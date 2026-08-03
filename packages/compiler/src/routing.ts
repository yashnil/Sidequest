import {
  DEFAULT_ROUTING_BUDGET,
  orderedPairs,
  planRouting,
  straightLineKm,
  type BaseCandidate,
  type Coordinates,
  type FoodVenue,
  type Place,
  type RoutableCluster,
  type RoutingBudget,
  type RoutingPlan,
  type RoutingPoint,
} from '@sidequest/core';
import type { RoutingMatrixResult, RoutingProvider } from './providers';

/**
 * EXECUTING A HIERARCHICAL ROUTING PLAN.
 *
 * The compiler used to hand every base, every retained candidate and every food
 * venue to the router as one square matrix. For a country that was 126 points
 * and 15,750 ordered pairs against a 2,500-pair budget, so 85% of the matrix was
 * marked failed *without being requested*, densification then peeled 126 points
 * down to 17, and the compile failed for want of travel times it had chosen not
 * to buy.
 *
 * This runs the plan instead: one small inter-cluster matrix over
 * representatives, and one bounded local matrix per cluster. Every pair it
 * requests is one some consumer will read.
 *
 * ONE MATRIX COMES OUT, AND WHY.
 *
 * The planner takes a single dense `TravelTimeMatrix` and `validateMatrix`
 * rightly refuses a hole. So the blocks are merged, and the pairs no block
 * covered — a stop in one region against a stop in another — are **composed
 * from measured legs**: `A → base(A) → base(B) → B`. Every component is a real
 * measurement, and the result is the journey a traveller would actually make,
 * because you do not drive cross-country between two afternoon stops without
 * passing through where you slept.
 *
 * That composition is also self-enforcing rather than merely hoped for: a
 * composed leg is genuinely hours long, so the day clusterer refuses to put its
 * endpoints in one day for the same reason a traveller would. Nothing has to
 * remember not to read it.
 *
 * What is *not* done: no straight line ever becomes a travel time. A pair with
 * no measured path through the bases stays unmeasured and its place is dropped,
 * exactly as before.
 */

export interface ClusterAssignment {
  id: string;
  name: string;
  base: BaseCandidate;
  placeIds: string[];
  foodIds: string[];
}

/**
 * Put every place with the base it will actually be visited from.
 *
 * Nearest base by straight line — the one legitimate use of geometry, because it
 * decides *what to measure* and never becomes a measurement. A place two hundred
 * kilometres from every base still joins the nearest one; the router is what
 * then says whether it is reachable, and the quality layer is what says whether
 * it is worth the drive.
 */
export function assignToClusters(input: {
  bases: readonly BaseCandidate[];
  places: readonly Place[];
  food: readonly { routingId: string; coordinates: Coordinates }[];
}): ClusterAssignment[] {
  if (input.bases.length === 0) return [];

  const clusters = new Map<string, ClusterAssignment>(
    input.bases.map((base) => [
      base.id,
      { id: base.id, name: base.name, base, placeIds: [], foodIds: [] },
    ]),
  );

  const nearest = (point: Coordinates): BaseCandidate => {
    let best = input.bases[0]!;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const base of input.bases) {
      const km = straightLineKm(point, base.coordinates);
      /* Ties break on id so the assignment is reproducible. */
      if (km < bestKm || (km === bestKm && base.id < best.id)) {
        best = base;
        bestKm = km;
      }
    }
    return best;
  };

  for (const place of input.places) {
    clusters.get(nearest(place.coordinates).id)?.placeIds.push(place.id);
  }
  const seenFood = new Set<string>();
  for (const venue of input.food) {
    if (seenFood.has(venue.routingId)) continue;
    seenFood.add(venue.routingId);
    clusters.get(nearest(venue.coordinates).id)?.foodIds.push(venue.routingId);
  }

  return [...clusters.values()];
}

export interface HierarchicalRoutingInput {
  clusters: readonly ClusterAssignment[];
  places: readonly Place[];
  food: readonly { routingId: string; coordinates: Coordinates }[];
  routing: RoutingProvider;
  mode: 'car' | 'foot';
  budget?: Partial<RoutingBudget>;
  /** Fit per place id, so a budget cut removes the least valuable. */
  fitOf?: (placeId: string) => number;
  /** Hard ceiling from the compiler's own ledger. */
  maxElements: number;
}

export interface HierarchicalRoutingResult {
  /** Dense over every routed id. Cross-cluster cells are composed, never guessed. */
  matrix: RoutingMatrixResult;
  /** Representatives only. What `selectBases` reads. */
  interCluster: RoutingMatrixResult | null;
  /** Per cluster, so a partial failure names the region it lost. */
  perCluster: Map<string, RoutingMatrixResult>;
  plan: RoutingPlan;
  /** Requested pairs, measured. Compared against `plan.flatPairs` in diagnostics. */
  requestedPairs: number;
  composedPairs: number;
  providerCalls: number;
  failedClusters: { clusterId: string; name: string; reason: string }[];
}

function pointFor(id: string, coordinates: Coordinates, role: RoutingPoint['role'], clusterId: string): RoutingPoint {
  return { id, coordinates, role, clusterId };
}

/**
 * Run the plan and merge the blocks.
 *
 * Blocks are requested in order — inter-cluster first, because if the regions
 * cannot be connected the base portfolio shrinks and some local matrices become
 * unnecessary. A cluster whose local matrix fails is reported and removed rather
 * than poisoning the rest, which is the whole salvage story in one line.
 */
export async function routeHierarchically(
  input: HierarchicalRoutingInput,
): Promise<HierarchicalRoutingResult> {
  const placeById = new Map(input.places.map((place) => [place.id, place]));
  const foodById = new Map(input.food.map((venue) => [venue.routingId, venue]));

  const routable: RoutableCluster[] = input.clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    base: pointFor(cluster.base.routingId, cluster.base.coordinates, 'base', cluster.id),
    representative: pointFor(cluster.base.routingId, cluster.base.coordinates, 'base', cluster.id),
    activities: cluster.placeIds
      .map((id) => placeById.get(id))
      .filter((place): place is Place => place !== undefined)
      .map((place) => pointFor(place.id, place.coordinates, 'activity', cluster.id)),
    food: cluster.foodIds
      .map((id) => foodById.get(id))
      .filter((venue): venue is { routingId: string; coordinates: Coordinates } => venue !== undefined)
      .map((venue) => pointFor(venue.routingId, venue.coordinates, 'food', cluster.id)),
  }));

  /*
   * The ledger's ceiling is folded into the plan's own budget, so the plan is
   * reduced *deliberately and visibly* rather than by a provider refusing blocks
   * halfway through a loop. This is the single change that turns the old
   * failure mode into a reported reduction.
   */
  const budget: Partial<RoutingBudget> = {
    ...input.budget,
    maxTotalPairs: Math.min(
      input.budget?.maxTotalPairs ?? DEFAULT_ROUTING_BUDGET.maxTotalPairs,
      Math.max(2, input.maxElements),
    ),
  };

  const plan = planRouting({
    clusters: routable,
    budget,
    ...(input.fitOf ? { fitOf: input.fitOf } : {}),
  });

  const perCluster = new Map<string, RoutingMatrixResult>();
  const failedClusters: { clusterId: string; name: string; reason: string }[] = [];
  let interCluster: RoutingMatrixResult | null = null;
  let requestedPairs = 0;
  let providerCalls = 0;
  const licences = new Map<string, NonNullable<RoutingMatrixResult['licences']>[number]>();

  for (const block of plan.blocks) {
    const points = block.points.map((point) => ({ id: point.id, ...point.coordinates }));
    let result: RoutingMatrixResult;
    try {
      result = await input.routing.matrix({
        points,
        mode: input.mode,
        maxElements: block.pairs + points.length,
      });
    } catch {
      if (block.kind === 'inter_cluster') {
        /*
         * No inter-cluster graph means no measured transfers. That is survivable
         * — the portfolio falls back to a single base — and it is emphatically
         * not a reason to abandon the local matrices that make that base work.
         */
        continue;
      }
      const cluster = input.clusters.find((entry) => entry.id === block.clusterId);
      failedClusters.push({
        clusterId: block.clusterId ?? 'unknown',
        name: cluster?.name ?? 'an area',
        reason: 'The routing service did not answer for this area.',
      });
      continue;
    }

    providerCalls += result.calls;
    requestedPairs += result.elements;
    for (const entry of result.licences ?? []) licences.set(entry.id, entry);

    if (block.kind === 'inter_cluster') {
      interCluster = result;
      continue;
    }
    if (result.ids.length < 2) {
      const cluster = input.clusters.find((entry) => entry.id === block.clusterId);
      failedClusters.push({
        clusterId: block.clusterId ?? 'unknown',
        name: cluster?.name ?? 'an area',
        reason: 'Nothing in this area could be routed against anything else in it.',
      });
      continue;
    }
    perCluster.set(block.clusterId!, result);
  }

  const merged = mergeBlocks({
    perCluster,
    interCluster,
    clusters: input.clusters,
    licences: [...licences.values()],
  });

  for (const clusterId of merged.lostClusters) {
    if (failedClusters.some((entry) => entry.clusterId === clusterId)) continue;
    const cluster = input.clusters.find((entry) => entry.id === clusterId);
    failedClusters.push({
      clusterId,
      name: cluster?.name ?? 'an area',
      reason: 'Nothing in this area could be reached from the rest of the trip.',
    });
  }

  return {
    matrix: merged.matrix,
    interCluster,
    perCluster,
    plan,
    requestedPairs,
    composedPairs: merged.composedPairs,
    providerCalls,
    failedClusters,
  };
}

/**
 * Merge the blocks into one dense matrix.
 *
 * Within a cluster the numbers come straight from that cluster's own matrix.
 * Across clusters they are composed through the two bases, which is both the
 * only honest option and the journey a traveller would actually make. A pair
 * with no complete chain of measured legs is left unmeasured and reported —
 * never filled with a straight line, never filled with zero.
 */
export function mergeBlocks(input: {
  perCluster: Map<string, RoutingMatrixResult>;
  interCluster: RoutingMatrixResult | null;
  clusters: readonly ClusterAssignment[];
  licences: NonNullable<RoutingMatrixResult['licences']>;
}): { matrix: RoutingMatrixResult; composedPairs: number; lostClusters: string[] } {
  const clusterOfId = new Map<string, string>();
  const baseOfCluster = new Map<string, string>();
  for (const cluster of input.clusters) {
    baseOfCluster.set(cluster.id, cluster.base.routingId);
    const local = input.perCluster.get(cluster.id);
    for (const id of local?.ids ?? []) clusterOfId.set(id, cluster.id);
  }

  /*
   * Bases are seeded first, and unconditionally.
   *
   * A cluster whose local matrix failed or held fewer than two points produces
   * no block — and the first version built the id set from blocks alone, so that
   * cluster's *base* vanished from the matrix while remaining in the artifact's
   * base list. `checkRegionIntegrity` then refused the whole region with "a base
   * with no travel-time row cannot start or end a day", after routing had
   * otherwise succeeded.
   *
   * A base with no local block is still a real, measured point: the
   * inter-cluster matrix has its legs to every other base. Seeding it here is
   * what lets those legs survive, and the peel below is what removes it honestly
   * if they do not.
   */
  const ids: string[] = [];
  for (const cluster of input.clusters) {
    if (!ids.includes(cluster.base.routingId)) ids.push(cluster.base.routingId);
    clusterOfId.set(cluster.base.routingId, cluster.id);
  }
  for (const cluster of input.clusters) {
    for (const id of input.perCluster.get(cluster.id)?.ids ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }

  const index = new Map(ids.map((id, position) => [id, position]));
  const minutes = ids.map(() => new Array<number>(ids.length).fill(Number.NaN));
  const km = ids.map(() => new Array<number>(ids.length).fill(Number.NaN));

  const localLeg = (clusterId: string, from: string, to: string): { minutes: number; km: number } | null => {
    const local = input.perCluster.get(clusterId);
    if (!local) return null;
    const row = local.ids.indexOf(from);
    const col = local.ids.indexOf(to);
    if (row < 0 || col < 0) return null;
    const value = local.minutes[row]?.[col];
    const distance = local.km[row]?.[col];
    if (!Number.isFinite(value) || !Number.isFinite(distance)) return null;
    return { minutes: value as number, km: distance as number };
  };

  const interLeg = (from: string, to: string): { minutes: number; km: number } | null => {
    if (!input.interCluster) return null;
    const row = input.interCluster.ids.indexOf(from);
    const col = input.interCluster.ids.indexOf(to);
    if (row < 0 || col < 0) return null;
    const value = input.interCluster.minutes[row]?.[col];
    const distance = input.interCluster.km[row]?.[col];
    if (!Number.isFinite(value) || !Number.isFinite(distance)) return null;
    return { minutes: value as number, km: distance as number };
  };

  // Intra-cluster cells: straight from the block that measured them.
  for (const cluster of input.clusters) {
    const local = input.perCluster.get(cluster.id);
    if (!local) continue;
    for (const from of local.ids) {
      for (const to of local.ids) {
        const leg = localLeg(cluster.id, from, to);
        if (!leg) continue;
        const row = index.get(from);
        const col = index.get(to);
        if (row === undefined || col === undefined) continue;
        minutes[row]![col] = leg.minutes;
        km[row]![col] = leg.km;
      }
    }
  }

  // Cross-cluster cells: composed through the bases, or left unmeasured.
  const failedPairs: RoutingMatrixResult['failedPairs'] = [];
  let composedPairs = 0;
  for (const from of ids) {
    for (const to of ids) {
      if (from === to) continue;
      const row = index.get(from)!;
      const col = index.get(to)!;
      if (Number.isFinite(minutes[row]![col])) continue;

      const fromCluster = clusterOfId.get(from);
      const toCluster = clusterOfId.get(to);
      const fromBase = fromCluster ? baseOfCluster.get(fromCluster) : undefined;
      const toBase = toCluster ? baseOfCluster.get(toCluster) : undefined;

      if (!fromCluster || !toCluster || !fromBase || !toBase) {
        failedPairs.push({ from, to, reason: 'not_found' });
        continue;
      }

      const toHome = from === fromBase ? { minutes: 0, km: 0 } : localLeg(fromCluster, from, fromBase);
      const between = fromBase === toBase ? { minutes: 0, km: 0 } : interLeg(fromBase, toBase);
      const fromHome = to === toBase ? { minutes: 0, km: 0 } : localLeg(toCluster, toBase, to);

      if (!toHome || !between || !fromHome) {
        failedPairs.push({ from, to, reason: 'not_found' });
        continue;
      }

      minutes[row]![col] = toHome.minutes + between.minutes + fromHome.minutes;
      km[row]![col] = toHome.km + between.km + fromHome.km;
      composedPairs += 1;
    }
  }

  for (let position = 0; position < ids.length; position += 1) {
    minutes[position]![position] = 0;
    km[position]![position] = 0;
  }

  /*
   * DENSIFY, AFTER COMPOSING RATHER THAN BEFORE.
   *
   * The artifact's matrix schema requires every cell to be a number, and it is
   * right to: the planner cannot lay out a day around a leg nobody measured, and
   * a NaN read as a number passes every limit silently.
   *
   * What changed is *when* this happens. The flat design densified a matrix that
   * was 85% never-requested, so it peeled 126 points down to 17. Here it runs
   * after composition, so what it removes is the genuinely unreachable — a place
   * with no measured path to its own base, in a cluster with no measured path to
   * the rest of the trip — and that is a handful rather than a hundred.
   *
   * Greedy by worst offender, which is both the standard peel and the one that
   * removes fewest points: the row with the most holes is the row whose removal
   * fixes the most cells.
   */
  /*
   * SALVAGE AT CLUSTER GRANULARITY FIRST, THEN AT POINT GRANULARITY.
   *
   * The order matters more than either step. A point-by-point peel looks
   * reasonable and cascades catastrophically: when two regions cannot be
   * connected, *every* point in region A has a hole against *every* point in
   * region B, so a greedy worst-offender peel removes them alternately until
   * nothing is left. A live country-scale build did exactly that — 1,070 legs
   * measured successfully, and one surviving point.
   *
   * The real answer is structural. If two regions cannot reach each other, one
   * of them leaves *whole*, and the other keeps everything it measured. So:
   * connectivity between clusters is decided first, the largest usable group is
   * kept, and only then are individual stragglers peeled inside it.
   */
  const baseIds = new Set(input.clusters.map((cluster) => cluster.base.routingId));
  const dropped: string[] = [];
  const lostClusters: string[] = [];
  const live = new Set(ids);

  const measured = (from: string, to: string): boolean => {
    const row = index.get(from);
    const col = index.get(to);
    if (row === undefined || col === undefined) return false;
    return Number.isFinite(minutes[row]![col]) && Number.isFinite(minutes[col]![row]);
  };

  // --- Step one: which clusters can reach which ---------------------------
  const clusterIds = input.clusters.map((cluster) => cluster.id);
  const connected = (a: string, b: string): boolean => {
    if (a === b) return true;
    const baseA = input.clusters.find((entry) => entry.id === a)?.base.routingId;
    const baseB = input.clusters.find((entry) => entry.id === b)?.base.routingId;
    return baseA !== undefined && baseB !== undefined && measured(baseA, baseB);
  };

  /* Connected components over the cluster graph, by union-find on a small set. */
  const componentOf = new Map<string, string>();
  for (const id of clusterIds) componentOf.set(id, id);
  const find = (id: string): string => {
    let root = id;
    while (componentOf.get(root) !== root) root = componentOf.get(root)!;
    return root;
  };
  for (const a of clusterIds) {
    for (const b of clusterIds) {
      if (a >= b || !connected(a, b)) continue;
      componentOf.set(find(a), find(b));
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of clusterIds) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }

  if (groups.size > 1) {
    /*
     * Keep the component with the most routed points, ties by id. "Most points"
     * rather than "most clusters", because a trip is better served by one region
     * with twenty stops than by two with three each.
     */
    const weightOf = (members: readonly string[]): number =>
      members.reduce(
        (total, clusterId) => total + (input.perCluster.get(clusterId)?.ids.length ?? 0),
        0,
      );
    const kept = [...groups.entries()].sort(
      (a, b) => weightOf(b[1]) - weightOf(a[1]) || a[0].localeCompare(b[0]),
    )[0]![1];

    for (const clusterId of clusterIds) {
      if (kept.includes(clusterId)) continue;
      lostClusters.push(clusterId);
      for (const id of [...live]) {
        if (clusterOfId.get(id) === clusterId) {
          live.delete(id);
          dropped.push(id);
        }
      }
    }
  }

  // --- Step two: individual stragglers inside what is left ----------------
  const holesFor = (id: string): number => {
    let holes = 0;
    for (const other of live) {
      if (other === id) continue;
      if (!measured(id, other)) holes += 1;
    }
    return holes;
  };

  for (let guard = 0; guard < ids.length; guard += 1) {
    /*
     * A base is never peeled: `checkRegionIntegrity` refuses an artifact whose
     * base has no travel-time row, and a base is where every day starts and
     * ends. By this point cross-cluster holes are gone, so a base with holes
     * means its own region is internally unroutable — and then the honest loss
     * is that region, not the trip.
     */
    let worst: { id: string; holes: number } | null = null;
    for (const id of live) {
      if (baseIds.has(id)) continue;
      const holes = holesFor(id);
      if (holes > 0 && (!worst || holes > worst.holes || (holes === worst.holes && id < worst.id))) {
        worst = { id, holes };
      }
    }
    if (worst) {
      live.delete(worst.id);
      dropped.push(worst.id);
      continue;
    }

    const holedBase = [...live]
      .filter((id) => baseIds.has(id))
      .sort()
      .find((id) => holesFor(id) > 0);
    if (!holedBase) break;

    const cluster = input.clusters.find((entry) => entry.base.routingId === holedBase);
    if (cluster) lostClusters.push(cluster.id);
    for (const id of [...live]) {
      if (clusterOfId.get(id) === cluster?.id || id === holedBase) {
        live.delete(id);
        dropped.push(id);
      }
    }
  }

  const denseIds = ids.filter((id) => live.has(id));
  const denseMinutes = denseIds.map((from) =>
    denseIds.map((to) => minutes[index.get(from)!]![index.get(to)!]!),
  );
  const denseKm = denseIds.map((from) =>
    denseIds.map((to) => {
      const value = km[index.get(from)!]![index.get(to)!]!;
      /*
       * A measured duration with an unreported distance is still a usable leg —
       * some deployments answer with time and no kilometres. Zero is honest
       * here in a way it never is for a duration: nothing schedules on distance.
       */
      return Number.isFinite(value) ? value : 0;
    }),
  );

  for (const id of dropped) failedPairs.push({ from: id, to: id, reason: 'not_found' });

  return {
    lostClusters,
    matrix: {
      ids: denseIds,
      minutes: denseMinutes,
      km: denseKm,
      licences: input.licences,
      provenance: {
        kind: 'measured',
        note:
          composedPairs > 0
            ? 'Travel inside each area is measured directly. Between areas it is measured through the base you sleep in, because that is the journey you would actually make.'
            : 'Measured against the road network.',
        source: 'hierarchical',
      },
      failedPairs,
      calls: 0,
      elements: orderedPairs(denseIds.length),
    },
    composedPairs,
  };
}

/**
 * Places that ended up with no usable row.
 *
 * Kept separate from the matrix build so the caller decides what to do — the
 * compiler drops them and counts them, exactly as it did with the flat matrix,
 * because a place with no measurable leg cannot be scheduled and a missing leg
 * read as zero teleports somebody.
 */
export function unroutablePlaces(
  matrix: RoutingMatrixResult,
  places: readonly Place[],
): string[] {
  const routed = new Set(matrix.ids);
  return places.filter((place) => !routed.has(place.id)).map((place) => place.id);
}

/** Food venues the merged matrix can actually place a meal against. */
export function routableFood(
  matrix: RoutingMatrixResult,
  food: readonly FoodVenue[],
): FoodVenue[] {
  const routed = new Set(matrix.ids);
  return food.filter((venue) => routed.has(venue.routingId));
}
