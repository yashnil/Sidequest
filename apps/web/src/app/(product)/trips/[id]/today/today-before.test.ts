import { describe, expect, it } from 'vitest';
import type { NextActions } from '@sidequest/core';
import { countdownWords, daysBetween, firstDayPreview, longDate, prepActions } from './today-before';

describe('Today before the trip', () => {
  it('counts calendar days and says them as a person would', () => {
    expect(daysBetween('2026-10-25', '2026-11-10')).toBe(16);
    expect(daysBetween('2026-11-10', '2026-11-10')).toBe(0);
    expect(daysBetween('nope', '2026-11-10')).toBeNull();
    expect(countdownWords(1)).toBe('Tomorrow');
    expect(countdownWords(5)).toBe('In 5 days');
    expect(countdownWords(16)).toBe('In 2 weeks');
    expect(countdownWords(90)).toBe('In 3 months');
  });

  it('prints the ISO date as a human date', () => {
    expect(longDate('2026-11-10')).toMatch(/Tuesday,? 10 November 2026/);
  });

  it('previews day one from the plan: its stops, where you sleep, and how far the clock can be read', () => {
    const day = { dayNumber: 1, date: '2026-11-10', theme: 'Arrive — Harpa.', baseName: 'Reykjavik', timing: { precision: 'band', estimatedLegs: 0, unknownLegs: 2 }, items: [
      { kind: 'travel', title: 'Walk', startMinute: 600 },
      { kind: 'activity', title: 'Harpa', startMinute: 620 },
      { kind: 'meal', title: 'Dinner', startMinute: 1100 },
    ] };
    const preview = firstDayPreview({ days: [day] } as never)!;
    expect(preview).toMatchObject({ dayNumber: 1, theme: 'Arrive — Harpa', baseName: 'Reykjavik', stopCount: 1, timing: 'band' });
    expect(preview.stops).toEqual([{ title: 'Harpa', startMinute: 620 }]);
    expect(firstDayPreview({ days: [] } as never)).toBeNull();
  });

  it('points the next actions at the hub, keeps their own words, and drops the day-of travel action', () => {
    const next: NextActions = { phase: 'book', remaining: 2, actions: [
      { id: 'a', kind: 'book', title: 'Book the car', why: 'The far stops need it.', href: '#book-first', nodeId: 'n1', score: 3 },
      { id: 'b', kind: 'travel', title: 'Next: Harpa', why: 'x', href: '#day-1', nodeId: 'n2', score: 1000 },
      { id: 'c', kind: 'prepare', title: 'Offline maps', why: 'No signal.', href: '/trips/t/pack', nodeId: 'n3', score: 1 },
    ] };
    const actions = prepActions(next, 't');
    expect(actions.map((a) => a.id)).toEqual(['a', 'c']);
    expect(actions[0]!.link).toBe('/trips/t/itinerary#book-first');
    expect(actions[1]!.link).toBe('/trips/t/pack');
    expect(actions[0]!.title).toBe('Book the car');
    expect(prepActions(null, 't')).toEqual([]);
  });
});
