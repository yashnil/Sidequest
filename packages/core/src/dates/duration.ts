import type { DestinationFeatureType } from '../schemas/destination-index';

/**
 * HOW LONG A TRIP NEEDS TO BE, FROM THE GEOGRAPHY RATHER THAN FROM A GUIDEBOOK.
 *
 * "Ten days is right for Iceland" is the kind of sentence this module exists to
 * never produce. It is authored destination knowledge, it ages, and it is
 * exactly what the architecture forbids.
 *
 * What is used instead is measurable: how many separate clusters of things worth
 * doing the region actually contains, how far apart they are, how long a
 * transfer between them costs, and how many bases the traveller will tolerate.
 * Every input is a number somebody could check.
 *
 * The output is a set of *options with tradeoffs*, not one number, because for
 * any region larger than a town there genuinely is no single right answer — five
 * days is a good trip to one part of Kyrgyzstan and a bad trip to all of it.
 */

export interface DurationOption {
  minNights: number;
  maxNights: number;
  /** Bases the traveller sleeps in. One means never packing up. */
  bases: number;
  label: string;
  /** What this length buys, from the cluster model. */
  covers: string;
  tradeoff: string;
  /** How many of the region's clusters this option reaches. */
  clustersReached: number;
  /** Whole days spent moving rather than doing. */
  transferDays: number;
  recommended: boolean;
}

export interface DurationRecommendation {
  kind: 'recommended';
  options: DurationOption[];
  /** The clusters the estimate is built on, so the number is checkable. */
  clusterCount: number;
  basis: string;
}

export type DurationGuidance =
  | DurationRecommendation
  | { kind: 'unavailable'; note: string };

/**
 * A cluster of things worth doing, close enough to be reachable from one base.
 *
 * Produced by the broad-scope layer from indexed source coordinates. The
 * duration model does not care what is *in* a cluster, only that it exists, how
 * far it is, and how much is there — which is why this interface is three fields
 * and not a place list.
 */
export interface DurationCluster {
  id: string;
  name: string;
  /** Indexed features inside it. A proxy for how many days it can hold. */
  weight: number;
  /** Estimated minutes from the region's principal gateway. */
  transferMinutes: number;
}

/**
 * Days one cluster can hold before it repeats itself.
 *
 * A floor of two and a ceiling of four. Two, because arriving somewhere, sleeping
 * and leaving is not a visit. Four, because past that a single base means driving
 * further each day to find something new, which is the point at which moving base
 * wins — and that trade is what the options below are made of.
 */
const MIN_DAYS_PER_CLUSTER = 2;
const MAX_DAYS_PER_CLUSTER = 4;

/** Above this, a transfer eats a day rather than a morning. */
const TRANSFER_DAY_MINUTES = 210;

export function daysForCluster(cluster: DurationCluster, pace?: 'slow' | 'balanced' | 'packed'): number {
  const fromWeight = Math.min(MAX_DAYS_PER_CLUSTER, Math.max(MIN_DAYS_PER_CLUSTER, Math.ceil(cluster.weight / 6)));
  if (pace === 'packed') return Math.max(MIN_DAYS_PER_CLUSTER, fromWeight - 1);
  if (pace === 'slow') return Math.min(MAX_DAYS_PER_CLUSTER + 1, fromWeight + 1);
  return fromWeight;
}

export interface RecommendDurationInput {
  featureType: DestinationFeatureType;
  destinationName: string;
  /** Ordered by desirability. The model takes them greedily. */
  clusters: readonly DurationCluster[];
  pace?: 'slow' | 'balanced' | 'packed';
  /** How many base changes the traveller has said they will accept. */
  maxBaseChanges?: number;
  /** Whether they will drive, which decides whether distant clusters exist at all. */
  canDrive?: boolean;
  /**
   * Nights the traveller already has, when they have any.
   *
   * Absent means nobody has said — and then **nothing is marked recommended**.
   * See `markRecommendation` for why that is the honest answer rather than a
   * default.
   */
  nights?: number | null;
}

/**
 * Two or three length options, each with what it reaches and what it costs.
 *
 * Returns `unavailable` when there is no cluster model. A duration invented from
 * the feature type alone would be a stereotype with a number on it — which is
 * precisely the thing this file's header refuses.
 */
export function recommendTripLength(input: RecommendDurationInput): DurationGuidance {
  const clusters = [...input.clusters];
  if (clusters.length === 0) {
    return {
      kind: 'unavailable',
      note: 'We have not mapped this region into areas yet, so we will not guess at a trip length.',
    };
  }

  const baseCeiling =
    input.maxBaseChanges === undefined ? clusters.length : Math.min(clusters.length, input.maxBaseChanges + 1);

  const options: DurationOption[] = [];
  const shapes: { bases: number; label: string }[] = [
    { bases: 1, label: 'One area, properly' },
    { bases: 2, label: 'Two bases' },
    { bases: 3, label: 'A route across the region' },
  ];

  for (const shape of shapes) {
    if (shape.bases > baseCeiling) continue;
    const taken = clusters.slice(0, shape.bases);
    if (taken.length < shape.bases) continue;

    const activeDays = taken.reduce((total, cluster) => total + daysForCluster(cluster, input.pace), 0);
    /*
     * Transfers cost whole days only when they are long enough to.
     *
     * A ninety-minute move between bases is a morning; a five-hour one is the
     * day. Counting every base change as a lost day overstates a compact
     * country and understates a big one, and both errors show up as a
     * recommendation the traveller can feel is wrong.
     */
    const transferDays = taken
      .slice(1)
      .reduce(
        (total, cluster) => total + (cluster.transferMinutes >= TRANSFER_DAY_MINUTES ? 1 : 0.5),
        0,
      );
    /* Arrival and departure are partial days at both ends of any trip. */
    const edgeDays = 1;
    const nights = Math.ceil(activeDays + transferDays + edgeDays) - 1;

    const reach = taken.map((cluster) => cluster.name).join(', ');
    const skipped = clusters.length - taken.length;

    options.push({
      minNights: Math.max(1, nights - 1),
      maxNights: nights + 1,
      bases: shape.bases,
      label: shape.label,
      covers: reach,
      tradeoff:
        skipped > 0
          ? `Leaves out ${skipped} other area${skipped === 1 ? '' : 's'} we found.`
          : 'Reaches everywhere we found worth going.',
      clustersReached: taken.length,
      transferDays: Math.round(transferDays * 10) / 10,
      recommended: false,
    });
  }

  if (options.length === 0) {
    return {
      kind: 'unavailable',
      note: 'The areas we found do not support a trip of any length we would stand behind.',
    };
  }

  markRecommendation(options, input.nights ?? null);

  return {
    kind: 'recommended',
    options,
    clusterCount: clusters.length,
    basis: `${clusters.length} distinct area${clusters.length === 1 ? '' : 's'} in ${input.destinationName}, with travel times between them${input.canDrive === false ? ' on public transport' : ''}.`,
  };
}

/**
 * Which option to mark, and when to mark none.
 *
 * The first version scored options by clusters-per-night, which is degenerate:
 * one cluster in five nights, two in ten and three in fifteen are all 0.2, the
 * comparison never fired, and the shortest option was silently labelled "best
 * value for the ground" on every destination — including an eleven-night trip
 * where it recommended three nights.
 *
 * The honest rule: recommend the option that fits the nights the traveller
 * actually has. When nobody has said how long, recommend **nothing** — there is
 * no defensible answer, and a badge with no basis is worse than no badge.
 */
function markRecommendation(options: DurationOption[], nights: number | null): void {
  for (const option of options) option.recommended = false;
  if (nights === null) return;

  const containing = options.filter(
    (option) => nights >= option.minNights && nights <= option.maxNights,
  );
  if (containing.length > 0) {
    // The one that does most with the time: the most clusters it can reach.
    const best = containing.reduce((a, b) => (b.clustersReached > a.clustersReached ? b : a));
    best.recommended = true;
    return;
  }

  // Outside every range: the closest option, so the traveller sees the gap.
  const closest = options.reduce((a, b) => {
    const distanceA = Math.min(Math.abs(nights - a.minNights), Math.abs(nights - a.maxNights));
    const distanceB = Math.min(Math.abs(nights - b.minNights), Math.abs(nights - b.maxNights));
    return distanceB < distanceA ? b : a;
  });
  closest.recommended = true;
}

/**
 * Whether a trip of this length can hold this scope.
 *
 * The counterpart to the recommendation: a traveller who has *already* fixed
 * their dates gets told whether what they named fits, and by how much. Never
 * silently corrected — shrinking somebody's destination without saying so is
 * worse than telling them it does not fit.
 */
export function durationFits(input: {
  nights: number;
  guidance: DurationGuidance;
}): { fits: boolean; note?: string; suggestion?: DurationOption } {
  if (input.guidance.kind === 'unavailable') return { fits: true };

  const reachable = input.guidance.options.filter((option) => option.minNights <= input.nights);
  if (reachable.length === 0) {
    const shortest = input.guidance.options.reduce((a, b) => (a.minNights < b.minNights ? a : b));
    return {
      fits: false,
      note: `${input.nights} night${input.nights === 1 ? '' : 's'} is short for this. The least we would build here is ${shortest.minNights}, covering ${shortest.covers}.`,
      suggestion: shortest,
    };
  }

  const best = reachable.reduce((a, b) => (a.clustersReached > b.clustersReached ? a : b));
  const longest = input.guidance.options.reduce((a, b) => (a.clustersReached > b.clustersReached ? a : b));
  if (best.clustersReached < longest.clustersReached) {
    return {
      fits: true,
      note: `At ${input.nights} nights we would build ${best.covers}. ${longest.maxNights} nights would reach ${longest.covers}.`,
      suggestion: best,
    };
  }
  return { fits: true, suggestion: best };
}
