import {
  DIETARY_NEED_LABELS,
  formatMinuteOfDay,
  MEDICAL_OR_OBSERVANT_NEEDS,
  needsExplicitEvidence,
  PRICE_BAND_ORDER,
  PRICE_BAND_WORDS,
  type FoodPlan,
  type ItineraryDay,
  type TravelerProfile,
  type ValidationIssue,
} from '@sidequest/core';
import { LONG_DAY_WITHOUT_FOOD_MINUTES, MAX_FOOD_DETOUR_MINUTES } from './food';
import type { PlannerConfig } from './types';

/**
 * THE FIFTH VALIDATION BLOCK, AND THE SOFTEST OF THEM.
 *
 * Four errors, and every one of them is a matter of record rather than an
 * opinion: a door that is shut at the hour we booked, a shop visited after the
 * food it was for was needed, a requirement the venue itself says it cannot
 * meet, and a stored summary that disagrees with its own timeline.
 *
 * Everything else is a caution. "Nothing good near this trailhead" and "that is
 * pricier than you said you wanted" are preferences, and blocking a trip on a
 * preference is how a traveller learns to scroll past the warning that would
 * have mattered. The weather layer settled this argument first and this block
 * follows it.
 *
 * One thing this block will never do is claim a venue is safe. The strongest
 * statement available anywhere in the food layer is "the venue published this",
 * and where nobody has published anything the output is a verification
 * reminder, not a reassurance.
 */
export interface FoodValidationInput {
  profile: TravelerProfile;
  config: PlannerConfig;
  foodPlan: FoodPlan;
  /** Whether food data reached the planner at all. */
  hadDataset: boolean;
}

export function validateDayFood(
  day: ItineraryDay,
  input: FoodValidationInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const meals = day.items.filter((item) => item.kind === 'meal');
  const { profile } = input;

  // A day with nothing at all on it is `missing_meal_break`'s business, in the
  // core validator. What this adds is the day that *has* meals and still leaves
  // a hole in the middle of itself.
  if (
    meals.length > 0 &&
    day.window.usableMinutes >= LONG_DAY_WITHOUT_FOOD_MINUTES &&
    longestGapWithoutFood(day) >= LONG_DAY_WITHOUT_FOOD_MINUTES
  ) {
    issues.push({
      code: 'long_day_without_food',
      severity: 'warning',
      message: `Day ${day.dayNumber} runs ${Math.round(
        longestGapWithoutFood(day) / 60,
      )} hours between one thing to eat and the next. Take something with you.`,
      dayNumber: day.dayNumber,
    });
  }

  for (const item of meals) {
    const food = item.food;
    if (!food) continue;

    /*
     * --- The door was open ------------------------------------------------
     *
     * Against the SERVICE, not the block. The timeline block deliberately opens
     * `walkMinutesFromRouting` before the meal and closes the same walk after
     * it, because that time is spent on this stop and hiding it would put a
     * walk inside somebody's lunch. Reading the block's own ends against the
     * opening hours therefore convicts every venue with a walk in front of it
     * by exactly that walk: a cafe opening at 11:30 was reported shut for a
     * meal whose block began at 11:29, one minute away on foot.
     *
     * Absent on plans stored before the walk was recorded, and zero is the
     * right reading there — those blocks were built without backing the walk
     * off, so their ends already are the service.
     */
    const walkIn = food.walkMinutesFromRouting ?? 0;
    const serviceStart = item.startMinute + walkIn;
    const serviceEnd = item.endMinute - walkIn;
    if (food.hours) {
      if (serviceStart < food.hours.openMinute) {
        issues.push({
          code: 'food_venue_closed_on_date',
          severity: 'error',
          message: `${food.venueName ?? item.title} is scheduled at ${formatMinuteOfDay(
            serviceStart,
          )} on day ${day.dayNumber} and does not open until ${formatMinuteOfDay(
            food.hours.openMinute,
          )}.`,
          dayNumber: day.dayNumber,
        });
      }
      if (serviceEnd > food.hours.closeMinute) {
        issues.push({
          code: 'meal_ends_after_venue_closes',
          severity: 'error',
          message: `${food.venueName ?? item.title} on day ${day.dayNumber} runs to ${formatMinuteOfDay(
            serviceEnd,
          )}, past the ${formatMinuteOfDay(food.hours.closeMinute)} we have for it.`,
          dayNumber: day.dayNumber,
        });
      }
      if (food.hours.confidence !== 'published') {
        issues.push({
          code: 'food_hours_unverified',
          severity: 'warning',
          message:
            food.hours.confidence === 'closing_time_estimated'
              ? `${food.venueName ?? item.title} publishes when it opens and not when it shuts. The closing time on day ${day.dayNumber} is ours, not theirs — ring before you rely on it.`
              : `Nobody at ${food.venueName ?? item.title} published the hours we used on day ${day.dayNumber}; they come from a listing rather than from the venue. Ring before you rely on them.`,
          dayNumber: day.dayNumber,
        });
      }
    }

    /*
     * --- The door nobody wrote down ---------------------------------------
     *
     * Same channel as an estimated closing time, because it is the same kind of
     * statement — what we hold about this venue's hours and where it came from —
     * and a second code would give the traveller two words for one doubt. What
     * the sentence may never contain is a time: there is not one.
     */
    if (food.hoursUnknown && food.stopKind === 'venue') {
      issues.push({
        code: 'food_hours_unverified',
        severity: 'warning',
        message: `Nobody publishes hours for ${food.venueName ?? item.title} that we could read, so the hour on day ${day.dayNumber} is the meal's rather than theirs. Check before you go, and have a second option in mind.`,
        dayNumber: day.dayNumber,
      });
    }

    /**
     * --- Provenance -------------------------------------------------------
     *
     * A name with nothing at all behind it, which is still an error.
     *
     * `hoursUnknown` is the exemption and it is the whole of §8's naming rule:
     * a venue whose own record answers "we could not read an opening time" has
     * been sourced — it has a name, a position and a provenance — and what is
     * missing is a calendar, which the caution above states. Before that
     * distinction existed this branch fired on every such venue, so the only way
     * to satisfy the validator was to withhold the name, which is how three
     * delivered trips came to hold thirty-one meals and no places.
     */
    if (food.stopKind === 'venue' && food.venueName && !food.hours && !food.hoursUnknown) {
      issues.push({
        code: 'food_venue_missing_provenance',
        severity: 'error',
        message: `${food.venueName} is named on day ${day.dayNumber} with no opening hours behind it. We will not put a name on a plan we cannot source.`,
        dayNumber: day.dayNumber,
      });
    }

    /**
     * Dietary — and the one place this block came closest to doing real harm.
     *
     * "Nobody has confirmed it" was an *error* for any medical or observant
     * need. Nothing in this region's data carries a nut-allergy or halal claim,
     * so every meal errored, every day was rebuilt without its food, and a
     * traveller with an allergy got a trip with no named meals on it at all —
     * then read that their choices "did not fit the route", which was not why.
     *
     * An unanswered question is a caution however much it matters. The strength
     * of the need changes the words, not the severity, and the traveller is the
     * one who decides what to do about it. The error is reserved for the one
     * thing that is a matter of record: a venue that has said it cannot.
     */
    for (const need of food.stopKind === 'grocery' ? [] : food.dietaryUnverified) {
      const strict = needsExplicitEvidence(need, profile.food.dietaryStrict);
      issues.push({
        code: 'dietary_support_unverified',
        severity: 'warning',
        message: strict
          ? `Nobody has confirmed how ${food.venueName ?? item.title} handles ${DIETARY_NEED_LABELS[
              need
            ].toLowerCase()}, and you told us that is a requirement rather than a preference. Ring them before day ${day.dayNumber}, or carry something you know about.`
          : `${food.venueName ?? item.title} on day ${day.dayNumber} has nothing on record about ${DIETARY_NEED_LABELS[
              need
            ].toLowerCase()}. That is not the same as it being a problem — it means nobody has said.`,
        dayNumber: day.dayNumber,
      });
    }

    /**
     * The venue's own no. Unreachable today, because a blocked venue is dropped
     * before it can be scheduled — kept because that is exactly the kind of
     * guarantee that stops being true when somebody adds a path.
     */
    for (const claim of food.dietary) {
      if (claim.evidence !== 'venue_states_unsuitable') continue;
      issues.push({
        code: 'strict_dietary_conflict',
        severity: 'error',
        message: `${food.venueName ?? item.title} on day ${day.dayNumber} says it cannot do ${DIETARY_NEED_LABELS[
          claim.need
        ].toLowerCase()}, and you told us you need it. ${claim.note}`,
        dayNumber: day.dayNumber,
      });
    }

    // --- Bookings ---------------------------------------------------------
    if (
      food.reservation &&
      (food.reservation.requirement === 'required' || food.reservation.requirement === 'recommended')
    ) {
      issues.push({
        code: 'food_reservation_unresolved',
        severity: 'warning',
        message: `${food.venueName ?? item.title} on day ${day.dayNumber} ${
          food.reservation.requirement === 'required'
            ? 'will not seat you without a booking'
            : 'asks you to book ahead'
        }. We have not made one.`,
        dayNumber: day.dayNumber,
      });
    }

    // --- Detour -----------------------------------------------------------
    const ceiling = Math.min(profile.derived.effectiveDetourMinutes, MAX_FOOD_DETOUR_MINUTES);
    if (!food.isSpecialMeal && food.detourMinutes > ceiling) {
      issues.push({
        code: 'food_detour_exceeds_tolerance',
        severity: 'warning',
        message: `Getting to ${food.venueName ?? item.title} and back on day ${day.dayNumber} adds ${
          food.detourMinutes
        } min of ${profile.transport.willDrive ? 'driving' : 'walking'}, past the ${ceiling} min we hold meals to.`,
        dayNumber: day.dayNumber,
      });
    }

    // --- Budget -----------------------------------------------------------
    if (
      food.priceBand &&
      !food.isSpecialMeal &&
      PRICE_BAND_ORDER[food.priceBand] > PRICE_BAND_ORDER[profile.food.everydayPriceBand]
    ) {
      issues.push({
        code: 'food_budget_mismatch',
        severity: 'warning',
        message: `${food.venueName ?? item.title} on day ${day.dayNumber} is ${PRICE_BAND_WORDS[
          food.priceBand
        ].toLowerCase()}, above the everyday spending you asked for.`,
        dayNumber: day.dayNumber,
      });
    }

    // --- Packed food, and where it came from ------------------------------
    if (food.stopKind === 'packed' && food.preparedOnDayNumber === undefined) {
      issues.push({
        code: 'packed_food_without_preparation',
        severity: 'warning',
        message: `Day ${day.dayNumber} has you eating a lunch you brought, and nothing on this plan is where you bought it. Pick something up in town before you set off.`,
        dayNumber: day.dayNumber,
      });
    }
    if (
      food.stopKind === 'grocery' &&
      food.suppliesDayNumber !== undefined &&
      food.suppliesDayNumber < day.dayNumber
    ) {
      issues.push({
        code: 'grocery_after_supplies_needed',
        severity: 'error',
        message: `The shopping on day ${day.dayNumber} is for day ${food.suppliesDayNumber}, which has already happened.`,
        dayNumber: day.dayNumber,
      });
    }
  }

  // --- Nothing verified fitted this day -----------------------------------
  if (
    input.hadDataset &&
    meals.length > 0 &&
    !meals.some((item) => item.food?.stopKind === 'venue' || item.food?.stopKind === 'packed')
  ) {
    /*
     * The same finding, told at whichever resolution the day actually reached.
     * A day that fell back to an area has been given somewhere to go and the
     * warning says what is missing from it; a day with no area at all is the
     * older, blunter case and keeps the older, blunter sentence.
     */
    const areas = [
      ...new Set(
        meals
          .map((item) => item.food?.areaName)
          .filter((name): name is string => name !== undefined),
      ),
    ];
    issues.push({
      code: 'no_verified_food_option',
      severity: 'warning',
      message:
        areas.length > 0
          ? `Nothing we can vouch for was open and near enough to day ${day.dayNumber}'s route, so its meals point at ${areas.join(' and ')} rather than at a place. Which one is yours to pick.`
          : `Nothing we can vouch for was open and near enough to day ${day.dayNumber}'s route, so its meals are time held rather than places. You will be picking somewhere yourself.`,
      dayNumber: day.dayNumber,
    });
  }

  // --- The day's own summary must match its own timeline -------------------
  const summaryPacked = day.food.remote;
  const timelinePacked = meals.some((item) => item.food?.stopKind === 'packed');
  if (timelinePacked && !summaryPacked) {
    issues.push({
      code: 'food_plan_inconsistent',
      severity: 'error',
      message: `Day ${day.dayNumber} schedules a packed lunch but its food summary does not say why.`,
      dayNumber: day.dayNumber,
    });
  }

  return issues;
}

/** Trip-level food checks, run once over the finished plan. */
export function validateTripFood(
  days: readonly ItineraryDay[],
  input: FoodValidationInput,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { foodPlan, profile } = input;

  if (!input.hadDataset) {
    issues.push({
      code: 'food_data_unavailable',
      severity: 'warning',
      message:
        'We have no food data for this region, so nothing below names anywhere to eat. The meal times are held; the choices are yours.',
    });
  }

  if (foodPlan.specialMealsPlanned > foodPlan.specialMealBudget) {
    issues.push({
      code: 'special_meal_quota_exceeded',
      severity: 'warning',
      message: `This plan has ${foodPlan.specialMealsPlanned} meals meant to be an event, and you asked for ${foodPlan.specialMealBudget} across a trip this length.`,
    });
  }

  /**
   * The same place twice.
   *
   * Counted across the whole trip rather than day by day, because that is what
   * the traveller sees — and because the per-day version could not report a
   * venue used twice on one day at all, which is exactly the case that reads
   * worst: the shop you bought breakfast at, again for lunch.
   */
  const uses = new Map<string, { name: string; days: number[] }>();
  for (const day of days) {
    for (const item of day.items) {
      const venueId = item.food?.venueId;
      if (!venueId) continue;
      const entry = uses.get(venueId) ?? { name: item.food!.venueName ?? venueId, days: [] };
      entry.days.push(day.dayNumber);
      uses.set(venueId, entry);
    }
  }
  for (const [, entry] of [...uses.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (entry.days.length < 2) continue;
    const distinctDays = [...new Set(entry.days)].sort((a, b) => a - b);
    issues.push({
      code: 'duplicate_food_venue',
      severity: 'warning',
      /*
       * The count and the days have to describe the same set.
       *
       * They did not: the count was every meal and the list was the distinct
       * days, so a venue taking breakfast and lunch on day 4 and breakfast on
       * day 5 read "is on this plan 3 times, on days 4 and 5" — a sentence that
       * does not add up, about the traveller's own trip. The count is now the
       * meals and the days say how they fall across them.
       */
      message: `${entry.name} is on this plan ${entry.days.length} times, ${
        distinctDays.length === 1
          ? `both on day ${distinctDays[0]}`
          : `across ${distinctDays.length} days — ${distinctDays.join(' and ')}`
      }. It was the closest thing that worked each time.`,
    });
  }

  for (const choice of foodPlan.unusedChoices) {
    issues.push({
      code: 'food_choice_unscheduled',
      severity: 'error',
      message: `${choice.name} is somewhere you asked to eat and it is not on the plan. ${choice.reason}`,
    });
  }

  /**
   * The one sentence that has to be right.
   *
   * A traveller with a medical or observant requirement is told, once, at the
   * top, that everything below is a menu claim rather than a kitchen one. It is
   * a reminder rather than a warning: nothing here is wrong, and pretending
   * otherwise would bury the days where something actually is.
   */
  const medical = profile.food.dietaryNeeds.filter((need) =>
    MEDICAL_OR_OBSERVANT_NEEDS.includes(need),
  );
  if ((profile.food.dietaryStrict || medical.length > 0) && days.length > 0) {
    issues.push({
      code: 'dietary_support_unverified',
      severity: 'warning',
      message:
        'Where a venue below says it can do something, those are its words and we quote them. None of it establishes how a kitchen is run or what a dish is prepared beside, so confirm anything you cannot risk directly with them.',
    });
  }

  return issues;
}

/**
 * The longest stretch of the day with nothing to eat in it.
 *
 * Measured between meal blocks and the ends of the day, so a nine-hour walk with
 * a coffee at the start and a dinner at the end does not read as fed. Stated as
 * a product rule about the plan — how long it leaves somebody without an option
 * — and never as a claim about what that does to a person.
 */
function longestGapWithoutFood(day: ItineraryDay): number {
  const marks = [
    day.window.startMinute,
    // A twenty-minute supermarket run at dawn is not a meal, and counting it as
    // one suppressed the warning about the nine hours that followed it.
    ...day.items
      .filter((item) => item.kind === 'meal' && item.food?.stopKind !== 'grocery')
      .map((item) => item.startMinute),
    day.window.endMinute,
  ].sort((a, b) => a - b);

  let longest = 0;
  for (let index = 0; index + 1 < marks.length; index += 1) {
    longest = Math.max(longest, marks[index + 1]! - marks[index]!);
  }
  return longest;
}
