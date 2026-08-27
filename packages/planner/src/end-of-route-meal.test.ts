import { describe, expect, it } from 'vitest';
import type { ItineraryDay, QuestionnaireAnswers } from '@sidequest/core';
import { planTrip } from './plan';
import { DEFAULT_PLANNER_CONFIG } from './types';
import { buildScenario } from './testing/scenario';

/**
 * THE DAY WHOSE ROUTE FINISHES INSIDE LUNCHTIME STILL GETS LUNCH.
 *
 * This is the complement of `meal-window.test.ts`, and it exists because that
 * file's fix had a cost nothing was counting. Clamping the top of the lunch
 * window stopped a block headed "Lunch" being bolted onto the cursor at 16:02,
 * which was right — but lunch was only ever asked about at two points: before
 * each unit, and again once the traveller is back at base. A day with one long
 * stop on it falls straight between them. The traveller is standing at their
 * last stop at 14:04, inside the window, and nothing asks; the ride home takes
 * thirty-four minutes; the fallback at base then finds it is 14:38 and
 * correctly refuses. The day comes back with no meal on it at all.
 *
 * Measured over the sweep below when this was written: 3 of 540 days carried no
 * meal before the clamp, 18 after it, 12 with the third question added. The six
 * days recovered are exactly the ones where the route finished while it was
 * still lunchtime and there was room to eat — which is what the census states,
 * so it cannot be satisfied by serving lunch late instead.
 *
 * The nine that remain are days whose route runs past 14:30 before it ends.
 * Those carry `missing_meal_break`, which is the honest output for a day with no
 * minute in it to eat, and closing them needs a meal the product has no name
 * for yet.
 */

const CONFIG = DEFAULT_PLANNER_CONFIG;
const WINDOWS = CONFIG.mealWindows;

const PACES: readonly QuestionnaireAnswers['pace'][] = ['slow', 'balanced', 'fast'];
const DAY_STARTS: readonly QuestionnaireAnswers['dayStart'][] = ['early', 'normal', 'relaxed'];
const INTENSITIES: readonly QuestionnaireAnswers['dailyIntensity'][] = [
  'light',
  'moderate',
  'intense',
];
const DEPARTURES = ['09:00', '12:00', '15:00', '17:00', '20:00'] as const;

/**
 * When the day's last stop is behind the traveller.
 *
 * Read off the activities rather than off the clock, because the whole point of
 * the fix is that it inserts a meal *after* this minute — reading a travel leg
 * would move the measurement with the thing being measured and the census would
 * quietly stop covering the days it repaired.
 */
function routeEndOf(day: ItineraryDay): number | null {
  const last = day.items.filter((item) => item.kind === 'activity').at(-1);
  return last ? last.endMinute : null;
}

/** The leg home, whose length the traveller still owes after any meal. */
function wayHomeMinutes(day: ItineraryDay): number {
  const legs = day.items.filter((item) => item.kind === 'travel' && item.travel?.role === 'return');
  return legs.at(-1)?.durationMinutes ?? 0;
}

describe('a day that finishes its route at lunchtime eats', () => {
  it('never rides home past the lunch window with the day still unfed', () => {
    const offences: string[] = [];
    let plans = 0;
    let reachable = 0;

    for (const pace of PACES) {
      for (const dayStart of DAY_STARTS) {
        for (const dailyIntensity of INTENSITIES) {
          for (const departureTime of DEPARTURES) {
            const result = planTrip(
              buildScenario({
                answers: { pace, dayStart, dailyIntensity },
                basics: { departureTime },
              }),
            );
            if (!result.ok) continue;
            plans += 1;
            for (const day of result.itinerary.days) {
              const routeEnd = routeEndOf(day);
              if (routeEnd === null) continue;
              /*
               * The precondition is the whole of the property: the day is long
               * enough that the product itself says it owes a meal break, the
               * route ended while it was still lunchtime, and a bare lunch plus
               * the leg home still fitted inside the day. Outside that it is
               * either a day with no minute to eat in or a day that would have
               * missed its own end, and neither is this test's business.
               */
              const roomToEat =
                day.window.usableMinutes >= CONFIG.minDayMinutesForLunch &&
                routeEnd >= WINDOWS.lunch.earliest &&
                routeEnd <= WINDOWS.lunch.latest &&
                routeEnd + CONFIG.unplannedMealMinutes.lunch + wayHomeMinutes(day) <=
                  day.window.endMinute;
              if (!roomToEat) continue;
              reachable += 1;
              if (!day.items.some((item) => item.kind === 'meal')) {
                offences.push(
                  `${pace}/${dayStart}/${dailyIntensity} leaving ${departureTime}, day ${day.dayNumber}: last stop ended at minute ${routeEnd}, inside the lunch window, and the day carries no meal`,
                );
              }
            }
          }
        }
      }
    }

    /*
     * Both guards on the sweep itself. Without the second this passes on a
     * repository where no day ever finishes its route at lunchtime, which is
     * the shape the defect hid in.
     */
    expect(plans).toBeGreaterThan(100);
    expect(reachable, 'no day in the sweep finishes its route inside lunchtime').toBeGreaterThan(0);
    expect(
      offences.slice(0, 12),
      `${offences.length} days rode home from a lunchtime finish with nothing to eat`,
    ).toEqual([]);
    /*
     * A hundred and thirty-five whole trips, planned end to end. Around a second
     * and a half alone and past Vitest's five-second default on a machine
     * running several suites at once, which is how it is actually run. The
     * ceiling is stated rather than the sweep trimmed: every assertion above is
     * unchanged and the cells are what give the census its coverage.
     */
  }, 30_000);

  it('serves that lunch inside the lunch window rather than late', () => {
    /**
     * The negative control the census cannot carry on its own: feeding these
     * days by relaxing the clamp would satisfy it, and that is the defect
     * `meal-window.test.ts` exists to prevent. So one of the six is planned
     * again and its meals are read against the clock.
     */
    const result = planTrip(
      buildScenario({
        /*
         * The witness is searched for, not sacred: the shared frequency ledger
         * (§29 G) recomposed the sweep's plans, and the relaxed-start variant
         * of this combination no longer finishes its route inside lunchtime.
         * The early-start variant does — day 2's route ends at minute 742 —
         * and the property being asserted is unchanged.
         */
        answers: { pace: 'slow', dayStart: 'early', dailyIntensity: 'intense' },
        basics: { departureTime: '09:00' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const day = result.itinerary.days.find((entry) => entry.dayNumber === 2);
    expect(day, 'the scenario no longer has a second day').toBeDefined();
    if (!day) return;

    const routeEnd = routeEndOf(day);
    expect(routeEnd, 'day 2 no longer visits anywhere, so it is the wrong witness').not.toBeNull();
    expect(
      routeEnd!,
      'day 2 no longer finishes its route inside the lunch window, so it is the wrong witness',
    ).toBeLessThanOrEqual(WINDOWS.lunch.latest);

    const meals = day.items.filter((item) => item.kind === 'meal');
    expect(meals.length, 'day 2 came back with nothing to eat on it').toBeGreaterThan(0);
    for (const meal of meals) {
      const service = meal.startMinute + (meal.food?.walkMinutesFromRouting ?? 0);
      const window = WINDOWS[meal.food!.slot];
      expect(
        service,
        `"${meal.title}" (${meal.food!.slot}) is served at minute ${service}, past the window's ${window.latest}`,
      ).toBeLessThanOrEqual(window.latest);
    }
  });
});
