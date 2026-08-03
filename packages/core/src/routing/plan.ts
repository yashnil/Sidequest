import type { Coordinates } from '../schemas/common';

/**
 * HIERARCHICAL ROUTING: DECIDING WHAT TO BUY BEFORE BUYING IT.
 *
 * The defect this exists to remove, in full. A country-scale compilation put
 * every retained candidate, every base and every food venue into **one flat
 * square matrix** — 126 points, 15,750 ordered pairs — then met its own 2,500
 * pair budget six blocks in, marked the remaining ~13,340 pairs as *failed
 * without requesting them*, and densified the result down to 17 usable points.
 * The compile then failed for want of travel times it had decided not to ask
 * for.
 *
 * Two things were wrong, and only one of them was the budget:
 *
 * 1. **Most of those pairs are unreadable by construction.** A stop in one
 *    region and a stop four hours away never appear on the same day, are never
 *    ordered against each other, and no consumer ever reads that cell. Seventy
 *    per cent of the budget went on cells nothing could use.
 * 2. **"Never asked" and "asked and unanswered" were the same value.** A
 *    deliberately sparse matrix is a normal thing; a matrix with holes it
 *    claims to have measured is not. Collapsing the two is what turned a
 *    budget stop into a routing failure.
 *
 * So routing becomes a *plan* — computed, bounded and inspectable **before** a
 * single request — with two layers:
 *
 * - **inter-cluster**: a handful of representatives (bases, medoids, gateways).
 *   Answers reachability, base order and transfer cost.
 * - **intra-cluster**: one bounded local matrix per cluster, over the
 *   candidates that can actually share a day with each other.
 *
 * The rule that keeps it honest: **a straight line may decide what to buy and
 * may never be sold as a road.** Geometric distance prunes the plan; it never
 * reaches `travelFromBase`, the board, the artifact or a screen.
 */

/** What a routed point is, so diagnostics can say what was measured and why. */
export const ROUTING_ROLES = [
  'base',
  'gateway',
  'cluster_representative',
  'activity',
  'food',
  'support',
] as const;
export type RoutingRole = (typeof ROUTING_ROLES)[number];

export interface RoutingPoint {
  id: string;
  coordinates: Coordinates;
  role: RoutingRole;
  /** Which cluster this point belongs to. Absent for a pure gateway. */
  clusterId?: string;
}

/**
 * One matrix this plan intends to buy.
 *
 * `pairs` is computed rather than discovered, which is the whole point: the
 * compiler knows what a plan costs before it submits anything, so exceeding a
 * budget is a decision taken in the open rather than a block silently refused
 * halfway through a nested loop.
 */
export interface RoutingBlock {
  kind: 'inter_cluster' | 'intra_cluster';
  /** Null for the inter-cluster block, which spans them all. */
  clusterId: string | null;
  points: RoutingPoint[];
  /** Ordered pairs, excluding the diagonal. `n × (n − 1)`. */
  pairs: number;
}

export interface RoutingPlan {
  blocks: RoutingBlock[];
  /** Sum of `pairs` across blocks. Compared against the budget before any call. */
  totalPairs: number;
  /** What the flat design would have cost, so the saving is a measured number. */
  flatPairs: number;
  /** Points removed to fit the budget, with the reason. Never silent. */
  reductions: RoutingReduction[];
}

export interface RoutingReduction {
  clusterId: string | null;
  removed: number;
  reason: string;
}

/**
 * A cluster, as routing needs it.
 *
 * Deliberately not the portfolio's `RegionCluster`: this carries the *candidate*
 * membership that only exists after discovery, where the portfolio's version is
 * built from index features before anything has been discovered. The scope layer
 * proposes; this routes what was found.
 */
export interface RoutableCluster {
  id: string;
  name: string;
  /** The base a traveller sleeps in for this cluster, when one was chosen. */
  base?: RoutingPoint;
  /** The point that stands for this cluster in the inter-cluster graph. */
  representative: RoutingPoint;
  activities: RoutingPoint[];
  food: RoutingPoint[];
}

export interface RoutingBudget {
  /** Points in the inter-cluster graph. Bases plus medoids, deduped. */
  maxRepresentatives: number;
  /** Ordered pairs in the inter-cluster block. */
  maxInterClusterPairs: number;
  /** Activity points inside one local matrix. */
  maxCandidatesPerCluster: number;
  /** Food points inside one local matrix. */
  maxFoodPerCluster: number;
  /** Ordered pairs across every block. The one that actually binds. */
  maxTotalPairs: number;
}

/**
 * Sized from what the consumers read, not from what a provider will accept.
 *
 * `maxCandidatesPerCluster` is 24 because a cluster serves at most four or five
 * days at four or five stops each, and a board wants roughly double that so
 * there is something to choose between. Twenty-four activities plus a base plus
 * four food points is 29 points and 812 ordered pairs — a local matrix that
 * answers every question a day can ask of it.
 */
export const DEFAULT_ROUTING_BUDGET: RoutingBudget = {
  maxRepresentatives: 12,
  maxInterClusterPairs: 132,
  maxCandidatesPerCluster: 24,
  maxFoodPerCluster: 6,
  maxTotalPairs: 3_600,
};

/** `n × (n − 1)`, guarded against a negative or absurd `n`. */
export function orderedPairs(n: number): number {
  if (!Number.isFinite(n) || n < 2) return 0;
  return Math.floor(n) * (Math.floor(n) - 1);
}

/**
 * How near two points are, in kilometres, for pruning only.
 *
 * Haversine on a sphere. Deliberately implemented here rather than imported
 * from `@sidequest/geo` so that the *prefilter* has no path to a `TravelLeg`
 * type: it is not a travel time, it must never be one, and keeping the types
 * apart is cheaper than remembering.
 */
export function straightLineKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const toRad = (value: number): number => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rank activities within a cluster for routing, most valuable first.
 *
 * The order decides who survives a budget cut, so it may not be arbitrary — and
 * it explicitly may not be id order, which is what "sorts later" would mean.
 * Fit leads; proximity to the cluster's base breaks ties, because a stop an hour
 * outside the cluster is a stop the day will struggle to hold anyway.
 *
 * Deterministic to the last comparison: equal fit and equal distance fall back
 * to id, so the same inputs always route the same points.
 */
export function rankForRouting(
  activities: readonly (RoutingPoint & { fit?: number })[],
  anchor: Coordinates,
): (RoutingPoint & { fit?: number })[] {
  return [...activities].sort((a, b) => {
    const fitDelta = (b.fit ?? 0) - (a.fit ?? 0);
    if (Math.abs(fitDelta) > 1e-9) return fitDelta;
    const distanceDelta = straightLineKm(anchor, a.coordinates) - straightLineKm(anchor, b.coordinates);
    if (Math.abs(distanceDelta) > 1e-9) return distanceDelta;
    return a.id.localeCompare(b.id);
  });
}

export interface PlanRoutingInput {
  clusters: readonly RoutableCluster[];
  /** Extra points that stand outside any cluster — an airport, a ferry terminal. */
  gateways?: readonly RoutingPoint[];
  budget?: Partial<RoutingBudget>;
  /** Fit per activity id, so a budget cut removes the least valuable. */
  fitOf?: (pointId: string) => number;
}

/**
 * Build the routing plan.
 *
 * Pure, deterministic, and — critically — it produces the point sets *and* the
 * pair count without touching a provider. The compiler compares `totalPairs`
 * against its ledger before submitting anything, so a plan that does not fit is
 * reduced deliberately and the reduction is reported.
 */
export function planRouting(input: PlanRoutingInput): RoutingPlan {
  const budget: RoutingBudget = { ...DEFAULT_ROUTING_BUDGET, ...input.budget };
  const reductions: RoutingReduction[] = [];
  const blocks: RoutingBlock[] = [];

  /*
   * What the flat design would have cost, computed from the same populations,
   * so the saving in diagnostics is a measurement rather than a claim.
   */
  const flatPoints = new Set<string>();
  for (const cluster of input.clusters) {
    if (cluster.base) flatPoints.add(cluster.base.id);
    for (const activity of cluster.activities) flatPoints.add(activity.id);
    for (const venue of cluster.food) flatPoints.add(venue.id);
  }
  for (const gateway of input.gateways ?? []) flatPoints.add(gateway.id);
  const flatPairs = orderedPairs(flatPoints.size);

  // ---- Inter-cluster: representatives only -------------------------------
  const representatives = new Map<string, RoutingPoint>();
  for (const cluster of input.clusters) {
    /*
     * The base *is* the representative when there is one. Routing a cluster's
     * medoid and then its base separately measures the same journey twice, and
     * the base is the point the traveller actually starts and ends transfers at.
     */
    const point = cluster.base ?? cluster.representative;
    representatives.set(point.id, { ...point, role: cluster.base ? 'base' : 'cluster_representative' });
  }
  for (const gateway of input.gateways ?? []) {
    if (!representatives.has(gateway.id)) representatives.set(gateway.id, gateway);
  }

  let interPoints = [...representatives.values()];
  if (interPoints.length > budget.maxRepresentatives) {
    /*
     * Bases before gateways before medoids. A gateway nobody sleeps at is worth
     * less than a base, and a medoid whose cluster has a base is redundant.
     */
    const priority: Record<RoutingRole, number> = {
      base: 0,
      gateway: 1,
      cluster_representative: 2,
      activity: 3,
      food: 4,
      support: 5,
    };
    const sorted = [...interPoints].sort(
      (a, b) => priority[a.role] - priority[b.role] || a.id.localeCompare(b.id),
    );
    reductions.push({
      clusterId: null,
      removed: interPoints.length - budget.maxRepresentatives,
      reason: `More travel regions than one routing pass covers; kept the ${budget.maxRepresentatives} most central.`,
    });
    interPoints = sorted.slice(0, budget.maxRepresentatives);
  }

  if (interPoints.length >= 2) {
    let pairs = orderedPairs(interPoints.length);
    while (pairs > budget.maxInterClusterPairs && interPoints.length > 2) {
      interPoints = interPoints.slice(0, interPoints.length - 1);
      pairs = orderedPairs(interPoints.length);
    }
    blocks.push({ kind: 'inter_cluster', clusterId: null, points: interPoints, pairs });
  }

  // ---- Intra-cluster: one bounded local matrix each -----------------------
  for (const cluster of input.clusters) {
    const anchor = (cluster.base ?? cluster.representative).coordinates;
    const ranked = rankForRouting(
      cluster.activities.map((activity) => ({
        ...activity,
        ...(input.fitOf ? { fit: input.fitOf(activity.id) } : {}),
      })),
      anchor,
    );

    const keptActivities = ranked.slice(0, budget.maxCandidatesPerCluster);
    if (ranked.length > keptActivities.length) {
      reductions.push({
        clusterId: cluster.id,
        removed: ranked.length - keptActivities.length,
        reason: `${cluster.name} has more candidates than one local routing pass covers; the rest are kept as unrouted reserve.`,
      });
    }

    const keptFood = cluster.food.slice(0, budget.maxFoodPerCluster);
    if (cluster.food.length > keptFood.length) {
      reductions.push({
        clusterId: cluster.id,
        removed: cluster.food.length - keptFood.length,
        reason: `${cluster.name} has more places to eat than the plan measures travel to.`,
      });
    }

    const points: RoutingPoint[] = [
      ...(cluster.base ? [cluster.base] : []),
      ...keptActivities.map(({ fit: _fit, ...point }) => point),
      ...keptFood,
    ];
    /* Deduplicate: a base that is also a candidate is one row, not two. */
    const unique = new Map(points.map((point) => [point.id, point]));
    const local = [...unique.values()];
    if (local.length < 2) continue;

    blocks.push({
      kind: 'intra_cluster',
      clusterId: cluster.id,
      points: local,
      pairs: orderedPairs(local.length),
    });
  }

  // ---- Fit the whole plan inside the total budget -------------------------
  let totalPairs = blocks.reduce((sum, block) => sum + block.pairs, 0);
  while (totalPairs > budget.maxTotalPairs) {
    /*
     * Shrink the largest *local* block, never the inter-cluster one.
     *
     * The inter-cluster graph is what decides whether the trip has a shape at
     * all — losing a cluster from it removes a base, where losing a candidate
     * from a local matrix removes one option from a day that has several. The
     * cheapest correct thing to give up is the least valuable candidate in the
     * fullest cluster, which is exactly what `rankForRouting` put last.
     */
    const largest = blocks
      .filter((block) => block.kind === 'intra_cluster' && block.points.length > 3)
      .sort((a, b) => b.pairs - a.pairs || (a.clusterId ?? '').localeCompare(b.clusterId ?? ''))[0];
    if (!largest) break;

    const dropped = largest.points[largest.points.length - 1];
    largest.points = largest.points.slice(0, largest.points.length - 1);
    largest.pairs = orderedPairs(largest.points.length);
    totalPairs = blocks.reduce((sum, block) => sum + block.pairs, 0);
    reductions.push({
      clusterId: largest.clusterId,
      removed: 1,
      reason: `Trimmed ${dropped?.id ?? 'a stop'} to keep this trip's routing inside its budget.`,
    });
  }

  return { blocks, totalPairs, flatPairs, reductions };
}

/**
 * Every pair the plan will request, as a flat list.
 *
 * Used by the tests that assert no cross-cluster pair is ever submitted — the
 * property the whole design turns on, and the one that would silently regress
 * if somebody merged the blocks back together for convenience.
 */
export function plannedPairs(plan: RoutingPlan): { from: string; to: string; block: string }[] {
  const pairs: { from: string; to: string; block: string }[] = [];
  for (const block of plan.blocks) {
    const label = block.clusterId ?? 'inter';
    for (const from of block.points) {
      for (const to of block.points) {
        if (from.id !== to.id) pairs.push({ from: from.id, to: to.id, block: label });
      }
    }
  }
  return pairs;
}
