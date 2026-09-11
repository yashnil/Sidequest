import { describe, expect, it } from 'vitest';
import { dayPartGroupFor, groupByDayPart, partsAreMeaningful } from './day-parts';

const row = (kind: string, startMinute: number, id = `${kind}-${startMinute}`) => ({ id, kind, startMinute });

describe('a day in three parts', () => {
  it('bands the clock into morning, midday and evening', () => {
    expect(dayPartGroupFor(8 * 60)).toBe('morning');
    expect(dayPartGroupFor(11 * 60 + 29)).toBe('morning');
    expect(dayPartGroupFor(11 * 60 + 30)).toBe('midday');
    expect(dayPartGroupFor(16 * 60 + 59)).toBe('midday');
    expect(dayPartGroupFor(17 * 60)).toBe('evening');
  });
  it('keeps a travel row with the stop it leads to, and the day in order', () => {
    const items = [row('meal', 540), row('travel', 570), row('activity', 600), row('travel', 700), row('activity', 720), row('free_time', 900), row('travel', 1000), row('meal', 1140)];
    const groups = groupByDayPart(items);
    expect(groups.map((g) => g.part)).toEqual(['morning', 'midday', 'evening']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['meal-540', 'travel-570', 'activity-600']);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['travel-700', 'activity-720', 'free_time-900']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['travel-1000', 'meal-1140']);
    expect(groups.flatMap((g) => g.items)).toHaveLength(items.length);
  });
  it('lets a trailing return leg stay with the last part', () => {
    const groups = groupByDayPart([row('activity', 600), row('travel', 700)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });
  it('does not head a single-part day', () => {
    expect(partsAreMeaningful(groupByDayPart([row('activity', 600), row('activity', 660)]))).toBe(false);
    expect(partsAreMeaningful(groupByDayPart([row('activity', 600), row('meal', 1100)]))).toBe(true);
  });
});
