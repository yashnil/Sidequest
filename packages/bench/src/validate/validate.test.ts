import { describe, expect, it } from 'vitest';
import {
  benchReportSchema,
  BENCH_CHECK_CODES,
  UNKNOWN_REASONS,
  type BenchCheckCode,
  type BenchSeverity,
  type UnknownReason,
} from '../schemas/finding';
import {
  type BenchmarkPlan,
  type PlanBlock,
  type PlanDay,
  type PlaceRef,
} from '../schemas/plan';
import { HARD_AVOIDANCES, INTERESTS, type BenchmarkTripRequest } from '../schemas/request';
import type {
  BenchmarkGroundTruth,
  DayOpening,
  FoodVenueFacts,
  InventoryEntry,
  SolarDay,
} from '../ground-truth';
import { CHECK_COVERAGE, runNeutralValidation } from '../validate';
import { CLAIM_PATTERNS, HEDGE_WORDS, scanProse } from './claims';
import { AVOIDANCE_TAGS, matchesMustDoText } from './constraints';

/**
 * The validators' own validator.
 *
 * Four things are being defended here and only the first is ordinary coverage.
 *
 * That every check actually fires — a check nobody has seen fail is
 * indistinguishable from a check that always passes, and a benchmark full of the
 * latter would report both systems as flawless.
 *
 * That `unknown` never costs anybody anything. Each reason gets a fixture with
 * exactly the evidence removed, and the critical count has to stay where it was.
 *
 * That the report is a function of the plan and nothing else — not array order,
 * and above all not which system produced it. The provenance test compares the
 * two reports byte for byte, because a bias that survives to the results table
 * would be undetectable by then.
 *
 * And that the prose sweep, the one check with a real false-positive risk, has a
 * test per mitigation.
 */

/* ------------------------------------------------------------------ *
 * Ground truth, faked
 * ------------------------------------------------------------------ */

interface FakeOptions {
  /** Mutates the traveller's statement in place, so a fixture states one change. */
  request?: (request: BenchmarkTripRequest) => void;
  places?: Record<string, Partial<InventoryEntry> | null>;
  openings?: Record<string, DayOpening | null>;
  seasonal?: Record<string, boolean | null>;
  solar?: Record<string, SolarDay | null>;
  routes?: Record<string, number | null>;
  straightLine?: Record<string, number | null>;
  food?: Record<string, Partial<FoodVenueFacts> | null>;
  supportsClaim?: (index: number, factPath?: string, statedValue?: string) => boolean | null;
}

const DEFAULT_OPENING: DayOpening = {
  status: 'open',
  windows: [{ openMinute: 480, closeMinute: 1080 }],
  lastAdmissionMinute: 1020,
};

const DEFAULT_SOLAR: SolarDay = { sunriseMinute: 360, sunsetMinute: 1200, kind: 'normal' };

function inventoryEntry(entityId: string, name: string, latitude: number): InventoryEntry {
  return {
    entityId,
    name,
    latitude,
    longitude: -119,
    typicalDurationMinutes: 120,
    daylightOnly: false,
    tags: ['scenic_viewpoint'],
    requiresCar: false,
    unpavedApproach: false,
    remoteNoServices: false,
    strenuous: false,
  };
}

const DEFAULT_PLACES: Record<string, InventoryEntry> = {
  base1: inventoryEntry('base1', 'Valley Inn', 37.6),
  base2: inventoryEntry('base2', 'Lake Lodge', 37.9),
  p1: inventoryEntry('p1', 'Morning Trail', 37.61),
  p2: inventoryEntry('p2', 'Blue Lake', 37.62),
  p3: inventoryEntry('p3', 'Old Mill', 37.63),
  p4: inventoryEntry('p4', 'North Overlook', 37.64),
  v1: inventoryEntry('v1', 'Trailhead Cafe', 37.615),
};

const DEFAULT_FOOD: FoodVenueFacts = {
  entityId: 'v1',
  name: 'Trailhead Cafe',
  latitude: 37.615,
  longitude: -119,
  servesSlots: ['breakfast', 'lunch', 'dinner'],
  cannotAccommodate: [],
};

type Interests = BenchmarkTripRequest['taste']['interests'];

/** The interest map is exhaustive by schema, so a fixture has to fill it. */
function everyInterestAt(level: Interests[keyof Interests]): Interests {
  return Object.fromEntries(INTERESTS.map((interest) => [interest, level])) as Interests;
}

function baseRequest(): BenchmarkTripRequest {
  return {
    schemaVersion: 1,
    requestId: 'req-1',
    destination: {
      mode: 'known',
      text: 'The valley',
      identity: { id: 'dest-1', displayName: 'The Valley', latitude: 37.6, longitude: -119 },
    },
    dates: {
      mode: 'exact',
      startDate: '2026-08-10',
      endDate: '2026-08-11',
      flexDays: 0,
      month: null,
      year: null,
      nights: 2,
    },
    arrival: { precision: 'exact', time: '08:00' },
    departure: { precision: 'exact', time: '23:00' },
    origin: 'Home',
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
      preference: 'drive',
      publicTransit: 'accept',
      carAvailable: true,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: true,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 240,
      maxDailyTravelMinutes: 300,
      maxAccessWalkMinutes: 30,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'balanced',
      activityIntensity: 'moderate',
      freeTime: 'balanced',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: { ...everyInterestAt('low'), hiking: 'core', scenic_viewpoints: 'frequent' },
      crowdTolerance: 'mild',
      discoveryMix: 'balanced',
      foodImportance: 'matters',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: [],
      dislikes: [],
      hardAvoidances: [],
    },
    conditions: { climate: 'mild', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'boutique_hotel',
      reservations: 'a_few_is_fine',
      guidedTours: 'sometimes',
    },
    freeText: '',
  };
}

function fakeGroundTruth(options: FakeOptions = {}): BenchmarkGroundTruth {
  const request = baseRequest();
  options.request?.(request);

  const lookupPlace = (entityId: string): InventoryEntry | null => {
    const override = options.places?.[entityId];
    if (override === null) return null;
    const base = DEFAULT_PLACES[entityId] ?? null;
    if (!base && !override) return null;
    const fallback = base ?? inventoryEntry(entityId, entityId, 37.6);
    return override ? { ...fallback, ...override } : fallback;
  };

  return {
    request,
    now: new Date('2026-08-01T00:00:00Z'),
    place: lookupPlace,
    openingOn(entityId, date) {
      const keyed = options.openings?.[`${entityId}@${date}`];
      if (keyed !== undefined) return keyed;
      const byId = options.openings?.[entityId];
      if (byId !== undefined) return byId;
      return lookupPlace(entityId) ? DEFAULT_OPENING : null;
    },
    seasonallyOpenOn(entityId, date) {
      const keyed = options.seasonal?.[`${entityId}@${date}`];
      if (keyed !== undefined) return keyed;
      const byId = options.seasonal?.[entityId];
      if (byId !== undefined) return byId;
      return lookupPlace(entityId) ? true : null;
    },
    solar(entityId, date) {
      const keyed = options.solar?.[`${entityId}@${date}`];
      if (keyed !== undefined) return keyed;
      const byId = options.solar?.[entityId];
      if (byId !== undefined) return byId;
      return lookupPlace(entityId) ? DEFAULT_SOLAR : null;
    },
    routeMinutes(from, to) {
      const keyed = options.routes?.[`${from}->${to}`];
      if (keyed !== undefined) return keyed;
      return lookupPlace(from) && lookupPlace(to) ? 40 : null;
    },
    straightLineKm(from, to) {
      const keyed = options.straightLine?.[`${from}->${to}`];
      if (keyed !== undefined) return keyed;
      return lookupPlace(from) && lookupPlace(to) ? 20 : null;
    },
    food(entityId) {
      const override = options.food?.[entityId];
      if (override === null) return null;
      if (override) return { ...DEFAULT_FOOD, ...override, entityId };
      return entityId === 'v1' ? DEFAULT_FOOD : null;
    },
    supportsClaim(index, factPath, statedValue) {
      return options.supportsClaim ? options.supportsClaim(index, factPath, statedValue) : true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * A plan with nothing wrong with it
 * ------------------------------------------------------------------ */

function ref(entityId: string | null, name: string, latitude = 37.6): PlaceRef {
  return { entityId, name, latitude, longitude: -119 };
}

function block(partial: Partial<PlanBlock> & Pick<PlanBlock, 'kind' | 'title'>): PlanBlock {
  return {
    startMinute: null,
    endMinute: null,
    place: null,
    travel: null,
    meal: null,
    opening: null,
    note: '',
    uncertainty: [],
    evidence: [],
    ...partial,
  };
}

function drive(
  from: PlaceRef,
  to: PlaceRef,
  startMinute: number,
  endMinute: number,
  minutes: number,
): PlanBlock {
  return block({
    kind: 'travel',
    title: `To ${to.name}`,
    startMinute,
    endMinute,
    travel: { mode: 'drive', from, to, minutes, km: 20, provenance: 'measured' },
  });
}

function visit(place: PlaceRef, startMinute: number, endMinute: number): PlanBlock {
  return block({ kind: 'activity', title: place.name, startMinute, endMinute, place });
}

function day(dayNumber: number, date: string, first: PlaceRef, second: PlaceRef): PlanDay {
  const home = ref('base1', 'Valley Inn');
  const venue = ref('v1', 'Trailhead Cafe', 37.615);
  return {
    dayNumber,
    date,
    baseId: 'b1',
    theme: 'Water and stone',
    blocks: [
      drive(home, first, 480, 540, 60),
      visit(first, 540, 660),
      drive(first, second, 660, 700, 40),
      visit(second, 700, 820),
      block({
        kind: 'meal',
        title: 'Lunch',
        startMinute: 820,
        endMinute: 880,
        meal: { slot: 'lunch', stopKind: 'venue', venue, detourMinutes: 10 },
      }),
      drive(venue, home, 880, 920, 40),
    ],
    statedTotals: { travelMinutes: 140, driveMinutes: 140, freeMinutes: 0, derived: false },
    alternatives: [],
    warnings: [],
  };
}

function soundPlan(): BenchmarkPlan {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    requestId: 'req-1',
    producedBy: 'sidequest',
    generationState: 'complete',
    failureKind: null,
    failureDetail: null,
    summary: 'Two unhurried days between the lake and the old mill.',
    destination: ref(null, 'The Valley'),
    scopeNote: 'The valley floor and its immediate side roads.',
    startDate: '2026-08-10',
    endDate: '2026-08-11',
    bases: [
      {
        id: 'b1',
        place: ref('base1', 'Valley Inn'),
        nights: 2,
        fromDate: '2026-08-10',
        toDate: '2026-08-11',
        why: 'Central to everything on the list.',
      },
    ],
    days: [
      day(1, '2026-08-10', ref('p1', 'Morning Trail'), ref('p2', 'Blue Lake')),
      day(2, '2026-08-11', ref('p3', 'Old Mill'), ref('p4', 'North Overlook')),
    ],
    exclusions: [],
    unknowns: [],
    preparation: [],
    warnings: [],
    sources: [],
  };
}

function run(mutate?: (plan: BenchmarkPlan, options: FakeOptions) => void) {
  const plan = soundPlan();
  const options: FakeOptions = {};
  mutate?.(plan, options);
  return runNeutralValidation(plan, fakeGroundTruth(options));
}

function codes(report: ReturnType<typeof run>): BenchCheckCode[] {
  return report.findings.map((finding) => finding.code);
}

function severityOf(report: ReturnType<typeof run>, code: BenchCheckCode): BenchSeverity[] {
  return report.findings.filter((finding) => finding.code === code).map((finding) => finding.severity);
}

/* ------------------------------------------------------------------ *
 * The baseline
 * ------------------------------------------------------------------ */

describe('a plan with nothing wrong with it', () => {
  it('produces no defects at all', () => {
    const report = run();
    expect(report.counts.critical).toBe(0);
    expect(report.counts.major).toBe(0);
    expect(report.counts.minor).toBe(0);
  });

  it('is checked rather than waved through', () => {
    const report = run();
    expect(report.verifiability.attempted).toBeGreaterThan(40);
    expect(report.verifiability.decided).toBe(report.verifiability.attempted);
  });

  it('emits findings the finding schema accepts', () => {
    expect(() => benchReportSchema.parse(run(mutations[0]!.apply))).not.toThrow();
  });
});

describe('a plan that states nothing', () => {
  /**
   * The scoring loophole this benchmark exists to close: a plan can always drive
   * its defect count down by refusing to commit to anything, and the only thing
   * standing between that and a good result is that verifiability falls with it.
   */
  it('earns few defects and little verifiability', () => {
    const report = run((plan) => {
      for (const planDay of plan.days) {
        planDay.blocks = [
          block({ kind: 'activity', title: 'Explore the area', place: ref(null, 'the area') }),
        ];
        planDay.statedTotals = { travelMinutes: null, driveMinutes: null, freeMinutes: null , derived: false};
        planDay.baseId = null;
      }
      plan.bases = [];
    });

    expect(report.counts.critical).toBe(0);
    const decidedShare = report.verifiability.decided / report.verifiability.attempted;
    expect(decidedShare).toBeLessThan(0.35);
    expect(report.counts.unknown).toBeGreaterThan(10);
  });
});

/* ------------------------------------------------------------------ *
 * Every check, flipped once
 * ------------------------------------------------------------------ */

interface Mutation {
  code: BenchCheckCode;
  severity: BenchSeverity;
  label: string;
  apply: (plan: BenchmarkPlan, options: FakeOptions) => void;
}

function blockAt(plan: BenchmarkPlan, dayIndex: number, blockIndex: number): PlanBlock {
  return plan.days[dayIndex]!.blocks[blockIndex]!;
}

function clearTotals(planDay: PlanDay): void {
  planDay.statedTotals = { travelMinutes: null, driveMinutes: null, freeMinutes: null , derived: false};
}

const mutations: Mutation[] = [
  {
    code: 'date_missing_from_plan',
    severity: 'critical',
    label: 'a date the trip covers and the plan does not',
    apply: (plan) => {
      plan.days = [plan.days[0]!];
    },
  },
  {
    code: 'date_outside_range',
    severity: 'critical',
    label: 'a day dated outside the trip',
    apply: (plan) => {
      plan.days[1]!.date = '2026-09-04';
    },
  },
  {
    code: 'duplicate_date',
    severity: 'critical',
    label: 'the same date twice',
    apply: (plan) => {
      plan.days[1]!.date = '2026-08-10';
    },
  },
  {
    code: 'arrival_day_starts_too_early',
    severity: 'major',
    label: 'a first day beginning before the traveller lands',
    apply: (plan) => {
      blockAt(plan, 0, 0).startMinute = 380;
    },
  },
  {
    code: 'departure_day_ends_too_late',
    severity: 'major',
    label: 'a last day running past the flight home',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.departure = { precision: 'exact', time: '10:00' };
      };
    },
  },
  {
    code: 'empty_day',
    severity: 'major',
    label: 'a day inside the trip with nothing on it',
    apply: (plan) => {
      plan.days[1]!.blocks = [];
    },
  },
  {
    code: 'empty_successful_plan',
    severity: 'critical',
    label: 'a complete run that scheduled nothing',
    apply: (plan) => {
      for (const planDay of plan.days) planDay.blocks = [];
    },
  },
  {
    code: 'missing_travel_segment',
    severity: 'critical',
    label: 'two places in a row and no journey between them',
    apply: (plan) => {
      plan.days[0]!.blocks.splice(2, 1);
    },
  },
  {
    code: 'travel_segment_endpoints_broken',
    severity: 'critical',
    label: 'a leg that arrives somewhere the day is not',
    apply: (plan) => {
      blockAt(plan, 0, 2).travel!.to = ref('p9', 'Somewhere else');
    },
  },
  {
    code: 'route_time_unavailable',
    severity: 'unknown',
    label: 'a pair nobody measured',
    apply: (_plan, options) => {
      options.routes = { 'p1->p2': null };
      options.straightLine = { 'p1->p2': null };
      options.places = { p9: null };
    },
  },
  {
    code: 'impossible_jump',
    severity: 'critical',
    label: 'less time than the measured journey takes',
    apply: (_plan, options) => {
      options.routes = { 'p1->p2': 400 };
    },
  },
  {
    code: 'base_inconsistent',
    severity: 'major',
    label: 'a day that does not end where it sleeps',
    apply: (plan) => {
      blockAt(plan, 0, 5).travel!.to = ref('p4', 'North Overlook');
    },
  },
  {
    code: 'transfer_day_without_transfer',
    severity: 'critical',
    label: 'a new bed with no journey to it',
    apply: (plan) => {
      plan.bases.push({
        id: 'b2',
        place: ref('base2', 'Lake Lodge'),
        nights: 1,
        fromDate: '2026-08-11',
        toDate: '2026-08-11',
        why: 'Closer to the north end.',
      });
      plan.days[1]!.baseId = 'b2';
    },
  },
  {
    code: 'transfer_understated',
    severity: 'critical',
    label: 'a move between bases costed at a fraction of the drive',
    apply: (plan, options) => {
      plan.bases.push({
        id: 'b2',
        place: ref('base2', 'Lake Lodge'),
        nights: 1,
        fromDate: '2026-08-11',
        toDate: '2026-08-11',
        why: 'Closer to the north end.',
      });
      plan.days[1]!.baseId = 'b2';
      plan.days[1]!.blocks.unshift(
        drive(ref('base1', 'Valley Inn'), ref('base2', 'Lake Lodge'), 400, 410, 10),
      );
      clearTotals(plan.days[1]!);
      options.routes = { 'base1->base2': 150 };
    },
  },
  {
    code: 'daily_travel_exceeded',
    severity: 'major',
    label: 'more time in transit than the traveller allowed',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.movement.maxDailyTravelMinutes = 60;
      };
    },
  },
  {
    code: 'daily_drive_exceeded',
    severity: 'major',
    label: 'more time at the wheel than the traveller allowed',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.movement.maxDailyDriveMinutes = 30;
      };
    },
  },
  {
    code: 'mobility_conflict',
    severity: 'critical',
    label: 'a strenuous stop for a traveller who said they cannot',
    apply: (_plan, options) => {
      options.places = { p1: { strenuous: true } };
      options.request = (request) => {
        request.party.mobility = ['low_stamina'];
      };
    },
  },
  {
    code: 'hard_avoidance_violated',
    severity: 'critical',
    label: 'the one thing the traveller ruled out',
    apply: (_plan, options) => {
      options.places = { p1: { tags: ['late_night', 'bar'] } };
      options.request = (request) => {
        request.taste.hardAvoidances = ['nightlife'];
      };
    },
  },
  {
    code: 'must_do_ignored',
    severity: 'critical',
    label: 'a named must-do neither scheduled nor explained',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.taste.mustDo = ['Sunrise at Minaret Vista'];
      };
    },
  },
  {
    /*
     * A reason the record *contradicts*, which is now what `major` means.
     *
     * It used to be a reason nothing confirmed, on a place the world has never
     * heard of — and that graded `major` too, so "we could not check the reason"
     * and "the reason is false" were the same finding at the same severity, which
     * is insufficient evidence scored as a defect. The unestablished case is now
     * `unknown` and has its own case below.
     */
    code: 'must_do_deferred_with_reason',
    severity: 'major',
    label: 'a must-do left out for a reason the record contradicts',
    apply: (plan, options) => {
      options.request = (request) => {
        request.taste.mustDo = ['Devils Postpile'];
      };
      // The record says it was open, so "shut all week" is contradicted rather
      // than merely unchecked. That distinction is the whole of this change.
      options.openings = { p9: { status: 'open', windows: [], lastAdmissionMinute: null } };
      plan.exclusions = [
        {
          place: ref('p9', 'Devils Postpile'),
          reason: 'It was shut for the whole week.',
          derived: false,
        },
      ];
    },
  },
  {
    code: 'blocks_overlap',
    severity: 'critical',
    label: 'two things at once',
    apply: (plan) => {
      blockAt(plan, 0, 3).startMinute = 690;
    },
  },
  {
    code: 'activity_duration_implausible',
    severity: 'minor',
    label: 'twenty minutes at a two-hour place',
    apply: (plan) => {
      blockAt(plan, 0, 1).endMinute = 560;
    },
  },
  {
    code: 'scheduled_while_closed',
    severity: 'critical',
    label: 'a visit on a day the gate is shut',
    apply: (_plan, options) => {
      options.openings = { p1: { status: 'closed', windows: [], lastAdmissionMinute: null } };
    },
  },
  {
    code: 'arrives_before_opening',
    severity: 'critical',
    label: 'arriving before the doors open',
    apply: (_plan, options) => {
      options.openings = {
        p1: { status: 'open', windows: [{ openMinute: 600, closeMinute: 1080 }], lastAdmissionMinute: 1020 },
      };
    },
  },
  {
    code: 'arrives_after_last_admission',
    severity: 'critical',
    label: 'arriving after the last entry',
    apply: (_plan, options) => {
      options.openings = {
        p1: { status: 'open', windows: [{ openMinute: 480, closeMinute: 1080 }], lastAdmissionMinute: 500 },
      };
    },
  },
  {
    code: 'ends_after_closing',
    severity: 'critical',
    label: 'still inside after closing',
    apply: (_plan, options) => {
      options.openings = {
        p1: { status: 'open', windows: [{ openMinute: 480, closeMinute: 600 }], lastAdmissionMinute: 560 },
      };
    },
  },
  {
    code: 'seasonal_access_conflict',
    severity: 'critical',
    label: 'a place shut for the season',
    apply: (_plan, options) => {
      options.seasonal = { p1: false };
    },
  },
  {
    code: 'scheduled_outside_daylight',
    severity: 'critical',
    label: 'a daylight-only place in the dark',
    apply: (_plan, options) => {
      options.places = { p1: { daylightOnly: true } };
      options.solar = { p1: { sunriseMinute: 600, sunsetMinute: 640, kind: 'normal' } };
    },
  },
  {
    code: 'scheduled_inside_daylight_buffer',
    severity: 'minor',
    label: 'a daylight-only place finishing at dusk',
    apply: (_plan, options) => {
      options.places = { p1: { daylightOnly: true } };
      options.solar = { p1: { sunriseMinute: 300, sunsetMinute: 680, kind: 'normal' } };
    },
  },
  {
    code: 'excessive_density',
    severity: 'minor',
    label: 'a day with more in it than a day holds',
    apply: (plan) => {
      blockAt(plan, 0, 3).endMinute = 1500;
      clearTotals(plan.days[0]!);
    },
  },
  {
    code: 'insufficient_free_time',
    severity: 'minor',
    label: 'a full day with not a minute unclaimed',
    apply: (plan) => {
      blockAt(plan, 0, 5).startMinute = 880;
      blockAt(plan, 0, 5).endMinute = 1000;
      clearTotals(plan.days[0]!);
    },
  },
  {
    code: 'meal_missing',
    severity: 'minor',
    label: 'a long day with one meal in it',
    apply: (plan) => {
      blockAt(plan, 0, 5).endMinute = 1000;
      clearTotals(plan.days[0]!);
    },
  },
  {
    code: 'long_day_without_food',
    severity: 'major',
    label: 'a long day with nowhere to eat',
    apply: (plan) => {
      plan.days[0]!.blocks.splice(4, 1);
      blockAt(plan, 0, 4).travel!.from = ref('p2', 'Blue Lake');
      blockAt(plan, 0, 4).endMinute = 1000;
      clearTotals(plan.days[0]!);
    },
  },
  {
    code: 'meal_venue_closed',
    severity: 'critical',
    label: 'lunch at a place that is shut',
    apply: (_plan, options) => {
      options.openings = { v1: { status: 'closed', windows: [], lastAdmissionMinute: null } };
    },
  },
  {
    code: 'meal_detour_excessive',
    severity: 'minor',
    label: 'an hour and a half off route for lunch',
    apply: (plan) => {
      blockAt(plan, 0, 4).meal!.detourMinutes = 90;
    },
  },
  {
    code: 'strict_dietary_conflict',
    severity: 'critical',
    label: 'a kitchen that says it cannot cater for the diet',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.party.dietary = ['vegan'];
        request.party.dietaryStrict = true;
      };
      options.food = { v1: { cannotAccommodate: ['vegan'] } };
    },
  },
  {
    code: 'duplicate_place',
    severity: 'major',
    label: 'the same place on two days',
    apply: (plan) => {
      blockAt(plan, 1, 1).place = ref('p1', 'Morning Trail');
    },
  },
  {
    code: 'stated_totals_contradict_timeline',
    severity: 'critical',
    label: 'a stated total the timeline does not add up to',
    apply: (plan) => {
      plan.days[0]!.statedTotals.travelMinutes = 45;
    },
  },
  {
    code: 'internal_contradiction',
    severity: 'critical',
    label: 'a place both scheduled and listed as left out',
    apply: (plan) => {
      plan.exclusions = [
        { place: ref('p1', 'Morning Trail'), reason: 'Too busy in August.', derived: false },
      ];
    },
  },
  {
    code: 'unsupported_exact_value',
    severity: 'minor',
    label: 'an exact time in the prose with nothing behind it',
    apply: (plan) => {
      blockAt(plan, 0, 1).note = 'The upper gate is locked at 16:30 sharp.';
    },
  },
  {
    code: 'unsupported_factual_claim',
    severity: 'major',
    label: 'a citation the source does not support',
    apply: (plan, options) => {
      plan.sources = [{ host: 'example.gov' }];
      blockAt(plan, 0, 1).evidence = [
        { sourceIndex: 0, factPath: 'hours.open', statedValue: '07:00' },
      ];
      options.supportsClaim = () => false;
    },
  },
];

describe('each check, flipped exactly once', () => {
  it('covers every code the benchmark declares', () => {
    const covered = new Set(mutations.map((mutation) => mutation.code));
    expect([...BENCH_CHECK_CODES].filter((code) => !covered.has(code))).toEqual([]);
  });

  for (const mutation of mutations) {
    it(`${mutation.code}: ${mutation.label}`, () => {
      const clean = run();
      expect(
        clean.findings.some(
          (finding) => finding.code === mutation.code && finding.severity === mutation.severity,
        ),
      ).toBe(false);

      const dirty = run(mutation.apply);
      expect(codes(dirty)).toContain(mutation.code);
      expect(severityOf(dirty, mutation.code)).toContain(mutation.severity);
      expect(() => benchReportSchema.parse(dirty)).not.toThrow();
    });
  }
});

/* ------------------------------------------------------------------ *
 * Unknown is not an error
 * ------------------------------------------------------------------ */

interface UnknownFixture {
  reason: UnknownReason;
  code: BenchCheckCode;
  label: string;
  apply: (plan: BenchmarkPlan, options: FakeOptions) => void;
}

const unknownFixtures: UnknownFixture[] = [
  {
    reason: 'no_dataset',
    code: 'scheduled_while_closed',
    label: 'no opening hours are held for the place',
    apply: (_plan, options) => {
      options.openings = { p1: null };
    },
  },
  {
    reason: 'subject_not_in_inventory',
    code: 'mobility_conflict',
    label: 'the plan names a place the inventory does not hold',
    apply: (plan) => {
      blockAt(plan, 0, 1).place = ref(null, 'A trail we heard about');
    },
  },
  {
    reason: 'no_measured_route',
    code: 'route_time_unavailable',
    label: 'nobody measured the leg',
    apply: (_plan, options) => {
      options.routes = { 'p1->p2': null };
    },
  },
  {
    reason: 'evidence_absent',
    code: 'unsupported_factual_claim',
    label: 'nothing retrieved can confirm or deny the citation',
    apply: (plan, options) => {
      plan.sources = [{ host: 'example.gov' }];
      blockAt(plan, 0, 1).evidence = [
        { sourceIndex: 0, factPath: 'hours.open', statedValue: '08:00' },
      ];
      options.supportsClaim = () => null;
    },
  },
  {
    reason: 'plan_omits_field',
    code: 'meal_detour_excessive',
    label: 'the plan does not say how far off route lunch sits',
    apply: (plan) => {
      blockAt(plan, 0, 4).meal!.detourMinutes = null;
    },
  },
  {
    reason: 'request_omits_constraint',
    code: 'arrival_day_starts_too_early',
    label: 'the traveller gave no exact arrival time',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.arrival = { precision: 'morning', time: null };
      };
    },
  },
  {
    reason: 'not_applicable_unproven',
    code: 'strict_dietary_conflict',
    label: 'the kitchen has published no limits either way',
    apply: (_plan, options) => {
      options.request = (request) => {
        request.party.dietary = ['gluten_free'];
        request.party.dietaryStrict = true;
      };
    },
  },
];

describe('unknown is never a defect', () => {
  it('has a fixture for every reason the schema allows', () => {
    const covered = new Set(unknownFixtures.map((fixture) => fixture.reason));
    expect([...UNKNOWN_REASONS].filter((reason) => !covered.has(reason))).toEqual([]);
  });

  for (const fixture of unknownFixtures) {
    it(`${fixture.reason}: ${fixture.label}`, () => {
      const clean = run();
      const report = run(fixture.apply);

      const matching = report.findings.filter(
        (finding) => finding.code === fixture.code && finding.unknownReason === fixture.reason,
      );
      expect(matching.length).toBeGreaterThan(0);
      for (const finding of matching) expect(finding.severity).toBe('unknown');

      expect(report.counts.critical).toBe(clean.counts.critical);
      expect(report.counts.major).toBe(clean.counts.major);
      expect(report.verifiability.decided).toBeLessThan(report.verifiability.attempted);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Determinism and blindness
 * ------------------------------------------------------------------ */

describe('the report is a function of the plan and nothing else', () => {
  it('is byte-identical across two runs', () => {
    const first = JSON.stringify(run());
    const second = JSON.stringify(run());
    expect(first).toBe(second);
  });

  it('survives the days and blocks arriving in another order', () => {
    const ordered = run();
    const shuffled = run((plan) => {
      plan.days = [...plan.days].reverse();
      for (const planDay of plan.days) {
        planDay.blocks = [planDay.blocks[3]!, planDay.blocks[0]!, planDay.blocks[5]!, planDay.blocks[2]!, planDay.blocks[1]!, planDay.blocks[4]!];
      }
    });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(ordered));
  });

  it('cannot see which system produced the plan', () => {
    const sidequest = run((plan) => {
      plan.producedBy = 'sidequest';
      blockAt(plan, 0, 1).endMinute = 560;
    });
    const baseline = run((plan) => {
      plan.producedBy = 'baseline';
      blockAt(plan, 0, 1).endMinute = 560;
    });
    expect(JSON.stringify(baseline)).toBe(JSON.stringify(sidequest));
  });

  it('never throws on a plan whose regions are malformed', () => {
    expect(() =>
      run((plan) => {
        plan.startDate = 'not-a-date';
        plan.endDate = '';
        plan.days[0]!.blocks = [
          block({ kind: 'activity', title: 'Nowhere', place: ref('ghost', 'Ghost') }),
        ];
        plan.bases = [];
      }),
    ).not.toThrow();
  });
});

describe('check coverage', () => {
  it('gives every hard avoidance something to match on', () => {
    for (const avoidance of HARD_AVOIDANCES) {
      expect(AVOIDANCE_TAGS[avoidance]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('matches a must-do by text in either direction, and only there', () => {
    expect(matchesMustDoText('sunrise at minaret vista', 'minaret vista')).toBe(true);
    expect(matchesMustDoText('minaret vista', 'sunrise at minaret vista')).toBe(true);
    expect(matchesMustDoText('blue lake', 'minaret vista')).toBe(false);
  });

  it('maps every declared code to a module', () => {
    const mapped = Object.keys(CHECK_COVERAGE);
    expect([...BENCH_CHECK_CODES].filter((code) => !mapped.includes(code))).toEqual([]);
    expect(mapped.filter((code) => !BENCH_CHECK_CODES.includes(code as BenchCheckCode))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The prose sweep, mitigation by mitigation
 * ------------------------------------------------------------------ */

function proseFindings(note: string, patch?: (target: PlanBlock) => void) {
  return run((plan) => {
    const target = blockAt(plan, 0, 1);
    target.note = note;
    patch?.(target);
  }).findings.filter((finding) => finding.code === 'unsupported_exact_value');
}

describe('the prose sweep', () => {
  it('flags an exact value with nothing behind it', () => {
    expect(proseFindings('The gate is locked at 16:30.').length).toBe(1);
  });

  it('says nothing when the block carries evidence', () => {
    const findings = run((plan) => {
      plan.sources = [{ host: 'example.gov' }];
      const target = blockAt(plan, 0, 1);
      target.note = 'The gate is locked at 16:30.';
      target.evidence = [{ sourceIndex: 0, factPath: 'hours.close', statedValue: '16:30' }];
    }).findings.filter((finding) => finding.code === 'unsupported_exact_value');
    expect(findings).toEqual([]);
  });

  it('(a) ignores a time that is the block describing its own schedule', () => {
    // 540 and 660 are this block's own start and end.
    expect(proseFindings('Arrive at 09:00 and be away by 11:00.')).toEqual([]);
  });

  it('(a) still flags a time the block does not itself keep', () => {
    expect(proseFindings('Arrive at 09:00; the ranger talk is at 14:30.').length).toBe(1);
  });

  it('(a) ignores a time that is the stated opening window', () => {
    expect(
      proseFindings('Open 08:00 to 18:00.', (target) => {
        target.opening = { openMinute: 480, closeMinute: 1080 };
      }),
    ).toEqual([]);
  });

  it('(b) demotes a hedged number to informational', () => {
    const findings = proseFindings('Allow about 90 minutes for the loop.');
    expect(findings.map((finding) => finding.severity)).toEqual(['informational']);
  });

  it('(b) keeps every hedge in the published list working', () => {
    for (const hedge of HEDGE_WORDS) {
      const note = hedge === '~' ? 'Allow ~90 minutes.' : `Allow ${hedge} 90 minutes.`;
      const findings = proseFindings(note);
      expect(findings.map((finding) => finding.severity)).toEqual(['informational']);
    }
  });

  it('(c) never fires on a bare number', () => {
    expect(proseFindings('There are 3 viewpoints and 12 benches along it.')).toEqual([]);
  });

  it('(d) leaves dates, day labels and road numbers alone', () => {
    expect(proseFindings('Day 2 runs up US-395 and finishes on 2026-08-11.')).toEqual([]);
  });

  it('(e) counts a range as one claim', () => {
    const findings = proseFindings('The kiosk is open 10:00–16:00.');
    expect(findings.length).toBe(1);
    expect(String(findings[0]!.observed.value)).toContain('16:00');
  });

  it('flags a closure statement and a permit requirement', () => {
    expect(proseFindings('It is closed on Mondays.').length).toBe(1);
    expect(proseFindings('A permit is required.').length).toBe(1);
  });

  it('(a) ignores a duration that is the block describing its own length', () => {
    // Block (0, 1) runs 540 to 660, which is two hours.
    expect(proseFindings('Two hours here, so allow 120 minutes.')).toEqual([]);
    expect(proseFindings('Allow 2 hours.')).toEqual([]);
  });

  it('(a) ignores a duration that is the leg stating its own journey time', () => {
    /*
     * The case this mitigation exists for. A travel block annotated "45 min on
     * the road" is repeating the number already sitting in `travel.minutes`
     * beside it, and flagging that charged whichever system annotates its legs
     * while leaving alone whichever writes nothing.
     */
    const findings = run((plan) => {
      const leg = blockAt(plan, 0, 2);
      leg.note = 'About 40 min on the road, and 40 minutes back.';
    }).findings.filter((finding) => finding.code === 'unsupported_exact_value');
    expect(findings).toEqual([]);
  });

  it('(a) still flags a duration the block does not itself take', () => {
    expect(proseFindings('The ranger walk lasts 30 minutes.').length).toBe(1);
  });

  it('scopes a citation to the kind of claim it vouches for', () => {
    /*
     * An hours citation answers for a time and says nothing about a price.
     * Exempting the whole note because it carried one reference handed a blanket
     * immunity to whichever system cites, and both of them cite hours.
     */
    const cited = (note: string) =>
      run((plan) => {
        plan.sources = [{ host: 'example.gov' }];
        const target = blockAt(plan, 0, 1);
        target.note = note;
        target.evidence = [
          { sourceIndex: 0, factPath: 'hours.weekly', statedValue: '09:00-17:30' },
        ];
      }).findings.filter((finding) => finding.code === 'unsupported_exact_value');

    expect(cited('The gate is locked at 16:30.')).toEqual([]);
    expect(cited('Entry costs $40.').length).toBe(1);
  });

  it('applies the same scoping to the trip-level prose', () => {
    const summarised = (summary: string) =>
      run((plan) => {
        plan.summary = summary;
        plan.sources = [{ host: 'example.gov' }];
        blockAt(plan, 0, 1).evidence = [
          { sourceIndex: 0, factPath: 'hours.weekly', statedValue: '09:00-17:30' },
        ];
      }).findings.filter((finding) => finding.code === 'unsupported_exact_value');

    expect(summarised('The kiosk shuts at 16:30.')).toEqual([]);
    // Having retrieved a source is not evidence about a price, and the old rule
    // — any source at all exempts the whole summary — was satisfied by nearly
    // every run of one arm and nearly none of the other.
    expect(summarised('Reckon on $40 a head.').length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * A check may not be gated on a field only one converter fills
 * ------------------------------------------------------------------ */

/**
 * The neutral plan schema makes several fields optional, and each of them is one
 * arm's habit: stated day totals and a duration on every leg whatever its
 * provenance on one side, a resolved meal venue on the other. A check that could
 * only run where its field was present was a check one arm could never fail, so
 * each of these reconstructs the subject from the timeline instead and only
 * falls back to the stated form.
 */
describe('subjects are reconstructed from the timeline, not read off optional fields', () => {
  it('totals the travel budgets from the slots the day gives its legs', () => {
    const report = run((plan, options) => {
      for (const planDay of plan.days) {
        for (const target of planDay.blocks) {
          if (target.travel) target.travel = { ...target.travel, minutes: null, provenance: 'unknown' };
        }
        clearTotals(planDay);
      }
      options.request = (request) => {
        request.movement.maxDailyTravelMinutes = 60;
        request.movement.maxDailyDriveMinutes = 30;
      };
    });

    expect(severityOf(report, 'daily_travel_exceeded')).toContain('major');
    expect(severityOf(report, 'daily_drive_exceeded')).toContain('major');
  });

  it('goes undecided only when a leg states neither a duration nor a clock', () => {
    const report = run((plan) => {
      const target = blockAt(plan, 0, 0);
      target.startMinute = null;
      target.endMinute = null;
      target.travel = { ...target.travel!, minutes: null, provenance: 'unknown' };
      clearTotals(plan.days[0]!);
    });

    expect(severityOf(report, 'daily_travel_exceeded')).toContain('unknown');
  });

  it('costs a transfer by the slot the day gives it when it states no duration', () => {
    const report = run((plan, options) => {
      plan.bases.push({
        id: 'b2',
        place: ref('base2', 'Lake Lodge'),
        nights: 1,
        fromDate: '2026-08-11',
        toDate: '2026-08-11',
        why: 'Closer to the north end.',
      });
      plan.days[1]!.baseId = 'b2';
      const move = drive(ref('base1', 'Valley Inn'), ref('base2', 'Lake Lodge'), 400, 410, 10);
      move.travel = { ...move.travel!, minutes: null, provenance: 'unknown' };
      plan.days[1]!.blocks.unshift(move);
      clearTotals(plan.days[1]!);
      options.routes = { 'base1->base2': 150 };
    });

    expect(severityOf(report, 'transfer_understated')).toContain('critical');
  });

  it('reads a meal venue the plan named on the block rather than in the meal', () => {
    const report = run((plan, options) => {
      const meal = blockAt(plan, 0, 4);
      meal.place = ref('v1', 'Trailhead Cafe', 37.615);
      meal.meal = { ...meal.meal!, venue: null };
      options.openings = { v1: { status: 'closed', windows: [], lastAdmissionMinute: null } };
    });

    expect(severityOf(report, 'meal_venue_closed')).toContain('critical');
  });

  it('measures a meal detour off the route when the plan states none', () => {
    const report = run((plan, options) => {
      // The meal sits between two stops the world holds, so the way round by the
      // cafe against the way straight on is arithmetic rather than a claim.
      blockAt(plan, 0, 4).meal!.detourMinutes = null;
      plan.days[0]!.blocks.splice(5, 0, visit(ref('p3', 'Old Mill'), 900, 960));
      options.routes = { 'p2->v1': 50, 'v1->p3': 50, 'p2->p3': 10 };
    });

    expect(severityOf(report, 'meal_detour_excessive')).toContain('minor');
  });

  it('leaves the stated totals undecided rather than passing when none are stated', () => {
    const report = run((plan) => {
      for (const planDay of plan.days) clearTotals(planDay);
    });
    const findings = report.findings.filter(
      (finding) => finding.code === 'stated_totals_contradict_timeline',
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.severity).toBe('unknown');
      expect(finding.unknownReason).toBe('plan_omits_field');
    }
  });

  it('still settles a stated free-time total over legs that state no duration', () => {
    const report = run((plan) => {
      for (const target of plan.days[0]!.blocks) {
        if (target.travel) target.travel = { ...target.travel, minutes: null, provenance: 'unknown' };
      }
      plan.days[0]!.blocks[0]!.startMinute = null;
      plan.days[0]!.blocks[0]!.endMinute = null;
      plan.days[0]!.statedTotals = { travelMinutes: null, driveMinutes: null, freeMinutes: 400 , derived: false};
    });

    expect(severityOf(report, 'stated_totals_contradict_timeline')).toContain('critical');
  });
});

/* ------------------------------------------------------------------ *
 * Wording must not decide a severity
 * ------------------------------------------------------------------ */

describe('a day that calls itself a rest day and is not one', () => {
  function loadedDay(theme: string, warnings: string[]) {
    return run((plan) => {
      plan.days[0]!.theme = theme;
      plan.days[0]!.warnings = warnings;
      blockAt(plan, 0, 5).endMinute = 1000;
      clearTotals(plan.days[0]!);
    });
  }

  it('is a labelling defect rather than an unexecutable trip', () => {
    expect(severityOf(loadedDay('Rest day', []), 'internal_contradiction')).toEqual(['minor']);
  });

  it('is read from the theme and not from a caution that happens to say "rest"', () => {
    const report = loadedDay('Water and stone', ['Take a rest at the summit if the wind gets up.']);
    expect(codes(report)).not.toContain('internal_contradiction');
  });
});

describe('must-do matching', () => {
  it('is not satisfied by a block whose title is a category', () => {
    const report = run((_plan, options) => {
      options.request = (request) => {
        request.taste.mustDo = ['lunch at the old harbour canteen'];
      };
    });
    expect(severityOf(report, 'must_do_ignored')).toContain('critical');
  });

  it('is still satisfied by a title that names the thing', () => {
    const report = run((_plan, options) => {
      options.request = (request) => {
        request.taste.mustDo = ['sunrise at the Morning Trail'];
      };
    });
    expect(codes(report)).not.toContain('must_do_ignored');
  });

  it('never reads a free-text exclusion reason', () => {
    /*
     * A longer reason is likelier to contain the must-do by accident, and one
     * converter concatenates the reason with its suggested remedy — so reading
     * it turned a critical finding into a major one on the strength of how much
     * a system writes.
     */
    const report = run((plan, options) => {
      options.request = (request) => {
        request.taste.mustDo = ['Devils Postpile'];
      };
      plan.exclusions = [
        {
          place: ref('p9', 'Somewhere else'),
          reason: 'Devils Postpile was shut all week.',
          derived: false,
        },
      ];
    });
    expect(severityOf(report, 'must_do_ignored')).toContain('critical');
    expect(codes(report)).not.toContain('must_do_deferred_with_reason');
  });

  /**
   * The third outcome, which used to be folded into the second.
   *
   * A plan that gives a reason nobody can check has not been caught doing
   * anything. Grading it `major` made the cheapest way to score well "name only
   * places the record knows", and summed an absence into a defect count.
   */
  it('leaves a must-do reason unknown when nothing on record speaks to it', () => {
    const report = run((plan, options) => {
      options.request = (request) => {
        request.taste.mustDo = ['Devils Postpile'];
      };
      plan.exclusions = [
        {
          place: ref('p9', 'Devils Postpile'),
          reason: 'The shuttle was full every day we tried.',
          derived: false,
        },
      ];
    });
    expect(severityOf(report, 'must_do_deferred_with_reason')).toContain('unknown');
    expect(severityOf(report, 'must_do_deferred_with_reason')).not.toContain('major');
  });

  it('matches a must-do by text in either direction, and only where the shorter side names something', () => {
    expect(matchesMustDoText('sunrise at minaret vista', 'minaret vista')).toBe(true);
    expect(matchesMustDoText('minaret vista', 'sunrise at minaret vista')).toBe(true);
    expect(matchesMustDoText('breakfast', 'breakfast at the harbour bakery')).toBe(false);
    expect(matchesMustDoText('hike', 'hike up to the tarn at first light')).toBe(false);
    expect(matchesMustDoText('blue lake', 'minaret vista')).toBe(false);
  });
});

describe('a citation that quotes nothing', () => {
  it('is undecided rather than unsupported', () => {
    /*
     * The port answers "does this source say this", and there is no `this` to
     * ask about. An implementation reaching for its own record of how many
     * sources a run retrieved would answer about the index instead, and a major
     * finding would turn on an unrelated count.
     */
    const report = run((plan) => {
      plan.sources = [{ host: 'example.gov' }];
      blockAt(plan, 0, 1).evidence = [{ sourceIndex: 0, factPath: 'hours.open' }];
    });

    const findings = report.findings.filter(
      (finding) => finding.code === 'unsupported_factual_claim',
    );
    expect(findings.map((finding) => finding.severity)).toEqual(['unknown']);
    expect(findings[0]!.unknownReason).toBe('evidence_absent');
  });

  it('is still wrong when it points past the source list the plan published', () => {
    const report = run((plan) => {
      plan.sources = [{ host: 'example.gov' }];
      blockAt(plan, 0, 1).evidence = [
        { sourceIndex: 4, factPath: 'hours.open', statedValue: '07:00' },
      ];
    });
    expect(severityOf(report, 'unsupported_factual_claim')).toContain('major');
  });
});

describe('the sweep vocabulary', () => {
  it('recognises each kind of exact value', () => {
    expect(scanProse('It costs $40.').map((token) => token.kind)).toEqual(['money']);
    expect(scanProse('Allow 45 minutes.').map((token) => token.kind)).toEqual(['duration']);
    expect(scanProse('It is 12 km away.').map((token) => token.kind)).toEqual(['distance']);
    expect(scanProse('Doors at 9am.').map((token) => token.kind)).toEqual(['clock']);
  });

  it('publishes a pattern for every kind it claims to sweep', () => {
    expect(Object.keys(CLAIM_PATTERNS).sort()).toEqual([
      'clock',
      'closure',
      'distance',
      'duration',
      'money',
      'requirement',
    ]);
  });
});
