import { consecutivePairs } from '../geometry';
import {
  NEUTRAL_THRESHOLDS,
  type BenchmarkGroundTruth,
  type DayOpening,
} from '../ground-truth';
import { type BenchCheckCode, type BenchFinding, type BenchSubject } from '../schemas/finding';
import { type BenchmarkPlan, type PlanBlock, type PlanDay } from '../schemas/plan';
import {
  activityBlocks,
  clockLabel,
  committedMinutes,
  dayLabel,
  daySpan,
  displayNameOf,
  entityIdOf,
  isActivity,
  report,
  safeArray,
  subjectOf,
  timesOf,
  unresolved,
  type CheckContext,
} from './context';

/**
 * The clock, and the gates the clock has to get through.
 *
 * Two kinds of finding live here and they are graded differently on purpose.
 * A visit scheduled while the gate is shut is `critical` — it is a fact about
 * the world and no traveller can execute it. A day that is merely busy, or that
 * finishes half an hour before sunset, is `minor` — the threshold is a policy
 * this benchmark published, and a system whose house style runs tighter days has
 * not produced a defective plan.
 *
 * Where the daylight pair is concerned that distinction is the whole design:
 * finishing *after* sunset on a daylight-only trail is the fact, and finishing
 * inside the buffer before it is the policy.
 */

export function checkScheduling(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  for (const day of safeArray(plan.days)) {
    findings.push(...checkOverlaps(day, ctx));
    findings.push(...checkShape(day, ctx));

    safeArray(day.blocks).forEach((block, index) => {
      if (!isActivity(block)) return;
      findings.push(...checkDuration(day, block, index, truth, ctx));
      findings.push(...checkOpening(day, block, index, truth, ctx));
      findings.push(...checkSeason(day, block, index, truth, ctx));
      findings.push(...checkDaylight(day, block, index, truth, ctx));
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Overlaps
 * ------------------------------------------------------------------ */

/**
 * Two things at once.
 *
 * Critical and decidable from the plan alone, which makes it the cheapest real
 * defect in the set: a timeline that double-books an hour has not been checked
 * by anybody, and the hours it claims to have are fictional.
 */
function checkOverlaps(day: PlanDay, ctx: CheckContext): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const blocks = safeArray(day.blocks);
  const timed = blocks
    .map((block, index) => ({ block, index, times: timesOf(block) }))
    .filter((entry) => entry.times !== null);

  if (timed.length < 2) {
    ctx.undecided();
    return [
      unresolved(
        'blocks_overlap',
        subjectOf(day),
        `${dayLabel(day)} does not put clock times on enough of itself for an overlap to be visible.`,
        'plan.days[].blocks[].startMinute',
        'plan_omits_field',
      ),
    ];
  }

  for (const [earlier, later] of consecutivePairs(timed)) {
    ctx.decided();
    const first = earlier.times!;
    const second = later.times!;
    if (second.start >= first.end) continue;
    findings.push(
      report(
        'blocks_overlap',
        'critical',
        subjectOf(day, { blockIndex: later.index, entityId: entityIdOf(later.block) }),
        `${dayLabel(day)} runs "${earlier.block.title}" until ${clockLabel(first.end)} and starts "${later.block.title}" at ${clockLabel(second.start)}.`,
        'plan.days[].blocks',
        { observed: { previousEnd: first.end, nextStart: second.start } },
      ),
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Shape of the day
 * ------------------------------------------------------------------ */

/**
 * Too much in a day, and too little of it left alone.
 *
 * Both minor, both from published thresholds, and both deliberately generous.
 * A neutral checker's job is to catch plans that do not work, not to enforce a
 * house style, and a tight number here would quietly punish whichever system's
 * conventions differ from the author's.
 */
function checkShape(day: PlanDay, ctx: CheckContext): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const subject = subjectOf(day);
  const activities = activityBlocks(day);
  const committed = committedMinutes(day);

  ctx.decided();
  if (
    activities.length > NEUTRAL_THRESHOLDS.maxActivityBlocksPerDay ||
    committed > NEUTRAL_THRESHOLDS.maxScheduledMinutesPerDay
  ) {
    findings.push(
      report(
        'excessive_density',
        'minor',
        subject,
        `${dayLabel(day)} holds ${activities.length} stops across ${Math.round(committed / 60)} committed hours.`,
        'NEUTRAL_THRESHOLDS.maxActivityBlocksPerDay',
        {
          observed: { activityBlocks: activities.length, committedMinutes: committed },
          expected: {
            maxActivityBlocks: NEUTRAL_THRESHOLDS.maxActivityBlocksPerDay,
            maxScheduledMinutes: NEUTRAL_THRESHOLDS.maxScheduledMinutesPerDay,
          },
        },
      ),
    );
  }

  const span = daySpan(day);
  if (!span) {
    ctx.undecided();
    findings.push(
      unresolved(
        'insufficient_free_time',
        subject,
        `${dayLabel(day)} states no clock times, so how much of it is unclaimed cannot be worked out.`,
        'plan.days[].blocks[].startMinute',
        'plan_omits_field',
      ),
    );
    return findings;
  }

  const length = span.end - span.start;
  // Only a full day is held to a free-time floor. Half a day that is entirely
  // booked is a morning, not an ordeal. The gate reads its own constant rather
  // than the food rule's, so that adjusting how long a day has to be before it
  // needs feeding cannot silently change how long it has to be before it needs
  // slack.
  if (length < NEUTRAL_THRESHOLDS.fullDayMinutesForFreeTimeFloor) return findings;

  ctx.decided();
  const free = length - committed;
  if (free >= NEUTRAL_THRESHOLDS.minFreeMinutesPerFullDay) return findings;
  findings.push(
    report(
      'insufficient_free_time',
      'minor',
      subject,
      `${dayLabel(day)} runs ${Math.round(length / 60)} hours with ${Math.max(0, free)} min unclaimed.`,
      'NEUTRAL_THRESHOLDS.minFreeMinutesPerFullDay',
      {
        observed: { freeMinutes: Math.max(0, free), spanMinutes: length },
        expected: { minFreeMinutes: NEUTRAL_THRESHOLDS.minFreeMinutesPerFullDay },
      },
    ),
  );
  return findings;
}

/* ------------------------------------------------------------------ *
 * Duration
 * ------------------------------------------------------------------ */

/**
 * Twenty minutes at a place that takes three hours, or a day and a half at a
 * viewpoint.
 *
 * Minor, because the typical duration is one source's opinion and travellers
 * legitimately rush and linger. The band is wide — well under half and well over
 * four times — so only a stop that could not have been thought about at all
 * trips it.
 */
function checkDuration(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const entityId = entityIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId });
  const times = timesOf(block);

  if (!times) {
    ctx.undecided();
    return [
      unresolved(
        'activity_duration_implausible',
        subject,
        `${displayNameOf(block)} has no stated start and end, so how long it takes is unstated.`,
        'plan.days[].blocks[].startMinute',
        'plan_omits_field',
      ),
    ];
  }
  if (entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'activity_duration_implausible',
        subject,
        `${displayNameOf(block)} carries no shared identity, so no typical visit length applies.`,
        'plan.days[].blocks[].place.entityId',
        'subject_not_in_inventory',
      ),
    ];
  }

  const entry = truth.place(entityId);
  const typical = entry?.typicalDurationMinutes ?? null;
  if (typical === null) {
    ctx.undecided();
    return [
      unresolved(
        'activity_duration_implausible',
        subject,
        `Nobody has recorded how long a visit to ${displayNameOf(block)} usually takes.`,
        'truth.place',
        entry ? 'no_dataset' : 'subject_not_in_inventory',
      ),
    ];
  }

  ctx.decided();
  const duration = times.end - times.start;
  const floor = typical * NEUTRAL_THRESHOLDS.minDurationFractionOfTypical;
  const ceiling = typical * NEUTRAL_THRESHOLDS.maxDurationMultipleOfTypical;
  if (duration >= floor && duration <= ceiling) return [];

  return [
    report(
      'activity_duration_implausible',
      'minor',
      subject,
      `${dayLabel(day)} allows ${duration} min at ${entry?.name ?? displayNameOf(block)}, against a typical ${typical} min.`,
      'truth.place',
      {
        observed: { durationMinutes: duration },
        expected: { typicalMinutes: typical, floorMinutes: Math.round(floor), ceilingMinutes: Math.round(ceiling) },
      },
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Opening hours
 * ------------------------------------------------------------------ */

const WINDOW_CODES: readonly BenchCheckCode[] = [
  'arrives_before_opening',
  'arrives_after_last_admission',
  'ends_after_closing',
];

/**
 * The gate, on the day.
 *
 * Every finding here is critical: a traveller standing at a locked door has lost
 * the afternoon, and no other quality in the plan buys it back. `unknown` hours
 * are the common case for a great many places and are treated as exactly that —
 * a plan is never charged for visiting somewhere nobody has catalogued, because
 * doing so would make obscurity itself a defect and push both systems toward the
 * same short list of well-documented sights.
 */
function checkOpening(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const entityId = entityIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId });
  const date = String(day.date ?? '');

  if (entityId === null) {
    return allUnknown(
      ctx,
      ['scheduled_while_closed', ...WINDOW_CODES],
      subject,
      `${displayNameOf(block)} carries no shared identity, so its hours cannot be looked up.`,
      'plan.days[].blocks[].place.entityId',
      'subject_not_in_inventory',
    );
  }

  const opening = truth.openingOn(entityId, date);
  if (opening === null || opening.status === 'unknown') {
    return allUnknown(
      ctx,
      ['scheduled_while_closed', ...WINDOW_CODES],
      subject,
      `No opening-hours dataset covers ${displayNameOf(block)} on ${date}.`,
      'truth.openingOn',
      'no_dataset',
    );
  }

  ctx.decided();
  if (opening.status === 'closed') {
    // The window checks are not attempted at all: a shut gate has no window to
    // arrive inside, so they are inapplicable rather than undecidable, and
    // counting three unknowns here would depress verifiability for a plan whose
    // one real defect has already been found.
    return [
      report(
        'scheduled_while_closed',
        'critical',
        subject,
        `${displayNameOf(block)} is closed on ${date}, and ${dayLabel(day)} visits it.`,
        'truth.openingOn',
        { observed: { status: opening.status, date } },
      ),
    ];
  }

  if (opening.status === 'always_open') {
    // No gate, no window, nothing to check. Recorded as decided once and then
    // left alone rather than producing three empty unknowns.
    return [];
  }

  return checkWindow(day, block, subject, opening, ctx);
}

function checkWindow(
  day: PlanDay,
  block: PlanBlock,
  subject: BenchSubject,
  opening: DayOpening,
  ctx: CheckContext,
): BenchFinding[] {
  const times = timesOf(block);
  if (!times) {
    return allUnknown(
      ctx,
      WINDOW_CODES,
      subject,
      `${displayNameOf(block)} has no clock times, so it cannot be placed inside the opening window.`,
      'plan.days[].blocks[].startMinute',
      'plan_omits_field',
    );
  }

  const windows = safeArray(opening.windows);
  if (windows.length === 0) {
    return allUnknown(
      ctx,
      WINDOW_CODES,
      subject,
      `${displayNameOf(block)} is recorded as open with no window stated.`,
      'truth.openingOn',
      'no_dataset',
    );
  }

  // Earliest open to latest close. A place with a midday break is not caught
  // here, and that is the conservative direction: a false accusation about a
  // siesta would be a defect this validator invented.
  const opens = Math.min(...windows.map((window) => window.openMinute));
  const closes = Math.max(...windows.map((window) => window.closeMinute));
  const findings: BenchFinding[] = [];

  ctx.decided();
  if (times.start < opens) {
    findings.push(
      report(
        'arrives_before_opening',
        'critical',
        subject,
        `${dayLabel(day)} starts ${displayNameOf(block)} at ${clockLabel(times.start)}, before it opens at ${clockLabel(opens)}.`,
        'truth.openingOn',
        { observed: { startMinute: times.start }, expected: { openMinute: opens } },
      ),
    );
  }

  const lastAdmission = opening.lastAdmissionMinute;
  if (typeof lastAdmission === 'number') {
    ctx.decided();
    if (times.start > lastAdmission) {
      findings.push(
        report(
          'arrives_after_last_admission',
          'critical',
          subject,
          `${dayLabel(day)} arrives at ${displayNameOf(block)} at ${clockLabel(times.start)}, after the last entry at ${clockLabel(lastAdmission)}.`,
          'truth.openingOn',
          { observed: { startMinute: times.start }, expected: { lastAdmissionMinute: lastAdmission } },
        ),
      );
    }
  } else {
    ctx.undecided();
    findings.push(
      unresolved(
        'arrives_after_last_admission',
        subject,
        `No last-admission time is on record for ${displayNameOf(block)}.`,
        'truth.openingOn',
        'no_dataset',
      ),
    );
  }

  ctx.decided();
  if (times.end > closes) {
    findings.push(
      report(
        'ends_after_closing',
        'critical',
        subject,
        `${dayLabel(day)} has the traveller at ${displayNameOf(block)} until ${clockLabel(times.end)}, after it closes at ${clockLabel(closes)}.`,
        'truth.openingOn',
        { observed: { endMinute: times.end }, expected: { closeMinute: closes } },
      ),
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Season and daylight
 * ------------------------------------------------------------------ */

function checkSeason(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const entityId = entityIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId });
  const date = String(day.date ?? '');

  if (entityId === null) {
    ctx.undecided();
    return [
      unresolved(
        'seasonal_access_conflict',
        subject,
        `${displayNameOf(block)} carries no shared identity, so no seasonal rule can be found for it.`,
        'plan.days[].blocks[].place.entityId',
        'subject_not_in_inventory',
      ),
    ];
  }

  const open = truth.seasonallyOpenOn(entityId, date);
  if (open === null) {
    ctx.undecided();
    return [
      unresolved(
        'seasonal_access_conflict',
        subject,
        `No seasonal rule is on record for ${displayNameOf(block)}.`,
        'truth.seasonallyOpenOn',
        'no_dataset',
      ),
    ];
  }

  ctx.decided();
  if (open) return [];
  return [
    report(
      'seasonal_access_conflict',
      'critical',
      subject,
      `${displayNameOf(block)} is not accessible in this season, and ${dayLabel(day)} is built around it.`,
      'truth.seasonallyOpenOn',
      { observed: { date, seasonallyOpen: false } },
    ),
  ];
}

/**
 * Sunset against a place that is signed for daylight use only.
 *
 * The pair is split because the two halves are different kinds of claim. Ending
 * after sunset on a daylight-only trail is a fact about the sun and the sign, so
 * it is critical. Ending inside the buffer before sunset is this benchmark's
 * policy about what counts as cutting it fine, so it is minor — and if a system
 * disagrees with the policy it has not produced a plan that fails.
 */
function checkDaylight(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const entityId = entityIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId });
  const date = String(day.date ?? '');
  const codes: readonly BenchCheckCode[] = ['scheduled_outside_daylight', 'scheduled_inside_daylight_buffer'];

  if (entityId === null) {
    return allUnknown(
      ctx,
      codes,
      subject,
      `${displayNameOf(block)} carries no shared identity, so whether it is daylight-only is unknown.`,
      'plan.days[].blocks[].place.entityId',
      'subject_not_in_inventory',
    );
  }

  const entry = truth.place(entityId);
  if (!entry || entry.daylightOnly === null) {
    return allUnknown(
      ctx,
      codes,
      subject,
      `Nobody has recorded whether ${displayNameOf(block)} is daylight-only.`,
      'truth.place',
      entry ? 'no_dataset' : 'subject_not_in_inventory',
    );
  }
  if (entry.daylightOnly === false) {
    // Both halves of the pair are decidable and both pass: the sign says the
    // place may be used after dark, which is an answer rather than an absence.
    ctx.decided();
    ctx.decided();
    return [];
  }

  const times = timesOf(block);
  if (!times) {
    return allUnknown(
      ctx,
      codes,
      subject,
      `${displayNameOf(block)} has no clock times to compare with sunset.`,
      'plan.days[].blocks[].startMinute',
      'plan_omits_field',
    );
  }

  const solar = truth.solar(entityId, date);
  if (!solar) {
    return allUnknown(
      ctx,
      codes,
      subject,
      `No sunrise or sunset is on record for ${displayNameOf(block)} on ${date}.`,
      'truth.solar',
      'no_dataset',
    );
  }

  const findings: BenchFinding[] = [];
  // One attempt for the fact, one for the policy, whichever way each falls.
  ctx.decided();
  const dark =
    solar.kind === 'polar_night' ||
    (solar.kind === 'normal' && (times.end > solar.sunsetMinute || times.start < solar.sunriseMinute));
  if (dark) {
    findings.push(
      report(
        'scheduled_outside_daylight',
        'critical',
        subject,
        solar.kind === 'polar_night'
          ? `${displayNameOf(block)} is daylight-only and ${date} has no daylight at all.`
          : `${dayLabel(day)} has the traveller at ${displayNameOf(block)} from ${clockLabel(times.start)} to ${clockLabel(times.end)}, outside the ${clockLabel(solar.sunriseMinute)}–${clockLabel(solar.sunsetMinute)} daylight.`,
        'truth.solar',
        {
          observed: { startMinute: times.start, endMinute: times.end },
          expected: { sunriseMinute: solar.sunriseMinute, sunsetMinute: solar.sunsetMinute },
        },
      ),
    );
    // The buffer question is settled by the stronger finding: a visit already
    // past sunset is not additionally "close to" sunset.
    ctx.decided();
    return findings;
  }

  ctx.decided();
  if (solar.kind === 'normal' && times.end > solar.sunsetMinute - NEUTRAL_THRESHOLDS.daylightBufferMinutes) {
    findings.push(
      report(
        'scheduled_inside_daylight_buffer',
        'minor',
        subject,
        `${displayNameOf(block)} finishes at ${clockLabel(times.end)}, inside the ${NEUTRAL_THRESHOLDS.daylightBufferMinutes} min before sunset at ${clockLabel(solar.sunsetMinute)}.`,
        'NEUTRAL_THRESHOLDS.daylightBufferMinutes',
        {
          observed: { endMinute: times.end },
          expected: { sunsetMinute: solar.sunsetMinute, bufferMinutes: NEUTRAL_THRESHOLDS.daylightBufferMinutes },
        },
      ),
    );
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

function allUnknown(
  ctx: CheckContext,
  codes: readonly BenchCheckCode[],
  subject: BenchSubject,
  message: string,
  groundTruth: string,
  reason: Parameters<typeof unresolved>[4],
): BenchFinding[] {
  return codes.map((code) => {
    ctx.undecided();
    return unresolved(code, subject, message, groundTruth, reason);
  });
}
