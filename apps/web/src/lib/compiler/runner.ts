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
  type ImageSubject,
  type StageObservation,
  type Warmth,
  type CompilationStage,
  EVIDENCE_STORE_VERSION,
  STAGE_OBSERVATION_VERSION,
  STAGE_PHASE,
  destinationShapeFrom,
  failureCategoryFor,
  mustDoRequestsFrom,
  observedDurationMs,
  reuseShare,
} from '@sidequest/core';
import {
  completeJob,
  failJob,
  pruneOrphanedSourceDocuments,
  findCompiledRegion,
  getActiveJob,
  getIntent,
  getJob,
  heartbeat,
  isCancelRequested,
  markJobRunning,
  recordStage,
  saveOperationalDiagnostics,
  saveWorkPlan,
  startJob,
  type StartJobResult,
} from '../db/compiler-repository';
import { HEARTBEAT_INTERVAL_MS, isAbandoned, isTerminal } from '@sidequest/core';
import { dailySpendGate, recordDailySpend } from './daily-ceiling';
import { compileDeadlineMs, modelCallCeiling } from './limits';
import { fetchRefusalCounts, resetFetchRefusalCounts } from '../net/safe-fetch';
import { priorityHintsFrom, type ReconciliationBasis } from '@sidequest/core';
import {
  getProvisionalBoard,
  getProvisionalSelections,
  reconcilePendingActions,
  saveProvisionalBoard,
} from '../db/provisional-repository';
import { getProfile, getSelections, setSelection } from '../db/repository';
import { evidenceStoreNeedsSweep, sweepEvidenceStore } from '../db/evidence-repository';
import {
  attachCompiledRegionToObservations,
  pruneStageObservations,
  recordStageObservation,
} from '../db/timing-repository';
import { retentionIsDue, runRetentionSweep } from '../db/retention';
import { imageryCache } from '../db/imagery-repository';
import { destinationEntryById } from '../db/destination-index-repository';
import { resolveImageryForSubjects } from '../providers/wikimedia';
import { compilerProviders } from './providers';
import { providerReadiness } from './readiness';
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
export function startCompilation(
  trip: Trip,
  now = new Date(),
  /**
   * Who is asking, when the request layer can honestly say. The daily ledger
   * charges the deployment either way and charges this caller as well when it
   * is given, so one visitor cannot drain the whole day's allowance. Null (the
   * default) is the honest answer for an internal caller — the benchmark
   * driver, a worker, a test — and leaves only the global ceiling in force.
   */
  caller: string | null = null,
): StartOutcome {
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
   * THE DAILY CEILINGS — THE DEPLOYMENT'S AND THIS CALLER'S — CONSULTED BEFORE
   * ANY NEW LIVE JOB EXISTS.
   *
   * Only for the open stack — a fixture build costs nothing and must never be
   * refused by a spend gate. Order matters twice here: the artifact check
   * above stays in front because rendering what already exists is free and
   * must always work, and the live-job adoption below is checked first for the
   * same reason — pressing the button on a build that is already running
   * spends nothing new, so a full ledger must not refuse it.
   */
  if (readiness.choice === 'open') {
    const running = getActiveJob(trip.id);
    if (running && !isAbandoned(running, now)) {
      return { kind: 'already_running', jobId: running.id };
    }
    const gate = dailySpendGate(now, caller);
    if (!gate.allowed) {
      return { kind: 'blocked', code: 'budget_exhausted', message: gate.message };
    }
  }

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

  /*
   * Reserved on the ledger the moment the job exists, not when it finishes —
   * the benchmark budget's rule, for the same reason: a ceiling discovered by
   * crossing it is not a ceiling. Model calls are recorded separately, after
   * the run, from what the transport actually counted.
   */
  if (readiness.choice === 'open') recordDailySpend('live_compilations', 1, now, caller);

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
  /**
   * True only in the dedicated compile worker, where this process exists for
   * exactly one job: a cancellation noticed by the pulse may then stop the
   * process outright, which is the only way to stop mid-flight spending
   * without a hook inside the compiler. In-process callers (the benchmark
   * harness, tests, the inline fallback) must leave this off — exiting would
   * take the web server with it — and keep the end-of-run cancellation check,
   * which never adopts a cancelled build's artifact.
   */
  haltOnCancel?: boolean;
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
   * THE PULSE: PROOF OF LIFE ON A CLOCK, NOT ON STAGE BOUNDARIES.
   *
   * `heartbeat()` was exported with a rationale and had zero callers, so the
   * only heartbeat writes were the stage-boundary ones inside `recordStage` —
   * and real stages run past three minutes while the abandonment threshold
   * read ninety seconds. Every healthy live build was therefore reported dead
   * mid-stage, and the screen offered a second paid build while the first was
   * still spending. The pulse writes every `HEARTBEAT_INTERVAL_MS` for as long
   * as the job is genuinely running, so silence now means what the threshold
   * assumes it means: the process is gone.
   *
   * The same clock is the cancellation watch. `requestCancel` flips the row
   * terminal immediately; the pulse notices within one interval, records what
   * the run had spent by then — the counters exist and money is money whether
   * or not the build finished — and, in the dedicated worker, stops the
   * process. Self-stopping on any terminal state, and `unref`ed, so it can
   * neither beat for a corpse nor hold a process open.
   */
  const stopPulse = startCompilationPulse({
    jobId: input.jobId,
    haltOnCancel: input.haltOnCancel === true,
    onCancelled: () => {
      saveOperationalDiagnostics(input.jobId, {
        counters: operationalCounters(live, evidence),
      });
    },
  });

  /*
   * Refusal causes are counted at the safe-fetch layer, per process. Reset at
   * the start of the run so the histogram stored with this job describes this
   * job — exact in the dedicated worker, where one process is one compilation,
   * and best-effort in the inline fallback, where a concurrent build would
   * share the counter (the same approximation every in-process diagnostic
   * already accepts there).
   */
  resetFetchRefusalCounts();

  /**
   * Decisions the compiler took to skip work, kept alongside the ones the shared
   * evidence layer reports. The two are disjoint by construction: the layer can
   * only speak for calls it received, and these are exactly the calls that were
   * never made.
   */
  const compilerNotes: WorkPlanEntry[] = [];

  /**
   * The traveller's marks from an earlier provisional board.
   *
   * Bounded at the source — `priorityHintsFrom` caps how many pins may steer the
   * research order — so a traveller who pinned everything reorders the queue and
   * does not lengthen it.
   */
  const priorityHints = priorityHintsFrom(getProvisionalSelections(input.trip.id));

  /**
   * THE THINGS THE TRAVELLER NAMED THEMSELVES, TYPED BEFORE ANYTHING IS BOUGHT.
   *
   * Derived from what they wrote in the composer, by a pure function, here — not
   * inside the compiler. The composer is the intake layer and this is intake's
   * job: the compiler receives typed requests and never parses free text, which
   * is what keeps traveller prose out of every layer below this one.
   *
   * The decisions travel with them. A traveller who withdrew a request, or
   * picked which of three matches they meant, has said something that must
   * survive a rebuild — so it is read from the stored composer rather than from
   * anything this run computes.
   */
  const mustDo = mustDoRequestsFrom(intent.composer?.interpretation);
  const mustDoDecisions = intent.composer?.mustDoDecisions ?? [];

  /**
   * ONE OBSERVATION PER STAGE, WRITTEN AS THE STAGE LANDS.
   *
   * The third clock, and the only one that can ever justify an estimate. The
   * artifact carries no clock at all; the job row carries what *this* run did;
   * this carries what runs *like* this one have done, bucketed so a city build is
   * never averaged with a country build and a cold run is never averaged with a
   * warm one.
   *
   * Never fatal. A build that produced a region and failed to record how long it
   * took has produced a region, and the estimator's honest output without
   * history is silence — which the screen already knows how to render.
   */
  const shape = destinationShapeFrom({
    breadth: scope.breadth,
    entityType: scope.destinationEntityType,
  });
  let degraded = false;
  let priorCalls = 0;
  let priorHits = 0;

  /**
   * THE MONOTONIC CLOCK, WHERE THE RUNTIME OFFERS ONE.
   *
   * `performance.now()` does not jump when NTP corrects the system clock or
   * when a container is resumed on a different host, and a wall-clock span that
   * crosses one of those is not a duration — it is the correction. The observation
   * schema has carried `monotonicMs` with that rationale written out and nothing
   * ever wrote it, which is a field describing a value nobody supplies.
   *
   * Stamped when the stage's `running` record arrives and read when its terminal
   * record does, so the pair brackets the same work the wall clock brackets.
   */
  const monotonicStarts = new Map<CompilationStage, number>();

  /**
   * WARMTH IS A PROPERTY OF THE RUN, DECIDED ONCE.
   *
   * It used to be recomputed per stage from the *cumulative* provider counters,
   * which meant every run's first stages saw zero cache hits and were written as
   * `cold` while its later stages were written as `mixed`. One build therefore
   * scattered its observations across two buckets that `observationBucket`
   * exists to keep apart, and `runBucket` — which reads the most recent
   * observation — changed the population being compared against underneath the
   * progress screen as the build proceeded.
   *
   * `null` when there is no live diagnostics source at all. That is the fixture
   * stack, and it is genuinely unclassifiable rather than cold: recording a
   * one-second synthetic build as a cold city build put five of them in the
   * bucket a four-minute live build reads from, which is "roughly 0s–0s to go"
   * returning in a new costume. An unclassifiable run records nothing.
   */
  const runWarmth: Warmth | null = live === null ? null : warmthAtStart(live, evidence);

  const providerTotals = (): { calls: number; hits: number } =>
    live === null
      ? { calls: 0, hits: 0 }
      : {
          calls: live.geocoderCalls + live.poiCalls + live.routeCalls + live.pagesFetched,
          hits: live.geocoderCacheHits + live.poiCacheHits + live.routeCacheHits,
        };

  const observeStage = (record: StageRecord): void => {
    if (record.status === 'running') {
      monotonicStarts.set(record.stage, performance.now());
      return;
    }
    if (record.status === 'waiting') return;
    /*
     * No classification, no observation. History that cannot say which kind of
     * run it came from is history the estimator must not read, and writing it
     * with a plausible-looking default is how an incomparable population gets
     * into a comparable bucket.
     */
    if (runWarmth === null) return;

    /*
     * A stage that failed is observed by `observeTermination`, not here.
     *
     * One terminal observation per run rather than two: this path would write a
     * zero-length row (the compiler stamps both observed timestamps at the
     * instant it gives up) and could not say *why* it ended, because the failure
     * and cancellation categories are only known at the job level. So the
     * monotonic start is deliberately left in place for the terminal write to
     * pick up, which is what gives that row a real span.
     */
    if (record.status === 'failed') {
      degraded = true;
      return;
    }

    const durationMs = observedDurationMs(record);
    if (durationMs === null || !record.observedStartedAt || !record.observedFinishedAt) return;
    /*
     * A degraded stage marks the whole run degraded, and it stays marked.
     *
     * Two ways in, and both were unreachable before. `status: 'failed'` was
     * never emitted by any code path, so the flag could only ever be false; and
     * a stage that finished having lost a provider or run a counter dry — which
     * is the *common* shape of a degraded build — is legitimately `done` and so
     * would not have set it even once failures existed. The compiler now marks
     * both, and the run inherits the mark: a build that lost a provider halfway
     * is not comparable to one that did not, and the stages *after* the loss are
     * the ones most distorted by it.
     */
    if (record.degraded === true) degraded = true;

    const totals = providerTotals();
    const providerCalls = Math.max(0, totals.calls - priorCalls);
    const cacheHits = Math.max(0, totals.hits - priorHits);
    priorCalls = totals.calls;
    priorHits = totals.hits;

    const monotonicStart = monotonicStarts.get(record.stage);
    monotonicStarts.delete(record.stage);
    const monotonicMs =
      monotonicStart === undefined ? undefined : Math.max(0, performance.now() - monotonicStart);

    try {
      recordStageObservation({
        schemaVersion: STAGE_OBSERVATION_VERSION,
        jobId: input.jobId,
        stage: record.stage,
        phase: STAGE_PHASE[record.stage],
        outcome:
          record.status === 'done' ? 'done' : record.status === 'skipped' ? 'skipped' : 'failed',
        startedAt: record.observedStartedAt,
        completedAt: record.observedFinishedAt,
        durationMs,
        /*
         * Bounded on the way in, because the schema's ceiling would reject the
         * whole observation and a rejected observation is a silent loss. A span
         * past the ceiling is not a duration anyway — it is a suspended process.
         */
        ...(monotonicMs !== undefined && monotonicMs <= 3_600_000 ? { monotonicMs } : {}),
        breadth: scope.breadth,
        shape,
        warmth: runWarmth,
        degraded,
        providerCalls,
        cacheHits,
        /*
         * What the stage reported, not a constant written at this call site.
         *
         * This was `retries: 0`, which was true and was not a measurement — the
         * runner had no way of knowing. The compiler counts them where they
         * happen (today: the routing layer falling back to the road network when
         * the footpath network came back with nothing), so a zero here is now a
         * stage that provably did not retry rather than a placeholder.
         */
        retries: record.retries ?? 0,
        ...(record.workUnits === undefined ? {} : { workUnits: record.workUnits }),
        observedAt: new Date().toISOString(),
      } satisfies StageObservation);
    } catch (error) {
      console.error('Could not record a stage observation', { jobId: input.jobId, error });
    }
  };

  /**
   * THE OBSERVATION A RUN THAT DID NOT FINISH STILL OWES.
   *
   * Every observation above describes a stage that ended. A build that failed
   * or was cancelled ends *between* stages, and before this there was no record
   * of that at all: `outcome` was never `failed` or `cancelled`, so the two
   * fields the schema carries for exactly this — `failure` and `cancellation` —
   * were declared with a written rationale and never written by anything.
   *
   * The duration is the span of the stage that was in flight, which is the only
   * honest one available: nothing measured how long the failure itself took.
   */
  const observeTermination = (input2: {
    stage: CompilationStage;
    kind: 'failed' | 'cancelled';
    code: CompilationErrorCode;
  }): void => {
    if (runWarmth === null) return;
    const monotonicStart = monotonicStarts.get(input2.stage);
    monotonicStarts.delete(input2.stage);
    const finishedAt = new Date();
    const monotonicMs =
      monotonicStart === undefined ? 0 : Math.max(0, performance.now() - monotonicStart);
    degraded = true;

    try {
      recordStageObservation({
        schemaVersion: STAGE_OBSERVATION_VERSION,
        jobId: input.jobId,
        stage: input2.stage,
        phase: STAGE_PHASE[input2.stage],
        outcome: input2.kind,
        startedAt: new Date(finishedAt.getTime() - Math.min(monotonicMs, 3_600_000)).toISOString(),
        completedAt: finishedAt.toISOString(),
        durationMs: Math.min(monotonicMs, 3_600_000),
        ...(monotonicMs <= 3_600_000 ? { monotonicMs } : {}),
        breadth: scope.breadth,
        shape,
        warmth: runWarmth,
        degraded: true,
        providerCalls: 0,
        cacheHits: 0,
        retries: 0,
        ...(input2.kind === 'cancelled'
          ? { cancellation: 'traveller_requested' as const }
          : { failure: failureCategoryFor(input2.code) }),
        observedAt: finishedAt.toISOString(),
      } satisfies StageObservation);
    } catch (error) {
      console.error('Could not record a terminal stage observation', {
        jobId: input.jobId,
        error,
      });
    }
  };

  /** The stage the job is sitting on, so a termination can name it. */
  let lastStage: CompilationStage = 'expanding_region';

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
      /*
       * ONE NUMBER PER CEILING, AND THE PRINTED ONE IS THE OPERATIVE ONE.
       *
       * Without this the ledger printed the compiler's defaults — twenty model
       * calls, a three-minute wall clock — while the transport enforced twelve
       * and live builds observably ran eight minutes. The runner is the one
       * place that knows both halves, so it hands the ledger the same figures
       * the transport and the worker's deadline actually enforce.
       */
      budget: {
        maxModelCalls: modelCallCeiling(),
        maxDurationMs: compileDeadlineMs(),
      },
      onStage: (record: StageRecord) => {
        lastStage = record.stage;
        // Written as it happens. A stage that has finished is a fact, and a
        // traveller watching this screen should see it the moment it is one.
        recordStage(input.jobId, record, new Date());
        // …and once into history, which is what makes the *next* build's
        // estimate possible. A separate write because the job row dies with its
        // trip and the history must outlive it.
        observeStage(record);
      },
      onWorkPlanNote: (entry) => {
        compilerNotes.push(entry);
      },
      /*
       * Persisted the moment it exists, not at the end.
       *
       * The whole point of the cut is that somebody can look at it *while* the
       * research funnel runs. Buffering it until `completeJob` would make it
       * arrive at the same time as the finished board, which is the problem it
       * was built to solve.
       *
       * Wrapped, and never fatal: a board nobody could store is a preview
       * nobody sees, and that is not a reason to fail a compilation that is
       * otherwise going fine. The same posture `saveWorkPlan` takes.
       */
      /*
       * What they marked last time, if there was a last time.
       *
       * Read once, before the run: a mark made *during* this compilation cannot
       * reorder work the funnel has already started, and pretending otherwise
       * would make the ordering depend on when somebody happened to click.
       */
      ...(priorityHints ? { priorityHints } : {}),
      ...(mustDo.length > 0 ? { mustDo } : {}),
      ...(mustDoDecisions.length > 0 ? { mustDoDecisions } : {}),
      onProvisionalBoard: (board) => {
        try {
          saveProvisionalBoard({ ...board, tripId: input.trip.id }, new Date());
        } catch (error) {
          console.error('Could not store the provisional board', { jobId: input.jobId, error });
        }
      },
    });
  } catch (error) {
    console.error('Compilation threw', { jobId: input.jobId });
    stopPulse();
    observeTermination({ stage: lastStage, kind: 'failed', code: 'internal_error' });
    /*
     * The spend still happened. A throw is the one path that used to record
     * nothing at all, and "we do not know what the failures cost" is the shape
     * of an unbounded bill — same rule as the failure branch below.
     */
    saveOperationalDiagnostics(input.jobId, {
      counters: operationalCounters(live, evidence),
    });
    if (live) recordDailySpend('model_calls', live.model.calls, new Date());
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
  /*
   * WHAT IT COST IS RECORDED WHETHER OR NOT IT WORKED.
   *
   * Written before the two early returns below, not after them. A build that
   * fails at the last gate has already paid for every search, page and model
   * call that came before it — a live run of a thin region did exactly that,
   * spending real money and then recording nothing because the counters were
   * only saved on the success path. "We do not know what the failures cost" is
   * the shape of an unbounded bill.
   */
  saveOperationalDiagnostics(input.jobId, {
    counters: operationalCounters(live, evidence),
    compiler: result.operational,
  });

  /*
   * The day's model-call ledger, from what the transport actually counted.
   * Written once, here, because every path below — cancelled, failed,
   * committed, superseded — has already spent these calls.
   */
  if (live) recordDailySpend('model_calls', live.model.calls, new Date());

  if (isCancelRequested(input.jobId)) {
    stopPulse();
    observeTermination({ stage: lastStage, kind: 'cancelled', code: 'cancelled_by_user' });
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
    stopPulse();
    observeTermination({ stage: lastStage, kind: 'failed', code: result.code });
    failJob({
      jobId: input.jobId,
      code: result.code,
      detail: result.message,
      now: new Date(),
    });
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

  /**
   * THE ARTIFACT LEAVES THE COMPILER AND IS NOT TOUCHED AGAIN.
   *
   * This line used to read
   * `withEvidenceCounters(withProviderCounters(result.region, live), evidence)`,
   * folding live provider and cache counters into
   * `region.diagnostics.budget.consumed` after `compileRegion` had returned. The
   * compiler is deterministic — two runs of the same inputs produce identical
   * bytes — and this is where that guarantee was being thrown away: the
   * *persisted* artifact then differed by exactly how warm the cache happened to
   * be, so an immutable record of a region changed because somebody else had
   * compiled a nearby city first.
   *
   * The counters were worth keeping and are kept, on the job row, which is what
   * they were always facts about. The one thing folded in here is the resolved
   * time zone, which is provenance about the *region* rather than a measurement
   * of the run, and is the same for every build of that ground.
   */
  const region = withResolvedTimeZone(result.region, live);

  const committed = completeJob({
    jobId: input.jobId,
    tripId: input.trip.id,
    region,
    state: result.partial ? 'partial' : 'ready',
    now: new Date(),
  });
  stopPulse();

  /*
   * Somebody ended this job while the compiler was finishing — a cancellation
   * the pulse had not yet seen, or an orphan reclaim that outlived a stall.
   * The terminal verdict on the row is the traveller's truth and stands; the
   * artifact was not adopted, so none of the adoption side effects below may
   * run either. The spend was already recorded above, which is the half that
   * must survive whatever happened to the job.
   */
  if (!committed) return result;

  /*
   * `StageObservation.compiledRegionId` is written here, and cannot be written
   * earlier.
   *
   * The field's own rationale says it is "absent while the build is still
   * running and absent forever if it failed" — which is exactly why an
   * observation stamped as its stage lands cannot carry it: at that moment
   * nobody knows whether this run will end with an artifact. The join is made
   * once, after the commit, over the observations this job already wrote.
   */
  attachCompiledRegionToObservations(input.jobId, region.id);

  /**
   * A PLACE SOMEBODY NAMED IS A PLACE SOMEBODY PICKED.
   *
   * The link between the compile-time half of the guarantee and the downstream
   * half. `must_include_unscheduled` is already an error, the reviser already
   * refuses to drop a manual pick to satisfy a machine constraint, and the
   * terminal gate already excludes it from refusal so a named place that is shut
   * is reported rather than silently dropped — but every one of those turns on
   * the selection being marked as the traveller's own, and typing a place into
   * "anything you would regret missing" was not marking anything.
   *
   * `source: 'user'` is not a fib. Typing a place by name is a *more* explicit
   * statement than ticking a box on a board, and the row records what a person
   * did rather than what the ranker suggested.
   *
   * Never overwrites. A traveller who has already said something about this
   * place — including "no" — has said the more recent thing, and a build must
   * not argue with them. Wrapped and never fatal: a region with a selection
   * missing is still a region.
   */
  try {
    const covered = (region.mustDoCoverage?.resolutions ?? []).filter(
      (entry) =>
        (entry.status === 'covered' || entry.status === 'replaced') &&
        entry.match?.target === 'place',
    );
    if (covered.length > 0) {
      const already = new Set(getSelections(input.trip.id).map((entry) => entry.placeId));
      for (const entry of covered) {
        const placeId = entry.match!.id;
        if (already.has(placeId)) continue;
        if (!region.places.some((place) => place.id === placeId)) continue;
        setSelection(input.trip.id, placeId, 'included', 'user');
      }
    }
  } catch (error) {
    console.error('Could not mark a named must-do as chosen', { jobId: input.jobId, error });
  }

  /*
   * Written again, because the counters moved after the early returns above:
   * the artifact commit itself is preceded by nothing that spends, but the
   * evidence layer's reuse ledger is only complete once the run is.
   *
   * `result.operational` is the compiler's own half — the ledger's spend, the
   * ceilings, which stages ran, the reuse counters and the provider call counts
   * that used to be folded into `region.diagnostics.budget` and
   * `region.sourceManifest.providers[].calls`. See the boundary table in
   * `schemas/compiled-region.ts`: none of it could stay on the artifact,
   * because a warm shared store changes every one of those numbers for
   * identical output, and all of it is worth keeping.
   */
  saveOperationalDiagnostics(input.jobId, {
    counters: operationalCounters(live, evidence),
    compiler: result.operational,
  });

  /**
   * THE DESTINATION'S PHOTOGRAPH, RESOLVED ONCE AND WRITTEN DOWN.
   *
   * After the artifact is committed, never inside its transaction, and never at
   * render. An image identity is a fact about a place, so it is established when
   * the place is compiled and read out of a row for ever after. A render path
   * that could resolve one would resolve it per card, per refresh, per visitor —
   * which is precisely the pattern Wikimedia's own guidance names and asks
   * clients not to build.
   *
   * The Wikidata id is read back out of the destination index rather than off
   * the artifact, because that is what makes the lookup an identifier
   * relationship instead of a name search. A trip whose destination was typed
   * rather than selected has no index row and gets the coordinate-derived
   * graphic — which is a designed object, not an absence.
   *
   * Wrapped and never fatal: a build that produced a region and no photograph
   * has produced a region.
   */
  try {
    const entry = intent.selectedDestination
      ? destinationEntryById(intent.selectedDestination.entryId)
      : null;
    if (entry) {
      const subject: ImageSubject = {
        kind: 'destination',
        id: entry.id,
        name: entry.displayName,
        ...(entry.wikidataId ? { wikidataId: entry.wikidataId } : {}),
        coordinates: entry.center,
        hierarchy: entry.hierarchy,
      };
      await resolveImageryForSubjects([subject], { cache: imageryCache(new Date()) });
    }
  } catch (error) {
    console.error('Could not resolve destination imagery', { jobId: input.jobId, error });
  }

  /**
   * WHAT HAPPENED TO WHAT THEY PICKED.
   *
   * After the artifact is committed, not inside its transaction. The account of
   * a removal is worth having and it is not worth failing a finished build for:
   * if this throws, the traveller has their region and loses an explanation,
   * which is the right way round.
   *
   * The reasons come from the compiler's own gaps, so a removal is explained in
   * the words of the stage that caused it rather than in a category invented
   * here.
   */
  try {
    const board = getProvisionalBoard(input.trip.id);
    if (board) {
      /*
       * What the run concluded, persisted beside the account.
       *
       * Removals travel on the *result* rather than on the artifact, because a
       * removal is a fact about this run — two builds of one destination a month
       * apart remove different things, and folding that into an immutable record
       * would make the record depend on what happened to be shut the week
       * somebody pressed the button.
       *
       * That is right, and it has a consequence worth stating: the result is gone
       * by the time somebody marks a card a minute later. So the conclusions are
       * stored, and a late mark is reconciled against the same ones this build
       * reached rather than against the honest generic default.
       */
      const placesById = new Map(region.places.map((place) => [place.id, place]));
      const basis: ReconciliationBasis = {
        removals: result.removals.map((removal) => ({
          placeId: removal.placeId,
          outcome: removal.outcome,
          ...(removal.detail ? { detail: removal.detail } : {}),
          ...(removal.detailStage ? { detailStage: removal.detailStage } : {}),
        })),
        /*
         * Deduplication runs before the provisional cut, so a merged-away record
         * is never on a board and never a selection. Empty rather than invented:
         * `replaced_duplicate` claiming a survivor nobody checked is exactly the
         * defect that outcome was corrected for.
         */
        duplicates: [],
        /*
         * Survived, and something a traveller can see on the card is different.
         *
         * Compared against what the board actually *showed*. A provisional card
         * asserts no hours, no cost and no travel time, so "verification
         * established something" is true of nearly every card and would make this
         * outcome noise. The name and the category are what the card claimed, so
         * they are what can have changed.
         */
        changedPlaceIds: board.cards
          .filter((card) => {
            const place = placesById.get(card.placeId);
            return !!place && (place.name !== card.name || place.category !== card.category);
          })
          .map((card) => card.placeId),
      };

      const outcome = reconcilePendingActions({
        tripId: input.trip.id,
        now: new Date(),
        compiledRegionId: region.id,
        basis,
      });
      if (outcome.state === 'lost_to_newer_writer' || outcome.pendingActions > 0) {
        console.warn('Reconciliation did not fully settle', { jobId: input.jobId, outcome });
      }
    }
  } catch (error) {
    console.error('Could not reconcile the provisional board', { jobId: input.jobId, error });
  }

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
  /*
   * Retention latches on its own clock, and that matters.
   *
   * It used to sit inside the evidence-store condition below, which is a count of
   * `evidence_documents` over 200 — and none of the tables retention owns is grown
   * by evidence documents. `decision_sessions` is grown by a flow that runs no
   * compilation at all. Measured over two full browser-suite runs, the evidence
   * store peaked at 28 documents, so the retention sweep never ran once while the
   * tables it governs doubled.
   */
  if (retentionIsDue(new Date())) runRetentionSweep(new Date());

  if (evidenceStoreNeedsSweep()) {
    sweepEvidenceStore({ dryRun: false, now: new Date() });
    pruneStageObservations();
  }

  return result;
}

/**
 * WHAT THE PROVIDERS ACTUALLY COST — AS A RECORD OF THE RUN.
 *
 * The runner's half. The compiler's half arrives on `CompileResult.operational`
 * and the two are stored side by side, because neither can see the other: the
 * ledger knows what a stage was allowed to spend and the live diagnostics know
 * what the wire actually carried.
 *
 * How many map queries it took, how many route pairs were measured, how many
 * the router refused, what the model spent. A build that cannot say what it cost
 * is one nobody can audit later, and a live evaluation has no numbers.
 *
 * No credential, no request URL, no page body goes in here — only counts.
 *
 * These used to be folded onto the artifact. They are facts about a *run*: two
 * builds of one destination produce the same region and wildly different
 * counters, and putting them on the region made an immutable record depend on
 * how warm somebody else's cache had left the store. Same reasoning
 * `saveWorkPlan` already applies to the work plan, applied consistently.
 */
function operationalCounters(
  live: LiveDiagnostics | null,
  evidence: SharedEvidenceLayer | null,
): Record<string, number> {
  const counters: Record<string, number> = {};
  if (live) {
    counters.geocoderCalls = live.geocoderCalls;
    counters.geocoderCacheHits = live.geocoderCacheHits;
    counters.poiCalls = live.poiCalls;
    counters.poiCacheHits = live.poiCacheHits;
    counters.poiElements = live.poiElements;
    counters.routeCalls = live.routeCalls;
    counters.routePairs = live.routePairs;
    counters.routeCacheHits = live.routeCacheHits;
    counters.wikidataCalls = live.wikidataCalls;
    counters.sourceSearches = live.sourceSearches;
    counters.pagesFetched = live.pagesFetched;
    counters.pagesRejected = live.pagesRejected;
    counters.modelCalls = live.model.calls;
    counters.modelWebSearches = live.model.webSearches;
    counters.modelInputTokens = live.model.inputTokens;
    counters.modelOutputTokens = live.model.outputTokens;
    counters.modelCacheReadTokens = live.model.cacheReadTokens;
    counters.modelCostMicroUsd = Math.round(live.model.estimatedCostUsd * 1_000_000);
    /*
     * `pagesRejected`, decomposed by cause. The one number answered "how many"
     * and an operator triaging a thin region needs "why": robots refusals are
     * politeness working, policy refusals are the SSRF guard working, and a
     * pile of transient ones is a publisher having a bad day. Counted at the
     * safe-fetch layer — the only place the cause is known — and carried here
     * as counts alone: no URL, no hostname, no page body.
     */
    const refusals = fetchRefusalCounts();
    counters.pagesRejectedRobots = refusals.robots;
    counters.pagesRejectedPolicy = refusals.policy;
    counters.pagesRejectedSize = refusals.size;
    counters.pagesRejectedContentType = refusals.content_type;
    counters.pagesRejectedTransient = refusals.transient;
  }
  if (evidence) {
    const share = reuseShare(evidence.metrics);
    counters.evidenceDiscoveryHits = evidence.metrics.discoveryHits;
    counters.evidenceDiscoveryMisses = evidence.metrics.discoveryMisses;
    counters.evidenceDocumentsReused = evidence.metrics.documentsReused;
    counters.evidenceDocumentsRevalidated = evidence.metrics.documentsRevalidated;
    counters.evidenceDocumentsFetched = evidence.metrics.documentsFetched;
    counters.evidenceBytesTransferred = evidence.metrics.bytesTransferred;
    counters.evidenceBytesAvoided = evidence.metrics.bytesAvoided;
    counters.evidenceExtractionsReused = evidence.metrics.extractionsReused;
    counters.evidenceExtractionsPerformed = evidence.metrics.extractionsPerformed;
    counters.evidenceModelCallsAvoided = evidence.metrics.modelCallsAvoided;
    /*
     * `null` rather than 1 when nothing was eligible, and therefore absent
     * rather than zero here. "100% reused, of nothing" is a lie, and so is "0%".
     */
    if (share !== null) counters.evidenceReusePercent = Math.round(share * 100);
  }
  return counters;
}

/**
 * The one thing still folded onto the artifact after the compiler returns.
 *
 * A resolved time zone is provenance about the *ground* — every build of this
 * region resolves the same one — so it does not make the artifact depend on the
 * run the way a cache-hit count does. It sits in `promptVersions` because that
 * is already the artifact's "what produced this" record, and moving it would
 * change a read path for no gain.
 */
function withResolvedTimeZone(
  region: CompiledRegion,
  live: LiveDiagnostics | null,
): CompiledRegion {
  if (!live?.timeZone) return region;
  return {
    ...region,
    diagnostics: {
      ...region.diagnostics,
      promptVersions: { ...region.diagnostics.promptVersions, resolvedTimeZone: live.timeZone },
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

/**
 * The heartbeat-and-cancellation pulse for one running compilation.
 *
 * Exported for tests; production callers go through `runCompilation`, which
 * installs it around the compile call. Three behaviours, in the order the
 * ticker applies them:
 *
 * 1. **A terminal job stops the pulse.** Finished, failed, cancelled or
 *    reclaimed — there is nothing left to prove alive, and a heartbeat written
 *    over a reclaimed row would resurrect exactly the zombie the reclaim ended.
 * 2. **A cancelled job additionally records what was spent and, in the
 *    dedicated worker, stops the process.** `requestCancel` has already
 *    flipped the row and closed its stages; the worker's only remaining duty
 *    is to stop costing money, and `process.exit` is the one lever that works
 *    without a hook inside the compiler. The terminal-write guards make this
 *    safe: whatever the dying process had in flight can no longer change the
 *    row.
 * 3. **Otherwise, beat.**
 *
 * `unref`ed, so a pulse can never hold a process open; self-stopping, so a
 * caller that forgets to stop it leaks one tick, not a timer.
 */
export function startCompilationPulse(input: {
  jobId: string;
  haltOnCancel: boolean;
  onCancelled?: () => void;
  intervalMs?: number;
}): () => void {
  let cancelledHandled = false;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    try {
      const job = getJob(input.jobId);
      if (!job || isTerminal(job.state)) {
        clearInterval(timer);
        if (job?.state === 'cancelled' && !cancelledHandled) {
          cancelledHandled = true;
          try {
            input.onCancelled?.();
          } catch (error) {
            console.error('Could not record a cancelled build’s spend', {
              jobId: input.jobId,
              error,
            });
          }
          if (input.haltOnCancel) {
            // One job per worker process, by design. The row is already
            // terminal and every write above is synchronous, so nothing is
            // lost by leaving now — only further spending is.
            process.exit(0);
          }
        }
        return;
      }
      heartbeat(input.jobId, new Date());
    } catch (error) {
      // A missed beat is recoverable for HEARTBEAT_TIMEOUT_MS; a pulse that
      // threw out of a timer would take the worker down mid-write instead.
      console.error('Heartbeat pulse could not reach the job row', {
        jobId: input.jobId,
        error,
      });
    }
  }, input.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * How warm this run is, judged before it starts spending.
 *
 * A build is warm when the shared store can already answer for the ground it is
 * about to cover, cold when it has to buy all of it, and mixed when it holds
 * some. That is a question about what exists at the start, not about what the
 * counters read halfway through — which is what made the old per-stage reading
 * classify one run two ways.
 *
 * The counters are the ones a fresh process has not touched yet, so on entry
 * they are zero for a cold run and non-zero only where a previous build in this
 * process already populated them. The evidence layer's own ledger is the
 * stronger signal and is preferred where it exists.
 */
function warmthAtStart(live: LiveDiagnostics, evidence: SharedEvidenceLayer | null): Warmth {
  const held = evidence
    ? evidence.metrics.documentsReused + evidence.metrics.extractionsReused
    : 0;
  const hits = live.geocoderCacheHits + live.poiCacheHits + live.routeCacheHits + held;
  const bought = live.geocoderCalls + live.poiCalls + live.routeCalls + live.pagesFetched;
  if (hits === 0) return 'cold';
  if (bought === 0) return 'warm';
  return 'mixed';
}
