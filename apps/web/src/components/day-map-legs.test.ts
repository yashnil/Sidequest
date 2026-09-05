import { describe, expect, it } from 'vitest';
import type { ItineraryDay } from '@sidequest/core';
import { dayMapModel } from './day-map-legs';

function day(items: ItineraryDay['items']): ItineraryDay {
  return {
    dayNumber: 2,
    date: '2026-08-13',
    baseId: 'base',
    baseName: 'Base Town',
    theme: 'A day out',
    window: { startMinute: 540, endMinute: 1140, usableMinutes: 600 },
    items,
    totals: { driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, travelMinutes: 0, travelKm: 0, activityMinutes: 0, freeMinutes: 0, unmeasuredLegCount: 0, strenuousCount: 0 },
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], notes: [] },
    availability: { status: 'all_open', notes: [] },
    weather: { status: 'unavailable', backups: [], notes: [] },
    warnings: [],
  } as unknown as ItineraryDay;
}

const travel = (id: string, mode: 'drive' | 'walk' | 'rail', provenance: 'measured' | 'unmeasured', role: 'approach' | 'return' = 'approach'): ItineraryDay['items'][number] =>
  ({
    id,
    kind: 'travel',
    title: 'leg',
    startMinute: 0,
    endMinute: 0,
    durationMinutes: 0,
    reason: '',
    weatherSensitive: false,
    travel: { fromId: 'a', toId: 'b', fromName: 'a', toName: 'b', minutes: provenance === 'measured' ? 20 : null, km: null, mode, role, provenance, ...(provenance === 'unmeasured' ? { unmeasuredReason: 'no_route_found' } : {}) },
  }) as unknown as ItineraryDay['items'][number];

const activity = (id: string, placeId: string, title: string): ItineraryDay['items'][number] =>
  ({ id, kind: 'activity', title, placeId, startMinute: 600, endMinute: 660, durationMinutes: 60, reason: '', weatherSensitive: false }) as unknown as ItineraryDay['items'][number];

describe('a day as map marks', () => {
  const coordinates = { base: { lat: 50, lng: 10 }, p1: { lat: 50.1, lng: 10.1 }, p2: { lat: 50.2, lng: 10.2 } };

  it('numbers the stops in order and styles each leg by what is known about it', () => {
    const model = dayMapModel({
      day: day([travel('t1', 'drive', 'measured'), activity('a1', 'p1', 'One'), travel('t2', 'walk', 'unmeasured'), activity('a2', 'p2', 'Two'), travel('t3', 'rail', 'measured', 'return')]),
      coordinates,
    });
    expect(model.markers.map((m) => [m.order, m.name])).toEqual([
      [1, 'One'],
      [2, 'Two'],
    ]);
    expect(model.connectors.map((c) => c.style)).toEqual(['measured_drive', 'unmeasured', 'measured_transit']);
    expect(model.base).toEqual(coordinates.base);
    expect(model.omitted).toBe(0);
  });

  it('counts a stop nobody positioned rather than dropping it silently, and never draws a leg to it', () => {
    const model = dayMapModel({ day: day([activity('a1', 'p1', 'One'), travel('t', 'drive', 'measured'), activity('a9', 'nowhere', 'Lost')]), coordinates });
    expect(model.markers).toHaveLength(1);
    expect(model.omitted).toBe(1);
    expect(model.connectors).toHaveLength(1);
  });

  it('a stop with no leg before it gets an unmeasured connector, never a measured one', () => {
    const model = dayMapModel({ day: day([activity('a1', 'p1', 'One'), activity('a2', 'p2', 'Two')]), coordinates });
    expect(model.connectors.map((c) => c.style)).toEqual(['unmeasured', 'unmeasured']);
  });
});

describe('LIVE WORLD V1 — route shapes on the day map', () => {
  it('a measured leg with a persisted polyline draws the road; one without stays a straight measured line; unmeasured never gets a shape', async () => {
    const { encodePolyline } = await import('@sidequest/core');
    const geometry = encodePolyline([{ lat: 50, lng: 10 }, { lat: 50.02, lng: 10.03 }, { lat: 50.05, lng: 10.02 }]);
    const day = {
      dayNumber: 1,
      baseId: 'base',
      items: [
        { id: 'l1', kind: 'travel', title: 'Drive to A', startMinute: 540, endMinute: 560, durationMinutes: 20, reason: 'x', weatherSensitive: false, travel: { fromId: 'base', toId: 'a', fromName: 'Base', toName: 'A', minutes: 20, km: 9, mode: 'drive', role: 'approach', provenance: 'measured', geometry } },
        { id: 'a', kind: 'activity', title: 'A', startMinute: 560, endMinute: 620, durationMinutes: 60, placeId: 'a', reason: 'x', weatherSensitive: false },
        { id: 'l2', kind: 'travel', title: 'Drive to B', startMinute: 620, endMinute: 640, durationMinutes: 20, reason: 'x', weatherSensitive: false, travel: { fromId: 'a', toId: 'b', fromName: 'A', toName: 'B', minutes: 20, km: 9, mode: 'drive', role: 'approach', provenance: 'measured' } },
        { id: 'b', kind: 'activity', title: 'B', startMinute: 640, endMinute: 700, durationMinutes: 60, placeId: 'b', reason: 'x', weatherSensitive: false },
        { id: 'l3', kind: 'travel', title: 'Travel to C', startMinute: 700, endMinute: 700, durationMinutes: 0, reason: 'x', weatherSensitive: false, travel: { fromId: 'b', toId: 'c', fromName: 'B', toName: 'C', minutes: null, km: null, mode: 'drive', role: 'approach', provenance: 'unmeasured', unmeasuredReason: 'no_route_found', geometry } },
        { id: 'c', kind: 'activity', title: 'C', startMinute: 700, endMinute: 760, durationMinutes: 60, placeId: 'c', reason: 'x', weatherSensitive: false },
      ],
    } as never;
    const model = dayMapModel({ day, coordinates: { base: { lat: 50, lng: 10 }, a: { lat: 50.05, lng: 10.02 }, b: { lat: 50.06, lng: 10.05 }, c: { lat: 50.07, lng: 10.06 } } });
    expect(model.connectors[0]!.path?.length).toBe(3);
    expect(model.connectors[0]!.style).toBe('measured_drive');
    expect(model.connectors[1]!.path).toBeUndefined();
    expect(model.connectors[1]!.style).toBe('measured_drive');
    expect(model.connectors[2]!.style).toBe('unmeasured');
    expect(model.connectors[2]!.path).toBeUndefined();
  });
});
