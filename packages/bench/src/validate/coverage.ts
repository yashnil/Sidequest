import type { BenchmarkGroundTruth } from '../ground-truth';
import { type BenchFinding } from '../schemas/finding';
import { type BenchmarkPlan, type PlanDay } from '../schemas/plan';
import {
  activityBlocks,
  clockLabel,
  dayLabel,
  minutesFromClock,
  report,
  safeArray,
  subjectOf,
  timesOf,
  unresolved,
  type CheckContext,
} from './context';

/**
 * Does the plan cover the trip it says it covers?
 *
 * The cheapest defects to find and the most expensive to discover on the ground.
 * A missing date is critical rather than major because a traveller standing in a
 * town on a day the plan skipped has no plan at all, and no amount of quality in
 * the other days compensates. None of these checks needs any world data, so all
 * of them are always decidable — which is deliberate: it means a plan cannot
 * lower its defect count by stating less.
 */

/** A day the plan itself declares to be a day off, in its own words. */
export const REST_DAY_PATTERN =
  /\b(rest day|rest|recovery|downtime|down day|free day|day off|nothing planned|unstructured)\b/i;

export function checkCoverage(
  plan: BenchmarkPlan,
  _truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const days = safeArray(plan.days);
  const expected = ctx.tripDates;

  findings.push(...checkDateCoverage(plan, ctx, days, expected));
  findings.push(...checkEdgeDays(ctx, days, expected));
  findings.push(...checkEmptyDays(ctx, days, expected));
  findings.push(...checkEmptyPlan(plan, ctx, days));

  return findings;
}

function checkDateCoverage(
  plan: BenchmarkPlan,
  ctx: CheckContext,
  days: readonly PlanDay[],
  expected: readonly string[],
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  // A plan whose own start and end cannot be read as dates has broken the one
  // thing every other coverage check is measured against, so the range is
  // reported as undecidable rather than silently treated as empty.
  if (expected.length === 0) {
    ctx.undecided();
    findings.push(
      unresolved(
        'date_missing_from_plan',
        {},
        'The plan does not state a readable date range, so its coverage cannot be checked.',
        'plan.startDate/plan.endDate',
        'plan_omits_field',
        { observed: { startDate: String(plan.startDate ?? ''), endDate: String(plan.endDate ?? '') } },
      ),
    );
    return findings;
  }

  const covered = new Set(days.map((day) => String(day.date ?? '')));
  for (const date of expected) {
    ctx.decided();
    if (covered.has(date)) continue;
    findings.push(
      report(
        'date_missing_from_plan',
        'critical',
        { date },
        `The trip runs over ${date} and the plan has no day for it.`,
        'plan.days',
        { observed: { date }, expected: { covered: true } },
      ),
    );
  }

  const inRange = new Set(expected);
  const seen = new Set<string>();
  for (const day of days) {
    const date = String(day.date ?? '');

    ctx.decided();
    if (!inRange.has(date)) {
      findings.push(
        report(
          'date_outside_range',
          'critical',
          subjectOf(day),
          `${dayLabel(day)} is dated ${date || 'nothing readable'}, outside the trip's ${expected[0]} to ${expected[expected.length - 1]}.`,
          'plan.days',
          {
            observed: { date },
            expected: { from: expected[0] ?? null, to: expected[expected.length - 1] ?? null },
          },
        ),
      );
    }

    ctx.decided();
    if (seen.has(date)) {
      findings.push(
        report(
          'duplicate_date',
          'critical',
          subjectOf(day),
          `${dayLabel(day)} repeats ${date}, which another day already covers.`,
          'plan.days',
          { observed: { date } },
        ),
      );
    }
    seen.add(date);
  }

  return findings;
}

/**
 * The two edges, against the times the traveller actually gave.
 *
 * Only `exact` counts. A traveller who said "some time in the afternoon" has not
 * set a boundary a plan can violate, and inventing one — treating "afternoon" as
 * a hard 12:00 — would score a plan against a constraint nobody stated.
 */
function checkEdgeDays(
  ctx: CheckContext,
  days: readonly PlanDay[],
  expected: readonly string[],
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const request = ctx.request;

  const firstDate = expected[0];
  const lastDate = expected[expected.length - 1];
  const arrivalDay = firstDate === undefined ? undefined : days.find((day) => day.date === firstDate);
  const departureDay = lastDate === undefined ? undefined : days.find((day) => day.date === lastDate);

  const arrivalMinute =
    request?.arrival?.precision === 'exact' ? minutesFromClock(request.arrival.time) : null;
  const departureMinute =
    request?.departure?.precision === 'exact' ? minutesFromClock(request.departure.time) : null;

  findings.push(
    ...edgeFinding({
      ctx,
      code: 'arrival_day_starts_too_early',
      day: arrivalDay,
      limit: arrivalMinute,
      groundTruth: 'request.arrival',
      evaluate: (day) => {
        const starts = timedStarts(day);
        if (starts.length === 0) return null;
        const earliest = Math.min(...starts);
        return earliest < (arrivalMinute ?? 0)
          ? {
              message: `${dayLabel(day)} begins at ${clockLabel(earliest)}, before the ${clockLabel(arrivalMinute ?? 0)} arrival the traveller gave.`,
              observed: { earliestStart: earliest },
              expected: { notBefore: arrivalMinute ?? 0 },
            }
          : null;
      },
    }),
  );

  findings.push(
    ...edgeFinding({
      ctx,
      code: 'departure_day_ends_too_late',
      day: departureDay,
      limit: departureMinute,
      groundTruth: 'request.departure',
      evaluate: (day) => {
        const ends = timedEnds(day);
        if (ends.length === 0) return null;
        const latest = Math.max(...ends);
        return latest > (departureMinute ?? 0)
          ? {
              message: `${dayLabel(day)} runs until ${clockLabel(latest)}, past the ${clockLabel(departureMinute ?? 0)} departure the traveller gave.`,
              observed: { latestEnd: latest },
              expected: { notAfter: departureMinute ?? 0 },
            }
          : null;
      },
    }),
  );

  return findings;
}

interface EdgeInput {
  ctx: CheckContext;
  code: 'arrival_day_starts_too_early' | 'departure_day_ends_too_late';
  day: PlanDay | undefined;
  limit: number | null;
  groundTruth: string;
  evaluate: (day: PlanDay) => {
    message: string;
    observed: Record<string, number>;
    expected: Record<string, number>;
  } | null;
}

function edgeFinding(input: EdgeInput): BenchFinding[] {
  const { ctx, code, day, limit, groundTruth, evaluate } = input;

  if (limit === null) {
    ctx.undecided();
    return [
      unresolved(
        code,
        subjectOf(day ?? null),
        'The traveller did not give an exact time for this edge of the trip, so nothing bounds it.',
        groundTruth,
        'request_omits_constraint',
      ),
    ];
  }
  if (!day) {
    ctx.undecided();
    return [
      unresolved(
        code,
        {},
        'The plan has no day at this edge of the trip to check the stated time against.',
        'plan.days',
        'plan_omits_field',
      ),
    ];
  }

  const timedBlocks = safeArray(day.blocks).filter((block) => timesOf(block) !== null);
  if (timedBlocks.length === 0) {
    ctx.undecided();
    return [
      unresolved(
        code,
        subjectOf(day),
        `${dayLabel(day)} puts no clock times on anything, so it cannot be compared with the stated time.`,
        'plan.days[].blocks[].startMinute',
        'plan_omits_field',
      ),
    ];
  }

  ctx.decided();
  const breach = evaluate(day);
  if (!breach) return [];
  return [
    report(code, 'major', subjectOf(day), breach.message, groundTruth, {
      observed: breach.observed,
      expected: breach.expected,
    }),
  ];
}

function timedStarts(day: PlanDay): number[] {
  return safeArray(day.blocks)
    .map((block) => timesOf(block)?.start)
    .filter((value): value is number => typeof value === 'number');
}

function timedEnds(day: PlanDay): number[] {
  return safeArray(day.blocks)
    .map((block) => timesOf(block)?.end)
    .filter((value): value is number => typeof value === 'number');
}

/**
 * A day inside the trip with nothing to do on it.
 *
 * Major, not critical: the traveller can still stand somewhere, and a plan that
 * leaves a gap has failed to help rather than asserted something impossible. It
 * drops to informational when the plan *said* it was a rest day and the
 * traveller asked for lots of free time — that is the plan doing what it was
 * told, and grading it as a defect would punish the only system that listened.
 */
function checkEmptyDays(
  ctx: CheckContext,
  days: readonly PlanDay[],
  expected: readonly string[],
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const inRange = new Set(expected);
  const wantsSpace = ctx.request?.rhythm?.freeTime === 'lots';

  for (const day of days) {
    if (!inRange.has(String(day.date ?? ''))) continue;
    ctx.decided();
    if (activityBlocks(day).length > 0) continue;

    const declared = declaresRest(day);
    findings.push(
      report(
        'empty_day',
        declared && wantsSpace ? 'informational' : 'major',
        subjectOf(day),
        declared && wantsSpace
          ? `${dayLabel(day)} is left open on purpose, which is the space the traveller asked for.`
          : `${dayLabel(day)} falls inside the trip and has nothing scheduled on it.`,
        'plan.days[].blocks',
        { observed: { activityBlocks: 0, declaredRestDay: declared, freeTimeAppetite: ctx.request?.rhythm?.freeTime ?? null } },
      ),
    );
  }

  return findings;
}

/**
 * Whether the plan said, in the field meant for saying it, that this is a day
 * off.
 *
 * The theme only. Reading the warnings as well would let a plan earn the softer
 * grade because one of up to twenty cautions happened to contain the word
 * "rest" — and one converter fills that array from three separate sources while
 * the other rarely fills it at all, so the softer grade would go to whichever
 * system writes more cautions rather than to whichever meant it.
 */
function declaresRest(day: PlanDay): boolean {
  return REST_DAY_PATTERN.test(String(day.theme ?? ''));
}

/**
 * A run that says it finished and scheduled nothing at all.
 *
 * Critical, and separate from `empty_day`, because it is the failure mode a
 * benchmark most needs to catch: a system that returns dated days with nothing
 * on them and calls it a success would otherwise score as a plan with no
 * defects. A run that admits it was `partial` or `failed` has already told the
 * truth and is not charged twice for it.
 */
function checkEmptyPlan(
  plan: BenchmarkPlan,
  ctx: CheckContext,
  days: readonly PlanDay[],
): BenchFinding[] {
  ctx.decided();
  if (plan.generationState !== 'complete') return [];
  const scheduled = days.reduce((total, day) => total + activityBlocks(day).length, 0);
  if (scheduled > 0) return [];
  return [
    report(
      'empty_successful_plan',
      'critical',
      {},
      'The plan reports itself complete and has not scheduled a single activity.',
      'plan.generationState',
      { observed: { generationState: plan.generationState, activityBlocks: 0 } },
    ),
  ];
}
