import { describe, expect, it } from 'vitest';
import {
  MAX_RECOVERY_PASSES,
  recoveryAdjustment,
  repairsFor,
  assessResearchReadiness,
  type ReadinessInput,
} from './research-readiness';
import { geographicScopeSchema, shouldAttemptRecovery, type GeographicScope } from '@sidequest/core';

/**
 * THE LOOP'S SAFETY ARGUMENT, AS ASSERTIONS.
 *
 * Recovery is the part of readiness that spends something, so the properties
 * that keep it bounded are the ones worth pinning down. Every case here is a set
 * of numbers; none names a destination, and a rule that needed to know which
 * city it was looking at would have stopped measuring.
 */

function scopeFor(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'relation/1',
    destinationName: 'Testville',
    destinationEntityType: 'city',
    breadth: 'city',
    center: { lat: 40.7, lng: -74 },
    bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    timeZones: ['UTC'],
    shape: {
      kind: 'bounds',
      bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk'],
      carAvailable: true,
      acceptsWaterOrAirTransfers: true,
      basis: 'default',
      note: 'Test transport.',
    },
    maxBaseChanges: 0,
    nights: 4,
    rationale: 'A test scope.',
    confidence: { level: 'high', signals: [], note: 'Test.' },
    decidedBy: [],
    confirmedByUser: true,
    ...overrides,
  });
}

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    scope: scopeFor(),
    tripDays: 5,
    funnel: {
      packRecords: 4000,
      visitable: 0,
      anchors: 0,
      discoveries: 0,
      food: 41,
      support: 4,
      gateways: 0,
      anchorDemotions: 0,
      membershipUnverified: 45,
      tripDays: 5,
    },
    categories: 1,
    areasWithVisitable: 1,
    areasTotal: 12,
    largestAreaVisitable: 0,
    sourceCatalogues: 1,
    hoursKnown: 0,
    routing: { measuredPairs: 20, requiredPairs: 400 },
    unroutableModes: [],
    bases: 1,
    satellites: 0,
    identityAgrees: true,
    packPartial: false,
    ...overrides,
  };
}

describe('a food-dominated city packet', () => {
  it('is recoverable, and names repairs that address the deficit rather than any repair', () => {
    const readiness = assessResearchReadiness(input());
    expect(readiness.level).toBe('recoverable');
    expect(shouldAttemptRecovery(readiness)).toBe(true);
    // Directed: the binding deficits are supply/balance and spread, and those
    // are exactly the two repairs offered.
    expect(readiness.repairs).toEqual(
      expect.arrayContaining(['category_targeted_query', 'reread_underserved_areas']),
    );
    /*
     * Every repair offered traces to a deficit that is actually binding, and
     * nothing else is offered. Routeability is binding here too — twenty
     * measured pairs against four hundred needed — so a gateway search is a
     * legitimate directed repair for this packet and appears; identity is fine,
     * so identity repair does not.
     */
    expect(readiness.repairs).not.toContain('reresolve_identity');
    expect(readiness.repairs).not.toContain('refresh_stale_pack');
    for (const repair of readiness.repairs) {
      expect(repairsFor(readiness.binding, input())).toContain(repair);
    }
  });

  it('becomes ready once the second look actually finds things to do', () => {
    /**
     * The loop's whole purpose, expressed as the transition it is trying to
     * cause. The recovered numbers are what a widened per-category ceiling
     * produces over the same pack: the museums that were behind four hundred
     * plaques.
     */
    const recovered = assessResearchReadiness(
      input({
        funnel: {
          packRecords: 4000,
          visitable: 18,
          anchors: 9,
          discoveries: 9,
          food: 41,
          support: 4,
          gateways: 0,
          anchorDemotions: 0,
          membershipUnverified: 45,
          tripDays: 5,
        },
        categories: 6,
        areasWithVisitable: 5,
        hoursKnown: 7,
        routing: { measuredPairs: 400, requiredPairs: 306 },
      }),
    );
    expect(recovered.level).toBe('ready');
    expect(shouldAttemptRecovery(recovered)).toBe(false);
  });
});

describe('a multi-part destination that came back from one corner', () => {
  const pooled = input({
    scope: scopeFor({ breadth: 'country', destinationEntityType: 'country' }),
    funnel: {
      packRecords: 900,
      visitable: 11,
      anchors: 5,
      discoveries: 6,
      food: 6,
      support: 2,
      gateways: 1,
      anchorDemotions: 0,
      membershipUnverified: 1,
      tripDays: 6,
    },
    tripDays: 6,
    categories: 4,
    areasWithVisitable: 1,
    areasTotal: 9,
    hoursKnown: 5,
  });

  it('names the spread deficit and offers the repair that targets it', () => {
    const readiness = assessResearchReadiness(pooled);
    expect(readiness.binding).toContain('geographic_spread');
    expect(readiness.repairs).toContain('reread_underserved_areas');
  });

  it('clears once the second look spreads the selection out', () => {
    const spread = assessResearchReadiness({ ...pooled, areasWithVisitable: 4 });
    expect(spread.binding).not.toContain('geographic_spread');
  });
});

describe('the bounds on the loop', () => {
  it('offers at most two passes', () => {
    expect(MAX_RECOVERY_PASSES).toBe(2);
  });

  it('only ever widens a ceiling — never lowers a quality bar', () => {
    /**
     * The invariant that separates recovery from cheating. Every adjustment is a
     * limit on *how much* is kept, and each pass may only relax it; nothing here
     * can reach a quality gate, a containment verdict or a role permission.
     */
    for (let pass = 0; pass < MAX_RECOVERY_PASSES; pass += 1) {
      const category = recoveryAdjustment('category_targeted_query', pass)!;
      expect(category.maxPerCategory!).toBeGreaterThan(22);
      expect(category.maxAttractions!).toBeGreaterThan(140);

      const spread = recoveryAdjustment('reread_underserved_areas', pass)!;
      // A *lower* area share is a widening: no single area may hold as much.
      expect(spread.maxAreaShare!).toBeLessThan(0.45);
      expect(spread.maxAreaShare!).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('widens monotonically, so a second pass is never weaker than the first', () => {
    const first = recoveryAdjustment('category_targeted_query', 0)!;
    const second = recoveryAdjustment('category_targeted_query', 1)!;
    expect(second.maxPerCategory!).toBeGreaterThan(first.maxPerCategory!);
    expect(second.maxAttractions!).toBeGreaterThan(first.maxAttractions!);
  });

  it('refuses to execute a repair that needs provider work', () => {
    /**
     * The honest edge of a loop whose safety argument is that it spends nothing.
     * These three are real repairs and they are not free, so the loop declines
     * them rather than pretending — and `repairsFor` still names them, so a
     * traveller-facing surface can say what *would* help.
     */
    for (const repair of ['reresolve_identity', 'gateway_discovery', 'refresh_stale_pack'] as const) {
      expect(recoveryAdjustment(repair, 0)).toBeNull();
    }
  });
});

describe('a packet nothing can repair', () => {
  it('does not loop: it offers no executable repair and settles', () => {
    const unfixable = input({
      unroutableModes: ['ferry'],
      mustDo: { asked: 2, accounted: 0, needsTraveller: 0, retriable: false },
      funnel: {
        packRecords: 900,
        visitable: 14,
        anchors: 8,
        discoveries: 6,
        food: 6,
        support: 2,
        gateways: 1,
        anchorDemotions: 0,
        membershipUnverified: 0,
        tripDays: 5,
      },
      categories: 5,
      areasWithVisitable: 4,
      hoursKnown: 9,
    });
    const readiness = assessResearchReadiness(unfixable);
    expect(readiness.level).toBe('blocked');
    expect(shouldAttemptRecovery(readiness)).toBe(false);
    expect(readiness.repairs).toEqual([]);
  });

  it('a stale pack alone does not rescue an unfixable packet into recoverable', () => {
    /**
     * The guard on the guard. `refresh_stale_pack` used to be pushed on
     * `packPartial` regardless of what was binding, which routed around the
     * deliberate refusal to offer `gateway_discovery` for an unmeasurable mode —
     * so a trip blocked on a ferry reported itself recoverable.
     */
    const readiness = assessResearchReadiness(
      input({
        packPartial: true,
        unroutableModes: ['ferry'],
        funnel: {
          packRecords: 900,
          visitable: 14,
          anchors: 8,
          discoveries: 6,
          food: 6,
          support: 2,
          gateways: 1,
          anchorDemotions: 0,
          membershipUnverified: 0,
          tripDays: 5,
        },
        categories: 5,
        areasWithVisitable: 4,
        hoursKnown: 9,
      }),
    );
    expect(readiness.repairs).not.toContain('refresh_stale_pack');
    expect(readiness.level).toBe('blocked');
  });
});

describe('repair selection is deficit-directed', () => {
  it('offers nothing when nothing is binding', () => {
    expect(repairsFor([], input())).toEqual([]);
  });

  it('does not offer a gateway search for a mode no provider can measure', () => {
    expect(
      repairsFor(['transport_routeability'], input({ unroutableModes: ['rail'] })),
    ).not.toContain('gateway_discovery');
  });

  it('does offer a gateway search when the gap is a missing station, not a missing mode', () => {
    expect(repairsFor(['transport_routeability'], input({ unroutableModes: [] }))).toContain(
      'gateway_discovery',
    );
  });
});
