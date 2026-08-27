import { describe, expect, it } from 'vitest';
import type { OperatingHoursDataset, QuestionnaireAnswers } from '@sidequest/core';
import { EASTERN_SIERRA_HOURS, EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';

/**
 * PR-PLAN-15: "THERE WAS NO ROOM" MUST NOT BE SAID ABOUT A PLACE THAT WAS SHUT.
 *
 * `unscheduledFor` counted a place's available days from the *access*
 * resolution alone — whether a road, a shuttle or a service reaches it — and
 * never from the venue's own opening calendar. So the branch that says the
 * useful thing ("only N of your D days could have taken this, and those were
 * full") could not fire for a venue that simply is not open every day, and the
 * traveller got the generic bottom of the function instead: "There was no day
 * in these 5 with the hours and the travel budget left for it." That sentence
 * was printed, on a real plan, beside a completely empty mid-trip day with
 * eight and a quarter hours free on it — sending the traveller to look for room
 * they already had, over a place that is shut on the days they have.
 */

/** The golden hours, with the gondola open only at the weekend. */
function weekendOnlyGondola(): OperatingHoursDataset {
  return {
    ...EASTERN_SIERRA_HOURS,
    calendars: EASTERN_SIERRA_HOURS.calendars.map((calendar) =>
      calendar.placeId === 'panorama-gondola' && calendar.kind === 'scheduled'
        ? {
            ...calendar,
            periods: calendar.periods.map((period) => ({
              ...period,
              /* Friday and Saturday: two of the trip's four days (Wed–Sat). */
              daysOfWeek: [5, 6] as const as number[],
            })),
          }
        : calendar,
    ),
  } as OperatingHoursDataset;
}

describe('why a place was left off', () => {
  it('says a venue was open on fewer days than the trip has, not that there was no room', () => {
    /*
     * The fixture has to make the *hours* the binding refusal. Under the
     * shared frequency ledger (§29 G) the authored region's heavily
     * overlapping interests spend a traveller's scenic allowance long before
     * any day fills, so the gondola came back `frequency_reached` — a true
     * sentence about a different limit. Every other place is retyped to a
     * single rotating interest and the traveller grades them all `core`, so
     * the ledgers stay open, the days genuinely fill, and the only thing left
     * standing between the gondola and the plan is the two days it opens.
     */
    const result = planTrip(
      buildScenario({
        hours: weekendOnlyGondola(),
        selections: EASTERN_SIERRA_PLACES.map((place) => ({
          placeId: place.id,
          status: 'included' as const,
          source: 'auto' as const,
          updatedAt: '2026-07-30T00:00:00.000Z',
        })),
        places: EASTERN_SIERRA_PLACES.map((place, index) =>
          place.id === 'panorama-gondola'
            ? place
            : ({
                ...place,
                interests: [
                  (
                    [
                      'hiking',
                      'lakes_and_rivers',
                      'food_and_towns',
                      'geology_and_geothermal',
                      'easy_nature_walks',
                      'scenic_drives',
                      'photography_golden_hour',
                    ] as const
                  )[index % 7]!,
                ],
              } as typeof place),
        ),
        answers: {
          interests: {
            hiking: 'core',
            lakes_and_rivers: 'core',
            food_and_towns: 'core',
            geology_and_geothermal: 'core',
            easy_nature_walks: 'core',
            scenic_drives: 'core',
            photography_golden_hour: 'core',
            scenic_viewpoints: 'core',
          } as QuestionnaireAnswers['interests'],
        },
      }),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const left = result.itinerary.unscheduled.find(
      (entry) => entry.placeId === 'panorama-gondola',
    );
    expect(
      left,
      'the fixture must still leave the gondola off, or this asserts nothing',
    ).toBeDefined();
    if (!left) return;

    expect(left.reasonCode).toBe('hours_do_not_fit');
    expect(left.reason).toContain('only open on 2 of your 4 days');
    /* And the remedy has to be about the days it opens, not about room in general. */
    expect(left.suggestedRemedy ?? '').toMatch(/days it opens/);
  });
});
