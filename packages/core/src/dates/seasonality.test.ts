import { describe, expect, it } from 'vitest';
import { climateProfileSchema, type ClimateNormal } from '../schemas/climate';
import { activityAccessScore, objectivesOf, recommendDateWindows, scenicScore, scoreWindow, severeWeatherScore, windowFeatures, WINDOW_OBJECTIVE_LABELS } from './windows';

/**
 * V10 §10 — BEST_TIME is multi-objective, the tradeoffs are shown, and the
 * access claim is a likelihood.
 */
const NOW = new Date('2026-09-12T12:00:00Z');

function month(m: number, over: Partial<ClimateNormal> = {}): ClimateNormal {
  return { month: m, temperature: { low: 4, high: 14 }, precipitationMm: 70, wetDays: 12, snowDays: 0, daylightHours: 13, hotDays: 0, freezeDays: 0, ...over };
}

/** A mountain-region shape: snowbound shoulders, a short open season, long summer light. */
const MOUNTAIN = climateProfileSchema.parse({
  schemaVersion: 1,
  coordinates: { lat: 51.4, lng: -116.2 },
  sampleYearFrom: 2005,
  sampleYearTo: 2025,
  months: [
    month(1, { temperature: { low: -16, high: -6 }, snowDays: 14, freezeDays: 30, daylightHours: 8.3, wetDays: 14 }),
    month(2, { temperature: { low: -13, high: -3 }, snowDays: 12, freezeDays: 28, daylightHours: 9.8, wetDays: 12 }),
    month(3, { temperature: { low: -9, high: 2 }, snowDays: 11, freezeDays: 28, daylightHours: 11.9, wetDays: 12 }),
    month(4, { temperature: { low: -4, high: 8 }, snowDays: 7, freezeDays: 22, daylightHours: 13.8, wetDays: 11 }),
    month(5, { temperature: { low: 1, high: 14 }, snowDays: 3, freezeDays: 12, daylightHours: 15.7, wetDays: 13 }),
    month(6, { temperature: { low: 5, high: 18 }, snowDays: 1, freezeDays: 3, daylightHours: 16.6, wetDays: 14 }),
    month(7, { temperature: { low: 8, high: 22 }, snowDays: 0, freezeDays: 0, daylightHours: 16.1, wetDays: 11 }),
    month(8, { temperature: { low: 7, high: 21 }, snowDays: 0, freezeDays: 1, daylightHours: 14.5, wetDays: 10 }),
    month(9, { temperature: { low: 3, high: 16 }, snowDays: 2, freezeDays: 8, daylightHours: 12.5, wetDays: 10 }),
    month(10, { temperature: { low: -2, high: 9 }, snowDays: 6, freezeDays: 20, daylightHours: 10.5, wetDays: 11 }),
    month(11, { temperature: { low: -10, high: 0 }, snowDays: 11, freezeDays: 27, daylightHours: 8.8, wetDays: 13 }),
    month(12, { temperature: { low: -15, high: -5 }, snowDays: 14, freezeDays: 30, daylightHours: 7.9, wetDays: 14 }),
  ],
  provider: 'test',
  dataset: 'test',
  attribution: 'test',
  retrievedAt: NOW.toISOString(),
});

describe('multi-objective seasonality', () => {
  it('scores access, severe weather, phenomena and scenery as separate objectives', () => {
    const features = windowFeatures(MOUNTAIN.months[6]!);
    expect(Object.keys(features).sort()).toEqual(['activityAccess', 'crowds', 'daylight', 'dryness', 'heat', 'phenomena', 'scenic', 'severeWeather', 'snow', 'temperature']);
  });

  it('rates a snowbound month unreachable and a midsummer month reachable', () => {
    expect(activityAccessScore(MOUNTAIN.months[0]!)).toBeLessThan(0.2);
    expect(activityAccessScore(MOUNTAIN.months[6]!)).toBe(1);
  });

  it('keeps severe weather separate from comfort', () => {
    /* A pleasant month with a deluge is comfortable and risky at once. */
    const wet = month(7, { temperature: { low: 18, high: 26 }, precipitationMm: 480, wetDays: 24 });
    expect(severeWeatherScore(wet)).toBeLessThan(0.8);
    expect(windowFeatures(wet).temperature).toBe(1);
  });

  it('reads a few snow days as scenery and many as a shut road', () => {
    expect(scenicScore(month(9, { snowDays: 4, daylightHours: 13, wetDays: 8 }))).toBeGreaterThan(scenicScore(month(1, { snowDays: 18, daylightHours: 8, wetDays: 16 })));
  });

  it('scores an unknown phenomenon at neutral, never at best', () => {
    expect(windowFeatures(MOUNTAIN.months[6]!).phenomena).toBe(0.5);
    const known = windowFeatures(MOUNTAIN.months[8]!, undefined, [], new Map([[9, 1]]));
    expect(known.phenomena).toBe(1);
  });

  it('never states access as a certainty', () => {
    const guidance = recommendDateWindows({ profile: MOUNTAIN, year: 2027, now: NOW, limit: 12 });
    expect(guidance.kind).toBe('recommended');
    if (guidance.kind !== 'recommended') return;
    const prose = guidance.windows.flatMap((w) => [...w.reasons, ...w.tradeoffs]).join(' ');
    expect(prose).not.toMatch(/trails are still open|will be open|are open before/i);
    expect(prose).toMatch(/Historically|historically/);
  });

  it('carries the objective vector so a screen can show the tradeoff rather than one number', () => {
    const guidance = recommendDateWindows({ profile: MOUNTAIN, year: 2027, now: NOW, limit: 3, interests: ['hiking', 'scenic_drives'] });
    if (guidance.kind !== 'recommended') throw new Error('expected windows');
    for (const window of guidance.windows) {
      expect(window.objectives.length).toBe(Object.keys(WINDOW_OBJECTIVE_LABELS).length);
      /* Heaviest objective first, so a screen reads top-down. */
      expect(window.objectives[0]!.weight).toBeGreaterThanOrEqual(window.objectives[1]!.weight);
      for (const objective of window.objectives) expect(objective.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('puts an open month ahead of a snowbound one for a hiking trip', () => {
    const guidance = recommendDateWindows({ profile: MOUNTAIN, year: 2027, now: NOW, limit: 12, interests: ['hiking'] });
    if (guidance.kind !== 'recommended') throw new Error('expected windows');
    const ranked = guidance.windows.map((w) => w.month);
    expect([6, 7, 8, 9]).toContain(ranked[0]);
    expect(ranked.slice(0, 4)).not.toContain(1);
  });

  it('weights every objective it scores', () => {
    const features = windowFeatures(MOUNTAIN.months[6]!);
    const objectives = objectivesOf(features, { temperature: 0.2, dryness: 0.14, daylight: 0.1, snow: 0.06, heat: 0.04, crowds: 0.08, activityAccess: 0.18, severeWeather: 0.08, phenomena: 0.06, scenic: 0.06 });
    expect(Math.round(objectives.reduce((s, o) => s + o.weight, 0) * 100) / 100).toBe(1);
    expect(scoreWindow(features)).toBeGreaterThan(0);
  });
});
