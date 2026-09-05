import { describe, expect, it } from 'vitest';
import { benchmarkTripRequestSchema } from '@sidequest/bench';
import { emptyComposerAnswers, type Trip } from '@sidequest/core';
import { buildHybridTripRequest } from './hybrid-request';

function tripFor(overrides: Partial<Trip['basics']> = {}): Trip {
  return {
    id: 'trip-1',
    status: 'draft',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    basics: {
      mode: 'known_destination',
      destinationInput: 'Iceland',
      regionId: 'dynamic',
      startDate: '2026-07-10',
      endDate: '2026-07-22',
      arrivalTime: '15:00',
      departureTime: '10:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
      ...overrides,
    },
  };
}

describe('buildHybridTripRequest', () => {
  it('produces a schema-valid request from a truly minimal composer capture', () => {
    const trip = tripFor();
    const composer = emptyComposerAnswers('known_destination', new Date('2026-06-01T00:00:00.000Z'));
    const request = buildHybridTripRequest({ trip, composer, profile: null, now: new Date('2026-06-01T00:00:00.000Z') });
    expect(() => benchmarkTripRequestSchema.parse(request)).not.toThrow();
    expect(request.dates.nights).toBe(12);
    expect(request.destination.text).toBe('Iceland');
    expect(
      Object.values(request.taste.interests).some(
        (level) => level === 'occasional' || level === 'frequent' || level === 'core',
      ),
    ).toBe(true);
  });

  it('produces a schema-valid request from no composer and no profile at all', () => {
    const trip = tripFor();
    const request = buildHybridTripRequest({ trip, composer: null, profile: null, now: new Date('2026-06-01T00:00:00.000Z') });
    expect(() => benchmarkTripRequestSchema.parse(request)).not.toThrow();
    expect(request.party.adults).toBe(2);
  });

  it('carries a stated circuit shape into a wider base count', () => {
    const trip = tripFor();
    const composer = {
      ...emptyComposerAnswers('known_destination', new Date('2026-06-01T00:00:00.000Z')),
      shape: 'circuit' as const,
      themes: ['outdoors' as const, 'mountains' as const],
      transport: 'drive' as const,
    };
    const request = buildHybridTripRequest({ trip, composer, profile: null, now: new Date('2026-06-01T00:00:00.000Z') });
    expect(request.movement.desiredBaseCount).toBeGreaterThan(1);
    expect(request.taste.interests.hiking).not.toBe('low');
  });
});
