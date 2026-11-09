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

describe('meal venues: a stated ranking (food pass, 2026-11)', () => {
  it('an adjustment moves the choice among close venues; a stated diet still comes first', () => {
    const adjust = (entry: { venue: { id: string } }) => (entry.venue.id === 'chain' ? 0.8 : 0);
    expect(pickMealVenue([v('chain', 0.2), v('local', 0.6)], new Map(), none, adjust)?.venue.id).toBe('local');
    expect(pickMealVenue([v('chain', 0.2), v('local', 2.5)], new Map(), none, adjust)?.venue.id).toBe('chain');
    expect(pickMealVenue([v('chain', 0.2), v('vegan', 1.9)], new Map(), (x) => x.id === 'chain', () => 5)?.venue.id).toBe('chain');
  });
});

describe('a named meal sits on the leg it interrupts (release pass, 2026-11)', () => {
  // About 0.009° of latitude per kilometre.
  const north = (km: number) => ({ lat: 28 + km * 0.009, lng: -16.5 });
  it('by car: a venue 20 km back towards the hotel is not "on the way" between two stops 5 km apart', async () => {
    const { mealVenueFit } = await import('./reconcile');
    const origin = north(0);
    const next = north(5);
    expect(mealVenueFit({ origin, next, venue: north(-20), carFree: false, searchKm: 25 })).toBeNull();
    expect(mealVenueFit({ origin, next, venue: north(3), carFree: false, searchKm: 25 })).not.toBeNull();
    // A small step off the leg is fine; a long one is not.
    expect(mealVenueFit({ origin, next, venue: { lat: north(2.5).lat, lng: -16.5 + 0.02 }, carFree: false, searchKm: 25 })).not.toBeNull();
    expect(mealVenueFit({ origin, next, venue: { lat: north(2.5).lat, lng: -16.5 + 0.2 }, carFree: false, searchKm: 25 })).toBeNull();
  });
  it('dinner on the way back to the base counts; beside the stop before always counts', async () => {
    const { mealVenueFit } = await import('./reconcile');
    const lastStop = north(0);
    const base = north(20);
    expect(mealVenueFit({ origin: lastStop, next: base, venue: north(19.5), carFree: false, searchKm: 25 })).not.toBeNull();
    expect(mealVenueFit({ origin: lastStop, next: north(-30), venue: north(1.5), carFree: false, searchKm: 25 })).not.toBeNull();
  });
  it('on foot: within a short walk of the stop before or the stop after, nothing further', async () => {
    const { mealVenueFit } = await import('./reconcile');
    const origin = north(0);
    const next = north(6);
    expect(mealVenueFit({ origin, next, venue: north(5.5), carFree: true, searchKm: 3 })?.km).toBeCloseTo(0.5, 1);
    expect(mealVenueFit({ origin, next, venue: north(2.5), carFree: true, searchKm: 3 })).not.toBeNull();
    expect(mealVenueFit({ origin, next, venue: north(-4), carFree: true, searchKm: 3 })).toBeNull();
  });
});
