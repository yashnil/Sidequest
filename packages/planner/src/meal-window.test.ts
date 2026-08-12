import { describe, expect, it } from 'vitest';
import type { QuestionnaireAnswers } from '@sidequest/core';
import { planTrip } from './plan';
import { DEFAULT_PLANNER_CONFIG } from './types';
import { buildScenario } from './testing/scenario';

/**
 * PR-PLAN-13: A MEAL IS NAMED FOR THE HOUR IT HAPPENS AT.
 *
 * The lunch clamp read `Math.max(cursor, lunch.earliest)` and nothing at the
 * other end, so it could only ever move lunch *later*. On a day whose route ran
 * straight through the middle of itself the fallback bolted a forty-five minute
 * block headed "Lunch" onto the cursor wherever it happened to be — 16:02 at
 * the worst, on 41% of the plans in the sweep below, and on 42 of those days
 * there was no dinner either, so the traveller's whole afternoon meal was
 * scheduled at four o'clock and called lunch.
 *
 * The window is the product's own definition of when lunch is lunch. Nothing in
 * the validator had anything to say about a meal outside it, which is why the
 * regression from 28% at the previous release went unmeasured. This is the
 * measurement.
 */

const WINDOWS = DEFAULT_PLANNER_CONFIG.mealWindows;

const PACES: readonly QuestionnaireAnswers['pace'][] = ['slow', 'balanced', 'fast'];
const DAY_STARTS: readonly QuestionnaireAnswers['dayStart'][] = ['early', 'normal', 'relaxed'];
const INTENSITIES: readonly QuestionnaireAnswers['dailyIntensity'][] = [
  'light',
  'moderate',
  'intense',
];
const DEPARTURES = ['09:00', '12:00', '15:00', '17:00', '20:00'] as const;

describe('meals sit inside their own windows', () => {
  it('never schedules a block in a slot the clock has already left', () => {
    const offences: string[] = [];
    let plans = 0;
    let mealsSeen = 0;

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
              for (const item of day.items) {
                if (item.kind !== 'meal' || !item.food) continue;
                mealsSeen += 1;
                const window = WINDOWS[item.food.slot];
                /*
                 * Read at the *service* minute — the block starts when the
                 * traveller sets off for it, and the walk to the door belongs to
                 * the journey, not to the meal.
                 */
                const service = item.startMinute + (item.food.walkMinutesFromRouting ?? 0);
                if (service > window.latest) {
                  offences.push(
                    `${pace}/${dayStart}/${dailyIntensity} leaving ${departureTime}, day ${day.dayNumber}: "${item.title}" (${item.food.slot}) served at minute ${service}, past the window's ${window.latest}`,
                  );
                }
              }
            }
          }
        }
      }
    }

    /* Both guards on the sweep itself: it has to have planned, and to have eaten. */
    expect(plans).toBeGreaterThan(100);
    expect(mealsSeen).toBeGreaterThan(100);
    expect(
      offences.slice(0, 12),
      `${offences.length} meals were served outside their own slot's window`,
    ).toEqual([]);
  });
});
