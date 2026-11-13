import type { RouteFeasibility } from '../schemas/route-feasibility';
import type { TravelTimeMatrixData } from '../schemas/compiled-region';

/**
 * EVAL V3 — PROXIMITY IS NOT DRIVEABILITY.
 *
 * Where no router answered, Sidequest estimates a leg from straight-line
 * distance (`estimate.ts#estimateLegMinutes`). That is honest about *how far*
 * and silent about *whether a road joins the two ends*: a trailhead on one side
 * of a sea cliff and a lookout on the other were planned as a 20-minute drive
 * when the road goes around the island in about three hours.
 *
 * Travel times obey the triangle inequality. For any point k with measured
 * T(k,a) and T(k,b), T(k,b) ≤ T(k,a) + T(a,b), so
 *
 *     T(a,b) ≥ T(k,b) − T(k,a)          (from k's row)
 *     T(a,b) ≥ T(a,k) − T(b,k)          (from k's column)
 *
 * Measuring every base to every place therefore bounds every place-to-place
 * pair from below, whatever the provider, with no place-specific rule: if a
 * base reaches one stop in 45 minutes and another in 2 h 45, the two stops are
 * at least two hours apart by road, however close they look on a map.
 *
 * Only router-measured cells are ever pivots — a bound is never derived from
 * another estimate or another bound. Where a direction was not measured, the
 * reverse is used for it (a road network is close to symmetric at this scale,
 * and the providers already mirror a pair they measured one way). The result is
 * a floor: labelled `bounded_estimate`, scheduled as at least that long, and —
 * like every estimate — never the trigger for a hard-constraint removal.
 *
 * Pure: no provider, no clock.
 */

/** A matrix in which a non-finite or null cell means "nobody measured this pair". */
export interface PartialTravelMatrix {
  ids: readonly string[];
  minutes: readonly (readonly (number | null | undefined)[])[];
}

export interface TriangleBound {
  minutes: number;
  /** The measured point the bound was proved through. */
  viaId: string;
}

function cell(m: PartialTravelMatrix, i: number, j: number): number | null {
  const v = m.minutes[i]?.[j];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A measured figure for i→j, or the measured reverse when only that direction was asked. */
function measuredEitherWay(m: PartialTravelMatrix, i: number, j: number): number | null {
  return cell(m, i, j) ?? cell(m, j, i);
}

/**
 * The best lower bound on T(from,to) that measured legs prove, or null when no
 * measured point sees both ends. `pivots` limits which points may serve (by
 * index); every point with a measured cell is used by default.
 */
export function triangleLowerBound(m: PartialTravelMatrix, from: number, to: number, pivots?: readonly number[]): TriangleBound | null {
  if (from === to) return null;
  let best: TriangleBound | null = null;
  const consider = pivots ?? m.ids.map((_, k) => k);
  for (const k of consider) {
    if (k === from || k === to) continue;
    const kTo = measuredEitherWay(m, k, to);
    const kFrom = measuredEitherWay(m, k, from);
    const fromK = measuredEitherWay(m, from, k);
    const toK = measuredEitherWay(m, to, k);
    const rowBound = kTo !== null && kFrom !== null ? kTo - kFrom : null;
    const columnBound = fromK !== null && toK !== null ? fromK - toK : null;
    for (const bound of [rowBound, columnBound]) {
      if (bound !== null && bound > 0 && (!best || bound > best.minutes)) best = { minutes: bound, viaId: m.ids[k]! };
    }
  }
  return best;
}

/** The pair key used for an affirmative no-route set. */
export function routePairKey(fromId: string, toId: string): string {
  return `${fromId}\u0000${toId}`;
}

export interface BoundedLeg {
  minutes: number;
  feasibility: RouteFeasibility;
  /** Present when the figure is a proved floor rather than the straight-line estimate. */
  bound?: TriangleBound;
}

/**
 * One unmeasured leg: the straight-line estimate, raised to the measured bound
 * when the bound is longer. `fallback` is the status when no bound applies
 * (`plausible_unverified` when a router could have been asked but this pair was
 * not, `provider_unavailable` when no router could answer). Rounded up to five
 * minutes so a floor never reads as precision it does not have.
 */
export function boundedLegMinutes(input: { estimate: number | null; bound: TriangleBound | null; fallback?: 'plausible_unverified' | 'provider_unavailable' }): BoundedLeg | null {
  const fallback = input.fallback ?? 'plausible_unverified';
  if (input.bound && (input.estimate === null || input.bound.minutes >= input.estimate)) {
    return { minutes: Math.ceil(input.bound.minutes / 5) * 5, feasibility: 'bounded_estimate', bound: input.bound };
  }
  if (input.estimate === null) return null;
  return { minutes: input.estimate, feasibility: fallback };
}

export interface BoundMatrixInput {
  matrix: TravelTimeMatrixData;
  /** True where a router measured the cell. Defaults to the matrix's own `feasibility` grid (`verified` cells), else to nothing measured. */
  measured?: readonly (readonly boolean[])[];
  /** Pairs a router affirmatively reported unroutable on this profile (`routePairKey`). Only the direct-route `not_found` answer belongs here. */
  disconnected?: ReadonlySet<string>;
  /** The status of an unmeasured cell no bound improves. */
  unmeasuredStatus?: 'plausible_unverified' | 'provider_unavailable';
}

export interface BoundMatrixResult {
  matrix: TravelTimeMatrixData;
  counts: Record<RouteFeasibility, number>;
}

/**
 * The scan's matrix with every unmeasured cell raised to the best measured
 * bound and labelled. Idempotent: run it on its own output and nothing changes,
 * because only `verified` cells are pivots and the stored estimates are only
 * ever raised. A matrix with no measured cell is returned labelled and
 * otherwise unchanged.
 */
export function boundTravelMatrix(input: BoundMatrixInput): BoundMatrixResult {
  const { matrix } = input;
  const n = matrix.ids.length;
  const prior = matrix.feasibility;
  const isMeasured = (i: number, j: number): boolean => (input.measured ? input.measured[i]?.[j] === true : prior?.[i]?.[j] === 'verified');
  const fallback = input.unmeasuredStatus ?? 'plausible_unverified';
  const measuredOnly: (number | null)[][] = matrix.ids.map((_, i) => matrix.ids.map((__, j) => (i !== j && isMeasured(i, j) ? (matrix.minutes[i]?.[j] ?? null) : null)));
  const partial: PartialTravelMatrix = { ids: matrix.ids, minutes: measuredOnly };
  const pivots = matrix.ids.map((_, k) => k).filter((k) => measuredOnly[k]!.some((v) => v !== null) || measuredOnly.some((row) => row[k] !== null));
  const counts = Object.fromEntries((['verified', 'bounded_estimate', 'plausible_unverified', 'disconnected', 'other_mode_required', 'provider_unavailable'] as const).map((s) => [s, 0])) as Record<RouteFeasibility, number>;
  const minutes = matrix.minutes.map((row) => [...row]);
  const feasibility: RouteFeasibility[][] = matrix.ids.map((from, i) =>
    matrix.ids.map((to, j) => {
      if (i === j) return 'verified';
      let status: RouteFeasibility;
      if (input.disconnected?.has(routePairKey(from, to)) || prior?.[i]?.[j] === 'disconnected') status = 'disconnected';
      else if (isMeasured(i, j)) status = 'verified';
      else {
        const estimate = matrix.minutes[i]?.[j];
        const priorStatus = prior?.[i]?.[j];
        const base = priorStatus === 'provider_unavailable' || priorStatus === 'plausible_unverified' ? priorStatus : fallback;
        const leg = boundedLegMinutes({ estimate: typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null, bound: n > 2 ? triangleLowerBound(partial, i, j, pivots) : null, fallback: base });
        if (leg) {
          minutes[i]![j] = leg.minutes;
          status = leg.feasibility;
        } else status = base;
      }
      counts[status] += 1;
      return status;
    }),
  );
  return { matrix: { ...matrix, minutes, feasibility }, counts };
}

/** The status of one cell of a matrix, when it carries a grid. */
export function matrixFeasibility(matrix: { ids: readonly string[]; feasibility?: readonly (readonly string[])[] }, fromId: string, toId: string): RouteFeasibility | null {
  const i = matrix.ids.indexOf(fromId);
  const j = matrix.ids.indexOf(toId);
  if (i < 0 || j < 0) return null;
  const v = matrix.feasibility?.[i]?.[j];
  return (v as RouteFeasibility | undefined) ?? null;
}

/**
 * The lower bound for an arbitrary pair against a matrix's verified cells —
 * for callers (the planner, the reconciler) whose endpoints may sit outside
 * the matrix: `measured` answers a router figure for any two ids or null.
 */
export function lowerBoundFrom(input: { pivots: readonly string[]; measured: (fromId: string, toId: string) => number | null; fromId: string; toId: string }): TriangleBound | null {
  const { fromId, toId, measured } = input;
  if (fromId === toId) return null;
  const either = (a: string, b: string) => measured(a, b) ?? measured(b, a);
  let best: TriangleBound | null = null;
  for (const k of input.pivots) {
    if (k === fromId || k === toId) continue;
    const toB = measured(k, toId);
    const toA = measured(k, fromId);
    const fromA = measured(fromId, k);
    const fromB = measured(toId, k);
    /* Directed where both directions were measured; otherwise the reverse stands in, as in `triangleLowerBound`. */
    const rowBound = toB !== null && toA !== null ? toB - toA : either(k, toId) !== null && either(k, fromId) !== null ? either(k, toId)! - either(k, fromId)! : null;
    const columnBound = fromA !== null && fromB !== null ? fromA - fromB : either(fromId, k) !== null && either(toId, k) !== null ? either(fromId, k)! - either(toId, k)! : null;
    for (const bound of [rowBound, columnBound]) {
      if (bound !== null && bound > 0 && (!best || bound > best.minutes)) best = { minutes: bound, viaId: k };
    }
  }
  return best;
}

/** The matrix's verified cells as a lookup, and the ids that can serve as pivots. */
export function verifiedLookup(matrix: { ids: readonly string[]; minutes: readonly (readonly number[])[]; feasibility?: readonly (readonly string[])[] }): { pivots: string[]; measured: (fromId: string, toId: string) => number | null } {
  const index = new Map(matrix.ids.map((id, i) => [id, i] as const));
  const grid = matrix.feasibility;
  if (!grid) return { pivots: [], measured: () => null };
  const measured = (a: string, b: string): number | null => {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined || i === j || grid[i]?.[j] !== 'verified') return null;
    const v = matrix.minutes[i]?.[j];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const pivots = matrix.ids.filter((_, k) => grid[k]?.some((s, j) => j !== k && s === 'verified'));
  return { pivots, measured };
}
