import { describe, expect, it } from 'vitest';
import type { OperatingHoursDataset } from '@sidequest/core';
import { EASTERN_SIERRA_HOURS } from '@sidequest/core/data';
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
    const result = planTrip(buildScenario({ hours: weekendOnlyGondola() }));
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
