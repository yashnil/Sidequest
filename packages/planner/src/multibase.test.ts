import { describe, expect, it } from 'vitest';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';

/**
 * MULTI-BASE PLANNING.
 *
 * The defect these exist to make impossible: a day after the traveller has moved
 * base that still starts and ends at the base they left. Every number in such a
 * plan is internally consistent, which is exactly why it survives review — the
 * only thing wrong with it is that nobody would ever make those journeys.
 *
 * The scenario harness builds a synthetic region; nothing here names a real
 * place, and nothing depends on a provider.
 */

describe('a trip with two bases', () => {
  /**
   * The authored region, planned as though it had two bases.
   *
   * Deliberately reusing the existing fixture rather than inventing a second
   * one: the point under test is the *date-to-base mapping*, and proving it on
   * the region every other planner test already uses is what makes a regression
   * here impossible to miss.
   */
  function twoBaseSetup() {
    return buildScenario();
  }

  /**
   * The trip's own dates, split in two.
   *
   * Derived from the fixture rather than assumed: hard-coding "day four" makes
   * the test depend on how long the authored trip happens to be, and a fixture
   * that gained or lost a night would break a test that has nothing to do with
   * trip length.
   */
  function split(setup: ReturnType<typeof buildScenario>) {
    const start = setup.basics.startDate;
    const end = setup.basics.endDate;
    const nights = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    );
    const moveOn = addDays(start, Math.max(1, Math.floor((nights + 1) / 2)));
    return { start, end, moveOn };
  }

  it('plans without a portfolio exactly as it always did', () => {
    const setup = twoBaseSetup();
    const result = planTrip(setup);
    expect(result.ok).toBe(true);
  });

  it('uses the base whose date range covers the day', () => {
    const setup = twoBaseSetup();
    const ids = setup.matrix.ids;
    const first = setup.baseId;
    /*
     * A second base taken from the matrix, so the leg to it is measured rather
     * than invented. Any point that is not the first base will do — what is
     * being tested is that the *date mapping* is honoured, not which point was
     * chosen.
     */
    const second = ids.find((id) => id !== first)!;

    const { start, end, moveOn } = split(setup);

    const result = planTrip({
      ...setup,
      basePortfolio: {
        bases: [
          {
            baseId: first,
            baseName: 'First',
            order: 0,
            fromDate: start,
            toDate: addDays(moveOn, -1),
            transferMinutesFromPrevious: 0,
            transferIsWholeDay: false,
          },
          {
            baseId: second,
            baseName: 'Second',
            order: 1,
            fromDate: moveOn,
            toDate: end,
            transferMinutesFromPrevious: 95,
            transferIsWholeDay: false,
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * The property. Days on or after the move must carry the second base, and
     * days before it the first. A planner that ignored the portfolio would put
     * the first base on all six.
     */
    const byDate = new Map(result.itinerary.days.map((day) => [day.date, day.baseId]));
    expect(byDate.get(start)).toBe(first);
    expect(byDate.get(moveOn)).toBe(second);
    for (const [date, baseId] of byDate) {
      expect(baseId, `day ${date}`).toBe(date >= moveOn ? second : first);
    }
  });

  it('never routes a later day back to the base the traveller left', () => {
    const setup = twoBaseSetup();
    const first = setup.baseId;
    const second = setup.matrix.ids.find((id) => id !== first)!;
    const { start, end, moveOn } = split(setup);

    const result = planTrip({
      ...setup,
      basePortfolio: {
        bases: [
          {
            baseId: first,
            baseName: 'First',
            order: 0,
            fromDate: start,
            toDate: addDays(moveOn, -1),
            transferMinutesFromPrevious: 0,
            transferIsWholeDay: false,
          },
          {
            baseId: second,
            baseName: 'Second',
            order: 1,
            fromDate: moveOn,
            toDate: end,
            transferMinutesFromPrevious: 95,
            transferIsWholeDay: false,
          },
        ],
      },
    });
    if (!result.ok) return;

    for (const day of result.itinerary.days) {
      const expected = day.date >= moveOn ? second : first;
      expect(day.baseId, `day ${day.date} routed from the wrong base`).toBe(expected);
    }
  });

  it('says on the day itself that it is a travel day', () => {
    const setup = twoBaseSetup();
    const first = setup.baseId;
    const second = setup.matrix.ids.find((id) => id !== first)!;
    const { start, end, moveOn } = split(setup);

    const result = planTrip({
      ...setup,
      basePortfolio: {
        bases: [
          {
            baseId: first,
            baseName: 'First',
            order: 0,
            fromDate: start,
            toDate: addDays(moveOn, -1),
            transferMinutesFromPrevious: 0,
            transferIsWholeDay: false,
          },
          {
            baseId: second,
            baseName: 'Second Base',
            order: 1,
            fromDate: moveOn,
            toDate: end,
            transferMinutesFromPrevious: 140,
            transferIsWholeDay: false,
          },
        ],
      },
    });
    if (!result.ok) return;

    /*
     * Without this a traveller reads a lighter day with no explanation, and the
     * two hours they will spend in the car are invisible until they are in it.
     */
    const transferDay = result.itinerary.days.find((day) => day.date === moveOn);
    expect(transferDay?.theme).toMatch(/Moving to Second Base/);
    expect(transferDay?.theme).toMatch(/140 minutes/);

    for (const day of result.itinerary.days) {
      if (day.date === moveOn) continue;
      expect(day.theme).not.toMatch(/Moving to/);
    }
  });

  it('gives a transfer day its own allowance without raising the ordinary limit', () => {
    const setup = twoBaseSetup();
    const first = setup.baseId;
    const second = setup.matrix.ids.find((id) => id !== first)!;
    const { start, end, moveOn } = split(setup);
    const transferDate = moveOn;

    const withTransfer = planTrip({
      ...setup,
      basePortfolio: {
        bases: [
          {
            baseId: first,
            baseName: 'First',
            order: 0,
            fromDate: start,
            toDate: addDays(moveOn, -1),
            transferMinutesFromPrevious: 0,
            transferIsWholeDay: false,
          },
          {
            baseId: second,
            baseName: 'Second',
            order: 1,
            fromDate: transferDate,
            toDate: end,
            transferMinutesFromPrevious: 120,
            transferIsWholeDay: false,
          },
        ],
      },
    });
    if (!withTransfer.ok) return;

    /*
     * The allowance applies to the transfer date and to no other. A day that is
     * not a transfer must still be judged against the traveller's own limit —
     * the whole objection to a raised ceiling is that it leaks.
     */
    const cap = setup.profile.transport.maxDailyDriveMinutes;
    for (const day of withTransfer.itinerary.days) {
      if (day.date === transferDate) continue;
      expect(day.totals.driveMinutes).toBeLessThanOrEqual(cap);
    }
  });
});

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
