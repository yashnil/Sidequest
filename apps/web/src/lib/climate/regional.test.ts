import { describe, expect, it, vi } from 'vitest';
import type { ClimateProfile } from '@sidequest/core';

vi.mock('server-only', () => ({}));
vi.mock('../destinations/preflight', () => ({ climateWithReason: vi.fn(async () => ({ profile: null, reason: 'provider_unavailable' })) }));

import { geographicScaleOf, regionalClimate } from './regional';

function profileAt(lat: number, lng: number, high: number): ClimateProfile {
  return {
    schemaVersion: 1,
    coordinates: { lat, lng },
    sampleYearFrom: 2005,
    sampleYearTo: 2024,
    months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, temperature: { low: high - 12, high }, precipitationMm: 50, wetDays: 8, snowDays: 0, daylightHours: 12, hotDays: 0, freezeDays: 0 })),
    provider: 'fixture',
    dataset: 'fixture',
    attribution: 'Fixture normals',
    retrievedAt: '2026-09-01T00:00:00.000Z',
  };
}

const NOW = new Date('2026-09-11T00:00:00Z');
const BOX = { southWest: { lat: 49, lng: -119 }, northEast: { lat: 54, lng: -114 } };

describe('regionalClimate', () => {
  it('reads three points across a regional box and merges them with a sentence about the spread', async () => {
    const lookup = vi.fn(async (c: { lat: number; lng: number }) => ({ profile: profileAt(c.lat, c.lng, c.lat > 52 ? 12 : c.lat < 51 ? 22 : 18), reason: null }));
    const out = await regionalClimate({ center: { lat: 51.5, lng: -116.5 }, bounds: BOX, scale: 'region' }, NOW, lookup);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(out.sampled).toBe(3);
    expect(out.profile?.months[0]!.temperature.high).toBeCloseTo(17.3, 1);
    expect(out.note).toMatch(/Compared 3 points across the region/);
    expect(out.note).toMatch(/10°C/);
  });

  it('keeps what answered when one point fails, and reports the reason only when none did', async () => {
    let calls = 0;
    const flaky = vi.fn(async (c: { lat: number; lng: number }) => {
      calls += 1;
      return calls === 2 ? { profile: null, reason: 'provider_rate_limited' as const } : { profile: profileAt(c.lat, c.lng, 20), reason: null };
    });
    const out = await regionalClimate({ center: { lat: 51.5, lng: -116.5 }, bounds: BOX, scale: 'region' }, NOW, flaky);
    expect(out.sampled).toBe(2);
    expect(out.reason).toBeNull();
    expect(out.profile).not.toBeNull();

    const dead = vi.fn(async () => ({ profile: null, reason: 'provider_rate_limited' as const }));
    const none = await regionalClimate({ center: { lat: 51.5, lng: -116.5 }, bounds: BOX, scale: 'region' }, NOW, dead);
    expect(none.profile).toBeNull();
    expect(none.reason).toBe('provider_rate_limited');
    expect(none.sampled).toBe(0);
  });

  it('samples one point for a town, with no hedge, and one point for a region without a box, with a hedge', async () => {
    const lookup = vi.fn(async (c: { lat: number; lng: number }) => ({ profile: profileAt(c.lat, c.lng, 20), reason: null }));
    const town = await regionalClimate({ center: { lat: 48.2, lng: 16.4 }, bounds: { southWest: { lat: 48.1, lng: 16.2 }, northEast: { lat: 48.3, lng: 16.6 } }, scale: 'settlement' }, NOW, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(town.note).toBeNull();
    const region = await regionalClimate({ center: { lat: 51.5, lng: -116.5 }, bounds: null, scale: 'region' }, NOW, lookup);
    expect(region.sampled).toBe(1);
    expect(region.note).toMatch(/one point only/);
  });

  it('reads an unknown scale as a single place', () => {
    expect(geographicScaleOf('region')).toBe('region');
    expect(geographicScaleOf('shop')).toBeNull();
    expect(geographicScaleOf(null)).toBeNull();
  });
});
