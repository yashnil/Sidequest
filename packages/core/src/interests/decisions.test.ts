import { describe, expect, it } from 'vitest';
import {
  TRANSIT_CITY_ACCESS,
  TRANSIT_CITY_PLACES,
} from '../testing/transit-city';
import type { AccessDataset, AccessRule } from '../schemas/access';
import type { Place } from '../schemas/place';
import { decisionQuestionsFor, MAX_DECISION_QUESTIONS } from './decisions';

const SOURCE = {
  kind: 'authored' as const,
  sourceName: 'Sidequest fixture',
  confidence: 0.9,
  volatility: 'stable' as const,
};

function place(id: string, overrides: Partial<Place> & Pick<Place, 'category'>): Place {
  return {
    id,
    regionId: 'r',
    name: id,
    shortDescription: `${id} is somewhere with enough written about it to plan around.`,
    coordinates: { lat: 37.6, lng: -119 },
    relationship: 'satellite',
    interests: ['scenic_viewpoints'],
    typicalDurationMinutes: 90,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.4,
    hiddenGemScore: 0.4,
    tags: [],
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
    travelFromBase: { distanceKm: 20, driveMinutes: 30, driveIsScenic: false },
    ...overrides,
  } as Place;
}

function rule(id: string, placeIds: string[], approachMode: AccessRule['approachMode']): AccessRule {
  return {
    id,
    label: id,
    placeIds,
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    approachMode,
    approachMinutes: null,
    privateVehicle: 'allowed',
    serviceRequirement: 'none',
    walkMinutesFromDropOff: 0,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [],
    provenance: SOURCE,
  } as AccessRule;
}

function dataset(rules: AccessRule[]): AccessDataset {
  return { regionId: 'r', points: [], services: [], rules };
}

const DRIVE_ONLY_PLACES = [
  place('p1', { category: 'day_hike', travelFromBase: { distanceKm: 30, driveMinutes: 45, driveIsScenic: true } }),
  place('p2', { category: 'lake' }),
  place('p3', { category: 'viewpoint' }),
  place('p4', { category: 'geothermal' }),
];

describe('the evidence a question interrupts somebody with', () => {
  /**
   * A CLOCK IS EVIDENCE ONLY WHERE IT IS THIS TRAVELLER'S OWN JOURNEY.
   *
   * `travelFromBase.driveMinutes` is not a driving figure — its own schema says
   * the name predates multi-mode measurement — and on a car-free compile every
   * record carries a *walking* proxy for a journey nobody could time. The
   * long-day question printed it bare: "13 of the strongest options sit 275
   * minutes or so away, one way", on the first screen of the journey, about
   * places twelve kilometres from a metropolitan base, to press the traveller
   * into raising a transport limit.
   *
   * The question is still worth asking — those places really are a day out —
   * so what changes is the evidence: a distance, which is true in every mode.
   */
  const FAR_ON_FOOT = [
    place('f1', {
      category: 'viewpoint',
      relationship: 'satellite',
      travelFromBase: { distanceKm: 27.5, driveMinutes: 275, driveIsScenic: false, mode: 'foot' as const, measured: true },
    }),
    place('f2', {
      category: 'viewpoint',
      relationship: 'satellite',
      travelFromBase: { distanceKm: 19, driveMinutes: 190, driveIsScenic: false, mode: 'foot' as const, measured: true },
    }),
  ];

  it('never quotes a walking clock as how far away something is', () => {
    const questions = decisionQuestionsFor({
      places: FAR_ON_FOOT,
      access: dataset([rule('r-foot', ['f1', 'f2'], 'walk')]),
      carAvailable: false,
      secondaryBaseMinutes: [],
    });
    const dayTrip = questions.find((question) => question.id === 'long_day_trip');
    expect(dayTrip, 'the question must still be asked').toBeDefined();
    expect(dayTrip!.evidence).not.toContain('275');
    expect(dayTrip!.evidence).not.toContain('minutes');
    /* And it says the thing that is true in any mode. */
    expect(dayTrip!.evidence).toMatch(/28 km out/);
    expect(dayTrip!.evidence).toMatch(/could not time the journey/);
  });

  it('still quotes the clock where the traveller will drive it', () => {
    const driven = [
      place('d1', {
        category: 'viewpoint',
        relationship: 'satellite',
        travelFromBase: { distanceKm: 90, driveMinutes: 100, driveIsScenic: false, mode: 'car' as const, measured: true },
      }),
    ];
    const questions = decisionQuestionsFor({
      places: driven,
      access: dataset([rule('r-road', ['d1'], 'drive')]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    const dayTrip = questions.find((question) => question.id === 'long_day_trip');
    expect(dayTrip!.evidence).toContain('100 minutes');
  });
});

describe('a follow-up is asked only when the answer changes something', () => {
  it('does not ask a walkable region about a hire car', () => {
    /*
     * The city fixture reaches everything but one vineyard on foot or by metro.
     * Asking somebody there to reconsider a hire car is the destination trivia
     * §6.2 forbids: the plan is the same either way.
     */
    const questions = decisionQuestionsFor({
      places: TRANSIT_CITY_PLACES,
      access: TRANSIT_CITY_ACCESS,
      carAvailable: false,
      secondaryBaseMinutes: [],
    });
    expect(questions.map((question) => question.id)).not.toContain('rent_a_car');
  });

  it('asks a region with no way in but a road', () => {
    const questions = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([rule('r-road', ['p1', 'p2', 'p3', 'p4'], 'drive')]),
      carAvailable: false,
      secondaryBaseMinutes: [],
    });
    const car = questions.find((question) => question.id === 'rent_a_car');
    expect(car).toBeDefined();
    expect(car!.answerField).toBe('willDrive');
    // Every question carries the measurement that justified asking it.
    expect(car!.evidence).toContain('4 of the 4');
    expect(car!.why.length).toBeGreaterThan(0);
  });

  it('does not ask somebody who already told us they have a car', () => {
    const questions = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([rule('r-road', ['p1', 'p2', 'p3', 'p4'], 'drive')]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    expect(questions.map((question) => question.id)).not.toContain('rent_a_car');
  });

  it('does not infer a hire car from an approach nobody classified', () => {
    /*
     * No access rule is not evidence of a road. A region whose approaches were
     * never classified must not produce a confident "you will need a car" out
     * of our own silence.
     */
    const questions = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([]),
      carAvailable: false,
      secondaryBaseMinutes: [],
    });
    expect(questions.map((question) => question.id)).not.toContain('rent_a_car');
  });

  it('does not ask about a car for stops that are a long walk rather than a drive', () => {
    const closeIn = DRIVE_ONLY_PLACES.map((entry) => ({
      ...entry,
      travelFromBase: { distanceKm: 2, driveMinutes: 6, driveIsScenic: false },
    }));
    const questions = decisionQuestionsFor({
      places: closeIn,
      access: dataset([rule('r-road', ['p1', 'p2', 'p3', 'p4'], 'drive')]),
      carAvailable: false,
      secondaryBaseMinutes: [],
    });
    expect(questions.map((question) => question.id)).not.toContain('rent_a_car');
  });

  it('asks about a boat only where a boat is the way in', () => {
    const withoutFerry = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([rule('r-road', ['p1', 'p2', 'p3', 'p4'], 'drive')]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    expect(withoutFerry.map((question) => question.id)).not.toContain('ferry_leg');

    const withFerry = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([
        rule('r-road', ['p1', 'p2', 'p3'], 'drive'),
        rule('r-boat', ['p4'], 'ferry'),
      ]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    const ferry = withFerry.find((question) => question.id === 'ferry_leg');
    expect(ferry?.answerField).toBe('willUseShuttles');
    expect(ferry?.evidence).toContain('1 place is');
  });

  it('asks about a second hotel only when the second area is genuinely far', () => {
    const near = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([rule('r-road', ['p1', 'p2', 'p3', 'p4'], 'drive')]),
      carAvailable: true,
      secondaryBaseMinutes: [35],
    });
    expect(near.map((question) => question.id)).not.toContain('extra_base_move');

    const far = decisionQuestionsFor({
      places: DRIVE_ONLY_PLACES,
      access: dataset([rule('r-road', ['p1', 'p2', 'p3', 'p4'], 'drive')]),
      carAvailable: true,
      secondaryBaseMinutes: [35, 140],
    });
    const move = far.find((question) => question.id === 'extra_base_move');
    expect(move?.answerField).toBe('regionalExpansion');
    expect(move?.evidence).toContain('140');
  });

  it('asks about hard walking only when the best-evidenced places are the hard ones', () => {
    const obscure = decisionQuestionsFor({
      places: [place('p9', { category: 'day_hike', physicalIntensity: 'strenuous', popularityScore: 0.2 })],
      access: dataset([]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    expect(obscure.map((question) => question.id)).not.toContain('strenuous_walking');

    const anchor = decisionQuestionsFor({
      places: [
        place('Sawtooth Ridge', {
          category: 'day_hike',
          physicalIntensity: 'strenuous',
          popularityScore: 0.8,
        }),
      ],
      access: dataset([]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    const strenuous = anchor.find((question) => question.id === 'strenuous_walking');
    expect(strenuous?.evidence).toContain('Sawtooth Ridge');
    expect(strenuous?.answerField).toBe('dailyIntensity');
  });

  it('names the thing that is worth the early start', () => {
    const questions = decisionQuestionsFor({
      places: [place('Cathedral Rock', { category: 'viewpoint', bestTimeOfDay: 'sunrise' })],
      access: dataset([]),
      carAvailable: true,
      secondaryBaseMinutes: [],
    });
    const early = questions.find((question) => question.id === 'early_start');
    expect(early?.evidence).toContain('Cathedral Rock');
    expect(early?.answerField).toBe('dayStart');
  });

  it('never turns a follow-up into a second questionnaire', () => {
    const questions = decisionQuestionsFor({
      places: [
        ...DRIVE_ONLY_PLACES,
        place('Dawn Ridge', {
          category: 'day_hike',
          physicalIntensity: 'strenuous',
          popularityScore: 0.9,
          bestTimeOfDay: 'sunrise',
          travelFromBase: { distanceKm: 90, driveMinutes: 120, driveIsScenic: true },
        }),
      ],
      access: dataset([
        rule('r-road', ['p1', 'p2', 'p3', 'p4', 'Dawn Ridge'], 'drive'),
        rule('r-boat', ['p4'], 'ferry'),
      ]),
      carAvailable: false,
      secondaryBaseMinutes: [180],
    });
    expect(questions.length).toBeLessThanOrEqual(MAX_DECISION_QUESTIONS);
    // The ones that change what gets built come before the ones that change
    // what time it starts.
    expect(questions[0]!.id).toBe('rent_a_car');
  });

  it('says nothing at all about a region with nothing in it', () => {
    expect(
      decisionQuestionsFor({
        places: [],
        access: dataset([]),
        carAvailable: null,
        secondaryBaseMinutes: [],
      }),
    ).toEqual([]);
  });
});
