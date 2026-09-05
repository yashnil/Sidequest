import 'server-only';
import {
  buildPlannerReadiness,
  planTrip,
  type ItineraryLock,
  type PlannerInput,
} from '@sidequest/planner';
import { tryLeg, type TravelTimeMatrix } from '@sidequest/geo';
import {
  displayNameOf,
  tripDates,
  type AccessDataset,
  type BaseCandidate,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type FoodDataset,
  type FoodSelection,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type OperatingHoursDataset,
  type Place,
  type PlannerReadiness,
  type Region,
  type ScheduledNetworkPresence,
  type TransitEvidence,
  type TransportMode,
  type TravelerProfile,
  type TripBasics,
  type UnscheduledPlace,
  type UnscheduledReasonCode,
  type WeatherDataset,
} from '@sidequest/core';
import type { TripArchetype, TripSkeleton } from '@/lib/benchmark/baseline/skeleton';
import type { SkeletonEvidencePacket, SkeletonEvidencePlace } from '@/lib/benchmark/baseline/skeleton-packet';
import { findCorridorRemedyCandidates, type CorridorCandidate } from './relocation-corridor';

/**
 * TRIPSKELETON → SIDEQUEST'S PRODUCTION PLANNER — THE BRIDGE, NOT A SECOND
 * PLANNER.
 *
 * `benchmark/baseline/hydrate.ts` exists to answer one question, fairly:
 * *was the model's TripSkeleton good?* — measured against a hydrator that is
 * architecturally forbidden from touching Sidequest's own selection,
 * clustering, scheduling and routing engines, so that the benchmark cannot
 * quietly become Sidequest grading itself. This file answers the other
 * question, the one the benchmark is not allowed to: *can Sidequest's actual
 * planner turn that skeleton into a superior, fully verified trip?* It lives
 * outside `apps/web/src/lib/benchmark/`, imports the real
 * `@sidequest/planner`, and must never be imported by anything inside that
 * package — `baseline.architecture.test.ts` enforces the other direction
 * already; nothing here is exempt from it, and nothing here weakens it.
 *
 * The doctrine stays the same doctrine, one level up: *the model decides
 * shape, Sidequest verifies and builds.* `planTrip()` itself does not take a
 * pre-decided shape — it is Sidequest's own autonomous planner, the other
 * arm of the Phase 13 comparison, and left alone it would select its own
 * bases and its own days from a scored candidate board. What turns it into a
 * TripSkeleton executor rather than a second opinion is `PlannerInput`'s own
 * existing primitives for *being told* a shape: `locks` (a stop pinned to a
 * day, "planned as if hand-picked") and `basePortfolio` (which base a date
 * belongs to, authoritative). This file's job is translating a validated
 * skeleton into those two structures — plus one check `PlannerInput` does
 * not yet perform at all, whole-route relocation feasibility (see
 * `assessRelocationFeasibility` below) — and then calling the same
 * `planTrip()` the questionnaire path already calls, so that measured
 * routing, scheduling, access/opening constraints, meals, weather and
 * validation are Sidequest's own, exercised exactly once.
 *
 * ARCHITECTURAL INVARIANT — SKELETON BASES DO NOT NEED REDISCOVERING.
 *
 * A validated `TripSkeleton` already states its own ordered base sequence,
 * nights and day assignments — a planning intent, not a hint. Sidequest's
 * *own* compiler has a separate, model-backed region-expansion stage that
 * proposes bases from scratch for the flows that have no skeleton yet (the
 * questionnaire path, an ordinary `/plan` build); it exists to answer "where
 * should this trip stay" when nobody has already answered that question.
 * When a skeleton has already answered it, invoking that stage to answer it
 * *again* is not verification, it is a second opinion nobody asked for, and
 * — as the zero-model Iceland run proved concretely, see PROGRESS.md — one
 * that silently collapses to a single whole-destination base when the model
 * budget is zero, which is not the skeleton's fault and not a reason to
 * distrust the skeleton. **Production hydration must never call the model to
 * rediscover or repropose a base sequence a skeleton already supplies.** The
 * base-resolution policy below (`resolveSkeletonBase`) is the deterministic
 * replacement: it turns a skeleton's own named bases into real Sidequest
 * identities using non-model evidence only — the compiler's own base list
 * when populated, the Discovery Board, and a deterministic geocoder as a
 * last, bounded resort. The existing model-backed expansion stage remains
 * exactly where it is, for the flows that still need it.
 */

/* ------------------------------------------------------------------ *
 * The pre-resolved context this adapter needs, and does not build
 * ------------------------------------------------------------------ */

/**
 * Everything a `PlannerInput` needs that is *not* a skeleton decision —
 * region, candidates, matrix, access/hours/weather/food. Resolved the one
 * way it ever is, by `resolveTripRegion`/`boardFor` in
 * `apps/web/src/lib/planning/build.ts`, before this adapter ever runs. This
 * type is `PlannerInput` with the skeleton-derived fields removed, so the
 * two cannot drift silently: anything `PlannerInput` adds, this inherits.
 */
export type SkeletonPlanningContext = Omit<
  PlannerInput,
  'selections' | 'locks' | 'basePortfolio' | 'tripId' | 'basics' | 'profile'
> & {
  tripId: string;
  basics: TripBasics;
  profile: TravelerProfile;
  region: Region;
  candidates: readonly DiscoveryCandidate[];
  matrix: TravelTimeMatrix;
  access: AccessDataset;
  hours: OperatingHoursDataset;
  weather: WeatherDataset;
  food?: FoodDataset;
  foodSelections?: readonly FoodSelection[];
  transit?: TransitEvidence;
  scheduledNetwork?: ScheduledNetworkPresence | null;
  now?: Date;
  /**
   * The compiler's own base-eligible localities, when the compiled region
   * carries any — real, deterministic evidence (`CompiledRegion.bases`),
   * never gated on this adapter's own work. Distinct from `candidates` on
   * purpose: a `BaseCandidate` is "somewhere to sleep", scored for reach and
   * transport, not for personal fit — see this file's base-resolution
   * doctrine below for why the two must not be conflated.
   */
  compiledBases?: readonly BaseCandidate[];
  /**
   * A deterministic, non-model locality lookup — real production geocoding
   * (Nominatim, the same service `resolveDestinationAction` uses), injected
   * rather than constructed here so this file never instantiates a provider.
   * Absent in a context that has none configured, or in a test that has no
   * need to exercise the geocoder tier; base resolution degrades to
   * `base_unresolved`/`base_identity_ambiguous` rather than guessing.
   */
  geocodeLocality?: SkeletonBaseGeocoder;
  /**
   * ON-DEMAND ROUTING FOR RESOLVED BASES THE COMPILED MATRIX DOES NOT COVER.
   *
   * A base resolved through the geocoder (or through a `BaseCandidate` whose
   * `routingId` the current matrix happens not to carry) is a real identity,
   * not yet a *routable* one — `context.matrix` is the board's own static,
   * pre-computed matrix, and a locality discovered after it was built has no
   * row in it. This seam is the smallest fix that does not require rebuilding
   * that matrix: given the small set of resolved base points, a real
   * production router (the same `RoutingProvider` a compilation itself calls)
   * answers a bounded, small matrix over just those points — proportional to
   * the trip's own base count, never the whole region. Absent in a context
   * with no such capability configured, or in a test with no need to exercise
   * it; a resolved-but-unmeasured base then degrades exactly as it already
   * did — an honest "unmeasured", never treated as proof of infeasibility.
   *
   * Deliberately **not** merged into `context.matrix` itself: `planTrip()`
   * validates that matrix as fully dense (`validateMatrix`, `@sidequest/geo`),
   * and a small routed sub-matrix over a handful of bases cannot honestly
   * densify a board of dozens of candidates without either an implausible
   * number of extra calls or fabricating the rest — so this covers exactly
   * what this round's regression requires (base-to-base relocation,
   * departure closure, `basePortfolio` transfer minutes), not day-scheduling
   * reachability for every candidate from a geocoded base, which remains a
   * known, honestly-scoped gap — see this file's own report.
   */
  routeMatrix?: SkeletonRouteMatrixProvider;
  /**
   * ONE BOUNDED, DIRECT POINT-TO-POINT ROUTE CONFIRMATION — THE FALLBACK
   * FOR A LEG A HARD FEASIBILITY DECISION DEPENDS ON, NEVER THE PRIMARY
   * ACQUISITION STRATEGY.
   *
   * The sparse matrix (`routeMatrix` above) is an optimization, and a real
   * matrix engine can answer `not_found` — or nothing at all — for a pair
   * that a single point-to-point route genuinely connects; a live Iceland
   * validation proved exactly this (Valhalla's `costmatrix` algorithm
   * returning null for two legs a direct `/route` measured successfully).
   * For a leg that merely narrows the discovery board this is an accepted,
   * cheap degradation — but for the handful of legs a hard feasibility gate
   * depends on (mandatory base-to-base relocation, departure closure — see
   * `confirmMandatoryLeg`), the matrix's own answer is not trusted alone.
   * Absent in a context with no such capability configured, or in a test
   * with no need to exercise it; those mandatory legs then degrade exactly
   * as they already did before this seam existed.
   */
  confirmRoute?: SkeletonRouteConfirmationProvider;
  /**
   * The destination's own real geographic identity — `CompiledRegion.scope`,
   * mapped to the small shape this file needs. Absent falls back to the
   * region's own reach-based radius check exactly as before (every context
   * built before this field existed keeps working unchanged). See
   * `BaseResolutionScope`'s own header for why this exists separately from
   * `Region.maxRadiusKm`.
   */
  destinationScope?: BaseResolutionScope;
  /** Named areas Sidequest already has real geometry for — `CompiledRegion.subregions`, when any exist. */
  subregionGeometries?: readonly SubregionGeometry[];
  /**
   * Bounded near-corridor settlement search for `relocation-corridor.ts`'s
   * remedy tier — a coordinate and a search radius in, the real localities
   * found nearby out. Absent in a context with no such capability
   * configured, or in a test with no need to exercise it; the corridor
   * remedy tier is then simply never attempted, exactly as it never existed
   * for every context built before this field did.
   */
  findNearbyLocalities?: SkeletonCorridorLocalitySearch;
};

/* ------------------------------------------------------------------ *
 * Anchor and base resolution — through real Sidequest place identity
 * ------------------------------------------------------------------ */

export interface AnchorResolution {
  skeletonPlaceIndex: number;
  skeletonName: string;
  place: Place | null;
  /** `null` only when `place` is `null`. */
  confidence: 'name' | 'proximity' | null;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Past this, two places are different places, whatever their names say. */
const PROXIMITY_MATCH_KM = 0.3;
/** Past this, a name match is not worth trusting even if the words are close. */
const NAME_MATCH_RADIUS_KM = 5;

/**
 * A SKELETON ANCHOR IS A NAME AND A COORDINATE FROM ONE CANDIDATE UNIVERSE
 * (THE BASELINE ARM'S OWN OSM-SOURCED EVIDENCE); PRODUCTION HYDRATION NEEDS
 * A `Place.id` FROM A DIFFERENT ONE (SIDEQUEST'S OWN COMPILED REGION). There
 * is no shared identity between them — this is the resolution step that
 * bridges the two, deterministically, by name and by distance, never by
 * inventing a place that is not on the board.
 *
 * Exact normalized name within a plausible radius wins outright. Failing
 * that, the nearest candidate within `PROXIMITY_MATCH_KM` stands in for it —
 * the same coordinate, a different source's name for it. Anything further
 * is `null`: a deliberate refusal to resolve rather than a guess, recorded
 * as a deviation the caller must account for, never silently substituted.
 */
export function resolveAnchorPlace(
  anchor: Pick<SkeletonEvidencePlace, 'name' | 'lat' | 'lng'>,
  candidates: readonly DiscoveryCandidate[],
): { place: Place | null; confidence: 'name' | 'proximity' | null } {
  const target = normalizeName(anchor.name);
  let nameMatch: { place: Place; km: number } | null = null;
  let nearest: { place: Place; km: number } | null = null;

  for (const candidate of candidates) {
    const place = candidate.place;
    const km = haversineKm(anchor, place.coordinates);
    if (nearest === null || km < nearest.km) nearest = { place, km };
    if (km > NAME_MATCH_RADIUS_KM) continue;
    const candidateName = normalizeName(displayNameOf(place));
    if (candidateName !== target) continue;
    if (nameMatch === null || km < nameMatch.km) nameMatch = { place, km };
  }

  if (nameMatch) return { place: nameMatch.place, confidence: 'name' };
  if (nearest && nearest.km <= PROXIMITY_MATCH_KM) return { place: nearest.place, confidence: 'proximity' };
  return { place: null, confidence: null };
}

/**
 * WHAT SIDEQUEST COULD ESTABLISH ABOUT ONE MODEL-PROPOSED ANCHOR.
 *
 * `unknown != false` — see the Phase 17 baseline-first doctrine. `verified`
 * is a real board `DiscoveryCandidate`, carrying fit/access/hours/weather
 * evidence the planner can schedule against. `partially_verified` is a real
 * place identity (a live geocoder confirmed it exists, roughly where the
 * model said) that the compiled region never scored — real, but thin.
 * `unverified` is neither: not on the board, and either no geocoder was
 * available or nothing it returned could be trusted as this specific place.
 * None of the three is a rejection; only a genuine contradiction (handled
 * elsewhere, e.g. `anchor_unroutable`) removes an anchor outright.
 */
export type AnchorVerificationState = 'verified' | 'partially_verified' | 'unverified';

export interface AnchorResolutionOutcome {
  state: AnchorVerificationState;
  /** A real board candidate — present only when `state === 'verified'`. */
  place: Place | null;
  /** Real id/name/coordinates — present for `verified` and `partially_verified`, absent for `unverified`. */
  identity: ResolvedBaseIdentity | null;
  method: 'packet_evidence' | 'packet_evidence_unmatched' | 'board_name_match' | 'geocoder' | null;
  geographicScopeOutcome: BaseResolutionScopeOutcome | null;
  /** The evidence packet's own duration estimate for this place, when the anchor resolved through it — a better fallback than the bridge's generic default. Never present alongside `state: 'unverified'`. */
  fallbackDurationMinutes?: number;
}

const ANCHOR_UNVERIFIED: AnchorResolutionOutcome = {
  state: 'unverified',
  place: null,
  identity: null,
  method: null,
  geographicScopeOutcome: null,
};

/**
 * A MODEL-PROPOSED ANCHOR THAT COULD NOT JOIN `locks` — CARRIED FORWARD, NEVER
 * DROPPED, AND STILL SCHEDULABLE.
 *
 * No `DiscoveryCandidate` exists for either state (a geocoder confirms
 * identity, never fit/hours/access/weather, and fabricating one is exactly
 * the failure mode `packages/compiler/src/provisional.ts`'s own header
 * documents), so neither can enter `planTrip()`'s normal candidate-selection
 * path. `reconcileRetainedAnchorsOntoItinerary` (below) instead inserts each
 * one directly into its day's own `items`, using real day-local routing
 * where identity allows it, and a plainly-labelled estimate where it does
 * not — a lighter, purpose-built bridge, not a second copy of the board's
 * scoring pipeline. Only an anchor that genuinely has no room left in its
 * day falls back to the itinerary's `unscheduled` list. See
 * `UNSCHEDULED_REASON_CODES`'s `'model_proposal_unintegrated'`.
 */
export interface RetainedAnchor {
  /**
   * Stable within this one skeleton, independent of array position —
   * derived once from `(dayNumber, anchor index within the day, name)`,
   * never recomputed from position after this. Used for disposition
   * tracking and, where the item is actually scheduled, becomes the
   * `ItineraryItem.id`.
   */
  id: string;
  dayNumber: number;
  name: string;
  locality: string | null;
  role: 'primary' | 'secondary';
  why: string;
  /** The model's own rough estimate, minutes — `undefined` when it gave none. See `estimatedDurationMinutes` on the schema. */
  estimatedDurationMinutes: number | undefined;
  state: Extract<AnchorVerificationState, 'partially_verified' | 'unverified'>;
  /** Real id/name/coordinates from a geocoder — present only when `state === 'partially_verified'`. */
  identity: ResolvedBaseIdentity | null;
}

/**
 * WHAT ACTUALLY HAPPENED TO ONE MODEL-PROPOSED ANCHOR — THE EXPLICIT,
 * EXHAUSTIVE DISPOSITION EVERY ANCHOR MUST END IN.
 *
 * No anchor is allowed to exist only inside an internal loop with no trace
 * in the output; every one of these is attached to a `SkeletonPlanResult`
 * so a caller (a test, a diagnostic, the eventual product report) can
 * account for 100% of what the model proposed without re-deriving it from
 * `deviations` prose.
 */
export type AnchorDisposition =
  | 'scheduled_verified'
  | 'scheduled_partially_verified'
  | 'scheduled_unverified'
  | 'unscheduled_capacity';

export interface AnchorDispositionRecord {
  id: string;
  dayNumber: number;
  name: string;
  disposition: AnchorDisposition;
  /** The real board `Place.id`, when one exists — used to cross-check a `scheduled_verified` record against what `planTrip()` actually placed. */
  placeId?: string;
}

/**
 * DISAMBIGUATION AMONG SEVERAL GEOGRAPHICALLY-PLAUSIBLE GEOCODER RESULTS FOR
 * AN ANCHOR — DELIBERATELY SIMPLER THAN `rankGeocoderCandidates`.
 *
 * That function's "prefer a real settlement over a namesake attraction" rule
 * exists for resolving overnight *bases* and is the wrong bias for an
 * anchor, which is usually not a settlement at all. An anchor also has no
 * stated coordinate to rank distance against (a `placeIndex: null` anchor
 * carries no packet coordinate) — `rankGeocoderCandidates` always refuses to
 * pick without one. So: exactly one accepted result wins outright; more than
 * one is resolved only when the geocoder's own `importance` ranking shows a
 * clear leader, never guessed at.
 */
const ANCHOR_IMPORTANCE_MARGIN = 0.05;

export function pickAnchorGeocoderWinner(
  accepted: readonly AssessedGeocoderCandidate[],
): AssessedGeocoderCandidate | null {
  if (accepted.length === 1) return accepted[0]!;
  if (accepted.length === 0) return null;
  const ranked = [...accepted].sort((a, b) => (b.result.importance ?? 0) - (a.result.importance ?? 0));
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (typeof top.result.importance !== 'number' || typeof second.result.importance !== 'number') return null;
  return top.result.importance - second.result.importance >= ANCHOR_IMPORTANCE_MARGIN ? top : null;
}

/**
 * ANCHOR RESOLUTION — THE SAME TIERED, MODEL-FREE DOCTRINE `resolveSkeletonBase`
 * APPLIES TO BASES, NOW APPLIED TO ANCHORS.
 *
 * 1. **Packet evidence, through the board** — the anchor cited a real
 *    evidence-packet place and it is also a scored board candidate. Exactly
 *    the pre-existing behaviour.
 * 2. **Exact name match anywhere on the board** — no distance guard needed:
 *    `context.candidates` is already this trip's own region-scoped evidence,
 *    so a normalized name match on it is not a coincidence. Covers a model
 *    anchor that named a real board place without citing its `placeIndex`.
 * 3. **A deterministic geocoder/place search**, bounded to the destination's
 *    own real geography exactly like `resolveSkeletonBase`'s own tier 4 —
 *    the tier that lets the model anchor a day on a real place the compiled
 *    region never happened to score. Resolves *identity*, never a full
 *    board card: no fit, hours or access evidence comes from a geocoder, so
 *    this is `partially_verified`, not `verified`.
 *
 * Anything past tier 3 is `unverified` — never fabricated, never dropped
 * either; the caller decides what an unverified proposal becomes.
 */
export async function resolveSkeletonAnchor(
  anchor: Pick<TripSkeleton['days'][number]['anchors'][number], 'placeIndex' | 'name' | 'locality'>,
  packet: SkeletonEvidencePacket,
  context: Pick<SkeletonPlanningContext, 'candidates' | 'region' | 'geocodeLocality' | 'destinationScope' | 'subregionGeometries'>,
): Promise<AnchorResolutionOutcome> {
  // Tier 1 — a packet place, resolved through the board.
  if (anchor.placeIndex !== null) {
    const evidencePlace = packet.places.find((p) => p.index === anchor.placeIndex);
    if (evidencePlace) {
      const resolved = resolveAnchorPlace(evidencePlace, context.candidates);
      if (resolved.place) {
        return {
          state: 'verified',
          place: resolved.place,
          identity: identityFromPlace(resolved.place),
          method: 'packet_evidence',
          geographicScopeOutcome: null,
        };
      }
      // The evidence packet has a real record — a name and a coordinate
      // the baseline arm's own sourcing gathered — even though Sidequest's
      // board has no matching `DiscoveryCandidate` for it. That coordinate
      // is real, not a geocoder call away: using it directly, rather than
      // discarding it and falling through to a name-only search (which may
      // not even have a `name` to search on — see below), is both cheaper
      // and more accurate. A synthetic id, clearly packet-scoped, since
      // nothing here has ever claimed a stable external identifier for it.
      return {
        state: 'partially_verified',
        place: null,
        identity: {
          id: `packet:${evidencePlace.index}:${normalizeName(evidencePlace.name).replace(/\s+/g, '-').slice(0, 24)}`,
          name: evidencePlace.name,
          coordinates: { lat: evidencePlace.lat, lng: evidencePlace.lng },
        },
        method: 'packet_evidence_unmatched',
        geographicScopeOutcome: null,
        ...(evidencePlace.duration !== null && evidencePlace.duration !== undefined ? { fallbackDurationMinutes: evidencePlace.duration } : {}),
      };
    }
    // An invalid placeIndex (no packet record at all) still falls through
    // to tiers 2–3 when the anchor also carries a `name`.
  }

  // `name` is schema-optional only for fixtures/anchors predating this
  // field — every anchor a live model produces is asked to supply one (see
  // `SKELETON_GENERATE_INSTRUCTION`). Without it and without a resolved
  // placeIndex, there is nothing left to search on.
  if (!anchor.name) return ANCHOR_UNVERIFIED;

  // Tier 2 — exact normalized name anywhere on this trip's own board.
  const target = normalizeName(anchor.name);
  const nameMatch = context.candidates.find((c) => normalizeName(displayNameOf(c.place)) === target);
  if (nameMatch) {
    return {
      state: 'verified',
      place: nameMatch.place,
      identity: identityFromPlace(nameMatch.place),
      method: 'board_name_match',
      geographicScopeOutcome: null,
    };
  }

  // Tier 3 — a deterministic geocoder, screened by the destination's own real
  // geography. A provider failure degrades to unverified, never a crash.
  if (!context.geocodeLocality) return ANCHOR_UNVERIFIED;
  const query = anchor.locality ? `${anchor.name}, ${anchor.locality}` : `${anchor.name}, ${context.region.name}`;
  let results: readonly GeocodedLocality[];
  try {
    results = await context.geocodeLocality(query);
  } catch {
    return { ...ANCHOR_UNVERIFIED, geographicScopeOutcome: 'geocoder_unavailable' };
  }

  const assessed = results.map((r) => ({
    result: r,
    ...assessGeographicScope({
      point: r,
      countryCode: r.countryCode,
      region: context.region,
      scope: context.destinationScope,
      subregions: context.subregionGeometries,
      evidenceCandidates: context.candidates,
    }),
  }));
  const accepted = assessed.filter((a) => a.accepted);
  const winner = pickAnchorGeocoderWinner(accepted);
  if (!winner) {
    return {
      ...ANCHOR_UNVERIFIED,
      geographicScopeOutcome: accepted.length > 0 ? 'rejected_ambiguous_locality' : (assessed[0]?.outcome ?? null),
    };
  }
  return {
    state: 'partially_verified',
    place: null,
    identity: { id: winner.result.sourceId, name: winner.result.name, coordinates: { lat: winner.result.lat, lng: winner.result.lng } },
    method: 'geocoder',
    geographicScopeOutcome: winner.outcome,
  };
}

/* ------------------------------------------------------------------ *
 * Deviations and the typed repair issue
 * ------------------------------------------------------------------ */

export type SkeletonDeviationKind =
  | 'anchor_unresolved'
  /**
   * No longer produced as of the draft-anchor bridge: an evidence-packet
   * place that fails board resolution now returns `partially_verified`
   * (`resolveSkeletonAnchor`'s `packet_evidence_unmatched` tier) instead of
   * this kind — the packet's own coordinate is real evidence, not nothing.
   * Kept in the vocabulary rather than removed, since a repair issue or a
   * stored deviation may still reference it from before this change.
   */
  | 'anchor_infeasible_no_substitute'
  /**
   * A real, resolved anchor that no route — static or on-demand — could
   * measure to or from its base. Soft, not fatal: one anchor is dropped
   * (excluded from `locks`), never the whole plan — the same doctrine
   * `anchor_unresolved`/`anchor_infeasible_no_substitute` already follow.
   */
  | 'anchor_unroutable'
  /**
   * A model-proposed anchor that was not on the board resolved to a real
   * place through a deterministic geocoder lookup — `partially_verified`:
   * a real identity, but none of the board's own fit/access/hours/weather
   * evidence. Recorded here for the same reason `base_resolved_via_geocoder`
   * is; see `resolveSkeletonAnchor`.
   */
  | 'anchor_resolved_via_geocoder'
  | 'anchor_resolved_via_places'
  /**
   * A model-proposed anchor that neither the board nor a geocoder could
   * confirm as a real, specific place. Never silently dropped — see
   * `RetainedAnchor` and the doctrine `unknown != false`.
   */
  | 'anchor_unverified'
  | 'base_unresolved'
  | 'base_resolved_via_geocoder'
  | 'duplicate_location_identity'
  /** QUALITY V1 — the draft's day sequence disagreed with its declared base nights (a loop's return, a miscount); the stays were rebuilt from the days. */
  | 'base_stays_corrected_from_days'
  | 'relocation_resolved_with_intermediate_base'
  /**
   * The same remedy as `relocation_resolved_with_intermediate_base`, but the
   * waypoint came from `relocation-corridor.ts`'s reverse-geocoder search
   * along the route rather than from an already-known Discovery Board base
   * candidate — the tier tried when the board has none. See that module's
   * own header for why the board alone is not always enough.
   */
  | 'relocation_resolved_with_corridor_locality'
  /**
   * A mandatory leg (a relocation, or departure closure) that the matrix
   * could not answer for was measured instead by one bounded, direct
   * point-to-point route confirmation — see `confirmMandatoryLeg`. Recorded
   * so the final itinerary can say plainly that this specific measurement
   * came from a real route response, not a matrix cell.
   */
  | 'relocation_confirmed_via_direct_route';

export interface SkeletonDeviation {
  kind: SkeletonDeviationKind;
  detail: string;
  skeletonDayNumber?: number;
  skeletonPlaceIndex?: number;
  /** The real `Place.id` used in place of the skeleton's original intent, when one was found. */
  replacementPlaceId?: string;
}

/**
 * PROVENANCE FOR A MANDATORY LEG'S EVIDENCE — WHAT THE MATRIX SAID, WHAT A
 * DIRECT CONFIRMATION SAID (IF ONE WAS ATTEMPTED), AND WHICH ONE WON.
 *
 * `matrixOutcome`/`matrixFailureReason` describe the sparse matrix's own
 * answer for this exact pair, independent of whether a confirmation ran.
 * `confirmation*` fields are populated only when `confirmMandatoryLeg`
 * actually attempted one — never fabricated when no capability was offered.
 */
export interface RelocationEvidence {
  fromBaseId: string;
  toBaseId: string;
  fromPlaceId: string | null;
  toPlaceId: string | null;
  measuredMinutes: number | null;
  hardCeilingMinutes: number;
  matrixMode: TravelTimeMatrix['mode'];
  /** What the matrix (static or on-demand) itself said about this exact pair, before any direct confirmation. */
  matrixOutcome?: 'measured' | 'authoritative_no_route' | 'unavailable' | 'not_attempted';
  matrixFailureReason?: RouteFailureReason;
  confirmationAttempted?: boolean;
  confirmationProvider?: string;
  confirmationMinutes?: number | null;
  confirmationKm?: number | null;
  confirmationLatencyMs?: number;
  /** The evidence that actually decided this leg's outcome. */
  finalEvidenceClassification?: 'matrix_measured' | 'direct_route_confirmed' | 'authoritative_no_route' | 'evidence_unavailable';
}

/**
 * WHAT `repairTripSkeleton()` WOULD NEED, SHAPED FOR IT NOW — NO MODEL CALL
 * MADE FROM HERE.
 *
 * Deliberately close to `SkeletonRepairInput` in
 * `benchmark/baseline/skeleton-repair.ts` (original skeleton, concise
 * deterministic failure, verified alternatives, locked decisions) so that
 * wiring this into that function later is a translation, not a redesign —
 * see this module's own header for why calling it is out of scope here.
 */
export interface SkeletonRepairIssue {
  kind:
    | 'relocation_infeasible'
    | 'anchor_unresolved'
    | 'base_unresolved'
    | 'base_identity_ambiguous'
    /**
     * The router *answered* for a mandatory leg touching this base — at
     * least once, with a real response — and every answer was a positive
     * "no route exists" (`RouteFailureReason` `'not_found'`). This is a
     * genuine geographic fact about the skeleton's own route structure, and
     * the one repair-eligible member of this pair: a model asked to fix the
     * skeleton is being told something true.
     */
    | 'base_unroutable'
    /**
     * A mandatory leg touching this base has no measured value, and nothing
     * the router said supports concluding the leg is impossible — a
     * timeout, a rate limit, an exhausted budget, an unattempted request, or
     * a result rejected as implausible. This is a fact about *this attempt*,
     * never about the road network, and it is NOT repair-eligible: nothing
     * here has told the model the trip is geographically impossible, and a
     * caller must not treat this the way it treats `base_unroutable` — no
     * `repairTripSkeleton()` call should ever be driven by this kind. A
     * later attempt, a different provider, or a smaller request may still
     * succeed where this one didn't.
     */
    | 'routing_evidence_unavailable'
    | 'departure_unreachable'
    | 'planner_refused';
  detail: string;
  affectedDayNumbers: readonly number[];
  affectedBaseIds: readonly string[];
  relocationEvidence?: RelocationEvidence;
  /**
   * Evidence for every *other* relocation still unresolved after a
   * whole-route remediation pass considered them jointly — `relocationEvidence`
   * above always carries the first. Present only when more than one mandatory
   * leg remains unresolved in the same pass, so the product can say what the
   * *whole* route still needs rather than only the first problem found — see
   * `assessRelocationFeasibility`'s own header on why this no longer returns
   * on the first unresolved leg.
   */
  additionalRelocationEvidence?: readonly RelocationEvidence[];
  /** Real, currently-reachable places found while searching for a remedy — offered, never used unasked. */
  verifiedAlternatives: readonly { placeId: string; name: string; reason: string }[];
  lockedDecisions: { baseIds: readonly string[]; dayNumbers: readonly number[] };
}

export type SkeletonPlanResult = { baseResolutions: readonly BaseResolutionRecord[] } & (
  | {
      ok: true;
      itinerary: Itinerary;
      readiness: PlannerReadiness;
      deviations: readonly SkeletonDeviation[];
      /** Every model-proposed anchor's final, explicit disposition — see `AnchorDisposition`. Never partial: one entry per anchor the skeleton proposed. */
      dispositions: readonly AnchorDispositionRecord[];
    }
  | { ok: false; repairIssue: SkeletonRepairIssue }
);

/* ------------------------------------------------------------------ *
 * Base resolution — deterministic, model-free, and honest about its tiers
 * ------------------------------------------------------------------ */

/**
 * How a skeleton base ended up resolved. Recorded, never inferred after the
 * fact — the report a founder reads is built from this, not reconstructed by
 * guessing which branch ran.
 */
export type BaseResolutionMethod =
  | 'skeleton_evidence'
  | 'compiled_base_exact_name'
  | 'board_exact_name'
  | 'board_proximity'
  | 'geocoder';

/** One candidate a deterministic locality lookup returned — real, or nothing. */
export interface GeocodedLocality {
  /** A stable id for this locality from the geocoder's own catalogue. */
  sourceId: string;
  name: string;
  lat: number;
  lng: number;
  /** ISO-3166-1 alpha-2, when the geocoder's own address breakdown carries one. */
  countryCode?: string;
  /**
   * The geocoder's own administrative classification of this candidate —
   * `classifyNominatim()`'s `entityType` (`nominatim.ts`), the same
   * translation of Nominatim's `addresstype`/`type`/`category` already used
   * elsewhere in this codebase (`live.ts`'s destination-candidate scoring).
   * `'city'` and `'neighbourhood'` are real settlements (city/town/
   * municipality, and village/hamlet/suburb, respectively); anything else —
   * `'unknown'` in particular — is the geocoder's own signal that this
   * candidate is not a recognized administrative locality at all (an
   * attraction, a business, an unclassified point), evidence this file uses
   * to prefer a real place-to-sleep over a same-named landmark.
   */
  entityType?: string;
  /** The geocoder's own 0–1 relevance score, when it exposes one — diagnostic only, never the ranking's primary signal. */
  importance?: number;
}

/**
 * The one seam this file uses to reach a real geocoder — never constructed
 * here. Production wiring supplies the real Nominatim lookup
 * (`apps/web/src/lib/providers/nominatim.ts`'s `geocode`, adapted to this
 * shape); a test supplies a fixture. Zero Anthropic exposure either way: this
 * type has no model in it anywhere.
 */
export type SkeletonBaseGeocoder = (query: string) => Promise<readonly GeocodedLocality[]>;

/**
 * WHY A PAIR IN A `RouteMatrixResult` HAS NO MEASURED VALUE.
 *
 * `'not_found'` is the one value that means the provider actually answered —
 * a real routing engine evaluated the leg and reported no viable route,
 * positive evidence the ground itself has no route. Every other value means
 * the opposite: no trustworthy measurement was obtained, for a reason about
 * the provider or the request (rate limiting, a timeout, an exhausted
 * budget, an implausible result rejected on arrival), never about the road
 * network. This is the distinction `base_unroutable` vs
 * `routing_evidence_unavailable` is built on — see `classifyRouteFailure`.
 */
export type RouteFailureReason = 'not_found' | 'provider_error' | 'rate_limited' | 'budget_exhausted' | 'insufficient_evidence';

/** The one `RouteFailureReason` that is positive evidence rather than an absent answer. */
export const AUTHORITATIVE_NO_ROUTE: RouteFailureReason = 'not_found';

/** A small, real, on-demand routed matrix over exactly the points asked for — never the whole region. */
export interface RouteMatrixResult {
  ids: readonly string[];
  /** minutes[i][j], indices matching `ids`. A missing/unmeasured pair is a non-finite cell, never invented. */
  minutes: readonly (readonly number[])[];
  /** km[i][j], same indexing. Real distance from the router, never derived or guessed from minutes. */
  km: readonly (readonly number[])[];
  /**
   * Pairs this call could not answer for, classified — optional so a fixture
   * or a provider with nothing to report can omit it, but never a place to
   * hide a real distinction: when present, every entry says *why*, per
   * `RouteFailureReason`.
   */
  failedPairs?: readonly { fromId: string; toId: string; reason: RouteFailureReason }[];
}

/**
 * The one seam this file uses to reach real production routing — never
 * constructed here. Production wiring adapts the real `RoutingProvider`
 * (`packages/compiler/src/providers.ts`, Valhalla-backed) already used
 * during compilation; a test supplies a fixture. Given the small set of
 * points that need it (resolved bases, never the whole board), never the
 * model, and never fabricated when it returns nothing for a pair.
 */
export type SkeletonRouteMatrixProvider = (
  points: readonly { id: string; lat: number; lng: number }[],
) => Promise<RouteMatrixResult | null>;

/**
 * ONE PAIR, DIRECTLY — THE ANSWER TO EXACTLY ONE QUESTION, NEVER A MATRIX.
 *
 * `found: true` means the provider returned a real, positive measurement —
 * the same standard `RouteMatrixResult`'s finite cells already mean.
 * `found: false` is `RouteMatrixResult.failedPairs`'s per-pair shape,
 * collapsed to one pair: `reason: 'not_found'` is the provider's own
 * positive "no route exists" answer; every other reason (or no reason at
 * all, for a provider that cannot say why) means no trustworthy
 * measurement was obtained, never a claim about the road network.
 */
export interface RouteConfirmation {
  found: boolean;
  minutes: number | null;
  km: number | null;
  reason?: RouteFailureReason;
  /** Which real provider answered — for provenance, not for branching logic here. */
  provider?: string;
  /** Real latency of this one request, ms — diagnostic only. */
  latencyMs?: number;
  /**
   * The route's own real shape, when the provider's response carried one —
   * see `RouteConfirmationResult.geometry`'s own header
   * (`packages/compiler/src/providers.ts`). Present "for free" whenever a
   * direct confirmation succeeds and the provider returns geometry with its
   * duration, in the same response — never fetched by a second request.
   * `relocation-corridor.ts`'s remedy tier is this file's one consumer of
   * it; ordinary mandatory-leg confirmation neither requests nor discards
   * anything extra to carry it.
   */
  geometry?: readonly { lat: number; lng: number }[];
  /** LIVE WORLD V1 — what kind of figure this is, so the itinerary can say so. */
  basis?: 'static' | 'traffic_aware' | 'scheduled' | 'estimated';
  measuredAt?: string;
  staticMinutes?: number;
  effectiveDepartAt?: string;
  transitSummary?: string;
}

/**
 * The one seam this file uses to reach a real single-route confirmation —
 * never constructed here. Production wiring adapts the same `RoutingProvider`
 * `routeMatrix` above already uses, when that provider exposes one (optional
 * — see `RoutingProvider.route` in `packages/compiler/src/providers.ts`); a
 * test supplies a fixture. Bounded to exactly the one pair asked, never a
 * retry loop, never fabricated when the provider has nothing to say.
 */
export type SkeletonRouteConfirmationProvider = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) => Promise<RouteConfirmation | null>;

/**
 * The one seam `relocation-corridor.ts`'s remedy tier uses to ask "what real
 * settlements are near here" — never constructed here. Production wiring
 * (`productionFindNearbyLocalities` in `skeleton-orchestrator.ts`) prefers a
 * bounded Overpass settlement search over the given radius, falling back to
 * Nominatim's exact-point reverse geocoder only when that is unavailable; a
 * test supplies a fixture directly. An empty array is a real, honest
 * "nothing found within this radius", not an error.
 */
export type SkeletonCorridorLocalitySearch = (
  point: { lat: number; lng: number },
  radiusKm: number,
) => Promise<readonly GeocodedLocality[]>;

/**
 * THE DESTINATION'S OWN REAL GEOGRAPHIC IDENTITY — NOT `Region.maxRadiusKm`.
 *
 * `Region.maxRadiusKm` means "how far the compiler's own *discovered
 * evidence* spreads from the primary base" (`buildRegion()` in
 * `packages/compiler/src/compile.ts`: `Math.max(10, ...places.map(place =>
 * place.travelFromBase.distanceKm))`) — a number about what got *found*, not
 * about where the destination actually *is*. For a country-scale, zero-model
 * compilation whose expansion never ran, that number floors at its own
 * 10 km minimum and has nothing to do with the country's real extent, which
 * is exactly the bug the zero-model Iceland run exposed: Vík (≈186 km from
 * the centroid), Höfn (≈450 km) and Akureyri (≈210 km) are all genuinely
 * inside Iceland and were rejected by a check built for a different question.
 * `Region.maxRadiusKm`'s existing meaning and every existing caller of it are
 * untouched by this file — this is a second, separate source of truth, used
 * only for skeleton base-resolution geography.
 *
 * Built from `CompiledRegion.scope: GeographicScope` (`packages/core/src/
 * schemas/scope.ts`), the confirmed-at-confirmation-time record of what the
 * destination actually is — administratively and geometrically — which
 * already exists and is already stored on every compiled artifact.
 */
export interface BaseResolutionScope {
  /** ISO-3166-1 alpha-2, when the destination's own administrative identity is known. */
  countryCode?: string;
  /**
   * The destination's real published/measured extent, unclipped —
   * `GeographicScope.administrativeBoundary`, or its clipped `bounds` when
   * that is all a stored scope carries. Only trustworthy as a containment
   * boundary when `boundaryEvidence` says so — see that field's own note.
   */
  administrativeBounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } };
  /**
   * Whether `administrativeBounds` is a real boundary or merely a circle
   * drawn around a point. `'reach_circle'` is the truth for nearly every
   * subregion/city/town-scale destination — no published polygon exists for
   * the overwhelming majority of them — and a circle must never be read as
   * an administrative border (see `GeographicScope.boundaryEvidence`'s own
   * note: a New York trip's reach circle once "contained" a Pennsylvania
   * county). Only `'published_boundary'`/`'measured_extent'` license using
   * `administrativeBounds` as containment evidence.
   */
  boundaryEvidence: 'published_boundary' | 'measured_extent' | 'reach_circle';
  /** The destination's own stated reach — `GeographicScope.reachRadiusKm` — for the last-resort fallback only. */
  reachRadiusKm?: number;
}

/** A named area Sidequest already has real geometry for — `CompiledRegion.subregions`, when any exist. */
export interface SubregionGeometry {
  center: { lat: number; lng: number };
  radiusKm: number;
}

/**
 * WHY A GEOCODED LOCALITY WAS ACCEPTED OR REJECTED, IN ITS OWN TERMS.
 *
 * Recorded even though the outer `SkeletonRepairIssue` still collapses to
 * `base_unresolved` — the *reason* must survive past that collapse, because
 * "outside the destination's real boundary" and "inside it but this
 * particular check has no evidence yet" are different findings a founder (or
 * a later repair) needs to tell apart.
 */
export type BaseResolutionScopeOutcome =
  | 'accepted_administrative_containment'
  | 'accepted_destination_bounds'
  | 'accepted_evidence_extent'
  | 'accepted_subregion_geometry'
  | 'accepted_radius_fallback'
  /** A real administrative/country mismatch — authoritative, nothing weaker is consulted. */
  | 'rejected_outside_administrative_destination'
  /** Outside a real published/measured boundary — authoritative, nothing weaker is consulted. */
  | 'rejected_outside_destination_bounds'
  /** Nothing — not a real boundary, not the destination's own evidence, not the fallback radius — accepted it. */
  | 'rejected_outside_radius_fallback'
  | 'rejected_ambiguous_locality'
  | 'geocoder_unavailable';

/** A resolved skeleton base's real identity — just enough to route, schedule and name it. */
export interface ResolvedBaseIdentity {
  /** The matrix/routing id, when this identity is known to one. */
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
}

/**
 * WHAT ACTUALLY HAPPENED WHEN THIS BASE WAS RESOLVED — THE FULL DIAGNOSTIC,
 * NOT JUST THE OUTCOME.
 *
 * One of these exists for every skeleton base, resolved or not, so a founder
 * (or a repair issue) can say exactly which tier answered, how far the
 * result sits from what the skeleton stated, and whether the matrix can
 * actually measure a route to it yet — a real identity with no matrix
 * presence is a true, useful answer, not a bug.
 */
export interface BaseResolutionRecord {
  skeletonBaseId: string;
  skeletonName: string;
  requestedCoordinates: { lat: number; lng: number } | null;
  resolvedId: string | null;
  resolvedName: string | null;
  method: BaseResolutionMethod | null;
  /** Straight-line distance between the skeleton's own coordinate and the resolved identity. */
  distanceKm: number | null;
  /** More than one equally-plausible identity was found; nothing was picked. */
  ambiguous: boolean;
  provenance: 'discovery_board' | 'compiled_region_bases' | 'geocoder' | null;
  /** Whether `context.matrix` already has a row for this identity — real routing needs this to be true. */
  measuredInMatrix: boolean;
  /**
   * Whether *some* real evidence measures a route to/from this identity —
   * `measuredInMatrix`, or a successful on-demand `routeMatrix` lookup.
   * `false` for an identity that resolved but that nothing could route,
   * which is exactly the `base_unroutable` repair issue's condition.
   */
  routable: boolean;
  /**
   * Why a geocoded candidate was accepted or rejected on geography alone —
   * `null` when the geocoder tier never ran (resolved earlier, or no
   * `geocodeLocality` configured at all). See `BaseResolutionScopeOutcome`.
   */
  geographicScopeOutcome: BaseResolutionScopeOutcome | null;
  /**
   * Every geocoder candidate that survived geographic-scope filtering, with
   * enough to explain the outcome — never the full provider payload. `null`
   * unless the geocoder tier actually returned results. See
   * `rankGeocoderCandidates` for how `selected`/`rankingReason` were decided.
   */
  candidates: readonly CandidateDiagnostic[] | null;
}

/** One geographically-plausible geocoder candidate, kept for diagnostics — not the full provider payload. */
export interface CandidateDiagnostic {
  sourceId: string;
  name: string;
  coordinates: { lat: number; lng: number };
  /** `classifyNominatim()`'s `entityType`, when the geocoder exposed one — see `GeocodedLocality.entityType`. */
  entityType?: string;
  /** Whether `entityType` reads as a real settlement (`'city'`/`'neighbourhood'`) rather than an attraction/business/unclassified point. */
  isLocality: boolean;
  importance?: number;
  /** Straight-line distance to the skeleton's own stated coordinate, or `null` when the skeleton carried none. */
  distanceKm: number | null;
  geographicScopeOutcome: BaseResolutionScopeOutcome;
  /** Whether this candidate is the one `resolveSkeletonBase` picked. */
  selected: boolean;
  /** Why — `rankGeocoderCandidates`'s reason when selected, or why this one lost when not. */
  rankingReason: string;
}

export interface ResolvedBase {
  skeletonBaseId: string;
  name: string;
  nights: number;
  identity: ResolvedBaseIdentity | null;
}

export function identityFromPlace(place: Place): ResolvedBaseIdentity {
  return { id: place.id, name: displayNameOf(place), coordinates: place.coordinates };
}

function identityFromBaseCandidate(base: BaseCandidate): ResolvedBaseIdentity {
  return { id: base.routingId, name: displayNameOf(base), coordinates: base.coordinates };
}

/** How far outside a fallback radius a geocoder match is still trusted — slack for a rounded boundary. */
const GEOCODER_REGION_MARGIN = 1.15;
/** Slack over the destination's own real evidence extent — a genuine outlier still counts, a wild one does not. */
const EVIDENCE_EXTENT_MARGIN = 1.2;
/** The high percentile used for the evidence-derived extent, so one outlier place cannot expand the scope arbitrarily. */
const EVIDENCE_EXTENT_PERCENTILE = 0.9;

function pointWithinBounds(
  point: { lat: number; lng: number },
  bounds: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } },
): boolean {
  return (
    point.lat >= bounds.southWest.lat &&
    point.lat <= bounds.northEast.lat &&
    point.lng >= bounds.southWest.lng &&
    point.lng <= bounds.northEast.lng
  );
}

/**
 * HOW FAR THE DESTINATION'S OWN REAL, DISCOVERED EVIDENCE ACTUALLY SPREADS.
 *
 * The 90th-percentile distance from the region's own base, not the bare
 * maximum — one outlier place (a data error, or a single far-flung addition)
 * must not single-handedly widen where a base can resolve. Computed fresh
 * from `context.candidates`' own real coordinates every time, deliberately
 * not read off `Region.maxRadiusKm` (which is *also* a distance-from-evidence
 * figure, but computed once at compile time and, as the zero-model Iceland
 * compilation showed, can floor at a near-meaningless minimum when the
 * distances behind it were never actually computed).
 */
function evidenceExtentKm(center: { lat: number; lng: number }, candidates: readonly DiscoveryCandidate[]): number | null {
  if (candidates.length === 0) return null;
  const distances = candidates.map((c) => haversineKm(center, c.place.coordinates)).sort((a, b) => a - b);
  const index = Math.min(distances.length - 1, Math.floor(distances.length * EVIDENCE_EXTENT_PERCENTILE));
  return distances[index]!;
}

/**
 * WHETHER A GEOCODED POINT BELONGS TO THIS DESTINATION — GEOGRAPHICALLY, NOT
 * BY A ONE-SIZE RADIUS.
 *
 * Tiers, in order, stopping at the first that has an answer:
 *
 * 1. **Administrative identity.** A country-code mismatch is an outright
 *    rejection — the strongest, cheapest signal available. A *match* only
 *    decides acceptance on its own when the destination's own boundary is
 *    real (`boundaryEvidence !== 'reach_circle'`) — country-scale
 *    destinations like Iceland get this; a subregion/city-scale destination
 *    (nearly everything else — no published polygon exists for the
 *    overwhelming majority of towns and cities) does not, so "same country"
 *    alone never admits a same-country namesake for a Mammoth-Lakes-scale
 *    trip. That case falls through to the tiers below, which are naturally
 *    small for a small destination.
 * 2. **A real published/measured boundary**, when one exists and is not a
 *    reach circle — genuine containment, regardless of distance from the
 *    centroid. This is what makes Vík/Höfn/Akureyri resolvable for Iceland.
 * 3. **The destination's own observed evidence extent** — see
 *    `evidenceExtentKm`. Only ever *accepts*; failing this tier falls
 *    through rather than rejecting, since it is statistical, not a boundary.
 * 4. **Explicit subregion geometry** Sidequest already has, when any exists.
 * 5. **A conservative radius fallback** — the destination's own stated reach
 *    (`reachRadiusKm`) when known, else `Region.maxRadiusKm` unchanged, the
 *    exact pre-existing behaviour. The only tier whose failure is itself the
 *    final, reported rejection.
 */
export function assessGeographicScope(input: {
  point: { lat: number; lng: number };
  countryCode: string | undefined;
  region: Region;
  scope: BaseResolutionScope | undefined;
  subregions: readonly SubregionGeometry[] | undefined;
  evidenceCandidates: readonly DiscoveryCandidate[];
}): { accepted: boolean; outcome: BaseResolutionScopeOutcome } {
  const { point, countryCode, region, scope, subregions, evidenceCandidates } = input;

  // Tier 1 — administrative identity.
  if (scope?.countryCode && countryCode) {
    if (scope.countryCode.toLowerCase() !== countryCode.toLowerCase()) {
      return { accepted: false, outcome: 'rejected_outside_administrative_destination' };
    }
    if (scope.boundaryEvidence !== 'reach_circle') {
      return { accepted: true, outcome: 'accepted_administrative_containment' };
    }
  }

  // Tier 2 — a real published/measured boundary.
  if (scope?.administrativeBounds && scope.boundaryEvidence !== 'reach_circle') {
    if (pointWithinBounds(point, scope.administrativeBounds)) {
      return { accepted: true, outcome: 'accepted_destination_bounds' };
    }
    return { accepted: false, outcome: 'rejected_outside_destination_bounds' };
  }

  // Tier 3 — the destination's own observed evidence extent.
  const extent = evidenceExtentKm(region.baseCoordinates, evidenceCandidates);
  if (extent !== null && haversineKm(region.baseCoordinates, point) <= extent * EVIDENCE_EXTENT_MARGIN) {
    return { accepted: true, outcome: 'accepted_evidence_extent' };
  }

  // Tier 4 — explicit subregion geometry already known to Sidequest.
  for (const subregion of subregions ?? []) {
    if (haversineKm(subregion.center, point) <= subregion.radiusKm) {
      return { accepted: true, outcome: 'accepted_subregion_geometry' };
    }
  }

  // Tier 5 — a conservative radius fallback, the only tier whose rejection is final.
  const fallbackRadiusKm = scope?.reachRadiusKm ?? region.maxRadiusKm;
  if (haversineKm(region.baseCoordinates, point) <= fallbackRadiusKm * GEOCODER_REGION_MARGIN) {
    return { accepted: true, outcome: 'accepted_radius_fallback' };
  }
  return { accepted: false, outcome: 'rejected_outside_radius_fallback' };
}

interface BaseResolutionOutcome {
  identity: ResolvedBaseIdentity | null;
  method: BaseResolutionMethod | null;
  distanceKm: number | null;
  ambiguous: boolean;
  provenance: BaseResolutionRecord['provenance'];
  geographicScopeOutcome: BaseResolutionScopeOutcome | null;
  candidates: readonly CandidateDiagnostic[] | null;
}

const UNRESOLVED: BaseResolutionOutcome = {
  identity: null,
  method: null,
  distanceKm: null,
  ambiguous: false,
  provenance: null,
  geographicScopeOutcome: null,
  candidates: null,
};

/**
 * HOW CLOSE A GEOCODED CANDIDATE MUST SIT TO THE SKELETON'S OWN COORDINATE
 * TO BE TRUSTED AS "THE SAME LOCALITY" AT ALL, AND HOW MUCH IT MUST BEAT A
 * RUNNER-UP TO BE PICKED WITHOUT ASKING.
 *
 * Deliberately wider than `PROXIMITY_MATCH_KM` (0.3 km): that constant
 * matches one exact point-of-interest coordinate to a board candidate, but a
 * town or city's own OSM node can legitimately sit a little off from
 * wherever a skeleton's evidence happened to record its centroid — the real
 * Vík match landed at 0.0004 km, but nothing here assumes matches are always
 * that close. Small and generic on purpose, not tuned to any one country or
 * place name: a locality this far from the skeleton's stated coordinate is
 * plausibly the same place; a runner-up this much farther is plausibly a
 * different one.
 */
const LOCALITY_RESOLUTION_RADIUS_KM = 2;
/** The nearest candidate must beat the runner-up by at least this many km to be picked on distance alone. */
const LOCALITY_MARGIN_KM = 1;
/** ...or be at least this many times closer — whichever is easier to satisfy, so a very tight cluster still resolves. */
const LOCALITY_MARGIN_RATIO = 3;

/** `classifyNominatim()`'s `entityType` values that mean "a real settlement", not an attraction, business, or unclassified point. */
const LOCALITY_ENTITY_TYPES = new Set(['city', 'neighbourhood']);

/** Exported for `relocation-corridor.ts` — the same real-settlement-vs-attraction rule, reused rather than forked. */
export function isLocalityCandidate(candidate: GeocodedLocality): boolean {
  return candidate.entityType !== undefined && LOCALITY_ENTITY_TYPES.has(candidate.entityType);
}

export interface AssessedGeocoderCandidate {
  result: GeocodedLocality;
  accepted: boolean;
  outcome: BaseResolutionScopeOutcome;
}

/**
 * DETERMINISTIC, CONSERVATIVE DISAMBIGUATION AMONG SEVERAL GEOGRAPHICALLY-
 * PLAUSIBLE GEOCODER CANDIDATES — NEVER "NEAREST ALWAYS WINS".
 *
 * Called only once `assessGeographicScope` has already filtered to
 * candidates that genuinely belong to the destination; this function's only
 * job is picking among *those*, using the skeleton's own stated coordinate
 * as the tie-breaker Sidequest already has and was not using.
 *
 * Two independent ways to win, checked in order:
 *
 * 1. **Locality identity, among candidates close enough to compete.** If
 *    exactly one candidate within `LOCALITY_RESOLUTION_RADIUS_KM` reads as a
 *    real settlement (`isLocalityCandidate`) and at least one other
 *    candidate is also that close but is not, the settlement wins outright —
 *    an overnight base is a place to sleep, and an unrelated attraction or
 *    business sharing its name is never a valid substitute, regardless of
 *    which one the geocoder happened to rank fractionally nearer. This never
 *    reaches past `LOCALITY_RESOLUTION_RADIUS_KM`, so it can prefer a
 *    settlement over a closer namesake but can never rescue one that is
 *    genuinely far from where the skeleton said its base was.
 * 2. **A materially dominant nearest candidate.** Otherwise, the closest
 *    candidate wins only when it is inside `LOCALITY_RESOLUTION_RADIUS_KM`
 *    *and* clearly ahead of the runner-up — by `LOCALITY_MARGIN_KM` or by
 *    `LOCALITY_MARGIN_RATIO`, whichever is easier to satisfy.
 *
 * Anything else — no skeleton coordinate to rank by, the nearest candidate
 * itself too far away, or two-plus candidates within the radius that are
 * neither a clean locality-vs-attraction split nor clearly separated by
 * distance — stays `null`: genuine ambiguity, never a guess.
 */
function rankGeocoderCandidates(
  accepted: readonly AssessedGeocoderCandidate[],
  stated: { lat: number; lng: number } | null,
): { winner: AssessedGeocoderCandidate | null; reason: string } {
  if (!stated) return { winner: null, reason: 'no_skeleton_coordinate_to_rank_by' };

  const withDistance = accepted
    .map((c) => ({ candidate: c, distanceKm: haversineKm(stated, c.result) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = withDistance[0]!;
  const runnerUp = withDistance[1]!;

  if (nearest.distanceKm > LOCALITY_RESOLUTION_RADIUS_KM) {
    return { winner: null, reason: 'nearest_candidate_outside_locality_resolution_radius' };
  }

  const withinRadius = withDistance.filter((c) => c.distanceKm <= LOCALITY_RESOLUTION_RADIUS_KM);
  const localityOnesWithinRadius = withinRadius.filter((c) => isLocalityCandidate(c.candidate.result));
  if (withinRadius.length > 1 && localityOnesWithinRadius.length === 1) {
    return { winner: localityOnesWithinRadius[0]!.candidate, reason: 'locality_identity_preferred_over_non_locality' };
  }

  const materiallyCloser =
    runnerUp.distanceKm - nearest.distanceKm >= LOCALITY_MARGIN_KM ||
    (nearest.distanceKm > 0 && runnerUp.distanceKm >= nearest.distanceKm * LOCALITY_MARGIN_RATIO);
  if (materiallyCloser) {
    return { winner: nearest.candidate, reason: 'materially_nearer_than_runner_up' };
  }
  return { winner: null, reason: 'candidates_too_close_to_distinguish_safely' };
}

/**
 * Every geocoder candidate that passed geographic scope, kept as a diagnostic
 * — never the full provider payload, just enough to make a repair issue
 * actionable. `selectedSourceId` is `null` when nothing was picked.
 */
function buildCandidateDiagnostics(
  assessed: readonly AssessedGeocoderCandidate[],
  stated: { lat: number; lng: number } | null,
  selectedSourceId: string | null,
  selectionReason?: string,
): readonly CandidateDiagnostic[] {
  return assessed
    .filter((a) => a.accepted)
    .map((a) => {
      const distanceKm = stated ? haversineKm(stated, a.result) : null;
      const selected = a.result.sourceId === selectedSourceId;
      return {
        sourceId: a.result.sourceId,
        name: a.result.name,
        coordinates: { lat: a.result.lat, lng: a.result.lng },
        ...(a.result.entityType !== undefined ? { entityType: a.result.entityType } : {}),
        isLocality: isLocalityCandidate(a.result),
        ...(a.result.importance !== undefined ? { importance: a.result.importance } : {}),
        distanceKm,
        geographicScopeOutcome: a.outcome,
        selected,
        rankingReason: selected ? (selectionReason ?? 'single_accepted_candidate') : 'accepted_geography_but_not_selected',
      };
    });
}

/**
 * THE DETERMINISTIC BASE-RESOLUTION POLICY.
 *
 * Four tiers, tried in order, every one of them real production evidence and
 * none of them the model:
 *
 * 1. **Skeleton evidence identity** — the skeleton cited a `placeIndex` from
 *    its own evidence packet, and that place is also a real board candidate.
 * 2. **The compiler's own base list, by exact name** — `CompiledRegion.bases`
 *    (`context.compiledBases`), the deterministic "somewhere to sleep" list a
 *    live compilation with real regional evidence populates. Preferred over
 *    the board because a `BaseCandidate` carries what a base actually needs
 *    (`routingId`, `timeZone`, `suggestedNights`) that an attraction card
 *    does not — see this file's header on why the two must stay distinct.
 * 3. **The Discovery Board, by name or close proximity** — the previous
 *    behaviour, kept: a base that also happens to be a scored attraction (a
 *    town square, a named landmark) is still real evidence.
 * 4. **A deterministic geocoder**, bounded to the trip's own region
 *    (`withinRegion`) so a same-named locality on the far side of the world
 *    is never accepted — the last resort, and the only tier that can resolve
 *    a base the compiler and the board both missed entirely, which is
 *    exactly the Vík/Höfn/Akureyri case the zero-model Iceland run exposed.
 *
 * More than one equally-plausible match at tier 2 or tier 4 is `ambiguous`,
 * never resolved by picking one — the caller turns that into a typed
 * `SkeletonRepairIssue`, per this file's own rule against silently choosing
 * a different town.
 */
export async function resolveSkeletonBase(
  base: TripSkeleton['bases'][number],
  packet: SkeletonEvidencePacket,
  context: Pick<
    SkeletonPlanningContext,
    'candidates' | 'compiledBases' | 'region' | 'geocodeLocality' | 'destinationScope' | 'subregionGeometries'
  >,
): Promise<BaseResolutionOutcome> {
  const evidencePlace = base.placeIndex !== null ? packet.places.find((p) => p.index === base.placeIndex) : undefined;
  const packetBaseCandidate = packet.baseCandidates.find((b) => b.name === base.name);
  const stated = evidencePlace ?? packetBaseCandidate ?? null;

  // Tier 1 — skeleton evidence, resolved through the board.
  if (evidencePlace) {
    const resolved = resolveAnchorPlace(evidencePlace, context.candidates);
    if (resolved.place) {
      return {
        identity: identityFromPlace(resolved.place),
        method: 'skeleton_evidence',
        distanceKm: haversineKm(evidencePlace, resolved.place.coordinates),
        ambiguous: false,
        provenance: 'discovery_board',
        geographicScopeOutcome: null,
        candidates: null,
      };
    }
  }

  // Tier 2 — the compiler's own base-eligible list, exact normalized name.
  if (stated) {
    const target = normalizeName(base.name);
    const nameMatches = (context.compiledBases ?? []).filter((b) => normalizeName(displayNameOf(b)) === target);
    if (nameMatches.length === 1) {
      const match = nameMatches[0]!;
      return {
        identity: identityFromBaseCandidate(match),
        method: 'compiled_base_exact_name',
        distanceKm: haversineKm(stated, match.coordinates),
        ambiguous: false,
        provenance: 'compiled_region_bases',
        geographicScopeOutcome: null,
        candidates: null,
      };
    }
    if (nameMatches.length > 1) {
      return { ...UNRESOLVED, ambiguous: true, provenance: 'compiled_region_bases' };
    }
  }

  // Tier 3 — the Discovery Board, by name or close proximity (unchanged from before).
  if (packetBaseCandidate) {
    const resolved = resolveAnchorPlace({ name: base.name, lat: packetBaseCandidate.lat, lng: packetBaseCandidate.lng }, context.candidates);
    if (resolved.place) {
      return {
        identity: identityFromPlace(resolved.place),
        method: resolved.confidence === 'name' ? 'board_exact_name' : 'board_proximity',
        distanceKm: haversineKm(packetBaseCandidate, resolved.place.coordinates),
        ambiguous: false,
        provenance: 'discovery_board',
        geographicScopeOutcome: null,
        candidates: null,
      };
    }
  }

  // Tier 4 — a deterministic geocoder, screened by the destination's own
  // real geography (`assessGeographicScope`), never a one-size radius. A
  // provider failure (a real network/service error) degrades to
  // "unresolved" exactly like every other provider gap in this codebase —
  // never a crash that takes the whole plan attempt down with it.
  if (context.geocodeLocality) {
    let results: readonly GeocodedLocality[];
    try {
      results = await context.geocodeLocality(`${base.name}, ${context.region.name}`);
    } catch {
      return { ...UNRESOLVED, geographicScopeOutcome: 'geocoder_unavailable' };
    }

    const assessed = results.map((r) => ({
      result: r,
      ...assessGeographicScope({
        point: r,
        countryCode: r.countryCode,
        region: context.region,
        scope: context.destinationScope,
        subregions: context.subregionGeometries,
        evidenceCandidates: context.candidates,
      }),
    }));
    const accepted = assessed.filter((a) => a.accepted);

    if (accepted.length === 1) {
      const match = accepted[0]!;
      return {
        identity: { id: match.result.sourceId, name: match.result.name, coordinates: { lat: match.result.lat, lng: match.result.lng } },
        method: 'geocoder',
        distanceKm: stated ? haversineKm(stated, match.result) : null,
        ambiguous: false,
        provenance: 'geocoder',
        geographicScopeOutcome: match.outcome,
        candidates: buildCandidateDiagnostics(assessed, stated, match.result.sourceId),
      };
    }
    if (accepted.length > 1) {
      // More than one real identity is geographically plausible — before
      // declaring that ambiguous, use the skeleton's own stated coordinate
      // to rank them (`rankGeocoderCandidates`), the same evidence this file
      // already carries but was not yet using here. A dominant match is
      // resolved exactly like any other tier; anything short of dominant
      // stays a refusal to guess, same as before, but now with the actual
      // candidates recorded so the resulting repair issue is actionable.
      const ranked = rankGeocoderCandidates(accepted, stated);
      const candidates = buildCandidateDiagnostics(assessed, stated, ranked.winner?.result.sourceId ?? null, ranked.reason);
      if (ranked.winner) {
        const match = ranked.winner;
        return {
          identity: { id: match.result.sourceId, name: match.result.name, coordinates: { lat: match.result.lat, lng: match.result.lng } },
          method: 'geocoder',
          distanceKm: stated ? haversineKm(stated, match.result) : null,
          ambiguous: false,
          provenance: 'geocoder',
          geographicScopeOutcome: match.outcome,
          candidates,
        };
      }
      return {
        ...UNRESOLVED,
        ambiguous: true,
        provenance: 'geocoder',
        geographicScopeOutcome: 'rejected_ambiguous_locality',
        candidates,
      };
    }
    // Nothing passed geography — report the most informative rejection
    // (an authoritative admin/bbox mismatch over a mere fallback miss).
    const authoritative = assessed.find(
      (a) => a.outcome === 'rejected_outside_administrative_destination' || a.outcome === 'rejected_outside_destination_bounds',
    );
    return {
      ...UNRESOLVED,
      geographicScopeOutcome: authoritative?.outcome ?? assessed[0]?.outcome ?? null,
    };
  }

  return UNRESOLVED;
}

/**
 * Minutes for a pair, from whichever real evidence has it — never invented.
 *
 * `extra` (a small, on-demand routed sub-matrix over resolved bases; see
 * `SkeletonPlanningContext.routeMatrix`) is checked first, since it is the
 * more specific, more recently measured evidence for exactly these points;
 * `context.matrix`, the board's own static matrix, is the fallback. Absent
 * from both is `null`, exactly as before — an honest "not measured", not a
 * claim either way.
 */
export function measuredMinutes(matrix: TravelTimeMatrix, extra: RouteMatrixResult | null, fromId: string, toId: string): number | null {
  if (extra) {
    const fromIndex = extra.ids.indexOf(fromId);
    const toIndex = extra.ids.indexOf(toId);
    if (fromIndex >= 0 && toIndex >= 0) {
      const value = extra.minutes[fromIndex]?.[toIndex];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  const leg = tryLeg(matrix, fromId, toId);
  return leg?.minutes ?? null;
}

/** Whether some real evidence — the matrix or a routed sub-matrix — can measure a leg touching this id at all. */
export function routableWithin(matrix: TravelTimeMatrix, extra: RouteMatrixResult | null, id: string): boolean {
  if (matrix.ids.includes(id)) return true;
  if (!extra) return false;
  const index = extra.ids.indexOf(id);
  if (index < 0) return false;
  for (let other = 0; other < extra.ids.length; other += 1) {
    if (other === index) continue;
    const forward = extra.minutes[index]?.[other];
    const backward = extra.minutes[other]?.[index];
    if ((typeof forward === 'number' && Number.isFinite(forward)) || (typeof backward === 'number' && Number.isFinite(backward))) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * THE TRAVEL-LEG LEDGER — SPARSE, INCREMENTAL, BUILT FROM MANY SMALL CALLS
 * ------------------------------------------------------------------ *
 *
 * A `TripSkeleton` does not need one dense matrix over every point it
 * mentions before hydration can begin — it needs the handful of legs that
 * are actually mandatory (consecutive overnight-base relocations, a day's
 * own base-to-anchor legs) measured, in requests bounded to what that one
 * question needs. This ledger is where those many small on-demand results
 * accumulate: still a `RouteMatrixResult`-shaped dense grid underneath (so
 * `measuredMinutes`/`routableWithin`/`assessRelocationFeasibility`/
 * `buildBasePortfolioDates` — every existing consumer — read it exactly as
 * they always read `extraMatrix`, unchanged), but grown incrementally, one
 * small request at a time, rather than requested once as a single square
 * over every point the skeleton touches.
 */

export interface TravelLegLedger {
  ids: string[];
  minutes: number[][];
  km: number[][];
  /** fromId -> toId -> why that specific ordered pair has no measured value. */
  failures: Map<string, Map<string, RouteFailureReason>>;
}

export function emptyLedger(): TravelLegLedger {
  return { ids: [], minutes: [], km: [], failures: new Map() };
}

function ledgerIndexFor(ledger: TravelLegLedger, id: string): number {
  const existing = ledger.ids.indexOf(id);
  if (existing >= 0) return existing;
  for (const row of ledger.minutes) row.push(Number.NaN);
  for (const row of ledger.km) row.push(Number.NaN);
  ledger.ids.push(id);
  ledger.minutes.push(new Array(ledger.ids.length).fill(Number.NaN));
  ledger.km.push(new Array(ledger.ids.length).fill(Number.NaN));
  return ledger.ids.length - 1;
}

/** Folds one small on-demand result into the ledger — measured values overwrite `NaN`, never the reverse. */
function mergeIntoLedger(ledger: TravelLegLedger, result: RouteMatrixResult): void {
  const indexOf = result.ids.map((id) => ledgerIndexFor(ledger, id));
  for (let i = 0; i < result.ids.length; i += 1) {
    for (let j = 0; j < result.ids.length; j += 1) {
      const minutes = result.minutes[i]?.[j];
      const km = result.km[i]?.[j];
      const fromIndex = indexOf[i]!;
      const toIndex = indexOf[j]!;
      if (typeof minutes === 'number' && Number.isFinite(minutes)) ledger.minutes[fromIndex]![toIndex] = minutes;
      if (typeof km === 'number' && Number.isFinite(km)) ledger.km[fromIndex]![toIndex] = km;
    }
  }
  for (const pair of result.failedPairs ?? []) {
    let byTo = ledger.failures.get(pair.fromId);
    if (!byTo) {
      byTo = new Map();
      ledger.failures.set(pair.fromId, byTo);
    }
    byTo.set(pair.toId, pair.reason);
  }
}

export function ledgerSnapshot(ledger: TravelLegLedger): RouteMatrixResult | null {
  if (ledger.ids.length === 0) return null;
  const failedPairs: { fromId: string; toId: string; reason: RouteFailureReason }[] = [];
  for (const [fromId, byTo] of ledger.failures) {
    for (const [toId, reason] of byTo) failedPairs.push({ fromId, toId, reason });
  }
  return { ids: ledger.ids, minutes: ledger.minutes, km: ledger.km, failedPairs };
}

/** Whichever direction has a recorded reason — routes are not always symmetric, but a failure on either leg is informative. */
export function ledgerFailureReason(ledger: TravelLegLedger, fromId: string, toId: string): RouteFailureReason | null {
  return ledger.failures.get(fromId)?.get(toId) ?? ledger.failures.get(toId)?.get(fromId) ?? null;
}

/** Same lookup as `ledgerFailureReason`, but against a plain `RouteMatrixResult` — for functions that only ever see a snapshot. */
export function failureReasonIn(result: RouteMatrixResult | null, fromId: string, toId: string): RouteFailureReason | null {
  if (!result?.failedPairs) return null;
  for (const pair of result.failedPairs) {
    if ((pair.fromId === fromId && pair.toId === toId) || (pair.fromId === toId && pair.toId === fromId)) return pair.reason;
  }
  return null;
}

/** What `confirmMandatoryLeg` actually did, for the caller to classify and report. */
export interface MandatoryLegConfirmation {
  attempted: boolean;
  minutes: number | null;
  km: number | null;
  reason: RouteFailureReason | null;
  provider?: string;
  latencyMs?: number;
  basis?: 'static' | 'traffic_aware' | 'scheduled' | 'estimated';
  measuredAt?: string;
  staticMinutes?: number;
  effectiveDepartAt?: string;
  transitSummary?: string;
  /** The route's own real shape, when this confirmation succeeded and the provider's response carried one — see `RouteConfirmation.geometry`'s own header. Carried through the memo "for free": a second caller asking about the identical pair reuses it, never fetches it twice. */
  geometry?: readonly { lat: number; lng: number }[];
}

const NOT_ATTEMPTED: MandatoryLegConfirmation = { attempted: false, minutes: null, km: null, reason: null };

/**
 * ONE ENTRY PER DIRECTED PAIR THIS BUILD HAS ALREADY DIRECTLY CONFIRMED —
 * DELIBERATELY SEPARATE FROM THE LEDGER'S OWN (MATRIX-SOURCED) FAILURES.
 *
 * The matrix's own "no answer" for a pair is *why* `confirmMandatoryLeg`
 * gets called at all — checking the ledger's matrix-sourced failure map for
 * "already known" would find that very reason and skip confirming
 * anything, ever. This memo tracks only what a direct confirmation itself
 * already answered, so a second stage asking about the identical directed
 * pair reuses that answer instead of asking again, without that memoization
 * ever masking the matrix gap that made confirmation necessary in the
 * first place.
 */
export type ConfirmationMemo = Map<string, MandatoryLegConfirmation>;

function confirmationMemoKey(fromId: string, toId: string): string {
  return `${fromId}=>${toId}`;
}

/**
 * ONE BOUNDED, DIRECT POINT-TO-POINT ROUTE CONFIRMATION FOR A LEG A HARD
 * FEASIBILITY DECISION DEPENDS ON — NEVER THE PRIMARY ACQUISITION STRATEGY.
 *
 * A live Iceland validation proved the reason this exists: Valhalla's
 * `costmatrix` algorithm returned `not_found` for two legs a direct
 * `/route` request measured successfully seconds later, on the same
 * healthy instance. A sparse matrix is an optimization, not ground truth —
 * for the handful of legs that matter to a hard feasibility gate
 * (mandatory relocation, departure closure), a matrix gap of *any* kind
 * (an authoritative `not_found`, a degraded `provider_error`, or simply no
 * answer at all) earns exactly one direct confirmation before Sidequest
 * trusts it.
 *
 * Memoized against `memo` first (see its own header), never the ledger's
 * matrix-sourced failures — a pair this exact function already confirmed is
 * never asked about twice, whichever stage — relocation, departure closure —
 * asks second. A successful confirmation is still merged into the shared
 * `ledger` (so `measuredMinutes`/`buildBasePortfolioDates`/the final
 * `travelLegs` see it exactly like any other measured leg), directionally
 * only: `from -> to`, never mirrored onto `to -> from` — routes are not
 * assumed symmetric, matching every other leg this file has ever measured.
 */
export async function confirmMandatoryLeg(
  ledger: TravelLegLedger,
  memo: ConfirmationMemo,
  confirmRoute: SkeletonRouteConfirmationProvider,
  from: ResolvedBaseIdentity,
  to: ResolvedBaseIdentity,
): Promise<MandatoryLegConfirmation> {
  const key = confirmationMemoKey(from.id, to.id);
  const cached = memo.get(key);
  if (cached) return { ...cached, attempted: false }; // already asked once this build; reused, not re-asked

  let result: RouteConfirmation | null;
  try {
    result = await confirmRoute(from.coordinates, to.coordinates);
  } catch {
    result = null;
  }

  let outcome: MandatoryLegConfirmation;
  if (!result) {
    outcome = { attempted: true, minutes: null, km: null, reason: 'provider_error' };
  } else if (result.found) {
    mergeIntoLedger(ledger, {
      ids: [from.id, to.id],
      minutes: [
        [0, result.minutes ?? Number.NaN],
        [Number.NaN, 0],
      ],
      km: [
        [0, result.km ?? Number.NaN],
        [Number.NaN, 0],
      ],
    });
    outcome = {
      attempted: true,
      minutes: result.minutes,
      km: result.km,
      reason: null,
      provider: result.provider,
      latencyMs: result.latencyMs,
      ...(result.geometry ? { geometry: result.geometry } : {}),
      ...(result.basis ? { basis: result.basis } : {}),
      ...(result.measuredAt ? { measuredAt: result.measuredAt } : {}),
      ...(result.staticMinutes !== undefined ? { staticMinutes: result.staticMinutes } : {}),
      ...(result.effectiveDepartAt ? { effectiveDepartAt: result.effectiveDepartAt } : {}),
      ...(result.transitSummary ? { transitSummary: result.transitSummary } : {}),
    };
  } else {
    outcome = {
      attempted: true,
      minutes: null,
      km: null,
      reason: result.reason ?? 'provider_error',
      provider: result.provider,
      latencyMs: result.latencyMs,
    };
  }
  memo.set(key, outcome);
  return outcome;
}

/**
 * ACQUIRE ROUTE EVIDENCE FOR ONE SMALL, BOUNDED SET OF POINTS — MEMOIZED
 * AGAINST WHAT THE LEDGER (AND THE PRIMARY MATRIX) ALREADY KNOW.
 *
 * Skips the provider call entirely when every pair among these points is
 * already resolved one way or another — measured in the primary matrix,
 * measured in the ledger from an earlier call this same build, or already
 * recorded as a failure for that exact pair — so a day whose base and
 * anchors were already covered by an earlier call costs nothing. A provider
 * failure (the callback itself throwing) degrades to "nothing new learned",
 * never a crash — the same doctrine every other provider gap in this file
 * already follows.
 */
export async function acquireRoute(
  ledger: TravelLegLedger,
  routeMatrix: SkeletonRouteMatrixProvider,
  points: readonly { id: string; lat: number; lng: number }[],
  primaryMatrix: TravelTimeMatrix,
): Promise<void> {
  const deduped = points.filter((point, index, all) => all.findIndex((p) => p.id === point.id) === index);
  if (deduped.length < 2) return;
  const snapshot = ledgerSnapshot(ledger);
  const alreadyKnown = (a: string, b: string): boolean =>
    measuredMinutes(primaryMatrix, snapshot, a, b) !== null || ledgerFailureReason(ledger, a, b) !== null;
  const needsRequest = deduped.some((a, i) => deduped.some((b, j) => i < j && !alreadyKnown(a.id, b.id)));
  if (!needsRequest) return;
  try {
    const result = await routeMatrix(deduped);
    if (result) mergeIntoLedger(ledger, result);
  } catch {
    // A genuine provider failure with no result at all — the pairs stay
    // unresolved, exactly as if they had never been requested. The caller's
    // own routing_evidence_unavailable/base_unroutable classification (see
    // `planFromSkeleton`) already treats "no evidence" conservatively.
  }
}

export function hardCeilingFor(profile: TravelerProfile, matrix: TravelTimeMatrix): number {
  return matrix.mode === 'car' ? profile.transport.maxDailyDriveMinutes : profile.transport.maxDailyTransportMinutes;
}

/* ------------------------------------------------------------------ *
 * THE NEW STAGE: WHOLE-ROUTE RELOCATION FEASIBILITY
 * ------------------------------------------------------------------ */

/**
 * THE GENERIC FIX FOR THE FAILURE CLASS THE ICELAND SKELETON EXPOSED.
 *
 * `PlannerInput.basePortfolio` carries `transferMinutesFromPrevious` and
 * `planTrip()` *narrates* it ("Moving to X — about N minutes on the road")
 * but never validates it against anything — traced through `plan.ts`, the
 * only reads are display text and whether the transfer eats the whole day.
 * A relocation between two overnight bases genuinely may take longer than
 * an ordinary day's local movement — the traveller chose a moving trip, and
 * a relocation day is explicitly allowed to spend the whole day travelling
 * — but it must never exceed the traveller's own *explicit* hard ceiling
 * (`profile.transport.maxDailyDriveMinutes`/`maxDailyTransportMinutes`,
 * asked outright, unlike an ordinary day's more comfortable budget). This
 * runs before `planTrip()` for exactly that one check, on measured
 * evidence, generically — nothing here names a place, a region or a
 * country.
 *
 * TWO BOUNDED REMEDY TIERS, TRIED IN ORDER, NEITHER A SEARCH: a verified
 * intermediate base already on the Discovery Board (real, base-eligible,
 * reachable from both endpoints within the hard ceiling, roughly on the way
 * rather than a detour — its two legs must not together run more than 50%
 * over the straight two-endpoint distance), and, only when the board has
 * none, a corridor search (`relocation-corridor.ts`) that reverse-geocodes a
 * small, bounded set of points along the route to real settlements and
 * measures the same two-leg feasibility. The board tier existed first; the
 * corridor tier exists because a live Iceland run proved the board alone is
 * not always enough — its compiled region held zero base-relationship
 * places at all, an ingestion-time gap this function routes around rather
 * than tries to fix.
 *
 * A remedy that finds a geographically and time-feasible waypoint is only
 * accepted if a night can be legally borrowed for it from a neighbouring
 * base with one to spare — never by silently running the trip a night
 * longer, which the pre-corridor version of this function used to do. A
 * feasible-but-night-less candidate is reported (`verifiedAlternatives`),
 * not used.
 *
 * The whole route is inspected in one pass: an unresolved leg is *recorded*
 * and the loop continues to every remaining pair, rather than returning on
 * the first one, so a route with two consequential problems is never
 * reported as having only the first — the exact failure mode a prior
 * Iceland round hit ("discovered the second leg only on the next run").
 * Everything else item 5 of the routing-evidence round names — moving which
 * day performs the relocation, substituting a whole nearby region — is
 * still not attempted here; a route left with any unresolved leg after both
 * remedy tiers returns one typed `SkeletonRepairIssue` describing every
 * remaining problem together, never a knowingly impossible itinerary.
 */
export async function assessRelocationFeasibility(input: {
  orderedBases: readonly ResolvedBase[];
  matrix: TravelTimeMatrix;
  profile: TravelerProfile;
  candidates: readonly DiscoveryCandidate[];
  archetype: TripArchetype;
  /** A small, on-demand routed sub-matrix over resolved bases — see `SkeletonPlanningContext.routeMatrix`. */
  extraMatrix?: RouteMatrixResult | null;
  /**
   * Whether a genuine on-demand routing attempt actually covered these
   * bases this build (Phase A — see `planFromSkeleton`) — distinct from
   * `extraMatrix` merely being non-null, which can be true from an
   * unrelated day's anchor acquisition even when the bases themselves were
   * never asked about. `false` (the default) preserves the exact
   * pre-existing behaviour: an unmeasured leg is not a claim of anything.
   */
  routeAttempted?: boolean;
  /**
   * The live ledger (not a frozen snapshot) — required, alongside
   * `confirmRoute`, for a mandatory leg the matrix could not answer to earn
   * one direct confirmation (see `confirmMandatoryLeg`). Absent, this
   * function degrades to its exact pre-existing behaviour: a matrix gap on
   * a mandatory leg is classified from the matrix's own answer alone.
   */
  ledger?: TravelLegLedger;
  confirmRoute?: SkeletonRouteConfirmationProvider;
  /** Shared across relocation and departure-closure calls this build — see `confirmMandatoryLeg`'s own header on why this is separate from `ledger`. */
  confirmationMemo?: ConfirmationMemo;
  /**
   * Bounded near-corridor settlement search for the corridor remedy tier —
   * see `relocation-corridor.ts`. Absent, this function degrades to exactly
   * its pre-corridor behaviour: the board tier alone, an unresolved leg
   * returns a typed issue.
   */
  findNearbyLocalities?: SkeletonCorridorLocalitySearch;
  /**
   * TOLERANT MODE — THE CANONICAL RECONCILER'S POSTURE (`reconcile.ts`).
   *
   * `unknown != false`: a mandatory leg nobody could measure, or one the
   * router answered "no route" for, is recorded as an `UnresolvedRelocation`
   * and the pass continues, rather than returning a typed repair issue that
   * would withhold the whole trip. A measured leg over the ceiling that no
   * remedy tier resolved is recorded the same way — the traveller decides,
   * with the itinerary in front of them. The default (`false`) is the exact
   * pre-existing behaviour every earlier caller and test relies on.
   */
  tolerant?: boolean;
}): Promise<{
  ok: true;
  orderedBases: readonly ResolvedBase[];
  deviations: readonly SkeletonDeviation[];
  /** Only ever non-empty in tolerant mode. */
  unresolved: readonly UnresolvedRelocation[];
} | {
  ok: false;
  repairIssue: SkeletonRepairIssue;
}> {
  const { matrix, profile, candidates } = input;
  let extra = input.extraMatrix ?? null;
  const tolerant = input.tolerant ?? false;
  const tolerated: UnresolvedRelocation[] = [];
  const routeAttempted = input.routeAttempted ?? false;
  const ceiling = hardCeilingFor(profile, matrix);
  const deviations: SkeletonDeviation[] = [];
  const bases = [...input.orderedBases];
  /**
   * Hoisted once, not re-derived at each `confirmMandatoryLeg` call site —
   * this function now calls it up to twice for the same pair within one
   * iteration (the leg's own confirmation, then a possible geometry-only
   * confirmation for the corridor remedy tier below). Re-evaluating
   * `input.confirmationMemo ?? new Map()` at each call site would hand the
   * second call a fresh, empty map whenever no memo was supplied at all,
   * defeating memoization between the two calls specifically — a real
   * regression this hoist prevents, not a style preference.
   */
  const confirmationMemo: ConfirmationMemo = input.confirmationMemo ?? new Map();
  /**
   * Every mandatory leg that neither remedy tier could resolve, collected
   * across the whole route rather than returned on the first — see this
   * function's own header. Each entry carries the same `RelocationEvidence`
   * a single-issue return always has; `finalizeUnresolved` below folds them
   * into the one `SkeletonRepairIssue` this function still returns.
   */
  const unresolvedLegs: {
    from: ResolvedBase;
    to: ResolvedBase;
    detail: string;
    evidence: RelocationEvidence;
    alternatives: readonly { placeId: string; name: string; reason: string }[];
  }[] = [];

  for (let i = 0; i < bases.length - 1; i += 1) {
    const from = bases[i]!;
    const to = bases[i + 1]!;
    if (!from.identity || !to.identity) continue; // surfaced separately as `base_unresolved`
    if (from.identity.id === to.identity.id) continue; // same physical place — no relocation at all

    let minutes = measuredMinutes(matrix, extra, from.identity.id, to.identity.id);
    let matrixOutcome: NonNullable<RelocationEvidence['matrixOutcome']> =
      minutes !== null ? 'measured' : routeAttempted ? 'unavailable' : 'not_attempted';
    let matrixReason: RouteFailureReason | null = null;
    let confirmation: MandatoryLegConfirmation = NOT_ATTEMPTED;

    if (minutes === null && routeAttempted) {
      matrixReason = failureReasonIn(extra, from.identity.id, to.identity.id);
      if (matrixReason === AUTHORITATIVE_NO_ROUTE) matrixOutcome = 'authoritative_no_route';

      // The one bounded direct confirmation this leg earns — a matrix gap
      // is never trusted alone for a mandatory relocation leg. See
      // `confirmMandatoryLeg`'s own header for why.
      if (input.ledger && input.confirmRoute) {
        confirmation = await confirmMandatoryLeg(
          input.ledger,
          confirmationMemo,
          input.confirmRoute,
          from.identity,
          to.identity,
        );
        extra = ledgerSnapshot(input.ledger); // refreshed so the remedy search below sees it too
        if (confirmation.minutes !== null) {
          minutes = confirmation.minutes;
          if (confirmation.attempted) {
            deviations.push({
              kind: 'relocation_confirmed_via_direct_route',
              detail:
                `${from.identity.name} → ${to.identity.name}: the matrix ${
                  matrixOutcome === 'authoritative_no_route' ? 'reported no route for this pair' : 'had no trustworthy measurement'
                }; a direct route confirmation measured ${confirmation.minutes} min${confirmation.km !== null ? ` / ${confirmation.km} km` : ''}.`,
            });
          }
        }
      }
    }

    if (minutes === null) {
      // Never asked about at all (routing not configured, or this base
      // pair was never part of a genuine attempt) — the pre-existing,
      // honest "unmeasured is not a claim of infeasibility" degrade,
      // unchanged.
      if (!routeAttempted) continue;

      const finalReason = confirmation.attempted ? confirmation.reason : matrixReason;
      const relocationEvidence: RelocationEvidence = {
        fromBaseId: from.skeletonBaseId,
        toBaseId: to.skeletonBaseId,
        fromPlaceId: from.identity.id,
        toPlaceId: to.identity.id,
        measuredMinutes: null,
        hardCeilingMinutes: ceiling,
        matrixMode: matrix.mode,
        matrixOutcome,
        ...(matrixReason ? { matrixFailureReason: matrixReason } : {}),
        confirmationAttempted: confirmation.attempted,
        ...(confirmation.provider ? { confirmationProvider: confirmation.provider } : {}),
        confirmationMinutes: confirmation.minutes,
        confirmationKm: confirmation.km,
        ...(confirmation.latencyMs !== undefined ? { confirmationLatencyMs: confirmation.latencyMs } : {}),
        finalEvidenceClassification: finalReason === AUTHORITATIVE_NO_ROUTE ? 'authoritative_no_route' : 'evidence_unavailable',
      };
      const lockedDecisions = {
        baseIds: input.orderedBases.map((b) => b.skeletonBaseId).filter((id) => id !== from.skeletonBaseId && id !== to.skeletonBaseId),
        dayNumbers: [],
      };

      if (tolerant) {
        tolerated.push({
          kind: finalReason === AUTHORITATIVE_NO_ROUTE ? 'no_road_route' : 'unmeasured',
          fromBaseId: from.skeletonBaseId,
          toBaseId: to.skeletonBaseId,
          fromName: from.identity.name,
          toName: to.identity.name,
          detail:
            finalReason === AUTHORITATIVE_NO_ROUTE
              ? `${from.identity.name} → ${to.identity.name}: the routing provider answered that no road route reaches here — this transfer may need a ferry, a flight or a local arrangement; verify before travelling.`
              : `${from.identity.name} → ${to.identity.name}: no trustworthy travel time could be measured (${finalReason ?? 'no reason given'}) — not evidence the route is impossible, only that it is not known yet.`,
          evidence: relocationEvidence,
        });
        continue;
      }
      if (finalReason === AUTHORITATIVE_NO_ROUTE) {
        return {
          ok: false,
          repairIssue: {
            kind: 'base_unroutable',
            detail: confirmation.attempted
              ? `${from.identity.name} → ${to.identity.name}: the matrix could not answer, and a direct route confirmation to the same real routing provider reported no viable route — not a timeout, a real answer.`
              : `${from.identity.name} → ${to.identity.name}: the routing provider evaluated this leg and reported no viable route — not a timeout or a degraded attempt, a real answer.`,
            affectedDayNumbers: [],
            affectedBaseIds: [from.skeletonBaseId, to.skeletonBaseId],
            relocationEvidence,
            verifiedAlternatives: [],
            lockedDecisions,
          },
        };
      }
      return {
        ok: false,
        repairIssue: {
          kind: 'routing_evidence_unavailable',
          detail: confirmation.attempted
            ? `${from.identity.name} → ${to.identity.name}: neither the matrix nor a direct route confirmation produced a trustworthy measurement (${finalReason ?? 'no reason given'}) — not evidence the route is impossible, only that it isn't known yet.`
            : matrixReason
              ? `${from.identity.name} → ${to.identity.name} could not be measured (${matrixReason}) — a fact about this attempt, not about whether the route exists.`
              : `${from.identity.name} → ${to.identity.name} was part of a genuine routing attempt, but no trustworthy measurement came back for this leg — not evidence the route is impossible, only that it isn't known yet.`,
          affectedDayNumbers: [],
          affectedBaseIds: [from.skeletonBaseId, to.skeletonBaseId],
          relocationEvidence,
          verifiedAlternatives: [],
          lockedDecisions,
        },
      };
    }

    if (minutes <= ceiling) continue; // measured (matrix or direct confirmation), within the traveller's own limit

    // --- Remedy tier 1: a verified intermediate base already on the board ---
    const directKm = haversineKm(from.identity.coordinates, to.identity.coordinates);
    let bestIntermediate: { place: Place; legOneMinutes: number; legTwoMinutes: number } | null = null;
    for (const candidate of candidates) {
      const place = candidate.place;
      if (place.relationship !== 'base') continue;
      if (place.id === from.identity.id || place.id === to.identity.id) continue;
      const legOne = measuredMinutes(matrix, extra, from.identity.id, place.id);
      const legTwo = measuredMinutes(matrix, extra, place.id, to.identity.id);
      if (legOne === null || legTwo === null) continue;
      if (legOne > ceiling || legTwo > ceiling) continue;
      const viaKm = haversineKm(from.identity.coordinates, place.coordinates) + haversineKm(place.coordinates, to.identity.coordinates);
      if (directKm > 0 && viaKm > directKm * 1.5) continue; // a detour, not a waypoint
      if (!bestIntermediate || legOne + legTwo < bestIntermediate.legOneMinutes + bestIntermediate.legTwoMinutes) {
        bestIntermediate = { place, legOneMinutes: legOne, legTwoMinutes: legTwo };
      }
    }

    /**
     * The waypoint's one night has to come from somewhere — the total must
     * still equal the trip's own length. Borrowed from whichever neighbour
     * has a spare night, preferring the arrival base (the night saved is,
     * in effect, the first night there). `null` when neither has one to
     * spare — a real constraint, not a detail to route around: the caller
     * below refuses the remedy rather than silently running the trip a
     * night longer.
     */
    const nightDonorFor = (): ResolvedBase | null => (to.nights > 1 ? to : from.nights > 1 ? from : null);

    if (bestIntermediate) {
      const donor = nightDonorFor();
      if (donor) {
        donor.nights -= 1;
        deviations.push({
          kind: 'relocation_resolved_with_intermediate_base',
          detail:
            `${from.identity.name} → ${to.identity.name} measured ${minutes} min, past the ${ceiling}-minute hard limit; ` +
            `inserted ${displayNameOf(bestIntermediate.place)} as an intermediate base (${bestIntermediate.legOneMinutes} + ${bestIntermediate.legTwoMinutes} min, both within limit), its one night drawn from ${donor.identity!.name} (${donor.nights + 1} → ${donor.nights}).`,
          replacementPlaceId: bestIntermediate.place.id,
        });
        bases.splice(i + 1, 0, {
          skeletonBaseId: `${from.skeletonBaseId}-to-${to.skeletonBaseId}-waypoint`,
          name: displayNameOf(bestIntermediate.place),
          nights: 1,
          identity: identityFromPlace(bestIntermediate.place),
        });
        continue;
      }
      // A feasible waypoint exists, but no night can be legally reallocated
      // for it — reported below as a verified alternative, never used
      // unasked; this leg still counts as unresolved.
    }

    // --- Remedy tier 2: a real settlement found along the route corridor,
    // --- tried only when the board had nothing (`relocation-corridor.ts`) --
    let corridorCandidate: CorridorCandidate | null = null;
    if (!bestIntermediate && input.findNearbyLocalities && input.confirmRoute) {
      const excludeSourceIds = new Set(bases.map((b) => b.identity?.id).filter((id): id is string => id !== undefined && id !== null));
      const confirmRoute = input.confirmRoute;
      const findNearbyLocalities = input.findNearbyLocalities;

      /**
       * REAL ROUTE GEOMETRY FOR THIS ONE OVER-CEILING LEG — ACQUIRED ONLY
       * HERE, ONLY NOW THAT THE CORRIDOR TIER IS ACTUALLY ABOUT TO RUN.
       *
       * Sampling along the straight chord between two bases can land tens
       * of kilometres from the real, curved drivable road (a live Iceland
       * finding: Höfn→Akureyri's real route curves along the coast around
       * genuinely uninhabited highlands the chord cuts straight through).
       * Reuses `confirmMandatoryLeg`'s own memoization (`confirmationMemo`,
       * hoisted above) rather than a second cache: when the matrix could
       * not measure this leg, its own confirmation earlier in this same
       * iteration already asked the provider and — for free, in the same
       * response — may already carry geometry, so this call is a memo hit,
       * not a second request. When the matrix measured this leg directly
       * (the common case for an over-ceiling leg), no confirmation has
       * happened yet for this pair, and this is the one, bounded,
       * genuinely new request this leg's remediation attempt costs —
       * exactly the "even when the matrix already measured the duration"
       * case this exists for. A provider failure here (thrown, or
       * `found: false`) degrades to no geometry, never to a claim about
       * the leg's own feasibility — that classification was already made
       * above, from the matrix/mandatory-leg confirmation, and is
       * untouched by whether this *extra* geometry request succeeds.
       */
      let routeGeometry: readonly { lat: number; lng: number }[] | undefined;
      if (input.ledger) {
        const geometryConfirmation = await confirmMandatoryLeg(
          input.ledger,
          confirmationMemo,
          confirmRoute,
          from.identity,
          to.identity,
        );
        routeGeometry = geometryConfirmation.geometry;
      }

      const found = await findCorridorRemedyCandidates({
        from: from.identity.coordinates,
        to: to.identity.coordinates,
        ceilingMinutes: ceiling,
        directMinutes: minutes,
        excludeSourceIds,
        isLocalityCandidate,
        ...(routeGeometry ? { routeGeometry } : {}),
        findNearbyLocalities: (point, radiusKm) => findNearbyLocalities(point, radiusKm),
        confirmRoute: async (a, b) => {
          const result = await confirmRoute(a, b);
          return result ? { found: result.found, minutes: result.minutes, km: result.km } : null;
        },
      });
      corridorCandidate = found[0] ?? null;
    }

    if (corridorCandidate) {
      const donor = nightDonorFor();
      if (donor) {
        donor.nights -= 1;
        const locality = corridorCandidate.locality;
        const samplingNote =
          corridorCandidate.foundVia === 'route_geometry'
            ? 'found via a route-following corridor search'
            : 'found via a straight-line corridor search (real route geometry was unavailable for this leg)';
        deviations.push({
          kind: 'relocation_resolved_with_corridor_locality',
          detail:
            `${from.identity.name} → ${to.identity.name} measured ${minutes} min, past the ${ceiling}-minute hard limit; ` +
            `a real-settlement corridor search ${samplingNote} ${locality.name} as an intermediate base (${corridorCandidate.legOneMinutes} + ${corridorCandidate.legTwoMinutes} min, both within limit), its one night drawn from ${donor.identity!.name} (${donor.nights + 1} → ${donor.nights}).`,
          replacementPlaceId: locality.sourceId,
        });
        bases.splice(i + 1, 0, {
          skeletonBaseId: `${from.skeletonBaseId}-to-${to.skeletonBaseId}-waypoint`,
          name: locality.name,
          nights: 1,
          identity: { id: locality.sourceId, name: locality.name, coordinates: { lat: locality.lat, lng: locality.lng } },
        });
        continue;
      }
    }

    // Neither remedy tier resolved this leg — recorded, not returned yet,
    // so the rest of the route is still inspected in this same pass.
    const boardAlternatives = candidates
      .filter((c) => c.place.relationship === 'base')
      .map((c) => ({
        place: c.place,
        legOne: measuredMinutes(matrix, extra, from.identity!.id, c.place.id),
        legTwo: measuredMinutes(matrix, extra, c.place.id, to.identity!.id),
      }))
      .filter((c) => c.legOne !== null || c.legTwo !== null)
      .slice(0, 3)
      .map((c) => ({
        placeId: c.place.id,
        name: displayNameOf(c.place),
        reason:
          c.legOne !== null && c.legOne <= ceiling
            ? `${c.legOne} min from ${from.identity!.name}, within the limit — but no feasible second leg was found from here to ${to.identity!.name}.`
            : `Measured but did not resolve the conflict on its own.`,
      }));
    const nightlessAlternative =
      bestIntermediate && !nightDonorFor()
        ? [
            {
              placeId: bestIntermediate.place.id,
              name: displayNameOf(bestIntermediate.place),
              reason: `${bestIntermediate.legOneMinutes} + ${bestIntermediate.legTwoMinutes} min, both within limit — but neither neighbouring base has a spare night to lend it, and the trip's total nights cannot silently grow.`,
            },
          ]
        : [];
    const corridorAlternatives = corridorCandidate
      ? [
          {
            placeId: corridorCandidate.locality.sourceId,
            name: corridorCandidate.locality.name,
            reason: `${corridorCandidate.legOneMinutes} + ${corridorCandidate.legTwoMinutes} min, both within limit, found via route-corridor search — but neither neighbouring base has a spare night to lend it, and the trip's total nights cannot silently grow.`,
          },
        ]
      : [];

    unresolvedLegs.push({
      from,
      to,
      detail: `${from.identity.name} → ${to.identity.name} measures ${minutes} minute(s), past the traveller's stated ${ceiling}-minute daily ${matrix.mode === 'car' ? 'driving' : 'travel'} limit, and no verified intermediate base resolves it.`,
      evidence: {
        fromBaseId: from.skeletonBaseId,
        toBaseId: to.skeletonBaseId,
        fromPlaceId: from.identity.id,
        toPlaceId: to.identity.id,
        measuredMinutes: minutes,
        hardCeilingMinutes: ceiling,
        matrixMode: matrix.mode,
        matrixOutcome: confirmation.attempted && confirmation.minutes !== null ? matrixOutcome : 'measured',
        confirmationAttempted: confirmation.attempted,
        ...(confirmation.provider ? { confirmationProvider: confirmation.provider } : {}),
        ...(confirmation.attempted ? { confirmationMinutes: confirmation.minutes, confirmationKm: confirmation.km } : {}),
        finalEvidenceClassification: confirmation.attempted && confirmation.minutes !== null ? 'direct_route_confirmed' : 'matrix_measured',
      },
      alternatives: [...nightlessAlternative, ...corridorAlternatives, ...boardAlternatives],
    });
  }

  if (tolerant) {
    for (const leg of unresolvedLegs) {
      tolerated.push({
        kind: 'over_ceiling',
        fromBaseId: leg.from.skeletonBaseId,
        toBaseId: leg.to.skeletonBaseId,
        fromName: leg.from.identity!.name,
        toName: leg.to.identity!.name,
        detail: leg.detail,
        evidence: leg.evidence,
        alternatives: leg.alternatives,
      });
    }
    return { ok: true, orderedBases: bases, deviations, unresolved: tolerated };
  }

  if (unresolvedLegs.length > 0) {
    const [first, ...rest] = unresolvedLegs;
    const touchedBaseIds = new Set(unresolvedLegs.flatMap((leg) => [leg.from.skeletonBaseId, leg.to.skeletonBaseId]));
    return {
      ok: false,
      repairIssue: {
        kind: 'relocation_infeasible',
        detail:
          unresolvedLegs.length === 1
            ? first!.detail
            : `${unresolvedLegs.length} mandatory relocations remain past the traveller's hard limit, none resolved by a verified intermediate base: ${unresolvedLegs
                .map((leg) => leg.detail)
                .join(' ')}`,
        affectedDayNumbers: [],
        affectedBaseIds: [...touchedBaseIds],
        relocationEvidence: first!.evidence,
        ...(rest.length > 0 ? { additionalRelocationEvidence: rest.map((leg) => leg.evidence) } : {}),
        verifiedAlternatives: unresolvedLegs.flatMap((leg) => leg.alternatives),
        lockedDecisions: {
          baseIds: input.orderedBases.map((b) => b.skeletonBaseId).filter((id) => !touchedBaseIds.has(id)),
          dayNumbers: [],
        },
      },
    };
  }

  return { ok: true, orderedBases: bases, deviations, unresolved: [] };
}

/**
 * A mandatory relocation the tolerant pass could not settle — kept in the
 * trip as an honest, visible problem rather than a reason to withhold it.
 */
export interface UnresolvedRelocation {
  kind: 'unmeasured' | 'no_road_route' | 'over_ceiling';
  fromBaseId: string;
  toBaseId: string;
  fromName: string;
  toName: string;
  detail: string;
  evidence: RelocationEvidence;
  alternatives?: readonly { placeId: string; name: string; reason: string }[];
}

/* ------------------------------------------------------------------ *
 * Departure closure — the same doctrine as `hydrate.ts`'s, against real evidence
 * ------------------------------------------------------------------ */

export async function assessDepartureClosure(
  orderedBases: readonly ResolvedBase[],
  matrix: TravelTimeMatrix,
  profile: TravelerProfile,
  extraMatrix: RouteMatrixResult | null,
  routeAttempted: boolean,
  ledger?: TravelLegLedger,
  confirmRoute?: SkeletonRouteConfirmationProvider,
  confirmationMemo?: ConfirmationMemo,
): Promise<{
  ok: boolean;
  detail: string;
  kind: 'departure_unreachable' | 'routing_evidence_unavailable' | 'base_unroutable' | null;
  relocationEvidence?: RelocationEvidence;
  deviation?: SkeletonDeviation;
}> {
  const first = orderedBases[0];
  const last = orderedBases[orderedBases.length - 1];
  if (!first?.identity || !last?.identity) {
    return { ok: true, detail: 'A base did not resolve to a real place; departure closure was not checked.', kind: null };
  }
  if (first.identity.id === last.identity.id) {
    return { ok: true, detail: 'The trip ends at the same base it started from.', kind: null };
  }
  const ceiling = hardCeilingFor(profile, matrix);
  let minutes = measuredMinutes(matrix, extraMatrix, last.identity.id, first.identity.id);
  let matrixOutcome: NonNullable<RelocationEvidence['matrixOutcome']> =
    minutes !== null ? 'measured' : routeAttempted ? 'unavailable' : 'not_attempted';
  let matrixReason: RouteFailureReason | null = null;
  let confirmation: MandatoryLegConfirmation = NOT_ATTEMPTED;
  let deviation: SkeletonDeviation | undefined;

  if (minutes === null && routeAttempted) {
    matrixReason = failureReasonIn(extraMatrix, last.identity.id, first.identity.id);
    if (matrixReason === AUTHORITATIVE_NO_ROUTE) matrixOutcome = 'authoritative_no_route';

    if (ledger && confirmRoute) {
      confirmation = await confirmMandatoryLeg(ledger, confirmationMemo ?? new Map(), confirmRoute, last.identity, first.identity);
      if (confirmation.minutes !== null) {
        minutes = confirmation.minutes;
        if (confirmation.attempted) {
          deviation = {
            kind: 'relocation_confirmed_via_direct_route',
            detail:
              `${last.identity.name} → ${first.identity.name} (departure closure): the matrix ${
                matrixOutcome === 'authoritative_no_route' ? 'reported no route for this pair' : 'had no trustworthy measurement'
              }; a direct route confirmation measured ${confirmation.minutes} min${confirmation.km !== null ? ` / ${confirmation.km} km` : ''}.`,
          };
        }
      }
    }
  }

  const relocationEvidenceFor = (finalClassification: RelocationEvidence['finalEvidenceClassification']): RelocationEvidence => ({
    fromBaseId: last.skeletonBaseId,
    toBaseId: first.skeletonBaseId,
    fromPlaceId: last.identity!.id,
    toPlaceId: first.identity!.id,
    measuredMinutes: minutes,
    hardCeilingMinutes: ceiling,
    matrixMode: matrix.mode,
    matrixOutcome,
    ...(matrixReason ? { matrixFailureReason: matrixReason } : {}),
    confirmationAttempted: confirmation.attempted,
    ...(confirmation.provider ? { confirmationProvider: confirmation.provider } : {}),
    ...(confirmation.attempted ? { confirmationMinutes: confirmation.minutes, confirmationKm: confirmation.km } : {}),
    finalEvidenceClassification: finalClassification,
  });

  if (minutes === null) {
    if (routeAttempted) {
      const finalReason = confirmation.attempted ? confirmation.reason : matrixReason;
      if (finalReason !== null && finalReason !== AUTHORITATIVE_NO_ROUTE) {
        return {
          ok: false,
          detail: confirmation.attempted
            ? `The closing leg from ${last.identity.name} back to ${first.identity.name}: neither the matrix nor a direct route confirmation produced a trustworthy measurement (${finalReason}) — not evidence the route is impossible, only that it isn't known yet.`
            : `The closing leg from ${last.identity.name} back to ${first.identity.name} could not be measured (${finalReason}) — a fact about this attempt, not about whether the route exists.`,
          kind: 'routing_evidence_unavailable',
          relocationEvidence: relocationEvidenceFor('evidence_unavailable'),
        };
      }
      if (finalReason === AUTHORITATIVE_NO_ROUTE) {
        return {
          ok: false,
          detail: confirmation.attempted
            ? `The closing leg from ${last.identity.name} back to ${first.identity.name}: the matrix could not answer, and a direct route confirmation to the same real routing provider reported no viable route.`
            : `The routing provider evaluated the closing leg from ${last.identity.name} back to ${first.identity.name} and reported no viable route.`,
          kind: 'base_unroutable',
          relocationEvidence: relocationEvidenceFor('authoritative_no_route'),
        };
      }
    }
    return { ok: true, detail: 'No measured leg exists between the final base and the start; departure closure could not be checked against real evidence.', kind: null };
  }
  if (minutes <= ceiling) {
    return {
      ok: true,
      detail: `The final base is ${minutes} minute(s) from where the trip began — within the traveller's own limit.`,
      kind: null,
      deviation,
    };
  }
  return {
    ok: false,
    detail: `The final base is ${minutes} minute(s) from where the trip began, past the traveller's own ${ceiling}-minute limit — the route may not close in time for departure.`,
    kind: 'departure_unreachable',
    relocationEvidence: relocationEvidenceFor(confirmation.attempted ? 'direct_route_confirmed' : 'matrix_measured'),
  };
}

/**
 * REAL CALENDAR DATES, NOT PLACEHOLDERS.
 *
 * `basePortfolio` is authoritative about which base a given *date* belongs
 * to (`plan.ts` reads `base.fromDate === date` directly) — an empty string
 * would make that comparison never match anything, silently disabling the
 * whole mechanism this adapter exists to drive. Dates are assigned
 * cumulatively from each resolved base's own night count against the
 * trip's real date range, so a night borrowed for an inserted waypoint (see
 * `assessRelocationFeasibility`) is reflected here automatically — the
 * count, not a separate calendar, is the one thing this function reads.
 */
export function buildBasePortfolioDates(
  bases: readonly (ResolvedBase & { identity: ResolvedBaseIdentity })[],
  basics: TripBasics,
  matrix: TravelTimeMatrix,
  profile: TravelerProfile,
  extraMatrix: RouteMatrixResult | null,
): NonNullable<PlannerInput['basePortfolio']>['bases'] {
  const dates = tripDates(basics.startDate, basics.endDate);
  const lastIndex = Math.max(0, dates.length - 1);
  const ceiling = hardCeilingFor(profile, matrix);
  /*
   * Consecutive bases *share* their transition date, on purpose: a base's
   * `toDate` is the day you leave it, which is the next base's `fromDate` —
   * the same day `transferMinutesFromPrevious`/`transferIsWholeDay` are
   * keyed to (`plan.ts` reads `base.fromDate === date` to identify the
   * arriving base on a relocation day). Nights, not calendar days, are the
   * one thing summed here, so a night borrowed for an inserted waypoint
   * (see `assessRelocationFeasibility`) is reflected without this function
   * knowing why.
   */
  let cumulativeNights = 0;
  return bases.map((base, index) => {
    const previous = bases[index - 1];
    const fromIndex = Math.min(cumulativeNights, lastIndex);
    cumulativeNights += base.nights;
    const toIndex = Math.min(cumulativeNights, lastIndex);
    const transferMinutesFromPrevious = previous ? measuredMinutes(matrix, extraMatrix, previous.identity.id, base.identity.id) ?? 0 : 0;
    return {
      baseId: base.identity.id,
      baseName: base.identity.name,
      order: index,
      fromDate: dates[fromIndex] ?? basics.startDate,
      toDate: dates[toIndex] ?? basics.endDate,
      transferMinutesFromPrevious,
      transferIsWholeDay: transferMinutesFromPrevious > ceiling * 0.5,
    };
  });
}

/* ------------------------------------------------------------------ *
 * DRAFT ANCHOR -> SCHEDULE BRIDGE
 *
 * The comprehensive fix to the "resolves but still cannot schedule"
 * blocker: a `RetainedAnchor` (`partially_verified`/`unverified` — no board
 * `DiscoveryCandidate` exists for it, by design, per that type's own header)
 * is inserted here directly into its day's own `items`, using only what is
 * genuinely known — real day-local routing where identity allows it, the
 * model's own estimated duration honestly labelled where nothing better
 * exists, `unknown != false` for hours/access. This is deliberately a small,
 * purpose-built bridge, not a second copy of `packages/planner/src/schedule.ts`'s
 * scoring/ordering pipeline — see `RetainedAnchor`'s own header on why
 * fabricating a `DiscoveryCandidate` was rejected instead.
 * ------------------------------------------------------------------ */

/** Used only when the model gave no `estimatedDurationMinutes` at all — never presented as more than a placeholder. */
const DEFAULT_RETAINED_ANCHOR_DURATION_MINUTES = 60;
/** Mirrors `PlannerConfig.minFreeTimeBlockMinutes`'s own default (`packages/planner/src/types.ts`) — below this, a remaining gap is not worth naming as its own block. */
const MIN_FREE_TIME_BLOCK_MINUTES = 30;

interface TimeGap {
  start: number;
  end: number;
}

/** Every stretch of a day's window not already occupied by a non-free-time item — `free_time` blocks are fungible and re-split around whatever is inserted. */
function computeGaps(items: readonly ItineraryItem[], window: { startMinute: number; endMinute: number }): TimeGap[] {
  const occupied = items
    .filter((item) => item.kind !== 'free_time')
    .map((item) => ({ start: item.startMinute, end: item.endMinute }))
    .sort((a, b) => a.start - b.start);
  const gaps: TimeGap[] = [];
  let cursor = window.startMinute;
  for (const block of occupied) {
    if (block.start > cursor) gaps.push({ start: cursor, end: Math.min(block.start, window.endMinute) });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < window.endMinute) gaps.push({ start: cursor, end: window.endMinute });
  return gaps.filter((g) => g.end > g.start);
}

/** First-fit: the earliest gap with room, so a day fills front-to-back rather than by any notion of "best" slot this bridge has no evidence to judge. Mutates `gaps` in place so repeated calls for the same day never double-claim a minute. */
function claimGap(gaps: TimeGap[], neededMinutes: number): TimeGap | null {
  const index = gaps.findIndex((g) => g.end - g.start >= neededMinutes);
  if (index < 0) return null;
  const gap = gaps[index]!;
  const claimed = { start: gap.start, end: gap.start + neededMinutes };
  const remainder = { start: claimed.end, end: gap.end };
  const replacement = remainder.end > remainder.start ? [remainder] : [];
  gaps.splice(index, 1, ...replacement);
  return claimed;
}

/** `measuredMinutes`'s own lookup, widened to return `km` alongside — kept separate rather than changed in place, since `measuredMinutes` has other, unrelated callers this bridge must not affect. */
export function measuredLeg(matrix: TravelTimeMatrix, extra: RouteMatrixResult | null, fromId: string, toId: string): { minutes: number; km: number } | null {
  if (extra) {
    const fromIndex = extra.ids.indexOf(fromId);
    const toIndex = extra.ids.indexOf(toId);
    if (fromIndex >= 0 && toIndex >= 0) {
      const minutes = extra.minutes[fromIndex]?.[toIndex];
      if (typeof minutes === 'number' && Number.isFinite(minutes)) {
        const km = extra.km[fromIndex]?.[toIndex];
        return { minutes, km: typeof km === 'number' && Number.isFinite(km) ? km : 0 };
      }
    }
  }
  return tryLeg(matrix, fromId, toId);
}

/** `TravelTimeMatrix.mode` is one of three; `travelSegmentSchema.mode` is the richer nine-value transport vocabulary. `transit` has no single honest member of that set, so it is labelled `public_bus` — a stated best-effort reading of a matrix mode, not a claim about a specific verified service. */
function matrixModeToTransportMode(mode: TravelTimeMatrix['mode']): TransportMode {
  if (mode === 'car') return 'drive';
  if (mode === 'foot') return 'walk';
  return 'public_bus';
}

/**
 * The delta this bridge's own insertion makes to a day's totals — never a
 * full recomputation from every item, which would have to rediscover
 * bucketing rules (wait-role legs, unsupported modes, unmeasured-leg
 * accounting) `scheduleUnits()` already gets right for the board-sourced
 * content this bridge does not touch. Starting from the value `planTrip()`
 * already computed and adding only what this bridge itself contributed
 * keeps that already-correct accounting intact.
 *
 * The inserted block's travel and visit time are counted together as one
 * `activityMinutes` addition — the traveller sees it as a single card, not
 * a travel leg plus a separate stop — so this never double-books the same
 * wall-clock minutes into both `activityMinutes` and `travelMinutes`.
 */
function applyRetainedAnchorsToTotals(totals: ItineraryDay['totals'], addedMinutes: number, addedKm: number): ItineraryDay['totals'] {
  return {
    ...totals,
    activityMinutes: totals.activityMinutes + addedMinutes,
    freeMinutes: Math.max(0, totals.freeMinutes - addedMinutes),
    travelKm: totals.travelKm + addedKm,
  };
}

function unscheduledEntryForRetainedAnchor(
  anchor: RetainedAnchor,
  why: string,
  reasonCode: UnscheduledReasonCode = 'model_proposal_unintegrated',
): UnscheduledPlace {
  return {
    placeId: anchor.identity?.id ?? `model-proposal:day${anchor.dayNumber}:${normalizeName(anchor.name)}`,
    name: anchor.name,
    wasManual: false,
    reasonCode,
    reason: `Your plan proposed this for day ${anchor.dayNumber}${anchor.locality ? ` (near ${anchor.locality})` : ''}. ${why} ${anchor.why}`,
    suggestedRemedy:
      reasonCode === 'no_time_left'
        ? 'Consider a lighter pace for this trip, or move something else to make room.'
        : anchor.state === 'partially_verified'
          ? 'Search for it on the Discovery Board to add full details and improve its odds of fitting.'
          : 'Double-check the name and location — search for it on the Discovery Board if it is real and you want it scheduled.',
  };
}

/**
 * THE BRIDGE ITSELF — EVERY RETAINED ANCHOR ENDS IN ONE EXPLICIT DISPOSITION.
 *
 * For each day with retained anchors: acquire exactly the day-local routing
 * evidence those anchors need (one `acquireRoute` call per day, over that
 * day's own base plus its own retained anchors with resolved identity —
 * never a global matrix, never routed against unrelated days' content),
 * then place each anchor, primary role first, into the day's own free time
 * using first-fit — real measured travel when the ledger has it, an honest
 * "not measured" when it does not, the model's own duration estimate when
 * nothing better exists. An anchor that does not fit is never dropped
 * either: it rides onto `itinerary.unscheduled` with a genuine
 * capacity-based reason, which is a different, honest claim from "we could
 * not verify it" — see `RetainedAnchor`'s own header.
 */
async function reconcileRetainedAnchorsOntoItinerary(input: {
  itinerary: Itinerary;
  retainedAnchors: readonly RetainedAnchor[];
  skeleton: TripSkeleton;
  resolvedBases: readonly ResolvedBase[];
  matrix: TravelTimeMatrix;
  routeMatrix?: SkeletonRouteMatrixProvider;
  ledger: TravelLegLedger;
}): Promise<{ itinerary: Itinerary; dispositions: readonly AnchorDispositionRecord[] }> {
  const { itinerary, retainedAnchors, skeleton, resolvedBases, matrix, routeMatrix, ledger } = input;
  if (retainedAnchors.length === 0) return { itinerary, dispositions: [] };

  const dispositions: AnchorDispositionRecord[] = [];
  const unscheduledAdditions: UnscheduledPlace[] = [];

  const byDay = new Map<number, RetainedAnchor[]>();
  for (const anchor of retainedAnchors) {
    const list = byDay.get(anchor.dayNumber) ?? [];
    list.push(anchor);
    byDay.set(anchor.dayNumber, list);
  }

  const baseByDayNumber = new Map<number, ResolvedBaseIdentity | null>();
  for (const day of skeleton.days) {
    const base = day.baseId ? resolvedBases.find((b) => b.skeletonBaseId === day.baseId) : undefined;
    baseByDayNumber.set(day.dayNumber, base?.identity ?? null);
  }

  const days: ItineraryDay[] = itinerary.days.map((day) => ({ ...day, items: [...day.items], warnings: [...day.warnings] }));
  const dayByNumber = new Map(days.map((d) => [d.dayNumber, d] as const));

  for (const [dayNumber, anchorsForDay] of byDay) {
    const day = dayByNumber.get(dayNumber);
    if (!day) {
      for (const anchor of anchorsForDay) {
        unscheduledAdditions.push(unscheduledEntryForRetainedAnchor(anchor, 'This day is not part of the final trip.'));
        dispositions.push({ id: anchor.id, dayNumber, name: anchor.name, disposition: 'unscheduled_capacity' });
      }
      continue;
    }

    const baseIdentity = baseByDayNumber.get(dayNumber) ?? null;

    // Targeted acquisition — exactly this day's base plus this day's own
    // retained anchors, nothing from any other day. `acquireRoute` is
    // already memoized against the same ledger every earlier resolution
    // stage used, so a point already known costs nothing here.
    if (routeMatrix && baseIdentity) {
      const points = [
        { id: baseIdentity.id, lat: baseIdentity.coordinates.lat, lng: baseIdentity.coordinates.lng },
        ...anchorsForDay
          .filter((a): a is RetainedAnchor & { identity: ResolvedBaseIdentity } => a.identity !== null)
          .map((a) => ({ id: a.identity.id, lat: a.identity.coordinates.lat, lng: a.identity.coordinates.lng })),
      ];
      await acquireRoute(ledger, routeMatrix, points, matrix);
    }
    const ledgerNow = ledgerSnapshot(ledger);

    const gaps = computeGaps(day.items, day.window);
    const newItems: ItineraryItem[] = [];

    // Primary anchors get first claim on the day's own free time — a
    // stable sort, so anchors of the same role keep the model's own order.
    const ordered = [...anchorsForDay].sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1));

    for (const anchor of ordered) {
      const visitMinutes = anchor.estimatedDurationMinutes ?? DEFAULT_RETAINED_ANCHOR_DURATION_MINUTES;
      let leg: { minutes: number; km: number } | null = null;
      if (anchor.identity && baseIdentity) {
        leg = measuredLeg(matrix, ledgerNow, baseIdentity.id, anchor.identity.id);
      }
      const blockMinutes = visitMinutes + (leg?.minutes ?? 0);
      const claimed = claimGap(gaps, blockMinutes);
      if (!claimed) {
        unscheduledAdditions.push(
          unscheduledEntryForRetainedAnchor(anchor, 'There was no room left in this day once everything else was placed.', 'no_time_left'),
        );
        dispositions.push({ id: anchor.id, dayNumber, name: anchor.name, disposition: 'unscheduled_capacity' });
        continue;
      }
      const travelUnmeasuredNote =
        anchor.identity && baseIdentity && !leg ? 'Travel time to it has not been measured, so treat the block above as a floor. ' : '';
      const item: ItineraryItem = {
        id: anchor.id,
        kind: 'activity',
        title: anchor.name,
        startMinute: claimed.start,
        endMinute: claimed.start + blockMinutes,
        durationMinutes: blockMinutes,
        ...(anchor.identity ? { placeId: anchor.identity.id } : {}),
        ...(anchor.identity && baseIdentity
          ? {
              travel: {
                fromId: baseIdentity.id,
                toId: anchor.identity.id,
                fromName: baseIdentity.name,
                toName: anchor.identity.name,
                minutes: leg?.minutes ?? null,
                km: leg?.km ?? null,
                mode: matrixModeToTransportMode(matrix.mode),
                role: 'approach' as const,
                provenance: leg ? ('measured' as const) : ('unmeasured' as const),
                ...(leg ? {} : { unmeasuredReason: 'no_route_found' as const }),
              },
            }
          : {}),
        // `reason` is the one field every item card actually renders
        // (`ItineraryView.tsx`) — the honest caveat belongs here, not only
        // in `note` (kept too, for any reader that does use it, but never
        // relied on as the sole visible copy of this).
        reason:
          anchor.state === 'partially_verified'
            ? `From your plan's own day ${dayNumber}: ${anchor.why} Sidequest confirmed a real place at this name, but does not yet have Discovery Board evidence for it — duration${anchor.estimatedDurationMinutes ? " is your plan's own estimate" : ' is a rough placeholder'}, and hours/access are unconfirmed. ${travelUnmeasuredNote}Confirm details locally.`
            : `From your plan's own day ${dayNumber}: ${anchor.why} This could not be independently confirmed as a specific place — visit if you can find it locally, and confirm details on the ground.`,
        note:
          anchor.state === 'partially_verified'
            ? `Sidequest confirmed a real place at this name, but does not yet have Discovery Board evidence for it — duration${anchor.estimatedDurationMinutes ? " is your plan's own estimate" : ' is a rough placeholder'}, and hours/access are unconfirmed. ${travelUnmeasuredNote}Confirm details locally.`
            : `This came from your plan's own composition and could not be independently confirmed as a specific place. Visit if you can find it locally — details should be confirmed on the ground.`,
        accessWarning: 'Hours and access have not been independently confirmed for this stop.',
        verifyBeforeTravel: 'Confirm this is open and accessible before you go.',
        weatherSensitive: false,
      };
      newItems.push(item);
      dispositions.push({
        id: anchor.id,
        dayNumber,
        name: anchor.name,
        disposition: anchor.state === 'partially_verified' ? 'scheduled_partially_verified' : 'scheduled_unverified',
        ...(anchor.identity ? { placeId: anchor.identity.id } : {}),
      });
    }

    if (newItems.length > 0) {
      const merged = [...day.items.filter((i) => i.kind !== 'free_time'), ...newItems].sort((a, b) => a.startMinute - b.startMinute);
      const remainingGaps = computeGaps(merged, day.window);
      const freeItems: ItineraryItem[] = remainingGaps
        .filter((g) => g.end - g.start >= MIN_FREE_TIME_BLOCK_MINUTES)
        .map((g) => ({
          id: `free-${dayNumber}-${g.start}`,
          kind: 'free_time' as const,
          title: 'Free time',
          startMinute: g.start,
          endMinute: g.end,
          durationMinutes: g.end - g.start,
          reason: 'Deliberately unbooked. A plan with no slack in it is a plan that breaks.',
          weatherSensitive: false,
        }));
      day.items = [...merged, ...freeItems].sort((a, b) => a.startMinute - b.startMinute);
      const addedMinutes = newItems.reduce((sum, item) => sum + item.durationMinutes, 0);
      const addedKm = newItems.reduce((sum, item) => sum + (item.travel?.km ?? 0), 0);
      day.totals = applyRetainedAnchorsToTotals(day.totals, addedMinutes, addedKm);
      day.warnings = [
        ...day.warnings,
        `This day also includes ${newItems.length} stop${newItems.length === 1 ? '' : 's'} from your plan that Sidequest has not fully verified — treat timing, access and hours as approximate until confirmed locally.`,
      ];
    }
  }

  return {
    itinerary: { ...itinerary, days, unscheduled: [...itinerary.unscheduled, ...unscheduledAdditions] },
    dispositions,
  };
}

/**
 * THE STALE-READINESS FIX — `funnel.scheduled` NOW COUNTS WHAT THE
 * TRAVELLER ACTUALLY SEES, NOT ONLY WHAT THE BOARD FUNNEL PLACED.
 *
 * `result.readiness` is built by `planTrip()` — before this file's bridge
 * ever runs — from `PlannerFunnel`, a strictly board-scoped count
 * (`considered`/`selected`/`eligible`/.../`scheduled` are all, by their own
 * field doctrine, about `DiscoveryCandidate`s). Left alone, a trip whose
 * bridge added eight real stops would still report the pre-bridge number,
 * silently understating a itinerary a traveller can already see is fuller
 * than that. This does not touch board-scoped semantics upstream of
 * `scheduled` (`considered` through `feasible` stay exactly what
 * `planTrip()` measured — they are honestly about the board, and this
 * bridge's content never was board content); it only corrects the one
 * terminal count, `scheduled`, to mean what it is read as meaning: how much
 * is actually in the trip. `buildPlannerReadiness()` is called again,
 * fully, rather than hand-patching `readiness.summary`/`.level` alongside
 * it — those are *derived* from the funnel, and patching one without the
 * other would leave a plan reading "3 places are in the plan" beside a
 * `funnel.scheduled` that now says 11.
 *
 * Bounded, stated imprecision: `usableDays`/`anchorableDays`/
 * `usableDaysWithActivity` (see `ReadinessInput`) are not recoverable from
 * an already-built `PlannerReadiness` — only `buildPlannerReadiness()`'s
 * own caller (`plan.ts`) had them, and passing them through was out of
 * this round's scope. Their absence falls back to `coverageOf()`'s own
 * conservative date-arithmetic reading, exactly what every caller before
 * this file's own use of `buildPlannerReadiness()` already gets.
 */
function recomputeReadinessAfterBridge(input: {
  readiness: PlannerReadiness;
  itinerary: Itinerary;
  bridgeScheduledCount: number;
  profile: TravelerProfile;
}): PlannerReadiness {
  const { readiness, itinerary, bridgeScheduledCount, profile } = input;
  if (bridgeScheduledCount === 0) return readiness;
  const daysWithActivity = itinerary.days.filter((day) => day.items.some((item) => item.kind !== 'free_time')).length;
  return buildPlannerReadiness({
    funnel: { ...readiness.funnel, scheduled: readiness.funnel.scheduled + bridgeScheduledCount },
    unscheduled: itinerary.unscheduled,
    dayCount: readiness.daysRequested,
    daysWithFullMeals: readiness.daysWithFullMeals,
    supply: readiness.supply,
    unresolved: readiness.unresolved,
    profile,
    daysWithActivity,
  });
}

/* ------------------------------------------------------------------ *
 * The adapter's entry point
 * ------------------------------------------------------------------ */

export async function planFromSkeleton(input: {
  skeleton: TripSkeleton;
  skeletonPacket: SkeletonEvidencePacket;
  context: SkeletonPlanningContext;
}): Promise<SkeletonPlanResult> {
  const { skeleton, skeletonPacket, context } = input;
  const deviations: SkeletonDeviation[] = [];

  // --- Base resolution: deterministic, tiered, never the model ------------
  let resolvedBases: ResolvedBase[] = [];
  const baseResolutions: BaseResolutionRecord[] = [];
  for (const base of skeleton.bases) {
    const stated = statedCoordinatesFor(base, skeletonPacket);
    const outcome = await resolveSkeletonBase(base, skeletonPacket, context);
    const measuredInMatrix = outcome.identity ? context.matrix.ids.includes(outcome.identity.id) : false;
    baseResolutions.push({
      skeletonBaseId: base.id,
      skeletonName: base.name,
      requestedCoordinates: stated,
      resolvedId: outcome.identity?.id ?? null,
      resolvedName: outcome.identity?.name ?? null,
      method: outcome.method,
      distanceKm: outcome.distanceKm,
      ambiguous: outcome.ambiguous,
      provenance: outcome.provenance,
      measuredInMatrix,
      // Refined below, once the on-demand routing step (if any) has run —
      // a base that fails resolution entirely is never routable.
      routable: measuredInMatrix,
      geographicScopeOutcome: outcome.geographicScopeOutcome,
      candidates: outcome.candidates,
    });
    if (outcome.method === 'geocoder') {
      deviations.push({
        kind: 'base_resolved_via_geocoder',
        detail: `"${base.name}" resolved through a deterministic geocoder lookup rather than the compiler's own base list or the Discovery Board (${outcome.identity!.name}, ${outcome.distanceKm?.toFixed(2) ?? '?'} km from the skeleton's own coordinate).`,
        replacementPlaceId: outcome.identity!.id,
      });
    }
    resolvedBases.push({ skeletonBaseId: base.id, name: base.name, nights: base.nights, identity: outcome.identity });
  }

  // Authoritative planning intents are not optional: an unresolved or
  // ambiguous skeleton base stops here, named precisely, rather than
  // propagating a `null` identity into relocation/departure checks that
  // would only surface it later as an opaque planner refusal.
  const failures = baseResolutions.filter((r) => r.ambiguous || !r.resolvedId);
  if (failures.length > 0) {
    const ambiguous = failures.filter((f) => f.ambiguous);
    const unresolved = failures.filter((f) => !f.ambiguous);
    const detailParts: string[] = [];
    const verifiedAlternatives: { placeId: string; name: string; reason: string }[] = [];
    if (ambiguous.length > 0) {
      const summaries = ambiguous.map((f) => {
        const viable = (f.candidates ?? []).filter((c) => !c.selected);
        for (const c of viable) {
          verifiedAlternatives.push({
            placeId: c.sourceId,
            name: c.name,
            reason: `Candidate for "${f.skeletonName}": ${c.distanceKm !== null ? `${c.distanceKm.toFixed(2)} km from the skeleton's own coordinate` : 'distance unknown (skeleton carried no coordinate)'}, ${c.isLocality ? 'a real locality' : `not a recognized locality (${c.entityType ?? 'unclassified'})`}; ${c.rankingReason}.`,
          });
        }
        const list = viable
          .map((c) => `${c.name} (${c.distanceKm !== null ? `${c.distanceKm.toFixed(2)} km` : 'distance unknown'}${c.isLocality ? ', locality' : ''})`)
          .join(' vs. ');
        return `${f.skeletonName}: ${list || 'candidate details unavailable'}`;
      });
      detailParts.push(
        `${ambiguous.length} base(s) had more than one equally-plausible real identity and none was picked safely: ${summaries.join('; ')}.`,
      );
    }
    if (unresolved.length > 0) {
      detailParts.push(
        `${unresolved.length} base(s) did not resolve to any real production identity: ${unresolved.map((f) => f.skeletonName).join(', ')}.`,
      );
    }
    return {
      baseResolutions,
      ok: false,
      repairIssue: {
        kind: ambiguous.length > 0 ? 'base_identity_ambiguous' : 'base_unresolved',
        detail: detailParts.join(' '),
        affectedDayNumbers: [],
        affectedBaseIds: failures.map((f) => f.skeletonBaseId),
        verifiedAlternatives,
        lockedDecisions: {
          baseIds: baseResolutions.filter((r) => r.resolvedId).map((r) => r.skeletonBaseId),
          dayNumbers: [],
        },
      },
    };
  }

  // The same physical place occurring again later (a loop's return to its
  // starting base) is not a duplicate — only two *consecutive* resolved
  // bases sharing an identity are, since nothing separates them into a real
  // second stay. Merging every occurrence regardless of position used to
  // collapse a loop's return leg into its opening stay, silently corrupting
  // every date after it.
  const deduped: ResolvedBase[] = [];
  for (const base of resolvedBases) {
    const previous = deduped[deduped.length - 1];
    if (previous?.identity && base.identity && previous.identity.id === base.identity.id) {
      deviations.push({
        kind: 'duplicate_location_identity',
        detail: `Bases "${previous.skeletonBaseId}" and "${base.skeletonBaseId}" are the same consecutive stay at ${base.identity.name}; merged into one.`,
        replacementPlaceId: base.identity.id,
      });
      previous.nights += base.nights;
      continue;
    }
    deduped.push({ ...base });
  }
  resolvedBases = deduped;

  // --- Anchor resolution, day by day — before routing, so Phase B (below)
  // --- knows each day's own points without re-deriving them. -------------
  const usedPlaceIds = new Set<string>();
  const locks: ItineraryLock[] = [];
  const includedPlaceIds = new Set<string>();
  /** Place id -> the day(s) it is locked to, for the anchor-unroutable deviation's detail. */
  const anchorDayNumbers = new Map<string, number[]>();
  /** Day number -> the resolved place ids locked to it — Phase B's own per-day point sets. */
  const anchorIdsByDay = new Map<number, string[]>();
  /**
   * Anchors that resolved `partially_verified` or `unverified` — never on
   * `locks` (no board `DiscoveryCandidate` exists for them), and never
   * dropped either. Surfaced on the finished itinerary's own `unscheduled`
   * list — see the `ok: true` return below — so a thin compiled region
   * degrades verification confidence, never content. See `RetainedAnchor`.
   */
  const retainedAnchors: RetainedAnchor[] = [];
  /** Every anchor's final disposition — see `AnchorDisposition`. Populated as each is resolved, never reconstructed after the fact. */
  const anchorDispositions: AnchorDispositionRecord[] = [];

  for (const day of skeleton.days) {
    for (const [anchorIndex, anchor] of day.anchors.entries()) {
      const outcome = await resolveSkeletonAnchor(anchor, skeletonPacket, context);
      // `name` is schema-optional only for anchors predating this field.
      // Prefer it when the model gave one; otherwise prefer whatever real
      // name resolution itself found (the board place, or — for
      // `packet_evidence_unmatched` — the evidence packet's own record,
      // which has a real name a placeIndex-only anchor never carried on
      // itself); only an anchor with none of the three falls back to a
      // placeholder, never shown to a traveller.
      const label =
        anchor.name ??
        (outcome.place ? displayNameOf(outcome.place) : undefined) ??
        outcome.identity?.name ??
        (anchor.placeIndex !== null ? `packet place #${anchor.placeIndex}` : 'an unnamed anchor');
      // Stable within this one skeleton, independent of everything that
      // happens after this point — see `RetainedAnchor.id`.
      const anchorId = `day${day.dayNumber}-anchor${anchorIndex}-${normalizeName(label).replace(/\s+/g, '-').slice(0, 24)}`;

      if (outcome.state === 'verified' && outcome.place) {
        // Board-matched by placeIndex or by exact name — both are the
        // ordinary, expected path and never a deviation.
        includedPlaceIds.add(outcome.place.id);
        if (!usedPlaceIds.has(outcome.place.id)) {
          locks.push({ placeId: outcome.place.id, dayNumber: day.dayNumber });
          usedPlaceIds.add(outcome.place.id);
        }
        const days = anchorDayNumbers.get(outcome.place.id) ?? [];
        days.push(day.dayNumber);
        anchorDayNumbers.set(outcome.place.id, days);
        const dayIds = anchorIdsByDay.get(day.dayNumber) ?? [];
        dayIds.push(outcome.place.id);
        anchorIdsByDay.set(day.dayNumber, dayIds);
        // A verified anchor can still lose to real day capacity/pacing
        // competition inside `planTrip()` itself — that outcome is decided
        // (and reported via the pre-existing `unscheduled`/readiness path)
        // only once `planTrip()` actually runs, below. Recorded optimistically
        // here and not re-checked, per this round's own bounded scope —
        // see the final report's own note on this.
        anchorDispositions.push({ id: anchorId, dayNumber: day.dayNumber, name: label, disposition: 'scheduled_verified', placeId: outcome.place.id });
        continue;
      }

      if (outcome.state === 'partially_verified' && outcome.identity) {
        deviations.push({
          kind: 'anchor_resolved_via_geocoder',
          detail:
            outcome.method === 'packet_evidence_unmatched'
              ? `"${label}" (day ${day.dayNumber}) has a real record in the model's own evidence packet, but no matching place on this trip's board. Using the packet's own coordinate directly — no geocoder call needed — and Sidequest will attempt to schedule it using real day-local routing, without board fit/access/hours evidence.`
              : `"${label}" (day ${day.dayNumber}) is not on this trip's board; a deterministic geocoder confirmed a real place (${outcome.identity.name}) at this name. Sidequest will attempt to schedule it directly using real day-local routing, without board fit/access/hours evidence.`,
          skeletonDayNumber: day.dayNumber,
          replacementPlaceId: outcome.identity.id,
        });
        retainedAnchors.push({
          id: anchorId,
          dayNumber: day.dayNumber,
          name: label,
          locality: anchor.locality ?? null,
          role: anchor.role,
          why: anchor.why,
          estimatedDurationMinutes: anchor.estimatedDurationMinutes ?? outcome.fallbackDurationMinutes,
          state: 'partially_verified',
          identity: outcome.identity,
        });
        continue;
      }

      // Unverified: neither the board nor a geocoder confirmed this exact
      // place. Retained by name, never dropped — see `RetainedAnchor`.
      deviations.push({
        kind: 'anchor_unverified',
        detail: `"${label}" (day ${day.dayNumber}) could not be independently verified as a real, specific place — neither this trip's board nor a geocoder lookup confirmed it. Sidequest will still try to schedule it as an honestly-uncertain proposal rather than dropping it.`,
        skeletonDayNumber: day.dayNumber,
        ...(anchor.placeIndex !== null ? { skeletonPlaceIndex: anchor.placeIndex } : {}),
      });
      retainedAnchors.push({
        id: anchorId,
        dayNumber: day.dayNumber,
        name: label,
        locality: anchor.locality ?? null,
        role: anchor.role,
        why: anchor.why,
        estimatedDurationMinutes: anchor.estimatedDurationMinutes,
        state: 'unverified',
        identity: null,
      });
    }
  }

  // --- PHASE A: mandatory relocation-leg acquisition, independent of any
  // --- day's anchors — a TripSkeleton's route *shape* is decided by its
  // --- consecutive overnight bases, and that question must be answerable
  // --- even when a later, larger request degrades (see `TravelLegLedger`).
  const resolvedIdentities = resolvedBases.filter(
    (b): b is ResolvedBase & { identity: ResolvedBaseIdentity } => b.identity !== null,
  );
  const routingCapable = Boolean(context.routeMatrix);
  const routeAttempted = routingCapable && resolvedIdentities.length > 1;
  const ledger = emptyLedger();
  if (routeAttempted) {
    const basePoints = resolvedIdentities.map((b) => ({
      id: b.identity.id,
      lat: b.identity.coordinates.lat,
      lng: b.identity.coordinates.lng,
    }));
    await acquireRoute(ledger, context.routeMatrix!, basePoints, context.matrix);
  }

  // --- PHASE B: per-day acquisition — only this day's own base and locked
  // --- anchors, never the whole skeleton's points at once. `acquireRoute`'s
  // --- own memoization skips a day whose pairs Phase A (or the static
  // --- matrix) already covers, so this costs nothing beyond what the day
  // --- genuinely still needs. --------------------------------------------
  const anchorPoints = locks
    .map((lock) => context.candidates.find((c) => c.place.id === lock.placeId))
    .filter((c): c is DiscoveryCandidate => c !== undefined)
    .map((c) => ({ id: c.place.id, lat: c.place.coordinates.lat, lng: c.place.coordinates.lng }));
  if (routingCapable) {
    const resolvedBaseById = new Map(resolvedBases.map((b) => [b.skeletonBaseId, b] as const));
    for (const day of skeleton.days) {
      const dayBase = day.baseId ? resolvedBaseById.get(day.baseId) : undefined;
      const dayAnchorIds = new Set(anchorIdsByDay.get(day.dayNumber) ?? []);
      const dayPoints = [
        ...(dayBase?.identity
          ? [{ id: dayBase.identity.id, lat: dayBase.identity.coordinates.lat, lng: dayBase.identity.coordinates.lng }]
          : []),
        ...anchorPoints.filter((a) => dayAnchorIds.has(a.id)),
      ];
      await acquireRoute(ledger, context.routeMatrix!, dayPoints, context.matrix);
    }
  }

  let extraMatrix: RouteMatrixResult | null = ledgerSnapshot(ledger);

  for (const record of baseResolutions) {
    if (!record.resolvedId) continue;
    record.routable = routableWithin(context.matrix, extraMatrix, record.resolvedId);
  }

  // Whether a resolved base is genuinely `base_unroutable` (authoritative
  // no-route evidence for a *mandatory* leg) versus merely
  // `routing_evidence_unavailable` (a degraded/unattempted attempt) is now
  // decided leg by leg, inside `assessRelocationFeasibility` and
  // `assessDepartureClosure` below — the actual mandatory legs a route
  // shape needs, not "does this base have zero routable legs to anything",
  // which could not tell the two apart at all.

  // A locked anchor that a genuine routing attempt still could not place is
  // soft-dropped — one missing stop, not a torpedoed multi-day itinerary —
  // exactly the doctrine `anchor_unresolved`/`anchor_infeasible_no_substitute`
  // already follow. No capability offered at all leaves it locked exactly as
  // before; `resolveCandidates()`'s own `missing_travel_data` gate is what
  // then honestly excludes it downstream if the static matrix cannot answer
  // for it either. (Anchor-level diagnostics stay coarse — routable or not —
  // per this round's scope; only the *base*-relocation path needed the
  // finer authoritative/unavailable split.)
  if (routingCapable) {
    for (const point of anchorPoints) {
      if (context.matrix.ids.includes(point.id)) continue;
      if (routableWithin(context.matrix, extraMatrix, point.id)) continue;
      const days = anchorDayNumbers.get(point.id) ?? [];
      const name = context.candidates.find((c) => c.place.id === point.id);
      deviations.push({
        kind: 'anchor_unroutable',
        detail: `"${name ? displayNameOf(name.place) : point.id}" (day${days.length === 1 ? '' : 's'} ${days.join(', ')}) resolved to a real place, but no route could be measured to or from it even after attempting one; dropped rather than scheduled on faith.`,
        skeletonDayNumber: days[0],
        replacementPlaceId: point.id,
      });
      includedPlaceIds.delete(point.id);
      for (let i = locks.length - 1; i >= 0; i -= 1) {
        if (locks[i]!.placeId === point.id) locks.splice(i, 1);
      }
    }
  }

  // Shared across both calls below, so a leg confirmed by relocation
  // feasibility is never re-asked by departure closure (see
  // `confirmMandatoryLeg`'s own header).
  const confirmationMemo: ConfirmationMemo = new Map();

  // --- Whole-route relocation feasibility, before anything is scheduled --
  const feasibility = await assessRelocationFeasibility({
    orderedBases: resolvedBases,
    matrix: context.matrix,
    profile: context.profile,
    candidates: context.candidates,
    archetype: skeleton.archetype,
    extraMatrix,
    routeAttempted,
    ledger,
    confirmationMemo,
    ...(context.confirmRoute ? { confirmRoute: context.confirmRoute } : {}),
    ...(context.findNearbyLocalities ? { findNearbyLocalities: context.findNearbyLocalities } : {}),
  });
  if (!feasibility.ok) return { baseResolutions, ok: false, repairIssue: feasibility.repairIssue };
  resolvedBases = [...feasibility.orderedBases];
  deviations.push(...feasibility.deviations);
  extraMatrix = ledgerSnapshot(ledger); // may have grown from a direct confirmation above

  // --- Departure closure ---------------------------------------------------
  const closure = await assessDepartureClosure(
    resolvedBases,
    context.matrix,
    context.profile,
    extraMatrix,
    routeAttempted,
    ledger,
    context.confirmRoute,
    confirmationMemo,
  );
  if (closure.deviation) deviations.push(closure.deviation);
  if (!closure.ok) {
    return {
      baseResolutions,
      ok: false,
      repairIssue: {
        kind: closure.kind ?? 'departure_unreachable',
        detail: closure.detail,
        affectedDayNumbers: [],
        affectedBaseIds: [resolvedBases[resolvedBases.length - 1]!.skeletonBaseId],
        ...(closure.relocationEvidence ? { relocationEvidence: closure.relocationEvidence } : {}),
        verifiedAlternatives: [],
        lockedDecisions: { baseIds: resolvedBases.map((b) => b.skeletonBaseId), dayNumbers: [] },
      },
    };
  }
  extraMatrix = ledgerSnapshot(ledger); // may have grown from a direct confirmation above

  const now = context.now ?? new Date();
  const selections: DiscoverySelection[] = [...includedPlaceIds].map((placeId) => ({
    placeId,
    status: 'included',
    source: 'user',
    updatedAt: now.toISOString(),
  }));

  const resolvedBasesOnly = resolvedBases.filter((b): b is ResolvedBase & { identity: ResolvedBaseIdentity } => b.identity !== null);
  const basePortfolio =
    resolvedBasesOnly.length > 1
      ? { bases: buildBasePortfolioDates(resolvedBasesOnly, context.basics, context.matrix, context.profile, extraMatrix) }
      : undefined;

  const baseId = resolvedBases.find((b) => b.identity)?.identity?.id ?? context.candidates[0]?.place.id ?? '';

  /**
   * `PlannerInput.travelLegs` — the same on-demand evidence this adapter's
   * own checks just used, handed to the real planner so a base or an anchor
   * resolved here does not become unusable one layer deeper (`resolveCandidates`,
   * `assignToDays`, `scheduleUnits`'s stop ordering, `validateItinerary` all
   * consult it — see each one's own note). Never `context.matrix` itself,
   * which stays exactly what it was compiled as.
   */
  const travelLegs: TravelTimeMatrix | undefined =
    extraMatrix && extraMatrix.ids.length > 0
      ? {
          mode: context.matrix.mode,
          ids: extraMatrix.ids,
          minutes: extraMatrix.minutes,
          km: extraMatrix.km,
          provenance: { kind: 'measured', note: 'Resolved on demand for skeleton bases/anchors the compiled matrix did not carry.' },
        }
      : undefined;

  const result = planTrip({
    tripId: context.tripId,
    basics: context.basics,
    profile: context.profile,
    region: context.region,
    candidates: context.candidates,
    selections,
    matrix: context.matrix,
    ...(travelLegs ? { travelLegs } : {}),
    ...(context.transit ? { transit: context.transit } : {}),
    scheduledNetwork: context.scheduledNetwork,
    access: context.access,
    hours: context.hours,
    weather: context.weather,
    ...(context.food ? { food: context.food } : {}),
    ...(context.foodSelections ? { foodSelections: context.foodSelections } : {}),
    locks,
    ...(basePortfolio ? { basePortfolio } : {}),
    now,
    baseId,
  });

  if (!result.ok) {
    return {
      baseResolutions,
      ok: false,
      repairIssue: {
        kind: 'planner_refused',
        detail: `Sidequest's planner could not build a plan from this skeleton's resolved anchors: ${result.message}`,
        affectedDayNumbers: [],
        affectedBaseIds: resolvedBases.map((b) => b.skeletonBaseId),
        verifiedAlternatives: [],
        lockedDecisions: { baseIds: [], dayNumbers: [] },
      },
    };
  }

  // The bridge: every retained anchor gets real day-local routing where its
  // identity allows it, and a genuine attempt at a schedule slot — never a
  // direct trip to `unscheduled` merely for lacking board evidence. See
  // `reconcileRetainedAnchorsOntoItinerary`'s own header.
  const bridged = await reconcileRetainedAnchorsOntoItinerary({
    itinerary: result.itinerary,
    retainedAnchors,
    skeleton,
    resolvedBases,
    matrix: context.matrix,
    ...(context.routeMatrix ? { routeMatrix: context.routeMatrix } : {}),
    ledger,
  });

  // A `scheduled_verified` disposition was recorded optimistically at
  // resolution time, before `planTrip()` had run its own real
  // capacity/pacing competition — correct it here against what the finished
  // itinerary actually contains, so the disposition list stays accurate
  // rather than merely hopeful. A board anchor `planTrip()` itself could not
  // fit is not this bridge's failure and is not re-attempted here; it is
  // already honestly reported on `unscheduled` by the pre-existing pipeline.
  const scheduledPlaceIds = new Set(bridged.itinerary.days.flatMap((d) => d.items.map((i) => i.placeId).filter((id): id is string => Boolean(id))));
  const dispositions: AnchorDispositionRecord[] = [
    ...anchorDispositions.map((record) =>
      record.disposition === 'scheduled_verified' && record.placeId && !scheduledPlaceIds.has(record.placeId)
        ? { ...record, disposition: 'unscheduled_capacity' as const }
        : record,
    ),
    ...bridged.dispositions,
  ];

  const bridgeScheduledCount = bridged.dispositions.filter(
    (d) => d.disposition === 'scheduled_partially_verified' || d.disposition === 'scheduled_unverified',
  ).length;
  const readiness = recomputeReadinessAfterBridge({
    readiness: result.readiness,
    itinerary: bridged.itinerary,
    bridgeScheduledCount,
    profile: context.profile,
  });

  return { baseResolutions, ok: true, itinerary: bridged.itinerary, readiness, deviations, dispositions };
}

/** The skeleton's own stated coordinate for a base, for distance reporting only. */
function statedCoordinatesFor(
  base: TripSkeleton['bases'][number],
  packet: SkeletonEvidencePacket,
): { lat: number; lng: number } | null {
  const evidencePlace = base.placeIndex !== null ? packet.places.find((p) => p.index === base.placeIndex) : undefined;
  if (evidencePlace) return { lat: evidencePlace.lat, lng: evidencePlace.lng };
  const baseCandidate = packet.baseCandidates.find((b) => b.name === base.name);
  if (baseCandidate) return { lat: baseCandidate.lat, lng: baseCandidate.lng };
  return null;
}
