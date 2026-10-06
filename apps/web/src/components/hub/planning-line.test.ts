import { describe, expect, it } from 'vitest';
import { planningDate, planningLineFor } from './planning-line';

describe('how this trip was built', () => {
  it('says nothing for a plan stored before the record existed', () => {
    expect(planningLineFor(undefined)).toBeNull();
  });

  it('a planner-built trip names the pool and where each scheduled stop came from, skipping empty sources', () => {
    const line = planningLineFor({ mode: 'planner', poolSize: 18, scheduled: { traveller: 3, sidequest: 12, maybe: 0, filler: 3 }, weatherMoves: [], mustConflicts: [] });
    expect(line?.summary).toBe('Planned by Sidequest from 18 places on your Discovery Board — 3 you chose, 12 Sidequest picked and 3 added to fill the days.');
    expect(line?.notes).toEqual([]);
  });

  it('weather moves and must conflicts are one sentence each', () => {
    const line = planningLineFor({
      mode: 'planner',
      poolSize: 9,
      scheduled: { traveller: 1, sidequest: 4, maybe: 1, filler: 0 },
      weatherMoves: [{ name: 'the Delicate Arch hike', avoidedDate: '2026-10-13', chosenDate: '2026-10-15' }],
      mustConflicts: [{ name: 'Fiery Furnace', detail: 'Ranger-led entry is not offered on your dates' }],
    });
    expect(line?.summary).toMatch(/1 you chose, 1 you marked maybe and 4 Sidequest picked\.$/);
    expect(line?.notes).toEqual([
      'Moved the Delicate Arch hike to Thursday 15 Oct for a better forecast than Tuesday 13 Oct.',
      'You asked for Fiery Furnace; it didn’t fit: Ranger-led entry is not offered on your dates.',
    ]);
  });

  it('a model-composed trip says its structure was not optimised', () => {
    const line = planningLineFor({ mode: 'model_composed', reason: 'No Discovery Board existed for this trip, so a model composed the draft.', weatherMoves: [], mustConflicts: [] });
    expect(line?.summary).toBe('Composed by Sidequest’s model without a Discovery Board — places are checked, but the plan’s structure was not optimised.');
  });

  it('never claims a pool it was not told', () => {
    expect(planningLineFor({ mode: 'planner', weatherMoves: [], mustConflicts: [] })?.summary).toBe('Planned by Sidequest from your Discovery Board.');
  });

  it('reads calendar dates without a timezone shift', () => {
    expect(planningDate('2026-01-01')).toBe('Thursday 1 Jan');
  });
});
