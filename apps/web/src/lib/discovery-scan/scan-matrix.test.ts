import { describe, expect, it, vi } from 'vitest';
import type { RoutingMatrixResult, RoutingProvider } from '@sidequest/compiler';
import type { ScanPoint } from '@sidequest/core';

vi.mock('server-only', () => ({}));

import { MAX_SCAN_MATRIX_REQUESTS, SCAN_MATRIX_MAX_ELEMENTS, measureScanMatrix, planScanMatrixRequests } from './scan-matrix';
import { ORS_MATRIX_MAX_PAIRS } from '../providers/openrouteservice';
import { MAX_MATRIX_PAIRS_PER_REQUEST } from '../providers/valhalla';

/*
 * Synthetic geography only. A "road" here is a table of minutes the fake
 * router answers from; any pair it has no figure for it declines.
 */
const pt = (id: string, kind: 'base' | 'place', lat: number, lng: number): ScanPoint => ({ id, kind, key: id, name: id, coordinates: { lat, lng } });

function fakeRouter(options: {
  minutes: (a: string, b: string) => number | null;
  throwOnMatrix?: boolean;
  route?: RoutingProvider['route'];
  seen?: number[];
}): RoutingProvider {
  return {
    name: 'fake-router',
    supportedModes: () => ['car', 'foot'],
    async matrix({ points, maxElements }): Promise<RoutingMatrixResult> {
      options.seen?.push(points.length);
      if (points.length * points.length > maxElements) throw new Error('asked beyond its own ceiling');
      if (options.throwOnMatrix) throw new Error('router down');
      const ids = points.map((p) => p.id);
      const failedPairs: RoutingMatrixResult['failedPairs'] = [];
      const minutes = points.map((a) =>
        points.map((b) => {
          if (a.id === b.id) return 0;
          const m = options.minutes(a.id, b.id);
          if (m === null) {
            failedPairs.push({ from: a.id, to: b.id, reason: 'insufficient_evidence' });
            return Number.NaN;
          }
          return m;
        }),
      );
      return { ids, minutes, km: minutes.map((row) => row.map((m) => (Number.isFinite(m) ? m : Number.NaN))), provenance: { kind: 'measured', note: 'fake' }, failedPairs, calls: 1, elements: points.length ** 2 };
    },
    ...(options.route ? { route: options.route } : {}),
  };
}

describe('scan matrix requests respect the provider limits', () => {
  it('keeps the request ceiling in step with both routers', () => {
    expect(SCAN_MATRIX_MAX_ELEMENTS).toBe(ORS_MATRIX_MAX_PAIRS);
    expect(SCAN_MATRIX_MAX_ELEMENTS).toBe(MAX_MATRIX_PAIRS_PER_REQUEST);
  });

  it('chunks every base → place row into requests of at most twenty points, every base in each', () => {
    const bases = Array.from({ length: 4 }, (_, i) => pt(`b${i}`, 'base', 10 + i * 0.3, 50));
    const places = Array.from({ length: 70 }, (_, i) => pt(`p${i}`, 'place', 10 + (i % 7) * 0.1, 50 + Math.floor(i / 7) * 0.1));
    const points = [...bases, ...places];
    const requests = planScanMatrixRequests(points);
    for (const r of requests) {
      expect(r.points.length * r.points.length).toBeLessThanOrEqual(SCAN_MATRIX_MAX_ELEMENTS);
      expect(r.points.filter((i) => points[i]!.kind === 'base')).toHaveLength(4);
    }
    const covered = new Set(requests.flatMap((r) => r.points.filter((i) => points[i]!.kind === 'place')));
    expect(covered.size).toBe(70);
    expect(requests.length).toBe(Math.ceil(70 / 16));
  });

  it('splits bases into groups when there are many, so a request still has room for places', () => {
    const bases = Array.from({ length: 14 }, (_, i) => pt(`b${i}`, 'base', 10 + i * 0.3, 50));
    const places = Array.from({ length: 30 }, (_, i) => pt(`p${i}`, 'place', 10 + i * 0.05, 50.1));
    const requests = planScanMatrixRequests([...bases, ...places]);
    for (const r of requests) expect(r.points.length).toBeLessThanOrEqual(20);
    expect(requests.length).toBe(Math.ceil(30 / 10) + Math.ceil(30 / 16));
  });

  it('measures every base row through a fake router and never asks beyond the ceiling', async () => {
    const bases = [pt('b0', 'base', 10, 50), pt('b1', 'base', 10.5, 50)];
    const places = Array.from({ length: 40 }, (_, i) => pt(`p${i}`, 'place', 10 + i * 0.01, 50.05));
    const seen: number[] = [];
    const routing = fakeRouter({ minutes: () => 30, seen });
    const outcome = await measureScanMatrix({ points: [...bases, ...places], mode: 'car', routing, deadline: () => false });
    expect(Math.max(...seen)).toBeLessThanOrEqual(20);
    expect(outcome.baseRows.measured).toBe(outcome.baseRows.total);
    expect(outcome.baseRows.total).toBe(2 * 40 * 2);
    expect(outcome.requests.sent).toBeLessThanOrEqual(MAX_SCAN_MATRIX_REQUESTS);
  });
});

describe('route feasibility from the scan', () => {
  /* Base B; a north trailhead N 45 min away; a west lookout W 2 h 45 away; N and W are 5.6 km apart in a straight line and the router declines that pair. */
  const B = pt('B', 'base', 10.2, 50.2);
  const N = pt('N', 'place', 10.1, 49.8);
  const W = pt('W', 'place', 10.05, 49.8);
  const table: Record<string, number> = { 'B>N': 45, 'N>B': 45, 'B>W': 165, 'W>B': 165 };

  it('bounds the declined pair from the measured base rows', async () => {
    const outcome = await measureScanMatrix({ points: [B, N, W], mode: 'car', routing: fakeRouter({ minutes: (a, b) => table[`${a}>${b}`] ?? null }), deadline: () => false });
    const m = outcome.matrix;
    const n = m.ids.indexOf('N');
    const w = m.ids.indexOf('W');
    expect(m.minutes[n]![w]).toBeGreaterThanOrEqual(120);
    expect(m.feasibility![n]![w]).toBe('bounded_estimate');
    expect(m.feasibility![m.ids.indexOf('B')]![w]).toBe('verified');
  });

  it('a direct route that evaluates both ends and reports no route marks the pair disconnected', async () => {
    const routing = fakeRouter({
      minutes: (a, b) => (a === 'B' && b === 'N') || (a === 'N' && b === 'B') ? 45 : null,
      route: async () => ({ found: false, minutes: null, km: null, reason: 'not_found' }),
    });
    const outcome = await measureScanMatrix({ points: [B, N, W], mode: 'car', routing, deadline: () => false });
    const m = outcome.matrix;
    expect(m.feasibility![m.ids.indexOf('B')]![m.ids.indexOf('W')]).toBe('disconnected');
    expect(outcome.confirmations.noRoute).toBe(1);
  });

  it('a matrix cell the router declines is never disconnected', async () => {
    const outcome = await measureScanMatrix({ points: [B, N, W], mode: 'car', routing: fakeRouter({ minutes: () => null }), deadline: () => false });
    expect(outcome.counts.disconnected).toBe(0);
  });

  it('a provider failure is provider_unavailable, never disconnected', async () => {
    const routing = fakeRouter({ minutes: () => 30, throwOnMatrix: true, route: async () => ({ found: false, minutes: null, km: null, reason: 'provider_error' }) });
    const outcome = await measureScanMatrix({ points: [B, N, W], mode: 'car', routing, deadline: () => false });
    expect(outcome.counts.disconnected).toBe(0);
    expect(outcome.counts.provider_unavailable).toBe(6);
    expect(outcome.requests.failed).toBe(1);
  });

  it('no router at all is provider_unavailable everywhere', async () => {
    const outcome = await measureScanMatrix({ points: [B, N, W], mode: 'car', routing: null, deadline: () => false });
    expect(outcome.counts.provider_unavailable).toBe(6);
    expect(outcome.measuredPairs).toBe(0);
  });
});
