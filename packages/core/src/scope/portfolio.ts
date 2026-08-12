import { haversineKm } from '@sidequest/geo';
import type { Coordinates } from '../schemas/common';
import type { DestinationFeatureType, DestinationIndexEntry } from '../schemas/destination-index';
import type { DurationCluster } from '../dates/duration';
import {
  chooseBaseStructure,
  estimateTransferMinutes,
  reachRadiusForStructure,
  travelRegionGraph,
  DAY_REACH_KM,
  type BaseStructure,
  type TravelRegionGraph,
} from '../region/graph';

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
 * Reach and transfer speed live in `region/graph`, and are imported rather than
 * restated.
 *
 * They used to be declared here, and the base decision that reads them lived
 * somewhere else — which is exactly how a preview came to use a forty-kilometre
 * day reach while the compilation that followed used a twelve-kilometre one for
 * the same traveller. One definition, one importer, no drift.
 */

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
  /**
   * The seed entry's resolved parent chain, carried straight through from the
   * index.
   *
   * Carried rather than derived, because `chooseBaseStructure` needs it to tell
   * a division of the destination from a competing area — and without it that
   * test can never fire on a real build. A live metropolis reported its own
   * wards as rejected satellite areas for exactly this reason: the containment
   * evidence existed on the index entry and stopped at this boundary.
   */
  hierarchy?: readonly string[];
}

export interface RegionPortfolio {
  /** The place a trip most plausibly starts. The most prominent base-capable feature. */
  gateway: { name: string; center: Coordinates } | null;
  /** Clusters that fit the trip, in route order from the gateway. */
  route: RegionCluster[];
  /**
   * WHY EACH BASE, IN THE TRAVELLER'S OWN TERMS.
   *
   * One entry per member of `route`, same order, and the type says `string`
   * rather than `string | undefined` on purpose: a proposed base with no
   * traveller-facing reason is precisely the failure this pass exists to remove.
   * A screen that lists bases without printing these is showing a decision it
   * cannot defend.
   */
  baseReasons: {
    clusterId: string;
    reason: string;
    /** Nights this base is expected to hold. */
    nights: number;
    /** Estimated minutes from the previous base. Zero for the first. */
    transferMinutes: number;
  }[];
  /**
   * Clusters a base can reach and return from inside one day.
   *
   * These are the places a rank-ordered model used to propose as *second bases*
   * — the whole "you will move hotel to get there" mistake — when the honest
   * answer was that you can go and come back before dinner.
   */
  satellites: { cluster: RegionCluster; baseId: string; transferMinutes: number }[];
  /** Clusters we found and are not proposing, each with the reason. */
  excluded: { cluster: RegionCluster; reason: string }[];
  /** Everything found, before the trip length was applied. */
  allClusters: RegionCluster[];
  basesProposed: number;
  /** Whole days the route spends moving. Estimated. */
  transferDays: number;
  mode: 'drive' | 'transit' | 'walk';
  /**
   * How far out this structure actually reaches, in kilometres.
   *
   * The number a compilation should use for its own scope. Carrying it here is
   * what stops one screen proposing bases a hundred kilometres apart while the
   * next describes the same trip as a dozen kilometres across.
   */
  reachRadiusKm: number;
  /** One sentence a traveller can check against the numbers above. */
  rationale: string;
  /** The same decision as a graph, for anything that draws or audits it. */
  graph: TravelRegionGraph;
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
      ...(entry.hierarchy.length > 0 ? { hierarchy: entry.hierarchy } : {}),
    });
  }

  return clusters;
}

export { estimateTransferMinutes };

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
    const empty: BaseStructure = { bases: [], rejected: [], transferDays: 0, reach: input.mode };
    return {
      gateway: null,
      route: [],
      baseReasons: [],
      satellites: [],
      excluded: [],
      allClusters: [],
      basesProposed: 0,
      transferDays: 0,
      mode: input.mode,
      reachRadiusKm: reachRadiusForStructure(empty),
      rationale: `We could not find anywhere in ${input.destinationName} we would base a trip from.`,
      graph: travelRegionGraph({ destinationName: input.destinationName, structure: empty }),
    };
  }

  const gateway = all[0]!;
  for (const cluster of all) {
    cluster.distanceFromGatewayKm = Math.round(distanceKm(gateway.center, cluster.center));
    cluster.transferMinutesFromGateway = estimateTransferMinutes(gateway.center, cluster.center, input.mode);
  }

  /*
   * WHICH CLUSTERS ARE BASES — DECIDED ON TRAVEL, NOT ON POPULATION.
   *
   * This used to be `all.slice(0, basesAllowed)`: take the highest-ranked
   * clusters, order them nearest-next, and use the distances only to write the
   * sentence explaining what had already been decided. The consequence found in
   * a founder test was a six-night city trip proposing a second base a hundred
   * kilometres out — a genuinely prominent place, genuinely inside the
   * destination, and a hotel change nobody had any reason to make — while the
   * next screen described the same trip as a dozen kilometres across.
   *
   * `chooseBaseStructure` replaces the slice with four tests, in the order that
   * makes the *first* failure the truest explanation: can a day trip reach it,
   * are there days left, is there enough there, and does moving save more travel
   * than it costs. Anything a day trip reaches becomes a **satellite** of the
   * base it hangs off rather than a base of its own, which is both the honest
   * answer and the one that keeps the place on the board.
   *
   * Ordering is still nearest-next, and still a separate decision from
   * selection: a route that zig-zags is a bad route even when every stop on it
   * belongs.
   */
  const structure = chooseBaseStructure({
    clusters: all,
    reach: input.mode,
    nights: input.nights ?? null,
    maxBaseChanges: input.maxBaseChanges ?? null,
    destinationName: input.destinationName,
  });

  const byId = new Map(all.map((cluster) => [cluster.id, cluster]));
  const chosen = structure.bases.map((base) => byId.get(base.cluster.id) ?? gateway);

  const route: RegionCluster[] = [chosen[0] ?? gateway];
  const toOrder = chosen.slice(1);
  let cursor = route[0]!;
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

  const reasonById = new Map(
    structure.bases.map((base) => [base.cluster.id, { reason: base.reason, nights: base.nights }]),
  );
  const baseReasons = route.map((cluster, index) => {
    const found = reasonById.get(cluster.id);
    return {
      clusterId: cluster.id,
      reason: found?.reason ?? 'The densest part of the region.',
      nights: found?.nights ?? 0,
      transferMinutes:
        index === 0
          ? 0
          : estimateTransferMinutes(route[index - 1]!.center, cluster.center, input.mode),
    };
  });

  const satellites = structure.bases.flatMap((base) =>
    base.satellites.map((satellite) => ({
      cluster: byId.get(satellite.cluster.id) ?? satellite.cluster,
      baseId: base.cluster.id,
      transferMinutes: satellite.transferMinutes,
    })),
  ) as RegionPortfolio['satellites'];

  const transferDays =
    Math.round((baseReasons.reduce((total, entry) => total + entry.transferMinutes, 0) / 240) * 10) /
    10;

  const excluded = structure.rejected.map((entry) => ({
    cluster: byId.get(entry.cluster.id) ?? (entry.cluster as RegionCluster),
    reason: entry.reason,
  }));

  return {
    gateway: { name: gateway.name, center: gateway.center },
    route,
    baseReasons,
    satellites,
    excluded,
    allClusters: all,
    basesProposed: route.length,
    transferDays,
    mode: input.mode,
    reachRadiusKm: reachRadiusForStructure(structure),
    rationale: describePortfolio(input.destinationName, all.length, route.length, satellites.length),
    graph: travelRegionGraph({
      destinationName: input.destinationName,
      structure,
      gateway: { id: `${gateway.id}:gateway`, name: gateway.name, center: gateway.center },
    }),
  };
}

function describePortfolio(
  destinationName: string,
  found: number,
  bases: number,
  satellites: number,
): string {
  const areas = `${found} distinct area${found === 1 ? '' : 's'} found in ${destinationName}`;
  const structure =
    bases === 1
      ? satellites > 0
        ? `one base, with ${satellites} of them reachable and back in a day`
        : 'one base'
      : `${bases} bases${satellites > 0 ? `, plus ${satellites} reachable and back in a day` : ''}`;
  return `${areas}; this route uses ${structure}.`;
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
    /*
     * What this strategy would actually cover, from the same decision the map
     * draws — not `clusters.slice(0, bases)` in rank order.
     *
     * The old form promised the traveller the three most prominent areas, while
     * the portfolio beside it was choosing on travel logic. Two lists, one
     * choice, and no way to tell which one the build would honour. Asking the
     * structure with this strategy's own base allowance is the only form that
     * cannot drift, and it names the satellites too — because "one area, in
     * depth" that quietly reaches four more places is a better offer than the
     * one the old text made.
     */
    const structure = chooseBaseStructure({
      clusters,
      reach: portfolio.mode,
      nights,
      maxBaseChanges: shape.bases - 1,
      destinationName: input.destinationName,
    });
    const covers = structure.bases.flatMap((base) => [
      base.cluster.name,
      ...base.satellites.map((satellite) => satellite.cluster.name),
    ]);
    const required = nightsFor(shape.bases);
    const shortOfNights = nights !== null && nights < required;
    const shortOfGround = structure.bases.length < shape.bases;
    const available = !shortOfNights && !shortOfGround;
    strategies.push({
      id: shape.id,
      label: shape.label,
      detail: shape.detail,
      bases: shape.bases,
      covers,
      available,
      /*
       * Which of the two limits is doing the cutting, named separately.
       *
       * "Needs about nine nights; you have four" is actionable. Printing it at a
       * traveller whose destination simply has nowhere else worth sleeping — a
       * compact region where everything is a day trip from one place — is a
       * sentence they cannot act on, because the thing to change is not the
       * length of their holiday.
       */
      ...(available
        ? {}
        : shortOfNights
          ? { unavailableReason: `Needs about ${required} nights; you have ${nights}.` }
          : {
              unavailableReason:
                structure.rejected.length > 0
                  ? `Everything else here is either close enough to reach and come back in a day, or too far to be worth the move.`
                  : `Everything worth staying in is close enough to work from one base.`,
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
