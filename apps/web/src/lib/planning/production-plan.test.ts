import { describe, expect, it } from 'vitest';
import { boardSignalsFor, compositionPreview, defaultProfileFor } from './production-plan';
import type { CompositionContext } from './composition';
import { testCompositionContext } from './testing/context';
import type { Trip } from '@sidequest/core';

/**
 * Discovery Board decisions reach the composition call as compact *signals*
 * — must include / interested / avoid — never as a list of what exists. The
 * model stays free to compose anything the board never carried.
 */
describe('boardSignalsFor', () => {
  const candidates = [
    { place: { id: 'a', name: 'Place A' } },
    { place: { id: 'b', name: 'Place B' } },
    { place: { id: 'c', name: 'Place C' } },
  ] as never;

  it('maps included → mustInclude, maybe → interested, excluded → avoid', () => {
    const out = boardSignalsFor(candidates, [
      { placeId: 'a', status: 'included' },
      { placeId: 'b', status: 'maybe' },
      { placeId: 'c', status: 'excluded' },
    ]);
    expect(out).toEqual({ mustInclude: ['Place A'], interested: ['Place B'], avoid: ['Place C'] });
  });

  it('ignores a selection whose place is not on the board, and returns nothing for none', () => {
    expect(boardSignalsFor(candidates, [{ placeId: 'nowhere', status: 'included' }])).toBeUndefined();
    expect(boardSignalsFor(candidates, [])).toBeUndefined();
  });

  it('caps each list at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ placeId: `p${i}`, status: 'included' }));
    const manyCandidates = Array.from({ length: 15 }, (_, i) => ({ place: { id: `p${i}`, name: `Place ${i}` } })) as never;
    expect(boardSignalsFor(manyCandidates, many)?.mustInclude.length).toBe(10);
  });
});

const TRIP: Trip = {
  id: 'trip-1',
  basics: {
    mode: 'known_destination',
    destinationInput: 'Somewhere',
    regionId: 'dynamic',
    startDate: '2026-08-12',
    endDate: '2026-08-16',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  },
  status: 'draft',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('defaultProfileFor', () => {
  it('produces a complete profile from nothing but the trip, and honours composer answers on top', () => {
    const plain = defaultProfileFor(TRIP, null);
    expect(plain.pace).toBe('balanced');
    expect(plain.transport.willDrive).toBe(true);
    const composed = defaultProfileFor(TRIP, {
      schemaVersion: 1,
      pace: 'slow',
      transport: 'public_transport',
      outdoorIntensity: 'gentle',
      themes: [],
      adults: 2,
      children: 0,
      travelerNeeds: [],
      mustDoDecisions: [],
      skipped: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as never);
    expect(composed.pace).toBe('slow');
    expect(composed.transport.willDrive).toBe(false);
    expect(composed.dailyIntensity).toBe('light');
  });
});

describe('the composition call is told the traveller and the trip, never the POI universe', () => {
  it('carries preferences and signals and contains no coordinates, ids, hours or provenance', () => {
    const context: CompositionContext = testCompositionContext({
      trip: TRIP,
      envelope: { name: 'Somewhere', countryCode: 'XX', scale: 'city', center: { lat: 10.12345, lng: 20.54321 } },
      boardSignals: { mustInclude: ['Place A'], interested: [], avoid: ['Place C'] },
    });
    const preview = compositionPreview(context);
    const wire = JSON.stringify(preview);
    expect(preview.task).toContain('WHAT TO RETURN');
    expect(wire).toContain('Place A');
    expect(wire).toContain('Place C');
    for (const forbidden of ['placeIndex', 'provenance', 'openingHours', 'sourceUrl', 'wikidata', 'routeLegs', 'clusters', 'candidates']) {
      expect(wire, forbidden).not.toContain(forbidden);
    }
    // Only the destination centre carries a coordinate, rounded to two places.
    expect(wire).toContain('10.12, 20.54');
    expect(wire).not.toContain('10.12345');
  });
});

/**
 * MVP V3, Stage 3 — the traveller's own phrase is not thrown away by the resolver.
 *
 * "the steppes" resolving to a town is a lead, not a correction, and the layer
 * best placed to honour the phrase is the one composing the trip. The negative
 * half matters as much: repeating the phrase when it already matches the
 * resolved name is noise in a prompt that pays for every token.
 */
describe('the destination the traveller typed', () => {
  it('reaches the composition task when the resolver landed somewhere else', () => {
    const { task } = compositionPreview(testCompositionContext({
      trip: TRIP,
      envelope: { name: 'Fairbanks', qualifiedName: 'Fairbanks, Alaska', travellerPhrase: 'inland Alaska', center: { lat: 64.8, lng: -147.7 } },
    }));
    expect(task).toContain('inland Alaska');
    expect(task).toMatch(/Plan the trip they described/);
  });

  it('is not repeated when it is the same place', () => {
    const { task } = compositionPreview(testCompositionContext({ trip: TRIP, envelope: { name: 'Hong Kong', center: { lat: 22.3, lng: 114.2 } } }));
    expect(task).not.toMatch(/The traveller wrote/);
  });
});
