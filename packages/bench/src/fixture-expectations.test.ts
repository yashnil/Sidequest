import { describe, expect, it } from 'vitest';
import { runNeutralValidation } from './validate';
import { defectCount } from './schemas/finding';
import { planFingerprint } from './fingerprint';
import {
  citedBaselineIdiomPlan,
  contradictoryTotalsPlan,
  duplicatePlacePlan,
  emptyDayPlan,
  excessiveTravelPlan,
  fakeGroundTruth,
  hoursConflictPlan,
  ignoredHardAvoidancePlan,
  missingMealPlan,
  plainSidequestIdiomPlan,
  repairedPlan,
  routeConflictPlan,
  stillFailingPlan,
  unknownEvidencePlan,
  unsupportedExactClaimPlan,
  validBaselineShapedPlan,
  validSidequestShapedPlan,
} from './testing';
import type { BenchmarkPlan, PlanBlock, PlanDay } from './schemas/plan';
import { benchmarkPlanSchema } from './schemas/plan';

/**
 * WHAT EACH FIXTURE IS *FOR*, PINNED WHERE BOTH HALVES CAN SEE IT.
 *
 * The validators and the fixture library were built separately and against each
 * other: a plan named `missingMealPlan` is only useful while it is a plan whose
 * single defect is a missing meal. Nothing structural keeps that true. A
 * threshold moves, a check gets stricter, and `missingMealPlan` quietly starts
 * carrying four defects — at which point every test that used it as a
 * single-defect fixture is still green and is no longer testing what it says.
 *
 * So the mapping is a test rather than a shared understanding, and it lives here
 * rather than inside either half, because it is the seam between them.
 *
 * The two entries with no defects at all are the load-bearing ones. A validator
 * that found nothing wrong with a plan built to be correct is the only evidence
 * that the other rows are catching something real rather than firing at
 * everything.
 */

const truth = fakeGroundTruth();

/** Codes a fixture is built to trip, at critical or major. */
const EXPECTED: readonly { name: string; plan: BenchmarkPlan; defects: readonly string[] }[] = [
  { name: 'validSidequestShapedPlan', plan: validSidequestShapedPlan, defects: [] },
  { name: 'validBaselineShapedPlan', plan: validBaselineShapedPlan, defects: [] },
  { name: 'plainSidequestIdiomPlan', plan: plainSidequestIdiomPlan, defects: [] },
  { name: 'citedBaselineIdiomPlan', plan: citedBaselineIdiomPlan, defects: [] },
  { name: 'repairedPlan', plan: repairedPlan, defects: [] },
  { name: 'unknownEvidencePlan', plan: unknownEvidencePlan, defects: [] },
  { name: 'stillFailingPlan', plan: stillFailingPlan, defects: ['arrives_before_opening'] },
  { name: 'hoursConflictPlan', plan: hoursConflictPlan, defects: ['arrives_before_opening'] },
  { name: 'routeConflictPlan', plan: routeConflictPlan, defects: ['impossible_jump'] },
  {
    name: 'unsupportedExactClaimPlan',
    plan: unsupportedExactClaimPlan,
    defects: ['unsupported_factual_claim'],
  },
  {
    name: 'excessiveTravelPlan',
    plan: excessiveTravelPlan,
    defects: ['daily_drive_exceeded', 'daily_travel_exceeded'],
  },
  { name: 'missingMealPlan', plan: missingMealPlan, defects: ['long_day_without_food'] },
  {
    name: 'ignoredHardAvoidancePlan',
    plan: ignoredHardAvoidancePlan,
    defects: ['hard_avoidance_violated'],
  },
  { name: 'emptyDayPlan', plan: emptyDayPlan, defects: ['empty_day'] },
  { name: 'duplicatePlacePlan', plan: duplicatePlacePlan, defects: ['duplicate_place'] },
  {
    name: 'contradictoryTotalsPlan',
    plan: contradictoryTotalsPlan,
    defects: ['stated_totals_contradict_timeline'],
  },
];

function defectCodes(plan: BenchmarkPlan): string[] {
  return [
    ...new Set(
      runNeutralValidation(plan, truth)
        .findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
        .map((finding) => finding.code),
    ),
  ].sort();
}

describe('each fixture trips exactly the checks it was built to trip', () => {
  it.each(EXPECTED)('$name', ({ plan, defects }) => {
    expect(defectCodes(plan)).toEqual([...defects].sort());
  });

  it('finds nothing wrong with either well-formed plan, which is what makes the rest mean anything', () => {
    for (const plan of [validSidequestShapedPlan, validBaselineShapedPlan, repairedPlan]) {
      const report = runNeutralValidation(plan, truth);
      expect(defectCount(report.counts)).toBe(0);
    }
  });
});

/**
 * How far two structurally identical plans may drift in verifiability.
 *
 * Not zero, because the checks legitimately read evidence: a plan that quotes a
 * source gives `supportsClaim` something to answer and a plan that quotes
 * nothing does not, so the two have a different number of decidable questions in
 * front of them and forcing the counts to match would mean deleting the
 * unsupported-claim check. But small, because the *ratio* is what the results
 * view reports, and a validator whose decided share swung with how a plan words
 * itself would be reporting its own preferences. Five points of the ratio is
 * roughly twice the drift the fixtures actually show, which leaves room for a
 * check to be added without this becoming a tripwire on unrelated work.
 */
const VERIFIABILITY_EPSILON = 0.05;

function defectSignature(report: ReturnType<typeof runNeutralValidation>): string[] {
  return report.findings
    .filter((finding) => finding.severity !== 'unknown' && finding.severity !== 'informational')
    .map((finding) => `${finding.severity}:${finding.code}`)
    .sort();
}

function verifiabilityRatio(report: ReturnType<typeof runNeutralValidation>): number {
  return report.verifiability.attempted === 0
    ? 1
    : report.verifiability.decided / report.verifiability.attempted;
}

/**
 * FOUR PLANS, ONE TRIP, TWO IDIOMS CROSSED WITH TWO HABITS.
 *
 * Every one of these sends the traveller to the same places at the same times by
 * the same means, and `planFingerprint` says so. They differ in the idiom they
 * are written in — names, prose, array order — and in whether they show their
 * working: stated totals, citations, a source list.
 *
 * The crossing is the point. An earlier version of this file tested one pair, in
 * which the Sidequest idiom was also the one that showed its working, and
 * asserted that the baseline-idiom plan came back the *less* verifiable of the
 * two. That is not a neutrality assertion. It pins the expected outcome to the
 * arm rather than to the habit, and it passes identically whether the validators
 * are reading evidence or reading provenance.
 *
 * So the pairs below are matched on habit and crossed on idiom, and the mirror
 * pair carries the asymmetry in the opposite direction. A validator that had
 * learned to favour the Sidequest shape would fail on the mirror.
 */
const FINGERPRINT_EQUAL_PAIRS: readonly {
  name: string;
  left: { name: string; plan: BenchmarkPlan };
  right: { name: string; plan: BenchmarkPlan };
}[] = [
  {
    name: 'both showing their working',
    left: { name: 'the Sidequest idiom', plan: validSidequestShapedPlan },
    right: { name: 'the baseline idiom', plan: citedBaselineIdiomPlan },
  },
  {
    name: 'neither showing their working',
    left: { name: 'the Sidequest idiom', plan: plainSidequestIdiomPlan },
    right: { name: 'the baseline idiom', plan: validBaselineShapedPlan },
  },
  {
    name: 'the mirror: the Sidequest idiom is the terser one',
    left: { name: 'the Sidequest idiom, plain', plan: plainSidequestIdiomPlan },
    right: { name: 'the baseline idiom, cited', plan: citedBaselineIdiomPlan },
  },
];

describe('the neutrality set', () => {
  it('is one trip told four ways', () => {
    const fingerprints = new Set(
      [
        validSidequestShapedPlan,
        validBaselineShapedPlan,
        plainSidequestIdiomPlan,
        citedBaselineIdiomPlan,
      ].map(planFingerprint),
    );
    expect(fingerprints.size).toBe(1);
    expect(validSidequestShapedPlan.summary).not.toBe(validBaselineShapedPlan.summary);
  });

  it.each(FINGERPRINT_EQUAL_PAIRS)('$name: draws exactly the same defects', ({ left, right }) => {
    /*
     * The defect findings must match exactly. If they ever diverge, the
     * validators are grading something other than the trip — prose, id style,
     * array order, whether a source list was attached — and every comparison the
     * benchmark has produced is measuring that instead.
     */
    const a = runNeutralValidation(left.plan, truth);
    const b = runNeutralValidation(right.plan, truth);

    expect(defectSignature(b), `${right.name} against ${left.name}`).toEqual(defectSignature(a));
    expect(b.counts.critical).toBe(a.counts.critical);
    expect(b.counts.major).toBe(a.counts.major);
    expect(b.counts.minor).toBe(a.counts.minor);
    expect(defectCount(b.counts)).toBe(defectCount(a.counts));
  });

  it.each(FINGERPRINT_EQUAL_PAIRS)(
    '$name: differs in verifiability by no more than a rounding',
    ({ left, right }) => {
      const a = runNeutralValidation(left.plan, truth);
      const b = runNeutralValidation(right.plan, truth);
      expect(
        Math.abs(verifiabilityRatio(b) - verifiabilityRatio(a)),
        `${right.name} against ${left.name}`,
      ).toBeLessThanOrEqual(VERIFIABILITY_EPSILON);
    },
  );

  it('carries its verifiability gap on the habit rather than on the idiom', () => {
    /*
     * THE ASSERTION THE OLD ONE SHOULD HAVE BEEN.
     *
     * Showing your working is what makes a plan more checkable, and the idiom it
     * is written in is not. So the two plans that cite must be equally decidable
     * as each other, the two that do not must be equally decidable as each other,
     * and — this is the half that cannot be got right by accident — the plain
     * plan in the *Sidequest* idiom must land exactly where the plain plan in the
     * baseline idiom does, not somewhere better.
     */
    const richSidequest = runNeutralValidation(validSidequestShapedPlan, truth);
    const richBaseline = runNeutralValidation(citedBaselineIdiomPlan, truth);
    const plainSidequest = runNeutralValidation(plainSidequestIdiomPlan, truth);
    const plainBaseline = runNeutralValidation(validBaselineShapedPlan, truth);

    expect(richBaseline.verifiability).toEqual(richSidequest.verifiability);
    expect(plainSidequest.verifiability).toEqual(plainBaseline.verifiability);
    expect(plainSidequest.counts.unknown).toBeGreaterThan(richSidequest.counts.unknown);
    expect(plainSidequest.verifiability.decided).toBeLessThan(richSidequest.verifiability.decided);
  });

  it('says why, every time it could not decide something', () => {
    for (const plan of [
      validSidequestShapedPlan,
      validBaselineShapedPlan,
      plainSidequestIdiomPlan,
      citedBaselineIdiomPlan,
    ]) {
      const report = runNeutralValidation(plan, truth);
      for (const finding of report.findings.filter((entry) => entry.severity === 'unknown')) {
        expect(
          finding.unknownReason,
          `${finding.code} is unknown for no stated reason`,
        ).toBeDefined();
      }
    }
  });

  it('scores identically when the producing system is swapped', () => {
    // A cheap, total check for an accidental branch on provenance. There should
    // be no code path that can read `producedBy`, and this is what says so.
    const swapped = runNeutralValidation(
      { ...validSidequestShapedPlan, producedBy: 'baseline' },
      truth,
    );
    const original = runNeutralValidation(validSidequestShapedPlan, truth);
    expect(swapped.findings).toEqual(original.findings);
  });
});

/* ------------------------------------------------------------------ *
 * Optional fields must not decide what is checkable
 * ------------------------------------------------------------------ */

/**
 * THE FIELDS ONE CONVERTER FILLS AND THE OTHER DOES NOT.
 *
 * Each of these is optional in the neutral plan schema, and each is populated by
 * one arm's converter as a matter of course and by the other's rarely or never:
 * the deterministic pipeline states day totals on every day and a duration on
 * every leg whatever its provenance, and hard-codes a meal venue's identity to
 * null; the baseline states no totals, drops the duration on any leg nobody
 * measured, and resolves its venues to real inventory entries.
 *
 * A check that could only run when its field was present was therefore a check
 * one arm could never fail — not because its plans were better, but because its
 * converter was quieter. The sweep below removes each field from every fixture
 * and requires that a defect the fixture was built to trip either still trips,
 * or comes back as an explicit `unknown` naming the missing field. What must not
 * happen is the third thing: the check going silent.
 */
const ONE_SIDED_FIELDS: readonly { name: string; strip: (plan: BenchmarkPlan) => BenchmarkPlan }[] = [
  {
    name: 'stated day totals',
    strip: (plan) =>
      mapDays(plan, (day) => ({
        ...day,
        statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
      })),
  },
  {
    name: 'stated leg durations',
    strip: (plan) =>
      mapBlocks(plan, (block) => ({
        ...block,
        travel: block.travel === null ? null : { ...block.travel, minutes: null, km: null },
      })),
  },
  {
    name: 'the meal venue reference',
    strip: (plan) =>
      mapBlocks(plan, (block) => ({
        ...block,
        meal: block.meal === null ? null : { ...block.meal, venue: null },
      })),
  },
  {
    name: 'the stated meal detour',
    strip: (plan) =>
      mapBlocks(plan, (block) => ({
        ...block,
        meal: block.meal === null ? null : { ...block.meal, detourMinutes: null },
      })),
  },
  {
    name: 'coordinates on every place reference',
    strip: (plan) => mapBlocks(plan, (block) => ({ ...block, place: withoutCoordinates(block.place) })),
  },
];

function mapDays(plan: BenchmarkPlan, edit: (day: PlanDay) => PlanDay): BenchmarkPlan {
  return benchmarkPlanSchema.parse({ ...plan, days: plan.days.map(edit) });
}

function mapBlocks(plan: BenchmarkPlan, edit: (block: PlanBlock) => PlanBlock): BenchmarkPlan {
  return mapDays(plan, (day) => ({ ...day, blocks: day.blocks.map(edit) }));
}

function withoutCoordinates(place: PlanBlock['place']): PlanBlock['place'] {
  return place === null ? null : { ...place, latitude: null, longitude: null };
}

function codesPresent(report: ReturnType<typeof runNeutralValidation>): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

describe('no check is silenced by an optional field going missing', () => {
  const fixtures = EXPECTED.filter((entry) => entry.defects.length > 0);

  for (const field of ONE_SIDED_FIELDS) {
    it.each(fixtures)(`${field.name}: $name keeps its checks`, ({ plan, defects }) => {
      const stripped = runNeutralValidation(field.strip(plan), truth);
      const found = new Set(defectCodes(field.strip(plan)));
      const present = codesPresent(stripped);

      for (const code of defects) {
        // Either the check still convicts the plan, or it says out loud that it
        // no longer can. Vanishing without a word is the failure this is for.
        expect(
          found.has(code) || present.has(code),
          `${code} disappeared when ${field.name} was removed`,
        ).toBe(true);
      }
    });
  }

  it('still totals the travel budgets when no leg states its duration', () => {
    /*
     * The concrete case, pinned separately because it is the one that decided
     * whole sessions: the traveller's daily caps used to be checkable only
     * against `travel.minutes`, so an arm that omits that field on unmeasured
     * legs was structurally incapable of exceeding a cap it had exceeded.
     */
    const field = ONE_SIDED_FIELDS.find((entry) => entry.name === 'stated leg durations')!;
    const stripped = defectCodes(field.strip(excessiveTravelPlan));
    expect(stripped).toContain('daily_travel_exceeded');
    expect(stripped).toContain('daily_drive_exceeded');
  });

  it('still reads a meal venue the plan named on the block instead', () => {
    // The mirror of the same problem in the food checks: one converter puts the
    // restaurant's identity in `meal.venue` and the other on the block itself,
    // and either is the plan naming the restaurant.
    const field = ONE_SIDED_FIELDS.find((entry) => entry.name === 'the meal venue reference')!;
    const stripped = runNeutralValidation(field.strip(validSidequestShapedPlan), truth);
    const undecided = stripped.findings.filter(
      (finding) => finding.code === 'meal_venue_closed' && finding.severity === 'unknown',
    );
    const withVenue = runNeutralValidation(validSidequestShapedPlan, truth).findings.filter(
      (finding) => finding.code === 'meal_venue_closed' && finding.severity === 'unknown',
    );
    expect(undecided.length).toBe(withVenue.length);
  });
});

describe('a plan that states nothing', () => {
  it('collects no defects and very little verifiability', () => {
    /*
     * The incentive this benchmark most needs to avoid creating: if silence
     * scored well, the cheapest way to win would be to say nothing useful. The
     * defect count and the verifiability ratio are therefore always reported
     * together, and this asserts the second actually moves.
     */
    const silent = runNeutralValidation(unknownEvidencePlan, truth);
    const stated = runNeutralValidation(validSidequestShapedPlan, truth);

    expect(defectCount(silent.counts)).toBe(0);
    expect(silent.counts.unknown).toBeGreaterThan(stated.counts.unknown);
    const silentRatio = silent.verifiability.decided / silent.verifiability.attempted;
    const statedRatio = stated.verifiability.decided / stated.verifiability.attempted;
    expect(silentRatio).toBeLessThan(statedRatio);
  });
});
