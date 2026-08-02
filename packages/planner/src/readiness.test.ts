import { describe, expect, it } from 'vitest';
import { plannerReadinessSchema, type UnscheduledPlace } from '@sidequest/core';
import { planTrip } from './plan';
import { buildPlannerReadiness } from './readiness';
import { buildScenario } from './testing/scenario';

/**
 * A PLAN WITH NO STOPS IS NOT A PLAN.
 *
 * These exist because a live Bali compilation produced five dated days, a
 * transport strategy, a food plan, a status of `ready_with_cautions` and **zero
 * stops** — and would have shown it to a traveller as their trip. The single
 * sentence explaining it was a warning sitting beneath seven food warnings.
 *
 * The cause was not a bug in any one layer. Every candidate was reachable and
 * open; the nearest was a 157-minute round trip from the base against the
 * traveller's own 150-minute daily driving limit. Zero stops was the *correct*
 * answer, and presenting it as an itinerary was not.
 */

function rejection(reasonCode: UnscheduledPlace['reasonCode'], name: string): UnscheduledPlace {
  return { placeId: name, name, wasManual: false, reasonCode, reason: 'Because.' };
}

describe('planner readiness', () => {
  it('is schema-valid and counts every rejection exactly once', () => {
    const readiness = buildPlannerReadiness({
      consideredCount: 37,
      selectedCount: 9,
      eligibleCount: 9,
      feasibleCount: 9,
      scheduledCount: 0,
      dayCount: 5,
      unscheduled: [
        rejection('exceeds_daily_travel', 'A'),
        rejection('exceeds_daily_travel', 'B'),
        rejection('exceeds_daily_travel', 'C'),
        rejection('hours_do_not_fit', 'D'),
      ],
    });

    expect(() => plannerReadinessSchema.parse(readiness)).not.toThrow();
    expect(readiness.rejections.reduce((sum, entry) => sum + entry.count, 0)).toBe(4);
    // Largest first, so the answer is the first thing read.
    expect(readiness.rejections[0]?.reasonCode).toBe('exceeds_daily_travel');
    expect(readiness.rejections[0]?.examples).toEqual(['A', 'B', 'C']);
  });

  it('reproduces the live Bali shape: everything reachable, nothing schedulable', () => {
    const readiness = buildPlannerReadiness({
      consideredCount: 37,
      selectedCount: 9,
      eligibleCount: 9,
      feasibleCount: 9,
      scheduledCount: 0,
      dayCount: 5,
      unscheduled: Array.from({ length: 9 }, (_, index) =>
        rejection('exceeds_daily_travel', `Place ${index}`),
      ),
    });

    expect(readiness.dominantBlockers).toHaveLength(1);
    expect(readiness.dominantBlockers[0]?.reasonCode).toBe('exceeds_daily_travel');
    expect(readiness.summary).toContain('9 of the 9 places you picked were reachable and open');
    expect(readiness.summary).toContain('further than you said you would drive');

    const helps = new Map(readiness.remedies.map((entry) => [entry.remedy, entry.likelyToHelp]));
    // The two things that would actually change the outcome.
    expect(helps.get('adjust_transport')).toBe(true);
    expect(helps.get('adjust_scope')).toBe(true);
    // And the two that would not, said out loud so nobody spends an afternoon
    // on them.
    expect(helps.get('more_days')).toBe(false);
    expect(helps.get('retry')).toBe(false);
  });

  it('names the right remedy when nothing could be measured at all', () => {
    const readiness = buildPlannerReadiness({
      consideredCount: 12,
      selectedCount: 5,
      eligibleCount: 0,
      feasibleCount: 0,
      scheduledCount: 0,
      dayCount: 4,
      unscheduled: Array.from({ length: 5 }, (_, index) =>
        rejection('missing_travel_data', `Place ${index}`),
      ),
    });
    expect(readiness.summary).toContain('travel time we could measure');
    const helps = new Map(readiness.remedies.map((entry) => [entry.remedy, entry.likelyToHelp]));
    expect(helps.get('retry')).toBe(true);
    expect(helps.get('adjust_transport')).toBe(false);
  });

  it('names the right remedy when everything is shut', () => {
    const readiness = buildPlannerReadiness({
      consideredCount: 20,
      selectedCount: 6,
      eligibleCount: 6,
      feasibleCount: 0,
      scheduledCount: 0,
      dayCount: 3,
      unscheduled: Array.from({ length: 6 }, (_, index) =>
        rejection('closed_on_trip_dates', `Place ${index}`),
      ),
    });
    expect(readiness.summary).toContain('unreachable or shut on every one of your 3 days');
    const helps = new Map(readiness.remedies.map((entry) => [entry.remedy, entry.likelyToHelp]));
    expect(helps.get('refresh_evidence')).toBe(true);
    expect(helps.get('more_days')).toBe(false);
  });

  it('keeps two tied blockers rather than picking one of them', () => {
    const readiness = buildPlannerReadiness({
      consideredCount: 10,
      selectedCount: 4,
      eligibleCount: 4,
      feasibleCount: 4,
      scheduledCount: 0,
      dayCount: 3,
      unscheduled: [
        rejection('exceeds_daily_travel', 'A'),
        rejection('exceeds_daily_travel', 'B'),
        rejection('hours_do_not_fit', 'C'),
        rejection('hours_do_not_fit', 'D'),
      ],
    });
    expect(readiness.dominantBlockers).toHaveLength(2);
  });

  it('produces the same result twice for the same input', () => {
    const input = {
      consideredCount: 9,
      selectedCount: 9,
      eligibleCount: 9,
      feasibleCount: 9,
      scheduledCount: 0,
      dayCount: 5,
      unscheduled: [
        rejection('hours_do_not_fit', 'B'),
        rejection('exceeds_daily_travel', 'A'),
        rejection('hours_do_not_fit', 'C'),
      ],
    };
    expect(JSON.stringify(buildPlannerReadiness(input))).toBe(
      JSON.stringify(buildPlannerReadiness(input)),
    );
  });
});

describe('a plan that would have had no stops', () => {
  /**
   * The end-to-end version, through the real planner, over the authored region.
   *
   * A daily driving limit below the round trip to anything is exactly the Bali
   * situation, expressed against a fixture rather than a destination — the same
   * shape of failure with none of Bali in it.
   */
  function unreachableTrip() {
    const scenario = buildScenario();
    return {
      ...scenario,
      profile: {
        ...scenario.profile,
        transport: {
          ...scenario.profile.transport,
          // Lower than the round trip to anything on the board, which is the
          // Bali situation stated as a number rather than as a destination.
          maxDailyDriveMinutes: 5,
          maxDailyTransportMinutes: 5,
        },
      },
    };
  }

  it('refuses instead of returning dated days with nothing on them', () => {
    const result = planTrip(unreachableTrip());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('planner_coverage_insufficient');
    expect(result.readiness?.scheduledCount).toBe(0);
    expect(result.readiness?.selectedCount).toBeGreaterThan(0);
  });

  it('says the round trip is the problem, with the real number in it', () => {
    const result = planTrip(unreachableTrip());
    expect(result.ok).toBe(false);
    if (result.ok || !result.readiness) return;
    const blocker = result.readiness.dominantBlockers[0];
    expect(blocker?.reasonCode).toBe('exceeds_daily_travel');
    // `no_time_left` was the old, generic answer and it sent travellers to free
    // up room that was never the constraint.
    expect(
      result.readiness.rejections.some((entry) => entry.reasonCode === 'no_time_left'),
    ).toBe(false);
  });

  it('still returns a real plan when the limits allow one', () => {
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scheduled = result.itinerary.days.reduce(
      (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
      0,
    );
    expect(scheduled).toBeGreaterThan(0);
    expect(result.itinerary.diagnostics.counts.scheduled).toBe(scheduled);
  });
});
