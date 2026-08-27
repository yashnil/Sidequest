import { describe, expect, it } from 'vitest';
import { MAX_TIMES_ONE_VENUE_IS_NAMED } from './food';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';

/**
 * ONE DOOR, NAMED UNTIL THE TRIP STOPS READING AS A PLAN.
 *
 * Live evidence, a car-free metropolitan trip on the corrected food layer: the
 * same cafe was named **six times** — lunch and dinner on three consecutive
 * days. Seventeen venues were compiled and exactly one sat close enough to the
 * day's route to be usable, so the variety rule (a score penalty of −400) was
 * ordering a shortlist of one. A penalty orders; it cannot bound.
 *
 * The supply is what has to be narrow for this to reproduce, which is why the
 * scenario's food dataset is cut to a single venue rather than left as the
 * region's own: the shared world fixtures all carry enough doors that no repeat
 * arises, and a test built on one of those would have gone green against the
 * defect. Everything else is the production planner.
 */
describe('how often one venue may be named', () => {
  const scenarioWithOneVenue = () => {
    const rich = buildScenario();
    const dataset = rich.food;
    if (!dataset || dataset.venues.length === 0) {
      throw new Error('the scenario has no food data to narrow');
    }
    return buildScenario({ food: { ...dataset, venues: [dataset.venues[0]!] } });
  };

  const timesEachVenueIsNamed = (): Map<string, number> => {
    const result = planTrip(scenarioWithOneVenue());
    const counts = new Map<string, number>();
    if (!result.ok) return counts;
    for (const day of result.itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'meal') continue;
        const named = item.food?.venueName;
        if (named === undefined) continue;
        counts.set(named, (counts.get(named) ?? 0) + 1);
      }
    }
    return counts;
  };

  it('never names the only door past the cap, however many slots want it', () => {
    const counts = timesEachVenueIsNamed();
    expect(
      [...counts.values()].reduce((sum, count) => sum + count, 0),
      'no meal was named at all, so this fixture proves nothing',
    ).toBeGreaterThan(0);
    for (const [venue, count] of counts) {
      expect(count, `${venue} was named ${count} times`).toBeLessThanOrEqual(
        MAX_TIMES_ONE_VENUE_IS_NAMED,
      );
    }
  });
});
