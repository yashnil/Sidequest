import { describe, expect, it } from 'vitest';
import { boundTravelMatrix, boundedLegMinutes, lowerBoundFrom, routePairKey, triangleLowerBound, verifiedLookup } from './feasibility';
import { estimatedScanMatrix } from '../scan/assemble';
import { travelFigurePrefix } from './estimate';
import type { ScanPoint } from '../scan/assemble';

/*
 * A synthetic island: a base on the north-east, a trailhead on the north shore
 * and a lookout on the west side, 5.6 km apart in a straight line with a sea
 * cliff between them. The road from the base reaches the trailhead in 45
 * minutes and the lookout in 2 h 45 (it goes all the way around). Coordinates
 * are invented.
 */
const BASE: ScanPoint = { id: 'base', kind: 'base', key: 'b', name: 'Base', coordinates: { lat: 10.2, lng: 50.2 } };
const NORTH: ScanPoint = { id: 'north', kind: 'place', key: 'n', name: 'North trailhead', coordinates: { lat: 10.1, lng: 49.8 } };
const WEST: ScanPoint = { id: 'west', kind: 'place', key: 'w', name: 'West lookout', coordinates: { lat: 10.05, lng: 49.8 } };

function islandMatrix() {
  const raw = estimatedScanMatrix([BASE, NORTH, WEST], 'car', 'plausible_unverified');
  const minutes = raw.minutes.map((row) => [...row]);
  minutes[0]![1] = 45;
  minutes[1]![0] = 45;
  minutes[0]![2] = 165;
  minutes[2]![0] = 165;
  const feasibility = raw.feasibility!.map((row) => [...row]);
  feasibility[0]![1] = 'verified';
  feasibility[1]![0] = 'verified';
  feasibility[0]![2] = 'verified';
  feasibility[2]![0] = 'verified';
  return { ...raw, minutes, feasibility };
}

describe('triangle lower bound', () => {
  it('proves the far side of the cliff is at least two hours away, whatever the straight line says', () => {
    const m = islandMatrix();
    const straight = m.minutes[1]![2]!;
    expect(straight).toBeLessThan(30);
    const bound = triangleLowerBound({ ids: m.ids, minutes: [[null, 45, 165], [45, null, null], [165, null, null]] }, 1, 2);
    expect(bound).toEqual({ minutes: 120, viaId: 'base' });
  });

  it('uses only measured cells: an estimate is never a pivot', () => {
    expect(triangleLowerBound({ ids: ['a', 'b', 'c'], minutes: [[null, null, null], [null, null, null], [null, null, null]] }, 1, 2)).toBeNull();
  });

  it('reads a directed bound where both directions were measured', () => {
    const b = lowerBoundFrom({ pivots: ['k'], measured: (x, y) => (({ 'k>a': 10, 'k>b': 70, 'a>k': 12, 'b>k': 60 }) as Record<string, number>)[`${x}>${y}`] ?? null, fromId: 'a', toId: 'b' });
    expect(b?.minutes).toBe(60);
  });
});

describe('boundTravelMatrix', () => {
  it('raises the unmeasured pair to the bound and labels it bounded_estimate; measured cells stay verified', () => {
    const { matrix, counts } = boundTravelMatrix({ matrix: islandMatrix() });
    expect(matrix.minutes[1]![2]).toBe(120);
    expect(matrix.minutes[2]![1]).toBe(120);
    expect(matrix.feasibility![1]![2]).toBe('bounded_estimate');
    expect(matrix.feasibility![0]![1]).toBe('verified');
    expect(matrix.minutes[0]![2]).toBe(165);
    expect(counts.bounded_estimate).toBe(2);
    expect(counts.verified).toBe(4);
  });

  it('is idempotent', () => {
    const once = boundTravelMatrix({ matrix: islandMatrix() }).matrix;
    const twice = boundTravelMatrix({ matrix: once }).matrix;
    expect(twice).toEqual(once);
  });

  it('keeps a straight-line estimate when it is already longer than the bound', () => {
    const m = islandMatrix();
    m.minutes[0]![2] = 50;
    m.minutes[2]![0] = 50;
    const { matrix } = boundTravelMatrix({ matrix: m });
    expect(matrix.feasibility![1]![2]).toBe('plausible_unverified');
    expect(matrix.minutes[1]![2]).toBe(islandMatrix().minutes[1]![2]);
  });

  it('marks a pair disconnected only when told by an affirmative no-route, and never otherwise', () => {
    const disconnected = new Set([routePairKey('north', 'west'), routePairKey('west', 'north')]);
    const { matrix, counts } = boundTravelMatrix({ matrix: islandMatrix(), disconnected });
    expect(matrix.feasibility![1]![2]).toBe('disconnected');
    expect(counts.disconnected).toBe(2);
    expect(boundTravelMatrix({ matrix: islandMatrix() }).counts.disconnected).toBe(0);
  });

  it('a matrix no router answered stays provider_unavailable, never disconnected', () => {
    const { matrix, counts } = boundTravelMatrix({ matrix: estimatedScanMatrix([BASE, NORTH, WEST], 'car') });
    expect(matrix.feasibility![1]![2]).toBe('provider_unavailable');
    expect(counts.disconnected).toBe(0);
    expect(counts.provider_unavailable).toBe(6);
  });

  it('exposes verified cells for callers outside the matrix', () => {
    const { pivots, measured } = verifiedLookup(boundTravelMatrix({ matrix: islandMatrix() }).matrix);
    expect(pivots.sort()).toEqual(['base', 'north', 'west']);
    expect(measured('north', 'west')).toBeNull();
    expect(measured('base', 'west')).toBe(165);
  });
});

describe('boundedLegMinutes and the printed mark', () => {
  it('a bound longer than the estimate wins and rounds up to five minutes', () => {
    expect(boundedLegMinutes({ estimate: 20, bound: { minutes: 118, viaId: 'k' } })).toEqual({ minutes: 120, feasibility: 'bounded_estimate', bound: { minutes: 118, viaId: 'k' } });
    expect(boundedLegMinutes({ estimate: 20, bound: null, fallback: 'provider_unavailable' })).toEqual({ minutes: 20, feasibility: 'provider_unavailable' });
  });

  it('a bounded leg prints ≥, an estimate ≈, a measurement nothing', () => {
    expect(travelFigurePrefix({ provenance: 'estimated', feasibility: 'bounded_estimate' })).toBe('≥');
    expect(travelFigurePrefix({ provenance: 'estimated' })).toBe('≈');
    expect(travelFigurePrefix({ provenance: 'measured', feasibility: 'verified' })).toBe('');
  });
});
