import { describe, expect, it } from 'vitest';
import { baseLine, catalogueNumbers, countdown, countdownWords, coverTrip, formatCatalogue, projectShape, stampTilt } from './stamp-geometry';

const box = { width: 100, height: 100, pad: 10 };

describe('a stamp is drawn from the trip’s own coordinates', () => {
  it('draws nothing it was not given: no coordinates, no route, only the centre mark', () => {
    const empty = projectShape({ center: null, bases: [], stops: [] }, box);
    expect(empty.bases).toEqual([]);
    expect(empty.stops).toEqual([]);
    expect(empty.center).toBeNull();
    const centred = projectShape({ center: { lat: 64.1, lng: -21.9 }, bases: [], stops: [] }, box);
    expect(centred.center).toEqual({ x: 50, y: 50 });
  });

  it('keeps geography the right way up and inside the box', () => {
    // Reykjavík (west), Höfn (east), Akureyri (north).
    const shape = projectShape(
      {
        center: null,
        bases: [
          { name: 'Reykjavík', lat: 64.147, lng: -21.943 },
          { name: 'Höfn', lat: 64.254, lng: -15.208 },
          { name: 'Akureyri', lat: 65.689, lng: -18.126 },
        ],
        stops: [],
      },
      box,
    );
    const [rey, hofn, aku] = shape.bases;
    expect(rey!.x).toBeLessThan(hofn!.x);
    expect(aku!.y).toBeLessThan(rey!.y);
    for (const p of shape.bases) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 0.1);
      expect(p.x).toBeLessThanOrEqual(90 + 0.1);
      expect(p.y).toBeGreaterThanOrEqual(10 - 0.1);
      expect(p.y).toBeLessThanOrEqual(90 + 0.1);
    }
    expect(shape.extent).toMatchObject({ north: 65.689, south: 64.147 });
  });

  it('does not magnify one place into a fake shape', () => {
    const one = projectShape({ center: null, bases: [{ name: 'Porto', lat: 41.15, lng: -8.61 }], stops: [{ lat: 41.15001, lng: -8.61001, day: 1 }] }, box);
    expect(one.bases[0]).toMatchObject({ x: 50, y: 50 });
    expect(one.stops[0]).toMatchObject({ x: 50, y: 50 });
  });

  it('keeps a trip across the antimeridian in one piece', () => {
    const fiji = projectShape({ center: null, bases: [{ name: 'A', lat: -17, lng: 179.5 }, { name: 'B', lat: -17.2, lng: -179.5 }], stops: [] }, box);
    expect(Math.abs(fiji.bases[0]!.x - fiji.bases[1]!.x)).toBeGreaterThan(50);
    expect(fiji.bases[0]!.x).toBeLessThan(fiji.bases[1]!.x);
  });

  it('collapses two stays in one town into one mark on the line', () => {
    expect(baseLine([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 5, y: 5 }])).toHaveLength(2);
  });
});

describe('the collection’s numbers', () => {
  const rows = [
    { id: 'c', startDate: '2027-05-11' },
    { id: 'a', startDate: '2026-08-01' },
    { id: 'b', startDate: '2026-08-01' },
  ];

  it('numbers trips by when they are taken, stably, over the whole collection', () => {
    const numbers = catalogueNumbers(rows);
    expect(numbers.get('a')).toBe(1);
    expect(numbers.get('b')).toBe(2);
    expect(numbers.get('c')).toBe(3);
    expect(formatCatalogue(3)).toBe('No. 03');
  });

  it('tilts every stamp, deterministically, never flat', () => {
    expect(stampTilt('trip-1')).toBe(stampTilt('trip-1'));
    for (const id of ['a', 'b', 'trip-1', 'f5a7b58f-9833']) {
      const t = stampTilt(id);
      expect(Math.abs(t)).toBeGreaterThanOrEqual(1.2);
      expect(Math.abs(t)).toBeLessThanOrEqual(6.5);
    }
  });

  it('counts down, counts the day, and says when a trip is over', () => {
    const trip = { startDate: '2026-11-10', nights: 4, timing: 'fixed' as const };
    expect(countdown(trip, '2026-10-25')).toEqual({ kind: 'until', days: 16 });
    expect(countdown(trip, '2026-11-12')).toEqual({ kind: 'during', day: 3, of: 5 });
    expect(countdown(trip, '2026-11-15')).toEqual({ kind: 'past' });
    expect(countdown({ ...trip, timing: 'open' }, '2026-10-25')).toEqual({ kind: 'open' });
    expect(countdownWords({ kind: 'until', days: 1 })).toBe('Tomorrow');
    expect(countdownWords({ kind: 'during', day: 3, of: 5 })).toBe('Day 3 of 5');
  });

  it('puts the trip under way on the cover, else the nearest one ahead, never a past or open one', () => {
    const base = { nights: 3, timing: 'fixed' as const, lifecycle: 'planning' };
    const rows2 = [
      { ...base, id: 'later', startDate: '2027-01-10' },
      { ...base, id: 'soon', startDate: '2026-11-02' },
      { ...base, id: 'gone', startDate: '2026-01-01', lifecycle: 'past' },
      { ...base, id: 'idea', startDate: '2026-10-26', timing: 'open' as const },
    ];
    expect(coverTrip(rows2, '2026-10-25')?.id).toBe('soon');
    expect(coverTrip([...rows2, { ...base, id: 'now', startDate: '2026-10-24' }], '2026-10-25')?.id).toBe('now');
    expect(coverTrip([rows2[2]!, rows2[3]!], '2026-10-25')).toBeNull();
  });
});
