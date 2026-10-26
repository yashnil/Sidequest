import { describe, expect, it } from 'vitest';
import { plannerFallbackReasonOf, type PlannerComposition } from './planner-composer';

/** Only what `plannerFallbackReasonOf` reads: the days, the drops and the pool. */
function composition(days: { stops: number; capacity: number; relocation?: boolean }[], spare = 1): PlannerComposition {
  return {
    poolSize: 10,
    plan: {
      days: days.map((d, i) => ({ dayNumber: i + 1, stops: Array.from({ length: d.stops }, () => ({})), capacityMinutes: d.capacity, relocation: d.relocation ?? false })),
      dropped: Array.from({ length: spare }, () => ({ reason: 'capacity', candidate: { status: 'suggested' } })),
      mustConflicts: [],
      weatherMoves: [],
    },
  } as unknown as PlannerComposition;
}

describe('when the planner is too thin to stand', () => {
  it('a middle day with room and nothing on it is a shortage', () => {
    expect(plannerFallbackReasonOf(composition([{ stops: 1, capacity: 300 }, { stops: 0, capacity: 400 }, { stops: 1, capacity: 200 }]))).toBe('no_feasible_day_assignment');
  });

  it('a base move that fills the whole day is a travel day, not a shortage', () => {
    expect(plannerFallbackReasonOf(composition([{ stops: 2, capacity: 300 }, { stops: 0, capacity: 0, relocation: true }, { stops: 2, capacity: 400 }, { stops: 0, capacity: 120 }]))).toBeNull();
  });
});
