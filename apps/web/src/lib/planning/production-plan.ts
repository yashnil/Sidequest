import 'server-only';
import {
  buildTravelerBrief,
  countNights,
  journeyFromSegment,
  measurementAvailability,
  selectModes,
  travelModeOfSegment,
  countryFacts,
  currencyForCountry,
  deriveOperatingModel,
  deriveTravelerIntent,
  type TravelerBrief,
  displayNameOf,
  tripDates,
  unavailableWeatherDataset,
  type DestinationCandidate,
  type Place,
  type Region,
  type TravelerProfile,
  type Trip,
  type TripComposerAnswers,
  type TravelerBriefPartyMember,
} from '@sidequest/core';
import type { StructuredModel } from '../providers/interpretation-model';
import type { RoutingProvider } from '@sidequest/compiler';
import { ResearchModel } from '../providers/anthropic';
import { isCompositionModelConfigured, isFixtureComposer, isGeocoderEnabled, isPoiProviderEnabled } from '../providers/switches';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { verificationProviders } from './verification-providers';
import { getIntent, saveComposerAnswers } from '../db/compiler-repository';
import { getTripDraft, listCompositionAttempts, recordCompositionParse, saveCompositionAttempt, saveTripDraft } from '../db/draft-repository';
import { randomUUID } from 'node:crypto';
import { getAnswers, getProfile, getSelections, getTrip, saveItinerary, saveReadiness, updateTripDates } from '../db/repository';
import { boardFor, resolveTripRegion, withRefreshedWeather, type RegionContext } from '../region';
import { ensureWeatherForPlanning, weatherTargetFor } from '../weather/refresh';
import { getWeatherSnapshot, weatherScopeKey } from '../weather/snapshot-repository';
import { weatherAvailability, type WeatherDataset, type WeatherLocation } from '@sidequest/core';
import { composerModel } from './composition-model';
import { buildCanonicalTripBuildInput, compositionTimingBriefOf, type CanonicalTripBuildInput } from './canonical-input';
import { buildTripContract, contractEnforcementRecord, enforceContractOnDraft } from './trip-contract';
import { buildFeasibilityReport, buildStructuralMetrics, buildTripQualityReport, tripStructureOf, decomposeDestination, itineraryStatusForVerdict, needsDecomposition, routeObjectivesFor } from '@sidequest/core';
import { COMPOSITION_PROMPT_VERSION, buildCompositionTask, compositionEffort, compositionUntrustedPayload, compositionWireDecision, generateTripDraft, seasonOf, type BoardSignals, type CompositionContext, type DestinationEnvelope } from './composition';
import { FixtureComposer } from './fixture-composer';
import { reconcileTripDraft, type ReconcileContext, type ReconcileResult } from './reconcile';
import {
  productionDestinationScope,
  productionFindNearbyLocalities,
  productionGeocodeLocality,
  productionRouteMatrix,
  productionSubregionGeometries,
} from './skeleton-orchestrator';
import { episodesOf, type TripDraft } from './trip-draft';
import { defaultProfileFor } from './default-profile';
import { listBookedItems } from '@/lib/db/intelligence-repository';
import { listPartyMembersForBrief, listPartyMembersForContract, partyFactsFor, profileWithPartyDiet } from '@/lib/db/party-repository';
import { affordancesForTrip, realityForTrip } from '@/lib/interview/screening';
import { learnedForOwner } from '@/lib/db/preference-evidence-repository';
import { compactBookedFacts } from '@/lib/intelligence/booked-facts';
import { applyBookedFacts, bookedLeaveByMinute } from '@/lib/intelligence/booked-reconcile';
import { policyConfirmRoute } from './route-selection';
import { operationalEvidenceSeam, persistedIdentitiesFor, placesIdentitySeam } from './place-identity';
import { ProviderBudget, ceilingsFor } from '../providers/cost-budget';
import { buildPreservationReport, describePreservation, type DraftPreservationReport } from './preservation';
import { auditItinerary, type QualityAudit } from './quality-audit';
import { compileQualitySafely } from './quality-compiler';
import { deriveExperienceGraph } from './experience-graph';
import { accessConstraintsFor } from '../providers/access-constraints';
import { mobilityCapabilities } from '../providers/mobility-capabilities';
import { capability } from '../providers/registry';
import { MAX_PROVIDER_REQUEST_MS, withGenerationDeadline } from '../net/generation-deadline';
import { beginGeneration, finishGeneration, markGenerationDraftSaved, markGenerationModelInvoked, markGenerationStage, noteGenerationCounters, noteGenerationPlaced, type GenerationCounters } from '../db/generation-progress-repository';
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
    /**
     * PRODUCTION LOCK V5 — verify and persist THIS draft, with no model call.
     *
     * The refinement path (`refine/`) produces a patched draft deterministically
     * and then needs everything after the draft: identity resolution, routing,
     * hours, corrections, intelligence, persistence. That is this function's
     * whole second half, and reproducing it would be a second, quietly different
     * verification pipeline.
     *
     * Distinct from `reuseStoredDraft`, which re-verifies whatever is already in
     * `trip_drafts`. This supplies the draft, saves it, and carries on. Like
     * `reuseStoredDraft` it reserves nothing and calls no model — a refinement's
     * one model call is spent by the interpreter before this is reached.
     */
    useDraft?: TripDraft;
    /**
     * V8 — the durable run this generation belongs to. When the press already
     * recorded a run under this key, `beginGeneration` attaches to it rather
     * than replacing it; see `planning/build-runs.ts`.
     */
    buildKey?: string | null;
  } = {},
): Promise<ProductionPlanResult> {
  const now = options.now ?? new Date();
  const mode = options.mode ?? 'full';
  const startedMs = performance.now();
  const since = (from: number) => Math.round(performance.now() - from);

  /*
   * `tripRow` rather than `trip`, because §6 lets the composition choose the
   * dates: `trip` below is rebound to the row as it stands AFTER any window the
   * model picked has been adopted, so everything downstream — reconciliation,
   * weather, the itinerary, the audit — reads one set of dates.
   */
  const tripRow = getTrip(tripId);
  if (!tripRow) return { ok: false, error: 'We could not find that trip any more.' };
  /* Rebound after composition when the model chose the window (§6). */
  let trip = tripRow;
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
    beginGeneration(tripId, now, { buildKey: options.buildKey ?? null, caller: options.caller ?? null });
  } catch {
    /* the build is what matters */
  }
  const intent = getIntent(tripId);
  const composer = intent?.composer ?? null;
  const profile = getProfile(tripId) ?? defaultProfileFor(trip, composer);
  /*
   * V6 — Sidequest's own checks read the party's kitchen rule; the brief does
   * not (it reads the party person by person). See `mergePartyDiet`.
   */
  const verifyingProfile = profileWithPartyDiet(profile, tripId);

  const fixture = isFixtureComposer();
  /*
   * The credential is needed to COMPOSE, and only to compose.
   *
   * `reuseStoredDraft` and `useDraft` both supply the draft and reach the model
   * seam not at all — the first re-verifies what is already persisted, the
   * second applies a refinement patch. Refusing those for want of a credential
   * they will never use made "verify this again" and "apply my edit" impossible
   * on a machine that had simply unset the key, and made the zero-call paths
   * indistinguishable from the paid one at the point it matters most.
   */
  const willCompose = !options.reuseStoredDraft && !options.useDraft;
  if (willCompose && !fixture && !isCompositionModelConfigured()) {
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
  /*
   * V10 §2 — THE ONE CANONICAL DESTINATION OBJECT.
   *
   * Setup resolved it, the questionnaire read it, and from here it is what
   * composition, the placement ladder, the quality compiler and the jurisdiction
   * language all read. Nothing downstream derives its own second account of the
   * destination, which is how a mountain region became a country on one screen
   * and a currency sentence on another.
   */
  const concept = storedIntent?.semantics ?? null;
  const conceptCountries = concept?.countries ?? (candidate?.countryCode ? [candidate.countryCode] : []);
  const divisions = (concept?.jurisdictions ?? []).filter((j) => j.level === 'subnational').map((j) => j.name);
  /*
   * V10 §8 — the gateways, in order of authority.
   *
   * The traveller's own scope first, because a gateway they named (`fixed`) is a
   * fact and not a suggestion; then the rest of the scope's gateways; then the
   * ones the semantic layer inferred for the destination, already placed and
   * gated. Context, never the destination — the plan's edges are built around
   * them, and no gateway is ever a place to spend the trip.
   */
  const scopeGateways = [...(intent?.scope?.gateways ?? [])].sort((a, b) => Number(b.fixed) - Number(a.fixed));
  const conceptGateways = [
    ...scopeGateways.map((g) => ({ label: g.name, ...(g.coordinates ? { coordinates: g.coordinates } : {}) })),
    ...(concept?.gateways ?? []).map((g) => ({ label: g.label, ...(g.center ? { coordinates: g.center } : {}) })),
  ].filter((g, index, all) => all.findIndex((other) => other.label.toLowerCase() === g.label.toLowerCase()) === index);
  /*
   * V10 §3 — the coverage graph, derived from what already placed. A broad
   * natural or cultural region is decomposed before composition; a city is one
   * zone; a destination nobody has placed is no zones and a sentence saying so.
   * Pure and free: no provider call, no model call, no destination name in the
   * code that produces it.
   */
  const decomposition =
    concept && needsDecomposition(concept)
      ? decomposeDestination({
          concept,
          ...(region ? { signatureExperiences: region.compiled.subregions.slice(0, 6).map((s) => ({ name: s.name, ...(s.center ? { near: s.center } : {}) })) } : {}),
        })
      : null;
  /*
   * V10 §9 §11 — the operational facts that shape the plan, in the composition's
   * hands rather than corrected out of it afterwards. A closure the model never
   * proposes needs no correction; a shuttle-only lake designed for as a shuttle
   * day is a better day than one turned into a warning.
   */
  const accessFacts = accessConstraintsFor(conceptCountries)
    .filter((c) => c.status !== 'unknown' && c.status !== 'open')
    .filter((c) => {
      const from = c.validFrom ?? '0000-01-01';
      const until = c.validUntil ?? '9999-12-31';
      return trip.basics.endDate >= from && trip.basics.startDate <= until;
    })
    .slice(0, 10)
    .map((c) => `${c.travellerNote} (${c.sourceName})`);
  /* V10 §11 — the route's objectives, derived from the traveller's own answers and the destination's own shape. */
  const routeObjectives = routeObjectivesFor({
    concept,
    profile,
    nights: countNights(trip.basics.startDate, trip.basics.endDate),
    ...(decomposition ? { coreZones: decomposition.zones.filter((z) => z.role === 'core').length } : {}),
  });
  const resolvedName = candidate?.displayName ?? region?.region.name ?? trip.basics.destinationInput;
  const rawDestinationPhrase = (storedIntent?.rawText || intent?.destinationQuery || composer?.destinationQuery || trip.basics.destinationInput || '').trim();
  const destinationName = storedIntent?.interpretedLabel || resolvedName;
  const referenceTimeZone = (() => {
    const codes = [...(intent?.destinationIntent?.graph?.countries ?? []), ...(candidate?.countryCode ? [candidate.countryCode] : [])];
    for (const code of codes) {
      const zone = countryFacts(code)?.timeZone;
      if (zone) return zone;
    }
    return null;
  })();
  const envelope: DestinationEnvelope = {
    name: destinationName,
    ...(candidate?.qualifiedName ? { qualifiedName: candidate.qualifiedName } : {}),
    ...(candidate?.countryCode ? { countryCode: candidate.countryCode } : {}),
    ...(candidate?.countryName ? { countryName: candidate.countryName } : {}),
    ...(candidate?.breadth ? { scale: candidate.breadth } : {}),
    center: candidate?.center ?? region?.region.baseCoordinates ?? { lat: 0, lng: 0 },
    /* The candidate's zone, else the first named country's reference zone: a sunset computed in UTC is a wrong sunset, not a missing one. */
    ...(candidate?.timeZones?.[0] ? { timeZone: candidate.timeZones[0] } : referenceTimeZone ? { timeZone: referenceTimeZone } : {}),
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
    /*
     * V10 §3 §11 — THE SEMANTIC ENVELOPE THE COMPOSITION CALL DESERVES.
     *
     * Before V10 a broad region reached the one call as a name, a scale word and
     * a centre, and was asked to invent both the geography and the trip. It now
     * arrives with its coverage graph (the areas a trip here can be built from,
     * their roles and their distances), its jurisdictions kept separate from
     * itself, its gateways, the operational facts that would otherwise have to be
     * corrected afterwards, and what the route is for. Every one of those is
     * derived from evidence Sidequest already holds — nothing here is a new
     * provider call, and nothing is an allow-list.
     */
    ...(decomposition && decomposition.zones.length > 0
      ? {
          coverage: decomposition.zones.map((zone) => ({ label: zone.label, role: zone.role, kmFromCentre: zone.kmFromCentre, signatureExperiences: zone.signatureExperiences })),
          coverageNote: decomposition.note,
        }
      : {}),
    ...(concept && concept.jurisdictions.length > 0 ? { jurisdictions: concept.jurisdictions.map((j) => ({ level: j.level, name: j.name })) } : {}),
    ...(conceptGateways.length > 0 ? { gateways: conceptGateways.map((g) => g.label) } : {}),
    ...(accessFacts.length > 0 ? { accessFacts } : {}),
    ...(routeObjectives.length > 0 ? { routeObjectives } : {}),
  };

  const boardSignals = mode === 'full' && board ? boardSignalsFor(board.candidates, getSelections(tripId)) : undefined;
  /*
   * LIVE WORLD V1 — booked facts enter before composition. The model builds
   * around them; the deterministic layer verifies them after reconciliation.
   */
  const booked = listBookedItems(tripId);
  const bookedFacts = compactBookedFacts(booked);
  /*
   * PRODUCTION LOCK V5 §2 — ONE PRODUCTION BUILD INPUT, NO BENCHMARK SCHEMA.
   *
   * `buildHybridTripRequest` used to sit here and produce a
   * `BenchmarkTripRequest`, whose narrow vocabularies bounded the whole
   * production path and crashed a real trip whose diet the benchmark could not
   * represent. `CanonicalTripBuildInput` holds only real product state and every
   * planning-critical value carries its own lineage.
   */
  const input = buildCanonicalTripBuildInput({ trip, composer, profile, bookedFacts, destinationPhrase: rawDestinationPhrase, now });
  const partyForBrief = listPartyMembersForBrief(tripId, profile.interests as Record<string, string>);
  /* V6 §18 — leanings from earlier trips on the same account, medium confidence or better, phrased as leanings. */
  const learned = trip.userId ? learnedForOwner({ userId: trip.userId, ownerToken: null }, now).hints : [];
  const brief = travelerBriefFor({ input, envelope, ...(boardSignals ? { boardSignals } : {}), party: partyForBrief, learned });
  const timing = compositionTimingBriefOf(input.timing, now);
  /*
   * V6 §2 — THE TRIP CONTRACT, ASSEMBLED ONCE, BEFORE THE ONE CALL.
   *
   * What is decided, by whom, at what lock. The composition task renders it
   * as MUST KEEP / MUST AVOID / MAY DECIDE / SIDEQUEST WILL VERIFY; the
   * enforcement below refuses any model field that contradicts a lock and
   * records the conflict on the package.
   */
  let contract = buildTripContract({ trip, input, bookedFacts, members: listPartyMembersForContract(tripId), now });
  /*
   * V7 §3 — the travel reality, from the same inputs the interview read, so
   * what the interview promised and what the plan is built with agree. It
   * reaches the composition as `<travel_reality>`, the audit as the transport
   * check, and the package so the hub and the intelligence read the same.
   */
  const partyFacts = partyFactsFor(tripId);
  const reality = (() => {
    try {
      return realityForTrip({ trip, intent, region, ...(partyFacts ? { party: partyFacts } : {}), ...(profile.provenance.transport_mode?.source === 'explicit' ? { willDrive: profile.transport.willDrive } : {}) });
    } catch (error) {
      console.warn('Travel reality could not be built; the plan proceeds without it', { tripId, message: error instanceof Error ? error.message : 'unknown' });
      return null;
    }
  })();
  /*
   * V12 §2 §4 §6 — WHAT KIND OF PLANNING PROBLEM THIS IS, DECIDED BEFORE THE CALL.
   *
   * Three pure derivations, no model and no provider between them: what the
   * traveller means by their answers, what this ground supports, and — from the
   * meeting of the two — how the trip should work. The composition call is told
   * the result as a policy, and the verification layers read the same record
   * afterwards, so "what were we trying to build" and "did we build it" are one
   * fact rather than two opinions.
   *
   * Wrapped, because none of it may cost a trip: a derivation that throws leaves
   * the build exactly as it was before V12.
   */
  const storedAnswers = getAnswers(tripId);
  const derived = (() => {
    try {
      const affordances = affordancesForTrip({ trip, intent, region, ...(partyFacts ? { party: partyFacts } : {}), ...(profile.provenance.transport_mode?.source === 'explicit' ? { willDrive: profile.transport.willDrive } : {}) });
      const travelerIntent = deriveTravelerIntent({
        profile,
        /* The role answers as the traveller gave them, where this trip has stored answers. */
        ...(storedAnswers?.interestRoles ? { interestRoles: storedAnswers.interestRoles } : {}),
        ...(trip.basics.children > 0 ? { party: { children: trip.basics.children } } : {}),
      });
      const operating = deriveOperatingModel({ intent: travelerIntent, affordances, nights: brief.tripFacts.nights, willDrive: profile.transport.willDrive });
      /*
       * V12.1 §6 §7 — WHAT THIS TRIP CAN ACTUALLY MOVE BY, BEFORE THE CALL.
       *
       * Prevention at source. The reconciler refuses a hint the world does not
       * support, and a refusal is still a leg whose mode had to be replaced; a
       * model told plainly that this trip does not cross water does not propose
       * a ferry between a lake and its own shore in the first place.
       *
       * Derived from the same affordances and the same country reality the
       * verification layers read afterwards, so what the model was told and what
       * it is judged against are one fact rather than two.
       */
      const mobility = selectModes({ policy: operating.policy, world: { affordances, reality } });
      return { operating, mobility, affordances };
    } catch (error) {
      console.warn('The operating model could not be derived; the plan proceeds without it', { tripId, message: error instanceof Error ? error.message : 'unknown' });
      return null;
    }
  })();
  const operating = derived?.operating ?? null;

  const context: CompositionContext = {
    envelope,
    ...(boardSignals ? { boardSignals } : {}),
    brief,
    mode,
    ...(bookedFacts.length > 0 ? { bookedFacts } : {}),
    timing,
    contract,
    reality,
    operating,
    ...(derived?.mobility ? { mobility: derived.mobility } : {}),
    planningFacts: { carAvailable: input.movement.carAvailable, desiredBaseCount: input.movement.desiredBaseCount.value ?? 1, budgetBand: profile.budgetStyle },
  };
  const preparationMs = since(preparationStartedMs);

  let model: StructuredModel;
  if (options.useDraft) {
    const supplied = options.useDraft;
    model = { callsRemaining: 1, structured: async () => supplied as never } as unknown as StructuredModel;
  } else if (options.reuseStoredDraft) {
    const stored = getTripDraft(tripId);
    if (!stored) return { ok: false, error: 'There is no saved draft for this trip to verify again.' };
    model = { callsRemaining: 1, structured: async () => stored.draft as never } as unknown as StructuredModel;
  } else if (fixture) {
    model = new FixtureComposer(context, {
      placeNames: (board?.candidates ?? []).slice(0, 40).map((c) => ({ name: displayNameOf(c.place), category: c.place.category })),
      baseNames: (region?.compiled.bases ?? []).map((b) => displayNameOf(b)),
      // With recorded places responses on hand, the fixture draft names a venue the board does not know, so the places path is exercised end to end.
      unlistedVenue: Boolean(process.env.SIDEQUEST_PLACES_FIXTURE),
      destinationInput: trip.basics.destinationInput,
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
  /* V8 — from here a failure has a cost: the composition is being invoked. */
  try {
    markGenerationModelInvoked(tripId, new Date());
  } catch {
    /* progress is best-effort */
  }
  const outcome = await generateTripDraft({
    model,
    context,
    onRawResponse: fixture || options.reuseStoredDraft || options.useDraft
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
    if (!fixture && !options.reuseStoredDraft && !options.useDraft) {
      try {
        recordCompositionParse({ id: attemptId, parseStatus: outcome.failureKind === 'malformed_output' ? (outcome.issueKind ?? 'no_json') : 'model_failed', parse: diagnostics, draftLinked: false });
      } catch {
        /* the log line below still carries it */
      }
    }
    let failureRef: string | null = null;
    try {
      failureRef = finishGeneration(tripId, 'failed', new Date(), { kind: 'model_failed' }).ref;
    } catch {
      /* the failure is already reported */
    }
    console.error(`Composition failed [ref ${failureRef ?? 'none'}]: ${outcome.failureKind}${outcome.issueKind ? `/${outcome.issueKind}` : ''} — ${outcome.detail.slice(0, 300)}${outcome.issues?.length ? ` | issues: ${JSON.stringify(outcome.issues.slice(0, 10))}` : ''} | calls: ${JSON.stringify(modelCalls.map((call) => ({ ...(call as unknown as Record<string, unknown>), schemaValidationIssues: undefined })))}`);
    return { ok: false, error: TRAVELLER_COMPOSITION_FAILURE, timings: emptyTimings(), modelCalls, diagnostics };
  }
  /*
   * V6 §2 — ENFORCE THE CONTRACT BEFORE ANYTHING READS THE DRAFT.
   *
   * A window returned against locked dates is dropped here, with a recorded
   * conflict, so the adoption below can never see it. This is the second
   * half of "a traveller accepting June can never receive October": the first
   * half is that the lock exists at all (`trips.timing_lock`).
   */
  const enforced = enforceContractOnDraft(contract, outcome.draft, now);
  const draft = enforced.draft;
  const contractConflicts = enforced.conflicts;
  if (contractConflicts.length > 0) {
    console.warn('The composition contradicted a locked fact; the contract was kept', { tripId, conflicts: contractConflicts.map((c) => `${c.field}: ${c.contractValue} vs ${c.proposedValue} → ${c.resolution}`) });
  }
  /*
   * PRODUCTION LOCK V5 §5/§6 — THE WINDOW THE MODEL CHOSE BECOMES THE TRIP'S DATES.
   *
   * Without this the whole "tell me when it is best" feature is decoration: the
   * model picks a window, the draft carries it, and the itinerary is still dated
   * to the placeholder the trip row was created with — so every day's date, its
   * weather and its daylight belong to a month nobody chose. A live Hong Kong
   * walk showed the placeholder ("Oct 13–18") in the chrome before a single day
   * had been composed.
   *
   * Applied only when the traveller actually asked Sidequest to choose, and only
   * when the window is a real pair of dates spanning the nights they asked for.
   * A malformed or wrong-length window is ignored rather than trusted: the
   * placeholder is at least the right *length*, and silently changing a trip's
   * duration because a date string was mistyped is a worse failure than keeping
   * the month wrong.
   */
  if (input.timing.sidequestChooses && !trip.basics.timingLock && contract.timing.open && draft.window) {
    const chosen = adoptChosenWindow({ tripId, trip, window: draft.window, nights: input.nights.value ?? countNights(trip.basics.startDate, trip.basics.endDate), composer, now });
    if (chosen) {
      trip = chosen.trip;
      /*
       * V6 — the persisted contract record must say who decided the dates.
       * The contract was built while the window was open ("nobody"); once the
       * composition's window is adopted the trip's dates are Sidequest's
       * decision, and the Overview's "Sidequest chose <dates>" line reads
       * this record. A live Hokkaido build printed the rationale with no owner.
       */
      contract = { ...contract, timing: { ...contract.timing, open: false, lock: 'sidequest_inferred', decidedBy: 'sidequest' } };
      console.warn('The composition chose this trip’s dates', { tripId, from: `${tripRow.basics.startDate}..${tripRow.basics.endDate}`, to: `${chosen.trip.basics.startDate}..${chosen.trip.basics.endDate}` });
    } else {
      /*
       * The window was refused (past, malformed, or the wrong length), so the
       * trip keeps its placeholder dates — and the model's timing rationale is
       * now about a month the trip is not in. A live Hong Kong build showed the
       * contradiction on the Overview: dates "13 Oct – 18 Oct" above the words
       * "Early November gives dry, comfortably warm weather…".
       *
       * Dropping the rationale is the honest repair. It is prose explaining a
       * decision that did not take effect, and a trip with no explanation of its
       * dates is strictly better than one whose explanation is about other dates.
       */
      console.warn('The composition returned a window Sidequest could not use; the placeholder dates stand and its timing rationale is dropped', { tripId, window: draft.window });
      delete (draft as { timingRationale?: string }).timingRationale;
    }
  }
  if (!fixture && !options.reuseStoredDraft && !options.useDraft) {
    try {
      recordCompositionParse({ id: attemptId, parseStatus: 'ok', parse: { enforcement: outcome.enforcement, normalizedFields: outcome.normalizedFields }, normalizedFields: outcome.normalizedFields, draftLinked: true });
    } catch {
      /* the draft row itself is the record of success */
    }
  }
  if (!options.reuseStoredDraft) saveTripDraft({ tripId, draft, modelCall: modelCalls[0] ?? null, now });
  /* V8 — the draft is on disk: a failure from here is retried on it, with no model call. */
  try {
    markGenerationDraftSaved(tripId, new Date());
  } catch {
    /* progress is best-effort */
  }
  progress('route');
  /* V7 §16 — what the draft actually holds, counted, for the screen that is waiting. */
  const counters = (partial: GenerationCounters) => {
    try {
      noteGenerationCounters(tripId, partial, new Date());
    } catch {
      /* best-effort, like the stage itself */
    }
  };
  const draftedStops = draft.days.reduce((n, d) => n + d.anchors.length, 0);
  counters({ days: draft.days.length, stops: draftedStops, bases: draft.bases.length, episodes: episodesOf(draft).length });
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

  const mustIncludeNames = [...(boardSignals?.mustInclude ?? []), ...input.ownWords.mustDo];
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
  /* Every place the reconciler resolves and every leg it times is counted as it happens; the seams below are the only doors. */
  let placesMatched = 0;
  let legsTimed = 0;
  const countingGeocoder = geocoder
    ? (async (...args: Parameters<typeof geocoder>) => {
        const result = await geocoder(...args);
        if (result) counters({ placesMatched: ++placesMatched });
        /* V8 §14 — the first hit is a real point the build has just placed; the screen draws it. */
        const hit = Array.isArray(result) ? result[0] : null;
        if (hit && typeof hit.name === 'string' && Number.isFinite(hit.lat) && Number.isFinite(hit.lng)) {
          try {
            noteGenerationPlaced(tripId, { name: hit.name, lat: hit.lat, lng: hit.lng }, new Date());
          } catch {
            /* best-effort, like the counters */
          }
        }
        return result;
      }) as typeof geocoder
    : undefined;
  const timedGeocoder = countingGeocoder ? timed('placeResolutionMs', countingGeocoder) : undefined;
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
    routing
      ? timed('routingMs', async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
          const leg = await policyConfirmRoute({ routing, mode: m, from, to, departAt: new Date(`${trip.basics.startDate}T09:00:00Z`), now });
          if (leg) counters({ legsTimed: ++legsTimed });
          return leg;
        })
      : undefined;

  const leaveBy = bookedLeaveByMinute(booked, trip.basics.endDate);
  /*
   * V10 §5 — the context the placement ladder needs. A bare town name is the
   * worst way to ask a geocoder; the country's published name and the
   * destination's own provinces are what disambiguate it.
   */
  const placementContext = {
    ...(envelope.countryName ? { destinationCountryName: envelope.countryName } : conceptCountries[0] && countryFacts(conceptCountries[0])?.name ? { destinationCountryName: countryFacts(conceptCountries[0])!.name } : {}),
    ...(divisions.length > 0 ? { destinationDivisions: divisions } : {}),
    ...(conceptGateways.length > 0 ? { destinationGateways: conceptGateways } : {}),
  };
  /*
   * V12.2 §1 — THE WORLD THE MODE SCREEN IS SUPPOSED TO CONSULT.
   *
   * `ReconcileContext` has declared `affordances` and `reality` since V12 §17,
   * `reconcile.ts` reads them at the one place a hint becomes a mode, and
   * **nothing has ever set them on the production path**. `assessModeConsistency`
   * treats "nothing was consulted" as "refuse nothing" — deliberately, so that a
   * destination nobody screened keeps its legitimate ferry — so the phantom-mode
   * gate has been passing everything through since the day it was written.
   *
   * The Canadian Rockies refusal that V12 §17 demonstrates, and that V12.1's
   * replay tests assert against the stored plan, was therefore never actually
   * running on a live build. It is running now.
   *
   * Both come from the derivation that already computed them for the operating
   * model, so what the screen consults and what the composition envelope was
   * told are one fact rather than two.
   */
  const worldContext: Pick<ReconcileContext, 'affordances' | 'reality' | 'mobilityPattern'> = {
    ...(derived?.affordances ? { affordances: derived.affordances } : {}),
    ...(reality ? { reality } : {}),
    ...(operating ? { mobilityPattern: operating.policy.mobilityPattern } : {}),
  };
  const reconcileContext: ReconcileContext = region
    ? {
        tripId,
        basics: trip.basics,
        profile: verifyingProfile,
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
        ...worldContext,
        ...placementContext,
        ...timedSeams,
        ...(leaveBy !== null ? { lastDayLeaveByMinute: leaveBy } : {}),
      }
    : {
        ...contextWithoutRegion({ trip, profile: verifyingProfile, candidate, envelope, now, deadlineReached, mustIncludeNames, geocoder: timedGeocoder, nearby: timedNearby, routing, weather: (await regionlessWeather) ?? undefined }),
        ...(routing ? { routeMatrix: routeMatrixFor(profile.transport.willDrive ? 'car' : 'foot')!, confirmRoute: confirmRouteFor(profile.transport.willDrive ? 'car' : 'foot')! } : {}),
        weatherForBases,
        ...worldContext,
        ...placementContext,
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
  const quality = auditItinerary({ draft, itinerary: applied.itinerary, profile: verifyingProfile, trip, bookedConflicts: applied.conflicts, preservation, contract, contractConflicts, partyNeeds: contract.party.needs, reality });
  /*
   * V6 §12 — THE FEASIBILITY REPORT DECIDES "READY".
   *
   * Deterministic, from the plan as it stands plus the audit it just passed
   * or failed. The itinerary's status is set from the verdict, so a
   * relocation day with an unmeasured main transfer, or a first day that
   * depends on an airport nobody has chosen, reads "Needs a decision" rather
   * than "Ready, with cautions".
   */
  /*
   * V10 §9 §16 — THE QUALITY COMPILER, AND THE OPERATIONAL FACTS IT NEEDS.
   *
   * Access claims are loaded as data for the countries the destination spans;
   * a country with no recorded claims contributes nothing, which is honest. The
   * compiler then asks the questions V10 added — order coherence, route
   * completeness, jurisdiction language, gateway feasibility, closures, required
   * modes, double-counted experiences, transport semantics, signature quality —
   * corrects only what is safely derivable, and names the rest precisely.
   */
  const accessConstraints = accessConstraintsFor(conceptCountries);
  /*
   * V10 §4 §13 — the experience graph, derived from the draft's own statements
   * and from the official access constraints. Conservative on purpose: a
   * hierarchy invented by proximity would refuse to draw a real walk between two
   * real stops, which is a new defect in place of an old one.
   */
  const experiences = deriveExperienceGraph({
    draft,
    datesByDay: new Map(applied.itinerary.days.map((day) => [day.dayNumber, day.date])),
    accessConstraints,
    placeIdByAnchor: new Map((applied.itinerary.package?.anchors ?? []).filter((a) => a.placeId).map((a) => [a.id, a.placeId!])),
  });
  const compiled = compileQualitySafely({
    itinerary: applied.itinerary,
    draft,
    trip,
    profile: verifyingProfile,
    ...(concept ? { concept } : {}),
    placement: reconciledRaw.placement,
    dayOrders: reconciledRaw.dayOrders,
    gateway: reconciledRaw.gateway,
    accessConstraints,
    experiences,
  });
  if (compiled.report.issues.length > 0) {
    console.warn('Quality compiler found V10 issues', { tripId, blockers: compiled.report.issues.filter((i) => i.severity === 'blocker').map((i) => `${i.check}: ${i.detail}`), issues: compiled.report.issues.length });
  }
  /*
   * V11 §4 — HOW COMPLETE THE ROUTE ACTUALLY IS.
   *
   * Counted from the plan as it stands, so "Ready" can be gated on the
   * route-critical set rather than on whether anything happened to fail loudly.
   * The Canadian Rockies trip called itself "Ready, with cautions" with 12
   * unplaced names and one of its three signature experiences having no
   * position at all, because nothing asked this question.
   */
  const pkgForCompleteness = applied.itinerary.package;
  const placedAnchorIds = new Set((pkgForCompleteness?.anchors ?? []).filter((anchor) => anchor.identity).map((anchor) => anchor.id));
  const baseTransfers = applied.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel?.role === 'transfer').map((item) => item.travel!));
  const completeness = {
    basesPlaced: (pkgForCompleteness?.bases ?? []).filter((base) => base.coordinates).length,
    basesTotal: (pkgForCompleteness?.bases ?? []).length,
    routeCriticalPlaced: reconciledRaw.placement.placements.filter((placement) => placement.outcome === 'placed').length,
    routeCriticalTotal: reconciledRaw.placement.placements.length,
    /* Operator-timed counts as timed: no router can measure a lodge's 4x4, and demanding one would make every honest expedition unready forever. */
    baseTransfersTimed: baseTransfers.filter((travel) => travel.minutes !== null).length,
    baseTransfersTotal: baseTransfers.length,
    signaturesPlaced: (pkgForCompleteness?.signatures ?? []).filter((signature) => placedAnchorIds.has(signature.id)).length,
    signaturesTotal: (pkgForCompleteness?.signatures ?? []).length,
    /*
     * V12.2 §4 — judged-and-contradicted, kept apart from could-not-be-judged.
     *
     * The compiler emits two outcomes under one check id: a `violation` (the
     * day was measured against the ground and doubles back) and an
     * `unplaceable` (its stops have no coordinates, so nothing could be
     * measured). Both were counted here, and the audit found that across six
     * real live trips **every one of 43 findings was `unplaceable`** — so the
     * sentence a traveller read described a defect that has never occurred.
     */
    orderContradictions: reconciledRaw.dayOrders.filter((order) => order.report.verdict === 'violation').length,
    orderUnjudged: reconciledRaw.dayOrders.filter((order) => order.report.verdict === 'unplaceable').length,
    implausibleMeasurements: 0,
    unrepresentedAccessRequirements: compiled.report.issues.filter((issue) => issue.check === 'access_requirements_represented' && issue.severity === 'blocker').length,
    legsTimed: applied.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel && item.travel.fromId !== item.travel.toId)).filter((item) => item.travel!.minutes !== null).length,
    legsTotal: applied.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel && item.travel.fromId !== item.travel.toId)).length,
  };
  /*
   * V12.1 §3 §18 — THE TRIP'S JOURNEYS, DERIVED FROM THE PLAN AS IT STANDS.
   *
   * Nothing is stored and nothing is re-measured: a `Journey` is a reading of a
   * leg that is already on the itinerary, and this derives one per travel item
   * so readiness can ask the right question of each kind of movement. A base
   * transfer is route-critical; an in-day hop is not.
   *
   * `providerCanMeasureMode` comes from the capability registry, which is what
   * turns "we could not time this" into the specific and honest "no provider in
   * this deployment measures a ferry" — a statement about us, which §22 then
   * keeps off the traveller's list of actions.
   */
  const journeyCapabilities = mobilityCapabilities();
  const journeys = applied.itinerary.days.flatMap((day) =>
    day.items
      .filter((item) => item.kind === 'travel' && item.travel && item.travel.fromId !== item.travel.toId)
      .map((item) => {
        const segment = item.travel!;
        const mode = travelModeOfSegment(segment);
        const point = (pkgForCompleteness?.bases ?? []).find((base) => base.coordinates)?.coordinates;
        return journeyFromSegment(segment, {
          routeCritical: segment.role === 'transfer',
          providerCanMeasureMode: measurementAvailability(journeyCapabilities, mode, point ?? undefined) === 'measurable',
        });
      }),
  );
  const feasibility = buildFeasibilityReport({ itinerary: applied.itinerary, contract, audit: quality, partyNeeds: contract.party.needs, maxDailyDriveMinutes: input.movement.maxDailyDriveMinutes.value, compilerIssues: compiled.report.issues, completeness, journeys, ...(operating ? { operatingType: operating.type } : {}) });

  /*
   * V11 §2 §5 §6 — THE STRUCTURE AND THE QUALITY REPORT.
   *
   * Both are pure functions of the plan as it now stands, so they run after
   * feasibility and before the package is written. The quality report is the
   * thing that would have caught both founder trips: a day covering 80% more
   * ground than its stops require, seven bases where five would do, a bus on a
   * private-driver plan, and a measurement no journey takes.
   */
  const structure = tripStructureOf({ days: applied.itinerary.days, package: { ...applied.itinerary.package, feasibility } } as Parameters<typeof tripStructureOf>[0]);
  const usedModes = [...new Set(applied.itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!.mode)))];
  const tripQuality = buildTripQualityReport({
    itinerary: { ...applied.itinerary, package: { ...applied.itinerary.package, feasibility, signatures: applied.itinerary.package?.signatures } } as Parameters<typeof buildTripQualityReport>[0]['itinerary'],
    stays: structure.stays,
    chapters: structure.chapters,
    completeness,
    /* Judgeable days only: a day nothing could be placed on is not a day that scored zero excess. */
    dayExcess: reconciledRaw.dayOrders.filter((order) => order.report.verdict !== 'unplaceable').map((order) => ({ dayNumber: order.dayNumber, excessRatio: order.report.excessFraction })),
    transport: { declared: applied.itinerary.transportStrategy.primaryMode, used: usedModes },
    /* V12.1 §39 §40 — how this kind of trip should be judged, where the derivation produced one. */
    ...(operating ? { policy: operating.policy } : {}),
  });
  if (tripQuality.weak.length > 0) {
    console.warn('Trip quality: weak dimensions', { tripId, weak: tripQuality.weak, detail: tripQuality.findings.filter((f) => f.verdict === 'weak').map((f) => `${f.dimension}: ${f.detail}`) });
  }
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
        status: itineraryStatusForVerdict(feasibility.verdict),
        package: {
          ...applied.itinerary.package,
          ...(reality ? { reality } : {}),
          feasibility,
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
          contract: contractEnforcementRecord(contract, contractConflicts),
          /* V10 §5 §7 §8 §9 §16 — the new audits, persisted beside the ones that came before them. */
          placement: reconciledRaw.placement,
          dayOrders: reconciledRaw.dayOrders.map(({ dayNumber, report, corrected }) => ({
            dayNumber,
            verdict: report.verdict,
            corrected,
            plannedKm: Math.round(report.plannedKm * 10) / 10,
            bestKm: Math.round(report.bestKm * 10) / 10,
            excessFraction: Math.round(report.excessFraction * 1000) / 1000,
            violations: report.violations.map((v) => ({ kind: v.kind, ...(v.stopName ? { stopName: v.stopName } : {}), detail: v.detail })),
            unplaced: [...report.unplaced],
          })),
          ...(reconciledRaw.gateway ? { gateway: reconciledRaw.gateway } : {}),
          ...(accessConstraints.length > 0 ? { accessConstraints: accessConstraints.slice(0, 60) } : {}),
          ...(experiences.experiences.length > 0 ? { experiences } : {}),
          qualityCompiler: compiled.report,
          /*
           * V11 §5 §6 — the stay sequence a traveller actually experiences, and
           * the chapters it makes. Derived here because it needs the episodes and
           * the days together, and persisted because the days, the map, the
           * summary and the PDF must not each re-derive it and disagree.
           */
          ...(structure.chapters.length > 0 ? { chapters: structure.chapters } : {}),
          /* V11 §2 — the internal quality report. Never a score, never shown by default. */
          tripQuality,
          /*
           * V10 §7 §6 — the two corrections the compiler is allowed to make, both
           * derived from the plan's own geometry: a claim the route contradicts,
           * and a disclosure that states what the travel figures rest on.
           */
          ...(compiled.corrections.routeRationale ? { routeRationale: compiled.corrections.routeRationale } : {}),
          metrics: Object.fromEntries(Object.entries(buildStructuralMetrics({ itinerary: { ...applied.itinerary, package: { ...applied.itinerary.package, feasibility } }, contract, audit: quality, booked: { total: applied.honored.length + applied.conflicts.length, honoured: applied.honored.length }, silentAnchorLoss: preservation.silentLoss })).filter(([key]) => key !== 'version')) as Record<string, number | null>,
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
  /*
   * V10 §6 — "No 'Travel per day 3h44m' style precision may be shown when the
   * underlying route is predominantly unmeasured." The figures stay; the
   * sentence under them is replaced with one that says what they rest on.
   */
  const disclosed = compiled.corrections.transportDisclosure
    ? { ...itinerary, transportStrategy: { ...itinerary.transportStrategy, dataDisclosure: compiled.corrections.transportDisclosure } }
    : itinerary;
  const reconciled = { ...reconciledRaw, itinerary: disclosed };
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

/**
 * ADOPT THE WINDOW THE COMPOSITION CHOSE.
 *
 * PRODUCTION LOCK V5 §5/§6. When the traveller said "tell me when it is best",
 * the trip row holds a materialised placeholder until something decides. The
 * model decides, in the same call that designs the route — and this is where its
 * decision becomes the trip's dates.
 *
 * Three things happen, and all three are needed:
 *
 * 1. **The trip row is updated**, so reconciliation, the day dates, the weather
 *    lookup and the audit all read one set of dates.
 * 2. **The composer's timing intent records an accepted recommendation** with
 *    `basis: 'composed_with_trip'`, so a reload knows the question is answered
 *    and by whom. Without this the chrome would say "Sidequest picks the dates"
 *    forever on a trip whose dates it had already picked.
 * 3. **Nothing is adopted unless it is usable.** Two ISO dates, in order,
 *    spanning the nights the traveller asked for, and not in the past. A window
 *    that fails any of those is refused and the placeholder stands: the
 *    placeholder is at least the right *length*, and silently changing a trip's
 *    duration because a date was mistyped is a worse failure than a wrong month.
 */
export function adoptChosenWindow(input: {
  tripId: string;
  trip: Trip;
  window: { startDate: string; endDate: string };
  nights: number;
  composer: TripComposerAnswers | null;
  now: Date;
  /**
   * The two writes, as a seam.
   *
   * Not for indirection's sake: the refusals below are the important half of
   * this function and testing them against a real database would mean a
   * temporary file per case to prove that *nothing was written*. The default is
   * the real repository, so the production path is unchanged.
   */
  persist?: { updateTripDates: (id: string, start: string, end: string, lock?: 'traveler' | 'sidequest' | null) => void; saveComposerAnswers: (id: string, answers: TripComposerAnswers) => void };
}): { trip: Trip } | null {
  const { startDate, endDate } = input.window;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(startDate) || !iso.test(endDate)) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const spanned = Math.round((end - start) / 86_400_000);
  if (spanned !== input.nights) return null;
  /* A window in the past is not a recommendation, it is a mistake. */
  const today = Date.parse(`${input.now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (start < today) return null;

  /*
   * V6 — A LOCKED ROW IS NEVER OVERWRITTEN, WHATEVER THE CALLER BELIEVED.
   *
   * The composition path already skips this when the contract is closed. The
   * refusal is repeated here, on the row's own column, so a second caller —
   * a replay, a fixture, a future door — cannot reach the write either.
   */
  if (input.trip.basics.timingLock) return null;
  const persist = input.persist ?? { updateTripDates, saveComposerAnswers };
  persist.updateTripDates(input.tripId, startDate, endDate, 'sidequest');
  if (input.composer) {
    try {
      persist.saveComposerAnswers(input.tripId, {
        ...input.composer,
        dates: {
          ...input.composer.dates,
          startDate,
          endDate,
          recommendation: {
            startDate,
            endDate,
            label: monthLabelFor(startDate, endDate),
            month: Number(startDate.slice(5, 7)),
            year: Number(startDate.slice(0, 4)),
            reasons: [],
            tradeoffs: [],
            unknowns: [],
            basis: 'composed_with_trip',
            generatedAt: input.now.toISOString(),
            /* Closed, and honestly attributed: Sidequest decided, the traveller did not press anything. */
            accepted: true,
            decidedBy: 'sidequest',
          },
        },
        updatedAt: input.now.toISOString(),
      });
    } catch (error) {
      /*
       * The trip row is already right, which is what the itinerary reads. A
       * failure to record the provenance is worth a log line, not a lost trip.
       */
      console.error('Could not record where this trip’s dates came from', { tripId: input.tripId, message: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return { trip: { ...input.trip, basics: { ...input.trip.basics, startDate, endDate, timingLock: 'sidequest' } } };
}

/** "Late March", "March to April" — the part of the calendar a window sits in. */
function monthLabelFor(startDate: string, endDate: string): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const startMonth = names[Number(startDate.slice(5, 7)) - 1] ?? '';
  const endMonth = names[Number(endDate.slice(5, 7)) - 1] ?? '';
  if (startMonth !== endMonth) return `${startMonth} into ${endMonth}`;
  const day = Number(startDate.slice(8, 10));
  return `${day <= 10 ? 'Early' : day <= 20 ? 'Mid' : 'Late'} ${startMonth}`;
}


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
export function travelerBriefFor(input: { input: CanonicalTripBuildInput; envelope: DestinationEnvelope; boardSignals?: BoardSignals; party?: readonly TravelerBriefPartyMember[]; learned?: readonly string[] }): TravelerBrief {
  const { input: canonical, envelope } = input;
  const { profile, timing } = canonical;
  /*
   * §5/§6/§7 — WHAT THE BRIEF MAY STATE AS A DATE OR A TIME.
   *
   * `startDate` and `endDate` are omitted entirely while Sidequest still owes
   * the traveller a window, rather than carrying the trip row's placeholder:
   * a brief that says "2027-10-03 to 2027-10-13" for somebody who asked "tell
   * me when it is best" has already answered the question, wrongly, before the
   * model saw it. The season line goes with them for the same reason.
   */
  const startDate = timing.startDate.value;
  const endDate = timing.endDate.value;
  return buildTravelerBrief({
    profile,
    trip: {
      destination: envelope.name,
      ...(envelope.qualifiedName ? { qualifiedName: envelope.qualifiedName } : {}),
      ...(envelope.countryName ? { countryName: envelope.countryName } : {}),
      ...(envelope.scale ? { scale: envelope.scale } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      nights: canonical.nights.value ?? 1,
      days: (canonical.nights.value ?? 1) + 1,
      ...(startDate ? { season: seasonOf(startDate, envelope.center?.lat) } : {}),
      adults: canonical.party.adults,
      children: canonical.party.children,
      seniors: canonical.party.seniorsInGroup,
      /* §7 — the phrase, never a clock time nobody stated. */
      arrival: canonical.arrival.phrase,
      departure: canonical.departure.phrase,
      ...(canonical.origin ? { origin: canonical.origin } : {}),
      bookedFacts: canonical.bookedFacts,
    },
    signals: {
      mustInclude: [...(input.boardSignals?.mustInclude ?? []), ...canonical.ownWords.mustDo],
      boardLikes: input.boardSignals?.interested ?? [],
      boardRejects: input.boardSignals?.avoid ?? [],
    },
    ownWords: { mustDo: canonical.ownWords.mustDo, dislikes: canonical.ownWords.dislikes, freeText: canonical.ownWords.freeText, mobilityNotes: canonical.party.mobilityNotes },
    ...(input.party && input.party.length > 0 ? { party: input.party } : {}),
    ...(input.learned && input.learned.length > 0 ? { learned: input.learned } : {}),
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
