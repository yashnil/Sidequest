import { describe, expect, it } from 'vitest';
import { headlineFigures, heroStats, shortMinutes, splitDayTheme } from './hero-stats';

const totals = (travelMinutes: number, unmeasuredLegCount = 0) => ({ totals: { travelMinutes, unmeasuredLegCount } }) as never;

describe('the cover tiles', () => {
  const headline = 'A car: stops sit up to 31 minutes from where you sleep, and a typical day has about 67 minutes of driving against your 150-minute limit.';

  it('repeat the plan’s own typical day and limit rather than a second opinion', () => {
    expect(headlineFigures(headline)).toEqual({ typical: 67, limit: 150 });
    const stats = heroStats({ days: [totals(40), totals(90)], stopCount: 10, baseCount: 1, nights: 4, travellers: 2, primaryMode: 'drive', transportHeadline: headline });
    const travel = stats.find((s) => s.id === 'travel')!;
    expect(travel.value).toBe('≈ 67 min');
    expect(travel.sub).toBe('driving · your limit 150 min');
    expect(travel.gauge).toBeCloseTo(67 / 150);
    expect(travel.detail).toBe(headline);
    expect(stats.map((s) => s.id)).toEqual(['days', 'stops', 'sleep', 'travel', 'party']);
    expect(stats.find((s) => s.id === 'sleep')).toMatchObject({ label: 'Base', value: '1', sub: '4 nights' });
  });

  it('call a total with unmeasured legs a floor, and never print zero for travel nobody timed', () => {
    const floor = heroStats({ days: [totals(80, 1), totals(84)], stopCount: 5, baseCount: 1, nights: 2, travellers: null, primaryMode: 'drive', transportHeadline: 'Drive.' });
    expect(floor.find((s) => s.id === 'travel')!.value).toBe('≥ 82 min');
    const none = heroStats({ days: [totals(0, 2), totals(0, 1)], stopCount: 3, baseCount: 1, nights: 1, travellers: 1, primaryMode: 'walk', transportHeadline: null });
    const travel = none.find((s) => s.id === 'travel')!;
    expect(travel.value).toBe('Not measured');
    expect(none.some((s) => s.value === '0 min')).toBe(false);
    expect(none.find((s) => s.id === 'party')).toMatchObject({ label: 'Traveller', value: '1' });
  });

  it('omit the travel tile when there is neither travel nor a gap to name', () => {
    expect(heroStats({ days: [totals(0)], stopCount: 1, baseCount: 1, nights: 0, travellers: 2 }).some((s) => s.id === 'travel')).toBe(false);
  });

  it('print minutes as minutes up to three hours', () => {
    expect(shortMinutes(150)).toBe('150 min');
    expect(shortMinutes(190)).toBe('3 h 10 min');
    expect(shortMinutes(240)).toBe('4 h');
  });
});

describe('a day’s short title', () => {
  it('splits the lead from the places instead of truncating one string', () => {
    expect(splitDayTheme('Arrive and settle in — Hallgrímskirkja & Harpa.')).toEqual({ title: 'Arrive and settle in', places: 'Hallgrímskirkja & Harpa' });
    expect(splitDayTheme('Departure day')).toEqual({ title: 'Departure day', places: null });
  });
});
