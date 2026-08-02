import 'server-only';
import {
  compileRegion,
  orderWorkPlan,
  type CompilerProviders,
  type CompileResult,
  type SharedEvidenceLayer,
} from '@sidequest/compiler';
import {
  scopeFingerprint,
  tripDates,
  tripMonths,
  type CompilationErrorCode,
  type CompiledRegion,
  type GeographicScope,
  type StageRecord,
  type Trip,
  type WorkPlanEntry,
  EVIDENCE_STORE_VERSION,
  reuseShare,
} from '@sidequest/core';
import {
  completeJob,
  failJob,
  pruneOrphanedSourceDocuments,
  findCompiledRegion,
  getActiveJob,
  getIntent,
  isCancelRequested,
  markJobRunning,
  recordStage,
  saveWorkPlan,
  startJob,
  type StartJobResult,
} from '../db/compiler-repository';
import { getProfile } from '../db/repository';
import { evidenceStoreNeedsSweep, sweepEvidenceStore } from '../db/evidence-repository';
import { compilerProviders, providerReadiness } from './providers';
import type { LiveDiagnostics } from '../providers/live';

/**
 * THE RUNNER.
 *
 * Everything durable about a compilation is a row. The job's state, the stage it
 * reached, what each stage produced and the artifact it ended with are all in
 * SQLite before the traveller's browser hears about any of it — which is what
 * makes a refresh show the compilation that is already happening rather than
 * starting a second one.
 *
 * ## The in-process limitation, stated plainly
 *
 * This runs the compilation inside the web process, after the response, using
 * Next's `after()`. That is genuinely enough for development and genuinely not
 * production-durable:
 *
 * - a deploy or a crash mid-compilation kills the work in flight;
 * - a serverless platform may freeze the process once the response is sent;
 * - two web instances would each be able to start work, which the unique index
 *   prevents from becoming two *jobs* but not from becoming two attempts.
 *
 * The isolation that makes replacing it cheap is deliberate: everything below
 * reads and writes through the repository and nothing else, so a durable worker
 * is a different caller of `runCompilation`, not a rewrite. What must not happen
 * is pretending this is production-grade — hence `isAbandoned`, the heartbeat,
 * and the reclaim path, which exist precisely because this process can die.
 */

export type StartOutcome =
  | { kind: 'started'; jobId: string }
  | { kind: 'already_running'; jobId: string }
  | { kind: 'already_compiled'; compiledRegionId: string }
  | { kind: 'blocked'; code: CompilationErrorCode; message: string };

/**
 * Start a compilation, or hand back the one already happening.
 *
 * Four outcomes rather than two, because "you already have this" and "somebody
 * is already doing this" are different things to tell a traveller, and neither
 * is an error. Duplicate protection is the database's unique partial index, not
 * the disabled button — two tabs and a direct POST both go past the button.
 */
export function startCompilation(trip: Trip, now = new Date()): StartOutcome {
  const intent = getIntent(trip.id);
  const scope = intent?.scope;

  if (!scope || !scope.confirmedByUser) {
    return {
      kind: 'blocked',
      code: 'scope_not_confirmed',
      message: 'Nothing has been built yet — the region is still yours to confirm.',
    };
  }

  const readiness = providerReadiness();
  if (!readiness.ready) {
    return { kind: 'blocked', code: 'provider_credentials_missing', message: readiness.message };
  }

  const fingerprint = scopeFingerprint(scope);

  /**
   * An artifact for exactly this scope already exists, so nothing is recompiled.
   *
   * This is the rule that stops a refresh costing money: rendering reads the
   * database, and only a deliberate rebuild — which bumps the scope revision and
   * therefore the fingerprint — asks a provider anything.
   */
  const existing = findCompiledRegion(trip.id, fingerprint);
  if (existing) return { kind: 'already_compiled', compiledRegionId: existing.id };

  /**
   * Sweep audit rows whose region is gone, on the rare path rather than the hot
   * one. `compiled_regions` cascades from `trips`; SQLite will not cascade into
   * a table with no foreign key, and adding one would let the audit trail block
   * a delete.
   */
  pruneOrphanedSourceDocuments();

  const result: StartJobResult = startJob({
    tripId: trip.id,
    scopeFingerprint: fingerprint,
    now,
  });
  if (result.kind === 'already_running') {
    return { kind: 'already_running', jobId: result.job.id };
  }
  return { kind: 'started', jobId: result.job.id };
}

/**
 * Do the work, writing progress as it goes.
 *
 * Deliberately not transactional as a whole: stage rows are written *during* the
 * compilation so a refresh sees real progress, while the artifact and the flip
 * to ready are one transaction at the end. A crash halfway therefore leaves a
 * `running` job with honest stage history and no artifact — which is a state the
 * UI can explain and a retry can clear, rather than a half-written region
 * claiming to be ready.
 */
export async function runCompilation(input: {
  trip: Trip;
  jobId: string;
  providers?: CompilerProviders;
  now?: Date;
}): Promise<CompileResult | null> {
  const now = input.now ?? new Date();
  const intent = getIntent(input.trip.id);
  const scope = intent?.scope;
  if (!scope) {
    failJob({
      jobId: input.jobId,
      code: 'scope_not_confirmed',
      detail: 'The scope disappeared between starting and running.',
      now,
    });
    return null;
  }

  markJobRunning(input.jobId, now);

  const dates = tripDates(input.trip.basics.startDate, input.trip.basics.endDate);
  const months = tripMonths(input.trip.basics.startDate, input.trip.basics.endDate);
  const profile = getProfile(input.trip.id);

  let providers: CompilerProviders;
  let live: LiveDiagnostics | null = null;
  let evidence: SharedEvidenceLayer | null = null;
  try {
    if (input.providers) {
      providers = input.providers;
    } else {
      const resolved = compilerProviders(scope.destinationCandidateId);
      providers = resolved.providers;
      live = resolved.live;
      evidence = resolved.evidence;
    }
  } catch (error) {
    failJob({
      jobId: input.jobId,
      code: 'provider_credentials_missing',
      detail: error instanceof Error ? error.message : undefined,
      now,
    });
    return null;
  }

  /**
   * Decisions the compiler took to skip work, kept alongside the ones the shared
   * evidence layer reports. The two are disjoint by construction: the layer can
   * only speak for calls it received, and these are exactly the calls that were
   * never made.
   */
  const compilerNotes: WorkPlanEntry[] = [];

  let result: CompileResult;
  try {
    result = await compileRegion({
      compilationId: `region-${input.jobId}`,
      scope,
      ...(profile ? { profile } : {}),
      dates,
      months,
      providers,
      now,
      onStage: (record: StageRecord) => {
        // Written as it happens. A stage that has finished is a fact, and a
        // traveller watching this screen should see it the moment it is one.
        recordStage(input.jobId, record, new Date());
      },
      onWorkPlanNote: (entry) => {
        compilerNotes.push(entry);
      },
    });
  } catch (error) {
    console.error('Compilation threw', { jobId: input.jobId });
    failJob({
      jobId: input.jobId,
      code: 'internal_error',
      detail: error instanceof Error ? error.message.slice(0, 300) : undefined,
      now: new Date(),
    });
    return null;
  }

  // Cancellation is checked at the end rather than mid-flight: the providers
  // have already been paid for by then, and throwing the artifact away would
  // waste that without saving anything. What it does prevent is a cancelled job
  // silently becoming the trip's region.
  if (isCancelRequested(input.jobId)) {
    failJob({
      jobId: input.jobId,
      code: 'cancelled_by_user',
      detail: 'Stopped before the result was adopted.',
      now: new Date(),
      cancelled: true,
    });
    return result;
  }

  if (!result.ok) {
    failJob({ jobId: input.jobId, code: result.code, detail: result.message, now: new Date() });
    return result;
  }

  /**
   * What this compilation reused, written where a person can find it later.
   *
   * Persisted separately from the artifact because it is a fact about *this run*
   * rather than about the region: two builds of one destination produce the same
   * evidence and wildly different work plans, and conflating them would make an
   * artifact's checksum depend on how warm the cache happened to be.
   */
  const workPlanEntries = orderWorkPlan([...compilerNotes, ...(evidence?.workPlan() ?? [])]);
  if (workPlanEntries.length > 0) {
    saveWorkPlan({
      jobId: input.jobId,
      tripId: input.trip.id,
      plan: {
        schemaVersion: EVIDENCE_STORE_VERSION,
        entries: workPlanEntries,
        computedAt: new Date().toISOString(),
      },
    });
  }

  completeJob({
    jobId: input.jobId,
    tripId: input.trip.id,
    region: withEvidenceCounters(withProviderCounters(result.region, live), evidence),
    state: result.partial ? 'partial' : 'ready',
    now: new Date(),
  });

  /**
   * Sweep on the rare path, never the hot one — and only when there is
   * something to sweep.
   *
   * A compilation is the only thing that grows this store, so it is the right
   * moment to shrink it, and doing it after the artifact is committed means a
   * failed sweep can never cost a finished region. But the driver is
   * synchronous: a sweep runs on the event loop and every request behind it
   * waits, so an unconditional sweep after every build spends that stall on a
   * store that has barely grown.
   */
  if (evidenceStoreNeedsSweep()) sweepEvidenceStore({ dryRun: false, now: new Date() });

  return result;
}

/**
 * Fold what the providers actually cost into the artifact.
 *
 * Recorded on the region rather than in a log because it is evidence about the
 * region: how many map queries it took, how many route pairs were measured, how
 * many the router refused, and which model wrote the classifications. A stored
 * artifact that cannot say what it cost is one nobody can audit later.
 *
 * No credential and no request URL goes in here — only counts and versions.
 */
function withProviderCounters(region: CompiledRegion, live: LiveDiagnostics | null): CompiledRegion {
  if (!live) return region;
  return {
    ...region,
    diagnostics: {
      ...region.diagnostics,
      budget: {
        ...region.diagnostics.budget,
        consumed: {
          ...region.diagnostics.budget.consumed,
          geocoderCalls: live.geocoderCalls,
          geocoderCacheHits: live.geocoderCacheHits,
          poiCalls: live.poiCalls,
          poiCacheHits: live.poiCacheHits,
          poiElements: live.poiElements,
          routeCalls: live.routeCalls,
          routePairs: live.routePairs,
          routeCacheHits: live.routeCacheHits,
          wikidataCalls: live.wikidataCalls,
          sourceSearches: live.sourceSearches,
          pagesFetched: live.pagesFetched,
          pagesRejected: live.pagesRejected,
          modelCalls: live.model.calls,
          modelWebSearches: live.model.webSearches,
          modelInputTokens: live.model.inputTokens,
          modelOutputTokens: live.model.outputTokens,
          modelCacheReadTokens: live.model.cacheReadTokens,
          modelCostMicroUsd: Math.round(live.model.estimatedCostUsd * 1_000_000),
        },
      },
      promptVersions: {
        ...region.diagnostics.promptVersions,
        ...(live.timeZone ? { resolvedTimeZone: live.timeZone } : {}),
      },
    },
  };
}

/**
 * Fold what the evidence store saved into the artifact's ledger.
 *
 * Counts and one ratio, never a claim about quality. Reuse is allowed to make a
 * run cheap and is not allowed to make anything more certain — so none of these
 * numbers reaches a verification state, a coverage level or a card, and the only
 * place they surface is a diagnostics panel.
 */
function withEvidenceCounters(
  region: CompiledRegion,
  evidence: SharedEvidenceLayer | null,
): CompiledRegion {
  if (!evidence) return region;
  const share = reuseShare(evidence.metrics);
  return {
    ...region,
    diagnostics: {
      ...region.diagnostics,
      budget: {
        ...region.diagnostics.budget,
        consumed: {
          ...region.diagnostics.budget.consumed,
          evidenceDiscoveryHits: evidence.metrics.discoveryHits,
          evidenceDiscoveryMisses: evidence.metrics.discoveryMisses,
          evidenceDocumentsReused: evidence.metrics.documentsReused,
          evidenceDocumentsRevalidated: evidence.metrics.documentsRevalidated,
          evidenceDocumentsFetched: evidence.metrics.documentsFetched,
          evidenceBytesTransferred: evidence.metrics.bytesTransferred,
          evidenceBytesAvoided: evidence.metrics.bytesAvoided,
          evidenceExtractionsReused: evidence.metrics.extractionsReused,
          evidenceExtractionsPerformed: evidence.metrics.extractionsPerformed,
          evidenceModelCallsAvoided: evidence.metrics.modelCallsAvoided,
          ...(share === null ? {} : { evidenceReusePercent: Math.round(share * 100) }),
        },
      },
    },
  };
}

/**
 * Whether a trip already has an artifact for its current scope.
 *
 * Used by every page that renders a compiled region, so that navigating around
 * the product never triggers a provider call.
 */
export function compiledRegionForScope(tripId: string, scope: GeographicScope) {
  return findCompiledRegion(tripId, scopeFingerprint(scope));
}

export function activeJobFor(tripId: string) {
  return getActiveJob(tripId);
}
