import { GEOGRAPHIC_SCOPE_VERSION, scopeFingerprint, type GeographicScope } from '../schemas/scope';
import { assessConfidence } from '../schemas/geography';
import { licence } from '../schemas/licence';
import {
  COMPILED_REGION_VERSION,
  computeBlocking,
  travelTimeMatrixSchema,
  type BaseCandidate,
  type CompiledRegion,
  type CoverageDimensionReport,
  type SatelliteCandidate,
} from '../schemas/compiled-region';
import type { RegionRequest, RegionSource, RegionSourceResult } from '../region/source';
import { EASTERN_SIERRA_ACCESS } from './access';
import { EASTERN_SIERRA_FOOD } from './food';
import { EASTERN_SIERRA_HOURS } from './hours';
import { EASTERN_SIERRA_PLACES } from './places';
import { EASTERN_SIERRA } from './regions';
import { EASTERN_SIERRA_BASE_ID, easternSierraTravelMatrix } from './travel-times';
import { EASTERN_SIERRA_TIME_ZONE, EASTERN_SIERRA_WEATHER_LOCATIONS } from './weather';

/**
 * The authored Eastern Sierra, behind the same door a compiled region comes
 * through.
 *
 * This is the golden fixture, and it stays the golden fixture: every fact in it
 * was read off a managing agency's own page by a person, which is a standard no
 * runtime pipeline will match soon. What changes is that the rest of the product
 * can no longer tell it apart from a compiled one — it produces a
 * `CompiledRegion` like anything else, passes the same integrity gate, and
 * reports its coverage in the same sixteen dimensions.
 *
 * Its coverage report is therefore not decorative. It is the reference the
 * dynamic compiler's output is read against: this is what `high` looks like.
 */

export const STATIC_REGION_COMPILER_VERSION = 'static-fixture/1';

/** Compiled once and shared. The fixture cannot change between requests. */
let cached: CompiledRegion | null = null;

/**
 * The scope an authored region implies.
 *
 * Written out rather than left undefined because everything downstream reads a
 * scope — the fingerprint, the cache key, the confirmation screen — and a
 * fixture that opts out of that would need a second code path in each of them.
 * It is marked `user_confirmed`: a traveller who typed "Mammoth Lakes" and was
 * shown this region did confirm it, at the moment they pressed on.
 */
function easternSierraScope(nights: number): GeographicScope {
  return {
    schemaVersion: GEOGRAPHIC_SCOPE_VERSION,
    revision: 1,
    destinationCandidateId: 'eastern-sierra',
    destinationName: EASTERN_SIERRA.name,
    destinationEntityType: 'subregion',
    breadth: 'subregion',
    center: EASTERN_SIERRA.baseCoordinates,
    countryCode: 'US',
    timeZones: [EASTERN_SIERRA_TIME_ZONE],
    shape: {
      kind: 'radius',
      center: EASTERN_SIERRA.baseCoordinates,
      radiusKm: EASTERN_SIERRA.maxRadiusKm,
    },
    /*
     * A circle, and it says so. The authored region was drawn as a reach radius
     * around a base rather than traced from a published boundary, so this is the
     * honest value and containment will treat it accordingly.
     */
    boundaryEvidence: 'reach_circle',
    reachRadiusKm: EASTERN_SIERRA.maxRadiusKm,
    administrative: { countryCode: 'US', regionCode: 'US-CA', aliases: [], hierarchy: [], divisionIds: [] },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk', 'shuttle', 'public_bus'],
      carAvailable: null,
      acceptsWaterOrAirTransfers: null,
      basis: 'region_evidence',
      note: EASTERN_SIERRA.transportSummary,
    },
    maxBaseChanges: 0,
    nights,
    rationale:
      'One base town with the Highway 395 corridor hanging off it, out to the two-hour mark where Bodie and Bishop sit.',
    confidence: assessConfidence(['user_confirmed', 'exact_name_match', 'boundary_available']),
    decidedBy: [],
    confirmedByUser: true,
  };
}

/**
 * One base, and it is genuinely one.
 *
 * The base/satellite split here is a fact about the region rather than a
 * limitation of the model: everything in the Eastern Sierra is a day trip from
 * Mammoth Lakes, which is why `maxBaseChanges` is zero and why there is no
 * second entry to invent.
 */
function easternSierraBases(): BaseCandidate[] {
  return [
    {
      id: EASTERN_SIERRA_BASE_ID,
      name: EASTERN_SIERRA.baseName,
      coordinates: EASTERN_SIERRA.baseCoordinates,
      role: 'primary_base',
      routingId: EASTERN_SIERRA_BASE_ID,
      timeZone: EASTERN_SIERRA_TIME_ZONE,
      suggestedNights: { min: 2, max: 7 },
      placesWithinReach: EASTERN_SIERRA_PLACES.map((place) => place.id),
      transportModes: ['drive', 'walk', 'shuttle', 'public_bus'],
      lodgingEvidence: 'unknown',
      rationale:
        'The only town in the region with a full range of places to stay, and the point every road out of the corridor returns to.',
      tradeoffs: [
        'At 7,880 ft it is colder at night than anywhere down the valley, and the first day is an altitude day.',
      ],
      evidenceFactIds: [],
    },
  ];
}

/** Satellites, derived from the authored drive times rather than re-authored. */
function easternSierraSatellites(): SatelliteCandidate[] {
  return EASTERN_SIERRA_PLACES.filter((place) => place.relationship === 'satellite').map(
    (place) => ({
      id: `sat-${place.id}`,
      name: place.name,
      parentBaseId: EASTERN_SIERRA_BASE_ID,
      placeIds: [place.id],
      minutesFromBase: place.travelFromBase.driveMinutes,
      suggestedMinutes: place.typicalDurationMinutes,
      requiredModes: [],
      seasonalMonths:
        place.seasonalAccess.openMonths.length === 12 ? [] : [...place.seasonalAccess.openMonths],
      evidenceFactIds: [],
    }),
  );
}

/**
 * What the fixture actually covers.
 *
 * Counted, not claimed. `expected` and `covered` are read off the datasets on
 * every build, so a fixture edit that drops an hours record shows up here as a
 * number rather than as silence.
 */
function easternSierraCoverage(): CoverageDimensionReport[] {
  const placeCount = EASTERN_SIERRA_PLACES.length;
  const withHours = EASTERN_SIERRA_HOURS.calendars.filter(
    (calendar) => calendar.kind !== 'unknown',
  ).length;
  const foodCount = EASTERN_SIERRA_FOOD.venues.length;

  return [
    {
      dimension: 'geographic_resolution',
      level: 'high',
      reasons: ['fully_covered'],
      detail: 'A named region with a signed base town and an authored two-hour radius.',
    },
    {
      dimension: 'places',
      level: 'high',
      reasons: ['fully_covered'],
      detail: `${placeCount} places, every one of them written from a named source.`,
      expected: placeCount,
      covered: placeCount,
    },
    {
      dimension: 'mainstream_attractions',
      level: 'high',
      reasons: ['fully_covered'],
      detail: 'The corridor’s well-known stops are all here.',
    },
    {
      dimension: 'hidden_gems',
      level: 'high',
      reasons: ['fully_covered'],
      detail: 'Quiet stops were sought deliberately rather than filtered from a popularity list.',
    },
    {
      dimension: 'natural_features',
      level: 'high',
      reasons: ['fully_covered'],
      detail: 'Lakes, trailheads, geothermal ground and viewpoints, individually sourced.',
    },
    {
      dimension: 'operating_hours',
      level: withHours === placeCount ? 'high' : 'usable_with_cautions',
      reasons: withHours === placeCount ? ['fully_covered'] : ['no_official_source_found'],
      detail: `${withHours} of ${placeCount} have a real calendar; the rest are day-use ground with no gate.`,
      expected: placeCount,
      covered: withHours,
    },
    {
      dimension: 'transportation',
      level: 'high',
      reasons: ['fully_covered'],
      detail: 'Every place carries a date-aware access rule, including the shuttle-only ones.',
    },
    {
      dimension: 'road_routing',
      level: 'usable_with_cautions',
      reasons: ['inferred_not_sourced'],
      detail:
        'Modelled travel time from the corridor’s road topology, not measured road data. Labelled as such everywhere it is shown.',
    },
    {
      dimension: 'walking_routing',
      level: 'not_applicable',
      reasons: ['not_relevant_to_region'],
      detail: 'Nothing here is reached on foot from anywhere else; walking is the last few minutes of a drive.',
    },
    {
      dimension: 'transit_routing',
      level: 'usable_with_cautions',
      reasons: ['partial_results_returned'],
      detail: 'The town trolley and the shuttle are modelled as services with real calendars; there is no wider network to model.',
    },
    {
      dimension: 'ferry_or_rail',
      level: 'not_applicable',
      reasons: ['not_relevant_to_region'],
      detail: 'No ferries and no passenger rail in this region.',
    },
    {
      dimension: 'weather',
      level: 'high',
      reasons: ['fully_covered'],
      detail: `${EASTERN_SIERRA_WEATHER_LOCATIONS.length} forecast points, each at a materially different elevation.`,
    },
    {
      dimension: 'food',
      level: foodCount > 0 ? 'usable_with_cautions' : 'unavailable',
      reasons: foodCount > 0 ? ['partial_results_returned'] : ['no_results_returned'],
      detail: `${foodCount} venues, chosen for where they sit on a route rather than for coverage of the town.`,
      covered: foodCount,
    },
    {
      dimension: 'temporary_access',
      level: 'usable_with_cautions',
      reasons: ['evidence_stale'],
      detail:
        'Seasonal road closures here move by weeks with the snowpack. Every one of them is flagged for you to recheck.',
    },
    {
      dimension: 'official_sources',
      level: 'high',
      reasons: ['fully_covered'],
      detail: 'Access, hours and closures were read off the managing agencies’ own pages.',
    },
    {
      dimension: 'source_freshness',
      level: 'usable_with_cautions',
      reasons: ['evidence_stale'],
      detail: 'Read in July 2026. Conditions change; we have not checked today.',
    },
  ];
}

function buildEasternSierra(nights: number): CompiledRegion {
  const scope = easternSierraScope(nights);
  const dimensions = easternSierraCoverage();
  const blocking = computeBlocking(dimensions, { drivingPlanned: true });
  const now = '2026-07-31T00:00:00.000Z';

  return {
    schemaVersion: COMPILED_REGION_VERSION,
    id: 'compiled-eastern-sierra-static',
    compilerVersion: STATIC_REGION_COMPILER_VERSION,
    region: EASTERN_SIERRA,
    scope,
    scopeFingerprint: scopeFingerprint(scope),
    bases: easternSierraBases(),
    primaryBaseId: EASTERN_SIERRA_BASE_ID,
    subregions: [],
    satellites: easternSierraSatellites(),
    places: EASTERN_SIERRA_PLACES,
    access: EASTERN_SIERRA_ACCESS,
    operatingHours: EASTERN_SIERRA_HOURS,
    weatherLocations: EASTERN_SIERRA_WEATHER_LOCATIONS,
    food: EASTERN_SIERRA_FOOD,
    travelTimes: travelTimeMatrixSchema.parse(easternSierraTravelMatrix()),
    /**
     * The authored fixture is ours, written from sources a person read. It
     * carries no reciprocal obligation and no upstream database to attribute —
     * which is exactly the contrast a compiled OSM-derived region provides.
     */
    licences: [licence('sidequest-authored', ['places', 'access', 'hours', 'food'])],
    sourceManifest: {
      facts: [],
      pages: [],
      providers: [
        { name: 'sidequest-authored-fixture', version: '1', calls: 0, failures: 0 },
      ],
      attributions: [],
    },
    coverage: {
      dimensions,
      blocksItinerary: blocking.blocksItinerary,
      blockingDimensions: blocking.blockingDimensions,
      recheckFactIds: [],
      summary:
        'Written by hand from the managing agencies’ own pages. The one thing that is modelled rather than measured is travel time, and it says so wherever it appears.',
    },
    diagnostics: {
      compilerVersion: STATIC_REGION_COMPILER_VERSION,
      startedAt: now,
      finishedAt: now,
      stageCount: 0,
      stageTimings: [],
      budget: { consumed: {}, limits: {}, exhausted: [] },
      promptVersions: {},
      warnings: [],
    },
    createdAt: now,
  };
}

/**
 * The authored region, as a source.
 *
 * `supports` is keyed on the region id rather than on the scope, because this
 * source holds exactly one region and asking it about Bali should be a clean
 * "not mine" rather than a compilation that fails four stages in.
 */
export const easternSierraRegionSource: RegionSource = {
  name: 'eastern-sierra-fixture',

  supports(request: RegionRequest): boolean {
    return request.regionId === EASTERN_SIERRA.id;
  },

  async getCompiledRegion(request: RegionRequest): Promise<RegionSourceResult> {
    if (!this.supports(request)) {
      return {
        ok: false,
        code: 'destination_unresolved',
        message: 'That is not a region this source holds.',
      };
    }
    // Nights is the only thing that varies per trip, and it only reaches the
    // scope. Rebuilding for a different night count keeps the fingerprint
    // honest without recompiling any of the data.
    const nights = Math.max(0, request.dates.length - 1);
    if (!cached || cached.scope.nights !== nights) {
      cached = buildEasternSierra(nights);
    }
    return { ok: true, region: cached };
  },
};
