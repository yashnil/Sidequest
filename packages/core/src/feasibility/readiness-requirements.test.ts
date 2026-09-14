import { describe, expect, it } from 'vitest';
import { readinessShortfalls, type RouteCompleteness } from './readiness-requirements';

/** The Canadian Rockies trip's own printed figures, which headed themselves "Ready, with cautions". */
const ROCKIES: RouteCompleteness = {
  basesPlaced: 4,
  basesTotal: 4,
  routeCriticalPlaced: 12,
  routeCriticalTotal: 24,
  baseTransfersTimed: 3,
  baseTransfersTotal: 3,
  signaturesPlaced: 2,
  signaturesTotal: 3,
  orderContradictions: 0,
  implausibleMeasurements: 0,
  unrepresentedAccessRequirements: 1,
  legsTimed: 14,
  legsTotal: 37,
};

const COMPLETE: RouteCompleteness = {
  basesPlaced: 4,
  basesTotal: 4,
  routeCriticalPlaced: 24,
  routeCriticalTotal: 24,
  baseTransfersTimed: 3,
  baseTransfersTotal: 3,
  signaturesPlaced: 3,
  signaturesTotal: 3,
  orderContradictions: 0,
  implausibleMeasurements: 0,
  unrepresentedAccessRequirements: 0,
  legsTimed: 30,
  legsTotal: 37,
};

describe('V11 §4 — "Ready" has to mean something', () => {
  it('refuses to let the founder Rockies trip through', () => {
    const shortfalls = readinessShortfalls({ archetype: 'road_trip', completeness: ROCKIES });
    expect(shortfalls.length).toBeGreaterThan(0);
    expect(shortfalls.map((s) => s.requirement)).toContain('signatures_placed');
    expect(shortfalls.map((s) => s.requirement)).toContain('route_critical_placed');
    expect(shortfalls.map((s) => s.requirement)).toContain('access_requirements');
  });

  it('passes a route whose critical set is complete, even with a third of the legs untimed', () => {
    /* §4 — optional POI placement may degrade. 30 of 37 with every route-critical thing placed is a ready trip. */
    expect(readinessShortfalls({ archetype: 'road_trip', completeness: COMPLETE })).toEqual([]);
  });

  it('never gates on the raw leg count', () => {
    const sparse = { ...COMPLETE, legsTimed: 4, legsTotal: 37 };
    expect(readinessShortfalls({ archetype: 'road_trip', completeness: sparse })).toEqual([]);
  });

  it('demands timed base transfers on a road-carried trip', () => {
    const untimed = { ...COMPLETE, baseTransfersTimed: 1, baseTransfersTotal: 3 };
    expect(readinessShortfalls({ archetype: 'road_trip', completeness: untimed }).map((s) => s.requirement)).toContain('base_transfers_timed');
  });

  it('does NOT demand them of an operator-led trip, where no router can supply them', () => {
    const untimed = { ...COMPLETE, baseTransfersTimed: 1, baseTransfersTotal: 3 };
    expect(readinessShortfalls({ archetype: 'guided_remote', completeness: untimed }).map((s) => s.requirement)).not.toContain('base_transfers_timed');
  });

  it('refuses a trip built around an experience nobody could place', () => {
    /* Bow Falls headed the Rockies "signature experiences" and had no position on the map. */
    const unplacedSignature = { ...COMPLETE, signaturesPlaced: 2, signaturesTotal: 3 };
    expect(readinessShortfalls({ archetype: 'single_base_urban', completeness: unplacedSignature }).map((s) => s.requirement)).toContain('signatures_placed');
  });

  it('refuses a trip carrying a measurement it would not schedule a day from', () => {
    const suspect = { ...COMPLETE, implausibleMeasurements: 1 };
    expect(readinessShortfalls({ archetype: 'guided_remote', completeness: suspect }).map((s) => s.requirement)).toContain('plausible_measurements');
  });

  it('refuses a day whose order the ground does not support', () => {
    const reversed = { ...COMPLETE, orderContradictions: 1 };
    expect(readinessShortfalls({ archetype: 'road_trip', completeness: reversed }).map((s) => s.requirement)).toContain('route_order');
  });

  it('says nothing at all about an archetype it does not recognise, beyond the universal requirements', () => {
    expect(readinessShortfalls({ archetype: undefined, completeness: COMPLETE })).toEqual([]);
  });

  it('still lets a genuinely good trip through — the V10 Iceland build, from its own recorded figures', () => {
    /*
     * `artifacts/v10/metrics.json`, the "after" column printed by the V10
     * founder benchmark: 5/5 bases placed, route-critical rate 1.00, 4/4 base
     * transfers measured, 27/29 legs timed. A gate that failed this would be a
     * gate that fails everything, which is a different way of saying nothing.
     */
    const iceland: RouteCompleteness = {
      basesPlaced: 5,
      basesTotal: 5,
      routeCriticalPlaced: 9,
      routeCriticalTotal: 9,
      baseTransfersTimed: 4,
      baseTransfersTotal: 4,
      signaturesPlaced: 3,
      signaturesTotal: 3,
      orderContradictions: 0,
      implausibleMeasurements: 0,
      unrepresentedAccessRequirements: 0,
      legsTimed: 27,
      legsTotal: 29,
    };
    expect(readinessShortfalls({ archetype: 'road_trip', completeness: iceland })).toEqual([]);
  });
});

describe('V12 §21 §35 — readiness reads the operating model, and intent can fail a routed trip', () => {
  const completeness = {
    basesTotal: 3,
    basesPlaced: 3,
    routeCriticalTotal: 3,
    routeCriticalPlaced: 3,
    signaturesTotal: 2,
    signaturesPlaced: 2,
    baseTransfersTotal: 2,
    baseTransfersTimed: 0,
    orderContradictions: 0,
    implausibleMeasurements: 0,
    unrepresentedAccessRequirements: 0,
    legsTotal: 8,
    legsTimed: 8,
  };

  it('asks a self-driven route for timed transfers and an operator-led one not to', () => {
    /* The same untimed transfers, judged by how much this kind of trip depends on them. */
    const roadTrip = readinessShortfalls({ archetype: undefined, completeness, transportCertaintyRequirement: 0.85 });
    const trek = readinessShortfalls({ archetype: undefined, completeness, transportCertaintyRequirement: 0.4 });
    expect(roadTrip.map((entry) => entry.requirement)).toContain('base_transfers_timed');
    expect(trek.map((entry) => entry.requirement)).not.toContain('base_transfers_timed');
  });

  it('keeps the V11 behaviour exactly when no operating model is supplied', () => {
    expect(readinessShortfalls({ archetype: 'road_trip', completeness }).map((entry) => entry.requirement)).toContain('base_transfers_timed');
    expect(readinessShortfalls({ archetype: 'guided_remote', completeness }).map((entry) => entry.requirement)).not.toContain('base_transfers_timed');
  });

  it('fails a trip that routes perfectly and misses the reason it exists', () => {
    const perfect = { ...completeness, baseTransfersTimed: 2 };
    expect(readinessShortfalls({ archetype: 'road_trip', completeness: perfect })).toHaveLength(0);
    const missingThePoint = readinessShortfalls({
      archetype: 'road_trip',
      completeness: perfect,
      unmetPrimaryGoals: ['Hiking: 1 day, where 2 would make it real.'],
    });
    expect(missingThePoint).toHaveLength(1);
    expect(missingThePoint[0]?.requirement).toBe('primary_intent');
    /* And it reads as the plan's failure, not as something the traveller must wait for. */
    expect(missingThePoint[0]?.detail).toMatch(/meant to be built around/);
  });
});
