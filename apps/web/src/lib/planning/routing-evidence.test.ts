import { describe, expect, it, vi } from 'vitest';
import { acquireRoute, emptyLedger } from './skeleton-adapter';
import { evidenceMatrixOf } from './reconcile';

const A = { id: 'a', lat: 41.15, lng: -8.61 };
const B = { id: 'b', lat: 41.16, lng: -8.63 };
const matrix = (kind: 'estimated' | 'measured') => ({ mode: 'car', ids: ['a', 'b'], minutes: [[0, 12], [12, 0]], km: [[0, 5], [5, 0]], provenance: { kind, note: 'test' } }) as never;
const router = () => vi.fn(async () => ({ ids: ['a', 'b'], minutes: [[0, 14], [14, 0]], km: [[0, 6], [6, 0]], provenance: { kind: 'measured' } }) as never);

describe('a scanned region still asks the router (private alpha finding)', () => {
  it('an estimated matrix is not evidence: the build requests the leg', async () => {
    const routeMatrix = router();
    await acquireRoute(emptyLedger(), routeMatrix, [A, B], evidenceMatrixOf(matrix('estimated')));
    expect(routeMatrix).toHaveBeenCalledTimes(1);
  });

  it('a measured matrix is: a pair it already knows is never bought twice', async () => {
    const routeMatrix = router();
    await acquireRoute(emptyLedger(), routeMatrix, [A, B], evidenceMatrixOf(matrix('measured')));
    expect(routeMatrix).not.toHaveBeenCalled();
  });
});
