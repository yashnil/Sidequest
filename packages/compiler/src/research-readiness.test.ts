import { describe, expect, it } from 'vitest';
import {
  geographicScopeSchema,
  mayShowDiscoveryBoard,
  type DestinationCandidate,
  type GeographicScope,
  type ScopeBreadth,
} from '@sidequest/core';
import {
  assessResearchReadiness,
  unmeasurableModesFor,
  type ReadinessInput,
} from './research-readiness';
import { deriveScope } from './scope';

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
    identity: { placedInside: 160, refutedElsewhere: 40 },
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
    mustDo: { asked: 2, accounted: 0, needsTraveller: 0, retriable: false },
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
     * The same packet, plus an identity disagreement — every record we could
     * place is published in another country or region, and not one of them
     * inside. Identity *is* repairable, so the loop has somewhere to go and the
     * board is not withheld yet.
     */
    const readiness = assessResearchReadiness({
      ...unfixable,
      identity: { placedInside: 0, refutedElsewhere: 130 },
    });
    expect(readiness.repairs).toContain('reresolve_identity');
    expect(readiness.level).toBe('recoverable');
  });
});

/**
 * ACCUSING OUR OWN RESEARCH OF FINDING THE WRONG PLACE.
 *
 * Evidence class for every case below: **three finished, correctly-resolved city
 * builds — two dense metros and one European capital — opened their readiness
 * panel with "What we found does not look like the place you asked for", above
 * copy promising "we are going back for more".** The destination had resolved
 * correctly and the compiled region genuinely corresponded to it, so the first
 * sentence the traveller read was false and alarming.
 *
 * The condition was `insideSelected >= membershipDecided / 2`, computed at the
 * seam: a majority share of every record the containment overlay judged. That
 * population is the whole pack, and a pack is bought over a box drawn round the
 * traveller's reach — so a dense metro legitimately reads far more records that
 * a source publishes in the regions next door than records inside the city
 * itself, containment refuses every one of them correctly, and the correct
 * refusals then outvote the positives. Nothing in that arithmetic is about
 * identity; the better containment worked, the likelier the accusation.
 *
 * The numbers in each fixture are the shape of that read, not a destination.
 */
describe('a correctly-resolved destination is never accused of being somewhere else', () => {
  it('does not raise a mismatch for a dense destination with thin coverage in one category', () => {
    /*
     * The live regression. A wide read round a dense metro, one thin category —
     * the reviewer's hypothesis was that the claim was being inferred from
     * exactly this — and a resolution that is entirely correct: a hundred and
     * eighty records are published inside the destination itself.
     */
    const denseMetro = input({
      categories: 1,
      identity: { placedInside: 180, refutedElsewhere: 2_600 },
    });
    const readiness = assessResearchReadiness(denseMetro);
    const identity = readiness.dimensions.find(
      (entry) => entry.dimension === 'identity_agreement',
    )!;

    /* The old condition: 180 >= 2780/2 is false, so this used to be `unmet`. */
    expect(identity.state).toBe('met');
    expect(readiness.binding).not.toContain('identity_agreement');
    expect(readiness.repairs).not.toContain('reresolve_identity');
    /* Not merely un-bound: the sentence itself must not be on the report. */
    for (const entry of readiness.dimensions) {
      expect(entry.detail).not.toMatch(/does not look like the place/i);
    }
    /* And it is not what the traveller reads first. */
    expect(readiness.summary).not.toMatch(/does not look like the place/i);
  });

  it('does not raise a mismatch for a correctly-resolved broad region either', () => {
    /*
     * The same arithmetic with a different cause: a region trip whose ground
     * reaches over its own borders, so most of what the overlay places is
     * published in the neighbouring country or region and is refused there.
     * Fifty-five records inside a region is a correct resolution, not a wrong
     * one.
     */
    const broadRegion = input({
      scope: scopeFor({ breadth: 'region', destinationEntityType: 'state_or_province' }),
      identity: { placedInside: 55, refutedElsewhere: 420 },
    });
    const readiness = assessResearchReadiness(broadRegion);

    expect(
      readiness.dimensions.find((entry) => entry.dimension === 'identity_agreement')!.state,
    ).toBe('met');
    expect(readiness.binding).not.toContain('identity_agreement');
  });

  it('still reports a resolution that landed on a same-named place somewhere else', () => {
    /*
     * The case the warning exists for, and the reason it is tightened rather
     * than deleted. The instrument answered on two hundred and ten records and
     * every single one of them is published in a different country or region:
     * that is not a proportion, it is the shape of a destination resolved to the
     * wrong entity. Same rule the coverage report already grades its geography
     * row on — placed, and not one of them inside.
     */
    const wrongPlace = input({ identity: { placedInside: 0, refutedElsewhere: 210 } });
    const readiness = assessResearchReadiness(wrongPlace);
    const identity = readiness.dimensions.find(
      (entry) => entry.dimension === 'identity_agreement',
    )!;

    expect(identity.state).toBe('unmet');
    expect(identity.detail).toMatch(/210/);
    expect(identity.detail).toMatch(/different country or region/i);
    expect(readiness.binding).toContain('identity_agreement');
    expect(readiness.repairs).toContain('reresolve_identity');
  });

  it('withdraws the claim on a single record published inside the destination', () => {
    /*
     * The asymmetry that keeps the claim honest. A positive placement is a
     * source's own statement that this record is in the destination, and no
     * share of anything can overrule one — so two hundred and ten refusals
     * beside one positive is a wide read, not a wrong place.
     */
    const oneInside = input({ identity: { placedInside: 1, refutedElsewhere: 210 } });
    expect(
      assessResearchReadiness(oneInside).dimensions.find(
        (entry) => entry.dimension === 'identity_agreement',
      )!.state,
    ).toBe('met');
  });

  it('says nothing at all when nobody could place anything', () => {
    /*
     * Unknowns are not evidence about identity in either direction. A directory
     * too thin to place a single record is a hole in our instrument, and it must
     * not read as a verdict about somebody's destination.
     */
    const nothingPlaced = input({ identity: { placedInside: 0, refutedElsewhere: 0 } });
    const readiness = assessResearchReadiness(nothingPlaced);
    expect(
      readiness.dimensions.find((entry) => entry.dimension === 'identity_agreement')!.state,
    ).toBe('unmeasured');
    expect(readiness.binding).not.toContain('identity_agreement');
  });

  it('says what actually happened instead — that we read wider than the destination', () => {
    /*
     * The share the mis-firing condition was really measuring, kept and stated
     * as itself. It belongs to how well sourced the board is, not to which place
     * we searched, and it carries both numbers so a traveller can see that a
     * short board came out of a wide read and ask for the nearby areas rather
     * than being told their destination is wrong.
     *
     * Advisory on purpose: reading wider than the destination is the ordinary
     * condition of a dense metro and must not move the level, which is precisely
     * what the old rule did — to `recoverable`, and then towards `blocked` once
     * the repair it offered had been spent.
     */
    const denseMetro = input({ identity: { placedInside: 180, refutedElsewhere: 2_600 } });
    const readiness = assessResearchReadiness(denseMetro);
    const sourcing = readiness.dimensions.find(
      (entry) => entry.dimension === 'source_confidence',
    )!;

    expect(sourcing.state).toBe('partial');
    expect(sourcing.required).toBe(false);
    expect(sourcing.detail).toMatch(/read wider than the destination/i);
    expect(sourcing.detail).toMatch(/2600|2,600/);
    expect(sourcing.detail).toMatch(/180/);
    /* It describes the read; it never claims we searched the wrong place. */
    expect(sourcing.detail).not.toMatch(/wrong|does not look like/i);
    /* And an advisory partial leaves a good board alone. */
    expect(readiness.level).toBe('ready');
    expect(readiness.binding).toEqual([]);
  });
});

describe('the shape of the report', () => {
  it('never writes a zero for something it did not measure', () => {
    const unmeasured = assessResearchReadiness(
      input({ identity: undefined, destinationCoverage: undefined, routing: undefined }),
    );
    for (const dimension of unmeasured.dimensions) {
      if (dimension.state === 'unmeasured') expect(dimension.observed).toBeUndefined();
    }
  });

  it('does not count an unmeasured dimension as a failure', () => {
    const unmeasured = assessResearchReadiness(
      input({ identity: undefined, destinationCoverage: undefined }),
    );
    expect(unmeasured.binding).not.toContain('identity_agreement');
    expect(unmeasured.binding).not.toContain('destination_coverage');
  });

  it('is deterministic', () => {
    expect(assessResearchReadiness(input())).toEqual(assessResearchReadiness(input()));
  });
});

/**
 * THE DEFICIT THAT COULD NOT FIRE.
 *
 * `unmeasurableModesFor` exists to turn one specific gap into a named readiness
 * deficit: this trip depends on a train or a bus, and nothing configured can
 * measure one. It could not do it. The test was `reachRadiusKm <=
 * WALKABLE_REACH_KM` with `WALKABLE_REACH_KM = 12`, and twelve is
 * `RADIUS_KM_BY_MODE.walk.cap` in `scope.ts` — the ceiling `deriveScope` clamps
 * a car-free trip's reach to, at all three places it can be set. So the left
 * side of that comparison is ≤ 12 by construction, the walker always "covered
 * it", and with no transit provider configured — every deployment today — the
 * scheduled-mode branch was unreachable.
 *
 * These cases drive the real `deriveScope`, because the defect is a property of
 * the chain rather than of either end: a hand-written scope with a 60 km
 * car-free reach would have reported the deficit under the old rule and proved
 * nothing about anything the product can produce.
 */
describe('a trip that depends on a mode nothing can measure', () => {
  const ROAD_ONLY = { routing: { supportedModes: () => ['car', 'foot'] } };
  const WITH_TRANSIT = {
    routing: { supportedModes: () => ['car', 'foot'] },
    transit: { supportsTransit: () => true },
  };

  function candidateFor(breadth: ScopeBreadth, entityType: DestinationCandidate['entityType']) {
    return {
      id: 'relation/900001',
      displayName: 'Twin Isles',
      entityType,
      breadth,
      center: { lat: 0.2, lng: 6.6 },
      qualifiedName: 'Twin Isles',
      countryCode: 'ZQ',
      aliases: [],
      administrativeAreas: [],
      timeZones: ['UTC'],
      confidence: { level: 'high' as const, signals: [], note: 'Test.' },
      providerRefs: [],
    } as unknown as DestinationCandidate;
  }

  function scopeOf(
    breadth: ScopeBreadth,
    entityType: DestinationCandidate['entityType'],
    transport: string | undefined,
    nights = 4,
  ) {
    return deriveScope({
      candidate: candidateFor(breadth, entityType),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights,
      revision: 1,
      ...(transport ? { composerTransport: transport } : {}),
    });
  }

  it('reports the missing journey planner for a car-free trip across a destination bigger than a walk', () => {
    const scope = scopeOf('subregion', 'archipelago', 'public_transport');
    /*
     * The two facts that made the old rule vacuous, asserted so this case fails
     * loudly rather than silently if either ever changes: the traveller said no
     * car, and their recorded reach is pinned at the walking cap.
     */
    expect(scope.transport.carAvailable).toBe(false);
    expect(scope.reachRadiusKm).toBe(12);

    const missing = unmeasurableModesFor(scope, ROAD_ONLY);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('rail');
    expect(missing).toContain('public_bus');
    /* Never walking: a walker is not missing a provider, they are walking. */
    expect(missing).not.toContain('walk');
  });

  it('cannot be satisfied by any trip length, which is what made the old rule vacuous', () => {
    /*
     * The reach is clamped at the walking cap from two nights upward, so under
     * `reachRadiusKm <= 12` there is no trip length at which the deficit could
     * fire. The property has to hold across the range, not at one fixture.
     */
    for (const nights of [1, 2, 3, 4, 7, 14]) {
      const scope = scopeOf('subregion', 'archipelago', 'public_transport', nights);
      expect(scope.reachRadiusKm ?? 0, `nights=${nights}`).toBeLessThanOrEqual(12);
      expect(unmeasurableModesFor(scope, ROAD_ONLY).length, `nights=${nights}`).toBeGreaterThan(0);
    }
  });

  it('says it in words a traveller reads rather than in mode identifiers', () => {
    /*
     * The sentence had no readers while the deficit could not fire, and it
     * pasted the internal ids straight into traveller copy: "This trip needs
     * ferry or public_bus or rail or shuttle". Making the deficit reachable
     * makes this a screen somebody sees.
     */
    const scope = scopeOf('subregion', 'archipelago', 'public_transport');
    const readiness = assessResearchReadiness(
      input({ scope, unroutableModes: unmeasurableModesFor(scope, ROAD_ONLY) }),
    );
    const routeability = readiness.dimensions.find(
      (entry) => entry.dimension === 'transport_routeability',
    );
    expect(routeability?.state).toBe('unmet');
    expect(routeability!.detail).toMatch(/no way to measure/i);
    /* No identifier: nothing in this sentence is an underscore-joined enum. */
    expect(routeability!.detail).not.toMatch(/[a-z]+_[a-z]+/);
    expect(routeability!.detail).toMatch(/trains/);
    expect(routeability!.detail).toMatch(/buses/);
  });

  it('stops reporting it the moment something can measure a transit journey', () => {
    const scope = scopeOf('subregion', 'archipelago', 'public_transport');
    expect(unmeasurableModesFor(scope, WITH_TRANSIT)).toEqual([]);
  });

  it('does not call a walking city break a transport gap', () => {
    /*
     * The other half, and the reason this is a ground-against-reach test rather
     * than a blanket "car-free needs a train". A city is compiled to what the
     * traveller can cross, so the ground and the reach are the same number and
     * there is nothing they cannot get to on foot.
     */
    const scope = scopeOf('city', 'city', 'public_transport');
    expect(scope.transport.carAvailable).toBe(false);
    expect(unmeasurableModesFor(scope, ROAD_ONLY)).toEqual([]);
  });

  it('says nothing about a traveller who has not been asked about a car', () => {
    /*
     * `carAvailable: null` is a third state and not a quiet `false`. Telling
     * somebody who may be hiring a car that their trip needs a train we cannot
     * measure is a guess, and it arrives as `blocked` — the Discovery Board
     * withheld, with no repair offered.
     */
    const scope = scopeOf('subregion', 'archipelago', undefined);
    expect(scope.transport.carAvailable).toBeNull();
    expect(unmeasurableModesFor(scope, ROAD_ONLY)).toEqual([]);
  });

  it('says nothing to a driver', () => {
    const scope = scopeOf('subregion', 'archipelago', 'drive');
    expect(scope.transport.carAvailable).toBe(true);
    expect(unmeasurableModesFor(scope, ROAD_ONLY)).toEqual([]);
  });
});
