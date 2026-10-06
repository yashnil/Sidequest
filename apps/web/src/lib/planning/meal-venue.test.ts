import { describe, expect, it } from 'vitest';
import { pickMealVenue } from './reconcile';

const v = (id: string, km: number) => ({ venue: { id }, km });
const none = () => false;

describe('meal venues: a new table before the same one again (V1)', () => {
  it('passes over yesterday’s venue for a new one that is still close', () => {
    expect(pickMealVenue([v('bagels', 0.2), v('diner', 0.9)], new Map([['bagels', 1]]), none)?.venue.id).toBe('diner');
  });

  it('never sends anyone across town for the sake of variety: a far new venue loses to a near repeat', () => {
    expect(pickMealVenue([v('bagels', 0.2), v('bistro', 4.5)], new Map([['bagels', 1]]), none)?.venue.id).toBe('bagels');
  });

  it('with one credible venue it is repeated rather than faked', () => {
    expect(pickMealVenue([v('only', 0.5)], new Map([['only', 1]]), none)?.venue.id).toBe('only');
    expect(pickMealVenue([], new Map(), none)).toBeUndefined();
  });

  it('a declared diet still wins within two kilometres, among the venues not yet named', () => {
    const supports = (venue: { id: string }) => venue.id === 'vegan';
    expect(pickMealVenue([v('used', 0.1), v('cafe', 0.3), v('vegan', 1.4)], new Map([['used', 1]]), supports)?.venue.id).toBe('vegan');
  });
});
