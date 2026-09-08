import 'server-only';
import {
  buildTravelerBrief,
  currencyForCountry,
  type TravelerBrief,
  displayNameOf,
  tripDates,
  unavailableWeatherDataset,
  type DestinationCandidate,
  type Place,
  type Region,
  type TravelerProfile,
  type Trip,
} from '@sidequest/core';
import type { StructuredModel } from '../providers/interpretation-model';
import type { RoutingProvider } from '@sidequest/compiler';
import type { BenchmarkTripRequest } from '@sidequest/bench';
import { ResearchModel } from '../providers/anthropic';
import { isCompositionModelConfigured, isFixtureComposer, isGeocoderEnabled, isPoiProviderEnabled } from '../providers/switches';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { verificationProviders } from './verification-providers';
import { getIntent } from '../db/compiler-repository';
import { getTripDraft, listCompositionAttempts, recordCompositionParse, saveCompositionAttempt, saveTripDraft } from '../db/draft-repository';
import { randomUUID } from 'node:crypto';
import { getProfile, getSelections, getTrip, saveItinerary, saveReadiness } from '../db/repository';
import { boardFor, resolveTripRegion, withRefreshedWeather, type RegionContext } from '../region';
import { ensureWeatherForPlanning, weatherTargetFor } from '../weather/refresh';
import { getWeatherSnapshot, weatherScopeKey } from '../weather/snapshot-repository';
import { weatherAvailability, type WeatherDataset, type WeatherLocation } from '@sidequest/core';
import { composerModel } from '../benchmark/baseline/generate';
import { buildHybridTripRequest } from './hybrid-request';
import { COMPOSITION_PROMPT_VERSION, buildCompositionTask, compositionEffort, compositionUntrustedPayload, compositionWireDecision, generateTripDraft, seasonOf, type BoardSignals, type CompositionContext, type DestinationEnvelope } from './composition';
import { describeEdge } from '../benchmark/baseline/generate';
import { FixtureComposer } from './fixture-composer';
import { reconcileTripDraft, type ReconcileContext, type ReconcileResult } from './reconcile';
import {
  productionDestinationScope,
  productionFindNearbyLocalities,
  productionGeocodeLocality,
  productionRouteMatrix,
  productionSubregionGeometries,
} from './skeleton-orchestrator';
import type { TripDraft } from './trip-draft';
import { defaultProfileFor } from './default-profile';
import { listBookedItems } from '@/lib/db/intelligence-repository';
import { compactBookedFacts } from '@/lib/intelligence/booked-facts';
import { applyBookedFacts, bookedLeaveByMinute } from '@/lib/intelligence/booked-reconcile';
import { policyConfirmRoute } from './route-selection';
import { operationalEvidenceSeam, persistedIdentitiesFor, placesIdentitySeam } from './place-identity';
import { ProviderBudget, ceilingsFor } from '../providers/cost-budget';
import { buildPreservationReport, describePreservation, type DraftPreservationReport } from './preservation';
import { auditItinerary, type QualityAudit } from './quality-audit';
import { capability } from '../providers/registry';
import { MAX_PROVIDER_REQUEST_MS, withGenerationDeadline } from '../net/generation-deadline';
import { beginGeneration, finishGeneration, markGenerationStage } from '../db/generation-progress-repository';
import { fetchReferenceRate } from '../providers/fx';
import { saveFxRate } from '@/lib/db/intelligence-repository';

/**
 * THE ONE CANONICAL PRODUCTION ITINERARY-GENERATION ORCHESTRATOR.
 *
 *   trip request → traveller profile (stored, or a default derived from the
 *   composer) → destination envelope → ONE frontier-model TripDraft →
 *   persist the raw draft → targeted verification (identity, mandatory
 *   routes, day-local routes, hours) → deterministic corrections → reconcile
 *   → persist the itinerary + package + readiness.
 *
 * Every user-facing generation surface reaches this function: "Build my
 * trip"/"Rebuild my trip" on the Discovery Board, "Regenerate" on the
 * itinerary page, and Quick Plan (`mode: 'quick'` — the same architecture with
 * board signals skipped and a shorter verification deadline). `build.ts`
 * (deterministic `planTrip()` authorship) and `hybrid.ts` (the Phase 13
 * benchmark composer) remain for history and comparison and are explicitly
 * NOT canonical.
 *
 * What the composition call receives is the traveller and the trip — never
 * Sidequest's POI catalog (see `composition.ts`). What verification uses is
 * only what the draft references: compiled evidence first, then the
 * configured geocoder and router, each bounded by `SIDEQUEST_VERIFICATION_
 * DEADLINE_MS`; when the deadline fires, the rich draft is returned with
 * honest uncertainty rather than held hostage to a slow provider.
 *
 * Budget: exactly one model call, never a retry, never a repair call, never an
 * evaluator. `SIDEQUEST_COMPOSER_PROVIDER=fixture` replaces the model with a
 * deterministic offline composer so the whole path runs in tests with zero
 * calls.
 */

export type GenerationMode = 'full' | 'quick';

/** The one sentence a traveller sees when a draft could not be finished. No schema, no stop reason, no jargon. */
export const TRAVELLER_COMPOSITION_FAILURE = 'Sidequest could not finish this draft. Your answers are saved — retry when you are ready.';

export interface ProductionPlanResult {
  ok: boolean;
  error?: string;
  /** DEV/operator diagnostics for a failed composition: precise paths, never shown to a traveller. */
  diagnostics?: { failureKind: string; issueKind: string | null; detail: string; issues: readonly unknown[]; enforcement: string };
  result?: ReconcileResult;
  draft?: TripDraft;
  timings?: ProductionPlanTimingsMs;
  modelCalls?: readonly unknown[];
  /** LIVE WORLD V1 — what the provider budget spent and refused this build. */
  providerBudget?: ReturnType<ProviderBudget['report']>;
  /** QUALITY V1 — every draft anchor's fate; silent loss must be zero. */
  preservation?: DraftPreservationReport;
  /** QUALITY V1 — the deterministic structural audit. */
  quality?: QualityAudit;
  /** True when verification stopped at the product deadline and the trip was returned with what had verified. */
  degraded?: boolean;
}

/**
 * QUALITY V1 — stage timings. `totalMs` is wall time from entry to return;
 * `deadlineReached` says the verification budget fired. Kept flat so a log
 * line, a test and the persisted package read the same figures.
 */
export interface ProductionPlanTimingsMs {
  preparationMs: number;
  identityResolutionMs: number;
  compositionMs: number;
  placeResolutionMs: number;
  routingMs: number;
  operationalMs: number;
  reconciliationMs: number;
  verificationMs: number;
  intelligenceMs: number;
  persistenceMs: number;
  totalMs: number;
  deadlineReached: boolean;
  /**
   * DELIBERATION CLOSURE — what the composition was configured to do and what
   * the budget looked like when it finished.
   *
   * Four live builds were diagnosed by hand from three numbers on a log line.
   * These are the ones that were missing: the effort the call actually used,
   * and how much of the product budget the draft left behind — which is what
   * decides whether the traveller gets verification or just gets their trip.
   */
  compositionEffort?: 'low' | 'medium' | 'high';
  thinkingMode?: 'adaptive';
  remainingBudgetAfterCompositionMs?: number;
  /** Absent when verification ran normally; set when it was skipped or cut short, with the reason. */
  verificationDegradedReason?: string;
}

export const VERIFICATION_DEADLINE_ENV = 'SIDEQUEST_VERIFICATION_DEADLINE_MS';
export const PRODUCT_BUDGET_ENV = 'SIDEQUEST_GENERATION_BUDGET_MS';
/** The whole generation, model included, should return inside this. */
export const DEFAULT_PRODUCT_BUDGET_MS = 120_000;
/** The grant verification gets when the budget can afford it. Never a claim on time that is not there. */
const MIN_VERIFICATION_MS = 15_000;
const DEFAULT_VERIFICATION_DEADLINE_MS = 90_000;
const QUICK_VERIFICATION_DEADLINE_MS = 45_000;

export function productBudgetMs(): number {
  const raw = Number(process.env[PRODUCT_BUDGET_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRODUCT_BUDGET_MS;
}

/**
 * The verification deadline: an explicit override wins; otherwise the
 * remainder of the product budget after preparation and composition,
 * capped by the mode's own ceiling and floored so a slow model cannot leave
 * verification nothing.
 *
 * MVP V3, Stage 25 — the remainder now reserves one provider timeout.
 *
 * Every deadline check in the reconciler happens *before* a lookup, never
 * during one, so a request begun one millisecond inside the budget still ran to
 * its own timeout: the measured overshoot. Two answers, both applied. This is
 * the arithmetic half — the last request that may legally start still finishes
 * inside the budget. The other half is `withGenerationDeadline`, which lets an
 * in-flight socket actually be closed when the budget fires.
 */
export function verificationDeadlineMs(mode: GenerationMode, elapsedMs = 0): number {
  const raw = Number(process.env[VERIFICATION_DEADLINE_ENV]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const ceiling = mode === 'quick' ? QUICK_VERIFICATION_DEADLINE_MS : DEFAULT_VERIFICATION_DEADLINE_MS;
  const remaining = productBudgetMs() - elapsedMs - MAX_PROVIDER_REQUEST_MS;
  /*
   * The floor is a floor on the *grant*, never on the budget.
   *
   * This used to return fifteen seconds even when four remained, which is how
   * a finished draft could still lose its trip: verification was handed time
   * the product did not have, ran past the ceiling, and the traveller got a
   * failure page instead of the plan the model had already written. Clamped to
   * what is actually left; `draftFirstBudget` decides whether that is enough to
   * be worth starting at all.
   */
  return Math.max(0, Math.min(ceiling, Math.max(remaining >= MIN_VERIFICATION_MS ? MIN_VERIFICATION_MS : 0, remaining)));
}

/**
 * THE TRAVELLER GETS THE TRIP. VERIFICATION IS WHAT GIVES WAY.
 *
 * Once the model has answered, the draft is parsed, normalised, audited and
 * persisted — all of it deterministic and measured in milliseconds. Everything
 * after that is optional: identity lookups, routing, opening hours. Each is
 * worth having and none of them is worth the plan.
 *
 * So this is the last decision before any provider is touched. If what remains
 * of the product budget cannot hold a single provider round trip plus the
 * reconciliation around it, no provider is asked at all and the plan is built
 * from the draft alone — the same path a total provider outage takes, which
 * `acceptance/shapes.test.ts` shape 10 already holds to producing an itinerary
 * with zero content lost. The trip says honestly what it could not check.
 *
 * The shape this exists to make impossible: a complete draft, then ten seconds
 * of provider work that cannot finish, then the product ceiling, then a failure
 * page for a trip that was already written.
 */
export interface DraftFirstBudget {
  /** False means: skip every provider and return the plan built from the draft. */
  verify: boolean;
  /** How long verification may run when it runs at all. */
  deadlineMs: number;
  /** Said plainly, for the call log and the plan's own record. */
  reason: string;
  remainingMs: number;
}

/** One provider round trip plus room to reconcile around it. Below this, verification is not started. */
export const SAFE_VERIFICATION_MINIMUM_MS = MAX_PROVIDER_REQUEST_MS + 3_000;

export function draftFirstBudget(mode: GenerationMode, elapsedMs: number): DraftFirstBudget {
  const remainingMs = Math.max(0, productBudgetMs() - elapsedMs);
  const deadlineMs = verificationDeadlineMs(mode, elapsedMs);
  if (remainingMs < SAFE_VERIFICATION_MINIMUM_MS || deadlineMs <= 0) {
    return {
      verify: false,
      deadlineMs: 0,
      remainingMs,
      reason: `the draft arrived with ${Math.round(remainingMs / 1000)}s of the budget left, less than one provider round trip, so the trip was built from the draft alone`,
    };
  }
  return { verify: true, deadlineMs, remainingMs, reason: 'verification ran inside the remaining budget' };
}

export async function generateSidequestPlanForTrip(
  tripId: string,
  options: {
    caller?: string | null;
    now?: Date;
    mode?: GenerationMode;
    /** Called with the raw draft as soon as composition succeeds, before verification. The draft is also persisted at that point. */
    onDraftGenerated?: (draft: TripDraft) => void;
    /**
     * QUALITY V1 — re-verify from the draft already persisted for this trip:
     * no composition, no model call, no reservation. Everything after the
     * draft (resolution, routing, hours, corrections, intelligence,
     * persistence) runs exactly as on a build. Refused when no draft exists.
     */
    reuseStoredDraft?: boolean;
  } = {},
): Promise<ProductionPlanResult> {
  const now = options.now ?? new Date();
  const mode = options.mode ?? 'full';
  const startedMs = performance.now();
  const since = (from: number) => Math.round(performance.now() - from);

  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };
  /*
   * MVP V3, Stage 24 — the generation screen reads this, so every write below
   * is at a boundary the server actually crossed. Best-effort: a progress row
   * is never worth failing a build for.
   */
  const progress = (stage: Parameters<typeof markGenerationStage>[1]) => {
    try {
      markGenerationStage(tripId, stage, new Date());
    } catch {
      /* the build is what matters */
    }
  };
  try {
    beginGeneration(tripId, now);
  } catch {
    /* the build is what matters */
  }
  const intent = getIntent(tripId);
  const composer = intent?.composer ?? null;
  const profile = getProfile(tripId) ?? defaultProfileFor(trip, composer);

  const fixture = isFixtureComposer();
  if (!fixture && !isCompositionModelConfigured()) {
    return { ok: false, error: 'No model credential is configured, so we cannot compose a first draft yet.' };
  }

  // --- Preparation: region evidence and destination identity, in parallel ---
  const preparationStartedMs = performance.now();
  const regionWork = (async (): Promise<RegionContext | null> => {
    // Compiled evidence is optional: a trip that skipped compilation still gets a
    // complete draft, verified only through the geocoder and router that exist.
    const resolvedRegion = await resolveTripRegion(trip);
    let region: RegionContext | null = resolvedRegion.ok ? resolvedRegion.context : null;
    if (region) {
      // A plan is an explicit act and may buy a forecast; a render never does.
      await ensureWeatherForPlanning(weatherTargetFor(tripId, region.compiled, region.dates, region.weatherScopeKey), now);
      region = withRefreshedWeather(tripId, region);
    }
    return region;
  })();
  const identityStartedMs = performance.now();
  const candidateWork = destinationCandidateFor(trip, intent?.resolution ?? null, intent?.selectedCandidateId ?? null, now);
  const [region, candidate] = await Promise.all([regionWork, candidateWork]);
  const identityResolutionMs = since(identityStartedMs);
  const board = region ? boardFor(trip, profile, region) : null;

  /*
   * MVP V3, Stages 10–12 — THE DURABLE INTENT DECIDES WHAT THIS TRIP IS CALLED.
   *
   * The traveller's own phrase, and whether anything has earned the right to
   * replace it. "inland Alaska" resolving to a town is a *lead*, not a
   * correction, so `interpretedLabel` is still their words and the town travels
   * as a centre. Where no intent was ever recorded — a trip made before this
   * existed — the old derivation stands unchanged.
   */
  const storedIntent = intent?.destinationIntent ?? null;
  const resolvedName = candidate?.displayName ?? region?.region.name ?? trip.basics.destinationInput;
  const rawDestinationPhrase = (storedIntent?.rawText || intent?.destinationQuery || composer?.destinationQuery || trip.basics.destinationInput || '').trim();
  const destinationName = storedIntent?.interpretedLabel || resolvedName;
  const envelope: DestinationEnvelope = {
    name: destinationName,
    ...(candidate?.qualifiedName ? { qualifiedName: candidate.qualifiedName } : {}),
    ...(candidate?.countryCode ? { countryCode: candidate.countryCode } : {}),
    ...(candidate?.countryName ? { countryName: candidate.countryName } : {}),
    ...(candidate?.breadth ? { scale: candidate.breadth } : {}),
    center: candidate?.center ?? region?.region.baseCoordinates ?? { lat: 0, lng: 0 },
    ...(candidate?.timeZones?.[0] ? { timeZone: candidate.timeZones[0] } : {}),
    ...(region ? { knownAreas: region.compiled.subregions.map((s) => s.name).slice(0, 8) } : {}),
    ...(storedIntent && storedIntent.interpretationType !== 'unresolved' ? { interpretation: storedIntent.interpretationType } : {}),
    /*
     * The resolved place, when it did not earn the destination's name. It is a
     * centre to plan around and it is labelled as one; the model is told which
     * of the two is the traveller's own word.
     */
    ...(storedIntent?.anchor && normalizePhrase(storedIntent.anchor.label) !== normalizePhrase(destinationName)
      ? { anchorName: storedIntent.anchor.label }
      : {}),
    ...(rawDestinationPhrase && normalizePhrase(rawDestinationPhrase) !== normalizePhrase(destinationName) ? { travellerPhrase: rawDestinationPhrase } : {}),
  };

  const request = buildHybridTripRequest({ trip, composer, profile, now });
  const boardSignals = mode === 'full' && board ? boardSignalsFor(board.candidates, getSelections(tripId)) : undefined;
  /*
   * LIVE WORLD V1 — booked facts enter before composition. The model builds
   * around them; the deterministic layer verifies them after reconciliation.
   */
  const booked = listBookedItems(tripId);
  const bookedFacts = compactBookedFacts(booked);
  const brief = travelerBriefFor({ profile, trip, request, envelope, bookedFacts, ...(boardSignals ? { boardSignals } : {}) });
  const context: CompositionContext = { request, envelope, ...(boardSignals ? { boardSignals } : {}), brief, mode, ...(bookedFacts.length > 0 ? { bookedFacts } : {}) };
  const preparationMs = since(preparationStartedMs);

  let model: StructuredModel;
  if (options.reuseStoredDraft) {
    const stored = getTripDraft(tripId);
    if (!stored) return { ok: false, error: 'There is no saved draft for this trip to verify again.' };
    model = { callsRemaining: 1, structured: async () => stored.draft as never } as unknown as StructuredModel;
  } else if (fixture) {
    model = new FixtureComposer(context, {
      placeNames: (board?.candidates ?? []).slice(0, 40).map((c) => ({ name: displayNameOf(c.place), category: c.place.category })),
      baseNames: (region?.compiled.bases ?? []).map((b) => displayNameOf(b)),
      // With recorded places responses on hand, the fixture draft names a venue the board does not know, so the places path is exercised end to end.
      unlistedVenue: Boolean(process.env.SIDEQUEST_PLACES_FIXTURE),
    });
  } else {
    const reservation = reserveModelCalls(1, { now, caller: options.caller });
    if (!reservation.allowed) {
      return { ok: false, error: reservation.message ?? 'Today’s planning allowance is used up. Try again tomorrow.' };
    }
    model = new ResearchModel({ maxCalls: 1, maxRetries: 0, model: composerModel() });
  }

  /*
   * QUALITY V1 — weather for a trip with no compiled region: one location at
   * the destination centre, fetched (forecast inside the horizon, climate
   * beyond it) while the model composes, so the days carry a forecast badge
   * on the normal path too. Never blocks composition; a failure leaves the
   * honest "no weather" dataset.
   */
  const regionlessWeather = region || !candidate ? null : fetchRegionlessWeather({ tripId, trip, envelope, candidate, now });

  // --- Composition: the one model call ----------------------------------------
  /*
   * COMPOSITION RELIABILITY — the visible answer is persisted the moment it
   * arrives, before extraction or validation, under an attempt id; the
   * parser's verdict is recorded on the same row afterwards. A completed,
   * paid answer the normalizer refuses is reproducible from that row with
   * no further model call (`composition_attempts`).
   */
  const attemptId = randomUUID();
  const attemptNumber = listCompositionAttempts(tripId).length + 1;
  const wire = compositionWireDecision();
  const compositionStartedMs = performance.now();
  progress('composing');
  const outcome = await generateTripDraft({
    model,
    context,
    onRawResponse: fixture || options.reuseStoredDraft
      ? undefined
      : (raw) => {
          try {
            saveCompositionAttempt({ id: attemptId, tripId, attempt: attemptNumber, model: composerModel(), promptVersion: COMPOSITION_PROMPT_VERSION, enforcement: raw.enforcement, schemaSha256: wire.schemaSha256, stopReason: raw.stopReason, requestId: raw.requestId, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, elapsedMs: raw.elapsedMs, rawText: raw.text, parseStatus: 'pending', now });
          } catch (error) {
            console.error('Could not persist the composition attempt', { tripId, message: error instanceof Error ? error.message : 'unknown' });
          }
        },
  });
  const compositionMs = since(compositionStartedMs);
  const modelCalls = model instanceof ResearchModel ? [...model.callLog] : [];
  const emptyTimings = (): ProductionPlanTimingsMs => ({ preparationMs, identityResolutionMs, compositionMs, placeResolutionMs: 0, routingMs: 0, operationalMs: 0, reconciliationMs: 0, verificationMs: 0, intelligenceMs: 0, persistenceMs: 0, totalMs: since(startedMs), deadlineReached: false, compositionEffort: compositionEffort(), thinkingMode: 'adaptive' });
  if (!outcome.ok) {
    /*
     * The precise reason goes to the attempt row and the server log (paths,
     * codes, expected vs received — never the prompt); the traveller gets a
     * plain sentence and an explicit Retry. Nothing here retries.
     */
    const diagnostics = { failureKind: outcome.failureKind, issueKind: outcome.issueKind ?? null, detail: outcome.detail.slice(0, 500), issues: (outcome.issues ?? []).slice(0, 40), enforcement: outcome.enforcement };
    if (!fixture && !options.reuseStoredDraft) {
      try {
        recordCompositionParse({ id: attemptId, parseStatus: outcome.failureKind === 'malformed_output' ? (outcome.issueKind ?? 'no_json') : 'model_failed', parse: diagnostics, draftLinked: false });
      } catch {
        /* the log line below still carries it */
      }
    }
    try {
      finishGeneration(tripId, 'failed', new Date());
    } catch {
      /* the failure is already reported */
    }
    console.error(`Composition failed: ${outcome.failureKind}${outcome.issueKind ? `/${outcome.issueKind}` : ''} — ${outcome.detail.slice(0, 300)}${outcome.issues?.length ? ` | issues: ${JSON.stringify(outcome.issues.slice(0, 10))}` : ''} | calls: ${JSON.stringify(modelCalls.map((call) => ({ ...(call as unknown as Record<string, unknown>), schemaValidationIssues: undefined })))}`);
    return { ok: false, error: TRAVELLER_COMPOSITION_FAILURE, timings: emptyTimings(), modelCalls, diagnostics };
  }
  const draft = outcome.draft;
  if (!fixture && !options.reuseStoredDraft) {
    try {
      recordCompositionParse({ id: attemptId, parseStatus: 'ok', parse: { enforcement: outcome.enforcement, normalizedFields: outcome.normalizedFields }, normalizedFields: outcome.normalizedFields, draftLinked: true });
    } catch {
      /* the draft row itself is the record of success */
    }
  }
  if (!options.reuseStoredDraft) saveTripDraft({ tripId, draft, modelCall: modelCalls[0] ?? null, now });
  progress('route');
  options.onDraftGenerated?.(draft);

  // --- Verification + reconciliation, bounded by what is left of the budget ---
  const verificationStartedMs = performance.now();
  /*
   * DRAFT FIRST. The draft is already persisted above; this decides whether
   * there is enough of the budget left to ask a provider anything at all.
   * `deadlineReached` is the gate the reconciler consults before every lookup,
   * so a budget with no room makes it true from the outset and every optional
   * request is skipped rather than started and abandoned.
   */
  const budgetPolicy = draftFirstBudget(mode, since(startedMs));
  const deadlineMs = budgetPolicy.deadlineMs;
  const deadlineReached = () => !budgetPolicy.verify || performance.now() - verificationStartedMs > deadlineMs;
  if (!budgetPolicy.verify) console.warn('Verification skipped to deliver the trip', { tripId, reason: budgetPolicy.reason });
  const verification = verificationProviders(candidate?.id);
  const geocoder = isGeocoderEnabled() ? productionGeocodeLocality : undefined;
  const nearby = isGeocoderEnabled() || isPoiProviderEnabled() ? productionFindNearbyLocalities : undefined;
  const routing = verification.routing && verification.routing.supportedModes().length > 0 ? verification.routing : null;

  const mustIncludeNames = [...(boardSignals?.mustInclude ?? []), ...request.taste.mustDo];
  /*
   * LIVE WORLD V1 — every paid lookup this build may make is counted against
   * one budget sized by the draft itself; refusal means "verify later",
   * never a retry. Persisted identities from the last build are reused first.
   */
  const budget = new ProviderBudget(ceilingsFor({ anchors: draft.days.reduce((n, d) => n + d.anchors.length, 0), days: draft.days.length, bases: draft.bases.length, mealsNeedingVenue: draft.days.length * 2 }));
  const persistedIdentities = persistedIdentitiesFor(tripId);
  const resolvePlaceIdentity = placesIdentitySeam(budget);
  const operationalEvidence = operationalEvidenceSeam(budget, process.env, now);
  const identitySeams = { ...(persistedIdentities.size > 0 ? { persistedIdentities } : {}), ...(resolvePlaceIdentity ? { resolvePlaceIdentity } : {}), ...(operationalEvidence ? { operationalEvidence } : {}) };
  /*
   * Stage timers: the reconciler is one call, so the stages inside it are
   * measured by wrapping the seams it reaches — places, routing, hours — and
   * attributing their awaited time. Overlapping awaits (concurrent identity
   * lookups) count their wall time once each; the figures are for the
   * traveller's "what took the time" line, not for billing.
   */
  const stage = { placeResolutionMs: 0, routingMs: 0, operationalMs: 0 };
  const STAGE_MARK: Record<keyof typeof stage, Parameters<typeof markGenerationStage>[1]> = { placeResolutionMs: 'places', routingMs: 'travel', operationalMs: 'places' };
  const timed = <A extends unknown[], R>(key: keyof typeof stage, fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const from = performance.now();
    // The first time a seam is reached is the moment that stage genuinely began.
    progress(STAGE_MARK[key]);
    try {
      return await fn(...args);
    } finally {
      stage[key] += since(from);
    }
  };
  const timedSeams = {
    ...(identitySeams.persistedIdentities ? { persistedIdentities: identitySeams.persistedIdentities } : {}),
    ...(identitySeams.resolvePlaceIdentity ? { resolvePlaceIdentity: timed('placeResolutionMs', identitySeams.resolvePlaceIdentity) } : {}),
    ...(identitySeams.operationalEvidence ? { operationalEvidence: timed('operationalMs', identitySeams.operationalEvidence) } : {}),
  };
  const timedGeocoder = geocoder ? timed('placeResolutionMs', geocoder) : undefined;
  // PRODUCT RECOVERY V1 — the corridor settlement search used to be untimed; the live Ireland build spent most of a minute in it invisibly.
  const timedNearby = nearby ? timed('placeResolutionMs', nearby) : undefined;
  /*
   * PRODUCT RECOVERY V1 — route-aware weather: once the bases have positions,
   * one climate/forecast point per base (bounded) replaces the destination
   * centroid for the days at that base. Bounded by the deadline and by the
   * weather provider's own cache; a failure leaves the centroid dataset.
   */
  const weatherForBases: ReconcileContext['weatherForBases'] = async (locations) => {
    if (deadlineReached() || locations.length === 0) return null;
    const regionId = region?.region.id ?? `draft-region:${trip.id}`;
    const centre = envelope.center ?? { lat: 0, lng: 0 };
    const bounded = locations.slice(0, 8).map((l) => ({ id: `${regionId}:base:${l.id}`, label: l.label, coordinates: l.coordinates, elevationMetres: 0, timeZone: envelope.timeZone ?? 'UTC', placeIds: [l.id], limitation: 'One point for this base and the days around it.' }));
    const all: WeatherLocation[] = [...bounded, { ...regionlessWeatherLocation(regionId, { ...envelope, center: centre }) }];
    const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
    const scopeKey = weatherScopeKey({ regionId, dates, locations: all });
    try {
      await ensureWeatherForPlanning({ tripId, regionId, locations: all, dates, scopeKey }, now);
      const availability = weatherAvailability(getWeatherSnapshot(tripId, scopeKey), now);
      return availability.kind === 'present' ? availability.snapshot.dataset : null;
    } catch {
      return null;
    }
  };
  const routeMatrixFor = (m: 'car' | 'foot' | 'transit') => (routing ? timed('routingMs', (points: Parameters<typeof productionRouteMatrix>[2]) => productionRouteMatrix(routing, m, points)) : undefined);
  const confirmRouteFor = (m: 'car' | 'foot' | 'transit') =>
    routing ? timed('routingMs', (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => policyConfirmRoute({ routing, mode: m, from, to, departAt: new Date(`${trip.basics.startDate}T09:00:00Z`), now })) : undefined;

  const leaveBy = bookedLeaveByMinute(booked, trip.basics.endDate);
  const reconcileContext: ReconcileContext = region
    ? {
        tripId,
        basics: trip.basics,
        profile,
        region: region.region,
        candidates: board!.candidates,
        compiledPlaces: region.compiled.places,
        matrix: region.matrix,
        ...(region.transit ? { transit: region.transit } : {}),
        scheduledNetwork: region.scheduledNetwork,
        access: region.access,
        hours: region.hours,
        weather: region.weather,
        ...(region.food ? { food: region.food } : {}),
        now,
        baseId: region.baseId,
        compiledBases: region.compiled.bases,
        ...(timedGeocoder ? { geocodeLocality: timedGeocoder } : {}),
        ...(routing ? { routeMatrix: routeMatrixFor(region.matrix.mode)! } : {}),
        ...(routing ? { confirmRoute: confirmRouteFor(region.matrix.mode)! } : {}),
        ...(timedNearby ? { findNearbyLocalities: timedNearby } : {}),
        weatherForBases,
        destinationScope: productionDestinationScope(region.compiled),
        subregionGeometries: productionSubregionGeometries(region.compiled),
        deadlineReached,
        mustIncludeNames,
        ...timedSeams,
        ...(leaveBy !== null ? { lastDayLeaveByMinute: leaveBy } : {}),
      }
    : {
        ...contextWithoutRegion({ trip, profile, candidate, envelope, now, deadlineReached, mustIncludeNames, geocoder: timedGeocoder, nearby: timedNearby, routing, weather: (await regionlessWeather) ?? undefined }),
        ...(routing ? { routeMatrix: routeMatrixFor(profile.transport.willDrive ? 'car' : 'foot')!, confirmRoute: confirmRouteFor(profile.transport.willDrive ? 'car' : 'foot')! } : {}),
        weatherForBases,
        ...timedSeams,
        ...(leaveBy !== null ? { lastDayLeaveByMinute: leaveBy } : {}),
      };

  /*
   * MVP V3, Stage 25 — the budget is enforced, not merely consulted.
   *
   * One controller for this build, published on the async context so every
   * provider fetch merges it with its own timeout (`net/generation-deadline.ts`).
   * When the product budget fires, open sockets close and the reconciler
   * finishes with what it has: DEGRADED COMPLETE, inside 120 seconds, rather
   * than a complete answer at 132.
   */
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(new Error('Sidequest reached its generation budget.')), Math.max(1_000, productBudgetMs() - since(startedMs)));
  let reconciledRaw: ReconcileResult;
  try {
    reconciledRaw = await withGenerationDeadline(budgetController.signal, () => reconcileTripDraft({ draft, context: reconcileContext }));
  } finally {
    clearTimeout(budgetTimer);
  }
  /*
   * Booked reality, verified deterministically: the base is renamed to the
   * booked lodging, a booked ticket is pinned, a booked departure tightens
   * the last day, and anything the model did not honour is named as a
   * conflict on the itinerary — no second model call.
   */
  const applied = applyBookedFacts(reconciledRaw.itinerary, booked);
  const verificationMs = since(verificationStartedMs);
  const reconciliationMs = Math.max(0, verificationMs - stage.placeResolutionMs - stage.routingMs - stage.operationalMs);
  const degraded = deadlineReached();

  // --- Intelligence: preservation report + structural audit (deterministic) ---
  progress('preparing');
  const intelligenceStartedMs = performance.now();
  const preservation = buildPreservationReport(draft, applied.itinerary);
  const quality = auditItinerary({ draft, itinerary: applied.itinerary, profile, trip, bookedConflicts: applied.conflicts, preservation });
  const intelligenceMs = since(intelligenceStartedMs);

  /*
   * LIVE WORLD V1 — one dated reference rate, fetched at plan time and read on
   * every render, only when the destination's currency differs from the
   * traveller's and an FX provider is configured. A failure leaves the budget
   * in the traveller's currency and says nothing about rates.
   */
  const localCurrency = currencyForCountry(candidate?.countryCode ?? envelope.countryCode);
  const travellerCurrency = (profile.interview.budgetEnvelope as { currency?: string } | undefined)?.currency ?? 'USD';
  if (localCurrency && localCurrency !== travellerCurrency && capability('currency.fx')?.configured && budget.take('fx') && !degraded) {
    try {
      const rate = await fetchReferenceRate(travellerCurrency, localCurrency, { now });
      if (rate) saveFxRate(tripId, rate, now);
    } catch {
      /* the budget stays unconverted; nothing is invented */
    }
  }

  const persistenceStartedMs = performance.now();
  const timingsSoFar: ProductionPlanTimingsMs = {
    preparationMs,
    identityResolutionMs,
    compositionMs,
    placeResolutionMs: stage.placeResolutionMs,
    routingMs: stage.routingMs,
    operationalMs: stage.operationalMs,
    reconciliationMs,
    verificationMs,
    intelligenceMs,
    persistenceMs: 0,
    totalMs: since(startedMs),
    deadlineReached: degraded,
    compositionEffort: compositionEffort(),
    thinkingMode: 'adaptive',
    remainingBudgetAfterCompositionMs: budgetPolicy.remainingMs,
    ...(budgetPolicy.verify ? (degraded ? { verificationDegradedReason: 'verification stopped at its deadline; the trip was returned with what had verified' } : {}) : { verificationDegradedReason: budgetPolicy.reason }),
  };
  const itinerary = applied.itinerary.package
    ? {
        ...applied.itinerary,
        package: {
          ...applied.itinerary.package,
          preservation: {
            version: 1 as const,
            draftAnchors: preservation.draftAnchors,
            kept: preservation.kept,
            removed: preservation.removed,
            silentLoss: preservation.silentLoss,
            counts: { ...preservation.counts },
            draftSubstantiveDays: preservation.draftSubstantiveDays,
            finalSubstantiveDays: preservation.finalSubstantiveDays,
            collapsedDays: preservation.collapsedDays,
            summary: describePreservation(preservation),
          },
          quality: { version: 1 as const, passed: quality.passed, errors: quality.errors, warnings: quality.warnings, checks: quality.checks.map((c) => ({ ...c })) },
          /*
           * The persisted record is numbers only (`tripPackageSchema.timings`),
           * so a boolean becomes 0/1 and the two prose diagnostics — the effort
           * the call used and why verification gave way — stay on the returned
           * result and the log rather than being forced into a number-shaped
           * column they do not belong in.
           */
          timings: Object.fromEntries(
            Object.entries(timingsSoFar)
              .map(([key, value]) => [key, typeof value === 'boolean' ? (value ? 1 : 0) : value] as const)
              .filter((entry): entry is readonly [string, number] => typeof entry[1] === 'number'),
          ),
        },
      }
    : applied.itinerary;
  const reconciled = { ...reconciledRaw, itinerary };
  saveItinerary(reconciled.itinerary);
  saveReadiness(tripId, reconciled.readiness, now);
  const persistenceMs = since(persistenceStartedMs);

  const timings: ProductionPlanTimingsMs = { ...timingsSoFar, persistenceMs, totalMs: since(startedMs) };
  try {
    finishGeneration(tripId, 'ok', new Date());
  } catch {
    /* the itinerary is saved either way */
  }
  if (quality.errors > 0) {
    console.warn('Quality audit found structural errors', { tripId, errors: quality.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => `${c.id}: ${c.detail}`) });
  }
  return {
    ok: true,
    result: reconciled,
    draft,
    timings,
    modelCalls,
    providerBudget: budget.report(),
    preservation,
    quality,
    degraded,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Case- and punctuation-insensitive, so "Hong Kong" and "hong kong" are one phrase. */
function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * QUALITY V1 — one compact traveller brief instead of forty settings. Built
 * from the stored profile (hard rules first, assumptions marked) plus the
 * trip facts, bookings and board signals; rendered as XML in the task. Pure,
 * so tests can prove that changing one answer changes the brief.
 */
export function travelerBriefFor(input: {
  profile: TravelerProfile;
  trip: Trip;
  request: BenchmarkTripRequest;
  envelope: DestinationEnvelope;
  bookedFacts?: readonly string[];
  boardSignals?: BoardSignals;
}): TravelerBrief {
  const { profile, trip, request, envelope, boardSignals } = input;
  const bookedFacts = input.bookedFacts ?? [];
  return buildTravelerBrief({
    profile,
    trip: {
      destination: envelope.name,
      ...(envelope.qualifiedName ? { qualifiedName: envelope.qualifiedName } : {}),
      ...(envelope.countryName ? { countryName: envelope.countryName } : {}),
      ...(envelope.scale ? { scale: envelope.scale } : {}),
      startDate: trip.basics.startDate,
      endDate: trip.basics.endDate,
      nights: request.dates.nights,
      days: request.dates.nights + 1,
      season: seasonOf(trip.basics.startDate, envelope.center?.lat),
      adults: trip.basics.adults,
      children: trip.basics.children,
      seniors: request.party.seniorsInGroup,
      arrival: describeEdge(request.arrival),
      departure: describeEdge(request.departure),
      ...(request.origin ? { origin: request.origin } : {}),
      bookedFacts,
    },
    signals: { mustInclude: [...(boardSignals?.mustInclude ?? []), ...request.taste.mustDo], boardLikes: boardSignals?.interested ?? [], boardRejects: boardSignals?.avoid ?? [] },
    ownWords: { mustDo: request.taste.mustDo, dislikes: request.taste.dislikes, freeText: request.freeText, mobilityNotes: request.party.mobilityNotes },
  });
}

/**
 * A profile for a traveller who skipped the questionnaire: the product's own
 * defaults, with whatever the composer captured (pace, transport, driving
 * limit, intensity) applied on top. Never a fact about the world — every
 * value here is a preference with a documented default.
 */
export { defaultProfileFor } from './default-profile';

/** Discovery Board decisions as compact signals — never a list of what exists. */
export function boardSignalsFor(
  candidates: readonly { place: Place }[],
  selections: readonly { placeId: string; status: string }[],
): BoardSignals | undefined {
  if (selections.length === 0) return undefined;
  const nameById = new Map(candidates.map((c) => [c.place.id, displayNameOf(c.place)] as const));
  const mustInclude: string[] = [];
  const interested: string[] = [];
  const avoid: string[] = [];
  for (const selection of selections) {
    const name = nameById.get(selection.placeId);
    if (!name) continue;
    if (selection.status === 'included') mustInclude.push(name);
    else if (selection.status === 'maybe') interested.push(name);
    else if (selection.status === 'excluded') avoid.push(name);
  }
  if (mustInclude.length + interested.length + avoid.length === 0) return undefined;
  return { mustInclude: mustInclude.slice(0, 10), interested: interested.slice(0, 10), avoid: avoid.slice(0, 10) };
}

async function destinationCandidateFor(
  trip: Trip,
  resolution: { candidates: readonly DestinationCandidate[]; unambiguousCandidateId?: string } | null,
  selectedCandidateId: string | null,
  now: Date,
): Promise<DestinationCandidate | null> {
  if (resolution) {
    const chosen = resolution.candidates.find((c) => c.id === (selectedCandidateId ?? resolution.unambiguousCandidateId));
    if (chosen) return chosen;
    if (resolution.candidates[0]) return resolution.candidates[0];
  }
  try {
    const { resolver } = verificationProviders();
    if (!resolver) return null;
    const resolved = await resolver.resolve({ query: trip.basics.destinationInput, now });
    return resolved.candidates.find((c) => c.id === resolved.unambiguousCandidateId) ?? resolved.candidates[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The verification context for a trip with no compiled region: an empty
 * board, an empty matrix, no hours and no weather — every anchor verifies
 * through the geocoder alone, every leg through the router alone, and
 * everything else is honestly unknown. This is the Quick Plan and
 * provider-outage shape, and it must never collapse the draft.
 */
export function contextWithoutRegion(input: {
  trip: Trip;
  profile: TravelerProfile;
  candidate: DestinationCandidate | null;
  envelope: DestinationEnvelope;
  now: Date;
  deadlineReached: () => boolean;
  mustIncludeNames: readonly string[];
  geocoder: ReconcileContext['geocodeLocality'] | undefined;
  nearby: ReconcileContext['findNearbyLocalities'] | undefined;
  routing: RoutingProvider | null;
  /** A dataset fetched for the destination centre, when one was; otherwise the honest "not fetched" dataset. */
  weather?: WeatherDataset;
}): ReconcileContext {
  const { trip, profile, candidate, envelope } = input;
  const regionId = `draft-region:${trip.id}`;
  const center = envelope.center ?? { lat: 0, lng: 0 };
  const region: Region = {
    id: regionId,
    name: envelope.name,
    baseName: envelope.name,
    baseCoordinates: center,
    summary: `${envelope.qualifiedName ?? envelope.name}, planned from a composed draft without a compiled region.`,
    maxRadiusKm: candidate?.breadth === 'country' ? 800 : candidate?.breadth === 'region' ? 300 : 120,
    aliases: [],
    transportSummary: 'Getting around has not been compiled for this destination; the plan states its own transport strategy.',
    noVehicleSummary: 'Without a car, rely on the transport strategy the plan states and verify locally.',
  };
  const mode = profile.transport.willDrive ? 'car' : 'foot';
  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
  const weather =
    input.weather ??
    unavailableWeatherDataset({
      regionId,
      locations: [regionlessWeatherLocation(regionId, envelope)],
      dates,
      now: input.now,
      reason: 'not_configured',
      message: 'No weather was fetched for this trip; nothing here was placed against a forecast.',
    });
  return {
    tripId: trip.id,
    basics: trip.basics,
    profile,
    region,
    candidates: [],
    compiledPlaces: [],
    matrix: { mode, ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'No compiled matrix; every leg is measured on demand or left unmeasured.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather,
    now: input.now,
    baseId: `${regionId}:centre`,
    compiledBases: [],
    ...(input.geocoder ? { geocodeLocality: input.geocoder } : {}),
    ...(input.routing ? { routeMatrix: (points) => productionRouteMatrix(input.routing!, mode, points) } : {}),
    ...(input.routing ? { confirmRoute: (from, to) => policyConfirmRoute({ routing: input.routing!, mode, from, to, departAt: new Date(`${trip.basics.startDate}T09:00:00Z`), now: input.now }) } : {}),
    ...(input.nearby ? { findNearbyLocalities: input.nearby } : {}),
    destinationScope: {
      ...(candidate?.countryCode ? { countryCode: candidate.countryCode } : {}),
      ...(candidate?.bounds ? { administrativeBounds: candidate.bounds } : {}),
      boundaryEvidence: candidate?.bounds ? 'published_boundary' : 'reach_circle',
      reachRadiusKm: region.maxRadiusKm,
    },
    subregionGeometries: [],
    deadlineReached: input.deadlineReached,
    mustIncludeNames: input.mustIncludeNames,
  };
}

/** The one weather location a trip without a compiled region reads: its centre. */
export function regionlessWeatherLocation(regionId: string, envelope: DestinationEnvelope): WeatherLocation {
  return {
    id: `${regionId}:centre`,
    label: envelope.name,
    coordinates: envelope.center ?? { lat: 0, lng: 0 },
    elevationMetres: 0,
    timeZone: envelope.timeZone ?? 'UTC',
    placeIds: [`${regionId}:centre`],
    limitation: 'One point for the whole destination; conditions vary across it.',
  };
}

async function fetchRegionlessWeather(input: { tripId: string; trip: Trip; envelope: DestinationEnvelope; candidate: DestinationCandidate; now: Date }): Promise<WeatherDataset | null> {
  const regionId = `draft-region:${input.trip.id}`;
  const dates = tripDates(input.trip.basics.startDate, input.trip.basics.endDate);
  const locations = [regionlessWeatherLocation(regionId, input.envelope)];
  const scopeKey = weatherScopeKey({ regionId, dates, locations });
  try {
    await ensureWeatherForPlanning({ tripId: input.tripId, regionId, locations, dates, scopeKey }, input.now);
    const availability = weatherAvailability(getWeatherSnapshot(input.tripId, scopeKey), input.now);
    return availability.kind === 'present' ? availability.snapshot.dataset : null;
  } catch {
    return null;
  }
}

/** Exposed for tests that assert what the composition call is (and is not) told. */
export function compositionPreview(context: CompositionContext): { task: string; untrusted: Record<string, unknown> } {
  return { task: buildCompositionTask(context), untrusted: compositionUntrustedPayload(context) };
}
