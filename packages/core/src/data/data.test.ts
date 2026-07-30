import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA, EASTERN_SIERRA_PLACES, resolveRegion, validateSeedData } from './index';
import { tripBasicsSchema, tripMonths, countTripDays } from '../schemas/trip';

describe('seed data', () => {
  it('validates against the place schema', () => {
    expect(() => validateSeedData()).not.toThrow();
  });

  it('has unique ids and belongs to the region', () => {
    const ids = EASTERN_SIERRA_PLACES.map((place) => place.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const place of EASTERN_SIERRA_PLACES) {
      expect(place.regionId).toBe(EASTERN_SIERRA.id);
    }
  });

  it('covers both the base town and satellites across the detour range', () => {
    const bases = EASTERN_SIERRA_PLACES.filter((place) => place.relationship === 'base');
    const satellites = EASTERN_SIERRA_PLACES.filter((place) => place.relationship === 'satellite');
    expect(bases.length).toBeGreaterThanOrEqual(2);
    expect(satellites.length).toBeGreaterThanOrEqual(10);

    const driveTimes = satellites.map((place) => place.travelFromBase.driveMinutes);
    expect(Math.min(...driveTimes)).toBeLessThanOrEqual(20);
    expect(Math.max(...driveTimes)).toBeGreaterThanOrEqual(90);
  });

  it('gives every place a source and a seasonal window', () => {
    for (const place of EASTERN_SIERRA_PLACES) {
      expect(place.source.name.length).toBeGreaterThan(0);
      expect(place.source.confidence).toBeGreaterThan(0);
      expect(place.seasonalAccess.openMonths.length).toBeGreaterThan(0);
    }
  });

  it('records the seasonal reality of Reds Meadow', () => {
    const postpile = EASTERN_SIERRA_PLACES.find((place) => place.id === 'devils-postpile');
    expect(postpile).toBeDefined();
    expect(postpile?.seasonalAccess.openMonths).not.toContain(1);
    expect(postpile?.seasonalAccess.shuttleMonths.length).toBeGreaterThan(0);
    expect(postpile?.seasonalAccess.closureRisk).toBe('high');
  });

  it('resolves the destination a traveller would actually type', () => {
    expect(resolveRegion('Mammoth Lakes')?.id).toBe('eastern-sierra');
    expect(resolveRegion('mammoth')?.id).toBe('eastern-sierra');
    expect(resolveRegion('Mammoth Lakes, CA')?.id).toBe('eastern-sierra');
    expect(resolveRegion('Reykjavik')).toBeNull();
    expect(resolveRegion('   ')).toBeNull();
  });
});

describe('trip basics', () => {
  const valid = {
    mode: 'known_destination' as const,
    destinationInput: 'Mammoth Lakes',
    regionId: 'eastern-sierra',
    startDate: '2026-08-12',
    endDate: '2026-08-15',
    arrivalTime: '14:00',
    departureTime: '11:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  };

  it('accepts a well-formed trip', () => {
    expect(tripBasicsSchema.parse(valid).regionId).toBe('eastern-sierra');
  });

  it('rejects an end date before the start date', () => {
    const result = tripBasicsSchema.safeParse({ ...valid, endDate: '2026-08-10' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['endDate']);
  });

  it('rejects an implausibly long trip', () => {
    const result = tripBasicsSchema.safeParse({ ...valid, endDate: '2026-10-30' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed date rather than coercing it', () => {
    expect(tripBasicsSchema.safeParse({ ...valid, startDate: '12/08/2026' }).success).toBe(false);
    expect(tripBasicsSchema.safeParse({ ...valid, arrivalTime: '25:00' }).success).toBe(false);
  });

  it('counts days inclusively and reports every month the trip touches', () => {
    expect(countTripDays('2026-08-12', '2026-08-15')).toBe(4);
    expect(countTripDays('2026-08-12', '2026-08-12')).toBe(1);
    expect(tripMonths('2026-08-12', '2026-08-15')).toEqual([8]);
    expect(tripMonths('2026-09-28', '2026-10-03')).toEqual([9, 10]);
  });
});
