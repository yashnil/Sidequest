import { describe, expect, it } from 'vitest';
import { encodePolyline, type Itinerary, type ItineraryDay } from '@sidequest/core';
import { arcCoords, journeyDay, journeyModel, legLabel } from './model';

function day(dayNumber: number, items: ItineraryDay['items'], baseId = 'base', baseName = 'Base Town'): ItineraryDay {
  return {
    dayNumber,
    date: `2026-08-1${dayNumber}`,
    baseId,
    baseName,
    theme: 'A day out',
    window: { startMinute: 540, endMinute: 1140, usableMinutes: 600 },
    items,
    totals: {},
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], notes: [] },
    availability: { status: 'all_open', notes: [] },
    weather: { status: 'unavailable', backups: [], notes: [] },
    warnings: [],
  } as unknown as ItineraryDay;
}

type Prov = 'measured' | 'estimated' | 'unmeasured';
const travel = (id: string, mode: string, provenance: Prov, extra: Record<string, unknown> = {}): ItineraryDay['items'][number] =>
  ({
    id,
    kind: 'travel',
    title: 'leg',
    startMinute: 0,
    endMinute: 0,
    durationMinutes: 0,
    reason: '',
    weatherSensitive: false,
    travel: { fromId: 'a', toId: 'b', fromName: 'a', toName: 'b', minutes: provenance === 'unmeasured' ? null : 20, km: null, mode, role: 'approach', provenance, ...(provenance === 'unmeasured' ? { unmeasuredReason: 'no_route_found' } : {}), ...extra },
  }) as unknown as ItineraryDay['items'][number];

const stop = (id: string, kind: 'activity' | 'meal', placeId: string | undefined, title: string): ItineraryDay['items'][number] =>
  ({ id, kind, title, ...(placeId ? { placeId } : {}), startMinute: 600, endMinute: 660, durationMinutes: 60, reason: `${title} is worth it. And more.`, weatherSensitive: false }) as unknown as ItineraryDay['items'][number];

const coordinates = { base: { lat: 64.14, lng: -21.94 }, p1: { lat: 64.25, lng: -21.13 }, p2: { lat: 64.3, lng: -20.9 }, cafe: { lat: 64.26, lng: -21.1 }, other: { lat: 65.68, lng: -18.09 } };

describe('the journey model', () => {
  it('numbers stops in order, skips meals in the numbering, and keeps time and shape evidence apart', () => {
    const geometry = encodePolyline([coordinates.base, { lat: 64.2, lng: -21.5 }, coordinates.p1]);
    const model = journeyDay({
      day: day(1, [
        travel('t1', 'drive', 'measured', { geometry, km: 48.2, provider: 'valhalla' }),
        stop('a1', 'activity', 'p1', 'Þingvellir'),
        travel('t2', 'drive', 'measured'),
        stop('m1', 'meal', 'cafe', 'Lunch'),
        travel('t3', 'walk', 'estimated'),
        stop('a2', 'activity', 'p2', 'Gullfoss'),
        travel('t4', 'drive', 'unmeasured'),
        stop('a3', 'activity', undefined, 'Somewhere nobody placed'),
      ]),
      coordinates,
    });
    expect(model.stops.map((s) => [s.kind, s.number, s.title])).toEqual([
      ['base', null, 'Base Town'],
      ['stop', 1, 'Þingvellir'],
      ['meal', null, 'Lunch'],
      ['stop', 2, 'Gullfoss'],
    ]);
    expect(model.unplaced).toBe(1);
    expect(model.legs.map((l) => [l.time, l.shape, l.coords.length, l.distanceBasis])).toEqual([
      ['measured', 'routed', 3, 'routed'],
      // A measured time with no published line is still a straight chord, never a road.
      ['measured', 'straight', 2, 'straight_line'],
      ['estimated', 'straight', 2, 'straight_line'],
    ]);
    expect(model.legs[0]!.shapeSource).toBe('valhalla');
    expect(model.legs[0]!.km).toBe(48.2);
    expect(model.stops[1]!.why).toBe('Þingvellir is worth it.');
    expect(model.totals).toMatchObject({ legs: 3, measuredLegs: 2, routedLegs: 1, minutes: 60 });
  });

  it('never borrows a shape for an estimate, even when one is stored', () => {
    const geometry = encodePolyline([coordinates.base, { lat: 64.2, lng: -21.5 }, coordinates.p1]);
    const model = journeyDay({ day: day(1, [travel('t1', 'drive', 'estimated', { geometry }), stop('a1', 'activity', 'p1', 'One')]), coordinates });
    expect(model.legs[0]!.shape).toBe('straight');
  });

  it('says what a leg is in words, including that a chord is not the route', () => {
    const model = journeyDay({ day: day(1, [travel('t1', 'walk', 'estimated'), stop('a1', 'activity', 'p1', 'One')]), coordinates });
    const label = legLabel(model.legs[0]!, (m) => `${m} min`);
    expect(label).toMatch(/^Walk · ≈20 min · estimate · ≈\d+ km straight-line · straight line, not the route$/);
    const unknown = journeyDay({ day: day(1, [travel('t1', 'drive', 'unmeasured'), stop('a1', 'activity', 'p1', 'One')]), coordinates });
    expect(legLabel(unknown.legs[0]!, (m) => `${m} min`)).toContain('time unknown');
    expect(unknown.totals.minutes).toBeNull();
  });

  it('marks a flight as a disconnected segment and draws it as an arc, not ground', () => {
    const model = journeyDay({ day: day(1, [travel('t1', 'unsupported', 'estimated', { hint: 'flight' }), stop('a1', 'activity', 'other', 'Akureyri')]), coordinates });
    expect(model.legs[0]!.mode === 'flight' || model.legs[0]!.mode === 'unknown').toBe(true);
    const arc = arcCoords([0, 0], [10, 0]);
    expect(arc.length).toBe(33);
    expect(Math.max(...arc.map(([, y]) => Math.abs(y)))).toBeGreaterThan(0.5);
  });

  it('builds the trip spine from the bases in sleeping order, with each base move', () => {
    const itinerary = {
      days: [
        day(1, [stop('a1', 'activity', 'p1', 'One')]),
        day(2, [travel('t2', 'drive', 'measured', { role: 'transfer' }), stop('a2', 'activity', 'other', 'Two')], 'north', 'Akureyri'),
        day(3, [stop('a3', 'activity', 'other', 'Three')], 'north', 'Akureyri'),
      ],
      package: { bases: [{ id: 'base', name: 'Base Town', nights: 1 }, { id: 'north', name: 'Akureyri', nights: 2 }] },
    } as unknown as Itinerary;
    const model = journeyModel({ itinerary, coordinates: { ...coordinates, north: coordinates.other } });
    expect(model.bases.map((b) => [b.name, b.nights, b.dayNumbers])).toEqual([
      ['Base Town', 1, [1]],
      ['Akureyri', 2, [2, 3]],
    ]);
    expect(model.moves).toHaveLength(1);
    expect(model.moves[0]!.time).toBe('measured');
    expect(model.moves[0]!.shape).toBe('straight');
  });
});
