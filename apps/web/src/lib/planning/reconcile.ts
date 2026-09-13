import 'server-only';
import { buildDailyWindows, buildPlannerReadiness, resolveConfig, PLANNER_VERSION, type PlannedDay } from '@sidequest/planner';
import type { TravelTimeMatrix } from '@sidequest/geo';
import {
  DIETARY_NEED_LABELS,
  ASSUMED_GATEWAY_TRANSFER_MINUTES,
  buildGatewayPlan,
  compileSpatialOrder,
  describeEdgeTime,
  describeUnplaced,
  gatewayNodeSchema,
  isGatewayName,
  LADDER_LIMITS,
  placementQueries,
  placementReportSchema,
  MEDICAL_OR_OBSERVANT_NEEDS,
  PRICE_BAND_ORDER,
  displayNameOf,
  findOperatingCalendar,
  operatingOn,
  permittedModesFor,
  tripDates,
  ITINERARY_VERSION,
  FOOD_DATASET_VERSION,
  OPERATING_HOURS_DATASET_VERSION,
  WEATHER_DATASET_VERSION,
  type AnchorDispositionCode,
  type DayWeather,
  type DayWeatherSummary,
  type DiscoveryCandidate,
  type FoodDataset,
  type FoodVenue,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type PackageAnchor,
  type Place,
  type PlaceClass,
  type GatewayNode,
  type GatewayPlan,
  type GatewayTransfer,
  type OrderedStop,
  type PlacementAttempt,
  type PlacementReport,
  type PlannerReadiness,
  type RouteCriticalPlacement,
  type SpatialOrderReport,
  type RevisionAction,
  type TransportMode,
  type TravelSegment,
  type TravelerProfile,
  type TripPackage,
  type UnscheduledPlace,
  type ValidationIssue,
  type VerificationState,
  type WeatherDataset,
  encodePolyline,
  simplifyPolyline,
  assessOperational,
  enrichmentLevelFor,
  operationalWindowsOn,
  placeClassFor,
  type OperationalEvidence,
  type ScheduledOperational,
  anchorKindOf,
  lookupPriorityFor,
  mealSlotOf,
  estimateLegMinutes,
  plausibleModeFor,
  unknownLegAllowanceMinutes,
  dayPrecisionOf,
  type AnchorKind,
  gatewayIsUnresolved,
  type BaseKind,
} from '@sidequest/core';
import {
  AUTHORITATIVE_NO_ROUTE,
  acquireRoute,
  assessDepartureClosure,
  assessGeographicScope,
  assessRelocationFeasibility,
  emptyLedger,
  identityFromPlace,
  ledgerFailureReason,
  ledgerSnapshot,
  measuredLeg,
  normalizeName,
  pickAnchorGeocoderWinner,
  resolveSkeletonBase,
  isLocalityCandidate,
  haversineKm,
  type ConfirmationMemo,
  confirmMandatoryLeg,
  type GeocodedLocality,
  type ResolvedBase,
  type ResolvedBaseIdentity,
  type RouteMatrixResult,
  type SkeletonDeviation,
  type SkeletonPlanningContext,
  type UnresolvedRelocation,
} from './skeleton-adapter';
import type { SkeletonEvidencePacket } from '@/lib/benchmark/baseline/skeleton-packet';
import { TRIP_DRAFT_SCHEMA_VERSION, draftAnchorId, episodeForDay, episodeIsOffRoad, episodesOf, type AnchorRole, type DraftAnchor, type DraftEpisode, type DraftTransport, type TripDraft, movementShapeOf, impliesSelfDriving, timeOfDayIsBinding, timeOfDayIsHard } from './trip-draft';

/**
 * THE RECONCILER — MODEL DRAFT + VERIFICATION OVERLAY + MINIMAL DETERMINISTIC
 * CORRECTIONS = THE TRAVELLER'S ITINERARY.
 *
 * This is the canonical second half of "the model composes, Sidequest
 * verifies, corrects, enriches and presents". It never hands the draft to a
 * candidate competition: every day's sequence is the draft's own sequence,
 * every anchor is placed on the day the draft put it on, and only affirmative
 * evidence — a router that answered "no route", a calendar that says closed on
 * every trip date, measured driving over the traveller's own hard ceiling, a
 * day that physically cannot hold what was put in it — ever moves or removes
 * anything. Missing evidence lowers confidence and is said out loud on the
 * item; it never deletes.
 *
 * What is reused, unchanged, from `skeleton-adapter.ts`: base identity
 * resolution with geographic-scope screening, the sparse `TravelLegLedger`,
 * targeted `acquireRoute`, mandatory-leg confirmation, whole-route relocation
 * remediation (board base → corridor settlement, night borrowing, total-night
 * preservation), departure closure. Everything scheduling-shaped is here, and
 * deliberately small: a day is laid out in the draft's order with measured or
 * honestly-unmeasured legs between consecutive points, meals where the draft
 * (or the clock) puts them, and free time where nothing else is.
 *
 * Every anchor the draft proposed ends in exactly one `AnchorDispositionCode`,
 * and every non-scheduled disposition also appears on `itinerary.unscheduled`
 * with a reason — silent loss is structurally impossible (`dispositions.length
 * === anchors.length` is asserted by every acceptance fixture).
 */

/** A place identity a dedicated places provider (Google Places identity level, Overture, OSM) resolved — never a geocoder guess. */
/** How many identity lookups run at once. Small: providers rate-limit, and the budget counts every call. */
const ANCHOR_RESOLUTION_CONCURRENCY = 4;
/** Bases resolve a few at a time as well; the geocoder's own rate gate still serialises the wire. */
const BASE_RESOLUTION_CONCURRENCY = 3;
/** A landmark that resolved for a locality base is trusted for position only when it sits inside the town it names. */
const LANDMARK_WITHIN_TOWN_KM = 15;

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ProviderPlaceIdentity {
  providerRef: string;
  provider: string;
  name: string;
  coordinates: { lat: number; lng: number };
  countryCode?: string;
  placeClass?: PlaceClass;
  confidence?: 'exact' | 'probable' | 'weak';
  attribution?: string;
}

export interface ReconcileContext extends SkeletonPlanningContext {
  /** Every place the compiled region knows, not only the board's scored candidates — a broader identity source, still real evidence. */
  compiledPlaces?: readonly Place[];
  /**
   * LIVE WORLD V1 — identities persisted by an earlier build of this trip,
   * keyed by normalised anchor name. First in the resolution order: a name
   * already resolved is never looked up (or paid for) again.
   */
  persistedIdentities?: ReadonlyMap<string, NonNullable<PackageAnchor['identity']> & { name: string; placeId: string }>;
  /**
   * LIVE WORLD V1 — a dedicated places provider, tried after Sidequest's own
   * evidence and before the locality geocoder. Bounded by the caller (budget,
   * deadline); returns null when nothing matches or the budget is spent.
   */
  resolvePlaceIdentity?: (input: { name: string; locality?: string; category: string; near: { lat: number; lng: number }; radiusKm: number }) => Promise<ProviderPlaceIdentity | null>;
  /**
   * LIVE WORLD V1 closure — operational evidence (business status, regular
   * hours) for a stop a places provider identified, normalised by the
   * adapter into `OperationalEvidence`. Asked only for place classes whose
   * hours or status matter; null means nothing was available. Never a
   * provider's own shape.
   */
  operationalEvidence?: (input: { placeId: string; providerRef?: string; provider: string; name: string; placeClass: PlaceClass }) => Promise<OperationalEvidence | null>;
  /** Returns true once the bounded verification deadline has passed; later provider lookups are skipped and reported. */
  deadlineReached?: () => boolean;
  /**
   * PRODUCT RECOVERY V1 — route-aware weather. Once the bases have a position,
   * the reconciler may ask for a climate or forecast point per base (bounded
   * by the caller) instead of one national centroid for every day. Null or a
   * throw leaves the dataset the context already holds.
   */
  weatherForBases?: (locations: readonly { id: string; label: string; coordinates: { lat: number; lng: number } }[]) => Promise<WeatherDataset | null>;
  /** PRODUCT RECOVERY V1 — a booked departure's leave-by minute on the last day; the last window closes there, as a hard edge. */
  lastDayLeaveByMinute?: number;
  /** Names the traveller explicitly asked for (board must-includes, free-text must-dos); losing one is a decision, not a caution. */
  mustIncludeNames?: readonly string[];
  /**
   * V10 §5 — the published name of the destination's country, and the
   * first-level divisions it sits in, for the placement ladder. A bare town name
   * is the worst way to ask a geocoder; these are the context that disambiguates
   * it. Absent degrades the ladder to the destination's own label, which is
   * exactly the behaviour before V10.
   */
  destinationCountryName?: string;
  destinationDivisions?: readonly string[];
  /**
   * V10 §8 — the destination's own gateways, already placed and gated by the
   * semantic layer. Context, never the destination: the trip enters through one
   * of these and the gateway is not a place the trip is about.
   */
  destinationGateways?: readonly { label: string; coordinates?: { lat: number; lng: number } }[];
}

export interface ReconciledAnchor {
  id: string;
  dayNumber: number;
  index: number;
  draft: DraftAnchor;
  verification: VerificationState;
  identity: ResolvedBaseIdentity | null;
  place: Place | null;
  candidate: DiscoveryCandidate | null;
  method: 'persisted' | 'board' | 'compiled_place' | 'places' | 'geocoder' | null;
  /** LIVE WORLD V1 — the provider identity behind `identity`, persisted on the package anchor. */
  providerIdentity?: ProviderPlaceIdentity | null;
  /** LIVE WORLD V1 closure — normalised operational evidence, in memory for this cycle only. */
  operationalEvidence?: OperationalEvidence | null;
  operationalClass?: PlaceClass;
  durationMinutes: number;
  durationBasis: 'place_record' | 'model_estimate' | 'category_default';
  /** PRODUCT RECOVERY V1 — what kind of thing the model wrote; decides whether a lookup happens and how the item is presented. */
  kind: AnchorKind;
}

export interface ReconcileResult {
  ok: true;
  itinerary: Itinerary;
  readiness: PlannerReadiness;
  deviations: readonly SkeletonDeviation[];
  dispositions: readonly PackageAnchor[];
  unresolvedRelocations: readonly UnresolvedRelocation[];
  /** V10 §5 — every route-critical name's fate, with the queries that were tried. */
  placement: PlacementReport;
  /** V10 §7 — one spatial-order verdict per day, and whether the order was corrected. */
  dayOrders: readonly { dayNumber: number; report: SpatialOrderReport; corrected: boolean }[];
  /** V10 §8 — the gateway plan, when the plan names a gateway at all. */
  gateway: GatewayPlan | null;
}

/* ------------------------------------------------------------------ *
 * Small vocabularies
 * ------------------------------------------------------------------ */

const CATEGORY_DEFAULT_MINUTES: Record<DraftAnchor['category'], number> = {
  landmark: 75,
  nature: 90,
  hike: 180,
  viewpoint: 40,
  water: 90,
  wildlife: 120,
  geothermal: 90,
  museum: 120,
  historic: 75,
  neighbourhood: 120,
  market: 75,
  food: 75,
  activity: 150,
  scenic_drive: 120,
  beach: 120,
  town: 120,
  relaxation: 120,
  other: 90,
};

const ROLE_RANK: Record<AnchorRole, number> = { core: 0, secondary: 1, optional: 2, flex: 3 };

/**
 * Board blockers that are facts about access and legality — no car, no way
 * in, no service, shut on the dates — as opposed to budgets and preferences
 * (`exceeds_daily_travel`, `too_strenuous`, …) the model already weighed and
 * the reconciler measures for itself against the day the draft actually
 * built. Only the first kind is a contradiction of the draft.
 */
const ACCESS_BLOCKER_CODES = new Set(['needs_car', 'no_way_in', 'service_unavailable', 'mode_declined', 'closed_on_your_dates', 'no_open_hours']);

function reasonCodeForBlocker(code: string): UnscheduledPlace['reasonCode'] {
  switch (code) {
    case 'closed_on_your_dates':
    case 'no_open_hours':
      return 'closed_on_trip_dates';
    case 'needs_car':
    case 'mode_declined':
      return 'transport_mode_unavailable';
    case 'service_unavailable':
      return 'service_not_operating';
    case 'no_way_in':
      return 'access_unavailable';
    default:
      return 'not_feasible';
  }
}

const MEAL_MINUTES = { breakfast: 30, lunch: 45, dinner: 60 } as const;
const LUNCH_EARLIEST = 11 * 60 + 30;
const LUNCH_LATEST = 14 * 60 + 30;
const DINNER_EARLIEST = 18 * 60;
const DINNER_LATEST = 21 * 60;
/**
 * The earliest minute an experience with a stated time intent may begin.
 *
 * PRODUCTION LOCK V5 §13. Floors, not windows: the audit's own windows
 * (`quality-audit.ts`) are what decide whether the result is acceptable, and
 * they are deliberately wider than these. `morning`, `midday` and `any` have no
 * floor — a day already starts in the morning, and pushing an unconstrained stop
 * later would only empty the morning.
 *
 * `sunset` is 16:30 rather than an astronomical calculation on purpose. The real
 * sunset moves by hours across a year and a latitude, Sidequest does not have it
 * at this point in the pipeline, and a floor that is roughly late-afternoon
 * everywhere is honest where a computed instant would be precise and wrong.
 */
const TIME_OF_DAY_FLOOR: Record<string, number> = {
  midday: 11 * 60,
  afternoon: 12 * 60,
  sunset: 16 * 60 + 30,
  evening: 17 * 60,
  night: 18 * 60,
};

function timeOfDayFloor(intent: string | undefined): number | null {
  if (!intent) return null;
  return TIME_OF_DAY_FLOOR[intent] ?? null;
}

const MIN_FREE_BLOCK_MINUTES = 30;
/**
 * How far past its usual end an ordinary day may run before something comes
 * off. Small, and stated on the day whenever it is used: a plan that quietly
 * finishes an hour and a half late is the defect the founder's fixture PDF
 * showed. Arrival and departure days, and any day the traveller closed with a
 * hard back-by hour, get no tolerance at all — see `layoutDay`.
 */
const LATE_END_TOLERANCE_MINUTES = 30;
const MAX_MINUTE = 24 * 60;

function transportModeFor(hint: DraftTransport | undefined, matrixMode: TravelTimeMatrix['mode'], profileCanDrive: boolean): TransportMode {
  switch (hint) {
    case 'walk':
      return 'walk';
    case 'metro':
    case 'rail':
      return 'rail';
    case 'bus':
      return 'public_bus';
    case 'car':
    case 'four_wheel_drive':
      return 'drive';
    case 'ferry':
    case 'boat':
      return 'ferry';
    /* V7 §7 — a taxi or ride-hailing hop is a road leg somebody else drives; high-speed rail is a timetable. */
    case 'taxi':
      return 'rideshare';
    case 'high_speed_rail':
      return 'rail';
    /* A ride is arranged movement the road router cannot answer, like the two above it. */
    case 'private_transfer':
    case 'guide_or_lodge_transfer':
    case 'horse':
      return 'private_transfer';
    case 'flight':
      return 'unsupported';
    default:
      if (matrixMode === 'car') return profileCanDrive ? 'drive' : 'private_transfer';
      if (matrixMode === 'foot') return 'walk';
      return 'public_bus';
  }
}

/** Whether a road router could ever have measured this hint — a ferry or a flight leg that the router cannot see is `mode_not_routed`, never "no route". */
function roadRoutable(hint: DraftTransport | undefined): boolean {
  return hint === undefined || hint === 'car' || hint === 'four_wheel_drive' || hint === 'walk' || hint === 'bus' || hint === 'private_transfer' || hint === 'taxi' || hint === 'unknown';
}

/** V7 §8 — the transport hint an episode's own movement implies for a stop inside it that names none. */
function episodeHint(episode: DraftEpisode | null): DraftTransport | undefined {
  switch (episode?.mode) {
    case 'boat':
      return 'boat';
    case 'walk':
      return 'walk';
    case 'four_wheel_drive':
      return 'four_wheel_drive';
    case 'rail':
      return 'rail';
    case 'horse':
      return 'horse';
    case 'guide_or_lodge_transfer':
      return 'guide_or_lodge_transfer';
    case 'car':
      return 'car';
    default:
      return undefined;
  }
}

/** The traveller-facing verb for a leg inside an episode. */
function episodeLegLabel(episode: DraftEpisode): string {
  switch (episode.mode) {
    case 'boat':
      return 'Boat passage to';
    case 'walk':
      return 'On the trail to';
    case 'four_wheel_drive':
      return 'Game drive to';
    case 'rail':
      return 'By train to';
    case 'horse':
      return 'On horseback to';
    case 'bicycle':
      return 'By bike to';
    case 'guide_or_lodge_transfer':
      return 'With the guide to';
    default:
      return 'On to';
  }
}

/* ------------------------------------------------------------------ *
 * Anchor identity
 * ------------------------------------------------------------------ */

const EMPTY_PACKET: SkeletonEvidencePacket = {
  destination: { name: '', countryCode: null, scale: '' },
  tripLength: { days: 0, startDate: '', endDate: '' },
  traveller: {
    nights: 0,
    arrival: '',
    departure: '',
    pace: '',
    activityIntensity: '',
    transportPreference: '',
    carAvailable: false,
    maxDailyDriveMinutes: 0,
    maxDailyTravelMinutes: 0,
    desiredBaseCount: 1,
    maxBaseChanges: 0,
    strongInterests: [],
    hardAvoidances: [],
    mustDo: [],
    budget: '',
  },
  places: [],
  totalPlacesInPacket: 0,
  clusters: [],
  baseCandidates: [],
  routeLegs: [],
};

async function resolveDraftAnchor(
  anchor: DraftAnchor,
  context: ReconcileContext,
  notes: string[],
): Promise<Pick<ReconciledAnchor, 'verification' | 'identity' | 'place' | 'candidate' | 'method' | 'providerIdentity'>> {
  const target = normalizeName(anchor.name);
  /*
   * LIVE WORLD V1 — resolution order: persisted identity → board evidence →
   * compiled place → dedicated places provider → locality geocoder →
   * unresolved. Each step is real evidence of a different strength; none is
   * a world allow-list, and an unresolved name stays in the plan.
   */
  const persisted = context.persistedIdentities?.get(target);
  if (persisted) {
    return {
      verification: persisted.method === 'board' ? 'verified' : 'partially_verified',
      identity: { id: persisted.placeId, name: persisted.name, coordinates: persisted.coordinates },
      place: null,
      candidate: null,
      method: 'persisted',
      providerIdentity: { providerRef: persisted.providerRef ?? persisted.placeId, provider: persisted.provider, name: persisted.name, coordinates: persisted.coordinates, ...(persisted.placeClass ? { placeClass: persisted.placeClass } : {}), ...(persisted.confidence ? { confidence: persisted.confidence } : {}), ...(persisted.attribution ? { attribution: persisted.attribution } : {}) },
    };
  }
  const candidate = context.candidates.find((c) => normalizeName(displayNameOf(c.place)) === target || normalizeName(c.place.name) === target);
  if (candidate) {
    return { verification: 'verified', identity: identityFromPlace(candidate.place), place: candidate.place, candidate, method: 'board' };
  }
  const compiled = (context.compiledPlaces ?? []).find((p) => normalizeName(displayNameOf(p)) === target || normalizeName(p.name) === target);
  if (compiled) {
    return { verification: 'partially_verified', identity: identityFromPlace(compiled), place: compiled, candidate: null, method: 'compiled_place' };
  }
  if (!context.geocodeLocality && !context.resolvePlaceIdentity) return { verification: 'unverified', identity: null, place: null, candidate: null, method: null };
  if (context.deadlineReached?.()) {
    notes.push(`"${anchor.name}" was not looked up: the verification deadline had already passed.`);
    return { verification: 'unverified', identity: null, place: null, candidate: null, method: null };
  }
  if (context.resolvePlaceIdentity) {
    try {
      const found = await context.resolvePlaceIdentity({ name: anchor.name, ...(anchor.locality ? { locality: anchor.locality } : {}), category: anchor.category, near: context.region.baseCoordinates, radiusKm: context.region.maxRadiusKm });
      if (found && found.confidence !== 'weak') {
        const scope = assessGeographicScope({ point: found.coordinates, countryCode: found.countryCode, region: context.region, scope: context.destinationScope, subregions: context.subregionGeometries, evidenceCandidates: context.candidates });
        if (scope.accepted) {
          return {
            verification: 'partially_verified',
            // The plan keeps the name the model wrote; a provider's display name is matched against, never stored.
            identity: { id: `${found.provider}:${found.providerRef}`, name: anchor.name, coordinates: found.coordinates },
            place: null,
            candidate: null,
            method: 'places',
            providerIdentity: { ...found, name: anchor.name },
          };
        }
      }
    } catch {
      notes.push(`The places lookup for "${anchor.name}" failed; the locality geocoder was tried instead.`);
    }
  }
  if (!context.geocodeLocality) return { verification: 'unverified', identity: null, place: null, candidate: null, method: null };
  /*
   * V10 §5 — A ROUTE-DEFINING STOP GETS THE SAME LADDER A BASE GETS.
   *
   * One query per anchor was the V9 behaviour, and it fails for the same reason a
   * base's single query failed: a bare or thinly-qualified name is ambiguous
   * (three counties share it, two provinces have one each), and a hedge or a
   * containment locality the draft wrote for a *different* purpose is not a
   * geocoder qualifier. The ladder asks with the locality, the province and the
   * country, most-qualified first, and stops at the first accepted answer — so a
   * stop that places on the first query costs exactly what it always did.
   */
  const ladder = placementQueries({
    name: anchor.name,
    ...(anchor.locality ? { locality: anchor.locality } : {}),
    regionName: context.region.name,
    ...(context.destinationCountryName ? { countryName: context.destinationCountryName } : {}),
    ...(context.destinationDivisions ? { divisions: context.destinationDivisions } : {}),
  });
  let winner: ReturnType<typeof pickAnchorGeocoderWinner> = null;
  for (const [index, query] of ladder.slice(0, LADDER_LIMITS.route_defining_stop).entries()) {
    if (index > 0 && context.deadlineReached?.()) break;
    let results: readonly GeocodedLocality[];
    try {
      results = await context.geocodeLocality(query);
    } catch {
      notes.push(`The place lookup for "${anchor.name}" failed; it is kept as unverified.`);
      return { verification: 'unverified', identity: null, place: null, candidate: null, method: null };
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
    winner = pickAnchorGeocoderWinner(assessed.filter((a) => a.accepted));
    if (winner) break;
  }
  if (!winner) return { verification: 'unverified', identity: null, place: null, candidate: null, method: null };
  return {
    verification: 'partially_verified',
    identity: { id: winner.result.sourceId, name: winner.result.name, coordinates: { lat: winner.result.lat, lng: winner.result.lng } },
    place: null,
    candidate: null,
    method: 'geocoder',
  };
}

/**
 * V10 §8 — RESOLVE AND TIME BOTH GATEWAYS.
 *
 * The names come from the draft first — a gateway written as a stop is the
 * traveller's or the model's own statement about where the trip enters — and from
 * the destination's own gateway list second. Both are placed through the same
 * ladder the bases use, both transfers are measured through the same memo the
 * base moves use, and an unresolved "X or Y airport" is carried as unresolved
 * rather than collapsed to one of them.
 */
async function resolveGateways(input: {
  draft: TripDraft;
  context: ReconcileContext;
  bases: readonly ResolvedBase[];
  ledger: ReturnType<typeof emptyLedger>;
  confirmationMemo: ConfirmationMemo;
  placements: RouteCriticalPlacement[];
  deviations: SkeletonDeviation[];
  deadline: () => boolean;
  onCalls: (n: number) => void;
}): Promise<GatewayPlan | null> {
  const { draft, context, bases } = input;
  const firstBase = bases[0] ?? null;
  const finalBase = bases[bases.length - 1] ?? null;
  const lastDay = draft.days[draft.days.length - 1];

  /** A gateway name the draft wrote on a given day, if any. */
  const namedOn = (day: TripDraft['days'][number] | undefined): string | null => {
    for (const anchor of day?.anchors ?? []) if (anchorKindOf(anchor) === 'gateway') return anchor.name;
    const move = day?.move;
    if (move?.via && isGatewayName(move.via)) return move.via;
    return null;
  };
  const arrivalName = namedOn(draft.days[0]) ?? context.destinationGateways?.[0]?.label ?? null;
  const departureName = namedOn(lastDay) ?? arrivalName;
  /*
   * V10 §8 — A TRIP HAS EDGES EVEN WHEN NOBODY NAMED A TERMINAL.
   *
   * A country typed as a bare name resolves no gateway — the interpreter is not
   * asked about a country and the draft may name none — and before this that
   * meant the whole of §8 produced nothing. The founder's last day is exactly
   * that: breakfast at 09:00 against an 11:00 flight, with no arithmetic anywhere
   * because there was no airport to do arithmetic about. With no terminal there
   * is still a departure time and a final base, which is enough for a
   * conservative window and never enough for a measurement.
   */
  if (!arrivalName && !departureName) {
    if (!finalBase && !firstBase) return null;
    return buildGatewayPlan({
      ...(firstBase ? { firstBase: { id: firstBase.skeletonBaseId, name: firstBase.displayName ?? firstBase.name } } : {}),
      ...(finalBase ? { finalBase: { id: finalBase.skeletonBaseId, name: finalBase.displayName ?? finalBase.name } } : {}),
      arrivalMinute: minutesOfClock(context.basics.arrivalTime),
      departureMinute: minutesOfClock(context.basics.departureTime),
      arrivalStated: context.basics.arrivalPrecision === 'exact',
      departureStated: context.basics.departurePrecision === 'exact',
      selfDrive: context.profile.transport.willDrive,
      assumedTransferMinutes: ASSUMED_GATEWAY_TRANSFER_MINUTES,
    });
  }

  const placeGateway = async (name: string, role: 'arrival' | 'departure' | 'both'): Promise<GatewayNode | null> => {
    const unresolved = gatewayIsUnresolved(name);
    const id = `gateway:${normalizeName(name).replace(/\s+/g, '-') || role}`;
    const known = context.destinationGateways?.find((g) => normalizeName(g.label) === normalizeName(name));
    let coordinates = known?.coordinates ?? null;
    const attempts: PlacementAttempt[] = [];
    if (!coordinates && !unresolved && context.geocodeLocality && !input.deadline()) {
      const ladder = placementQueries({
        name,
        regionName: context.region.name,
        ...(context.destinationCountryName ? { countryName: context.destinationCountryName } : {}),
        ...(context.destinationDivisions ? { divisions: context.destinationDivisions } : {}),
      });
      for (const query of ladder.slice(0, LADDER_LIMITS.gateway)) {
        let rows: readonly GeocodedLocality[];
        try {
          rows = await context.geocodeLocality(query);
        } catch {
          attempts.push({ query, outcome: 'provider_unavailable' });
          break;
        }
        input.onCalls(1);
        const accepted = rows.filter((r) => assessGeographicScope({ point: r, countryCode: r.countryCode, region: context.region, scope: context.destinationScope, subregions: context.subregionGeometries, evidenceCandidates: context.candidates }).accepted);
        attempts.push({ query, outcome: accepted.length > 0 ? 'placed' : 'no_acceptable_candidate', candidates: rows.length });
        const hit = accepted[0];
        if (hit) {
          coordinates = { lat: hit.lat, lng: hit.lng };
          break;
        }
      }
    }
    const placement: RouteCriticalPlacement = {
      id,
      name,
      kind: 'gateway',
      outcome: coordinates ? 'placed' : unresolved ? 'ambiguous' : !context.geocodeLocality ? 'no_provider' : attempts.length === 0 ? 'not_attempted' : (attempts[attempts.length - 1]!.outcome === 'provider_unavailable' ? 'provider_unavailable' : 'no_acceptable_candidate'),
      ...(coordinates ? { coordinates } : {}),
      attempts: attempts.slice(0, 8),
    };
    const note = placement.outcome === 'placed' ? undefined : describeUnplaced(placement);
    input.placements.push(note ? { ...placement, travellerNote: note } : placement);
    if (placement.outcome !== 'placed') {
      input.deviations.push({ kind: 'route_critical_unplaced', detail: `"${name}" is the trip's ${role} gateway and could not be placed. Asked: ${attempts.map((a) => `"${a.query}" (${a.outcome.replace(/_/g, ' ')})`).join('; ') || 'nothing'}.` });
    }
    return gatewayNodeSchema.parse({
      id,
      name,
      kind: gatewayKindFor(name),
      role,
      ...(coordinates ? { coordinates } : {}),
      fixed: false,
      travellerStated: false,
      unresolved,
    });
  };

  const sameGateway = arrivalName !== null && departureName !== null && normalizeName(arrivalName) === normalizeName(departureName);
  const arrival = arrivalName ? await placeGateway(arrivalName, sameGateway ? 'both' : 'arrival') : null;
  const departure = sameGateway ? arrival : departureName ? await placeGateway(departureName, 'departure') : null;

  /* Both transfers, measured through the same memo the base moves use. */
  const measure = async (from: { id: string; coordinates: { lat: number; lng: number } } | null, to: { id: string; coordinates: { lat: number; lng: number } } | null): Promise<GatewayTransfer> => {
    if (!from || !to) return { basis: 'unmeasured' };
    const memo = input.confirmationMemo.get(`${from.id}=>${to.id}`) ?? input.confirmationMemo.get(`${to.id}=>${from.id}`);
    if (memo?.minutes !== undefined && memo.minutes !== null) return { minutes: Math.round(memo.minutes), ...(memo.km !== undefined && memo.km !== null ? { km: Math.round(memo.km) } : {}), basis: 'measured' };
    if (!context.confirmRoute || input.deadline()) return { basis: 'unmeasured' };
    const leg = await confirmMandatoryLeg(input.ledger, input.confirmationMemo, context.confirmRoute, { id: from.id, name: from.id, coordinates: from.coordinates }, { id: to.id, name: to.id, coordinates: to.coordinates });
    if (leg?.minutes !== undefined && leg.minutes !== null) return { minutes: Math.round(leg.minutes), ...(leg.km !== undefined && leg.km !== null ? { km: Math.round(leg.km) } : {}), basis: 'measured' };
    return { basis: 'unmeasured' };
  };
  const asPoint = (node: GatewayNode | null) => (node?.coordinates ? { id: node.id, coordinates: node.coordinates } : null);
  const basePoint = (base: ResolvedBase | null) => (base?.identity ? { id: base.identity.id, coordinates: base.identity.coordinates } : null);
  const arrivalTransfer = await measure(asPoint(arrival), basePoint(firstBase));
  const departureTransfer = sameGateway && firstBase === finalBase ? arrivalTransfer : await measure(basePoint(finalBase), asPoint(departure));

  return buildGatewayPlan({
    ...(arrival ? { arrival } : {}),
    ...(departure ? { departure } : {}),
    ...(firstBase ? { firstBase: { id: firstBase.skeletonBaseId, name: firstBase.displayName ?? firstBase.name } } : {}),
    ...(finalBase ? { finalBase: { id: finalBase.skeletonBaseId, name: finalBase.displayName ?? finalBase.name } } : {}),
    arrivalTransfer,
    departureTransfer,
    arrivalMinute: minutesOfClock(context.basics.arrivalTime),
    departureMinute: minutesOfClock(context.basics.departureTime),
    /* `exact` is the traveller stating a time; every other precision is Sidequest assuming one, which §8 requires a conservative window for. */
    arrivalStated: context.basics.arrivalPrecision === 'exact',
    departureStated: context.basics.departurePrecision === 'exact',
    selfDrive: context.profile.transport.willDrive,
  });
}

/** What kind of terminal a name reads as. Generic words only; never a place name. */
function gatewayKindFor(name: string): GatewayNode['kind'] {
  const text = name.toLowerCase();
  if (/\b(airport|international|airfield|aerodrome)\b/.test(text)) return 'airport';
  if (/\b(station|hbf|termini|centraal|gare)\b/.test(text)) return 'rail_station';
  if (/\b(ferry|harbour|harbor|port|pier|quay)\b/.test(text)) return 'ferry_port';
  if (/\b(bus terminal|coach station|bus station)\b/.test(text)) return 'bus_station';
  if (/\b(border|crossing|frontier)\b/.test(text)) return 'land_border';
  if (/\bcruise\b/.test(text)) return 'cruise_port';
  return 'airport';
}

/** `HH:MM` as a minute of the day, or null when the string is not a clock. */
function minutesOfClock(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * V10 §5 — one route-critical placement row for one base, and the deviation that
 * goes with it when nothing placed it.
 *
 * The `base_unresolved` deviation already existed and said "kept by name, legs
 * unmeasured". What it never said was *what was asked*, which is why three
 * ordinary town names could fail on a live trip and leave no trace anybody could
 * act on. This row carries every query.
 */
function recordBasePlacement(input: {
  base: { id: string; name: string };
  identity: ResolvedBaseIdentity | null;
  attempts: readonly PlacementAttempt[];
  ambiguous: boolean;
  unavailable: boolean;
  placements: RouteCriticalPlacement[];
  deviations: SkeletonDeviation[];
  hasProvider: boolean;
}): void {
  const outcome: RouteCriticalPlacement['outcome'] = input.identity
    ? 'placed'
    : input.unavailable
      ? 'provider_unavailable'
      : input.ambiguous
        ? 'ambiguous'
        : !input.hasProvider
          ? 'no_provider'
          : input.attempts.length === 0
            ? 'not_attempted'
            : 'no_acceptable_candidate';
  const placement: RouteCriticalPlacement = {
    id: `base:${input.base.id}`,
    name: input.base.name,
    kind: 'base',
    outcome,
    ...(input.identity ? { coordinates: input.identity.coordinates } : {}),
    attempts: input.attempts.slice(0, 8),
  };
  const note = outcome === 'placed' ? undefined : describeUnplaced(placement);
  input.placements.push(note ? { ...placement, travellerNote: note } : placement);
  if (outcome !== 'placed') {
    input.deviations.push({
      kind: 'route_critical_unplaced',
      detail: `"${input.base.name}" is a base and could not be placed on the map. Asked: ${input.attempts.map((a) => `"${a.query}" (${a.outcome.replace(/_/g, ' ')})`).join('; ') || 'nothing — no lookup was attempted'}.`,
    });
  }
}

/** See the call site: resolves the "ambiguous" cases that are really one place, never a genuine tie between two towns. */
function settleAmbiguousBase(candidates: readonly { sourceId: string; name: string; coordinates: { lat: number; lng: number }; isLocality: boolean; importance?: number; geographicScopeOutcome: string }[]) {
  const accepted = candidates.filter((c) => c.geographicScopeOutcome.startsWith('accepted'));
  const localities = accepted.filter((c) => c.isLocality);
  const pool = localities.length > 0 ? localities : accepted;
  if (pool.length === 0) return null;
  const ranked = [...pool].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const top = ranked[0]!;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const SAME_SETTLEMENT_KM = 10;
  if (ranked.slice(1).every((c) => kmBetween(top.coordinates, c.coordinates) <= SAME_SETTLEMENT_KM)) return top;
  const second = ranked[1]!;
  if (typeof top.importance === 'number' && typeof second.importance === 'number' && top.importance - second.importance >= 0.05) return top;
  return null;
}

/**
 * V10 §5 — THE TOWN A BASE NAMES, NOT THE PROVINCE IT SITS IN.
 *
 * `base.locality` has always been the traveller-facing display name for a base,
 * because a draft may name the hotel and put the town in the locality
 * ("Harbour View Inn" / "Reykjavík"). For a region spanning two provinces a draft
 * writes the locality the other way round — "Jasper" / "Alberta, Canada" — and the
 * base then displayed, and was routed under, the name of a province. A province is
 * not somewhere anybody sleeps.
 *
 * So a locality is a display name only while it is at least as specific as the
 * base's own name. A locality that is one of the destination's own jurisdictions —
 * a country or a first-level division — is context, and the base keeps its name.
 */
function baseLocalityName(base: { name: string; locality?: string }, jurisdictions: readonly string[]): string {
  const locality = base.locality?.trim();
  if (!locality) return base.name;
  const parts = locality.split(',').map((part) => normalizeName(part)).filter(Boolean);
  if (parts.length === 0) return base.name;
  const known = new Set(jurisdictions.map((name) => normalizeName(name)).filter(Boolean));
  /* Every part of the locality is a jurisdiction ("Alberta, Canada"): it locates the base, it does not name it. */
  if (parts.every((part) => known.has(part))) return base.name;
  return locality;
}

/** What kind of place the draft says the traveller sleeps in. Lodges and camps keep their own names; towns are localities. */
function draftBaseKind(base: { name: string; lodgingStyle?: string; lodgingArea?: string; overnight?: string }): BaseKind {
  const text = `${base.name} ${base.lodgingStyle ?? ''}`;
  /*
   * V7 §8 — A NIGHT ON A SHIP OR A SLEEPER IS NOT A TOWN. The bed moves; the
   * geocoder must never be asked to place "the cruise ship", and no surface may
   * offer parking, a neighbourhood or a hotel booking for it.
   */
  if (base.overnight === 'boat' || base.overnight === 'train' || /\b(cruise ship|river ship|the ship|aboard|on board|sleeper train|liveaboard)\b/i.test(text)) return 'vessel';
  if (base.overnight === 'hut' || base.overnight === 'refuge' || (base.overnight === 'tent' && /\b(trail|trek|camp)\b/i.test(text))) return 'trail_camp';
  if (/\b(tented|camp|campsite|bush camp|mobile camp)\b/i.test(text)) return 'camp';
  if (/\b(lodge|homestay|hut|cabin|ranch|estancia|ryokan|farm ?stay|eco.?lodge|retreat|manor|castle hotel)\b/i.test(text)) return 'lodge';
  if (/\b(hotel|inn|guesthouse|hostel|resort|b&b|apartment|riad|pousada|pension|villa)\b/i.test(base.name)) return 'lodging_property';
  if (/\b(quarter|district|neighbourhood|neighborhood|old town|centre|center|downtown)\b/i.test(base.name)) return 'neighbourhood';
  return 'locality';
}

/**
 * The traveller-facing base name. A lodge or camp is what the draft called
 * it; a town is the draft's own locality whenever the matched record names
 * the same settlement ("Kinsale Urban" ⊃ "Kinsale", "Reykjavík" ≈ "Reykjavik")
 * or is a landmark inside it; only a settlement record with a genuinely
 * different name (a spelling the geocoder corrected) replaces the draft's.
 */
function baseDisplayName(input: { kind: BaseKind; draftName: string; localityName: string; canonicalName: string | undefined; landmark: boolean }): string {
  if (input.kind === 'lodge' || input.kind === 'camp' || input.kind === 'lodging_property' || input.kind === 'vessel' || input.kind === 'trail_camp') return input.draftName;
  if (!input.canonicalName || input.landmark) return input.localityName;
  const canonical = normalizeName(input.canonicalName);
  const draftName = normalizeName(input.draftName);
  const locality = normalizeName(input.localityName);
  // The same settlement under its own spelling ("Reykjavík" for "Reykjavik") keeps the record's spelling; an administrative variant ("Kinsale Urban", "Zanzibar City") yields to the traveller's word.
  if (canonical === draftName || canonical === locality) return input.canonicalName;
  if (canonical.includes(draftName) || draftName.includes(canonical)) return input.draftName;
  if (canonical.includes(locality) || locality.includes(canonical)) return input.localityName;
  return input.canonicalName;
}

/* ------------------------------------------------------------------ *
 * Weather summary — read, never fetched
 * ------------------------------------------------------------------ */

function nearestWeatherLocation(dataset: WeatherDataset, point: { lat: number; lng: number } | null) {
  if (dataset.locations.length === 0) return null;
  if (!point) return dataset.locations[0]!;
  let best = dataset.locations[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const loc of dataset.locations) {
    const d = (loc.coordinates.lat - point.lat) ** 2 + (loc.coordinates.lng - point.lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = loc;
    }
  }
  return best;
}

function weatherSummaryFor(dataset: WeatherDataset, date: string, point: { lat: number; lng: number } | null): DayWeatherSummary {
  const location = nearestWeatherLocation(dataset, point);
  const day: DayWeather | undefined = location ? dataset.days.find((d) => d.locationId === location.id && d.date === date) : undefined;
  const solar = location ? dataset.solar.find((s) => s.locationId === location.id && s.date === date) : undefined;
  const base = {
    ...(location ? { locationId: location.id, locationLabel: location.label } : {}),
    ...(solar ? { sunriseMinute: solar.sunriseMinute, sunsetMinute: solar.sunsetMinute } : {}),
    decisions: [] as string[],
    cautions: [] as string[],
    backups: [] as DayWeatherSummary['backups'],
  };
  if (!day || day.kind === 'unavailable') {
    return {
      evidence: 'unavailable',
      summary: day ? `We could not get weather for this date. ${day.message}` : 'We have no weather for this day, so nothing here was placed against it.',
      precipitationProbabilityPercent: null,
      ...base,
      provider: day?.attemptedProvider ?? 'none',
      attribution: 'Nothing here has been checked against the weather.',
    };
  }
  if (day.kind === 'historical_pattern') {
    return {
      evidence: 'historical_pattern',
      summary:
        `Typically ${Math.round(day.temperatureMaxC.p50)} °C here at this time of year, with ${Math.round(day.wetDayFrequency * 100)}% of days in this period wet. ` +
        `This is what the last ${day.sampleYearTo - day.sampleYearFrom + 1} years have done, not a forecast for this date.`,
      temperatureMaxC: day.temperatureMaxC.p50,
      temperatureMinC: day.temperatureMinC.p50,
      precipitationProbabilityPercent: null,
      windGustMaxKph: day.windGustKphP90,
      ...base,
      provider: day.attribution.provider,
      attribution: day.attribution.notice,
    };
  }
  return {
    evidence: 'forecast',
    summary: `Forecast ${day.condition.replace(/_/g, ' ')}, ${Math.round(day.temperatureMinC)}–${Math.round(day.temperatureMaxC)} °C${day.precipitationProbabilityPercent !== null ? `, ${day.precipitationProbabilityPercent}% chance of rain` : ''}.`,
    temperatureMaxC: day.temperatureMaxC,
    temperatureMinC: day.temperatureMinC,
    precipitationProbabilityPercent: day.precipitationProbabilityPercent,
    precipitationMm: day.precipitationMm,
    snowfallCm: day.snowfallCm,
    windGustMaxKph: day.windGustMaxKph,
    condition: day.condition,
    fetchedAt: day.fetchedAt,
    staleAfterMinutes: day.staleAfterMinutes,
    ...base,
    provider: day.attribution.provider,
    attribution: day.attribution.notice,
  };
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

export async function reconcileTripDraft(input: { draft: TripDraft; context: ReconcileContext }): Promise<ReconcileResult> {
  const { draft, context } = input;
  /** V10 §15 — wall clock for the placement pass, reported rather than guessed at. */
  const reconcileStartedMs = Date.now();
  const deviations: SkeletonDeviation[] = [];
  const providerNotes: string[] = [];
  const revisions: RevisionAction[] = [];
  const issues: ValidationIssue[] = [];
  const dates = tripDates(context.basics.startDate, context.basics.endDate);
  const config = resolveConfig();
  const backBy = context.profile.interview?.mustBeBackByMinute;
  /*
   * PRODUCTION LOCK V5 §13 — A DAY WITH AN EVENING IN IT RUNS INTO THE EVENING.
   *
   * The default day ends at 18:00–20:00 depending on pace. A live Hong Kong
   * build put Temple Street NIGHT Market at 13:30 for exactly that reason: the
   * scheduler's floor could not hold it back to 18:00 because 18:00 plus the
   * visit ran past a 19:00 day, so the floor was skipped and the traveller was
   * sent to a night market in the early afternoon.
   *
   * A traveller who accepted a night market has asked for a late evening on that
   * day, and only that day. So the window is extended to hold it — never for a
   * day that has no such experience, and never against somebody who said they do
   * not want late nights or who has to be back at base by a stated time.
   */
  const lateIntent: Record<string, number> = { evening: 21 * 60, night: 22 * 60, sunset: 20 * 60 };
  const refusesLateNights = context.profile.interview?.lateNights === 'no';
  const latestFor = (dayNumber: number): number | null => {
    if (refusesLateNights || backBy !== undefined) return null;
    const day = draft.days.find((entry) => entry.dayNumber === dayNumber);
    const wanted = (day?.anchors ?? []).map((anchor) => lateIntent[anchor.timeOfDay ?? ''] ?? 0);
    const latest = Math.max(0, ...wanted);
    return latest > 0 ? latest : null;
  };
  /*
   * V6 — A DAY WITH A SUNRISE IN IT STARTS BEFORE DAWN.
   *
   * The mirror of the evening rule. A live Madhya Pradesh build put a dawn
   * tiger safari at 10:30 because the day opened at the traveller's usual
   * 09:00 and a floor can only push a stop later. A sunrise stop the model
   * composed and the traveller will see is a request for one early morning,
   * on that day only; the window opens at 05:30 for it and says so. Never
   * the arrival day, whose start is the arrival itself.
   */
  const DAWN_START = 5 * 60 + 30;
  const earliestFor = (dayNumber: number): number | null => {
    const day = draft.days.find((entry) => entry.dayNumber === dayNumber);
    return (day?.anchors ?? []).some((anchor) => anchor.timeOfDay === 'sunrise') ? DAWN_START : null;
  };
  const windows: PlannedDay[] = buildDailyWindows(context.basics, context.profile, config).map((day, index, all) => {
    const isLastDay = index === all.length - 1;
    const early = index === 0 ? null : earliestFor(day.dayNumber);
    if (early !== null && early < day.window.startMinute) {
      day = {
        ...day,
        window: { ...day.window, startMinute: early, usableMinutes: day.window.endMinute - early, note: [day.window.note, 'This day starts before dawn for something that only happens then.'].filter(Boolean).join(' ') },
        capacityMinutes: day.capacityMinutes + (day.window.startMinute - early),
      };
    }
    const late = isLastDay ? null : latestFor(day.dayNumber);
    if (late !== null && late > day.window.endMinute) {
      day = {
        ...day,
        window: { ...day.window, endMinute: late, usableMinutes: late - day.window.startMinute, note: [day.window.note, 'This day runs into the evening for something that only happens then.'].filter(Boolean).join(' ') },
        capacityMinutes: day.capacityMinutes + (late - day.window.endMinute),
      };
    }
    if (index === all.length - 1 && context.lastDayLeaveByMinute !== undefined && context.lastDayLeaveByMinute < day.window.endMinute) {
      const endMinute = Math.max(day.window.startMinute, context.lastDayLeaveByMinute);
      day = { ...day, window: { ...day.window, endMinute, usableMinutes: endMinute - day.window.startMinute, note: [day.window.note, `Leave base by ${formatClock(endMinute)} for your booked departure.`].filter(Boolean).join(' ') }, capacityMinutes: Math.min(day.capacityMinutes, endMinute - day.window.startMinute) };
    }
    /*
     * A hard "back at base by" hour closes every day's window at that minute,
     * on top of the pace-derived end and the departure edge. Hard because the
     * traveller made it hard (`profile.hard`), so the window is the rule and
     * the layout below gives it no tolerance.
     */
    if (backBy === undefined || backBy >= day.window.endMinute) return day;
    const endMinute = Math.max(day.window.startMinute, backBy);
    return {
      ...day,
      window: { ...day.window, endMinute, usableMinutes: endMinute - day.window.startMinute, note: [day.window.note, `Back at base by ${formatClock(backBy)}, as you asked.`].filter(Boolean).join(' ') },
      capacityMinutes: Math.min(day.capacityMinutes, endMinute - day.window.startMinute),
    };
  });
  const deadline = () => context.deadlineReached?.() ?? false;

  // --- Bases: deterministic identity, never the model ------------------------
  /*
   * PRODUCT RECOVERY V1 — A BASE IS A PLACE TO SLEEP, NAMED FOR THE TRAVELLER.
   *
   * The live Ireland build asked the geocoder for "Dublin, Dublin, Ireland"
   * (name and locality doubled) and took the single hit it got back — Trinity
   * College Dublin — as the overnight base; "Dingle" became Dingle Distillery
   * and "Kinsale" read as the administrative "Kinsale Urban". Three rules now
   * stand between a geocoder record and a base name: the locality is asked
   * for once, never doubled; a landmark that answers for a town is kept for
   * its position only when it sits inside that town, and a settlement is
   * looked for once more; and the traveller-facing name is the draft's own
   * locality (or the lodge/camp the draft meant), never the record's label.
   */
  const episodes = episodesOf(draft);
  /** V10 §5 — the destination's own jurisdiction names, so a base's locality cannot be mistaken for its name. */
  const jurisdictionNames = [...(context.destinationDivisions ?? []), ...(context.destinationCountryName ? [context.destinationCountryName] : [])];
  const baseResolutions = await mapConcurrent(draft.bases, BASE_RESOLUTION_CONCURRENCY, async (base) => {
    if (draftBaseKind(base) === 'vessel') {
      /* V7 §8 — a ship or a sleeper is placed by its route, never by a geocoder. */
      return { base, outcome: null, settled: null, landmarkFallback: false, secondLookup: null as { name: string; sourceId: string; coordinates: { lat: number; lng: number } } | null, vessel: true };
    }
    if (deadline()) {
      providerNotes.push(`Base "${base.name}" was not looked up: the verification deadline had passed.`);
      return { base, outcome: null, settled: null, landmarkFallback: false, secondLookup: null as { name: string; sourceId: string; coordinates: { lat: number; lng: number } } | null };
    }
    const localityName = baseLocalityName(base, jurisdictionNames);
    const query = base.locality && normalizeName(base.locality) !== normalizeName(base.name) ? `${base.name}, ${base.locality}` : base.name;
    /*
     * V10 §5 — THE PLACEMENT LADDER, FOR THE ONE ANCHOR CLASS THAT DECIDES THE
     * ROUTE.
     *
     * A base is where the traveller sleeps, and an unplaced base takes its
     * transfers, its day's order check and the trip's feasibility verdict with
     * it. So it is asked with every context there is — its locality, its
     * province, its country — and with the draft's own hedge words stripped,
     * stopping at the first answer the geographic screen accepts. The ladder
     * spends at most one extra request per base beyond what V9 spent, because
     * the first tier is the *most* qualified query rather than the least.
     */
    const ladder = placementQueries({
      name: base.name,
      ...(base.locality && normalizeName(base.locality) !== normalizeName(base.name) ? { locality: base.locality } : {}),
      regionName: context.region.name,
      ...(context.destinationCountryName ? { countryName: context.destinationCountryName } : {}),
      ...(context.destinationDivisions ? { divisions: context.destinationDivisions } : {}),
    });
    const attempts: PlacementAttempt[] = [];
    let outcome: Awaited<ReturnType<typeof resolveSkeletonBase>> | null = null;
    for (const [index, geocodeQuery] of ladder.slice(0, LADDER_LIMITS.base).entries()) {
      if (index > 0 && deadline()) break;
      const attempt = await resolveSkeletonBase({ id: base.id, placeIndex: null, name: query, nights: base.nights, why: base.why }, EMPTY_PACKET, context, { geocodeQuery });
      /*
       * "Several matches, all the same settlement" is not an ambiguity — the
       * settler resolves it — so the attempt records what actually happened
       * rather than the raw verdict. Otherwise the ladder's own diagnostics say a
       * base was ambiguous when it was placed.
       */
      const settledHere = attempt.ambiguous && attempt.candidates ? settleAmbiguousBase(attempt.candidates) : null;
      const placed = Boolean((attempt.identity && !attempt.ambiguous) || settledHere);
      attempts.push({
        query: geocodeQuery,
        outcome: placed ? 'placed' : attempt.ambiguous ? 'ambiguous' : attempt.geographicScopeOutcome === 'geocoder_unavailable' ? 'provider_unavailable' : 'no_acceptable_candidate',
        ...(attempt.candidates ? { candidates: attempt.candidates.length } : {}),
      });
      outcome = attempt;
      /* An identity, or an ambiguity the settler can resolve, ends the ladder: asking again would only add noise. */
      if (placed) break;
      /* A provider that is down will be down for the next query too. */
      if (attempt.geographicScopeOutcome === 'geocoder_unavailable') break;
    }
    if (!outcome) outcome = await resolveSkeletonBase({ id: base.id, placeIndex: null, name: query, nights: base.nights, why: base.why }, EMPTY_PACKET, context);
    const settled = outcome.ambiguous && outcome.candidates ? settleAmbiguousBase(outcome.candidates) : null;
    const identity = settled ? { id: settled.sourceId, name: settled.name, coordinates: settled.coordinates } : outcome.identity && !outcome.ambiguous ? outcome.identity : null;
    const hitIsLocality = settled ? settled.isLocality : outcome.candidates?.find((c) => c.sourceId === identity?.id)?.isLocality ?? (outcome.method && outcome.method !== 'geocoder' ? true : undefined);
    const kind = draftBaseKind(base);
    let secondLookup: { name: string; sourceId: string; coordinates: { lat: number; lng: number } } | null = null;
    let landmarkFallback = false;
    if (identity && hitIsLocality === false && (kind === 'locality' || kind === 'neighbourhood') && context.geocodeLocality && !deadline()) {
      // A landmark answered for a town. Ask for the town itself, once, and take a settlement near the landmark.
      try {
        const results = normalizeName(query) === normalizeName(localityName) ? [] : await context.geocodeLocality(`${localityName}, ${context.region.name}`);
        const settlements = results
          .filter((r) => isLocalityCandidate(r))
          .filter((r) => assessGeographicScope({ point: r, countryCode: r.countryCode, region: context.region, scope: context.destinationScope, subregions: context.subregionGeometries, evidenceCandidates: context.candidates }).accepted)
          .map((r) => ({ r, km: haversineKm(identity.coordinates, r) }))
          .sort((a, b) => a.km - b.km);
        const pick = settlements.find((c) => c.km <= LANDMARK_WITHIN_TOWN_KM) ?? [...settlements].sort((a, b) => (b.r.importance ?? 0) - (a.r.importance ?? 0))[0];
        if (pick) secondLookup = { name: pick.r.name, sourceId: pick.r.sourceId, coordinates: { lat: pick.r.lat, lng: pick.r.lng } };
        else landmarkFallback = true;
      } catch {
        landmarkFallback = true;
      }
    }
    return { base, outcome, settled, landmarkFallback, secondLookup, attempts };
  });
  let bases: ResolvedBase[] = [];
  /** V10 §5 — every route-critical placement, placed or not, with what was asked. */
  const placements: RouteCriticalPlacement[] = [];
  let placementCalls = 0;
  for (const resolution of baseResolutions) {
    const { base, outcome, settled, secondLookup, landmarkFallback } = resolution;
    const attempts: PlacementAttempt[] = ('attempts' in resolution ? resolution.attempts : undefined) ?? [];
    placementCalls += attempts.length;
    const kind = draftBaseKind(base);
    const localityName = baseLocalityName(base, jurisdictionNames);
    if (!outcome) {
      if ('vessel' in resolution && resolution.vessel) {
        const episode = episodes.find((e) => draft.days.some((d) => d.baseId === base.id && d.dayNumber >= e.fromDay && d.dayNumber <= e.toDay));
        bases.push({ skeletonBaseId: base.id, name: base.name, nights: base.nights, identity: null, displayName: base.name, locality: localityName, baseKind: 'vessel', ...(episode ? { episode: episode.name } : {}) });
        continue;
      }
      recordBasePlacement({ base, identity: null, attempts, ambiguous: false, unavailable: false, placements, deviations, hasProvider: Boolean(context.geocodeLocality) });
      bases.push({ skeletonBaseId: base.id, name: base.name, nights: base.nights, identity: null, displayName: kind === 'lodge' || kind === 'camp' || kind === 'vessel' || kind === 'trail_camp' ? base.name : localityName, locality: localityName, baseKind: kind });
      continue;
    }
    let identity: ResolvedBaseIdentity | null = null;
    if (secondLookup) {
      identity = { id: secondLookup.sourceId, name: secondLookup.name, coordinates: secondLookup.coordinates };
      deviations.push({ kind: 'base_resolved_via_geocoder', detail: `"${base.name}" first matched a landmark (${settled?.name ?? outcome.identity?.name ?? 'a non-settlement record'}); the town itself (${secondLookup.name}) was looked up and is the base.`, replacementPlaceId: secondLookup.sourceId });
    } else if (settled) {
      deviations.push({ kind: 'base_resolved_via_geocoder', detail: `"${base.name}" resolved through a deterministic geocoder lookup (${settled.name}; the other matches were the same settlement or not a settlement).`, replacementPlaceId: settled.sourceId });
      identity = { id: settled.sourceId, name: settled.name, coordinates: settled.coordinates };
    } else if (outcome.identity && !outcome.ambiguous) {
      if (outcome.method === 'geocoder') {
        deviations.push({ kind: 'base_resolved_via_geocoder', detail: `"${base.name}" resolved through a deterministic geocoder lookup (${outcome.identity.name}).${landmarkFallback ? ' The record is a landmark inside the town; the base is named for the town and placed at that point.' : ''}`, replacementPlaceId: outcome.identity.id });
      }
      // A base that resolved to the region's own home base through a board
      // place record is routed under the matrix's routing id for that base,
      // so its legs are measured rather than left unmeasured over an id mismatch.
      identity =
        !context.matrix.ids.includes(outcome.identity.id) && context.matrix.ids.includes(context.baseId) && normalizeName(outcome.identity.name) === normalizeName(context.region.baseName)
          ? { ...outcome.identity, id: context.baseId }
          : outcome.identity;
    } else {
      deviations.push({
        kind: 'base_unresolved',
        detail: outcome.ambiguous
          ? `"${base.name}" matched more than one real place equally well; kept by name without a coordinate, so legs to and from it are unmeasured.`
          : `"${base.name}" could not be confirmed as a real place by the board, the compiled region or a geocoder; kept by name, legs unmeasured.`,
      });
    }
    const canonicalName = identity?.name;
    const displayName = baseDisplayName({ kind, draftName: base.name, localityName, canonicalName, landmark: landmarkFallback || (identity !== null && !secondLookup && (settled ? !settled.isLocality : outcome.candidates?.find((c) => c.sourceId === identity?.id)?.isLocality === false)) });
    recordBasePlacement({ base, identity, attempts, ambiguous: Boolean(outcome.ambiguous && !settled), unavailable: outcome.geographicScopeOutcome === 'geocoder_unavailable', placements, deviations, hasProvider: Boolean(context.geocodeLocality) });
    bases.push({ skeletonBaseId: base.id, name: base.name, nights: base.nights, identity, displayName, ...(canonicalName ? { canonicalName } : {}), locality: localityName, baseKind: kind });
  }
  // Consecutive same-identity stays merge; a loop's return is not a duplicate.
  const merged: ResolvedBase[] = [];
  for (const base of bases) {
    const previous = merged[merged.length - 1];
    if (previous?.identity && base.identity && previous.identity.id === base.identity.id) {
      previous.nights += base.nights;
      continue;
    }
    merged.push({ ...base });
  }
  bases = merged;

  /*
   * QUALITY V1 — THE DAY SEQUENCE IS THE TRUTH ABOUT WHERE THE TRAVELLER SLEEPS.
   *
   * The draft states nights per base *and* a base per day, and the two can
   * disagree: the live Tasmania loop declared Hobart once with two nights and
   * then slept there on night seven as well, so the cumulative-nights
   * assignment put the traveller in Cradle Mountain while the day was in
   * Hobart. Every day names its bed; a run of days at one base is one stay,
   * and a base revisited later is a second stay of the same place (a loop's
   * return, never a duplicate). Only when every day names a base the draft
   * declared — otherwise the declared list stands and the scaling below
   * keeps the arithmetic honest.
   */
  {
    const nightDays = draft.days.slice(0, Math.max(0, dates.length - 1));
    const byRoot = new Map(bases.map((b) => [b.skeletonBaseId, b] as const));
    const runs: { id: string; nights: number }[] = [];
    for (const day of nightDays) {
      const last = runs[runs.length - 1];
      if (last && last.id === day.baseId) last.nights += 1;
      else runs.push({ id: day.baseId, nights: 1 });
    }
    const knownRuns = runs.length > 0 && runs.every((run) => byRoot.has(run.id));
    const declared = bases.map((b) => `${b.skeletonBaseId}:${b.nights}`).join(',');
    const sequenced = runs.map((run) => `${run.id}:${run.nights}`).join(',');
    if (knownRuns && declared !== sequenced) {
      const seen = new Map<string, number>();
      const stays: ResolvedBase[] = runs.map((run) => {
        const root = byRoot.get(run.id)!;
        const visit = (seen.get(run.id) ?? 0) + 1;
        seen.set(run.id, visit);
        return { ...root, skeletonBaseId: visit === 1 ? root.skeletonBaseId : `${root.skeletonBaseId}#${visit}`, nights: run.nights };
      });
      deviations.push({ kind: 'base_stays_corrected_from_days', detail: `The draft's bases (${declared.replace(/,/g, ', ')}) did not match the beds its days name (${sequenced.replace(/,/g, ', ')}); the stays follow the days.` });
      bases = stays;
    }
  }

  const draftNights = bases.reduce((sum, b) => sum + b.nights, 0);
  const tripNights = Math.max(0, dates.length - 1);
  if (draftNights !== tripNights) {
    // The trip's own length is a hard fact; the draft's nights are scaled to it, last base absorbing the difference.
    const diff = tripNights - draftNights;
    const last = bases[bases.length - 1];
    if (last) last.nights = Math.max(0, last.nights + diff);
    deviations.push({ kind: 'duplicate_location_identity', detail: `The draft's nights summed to ${draftNights} against a ${tripNights}-night trip; the final base absorbed the difference.` });
  }

  // --- Phase A: mandatory base legs, sparse, targeted -----------------------
  const ledger = emptyLedger();
  const identities = bases.filter((b): b is ResolvedBase & { identity: ResolvedBaseIdentity } => b.identity !== null);
  const routingCapable = Boolean(context.routeMatrix) && !deadline();
  const routeAttempted = routingCapable && identities.length > 1;
  if (routeAttempted) {
    await acquireRoute(ledger, context.routeMatrix!, identities.map((b) => ({ id: b.identity.id, ...b.identity.coordinates })), context.matrix);
  }
  let extraMatrix: RouteMatrixResult | null = ledgerSnapshot(ledger);
  const confirmationMemo: ConfirmationMemo = new Map();

  // --- Whole-route relocation feasibility, tolerant ------------------------
  const feasibility = await assessRelocationFeasibility({
    orderedBases: bases,
    matrix: context.matrix,
    profile: context.profile,
    candidates: context.candidates,
    archetype: movementShapeOf(draft.archetype),
    extraMatrix,
    routeAttempted,
    ledger,
    confirmationMemo,
    tolerant: true,
    ...(context.confirmRoute && !deadline() ? { confirmRoute: context.confirmRoute } : {}),
    ...(context.findNearbyLocalities && !deadline() ? { findNearbyLocalities: context.findNearbyLocalities } : {}),
  });
  const unresolvedRelocations: UnresolvedRelocation[] = [];
  if (feasibility.ok) {
    bases = [...feasibility.orderedBases];
    deviations.push(...feasibility.deviations);
    unresolvedRelocations.push(...feasibility.unresolved);
  }
  /*
   * LIVE WORLD V1 — the shape of every base move.
   *
   * A matrix times a base-to-base leg without a shape. The overview map and
   * the day's route line want the road itself, so each consecutive base pair
   * earns one direct, memoized route request (bases − 1 calls, bounded, free
   * on the Valhalla backbone). A pair already confirmed directly is a memo
   * hit; a failure here changes nothing about feasibility, only the map.
   */
  if (context.confirmRoute) {
    for (let i = 0; i + 1 < bases.length; i += 1) {
      if (deadline()) break;
      const from = bases[i]!.identity;
      const to = bases[i + 1]!.identity;
      if (!from || !to || from.id === to.id) continue;
      if (confirmationMemo.has(`${from.id}=>${to.id}`)) continue;
      await confirmMandatoryLeg(ledger, confirmationMemo, context.confirmRoute, from, to);
    }
  }
  /*
   * V10 §8 — THE GATEWAYS, PLACED AND TIMED LIKE ANY OTHER ROUTE-CRITICAL LEG.
   *
   * Before V10 the arrival airport was folded into the terminal plan and then
   * never existed again: no coordinate, no transfer, no allowance. The founder's
   * trip therefore opened with a six-minute drive to its first stop against a
   * 15:00 landing, and closed with breakfast at 09:00 against an 11:00 flight.
   *
   * Both gateways are resolved through the same placement ladder the bases use,
   * and both transfers are measured through the same confirmation memo the base
   * moves use — so a gateway leg is as real as a base transfer, and an unmeasured
   * one is as honestly absent.
   */
  const gatewayPlan = await resolveGateways({
    draft,
    context,
    bases,
    ledger,
    confirmationMemo,
    placements,
    deviations,
    deadline,
    onCalls: (n) => {
      placementCalls += n;
    },
  });
  extraMatrix = ledgerSnapshot(ledger);

  const closure = await assessDepartureClosure(bases, context.matrix, context.profile, extraMatrix, routeAttempted, ledger, deadline() ? undefined : context.confirmRoute, confirmationMemo);
  if (closure.deviation) deviations.push(closure.deviation);
  if (!closure.ok) providerNotes.push(closure.detail);

  // --- Date → base ------------------------------------------------------------
  /*
   * V7 §9 — A MOVE AT THE END OF A DAY DECIDES WHERE THAT NIGHT IS SLEPT.
   *
   * "Disembark at Yichang and take the train back to Chongqing" written as
   * `move.when: 'end'` on the cruise's last day, with the next day in the
   * city, means the night is in the city — whatever the stay counts said.
   * The live Chongqing build kept that night on the ship, so the train had
   * nowhere to be and the next morning walked from a moored vessel to a park.
   * The nights move with the traveller; the note says so.
   */
  /* The base a day sleeps at, by the stay counts as they stand (the same walk `baseForDate` makes below). */
  const baseIndexForDay = (d: number): number => {
    let cumulative = 0;
    let index = 0;
    while (index < bases.length - 1 && d >= cumulative + bases[index]!.nights) {
      cumulative += bases[index]!.nights;
      index += 1;
    }
    return index;
  };
  for (let d = 0; d < draft.days.length - 1; d += 1) {
    const today = draft.days[d]!;
    const tomorrow = draft.days[d + 1]!;
    if (!today.move || today.move.when !== 'end' || today.baseId === tomorrow.baseId) continue;
    const from = baseIndexForDay(d);
    const to = baseIndexForDay(d + 1);
    if (from === to || bases[from] === undefined || bases[to] === undefined || bases[from]!.nights <= 1) continue;
    bases[from]!.nights -= 1;
    bases[to]!.nights += 1;
    today.baseId = tomorrow.baseId;
    deviations.push({ kind: 'night_moved_with_transfer', detail: `Day ${today.dayNumber} ends with a ${today.move.how ?? 'transfer'} to ${bases[to]!.name}, so that night is slept there rather than at ${bases[from]!.name}.`, skeletonDayNumber: today.dayNumber });
  }

  const baseForDate: (ResolvedBase | null)[] = [];
  {
    let cumulative = 0;
    let index = 0;
    for (let d = 0; d < dates.length; d += 1) {
      while (index < bases.length - 1 && d >= cumulative + bases[index]!.nights) {
        cumulative += bases[index]!.nights;
        index += 1;
      }
      baseForDate.push(bases[index] ?? null);
    }
  }

  // --- Route-aware weather: one point per base, when the caller offers it ------
  let weather: WeatherDataset = context.weather;
  if (context.weatherForBases && !deadline()) {
    const seen = new Set<string>();
    const locations = bases.flatMap((b) => {
      if (!b.identity || seen.has(b.identity.id)) return [];
      seen.add(b.identity.id);
      return [{ id: b.identity.id, label: b.displayName ?? b.name, coordinates: b.identity.coordinates }];
    });
    if (locations.length > 0) {
      try {
        const dataset = await context.weatherForBases(locations);
        if (dataset) weather = dataset;
      } catch {
        providerNotes.push('Weather for the bases could not be fetched; the destination-wide pattern stands for every day.');
      }
    }
  }

  // --- Anchors: identity, then day-local routing ------------------------------
  /*
   * PRODUCT RECOVERY V1 — WHAT IS LOOKED UP, AND IN WHAT ORDER.
   *
   * Not every line the model wrote is a place. `anchorKindOf` sorts each
   * anchor into a named place (must resolve), an area or route experience
   * (geocoded for the map when time allows), a generic experience (never
   * looked up, never called "not verified") or a meal (folded into the day's
   * meal intent — the live Ireland build scheduled "Killarney town pub
   * dinner" as an 11:15 attraction and then added a second dinner at 18:00).
   * Lookups run core named places first, then secondary, then areas, a few
   * at a time; the deadline is consulted inside each lookup, so when it
   * fires it is the map decoration that goes unverified, not Kilkenny Castle.
   */
  const anchorJobs = draft.days.flatMap((day) =>
    day.anchors.map((anchor, index) => {
      const kind = anchorKindOf(anchor);
      return { day, anchor, index, kind, priority: lookupPriorityFor(kind, anchor.role) };
    }),
  );
  type ResolvedFields = Pick<ReconciledAnchor, 'verification' | 'identity' | 'place' | 'candidate' | 'method' | 'providerIdentity'>;
  const NOT_LOOKED_UP: ResolvedFields = { verification: 'unverified', identity: null, place: null, candidate: null, method: null };
  const resolvedAnchors: ResolvedFields[] = anchorJobs.map(() => NOT_LOOKED_UP);
  const lookupOrder = anchorJobs
    .map((job, jobIndex) => ({ job, jobIndex }))
    .filter(({ job }) => job.priority !== null)
    .sort((a, b) => a.job.priority! - b.job.priority! || a.jobIndex - b.jobIndex);
  const lookedUp = await mapConcurrent(lookupOrder, ANCHOR_RESOLUTION_CONCURRENCY, ({ job }) => resolveDraftAnchor(job.anchor, context, providerNotes));
  lookupOrder.forEach(({ jobIndex }, i) => {
    resolvedAnchors[jobIndex] = lookedUp[i]!;
  });
  /*
   * V10 §5 — a `core` named place the route is built around is route-critical
   * too. Not every stop: a decorative viewpoint may degrade, and an experience
   * with no specific place was never a lookup. What is recorded here is the
   * class that decides a day's geography.
   */
  for (const [jobIndex, job] of anchorJobs.entries()) {
    if (job.kind !== 'named_place' || job.anchor.role !== 'core') continue;
    const resolved = resolvedAnchors[jobIndex]!;
    const placement: RouteCriticalPlacement = {
      id: `${draftAnchorId(job.day.dayNumber, job.index, job.anchor.name)}`,
      name: job.anchor.name,
      kind: 'route_defining_stop',
      outcome: resolved.identity ? 'placed' : context.deadlineReached?.() ? 'not_attempted' : !context.geocodeLocality && !context.resolvePlaceIdentity ? 'no_provider' : 'no_acceptable_candidate',
      ...(resolved.identity ? { coordinates: resolved.identity.coordinates } : {}),
      attempts: [],
    };
    const note = placement.outcome === 'placed' ? undefined : describeUnplaced(placement);
    placements.push(note ? { ...placement, travellerNote: note } : placement);
  }

  const anchors: ReconciledAnchor[] = [];
  const mealFolds = new Map<number, Partial<Record<'breakfast' | 'lunch' | 'dinner', string>>>();
  const mealFoldNotes = new Map<string, string>();
  for (const [jobIndex, job] of anchorJobs.entries()) {
    const { day, anchor, index, kind } = job;
    const resolved = resolvedAnchors[jobIndex]!;
    // A verified place's own typical visit length is evidence and wins over
    // the model's estimate; the estimate wins over a category default.
    const placeMinutes = resolved.verification === 'verified' ? resolved.place?.typicalDurationMinutes : undefined;
    const durationMinutes = placeMinutes ?? anchor.estimatedDurationMinutes ?? CATEGORY_DEFAULT_MINUTES[anchor.category];
    const id = draftAnchorId(day.dayNumber, index, anchor.name);
    anchors.push({
      id,
      dayNumber: day.dayNumber,
      index,
      draft: anchor,
      ...resolved,
      durationMinutes,
      durationBasis: placeMinutes ? 'place_record' : anchor.estimatedDurationMinutes ? 'model_estimate' : 'category_default',
      kind,
    });
    if (kind === 'meal') {
      const slot = mealSlotOf(anchor.name);
      const current = mealFolds.get(day.dayNumber) ?? {};
      const existing = day.meals?.[slot] ?? current[slot];
      if (!existing) current[slot] = anchor.name;
      mealFolds.set(day.dayNumber, current);
      mealFoldNotes.set(id, existing ? `Written as a stop; it is the day's ${slot} (${existing}).` : `Written as a stop; it is the day's ${slot}.`);
      continue;
    }
    if (resolved.method === 'places') {
      deviations.push({ kind: 'anchor_resolved_via_places', detail: `"${anchor.name}" (day ${day.dayNumber}) matched a places provider record (${resolved.identity!.name}, ${resolved.providerIdentity?.confidence ?? 'probable'} match); hours and access are looked up separately.`, skeletonDayNumber: day.dayNumber, replacementPlaceId: resolved.identity!.id });
    } else if (resolved.method === 'geocoder') {
      deviations.push({ kind: 'anchor_resolved_via_geocoder', detail: `"${anchor.name}" (day ${day.dayNumber}) confirmed as a real place by a geocoder (${resolved.identity!.name}); no board evidence for hours or access.`, skeletonDayNumber: day.dayNumber, replacementPlaceId: resolved.identity!.id });
    } else if (resolved.verification === 'unverified' && kind === 'named_place') {
      deviations.push({ kind: 'anchor_unverified', detail: `"${anchor.name}" (day ${day.dayNumber}) could not be independently confirmed as a specific place; kept as an honestly-uncertain proposal.`, skeletonDayNumber: day.dayNumber });
    }
  }

  if (routingCapable) {
    for (let d = 0; d < dates.length; d += 1) {
      if (deadline()) {
        providerNotes.push(`Day-local routing stopped at day ${d + 1}: the verification deadline passed.`);
        break;
      }
      const dayNumber = d + 1;
      const points: { id: string; lat: number; lng: number }[] = [];
      const prev = baseForDate[d - 1]?.identity ?? null;
      const here = baseForDate[d]?.identity ?? null;
      if (prev) points.push({ id: prev.id, ...prev.coordinates });
      if (here) points.push({ id: here.id, ...here.coordinates });
      for (const a of anchors) if (a.dayNumber === dayNumber && a.identity && roadRoutable(a.draft.transport)) points.push({ id: a.identity.id, ...a.identity.coordinates });
      await acquireRoute(ledger, context.routeMatrix!, points, context.matrix);
    }
  }
  extraMatrix = ledgerSnapshot(ledger);

  // --- Hours: verified places only, affirmative closures only ----------------
  const dispositionOf = new Map<string, AnchorDispositionCode>();
  const scheduledDayOf = new Map<string, number>();
  const unscheduled: UnscheduledPlace[] = [];
  const anchorNote = new Map<string, string>();
  const mustInclude = new Set((context.mustIncludeNames ?? []).map(normalizeName));

  /*
   * LIVE WORLD V1 closure — operational evidence for provider-identified
   * stops. The board's own calendars cover board and compiled places; a
   * stop a places provider identified has no calendar here, so its status
   * and regular hours are asked for once, bounded by the deadline, only
   * where the place class says they matter. Assessed for the date now, for
   * the clock in layout.
   */
  if (context.operationalEvidence) {
    for (const anchor of anchors) {
      if (anchor.place || !anchor.identity || !anchor.providerIdentity) continue;
      const placeClass = anchor.providerIdentity.placeClass ?? placeClassFor(anchor.draft.category);
      anchor.operationalClass = placeClass;
      if (enrichmentLevelFor(placeClass) === 'none') continue;
      if (deadline()) {
        providerNotes.push(`"${anchor.draft.name}" was not checked for hours: the verification deadline had passed.`);
        continue;
      }
      try {
        anchor.operationalEvidence = await context.operationalEvidence({ placeId: anchor.identity.id, ...(anchor.providerIdentity.providerRef ? { providerRef: anchor.providerIdentity.providerRef } : {}), provider: anchor.providerIdentity.provider, name: anchor.draft.name, placeClass });
      } catch {
        anchor.operationalEvidence = { provider: anchor.providerIdentity.provider, checkedAt: (context.now ?? new Date()).toISOString(), status: 'unknown', hoursBasis: 'none', attribution: 'Provider did not answer', unavailableReason: 'provider_error' };
      }
    }
  }
  const daysUntil = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - (context.now ?? new Date()).getTime()) / 86_400_000);

  for (const anchor of anchors) {
    if (anchor.kind === 'meal') {
      dispositionOf.set(anchor.id, 'folded_into_meal');
      scheduledDayOf.set(anchor.id, anchor.dayNumber);
      continue;
    }
    /*
     * V6 §11 — TRANSPORT IS NOT A POI. A transfer written as a stop is the
     * day's travel leg, which the layout builds anyway; a gateway written as
     * a stop is the terminal plan. Both are kept content (never a loss) and
     * never a scheduled attraction, a signature or a "Don't miss".
     */
    if (anchor.kind === 'transfer') {
      dispositionOf.set(anchor.id, 'folded_into_transfer');
      scheduledDayOf.set(anchor.id, anchor.dayNumber);
      anchorNote.set(anchor.id, 'Written as a stop; it is the day’s transfer and is shown as the travel leg.');
      continue;
    }
    if (anchor.kind === 'gateway') {
      dispositionOf.set(anchor.id, 'folded_into_terminal');
      scheduledDayOf.set(anchor.id, anchor.dayNumber);
      const unresolved = gatewayIsUnresolved(anchor.draft.name);
      anchorNote.set(anchor.id, unresolved ? 'Written as a stop; it names a choice of arrival or departure point that has not been made.' : 'Written as a stop; it is the arrival or departure point and belongs to the transfer plan.');
      if (unresolved) {
        issues.push({ code: 'gateway_unresolved', severity: 'warning', message: `Day ${anchor.dayNumber} depends on which of these you arrive through: ${anchor.draft.name}. The first day cannot be timed until one is chosen.`, dayNumber: anchor.dayNumber });
      }
      continue;
    }
    dispositionOf.set(anchor.id, anchor.verification === 'verified' ? 'preserved_with_verified_facts' : anchor.verification === 'partially_verified' ? 'preserved' : 'retained_unverified');
    scheduledDayOf.set(anchor.id, anchor.dayNumber);
    if (!anchor.place && anchor.operationalEvidence && anchor.identity && anchor.operationalClass) {
      const ownDate = dates[anchor.dayNumber - 1]!;
      const assessed = assessOperational({ evidence: anchor.operationalEvidence, placeClass: anchor.operationalClass, date: ownDate, daysUntil: daysUntil(ownDate) });
      if (assessed.outcome === 'closed_permanently') {
        dispositionOf.set(anchor.id, 'rejected_contradiction');
        unscheduled.push({ placeId: anchor.identity.id, name: anchor.draft.name, wasManual: mustInclude.has(normalizeName(anchor.draft.name)), reasonCode: 'closed_on_trip_dates', reason: `Your plan proposed this for day ${anchor.dayNumber}, but the places provider lists it as permanently closed (${anchor.operationalEvidence.attribution}, ${anchor.operationalEvidence.checkedAt.slice(0, 10)}).` });
        issues.push({ code: 'attraction_closed_on_date', severity: 'warning', message: `${anchor.draft.name} is listed as permanently closed; taken off rather than left as a false promise.`, dayNumber: anchor.dayNumber, placeId: anchor.identity.id, wasResolvedByRemoval: true });
        continue;
      }
      if (assessed.outcome === 'closed_on_date') {
        const ownBase = baseForDate[anchor.dayNumber - 1];
        const alternative = dates.findIndex((date, i) => baseForDate[i] === ownBase && i !== anchor.dayNumber - 1 && (operationalWindowsOn(anchor.operationalEvidence!, date)?.length ?? 0) > 0);
        if (alternative >= 0) {
          scheduledDayOf.set(anchor.id, alternative + 1);
          dispositionOf.set(anchor.id, 'moved_other_day');
          anchorNote.set(anchor.id, `Moved from day ${anchor.dayNumber}: its regular schedule has no opening on that weekday (${anchor.operationalEvidence.attribution}).`);
          revisions.push({ code: 'moved_to_another_day', description: `${anchor.draft.name} moved to day ${alternative + 1} because its regular hours have no opening on day ${anchor.dayNumber}.`, dayNumber: alternative + 1, placeId: anchor.identity.id });
        } else {
          dispositionOf.set(anchor.id, 'rejected_contradiction');
          unscheduled.push({ placeId: anchor.identity.id, name: anchor.draft.name, wasManual: mustInclude.has(normalizeName(anchor.draft.name)), reasonCode: 'closed_on_trip_dates', reason: `Your plan proposed this for day ${anchor.dayNumber}, but its regular schedule (${anchor.operationalEvidence.attribution}, read ${anchor.operationalEvidence.checkedAt.slice(0, 10)}) has no opening on any day you are nearby.` });
          issues.push({ code: 'attraction_closed_on_date', severity: 'warning', message: `${anchor.draft.name} has no opening on any day the plan is nearby; taken off rather than left as a false promise.`, dayNumber: anchor.dayNumber, placeId: anchor.identity.id, wasResolvedByRemoval: true });
        }
        continue;
      }
    }
    if (!anchor.place) continue;
    // The board's own hard blockers are affirmative evidence: a place the
    // compiled region has established cannot work for this traveller as they
    // are travelling (out of season, no legal way in without a car) is a
    // contradiction, stated in the board's own words, never a silent drop.
    const hardBlockers = anchor.candidate?.fit.band === 'not_workable' ? anchor.candidate.fit.blockers.filter((b) => ACCESS_BLOCKER_CODES.has(b.code)) : [];
    if (anchor.candidate && hardBlockers.length > 0) {
      dispositionOf.set(anchor.id, 'rejected_contradiction');
      const why = hardBlockers.map((b) => b.message).join(' ');
      unscheduled.push({
        placeId: anchor.place.id,
        name: anchor.draft.name,
        wasManual: mustInclude.has(normalizeName(anchor.draft.name)),
        reasonCode: reasonCodeForBlocker(hardBlockers[0]!.code),
        reason: `Your plan proposed this for day ${anchor.dayNumber}, but it is not workable on this trip as you are travelling: ${why}`,
        suggestedRemedy: 'Change how you are getting around, or the dates, and regenerate.',
      });
      issues.push({ code: 'place_unavailable', severity: 'warning', message: `${anchor.draft.name} is not workable on this trip: ${why}`, dayNumber: anchor.dayNumber, placeId: anchor.place.id, wasResolvedByRemoval: true });
      continue;
    }
    const calendar = findOperatingCalendar(context.hours, anchor.place.id);
    if (!calendar || calendar.kind === 'unknown' || calendar.provenance.kind === 'estimated') continue;
    const onOwnDate = operatingOn(calendar, dates[anchor.dayNumber - 1]!);
    if (onOwnDate.status !== 'closed') continue;
    const ownBase = baseForDate[anchor.dayNumber - 1];
    const alternative = dates.findIndex((date, i) => baseForDate[i] === ownBase && i !== anchor.dayNumber - 1 && operatingOn(calendar, date).status !== 'closed');
    if (alternative >= 0) {
      scheduledDayOf.set(anchor.id, alternative + 1);
      dispositionOf.set(anchor.id, 'moved_other_day');
      anchorNote.set(anchor.id, `Moved from day ${anchor.dayNumber}: ${onOwnDate.closedReason?.replace(/_/g, ' ') ?? 'closed'} on its original date.`);
      revisions.push({ code: 'moved_to_another_day', description: `${anchor.draft.name} moved to day ${alternative + 1} because it is closed on day ${anchor.dayNumber}.`, dayNumber: alternative + 1, placeId: anchor.place.id });
      continue;
    }
    dispositionOf.set(anchor.id, 'rejected_contradiction');
    unscheduled.push({
      placeId: anchor.place.id,
      name: anchor.draft.name,
      wasManual: mustInclude.has(normalizeName(anchor.draft.name)),
      reasonCode: 'closed_on_trip_dates',
      reason: `Your plan proposed this for day ${anchor.dayNumber}, but its published calendar (${calendar.provenance.sourceName}) says it is ${onOwnDate.closedReason?.replace(/_/g, ' ') ?? 'closed'} on every day you are nearby.`,
    });
    issues.push({ code: 'attraction_closed_on_date', severity: 'warning', message: `${anchor.draft.name} is closed on every day the plan is nearby; taken off rather than left as a false promise.`, dayNumber: anchor.dayNumber, placeId: anchor.place.id, wasResolvedByRemoval: true });
  }

  /*
   * --- Routing contradictions: the router answered, and answered "no" --------
   *
   * V9.1 — the two conditions below are the whole of it, and both are required.
   *
   * A live structural refinement moved a day's base and this loop then removed
   * a 56-minute drive as unreachable, telling the traveller "a real answer, not
   * a gap". It was a gap: Valhalla's `costmatrix` had declined the pair while
   * `/route` solved it, and the null cell was being classified as the
   * authoritative no-route. That classification is fixed at source
   * (`providers/valhalla.ts`), so `AUTHORITATIVE_NO_ROUTE` now reaches this
   * ledger only from the direct route endpoint, which evaluates a path and
   * reports NO_PATH when there is none.
   *
   * The condition is named and checked below rather than left implicit in a
   * comparison, because the cost of getting it wrong is asymmetric: an
   * unmeasured leg is a caution the traveller can act on, and a deleted
   * experience is the reason they were going. It is also the whole of the
   * protection a defining experience needs — a `core` stop leaves the plan only
   * when a provider evaluated the leg and reported no route, never because a
   * measurement failed to arrive. See `V9.1-ROUTING-CONTRADICTION.md`.
   */
  for (const anchor of anchors) {
    if (!anchor.identity || dispositionOf.get(anchor.id) === 'rejected_contradiction') continue;
    if (!roadRoutable(anchor.draft.transport)) continue;
    const base = baseForDate[scheduledDayOf.get(anchor.id)! - 1]?.identity;
    if (!base) continue;
    const there = ledgerFailureReason(ledger, base.id, anchor.identity.id);
    const back = ledgerFailureReason(ledger, anchor.identity.id, base.id);
    const measured = measuredLeg(context.matrix, extraMatrix, base.id, anchor.identity.id) ?? measuredLeg(context.matrix, extraMatrix, anchor.identity.id, base.id);
    if (measured) continue;
    /*
     * Condition one: affirmative evidence. Not "no measurement arrived" — a
     * provider that evaluated these two resolved endpoints on this profile and
     * reported no route between them. Every other reason in the vocabulary
     * (`provider_error`, `rate_limited`, `budget_exhausted`,
     * `insufficient_evidence`, coverage, unreachable) is an absent answer.
     */
    const affirmativeNoRoute = there === AUTHORITATIVE_NO_ROUTE || back === AUTHORITATIVE_NO_ROUTE;
    if (!affirmativeNoRoute) continue;
    dispositionOf.set(anchor.id, 'rejected_contradiction');
    unscheduled.push({
      placeId: anchor.identity.id,
      name: anchor.draft.name,
      wasManual: mustInclude.has(normalizeName(anchor.draft.name)),
      reasonCode: 'route_contradicted',
      reason: `The routing provider answered that no route reaches ${anchor.draft.name} from ${base.name} — a real answer, not a gap — so it was taken off day ${anchor.dayNumber} rather than scheduled on faith.`,
      suggestedRemedy: 'If you know a way in (a boat, a track, a guide), add it back by hand and treat the leg as unmeasured.',
    });
    deviations.push({ kind: 'anchor_unroutable', detail: `"${anchor.draft.name}" (day ${anchor.dayNumber}) resolved to a real place, but the router reported no route to it from ${base.name}.`, skeletonDayNumber: anchor.dayNumber, replacementPlaceId: anchor.identity.id });
    issues.push({ code: 'matrix_entry_missing', severity: 'warning', message: `${anchor.draft.name}: the router reported no route from ${base.name}; removed from the day.`, dayNumber: anchor.dayNumber, placeId: anchor.identity.id, wasResolvedByRemoval: true });
  }

  // --- Lay out each day ---------------------------------------------------------
  const hardCeiling = context.matrix.mode === 'car' ? context.profile.transport.maxDailyDriveMinutes : context.profile.transport.maxDailyTransportMinutes;
  const permitted = permittedModesFor(context.profile);
  const days: ItineraryDay[] = [];
  /** V10 §7 — one spatial-order verdict per day. */
  const orderReports: { dayNumber: number; report: SpatialOrderReport; corrected: boolean }[] = [];
  let legsMeasured = 0;
  let legsUnmeasured = 0;
  let legsEstimated = 0;
  const draftDayByNumber = new Map(draft.days.map((d) => [d.dayNumber, d] as const));

  for (let d = 0; d < dates.length; d += 1) {
    const dayNumber = d + 1;
    const date = dates[d]!;
    const window = windows[d]!;
    const draftDayRaw = draftDayByNumber.get(dayNumber);
    const folds = mealFolds.get(dayNumber);
    const draftDay = draftDayRaw && folds ? { ...draftDayRaw, meals: { ...(draftDayRaw.meals ?? {}), ...folds } } : draftDayRaw;
    const base = baseForDate[d] ?? null;
    const previousBase = d > 0 ? (baseForDate[d - 1] ?? null) : null;
    const relocation = Boolean(previousBase && base && previousBase !== base);
    const dayAnchors = anchors
      .filter((a) => a.kind !== 'meal' && a.kind !== 'transfer' && a.kind !== 'gateway' && scheduledDayOf.get(a.id) === dayNumber && !String(dispositionOf.get(a.id)).startsWith('rejected'))
      .sort((a, b) => (a.dayNumber === b.dayNumber ? a.index - b.index : a.dayNumber - b.dayNumber));

    const laid = layoutDay({
      dayNumber,
      date,
      window,
      draftDay,
      base,
      previousBase,
      relocation,
      anchors: dayAnchors,
      episode: episodeForDay(episodes, dayNumber),
      episodeEntersToday: episodes.some((e) => e.fromDay === dayNumber),
      isLastDay: d === dates.length - 1,
      context,
      extraMatrix,
      ledger,
      hardCeiling,
      isFirst: d === 0,
      isLast: d === dates.length - 1,
      confirmationMemo,
      measuredAt: (context.now ?? new Date()).toISOString(),
      weather,
    });
    for (const dropped of laid.dropped) {
      dispositionOf.set(dropped.anchor.id, dropped.disposition);
      unscheduled.push({
        placeId: dropped.anchor.identity?.id ?? `model-proposal:day${dayNumber}:${normalizeName(dropped.anchor.draft.name).replace(/\s+/g, '-')}`,
        name: dropped.anchor.draft.name,
        wasManual: mustInclude.has(normalizeName(dropped.anchor.draft.name)),
        reasonCode: dropped.disposition === 'rejected_hard_constraint' ? 'exceeds_daily_travel' : 'no_time_left',
        reason: dropped.reason,
        suggestedRemedy: dropped.disposition === 'rejected_hard_constraint' ? 'Raise your daily driving limit, or move this to a day based nearer to it.' : 'Give this day a lighter pace, or move something else off it.',
      });
      revisions.push({ code: dropped.disposition === 'rejected_hard_constraint' ? 'dropped_lowest_priority' : 'replaced_with_free_time', description: dropped.reason, dayNumber, ...(dropped.anchor.identity ? { placeId: dropped.anchor.identity.id } : {}) });
      if (dropped.disposition === 'rejected_hard_constraint') {
        issues.push({ code: 'daily_drive_exceeded', severity: 'warning', message: dropped.reason, dayNumber, wasResolvedByRemoval: true });
      }
    }
    legsMeasured += laid.legsMeasured;
    legsUnmeasured += laid.legsUnmeasured;
    legsEstimated += laid.legsEstimated;
    /* V10 §7 — the order verdict for every day, corrected or not, so nothing about ordering is invisible. */
    orderReports.push({ dayNumber, report: laid.order, corrected: laid.orderCorrected });
    if (laid.orderCorrected) {
      const sentence = laid.order.violations[0]?.detail ?? 'the order as composed doubled back';
      const softened = laid.softened.length > 0 ? ` ${laid.softened.join(', ')} moved from the part of the day the plan suggested, because holding ${laid.softened.length === 1 ? 'it' : 'them'} there doubled back on the road.` : '';
      deviations.push({ kind: 'day_order_corrected', detail: `Day ${dayNumber}'s stops were reordered to follow the road: ${sentence}${softened}`, skeletonDayNumber: dayNumber });
    }
    days.push(laid.day);
  }

  // --- Additive enrichment: name a real venue for a meal where the region's
  // --- own food data holds one nearby. Never invents; never changes a stop. --
  const venueUse = new Map<string, number>();
  const anchorCoordinates = new Map<string, { lat: number; lng: number }>();
  for (const anchor of anchors) if (anchor.identity) anchorCoordinates.set(anchor.id, anchor.identity.coordinates);
  let mealsNamed = 0;
  if (context.food) {
    for (const day of days) {
      const base = baseForDate[day.dayNumber - 1]?.identity?.coordinates ?? null;
      mealsNamed += nameVenuesForDay(day, context.food, context.profile, anchorCoordinates, base, venueUse);
    }
  }

  for (const relocationIssue of unresolvedRelocations) {
    const dayIndex = baseForDate.findIndex((b) => b?.skeletonBaseId === relocationIssue.toBaseId);
    issues.push({
      code: relocationIssue.kind === 'over_ceiling' ? 'daily_drive_exceeded' : 'travel_without_time',
      severity: relocationIssue.kind === 'over_ceiling' ? 'error' : 'warning',
      message: relocationIssue.detail,
      ...(dayIndex >= 0 ? { dayNumber: dayIndex + 1 } : {}),
    });
  }
  if (!closure.ok) {
    issues.push({ code: 'base_not_returned', severity: 'warning', message: closure.detail });
  }

  // --- Package + dispositions --------------------------------------------------
  const packageAnchors: PackageAnchor[] = anchors.map((anchor) => {
    const disposition = dispositionOf.get(anchor.id) ?? 'preserved';
    const scheduledDayNumber = scheduledDayOf.get(anchor.id) ?? anchor.dayNumber;
    return {
      id: anchor.id,
      dayNumber: anchor.dayNumber,
      ...(scheduledDayNumber !== anchor.dayNumber ? { scheduledDayNumber } : {}),
      name: anchor.draft.name,
      role: anchor.draft.role,
      category: anchor.draft.category,
      disposition,
      verification: anchor.verification,
      anchorKind: anchor.kind,
      ...(anchor.identity ? { placeId: anchor.identity.id } : {}),
      ...(anchorNote.get(anchor.id) ?? mealFoldNotes.get(anchor.id) ? { note: (anchorNote.get(anchor.id) ?? mealFoldNotes.get(anchor.id))! } : {}),
      ...(anchor.identity && anchor.method
        ? {
            identity: {
              method: anchor.method,
              provider: anchor.providerIdentity?.provider ?? (anchor.method === 'board' || anchor.method === 'compiled_place' ? 'sidequest' : 'geocoder'),
              ...(anchor.providerIdentity?.providerRef ? { providerRef: anchor.providerIdentity.providerRef } : {}),
              coordinates: anchor.identity.coordinates,
              ...(anchor.providerIdentity?.placeClass ? { placeClass: anchor.providerIdentity.placeClass } : {}),
              ...(anchor.providerIdentity?.confidence ? { confidence: anchor.providerIdentity.confidence } : {}),
              ...(anchor.providerIdentity?.attribution ? { attribution: anchor.providerIdentity.attribution } : {}),
              resolvedAt: (context.now ?? new Date()).toISOString(),
            },
          }
        : {}),
    };
  });
  const scheduledCount = packageAnchors.filter((a) => !a.disposition.startsWith('rejected') && a.disposition !== 'unscheduled_capacity').length;
  const rejectedCount = packageAnchors.filter((a) => a.disposition.startsWith('rejected')).length;

  const pkg: TripPackage = {
    source: 'model_draft',
    draftVersion: TRIP_DRAFT_SCHEMA_VERSION,
    archetype: draft.archetype,
    purpose: draft.purpose,
    routeRationale: draft.routeRationale,
    ...(draft.timingRationale ? { timingRationale: draft.timingRationale } : {}),
    assumptions: [...draft.assumptions],
    tradeoffs: [...draft.tradeoffs],
    bases: bases.map((base) => {
      // A revisited base carries a `#n` suffix on its stay id; the draft's own record is the root.
      const draftBase = draft.bases.find((b) => b.id === base.skeletonBaseId.split('#')[0]);
      return {
        id: base.skeletonBaseId,
        name: base.displayName ?? base.identity?.name ?? base.name,
        ...(base.displayName ? { displayName: base.displayName } : {}),
        ...(base.canonicalName ?? base.identity?.name ? { canonicalName: (base.canonicalName ?? base.identity?.name)! } : {}),
        ...(base.locality ? { locality: base.locality } : {}),
        ...(base.baseKind ? { baseKind: base.baseKind } : {}),
        ...(base.identity ? { coordinates: base.identity.coordinates } : {}),
        nights: base.nights,
        why: draftBase?.why ?? 'Inserted by Sidequest so that no single transfer exceeds your daily driving limit.',
        ...(draftBase?.lodgingArea ? { area: draftBase.lodgingArea } : {}),
        ...(draftBase?.lodgingStyle ? { style: draftBase.lodgingStyle } : {}),
        verification: base.identity ? (context.candidates.some((c) => c.place.id === base.identity!.id) ? 'verified' : 'partially_verified') : base.baseKind === 'vessel' ? 'partially_verified' : 'unverified',
        ...(base.identity ? { placeId: base.identity.id } : {}),
        ...(draftBase ? {} : { insertedBySidequest: true }),
        ...(base.episode ? { episode: base.episode } : {}),
      };
    }),
    /*
     * V7 §8 — the episodes, with whether the plan carries a structured leg
     * into and out of each. A cruise the traveller boards on day 4 needs a
     * transfer on day 4; one that ends on the last day needs the last day to
     * reach the departure gateway. `missing` is what the feasibility report
     * turns into a dependency.
     */
    episodes: episodes.map((episode) => {
      const dayNumbers = days.filter((day) => day.dayNumber >= episode.fromDay && day.dayNumber <= episode.toDay).map((day) => day.dayNumber);
      const baseIds = [...new Set(draft.days.filter((d) => d.dayNumber >= episode.fromDay && d.dayNumber <= episode.toDay).map((d) => d.baseId))].map((id) => bases.find((b) => b.skeletonBaseId.split('#')[0] === id)?.skeletonBaseId ?? id);
      const transferOn = (dayNumber: number) => {
        const day = days.find((d) => d.dayNumber === dayNumber);
        const yesterday = days.find((d) => d.dayNumber === dayNumber - 1);
        return day?.items.some((item) => item.kind === 'travel' && item.travel && item.travel.fromId !== item.travel.toId && (item.travel.role === 'transfer' || (yesterday !== undefined && (item.travel.fromId === yesterday.baseId || item.travel.fromName === yesterday.baseName)))) ?? false;
      };
      const baseChanges = (dayNumber: number) => {
        const today = draft.days.find((d) => d.dayNumber === dayNumber);
        const yesterday = draft.days.find((d) => d.dayNumber === dayNumber - 1);
        return Boolean(today && yesterday && today.baseId !== yesterday.baseId);
      };
      const entryNeeded = episode.fromDay > 1 && baseChanges(episode.fromDay);
      const exitDay = episode.toDay + 1;
      const isLast = episode.toDay >= dates.length;
      const lastDayMovesOut = draft.days.find((d) => d.dayNumber === episode.toDay)?.move?.when === 'end';
      const exitNeeded = isLast ? (bases.find((b) => draft.days[episode.toDay - 1]?.baseId === b.skeletonBaseId.split('#')[0])?.baseKind === 'vessel') : baseChanges(exitDay) || lastDayMovesOut;
      return {
        name: episode.name,
        kind: episode.kind,
        dayNumbers,
        baseIds,
        mode: episode.mode,
        timing: episode.timing ?? 'unknown',
        ...(episode.startGateway ? { startGateway: episode.startGateway } : {}),
        ...(episode.endGateway ? { endGateway: episode.endGateway } : {}),
        ...(episode.meals ? { meals: episode.meals } : {}),
        ...(episode.why ? { why: episode.why } : {}),
        entryLeg: !entryNeeded ? ('not_needed' as const) : transferOn(episode.fromDay) ? ('present' as const) : ('missing' as const),
        exitLeg: !exitNeeded ? ('not_needed' as const) : transferOn(isLast ? episode.toDay : exitDay) || (lastDayMovesOut && transferOn(episode.toDay)) ? ('present' as const) : ('missing' as const),
      };
    }),
    foodStrategy: [...draft.package.foodStrategy],
    transport: { summary: draft.package.transport.summary, notes: [...draft.package.transport.notes] },
    beforeYouGo: [...draft.package.beforeYouGo],
    packing: [...draft.package.packing],
    backups: matchBackupsToDays(draft.package.backups, days, anchors, baseForDate),
    omissions: draft.omissions.map((o) => ({ ...o })),
    unresolved: [...draft.unresolved],
    bookingPriorities: [...(draft.bookingPriorities ?? [])],
    anchors: packageAnchors,
    verification: {
      anchors: anchors.length,
      verified: anchors.filter((a) => a.verification === 'verified').length,
      partiallyVerified: anchors.filter((a) => a.verification === 'partially_verified').length,
      unverified: anchors.filter((a) => a.verification === 'unverified').length,
      scheduled: scheduledCount,
      rejected: rejectedCount,
      legsMeasured,
      legsUnmeasured,
      legsEstimated,
      deadlineReached: deadline(),
      providerNotes,
    },
  };

  // --- Trip-level summaries ---------------------------------------------------
  const totals = days.reduce(
    (acc, day) => ({
      driveMinutes: acc.driveMinutes + day.totals.driveMinutes,
      transitMinutes: acc.transitMinutes + day.totals.transitMinutes,
      walkMinutes: acc.walkMinutes + day.totals.walkMinutes,
      waitMinutes: acc.waitMinutes + day.totals.waitMinutes,
      unverifiedMinutes: acc.unverifiedMinutes + day.totals.unverifiedMinutes,
      driveKm: acc.driveKm + day.totals.travelKm,
    }),
    { driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, driveKm: 0 },
  );
  /*
   * V7 §9 — THE TRIP'S PRIMARY MODE IS WHAT THE LEGS SAY, NOT WHAT THE PROFILE
   * TICKED. A traveller who said they would drive but whose plan moves by rail
   * and a hired driver is not on a driving trip. Self-drive keeps `drive`; any
   * other arrangement takes the mode that carries the most minutes across the
   * plan's own legs, and falls back to the old reading only when no leg exists.
   */
  const minutesByModeAcrossTrip = new Map<TransportMode, number>();
  for (const day of days) for (const item of day.items) if (item.kind === 'travel' && item.travel && item.travel.fromId !== item.travel.toId) minutesByModeAcrossTrip.set(item.travel.mode, (minutesByModeAcrossTrip.get(item.travel.mode) ?? 0) + item.durationMinutes);
  const busiest = [...minutesByModeAcrossTrip.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const selfDrives = impliesSelfDriving(draft.driving) || (draft.driving === undefined && context.profile.transport.willDrive);
  const primaryMode: TransportMode = selfDrives ? 'drive' : busiest && busiest !== 'unsupported' ? busiest : context.profile.transport.willDrive ? 'drive' : context.matrix.mode === 'foot' ? 'walk' : 'public_bus';
  const routerName = context.matrix.provenance.kind === 'measured' ? 'the routing provider' : `${context.matrix.provenance.kind} road data`;
  const itinerary: Itinerary = {
    version: ITINERARY_VERSION,
    tripId: context.tripId,
    regionId: context.region.id,
    baseId: bases[0]?.identity?.id ?? context.baseId,
    baseName: bases[0]?.displayName ?? bases[0]?.identity?.name ?? bases[0]?.name ?? context.region.baseName,
    startDate: context.basics.startDate,
    endDate: context.basics.endDate,
    status: issues.some((i) => i.severity === 'error') || unscheduled.some((u) => u.wasManual) ? 'needs_decision' : issues.length > 0 || legsUnmeasured > 0 || pkg.verification.unverified > 0 ? 'ready_with_cautions' : 'ready',
    summary: `${draft.purpose} ${bases.length > 1 ? `${bases.length} bases: ${bases.map((b) => `${b.displayName ?? b.identity?.name ?? b.name} (${b.nights} night${b.nights === 1 ? '' : 's'})`).join(' → ')}.` : `One base: ${bases[0]?.displayName ?? bases[0]?.identity?.name ?? bases[0]?.name ?? ''}.`} ${scheduledCount} of ${anchors.length} proposed experiences are on the plan${rejectedCount > 0 ? `; ${rejectedCount} taken off on evidence` : ''}.`,
    transportStrategy: {
      primaryMode,
      secondaryMode: primaryMode === 'drive' ? 'walk' : permitted.has('drive') ? 'drive' : null,
      headline: draft.package.transport.summary,
      rationale: draft.package.transport.notes.length > 0 ? [...draft.package.transport.notes] : [draft.package.transport.summary],
      tradeoffs: [],
      convenience: 'moderate',
      stress: unresolvedRelocations.length > 0 ? 'high' : 'moderate',
      /*
       * PRODUCTION LOCK V5 §15 — NO PARKING ADVICE FOR A TRIP WITH NO CAR.
       *
       * This sentence was unconditional, so a live Hong Kong plan whose own
       * transport strategy says "No car needed anywhere in this city plan" also
       * carried "Parking has not been verified for this plan; check at each
       * stop." The traveller is being asked to check something they will never
       * do, on a trip the plan has just told them needs no car.
       *
       * The draft states the arrangement (`driving`), and a plan with none —
       * or one nobody drives themselves — has nothing to park.
       */
      parkingSummary: impliesSelfDriving(draft.driving) || (draft.driving === undefined && primaryMode === 'drive')
        ? 'Parking has not been verified for this plan; check at each stop.'
        : 'No parking to arrange — nothing on this trip is yours to park.',
      transitSummary: context.transit ? 'Some public-transport journeys were measured for this region.' : 'Public-transport journeys were not measured for this plan.',
      seasonalWarnings: context.region.seasonalRoadSummary ? [context.region.seasonalRoadSummary] : [],
      verifyBeforeTravel: unresolvedRelocations.map((r) => r.detail),
      totals: {
        driveMinutes: totals.driveMinutes,
        transitMinutes: totals.transitMinutes,
        walkMinutes: totals.walkMinutes,
        waitMinutes: totals.waitMinutes,
        unverifiedMinutes: totals.unverifiedMinutes,
        driveKm: Math.round(totals.driveKm * 10) / 10,
      },
      dataDisclosure: `${legsMeasured} of ${legsMeasured + legsUnmeasured} travel legs were measured by ${routerName}; ${legsEstimated > 0 ? `${legsEstimated} carry Sidequest's own estimate from map distance` : 'none were estimated'}${legsUnmeasured - legsEstimated > 0 ? ` and ${legsUnmeasured - legsEstimated} hold an allowance shown as a part of the day` : ''}. Base transfers were checked against your ${hardCeiling}-minute daily limit where measured.`,
    },
    foodPlan: {
      headline: draft.package.foodStrategy[0] ?? 'Meals follow the route.',
      style: context.profile.food.style.replace(/_/g, ' '),
      dietaryNeeds: [...context.profile.food.dietaryNeeds],
      dietaryStrict: context.profile.food.dietaryStrict,
      ...(context.profile.food.dietaryNeeds.length > 0 ? { dietaryDisclosure: dietaryDisclosureFor(context.profile) } : {}),
      specialMealsPlanned: 0,
      specialMealBudget: context.profile.food.specialMealBudget,
      groceryDayNumbers: [],
      packedDayNumbers: [],
      daysWithoutVerifiedOption: days.filter((day) => day.items.some((i) => i.kind === 'meal') && !day.items.some((i) => i.food?.stopKind === 'venue')).map((day) => day.dayNumber),
      localSpecialties: [...new Set(days.flatMap((day) => day.items.map((i) => i.food?.localSpecialty).filter((v): v is string => Boolean(v))))],
      unusedChoices: [],
      dataDisclosure:
        mealsNamed > 0
          ? `${mealsNamed} meal${mealsNamed === 1 ? '' : 's'} name${mealsNamed === 1 ? 's' : ''} a venue from the region's own food data (${context.food?.venues.length ?? 0} on record); the rest follow the composed draft. We have not checked today whether any is open, and nothing has been booked.`
          : 'Meal suggestions come from the composed draft; no venue, price or opening time has been verified, and we have not checked today.',
    },
    days,
    unscheduled,
    issues,
    diagnostics: {
      plannerVersion: PLANNER_VERSION,
      generatedAt: (context.now ?? new Date()).toISOString(),
      matrixProvenance: context.matrix.provenance.kind,
      matrixNote: context.matrix.provenance.note,
      operatingHoursVersion: OPERATING_HOURS_DATASET_VERSION,
      weatherDatasetVersion: WEATHER_DATASET_VERSION,
      weatherProvider: days[0]?.weather.provider ?? 'none',
      weatherEvidence: [...new Set(days.map((day) => day.weather.evidence))],
      weatherGeneratedAt: (context.now ?? new Date()).toISOString(),
      foodDatasetVersion: context.food ? FOOD_DATASET_VERSION : 0,
      foodVenuesConsidered: context.food?.venues.length ?? 0,
      revisionPasses: revisions.length > 0 ? 1 : 0,
      revisions,
      capacity: {
        usableMinutes: days.reduce((s, day) => s + day.window.usableMinutes, 0),
        activityMinutes: days.reduce((s, day) => s + day.totals.activityMinutes, 0),
        travelMinutes: days.reduce((s, day) => s + day.totals.travelMinutes, 0),
        freeMinutes: days.reduce((s, day) => s + day.totals.freeMinutes, 0),
      },
      counts: { considered: anchors.length, scheduled: scheduledCount, unscheduled: unscheduled.length },
    },
    package: pkg,
  };

  const daysWithActivity = days.filter((day) => day.items.some((item) => item.kind === 'activity')).length;
  const readiness = buildPlannerReadiness({
    funnel: {
      considered: anchors.length,
      selected: anchors.length,
      eligible: anchors.length,
      accessFeasible: anchors.length,
      hoursFeasible: anchors.length - packageAnchors.filter((a) => a.disposition === 'rejected_contradiction').length,
      feasible: anchors.length - rejectedCount,
      scheduled: scheduledCount,
    },
    unscheduled,
    dayCount: dates.length,
    daysWithFullMeals: days.filter((day) => day.items.filter((i) => i.kind === 'meal').length >= 2).length,
    unresolved: { routePairs: legsUnmeasured },
    profile: context.profile,
    daysWithActivity,
    usableDays: windows.filter((w) => w.capacityMinutes > 0).length,
    anchorableDays: windows.filter((w) => w.capacityMinutes > 0).length,
    usableDaysWithActivity: days.filter((day, i) => windows[i]!.capacityMinutes > 0 && day.items.some((item) => item.kind === 'activity')).length,
  });

  return {
    ok: true,
    itinerary,
    readiness,
    deviations,
    dispositions: packageAnchors,
    unresolvedRelocations,
    placement: placementReportSchema.parse({ version: 1, placements: placements.slice(0, 120), providerCalls: placementCalls, elapsedMs: Math.max(0, Math.round(Date.now() - reconcileStartedMs)) }),
    dayOrders: orderReports,
    gateway: gatewayPlan,
  };
}

/* ------------------------------------------------------------------ *
 * One day
 * ------------------------------------------------------------------ */

interface DayLayoutInput {
  dayNumber: number;
  date: string;
  window: PlannedDay;
  draftDay: TripDraft['days'][number] | undefined;
  base: ResolvedBase | null;
  previousBase: ResolvedBase | null;
  relocation: boolean;
  anchors: readonly ReconciledAnchor[];
  /** V7 §8 — the episode this day sits inside, when it does. */
  episode?: DraftEpisode | null;
  episodeEntersToday?: boolean;
  isLastDay?: boolean;
  context: ReconcileContext;
  extraMatrix: RouteMatrixResult | null;
  ledger: ReturnType<typeof emptyLedger>;
  hardCeiling: number;
  isFirst: boolean;
  isLast: boolean;
  /** Direct route confirmations (with geometry, basis, provider) keyed `from=>to`. */
  confirmationMemo?: ConfirmationMemo;
  /** When the reconciliation ran — stamped on measured legs. */
  measuredAt?: string;
  /** The weather dataset days read from — the route-aware one when the caller fetched it. */
  weather: WeatherDataset;
}

interface DroppedAnchor {
  anchor: ReconciledAnchor;
  disposition: Extract<AnchorDispositionCode, 'rejected_hard_constraint' | 'unscheduled_capacity'>;
  reason: string;
}

interface Point {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number } | null;
  /** The town this point sits in, when known — lets an untimed leg inside one town hold a small allowance rather than a transfer's. */
  locality?: string;
}

/**
 * PRODUCTION LOCK V5 §13 — A DAY RUNS IN THE ORDER ITS HOURS DO.
 *
 * Floors alone were not enough. A live build put a Sunday-morning livestock
 * market, marked `morning`, second on its day behind a stop with no stated hour,
 * and it landed at 12:45. A floor can hold a stop back; it cannot bring one
 * forward.
 *
 * So a day is stably sorted by the hour its stops asked for. Stops with no
 * intent keep their authored order and sit between the morning ones and the
 * midday-or-later ones, which is where filler belongs. Stable, so two stops with
 * the same intent — or none — stay in the sequence the model chose them in, and
 * the geography it sequenced them for survives.
 *
 * V10 §7 — extracted from `attemptLayout` so the spatial-order compiler judges
 * the order the day is actually *driven* in. It used to judge the authored order
 * and then this sort moved a sunset stop to the end behind its back, which meant
 * the check and the plan disagreed about what the day was.
 */
function orderByStatedHour(anchors: readonly ReconciledAnchor[]): ReconciledAnchor[] {
  const ORDER: Record<string, number> = { sunrise: 0, morning: 1, midday: 3, afternoon: 4, sunset: 5, evening: 6, night: 7 };
  const rankOf = (anchor: ReconciledAnchor) => ORDER[anchor.draft.timeOfDay ?? ''] ?? 2;
  return anchors
    .map((anchor, index) => ({ anchor, index }))
    .sort((a, b) => rankOf(a.anchor) - rankOf(b.anchor) || a.index - b.index)
    .map((entry) => entry.anchor);
}

/**
 * V10 §7 — THE DAY'S ORDER, CHECKED AND, WHERE IT IS SAFE, CORRECTED.
 *
 * The order arrives from the composition, and the composition cannot see the
 * map: the founder's trip drove past a roadside waterfall, went 30 km on,
 * doubled back 28 minutes for it and went east again. Nothing checked.
 *
 * This runs *before* the layout rather than after it, which is the whole reason
 * it can correct anything: the legs have not been built yet, so a reordering
 * costs nothing and the matrix goes on to measure the pairs the day actually
 * drives. Correcting after layout would mean carrying measured durations for
 * pairs the plan no longer visits.
 *
 * What may move: a stop with no binding time-of-day intent, on a day where every
 * stop and both endpoints are placed, where the reordering strictly shortens the
 * chain past the tolerance. Everything else is left exactly as composed and
 * reported instead — §7 forbids optimising blindly, and a sunset viewpoint, an
 * opening window or a deliberate scenic sequence outranks distance.
 */
function correctDayOrder(input: DayLayoutInput): { anchors: readonly ReconciledAnchor[]; report: SpatialOrderReport; corrected: boolean; softened: readonly string[] } {
  const pointOf = (b: ResolvedBase | null, fallbackId: string): { id: string; name: string; coordinates: { lat: number; lng: number } | null } =>
    b ? { id: b.identity?.id ?? `base:${b.skeletonBaseId}`, name: b.displayName ?? b.name, coordinates: b.identity?.coordinates ?? null } : { id: fallbackId, name: 'your base', coordinates: null };
  const origin = input.relocation && input.previousBase ? pointOf(input.previousBase, 'base:previous') : pointOf(input.base, 'base:start');
  const destination = pointOf(input.base, 'base:end');
  const authored = orderByStatedHour(input.anchors);
  const stops: OrderedStop[] = authored.map((anchor) => ({
    id: anchor.id,
    name: anchor.draft.name,
    coordinates: anchor.identity?.coordinates ?? null,
    /*
     * Pinned for a stated reason, never by default: a binding part of the day,
     * a multi-day episode's own sequence, or a stop whose hours the reconciler
     * has already read. A pinned stop holds its index and the search moves
     * around it.
     */
    ...(timeOfDayIsHard(anchor.draft.timeOfDay)
      ? { pinned: true as const, pinnedReason: `the plan puts this at ${anchor.draft.timeOfDay}` }
      : episodeIsOffRoad(input.episode ?? null)
        ? /*
           * An off-road episode's sequence belongs to the operator: a gorge on a
           * river cruise, a checkpoint on a trek, a station on a sleeper are
           * reached in the order the vessel, the trail or the timetable reaches
           * them, and no amount of geometry may reorder that. A `road_trip_segment`
           * is not that — it is a label for a stretch of days on a road, and its
           * stops are as free as any other day's.
           */
          { pinned: true as const, pinnedReason: `it sits inside ${input.episode!.name}` }
        : {}),
  }));
  const report = compileSpatialOrder({ origin, destination, stops });
  if (report.verdict !== 'violation' || report.bestOrder.length !== authored.length) return { anchors: authored, report, corrected: false, softened: [] };
  const byId = new Map(authored.map((a) => [a.id, a]));
  const reordered = report.bestOrder.map((id) => byId.get(id)).filter((a): a is ReconciledAnchor => a !== undefined);
  if (reordered.length !== authored.length) return { anchors: authored, report, corrected: false, softened: [] };
  /* A soft part-of-day hint that the reordering moved. Recorded, never silent. */
  const softened = reordered
    .filter((anchor, index) => timeOfDayIsBinding(anchor.draft.timeOfDay) && !timeOfDayIsHard(anchor.draft.timeOfDay) && authored[index]?.id !== anchor.id)
    .map((anchor) => `${anchor.draft.name} (${anchor.draft.timeOfDay})`);
  return { anchors: reordered, report, corrected: true, softened };
}

function layoutDay(input: DayLayoutInput): { day: ItineraryDay; dropped: DroppedAnchor[]; legsMeasured: number; legsUnmeasured: number; legsEstimated: number; order: SpatialOrderReport; orderCorrected: boolean; softened: readonly string[] } {
  const dropped: DroppedAnchor[] = [];
  const order = correctDayOrder(input);
  let kept = [...order.anchors];
  const ceiling = input.hardCeiling;

  // Hard constraint: measured driving on an ordinary day over the traveller's own ceiling.
  // Relocation days are judged by the transfer check already performed; only affirmative measured minutes count.
  /*
   * THE EDGES ARE HARD. A departure day ends at the departure (less the lead
   * the planner keeps), and a day the traveller closed with a hard back-by
   * hour ends at that hour: no tolerance, and even an essential stop comes
   * off rather than overrun the flight. An ordinary day keeps a small
   * tolerance, always stated on the day when it is used.
   */
  const hardEnd = input.isLast || input.context.profile.interview?.mustBeBackByMinute !== undefined;
  const tolerance = hardEnd ? 0 : LATE_END_TOLERANCE_MINUTES;
  for (;;) {
    const attempt = attemptLayout(input, kept);
    // The traveller's own hard ceiling: at the wheel on a driving trip, every
    // measured minute in motion on a car-free one.
    const t = attempt.day.totals;
    const measuredInMotion = input.context.matrix.mode === 'car' ? t.driveMinutes : t.driveMinutes + t.transitMinutes + t.walkMinutes + t.waitMinutes + t.unverifiedMinutes;
    const overDrive = !input.relocation && measuredInMotion > ceiling;
    /*
     * PRODUCT RECOVERY V1 — an estimate is not evidence. Travel Sidequest only
     * estimated (or merely held an allowance for) may make a day run long, and
     * the day says so; it never removes a stop the model placed. Only a
     * measured overrun past an ordinary day's end, or any overrun past a hard
     * edge (departure, a hard back-by hour), takes something off.
     */
    const softMinutes = hardEnd ? 0 : t.estimatedMinutes + t.allowanceMinutes;
    const overWindow = attempt.overflowMinutes > tolerance + softMinutes;
    if (!overDrive && !overWindow) {
      const day = attempt.overflowMinutes > 0
        ? { ...attempt.day, warnings: [...attempt.day.warnings, attempt.overflowMinutes > tolerance ? `This day runs about ${Math.round(attempt.overflowMinutes)} minutes past your usual end on estimated travel times; nothing was taken off, because an estimate is not evidence.` : `This day runs about ${Math.round(attempt.overflowMinutes)} minutes past your usual end.`] }
        : attempt.day;
      return { day, dropped, legsMeasured: attempt.legsMeasured, legsUnmeasured: attempt.legsUnmeasured, legsEstimated: attempt.legsEstimated, order: order.report, orderCorrected: order.corrected, softened: order.softened };
    }
    const victim = [...kept].sort((a, b) => ROLE_RANK[b.draft.role] - ROLE_RANK[a.draft.role] || b.index - a.index)[0];
    if (!victim) return { day: attempt.day, dropped, legsMeasured: attempt.legsMeasured, legsUnmeasured: attempt.legsUnmeasured, legsEstimated: attempt.legsEstimated, order: order.report, orderCorrected: order.corrected, softened: order.softened };
    if (victim.draft.role === 'core' && overDrive === false && !hardEnd) {
      // Core-only overflow on an ordinary day is kept as a long day and said so; core anchors are never dropped for room.
      const day = { ...attempt.day, warnings: [...attempt.day.warnings, `This day runs about ${Math.round(attempt.overflowMinutes)} minutes past your usual end; every stop on it was marked essential, so nothing was taken off.`] };
      return { day, dropped, legsMeasured: attempt.legsMeasured, legsUnmeasured: attempt.legsUnmeasured, legsEstimated: attempt.legsEstimated, order: order.report, orderCorrected: order.corrected, softened: order.softened };
    }
    if (victim.draft.role === 'core' && overDrive && kept.length === 1) {
      const day = { ...attempt.day, warnings: [...attempt.day.warnings, `Measured travel on this day (${measuredInMotion} min) exceeds your ${ceiling}-minute limit and the only stop is essential; kept, flagged for your decision.`] };
      return { day, dropped, legsMeasured: attempt.legsMeasured, legsUnmeasured: attempt.legsUnmeasured, legsEstimated: attempt.legsEstimated, order: order.report, orderCorrected: order.corrected, softened: order.softened };
    }
    kept = kept.filter((a) => a.id !== victim.id);
    dropped.push({
      anchor: victim,
      disposition: overDrive ? 'rejected_hard_constraint' : 'unscheduled_capacity',
      reason: overDrive
        ? `Measured ${input.context.matrix.mode === 'car' ? 'driving' : 'travel'} on day ${input.dayNumber} came to ${measuredInMotion} minutes against your ${ceiling}-minute limit, so ${victim.draft.name} (${victim.draft.role}) was taken off to bring it under.`
        : input.isLast
          ? `Day ${input.dayNumber} ends with your departure ${describeEdgeTime(input.context.basics.departurePrecision, input.context.basics.departureTime)}; ${victim.draft.name} (${victim.draft.role}) would have run past it, so it was left off rather than scheduled after you leave.`
          : hardEnd
            ? `You asked to be back at base by ${formatClock(input.context.profile.interview!.mustBeBackByMinute!)}; ${victim.draft.name} (${victim.draft.role}) would have run past it, so it was left off.`
            : `Day ${input.dayNumber} ran ${Math.round(attempt.overflowMinutes)} minutes past its end, so ${victim.draft.name} (${victim.draft.role}) was left off for room.`,
    });
  }
}

function attemptLayout(input: DayLayoutInput, anchors: readonly ReconciledAnchor[]): { day: ItineraryDay; overflowMinutes: number; legsMeasured: number; legsUnmeasured: number; legsEstimated: number } {
  const { context, window, draftDay, base, previousBase } = input;
  const canDrive = context.profile.transport.willDrive;
  const items: ItineraryItem[] = [];
  let clock = window.window.startMinute;
  let legsMeasured = 0;
  let legsUnmeasured = 0;
  let legsEstimated = 0;
  const modes: TransportMode[] = [];
  const totals = { driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 0, travelKm: 0, activityMinutes: 0, unmeasuredLegCount: 0 };
  /* V6 §12 — set when the base-to-base transfer of a relocation day is an allowance rather than a measurement or an estimate. */
  let unmeasuredMajorTransfer = false;
  let hadLunch = false;
  let hadDinner = false;

  const pointFor = (b: ResolvedBase): Point => ({ id: b.identity?.id ?? `base:${b.skeletonBaseId}`, name: b.displayName ?? b.identity?.name ?? b.name, coordinates: b.identity?.coordinates ?? null, ...(b.locality ?? b.displayName ? { locality: (b.locality ?? b.displayName)! } : {}) });
  const startPoint: Point = previousBase && input.relocation ? pointFor(previousBase) : base ? pointFor(base) : { id: 'base:unknown', name: 'your base', coordinates: null };
  const endPoint: Point = base ? pointFor(base) : { id: 'base:unknown', name: 'your base', coordinates: null };

  /**
   * A meal sits at its natural hour, never before it, and never past the
   * day's own end: a departure day that leaves at five has no dinner, and a
   * day whose stops finish at ten has lunch at half past eleven, not at ten.
   * Returns false when the window has no room for it.
   */
  const placeMeal = (slot: 'lunch' | 'dinner', intent: string | undefined, early = false): boolean => {
    const earliest = slot === 'lunch' ? LUNCH_EARLIEST : early ? DINNER_EARLIEST - 30 : DINNER_EARLIEST;
    const latest = slot === 'lunch' ? LUNCH_LATEST + 60 : DINNER_LATEST;
    const start = Math.max(clock, earliest);
    /* An evening that ends at seven still eats: dinner may run the day on by an hour, and the day's window follows it. */
    const hardEnd = input.isLast || /Back at base by/.test(window.window.note ?? '');
    const endAllowed = slot === 'dinner' && !hardEnd ? Math.min(window.window.endMinute + 60, latest) : Math.min(window.window.endMinute, latest);
    if (start + MEAL_MINUTES[slot] > endAllowed) return false;
    if (slot === 'dinner' && start + MEAL_MINUTES[slot] > window.window.endMinute) {
      window.window.usableMinutes += start + MEAL_MINUTES[slot] - window.window.endMinute;
      window.window.endMinute = start + MEAL_MINUTES[slot];
    }
    clock = start;
    pushMeal(slot, intent);
    return true;
  };

  const pushMeal = (slot: 'breakfast' | 'lunch' | 'dinner', intent: string | undefined) => {
    const minutes = MEAL_MINUTES[slot];
    /*
     * QUALITY V1 — a meal is content only when the draft means one. "none, in
     * transit" is the model saying there is no meal; a day whose window has
     * already closed (a 09:00 departure) has no room for one; breakfast after
     * midday is not breakfast. The live East Africa build placed "Breakfast —
     * none, arriving midday" at 17:00 and a breakfast after a 09:00 departure.
     */
    if (intent && /^\s*(none|no |nothing|skip|not needed|in transit|n\/a)/i.test(intent)) return;
    if (clock + minutes > window.window.endMinute) return;
    if (slot === 'breakfast' && clock > 11 * 60) return;
    const title = intent ? `${slot[0]!.toUpperCase()}${slot.slice(1)} — ${intent}` : `${slot[0]!.toUpperCase()}${slot.slice(1)}`;
    items.push({
      id: `d${input.dayNumber}-${slot}`,
      kind: 'meal',
      title,
      startMinute: clamp(clock),
      endMinute: clamp(clock + minutes),
      durationMinutes: clamp(clock + minutes) - clamp(clock),
      reason: intent ? 'What to look for and where, from the plan. Nothing here is booked.' : `A ${slot} slot in the day; the plan did not say where.`,
      weatherSensitive: false,
    });
    clock += minutes;
  };

  const memoFor = (a: string, b: string) => input.confirmationMemo?.get(`${a}=>${b}`) ?? input.confirmationMemo?.get(`${b}=>${a}`) ?? null;
  /*
   * PRODUCT RECOVERY V1 — UNKNOWN TRAVEL TIME IS NEVER ZERO.
   *
   * Every leg lands in exactly one duration state (see `core/travel/estimate`):
   * measured (a router timed this pair); estimated (both ends have a position,
   * so Sidequest holds a mode-aware figure from map distance, labelled as an
   * estimate and never as a road measurement); unknown (one end has no
   * position — the schedule holds a conservative allowance and the day is
   * shown in parts of the day, never in fake minutes). The model's transport
   * hint is checked against the geometry first: a "walk" over 75 km of open
   * country is a drive for a driver and transit for everyone else.
   */
  const episode = input.episode ?? null;
  const offRoad = episodeIsOffRoad(episode);
  const pushLeg = (from: Point, to: Point, hintGiven: DraftTransport | undefined, role: TravelSegment['role'], options: { inEpisode?: boolean } = {}) => {
    if (from.id === to.id) return;
    /*
     * V7 §8 — INSIDE AN OFF-ROAD EPISODE THE ROAD ROUTER IS NEVER ASKED.
     *
     * A gorge on a river cruise, a checkpoint on a trek, a station on a sleeper
     * are reached by the episode's own movement. The stop's hint, when it names
     * none, is the episode's mode; the leg is never measured on roads, never
     * "corrected" to a drive because it is 90 km apart, and carries the
     * episode's name so every surface draws it as what it is.
     */
    const inEpisode = options.inEpisode === true && episode !== null;
    /* Inside any episode a stop with no hint of its own moves the episode's way: a game drive on a safari, a boat on a cruise. */
    const hint: DraftTransport | undefined = inEpisode ? (hintGiven ?? episodeHint(episode)) : hintGiven;
    if (inEpisode && offRoad && episode) {
      const mode = transportModeFor(hint, context.matrix.mode, canDrive);
      const fromCoordinates = from.coordinates;
      const toCoordinates = to.coordinates;
      const straightLineKm = fromCoordinates && toCoordinates ? haversineKm(fromCoordinates, toCoordinates) : null;
      if (straightLineKm !== null && straightLineKm <= 0.15) return;
      const estimate = episode.mode === 'walk' && fromCoordinates && toCoordinates ? estimateLegMinutes({ from: fromCoordinates, to: toCoordinates, mode: 'walk' }) : null;
      const operatorTimed = episode.timing !== 'self';
      const allowance = estimate ? null : operatorTimed ? 45 : 60;
      const duration = estimate ? estimate.minutes : allowance!;
      const stamp = input.measuredAt ?? new Date().toISOString();
      const travel: TravelSegment = {
        fromId: from.id,
        toId: to.id,
        fromName: from.name,
        toName: to.name,
        minutes: estimate ? estimate.minutes : null,
        km: null,
        mode,
        role,
        provenance: estimate ? 'estimated' : 'unmeasured',
        ...(estimate ? { basis: 'estimated', measuredAt: stamp, provider: 'sidequest-geo-estimate', estimateKind: 'geo' as const, estimate: { straightLineKm: Math.round(estimate.straightLineKm * 10) / 10, approxKm: estimate.approxKm, kmh: estimate.kmh } } : { unmeasuredReason: operatorTimed ? 'operator_unpublished' : 'mode_not_routed' }),
        episode: episode.name,
        episodeMode: episode.mode,
        ...(hint ? { hint } : {}),
      };
      items.push({
        id: `d${input.dayNumber}-leg-${items.length}`,
        kind: 'travel',
        title: `${episodeLegLabel(episode)} ${to.name}`,
        startMinute: clamp(clock),
        endMinute: clamp(clock + duration),
        durationMinutes: clamp(clock + duration) - clamp(clock),
        travel,
        reason: estimate
          ? `About ${estimate.minutes} min on foot, estimated from map distance (roughly ${estimate.approxKm} km) — part of ${episode.name}.`
          : operatorTimed
            ? `Part of ${episode.name}: the operator's timetable sets this, so the day shows parts of the day rather than clock times until it is confirmed.`
            : `Part of ${episode.name}; timing is yours and not measured.`,
        weatherSensitive: false,
        timing: { precision: estimate ? 'estimated' : 'band', ...(allowance !== null ? { allowanceMinutes: allowance } : {}) },
      });
      clock += duration;
      legsUnmeasured += 1;
      totals.unmeasuredLegCount += 1;
      if (estimate) {
        legsEstimated += 1;
        totals.estimatedMinutes += duration;
      } else totals.allowanceMinutes += duration;
      if (!modes.includes(mode)) modes.push(mode);
      return;
    }
    // LIVE WORLD V1 — on a transit-mode trip a metro/rail/bus hint is what the network measures, not a mode the road router refuses.
    const routable = roadRoutable(hint) || (context.matrix.mode === 'transit' && (hint === 'metro' || hint === 'rail' || hint === 'bus'));
    let measured = from.coordinates && to.coordinates && routable ? measuredLeg(context.matrix, input.extraMatrix, from.id, to.id) : null;
    let confirmation = measured ? memoFor(from.id, to.id) : null;
    let viaBases = false;
    if (!measured && role === 'transfer' && input.previousBase?.identity && input.base?.identity && routable) {
      const prevId = input.previousBase.identity.id;
      const nextId = input.base.identity.id;
      const baseLeg = measuredLeg(context.matrix, input.extraMatrix, prevId, nextId);
      if (baseLeg) {
        measured = baseLeg;
        confirmation = memoFor(prevId, nextId);
        viaBases = true;
      }
    }
    if (measured && confirmation && confirmation.minutes !== null) measured = { minutes: confirmation.minutes, km: confirmation.km ?? measured.km };
    const hinted = transportModeFor(hint, context.matrix.mode, canDrive);
    /*
     * An unresolved stop that the draft places in the base's own town (a
     * "Latin Quarter evening walk" in Galway) has no coordinate of its own,
     * but the town does: the base stands in for it, so the leg into town is
     * estimated rather than left as an allowance, and a "walk" from the
     * Burren into Galway is seen for the 40 km it is.
     */
    const baseLocality = base?.locality ?? base?.displayName;
    const proxyFor = (point: Point) => point.coordinates ?? (point.locality && base?.identity && baseLocality && normalizeName(point.locality) === normalizeName(baseLocality) ? base.identity.coordinates : null);
    const fromCoordinates = proxyFor(from);
    const toCoordinates = proxyFor(to);
    const straightLineKm = fromCoordinates && toCoordinates ? haversineKm(fromCoordinates, toCoordinates) : null;
    // Two distinct identities at the same spot (a town and its own harbour walk) are one place: no leg, no minutes.
    if (!measured && straightLineKm !== null && straightLineKm <= 0.15) return;
    const crossLocality = Boolean(from.locality && to.locality && normalizeName(from.locality) !== normalizeName(to.locality));
    const plausible = plausibleModeFor({ hinted, straightLineKm: straightLineKm ?? (crossLocality && hinted === 'walk' ? Number.POSITIVE_INFINITY : null), canDrive, transitTrip: context.matrix.mode === 'transit' });
    const mode = plausible.mode;
    const estimate = !measured && routable && fromCoordinates && toCoordinates ? estimateLegMinutes({ from: fromCoordinates, to: toCoordinates, mode }) : null;
    const noRouteAnswered = ledgerFailureReason(input.ledger, from.id, to.id) === AUTHORITATIVE_NO_ROUTE || ledgerFailureReason(input.ledger, to.id, from.id) === AUTHORITATIVE_NO_ROUTE;
    const unmeasuredReason: TravelSegment['unmeasuredReason'] = !routable || mode === 'unsupported' || mode === 'ferry' || mode === 'private_transfer' ? 'mode_not_routed' : noRouteAnswered ? 'no_route_found' : 'provider_unavailable';
    const minutes = measured?.minutes ?? estimate?.minutes ?? null;
    const km = measured?.km ?? null;
    const geometry = confirmation?.geometry && confirmation.geometry.length > 1 ? encodePolyline(simplifyPolyline(confirmation.geometry)) : undefined;
    const basis: TravelSegment['basis'] = measured ? (confirmation?.basis ?? (context.matrix.mode === 'transit' ? 'scheduled' : 'static')) : estimate ? 'estimated' : undefined;
    const sameLocality = Boolean(from.locality && to.locality && normalizeName(from.locality) === normalizeName(to.locality));
    const allowance = !measured && !estimate ? unknownLegAllowanceMinutes({ mode, sameLocality, role }) : null;
    const stamp = input.measuredAt ?? new Date().toISOString();
    const travel: TravelSegment = {
      fromId: from.id,
      toId: to.id,
      fromName: from.name,
      toName: to.name,
      minutes,
      km,
      mode,
      role,
      provenance: measured ? 'measured' : estimate ? 'estimated' : 'unmeasured',
      ...(measured || estimate ? {} : { unmeasuredReason }),
      ...(basis ? { basis } : {}),
      ...(measured ? { measuredAt: confirmation?.measuredAt ?? stamp, provider: confirmation?.provider ?? (context.matrix.provenance.kind === 'measured' ? 'routing-matrix' : `${context.matrix.provenance.kind}-road-data`) } : {}),
      ...(estimate ? { measuredAt: stamp, provider: 'sidequest-geo-estimate', estimateKind: 'geo' as const, estimate: { straightLineKm: Math.round(estimate.straightLineKm * 10) / 10, approxKm: estimate.approxKm, kmh: estimate.kmh } } : {}),
      ...(plausible.corrected ? { modeCorrectedFrom: hinted } : {}),
      ...(hint ? { hint } : {}),
      ...(confirmation?.staticMinutes !== undefined ? { staticMinutes: confirmation.staticMinutes } : {}),
      ...(confirmation?.effectiveDepartAt ? { effectiveDepartAt: confirmation.effectiveDepartAt } : {}),
      ...(confirmation?.transitSummary ? { transitSummary: confirmation.transitSummary } : {}),
      ...(geometry ? { geometry } : {}),
      ...(viaBases ? { viaBases: true as const } : {}),
    };
    const duration = measured ? measured.minutes : estimate ? estimate.minutes : allowance!;
    const precision: NonNullable<ItineraryItem['timing']>['precision'] = measured ? (basis === 'scheduled' ? 'fixed' : 'measured') : estimate ? 'estimated' : 'band';
    items.push({
      id: `d${input.dayNumber}-leg-${items.length}`,
      kind: 'travel',
      title: `${measured || estimate ? `${labelFor(mode)} to` : 'Travel to'} ${to.name}`,
      startMinute: clamp(clock),
      endMinute: clamp(clock + duration),
      durationMinutes: clamp(clock + duration) - clamp(clock),
      travel,
      reason: measured
        ? `${measured.minutes} min ${basis === 'traffic_aware' ? 'with traffic' : basis === 'scheduled' ? 'from a timetable' : 'measured'}${km !== null ? `, ${Math.round(km)} km` : ''}${viaBases ? ' base to base; today’s stops sit along the way' : ''}.`
        : estimate
          ? `About ${estimate.minutes} min by ${labelFor(mode).toLowerCase()}, estimated from map distance (roughly ${estimate.approxKm} km) — not a measured route.${plausible.corrected ? ` The plan said ${labelFor(hinted).toLowerCase()}; ${Math.round(straightLineKm ?? 0)} km apart is not a ${labelFor(hinted).toLowerCase()}.` : ''}`
          : hint && !roadRoutable(hint)
            ? `${hint.replace(/_/g, ' ')} — a journey Sidequest's road router cannot measure; the day holds ${duration} minutes for it and shows times as parts of the day.`
            : `Travel time not measured or estimated for this leg; the day holds a ${duration}-minute allowance and shows times as parts of the day.`,
      weatherSensitive: false,
      timing: { precision, ...(allowance !== null ? { allowanceMinutes: allowance } : {}) },
    });
    clock += duration;
    if (measured) {
      legsMeasured += 1;
      if (mode === 'drive') totals.driveMinutes += duration;
      else if (mode === 'walk') totals.walkMinutes += duration;
      else if (mode === 'rail' || mode === 'public_bus' || mode === 'shuttle' || mode === 'ferry') totals.transitMinutes += duration;
      else totals.unverifiedMinutes += duration;
      totals.travelKm += km ?? 0;
    } else {
      legsUnmeasured += 1;
      totals.unmeasuredLegCount += 1;
      if (estimate) {
        legsEstimated += 1;
        totals.estimatedMinutes += duration;
      } else {
        /*
         * V7 §9 — a transfer the router could not time because it is a flight,
         * a train, a boat or an arranged transfer is a booking with a timetable,
         * not a measurement gap: the feasibility report reads it from the leg's
         * own mode. Only a road transfer nobody could time or estimate is the
         * "major transfer not measured" dependency.
         */
        if (role === 'transfer' && roadRoutable(hint) && mode !== 'ferry' && mode !== 'private_transfer' && mode !== 'unsupported') unmeasuredMajorTransfer = true;
        totals.allowanceMinutes += duration;
      }
    }
    if (!modes.includes(mode)) modes.push(mode);
  };

  if (draftDay?.meals?.breakfast) pushMeal('breakfast', draftDay.meals.breakfast);

  /*
   * PRODUCTION LOCK V5 §13 — A DAY RUNS IN THE ORDER ITS HOURS DO.
   *
   * Floors alone were not enough. A live Kyrgyzstan build put "Karakol animal
   * bazaar" — a Sunday-morning livestock market, marked `morning` — second on
   * its day, behind a stop with no stated hour, and it landed at 12:45. A floor
   * can hold a stop back; it cannot bring one forward.
   *
   * So a day is stably sorted by the hour its stops asked for. Stops with no
   * intent keep their authored order and sit between the morning ones and the
   * midday-or-later ones, which is where filler belongs. Stable, so two stops
   * with the same intent — or none — stay in the sequence the model chose them
   * in, and the geography it sequenced them for survives.
   */
  /*
   * V10 §7 — the order is already settled: `layoutDay` applied the stated-hour
   * sort and then the spatial-order compiler to it. Re-sorting here would undo
   * the correction, which is exactly the bug that put a "morning" waterfall 30 km
   * past the one that was on the way to it.
   */
  const scheduledOrder = anchors;

  let cursor = startPoint;
  /*
   * V7 §9 — A MOVE THAT OPENS THE DAY. "Disembark at Yichang, then explore"
   * and "fly to Chongqing, then the old town" put the transfer first, and the
   * day's stops start from the new base. The draft says so with `move.when`;
   * absent, the transfer closes the day as it always did.
   */
  const move = draftDay?.move;
  const moveFirst = Boolean(input.relocation && move && move.when === 'start');
  if (moveFirst) {
    pushLeg(startPoint, endPoint, move!.how, 'transfer');
    cursor = endPoint;
  }
  const episodeStopIds = new Set(input.anchors.map((a) => a.id));
  for (const anchor of scheduledOrder) {
    // The plan keeps the name the model wrote; a geocoder's record name ("Trinity College Dublin" for "Trinity College and the Book of Kells") is matched against, never shown as the stop.
    const target: Point = { id: anchor.identity?.id ?? `draft:${anchor.id}`, name: anchor.draft.name, coordinates: anchor.identity?.coordinates ?? null, ...(anchor.draft.locality ? { locality: anchor.draft.locality } : {}) };
    /* A stop inside an episode is reached by the episode's movement unless the day is the one that enters it and this is the first stop (the approach to the pier or trailhead is ordinary travel). */
    const firstStopOnEntryDay = input.episodeEntersToday === true && cursor === startPoint && !moveFirst;
    /*
     * A named dinner before an evening stop: "hotpot, then Hongyadong after
     * dark" is dinner at seven and the skyline at eight, not the skyline and
     * then nowhere to eat because the day's window closed. The live Chongqing
     * arrival day lost its only meal this way.
     */
    if (!hadDinner && draftDay?.meals?.dinner && (anchor.draft.timeOfDay === 'evening' || anchor.draft.timeOfDay === 'night') && clock >= DINNER_EARLIEST - 30) {
      clock = Math.max(clock, DINNER_EARLIEST - 30);
      hadDinner = placeMeal('dinner', draftDay.meals.dinner, true);
    }
    pushLeg(cursor, target, anchor.draft.transport, 'approach', { inEpisode: episode !== null && episodeStopIds.has(anchor.id) && !firstStopOnEntryDay });
    if (!hadLunch && clock >= LUNCH_EARLIEST && clock <= LUNCH_LATEST) {
      hadLunch = placeMeal('lunch', draftDay?.meals?.lunch);
    }
    let start = clock;
    const hours = anchor.place ? hoursOn(context, anchor.place.id, input.date) : null;
    if (hours && start < hours.openMinute) {
      // Arrive when the gate opens; the gap becomes free time below.
      start = hours.openMinute;
    }
    /*
     * PRODUCTION LOCK V5 §13 — AN EXPERIENCE THAT DEPENDS ON THE HOUR WAITS FOR IT.
     *
     * The draft says when a stop belongs (`timeOfDay`) and nothing here read it,
     * so a live Hong Kong build scheduled Temple Street NIGHT Market at 13:30,
     * Victoria Peak "at dusk" at 14:20 and a harbour crossing meant for the
     * afternoon at 09:25. The plan was not merely imprecise; it sent somebody to
     * a night market in the early afternoon, when it is not there.
     *
     * The mechanism is the one directly above: a floor on the start, with the
     * gap becoming free time. Deliberately a floor and not a reorder — the model
     * had already sequenced these days correctly, and reordering by clock would
     * fight the geography it sequenced them for.
     *
     * Never applied when it would push the stop out of the day. A stop that
     * cannot reach its hour stays where it is and keeps its place in the trip:
     * unknown ≠ false, and a slightly early visit beats a deleted one.
     */
    const intentFloor = timeOfDayFloor(anchor.draft.timeOfDay);
    if (intentFloor !== null && start < intentFloor && intentFloor + anchor.durationMinutes <= input.window.window.endMinute) {
      start = intentFloor;
    }
    /*
     * LIVE WORLD V1 closure — a provider-identified stop's regular hours
     * shape the visit the same way a board calendar does: arrive at
     * opening, note a visit that runs past closing. The window itself is
     * not stored; the Sidequest outcome and provenance are.
     */
    let operational: ScheduledOperational | undefined;
    if (!anchor.place && anchor.operationalEvidence !== undefined && anchor.operationalClass) {
      const provisional = assessOperational({ evidence: anchor.operationalEvidence, placeClass: anchor.operationalClass, date: input.date, startMinute: start, endMinute: start + anchor.durationMinutes, daysUntil: Math.round((Date.parse(`${input.date}T00:00:00Z`) - (context.now ?? new Date()).getTime()) / 86_400_000) });
      if (provisional.window && start < provisional.window.openMinute && provisional.window.openMinute + anchor.durationMinutes <= input.window.window.endMinute) start = provisional.window.openMinute;
      const final = provisional.window && start !== clock ? assessOperational({ evidence: anchor.operationalEvidence, placeClass: anchor.operationalClass, date: input.date, startMinute: start, endMinute: start + anchor.durationMinutes, daysUntil: Math.round((Date.parse(`${input.date}T00:00:00Z`) - (context.now ?? new Date()).getTime()) / 86_400_000) }) : provisional;
      operational = final.outcome === 'not_applicable' ? undefined : (start !== clock && final.outcome === 'open_at_time' ? { ...final.persisted, outcome: 'opens_later', note: `Arrival moved to opening time on its regular schedule (read ${final.persisted.checkedAt.slice(0, 10)}).${final.persisted.recheck ? ' Regular hours can change; check again within a week of the visit.' : ''}`, recheck: true } : final.persisted);
    }
    const end = start + anchor.durationMinutes;
    const verificationCopy =
      anchor.verification === 'verified' || anchor.kind !== 'named_place'
        ? undefined
        : anchor.verification === 'partially_verified'
          ? 'A real place at this name was confirmed; hours and access have not been.'
          : 'This could not be independently confirmed as a specific place; confirm details locally.';
    items.push({
      id: anchor.id,
      kind: 'activity',
      title: anchor.draft.name,
      startMinute: clamp(start),
      endMinute: clamp(end),
      durationMinutes: clamp(end) - clamp(start),
      ...(anchor.identity ? { placeId: anchor.identity.id } : {}),
      reason: anchor.draft.why,
      note: `${anchor.draft.role} · ${anchor.draft.category.replace(/_/g, ' ')} · ${anchor.durationBasis === 'model_estimate' ? "your plan's own time estimate" : anchor.durationBasis === 'place_record' ? 'typical visit length on record' : 'a typical visit length for this kind of place'}`,
      weatherSensitive: anchor.candidate?.place.weather?.poorWeatherBackup === false,
      ...(anchor.candidate?.place.physicalIntensity ? { physicalIntensity: anchor.candidate.place.physicalIntensity } : {}),
      ...(hours ? { hours } : {}),
      ...(operational ? { operational } : {}),
      ...(verificationCopy && !(operational && (operational.outcome === 'open_at_time' || operational.outcome === 'opens_later' || operational.outcome === 'closes_earlier')) ? { accessWarning: verificationCopy } : {}),
      ...(anchor.candidate && anchor.candidate.fit.cautions.length > 0 ? { verifyBeforeTravel: anchor.candidate.fit.cautions[0]! } : {}),
    });
    if (hours && end > hours.closeMinute) {
      items[items.length - 1] = { ...items[items.length - 1]!, note: `${items[items.length - 1]!.note} · may run past the published closing time (${formatClock(hours.closeMinute)}); check hours` };
    }
    totals.activityMinutes += clamp(end) - clamp(start);
    clock = end;
    cursor = target;
  }

  if (!hadLunch && anchors.length > 0 && clock <= LUNCH_LATEST) {
    hadLunch = placeMeal('lunch', draftDay?.meals?.lunch);
  }
  if (!moveFirst) {
    /* The day's own move names the transfer's mode; failing that, the first stop's hint; an ordinary day returns to base. */
    const transferHint = input.relocation ? (move?.how ?? draftDay?.anchors[0]?.transport) : undefined;
    pushLeg(cursor, endPoint, transferHint, input.relocation ? 'transfer' : 'return', { inEpisode: episode !== null && !input.relocation && cursor !== startPoint });
  } else if (cursor !== endPoint) {
    pushLeg(cursor, endPoint, undefined, 'return', { inEpisode: episode !== null && offRoad });
  }
  /*
   * V7 §9 — THE LAST DAY REACHES THE DEPARTURE GATEWAY. A plan that ends on a
   * ship at Yichang and flies home from Chongqing has a flight on its last
   * day; the draft says so with `move`, and the leg is built here so the
   * budget counts it, the bookings list it and the days show it.
   */
  if (input.isLastDay && !input.relocation && move) {
    const gatewayName = move.via ?? 'the departure gateway';
    const gateway: Point = { id: `gateway:${normalizeName(gatewayName).replace(/\s+/g, '-') || 'departure'}`, name: gatewayName, coordinates: null };
    pushLeg(endPoint, gateway, move.how, 'transfer');
  }
  if (!hadLunch && draftDay?.meals?.lunch && clock <= LUNCH_LATEST) {
    placeMeal('lunch', draftDay.meals.lunch);
  }
  if (!hadDinner && (draftDay?.meals?.dinner || !input.isLast)) {
    placeMeal('dinner', draftDay?.meals?.dinner);
  }

  const overflowMinutes = Math.max(0, clock - window.window.endMinute);

  // Free time: every gap of at least half an hour, including the end of the day.
  const ordered = [...items].sort((a, b) => a.startMinute - b.startMinute);
  const gaps: { start: number; end: number }[] = [];
  let free = window.window.startMinute;
  for (const item of ordered) {
    if (item.startMinute - free >= MIN_FREE_BLOCK_MINUTES) gaps.push({ start: free, end: item.startMinute });
    free = Math.max(free, item.endMinute);
  }
  if (window.window.endMinute - free >= MIN_FREE_BLOCK_MINUTES) gaps.push({ start: free, end: window.window.endMinute });
  const freeItems: ItineraryItem[] = gaps.map((g) => ({
    id: `d${input.dayNumber}-free-${g.start}`,
    kind: 'free_time',
    title: 'Free time',
    startMinute: g.start,
    endMinute: g.end,
    durationMinutes: g.end - g.start,
    reason: draftDay?.note ?? 'Deliberately unbooked. A plan with no slack in it is a plan that breaks.',
    weatherSensitive: false,
  }));
  const freeMinutes = freeItems.reduce((s, i) => s + i.durationMinutes, 0);
  const allItems = [...ordered, ...freeItems].sort((a, b) => a.startMinute - b.startMinute || (a.kind === 'free_time' ? 1 : -1));

  const travelMinutes = totals.driveMinutes + totals.transitMinutes + totals.walkMinutes + totals.waitMinutes + totals.unverifiedMinutes + totals.estimatedMinutes + totals.allowanceMinutes;
  const primaryMode: TransportMode = modes.length > 0 ? modes.reduce((best, mode) => (minutesByMode(allItems, mode) > minutesByMode(allItems, best) ? mode : best), modes[0]!) : canDrive ? 'drive' : 'walk';
  const warnings: string[] = [];
  const unverifiedCount = anchors.filter((a) => a.kind === 'named_place' && a.verification !== 'verified').length;
  if (unverifiedCount > 0) warnings.push(`${unverifiedCount} stop${unverifiedCount === 1 ? '' : 's'} on this day ${unverifiedCount === 1 ? 'has' : 'have'} not been fully verified — hours and access are approximate until confirmed locally.`);
  const unknownLegs = legsUnmeasured - legsEstimated;
  if (unknownLegs > 0) warnings.push(`${unknownLegs} travel leg${unknownLegs === 1 ? '' : 's'} on this day could not be timed; times are shown as parts of the day.`);
  else if (legsEstimated > 0) warnings.push(`Travel times on this day are Sidequest's estimates from map distance, not measured routes.`);
  if (input.relocation && previousBase && base) warnings.push(`You move from ${previousBase.displayName ?? previousBase.identity?.name ?? previousBase.name} to ${base.displayName ?? base.identity?.name ?? base.name} today.`);

  const anchoredHours = ordered.find((i) => i.kind === 'activity' && i.hours);
  const day: ItineraryDay = {
    dayNumber: input.dayNumber,
    date: input.date,
    baseId: endPoint.id,
    baseName: endPoint.name,
    theme: draftDay?.theme ?? (input.relocation ? `Moving on to ${endPoint.name}` : 'An open day'),
    window: window.window,
    items: allItems,
    ...(draftDay?.split ? { split: draftDay.split } : {}),
    totals: { ...totals, travelMinutes, travelKm: Math.round(totals.travelKm * 10) / 10, freeMinutes, strenuousCount: anchors.filter((a) => a.candidate?.place.physicalIntensity === 'strenuous' || a.draft.category === 'hike').length, ...(unmeasuredMajorTransfer ? { unmeasuredMajorTransfer: true } : {}) },
    transport: {
      primaryMode,
      modes,
      serviceIds: [],
      parkingNotes: [],
      accessNotes: draftDay?.note ? [draftDay.note] : [],
      verifyBeforeTravel: anchors.filter((a) => a.draft.transport && !roadRoutable(a.draft.transport)).map((a) => `${a.draft.name}: reached by ${a.draft.transport!.replace(/_/g, ' ')} — confirm timings and operators locally.`),
    },
    availability: {
      ...(anchoredHours?.placeId && anchoredHours.hours
        ? { anchorPlaceId: anchoredHours.placeId, anchorNote: `${anchoredHours.title} sets the shape of this day: open ${formatClock(anchoredHours.hours.openMinute)}–${formatClock(anchoredHours.hours.closeMinute)}${anchoredHours.hours.lastAdmissionMinute !== undefined ? `, last entry ${formatClock(anchoredHours.hours.lastAdmissionMinute)}` : ''}.` }
        : {}),
      flexiblePlaceIds: ordered.filter((i) => i.kind === 'activity' && !i.hours && i.placeId).map((i) => i.placeId!),
      cautions: [],
      verifyBeforeTravel: anchors.filter((a) => a.verification !== 'verified').map((a) => `${a.draft.name}: hours not verified.`),
      bookings: [],
    },
    weather: weatherSummaryFor(input.weather, input.date, endPoint.coordinates ?? startPoint.coordinates),
    food: {
      summary: draftDay?.meals ? [draftDay.meals.breakfast, draftDay.meals.lunch, draftDay.meals.dinner].filter(Boolean).join(' · ') || 'Meals are time held on this day.' : 'Meals are time held on this day; nothing has been booked.',
      slots: ordered.filter((i) => i.kind === 'meal').map((i) => i.id.endsWith('breakfast') ? 'breakfast' : i.id.endsWith('lunch') ? 'lunch' : 'dinner'),
      remote: false,
      notes: [],
      reservations: [],
    },
    intensity: draftDay?.intensity ?? 'light',
    warnings,
    timing: { precision: ((p) => (p === 'fixed' ? 'measured' : p))(dayPrecisionOf(allItems)), estimatedLegs: legsEstimated, unknownLegs },
  };
  return { day, overflowMinutes, legsMeasured, legsUnmeasured, legsEstimated };
}

function minutesByMode(items: readonly ItineraryItem[], mode: TransportMode): number {
  return items.reduce((s, i) => s + (i.travel?.mode === mode ? i.durationMinutes : 0), 0);
}

function hoursOn(context: ReconcileContext, placeId: string, date: string): ItineraryItem['hours'] | null {
  const calendar = findOperatingCalendar(context.hours, placeId);
  if (!calendar || calendar.kind === 'unknown') return null;
  const on = operatingOn(calendar, date);
  const first = on.windows[0];
  if (on.status !== 'open' || !first) return null;
  return {
    openMinute: first.openMinute,
    closeMinute: first.closeMinute,
    ...(first.lastAdmissionMinute !== null ? { lastAdmissionMinute: first.lastAdmissionMinute } : {}),
    ...(on.periodLabel ? { periodLabel: on.periodLabel } : {}),
    sourceKind: calendar.provenance.kind,
    sourceName: calendar.provenance.sourceName,
    ...(calendar.provenance.sourceUrl ? { sourceUrl: calendar.provenance.sourceUrl } : {}),
    ...(calendar.provenance.lastVerified ? { lastVerified: calendar.provenance.lastVerified } : {}),
    confidence: calendar.provenance.confidence,
  };
}

function labelFor(mode: TransportMode): string {
  switch (mode) {
    case 'drive':
      return 'Drive';
    case 'walk':
      return 'Walk';
    case 'rail':
      return 'Train';
    case 'public_bus':
      return 'Bus';
    case 'ferry':
      return 'Ferry';
    case 'shuttle':
      return 'Shuttle';
    default:
      return 'Travel';
  }
}

function clamp(minute: number): number {
  return Math.max(0, Math.min(MAX_MINUTE, Math.round(minute)));
}

function formatClock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}


/* ------------------------------------------------------------------ *
 * Food enrichment — additive, from the region's own venue data
 * ------------------------------------------------------------------ */

const VENUE_SEARCH_KM = 25;
const MAX_TIMES_ONE_VENUE_IS_NAMED = 2;

function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Mirrors the planner's own sentence: never "safe", never "suitable", always ending with what the traveller must do. */
function dietaryDisclosureFor(profile: TravelerProfile): string {
  const labels = profile.food.dietaryNeeds.map((need) => DIETARY_NEED_LABELS[need].toLowerCase());
  const list = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  const medical = profile.food.dietaryNeeds.some((need) => MEDICAL_OR_OBSERVANT_NEEDS.includes(need));
  const base = `We only say a venue handles ${list} when the venue itself has published that it does, and we quote them.`;
  if (profile.food.dietaryStrict || medical) {
    return `${base} That is a menu claim, not a kitchen one — nothing here establishes how anything is prepared or what it is prepared beside, so confirm it with them directly before you rely on it.`;
  }
  return `${base} Where nobody has said either way, we say so rather than assume.`;
}

function venueHoursOn(venue: FoodVenue, date: string): ItineraryItem['food'] extends infer F ? (F extends { hours?: infer H } ? H | null : never) : never {
  if (venue.hours.kind !== 'scheduled') return null;
  const on = operatingOn(venue.hours, date);
  const first = on.windows[0];
  if (on.status !== 'open' || !first) return null;
  return {
    openMinute: first.openMinute,
    closeMinute: first.closeMinute,
    ...(on.periodLabel ? { periodLabel: on.periodLabel } : {}),
    confidence: venue.hours.hoursConfidence,
    sourceKind: venue.source.kind === 'official' ? 'official' : venue.source.kind === 'curated' ? 'authored' : 'estimated',
    sourceName: venue.source.name,
    ...(venue.source.url ? { sourceUrl: venue.source.url } : {}),
    ...(venue.source.lastVerified ? { lastVerified: venue.source.lastVerified } : {}),
  };
}

/**
 * For each lunch and dinner on the day, the nearest venue in the region's own
 * food data that serves that meal, sits within the everyday price band, is
 * within reach of where the traveller already is, and has not been named more
 * than twice on the trip. A meal with no such venue keeps the draft's own
 * intent, plainly. Returns how many meals were named.
 */
function nameVenuesForDay(
  day: ItineraryDay,
  food: FoodDataset,
  profile: TravelerProfile,
  anchorCoordinates: ReadonlyMap<string, { lat: number; lng: number }>,
  base: { lat: number; lng: number } | null,
  venueUse: Map<string, number>,
): number {
  let named = 0;
  const items = day.items;
  const bandCeiling = PRICE_BAND_ORDER[profile.food.everydayPriceBand];
  for (const [index, item] of items.entries()) {
    if (item.kind !== 'meal') continue;
    const slot: 'lunch' | 'dinner' | null = item.id.endsWith('lunch') ? 'lunch' : item.id.endsWith('dinner') ? 'dinner' : null;
    if (!slot) continue;
    // Where the traveller is at this meal: the last stop before it, or the base.
    let near: { lat: number; lng: number } | null = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const previous = items[i]!;
      if (previous.kind === 'activity') {
        near = anchorCoordinates.get(previous.id) ?? null;
        if (near) break;
      }
    }
    const atBase = near === null;
    const origin = near ?? base;
    if (!origin) continue;
    const candidates = food.venues
      .filter((venue) => venue.mealPeriods.includes(slot))
      .filter((venue) => PRICE_BAND_ORDER[venue.priceBand] <= bandCeiling)
      .filter((venue) => (venueUse.get(venue.id) ?? 0) < MAX_TIMES_ONE_VENUE_IS_NAMED)
      .filter((venue) => venue.hours.kind === 'unknown' || venue.hours.kind === 'always_open' || operatingOn(venue.hours, day.date).status !== 'closed')
      .map((venue) => ({ venue, km: kmBetween(origin, venue.coordinates) }))
      .filter((entry) => entry.km <= VENUE_SEARCH_KM)
      .sort((a, b) => a.km - b.km);
    const best = candidates[0];
    if (!best) continue;
    const { venue } = best;
    venueUse.set(venue.id, (venueUse.get(venue.id) ?? 0) + 1);
    const hours = venueHoursOn(venue, day.date);
    const declared = profile.food.dietaryNeeds;
    const claims = venue.dietary.filter((claim) => declared.includes(claim.need));
    const unverified = declared.filter((need) => !claims.some((claim) => claim.need === need));
    const routeContext = atBase ? 'at_base' : best.km <= 2 ? 'on_route' : 'near_route';
    const where = atBase ? 'near your base' : best.km <= 2 ? 'right on the route' : `${Math.round(best.km)} km off the route, on the way`;
    items[index] = {
      ...item,
      title: `${slot === 'lunch' ? 'Lunch' : 'Dinner'} — ${venue.name}`,
      reason: `${venue.name} is ${where}${venue.localSpecialty ? `; ${venue.localSpecialty.note}` : ''}. Named from the region's own food data; we have not checked today that it is open, and nothing is booked.`,
      food: {
        slot,
        stopKind: 'venue',
        venueId: venue.id,
        venueName: venue.name,
        serviceType: venue.serviceType,
        ...(venue.cuisines[0] ? { cuisineLabel: venue.cuisines[0] } : {}),
        priceBand: venue.priceBand,
        priceEvidence: venue.priceEvidence,
        ...(venue.localSpecialty ? { localSpecialty: venue.localSpecialty.label } : {}),
        reservation: venue.reservation,
        dietary: claims,
        dietaryUnverified: unverified,
        ...(hours ? { hours } : {}),
        hoursUnknown: venue.hours.kind === 'unknown',
        routeContext,
        walkMinutesFromRouting: venue.walkMinutesFromRouting,
        detourMinutes: 0,
        isSpecialMeal: false,
        fromUserChoice: false,
        alternatives: [],
      },
    };
    named += 1;
  }
  return named;
}


/* ------------------------------------------------------------------ *
 * Backups belong to days
 * ------------------------------------------------------------------ */

const BACKUP_STOPWORDS = new Set(['the', 'and', 'or', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'if', 'for', 'with', 'day', 'very', 'heavy', 'rain', 'wind', 'weather', 'fully', 'booked', 'closed', 'closes', 'crowded', 'poor', 'visibility', 'path', 'walk', 'time', 'instead', 'prioritise', 'prioritize', 'early', 'shelter', 'town', 'visit', 'substitute', 'conditions', 'worsen', 'cliff', 'loop', 'side', 'stop', 'stops', 'view', 'viewpoints', 'gardens', 'grounds', 'ticket', 'which', 'remain', 'accessible', 'without', 'village', 'museum', 'distillery', 'monument', 'far', 'western', 'main']);

/**
 * PRODUCT RECOVERY V1 — a backup can only appear on a day it was written for
 * or provably belongs to. The draft's backups carry no day, so each is matched
 * deterministically against the day's own text: base, theme, anchor names and
 * localities. Matching is by distinctive place tokens (four letters or more,
 * not a stopword); a backup no day claims is attached to none, and the
 * intelligence layer says "keep this afternoon flexible" instead of pasting
 * the Ring of Kerry onto a Dublin evening.
 */
function backupTokens(text: string): string[] {
  return normalizeName(text)
    .split(' ')
    .filter((t) => t.length >= 4 && !BACKUP_STOPWORDS.has(t));
}

/**
 * V10 §14 — A BACKUP BELONGS TO WHAT IT DEPENDS ON.
 *
 * The founder saw a photography fallback for one peninsula repeated across
 * unrelated capital days and a mountain-lake fallback across unrelated days in
 * another park. The cause is in two parts, and the first is the embarrassing one:
 *
 * 1. **The model already says which day each backup is for** (`backups[].day`,
 *    added for PRODUCTION LOCK V5 §25) and this function did not read it. It
 *    re-derived every attribution by word overlap and threw the authored answer
 *    away.
 * 2. The word overlap then attached a backup to every day scoring at least half
 *    the best score, which for a common word ("waterfall", "lake", "harbour") is
 *    most of the trip.
 *
 * So the order is now: the day the model named; else the days that actually hold
 * the experiences the backup names; else the days at the base it names — capped,
 * because a backup for three separate days is not a backup for anything.
 */
const MAX_BACKUP_DAYS = 3;

function matchBackupsToDays(
  backups: readonly { trigger: string; alternative: string; day?: number }[],
  days: readonly ItineraryDay[],
  anchors: readonly ReconciledAnchor[],
  baseForDate: readonly (ResolvedBase | null)[],
): TripPackage['backups'] {
  const dayNumbers = new Set(days.map((d) => d.dayNumber));
  /** Every anchor name on each day, and the base words for each day, kept apart: a stop is a dependency, a base is only a neighbourhood. */
  const anchorNamesByDay = new Map<number, string[]>();
  for (const anchor of anchors) {
    const list = anchorNamesByDay.get(anchor.dayNumber) ?? [];
    list.push(normalizeName(anchor.draft.name));
    anchorNamesByDay.set(anchor.dayNumber, list);
  }
  const baseTokensByDay = days.map((day, i) => {
    const base = baseForDate[i];
    return new Set(backupTokens([day.theme, day.baseName, base?.locality ?? '', base?.name ?? ''].join(' ')));
  });

  return backups.map((backup) => {
    const text = normalizeName(`${backup.trigger} ${backup.alternative}`);

    /* 1 — the day the model named, when the trip has it. */
    if (backup.day !== undefined && dayNumbers.has(backup.day)) {
      return { trigger: backup.trigger, alternative: backup.alternative, dayNumbers: [backup.day], match: 'authored' as const };
    }

    /*
     * 2 — the days that hold the experiences this backup is about. A backup
     * names a stop, and that stop's day is the day the backup covers: a
     * dependency, not a word in common.
     */
    const byExperience = days
      .map((day) => day.dayNumber)
      .filter((dayNumber) => (anchorNamesByDay.get(dayNumber) ?? []).some((name) => name.length >= 4 && text.includes(name)));
    if (byExperience.length > 0) {
      return { trigger: backup.trigger, alternative: backup.alternative, dayNumbers: byExperience.slice(0, MAX_BACKUP_DAYS), match: 'authored' as const };
    }

    /*
     * 3 — the base it names, which is a weaker claim and is treated as one: only
     * the days that score strictly best, and never more than three of them.
     */
    const tokens = backupTokens(`${backup.trigger} ${backup.alternative}`);
    const scored = days
      .map((day, i) => ({ dayNumber: day.dayNumber, hits: tokens.filter((t) => baseTokensByDay[i]!.has(t)).length }))
      .filter((d) => d.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    const best = scored[0]?.hits ?? 0;
    const geographic = scored.filter((d) => d.hits === best).map((d) => d.dayNumber);
    return {
      trigger: backup.trigger,
      alternative: backup.alternative,
      dayNumbers: geographic.slice(0, MAX_BACKUP_DAYS),
      match: geographic.length > 0 ? ('geographic' as const) : ('none' as const),
    };
  });
}
