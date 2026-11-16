import { describe, expect, it } from 'vitest';
import { trailScope } from './trip-quality-contract';

const stage = (order: number, fromName: string, toName: string, walkedOnDay: boolean, resolution = 'walk') => ({ order, fromName, toName, walkedOnDay, resolution });

describe('a plan says which part of the trail it walks', () => {
  it('a circuit walked in part is a section, never the whole (the beta TMB shape, unseen names)', () => {
    const scope = trailScope([stage(1, 'Arnau', 'Belvé', true), stage(2, 'Belvé', 'Corvo', true), stage(3, 'Corvo', 'Dalmar', true), stage(4, 'Dalmar', 'Esk', false), stage(5, 'Esk', 'Fane', false), stage(6, 'Fane', 'Arnau', false)])!;
    expect(scope.partial).toBe(true);
    expect(scope.closed).toBe(false);
    expect(scope.sentence).toBe('This plan walks the trail from Arnau to Dalmar: 3 of the 6 stages Sidequest found. The other 3 are not walked on these dates, so this is a section of the trail, not all of it.');
  });

  it('a closed circuit says so; a stage covered the other way does not count as walked', () => {
    expect(trailScope([stage(1, 'Arnau', 'Belvé', true), stage(2, 'Belvé', 'Arnau', true)])!.sentence).toBe('This plan walks the trail from Arnau to Arnau: 2 of the 2 stages Sidequest found, back to where it began.');
    const withRide = trailScope([stage(1, 'Arnau', 'Belvé', true), stage(2, 'Belvé', 'Corvo', true, 'alternative'), stage(3, 'Corvo', 'Dalmar', true)])!;
    expect(withRide.walked).toBe(2);
    expect(withRide.partial).toBe(true);
  });

  it('a point-to-point trail walked in full makes no claim about a circuit; a stage the party could not do counts as found', () => {
    const scope = trailScope([stage(1, 'Arnau', 'Belvé', true), stage(2, 'Belvé', 'Corvo', true)])!;
    expect(scope.partial).toBe(false);
    expect(scope.sentence).not.toMatch(/section|circuit/);
    expect(trailScope([stage(1, 'Arnau', 'Belvé', true)], 1)!.partial).toBe(true);
  });

  it('nothing walked is not a scope (the gap note says why)', () => {
    expect(trailScope([stage(1, 'Arnau', 'Belvé', false)])).toBeNull();
  });
});
