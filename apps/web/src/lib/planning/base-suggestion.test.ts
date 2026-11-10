import { describe, expect, it } from 'vitest';
import { suggestBaseForPicks } from './planner-composer';
import type { PlannedDay, PlannerBase, PlannerCandidate, StructurePlan } from './structure-planner';

const must = (id: string, name: string): PlannerCandidate => ({ id, name, status: 'must' }) as PlannerCandidate;
const base = (id: string, name: string): PlannerBase => ({ id, name, why: '', coordinates: { lat: 0, lng: 0 }, fromDate: '2027-01-01', toDate: '2027-01-05', nights: 4, transferMinutesFromPrevious: 0 });
const plan = (mustConflicts: StructurePlan['mustConflicts'], days: PlannedDay[] = []): StructurePlan => ({ days, dropped: [], weatherMoves: [], mustConflicts, repairs: [], dayNotes: [] }) as unknown as StructurePlan;
const conflict = (candidateId: string) => ({ candidateId, name: candidateId, reason: 'not_workable', detail: 'x' }) as StructurePlan['mustConflicts'][number];

describe('a pick the bases cannot reach', () => {
  const table: Record<string, number> = { 'west|kells': 210, 'east|kells': 15 };
  const minutes = (a: string, b: string) => table[`${a}|${b}`] ?? table[`${b}|${a}`] ?? null;
  const pool = [must('kells', 'Book of Kells')];

  it('names the proposed base that reaches it, and leaves the choice with the traveller', () => {
    const note = suggestBaseForPicks({ plan: plan([conflict('kells')]), bases: [base('west', 'Galway')], allBases: [{ id: 'west', name: 'Galway' }, { id: 'east', name: 'Dublin' }], pool, minutes, limit: 150, mayMove: true });
    expect(note).toBe('Book of Kells is on your list but far from Galway. A night or two in Dublin would bring it within reach.');
  });

  it('says what it would cost somebody who asked to stay put', () => {
    const note = suggestBaseForPicks({ plan: plan([conflict('kells')]), bases: [base('west', 'Galway')], allBases: [{ id: 'west', name: 'Galway' }, { id: 'east', name: 'Dublin' }], pool, minutes, limit: 150, mayMove: false });
    expect(note).toContain('if you would accept another hotel change');
  });

  it('says nothing when no proposed base would help', () => {
    expect(suggestBaseForPicks({ plan: plan([conflict('kells')]), bases: [base('west', 'Galway')], allBases: [{ id: 'west', name: 'Galway' }], pool, minutes, limit: 150, mayMove: true })).toBeNull();
  });

  it('says nothing when a pick is already within reach', () => {
    expect(suggestBaseForPicks({ plan: plan([]), bases: [base('east', 'Dublin')], allBases: [{ id: 'east', name: 'Dublin' }, { id: 'west', name: 'Galway' }], pool, minutes, limit: 150, mayMove: true })).toBeNull();
  });
});
