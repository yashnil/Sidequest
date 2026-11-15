import { describe, expect, it } from 'vitest';
import type { TravelTimeMatrixData } from '@sidequest/core';
import { plannerSurvivesDegradedRouting, routingEvidenceOf } from './routing-evidence';

type Status = NonNullable<TravelTimeMatrixData['feasibility']>[number][number];

function matrix(ids: string[], cell: (i: number, j: number) => Status): TravelTimeMatrixData {
  return {
    mode: 'car',
    ids,
    minutes: ids.map(() => ids.map(() => 10)),
    km: ids.map(() => ids.map(() => 10)),
    provenance: { kind: 'estimated', note: 'test', source: 'sidequest-geo-estimate' },
    feasibility: ids.map((_, i) => ids.map((__, j) => (i === j ? 'verified' : cell(i, j)))),
  };
}

const ids = ['base-a', 'p1', 'p2', 'p3', 'p4'];
const bases = new Set(['base-a']);

describe('routing evidence', () => {
  it('a router that answered the base rows is not degraded', () => {
    const e = routingEvidenceOf(matrix(ids, (i, j) => (i === 0 || j === 0 ? 'verified' : 'bounded_estimate')), bases)!;
    expect(e.baseRows).toEqual({ measured: 8, total: 8 });
    expect(e.degraded).toBe(false);
  });

  it('a router that was asked and mostly went quiet is degraded', () => {
    const e = routingEvidenceOf(matrix(ids, (i, j) => (i === 0 && j === 1 ? 'verified' : 'plausible_unverified')), bases)!;
    expect(e.routerAsked).toBe(true);
    expect(e.baseRows.measured).toBe(1);
    expect(e.degraded).toBe(true);
  });

  it('a router asked before the scan that answered nothing at all (quota already spent) is degraded', () => {
    const m = matrix(ids, () => 'provider_unavailable');
    m.provenance = { kind: 'estimated', note: 'No journeys measured: openrouteservice did not answer any of 3 requests.', source: 'openrouteservice' };
    const e = routingEvidenceOf(m, bases)!;
    expect(e.routerAsked).toBe(true);
    expect(e.degraded).toBe(true);
  });

  it('no router at all is a different state and never reads as degraded', () => {
    const e = routingEvidenceOf(matrix(ids, () => 'provider_unavailable'), bases)!;
    expect(e.routerAsked).toBe(false);
    expect(e.degraded).toBe(false);
  });

  it('a router’s affirmative no-route counts as an answer', () => {
    const e = routingEvidenceOf(matrix(ids, (i, j) => (i === 0 || j === 0 ? 'disconnected' : 'plausible_unverified')), bases)!;
    expect(e.degraded).toBe(false);
  });

  it('a matrix without a feasibility grid says nothing', () => {
    const m = matrix(ids, () => 'verified');
    delete m.feasibility;
    expect(routingEvidenceOf(m, bases)).toBeNull();
    expect(routingEvidenceOf(null, bases)).toBeNull();
  });
});

describe('a routing failure never hands the trip to composition', () => {
  const quiet = routingEvidenceOf(matrix(ids, () => 'plausible_unverified'), bases);
  const healthy = routingEvidenceOf(matrix(ids, () => 'verified'), bases);
  it('keeps the planner when the router went quiet and no day could be fitted', () => {
    expect(plannerSurvivesDegradedRouting('no_feasible_day_assignment', quiet)).toBe(true);
    expect(plannerSurvivesDegradedRouting('required_user_places_unplaceable', quiet)).toBe(true);
  });
  it('a thin board still composes, degraded or not', () => {
    expect(plannerSurvivesDegradedRouting('insufficient_candidates', quiet)).toBe(false);
    expect(plannerSurvivesDegradedRouting('insufficient_placed_candidates', quiet)).toBe(false);
  });
  it('healthy routing changes nothing', () => {
    expect(plannerSurvivesDegradedRouting('no_feasible_day_assignment', healthy)).toBe(false);
    expect(plannerSurvivesDegradedRouting(null, quiet)).toBe(false);
  });
});
