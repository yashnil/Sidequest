import { describe, expect, it } from 'vitest';
import type { TravelTimeMatrix } from '@sidequest/geo';
import {
  DEFAULT_ROUTING_BUDGET,
  MIN_NIGHTS_PER_BASE,
  TRANSFER_WHOLE_DAY_MINUTES,
  baseForDate,
  distributeNights,
  isTransferDate,
  orderRoute,
  orderedPairs,
  planRouting,
  plannedPairs,
  rankForRouting,
  selectBases,
  straightLineKm,
  type RoutableCluster,
  type RoutingPoint,
} from '../index';

/**
 * FIXTURES: THE GEOGRAPHIES THAT BREAK ROUTING.
 *
 * A dense city, a compact two-cluster country, a broad four-cluster country, an
 * archipelago whose clusters are separated by water, and a corridor. None is
 * named after a real place — the whole design forbids destination conditionals,
 * so the tests must not smuggle one in through a fixture name.
 */

function point(id: string, lat: number, lng: number, role: RoutingPoint['role'] = 'activity'): RoutingPoint {
  return { id, coordinates: { lat, lng }, role };
}

function cluster(
  id: string,
  name: string,
  center: { lat: number; lng: number },
  activityCount: number,
  foodCount = 2,
): RoutableCluster {
  const base = point(`${id}-base`, center.lat, center.lng, 'base');
  return {
    id,
    name,
    base,
    representative: base,
    activities: Array.from({ length: activityCount }, (_, index) =>
      point(`${id}-a${index}`, center.lat + index * 0.02, center.lng + index * 0.02),
    ),
    food: Array.from({ length: foodCount }, (_, index) =>
      point(`${id}-f${index}`, center.lat - index * 0.01, center.lng - index * 0.01, 'food'),
    ),
  };
}

/** Four clusters, hundreds of kilometres apart: the broad-country shape. */
const BROAD = [
  cluster('north', 'Northcity', { lat: 42.87, lng: 74.6 }, 40),
  cluster('south', 'Southcity', { lat: 40.51, lng: 72.8 }, 34),
  cluster('lake', 'Lakeside', { lat: 42.49, lng: 78.39 }, 26),
  cluster('west', 'Westtown', { lat: 41.03, lng: 71.7 }, 19),
];

const CITY = [cluster('metro', 'Metro', { lat: 40.71, lng: -74.0 }, 60, 8)];

/** A matrix over base ids, minutes symmetric, with an optional hole. */
function interMatrix(
  ids: readonly string[],
  minutes: Record<string, number>,
  holes: readonly string[] = [],
): TravelTimeMatrix {
  const rows = ids.map((from) =>
    ids.map((to) => {
      if (from === to) return 0;
      const key = [from, to].sort().join('|');
      if (holes.includes(key)) return Number.NaN;
      return minutes[key] ?? 120;
    }),
  );
  return {
    mode: 'car',
    ids: [...ids],
    minutes: rows,
    km: rows.map((row) => row.map((value) => (Number.isNaN(value) ? Number.NaN : value))),
    provenance: { kind: 'measured', note: 'test' },
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('the routing plan is computed before anything is bought', () => {
  it('never produces an all-pairs matrix over the whole candidate set', () => {
    const plan = planRouting({ clusters: BROAD });
    /*
     * The measurement the whole slice turns on. The flat design put every
     * candidate, base and venue into one square matrix; this one is bounded and
     * says by how much.
     */
    expect(plan.flatPairs).toBeGreaterThan(14_000);
    expect(plan.totalPairs).toBeLessThanOrEqual(DEFAULT_ROUTING_BUDGET.maxTotalPairs);
    expect(plan.totalPairs).toBeLessThan(plan.flatPairs / 4);
  });

  it('keeps the inter-cluster and intra-cluster layers separate', () => {
    const plan = planRouting({ clusters: BROAD });
    const inter = plan.blocks.filter((block) => block.kind === 'inter_cluster');
    const intra = plan.blocks.filter((block) => block.kind === 'intra_cluster');
    expect(inter).toHaveLength(1);
    expect(intra).toHaveLength(BROAD.length);
    // The inter block holds one point per cluster, not one per candidate.
    expect(inter[0]!.points).toHaveLength(BROAD.length);
  });

  it('never submits a pair that crosses two clusters', () => {
    /*
     * The property that makes the saving real rather than cosmetic. A stop in
     * one region and a stop in another never share a day, are never ordered
     * against each other, and no consumer reads that cell — so buying it is
     * waste, and the plan must be structurally incapable of it.
     */
    const plan = planRouting({ clusters: BROAD });
    const clusterOf = new Map<string, string>();
    for (const entry of BROAD) {
      for (const activity of [...entry.activities, ...entry.food]) clusterOf.set(activity.id, entry.id);
    }

    for (const pair of plannedPairs(plan)) {
      if (pair.block === 'inter') continue;
      const from = clusterOf.get(pair.from);
      const to = clusterOf.get(pair.to);
      if (from && to) expect(from).toBe(to);
    }
  });

  it('bounds every local matrix, and says what it left out', () => {
    const plan = planRouting({ clusters: BROAD });
    for (const block of plan.blocks) {
      if (block.kind !== 'intra_cluster') continue;
      const activities = block.points.filter((entry) => entry.role === 'activity');
      expect(activities.length).toBeLessThanOrEqual(DEFAULT_ROUTING_BUDGET.maxCandidatesPerCluster);
    }
    expect(plan.reductions.length).toBeGreaterThan(0);
    for (const reduction of plan.reductions) expect(reduction.reason.length).toBeGreaterThan(10);
  });

  it('drops the least valuable candidate, never the one whose id sorts last', () => {
    /*
     * A budget cut that fell on id order would quietly discard the best stop in
     * a region because somebody named it with a late letter.
     */
    const fit = new Map<string, number>();
    const only = BROAD[0]!;
    for (const [index, activity] of only.activities.entries()) {
      // The *last* id is the best fit, so id order and value order disagree.
      fit.set(activity.id, index);
    }

    const plan = planRouting({
      clusters: [only],
      fitOf: (id) => fit.get(id) ?? 0,
      budget: { maxCandidatesPerCluster: 5 },
    });
    const routed = plan.blocks[plan.blocks.length - 1]!.points
      .filter((entry) => entry.role === 'activity')
      .map((entry) => entry.id);

    const best = [...fit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    expect(routed.sort()).toEqual(best.sort());
  });

  it('shrinks a local matrix rather than the inter-cluster graph', () => {
    /*
     * Losing a cluster from the inter-cluster graph removes a base and changes
     * the shape of the trip. Losing a candidate from a local matrix removes one
     * option from a day that has several. Only one of those is a cheap thing to
     * give up.
     */
    const plan = planRouting({ clusters: BROAD, budget: { maxTotalPairs: 900 } });
    const inter = plan.blocks.find((block) => block.kind === 'inter_cluster');
    expect(inter?.points).toHaveLength(BROAD.length);
    expect(plan.totalPairs).toBeLessThanOrEqual(900);
  });

  it('is deterministic', () => {
    const a = planRouting({ clusters: BROAD });
    const b = planRouting({ clusters: [...BROAD].reverse() });
    const key = (plan: ReturnType<typeof planRouting>) =>
      plan.blocks
        .map((block) => `${block.kind}:${block.clusterId}:${block.points.map((p) => p.id).sort().join(',')}`)
        .sort()
        .join('||');
    expect(key(a)).toBe(key(b));
  });

  it('handles a dense single-cluster city without an inter-cluster block', () => {
    const plan = planRouting({ clusters: CITY });
    expect(plan.blocks.filter((block) => block.kind === 'inter_cluster')).toHaveLength(0);
    expect(plan.blocks).toHaveLength(1);
    expect(plan.totalPairs).toBeLessThanOrEqual(DEFAULT_ROUTING_BUDGET.maxTotalPairs);
  });

  it('refuses to build a matrix from one point', () => {
    const lonely: RoutableCluster = {
      id: 'x',
      name: 'X',
      representative: point('x-base', 1, 1, 'base'),
      base: point('x-base', 1, 1, 'base'),
      activities: [],
      food: [],
    };
    const plan = planRouting({ clusters: [lonely] });
    expect(plan.blocks.filter((block) => block.kind === 'intra_cluster')).toHaveLength(0);
  });
});

describe('the geometric prefilter', () => {
  it('measures a plausible distance', () => {
    // Two points ~1° of latitude apart are ~111 km, whatever the longitude.
    expect(straightLineKm({ lat: 40, lng: 10 }, { lat: 41, lng: 10 })).toBeGreaterThan(110);
    expect(straightLineKm({ lat: 40, lng: 10 }, { lat: 41, lng: 10 })).toBeLessThan(112);
    expect(straightLineKm({ lat: 5, lng: 5 }, { lat: 5, lng: 5 })).toBe(0);
  });

  it('survives duplicate and antipodal coordinates without producing NaN', () => {
    expect(straightLineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeGreaterThan(19_000);
    expect(Number.isFinite(straightLineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }))).toBe(true);
  });

  it('ranks by fit first and distance second, with a total order', () => {
    const anchor = { lat: 0, lng: 0 };
    const points = [
      { ...point('far-good', 1, 1), fit: 0.9 },
      { ...point('near-bad', 0.01, 0.01), fit: 0.1 },
      { ...point('near-good', 0.02, 0.02), fit: 0.9 },
    ];
    const ranked = rankForRouting(points, anchor).map((entry) => entry.id);
    expect(ranked).toEqual(['near-good', 'far-good', 'near-bad']);
  });
});

describe('pair arithmetic cannot go wrong', () => {
  it('never returns a negative or fractional count', () => {
    for (const n of [-5, 0, 1, 1.5, 2, 30, Number.NaN, Number.POSITIVE_INFINITY]) {
      const pairs = orderedPairs(n);
      expect(pairs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(pairs)).toBe(true);
    }
    expect(orderedPairs(30)).toBe(870);
  });
});

// ---------------------------------------------------------------------------
// The base portfolio
// ---------------------------------------------------------------------------

describe('choosing bases deterministically', () => {
  const ids = BROAD.map((entry) => entry.base!.id);
  const matrix = interMatrix(ids, {
    [['north-base', 'lake-base'].sort().join('|')]: 240,
    [['north-base', 'south-base'].sort().join('|')]: 600,
    [['north-base', 'west-base'].sort().join('|')]: 330,
    [['south-base', 'west-base'].sort().join('|')]: 150,
    [['south-base', 'lake-base'].sort().join('|')]: 700,
    [['lake-base', 'west-base'].sort().join('|')]: 560,
  });

  it('gives one base when the traveller asked for one', () => {
    const portfolio = selectBases({
      clusters: BROAD,
      interCluster: matrix,
      nights: 11,
      maxBaseChanges: 0,
      startDate: '2027-07-05',
    });
    expect(portfolio.bases).toHaveLength(1);
    expect(portfolio.bases[0]!.nights).toBe(11);
    expect(portfolio.transferDays).toBe(0);
    expect(portfolio.excluded.length).toBe(BROAD.length - 1);
    for (const entry of portfolio.excluded) expect(entry.unreachable).toBe(false);
  });

  it('gives the requested number of bases and spreads the nights', () => {
    const portfolio = selectBases({
      clusters: BROAD,
      interCluster: matrix,
      nights: 11,
      maxBaseChanges: 1,
      startDate: '2027-07-05',
    });
    expect(portfolio.bases).toHaveLength(2);
    expect(portfolio.bases.reduce((total, base) => total + base.nights, 0)).toBe(11);
    // Dates are contiguous and non-overlapping.
    expect(portfolio.bases[1]!.fromDate > portfolio.bases[0]!.toDate).toBe(true);
  });

  it('will not propose a base a trip has no nights for', () => {
    const portfolio = selectBases({
      clusters: BROAD,
      interCluster: matrix,
      nights: 3,
      maxBaseChanges: 3,
      startDate: '2027-07-05',
    });
    expect(portfolio.bases.length).toBeLessThanOrEqual(Math.floor(3 / MIN_NIGHTS_PER_BASE));
    for (const base of portfolio.bases) expect(base.nights).toBeGreaterThanOrEqual(1);
  });

  it('orders the route by measured travel, not by input order', () => {
    const portfolio = selectBases({
      clusters: BROAD,
      interCluster: matrix,
      nights: 14,
      maxBaseChanges: 2,
      startDate: '2027-07-05',
      clusterValue: (id) => ({ north: 3, south: 2, west: 1, lake: 0 })[id] ?? 0,
    });
    expect(portfolio.bases).toHaveLength(3);
    // north→west→south (330 + 150 = 480) beats north→south→west (600 + 150).
    expect(portfolio.bases.map((base) => base.clusterId)).toEqual(['north', 'west', 'south']);
  });

  it('marks a long transfer as a whole day and a short one as a morning', () => {
    const portfolio = selectBases({
      clusters: BROAD,
      interCluster: matrix,
      nights: 14,
      maxBaseChanges: 2,
      startDate: '2027-07-05',
      clusterValue: (id) => ({ north: 3, south: 2, west: 1, lake: 0 })[id] ?? 0,
    });
    const long = portfolio.bases.find((base) => base.transferMinutesFromPrevious >= TRANSFER_WHOLE_DAY_MINUTES);
    expect(long?.transferIsWholeDay).toBe(true);
    expect(portfolio.transferDays).toBeGreaterThan(0);
  });

  it('separates "cannot reach" from "does not fit"', () => {
    /*
     * The distinction the whole salvage story rests on. An unreachable cluster
     * is a routing fact with a retry; a cluster that does not fit is a trip-shape
     * fact with a different remedy.
     */
    const holed = interMatrix(ids, {}, [['north-base', 'lake-base'].sort().join('|')]);
    const portfolio = selectBases({
      clusters: [BROAD[0]!, BROAD[2]!],
      interCluster: holed,
      nights: 10,
      maxBaseChanges: 1,
      startDate: '2027-07-05',
      // Explicit, so the test is about reachability rather than about which of
      // two equally-valued clusters happened to sort first.
      clusterValue: (id) => (id === 'north' ? 1 : 0),
    });
    expect(portfolio.bases).toHaveLength(1);
    expect(portfolio.bases[0]!.clusterId).toBe('north');
    const lake = portfolio.excluded.find((entry) => entry.clusterId === 'lake');
    expect(lake?.unreachable).toBe(true);
    expect(lake?.reason).toMatch(/could not measure a route/i);
  });

  it('an optional cluster failing leaves the primary route intact', () => {
    const holed = interMatrix(ids, {}, [
      ['north-base', 'lake-base'].sort().join('|'),
      ['south-base', 'lake-base'].sort().join('|'),
      ['west-base', 'lake-base'].sort().join('|'),
    ]);
    const portfolio = selectBases({
      clusters: BROAD,
      interCluster: holed,
      nights: 14,
      maxBaseChanges: 2,
      startDate: '2027-07-05',
      clusterValue: (id) => ({ north: 3, lake: 2.5, south: 2, west: 1 })[id] ?? 0,
    });
    expect(portfolio.bases.length).toBeGreaterThanOrEqual(2);
    expect(portfolio.excluded.some((entry) => entry.clusterId === 'lake' && entry.unreachable)).toBe(true);
  });

  it('says so rather than inventing a base when no cluster has one', () => {
    const homeless: RoutableCluster[] = [
      { id: 'a', name: 'A', representative: point('a-rep', 1, 1), activities: [], food: [] },
    ];
    const portfolio = selectBases({
      clusters: homeless,
      interCluster: null,
      nights: 6,
      maxBaseChanges: 1,
      startDate: '2027-07-05',
    });
    expect(portfolio.bases).toHaveLength(0);
    expect(portfolio.rationale).toMatch(/no area/i);
  });

  it('is deterministic across input order', () => {
    const forwards = selectBases({
      clusters: BROAD,
      interCluster: matrix,
      nights: 12,
      maxBaseChanges: 2,
      startDate: '2027-07-05',
    });
    const backwards = selectBases({
      clusters: [...BROAD].reverse(),
      interCluster: matrix,
      nights: 12,
      maxBaseChanges: 2,
      startDate: '2027-07-05',
    });
    expect(forwards.bases.map((base) => base.clusterId)).toEqual(
      backwards.bases.map((base) => base.clusterId),
    );
  });
});

describe('nights and dates', () => {
  it('distributes nights without losing or inventing one', () => {
    for (const [bases, nights] of [
      [1, 11],
      [2, 11],
      [3, 11],
      [4, 7],
      [3, 3],
    ] as const) {
      const spread = distributeNights(bases, nights);
      expect(spread).toHaveLength(bases);
      expect(spread.reduce((a, b) => a + b, 0)).toBe(nights);
    }
  });

  it('front-loads the remainder', () => {
    expect(distributeNights(3, 11)).toEqual([4, 4, 3]);
  });

  it('answers which base a date belongs to, and which date is a transfer', () => {
    const portfolio = selectBases({
      clusters: BROAD.slice(0, 2),
      interCluster: interMatrix(BROAD.slice(0, 2).map((c) => c.base!.id), {}),
      nights: 6,
      maxBaseChanges: 1,
      startDate: '2027-07-05',
    });
    const first = portfolio.bases[0]!;
    const second = portfolio.bases[1]!;

    expect(baseForDate(portfolio, first.fromDate)?.clusterId).toBe(first.clusterId);
    expect(baseForDate(portfolio, second.fromDate)?.clusterId).toBe(second.clusterId);
    /*
     * The defect this function exists to make impossible: a day after the move
     * that still resolves to the first base, and therefore routes back to it.
     */
    expect(baseForDate(portfolio, second.toDate)?.clusterId).not.toBe(first.clusterId);
    expect(isTransferDate(portfolio, second.fromDate)).toBe(true);
    expect(isTransferDate(portfolio, first.fromDate)).toBe(false);
    expect(baseForDate(portfolio, '2099-01-01')).toBeNull();
  });
});

describe('route ordering', () => {
  it('is exact for a small route and falls back gracefully for a large one', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      cluster(`c${index}`, `C${index}`, { lat: 40 + index, lng: 10 }, 2),
    );
    const ids = many.map((entry) => entry.base!.id);
    const ordered = orderRoute(many, interMatrix(ids, {}));
    expect(ordered).toHaveLength(many.length);
    expect(new Set(ordered.map((entry) => entry.id)).size).toBe(many.length);
  });

  it('returns the input unchanged with no matrix to order against', () => {
    const ordered = orderRoute(BROAD, null);
    expect(ordered.map((entry) => entry.id)).toEqual(BROAD.map((entry) => entry.id));
  });
});
