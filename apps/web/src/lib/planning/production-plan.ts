import 'server-only';
import {
  compositionPreferenceSummary,
  currencyForCountry,
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
import { ResearchModel } from '../providers/anthropic';
import { isFixtureComposer, isGeocoderEnabled, isPoiProviderEnabled, isResearchModelConfigured } from '../providers/switches';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { compilerProviders } from '../compiler/providers';
import { getIntent } from '../db/compiler-repository';
import { saveTripDraft } from '../db/draft-repository';
import { getProfile, getSelections, getTrip, saveItinerary, saveReadiness } from '../db/repository';
import { boardFor, resolveTripRegion, withRefreshedWeather, type RegionContext } from '../region';
import { ensureWeatherForPlanning } from '../weather/refresh';
import { composerModel } from '../benchmark/baseline/generate';
import { buildHybridTripRequest } from './hybrid-request';
import { buildCompositionTask, compositionUntrustedPayload, generateTripDraft, type BoardSignals, type CompositionContext, type DestinationEnvelope } from './composition';
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
import { applyBookedFacts } from '@/lib/intelligence/booked-reconcile';
import { policyConfirmRoute } from './route-selection';
import { operationalEvidenceSeam, persistedIdentitiesFor, placesIdentitySeam } from './place-identity';
import { ProviderBudget, ceilingsFor } from '../providers/cost-budget';
import { capability } from '../providers/registry';
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

export interface ProductionPlanResult {
  ok: boolean;
  error?: string;
  result?: ReconcileResult;
  draft?: TripDraft;
  timings?: ProductionPlanTimingsMs;
  modelCalls?: readonly unknown[];
  /** LIVE WORLD V1 — what the provider budget spent and refused this build. */
  providerBudget?: ReturnType<ProviderBudget['report']>;
}

export interface ProductionPlanTimingsMs {
  identityResolutionMs: number;
  compositionMs: number;
  verificationMs: number;
  persistenceMs: number;
  totalMs: number;
  deadlineReached: boolean;
}

export const VERIFICATION_DEADLINE_ENV = 'SIDEQUEST_VERIFICATION_DEADLINE_MS';
const DEFAULT_VERIFICATION_DEADLINE_MS = 90_000;
const QUICK_VERIFICATION_DEADLINE_MS = 45_000;

export function verificationDeadlineMs(mode: GenerationMode): number {
  const raw = Number(process.env[VERIFICATION_DEADLINE_ENV]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return mode === 'quick' ? QUICK_VERIFICATION_DEADLINE_MS : DEFAULT_VERIFICATION_DEADLINE_MS;
}

export async function generateSidequestPlanForTrip(
  tripId: string,
  options: {
    caller?: string | null;
    now?: Date;
    mode?: GenerationMode;
    /** Called with the raw draft as soon as composition succeeds, before verification. The draft is also persisted at that point. */
    onDraftGenerated?: (draft: TripDraft) => void;
  } = {},
): Promise<ProductionPlanResult> {
  const now = options.now ?? new Date();
  const mode = options.mode ?? 'full';
  const startedMs = performance.now();

  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };
  const intent = getIntent(tripId);
  const composer = intent?.composer ?? null;
  const profile = getProfile(tripId) ?? defaultProfileFor(trip, composer);

  const fixture = isFixtureComposer();
  if (!fixture && !isResearchModelConfigured()) {
    return { ok: false, error: 'No model credential is configured, so we cannot compose a first draft yet.' };
  }

  // Compiled evidence is optional: a trip that skipped compilation still gets a
  // complete draft, verified only through the geocoder and router that exist.
  const resolvedRegion = await resolveTripRegion(trip);
  let region: RegionContext | null = resolvedRegion.ok ? resolvedRegion.context : null;
  if (region) {
    // A plan is an explicit act and may buy a forecast; a render never does.
    // Same seam the legacy build used, so weather-aware day summaries survive.
    await ensureWeatherForPlanning({ tripId, compiled: region.compiled, dates: region.dates, scopeKey: region.weatherScopeKey }, now);
    region = withRefreshedWeather(tripId, region);
  }
  const board = region ? boardFor(trip, profile, region) : null;

  const identityStartedMs = performance.now();
  const candidate = await destinationCandidateFor(trip, intent?.resolution ?? null, intent?.selectedCandidateId ?? null, now);
  const identityResolutionMs = Math.round(performance.now() - identityStartedMs);

  const envelope: DestinationEnvelope = {
    name: candidate?.displayName ?? region?.region.name ?? trip.basics.destinationInput,
    ...(candidate?.qualifiedName ? { qualifiedName: candidate.qualifiedName } : {}),
    ...(candidate?.countryCode ? { countryCode: candidate.countryCode } : {}),
    ...(candidate?.countryName ? { countryName: candidate.countryName } : {}),
    ...(candidate?.breadth ? { scale: candidate.breadth } : {}),
    center: candidate?.center ?? region?.region.baseCoordinates ?? { lat: 0, lng: 0 },
    ...(candidate?.timeZones?.[0] ? { timeZone: candidate.timeZones[0] } : {}),
    ...(region ? { knownAreas: region.compiled.subregions.map((s) => s.name).slice(0, 8) } : {}),
  };

  const request = buildHybridTripRequest({ trip, composer, profile, now });
  const boardSignals = mode === 'full' && board ? boardSignalsFor(board.candidates, getSelections(tripId)) : undefined;
  const preferenceSummary = compositionPreferenceSummary(profile);
  /*
   * LIVE WORLD V1 — booked facts enter before composition. The model builds
   * around them; the deterministic layer verifies them after reconciliation.
   */
  const booked = listBookedItems(tripId);
  const bookedFacts = compactBookedFacts(booked);
  const context: CompositionContext = { request, envelope, ...(boardSignals ? { boardSignals } : {}), preferenceSummary, mode, ...(bookedFacts.length > 0 ? { bookedFacts } : {}) };

  let model: StructuredModel;
  if (fixture) {
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

  const compositionStartedMs = performance.now();
  const outcome = await generateTripDraft({ model, context });
  const compositionMs = Math.round(performance.now() - compositionStartedMs);
  const modelCalls = model instanceof ResearchModel ? [...model.callLog] : [];
  if (!outcome.ok) {
    return {
      ok: false,
      error: `We could not compose a first draft just now. ${outcome.detail}`,
      timings: { identityResolutionMs, compositionMs, verificationMs: 0, persistenceMs: 0, totalMs: Math.round(performance.now() - startedMs), deadlineReached: false },
      modelCalls,
    };
  }
  const draft = outcome.draft;
  saveTripDraft({ tripId, draft, modelCall: modelCalls[0] ?? null, now });
  options.onDraftGenerated?.(draft);

  // --- Verification + reconciliation, bounded ------------------------------
  const verificationStartedMs = performance.now();
  const deadlineMs = verificationDeadlineMs(mode);
  const deadlineReached = () => performance.now() - verificationStartedMs > deadlineMs;
  const { providers } = compilerProviders(candidate?.id);
  const geocoder = isGeocoderEnabled() ? productionGeocodeLocality : undefined;
  const nearby = isGeocoderEnabled() || isPoiProviderEnabled() ? productionFindNearbyLocalities : undefined;
  const routingCapable = providers.routing.supportedModes().length > 0;

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
        ...(geocoder ? { geocodeLocality: geocoder } : {}),
        ...(routingCapable ? { routeMatrix: (points) => productionRouteMatrix(providers.routing, region.matrix.mode, points) } : {}),
        ...(routingCapable ? { confirmRoute: (from, to) => policyConfirmRoute({ routing: providers.routing, mode: region.matrix.mode, from, to, departAt: new Date(`${trip.basics.startDate}T09:00:00Z`), now }) } : {}),
        ...(nearby ? { findNearbyLocalities: nearby } : {}),
        destinationScope: productionDestinationScope(region.compiled),
        subregionGeometries: productionSubregionGeometries(region.compiled),
        deadlineReached,
        mustIncludeNames,
        ...identitySeams,
      }
    : { ...contextWithoutRegion({ trip, profile, candidate, envelope, now, deadlineReached, mustIncludeNames, geocoder, nearby, routing: routingCapable ? providers.routing : null }), ...identitySeams };

  const reconciledRaw = await reconcileTripDraft({ draft, context: reconcileContext });
  /*
   * Booked reality, verified deterministically: the base is renamed to the
   * booked lodging, a booked ticket is pinned, a booked departure tightens
   * the last day, and anything the model did not honour is named as a
   * conflict on the itinerary — no second model call.
   */
  const applied = applyBookedFacts(reconciledRaw.itinerary, booked);
  const reconciled = { ...reconciledRaw, itinerary: applied.itinerary };
  const verificationMs = Math.round(performance.now() - verificationStartedMs);

  /*
   * LIVE WORLD V1 — one dated reference rate, fetched at plan time and read on
   * every render, only when the destination's currency differs from the
   * traveller's and an FX provider is configured. A failure leaves the budget
   * in the traveller's currency and says nothing about rates.
   */
  const localCurrency = currencyForCountry(candidate?.countryCode ?? envelope.countryCode);
  const travellerCurrency = (profile.interview.budgetEnvelope as { currency?: string } | undefined)?.currency ?? 'USD';
  if (localCurrency && localCurrency !== travellerCurrency && capability('currency.fx')?.configured && budget.take('fx')) {
    try {
      const rate = await fetchReferenceRate(travellerCurrency, localCurrency, { now });
      if (rate) saveFxRate(tripId, rate, now);
    } catch {
      /* the budget stays unconverted; nothing is invented */
    }
  }

  const persistenceStartedMs = performance.now();
  saveItinerary(reconciled.itinerary);
  saveReadiness(tripId, reconciled.readiness, now);
  const persistenceMs = Math.round(performance.now() - persistenceStartedMs);

  return {
    ok: true,
    result: reconciled,
    draft,
    timings: { identityResolutionMs, compositionMs, verificationMs, persistenceMs, totalMs: Math.round(performance.now() - startedMs), deadlineReached: deadlineReached() },
    modelCalls,
    providerBudget: budget.report(),
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

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
    const { providers } = compilerProviders();
    const resolved = await providers.resolver.resolve({ query: trip.basics.destinationInput, now });
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
  routing: ReturnType<typeof compilerProviders>['providers']['routing'] | null;
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
  const weather = unavailableWeatherDataset({
    regionId,
    locations: [
      {
        id: `${regionId}:centre`,
        label: envelope.name,
        coordinates: center,
        elevationMetres: 0,
        timeZone: envelope.timeZone ?? 'UTC',
        placeIds: [`${regionId}:centre`],
        limitation: 'One point for the whole destination; conditions vary across it.',
      },
    ],
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

/** Exposed for tests that assert what the composition call is (and is not) told. */
export function compositionPreview(context: CompositionContext): { task: string; untrusted: Record<string, unknown> } {
  return { task: buildCompositionTask(context), untrusted: compositionUntrustedPayload(context) };
}
