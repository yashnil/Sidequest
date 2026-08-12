import { describe, expect, it } from 'vitest';
import type { QuestionnaireAnswers } from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';

/**
 * PR-PLAN-12: AN ORDINARY QUESTIONNAIRE ALWAYS GETS AN ITINERARY.
 *
 * The planner is allowed to refuse. It is allowed to refuse when the region has
 * nothing reachable, when the traveller rules out every way of getting around,
 * when the days are too short to hold anything they asked for. What it is not
 * allowed to do is refuse a trip it could plan for a traveller who answered the
 * questionnaire in one of the ordinary ways — and until this file existed
 * nothing in the suite measured that at all, because every scenario test picks
 * one set of answers and the golden set is a set that works.
 *
 * The gap let through a real one. `planTrip` lays each day out twice, plain and
 * with the meals on, and `foodFits` decided between them without ever checking
 * the clock: on a short departure day breakfast shifted the return drive a
 * minute past the window, `item_outside_window` is an error, the reviser has no
 * move that shortens a meal, and the refusal gate threw the whole trip away.
 * Thirty-two of the four hundred and five combinations below got no itinerary
 * at all. Every one of them planned fine with the food data removed.
 *
 * So the property is a sweep, not a case: no combination of the five answers a
 * traveller cannot avoid giving — how fast, how early, how hard, and the two
 * times the flights decide — may cost them the trip.
 */

/** The answers every traveller gives, and every value the questionnaire offers. */
const PACES: readonly QuestionnaireAnswers['pace'][] = ['slow', 'balanced', 'fast'];
const DAY_STARTS: readonly QuestionnaireAnswers['dayStart'][] = ['early', 'normal', 'relaxed'];
const INTENSITIES: readonly QuestionnaireAnswers['dailyIntensity'][] = [
  'light',
  'moderate',
  'intense',
];
/**
 * Arrival and departure clocks worth sweeping.
 *
 * Not a random sample: these are the hours that make an edge day *short*, which
 * is where a day's finish and the day's window are close enough together for a
 * coffee to decide the question. A grid that only ever landed at nine and left
 * at eight would have passed throughout.
 */
const ARRIVALS = ['09:00', '13:00', '17:00'] as const;
const DEPARTURES = ['09:00', '12:00', '15:00', '17:00', '20:00'] as const;

describe('every ordinary questionnaire gets a plan', () => {
  it('plans all 405 pace x start x intensity x arrival x departure combinations', () => {
    const refused: string[] = [];
    let planned = 0;

    for (const pace of PACES) {
      for (const dayStart of DAY_STARTS) {
        for (const dailyIntensity of INTENSITIES) {
          for (const arrivalTime of ARRIVALS) {
            for (const departureTime of DEPARTURES) {
              const result = planTrip(
                buildScenario({
                  answers: { pace, dayStart, dailyIntensity },
                  basics: { arrivalTime, departureTime },
                }),
              );
              if (result.ok) {
                planned += 1;
                continue;
              }
              refused.push(
                `${pace}/${dayStart}/${dailyIntensity} arriving ${arrivalTime}, leaving ${departureTime}: ${result.code} — ${result.message}`,
              );
            }
          }
        }
      }
    }

    // Named in full when it breaks: the point of the sweep is that the message
    // tells you which answers cost the traveller their trip, not merely that
    // some did.
    expect(refused, `${refused.length} of 405 refused:\n${refused.join('\n')}`).toEqual([]);
    expect(planned).toBe(405);
    /*
     * Four hundred and five real plans, about four seconds of them alone and
     * over five when the rest of the suite is running beside it. The timeout is
     * raised rather than the grid trimmed: every cell here is a questionnaire a
     * traveller can actually fill in, and the defect this file exists for showed
     * up in thirty-two of them. Nothing about the assertions is relaxed.
     */
  }, 60_000);

  /**
   * The smallest of the thirty-two, kept as a case of its own.
   *
   * A one-minute overrun on the last drive home is the whole defect, and a
   * failure here says so in one line where the sweep says it in thirty-two.
   * Asserted on the finished plan rather than on the refusal: what the
   * traveller must get is a plan whose days end when their days end.
   */
  it('keeps the departure-day drive home inside the window when a meal is added to it', () => {
    const result = planTrip(
      buildScenario({
        answers: { pace: 'slow', dayStart: 'normal', dailyIntensity: 'moderate' },
        basics: { arrivalTime: '09:00', departureTime: '12:00' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const last = result.itinerary.days.at(-1)!;
    const overruns = last.items.filter((item) => item.endMinute > last.window.endMinute);
    expect(
      overruns.map((item) => `${item.title} ends ${item.endMinute}, window ends ${last.window.endMinute}`),
    ).toEqual([]);
    expect(
      result.itinerary.issues.filter((issue) => issue.code === 'item_outside_window'),
    ).toEqual([]);
  });
});
