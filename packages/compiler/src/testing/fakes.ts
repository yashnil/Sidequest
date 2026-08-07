import {
  assessConfidence,
  DESTINATION_RESOLUTION_VERSION,
  normalizeDestinationQuery,
  type AccessRule,
  type DestinationCandidate,
  type DestinationEntityType,
  type FoodVenue,
  type OperatingCalendar,
  type Place,
  type ScopeBreadth,
  type SourceFact,
  type TransportMode,
  type WeatherLocation,
  stableHash,
} from '@sidequest/core';
import type {
  CompilerProviders,
  ConstraintResearchProvider,
  DestinationResolver,
  ExtractedClaim,
  FactExtractionProvider,
  FoodDiscoveryProvider,
  PlaceDiscoveryProvider,
  ProviderGap,
  RegionExpansionProvider,
  RetrievedDocument,
  RoutingProvider,
  SourceDiscoveryProvider,
  SourceReference,
  SourceRetrievalProvider,
  WeatherLocationProvider,
} from '../providers';

/**
 * SIX WORLDS THAT ARE NOT THE EASTERN SIERRA.
 *
 * These are not destinations and must never become destinations. They exist so
 * the compiler and the planner can be run against shapes the authored fixture
 * cannot express — a city with no car, an island whose good half is across
 * water, a country too big for one base — and so a regression in any of those
 * fails a test rather than a traveller.
 *
 * Everything is derived from an index. Nothing is random, nothing reads a clock,
 * and the same spec produces the same bytes on every run, which is what lets a
 * determinism test mean anything.
 */

export interface SyntheticWorldSpec {
  id: string;
  name: string;
  qualifiedName: string;
  countryCode: string;
  timeZone: string;
  /** Plural where the world genuinely spans zones. A rail corridor does. */
  timeZones?: string[];
  center: { lat: number; lng: number };
  entityType: DestinationEntityType;
  breadth: ScopeBreadth;
  placeCount: number;
  baseCount: number;
  subregionCount: number;
  primaryMode: 'drive' | 'walk';
  /** Share of places that get a real opening calendar. The rest come back unknown. */
  hoursCoverage: number;
  /** Share of places an access rule can be established for. The rest are dropped. */
  accessCoverage: number;
  foodVenues: number;
  weatherPoints: number;
  routingKind: 'measured' | 'modelled' | 'estimated';
  /** Legs the routing provider cannot answer for. Never silently zero. */
  failedLegs: number;
  hasFerry: boolean;
  /**
   * Minutes per step of separation in the travel-time matrix.
   *
   * Present so a world can be genuinely too spread out to plan, which is a state
   * the product has to handle and which no amount of clicking can reach: a live
   * compilation produced a region where every round trip from the base exceeded
   * the traveller's own daily driving limit, and the planner was returning five
   * empty days as a finished itinerary. Default keeps every existing world
   * byte-identical.
   */
  legMinutes?: number;
  /**
   * Minutes each place takes, overriding the derived duration.
   *
   * The other half of the same need. `legMinutes` makes a region too far to
   * reach, which the *board* now catches; this makes each stop too long to fit
   * in a day, which the board does not check and the planner does — so it is how
   * a browser test reaches the planner's own refusal rather than the board's.
   */
  placeDurationMinutes?: number;
}

/**
 * (a) Dense transit city. No car, walking and metro, timed-entry museums.
 * (b) Island with ferry-dependent satellites and thin evening options.
 * (c) Remote road region: long drives, sparse services, uncertain access.
 * (d) Broad country: too big for one base, needs a subset chosen.
 * (e) Rail corridor: several cities, no car, two timezones.
 * (f) Weak-data region: good geography, almost no official coverage.
 */
export const SYNTHETIC_WORLDS: Record<string, SyntheticWorldSpec> = {
  transit_city: {
    id: 'transit-city',
    name: 'Harbour City',
    qualifiedName: 'Harbour City, Testland',
    countryCode: 'TL',
    timeZone: 'Europe/Lisbon',
    center: { lat: 38.72, lng: -9.14 },
    entityType: 'city',
    breadth: 'city',
    placeCount: 18,
    baseCount: 1,
    subregionCount: 0,
    primaryMode: 'walk',
    hoursCoverage: 0.95,
    accessCoverage: 1,
    foodVenues: 12,
    weatherPoints: 1,
    routingKind: 'measured',
    failedLegs: 0,
    hasFerry: false,
  },
  ferry_island: {
    id: 'ferry-island',
    name: 'Outer Isles',
    qualifiedName: 'Outer Isles, Testland',
    countryCode: 'TL',
    timeZone: 'Atlantic/Faroe',
    center: { lat: 62.0, lng: -6.77 },
    entityType: 'archipelago',
    breadth: 'subregion',
    placeCount: 12,
    baseCount: 2,
    subregionCount: 2,
    primaryMode: 'drive',
    hoursCoverage: 0.5,
    accessCoverage: 0.9,
    foodVenues: 4,
    weatherPoints: 3,
    routingKind: 'modelled',
    failedLegs: 2,
    hasFerry: true,
  },
  remote_road: {
    id: 'remote-road',
    name: 'Long Road Country',
    qualifiedName: 'Long Road Country, Testland',
    countryCode: 'TL',
    timeZone: 'America/Anchorage',
    center: { lat: 63.5, lng: -148.9 },
    entityType: 'subregion',
    breadth: 'region',
    placeCount: 14,
    baseCount: 2,
    subregionCount: 2,
    primaryMode: 'drive',
    hoursCoverage: 0.3,
    accessCoverage: 0.85,
    foodVenues: 3,
    weatherPoints: 4,
    routingKind: 'modelled',
    failedLegs: 0,
    hasFerry: false,
  },
  broad_country: {
    id: 'broad-country',
    name: 'Wide Republic',
    qualifiedName: 'Wide Republic',
    countryCode: 'WR',
    timeZone: 'Europe/Istanbul',
    center: { lat: 39.0, lng: 35.0 },
    entityType: 'country',
    breadth: 'country',
    placeCount: 40,
    baseCount: 3,
    subregionCount: 6,
    primaryMode: 'drive',
    hoursCoverage: 0.7,
    accessCoverage: 0.95,
    foodVenues: 14,
    weatherPoints: 6,
    routingKind: 'measured',
    failedLegs: 0,
    hasFerry: true,
  },
  rail_corridor: {
    id: 'rail-corridor',
    name: 'The Northern Line',
    qualifiedName: 'The Northern Line, Testland to Otherland',
    countryCode: 'TL',
    timeZone: 'Europe/Berlin',
    timeZones: ['Europe/Berlin', 'Europe/Warsaw'],
    center: { lat: 52.4, lng: 15.2 },
    entityType: 'route_or_corridor',
    breadth: 'region',
    placeCount: 16,
    baseCount: 3,
    subregionCount: 3,
    primaryMode: 'walk',
    hoursCoverage: 0.9,
    accessCoverage: 1,
    foodVenues: 10,
    weatherPoints: 3,
    routingKind: 'measured',
    failedLegs: 0,
    hasFerry: false,
  },
  /**
   * (g) A region whose every stop is further out than a day can reach.
   *
   * Not a broken world — the geography is fine, the places are open, the matrix
   * is complete. It is simply too spread out for the traveller's own limits,
   * which is the one shape that used to produce a plan with nothing in it.
   */
  unreachable_region: {
    id: 'unreachable-region',
    name: 'Faraway Reaches',
    qualifiedName: 'Faraway Reaches, Testland',
    countryCode: 'TL',
    timeZone: 'America/Denver',
    center: { lat: 39.5, lng: -106.0 },
    entityType: 'subregion',
    breadth: 'region',
    placeCount: 8,
    baseCount: 1,
    subregionCount: 0,
    primaryMode: 'drive',
    hoursCoverage: 1,
    accessCoverage: 1,
    foodVenues: 2,
    weatherPoints: 1,
    routingKind: 'measured',
    failedLegs: 0,
    hasFerry: false,
    // Three and a half hours to the nearest stop, seven hours there and back —
    // past the furthest the questionnaire will let anybody go.
    legMinutes: 200,
  },
  /**
   * (h) A region of stops that no single day is long enough to hold.
   *
   * Every place is reachable and open and passes the board. None of them fits
   * inside a day once the drive is counted, which is the planner's own refusal
   * rather than the board's.
   */
  unplannable_region: {
    id: 'unplannable-region',
    name: 'Longday Basin',
    qualifiedName: 'Longday Basin, Testland',
    countryCode: 'TL',
    timeZone: 'America/Denver',
    center: { lat: 38.9, lng: -107.4 },
    entityType: 'subregion',
    breadth: 'subregion',
    placeCount: 4,
    baseCount: 1,
    subregionCount: 0,
    primaryMode: 'drive',
    hoursCoverage: 1,
    accessCoverage: 1,
    foodVenues: 2,
    weatherPoints: 1,
    routingKind: 'measured',
    failedLegs: 0,
    hasFerry: false,
    legMinutes: 12,
    // Ten hours at the stop, before any driving. No day is that long.
    placeDurationMinutes: 600,
  },
  weak_data: {
    id: 'weak-data',
    name: 'Little-Known Valley',
    qualifiedName: 'Little-Known Valley, Testland',
    countryCode: 'TL',
    timeZone: 'Asia/Bishkek',
    center: { lat: 42.5, lng: 74.6 },
    entityType: 'subregion',
    breadth: 'subregion',
    placeCount: 9,
    baseCount: 1,
    subregionCount: 0,
    primaryMode: 'drive',
    hoursCoverage: 0.05,
    accessCoverage: 0.4,
    foodVenues: 0,
    weatherPoints: 1,
    routingKind: 'estimated',
    failedLegs: 1,
    hasFerry: false,
  },
};

const CATEGORIES = [
  'viewpoint',
  'museum',
  'lake',
  'easy_walk',
  'town_and_food',
  'historic_site',
  'day_hike',
  'wildlife_area',
] as const;

const INTERESTS = [
  'scenic_viewpoints',
  'history_and_culture',
  'lakes_and_rivers',
  'easy_nature_walks',
  'food_and_towns',
  'hiking',
  'wildlife',
  'photography_golden_hour',
] as const;

const VERIFIED = '2026-07-01';

function offset(index: number): { lat: number; lng: number } {
  // A deterministic spiral, so places are distinct, ordered and never colocated.
  const angle = index * 2.399963229728653;
  const radius = 0.02 + index * 0.012;
  return { lat: Math.cos(angle) * radius, lng: Math.sin(angle) * radius };
}

export function syntheticPlace(spec: SyntheticWorldSpec, index: number): Place {
  const delta = offset(index + 1);
  const category = CATEGORIES[index % CATEGORIES.length] ?? 'viewpoint';
  const interest = INTERESTS[index % INTERESTS.length] ?? 'scenic_viewpoints';
  const indoor = category === 'museum';
  const driveMinutes = spec.primaryMode === 'drive' ? 8 + index * 6 : 4 + index * 3;

  return {
    id: `${spec.id}-place-${index}`,
    regionId: `compiled-${spec.id}`,
    name: `${spec.name} ${titleFor(category)} ${index + 1}`,
    locality: spec.name,
    shortDescription: `A ${titleFor(category).toLowerCase()} in ${spec.name}, used to exercise the compiler.`,
    coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
    tags: [category],
    source: {
      name: 'Synthetic test world',
      kind: 'curated',
      confidence: 0.9,
      lastVerified: VERIFIED,
    },
    relationship: index === 0 ? 'base' : 'satellite',
    category,
    interests: [interest],
    typicalDurationMinutes: 45 + (index % 4) * 30,
    costLevel: (index % 4) as 0 | 1 | 2 | 3,
    physicalIntensity: index % 5 === 0 ? 'moderate' : 'easy',
    crowdLevel: index % 3 === 0 ? 'busy' : 'quiet',
    // Alternating rather than random, so a world always contains both a
    // well-known stop and a quiet one — the two the board has to tell apart.
    popularityScore: index % 2 === 0 ? 0.8 : 0.2,
    hiddenGemScore: index % 2 === 0 ? 0.2 : 0.8,
    weather: {
      exposure: indoor ? 'indoor' : 'exposed_outdoor',
      precipitation: indoor ? 'low' : 'high',
      wind: indoor ? 'low' : 'moderate',
      heat: indoor ? 'low' : 'moderate',
      cold: indoor ? 'low' : 'moderate',
      visibilityDependent: category === 'viewpoint',
      poorWeatherBackup: indoor,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: spec.primaryMode === 'walk' ? 'hard' : 'easy',
      remoteNoServices: spec.id === 'remote-road' && index % 3 === 0,
    },
    travelFromBase: {
      distanceKm: driveMinutes * 0.9,
      driveMinutes,
      driveIsScenic: index % 4 === 0,
    },
  };
}

function titleFor(category: string): string {
  return category
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function syntheticAccessRule(spec: SyntheticWorldSpec, place: Place, index: number): AccessRule {
  const walkApproach = spec.primaryMode === 'walk';
  const mode: TransportMode = walkApproach ? 'walk' : 'drive';
  return {
    id: `${spec.id}-rule-${index}`,
    label: `Access to ${place.name}`,
    placeIds: [place.id],
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    approachMode: mode,
    ...(walkApproach ? { approachMinutes: 8 + (index % 5) * 3 } : {}),
    privateVehicle: 'allowed',
    serviceRequirement: 'none',
    walkMinutesFromDropOff: 3,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [],
    provenance: {
      kind: 'official',
      sourceName: 'Synthetic managing authority',
      sourceUrl: `https://example.invalid/${spec.id}/${place.id}`,
      lastVerified: VERIFIED,
      confidence: 0.9,
      volatility: 'stable',
    },
  };
}

function syntheticCalendar(spec: SyntheticWorldSpec, place: Place, index: number): OperatingCalendar {
  return {
    kind: 'scheduled',
    placeId: place.id,
    admission: {
      reservationRequired: place.category === 'museum',
      timedEntry: place.category === 'museum',
      permitRequired: false,
      walkInAllowed: place.category !== 'museum',
      capacityLimited: place.category === 'museum',
      // A booking requirement with nowhere to book is a dead end dressed as
      // guidance, and the schema refuses it. The synthetic world has to honour
      // that too, or it stops being a faithful rehearsal.
      ...(place.category === 'museum'
        ? { bookingUrl: `https://example.invalid/${spec.id}/book/${index}` }
        : {}),
    },
    daylightOnly: false,
    periods: [
      {
        label: 'All year',
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        windows: [{ openMinute: 9 * 60, closeMinute: 17 * 60 + 30 }],
      },
    ],
    closedAnnualDates: [],
    provenance: {
      /**
       * `authored`, not `official`.
       *
       * These stand in for hours a mapper transcribed, which is what the live
       * map-data path produces — a volunteer's reading of an operator's sign.
       * Calling them official would make "did the research funnel actually
       * establish this?" unanswerable in every test below.
       */
      kind: 'authored',
      sourceName: 'Synthetic map data',
      sourceUrl: `https://example.invalid/${spec.id}/hours/${index}`,
      confidence: 0.9,
      volatility: 'seasonal_recurring',
    },
  };
}

function syntheticFact(spec: SyntheticWorldSpec, place: Place, index: number): SourceFact {
  return {
    id: `${spec.id}-fact-${index}`,
    subjectId: place.id,
    kind: 'operating_hours',
    statement: `${place.name} publishes opening hours of 09:00 to 17:30.`,
    authorityKind: 'operator',
    authorityName: 'Synthetic operator',
    sourceUrl: `https://example.invalid/${spec.id}/hours/${index}`,
    sourceTitle: `${place.name} — visiting`,
    retrievedAt: `${VERIFIED}T09:00:00.000Z`,
    verifiedAt: `${VERIFIED}T09:00:00.000Z`,
    evidenceExcerpt: 'Open daily 09:00–17:30.',
    derivation: 'directly_stated',
    volatility: 'seasonal_recurring',
    shelfLifeDays: 180,
    recheckRequired: false,
  };
}

/**
 * Everything a fake provider set needs, built once from a spec.
 *
 * Exported because the planner's own synthetic-region tests want the same
 * places and the same matrix, and two generators that drift apart would make a
 * cross-package regression invisible.
 */
export function buildSyntheticWorld(spec: SyntheticWorldSpec): {
  places: Place[];
  rules: AccessRule[];
  calendars: OperatingCalendar[];
  facts: SourceFact[];
  venues: FoodVenue[];
  weatherLocations: WeatherLocation[];
} {
  const places = Array.from({ length: spec.placeCount }, (_, index) => syntheticPlace(spec, index));

  const accessCount = Math.floor(places.length * spec.accessCoverage);
  const rules = places
    .slice(0, accessCount)
    .map((place, index) => syntheticAccessRule(spec, place, index));

  const hoursCount = Math.floor(places.length * spec.hoursCoverage);
  const calendars = places
    .slice(0, hoursCount)
    .map((place, index) => syntheticCalendar(spec, place, index));

  const facts = places
    .slice(0, hoursCount)
    .map((place, index) => syntheticFact(spec, place, index));

  const venues: FoodVenue[] = Array.from({ length: spec.foodVenues }, (_, index) => {
    const delta = offset(index + 1);
    return {
      id: `${spec.id}-venue-${index}`,
      regionId: `compiled-${spec.id}`,
      name: `${spec.name} Kitchen ${index + 1}`,
      locality: spec.name,
      shortDescription: `A place to eat in ${spec.name}.`,
      coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
      tags: [],
      source: {
        name: 'Synthetic test world',
        kind: 'curated' as const,
        confidence: 0.8,
        lastVerified: VERIFIED,
      },
      serviceType: 'restaurant' as const,
      mealPeriods: ['lunch', 'dinner'] as const,
      cuisines: ['local'],
      priceBand: 'moderate' as const,
      priceEvidence: 'format_inferred' as const,
      serviceMinutes: 60,
      reservation: { requirement: 'walk_in_only' as const },
      takeaway: 'unknown' as const,
      provisioning: 'none' as const,
      dietary: [],
      hours: {
        kind: 'unknown' as const,
        note: 'No published hours for this synthetic venue.',
        hoursConfidence: 'unverified' as const,
        provenance: {
          kind: 'authored' as const,
          sourceName: 'Synthetic test world',
          confidence: 0.4,
          volatility: 'dynamic' as const,
          recheckNote: 'Synthetic data with no published hours. Never real.',
        },
      },
      routingId: `${spec.id}-venue-${index}`,
      walkMinutesFromRouting: 2,
    } as FoodVenue;
  });

  /**
   * Forecast points, spread across the places rather than one per place.
   *
   * Every place must be claimed exactly once or the integrity gate rejects the
   * region — which is the check that stops a compiled region from silently
   * forecasting a mountain from a valley reading.
   */
  const pointCount = Math.max(1, Math.min(spec.weatherPoints, places.length));
  const weatherLocations: WeatherLocation[] = Array.from({ length: pointCount }, (_, index) => {
    const claimed = places.filter((_, placeIndex) => placeIndex % pointCount === index);
    const delta = offset(index + 1);
    return {
      id: `${spec.id}-weather-${index}`,
      label: `${spec.name} point ${index + 1}`,
      coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
      elevationMetres: 100 + index * 250,
      timeZone: spec.timeZone,
      placeIds: claimed.map((place) => place.id),
      limitation: 'One synthetic point standing for a band of the region.',
    };
  }).filter((location) => location.placeIds.length > 0);

  return { places, rules, calendars, facts, venues, weatherLocations };
}

/**
 * Fake providers over a synthetic world.
 *
 * They honour the two rules the real ones must: they report gaps explicitly
 * rather than omitting, and they never assert a confidence level — only signals.
 */
export function fakeProviders(
  spec: SyntheticWorldSpec,
  options: FakeResearchOptions = {},
): CompilerProviders {
  const world = buildSyntheticWorld(spec);

  const resolver: DestinationResolver = {
    name: 'fake-resolver',
    async resolve({ query }) {
      const candidate = syntheticCandidate(spec);
      return {
        schemaVersion: DESTINATION_RESOLUTION_VERSION,
        query,
        normalizedQuery: normalizeDestinationQuery(query),
        candidates: [candidate],
        ambiguityReasons: [],
        unambiguousCandidateId: candidate.id,
        providersConsulted: ['fake-resolver'],
        resolvedAt: `${VERIFIED}T00:00:00.000Z`,
      };
    },
  };

  const expansion: RegionExpansionProvider = {
    name: 'fake-expansion',
    async expand({ maxBases, maxSubregions }) {
      const bases = Array.from({ length: Math.min(spec.baseCount, maxBases) }, (_, index) => {
        const delta = offset(index * 4 + 1);
        return {
          id: `${spec.id}-base-${index}`,
          name: `${spec.name} Base ${index + 1}`,
          coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
          timeZone: spec.timeZones?.[index] ?? spec.timeZone,
          suggestedNights: { min: 2, max: 5 },
          transportModes: (spec.primaryMode === 'walk'
            ? ['walk', 'public_bus', 'rail']
            : ['drive', 'walk']) as TransportMode[],
          rationale: `Puts most of ${spec.name} within reach.`,
          tradeoffs: [],
        };
      });
      const subregions = Array.from(
        { length: Math.min(spec.subregionCount, maxSubregions) },
        (_, index) => {
          const delta = offset(index * 3 + 2);
          return {
            id: `${spec.id}-sub-${index}`,
            name: `${spec.name} Area ${index + 1}`,
            summary: `Part of ${spec.name}.`,
            center: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
            radiusKm: 30,
            suggestedNights: { min: 1, max: 3 },
          };
        },
      );
      return { bases, subregions, gaps: [], calls: 1 };
    },
  };

  const places: PlaceDiscoveryProvider = {
    name: 'fake-places',
    async discover() {
      return {
        candidates: world.places.map((place, index) => ({
          place,
          /**
           * Two refs where the signal claims two providers, one where it does
           * not. A fixture that asserts corroboration it did not produce is a
           * fixture that will let the real thing do the same.
           */
          providerRefs:
            index % 3 === 0
              ? [
                  { provider: 'fake-places', externalId: place.id },
                  { provider: 'fake-second-provider', externalId: place.id },
                ]
              : [{ provider: 'fake-places', externalId: place.id }],
          facts: [],
          confidenceSignals:
            index % 3 === 0
              ? (['exact_name_match', 'multiple_providers_agree'] as const).slice()
              : (['single_provider_only'] as const).slice(),
        })),
        gaps: [],
        calls: 1,
      };
    },
  };

  const constraints: ConstraintResearchProvider = {
    name: 'fake-constraints',
    async research({ places: subjects, maxSubjects }) {
      const allowed = subjects.slice(0, maxSubjects).map((place) => place.id);
      const rules = world.rules.filter((rule) =>
        rule.placeIds.some((placeId) => allowed.includes(placeId)),
      );
      const covered = new Set(rules.flatMap((rule) => rule.placeIds));
      const gaps: ProviderGap[] = allowed
        .filter((placeId) => !covered.has(placeId))
        .map((placeId) => ({
          subjectId: placeId,
          reason: 'no_official_source' as const,
          detail: 'No managing authority publishes access information for this.',
        }));
      return {
        calendars: world.calendars.filter((calendar) => allowed.includes(calendar.placeId)),
        accessRules: rules,
        services: [],
        facts: world.facts.filter((fact) => allowed.includes(fact.subjectId)),
        gaps,
        calls: 1,
        // This provider reads a synthetic world in memory; reporting pages it
        // never fetched would spend the retrieval budget before retrieval ran.
        pagesFetched: 0,
      };
    },
  };

  const routing: RoutingProvider = {
    name: 'fake-routing',
    supportedModes() {
      return spec.primaryMode === 'walk' ? ['foot', 'transit'] : ['car'];
    },
    async matrix({ points, maxElements }) {
      // Truncated rather than silently short: a provider that would exceed the
      // budget drops points from the end and the compiler sees a smaller matrix.
      const capacity = Math.max(2, Math.floor(Math.sqrt(Math.max(1, maxElements))));
      const used = points.slice(0, Math.min(points.length, capacity));
      const ids = used.map((point) => point.id);
      const step = spec.legMinutes ?? 7;
      const minutes = used.map((from, i) =>
        used.map((to, j) => (i === j ? 0 : 6 + Math.abs(i - j) * step)),
      );
      const km = minutes.map((row) => row.map((value) => value * 0.9));
      const failedPairs = Array.from({ length: Math.min(spec.failedLegs, ids.length - 1) }, (_, index) => ({
        from: ids[0] ?? '',
        to: ids[index + 1] ?? '',
        reason: 'not_found' as const,
      }));
      return {
        ids,
        minutes,
        km,
        provenance: {
          kind: spec.routingKind,
          note:
            spec.routingKind === 'measured'
              ? 'Measured against a road network.'
              : spec.routingKind === 'modelled'
                ? 'Modelled travel time, not measured road data.'
                : 'Straight-line distance and an assumed speed. Not a real travel time.',
        },
        failedPairs,
        calls: 1,
        elements: ids.length * ids.length,
      };
    },
  };

  const weatherLocations: WeatherLocationProvider = {
    name: 'fake-weather-locations',
    async plan({ places: subjects, maxLocations }) {
      if (maxLocations <= 0) {
        return {
          locations: [],
          gaps: [{ subjectId: spec.id, reason: 'budget_exhausted', detail: 'No budget left for forecast points.' }],
          calls: 0,
        };
      }
      // Re-derived over the places that actually survived, so every one of them
      // is claimed exactly once whatever the compiler dropped along the way.
      const ids = subjects.map((place) => place.id);
      const pointCount = Math.max(1, Math.min(maxLocations, spec.weatherPoints, ids.length));
      const locations = Array.from({ length: pointCount }, (_, index) => {
        const delta = offset(index + 1);
        return {
          id: `${spec.id}-weather-${index}`,
          label: `${spec.name} point ${index + 1}`,
          coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
          elevationMetres: 100 + index * 250,
          timeZone: spec.timeZone,
          placeIds: ids.filter((_, placeIndex) => placeIndex % pointCount === index),
          limitation: 'One synthetic point standing for a band of the region.',
        };
      }).filter((location) => location.placeIds.length > 0);
      return { locations, gaps: [], calls: 1 };
    },
  };

  const food: FoodDiscoveryProvider = {
    name: 'fake-food',
    async discover({ maxVenues }) {
      const venues = world.venues.slice(0, Math.max(0, maxVenues));
      const gaps: ProviderGap[] =
        venues.length === 0
          ? [{ subjectId: spec.id, reason: 'not_found', detail: 'No food data for this region.' }]
          : [];
      return { venues, gaps, calls: 1 };
    },
  };

  const research = fakeResearchProviders(spec, options);

  return {
    resolver,
    expansion,
    places,
    constraints,
    routing,
    weatherLocations,
    food,
    ...research,
  };
}

/**
 * HOW THE FAKE RESEARCH FUNNEL BEHAVES.
 *
 * Every field is a failure mode the real one has to survive, expressed as data
 * rather than as a bespoke mock. That matters because these are the cases that
 * are hard to reach with a live provider and easy to get wrong in a refactor:
 * two sources disagreeing, a page that 404s, a model that returns prose with no
 * excerpt, a budget that runs out halfway.
 */
export interface FakeResearchOptions {
  /** Share of subjects an official page can be found for. */
  officialSourceCoverage?: number;
  /** Emit a second, contradicting hours fact from an independent domain. */
  conflictingHours?: boolean;
  /** Emit a dated closure that covers the trip. */
  temporaryClosure?: boolean;
  /** Emit facts retrieved long ago, so freshness has something to bite on. */
  staleSources?: boolean;
  /** Emit a booking requirement with a ticket page. */
  bookingRequired?: boolean;
  /** Emit an hours claim with no excerpt, which must be discarded. */
  uncitedClaims?: boolean;
  /** The whole discovery layer is down. */
  sourceDiscoveryFails?: boolean;
  /** Every fetch fails. */
  retrievalFails?: boolean;
  /** The extractor returns malformed output. */
  extractionFails?: boolean;
  /** A weak dietary hint on food venues, which must stay cautious. */
  weakDietaryEvidence?: boolean;
}

export function fakeResearchProviders(
  spec: SyntheticWorldSpec,
  options: FakeResearchOptions = {},
): Pick<CompilerProviders, 'sourceDiscovery' | 'retrieval' | 'extraction'> {
  const coverage = options.officialSourceCoverage ?? 0.6;

  const sourceDiscovery: SourceDiscoveryProvider = {
    name: 'fake-source-discovery',
    version: 'fake/1',
    async discover({ subjects, maxSearches, maxReferencesPerSubject }) {
      if (options.sourceDiscoveryFails) {
        return {
          references: [],
          gaps: [
            {
              subjectId: spec.id,
              reason: 'provider_error',
              detail: 'The search provider did not answer, so nothing official was found.',
            },
          ],
          calls: 1,
          searches: 0,
        };
      }

      const references: SourceReference[] = [];
      let searches = 0;
      for (const [index, subject] of subjects.entries()) {
        if (subject.knownOfficialUrl) {
          references.push({
            subjectId: subject.id,
            url: subject.knownOfficialUrl,
            title: `${subject.name} — official`,
            expectedAuthority: 'operator',
            discoveredVia: 'osm_tag',
          });
          continue;
        }
        if (index / Math.max(1, subjects.length) >= coverage) continue;
        if (searches >= maxSearches) break;
        searches += 1;
        references.push({
          subjectId: subject.id,
          /**
           * Keyed on the subject, not on its position in the batch.
           *
           * A museum's official page does not change because somebody asked
           * about fewer places this time. Deriving it from the index meant a
           * warm compilation — which legitimately researches a subset —
           * "discovered" a different URL for the same museum and minted a whole
           * second set of claims for it.
           */
          url: `https://operator-${stableHash(subject.id)}.invalid/visit`,
          title: `${subject.name} — visitor information`,
          expectedAuthority: index % 3 === 0 ? 'managing_authority' : 'operator',
          discoveredVia: 'search',
          pageAge: 'March 12, 2026',
        });
        if (options.conflictingHours && maxReferencesPerSubject > 1) {
          references.push({
            subjectId: subject.id,
            url: `https://guide-${stableHash(subject.id)}.invalid/hours`,
            title: `${subject.name} — a guide`,
            expectedAuthority: 'authoritative_secondary',
            discoveredVia: 'search',
          });
        }
      }
      return { references, gaps: [], calls: 1, searches };
    },
  };

  const retrieval: SourceRetrievalProvider = {
    name: 'fake-retrieval',
    async retrieve({ references, maxPages }) {
      if (options.retrievalFails) {
        return {
          documents: [],
          rejected: references.map((reference) => ({
            url: reference.url,
            subjectId: reference.subjectId,
            reason: 'provider_error' as const,
            detail: 'Every page we tried to read timed out.',
          })),
          gaps: [],
          bytes: 0,
        };
      }
      const allowed = references.slice(0, maxPages);
      const documents: RetrievedDocument[] = allowed.map((reference) => ({
        subjectId: reference.subjectId,
        url: reference.url,
        ...(reference.title ? { title: reference.title } : {}),
        text: `Opening hours: Monday to Friday 09:00 to 17:00. Admission 12 EUR per adult.`,
        structuredData: [],
        /**
         * A real-shaped digest, not a label.
         *
         * The evidence store refuses a digest whose algorithm or form it cannot
         * verify, so a fixture hash like `hash-place-0` would silently opt every
         * synthetic world out of the caching layer — and the browser journeys
         * that exist to prove reuse would prove nothing.
         */
        contentHash: syntheticDigest(reference.url),
        contentBytes: 4096,
        /**
         * Five days before the worlds' `NOW`, not three weeks.
         *
         * `hours.closure` ages out in twenty-one days by policy — which is
         * correct and is exactly what a three-week-old "closed for
         * refurbishment" notice deserves — so a fixture dated three weeks back
         * silently made every closure stale and untestable.
         */
        retrievedAt: options.staleSources
          ? '2024-01-01T00:00:00.000Z'
          : '2026-08-05T00:00:00.000Z',
        publishedAt: options.staleSources ? '2023-11-02' : '2026-08-01',
        robotsAllowed: true,
        authority: reference.expectedAuthority,
        publisher: hostOf(reference.url),
        domain: hostOf(reference.url),
      }));
      return { documents, unchanged: [], rejected: [], gaps: [], bytes: documents.length * 4096 };
    },
  };

  const extraction: FactExtractionProvider = {
    name: 'fake-extraction',
    promptVersion: 'fake-extract/1',
    schemaVersion: 'fake-extraction/1',
    async extract({ documents, subjects }) {
      if (options.extractionFails) {
        return {
          claims: [],
          unanswered: [],
          gaps: [
            {
              subjectId: spec.id,
              reason: 'provider_error',
              detail: 'The extractor returned something we could not read, so nothing was kept.',
            },
          ],
          calls: 1,
          promptVersion: 'fake-extract/1',
          schemaVersion: 'fake-extraction/1',
        };
      }

      const foodIds = new Set(buildSyntheticWorld(spec).venues.map((venue) => venue.id));
      const claims: ExtractedClaim[] = [];
      for (const [index, document] of documents.entries()) {
        const isFood = foodIds.has(document.subjectId);
        const secondary = document.authority === 'authoritative_secondary';

        claims.push({
          subjectId: document.subjectId,
          documentIndex: index,
          factPath: isFood ? 'food.hours' : 'hours.weekly',
          statement: secondary
            ? 'Open Monday to Friday, 10:00 to 16:00.'
            : 'Open Monday to Friday, 09:00 to 17:00.',
          ...(options.uncitedClaims && !secondary
            ? {}
            : { evidenceExcerpt: 'Opening hours: Monday to Friday 09:00 to 17:00.' }),
          derivation: 'directly_stated',
          payload: {
            periods: [
              {
                label: 'Year-round, weekdays',
                months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                daysOfWeek: [1, 2, 3, 4, 5],
                windows: [
                  secondary
                    ? { openMinute: 600, closeMinute: 960 }
                    : { openMinute: 540, closeMinute: 1020 },
                ],
              },
            ],
            closedAnnualDates: [],
          },
        });

        if (!isFood && !secondary) {
          claims.push({
            subjectId: document.subjectId,
            documentIndex: index,
            factPath: 'cost.admission',
            statement: 'Admission is 12 EUR per adult.',
            evidenceExcerpt: 'Admission 12 EUR per adult.',
            derivation: 'directly_stated',
            payload: { free: false, currency: 'EUR', amount: 12, unit: 'per_person' },
          });
        }

        // Every researched place, not just the first: the first document to be
        // read is whichever candidate the funnel prioritised, which is often a
        // food venue — and a booking requirement on somewhere nothing schedules
        // is a fixture that cannot exercise the preparation list.
        if (options.bookingRequired && !isFood && !secondary) {
          claims.push({
            subjectId: document.subjectId,
            documentIndex: index,
            factPath: 'booking.required',
            statement: 'Tickets must be booked online in advance.',
            evidenceExcerpt: 'Tickets must be booked online in advance.',
            derivation: 'directly_stated',
            payload: { value: 'yes', bookingUrl: `${document.url}/tickets` },
          });
        }

        if (options.temporaryClosure && index === 0) {
          claims.push({
            subjectId: document.subjectId,
            documentIndex: index,
            factPath: 'hours.closure',
            statement: 'Closed for refurbishment for the whole of this period.',
            evidenceExcerpt: 'Closed for refurbishment.',
            derivation: 'directly_stated',
            payload: { from: '2026-01-01', to: '2027-01-01', severity: 'blocks' },
          });
        }

        if (options.weakDietaryEvidence && isFood) {
          claims.push({
            subjectId: document.subjectId,
            documentIndex: index,
            factPath: 'food.dietary',
            statement: 'The menu mentions some vegetarian dishes.',
            evidenceExcerpt: 'vegetarian options available',
            derivation: 'inferred_from_source',
          });
        }
      }

      return {
        claims,
        unanswered: subjects
          .filter((subject) => !documents.some((document) => document.subjectId === subject.id))
          .map((subject) => ({
            subjectId: subject.id,
            factPath: 'hours.weekly' as const,
            reason: 'No page was found for this subject.',
          })),
        gaps: [],
        calls: 1,
        promptVersion: 'fake-extract/1',
        schemaVersion: 'fake-extraction/1',
      };
    },
  };

  return { sourceDiscovery, retrieval, extraction };
}

/**
 * A synthetic content digest with the shape of a real one.
 *
 * Derived from the URL alone, because that is what a real page's bytes behave
 * like: the same page read twice hashes the same however many other pages were
 * requested alongside it. Seeding it with the request *index* made the digest
 * depend on how many subjects happened to be in the batch, so a warm
 * compilation — which legitimately researches fewer of them — minted a fresh
 * claim for every page it re-read.
 */
function syntheticDigest(seed: string): string {
  return [0, 1, 2, 3].map((salt) => stableHash(`${salt}:${seed}`)).join('');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown.invalid';
  }
}

export function syntheticCandidate(spec: SyntheticWorldSpec): DestinationCandidate {
  return {
    id: spec.id,
    displayName: spec.name,
    qualifiedName: spec.qualifiedName,
    entityType: spec.entityType,
    breadth: spec.breadth,
    center: spec.center,
    countryCode: spec.countryCode,
    aliases: [],
    administrativeAreas: [spec.qualifiedName],
    timeZones: spec.timeZones ?? [spec.timeZone],
    providerRefs: [
      { provider: 'fake-resolver', externalId: spec.id },
      { provider: 'fake-second-resolver', externalId: spec.id },
    ],
    confidence: assessConfidence([
      'exact_name_match',
      'administrative_hierarchy_match',
      'multiple_providers_agree',
    ]),
  };
}

/**
 * A provider set where everything fails.
 *
 * Not a convenience: an outage has to be a first-class test case, because the
 * behaviour it must produce — an honest partial result rather than a default
 * sunny world — is the behaviour that is easiest to lose in a refactor.
 */
export function failingProviders(spec: SyntheticWorldSpec): CompilerProviders {
  const base = fakeProviders(spec);
  return {
    ...base,
    places: {
      name: 'failing-places',
      async discover() {
        return {
          candidates: [],
          gaps: [{ subjectId: spec.id, reason: 'provider_error', detail: 'The search provider did not answer.' }],
          calls: 1,
        };
      },
    },
  };
}
