import { NEUTRAL_THRESHOLDS, type BenchmarkGroundTruth } from '../ground-truth';
import { type BenchFinding } from '../schemas/finding';
import { type BenchmarkPlan, type PlanDay } from '../schemas/plan';
import { REST_DAY_PATTERN } from './coverage';
import {
  blockMinutes,
  committedMinutes,
  dayLabel,
  daySpan,
  entityIdOf,
  isActivity,
  report,
  safeArray,
  subjectOf,
  travelBlocks,
  travelMinutesOf,
  unresolved,
  type CheckContext,
} from './context';

/**
 * Does the plan agree with itself?
 *
 * The one family of defect that needs no world data at all, which makes it the
 * fairest thing in the benchmark: a plan whose stated totals do not match its
 * own timeline has contradicted itself in a way that is checkable from the
 * document alone, and no amount of missing ground truth can excuse it.
 *
 * That is also why it is critical. A traveller reads "two hours of driving
 * today" and plans the afternoon around it; a stated total that is not the sum
 * of the legs beneath it is worse than no total, because it survives being
 * checked casually.
 */

export function checkIntegrity(
  plan: BenchmarkPlan,
  _truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  findings.push(...checkDuplicatePlaces(plan, ctx));
  findings.push(...checkExcludedYetScheduled(plan, ctx));
  for (const day of safeArray(plan.days)) {
    findings.push(...checkStatedTotals(day, ctx));
    findings.push(...checkRestDayLoad(day, ctx));
  }

  return findings;
}

/**
 * The same place twice on different days.
 *
 * Major rather than critical: it is executable, and a traveller might genuinely
 * return somewhere. It is flagged because the far more common cause is a plan
 * that lost track of what it had already used, and the second visit has
 * displaced somewhere new.
 */
function checkDuplicatePlaces(plan: BenchmarkPlan, ctx: CheckContext): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const firstSeen = new Map<string, PlanDay>();

  for (const day of safeArray(plan.days)) {
    const onThisDay = new Set<string>();
    safeArray(day.blocks).forEach((block, index) => {
      if (!isActivity(block)) return;
      const entityId = entityIdOf(block);
      if (entityId === null) {
        ctx.undecided();
        findings.push(
          unresolved(
            'duplicate_place',
            subjectOf(day, { blockIndex: index }),
            'This stop carries no shared identity, so it cannot be compared with the rest of the trip.',
            'plan.days[].blocks[].place.entityId',
            'subject_not_in_inventory',
          ),
        );
        return;
      }

      ctx.decided();
      const earlier = firstSeen.get(entityId);
      // A place visited twice within one day is one stop split in two, which is
      // a different thing from the trip forgetting it had been there.
      if (earlier && earlier !== day && !onThisDay.has(entityId)) {
        findings.push(
          report(
            'duplicate_place',
            'major',
            subjectOf(day, { blockIndex: index, entityId }),
            `${block.place?.name ?? block.title} is scheduled on ${dayLabel(earlier)} and again on ${dayLabel(day)}.`,
            'plan.days[].blocks[].place.entityId',
            { observed: { firstDate: String(earlier.date ?? ''), secondDate: String(day.date ?? '') } },
          ),
        );
      }
      onThisDay.add(entityId);
      if (!earlier) firstSeen.set(entityId, day);
    });
  }

  return findings;
}

/**
 * A place the plan both schedules and says it left out.
 *
 * Checked over the whole plan in one pass and by identity only, so a plan whose
 * stops carry no ids is not charged an unknown for every one of them — the
 * duplicate check above already records that gap once.
 */
function checkExcludedYetScheduled(plan: BenchmarkPlan, ctx: CheckContext): BenchFinding[] {
  ctx.decided();
  const findings: BenchFinding[] = [];

  const scheduled = new Map<string, PlanDay>();
  for (const day of safeArray(plan.days)) {
    for (const block of safeArray(day.blocks)) {
      if (!isActivity(block)) continue;
      const entityId = entityIdOf(block);
      if (entityId !== null && !scheduled.has(entityId)) scheduled.set(entityId, day);
    }
  }

  for (const exclusion of safeArray(plan.exclusions)) {
    const entityId = exclusion.place?.entityId ?? null;
    if (entityId === null) continue;
    const day = scheduled.get(entityId);
    if (!day) continue;
    findings.push(
      report(
        'internal_contradiction',
        'critical',
        subjectOf(day, { entityId }),
        `${exclusion.place?.name ?? entityId} is scheduled on ${dayLabel(day)} and also listed as left out: ${exclusion.reason}`,
        'plan.exclusions',
        { observed: { entityId, scheduledOn: String(day.date ?? '') } },
      ),
    );
  }

  return findings;
}

/**
 * A day that calls itself a rest and then fills itself.
 *
 * The declaration is read from `day.theme` and nowhere else. It used to be read
 * from the day's warnings as well, which turned a critical finding into a
 * lottery on wording: one converter concatenates day warnings, weather cautions
 * and availability cautions into that array, up to twenty of them, so a single
 * caution mentioning a "free day" at the trailhead was enough to have the day
 * declared restful and then convicted of not being. The theme is where a plan
 * says what a day *is*; a warning is where it says what might go wrong.
 *
 * Minor rather than critical, and that is the more important half of the fix. A
 * label that disagrees with a load is a defect in how the day is described, not
 * a trip that cannot be executed — the traveller can do every one of those
 * hours. Grading it critical put a labelling slip in the same bucket as a locked
 * gate, and the bucket is what the decision rules read.
 */
function checkRestDayLoad(day: PlanDay, ctx: CheckContext): BenchFinding[] {
  ctx.decided();
  if (!REST_DAY_PATTERN.test(String(day.theme ?? ''))) return [];

  const committed = committedMinutes(day);
  if (committed <= NEUTRAL_THRESHOLDS.restDayMaxCommittedMinutes) return [];
  return [
    report(
      'internal_contradiction',
      'minor',
      subjectOf(day),
      `${dayLabel(day)} is described as a rest day and holds ${Math.round(committed / 60)} hours of commitments.`,
      'plan.days[].theme',
      {
        observed: { committedMinutes: committed },
        expected: { maxCommittedMinutes: NEUTRAL_THRESHOLDS.restDayMaxCommittedMinutes },
      },
    ),
  ];
}

/**
 * The day's own arithmetic.
 *
 * The one check in the set whose subject genuinely cannot be reconstructed from
 * the timeline: the contradiction *is* the gap between what a plan says and what
 * it schedules, so a plan that states no total has not contradicted itself and
 * there is nothing to compute. That is reported as `unknown` with
 * `plan_omits_field` rather than quietly passing, and it is reported that way for
 * either converter alike — one of which states totals on every day and one of
 * which states them on none.
 *
 * What has changed is that the three totals are settled independently. Free time
 * is readable off the timeline whatever the legs say about themselves, so a day
 * whose journeys carry no durations no longer takes its free-time claim
 * undecided with them, and a plan that states one checkable total and two
 * unstated ones is checked on the one.
 *
 * The tolerance is a single minute, because this is addition.
 */
const TOTALS_TOLERANCE_MINUTES = 1;

function checkStatedTotals(day: PlanDay, ctx: CheckContext): BenchFinding[] {
  const subject = subjectOf(day);
  const totals = day.statedTotals;
  const statedTravel = typeof totals?.travelMinutes === 'number' ? totals.travelMinutes : null;
  const statedDrive = typeof totals?.driveMinutes === 'number' ? totals.driveMinutes : null;
  const statedFree = typeof totals?.freeMinutes === 'number' ? totals.freeMinutes : null;

  if (statedTravel === null && statedDrive === null && statedFree === null) {
    ctx.undecided();
    return [
      unresolved(
        'stated_totals_contradict_timeline',
        subject,
        `${dayLabel(day)} states no totals, so there is nothing to contradict.`,
        'plan.days[].statedTotals',
        'plan_omits_field',
      ),
    ];
  }

  /*
   * TOTALS ADDED UP FROM THE VERY ITEMS THEY DESCRIBE CANNOT CONTRADICT THEM.
   *
   * One converter copies the planner's own totals, computed by summing exactly
   * the items that become these blocks, so the two agree by arithmetic identity
   * — and a critical check for an internal contradiction became one that arm
   * could only ever pass while the other could fail it. Reported as unknown, for
   * whichever converter says the totals are derived, because a tautology is not
   * a pass.
   */
  if (totals?.derived === true) {
    ctx.undecided();
    return [
      unresolved(
        'stated_totals_contradict_timeline',
        subject,
        `${dayLabel(day)} states totals its own system added up from these same blocks, so agreement between them establishes nothing.`,
        'plan.days[].statedTotals.derived',
        'not_applicable_unproven',
      ),
    ];
  }

  // A leg's cost is its stated duration or, failing that, the slot the day gives
  // it. Only a leg with neither leaves the travel arithmetic unsettleable.
  const legs = travelBlocks(day).map((block) => ({ block, minutes: travelMinutesOf(block) }));
  const uncosted = legs.some((leg) => leg.minutes === null);
  const travelMinutes = legs.reduce((total, leg) => total + (leg.minutes ?? 0), 0);
  const driveMinutes = legs
    .filter((leg) => leg.block.travel?.mode === 'drive')
    .reduce((total, leg) => total + (leg.minutes ?? 0), 0);

  const mismatched: string[] = [];
  let settled = false;

  if (statedTravel !== null && !uncosted) {
    settled = true;
    if (Math.abs(statedTravel - travelMinutes) > TOTALS_TOLERANCE_MINUTES) {
      mismatched.push(`travel ${statedTravel} against ${travelMinutes}`);
    }
  }
  if (statedDrive !== null && !uncosted) {
    settled = true;
    if (Math.abs(statedDrive - driveMinutes) > TOTALS_TOLERANCE_MINUTES) {
      mismatched.push(`driving ${statedDrive} against ${driveMinutes}`);
    }
  }
  if (statedFree !== null) {
    settled = true;
    if (!freeMinutesAgree(day, statedFree)) mismatched.push(`free time ${statedFree}`);
  }

  if (!settled) {
    ctx.undecided();
    return [
      unresolved(
        'stated_totals_contradict_timeline',
        subject,
        `${dayLabel(day)} states a travel total over a leg that gives neither a duration nor a slot on the clock.`,
        'plan.days[].blocks[].travel.minutes',
        'plan_omits_field',
      ),
    ];
  }

  ctx.decided();
  if (mismatched.length === 0) return [];

  return [
    report(
      'stated_totals_contradict_timeline',
      'critical',
      subject,
      `${dayLabel(day)} states totals its own timeline does not add up to: ${mismatched.join('; ')}.`,
      'plan.days[].statedTotals',
      {
        observed: {
          statedTravelMinutes: statedTravel,
          statedDriveMinutes: statedDrive,
          statedFreeMinutes: statedFree,
        },
        expected: { travelMinutes, driveMinutes },
      },
    ),
  ];
}

/**
 * Free time has two defensible definitions and this accepts either.
 *
 * A plan may mean the gaps its timeline leaves, or it may mean the rest and
 * free-time blocks it deliberately wrote down. Picking one and calling the other
 * a critical contradiction would be this validator scoring a convention rather
 * than an error.
 */
function freeMinutesAgree(day: PlanDay, statedFree: number): boolean {
  const explicit = safeArray(day.blocks)
    .filter((block) => block.kind === 'free_time' || block.kind === 'rest')
    .reduce((total, block) => total + (blockMinutes(block) ?? 0), 0);
  if (Math.abs(statedFree - explicit) <= TOTALS_TOLERANCE_MINUTES) return true;

  const span = daySpan(day);
  if (!span) return false;
  const gaps = Math.max(0, span.end - span.start - committedMinutes(day));
  return Math.abs(statedFree - gaps) <= TOTALS_TOLERANCE_MINUTES;
}
