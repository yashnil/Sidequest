import { describe, expect, it } from 'vitest';
import { assessMustDoFeasibility, CONFLICT_MARGIN, USABLE_MINUTES_PER_DAY } from './feasibility';
import { planTrip } from './plan';
import { buildScenario } from './testing/scenario';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import type { PlanningCandidate } from './types';
import type { TravelTimeMatrix } from '@sidequest/geo';

/**
 * SECTION 26.2 — THE ADVERSARIAL FEASIBILITY SCENARIO.
 *
 * "Create a trip with too many explicit must-dos for the available time.
 * Sidequest should say the constraints conflict rather than obediently
 * producing an impossible itinerary."
 *
 * The behaviour before this existed was the obedient one: the greedy packer
 * placed what it could, whichever hand-picks it reached last were reported as
 * `must_include_unscheduled`, and — because that code is deliberately excluded
 * from the blocking set — an itinerary shipped with `ok: true`. Every
 * individual step was defensible. The result was a plan that answered a
 * question the traveller had not asked.
 */

function candidate(
  id: string,
  minutes: number,
  manual = true,
): PlanningCandidate {
  const place = EASTERN_SIERRA_PLACES[0]!;
  return {
    place: { ...place, id, name: `Place ${id}` },
    priority: 3,
    manual,
    selectionStatus: 'included',
    fitScore: 80,
    matchedInterests: [],
    durationMinutes: minutes,
    driveMinutesFromBase: 30,
  };
}

/** A matrix where every pair costs the same, so the arithmetic is checkable by hand. */
function uniformMatrix(ids: readonly string[], minutes: number): TravelTimeMatrix {
  const size = ids.length;
  const grid = (value: number) =>
    Array.from({ length: size }, (_, row) =>
      Array.from({ length: size }, (_, column) => (row === column ? 0 : value)),
    );
  return {
    ids: [...ids],
    minutes: grid(minutes),
    km: grid(minutes),
    mode: 'car',
    provenance: { kind: 'measured', note: 'test' },
  } as TravelTimeMatrix;
}

describe('a set of must-dos that cannot fit is a conflict', () => {
  it('says so, with arithmetic the traveller can check', () => {
    /* Six picks at three hours each, plus travel, against one day. */
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const candidates = ids.map((id) => candidate(id, 180));
    const conflict = assessMustDoFeasibility({
      candidates,
      matrix: uniformMatrix(ids, 30),
      days: 1,
    });

    expect(conflict).not.toBeNull();
    expect(conflict!.minutesAvailable).toBe(USABLE_MINUTES_PER_DAY);
    /* 6 x 180 on site, plus five 30-minute hops on the nearest-neighbour tour. */
    expect(conflict!.minutesRequired).toBe(6 * 180 + 5 * 30);
    expect(conflict!.days).toBe(1);
    expect(conflict!.daysNeeded).toBeGreaterThan(1);
    expect(conflict!.places).toHaveLength(6);
    /* Every pick is named, because the traveller has to choose which gives. */
    expect(conflict!.places.map((entry) => entry.placeId).sort()).toEqual(ids);
  });

  it('names the fewest that would have to go, rather than deciding for them', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const conflict = assessMustDoFeasibility({
      candidates: ids.map((id) => candidate(id, 180)),
      matrix: uniformMatrix(ids, 30),
      days: 1,
    })!;
    expect(conflict.fewestToDrop).toBeGreaterThan(0);
    expect(conflict.fewestToDrop).toBeLessThan(ids.length);
    expect(conflict.summary).toContain('Something has to give');
    /* And it offers the other way out as well as the subtraction. */
    expect(conflict.summary).toContain(`${conflict.daysNeeded} days`);
  });

  it('stays quiet on a merely ambitious trip', () => {
    /*
     * Exactly at the margin. This is the case the planner should still get to
     * try, and a conflict here would refuse trips a good ordering delivers.
     */
    const ids = ['a', 'b', 'c'];
    const minutes = Math.floor((USABLE_MINUTES_PER_DAY * CONFLICT_MARGIN) / 3) - 20;
    expect(
      assessMustDoFeasibility({
        candidates: ids.map((id) => candidate(id, minutes)),
        matrix: uniformMatrix(ids, 5),
        days: 1,
      }),
    ).toBeNull();
  });

  it('says nothing about two picks, whose problem is the trip length rather than the set', () => {
    const ids = ['a', 'b'];
    expect(
      assessMustDoFeasibility({
        candidates: ids.map((id) => candidate(id, 600)),
        matrix: uniformMatrix(ids, 60),
        days: 1,
      }),
    ).toBeNull();
  });

  it('ignores auto-picks — only what the traveller chose by hand can conflict', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(
      assessMustDoFeasibility({
        candidates: ids.map((id) => candidate(id, 180, false)),
        matrix: uniformMatrix(ids, 30),
        days: 1,
      }),
    ).toBeNull();
  });

  it('cannot manufacture a conflict out of unmeasured travel', () => {
    /*
     * The bound has to stay a bound. An empty matrix means every leg is
     * unmeasured, and unmeasured legs contribute nothing — so a region we
     * cannot route is never refused *because* we cannot route it.
     */
    const ids = ['a', 'b', 'c'];
    const empty = { ids: [], minutes: [], km: [], mode: 'car', provenance: { kind: 'measured', note: 'test' } } as unknown as TravelTimeMatrix;
    const conflict = assessMustDoFeasibility({
      candidates: ids.map((id) => candidate(id, 100)),
      matrix: empty,
      days: 1,
    });
    expect(conflict).toBeNull();
  });
});

describe('the planner refuses rather than inventing an answer', () => {
  it('returns a typed conflict instead of a plan that silently drops picks', () => {
    /*
     * Driven through the real pipeline — questionnaire, board, auto-select —
     * with every fixture place hand-picked onto a three-day trip. This is the
     * founder-shaped version of the case above: not a synthetic matrix, but a
     * traveller ticking everything.
     */
    const everything = EASTERN_SIERRA_PLACES.map((place) => place.id);
    const scenario = buildScenario({
      basics: { startDate: '2026-08-12', endDate: '2026-08-13' },
      manualIncludes: everything,
    });
    const result = planTrip(scenario);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('must_do_conflict');
    expect(result.mustDoConflict).toBeDefined();
    /* The refusal names the traveller's own picks. */
    expect(result.mustDoConflict!.places.length).toBeGreaterThanOrEqual(3);
    expect(result.message).toContain('picked by hand');
  });

  it('still plans an ordinary trip, so the check has not become a gate', () => {
    /*
     * The other half of the claim, and the one that would make this feature a
     * regression if it failed: the default scenario is a normal four-day trip
     * with an auto-picked board, and it must still produce an itinerary.
     */
    const result = planTrip(buildScenario());
    expect(result.ok).toBe(true);
  });
});
