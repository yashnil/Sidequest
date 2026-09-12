import { describe, expect, it } from 'vitest';
import { mergeClimateProfiles, regionalSamplePoints, regionalUncertaintyNote } from './regional';
import type { ClimateProfile } from '../schemas/climate';

function profile(lat: number, lng: number, highBase: number, precipBase: number, years: [number, number] = [2005, 2024]): ClimateProfile {
  return {
    schemaVersion: 1,
    coordinates: { lat, lng },
    sampleYearFrom: years[0],
    sampleYearTo: years[1],
    months: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      temperature: { low: highBase - 10 + i, high: highBase + i },
      precipitationMm: precipBase + i * 2,
      wetDays: 5 + (i % 3),
      snowDays: i < 3 ? 4 : 0,
      daylightHours: 10 + (i % 6),
      hotDays: 0,
      freezeDays: i < 3 ? 6 : 0,
    })),
    provider: 'test',
    dataset: 'test-normals',
    attribution: 'Test archive',
    retrievedAt: '2026-09-01T00:00:00.000Z',
  };
}

const ROCKIES_BOX = { southWest: { lat: 49, lng: -119 }, northEast: { lat: 54, lng: -114 } };

describe('regionalSamplePoints', () => {
  it('reads a regional box at its centre and a quarter in from each end of the longer axis', () => {
    const points = regionalSamplePoints({ center: { lat: 51.5, lng: -116.5 }, bounds: ROCKIES_BOX, scale: 'region' });
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ lat: 51.5, lng: -116.5, label: 'centre' });
    /* 5° of latitude (~555 km) is longer than 5° of longitude at 51°N (~350 km): the axis is north–south. */
    expect(points[1]).toMatchObject({ lat: 50.25, lng: -116.5, label: 'southern part' });
    expect(points[2]).toMatchObject({ lat: 52.75, lng: -116.5, label: 'northern part' });
    for (const p of points) {
      expect(p.lat).toBeGreaterThanOrEqual(ROCKIES_BOX.southWest.lat);
      expect(p.lat).toBeLessThanOrEqual(ROCKIES_BOX.northEast.lat);
    }
  });

  it('walks east–west when the box is wider than it is tall', () => {
    const points = regionalSamplePoints({ center: { lat: 46, lng: 10 }, bounds: { southWest: { lat: 44, lng: 5 }, northEast: { lat: 48, lng: 16 } }, scale: 'region' });
    expect(points.map((p) => p.label)).toEqual(['centre', 'western part', 'eastern part']);
    expect(points[1]!.lng).toBeCloseTo(7.75, 5);
    expect(points[2]!.lng).toBeCloseTo(13.25, 5);
  });

  it('samples the centre only below regional scale, or without a box', () => {
    expect(regionalSamplePoints({ center: { lat: 1, lng: 2 }, bounds: ROCKIES_BOX, scale: 'district' })).toHaveLength(1);
    expect(regionalSamplePoints({ center: { lat: 1, lng: 2 }, bounds: null, scale: 'region' })).toHaveLength(1);
    expect(regionalSamplePoints({ center: { lat: 1, lng: 2 }, scale: 'continental' })).toHaveLength(1);
  });

  it('never exceeds three points, even for a continent-sized box', () => {
    const points = regionalSamplePoints({ center: { lat: 23, lng: 10 }, bounds: { southWest: { lat: 15, lng: -17 }, northEast: { lat: 32, lng: 35 } }, scale: 'continental' });
    expect(points).toHaveLength(3);
  });
});

describe('mergeClimateProfiles', () => {
  it('averages every normal month by month and reports the spread between the points', () => {
    const a = profile(50, -116, 20, 40, [2004, 2023]);
    const b = profile(52, -116, 14, 90, [2006, 2025]);
    const merged = mergeClimateProfiles([a, b]);
    expect(merged.sampled).toBe(2);
    expect(merged.profile.months).toHaveLength(12);
    expect(merged.profile.months[0]!.temperature.high).toBe(17);
    expect(merged.profile.months[0]!.temperature.low).toBe(7);
    expect(merged.profile.months[0]!.precipitationMm).toBe(65);
    expect(merged.profile.sampleYearFrom).toBe(2004);
    expect(merged.profile.sampleYearTo).toBe(2025);
    expect(merged.spread).toEqual({ maxHighDeltaC: 6, maxLowDeltaC: 6, maxPrecipDeltaMm: 50 });
    /* Still a profile about somewhere: provider and attribution travel with it. */
    expect(merged.profile.provider).toBe('test');
    expect(merged.profile.coordinates).toEqual({ lat: 50, lng: -116 });
  });

  it('returns a single profile untouched with zero spread', () => {
    const a = profile(50, -116, 20, 40);
    const merged = mergeClimateProfiles([a]);
    expect(merged.profile).toBe(a);
    expect(merged.spread).toEqual({ maxHighDeltaC: 0, maxLowDeltaC: 0, maxPrecipDeltaMm: 0 });
  });

  it('refuses an empty list', () => {
    expect(() => mergeClimateProfiles([])).toThrow();
  });
});

describe('regionalUncertaintyNote', () => {
  it('says nothing for one point at local scale', () => {
    expect(regionalUncertaintyNote({ maxHighDeltaC: 0, maxLowDeltaC: 0, maxPrecipDeltaMm: 0 }, 1, 'settlement')).toBeNull();
    expect(regionalUncertaintyNote({ maxHighDeltaC: 0, maxLowDeltaC: 0, maxPrecipDeltaMm: 0 }, 1, 'district')).toBeNull();
  });

  it('names the number of points and the differences between them', () => {
    const note = regionalUncertaintyNote({ maxHighDeltaC: 7.2, maxLowDeltaC: 5, maxPrecipDeltaMm: 48 }, 3, 'region');
    expect(note).toBe('Compared 3 points across the region; typical highs differ by up to 7°C between them, and monthly rain by up to 48 mm, so conditions vary by valley and altitude.');
  });

  it('hedges a regional place that could only be read at one point', () => {
    const note = regionalUncertaintyNote({ maxHighDeltaC: 0, maxLowDeltaC: 0, maxPrecipDeltaMm: 0 }, 1, 'region');
    expect(note).toMatch(/one point only/);
    expect(note).toMatch(/altitude/);
  });

  it('says a coarse read is coarse for somewhere the size of a continent', () => {
    const note = regionalUncertaintyNote({ maxHighDeltaC: 12, maxLowDeltaC: 9, maxPrecipDeltaMm: 5 }, 3, 'continental');
    expect(note).toMatch(/several countries/);
    expect(note).toMatch(/coarse read/);
    expect(note).not.toMatch(/%/);
  });
});
