import { describe, expect, it } from 'vitest';
import type { BaseCandidate, Place } from '@sidequest/core';
import { assignToClusters, mergeBlocks, routeHierarchically } from './routing';
import type { RoutingMatrixResult, RoutingProvider } from './providers';

/**
 * MERGING AND SALVAGE.
 *
 * Every case here is a failure a live country-scale build actually produced, or
 * one it would have produced next. The merge is where hierarchical routing is
 * most likely to go quietly wrong, because a matrix with a hole in it looks
 * fine until the planner reads it.
 */

function base(id: string, lat: number, lng: number): BaseCandidate {
  return {
    id,
    name: id,
    routingId: id,
    coordinates: { lat, lng },
    timeZone: 'UTC',
    suggestedNights: { min: 2, max: 4 },
    transportModes: ['drive'],
    rationale: 'test',
    tradeoffs: [],
    placesWithinReach: [],
  } as unknown as BaseCandidate;
}

function place(id: string, lat: number, lng: number): Place {
  return { id, coordinates: { lat, lng } } as unknown as Place;
}

function matrixOver(
  ids: readonly string[],
  minutesOf: (from: string, to: string) => number | null,
): RoutingMatrixResult {
  const rows = ids.map((from) =>
    ids.map((to) => (from === to ? 0 : (minutesOf(from, to) ?? Number.NaN))),
  );
  return {
    ids: [...ids],
    minutes: rows,
    km: rows.map((row) => row.map((value) => (Number.isFinite(value) ? value / 2 : Number.NaN))),
    provenance: { kind: 'measured', note: 'test' },
    failedPairs: [],
    calls: 1,
    elements: ids.length * (ids.length - 1),
  };
}

const CLUSTERS = [
  {
    id: 'a',
    name: 'Area A',
    base: base('a-base', 42.87, 74.6),
    placeIds: ['a1', 'a2'],
    foodIds: [],
  },
  {
    id: 'b',
    name: 'Area B',
    base: base('b-base', 40.51, 72.8),
    placeIds: ['b1', 'b2'],
    foodIds: [],
  },
];

describe('assigning places to the base they are visited from', () => {
  it('sends each place to its nearest base, deterministically', () => {
    const clusters = assignToClusters({
      bases: [base('north', 42.87, 74.6), base('south', 40.51, 72.8)],
      places: [place('near-north', 42.9, 74.7), place('near-south', 40.5, 72.9)],
      food: [],
    });
    expect(clusters.find((c) => c.id === 'north')?.placeIds).toEqual(['near-north']);
    expect(clusters.find((c) => c.id === 'south')?.placeIds).toEqual(['near-south']);
  });

  it('returns nothing rather than guessing when there are no bases', () => {
    expect(assignToClusters({ bases: [], places: [place('x', 1, 1)], food: [] })).toEqual([]);
  });
});

describe('merging the blocks', () => {
  const localA = matrixOver(['a-base', 'a1', 'a2'], () => 20);
  const localB = matrixOver(['b-base', 'b1', 'b2'], () => 25);

  it('composes a cross-area leg through the two bases, from measured parts', () => {
    const inter = matrixOver(['a-base', 'b-base'], () => 600);
    const merged = mergeBlocks({
      perCluster: new Map([
        ['a', localA],
        ['b', localB],
      ]),
      interCluster: inter,
      clusters: CLUSTERS,
      licences: [],
    });

    const ids = merged.matrix.ids;
    const row = ids.indexOf('a1');
    const col = ids.indexOf('b1');
    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);
    // 20 (a1 → a-base) + 600 (base → base) + 25 (b-base → b1).
    expect(merged.matrix.minutes[row]![col]).toBe(645);
    expect(merged.composedPairs).toBeGreaterThan(0);
  });

  it('produces a matrix with no holes at all', () => {
    const merged = mergeBlocks({
      perCluster: new Map([
        ['a', localA],
        ['b', localB],
      ]),
      interCluster: matrixOver(['a-base', 'b-base'], () => 600),
      clusters: CLUSTERS,
      licences: [],
    });
    for (const row of merged.matrix.minutes) {
      for (const value of row) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('keeps one whole area rather than dismantling both when they cannot connect', () => {
    /*
     * The live failure this exists for. With no route between the two regions,
     * every point in A has a hole against every point in B — and a greedy
     * point-by-point peel removes them alternately until one survives. It did:
     * 1,070 legs measured successfully, one surviving point.
     *
     * The right answer is structural: one region leaves whole, the other keeps
     * everything it measured.
     */
    const merged = mergeBlocks({
      perCluster: new Map([
        ['a', localA],
        ['b', localB],
      ]),
      interCluster: matrixOver(['a-base', 'b-base'], () => null),
      clusters: CLUSTERS,
      licences: [],
    });

    expect(merged.lostClusters).toHaveLength(1);
    expect(merged.matrix.ids.length).toBe(3);
    // The survivor keeps its base and both of its stops.
    const kept = merged.matrix.ids;
    expect(kept.filter((id) => id.endsWith('-base'))).toHaveLength(1);
  });

  it('never drops a base while a peelable point remains', () => {
    /* One stop unreachable inside its own area: the stop goes, the base stays. */
    const holed = matrixOver(['a-base', 'a1', 'a2'], (from, to) =>
      from === 'a2' || to === 'a2' ? null : 20,
    );
    const merged = mergeBlocks({
      perCluster: new Map([['a', holed]]),
      interCluster: null,
      clusters: [CLUSTERS[0]!],
      licences: [],
    });
    expect(merged.matrix.ids).toContain('a-base');
    expect(merged.matrix.ids).not.toContain('a2');
    expect(merged.lostClusters).toHaveLength(0);
  });

  it('keeps a base whose own area produced no local matrix', () => {
    /*
     * A cluster too thin for a local block still has measured legs to the other
     * bases. Building the id set from blocks alone dropped that base from the
     * matrix while leaving it in the artifact, and `checkRegionIntegrity` then
     * refused the whole region after routing had succeeded.
     */
    const merged = mergeBlocks({
      perCluster: new Map([['a', localA]]),
      interCluster: matrixOver(['a-base', 'b-base'], () => 300),
      clusters: CLUSTERS,
      licences: [],
    });
    expect(merged.matrix.ids).toContain('b-base');
    expect(merged.matrix.ids).toContain('a-base');
  });

  it('is deterministic', () => {
    const build = () =>
      mergeBlocks({
        perCluster: new Map([
          ['a', localA],
          ['b', localB],
        ]),
        interCluster: matrixOver(['a-base', 'b-base'], () => null),
        clusters: CLUSTERS,
        licences: [],
      }).matrix.ids;
    expect(build()).toEqual(build());
  });
});

describe('running the plan against a provider', () => {
  function provider(behaviour: (points: readonly { id: string }[]) => RoutingMatrixResult | 'throw'): {
    provider: RoutingProvider;
    calls: { ids: string[] }[];
  } {
    const calls: { ids: string[] }[] = [];
    return {
      calls,
      provider: {
        name: 'test',
        async matrix({ points }) {
          calls.push({ ids: points.map((point) => point.id) });
          const result = behaviour(points);
          if (result === 'throw') throw new Error('provider down');
          return result;
        },
      } as RoutingProvider,
    };
  }

  const places = [
    place('a1', 42.88, 74.61),
    place('a2', 42.89, 74.62),
    place('b1', 40.52, 72.81),
    place('b2', 40.53, 72.82),
  ];

  it('never asks for a pair that spans two areas', async () => {
    const harness = provider((points) => matrixOver(points.map((p) => p.id), () => 30));
    await routeHierarchically({
      clusters: CLUSTERS,
      places,
      food: [],
      routing: harness.provider,
      mode: 'car',
      maxElements: 3_000,
    });

    const clusterOf: Record<string, string> = {
      'a-base': 'a',
      a1: 'a',
      a2: 'a',
      'b-base': 'b',
      b1: 'b',
      b2: 'b',
    };
    for (const call of harness.calls) {
      const areas = new Set(call.ids.map((id) => clusterOf[id]));
      const isInterBlock = call.ids.every((id) => id.endsWith('-base'));
      if (isInterBlock) continue;
      expect(areas.size, `a request mixed areas: ${call.ids.join(',')}`).toBe(1);
    }
  });

  it('survives an inter-cluster failure by planning one area', async () => {
    const harness = provider((points) =>
      points.every((point) => point.id.endsWith('-base'))
        ? 'throw'
        : matrixOver(points.map((p) => p.id), () => 30),
    );
    const result = await routeHierarchically({
      clusters: CLUSTERS,
      places,
      food: [],
      routing: harness.provider,
      mode: 'car',
      maxElements: 3_000,
    });

    expect(result.interCluster).toBeNull();
    expect(result.matrix.ids.length).toBeGreaterThan(1);
    expect(result.failedClusters.length).toBeGreaterThan(0);
  });

  it('loses one area to a local failure without losing the other', async () => {
    const harness = provider((points) =>
      points.some((point) => point.id.startsWith('b'))
        && !points.every((point) => point.id.endsWith('-base'))
        ? 'throw'
        : matrixOver(points.map((p) => p.id), () => 30),
    );
    const result = await routeHierarchically({
      clusters: CLUSTERS,
      places,
      food: [],
      routing: harness.provider,
      mode: 'car',
      maxElements: 3_000,
    });

    expect(result.matrix.ids).toContain('a1');
    expect(result.failedClusters.some((entry) => entry.clusterId === 'b')).toBe(true);
  });

  it('reports what a flat matrix would have cost, so the saving is measured', async () => {
    const harness = provider((points) => matrixOver(points.map((p) => p.id), () => 30));
    const result = await routeHierarchically({
      clusters: CLUSTERS,
      places,
      food: [],
      routing: harness.provider,
      mode: 'car',
      maxElements: 3_000,
    });
    expect(result.plan.flatPairs).toBeGreaterThan(result.plan.totalPairs);
  });
});
