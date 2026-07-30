import { describe, expect, it } from 'vitest';
import { clusterByTravelTime } from './cluster';
import { haversineKm } from './distance';
import { leg, routeSummary, subMatrix, tryLeg, validateMatrix } from './matrix';
import { orderStops } from './order';
import { MatrixError, type TravelTimeMatrix } from './types';

function matrixOf(ids: string[], minutes: number[][]): TravelTimeMatrix {
  return {
    mode: 'car',
    ids,
    minutes,
    km: minutes.map((row) => row.map((value) => value * 0.8)),
    provenance: { kind: 'modelled', note: 'test' },
  };
}

/** base, near, far — a straight line so the expected ordering is obvious. */
const LINE = matrixOf(
  ['base', 'a', 'b', 'c'],
  [
    [0, 10, 20, 30],
    [10, 0, 10, 20],
    [20, 10, 0, 10],
    [30, 20, 10, 0],
  ],
);

describe('haversine', () => {
  it('measures a known distance', () => {
    // Mammoth Lakes to Mono Lake South Tufa, roughly 33 km straight line.
    const km = haversineKm({ id: 'a', lat: 37.6485, lng: -118.9721 }, { id: 'b', lat: 37.9375, lng: -119.0264 });
    expect(km).toBeGreaterThan(30);
    expect(km).toBeLessThan(36);
  });

  it('is zero for a point against itself and symmetric', () => {
    const a = { id: 'a', lat: 37.6, lng: -119 };
    const b = { id: 'b', lat: 38.1, lng: -118.4 };
    expect(haversineKm(a, a)).toBe(0);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
});

describe('matrix validation', () => {
  it('accepts a well-formed matrix', () => {
    expect(() => validateMatrix(LINE)).not.toThrow();
  });

  it('rejects a ragged matrix', () => {
    const broken = matrixOf(['a', 'b'], [[0, 5], [5]]);
    expect(() => validateMatrix(broken)).toThrow(MatrixError);
  });

  it('rejects a non-zero diagonal', () => {
    const broken = matrixOf(['a', 'b'], [[7, 5], [5, 0]]);
    expect(() => validateMatrix(broken)).toThrow(/itself/);
  });

  it('rejects negative, missing and non-numeric travel times', () => {
    expect(() => validateMatrix(matrixOf(['a', 'b'], [[0, -5], [5, 0]]))).toThrow(MatrixError);
    expect(() =>
      validateMatrix(matrixOf(['a', 'b'], [[0, Number.NaN], [5, 0]])),
    ).toThrow(MatrixError);
    expect(() =>
      validateMatrix({ ...LINE, minutes: [[0, 1, 2, 3], [1, 0, 1, 2], [2, 1, 0, 1], []] }),
    ).toThrow(MatrixError);
  });

  it('rejects duplicate ids and an empty matrix', () => {
    expect(() => validateMatrix(matrixOf(['a', 'a'], [[0, 1], [1, 0]]))).toThrow(/duplicate/);
    expect(() => validateMatrix(matrixOf([], []))).toThrow(/no points/);
  });

  /** The bug this prevents: a missing leg read as zero, teleporting the traveller. */
  it('throws rather than returning zero for an unknown point', () => {
    expect(() => leg(LINE, 'base', 'nowhere')).toThrow(MatrixError);
    expect(tryLeg(LINE, 'base', 'nowhere')).toBeNull();
  });

  it('reads legs and totals a route', () => {
    expect(leg(LINE, 'base', 'c')).toEqual({ minutes: 30, km: 24 });
    const summary = routeSummary(LINE, ['base', 'a', 'b', 'base']);
    expect(summary.totalMinutes).toBe(10 + 10 + 20);
    expect(summary.legs).toHaveLength(3);
  });

  it('narrows to a subset while preserving order', () => {
    const sub = subMatrix(LINE, ['c', 'base']);
    expect(sub.ids).toEqual(['c', 'base']);
    expect(sub.minutes[0]?.[1]).toBe(30);
  });
});

describe('clustering', () => {
  it('groups by travel time, not by map distance', () => {
    const clusters = clusterByTravelTime(LINE, ['a', 'b', 'c'], { k: 2, baseId: 'base' });
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((cluster) => cluster.memberIds.length).sort();
    expect(sizes).toEqual([1, 2]);
    // Every point lands in exactly one cluster.
    const all = clusters.flatMap((cluster) => cluster.memberIds).sort();
    expect(all).toEqual(['a', 'b', 'c']);
  });

  it('gives each point its own cluster when k is large', () => {
    const clusters = clusterByTravelTime(LINE, ['a', 'b'], { k: 5, baseId: 'base' });
    expect(clusters).toHaveLength(2);
  });

  it('orders clusters nearest-to-base first', () => {
    const clusters = clusterByTravelTime(LINE, ['a', 'b', 'c'], { k: 2, baseId: 'base' });
    const firstDistance = leg(LINE, 'base', clusters[0]!.medoidId).minutes;
    const secondDistance = leg(LINE, 'base', clusters[1]!.medoidId).minutes;
    expect(firstDistance).toBeLessThanOrEqual(secondDistance);
  });

  it('is deterministic', () => {
    const once = clusterByTravelTime(LINE, ['a', 'b', 'c'], { k: 2, baseId: 'base' });
    const twice = clusterByTravelTime(LINE, ['c', 'b', 'a'], { k: 2, baseId: 'base' });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('refuses unknown points', () => {
    expect(() => clusterByTravelTime(LINE, ['a', 'zzz'], { k: 2 })).toThrow(MatrixError);
  });
});

describe('stop ordering', () => {
  it('returns a round trip that starts and ends at base', () => {
    const route = orderStops(LINE, { startId: 'base', endId: 'base', stopIds: ['c', 'a', 'b'] });
    expect(route.path[0]).toBe('base');
    expect(route.path[route.path.length - 1]).toBe('base');
    expect(route.path).toHaveLength(5);
  });

  it('finds the optimal order on a line rather than the given one', () => {
    const route = orderStops(LINE, { startId: 'base', endId: 'base', stopIds: ['c', 'a', 'b'] });
    expect(route.path).toEqual(['base', 'a', 'b', 'c', 'base']);
    expect(route.totalMinutes).toBe(60);
  });

  it('handles the empty and single-stop cases', () => {
    expect(orderStops(LINE, { startId: 'base', endId: 'base', stopIds: [] }).path).toEqual(['base']);
    const one = orderStops(LINE, { startId: 'base', endId: 'base', stopIds: ['b'] });
    expect(one.path).toEqual(['base', 'b', 'base']);
    expect(one.totalMinutes).toBe(40);
  });

  it('ignores duplicates and the base appearing as a stop', () => {
    const route = orderStops(LINE, {
      startId: 'base',
      endId: 'base',
      stopIds: ['a', 'a', 'base', 'b'],
    });
    expect(route.path).toEqual(['base', 'a', 'b', 'base']);
  });

  it('is deterministic regardless of input order', () => {
    const a = orderStops(LINE, { startId: 'base', endId: 'base', stopIds: ['a', 'b', 'c'] });
    const b = orderStops(LINE, { startId: 'base', endId: 'base', stopIds: ['c', 'b', 'a'] });
    expect(a.path).toEqual(b.path);
  });
});
