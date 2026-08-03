import type { TravelTimeMatrix } from '@sidequest/geo';
import { tryLeg } from '@sidequest/geo';
import type { RoutableCluster } from './plan';

/**
 * WHICH BASES, IN WHAT ORDER, FOR HOW LONG — DETERMINISTICALLY.
 *
 * The previous slice proposed four bases for Kyrgyzstan as *display metadata*:
 * a list on a screen that nothing downstream read. This turns it into a real
 * portfolio the planner is held to — with nights per base, a transfer sequence,
 * and a reason for every inclusion and every exclusion.
 *
 * **The model does not choose bases.** Every decision here comes from measured
 * inter-cluster travel, the trip's own length, and answers the traveller gave.
 * A model may narrate the result from those structured inputs; it may not
 * produce them.
 *
 * The ordering is a bounded exact search rather than a heuristic. With at most
 * a handful of bases the permutations are countable, so the shortest real route
 * is computed rather than approximated — and being exact is what lets the
 * transfer figures on screen be the ones the planner will actually schedule.
 */

export interface BaseAssignment {
  clusterId: string;
  baseId: string;
  baseName: string;
  /** Position in the route. 0 is where the trip starts. */
  order: number;
  /** Nights slept here. Sums to the trip's nights across the portfolio. */
  nights: number;
  /** First and last date this base is occupied, inclusive. */
  fromDate: string;
  toDate: string;
  /** Measured minutes from the previous base. Zero for the first. */
  transferMinutesFromPrevious: number;
  /** Whether reaching this base costs a day rather than a morning. */
  transferIsWholeDay: boolean;
}

export interface ExcludedCluster {
  clusterId: string;
  name: string;
  reason: string;
  /** True when routing could not connect it, as opposed to it not fitting. */
  unreachable: boolean;
}

export interface BasePortfolio {
  bases: BaseAssignment[];
  excluded: ExcludedCluster[];
  /** Whole days the route spends moving. Measured, not estimated. */
  transferDays: number;
  /** The rule that produced this shape, in one checkable sentence. */
  rationale: string;
}

/**
 * The shortest a base change can be and still be worth making.
 *
 * Two nights. One night in a place is an arrival and a departure with a sleep
 * between them — the traveller unpacks, and the following morning is spent
 * packing again. A portfolio that proposed it would be optimising a map rather
 * than a holiday.
 */
export const MIN_NIGHTS_PER_BASE = 2;

/**
 * Above this, a transfer is a day rather than a morning.
 *
 * Matches the portfolio estimator's threshold in the scope layer, deliberately:
 * the preflight tells a traveller "about two days in transfers" and the planner
 * then has to schedule what the preflight promised. Two different thresholds
 * would make the estimate wrong in a way nobody could see.
 */
export const TRANSFER_WHOLE_DAY_MINUTES = 210;

export interface SelectBasesInput {
  clusters: readonly RoutableCluster[];
  /** The inter-cluster matrix. Measured; never the straight-line prefilter. */
  interCluster: TravelTimeMatrix | null;
  nights: number;
  /** Base changes the traveller accepted. `0` means one base for the trip. */
  maxBaseChanges: number;
  startDate: string;
  /**
   * Cluster value, so a shorter trip keeps the best ones. Higher is better.
   *
   * **Not** named `valueOf`. That name is inherited from `Object.prototype`, so
   * an input object without it still answers a *function* for `input.valueOf` —
   * which means `input.valueOf ?? fallback` never takes the fallback, and the
   * inherited method is then called with a string argument and throws. The
   * tests caught it on the first run; the name is the whole bug.
   */
  clusterValue?: (clusterId: string) => number;
}

/**
 * Build the portfolio.
 *
 * Returns a single-base portfolio when the traveller asked for one, when there
 * is only one cluster, or when routing could not connect any others — and in the
 * last case the unreachable clusters come back as `excluded` with
 * `unreachable: true`, which is what lets the caller distinguish "does not fit"
 * from "we could not measure it".
 */
export function selectBases(input: SelectBasesInput): BasePortfolio {
  const withBases = input.clusters.filter((cluster) => cluster.base !== undefined);
  const excluded: ExcludedCluster[] = [];

  for (const cluster of input.clusters) {
    if (!cluster.base) {
      excluded.push({
        clusterId: cluster.id,
        name: cluster.name,
        reason: 'We could not find anywhere to stay in this area.',
        unreachable: false,
      });
    }
  }

  if (withBases.length === 0) {
    return {
      bases: [],
      excluded,
      transferDays: 0,
      rationale: 'No area we found has somewhere to base a trip from.',
    };
  }

  const value = input.clusterValue ?? (() => 0);
  const ranked = [...withBases].sort(
    (a, b) => value(b.id) - value(a.id) || a.id.localeCompare(b.id),
  );

  /*
   * How many bases the *trip* can hold, before reachability is consulted.
   *
   * Three constraints, and the smallest wins: what the traveller accepted, how
   * many clusters have a base at all, and how many two-night stays fit in the
   * nights available. The third is what stops an eleven-night trip proposing
   * five bases at two nights each with four transfer days between them.
   */
  const byNights = Math.max(1, Math.floor(input.nights / MIN_NIGHTS_PER_BASE));
  const wanted = Math.max(1, Math.min(input.maxBaseChanges + 1, ranked.length, byNights));

  const chosen: RoutableCluster[] = [];
  for (const cluster of ranked) {
    if (chosen.length >= wanted) break;
    /*
     * A cluster only joins the route if it is measurably reachable from one
     * already in it. Unreachable is a *routing* verdict, kept separate from not
     * fitting, because the two need different sentences and different remedies.
     */
    if (chosen.length === 0 || isConnected(input.interCluster, chosen, cluster)) {
      chosen.push(cluster);
      continue;
    }
    excluded.push({
      clusterId: cluster.id,
      name: cluster.name,
      reason: 'We could not measure a route to this area from the rest of the trip.',
      unreachable: true,
    });
  }

  for (const cluster of ranked) {
    if (chosen.includes(cluster)) continue;
    if (excluded.some((entry) => entry.clusterId === cluster.id)) continue;
    excluded.push({
      clusterId: cluster.id,
      name: cluster.name,
      reason:
        input.maxBaseChanges + 1 <= chosen.length
          ? 'You said you would rather not move base again.'
          : `${input.nights} nights does not hold another base.`,
      unreachable: false,
    });
  }

  const ordered = orderRoute(chosen, input.interCluster);
  const nightsPerBase = distributeNights(ordered.length, input.nights);

  const bases: BaseAssignment[] = [];
  let cursor = input.startDate;
  for (const [index, cluster] of ordered.entries()) {
    const nights = nightsPerBase[index] ?? 0;
    const previous = ordered[index - 1];
    const minutes =
      previous && input.interCluster
        ? (tryLeg(input.interCluster, previous.base!.id, cluster.base!.id)?.minutes ?? 0)
        : 0;

    const toDate = addDays(cursor, Math.max(0, nights - 1));
    bases.push({
      clusterId: cluster.id,
      baseId: cluster.base!.id,
      baseName: cluster.name,
      order: index,
      nights,
      fromDate: cursor,
      toDate,
      transferMinutesFromPrevious: Math.round(minutes),
      transferIsWholeDay: minutes >= TRANSFER_WHOLE_DAY_MINUTES,
    });
    cursor = addDays(toDate, 1);
  }

  const transferDays = bases.reduce(
    (total, base) => total + (base.order === 0 ? 0 : base.transferIsWholeDay ? 1 : 0.5),
    0,
  );

  return {
    bases,
    excluded,
    transferDays: Math.round(transferDays * 10) / 10,
    rationale:
      bases.length === 1
        ? `One base for ${input.nights} nights: ${bases[0]?.baseName}.`
        : `${bases.length} bases over ${input.nights} nights, ordered by measured travel between them.`,
  };
}

function isConnected(
  matrix: TravelTimeMatrix | null,
  chosen: readonly RoutableCluster[],
  candidate: RoutableCluster,
): boolean {
  /*
   * With no inter-cluster matrix there is nothing to disprove reachability
   * with, and refusing every cluster would turn "we did not route" into "you
   * cannot go there". Optimistic here, and the planner is what actually refuses
   * a day it cannot schedule.
   */
  if (!matrix) return true;
  return chosen.some(
    (base) =>
      tryLeg(matrix, base.base!.id, candidate.base!.id) !== null &&
      tryLeg(matrix, candidate.base!.id, base.base!.id) !== null,
  );
}

/**
 * The order that minimises total transfer time, computed exactly.
 *
 * Brute force over permutations, which is defensible precisely because the input
 * is small: five bases is 120 orderings and the cap below refuses more. An
 * approximation would be faster and would occasionally disagree with the
 * transfer total shown on the preflight, which is a worse trade than the
 * microseconds.
 */
export function orderRoute(
  clusters: readonly RoutableCluster[],
  matrix: TravelTimeMatrix | null,
): RoutableCluster[] {
  if (clusters.length <= 2 || !matrix) return [...clusters];
  /** Above this, fall back to nearest-next; 6! = 720 is already generous. */
  if (clusters.length > 6) return nearestNext(clusters, matrix);

  const first = clusters[0]!;
  const rest = clusters.slice(1);
  let best: RoutableCluster[] = [first, ...rest];
  let bestCost = Number.POSITIVE_INFINITY;

  for (const permutation of permutations(rest)) {
    const route = [first, ...permutation];
    let cost = 0;
    let usable = true;
    for (let index = 1; index < route.length; index += 1) {
      const leg = tryLeg(matrix, route[index - 1]!.base!.id, route[index]!.base!.id);
      if (!leg) {
        usable = false;
        break;
      }
      cost += leg.minutes;
    }
    if (!usable) continue;
    /* Ties break on the id sequence, so the answer is total and reproducible. */
    const key = route.map((entry) => entry.id).join('|');
    const bestKey = best.map((entry) => entry.id).join('|');
    if (cost < bestCost || (cost === bestCost && key < bestKey)) {
      best = route;
      bestCost = cost;
    }
  }
  return best;
}

function nearestNext(
  clusters: readonly RoutableCluster[],
  matrix: TravelTimeMatrix,
): RoutableCluster[] {
  const remaining = clusters.slice(1);
  const route = [clusters[0]!];
  let cursor = clusters[0]!;
  while (remaining.length > 0) {
    remaining.sort((a, b) => {
      const legA = tryLeg(matrix, cursor.base!.id, a.base!.id)?.minutes ?? Number.POSITIVE_INFINITY;
      const legB = tryLeg(matrix, cursor.base!.id, b.base!.id)?.minutes ?? Number.POSITIVE_INFINITY;
      return legA - legB || a.id.localeCompare(b.id);
    });
    const next = remaining.shift()!;
    route.push(next);
    cursor = next;
  }
  return route;
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index]!, ...tail];
  }
}

/**
 * Nights across bases, front-loaded.
 *
 * The remainder goes to the earliest bases rather than the latest, because the
 * first base absorbs the arrival day — which is usually a half day — and the
 * last one gives a morning back to the departure.
 */
export function distributeNights(bases: number, nights: number): number[] {
  if (bases <= 0) return [];
  if (bases === 1) return [nights];
  const each = Math.floor(nights / bases);
  const remainder = nights - each * bases;
  return Array.from({ length: bases }, (_, index) => each + (index < remainder ? 1 : 0));
}

function addDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Which base a given date belongs to.
 *
 * The function the planner reads to stop a day silently routing back to the
 * first base after the traveller has moved on — the defect this whole model
 * exists to make impossible.
 */
export function baseForDate(portfolio: BasePortfolio, date: string): BaseAssignment | null {
  return portfolio.bases.find((base) => date >= base.fromDate && date <= base.toDate) ?? null;
}

/** Whether this date is the one a traveller spends moving between bases. */
export function isTransferDate(portfolio: BasePortfolio, date: string): boolean {
  return portfolio.bases.some((base) => base.order > 0 && base.fromDate === date);
}
