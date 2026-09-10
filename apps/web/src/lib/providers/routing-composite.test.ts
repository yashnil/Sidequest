import { describe, expect, it, vi } from 'vitest';
import type { RoutingProvider, RoutingMatrixResult } from '@sidequest/compiler';
import { createCompositeRouting } from './routing-composite';
import { parseRoutingCoverage } from './routing-coverage';

/**
 * V6 §11 — A ROUTER THAT CANNOT BE REACHED IS NOT ASKED AGAIN.
 *
 * The production deployment pointed at a loopback Valhalla that did not exist on
 * the host. Every leg was attempted, every attempt failed as `provider_error`,
 * nothing learned from it, and two real trips measured 0 of N legs after
 * spending the whole verification budget. One `unreachable` answer now latches
 * the local router off for the rest of the build and falls through.
 */

const points = [
  { id: 'a', lat: 43.06, lng: 141.35 },
  { id: 'b', lat: 43.77, lng: 142.36 },
];

function matrixOf(reason: 'unreachable' | 'out_of_coverage' | 'not_found' | null): RoutingMatrixResult {
  return {
    ids: points.map((p) => p.id),
    minutes: [
      [0, reason ? Number.NaN : 100],
      [reason ? Number.NaN : 100, 0],
    ],
    km: [
      [0, reason ? Number.NaN : 150],
      [reason ? Number.NaN : 150, 0],
    ],
    provenance: { kind: reason ? 'estimated' : 'measured', note: 'test' },
    failedPairs: reason ? [{ from: 'a', to: 'b', reason }, { from: 'b', to: 'a', reason }] : [],
    calls: 1,
    elements: 4,
    reasonCounts: reason ? { [reason]: 2 } : {},
  } as RoutingMatrixResult;
}

function provider(name: string, answer: RoutingMatrixResult): RoutingProvider & { matrix: ReturnType<typeof vi.fn> } {
  return { name, supportedModes: () => ['car', 'foot'], matrix: vi.fn(async () => answer) } as never;
}

describe('the composite router and an unreachable local endpoint', () => {
  it('falls through to the global router on the first unreachable answer and never asks the local one again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const local = provider('valhalla', matrixOf('unreachable'));
    const global = provider('openrouteservice', matrixOf(null));
    const composite = createCompositeRouting({ local, localCoverage: parseRoutingCoverage(undefined), global })!;
    const first = await composite.matrix({ points, mode: 'car', maxElements: 100 });
    expect(first.provenance.kind).toBe('measured');
    expect(global.matrix).toHaveBeenCalledTimes(1);
    await composite.matrix({ points, mode: 'car', maxElements: 100 });
    expect(local.matrix).toHaveBeenCalledTimes(1);
    expect(global.matrix).toHaveBeenCalledTimes(2);
  });
  it('with no global router, answers unmeasured immediately after the first unreachable answer instead of spending the budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const local = provider('valhalla', matrixOf('unreachable'));
    const composite = createCompositeRouting({ local, localCoverage: parseRoutingCoverage(undefined), global: null })!;
    await composite.matrix({ points, mode: 'car', maxElements: 100 });
    const second = await composite.matrix({ points, mode: 'car', maxElements: 100 });
    expect(local.matrix).toHaveBeenCalledTimes(1);
    expect(second.provenance.kind).toBe('estimated');
    expect(second.provenance.note).toMatch(/could not be reached/);
    expect(second.failedPairs.every((p) => p.reason === 'insufficient_evidence')).toBe(true);
  });
  it('a genuine no-route answer is evidence about the ground and keeps the local router', async () => {
    const local = provider('valhalla', matrixOf('not_found'));
    const global = provider('openrouteservice', matrixOf(null));
    const composite = createCompositeRouting({ local, localCoverage: parseRoutingCoverage(undefined), global })!;
    await composite.matrix({ points, mode: 'car', maxElements: 100 });
    await composite.matrix({ points, mode: 'car', maxElements: 100 });
    expect(local.matrix).toHaveBeenCalledTimes(2);
    expect(global.matrix).not.toHaveBeenCalled();
  });
});
