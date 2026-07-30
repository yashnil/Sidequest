import { leg, routeSummary } from './matrix';
import type { TravelTimeMatrix } from './types';

export interface OrderOptions {
  /** Where the day begins — normally the base the traveller is sleeping at. */
  startId: string;
  /** Where the day ends. Same as `startId` under the single-base model. */
  endId: string;
  stopIds: readonly string[];
  /** Bound on 2-opt sweeps. Small on purpose; see the note below. */
  maxPasses?: number;
}

export interface OrderedRoute {
  /** Full path including start and end. */
  path: string[];
  totalMinutes: number;
  totalKm: number;
  /** How many 2-opt improvements were accepted. Useful in diagnostics. */
  improvements: number;
}

/**
 * Nearest-neighbour construction followed by a bounded 2-opt improvement.
 *
 * At the scale this planner works at — a handful of stops in a day — 2-opt gets
 * to an optimal or near-optimal ordering in microseconds, and it is small enough
 * to read and to test. Anything heavier (OR-Tools, a hosted optimiser) would be
 * infrastructure bought for a problem this size does not have.
 *
 * Deterministic throughout: nearest-neighbour ties break by id, and 2-opt scans
 * in a fixed order and accepts only strict improvements.
 */
export function orderStops(matrix: TravelTimeMatrix, options: OrderOptions): OrderedRoute {
  const stops = [...new Set(options.stopIds)].filter(
    (id) => id !== options.startId && id !== options.endId,
  );

  if (stops.length === 0) {
    const path = options.startId === options.endId ? [options.startId] : [options.startId, options.endId];
    const summary = routeSummary(matrix, path);
    return { path, totalMinutes: summary.totalMinutes, totalKm: summary.totalKm, improvements: 0 };
  }

  // --- Nearest neighbour -------------------------------------------------
  const remaining = new Set(stops);
  const middle: string[] = [];
  let current = options.startId;

  while (remaining.size > 0) {
    let best: string | null = null;
    let bestMinutes = Number.POSITIVE_INFINITY;
    for (const candidate of [...remaining].sort()) {
      const minutes = leg(matrix, current, candidate).minutes;
      if (minutes < bestMinutes) {
        bestMinutes = minutes;
        best = candidate;
      }
    }
    const chosen = best ?? [...remaining].sort()[0]!;
    middle.push(chosen);
    remaining.delete(chosen);
    current = chosen;
  }

  // --- Bounded 2-opt -----------------------------------------------------
  let path = [options.startId, ...middle, options.endId];
  const maxPasses = options.maxPasses ?? 12;
  let improvements = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improvedThisPass = false;

    for (let i = 1; i < path.length - 2; i += 1) {
      for (let j = i + 1; j < path.length - 1; j += 1) {
        const a = path[i - 1]!;
        const b = path[i]!;
        const c = path[j]!;
        const d = path[j + 1]!;

        const before = leg(matrix, a, b).minutes + leg(matrix, c, d).minutes;
        const after = leg(matrix, a, c).minutes + leg(matrix, b, d).minutes;

        if (after < before - 1e-9) {
          const reversed = path.slice(i, j + 1).reverse();
          path = [...path.slice(0, i), ...reversed, ...path.slice(j + 1)];
          improvements += 1;
          improvedThisPass = true;
        }
      }
    }

    if (!improvedThisPass) break;
  }

  const summary = routeSummary(matrix, path);
  return { path, totalMinutes: summary.totalMinutes, totalKm: summary.totalKm, improvements };
}
