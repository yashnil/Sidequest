import { haversineKm } from '@sidequest/geo';
import type { Coordinates } from '../schemas/common';
/**
 * One definition of "a base is worth at least two nights", shared with the
 * measured base portfolio the planner is held to.
 *
 * Re-imported rather than restated: the preview promises a traveller a
 * structure and the planner has to deliver it, and two constants drifting apart
 * would make the promise wrong in a way nobody could see from either file.
 */
import { MIN_NIGHTS_PER_BASE } from '../routing/portfolio';

/**
 * HOW A TRAVELLER MOVES, NOT HOW FAR APART THINGS ARE.
 *
 * The defect this file exists to remove, stated as a class rather than as the
 * one destination it was found on: a regional preview that picked its bases by
 * **rank** — population and cartographic prominence — and used distance only to
 * write the sentence explaining what it had already decided. A prominent city a
 * hundred kilometres outside the destination's core out-ranks the nearer, smaller
 * places, so it became base two of a six-night trip, with no statement of what
 * moving there bought and while a later screen described the same trip as a
 * dozen kilometres across. Two screens, two models, one traveller.
 *
 * What replaces it is a small typed graph over the same clusters, and one rule
 * that decides base structure:
 *
 * > **You move base when you have run out of days where you are, and only to
 * > somewhere a day trip cannot reach, and only when moving saves more travel
 * > than it costs.**
 *
 * Every clause of that is a test below, every one of them produces the sentence
 * the traveller reads, and none of them mentions a country, a city or a mode of
 * transport by name.
 *
 * Two properties hold throughout, inherited from the portfolio this replaces:
 *
 * 1. **Every position is a source coordinate.** Nothing here invents a place.
 * 2. **Every duration is an estimate and is typed as one.** `basis` is
 *    `'estimated'` until a routing provider replaces it with `'measured'`. A
 *    consumer that renders a number without reading `basis` is a bug, and the
 *    field exists so that bug is findable.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What a node in the travel region is.
 *
 * `excluded_area` is a first-class kind rather than an absence, because the half
 * of a region a trip leaves out is the half a traveller most wants explained.
 */
export const REGION_NODE_KINDS = [
  'core',
  'base',
  'satellite',
  'day_trip',
  'gateway',
  'excluded_area',
] as const;
export type RegionNodeKind = (typeof REGION_NODE_KINDS)[number];

/**
 * How two nodes relate, in the vocabulary the product speaks.
 *
 * `day_trip_from` and `better_as_second_base` are the two that carry the whole
 * decision: the first says "you can reach it and come back", the second says
 * "you cannot, and it is worth the move anyway".
 */
export const REGION_EDGE_KINDS = [
  'inside',
  'gateway_for',
  'day_trip_from',
  'better_as_second_base',
  'road_linked',
  'transit_linked',
  'worth_detour',
  'not_worth_detour',
] as const;
export type RegionEdgeKind = (typeof REGION_EDGE_KINDS)[number];

/**
 * Where a duration came from.
 *
 * Not decoration. `estimated` is a straight line over an assumed speed and may
 * never be shown as a travel time without saying so; `measured` came from a
 * router; `scheduled` came from a timetable and carries a service date with it.
 */
export const TRAVEL_BASES = ['measured', 'scheduled', 'estimated', 'unmeasured'] as const;
export type TravelBasis = (typeof TRAVEL_BASES)[number];

/** The reach classes a region is reasoned about in. Not a `TransportMode`. */
export type ReachClass = 'drive' | 'transit' | 'walk';

export interface RegionNode {
  id: string;
  kind: RegionNodeKind;
  name: string;
  center: Coordinates;
  /**
   * The destination time zone this node sits in, where one is known.
   *
   * Optional rather than defaulted to UTC: a node whose zone nobody resolved is
   * a node whose local clock we do not know, and writing `'UTC'` there is how a
   * museum's opening hour moves by nine.
   */
  timeZone?: string;
  /** Indexed features within a day's reach of the centre. */
  memberCount: number;
  /** Sum of member ranks over twenty. A proxy for how much is there. */
  weight: number;
  /** Whole days this node could plausibly fill. Estimated from `weight`. */
  daysWorth: number;
  memberNames: string[];
}

export interface RegionEdge {
  from: string;
  to: string;
  kind: RegionEdgeKind;
  travel: {
    minutes: number | null;
    km: number | null;
    reach: ReachClass;
    basis: TravelBasis;
  };
}

export interface TravelRegionGraph {
  destinationName: string;
  reach: ReachClass;
  nodes: RegionNode[];
  edges: RegionEdge[];
}

// ---------------------------------------------------------------------------
// The physical constants the decision rests on
// ---------------------------------------------------------------------------

/**
 * How far out and back in one day, by how the traveller gets around.
 *
 * The same numbers the cluster model uses, imported by the caller rather than
 * duplicated here — see `scope/portfolio.ts`. What this file adds is the
 * *minutes* form, because a base decision is about time, not kilometres.
 */
export const DAY_REACH_KM: Record<ReachClass, number> = {
  drive: 70,
  transit: 40,
  walk: 12,
};

/** Average door-to-door transfer speed, km/h. Pessimistic on purpose. */
export const TRANSFER_SPEED_KMH: Record<ReachClass, number> = {
  drive: 55,
  transit: 40,
  walk: 4.5,
};

/**
 * What a base change costs beyond the drive itself, in minutes.
 *
 * Checking out, moving luggage, checking in, and the fact that the half-day it
 * lands in is not a day either place. Ninety minutes is conservative against
 * every published hotel check-in window and is the number that makes a short
 * hop between two adjacent towns not worth doing.
 */
export const BASE_CHANGE_OVERHEAD_MINUTES = 90;

/**
 * How much cluster weight one day of a trip consumes.
 *
 * `weight` is the sum of the members' ranks over twenty, and a rank tops out at
 * a hundred — so one significant town is worth roughly 3.5 and a dense
 * metropolitan cluster of twenty indexed places is worth forty or more. Four
 * puts a single town at one day and saturates a metropolis at the ceiling
 * below, which is exactly the distinction that decides whether a trip has any
 * days spare for a second base at all.
 */
const WEIGHT_PER_DAY = 4;

/** Nobody spends a fortnight in one cluster on our say-so. */
const MAX_DAYS_PER_CLUSTER = 7;

/**
 * Below this, a cluster is a stop rather than somewhere to sleep.
 *
 * Roughly one minor settlement and nothing else. Deliberately low: refusing to
 * base a trip somewhere is a strong claim, and the tests that actually decide
 * base structure are the travel ones below.
 */
const MIN_BASE_WEIGHT = 2.5;

/**
 * Usable minutes in a travelling day.
 *
 * Used to convert a transfer into the fraction of a trip it consumes, which is
 * the only way "four nights cannot hold two bases five hours apart" can be
 * stated as arithmetic rather than as a rule of thumb about nights.
 */
const USABLE_MINUTES_PER_DAY = 480;

export function daysWorthOf(weight: number): number {
  return Math.max(1, Math.min(MAX_DAYS_PER_CLUSTER, Math.round(weight / WEIGHT_PER_DAY)));
}

/**
 * ONE DEFINITION OF HOW FAR A TRAVELLER REACHES IN A DAY.
 *
 * Two screens derived this independently and disagreed for the commonest
 * traveller of all — the one who has not said. The preview read an unstated
 * transport answer as `transit` (40 km day reach) on the reasonable ground that
 * the recoverable error is the wider one; the compiler read the same silence as
 * `walk` (12 km cap). A six-night trip therefore had a preview ring labelled
 * "40 km — a day out and back" beside a build described as "about 12 km out".
 * That is the founder-test regression, one screen earlier than it was found.
 *
 * So both now call this, and the interesting parameter is the last one.
 *
 * **`transitMeasurable` is what stops a widened reach becoming a new lie.**
 * Raising a car-free traveller from the walking cap to the transit cap only
 * makes sense if something can actually measure a transit journey. When this was
 * written nothing could, and raising it anyway had a consequence worse than the
 * narrowness it fixed: `matrixModeFor` switched from the pedestrian network to
 * the road network above twelve kilometres, so every leg a car-free traveller
 * saw would have become a *driving* duration presented as their travel time.
 *
 * **Both halves of that have since changed, and the parameter is still the
 * gate.** `route_transit` is now registered when a deployment configures a
 * router built with timetable data, so this can genuinely be `true`; and
 * `matrixModeFor` no longer escalates a car-free scope to the road network at
 * any span, so the specific lie it names is no longer reachable. What the
 * parameter now controls is narrower and still load-bearing: a forty-kilometre
 * ring is a promise about ground the traveller can reach, and a build that
 * cannot measure a journey has no business making it. The reach widens the day
 * something can measure one; until then the gap is a stated readiness deficit
 * rather than a confident number.
 */
export function reachClassFor(input: {
  /** True, false, or null when nobody has established it. */
  carAvailable: boolean | null;
  /** Whether the traveller accepts scheduled transport. Null means unstated. */
  acceptsScheduled: boolean | null;
  /** Whether anything configured can measure a transit journey. */
  transitMeasurable: boolean;
}): ReachClass {
  if (input.carAvailable === true) return 'drive';
  if (input.acceptsScheduled === false) return 'walk';
  /*
   * Everyone else — an explicit "public transport", a bare "no car", and the
   * silence that is by far the commonest answer — is a transit traveller in
   * intent. Whether that earns them transit *reach* depends on whether we can
   * measure one.
   */
  return input.transitMeasurable ? 'transit' : 'walk';
}

export function dayReachMinutes(reach: ReachClass): number {
  return Math.round((DAY_REACH_KM[reach] / TRANSFER_SPEED_KMH[reach]) * 60);
}

export function estimateTransferMinutes(a: Coordinates, b: Coordinates, reach: ReachClass): number {
  const km = haversineKm({ id: 'a', ...a }, { id: 'b', ...b });
  return Math.round((km / TRANSFER_SPEED_KMH[reach]) * 60);
}

function distanceKm(a: Coordinates, b: Coordinates): number {
  return haversineKm({ id: 'a', ...a }, { id: 'b', ...b });
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** A cluster as the graph builder needs it. Structurally a `RegionCluster`. */
export interface GraphClusterInput {
  id: string;
  name: string;
  center: Coordinates;
  memberCount: number;
  weight: number;
  memberNames: string[];
  timeZone?: string;
}

/**
 * Why a cluster is not a base, in a form both a test and a sentence can read.
 *
 * `trip_already_full` is the one that matters most and the one nothing modelled
 * before: a traveller does not move hotel because somewhere else exists, they
 * move because they have run out of days where they are.
 */
export const BASE_REJECTIONS = [
  'reachable_as_day_trip',
  'trip_already_full',
  'move_costs_more_than_it_saves',
  'not_enough_there',
  'hotel_moves_exhausted',
  'nights_too_few',
] as const;
export type BaseRejection = (typeof BASE_REJECTIONS)[number];

export interface ChosenBase {
  cluster: GraphClusterInput;
  /** Nights this base is expected to hold. */
  nights: number;
  /** Estimated minutes from the previous base. Zero for the first. */
  transferMinutes: number;
  /**
   * Why this base, in one sentence a traveller can check against the numbers.
   *
   * Required. A base with no traveller-facing reason is the exact defect this
   * file exists to prevent, so the type makes producing one unavoidable.
   */
  reason: string;
  /** Clusters this base can reach and return from within a day. */
  satellites: { cluster: GraphClusterInput; transferMinutes: number }[];
}

export interface RejectedCluster {
  cluster: GraphClusterInput;
  rejection: BaseRejection;
  reason: string;
  /** Set when the cluster is still reachable from a chosen base. */
  dayTripFromBaseId?: string;
  transferMinutes: number;
}

export interface BaseStructure {
  bases: ChosenBase[];
  rejected: RejectedCluster[];
  /** Estimated whole days the route spends moving between bases. */
  transferDays: number;
  reach: ReachClass;
}

export interface BaseStructureInput {
  clusters: readonly GraphClusterInput[];
  reach: ReachClass;
  /** Nights on the ground. Null means "not decided yet — show the geography". */
  nights: number | null;
  /** Base changes the traveller will accept. Null means unconstrained. */
  maxBaseChanges: number | null;
}

/**
 * Choose the bases, the satellites, and the reasons for both.
 *
 * The clusters arrive in rank order and the first base-capable one is base one:
 * that much is unchanged, and it is right — a trip starts where the destination
 * is densest. Everything after it is decided by the four tests in the file
 * header, applied in an order chosen so the *first* test that fails is the
 * truest explanation:
 *
 * 1. Can a day trip reach it? Then it is a satellite and no move is warranted,
 *    whatever its population. This is the test that keeps a region's best places
 *    on the board without inventing a hotel change to get to them.
 * 2. Is there any day left? A trip whose chosen bases already hold more than its
 *    nights has nothing to spend on a fourth city, and saying so is more useful
 *    than a distance.
 * 3. Is there enough there to spend those nights on?
 * 4. Does moving save more travel than it costs?
 *
 * Deterministic throughout: input order decides ties, nothing is randomised, and
 * the same clusters with the same nights always produce the same structure.
 */
export function chooseBaseStructure(input: BaseStructureInput): BaseStructure {
  const { reach, nights, maxBaseChanges } = input;
  const clusters = [...input.clusters];
  if (clusters.length === 0) {
    return { bases: [], rejected: [], transferDays: 0, reach };
  }

  const reachMinutes = dayReachMinutes(reach);
  const basesAllowed = maxBaseChanges === null ? clusters.length : maxBaseChanges + 1;

  const bases: ChosenBase[] = [];
  const rejected: RejectedCluster[] = [];
  const claimed = new Set<string>();

  /** Days the chosen bases already account for. */
  let daysCommitted = 0;
  const tripDays = nights === null ? Number.POSITIVE_INFINITY : Math.max(1, nights);

  const first = clusters[0]!;
  const firstDays = Math.min(daysWorthOf(first.weight), tripDays);
  bases.push({
    cluster: first,
    nights: nights === null ? daysWorthOf(first.weight) : Math.min(nights, firstDays),
    transferMinutes: 0,
    reason: `The densest part of the region — about ${daysWorthOf(first.weight)} day${
      daysWorthOf(first.weight) === 1 ? '' : 's'
    } of places within a day's reach.`,
    satellites: [],
  });
  claimed.add(first.id);
  daysCommitted += firstDays;

  for (const cluster of clusters.slice(1)) {
    if (claimed.has(cluster.id)) continue;

    /* Nearest already-chosen base, which is what a day trip would leave from. */
    let nearest = bases[0]!;
    let nearestMinutes = estimateTransferMinutes(nearest.cluster.center, cluster.center, reach);
    for (const base of bases.slice(1)) {
      const minutes = estimateTransferMinutes(base.cluster.center, cluster.center, reach);
      if (minutes < nearestMinutes) {
        nearest = base;
        nearestMinutes = minutes;
      }
    }

    // 1. A day trip reaches it. No hotel change is warranted, whatever its size.
    if (nearestMinutes <= reachMinutes) {
      nearest.satellites.push({ cluster, transferMinutes: nearestMinutes });
      claimed.add(cluster.id);
      continue;
    }

    // 2. Days left, at all.
    const daysRemaining = tripDays - daysCommitted;
    if (daysRemaining < MIN_NIGHTS_PER_BASE) {
      rejected.push({
        cluster,
        rejection: nights === null ? 'nights_too_few' : 'trip_already_full',
        transferMinutes: nearestMinutes,
        reason:
          nights === null
            ? 'How long you are staying decides whether this is reachable at all.'
            : `Your ${nights} night${nights === 1 ? '' : 's'} are already spoken for by ${bases
                .map((base) => base.cluster.name)
                .join(' and ')}, which alone hold about ${Math.round(daysCommitted)} day${
                Math.round(daysCommitted) === 1 ? '' : 's'
              }.`,
      });
      continue;
    }

    // 3. Hotel-move tolerance.
    if (bases.length >= basesAllowed) {
      rejected.push({
        cluster,
        rejection: 'hotel_moves_exhausted',
        transferMinutes: nearestMinutes,
        reason:
          maxBaseChanges === 0
            ? `You said you would rather not move base at all — this would be base ${bases.length + 1}.`
            : `You said you would rather not move base more than ${maxBaseChanges} time${
                maxBaseChanges === 1 ? '' : 's'
              } — this would be base ${bases.length + 1}.`,
      });
      continue;
    }

    // 4. Enough there to spend the nights on.
    const clusterDays = daysWorthOf(cluster.weight);
    if (cluster.weight < MIN_BASE_WEIGHT && cluster.memberCount < 2) {
      rejected.push({
        cluster,
        rejection: 'not_enough_there',
        transferMinutes: nearestMinutes,
        reason: `About ${formatMinutes(nearestMinutes)} away by our estimate, and not enough there to justify ${MIN_NIGHTS_PER_BASE} nights.`,
      });
      continue;
    }

    /*
     * 5. Does the trip have room for the nights *and* the journey?
     *
     * The clause that stops a short trip acquiring a second base. Two nights
     * somewhere five hours away is not two nights plus a drive; it is two
     * nights, a drive, and a day that belongs to neither place. Counting the
     * transfer as the fraction of a day it really is makes "four nights cannot
     * hold this" arithmetic rather than a rule of thumb — and makes the
     * sentence the traveller reads a number they can check.
     */
    /*
     * THE ADMISSION TEST USES THE MINIMUM; THE ALLOCATION USES WHAT IS THERE.
     *
     * Testing feasibility against `min(clusterDays, daysRemaining)` made the
     * decision **non-monotone in cluster quality**: a ten-night trip whose
     * capital cluster committed seven days rejected a rich second region
     * (needing three nights) and *accepted* a thin one (needing two). The more
     * there was to do somewhere, the more likely it was excluded — which is the
     * opposite of the intended behaviour and impossible to explain to anybody.
     *
     * So admission asks the only question that has a defensible answer: is
     * there room for another base *at all*, at the two nights below which it
     * would be a stopover rather than a base. What the base is then allocated
     * still reflects what is there, because that is a different question.
     */
    const transferDayCost = nearestMinutes / USABLE_MINUTES_PER_DAY;
    if (daysCommitted + MIN_NIGHTS_PER_BASE + transferDayCost > tripDays) {
      rejected.push({
        cluster,
        rejection: 'trip_already_full',
        transferMinutes: nearestMinutes,
        /* Hedged, like its siblings: every minute here is a straight-line estimate. */
        reason: `About ${formatMinutes(nearestMinutes)} each way by our estimate, plus the ${MIN_NIGHTS_PER_BASE} nights a base is worth, does not fit in ${nights} night${
          nights === 1 ? '' : 's'
        } alongside ${bases.map((base) => base.cluster.name).join(' and ')}.`,
      });
      continue;
    }

    /*
     * Allocated after admission, and this is where what is there matters. The
     * transfer is taken out of the trip before the nights are, because a day
     * spent moving belongs to neither place.
     */
    const nightsThere = Math.max(
      MIN_NIGHTS_PER_BASE,
      Math.min(clusterDays, Math.floor(tripDays - daysCommitted - transferDayCost)),
    );

    /*
     * 6. Does moving save more travel than it costs?
     *
     * `travelSaved` was `nightsThere * 2 * nearestMinutes` — the round trips
     * avoided if you day-tripped there *every night*. That is wrong in kind:
     * test 1 has just established the cluster is **not** day-trippable, so
     * those round trips were never on offer. It also made the gate dead code:
     * with `nightsThere >= 2` the test reduced to `m > 30`, and control only
     * reaches here when `m` already exceeds the day reach.
     *
     * One out-and-back is the honest comparison — the single journey you would
     * otherwise make and return from. The gate now bites below about ninety
     * minutes, which is exactly the short hop between two adjacent towns that
     * `BASE_CHANGE_OVERHEAD_MINUTES` was written for.
     */
    const travelSaved = 2 * nearestMinutes;
    const transferCost = nearestMinutes + BASE_CHANGE_OVERHEAD_MINUTES;
    if (travelSaved <= transferCost) {
      rejected.push({
        cluster,
        rejection: 'move_costs_more_than_it_saves',
        transferMinutes: nearestMinutes,
        dayTripFromBaseId: nearest.cluster.id,
        reason: `Moving there costs about ${formatMinutes(transferCost)} and would save about ${formatMinutes(travelSaved)} — not worth the change of hotel.`,
      });
      continue;
    }

    bases.push({
      cluster,
      nights: nightsThere,
      transferMinutes: nearestMinutes,
      reason: `About ${formatMinutes(nearestMinutes)} from ${nearest.cluster.name} — too far to day-trip, and ${nightsThere} night${
        nightsThere === 1 ? '' : 's'
      } here saves roughly ${formatMinutes(travelSaved - transferCost)} of travel over going back and forth.`,
      satellites: [],
    });
    claimed.add(cluster.id);
    daysCommitted += nightsThere;
  }

  /*
   * A second pass for satellites.
   *
   * A cluster rejected as a base while base two was still hypothetical may be a
   * day trip from base two once it exists. Running this after the loop rather
   * than inside it keeps the base decision from depending on bases that had not
   * been chosen when it was made.
   */
  const stillRejected: RejectedCluster[] = [];
  for (const entry of rejected) {
    let attached = false;
    for (const base of bases) {
      const minutes = estimateTransferMinutes(base.cluster.center, entry.cluster.center, reach);
      if (minutes <= reachMinutes) {
        base.satellites.push({ cluster: entry.cluster, transferMinutes: minutes });
        attached = true;
        break;
      }
    }
    if (!attached) stillRejected.push(entry);
  }

  let transferMinutes = 0;
  for (const base of bases.slice(1)) transferMinutes += base.transferMinutes;

  return {
    bases,
    rejected: stillRejected,
    transferDays: Math.round((transferMinutes / 240) * 10) / 10,
    reach,
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 90) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} hours`;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * The structure, as a graph.
 *
 * Produced from the decision rather than beside it, so the nodes and edges can
 * never describe a different trip from the one the planner builds. The graph is
 * what a map draws and what a reviewer reads; the structure is what compiles.
 */
export function travelRegionGraph(input: {
  destinationName: string;
  structure: BaseStructure;
  gateway?: { id: string; name: string; center: Coordinates; timeZone?: string };
}): TravelRegionGraph {
  const { structure } = input;
  const nodes: RegionNode[] = [];
  const edges: RegionEdge[] = [];

  const node = (
    cluster: GraphClusterInput,
    kind: RegionNodeKind,
  ): RegionNode => ({
    id: cluster.id,
    kind,
    name: cluster.name,
    center: cluster.center,
    ...(cluster.timeZone ? { timeZone: cluster.timeZone } : {}),
    memberCount: cluster.memberCount,
    weight: cluster.weight,
    daysWorth: daysWorthOf(cluster.weight),
    memberNames: [...cluster.memberNames],
  });

  structure.bases.forEach((base, index) => {
    nodes.push(node(base.cluster, index === 0 ? 'core' : 'base'));
    if (index > 0) {
      const previous = structure.bases[index - 1]!;
      edges.push({
        from: previous.cluster.id,
        to: base.cluster.id,
        kind: 'better_as_second_base',
        travel: {
          minutes: base.transferMinutes,
          km: Math.round(distanceKm(previous.cluster.center, base.cluster.center)),
          reach: structure.reach,
          basis: 'estimated',
        },
      });
    }
    for (const satellite of base.satellites) {
      nodes.push(node(satellite.cluster, 'satellite'));
      edges.push({
        from: base.cluster.id,
        to: satellite.cluster.id,
        kind: 'day_trip_from',
        travel: {
          minutes: satellite.transferMinutes,
          km: Math.round(distanceKm(base.cluster.center, satellite.cluster.center)),
          reach: structure.reach,
          basis: 'estimated',
        },
      });
    }
  });

  for (const entry of structure.rejected) {
    nodes.push(node(entry.cluster, 'excluded_area'));
    const anchor = structure.bases[0];
    if (anchor) {
      edges.push({
        from: anchor.cluster.id,
        to: entry.cluster.id,
        kind: 'not_worth_detour',
        travel: {
          minutes: entry.transferMinutes,
          km: Math.round(distanceKm(anchor.cluster.center, entry.cluster.center)),
          reach: structure.reach,
          basis: 'estimated',
        },
      });
    }
  }

  if (input.gateway && !nodes.some((entry) => entry.id === input.gateway!.id)) {
    nodes.push({
      id: input.gateway.id,
      kind: 'gateway',
      name: input.gateway.name,
      center: input.gateway.center,
      ...(input.gateway.timeZone ? { timeZone: input.gateway.timeZone } : {}),
      memberCount: 0,
      weight: 0,
      daysWorth: 0,
      memberNames: [],
    });
    const anchor = structure.bases[0];
    if (anchor) {
      edges.push({
        from: input.gateway.id,
        to: anchor.cluster.id,
        kind: 'gateway_for',
        travel: {
          minutes: estimateTransferMinutes(
            input.gateway.center,
            anchor.cluster.center,
            structure.reach,
          ),
          km: Math.round(distanceKm(input.gateway.center, anchor.cluster.center)),
          reach: structure.reach,
          basis: 'estimated',
        },
      });
    }
  }

  return {
    destinationName: input.destinationName,
    reach: structure.reach,
    nodes,
    edges,
  };
}

/**
 * The reach a compiled scope should use, from the structure the preview showed.
 *
 * This is the hand-off that stops the two screens disagreeing. The preview
 * decides how far the trip actually goes; the compiler reads that number instead
 * of deriving a second one from a table. A structure with one base and no
 * satellites yields the base's own day reach; a structure that spans bases
 * yields enough to hold all of them.
 */
export function reachRadiusForStructure(structure: BaseStructure): number {
  const dayReach = DAY_REACH_KM[structure.reach];
  if (structure.bases.length === 0) return dayReach;
  const anchor = structure.bases[0]!.cluster.center;
  let furthest = 0;
  for (const base of structure.bases) {
    furthest = Math.max(furthest, distanceKm(anchor, base.cluster.center));
    for (const satellite of base.satellites) {
      furthest = Math.max(furthest, distanceKm(anchor, satellite.cluster.center));
    }
  }
  return Math.round(Math.max(dayReach, furthest + dayReach));
}
