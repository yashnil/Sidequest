import { interestLevels } from '../cases/builder';
import {
  BENCHMARK_REQUEST_VERSION,
  benchmarkTripRequestSchema,
  type BenchmarkTripRequest,
} from '../schemas/request';

/**
 * THE TRAVELLER THE FIXTURE PLANS FOR.
 *
 * Not one of the library cases. The case library describes real destinations and
 * the fixture world does not exist, so pairing them would produce a ground truth
 * whose request and inventory are about different planets — and every check that
 * compared the two would be meaningless in a way that is hard to see.
 *
 * One stated constraint is doing real work: `strenuous_activity` is a hard
 * avoidance, and exactly one place in the fixture world is strenuous. That is
 * what lets `ignoredHardAvoidancePlan` be a single-defect plan against the
 * default ground truth, with no bespoke setup at the call site.
 */

/**
 * The instant every fixture is judged at.
 *
 * Eight days before the fixture trip starts, so the trip is in the future and
 * stays there however long this repository lives. Nothing in this directory
 * reads a clock; where an instant is needed it comes from here or from a
 * parameter.
 */
export const FIXED_NOW = new Date('2027-05-10T09:00:00.000Z');

export const FIXTURE_START_DATE = '2027-05-18';
export const FIXTURE_END_DATE = '2027-05-20';
export const FIXTURE_DATES = ['2027-05-18', '2027-05-19', '2027-05-20'] as const;

type SectionKeys =
  | 'destination'
  | 'dates'
  | 'arrival'
  | 'departure'
  | 'party'
  | 'movement'
  | 'rhythm'
  | 'taste'
  | 'conditions'
  | 'practicalities';

/**
 * Sections merge, scalars replace.
 *
 * The same convention `packages/core/src/testing/fixtures.ts` uses, and for the
 * same reason: a test that wants one different movement cap should not have to
 * restate eleven fields it does not care about, and a test that replaces an
 * array means to replace it.
 */
export type FakeRequestOverrides = {
  [K in SectionKeys]?: Partial<BenchmarkTripRequest[K]>;
} & Partial<Pick<BenchmarkTripRequest, 'requestId' | 'origin' | 'freeText'>>;

export function fakeRequest(overrides: FakeRequestOverrides = {}): BenchmarkTripRequest {
  const base = {
    schemaVersion: BENCHMARK_REQUEST_VERSION,
    requestId: 'req-fixture-kestrel-coast',
    destination: {
      mode: 'known' as const,
      text: 'Kestrel Coast',
      identity: {
        id: 'kc-region',
        displayName: 'Kestrel Coast',
        countryCode: 'TL',
        latitude: 55.2,
        longitude: -5.4,
      },
    },
    dates: {
      mode: 'exact' as const,
      startDate: FIXTURE_START_DATE,
      endDate: FIXTURE_END_DATE,
      flexDays: 0,
      month: null,
      year: null,
      nights: 2,
    },
    arrival: { precision: 'exact' as const, time: '09:00' },
    departure: { precision: 'exact' as const, time: '16:00' },
    origin: 'Testland Central',
    party: {
      adults: 2,
      children: 0,
      childAges: [],
      seniorsInGroup: false,
      mobility: [],
      mobilityNotes: '',
      dietary: [],
      dietaryStrict: false,
    },
    movement: {
      preference: 'drive' as const,
      publicTransit: 'accept' as const,
      carAvailable: true,
      comfortableMountainRoads: true,
      // Comfortable with a gravel track, so that the one place in this world
      // with an unpaved approach violates exactly one thing — the stated
      // avoidance of strenuous activity — rather than two.
      comfortableUnpavedRoads: true,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 180,
      maxDailyTravelMinutes: 300,
      maxAccessWalkMinutes: 45,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'balanced' as const,
      activityIntensity: 'moderate' as const,
      freeTime: 'balanced' as const,
      earlyMornings: 'sometimes' as const,
    },
    taste: {
      interests: interestLevels({
        scenic_viewpoints: 'core',
        easy_nature_walks: 'frequent',
        museums_and_galleries: 'occasional',
        food_and_towns: 'occasional',
        lakes_and_rivers: 'occasional',
        history_and_culture: 'occasional',
      }),
      crowdTolerance: 'mild' as const,
      discoveryMix: 'balanced' as const,
      foodImportance: 'matters' as const,
      nightlifeImportance: 'not_at_all' as const,
      indoorOutdoorBalance: 'balanced' as const,
      // Named the way the inventory names it. A must-do can only be checked by
      // matching text — there is no identity for "the sunrise hike my brother
      // did" — so a fixture that phrased it loosely would be testing the
      // matcher's generosity rather than whether the plan honoured the request.
      mustDo: ['Old Quay Steps'],
      dislikes: [],
      hardAvoidances: ['strenuous_activity' as const],
    },
    conditions: {
      climate: 'mild' as const,
      heat: 'fine' as const,
      cold: 'fine' as const,
      rain: 'prefer_not' as const,
      snow: 'fine' as const,
    },
    practicalities: {
      budget: 'midrange' as const,
      accommodation: 'basic_hotel' as const,
      reservations: 'a_few_is_fine' as const,
      guidedTours: 'avoid' as const,
    },
    freeText: 'Two nights, one base, we would rather walk than drive where we can.',
  } satisfies BenchmarkTripRequest;

  return benchmarkTripRequestSchema.parse({
    ...base,
    ...(overrides.requestId === undefined ? {} : { requestId: overrides.requestId }),
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    ...(overrides.freeText === undefined ? {} : { freeText: overrides.freeText }),
    destination: { ...base.destination, ...overrides.destination },
    dates: { ...base.dates, ...overrides.dates },
    arrival: { ...base.arrival, ...overrides.arrival },
    departure: { ...base.departure, ...overrides.departure },
    party: { ...base.party, ...overrides.party },
    movement: { ...base.movement, ...overrides.movement },
    rhythm: { ...base.rhythm, ...overrides.rhythm },
    taste: { ...base.taste, ...overrides.taste },
    conditions: { ...base.conditions, ...overrides.conditions },
    practicalities: { ...base.practicalities, ...overrides.practicalities },
  });
}
