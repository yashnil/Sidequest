import 'server-only';
import {
  runNeutralValidation,
  type BenchmarkPlan,
  type BenchReport,
  type RunMetrics,
} from '@sidequest/bench';
import { tripDates, type DestinationCandidate } from '@sidequest/core';
import { ResearchModel, type ModelCallDiagnostic } from '../providers/anthropic';
import { isResearchModelConfigured } from '../providers/switches';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { compilerProviders } from '../compiler/providers';
import { getIntent } from '../db/compiler-repository';
import { getProfile, getTrip } from '../db/repository';
import { saveHybridPlan } from '../db/hybrid-repository';
import { composerModel, generateBaselinePlan, type BaselineGeneration } from '../benchmark/baseline/generate';
import { buildResearchPacket } from '../benchmark/baseline/packet';
import { repairBaselinePlan, repairableFindings } from '../benchmark/baseline/repair';
import { runPreliminaryScan } from '../benchmark/baseline/scan';
import { RunTimeline } from '../benchmark/baseline/timing';
import { toBenchmarkPlan } from '../benchmark/baseline/convert';
import { packetGroundTruth } from '../benchmark/ground-truth';
import { buildHybridTripRequest } from './hybrid-request';
import { gatherProductionPacketInputs, type GatherStageTimingsMs } from './hybrid-gather';

/**
 * NOT CANONICAL. Kept for benchmark history and comparison only. The one
 * normal product generation path is `production-plan.ts#generateSidequestPlanForTrip`
 * (composition → verification → reconciliation); no user-facing action calls
 * this file any more — Quick Plan was consolidated onto the canonical path.
 *
 * PHASE 17 — THE BASELINE-FIRST HYBRID PLANNER, WIRED FOR PRODUCTION.
 *
 * "The model composes. Sidequest verifies and improves." (see
 * `.claude-private/phase-17-baseline-first-hybrid-planner.md`.)
 *
 * This reuses the Phase 13 baseline arm's own composition/validation
 * building blocks — `buildResearchPacket`, `runPreliminaryScan`,
 * `generateBaselinePlan`, `repairBaselinePlan`, `toBenchmarkPlan`,
 * `packetGroundTruth` / `runNeutralValidation` — because that arm already *is*
 * a model-composes-first-then-deterministic-verifies pipeline. What it does
 * NOT reuse, as of the correction described in `hybrid-gather.ts`, is that
 * arm's *evidence acquisition* (`gatherPacketInputs`/`resolveDestinationIdentity`
 * in `benchmark/baseline/`): those issue raw, uncached Overpass requests
 * directly, a Phase 13 benchmark-fairness constraint that had no business
 * governing production. Evidence now comes from `gatherProductionPacketInputs`,
 * which calls the same `CompilerProviders` seam (`resolver`, `regionPack`,
 * `places`, `food`, `routing`, `expansion`) the deterministic compiler itself
 * calls — the current production place/evidence backbone, its caches and its
 * configured Overture/Google/routing/weather capabilities.
 *
 * `runBaseline`'s own orchestration is still not reused: that function's
 * single-flight claim is foreign-keyed to a `benchmark_sessions` row and its
 * spend gate (`lib/benchmark/budget.ts`) is keyed to
 * `SIDEQUEST_BENCHMARK_BUDGET_USD`, a pilot-experiment knob that has no
 * meaning for an ordinary trip. A production build spends against the same
 * daily model-call ceiling every other paid production path already respects
 * (`lib/compiler/daily-ceiling.ts`).
 *
 * Call budget: one generation call, at most one re-ask if that answer was
 * malformed or truncated, and at most one repair call — three ever, reserved
 * as three independent slots. This used to be reserved as two, on the theory
 * that the re-ask "replaces" the generation attempt rather than adding a call;
 * that was true of the daily ceiling but not of `fence`'s own local counter,
 * which the re-ask and the repair both draw from. A run whose first answer was
 * malformed would spend its second (and, under `maxCalls: 2`, last) slot on
 * the re-ask and arrive at validation with zero calls left — so a plan with a
 * genuinely repairable defect got no repair, silently, only on runs unlucky
 * enough to also need a re-ask. Generation retry and validation repair are
 * different operations answering different failures (an unusable answer vs.
 * a usable one with a fixable defect) and must not compete for the same slot.
 * `reserveModelCalls` and `fence` now both book three up front so the worst
 * case — re-ask *and* repair — is exactly what was reserved, never a shortfall.
 * The composition call is not attempted at all until evidence acquisition has
 * returned at least one real place — see the check below `gatherProductionPacketInputs`.
 */

/**
 * MEASURED, NOT GUESSED.
 *
 * One field per stage a founder or a reviewer would ask about by name, so a
 * latency question never has to be answered by re-instrumenting the code to
 * find out. `null` means the stage did not run for this build (no region-pack
 * provider configured, no repair needed) — never a zero standing in for
 * "did not measure it".
 */
export interface LatencyBreakdownMs {
  identityResolutionMs: number;
  regionPackMs: number | null;
  placesMs: number | null;
  foodMs: number | null;
  expansionMs: number | null;
  routingMs: number | null;
  weatherMs: number | null;
  /**
   * Wall time of the whole acquisition phase. Not a sum of the stages above —
   * `expansion` and `weather` run concurrently with the `places`/`food`/
   * `routing` chain, so the phase total is legitimately less than their sum,
   * and reporting the sum instead would misstate exactly the parallelism this
   * phase exists to get credit for.
   */
  providerAcquisitionTotalMs: number;
  /** The generation call(s) — one attempt, plus the one re-ask on a malformed answer. */
  compositionMs: number;
  /** The first validation pass, before any repair. */
  validationMs: number;
  /** The repair call and its re-validation. `null` when no repair was needed. */
  repairMs: number | null;
  /** Converting, saving and preparing the result to return. */
  persistenceMs: number;
  totalMs: number;
}

export interface HybridBuildResult {
  ok: boolean;
  error?: string;
  plan?: BenchmarkPlan;
  metrics?: RunMetrics;
  report?: BenchReport | null;
  latency?: LatencyBreakdownMs;
  /** One entry per model call actually made — see `ModelCallDiagnostic`. */
  modelCalls?: ModelCallDiagnostic[];
}

export async function buildHybridItinerary(
  tripId: string,
  options: { caller?: string | null; now?: Date } = {},
): Promise<HybridBuildResult> {
  const now = options.now ?? new Date();

  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  if (!isResearchModelConfigured()) {
    return {
      ok: false,
      error: 'No model credential is configured, so we cannot compose a first draft yet.',
    };
  }

  // Reserved before anything is spent — see `reserveModelCalls`'s own note on
  // why booking happens ahead of the call rather than after it.
  const reservation = reserveModelCalls(3, { now, caller: options.caller });
  if (!reservation.allowed) {
    return {
      ok: false,
      error: reservation.message ?? 'Today’s planning allowance is used up. Try again tomorrow.',
    };
  }

  const intent = getIntent(tripId);
  const profile = getProfile(tripId);
  const request = buildHybridTripRequest({
    trip,
    composer: intent?.composer ?? null,
    profile,
    now,
  });

  const timeline = new RunTimeline();
  const buildStartedMs = performance.now();

  const identityStartedMs = performance.now();
  const { providers } = compilerProviders();
  const resolution = await providers.resolver.resolve({ query: request.destination.text, now });
  const candidate = bestCandidate(resolution);
  const identityResolutionMs = Math.round(performance.now() - identityStartedMs);
  if (!candidate) {
    return {
      ok: false,
      error: 'We could not identify that destination through the place backbone.',
      latency: latencyFor({ identityResolutionMs, buildStartedMs }),
    };
  }

  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
  const acquisitionStartedMs = performance.now();
  const gathered = await gatherProductionPacketInputs({
    request,
    candidate,
    dates,
    now,
    profile,
    nights: request.dates.nights,
    ...(intent?.composer?.transport ? { composerTransport: intent.composer.transport } : {}),
    ...(intent?.composer?.shape ? { composerShape: intent.composer.shape } : {}),
    providers,
  });
  const providerAcquisitionTotalMs = Math.round(performance.now() - acquisitionStartedMs);

  const packet = buildResearchPacket(gathered.inputs);
  if (packet.places.length > 0) timeline.mark('timeToFirstUsefulResultMs');

  /*
   * DO NOT SPEND THE COMPOSITION CALL ON NOTHING.
   *
   * A packet with zero real places produced exactly one thing worth reading —
   * "I have nothing to compose from" — for the cost of a full-size generation
   * call. Refusing here is the fail-fast the runtime-economics requirement
   * asks for: the traveller gets an honest, immediate refusal naming which
   * provider came back empty, rather than a paid call that could only restate
   * the same fact at length.
   */
  if (packet.places.length === 0) {
    timeline.finish();
    return {
      ok: false,
      error:
        'The place backbone returned no real places for this destination, so there is nothing to compose a trip from yet. ' +
        (gathered.inputs.gaps[0]?.detail ?? ''),
      latency: latencyFor({ identityResolutionMs, providerAcquisitionTotalMs, gathered, buildStartedMs }),
    };
  }

  const scan = runPreliminaryScan({ request, packet });

  const truth = packetGroundTruth({ inputs: gathered.inputs, request, now });
  const validate = (plan: BenchmarkPlan): BenchReport => runNeutralValidation(plan, truth);

  // Three calls, structurally: the client refuses a fourth attempt on its
  // own, independent of anything below counting correctly. One generation,
  // one optional re-ask, one optional repair — never two of those sharing a
  // slot. See the module-level comment for why this moved from two to three.
  // `model: composerModel()` — configurable per the composer-efficiency
  // pass, not the constructor's own generic default; see that function's
  // own note for why it is a dedicated setting rather than `ANTHROPIC_MODEL`.
  const fence = new ResearchModel({ maxCalls: 3, maxRetries: 0, model: composerModel() });
  const compositionStartedMs = performance.now();

  let outcome = await generateBaselinePlan({
    model: fence,
    request,
    packet,
    scan,
    followUpAnswers: [],
  });
  if (!outcome.ok && outcome.failureKind === 'malformed_output' && fence.callsRemaining > 0) {
    outcome = await generateBaselinePlan({
      model: fence,
      request,
      packet,
      scan,
      followUpAnswers: [],
      retry: outcome.truncated ? 'truncated' : 'malformed',
    });
  }

  const compositionMs = Math.round(performance.now() - compositionStartedMs);

  if (!outcome.ok) {
    timeline.finish();
    return {
      ok: false,
      error: composeFailureCopy(outcome.detail),
      latency: latencyFor({
        identityResolutionMs,
        providerAcquisitionTotalMs,
        gathered,
        compositionMs,
        buildStartedMs,
      }),
      modelCalls: [...fence.callLog],
    };
  }

  let generation: BaselineGeneration = outcome.output;
  let converted = toBenchmarkPlan({
    planId: `hybrid:${tripId}`,
    requestId: request.requestId,
    output: generation,
    packet,
    startDate: trip.basics.startDate,
    endDate: trip.basics.endDate,
    generationState: 'complete',
    failureKind: null,
    failureDetail: null,
  }).plan;
  if (converted.days.length > 0) timeline.mark('timeToFirstItineraryMs');

  const validationStartedMs = performance.now();
  let report = validate(converted);
  const validationMs = Math.round(performance.now() - validationStartedMs);
  const warnings: string[] = [];
  let repairCalls = 0;
  let repairMs: number | null = null;

  const defects = repairableFindings(report.findings);
  if (defects.length > 0) {
    if (fence.callsRemaining > 0) {
      const repairStartedMs = performance.now();
      repairCalls += 1;
      const repaired = await repairBaselinePlan({
        model: fence,
        plan: generation,
        findings: report.findings,
        packet,
      });
      if (repaired.ok) {
        generation = repaired.output;
        converted = toBenchmarkPlan({
          planId: `hybrid:${tripId}`,
          requestId: request.requestId,
          output: repaired.output,
          packet,
          startDate: trip.basics.startDate,
          endDate: trip.basics.endDate,
          generationState: 'complete',
          failureKind: null,
          failureDetail: null,
        }).plan;
        report = validate(converted);
        const remaining = repairableFindings(report.findings);
        if (remaining.length > 0) {
          warnings.push(
            `${remaining.length} problem(s) remained after the one correction attempt this build is allowed.`,
          );
        }
      } else {
        warnings.push('A correction was attempted and did not produce a usable plan, so the original stands.');
      }
      repairMs = Math.round(performance.now() - repairStartedMs);
    } else {
      warnings.push(`${defects.length} problem(s) were found and no repair call was left to fix them.`);
    }
  }
  timeline.mark('timeToValidatedPlanMs');

  if (warnings.length > 0) {
    converted = toBenchmarkPlan({
      planId: `hybrid:${tripId}`,
      requestId: request.requestId,
      output: generation,
      packet,
      startDate: trip.basics.startDate,
      endDate: trip.basics.endDate,
      generationState: 'partial',
      failureKind: null,
      failureDetail: null,
      extraWarnings: warnings,
    }).plan;
  }

  timeline.finish();

  const usage = fence.usage;
  const metrics = timeline.toRunMetrics({
    runId: `hybrid:${tripId}`,
    failed: false,
    modelCalls: usage?.calls ?? 0,
    repairCalls,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    costMicroUsd: usage ? Math.round(usage.estimatedCostUsd * 1_000_000) : null,
    unpricedCalls: 0,
    providerCalls: gathered.counters.providerCalls,
    routeCalls: gathered.counters.routeCalls,
    routePairs: gathered.counters.routePairs,
    weatherCalls: gathered.counters.weatherCalls,
    warmth: 'cold',
    warmthBasis: 'This world was bought fresh for this build.',
  });

  const persistenceStartedMs = performance.now();
  saveHybridPlan({ tripId, plan: converted, metrics, report, now });
  const persistenceMs = Math.round(performance.now() - persistenceStartedMs);

  return {
    ok: true,
    plan: converted,
    metrics,
    report,
    latency: latencyFor({
      identityResolutionMs,
      providerAcquisitionTotalMs,
      gathered,
      compositionMs,
      validationMs,
      repairMs,
      persistenceMs,
      buildStartedMs,
    }),
    modelCalls: [...fence.callLog],
  };
}

/**
 * Assembles the reported breakdown from whichever stages actually ran.
 *
 * A single seam rather than building the object inline at every return, so
 * every exit path — including the early refusals — reports the same shape
 * with the same "not reached" semantics for stages it never got to.
 */
function latencyFor(input: {
  identityResolutionMs: number;
  providerAcquisitionTotalMs?: number;
  gathered?: { stageTimingsMs: GatherStageTimingsMs };
  compositionMs?: number;
  validationMs?: number;
  repairMs?: number | null;
  persistenceMs?: number;
  buildStartedMs: number;
}): LatencyBreakdownMs {
  const stage = (name: string): number | null => {
    const timings = input.gathered?.stageTimingsMs;
    if (!timings) return null;
    return timings[name] ?? timings[`${name} (failed/timed out)`] ?? null;
  };
  return {
    identityResolutionMs: input.identityResolutionMs,
    regionPackMs: stage('region pack'),
    placesMs: stage('places'),
    foodMs: stage('food'),
    expansionMs: stage('expansion'),
    routingMs: stage('routing'),
    weatherMs: stage('weather'),
    providerAcquisitionTotalMs: input.providerAcquisitionTotalMs ?? 0,
    compositionMs: input.compositionMs ?? 0,
    validationMs: input.validationMs ?? 0,
    repairMs: input.repairMs ?? null,
    persistenceMs: input.persistenceMs ?? 0,
    totalMs: Math.round(performance.now() - input.buildStartedMs),
  };
}

function composeFailureCopy(detail: string): string {
  return `We could not compose a first draft just now. ${detail}`;
}

/**
 * The unambiguous read where the resolver gave one, otherwise its own
 * top-ranked candidate. Mirrors `pickBest` in the retired
 * `benchmark/baseline/identity.ts`: a resolver orders by its own relevance,
 * which is a published behaviour of the service rather than a judgement of
 * ours, and re-ranking here would be this path quietly acquiring a
 * destination-resolution heuristic of its own.
 */
function bestCandidate(resolution: {
  candidates: readonly DestinationCandidate[];
  unambiguousCandidateId?: string;
}): DestinationCandidate | null {
  if (resolution.unambiguousCandidateId) {
    const match = resolution.candidates.find(
      (candidate) => candidate.id === resolution.unambiguousCandidateId,
    );
    if (match) return match;
  }
  return resolution.candidates[0] ?? null;
}
