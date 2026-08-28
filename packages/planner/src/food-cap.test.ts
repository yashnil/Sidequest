import { describe, expect, it } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';
import { MAX_TIMES_ONE_VENUE_IS_NAMED } from './food';

/**
 * THE VARIETY CAP, HELD WHERE THE NAMING HAPPENS.
 *
 * `MAX_TIMES_ONE_VENUE_IS_NAMED` was enforced against a tally of *heads of
 * shortlists*, incremented one phase before layout. `chooseFoodStop` then
 * re-sorts each shortlist by legality and real detour, so a runner-up wins
 * slots without its tally ever moving — the cap bounded who was likeliest to be
 * named rather than who was.
 *
 * Measured on the primary fixture at ordinary trip lengths, with no overrides:
 *
 *   7 days   Mammoth Brewing Company ×3, Old New York Deli & Bakery Co. ×3
 *            — including breakfast *and* lunch at the deli on day 4, and the
 *              deli again on day 5 morning
 *  10 days   Mammoth Brewing Company ×4, Old New York Deli & Bakery Co. ×5
 *
 * The fix is a ledger of what each *settled day* named, which later days read.
 * It keeps the rule `resolveFood` states — the packer re-lays a day out many
 * times, so `chooseFoodStop` may not remember an *attempt* — because a finished
 * day is the same finished day however many attempts reached it.
 */

function namedVenues(itinerary: Itinerary): Map<string, number> {
  const counts = new Map<string, number>();
  for (const day of itinerary.days) {
    for (const item of day.items) {
      const id = item.food?.venueId;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function planOver(startDate: string, endDate: string): Itinerary {
  const result = planTrip(buildScenario({ basics: { startDate, endDate } }));
  if (!result.ok) throw new Error(`the scenario did not plan: ${result.message}`);
  return result.itinerary;
}

/** The lengths the breach was measured at, and one short enough to be clean. */
const LENGTHS: [string, string][] = [
  ['2026-08-12', '2026-08-16'],
  ['2026-08-12', '2026-08-18'],
  ['2026-08-12', '2026-08-21'],
];

describe('how many times one venue may be named', () => {
  it('names venues at all, on every length, or these assertions are empty', () => {
    for (const [start, end] of LENGTHS) {
      const counts = namedVenues(planOver(start, end));
      expect([...counts.values()].reduce((sum, n) => sum + n, 0), `${start}..${end}`).toBeGreaterThan(
        MAX_TIMES_ONE_VENUE_IS_NAMED,
      );
    }
  });

  it('never names one past the cap, at any trip length', () => {
    for (const [start, end] of LENGTHS) {
      for (const [venueId, used] of namedVenues(planOver(start, end))) {
        expect(used, `${venueId} on ${start}..${end}`).toBeLessThanOrEqual(
          MAX_TIMES_ONE_VENUE_IS_NAMED,
        );
      }
    }
  });

  it('spends the allowance on variety rather than on fewer meals', () => {
    /*
     * The cost this fix had to not pay. Capping the repeat must send the slot
     * to a different door where one exists, not to a held hour — measured
     * against the seven-day plan, which is where the breach first appeared.
     */
    const capped = planOver('2026-08-12', '2026-08-18');
    const distinct = namedVenues(capped).size;
    expect(distinct).toBeGreaterThan(4);
  });

  it('counts the meals and the days consistently when it does warn', () => {
    /*
     * The warning read "is on this plan 3 times, on days 4 and 5" — the count
     * was meals and the list was distinct days, so the sentence did not add up.
     */
    for (const [start, end] of LENGTHS) {
      for (const issue of planOver(start, end).issues) {
        if (issue.code !== 'duplicate_food_venue') continue;
        const times = Number(/ (\d+) times/.exec(issue.message)?.[1]);
        const days = [...issue.message.matchAll(/day (\d+)/g)].length
          + (/across (\d+) days/.exec(issue.message) ? Number(/across (\d+) days/.exec(issue.message)![1]) : 0);
        expect(times, issue.message).toBeGreaterThanOrEqual(2);
        expect(days, issue.message).toBeGreaterThan(0);
        // "N times, both on day D" is the only form that may name one day.
        if (/both on day/.test(issue.message)) continue;
        expect(issue.message, issue.message).toMatch(/across \d+ days/);
      }
    }
  });
});
