import { NEUTRAL_THRESHOLDS, type BenchmarkGroundTruth } from '../ground-truth';
import { type BenchFinding } from '../schemas/finding';
import { type BenchmarkPlan, type PlanBlock, type PlanDay } from '../schemas/plan';
import {
  clockLabel,
  dayLabel,
  daySpan,
  isMeal,
  normaliseTag,
  report,
  safeArray,
  subjectOf,
  timesOf,
  unresolved,
  venueIdOf,
  type CheckContext,
} from './context';

/**
 * Eating.
 *
 * Graded on a deliberate slope. A long day with no food at all is `major`,
 * because a traveller who cannot eat between nine and seven has been handed a
 * problem rather than a plan. A day with fewer meals than its length implies is
 * `minor`, because people snack, carry sandwiches and skip lunch, and a stricter
 * grade would be this benchmark imposing a mealtime convention on two systems
 * that never agreed to one.
 *
 * The dietary check is the exception and it runs the other way. A venue that
 * says in as many words that it cannot serve a diet the traveller declared
 * strict is `critical`. A venue that has said nothing is `unknown` — never a
 * warning — because "nobody confirmed this kitchen is vegan" is the ordinary
 * state of the world and grading it would punish whichever system named real
 * restaurants instead of leaving dinner vague.
 */

export function checkFood(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  for (const day of safeArray(plan.days)) {
    findings.push(...checkMealCoverage(day, ctx));
    safeArray(day.blocks).forEach((block, index) => {
      if (!isMeal(block)) return;
      findings.push(...checkVenue(day, block, index, truth, ctx));
      findings.push(...checkDetour(day, block, index, truth, ctx));
      findings.push(...checkDiet(day, block, index, truth, ctx));
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Coverage
 * ------------------------------------------------------------------ */

/**
 * How many meals a day of that length implies.
 *
 * Derived from the one published number rather than from a mealtime table,
 * because a mealtime table is a culture: a plan for Spain that puts dinner at
 * ten has not made a mistake, and a checker with opinions about when people eat
 * would score two systems on whose habits they share.
 */
export function impliedMeals(spanMinutes: number): number {
  if (spanMinutes <= 0) return 0;
  return Math.floor(spanMinutes / NEUTRAL_THRESHOLDS.minutesPerImpliedMeal) + 1;
}

function checkMealCoverage(day: PlanDay, ctx: CheckContext): BenchFinding[] {
  const subject = subjectOf(day);
  const span = daySpan(day);

  if (!span) {
    ctx.undecided();
    ctx.undecided();
    const message = `${dayLabel(day)} states no clock times, so how long it runs — and how much eating it needs — is unstated.`;
    return [
      unresolved('meal_missing', subject, message, 'plan.days[].blocks[].startMinute', 'plan_omits_field'),
      unresolved('long_day_without_food', subject, message, 'plan.days[].blocks[].startMinute', 'plan_omits_field'),
    ];
  }

  const length = span.end - span.start;
  const meals = safeArray(day.blocks).filter(isMeal).length;
  const findings: BenchFinding[] = [];

  ctx.decided();
  if (length > NEUTRAL_THRESHOLDS.longDayMinutesRequiringFood && meals === 0) {
    findings.push(
      report(
        'long_day_without_food',
        'major',
        subject,
        `${dayLabel(day)} runs ${clockLabel(span.start)} to ${clockLabel(span.end)} with nowhere to eat in it.`,
        'NEUTRAL_THRESHOLDS.longDayMinutesRequiringFood',
        { observed: { spanMinutes: length, mealBlocks: 0 } },
      ),
    );
    // The count check has nothing left to say once the day has no food at all;
    // charging both would double-count one omission.
    ctx.decided();
    return findings;
  }

  ctx.decided();
  const wanted = impliedMeals(length);
  if (length >= NEUTRAL_THRESHOLDS.longDayMinutesRequiringFood && meals > 0 && meals < wanted) {
    findings.push(
      report(
        'meal_missing',
        'minor',
        subject,
        `${dayLabel(day)} runs ${Math.round(length / 60)} hours and names ${meals} meal${meals === 1 ? '' : 's'}.`,
        'NEUTRAL_THRESHOLDS.longDayMinutesRequiringFood',
        { observed: { mealBlocks: meals, spanMinutes: length }, expected: { mealBlocks: wanted } },
      ),
    );
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * The venue itself
 * ------------------------------------------------------------------ */

function checkVenue(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const venueId = venueIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId: venueId });
  const date = String(day.date ?? '');

  if (venueId === null) {
    ctx.undecided();
    return [
      unresolved(
        'meal_venue_closed',
        subject,
        `${dayLabel(day)} names no place for this meal, in the meal detail or on the block, so its kitchen cannot be looked up.`,
        'plan.days[].blocks[].meal.venue.entityId',
        // The plan omitted the field rather than the inventory failing to hold
        // the place: `venueIdOf` has already tried both places a plan may put a
        // venue's identity, so reaching here means neither was given.
        'plan_omits_field',
      ),
    ];
  }

  const facts = truth.food(venueId);
  const opening = truth.openingOn(venueId, date);
  /*
   * WHAT IS ACTUALLY ON RECORD, ASKED BEFORE THE TALLY MOVES.
   *
   * Two ways to be silent about a venue, and neither is a finding. The opening
   * calendar may say nothing, and the meal-times list may be empty — which is the
   * ordinary case rather than an edge one, because the provider layer sets
   * `servesSlots: []` on every food record on purpose: a venue tagged
   * `amenity=restaurant` has not told anybody which meals it serves, and
   * inferring "lunch and dinner" from the word restaurant is exactly the
   * confident guess the plan is forbidden to make.
   *
   * `!servesSlots.includes(slot)` is true of an empty array, so the check below
   * used to convict every such meal, critically, of a claim nobody made. The
   * damage compounded: critical findings are what the single bounded repair is
   * spent on, so fabricated ones consumed the one correction a run gets. And only
   * one converter resolves a meal venue to an identity at all, so the fabrication
   * was reserved for one arm — a defect in a converter, read as a defect in a
   * planner.
   */
  const name = block.meal?.venue?.name ?? facts?.name ?? 'the venue';
  const slot = block.meal?.slot ?? null;
  const calendarIsSilent = opening === null || opening.status === 'unknown';
  const mealTimesAreSilent = !facts || slot === null || facts.servesSlots.length === 0;

  if (calendarIsSilent && mealTimesAreSilent) {
    ctx.undecided();
    return [
      unresolved(
        'meal_venue_closed',
        subject,
        `Nothing is on record about whether ${name} is open on ${date}, or which meals it serves.`,
        'truth.food',
        'no_dataset',
      ),
    ];
  }

  ctx.decided();

  if (opening?.status === 'closed') {
    return [
      report(
        'meal_venue_closed',
        'critical',
        subject,
        `${name} is closed on ${date}, and ${dayLabel(day)} eats there.`,
        'truth.openingOn',
        { observed: { status: 'closed', date } },
      ),
    ];
  }

  // Only a *populated* list can contradict a slot. `checkDiet` already applies
  // the same rule to `cannotAccommodate`, for the same reason.
  if (facts && slot !== null && facts.servesSlots.length > 0 && !facts.servesSlots.includes(slot)) {
    return [
      report(
        'meal_venue_closed',
        'critical',
        subject,
        `${name} does not serve ${slot}, and ${dayLabel(day)} schedules it for that.`,
        'truth.food',
        { observed: { slot }, expected: { serves: facts.servesSlots.join(',') } },
      ),
    ];
  }

  const times = timesOf(block);
  const windows = safeArray(opening?.windows);
  if (opening?.status === 'open' && times && windows.length > 0) {
    const opens = Math.min(...windows.map((window) => window.openMinute));
    const closes = Math.max(...windows.map((window) => window.closeMinute));
    if (times.start < opens || times.end > closes) {
      return [
        report(
          'meal_venue_closed',
          'critical',
          subject,
          `${dayLabel(day)} eats at ${name} from ${clockLabel(times.start)}, outside its ${clockLabel(opens)}–${clockLabel(closes)}.`,
          'truth.openingOn',
          {
            observed: { startMinute: times.start, endMinute: times.end },
            expected: { openMinute: opens, closeMinute: closes },
          },
        ),
      ];
    }
  }

  return [];
}

/**
 * How far off the day a meal drags the traveller.
 *
 * Minor, and from a published threshold, because a detour worth making is a
 * judgement — plenty of travellers would drive half an hour for the right
 * dinner, and this check exists to notice the ones that were not a choice.
 *
 * The detour is measured off the timeline first and read out of the plan second.
 * A meal sitting between two stops the shared inventory holds has a detour that
 * is arithmetic — the way round by the restaurant, less the way straight on —
 * and nothing about that arithmetic depends on whether the plan chose to write
 * the number down. Only where the route is not measurable does the plan's own
 * figure stand in, and only where there is neither does the check go undecided.
 * Reading the field alone made this a check one converter always answered and
 * the other frequently did not.
 *
 * Where both exist the measured one decides, because the plan's number is its
 * claim and the route is the fact. The claim is carried into `observed` so a
 * reviewer disputing the finding can see the two side by side.
 */
function checkDetour(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const venueId = venueIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId: venueId });
  const stated = block.meal?.detourMinutes ?? null;
  const measured = measuredDetourMinutes(day, index, venueId, truth);
  const detour = measured ?? stated;

  if (detour === null) {
    ctx.undecided();
    return [
      unresolved(
        'meal_detour_excessive',
        subject,
        `${dayLabel(day)} neither states how far off the route this meal sits nor puts it between two measured stops.`,
        'plan.days[].blocks[].meal.detourMinutes',
        'plan_omits_field',
      ),
    ];
  }

  ctx.decided();
  if (detour <= NEUTRAL_THRESHOLDS.mealDetourMinutes) return [];
  return [
    report(
      'meal_detour_excessive',
      'minor',
      subject,
      `${dayLabel(day)} goes ${detour} min off route to eat.`,
      measured === null ? 'plan.days[].blocks[].meal.detourMinutes' : 'truth.routeMinutes',
      {
        observed: { detourMinutes: detour, statedDetourMinutes: stated, measured: measured !== null },
        expected: { maxDetourMinutes: NEUTRAL_THRESHOLDS.mealDetourMinutes },
      },
    ),
  ];
}

/**
 * The meal's detour, worked out from where the day is either side of it.
 *
 * `null` whenever any of the three legs is unmeasured or either neighbour is
 * missing, which is most of the time — this is an opportunity to decide a check
 * from the timeline rather than a replacement for the plan's own number, and a
 * validator that estimated the missing leg would be grading plans against its
 * own invention.
 */
function measuredDetourMinutes(
  day: PlanDay,
  index: number,
  venueId: string | null,
  truth: BenchmarkGroundTruth,
): number | null {
  if (venueId === null) return null;
  const blocks = safeArray(day.blocks);
  const before = nearestPlacedIdentity(blocks, index, -1);
  const after = nearestPlacedIdentity(blocks, index, 1);
  if (before === null || after === null) return null;
  // Eating where you already are, or where you are going next, is not a detour
  // and does not need a route to prove it.
  if (before === venueId || after === venueId) return 0;

  const out = truth.routeMinutes(before, venueId);
  const back = truth.routeMinutes(venueId, after);
  const straight = truth.routeMinutes(before, after);
  if (out === null || back === null || straight === null) return null;
  if (!Number.isFinite(out) || !Number.isFinite(back) || !Number.isFinite(straight)) return null;
  return Math.max(0, Math.round(out + back - straight));
}

/**
 * Where the day is, either side of a block.
 *
 * Journeys are stepped over because they are the moving rather than the being
 * somewhere, and so is anything that names nowhere at all. It stops at the first
 * block that names a place, even one carrying no shared identity, because
 * walking past that one would measure the detour against the wrong end of the
 * day.
 */
function nearestPlacedIdentity(
  blocks: readonly PlanBlock[],
  from: number,
  step: 1 | -1,
): string | null {
  for (let cursor = from + step; cursor >= 0 && cursor < blocks.length; cursor += step) {
    const block = blocks[cursor];
    if (!block) continue;
    if (block.kind === 'travel' || block.kind === 'transfer') continue;
    if (!block.place && !block.meal?.venue) continue;
    return venueIdOf(block);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Diet
 * ------------------------------------------------------------------ */

function checkDiet(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const party = ctx.request?.party;
  const required = safeArray(party?.dietary);
  // Strictness is a property of a stated requirement, and a traveller who said
  // "I would rather" has not set a constraint a plan can violate.
  if (party?.dietaryStrict !== true || required.length === 0) return [];

  const venueId = venueIdOf(block);
  const subject = subjectOf(day, { blockIndex: index, entityId: venueId });

  if (venueId === null) {
    ctx.undecided();
    return [
      unresolved(
        'strict_dietary_conflict',
        subject,
        `${dayLabel(day)} names no place for this meal, in the meal detail or on the block, so its kitchen is unknown.`,
        'plan.days[].blocks[].meal.venue.entityId',
        'plan_omits_field',
      ),
    ];
  }

  const facts = truth.food(venueId);
  if (!facts) {
    ctx.undecided();
    return [
      unresolved(
        'strict_dietary_conflict',
        subject,
        'The shared inventory holds no food record for this venue.',
        'truth.food',
        'subject_not_in_inventory',
      ),
    ];
  }

  const cannot = new Set(safeArray(facts.cannotAccommodate).map(normaliseTag));
  const blocked = required.filter((requirement) => cannot.has(normaliseTag(requirement)));

  if (blocked.length > 0) {
    ctx.decided();
    return [
      report(
        'strict_dietary_conflict',
        'critical',
        subject,
        `${facts.name} states it cannot cater for ${blocked.join(' or ').replace(/_/g, ' ')}, which the traveller declared strict.`,
        'truth.food',
        { observed: { cannotAccommodate: blocked.join(',') } },
      ),
    ];
  }

  if (cannot.size === 0) {
    // The venue has published no limits, which is not the same as publishing that
    // it has none. Unknown, never a warning.
    ctx.undecided();
    return [
      unresolved(
        'strict_dietary_conflict',
        subject,
        `Nobody has confirmed whether ${facts.name} can cater for ${required.join(' and ').replace(/_/g, ' ')}.`,
        'truth.food',
        'not_applicable_unproven',
      ),
    ];
  }

  ctx.decided();
  return [];
}

/** Exported so a test can pin the dietary vocabulary join. */
export function dietaryConflict(
  required: readonly string[],
  cannotAccommodate: readonly string[],
): string[] {
  const cannot = new Set(cannotAccommodate.map(normaliseTag));
  return required.filter((requirement) => cannot.has(normaliseTag(requirement)));
}
