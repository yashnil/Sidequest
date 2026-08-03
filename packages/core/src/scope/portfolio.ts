import { haversineKm } from '@sidequest/geo';
import type { Coordinates } from '../schemas/common';
import type { DestinationFeatureType, DestinationIndexEntry } from '../schemas/destination-index';
import type { DurationCluster } from '../dates/duration';

/**
 * A COUNTRY IS NOT A CITY WITH A LARGER BOUNDING BOX.
 *
 * The defect this file exists to fix, in full: `deriveScope` produced one centre
 * and one radius whatever the destination's breadth, so "Kyrgyzstan" compiled as
 * "Bishkek plus two hundred and twenty kilometres" — which is neither the
 * country the traveller named nor a region they chose. Everything downstream
 * then worked correctly on the wrong ground.
 *
 * What replaces it is a **portfolio**: the region divided into clusters that can
 * each be worked from one base, ordered into a route, with the ones a trip of
 * this length cannot reach named as excluded rather than silently dropped.
 *
 * Two rules hold throughout:
 *
 * 1. **Every position comes from an indexed source coordinate.** Nothing here
 *    invents a place, a centre or a boundary. A cluster is a set of records that
 *    exist, and its centre is one of them.
 * 2. **Distances are straight-line estimates and say so.** Real routing costs a
 *    provider call per leg, and this runs before the traveller has committed to
 *    anything. `transferMinutes` is explicitly an estimate; the routing layer
 *    replaces it for the handful of legs that survive into a plan.
 */

/**
 * How far a traveller will go out and back in a day, by how they get around.
 *
 * This is what makes two records "the same cluster": not that they are near each
 * other on a map, but that one base serves both. A ferry-dependent archipelago
 * gets the transit figure, which is why islands do not merge.
 */
const DAY_REACH_KM: Record<'drive' | 'transit' | 'walk', number> = {
  drive: 70,
  transit: 40,
  walk: 12,
};

/**
 * Average door-to-door speed for an inter-cluster transfer, km/h.
 *
 * Deliberately pessimistic against a motorway figure: a transfer between two
 * regions of a mountainous country is not driven at motorway speed, and a
 * duration model built on one would recommend trips that do not fit. Straight-
 * line distance is also shorter than road distance, so the two errors work in
 * the same direction and the speed compensates for both.
 */
const TRANSFER_SPEED_KMH: Record<'drive' | 'transit' | 'walk', number> = {
  drive: 55,
  transit: 40,
  walk: 4.5,
};

/** Feature types that can anchor a cluster — somewhere you could actually sleep. */
const BASE_CAPABLE: readonly DestinationFeatureType[] = ['city', 'town', 'district'];

export interface RegionCluster {
  id: string;
  /** The most prominent member. A real place, never a computed centroid. */
  name: string;
  center: Coordinates;
  /** Indexed features inside the day-reach of the centre. */
  memberCount: number;
  /** Sum of member ranks. A proxy for how much is there, not a claim about it. */
  weight: number;
  /** Straight-line km from the gateway. */
  distanceFromGatewayKm: number;
  /** Estimated, not routed. The distinction is carried into the UI. */
  transferMinutesFromGateway: number;
  memberNames: string[];
}

export interface RegionPortfolio {
  /** The place a trip most plausibly starts. The most prominent base-capable feature. */
  gateway: { name: string; center: Coordinates } | null;
  /** Clusters that fit the trip, in route order from the gateway. */
  route: RegionCluster[];
  /** Clusters we found and are not proposing, each with the reason. */
  excluded: { cluster: RegionCluster; reason: string }[];
  /** Everything found, before the trip length was applied. */
  allClusters: RegionCluster[];
  basesProposed: number;
  /** Whole days the route spends moving. Estimated. */
  transferDays: number;
  mode: 'drive' | 'transit' | 'walk';
  /** One sentence a traveller can check against the numbers above. */
  rationale: string;
}

export interface BuildPortfolioInput {
  /** Indexed features inside the destination. Bounded by the caller. */
  entries: readonly DestinationIndexEntry[];
  mode: 'drive' | 'transit' | 'walk';
  /** Nights on the ground, when known. Absent means "show everything". */
  nights?: number | null;
  /** Base changes the traveller will accept. Absent means unconstrained. */
  maxBaseChanges?: number;
  destinationName: string;
  /** How many clusters to keep at most. A bound on the work, not a judgement. */
  maxClusters?: number;
}

/**
 * Straight-line kilometres between two coordinates.
 *
 * A thin adapter rather than a second implementation: `@sidequest/geo` keys its
 * points by id because a travel-time matrix has to, and the features here carry
 * ids of their own that mean something different. One shared formula, one
 * conversion, no drift.
 */
function distanceKm(a: Coordinates, b: Coordinates): number {
  return haversineKm({ id: 'a', ...a }, { id: 'b', ...b });
}

function rankOf(entry: DestinationIndexEntry): number {
  const prominence = entry.prominence ?? 0;
  const population = entry.population ?? 0;
  const fromPopulation = population > 0 ? Math.min(100, Math.log10(population) * 14) : 0;
  const typeFloor = entry.featureType === 'region' ? 30 : entry.featureType === 'county' ? 15 : 0;
  return Math.max(prominence, fromPopulation, typeFloor);
}

/**
 * Greedy density clustering over source coordinates.
 *
 * Greedy rather than k-medoids because *k is the thing we are trying to find*.
 * Asking for five clusters of a country that has three is how a portfolio comes
 * to propose two bases in the same valley; growing them from the most prominent
 * unassigned place outwards lets the geography decide how many there are.
 *
 * Fully deterministic: seeds are taken in rank order, ties broken by id.
 */
export function clusterEntries(input: {
  entries: readonly DestinationIndexEntry[];
  mode: 'drive' | 'transit' | 'walk';
  maxClusters: number;
}): RegionCluster[] {
  const reach = DAY_REACH_KM[input.mode];
  const ranked = [...input.entries]
    .map((entry) => ({ entry, rank: rankOf(entry) }))
    .sort((a, b) => b.rank - a.rank || a.entry.id.localeCompare(b.entry.id));

  const assigned = new Set<string>();
  const clusters: RegionCluster[] = [];

  for (const { entry } of ranked) {
    if (clusters.length >= input.maxClusters) break;
    if (assigned.has(entry.id)) continue;
    /*
     * Only somewhere you could sleep may anchor a cluster.
     *
     * A cluster centred on a county with no town in it produces a base
     * recommendation of "the middle of a county", which is not a place anybody
     * can book. Regions and counties still *join* clusters and still count
     * towards weight; they simply do not seed one.
     */
    if (!BASE_CAPABLE.includes(entry.featureType)) continue;

    const members: DestinationIndexEntry[] = [];
    for (const other of ranked) {
      if (assigned.has(other.entry.id)) continue;
      if (distanceKm(entry.center, other.entry.center) <= reach) {
        members.push(other.entry);
      }
    }
    for (const member of members) assigned.add(member.id);

    clusters.push({
      id: entry.id,
      name: entry.displayName,
      center: entry.center,
      memberCount: members.length,
      weight: members.reduce((total, member) => total + rankOf(member), 0) / 20,
      distanceFromGatewayKm: 0,
      transferMinutesFromGateway: 0,
      memberNames: members
        .slice(0, 6)
        .map((member) => member.displayName)
        .filter((name) => name !== entry.displayName),
    });
  }

  return clusters;
}

export function estimateTransferMinutes(
  a: Coordinates,
  b: Coordinates,
  mode: 'drive' | 'transit' | 'walk',
): number {
  const km = distanceKm(a, b);
  return Math.round((km / TRANSFER_SPEED_KMH[mode]) * 60);
}

/**
 * Turn a set of indexed features into a proposed trip structure.
 *
 * The route is built greedily from the gateway by nearest-next, which is the
 * same heuristic the daily stop orderer uses and is deliberately not presented
 * as optimal — it is a proposal a traveller confirms, and the real ordering
 * happens in the planner with real travel times.
 */
export function buildRegionPortfolio(input: BuildPortfolioInput): RegionPortfolio {
  const maxClusters = input.maxClusters ?? 8;
  const all = clusterEntries({ entries: input.entries, mode: input.mode, maxClusters });

  if (all.length === 0) {
    return {
      gateway: null,
      route: [],
      excluded: [],
      allClusters: [],
      basesProposed: 0,
      transferDays: 0,
      mode: input.mode,
      rationale: `We could not find anywhere in ${input.destinationName} we would base a trip from.`,
    };
  }

  const gateway = all[0]!;
  for (const cluster of all) {
    cluster.distanceFromGatewayKm = Math.round(distanceKm(gateway.center, cluster.center));
    cluster.transferMinutesFromGateway = estimateTransferMinutes(gateway.center, cluster.center, input.mode);
  }

  /*
   * How many bases this trip can hold.
   *
   * Nights decide the ceiling, not the destination: an eleven-night trip can
   * support three bases at roughly three nights each and still leave time to
   * move; a four-night trip cannot support two without the second being a night
   * spent arriving. When nobody has said how long, every cluster is shown and
   * the trip-length recommendation is what narrows it.
   */
  const byNights =
    input.nights === undefined || input.nights === null
      ? all.length
      : Math.max(1, Math.floor(input.nights / 3));
  const byPreference = input.maxBaseChanges === undefined ? all.length : input.maxBaseChanges + 1;
  const basesAllowed = Math.max(1, Math.min(all.length, byNights, byPreference));

  /*
   * Which limit is actually doing the cutting.
   *
   * Not "whichever we check first". A traveller who said they would move base
   * once, on a fourteen-night trip, was being told that fourteen nights cannot
   * hold three bases — which is both wrong and unfixable by them, since the
   * thing to change was the answer they gave, not the length of their holiday.
   * The binding constraint is the smallest one, and the sentence has to name it.
   */
  const binding: 'preference' | 'nights' | 'geography' =
    byPreference <= byNights && byPreference < all.length
      ? 'preference'
      : byNights < all.length
        ? 'nights'
        : 'geography';

  /*
   * WHICH clusters, then in WHAT ORDER — two decisions, and conflating them was
   * a real defect.
   *
   * The first version chose by nearest-next from the gateway, which meant a
   * country trip took the three clusters closest to the capital and never left
   * the valley it sits in — while the strategy list beside it named the three
   * most significant ones. The map and the text described different trips.
   *
   * So: **selection is by rank** (the clusters most worth going to, which is the
   * same order the strategies use), and **ordering is nearest-next** (so the
   * route does not zig-zag across the country). One answer, two properties.
   */
  const selected = all.slice(0, basesAllowed);
  const remaining = all.slice(basesAllowed);

  const route: RegionCluster[] = [gateway];
  const toOrder = selected.filter((cluster) => cluster.id !== gateway.id);
  let cursor = gateway;
  while (toOrder.length > 0) {
    toOrder.sort(
      (a, b) =>
        distanceKm(cursor.center, a.center) - distanceKm(cursor.center, b.center) ||
        a.id.localeCompare(b.id),
    );
    const next = toOrder.shift()!;
    route.push(next);
    cursor = next;
  }

  let transferMinutes = 0;
  for (let index = 1; index < route.length; index += 1) {
    transferMinutes += estimateTransferMinutes(route[index - 1]!.center, route[index]!.center, input.mode);
  }
  const transferDays = Math.round((transferMinutes / 240) * 10) / 10;

  const excluded = remaining.map((cluster) => ({
    cluster,
    reason:
      binding === 'preference'
        ? `You said you would rather not move base again — this would be base ${route.length + 1}.`
        : binding === 'nights'
          ? `Adding it would mean another base, and ${input.nights} nights does not hold ${route.length + 1}.`
          : `About ${cluster.transferMinutesFromGateway} minutes from ${gateway.name} by our estimate — too far to fold into this route.`,
  }));

  return {
    gateway: { name: gateway.name, center: gateway.center },
    route,
    excluded,
    allClusters: all,
    basesProposed: route.length,
    transferDays,
    mode: input.mode,
    rationale: `${all.length} distinct area${all.length === 1 ? '' : 's'} found in ${input.destinationName}; this route uses ${route.length} of them.`,
  };
}

/** The duration model's view of a portfolio. */
export function durationClustersFrom(portfolio: RegionPortfolio): DurationCluster[] {
  return portfolio.allClusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    weight: cluster.weight,
    transferMinutes: cluster.transferMinutesFromGateway,
  }));
}

// ---------------------------------------------------------------------------
// Scope strategies
// ---------------------------------------------------------------------------

export interface ScopeStrategy {
  id: string;
  label: string;
  detail: string;
  /** Bases this strategy would use. Drives `maxBaseChanges`. */
  bases: number;
  /** The clusters it would cover, named so the choice is concrete. */
  covers: string[];
  /** Only offered when the geography and the trip length actually support it. */
  available: boolean;
  unavailableReason?: string;
}

/**
 * The strategies this destination genuinely offers, from its own cluster model.
 *
 * The screen these replace asked "Kyrgyzstan — which one?" and showed one card.
 * That was a name-ambiguity question asked of a breadth problem. The right
 * question for a country is not *which* Kyrgyzstan but *how much* of it — and
 * the options have to be the ones the data supports, not a fixed list.
 *
 * `available: false` entries are kept rather than filtered out: a traveller
 * seeing "a route across the region — needs at least nine nights, you have four"
 * has learnt something, where a silently shortened list teaches nothing.
 */
export function scopeStrategiesFor(input: {
  portfolio: RegionPortfolio;
  nights: number | null;
  destinationName: string;
}): ScopeStrategy[] {
  const { portfolio, nights } = input;
  const clusters = portfolio.allClusters;
  if (clusters.length === 0) return [];

  const strategies: ScopeStrategy[] = [];
  const nightsFor = (bases: number) => bases * 3;

  const shapes: { bases: number; id: string; label: string; detail: string }[] = [
    {
      bases: 1,
      id: 'one_area',
      label: 'One area, in depth',
      detail: 'Stay put. Shorter days, more of them, nothing packed twice.',
    },
    {
      bases: 2,
      id: 'two_bases',
      label: 'Two bases',
      detail: 'Split the trip. Opens ground a day trip cannot reach.',
    },
    {
      bases: 3,
      id: 'circuit',
      label: 'A route across the region',
      detail: 'Move on every few nights. The most ground, and the most packing.',
    },
  ];

  for (const shape of shapes) {
    if (shape.bases > clusters.length) continue;
    const covers = clusters.slice(0, shape.bases).map((cluster) => cluster.name);
    const required = nightsFor(shape.bases);
    const available = nights === null || nights >= required;
    strategies.push({
      id: shape.id,
      label: shape.label,
      detail: shape.detail,
      bases: shape.bases,
      covers,
      available,
      ...(available
        ? {}
        : {
            unavailableReason: `Needs about ${required} nights; you have ${nights}.`,
          }),
    });
  }

  strategies.push({
    id: 'name_it',
    label: 'I will name the part I mean',
    detail: 'Tell us the region or town and we build outwards from there instead.',
    bases: 1,
    covers: [],
    available: true,
  });

  return strategies;
}
