import type { TravelTimeMatrixData } from '@sidequest/core';

/**
 * FINAL PASS — HOW MUCH OF THE TRIP'S GEOGRAPHY A ROUTER ACTUALLY ANSWERED.
 *
 * Eval v3's degraded Tanzania run: openrouteservice's quota ran out mid-scan,
 * 90 of 1,482 pairs were measured, the planner could not fill a day from the
 * estimates, and the build handed the whole trip to model composition — which
 * is bound by neither the pillars nor the stay decision, and added a Zanzibar
 * extension while the Serengeti days stood empty. A routing failure must never
 * destroy the trip (`.claude-private` final brief §5): this reads the scan's own
 * matrix so the build can tell "the board is thin" (composition can help) from
 * "the router went quiet" (composition would only ignore the evidence).
 *
 * `degraded` is true only when a router was asked and mostly did not answer:
 * a matrix whose unmeasured cells are all `provider_unavailable` had no router
 * at all (fixtures, an unconfigured deployment), which is a different, already
 * labelled state and changes nothing here.
 */
export interface RoutingEvidence {
  /** Base ↔ place cells, both directions. */
  baseRows: { measured: number; total: number };
  /** Off-diagonal cells a router verified, of all off-diagonal cells. */
  measuredPairs: number;
  totalPairs: number;
  /** A router was asked (some cell verified or `plausible_unverified`). */
  routerAsked: boolean;
  degraded: boolean;
}

/** Below this share of verified base rows, a router that was asked is treated as having gone quiet. */
export const DEGRADED_BASE_ROW_SHARE = 0.5;

export function routingEvidenceOf(matrix: TravelTimeMatrixData | null | undefined, baseIds: ReadonlySet<string>): RoutingEvidence | null {
  if (!matrix || !matrix.feasibility || matrix.ids.length < 2) return null;
  const isBase = matrix.ids.map((id) => baseIds.has(id));
  let measured = 0;
  let total = 0;
  let baseMeasured = 0;
  let baseTotal = 0;
  let asked = false;
  matrix.ids.forEach((_, i) => {
    matrix.ids.forEach((__, j) => {
      if (i === j) return;
      const status = matrix.feasibility![i]?.[j];
      total += 1;
      const verified = status === 'verified' || status === 'disconnected';
      if (verified) measured += 1;
      if (verified || status === 'plausible_unverified') asked = true;
      if (isBase[i] !== isBase[j]) {
        baseTotal += 1;
        if (verified) baseMeasured += 1;
      }
    });
  });
  const share = baseTotal > 0 ? baseMeasured / baseTotal : total > 0 ? measured / total : 1;
  return { baseRows: { measured: baseMeasured, total: baseTotal }, measuredPairs: measured, totalPairs: total, routerAsked: asked, degraded: asked && share < DEGRADED_BASE_ROW_SHARE };
}

/**
 * Whether the planner's plan ships instead of a model composition. Only a
 * failure composition cannot fix — a day nothing measured could be fitted to,
 * or a pick no day could hold — and only when the router went quiet. A thin
 * board (`insufficient_candidates`) still composes: there, the model adds
 * places the scan never found, which is what it is for.
 */
export function plannerSurvivesDegradedRouting(fallbackReason: string | null, evidence: RoutingEvidence | null): boolean {
  if (!fallbackReason || !evidence?.degraded) return false;
  return fallbackReason === 'no_feasible_day_assignment' || fallbackReason === 'required_user_places_unplaceable';
}
