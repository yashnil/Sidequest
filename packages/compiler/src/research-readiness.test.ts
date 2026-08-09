import { describe, expect, it } from 'vitest';
import { geographicScopeSchema, mayShowDiscoveryBoard, type GeographicScope } from '@sidequest/core';
import { assessResearchReadiness, type ReadinessInput } from './research-readiness';

/**
 * The readiness contract, exercised against the two shapes that motivated it and
 * against the shapes it must not break.
 *
 * Every case below is a *set* of numbers, not a destination. That is deliberate
 * and it is the point of the whole layer: readiness is a property of what came
 * back, and a rule that needed to know which city it was looking at would be a
 * rule that had stopped measuring.
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
    tripDays: 4,
    funnel: {
      packRecords: 200,
      visitable: 14,
      anchors: 8,
      discoveries: 6,
      food: 12,
      support: 4,
      gateways: 2,
      anchorDemotions: 0,
      membershipUnverified: 0,
      tripDays: 4,
    },
    categories: 5,
    areasWithVisitable: 4,
    areasTotal: 6,
    largestAreaVisitable: 5,
    sourceCatalogues: 2,
    hoursKnown: 10,
    routing: { measuredPairs: 180, requiredPairs: 180 },
    unroutableModes: [],
    bases: 1,
    satellites: 2,
    destinationCoverage: 1,
    identityAgrees: true,
    packPartial: false,
    ...overrides,
  };
}

describe('a healthy packet', () => {
  it('is ready, with nothing binding', () => {
    const readiness = assessResearchReadiness(input());
    expect(readiness.level).toBe('ready');
    expect(readiness.binding).toEqual([]);
    expect(mayShowDiscoveryBoard(readiness)).toBe(true);
  });

  it('names a number and never names a destination', () => {
    const readiness = assessResearchReadiness(input());
    expect(readiness.summary).toMatch(/\d/);
    // The neutrality convention the rest of the engine already holds to.
    expect(readiness.summary).not.toMatch(/[A-Z][a-z]+,\s[A-Z]/);
  });
});

describe('the metropolis that came back as a food pocket', () => {
  /**
   * The Tokyo shape, as numbers: forty-five records, all of them somewhere to
   * eat or a practical stop, all in one corner of a ground divided into many.
   * Nothing here says which city it is, and nothing needs to.
   */
  const foodPocket = input({
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
    tripDays: 5,
    categories: 1,
    areasWithVisitable: 1,
    areasTotal: 12,
    largestAreaVisitable: 0,
    sourceCatalogues: 1,
    hoursKnown: 0,
    routing: { measuredPairs: 20, requiredPairs: 400 },
  });

  it('is never ready', () => {
    expect(assessResearchReadiness(foodPocket).level).not.toBe('ready');
  });

  it('says the reason is that everything is somewhere to eat', () => {
    const readiness = assessResearchReadiness(foodPocket);
    expect(readiness.binding).toContain('support_balance');
    const balance = readiness.dimensions.find((entry) => entry.dimension === 'support_balance')!;
    expect(balance.state).toBe('unmet');
    expect(balance.detail).toMatch(/nothing is a thing to do/);
  });

  it('also notices that it is all in one corner', () => {
    expect(assessResearchReadiness(foodPocket).binding).toContain('geographic_spread');
  });

  it('is recoverable, and knows which repairs to try', () => {
    const readiness = assessResearchReadiness(foodPocket);
    expect(readiness.level).toBe('recoverable');
    expect(readiness.repairs).toContain('category_targeted_query');
    expect(readiness.repairs).toContain('reread_underserved_areas');
  });
});

describe('a genuinely quiet destination', () => {
  /**
   * The counter-case, and the one a universal quota would get wrong. Nine
   * things to do across a small island, few opening hours, one source. That is
   * not a broken packet; it is a quiet place, and a traveller can have a real
   * trip there.
   */
  const quiet = input({
    scope: scopeFor({ breadth: 'subregion', destinationEntityType: 'subregion' }),
    tripDays: 4,
    funnel: {
      packRecords: 90,
      visitable: 9,
      anchors: 3,
      discoveries: 6,
      food: 3,
      support: 1,
      gateways: 1,
      anchorDemotions: 0,
      membershipUnverified: 0,
      tripDays: 4,
    },
    categories: 4,
    areasWithVisitable: 2,
    areasTotal: 3,
    largestAreaVisitable: 5,
    sourceCatalogues: 1,
    hoursKnown: 3,
  });

  it('is usable rather than blocked', () => {
    const readiness = assessResearchReadiness(quiet);
    expect(['ready', 'thin']).toContain(readiness.level);
    expect(mayShowDiscoveryBoard(readiness)).toBe(true);
  });

  it('has nothing binding — a quiet place is not a failed one', () => {
    expect(assessResearchReadiness(quiet).binding).toEqual([]);
  });
});

describe('a destination whose second part we never reached', () => {
  /**
   * The São Tomé shape: real content on one landmass, none on the other, and no
   * way to measure the crossing. The scope fix stops the extent being clipped
   * away; this is the layer that notices when the ground was covered and the
   * far side still came back empty.
   */
  const halfCovered = input({
    scope: scopeFor({ breadth: 'country', destinationEntityType: 'country', maxBaseChanges: 1 }),
    destinationCoverage: 0.42,
    unroutableModes: ['ferry'],
    funnel: {
      packRecords: 140,
      visitable: 11,
      anchors: 4,
      discoveries: 7,
      food: 5,
      support: 2,
      gateways: 1,
      anchorDemotions: 0,
      membershipUnverified: 2,
      tripDays: 6,
    },
    tripDays: 6,
    areasWithVisitable: 1,
    areasTotal: 4,
    bases: 1,
    satellites: 0,
  });

  it('reports the uncovered part of the destination', () => {
    const readiness = assessResearchReadiness(halfCovered);
    const coverage = readiness.dimensions.find((entry) => entry.dimension === 'destination_coverage')!;
    expect(coverage.state).toBe('unmet');
    expect(coverage.detail).toMatch(/42%/);
    expect(readiness.binding).toContain('destination_coverage');
  });

  it('reports the crossing it cannot measure', () => {
    const readiness = assessResearchReadiness(halfCovered);
    const transport = readiness.dimensions.find(
      (entry) => entry.dimension === 'transport_routeability',
    )!;
    expect(transport.state).toBe('unmet');
    expect(transport.detail).toMatch(/ferry/);
  });

  it('does not offer to find a gateway for a mode no provider can measure', () => {
    /**
     * The distinction that keeps recovery honest. A missing *station* is
     * findable. A missing *mode* is not, and offering to look for one would be
     * a repair that cannot succeed — which is how a bounded loop turns into a
     * budget leak.
     */
    expect(assessResearchReadiness(halfCovered).repairs).not.toContain('gateway_discovery');
  });
});

describe('when nothing can be done', () => {
  /**
   * The only way to reach `blocked` is a required deficit that no bounded repair
   * addresses — which is a narrower set than it sounds, and deliberately so. A
   * board is withheld only when looking again would not help, because withholding
   * is the most expensive thing this layer can do to a traveller.
   *
   * Here: the supply is fine, the ground is covered, but the trip's only way
   * between its parts is a mode no configured provider can measure, and the
   * traveller named places that are not in what we found. Neither a category
   * query nor a re-read produces a ferry timetable or invents a named place.
   */
  const unfixable = input({
    unroutableModes: ['ferry'],
    mustDo: { found: 0, asked: 2 },
  });

  it('offers no repair for a deficit no repair addresses', () => {
    const readiness = assessResearchReadiness(unfixable);
    expect(readiness.binding).toContain('transport_routeability');
    expect(readiness.binding).toContain('must_do_coverage');
    expect(readiness.repairs).toEqual([]);
  });

  it('blocks rather than shipping a confident bad board', () => {
    const readiness = assessResearchReadiness(unfixable);
    expect(readiness.level).toBe('blocked');
    expect(mayShowDiscoveryBoard(readiness)).toBe(false);
  });

  it('is recoverable while something repairable is still outstanding', () => {
    /**
     * The same packet, plus an identity disagreement. Identity *is* repairable,
     * so the loop has somewhere to go and the board is not withheld yet.
     */
    const readiness = assessResearchReadiness({ ...unfixable, identityAgrees: false });
    expect(readiness.repairs).toContain('reresolve_identity');
    expect(readiness.level).toBe('recoverable');
  });
});

describe('the shape of the report', () => {
  it('never writes a zero for something it did not measure', () => {
    const unmeasured = assessResearchReadiness(
      input({ identityAgrees: undefined, destinationCoverage: undefined, routing: undefined }),
    );
    for (const dimension of unmeasured.dimensions) {
      if (dimension.state === 'unmeasured') expect(dimension.observed).toBeUndefined();
    }
  });

  it('does not count an unmeasured dimension as a failure', () => {
    const unmeasured = assessResearchReadiness(
      input({ identityAgrees: undefined, destinationCoverage: undefined }),
    );
    expect(unmeasured.binding).not.toContain('identity_agreement');
    expect(unmeasured.binding).not.toContain('destination_coverage');
  });

  it('is deterministic', () => {
    expect(assessResearchReadiness(input())).toEqual(assessResearchReadiness(input()));
  });
});
