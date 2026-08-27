import { describe, expect, it } from 'vitest';
import {
  unavailableWeatherDataset,
  type AccessDataset,
  type ItineraryItem,
  type OperatingHoursDataset,
  type Place,
  type QuestionnaireAnswers,
  type Region,
  type SourceProvenance,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { planTrip } from './plan';
import { DEFAULT_PLANNER_CONFIG } from './types';
import { buildScenario, type ScenarioWorld } from './testing/scenario';

/**
 * MODE SELECTION IS A POLICY, NOT A RACE BETWEEN RESOLVERS.
 *
 * `resolveLeg` answers with the first mode its ordered rules can carry, and on
 * a trip with a car and a road matrix that is the road for every pair the
 * matrix holds — including a pair a hundred and seventy metres apart. The
 * audited plan drove between two adjacent squares and spent sixty minutes
 * parking to cover three and three-quarter kilometres across a day. Every one
 * of those legs was a correct measurement and the day was absurd.
 *
 * Run end to end through the real pipeline, because the defect is in what the
 * scheduler books rather than in what a resolver returns in isolation: the
 * parking allowance the policy has to beat is `config.bufferMinutes`, and it is
 * only spent where a day is actually laid out.
 *
 * The two directions this file holds:
 *
 *   1. a leg short enough that walking beats the drive *and its parking* is
 *      walked, and the threshold moves with that allowance rather than with a
 *      constant written here;
 *   2. accessibility overrides the policy and only ever in the traveller's
 *      favour — a stated mobility constraint, or a walking answer the leg does
 *      not fit inside, and the measured drive stands.
 */

const IDS = {
  regionId: 'sl-compact',
  baseId: 'sl-base',
  adjacent: 'sl-adjacent-square',
  acrossTown: 'sl-across-town',
  outOfTown: 'sl-out-of-town',
} as const;

/**
 * The road network, as one table.
 *
 * `adjacent` is the audited pair: a hundred and seventy metres, one measured
 * minute of driving, and fifteen minutes of parking booked on top of it.
 * `acrossTown` is the control that must stay a drive on distance alone, and
 * `outOfTown` the one that must stay a drive however the allowance moves.
 */
const ROADS = {
  adjacent: { minutes: 1, km: 0.17 },
  acrossTown: { minutes: 8, km: 3.4 },
  outOfTown: { minutes: 24, km: 26 },
} as const;

const SOURCE: SourceProvenance = {
  kind: 'authored',
  sourceName: 'Sidequest fixture',
  confidence: 0.9,
  volatility: 'stable',
};

const REGION: Region = {
  id: IDS.regionId,
  name: 'Fairhaven',
  baseName: 'Fairhaven',
  baseCoordinates: { lat: 44.2, lng: -1.4 },
  summary: 'A compact town with a square you can cross on foot and a coast road out of it.',
  maxRadiusKm: 60,
  aliases: ['fairhaven'],
  transportSummary: 'A car reaches the coast; the centre is a few minutes across.',
  noVehicleSummary: 'Without a car the coast is out of reach.',
};

function place(
  id: string,
  name: string,
  overrides: Partial<Place> & Pick<Place, 'interests' | 'category'>,
): Place {
  return {
    id,
    regionId: IDS.regionId,
    name,
    shortDescription: `${name} is one of the places people in Fairhaven actually go, and it keeps its hours posted.`,
    coordinates: { lat: 44.2, lng: -1.4 },
    relationship: id === IDS.baseId ? 'base' : 'satellite',
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
    travelFromBase: { distanceKm: 1, driveMinutes: 5, driveIsScenic: false },
    ...overrides,
  } as Place;
}

const PLACES: Place[] = [
  place(IDS.baseId, 'Fairhaven Square', {
    category: 'town_and_food',
    interests: ['food_and_towns'],
  }),
  place(IDS.adjacent, 'Market Square', {
    category: 'museum',
    interests: ['history_and_culture'],
    travelFromBase: { distanceKm: ROADS.adjacent.km, driveMinutes: ROADS.adjacent.minutes, driveIsScenic: false },
  }),
  place(IDS.acrossTown, 'Harbour Museum', {
    category: 'museum',
    interests: ['history_and_culture'],
    travelFromBase: { distanceKm: ROADS.acrossTown.km, driveMinutes: ROADS.acrossTown.minutes, driveIsScenic: false },
  }),
  place(IDS.outOfTown, 'Coast Overlook', {
    category: 'viewpoint',
    interests: ['scenic_viewpoints'],
    travelFromBase: { distanceKm: ROADS.outOfTown.km, driveMinutes: ROADS.outOfTown.minutes, driveIsScenic: true },
  }),
];

const ACCESS: AccessDataset = {
  regionId: IDS.regionId,
  points: [],
  services: [],
  rules: [
    {
      id: 'sl-rule-drive',
      label: 'Drive to it',
      placeIds: PLACES.map((entry) => entry.id),
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      approachMode: 'drive',
      approachMinutes: null,
      privateVehicle: 'allowed',
      serviceRequirement: 'none',
      walkMinutesFromDropOff: 0,
      internalTransfer: { mode: 'drive', minutes: 0 },
      permitRequired: false,
      notes: [],
      provenance: SOURCE,
    },
  ],
};

const HOURS: OperatingHoursDataset = {
  version: 1,
  regionId: IDS.regionId,
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

function roadMatrix(): TravelTimeMatrix {
  const fromBase: Record<string, { minutes: number; km: number }> = {
    [IDS.baseId]: { minutes: 0, km: 0 },
    [IDS.adjacent]: ROADS.adjacent,
    [IDS.acrossTown]: ROADS.acrossTown,
    [IDS.outOfTown]: ROADS.outOfTown,
  };
  const ids = Object.keys(fromBase);
  const between = (from: string, to: string) => {
    if (from === to) return { minutes: 0, km: 0 };
    if (from === IDS.baseId || to === IDS.baseId) {
      return fromBase[from === IDS.baseId ? to : from]!;
    }
    /* Between two satellites: the difference in their distance out. */
    const a = fromBase[from]!;
    const b = fromBase[to]!;
    return {
      minutes: Math.max(1, Math.abs(a.minutes - b.minutes)),
      km: Math.max(0.17, Math.round(Math.abs(a.km - b.km) * 100) / 100),
    };
  };
  return {
    mode: 'car',
    ids,
    minutes: ids.map((from) => ids.map((to) => between(from, to).minutes)),
    km: ids.map((from) => ids.map((to) => between(from, to).km)),
    provenance: {
      kind: 'measured',
      note: 'Road network, measured by construction.',
      source: 'packages/planner/src/short-leg-mode.test.ts',
    },
  };
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
  willDrive: true,
  comfortableMountainRoads: true,
  comfortableGravelRoads: true,
  maxAccessWalkMinutes: 25,
  detourToleranceMinutes: 60,
  maxDailyTravelMinutes: 150,
  regionalExpansion: 'nearby_60',
  avoidances: [],
  mobilityLimited: false,
};

const COMPACT_TOWN: ScenarioWorld = {
  basics: {
    mode: 'known_destination',
    destinationInput: 'Fairhaven',
    regionId: IDS.regionId,
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
  baseId: IDS.baseId,
  matrix: roadMatrix,
  weather: (dates, now) =>
    unavailableWeatherDataset({
      regionId: IDS.regionId,
      locations: [
        {
          id: 'sl-weather',
          label: 'Fairhaven',
          coordinates: REGION.baseCoordinates,
          elevationMetres: 15,
          timeZone: 'Europe/Lisbon',
          placeIds: PLACES.map((entry) => entry.id),
          limitation: 'One point for the whole town.',
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

function scenario(answers: Partial<QuestionnaireAnswers> = {}) {
  return buildScenario({
    world: COMPACT_TOWN,
    answers: { ...ANSWERS, ...answers },
    manualIncludes: [IDS.adjacent, IDS.outOfTown],
  });
}

function legsTo(items: readonly ItineraryItem[], toId: string): ItineraryItem[] {
  return items.filter((item) => item.kind === 'travel' && item.travel?.toId === toId);
}

function allItems(plan: ReturnType<typeof planTrip>): ItineraryItem[] {
  return plan.ok ? plan.itinerary.days.flatMap((day) => day.items) : [];
}

describe('a leg short enough that walking beats parking', () => {
  const OVERHEAD = DEFAULT_PLANNER_CONFIG.bufferMinutes;

  it('derives its threshold from the overhead rather than from a constant', () => {
    /*
     * The arithmetic the policy is, stated where a reader can check it: a drive
     * costs its minutes plus the parking allowance the layout books, and a walk
     * costs the road distance at the product's own conservative pace. The
     * distance walking wins up to is a consequence of the allowance, not a
     * number anybody chose.
     */
    const walkMinutes = Math.ceil((ROADS.adjacent.km * 60) / 4.5);
    expect(walkMinutes).toBeLessThanOrEqual(ROADS.adjacent.minutes + OVERHEAD);
    /* And the control legs lose it on their own distance, not on a special case. */
    for (const road of [ROADS.acrossTown, ROADS.outOfTown]) {
      expect(Math.ceil((road.km * 60) / 4.5)).toBeGreaterThan(road.minutes + OVERHEAD);
    }
  });

  it('walks the adjacent square instead of driving and parking', () => {
    const plan = planTrip(scenario());
    expect(plan.ok, plan.ok ? '' : plan.message).toBe(true);
    if (!plan.ok) return;

    const legs = legsTo(allItems(plan), IDS.adjacent);
    expect(legs.length, 'the adjacent stop was never travelled to').toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.travel?.mode, `"${leg.title}" still drives 170 m`).toBe('walk');
      /* Nothing to park, so no parking is booked: the block is the walk itself. */
      expect(leg.durationMinutes).toBe(leg.travel?.minutes);
    }
  });

  it('leaves a leg walking plainly loses as the measured drive it is', () => {
    const plan = planTrip(scenario());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const legs = legsTo(allItems(plan), IDS.outOfTown);
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.travel?.mode).toBe('drive');
      expect(leg.travel?.provenance).toBe('measured');
    }
  });

  it('never switches a traveller with a stated mobility constraint onto a walk', () => {
    /*
     * Accessibility overrides the policy, and only ever in their favour. The
     * same town, the same hundred and seventy metres, and the answer that says
     * do not put me on foot.
     */
    const plan = planTrip(scenario({ mobilityLimited: true }));
    expect(plan.ok, plan.ok ? '' : plan.message).toBe(true);
    if (!plan.ok) return;

    const legs = legsTo(allItems(plan), IDS.adjacent);
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.travel?.mode, 'a mobility-limited traveller was walked').toBe('drive');
    }
  });

  it('never switches a traveller onto a walk longer than the one they agreed to', () => {
    /*
     * The other half of the same rule. A three-minute answer is a three-minute
     * answer: the walk that beats the parking is still a walk they did not
     * agree to, and being put on foot instead of in the car they said they
     * would drive is not a stretch anybody offered.
     */
    const plan = planTrip(scenario({ maxAccessWalkMinutes: 2 }));
    expect(plan.ok, plan.ok ? '' : plan.message).toBe(true);
    if (!plan.ok) return;

    const legs = legsTo(allItems(plan), IDS.adjacent);
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.travel?.mode).toBe('drive');
    }
  });
});
