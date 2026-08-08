import type { z } from 'zod';
import {
  BENCHMARK_PLAN_VERSION,
  benchmarkPlanSchema,
  planBlockSchema,
  type planDaySchema,
  type sourceSchema,
  type BenchmarkPlan,
  type BlockKind,
  type PlaceRef,
  type PlanBlock,
  type PlanDay,
} from '../schemas/plan';
import { FIXTURE_DATES, FIXTURE_END_DATE, FIXTURE_START_DATE } from './request';

/**
 * THE FIXTURE PLANS.
 *
 * One good plan over the Kestrel Coast, and then every way of being wrong that
 * the benchmark's offline matrix names — each derived from the good plan by
 * changing a single thing, so that a validator firing on `missingMealPlan` and
 * nothing else is evidence about the meal check rather than about whatever else
 * happened to differ.
 *
 * Deriving them rather than writing each out longhand is a deliberate trade. A
 * hand-written defect plan drifts: somebody adjusts a time in the good plan, the
 * defect plan keeps the old one, and the check under test starts firing for two
 * reasons. Derivation makes "everything else is identical" true by construction
 * rather than by vigilance.
 *
 * The one pair that is not a single mutation is the neutrality pair, and it is
 * the most important thing in this file. `validBaselineShapedPlan` differs from
 * `validSidequestShapedPlan` in every way a plan can differ without changing
 * what the traveller would actually do — different prose, different names for
 * the same ids, different optional fields present, different array order, no
 * stated totals, no evidence at all — and `planFingerprint` returns the same
 * string for both. If it ever stops doing so, either the fingerprint has begun
 * counting something cosmetic or one of these plans has quietly changed shape,
 * and the neutrality test resting on the pair would be proving nothing.
 */

type PlanBlockInput = z.input<typeof planBlockSchema>;
type PlanDayInput = z.input<typeof planDaySchema>;
type SourceInput = z.input<typeof sourceSchema>;
type PlanInput = z.input<typeof benchmarkPlanSchema>;

/* ------------------------------------------------------------------ *
 * The world, as a plan refers to it
 * ------------------------------------------------------------------ */

function ref(entityId: string, name: string, latitude: number, longitude: number): PlaceRef {
  return { entityId, name, latitude, longitude };
}

const REGION = ref('kc-region', 'Kestrel Coast', 55.2, -5.4);
const HARBOUR = ref('kc-harbour-quarter', 'Harbour Quarter', 55.201, -5.402);
const OLD_QUAY = ref('kc-old-quay-steps', 'Old Quay Steps', 55.2035, -5.398);
const MUSEUM = ref('kc-lantern-museum', 'Lantern Museum', 55.2062, -5.3925);
const TIDAL = ref('kc-tidal-garden', 'Tidal Garden', 55.211, -5.386);
const GULL = ref('kc-gull-rock-lookout', 'Gull Rock Lookout', 55.1965, -5.4105);
const TIDE_MILL = ref('kc-tide-mill', 'Tide Mill', 55.1988, -5.4162);
const TARN = ref('kc-mirror-tarn', 'Mirror Tarn', 55.26, -5.31);
const CABLE = ref('kc-cable-station', 'Wind Ridge Cable Station', 55.245, -5.34);
const HEADLAND = ref('kc-north-headland', 'North Headland Path', 55.31, -5.26);
const SALTMARSH = ref('kc-saltmarsh-hide', 'Saltmarsh Hide', 55.16, -5.52);
const STORM = ref('kc-storm-light', 'Storm Light Beacon', 55.02, -5.78);
const BAKERY = ref('kc-quay-bakery', 'Quay Bakery', 55.2015, -5.4035);
const CANTEEN = ref('kc-harbour-canteen', 'Harbour Canteen', 55.2022, -5.4008);
const BLUE_LANTERN = ref('kc-blue-lantern', 'The Blue Lantern', 55.2044, -5.3968);

/** Somewhere the shared inventory has never heard of. Used by the unknown fixture. */
const FERRYMANS_POINT: PlaceRef = {
  entityId: null,
  name: "Ferryman's Point",
  latitude: null,
  longitude: null,
};

const RETRIEVED_AT = '2027-05-10T08:00:00.000Z';

/**
 * The plan's source list, in the order the ground truth indexes it.
 *
 * `evidenceRef.sourceIndex` points in here and `fakeGroundTruth` answers about
 * the same positions, so index 2 — fetched and never read — is what a claim has
 * to rest on for `supportsClaim` to return `null` rather than `false`.
 */
const SOURCES: SourceInput[] = [
  {
    host: 'harbour-authority.invalid',
    title: 'Old Quay Steps — visiting',
    url: 'https://harbour-authority.invalid/old-quay',
    retrievedAt: RETRIEVED_AT,
  },
  {
    host: 'lantern-museum.invalid',
    title: 'Lantern Museum — opening times',
    url: 'https://lantern-museum.invalid/visit',
    retrievedAt: RETRIEVED_AT,
  },
  {
    host: 'kestrel-coast-council.invalid',
    title: 'Kestrel Coast — visitor notes',
    url: 'https://kestrel-coast-council.invalid/visitors',
    retrievedAt: RETRIEVED_AT,
  },
  {
    host: 'wind-ridge-lifts.invalid',
    title: 'Wind Ridge Cable Station — timetable',
    url: 'https://wind-ridge-lifts.invalid/times',
    retrievedAt: RETRIEVED_AT,
  },
  {
    host: 'tide-mill-trust.invalid',
    title: 'Tide Mill — when we are open',
    url: 'https://tide-mill-trust.invalid/open',
    retrievedAt: RETRIEVED_AT,
  },
];

/* ------------------------------------------------------------------ *
 * Block constructors
 * ------------------------------------------------------------------ */

function walkInput(from: PlaceRef, to: PlaceRef, minutes: number, start: number): PlanBlockInput {
  return {
    kind: 'travel',
    title: `Walk to ${to.name}`,
    startMinute: start,
    endMinute: start + minutes,
    travel: {
      mode: 'walk',
      from,
      to,
      minutes,
      km: Math.round(minutes * 0.08 * 10) / 10,
      provenance: 'measured',
    },
    note: 'Flat the whole way, and signposted from the corner.',
  };
}

function driveInput(from: PlaceRef, to: PlaceRef, minutes: number, start: number): PlanBlockInput {
  return {
    kind: 'travel',
    title: `Drive to ${to.name}`,
    startMinute: start,
    endMinute: start + minutes,
    travel: {
      mode: 'drive',
      from,
      to,
      minutes,
      km: Math.round(minutes * 0.9 * 10) / 10,
      provenance: 'measured',
    },
    note: 'Single carriageway, no tolls.',
  };
}

/**
 * A leg no router answered for, stating no duration.
 *
 * The honest shape: `provenance: 'unknown'` with `minutes: null`. A plan that
 * put a number here instead would be asserting something no provider produced,
 * which is a different fixture and a different finding.
 */
function unmeasuredDriveInput(from: PlaceRef, to: PlaceRef, start: number): PlanBlockInput {
  return {
    kind: 'travel',
    title: `Drive to ${to.name}`,
    startMinute: start,
    endMinute: start + 30,
    travel: { mode: 'drive', from, to, minutes: null, km: null, provenance: 'unknown' },
    note: 'We could not get a travel time for this road.',
    uncertainty: ['Nobody measured this leg, so the half hour is a placeholder.'],
  };
}

/**
 * An unscheduled stretch, anchored to somewhere.
 *
 * The place matters more than it looks. A neutral checker reads a day's shape
 * from the placed blocks either side of each leg, so a gap at the base with no
 * place on it makes the walk home appear to arrive at wherever dinner is — the
 * plan is fine and the reading of it is not. Saying where the free time happens
 * is both true and what keeps the chain legible.
 */
function freeTimeInput(where: PlaceRef, start: number, end: number, note: string): PlanBlockInput {
  return {
    kind: 'free_time',
    title: 'Nothing planned',
    startMinute: start,
    endMinute: end,
    place: where,
    note,
  };
}

function packedLunchInput(start: number, end: number): PlanBlockInput {
  return {
    kind: 'meal',
    title: 'Lunch you carried',
    startMinute: start,
    endMinute: end,
    meal: { slot: 'lunch', stopKind: 'packed', venue: null, detourMinutes: 0 },
    note: 'There is nowhere to buy food out here.',
  };
}

/** Parsed on the way out, so a hand-built block cannot enter a fixture unvalidated. */
function block(input: PlanBlockInput): PlanBlock {
  return planBlockSchema.parse(input);
}

const walk = (from: PlaceRef, to: PlaceRef, minutes: number, start: number): PlanBlock =>
  block(walkInput(from, to, minutes, start));
const drive = (from: PlaceRef, to: PlaceRef, minutes: number, start: number): PlanBlock =>
  block(driveInput(from, to, minutes, start));
const unmeasuredDrive = (from: PlaceRef, to: PlaceRef, start: number): PlanBlock =>
  block(unmeasuredDriveInput(from, to, start));
const packedLunch = (start: number, end: number): PlanBlock =>
  block(packedLunchInput(start, end));
const freeTime = (where: PlaceRef, start: number, end: number, note: string): PlanBlock =>
  block(freeTimeInput(where, start, end, note));

/* ------------------------------------------------------------------ *
 * The good plan
 * ------------------------------------------------------------------ */

const DAY_ONE: PlanDayInput = {
  dayNumber: 1,
  date: FIXTURE_DATES[0],
  baseId: 'base-harbour',
  theme: 'The old town on foot',
  blocks: [
    walkInput(HARBOUR, OLD_QUAY, 6, 560),
    {
      kind: 'activity',
      title: 'Old Quay Steps',
      startMinute: 570,
      endMinute: 630,
      place: OLD_QUAY,
      opening: {
        openMinute: 540,
        closeMinute: 1050,
        evidence: { sourceIndex: 0, factPath: 'hours.weekly', statedValue: '09:00-17:30' },
      },
      note: 'Go up before the light gets flat. An hour is plenty.',
      evidence: [{ sourceIndex: 0, factPath: 'hours.weekly', statedValue: '09:00-17:30' }],
    },
    walkInput(OLD_QUAY, MUSEUM, 12, 630),
    {
      kind: 'activity',
      title: 'Lantern Museum',
      startMinute: 645,
      endMinute: 735,
      place: MUSEUM,
      opening: {
        openMinute: 600,
        closeMinute: 1080,
        lastAdmissionMinute: 1035,
        evidence: { sourceIndex: 1, factPath: 'hours.weekly', statedValue: '10:00-18:00' },
      },
      note: 'Small enough to see properly in ninety minutes.',
      evidence: [
        { sourceIndex: 1, factPath: 'hours.weekly', statedValue: '10:00-18:00' },
        { sourceIndex: 1, factPath: 'hours.lastAdmission', statedValue: '17:15' },
      ],
    },
    walkInput(MUSEUM, CANTEEN, 8, 735),
    {
      kind: 'meal',
      title: 'Lunch at the Harbour Canteen',
      startMinute: 750,
      endMinute: 810,
      place: CANTEEN,
      meal: { slot: 'lunch', stopKind: 'venue', venue: CANTEEN, detourMinutes: 5 },
      note: 'Five minutes off the walk between the museum and the garden.',
    },
    walkInput(CANTEEN, TIDAL, 18, 810),
    {
      kind: 'activity',
      title: 'Tidal Garden',
      startMinute: 840,
      endMinute: 915,
      place: TIDAL,
      note: 'Best in the afternoon, when the tide is out far enough to walk the bar.',
    },
    walkInput(TIDAL, HARBOUR, 22, 915),
    freeTimeInput(
      HARBOUR,
      945,
      1080,
      'Deliberately empty. The harbour is a good place to lose track of time.',
    ),
    walkInput(HARBOUR, BLUE_LANTERN, 5, 1130),
    {
      kind: 'meal',
      title: 'Dinner at The Blue Lantern',
      startMinute: 1140,
      endMinute: 1230,
      place: BLUE_LANTERN,
      meal: { slot: 'dinner', stopKind: 'venue', venue: BLUE_LANTERN, detourMinutes: 0 },
      note: 'Five minutes from where you are sleeping.',
    },
    walkInput(BLUE_LANTERN, HARBOUR, 5, 1235),
  ],
  statedTotals: { travelMinutes: 76, driveMinutes: 0, freeMinutes: 135, derived: false },
};

const DAY_TWO: PlanDayInput = {
  dayNumber: 2,
  date: FIXTURE_DATES[1],
  baseId: 'base-harbour',
  theme: 'Up the valley and back',
  blocks: [
    walkInput(HARBOUR, BAKERY, 3, 475),
    {
      kind: 'meal',
      title: 'Breakfast at the Quay Bakery',
      startMinute: 480,
      endMinute: 510,
      place: BAKERY,
      meal: { slot: 'breakfast', stopKind: 'venue', venue: BAKERY, detourMinutes: 0 },
      note: 'Opens early, and it is on the way to the car.',
    },
    driveInput(BAKERY, TARN, 44, 540),
    {
      kind: 'activity',
      title: 'Mirror Tarn',
      startMinute: 585,
      endMinute: 705,
      place: TARN,
      note: 'Two hours is enough for the circuit at a gentle pace.',
      uncertainty: ['Nobody publishes opening times for the car park here.'],
    },
    packedLunchInput(720, 750),
    driveInput(TARN, CABLE, 25, 750),
    {
      kind: 'activity',
      title: 'Wind Ridge Cable Station',
      startMinute: 780,
      endMinute: 870,
      place: CABLE,
      opening: {
        openMinute: 570,
        closeMinute: 960,
        evidence: { sourceIndex: 3, factPath: 'hours.weekly', statedValue: '09:30-16:00' },
      },
      note: 'The last car down is well before closing, so do not leave it late.',
      evidence: [{ sourceIndex: 3, factPath: 'hours.weekly', statedValue: '09:30-16:00' }],
    },
    driveInput(CABLE, HARBOUR, 35, 870),
    freeTimeInput(HARBOUR, 930, 1110, 'Three hours with nothing in them, after a day of driving.'),
    walkInput(HARBOUR, CANTEEN, 4, 1130),
    {
      kind: 'meal',
      title: 'Dinner at the Harbour Canteen',
      startMinute: 1140,
      endMinute: 1230,
      place: CANTEEN,
      meal: { slot: 'dinner', stopKind: 'venue', venue: CANTEEN, detourMinutes: 0 },
      note: 'Nothing to book. Turn up.',
    },
    walkInput(CANTEEN, HARBOUR, 4, 1235),
  ],
  statedTotals: { travelMinutes: 115, driveMinutes: 104, freeMinutes: 180, derived: false },
  alternatives: [
    {
      place: SALTMARSH,
      trigger: 'If the cable station is not running when you get there',
      why: 'Twenty minutes back down the valley, and it does not depend on anybody opening a gate.',
    },
  ],
  warnings: ['The cable station closes for wind, and nobody announces it in advance.'],
};

const DAY_THREE: PlanDayInput = {
  dayNumber: 3,
  date: FIXTURE_DATES[2],
  baseId: 'base-harbour',
  theme: 'A short morning before the road home',
  blocks: [
    walkInput(HARBOUR, BAKERY, 3, 490),
    {
      kind: 'meal',
      title: 'Breakfast at the Quay Bakery',
      startMinute: 495,
      endMinute: 525,
      place: BAKERY,
      meal: { slot: 'breakfast', stopKind: 'venue', venue: BAKERY, detourMinutes: 0 },
      note: 'The same place as yesterday, because it is the good one.',
    },
    walkInput(BAKERY, GULL, 10, 530),
    {
      kind: 'activity',
      title: 'Gull Rock Lookout',
      startMinute: 545,
      endMinute: 590,
      place: GULL,
      note: 'Forty-five minutes, and the last view of the coast you will get.',
    },
    walkInput(GULL, HARBOUR, 9, 590),
    freeTimeInput(HARBOUR, 600, 715, 'Enough time to pack without watching the clock.'),
    walkInput(HARBOUR, CANTEEN, 4, 716),
    {
      kind: 'meal',
      title: 'Lunch before you go',
      startMinute: 720,
      endMinute: 780,
      place: CANTEEN,
      meal: { slot: 'lunch', stopKind: 'venue', venue: CANTEEN, detourMinutes: 0 },
      note: 'Early enough to leave without hurrying.',
    },
    walkInput(CANTEEN, HARBOUR, 4, 785),
    {
      kind: 'transfer',
      title: 'Leave the Kestrel Coast',
      startMinute: 840,
      endMinute: 900,
      note: 'An hour in hand for the departure.',
    },
  ],
  statedTotals: { travelMinutes: 30, driveMinutes: 0, freeMinutes: 115, derived: false },
};

const BASE_PLAN: PlanInput = {
  schemaVersion: BENCHMARK_PLAN_VERSION,
  planId: 'plan-fixture-sidequest',
  requestId: 'req-fixture-kestrel-coast',
  producedBy: 'sidequest',
  generationState: 'complete',
  failureKind: null,
  failureDetail: null,
  summary:
    'Two nights at the harbour: one day on foot in the old town, one day up the valley, and a short morning before you leave.',
  destination: REGION,
  scopeNote:
    'Everything here is within forty-five minutes of the harbour, which is as far as two nights justifies.',
  startDate: FIXTURE_START_DATE,
  endDate: FIXTURE_END_DATE,
  bases: [
    {
      id: 'base-harbour',
      place: HARBOUR,
      nights: 2,
      fromDate: FIXTURE_START_DATE,
      toDate: FIXTURE_END_DATE,
      why: 'One base for two nights. Moving would cost more time than it saved.',
    },
  ],
  days: [DAY_ONE, DAY_TWO, DAY_THREE],
  exclusions: [
    {
      place: HEADLAND,
      reason: 'Three and a half hours of steep walking, which you asked not to be sent on.',
    },
    { place: STORM, reason: 'Two and a half hours of driving each way, for one viewpoint.' },
  ],
  unknowns: [
    'Whether the Tidal Garden has gates at all. No source says either way.',
    'Whether the cable station runs on the Tuesday. The timetable does not break it down by day.',
  ],
  preparation: [
    'Carry lunch for the valley day. There is nowhere to buy any.',
    'Check the cable station is running before you drive up.',
  ],
  warnings: ['The tarn road is shut from November to March, which does not affect these dates.'],
  sources: SOURCES,
};

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

/**
 * A valid, complete plan.
 *
 * Top-level fields replace rather than merge and arrays replace wholesale — the
 * same convention as the rest of the repository's fixture kits. A caller wanting
 * one different block reaches for `editBlock`, which is honest about being
 * surgery.
 */
export function samplePlan(overrides: Partial<BenchmarkPlan> = {}): BenchmarkPlan {
  return benchmarkPlanSchema.parse({ ...BASE_PLAN, ...overrides });
}

/** Re-parse after a change, so no fixture is ever handed out unvalidated. */
function derive(plan: BenchmarkPlan, patch: Partial<BenchmarkPlan>): BenchmarkPlan {
  return benchmarkPlanSchema.parse({ ...plan, ...patch });
}

export function editDay(
  plan: BenchmarkPlan,
  dayNumber: number,
  edit: (day: PlanDay) => PlanDay,
): BenchmarkPlan {
  return derive(plan, {
    days: plan.days.map((day) => (day.dayNumber === dayNumber ? edit(day) : day)),
  });
}

export function editBlock(
  plan: BenchmarkPlan,
  dayNumber: number,
  blockIndex: number,
  edit: (target: PlanBlock) => PlanBlock,
): BenchmarkPlan {
  return editDay(plan, dayNumber, (day) => ({
    ...day,
    blocks: day.blocks.map((target, index) => (index === blockIndex ? edit(target) : target)),
  }));
}

/* ------------------------------------------------------------------ *
 * The neutrality pair
 * ------------------------------------------------------------------ */

export const validSidequestShapedPlan: BenchmarkPlan = samplePlan();

const BASELINE_NAMES: Readonly<Record<string, string>> = {
  'kc-region': 'The Kestrel Coast',
  'kc-harbour-quarter': 'the harbour',
  'kc-old-quay-steps': 'the old quay steps',
  'kc-lantern-museum': 'The Lantern Museum',
  'kc-tidal-garden': 'the tidal garden',
  'kc-gull-rock-lookout': 'Gull Rock',
  'kc-tide-mill': 'the tide mill',
  'kc-mirror-tarn': 'the mirror tarn',
  'kc-cable-station': 'the Wind Ridge cable car',
  'kc-north-headland': 'the north headland',
  'kc-storm-light': 'Storm Light',
  'kc-saltmarsh-hide': 'the saltmarsh hide',
  'kc-quay-bakery': 'the bakery on the quay',
  'kc-harbour-canteen': 'the canteen',
  'kc-blue-lantern': 'Blue Lantern',
};

const BASELINE_NOTES: Readonly<Record<BlockKind, string>> = {
  activity: 'Worth the time, and close to where you already are.',
  travel: 'A short hop. No need to rush it.',
  meal: 'Somewhere to eat that does not drag you off the route.',
  free_time: 'Left open on purpose.',
  rest: 'A gap to sit down in.',
  transfer: 'Leave a margin for this one.',
};

function renameRef(subject: PlaceRef): PlaceRef {
  const renamed = subject.entityId === null ? undefined : BASELINE_NAMES[subject.entityId];
  return {
    entityId: subject.entityId,
    name: renamed ?? subject.name,
    // Dropped rather than copied: an optional field one system fills and the
    // other does not is precisely the asymmetry the fingerprint has to survive.
    latitude: null,
    longitude: null,
  };
}

function renameMaybe(subject: PlaceRef | null): PlaceRef | null {
  return subject === null ? null : renameRef(subject);
}

/**
 * The same plan, told the way the other system tells it.
 *
 * Every rewrite below is deliberate. Nothing here touches a day number, a date,
 * a base, an entity id, a clock time, a travel mode or provenance, a meal slot
 * or stop kind, a claimed opening window, an alternative's position, or the
 * number of uncertainties on a block — because those are the plan, and the
 * fingerprint says so.
 */
function inBaselineIdiom(plan: BenchmarkPlan): BenchmarkPlan {
  return benchmarkPlanSchema.parse({
    ...plan,
    planId: 'plan-fixture-baseline',
    requestId: 'req-fixture-kestrel-coast-baseline',
    producedBy: 'baseline',
    summary: 'A three-day coastal break. Day one in town, day two inland, a slow last morning.',
    scopeNote: 'Kept close to the harbour, since there are only two nights to work with.',
    destination: renameRef(plan.destination),
    bases: plan.bases.map((base) => ({
      ...base,
      place: renameRef(base.place),
      why: 'Staying put. There is no reason to pack twice in two nights.',
    })),
    days: plan.days.map((day) => ({
      ...day,
      theme: `Day ${day.dayNumber}`,
      blocks: day.blocks.map((target) => ({
        ...target,
        title: baselineTitle(target),
        place: renameMaybe(target.place),
        note: BASELINE_NOTES[target.kind],
        // Length preserved, wording not: the fingerprint records whether the
        // plan flagged doubt, and must not care how it phrased it.
        uncertainty: target.uncertainty.map(() => 'Not certain about this one.'),
        evidence: [],
        travel:
          target.travel === null
            ? null
            : {
                ...target.travel,
                from: renameMaybe(target.travel.from),
                to: renameMaybe(target.travel.to),
                km: null,
              },
        meal:
          target.meal === null
            ? null
            : { ...target.meal, venue: renameMaybe(target.meal.venue) },
        opening:
          target.opening === null
            ? null
            : {
                openMinute: target.opening.openMinute,
                closeMinute: target.opening.closeMinute,
                ...(target.opening.lastAdmissionMinute === undefined
                  ? {}
                  : { lastAdmissionMinute: target.opening.lastAdmissionMinute }),
              },
      })),
      statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
      alternatives: day.alternatives.map((alternative) => ({
        place: renameRef(alternative.place),
        trigger: 'If the lift is shut',
        why: 'Closer, and it does not need anybody to open it.',
      })),
      warnings: day.warnings.map(() => 'Conditions can change here at short notice.'),
    })),
    // Reversed, with different reasons. The fingerprint sorts exclusions by id
    // for exactly this: two systems that ruled the same things out have made the
    // same decision whatever order they wrote it in.
    exclusions: [...plan.exclusions].reverse().map((exclusion) => ({
      place: renameRef(exclusion.place),
      reason: 'Too far for a trip this short.',
    })),
    unknowns: plan.unknowns.map((_, index) => `Open question ${index + 1}: not established.`),
    preparation: ['Take food for the inland day.'],
    warnings: [],
    sources: [
      { host: 'coast-guide.invalid', title: 'Kestrel Coast, a guide' },
      { host: 'valley-notes.invalid' },
    ],
  });
}

function baselineTitle(target: PlanBlock): string {
  if (target.travel?.to) return `Get to ${renameRef(target.travel.to).name}`;
  if (target.place) return renameRef(target.place).name;
  return target.title;
}

export const validBaselineShapedPlan: BenchmarkPlan = inBaselineIdiom(validSidequestShapedPlan);

/* ------------------------------------------------------------------ *
 * The mirror pair
 * ------------------------------------------------------------------ */

/**
 * THE SAME QUESTION ASKED THE OTHER WAY ROUND.
 *
 * The pair above varies two things at once — the idiom a plan is written in, and
 * whether it shows its working — and it varies them together, because that is
 * how the two arms actually differ today. Which means a neutrality test resting
 * on it alone can be satisfied by a validator that is biased in the direction
 * the pair happens to point: assert that the plan without citations is the less
 * verifiable one and the assertion passes for the right reason and for the wrong
 * one identically.
 *
 * So the two below cross the variables over. One is the *Sidequest* idiom with
 * the totals, the citations and the source list taken away; the other is the
 * *baseline* idiom with all three put back. Both fingerprint the same as the
 * pair above — none of totals, evidence, sources or coordinates is structure —
 * so any difference in findings between the four is a difference the validators
 * invented.
 *
 * The evidence is copied across block by block rather than written afresh, so
 * the cited plan cites exactly what the original cited and cannot pick up a
 * defect the comparison would then have to explain away.
 */
function withoutShownWorking(plan: BenchmarkPlan, planId: string): BenchmarkPlan {
  return derive(plan, {
    planId,
    days: plan.days.map((day) => ({
      ...day,
      blocks: day.blocks.map((target) => ({
        ...target,
        evidence: [],
        opening:
          target.opening === null
            ? null
            : {
                openMinute: target.opening.openMinute,
                closeMinute: target.opening.closeMinute,
                ...(target.opening.lastAdmissionMinute === undefined
                  ? {}
                  : { lastAdmissionMinute: target.opening.lastAdmissionMinute }),
              },
      })),
      statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
    })),
    sources: [],
  });
}

function withShownWorking(
  plan: BenchmarkPlan,
  donor: BenchmarkPlan,
  planId: string,
): BenchmarkPlan {
  return derive(plan, {
    planId,
    days: plan.days.map((day, dayIndex) => {
      const donorDay = donor.days[dayIndex];
      return {
        ...day,
        blocks: day.blocks.map((target, blockIndex) => {
          const donorBlock = donorDay?.blocks[blockIndex];
          return {
            ...target,
            evidence: donorBlock ? [...donorBlock.evidence] : [],
            opening:
              target.opening === null
                ? null
                : {
                    openMinute: target.opening.openMinute,
                    closeMinute: target.opening.closeMinute,
                    ...(target.opening.lastAdmissionMinute === undefined
                      ? {}
                      : { lastAdmissionMinute: target.opening.lastAdmissionMinute }),
                    ...(donorBlock?.opening?.evidence === undefined
                      ? {}
                      : { evidence: donorBlock.opening.evidence }),
                  },
          };
        }),
        statedTotals: donorDay
          ? { ...donorDay.statedTotals }
          : { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
      };
    }),
    sources: [...donor.sources],
  });
}

/** The Sidequest idiom, stating nothing it does not have to. */
export const plainSidequestIdiomPlan: BenchmarkPlan = withoutShownWorking(
  validSidequestShapedPlan,
  'plan-fixture-sidequest-idiom-plain',
);

/** The baseline idiom, showing every piece of working the other pair's rich half shows. */
export const citedBaselineIdiomPlan: BenchmarkPlan = withShownWorking(
  validBaselineShapedPlan,
  validSidequestShapedPlan,
  'plan-fixture-baseline-idiom-cited',
);

/* ------------------------------------------------------------------ *
 * Incomplete and failed runs
 * ------------------------------------------------------------------ */

/**
 * A partial is a result, not an absence.
 *
 * It keeps the days it managed and names what stopped it, because a benchmark
 * that dropped these rows would report a perfect completion rate for whichever
 * system fell over most often.
 */
export const sidequestPartialPlan: BenchmarkPlan = derive(validSidequestShapedPlan, {
  planId: 'plan-fixture-sidequest-partial',
  generationState: 'partial',
  failureKind: 'insufficient_data',
  failureDetail: 'Nothing usable was established for the last day, so it was left out.',
  days: validSidequestShapedPlan.days.slice(0, 2),
  unknowns: [
    ...validSidequestShapedPlan.unknowns,
    'The whole of the final day. Nothing usable was found in time.',
  ],
});

export const baselinePartialPlan: BenchmarkPlan = derive(validBaselineShapedPlan, {
  planId: 'plan-fixture-baseline-partial',
  generationState: 'partial',
  failureKind: 'timeout',
  failureDetail: 'The run stopped after the first day.',
  days: validBaselineShapedPlan.days.slice(0, 1),
});

export const failedPlan: BenchmarkPlan = derive(validBaselineShapedPlan, {
  planId: 'plan-fixture-failed',
  generationState: 'failed',
  failureKind: 'provider_unavailable',
  failureDetail: 'Nothing could be looked up, so no plan was produced.',
  summary: '',
  bases: [],
  days: [],
  exclusions: [],
  unknowns: [],
  preparation: [],
  warnings: [],
  sources: [],
});

/* ------------------------------------------------------------------ *
 * Single-defect plans
 * ------------------------------------------------------------------ */

/** States an exact opening window that source 0 does not support. */
export const unsupportedExactClaimPlan: BenchmarkPlan = derive(
  editBlock(validSidequestShapedPlan, 1, 1, (target) => ({
    ...target,
    opening: {
      openMinute: 420,
      closeMinute: 1320,
      evidence: { sourceIndex: 0, factPath: 'hours.weekly', statedValue: '07:00-22:00' },
    },
    evidence: [{ sourceIndex: 0, factPath: 'hours.weekly', statedValue: '07:00-22:00' }],
  })),
  { planId: 'plan-fixture-unsupported-claim' },
);

/**
 * Claims twelve minutes for a leg the router measured at twenty-five, and builds
 * the afternoon on the claim.
 *
 * The clock is what makes this decidable. A plan that stated a wrong number and
 * still left an hour for the drive would be sloppy but executable; this one puts
 * the traveller at the cable station twelve minutes after leaving the tarn, and
 * that is a journey nobody can make. The plan's own arithmetic stays consistent
 * throughout, so the only thing wrong with it is that the world disagrees.
 */
export const routeConflictPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 2, (day) => ({
    ...day,
    blocks: [
      ...day.blocks.slice(0, 4),
      drive(TARN, CABLE, 12, 705),
      ...day.blocks.slice(6, 7).map((target) => ({
        ...target,
        startMinute: 718,
        endMinute: 808,
      })),
      packedLunch(820, 850),
      ...day.blocks.slice(7),
    ],
    statedTotals: { travelMinutes: 102, driveMinutes: 91, freeMinutes: 180, derived: false },
  })),
  { planId: 'plan-fixture-route-conflict' },
);

const TIDE_MILL_VISIT: PlanBlockInput = {
  kind: 'activity',
  title: 'Tide Mill',
  place: TIDE_MILL,
  opening: {
    openMinute: 660,
    closeMinute: 1020,
    evidence: { sourceIndex: 4, factPath: 'hours.weekly', statedValue: '11:00-17:00' },
  },
  note: 'Forty-five minutes, and the last thing you will see here.',
  evidence: [{ sourceIndex: 4, factPath: 'hours.weekly', statedValue: '11:00-17:00' }],
};

interface TideMillTimes {
  walkOut: number;
  visitStart: number;
  walkBack: number;
  freeStart: number;
  freeEnd: number;
  lunchWalk: number;
  lunch: number;
  walkHome: number;
  transfer: number;
}

/**
 * The last day, rebuilt around the Tide Mill.
 *
 * One shape and three sets of times, because the three fixtures it produces —
 * the conflict, the successful repair and the failed repair — differ only in
 * when the visit happens. Sharing the structure is what makes the comparison
 * between them about the clock and nothing else.
 *
 * `freeMinutes` is left unstated throughout: these fixtures are about opening
 * hours, and a free-time total that had to be recomputed for each variant would
 * be a second thing to get wrong.
 */
function tideMillDay(day: PlanDay, times: TideMillTimes): PlanDay {
  return {
    ...day,
    blocks: [
      walk(HARBOUR, BAKERY, 3, 460),
      block({
        kind: 'meal',
        title: 'Breakfast at the Quay Bakery',
        startMinute: 465,
        endMinute: 495,
        place: BAKERY,
        meal: { slot: 'breakfast', stopKind: 'venue', venue: BAKERY, detourMinutes: 0 },
        note: 'The same place as yesterday, because it is the good one.',
      }),
      walk(BAKERY, TIDE_MILL, 12, times.walkOut),
      block({ ...TIDE_MILL_VISIT, startMinute: times.visitStart, endMinute: times.visitStart + 45 }),
      walk(TIDE_MILL, HARBOUR, 11, times.walkBack),
      freeTime(HARBOUR, times.freeStart, times.freeEnd, 'Enough time to pack without hurrying.'),
      walk(HARBOUR, CANTEEN, 4, times.lunchWalk),
      block({
        kind: 'meal',
        title: 'Lunch before you go',
        startMinute: times.lunch,
        endMinute: times.lunch + 60,
        place: CANTEEN,
        meal: { slot: 'lunch', stopKind: 'venue', venue: CANTEEN, detourMinutes: 0 },
        note: 'Early enough to leave without hurrying.',
      }),
      walk(CANTEEN, HARBOUR, 4, times.walkHome),
      block({
        kind: 'transfer',
        title: 'Leave the Kestrel Coast',
        startMinute: times.transfer,
        endMinute: times.transfer + 60,
        note: 'An hour in hand for the departure.',
      }),
    ],
    statedTotals: { travelMinutes: 34, driveMinutes: 0, freeMinutes: null, derived: false },
  };
}

/** Arrives at the Tide Mill two hours before it opens, and says so itself. */
export const hoursConflictPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 3, (day) =>
    tideMillDay(day, {
      walkOut: 528,
      visitStart: 540,
      walkBack: 585,
      freeStart: 600,
      freeEnd: 715,
      lunchWalk: 716,
      lunch: 720,
      walkHome: 785,
      transfer: 840,
    }),
  ),
  { planId: 'plan-fixture-hours-conflict' },
);

/** The same day, with the visit moved inside the window. */
export const repairedPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 3, (day) =>
    tideMillDay(day, {
      walkOut: 655,
      visitStart: 675,
      walkBack: 720,
      freeStart: 735,
      freeEnd: 795,
      lunchWalk: 800,
      lunch: 810,
      walkHome: 875,
      transfer: 900,
    }),
  ),
  { planId: 'plan-fixture-repaired' },
);

/** The repair attempted, and the visit still lands before the doors open. */
export const stillFailingPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 3, (day) =>
    tideMillDay(day, {
      walkOut: 585,
      visitStart: 600,
      walkBack: 645,
      freeStart: 660,
      freeEnd: 715,
      lunchWalk: 716,
      lunch: 720,
      walkHome: 785,
      transfer: 840,
    }),
  ),
  { planId: 'plan-fixture-still-failing' },
);

/** Three hundred and twenty-two minutes at the wheel against a stated cap of a hundred and eighty. */
export const excessiveTravelPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 2, (day) => ({
    ...day,
    blocks: [
      ...day.blocks.slice(0, 2),
      drive(BAKERY, STORM, 162, 540),
      packedLunch(705, 725),
      block({
        kind: 'activity',
        title: 'Storm Light Beacon',
        startMinute: 730,
        endMinute: 820,
        place: STORM,
        note: 'Ninety minutes at the far end of the coast road.',
      }),
      drive(STORM, HARBOUR, 160, 830),
      freeTime(HARBOUR, 1000, 1100, 'What is left of the evening.'),
      ...day.blocks.slice(9),
    ],
    statedTotals: { travelMinutes: 333, driveMinutes: 322, freeMinutes: 100, derived: false },
    alternatives: [],
  })),
  {
    planId: 'plan-fixture-excessive-travel',
    // The beacon is scheduled here, so it can no longer be on the excluded list:
    // a plan that both rules a place out and sends you to it has two defects,
    // and this fixture is meant to have one.
    exclusions: validSidequestShapedPlan.exclusions.filter(
      (exclusion) => exclusion.place.entityId !== STORM.entityId,
    ),
  },
);

/**
 * Nine and a half hours in the open with nothing to eat in any of them.
 *
 * The meals are removed along with the legs that only existed to reach them,
 * rather than deleted where they stood — a day whose walk to breakfast survives
 * the breakfast is a broken route as well as a hungry one, and this fixture is
 * meant to be about the food.
 */
export const missingMealPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 2, (day) => ({
    ...day,
    blocks: [
      drive(HARBOUR, TARN, 45, 540),
      ...day.blocks.slice(3, 4),
      ...day.blocks.slice(5, 9),
    ],
    statedTotals: { travelMinutes: 105, driveMinutes: 105, freeMinutes: 180, derived: false },
  })),
  { planId: 'plan-fixture-missing-meal' },
);

/**
 * Sends a traveller who ruled out strenuous activity up the headland.
 *
 * Nothing measured that road, so the travel blocks state no minutes and claim no
 * provenance — which keeps the fixture to one *defect*, with the missing route
 * showing up as the `unknown` it honestly is.
 */
export const ignoredHardAvoidancePlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 2, (day) => ({
    ...day,
    blocks: [
      unmeasuredDrive(HARBOUR, HEADLAND, 540),
      block({
        kind: 'activity',
        title: 'North Headland Path',
        startMinute: 570,
        endMinute: 780,
        place: HEADLAND,
        note: 'Three and a half hours, steep in both directions.',
      }),
      packedLunch(790, 820),
      unmeasuredDrive(HEADLAND, HARBOUR, 830),
      freeTime(HARBOUR, 900, 1080, 'The rest of the evening, and you will want it.'),
    ],
    statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
    alternatives: [],
  })),
  {
    planId: 'plan-fixture-ignored-avoidance',
    // The headland is scheduled here, so it cannot still be on the excluded
    // list. A plan that both rules a place out and sends you to it contradicts
    // itself, which is a different defect from the one this fixture is for.
    exclusions: validSidequestShapedPlan.exclusions.filter(
      (exclusion) => exclusion.place.entityId !== HEADLAND.entityId,
    ),
  },
);

/**
 * A plan whose every check comes back undecided rather than wrong.
 *
 * It names a place the inventory does not hold, states no travel times at all,
 * and rests its one claim on the source that was retrieved and never read. None
 * of that is a defect, and a validator scoring it as one has confused "we could
 * not tell" with "this is broken" — which is the single failure mode the
 * `unknown` severity exists to prevent.
 */
export const unknownEvidencePlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 2, (day) => ({
    ...day,
    blocks: [
      unmeasuredDrive(HARBOUR, FERRYMANS_POINT, 540),
      block({
        kind: 'activity',
        title: "The sea cave at Ferryman's Point",
        startMinute: 600,
        endMinute: 720,
        place: FERRYMANS_POINT,
        opening: {
          openMinute: 600,
          closeMinute: 1020,
          evidence: { sourceIndex: 2, factPath: 'hours.weekly', statedValue: '10:00-17:00' },
        },
        note: 'Local knowledge rather than anything published.',
        uncertainty: ['We could not confirm this is open to the public.'],
        evidence: [{ sourceIndex: 2, factPath: 'hours.weekly', statedValue: '10:00-17:00' }],
      }),
      packedLunch(730, 760),
      unmeasuredDrive(FERRYMANS_POINT, HARBOUR, 770),
      freeTime(HARBOUR, 850, 1030, 'Back early, with the evening free.'),
    ],
    statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
  })),
  { planId: 'plan-fixture-unknown-evidence' },
);

/** A day of the trip with nothing in it at all. */
export const emptyDayPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 3, (day) => ({
    ...day,
    blocks: [],
    statedTotals: { travelMinutes: 0, driveMinutes: 0, freeMinutes: 0, derived: false },
  })),
  { planId: 'plan-fixture-empty-day' },
);

/** The museum, twice, on two different days. */
export const duplicatePlacePlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 3, (day) => ({
    ...day,
    blocks: [
      ...day.blocks.slice(0, 2),
      walk(BAKERY, MUSEUM, 16, 580),
      block({
        kind: 'activity',
        title: 'Lantern Museum',
        startMinute: 600,
        endMinute: 645,
        place: MUSEUM,
        opening: {
          openMinute: 600,
          closeMinute: 1080,
          lastAdmissionMinute: 1035,
          evidence: { sourceIndex: 1, factPath: 'hours.weekly', statedValue: '10:00-18:00' },
        },
        note: 'Back for the rooms you did not get to on the first day.',
        evidence: [{ sourceIndex: 1, factPath: 'hours.weekly', statedValue: '10:00-18:00' }],
      }),
      walk(MUSEUM, HARBOUR, 15, 645),
      freeTime(HARBOUR, 665, 715, 'A short gap before lunch.'),
      ...day.blocks.slice(6),
    ],
    statedTotals: { travelMinutes: 42, driveMinutes: 0, freeMinutes: 50, derived: false },
  })),
  { planId: 'plan-fixture-duplicate-place' },
);

/** Says the first day held fifteen minutes of travel. Its own blocks say seventy-one. */
export const contradictoryTotalsPlan: BenchmarkPlan = derive(
  editDay(validSidequestShapedPlan, 1, (day) => ({
    ...day,
    statedTotals: { travelMinutes: 15, driveMinutes: 0, freeMinutes: 135, derived: false },
  })),
  { planId: 'plan-fixture-contradictory-totals' },
);

/** Every fixture plan, so a test can sweep them without listing them twice. */
export const ALL_FIXTURE_PLANS: readonly BenchmarkPlan[] = [
  validSidequestShapedPlan,
  validBaselineShapedPlan,
  plainSidequestIdiomPlan,
  citedBaselineIdiomPlan,
  repairedPlan,
  stillFailingPlan,
  sidequestPartialPlan,
  baselinePartialPlan,
  failedPlan,
  unsupportedExactClaimPlan,
  routeConflictPlan,
  hoursConflictPlan,
  excessiveTravelPlan,
  missingMealPlan,
  ignoredHardAvoidancePlan,
  unknownEvidencePlan,
  emptyDayPlan,
  duplicatePlacePlan,
  contradictoryTotalsPlan,
];
