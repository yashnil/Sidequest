import {
  unavailableWeatherDataset,
  type AccessDataset,
  type OperatingHoursDataset,
  type Place,
  type QuestionnaireAnswers,
  type Region,
  type SourceProvenance,
  type TransitEvidence,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';

import { buildScenario, type ScenarioWorld } from './scenario';

/**
 * A CAR-FREE CITY WHOSE SCHEDULED NETWORK NOBODY COULD TIME.
 *
 * The production shape behind the transit-blind findings, as a world rather
 * than as a literal inside one test file: no car; twenty-five minutes as the
 * answer to "how far will you walk to reach a stop"; a much larger answer to
 * "how far will you travel one way for one stop"; a destination whose evidence
 * observes a scheduled network and whose journeys nobody could time. On that
 * ground the compiler prices every journey on the only network anybody measured
 * — the pedestrian one — so seats a traveller would ride to in twenty minutes
 * arrive as walks of three quarters of an hour and more.
 *
 * It lives here because two suites need the same world and a second copy of it
 * would be a second world: the planner asserts what the legs are, and the web
 * app asserts what the finished document says about them. A fixture whose two
 * halves are wired from one source cannot drift, and drift between the model
 * and the render is exactly how a title-only repair passed a review.
 *
 * NAMES NOTHING REAL. The ids, the coordinates and the durations are chosen to
 * make each bound bite unambiguously and to keep the arithmetic checkable by
 * hand.
 */

export const TRANSIT_BLIND_IDS = {
  regionId: 'cf-metro',
  baseId: 'cf-base',
  near: 'cf-near-market',
  canonA: 'cf-canon-hall',
  canonB: 'cf-canon-terrace',
  canonC: 'cf-canon-basilica',
  outlier: 'cf-outer-headland',
} as const;

/**
 * The journeys, as one table, so the number a test asserts and the number the
 * matrix answers with are the same literal.
 *
 * The three canon figures sit in the band two live car-free metro boards
 * actually produced — three quarters of an hour to an hour on foot to every
 * principal seat — and every one of them is past the twenty-five minute answer
 * several times over. `near` is inside that answer and is the control: a
 * genuine walk, which must stay a walk in every total and on every surface. The
 * outlier is past what any bound here can carry, and it is the guardrail: a fix
 * that reached it would have widened rather than separated.
 */
export const TRANSIT_BLIND_WALKS = {
  near: 14,
  canonA: 48,
  canonB: 55,
  canonC: 62,
  outlier: 130,
} as const;

const SOURCE: SourceProvenance = {
  kind: 'authored',
  sourceName: 'Sidequest fixture',
  confidence: 0.9,
  volatility: 'stable',
};

const REGION: Region = {
  id: TRANSIT_BLIND_IDS.regionId,
  name: 'Riverport',
  baseName: 'Riverport',
  baseCoordinates: { lat: 41.15, lng: -8.61 },
  summary: 'A river city on a metro, where nothing central needs a car.',
  maxRadiusKm: 40,
  aliases: ['riverport'],
  transportSummary: 'The metro reaches everything; the old quarter is walkable.',
  noVehicleSummary: 'A car buys nothing here and parks nowhere.',
};

function place(
  id: string,
  name: string,
  walkMinutes: number,
  overrides: Partial<Place> & Pick<Place, 'interests' | 'category'>,
): Place {
  return {
    id,
    regionId: TRANSIT_BLIND_IDS.regionId,
    name,
    /*
     * Long enough to clear the description mark, and every place carries
     * recorded attributes. This world varies *transport* and nothing else, so
     * evidence quality must not be what decides a band — a thin record would
     * file every candidate under `insufficient_evidence` and the transport axis
     * would never be reached.
     */
    shortDescription: `${name} is one of the places people in Riverport actually go, and it keeps its hours posted.`,
    coordinates: { lat: 41.15, lng: -8.61 },
    relationship: id === TRANSIT_BLIND_IDS.baseId ? 'base' : 'satellite',
    typicalDurationMinutes: 75,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.5,
    hiddenGemScore: 0.4,
    localSignificance: 0.8,
    globalProminence: 0.6,
    tags: ['attr:website', 'attr:opening_hours'],
    weather: {
      exposure: 'mixed',
      precipitation: 'low',
      wind: 'low',
      heat: 'low',
      cold: 'low',
      visibilityDependent: false,
      poorWeatherBackup: false,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'easy',
      remoteNoServices: false,
    },
    /* The legacy scalar the compiler fills from whichever mode the matrix was. */
    travelFromBase: { distanceKm: walkMinutes / 12, driveMinutes: walkMinutes, driveIsScenic: false },
    ...overrides,
  } as Place;
}

const PLACES: Place[] = [
  place(TRANSIT_BLIND_IDS.baseId, 'Riverport Old Quarter', 0, {
    category: 'town_and_food',
    interests: ['food_and_towns'],
  }),
  place(TRANSIT_BLIND_IDS.near, 'Quarter Market', TRANSIT_BLIND_WALKS.near, {
    category: 'town_and_food',
    interests: ['food_and_towns'],
  }),
  place(TRANSIT_BLIND_IDS.canonA, 'Assembly Hall', TRANSIT_BLIND_WALKS.canonA, {
    category: 'museum',
    interests: ['history_and_culture'],
  }),
  place(TRANSIT_BLIND_IDS.canonB, 'North Terrace', TRANSIT_BLIND_WALKS.canonB, {
    category: 'viewpoint',
    interests: ['scenic_viewpoints'],
  }),
  place(TRANSIT_BLIND_IDS.canonC, 'Hill Basilica', TRANSIT_BLIND_WALKS.canonC, {
    category: 'museum',
    interests: ['history_and_culture'],
  }),
  place(TRANSIT_BLIND_IDS.outlier, 'Outer Headland', TRANSIT_BLIND_WALKS.outlier, {
    category: 'viewpoint',
    interests: ['scenic_viewpoints'],
  }),
];

const ACCESS: AccessDataset = {
  regionId: TRANSIT_BLIND_IDS.regionId,
  points: [],
  services: [],
  rules: [
    {
      id: 'cf-rule-walkable',
      label: 'On foot or by metro',
      placeIds: PLACES.map((entry) => entry.id),
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      approachMode: 'walk',
      approachMinutes: null,
      privateVehicle: 'allowed',
      serviceRequirement: 'none',
      walkMinutesFromDropOff: 0,
      internalTransfer: { mode: 'walk', minutes: 0 },
      permitRequired: false,
      notes: [],
      provenance: SOURCE,
    },
  ],
};

const HOURS: OperatingHoursDataset = {
  version: 1,
  regionId: TRANSIT_BLIND_IDS.regionId,
  calendars: PLACES.map((entry) => ({
    kind: 'always_open' as const,
    placeId: entry.id,
    admission: {
      reservationRequired: false,
      timedEntry: false,
      permitRequired: false,
      walkInAllowed: true,
      capacityLimited: false,
    },
    daylightOnly: false,
    provenance: SOURCE,
  })),
};

/**
 * The pedestrian network, which is the only one anybody measured here — and the
 * whole of the problem. Every pair is priced on foot, including the pairs a
 * traveller would ride between.
 */
export function transitBlindWalkMatrix(): TravelTimeMatrix {
  const minutesFor: Record<string, number> = {
    [TRANSIT_BLIND_IDS.baseId]: 0,
    [TRANSIT_BLIND_IDS.near]: TRANSIT_BLIND_WALKS.near,
    [TRANSIT_BLIND_IDS.canonA]: TRANSIT_BLIND_WALKS.canonA,
    [TRANSIT_BLIND_IDS.canonB]: TRANSIT_BLIND_WALKS.canonB,
    [TRANSIT_BLIND_IDS.canonC]: TRANSIT_BLIND_WALKS.canonC,
    [TRANSIT_BLIND_IDS.outlier]: TRANSIT_BLIND_WALKS.outlier,
  };
  const ids = Object.keys(minutesFor);
  const between = (from: string, to: string): number => {
    if (from === to) return 0;
    /* Distance from base for a base pair; otherwise the gap between the two. */
    if (from === TRANSIT_BLIND_IDS.baseId || to === TRANSIT_BLIND_IDS.baseId) {
      return minutesFor[from === TRANSIT_BLIND_IDS.baseId ? to : from]!;
    }
    return Math.max(6, Math.abs(minutesFor[from]! - minutesFor[to]!));
  };
  return {
    mode: 'foot',
    ids,
    minutes: ids.map((from) => ids.map((to) => between(from, to))),
    /* 4.5 km/h, the same conservative pace every derived walk in this product uses. */
    km: ids.map((from) => ids.map((to) => Math.round((between(from, to) / 60) * 4.5 * 100) / 100)),
    provenance: {
      kind: 'measured',
      note: 'Pedestrian network, measured by construction.',
      source: 'packages/planner/src/testing/transit-blind-city.ts',
    },
  };
}

/** The compiler's own signature for "this trip leaned on transit and none measured". */
export function unmeasurableTransit(): TransitEvidence {
  return { journeys: [], requested: 10, measured: 0, absence: 'unsupported' };
}

const ANSWERS: Partial<QuestionnaireAnswers> = {
  interests: {
    history_and_culture: 'core',
    scenic_viewpoints: 'frequent',
    food_and_towns: 'occasional',
    hiking: 'low',
    lakes_and_rivers: 'low',
    wildlife: 'low',
    stargazing: 'low',
  },
  pace: 'balanced',
  dayStart: 'normal',
  dailyIntensity: 'moderate',
  budgetStyle: 'midrange',
  discoveryMix: 'balanced',
  crowdTolerance: 'dont_mind',
  avoidTouristTraps: false,
  /* No car, and the last-mile answer the live journeys gave. */
  willDrive: false,
  maxAccessWalkMinutes: 25,
  /* Substantially larger, and about trains rather than about feet. */
  detourToleranceMinutes: 90,
  maxDailyTravelMinutes: 150,
  regionalExpansion: 'nearby_60',
  avoidances: [],
  mobilityLimited: false,
};

export const CAR_FREE_METRO_WORLD: ScenarioWorld = {
  basics: {
    mode: 'known_destination',
    destinationInput: 'Riverport',
    regionId: TRANSIT_BLIND_IDS.regionId,
    startDate: '2026-08-12',
    endDate: '2026-08-15',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  },
  region: REGION,
  places: PLACES,
  access: ACCESS,
  hours: HOURS,
  baseId: TRANSIT_BLIND_IDS.baseId,
  matrix: transitBlindWalkMatrix,
  weather: (dates, now) =>
    unavailableWeatherDataset({
      regionId: TRANSIT_BLIND_IDS.regionId,
      locations: [
        {
          id: 'cf-weather',
          label: 'Riverport',
          coordinates: REGION.baseCoordinates,
          elevationMetres: 20,
          timeZone: 'Europe/Lisbon',
          placeIds: PLACES.map((entry) => entry.id),
          limitation: 'One point for the whole city.',
        },
      ],
      dates: [...dates],
      now,
      reason: 'not_configured',
      message: 'We have not fetched the weather for this trip yet.',
    }),
  food: null,
  answers: ANSWERS,
};

/**
 * The world, run through the real questionnaire → board → auto-pick pipeline.
 *
 * `network` is the axis: `observed` is the trip whose evidence records a
 * scheduled network nobody could time, and `not_observed` is the control where
 * a long walk is simply a long walk.
 */
export function transitBlindScenario(network: 'observed' | 'not_observed') {
  return buildScenario({
    world: CAR_FREE_METRO_WORLD,
    transit: unmeasurableTransit(),
    scheduledNetwork: network,
  });
}
