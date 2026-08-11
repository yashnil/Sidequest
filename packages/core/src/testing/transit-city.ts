import type { TravelTimeMatrix } from '@sidequest/geo';

import type { AccessDataset, AccessRule } from '../schemas/access';
import type { TransitEvidence } from '../schemas/compiled-region';
import type { OperatingHoursDataset } from '../schemas/hours';
import type { Place } from '../schemas/place';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import type { Region } from '../schemas/region';
import type { SourceProvenance } from '../schemas/provenance';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import { travelKnowledgeFor, type TravelKnowledge } from '../travel/reach';

/**
 * A CAR-FREE CITY WHERE THE TWO NETWORKS DISAGREE, AND FIVE PLACES THAT PROVE IT.
 *
 * The Discovery Board's failure was never visible on a driving trip, because on
 * a driving trip the road matrix and the journey the traveller makes are the
 * same thing. It only appears where walking and riding give different answers
 * about the same pair — and until this fixture existed, no world in the
 * repository put a Board in front of a traveller who could not drive *and* held
 * a measured train for them.
 *
 * The five candidates are the five answers a reach question can have, and each
 * one is a defect this pass fixed:
 *
 *   A  a twelve-minute measured walk, close in           → reachable, on foot
 *   B  a ninety-five-minute walk **and** a twenty-seven-  → reachable, by train
 *      minute measured train; strong fit, real local
 *      significance
 *   C  a two-hour walk, no train, no permitted drive      → too burdensome
 *   D  a twenty-two-minute measured drive and nothing     → not reachable
 *      else, for a traveller with no car
 *   E  a journey planner that failed                      → unknown
 *
 * B is the one the whole pass is about. Before it, the Board read B's
 * ninety-five-minute *walk* — because that is what the single matrix measured —
 * called it a detour four times past a twenty-minute car-free radius, scored it
 * down, filed it under "weak fit", and dropped it from auto-pick. The planner,
 * handed the same region, would have taken the train. A traveller never saw a
 * place their own itinerary could have reached.
 *
 * C and D are the guardrails on the other side, and they matter as much: a fix
 * that made B reachable by relaxing the rules would make both of these reachable
 * too, which is a worse product than the one being replaced.
 *
 * NAMES NOTHING REAL. Two Rivers is not a city; the ids, the coordinates and
 * the durations are chosen to make each rule bite unambiguously and to keep the
 * arithmetic checkable by hand. `TRANSIT_CITY_IDENTITY` is asserted by every
 * test that uses this, so a scenario cannot silently run against another world.
 */

export const TRANSIT_CITY_IDENTITY = {
  regionId: 'transit-city',
  baseId: 'transit-city-base',
  candidateA: 'tc-a-quayside-gallery',
  candidateB: 'tc-b-hillside-shrine',
  candidateC: 'tc-c-outer-headland',
  candidateD: 'tc-d-valley-vineyard',
  candidateE: 'tc-e-unverified-quarter',
} as const;

const { baseId, candidateA, candidateB, candidateC, candidateD, candidateE } =
  TRANSIT_CITY_IDENTITY;

/**
 * The journeys, as one table.
 *
 * Declared here rather than inline in the matrices so that the number a test
 * asserts and the number a matrix answers with are the same literal. Two
 * matrices read this: the pedestrian one the traveller's own trip would be
 * routed on, and the road one that exists only to prove road evidence is not
 * reach for somebody with no car.
 */
export const TRANSIT_CITY_JOURNEYS = {
  /** Inside the stated walking tolerance, so nothing should board anything. */
  walkToA: 12,
  /** Far past it. The whole reason B needs a train. */
  walkToB: 95,
  /** Past any budget a day has. Measured, permitted, and still a bad idea. */
  walkToC: 120,
  /** The train. Quicker than the walk and inside the transport budget. */
  transitToB: 27,
  /** Road only, and this traveller has no car. */
  driveToD: 22,
} as const;

export const TRANSIT_CITY_REGION: Region = {
  id: TRANSIT_CITY_IDENTITY.regionId,
  name: 'Two Rivers',
  baseName: 'Two Rivers',
  baseCoordinates: { lat: 38.72, lng: -9.14 },
  summary: 'A river city with a metro, a long waterfront and a headland you can see but not walk to.',
  maxRadiusKm: 60,
  aliases: ['two rivers'],
  transportSummary: 'Everything central is walkable; the metro covers the rest.',
  noVehicleSummary: 'A car buys almost nothing here and costs a fortune to park.',
};

const SOURCE: SourceProvenance = {
  kind: 'authored',
  sourceName: 'Sidequest fixture',
  confidence: 0.9,
  volatility: 'stable',
};

function place(
  id: string,
  name: string,
  overrides: Partial<Place> & Pick<Place, 'interests' | 'category'>,
): Place {
  return {
    id,
    regionId: TRANSIT_CITY_IDENTITY.regionId,
    name,
    /*
     * Long enough to clear the description mark, and every place carries the
     * recorded attributes below. Both are deliberate: this fixture varies
     * *transport* and nothing else, so evidence quality must not be the thing
     * that decides a band. A thin description would file every candidate under
     * `insufficient_evidence` and the transport axis would never be reached.
     */
    shortDescription: `${name} is one of the places people in Two Rivers actually go, and it keeps its hours posted.`,
    coordinates: { lat: 38.72, lng: -9.14 },
    relationship: 'satellite',
    typicalDurationMinutes: 90,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.4,
    hiddenGemScore: 0.5,
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
    /*
     * THE LEGACY SCALAR, DELIBERATELY SET TO THE WALK.
     *
     * This is what the compiler writes from whichever single mode the matrix
     * was, and it is exactly the number the Board used to read. Leaving it at
     * the *walking* figure is what makes this fixture adversarial: any code path
     * that quietly falls back to `travelFromBase.driveMinutes` will produce
     * ninety-five minutes for B and be caught, rather than coincidentally
     * agreeing with the train.
     */
    travelFromBase: { distanceKm: 8, driveMinutes: 95, driveIsScenic: false },
    ...overrides,
  } as Place;
}

export const TRANSIT_CITY_PLACES: Place[] = [
  place(baseId, 'Two Rivers Old Town', {
    relationship: 'base',
    category: 'town_and_food',
    interests: ['food_and_towns'],
    travelFromBase: { distanceKm: 0, driveMinutes: 0, driveIsScenic: false },
  }),
  place(candidateA, 'Quayside Gallery', {
    category: 'museum',
    interests: ['history_and_culture'],
    travelFromBase: { distanceKm: 1, driveMinutes: 12, driveIsScenic: false },
  }),
  /*
   * B is deliberately *good*: a strong interest match and real local
   * significance. A candidate the traveller would not have wanted anyway proves
   * nothing about a logistics penalty, because it would be absent either way.
   */
  place(candidateB, 'Hillside Shrine', {
    category: 'viewpoint',
    interests: ['scenic_viewpoints', 'history_and_culture'],
    popularityScore: 0.55,
    hiddenGemScore: 0.5,
    localSignificance: 0.9,
    globalProminence: 0.5,
    travelFromBase: { distanceKm: 8, driveMinutes: 95, driveIsScenic: false },
  }),
  place(candidateC, 'Outer Headland', {
    category: 'viewpoint',
    interests: ['scenic_viewpoints'],
    travelFromBase: { distanceKm: 14, driveMinutes: 120, driveIsScenic: false },
  }),
  place(candidateD, 'Valley Vineyard', {
    category: 'town_and_food',
    interests: ['food_and_towns'],
    travelFromBase: { distanceKm: 22, driveMinutes: 22, driveIsScenic: false },
  }),
  place(candidateE, 'Unverified Quarter', {
    category: 'town_and_food',
    interests: ['food_and_towns'],
    travelFromBase: { distanceKm: 9, driveMinutes: 30, driveIsScenic: false },
  }),
];

function walkIn(id: string, placeIds: string[]): AccessRule {
  return {
    id,
    label: 'On foot or by metro',
    placeIds,
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
  };
}

export const TRANSIT_CITY_ACCESS: AccessDataset = {
  regionId: TRANSIT_CITY_IDENTITY.regionId,
  points: [],
  services: [],
  rules: [
    walkIn('tc-rule-walkable', [baseId, candidateA, candidateB, candidateC, candidateE]),
    /*
     * D is out in the valley and the dataset says so: a private vehicle is
     * required, which for this traveller is a hard access blocker. That is the
     * *second* reason D must not be selected — the first is that the only
     * journey anybody measured to it is a drive they cannot make — and the two
     * are independent on purpose. A fix that only satisfied one of them would
     * leave the other live.
     */
    {
      ...walkIn('tc-rule-vineyard', [candidateD]),
      label: 'Valley Vineyard by car',
      /*
       * `approachMode: 'drive'` is what blocks it, and it is the honest
       * encoding: the way in is a road, and this traveller has no car.
       * `privateVehicle` stays `allowed` because that field says whether a
       * vehicle is *permitted* on the approach, not whether one is needed — a
       * distinction worth keeping, since the two failed differently in the
       * Eastern Sierra (a shuttle corridor where cars are banned outright).
       */
      approachMode: 'drive',
      privateVehicle: 'allowed',
    },
  ],
};

export const TRANSIT_CITY_HOURS: OperatingHoursDataset = {
  version: 1,
  regionId: TRANSIT_CITY_IDENTITY.regionId,
  calendars: TRANSIT_CITY_PLACES.map((entry) => ({
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

function matrixOf(
  mode: 'foot' | 'car',
  entries: Record<string, { minutes: number; km: number }>,
): TravelTimeMatrix {
  const ids = [baseId, ...Object.keys(entries)];
  const minutesFor = (from: string, to: string): number => {
    if (from === to) return 0;
    const other = from === baseId ? to : from;
    return entries[other]?.minutes ?? 0;
  };
  const kmFor = (from: string, to: string): number => {
    if (from === to) return 0;
    const other = from === baseId ? to : from;
    return entries[other]?.km ?? 0;
  };
  return {
    mode,
    ids,
    minutes: ids.map((from) => ids.map((to) => minutesFor(from, to))),
    km: ids.map((from) => ids.map((to) => kmFor(from, to))),
    provenance: {
      kind: 'measured',
      note: 'Fixture network, measured by construction.',
      source: 'packages/core/src/testing/transit-city.ts',
    },
  };
}

/**
 * The pedestrian network, which is what a car-free trip is routed on.
 *
 * D and E are **absent from it**, and their absence is the fixture rather than
 * an oversight: D sits out in the valley where no footway reaches, and E is the
 * pair the journey planner failed on. A candidate present in the matrix always
 * has *some* measured answer, which would resolve both of them and make two of
 * the five cases untestable.
 */
export function transitCityWalkMatrix(): TravelTimeMatrix {
  return matrixOf('foot', {
    [candidateA]: { minutes: TRANSIT_CITY_JOURNEYS.walkToA, km: 1 },
    [candidateB]: { minutes: TRANSIT_CITY_JOURNEYS.walkToB, km: 7 },
    [candidateC]: { minutes: TRANSIT_CITY_JOURNEYS.walkToC, km: 9 },
  });
}

/**
 * The same city measured on the road, for the one question only a road can ask.
 *
 * Used to prove that a twenty-two-minute *drive* to D — a real, measured,
 * present-in-the-artifact journey — establishes no reach at all for somebody who
 * told us they will not drive. Without a matrix that actually contains that leg,
 * "road evidence does not establish reach" is a claim about an absence.
 */
export function transitCityRoadMatrix(): TravelTimeMatrix {
  return matrixOf('car', {
    [candidateD]: { minutes: TRANSIT_CITY_JOURNEYS.driveToD, km: 22 },
  });
}

const BASIS = {
  kind: 'depart_at' as const,
  instant: '2026-08-12T09:30:00.000Z',
  timeZone: 'Europe/Lisbon',
};

/**
 * The timetables, beside the matrix and never inside it.
 *
 * One measured journey, both directions, because a timetable is not symmetric
 * and the way home is where a car-free trip most often fails. One provider
 * failure, so "we could not check" stays distinguishable from "there is no
 * service". Nothing at all for A, C or D — and that silence is meaningful:
 * absent transit evidence is not evidence of absent transit, and no rule here
 * may treat it as either.
 */
export function transitCityTransit(): TransitEvidence {
  const measured = (fromId: string, toId: string) => ({
    fromId,
    toId,
    status: 'measured' as const,
    minutes: TRANSIT_CITY_JOURNEYS.transitToB,
    transfers: 0,
    walkingMinutes: 7,
    /* Sums to `minutes`. The transit suite's own invariant checks exactly that. */
    legs: [
      { mode: 'walk' as const, minutes: 4 },
      { mode: 'rail' as const, minutes: 20 },
      { mode: 'walk' as const, minutes: 3 },
    ],
    requestBasis: BASIS,
    source: 'fixture-journey-planner',
    retrievedAt: '2026-08-10T09:00:00.000Z',
    detail: 'Measured against published timetables.',
  });
  return {
    journeys: [
      measured(baseId, candidateB),
      measured(candidateB, baseId),
      {
        fromId: baseId,
        toId: candidateE,
        status: 'provider_error',
        requestBasis: BASIS,
        source: 'fixture-journey-planner',
        retrievedAt: '2026-08-10T09:00:00.000Z',
        detail: 'The journey planner did not answer for this one.',
      },
    ],
    requested: 3,
    measured: 2,
  };
}

/**
 * The traveller: no car, a stated walking limit, and interests B satisfies.
 *
 * `maxAccessWalkMinutes: 20` is the number that makes A a walk and B not one.
 * Without it every pair in the fixture is "close enough to walk" and the world
 * never has a reason to board anything.
 */
export function transitCityTraveler(
  overrides: Partial<QuestionnaireAnswers> = {},
): TravelerProfile {
  const context = { travelerNeeds: [], tripDays: 3 };
  const base = defaultAnswers(context);
  const answers: QuestionnaireAnswers = {
    ...base,
    willDrive: false,
    maxAccessWalkMinutes: 20,
    ...overrides,
    interests: {
      ...base.interests,
      scenic_viewpoints: 'core',
      history_and_culture: 'frequent',
      food_and_towns: 'occasional',
      ...overrides.interests,
    },
  };
  return buildTravelerProfile(answers, context);
}

export const TRANSIT_CITY_DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
export const TRANSIT_CITY_MONTHS = [8];

/** Everything `buildDiscoveryBoard` needs, on the pedestrian network. */
export function transitCityBoardInput(profile: TravelerProfile) {
  return {
    region: TRANSIT_CITY_REGION,
    places: TRANSIT_CITY_PLACES,
    profile,
    months: TRANSIT_CITY_MONTHS,
    dates: TRANSIT_CITY_DATES,
    access: TRANSIT_CITY_ACCESS,
    hours: TRANSIT_CITY_HOURS,
    travelerNeeds: [] as never[],
    travel: {
      matrix: transitCityWalkMatrix(),
      transit: transitCityTransit(),
      baseId,
    },
  };
}

/** The same travel truth as a resolver input, for reach-level assertions. */
export function transitCityKnowledge(
  profile: TravelerProfile,
  network: 'walk' | 'road' = 'walk',
): TravelKnowledge {
  return network === 'walk'
    ? travelKnowledgeFor(transitCityWalkMatrix(), profile, transitCityTransit())
    : travelKnowledgeFor(transitCityRoadMatrix(), profile, null);
}
