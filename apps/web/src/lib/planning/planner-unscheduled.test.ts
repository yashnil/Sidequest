import { describe, expect, it } from 'vitest';
import { plannerUnscheduledPicks } from './planner-composer';
import type { PlannerCandidate, StructurePlan } from './structure-planner';

/**
 * Production pass — a traveller's pick the planner could not place is an
 * unscheduled place with a reason code (so the itinerary can offer the remedy),
 * never only a line of prose in the draft.
 */
const candidate = (id: string, blockedCode?: string): PlannerCandidate =>
  ({ id, name: id, status: 'must', ...(blockedCode ? { blocked: 'Reaching the start of this one needs your own vehicle.', blockedCode } : {}) }) as unknown as PlannerCandidate;

describe('plannerUnscheduledPicks', () => {
  it('turns every must-do conflict into an unscheduled place, by the board’s blocker', () => {
    const plan = {
      dropped: [
        { candidate: candidate('convict-lake', 'needs_car'), reason: 'not_workable', detail: 'Reaching the start of this one needs your own vehicle.' },
        { candidate: candidate('far-falls'), reason: 'capacity', detail: 'There was no day it fitted.' },
      ],
      mustConflicts: [
        { candidateId: 'convict-lake', name: 'Convict Lake', reason: 'not_workable', detail: 'Reaching the start of this one needs your own vehicle.' },
        { candidateId: 'far-falls', name: 'Far Falls', reason: 'capacity', detail: 'There was no day it fitted.' },
      ],
    } as unknown as StructurePlan;
    const out = plannerUnscheduledPicks({ plan });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ placeId: 'convict-lake', wasManual: true, reasonCode: 'transport_mode_unavailable' });
    expect(out[0]!.reason).toMatch(/not workable on this trip as you are travelling/);
    expect(out[0]!.suggestedRemedy).toMatch(/getting around/);
    expect(out[1]).toMatchObject({ placeId: 'far-falls', reasonCode: 'no_time_left' });
  });

  it('is empty when every pick was placed', () => {
    expect(plannerUnscheduledPicks({ plan: { dropped: [], mustConflicts: [] } as unknown as StructurePlan })).toEqual([]);
  });
});
