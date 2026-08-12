import { describe, expect, it } from 'vitest';
import {
  chooseBaseStructure,
  daysWorthOf,
  dayReachMinutes,
  estimateTransferMinutes,
  reachRadiusForStructure,
  travelRegionGraph,
  DAY_REACH_KM,
  type GraphClusterInput,
} from './graph';
import { buildRegionPortfolio } from '../scope/portfolio';
import type { DestinationIndexEntry } from '../schemas/destination-index';

/**
 * THE FOUNDER-TEST REGRESSION, AS A CLASS RATHER THAN AS A DESTINATION.
 *
 * What was seen: a six-night city trip whose regional preview proposed a second
 * base in a prominent settlement about a hundred kilometres out, while the next
 * screen described the same build as roughly a dozen kilometres across. Nothing
 * on either screen said what the move bought.
 *
 * Nothing below names that city, that country or that traveller. The pattern is
 * *one dense cluster plus one prominent distant one, on a trip short enough
 * that the dense one already fills it* — which is a shape, not a place, and the
 * shape is what the fixtures build.
 */

function cluster(
  id: string,
  name: string,
  lat: number,
  lng: number,
  over: Partial<GraphClusterInput> = {},
): GraphClusterInput {
  return {
    id,
    name,
    center: { lat, lng },
    memberCount: 1,
    weight: 4,
    memberNames: [],
    ...over,
  };
}

/**
 * A dense core and a prominent settlement far outside it.
 *
 * The second is deliberately *worth going to* — high weight, several members —
 * so the test cannot pass by rejecting thin places. It has to reject it for the
 * right reason: the trip has no days left for it.
 */
const DENSE_CORE = cluster('core', 'Core', 35.68, 139.76, {
  memberCount: 22,
  weight: 46,
  memberNames: ['One', 'Two', 'Three'],
});
const DISTANT_PROMINENT = cluster('far', 'Far', 36.56, 139.88, {
  memberCount: 6,
  weight: 18,
  memberNames: ['Four', 'Five'],
});

describe('a second base has to earn itself', () => {
  it('refuses a distant base when the core already fills the trip, and says why', () => {
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, DISTANT_PROMINENT],
      reach: 'transit',
      nights: 6,
      maxBaseChanges: null,
    });

    expect(structure.bases).toHaveLength(1);
    expect(structure.bases[0]!.cluster.id).toBe('core');

    const refusal = structure.rejected.find((entry) => entry.cluster.id === 'far');
    expect(refusal).toBeDefined();
    expect(refusal!.rejection).toBe('trip_already_full');
    /*
     * The reason has to name the numbers a traveller can check, not merely
     * exist. A rejection reason nobody can audit is the same defect wearing a
     * sentence.
     */
    expect(refusal!.reason).toContain('6 nights');
    expect(refusal!.reason).toContain('Core');
  });

  it('accepts the same distant base once the trip is long enough to hold it', () => {
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, DISTANT_PROMINENT],
      reach: 'transit',
      nights: 14,
      maxBaseChanges: null,
    });

    expect(structure.bases.map((base) => base.cluster.id)).toEqual(['core', 'far']);
    /*
     * And it explains itself in terms of travel saved — which is the whole of
     * what a base change is for.
     */
    expect(structure.bases[1]!.reason).toContain('too far to day-trip');
    expect(structure.bases[1]!.reason).toContain('saves');
  });

  it('makes a reachable cluster a satellite rather than a second base, whatever its size', () => {
    /* Big enough to out-rank the core, close enough to go and come back. */
    const near = cluster('near', 'Near', 35.9, 139.9, { memberCount: 12, weight: 40 });
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, near],
      reach: 'drive',
      nights: 14,
      maxBaseChanges: null,
    });

    expect(structure.bases).toHaveLength(1);
    expect(structure.bases[0]!.satellites.map((entry) => entry.cluster.id)).toEqual(['near']);
    expect(structure.rejected).toHaveLength(0);
  });

  it('honours a stated ceiling on hotel changes before anything else', () => {
    const third = cluster('third', 'Third', 37.4, 140.4, { memberCount: 5, weight: 16 });
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, DISTANT_PROMINENT, third],
      reach: 'drive',
      nights: 21,
      maxBaseChanges: 1,
    });

    expect(structure.bases).toHaveLength(2);
    const refused = structure.rejected.find((entry) => entry.cluster.id === 'third');
    expect(refused?.rejection).toBe('hotel_moves_exhausted');
    expect(refused?.reason).toContain('rather not move');
  });

  it('never proposes a base without a reason', () => {
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, DISTANT_PROMINENT],
      reach: 'drive',
      nights: 12,
      maxBaseChanges: null,
    });
    for (const base of structure.bases) {
      expect(base.reason.length).toBeGreaterThan(20);
    }
  });

  it('is deterministic, and the satellite pass does not depend on arrival order', () => {
    /*
     * This asserted that a pure function is pure: it passed the *same* array to
     * both calls and compared the results. The property worth having is that
     * the *satellite* second pass — which runs after the loop and can attach a
     * cluster to a base chosen later — does not depend on which order equally
     * reachable clusters arrived in.
     */
    const near = cluster('near', 'Near', 35.9, 139.9, { memberCount: 4, weight: 12 });
    const alsoNear = cluster('also', 'Also Near', 35.88, 139.85, { memberCount: 4, weight: 12 });
    const forwards = chooseBaseStructure({
      clusters: [DENSE_CORE, near, alsoNear],
      reach: 'drive',
      nights: 12,
      maxBaseChanges: null,
    });
    const backwards = chooseBaseStructure({
      clusters: [DENSE_CORE, alsoNear, near],
      reach: 'drive',
      nights: 12,
      maxBaseChanges: null,
    });
    expect(forwards.bases.map((base) => base.cluster.id)).toEqual(
      backwards.bases.map((base) => base.cluster.id),
    );
    /* Same satellites, as a set, whichever order they arrived in. */
    const satellitesOf = (structure: typeof forwards) =>
      structure.bases.flatMap((base) => base.satellites.map((entry) => entry.cluster.id)).sort();
    expect(satellitesOf(forwards)).toEqual(satellitesOf(backwards));
  });

  it('refuses a move that costs more travel than it saves', () => {
    /*
     * The gate that could never fire. `travelSaved` was `nights * 2 * minutes`
     * — the round trips avoided if you day-tripped there every night — which
     * contradicts the test immediately above it having just established the
     * cluster is *not* day-trippable, and reduced the condition to `m > 30`
     * when control only reaches it above the day reach.
     *
     * One out-and-back is the honest comparison, so the gate now bites below
     * about ninety minutes: a cluster just past the day-trip line is a place
     * you visit, not a place you move your luggage to.
     */
    /* ~50 km north: 75 minutes at the transit speed, just past the 60-minute day reach. */
    const justPastDayTrip = cluster('hop', 'Short Hop', 36.13, 139.76, {
      memberCount: 5,
      weight: 16,
    });
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, justPastDayTrip],
      reach: 'transit',
      nights: 14,
      maxBaseChanges: null,
    });
    expect(structure.bases).toHaveLength(1);
    const refusal = structure.rejected.find((entry) => entry.cluster.id === 'hop');
    expect(refusal?.rejection).toBe('move_costs_more_than_it_saves');
    expect(refusal?.reason).toContain('not worth the change of hotel');
  });

  it('does not punish a second region for having more to do in it', () => {
    /*
     * Non-monotonicity, as a test. Admission used to be tested against
     * `min(clusterDays, daysRemaining)`, so a ten-night trip whose core
     * committed seven days *rejected* a rich second region and *accepted* a
     * thin one. The more there was to do somewhere, the more likely it was
     * excluded — which is the opposite of the intent and impossible to explain.
     */
    const thin = cluster('thin', 'Thin', 36.9, 140.2, { memberCount: 3, weight: 8 });
    const rich = cluster('rich', 'Rich', 36.9, 140.2, { memberCount: 14, weight: 30 });

    const withThin = chooseBaseStructure({
      clusters: [DENSE_CORE, thin],
      reach: 'drive',
      nights: 10,
      maxBaseChanges: null,
    });
    const withRich = chooseBaseStructure({
      clusters: [DENSE_CORE, rich],
      reach: 'drive',
      nights: 10,
      maxBaseChanges: null,
    });
    expect(withThin.bases).toHaveLength(2);
    expect(withRich.bases).toHaveLength(2);
  });
});

describe('the reach a structure implies', () => {
  it('is the day reach when there is one base and nothing beyond it', () => {
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE],
      reach: 'walk',
      nights: 4,
      maxBaseChanges: null,
    });
    expect(reachRadiusForStructure(structure)).toBe(12);
  });

  it('grows to hold every base the structure actually chose', () => {
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, DISTANT_PROMINENT],
      reach: 'drive',
      nights: 14,
      maxBaseChanges: null,
    });
    expect(structure.bases).toHaveLength(2);
    expect(reachRadiusForStructure(structure)).toBeGreaterThan(100);
  });
});

/**
 * THE TWO SCREENS AGREE, BY CONSTRUCTION.
 *
 * The preview and the build used to derive their own geography from different
 * tables. This asserts the hand-off exists: the portfolio a traveller is shown
 * carries the reach the compilation is meant to use, and that number covers
 * every base the preview drew.
 */
describe('preview and build cannot describe different-sized trips', () => {
  function feature(
    id: string,
    name: string,
    lat: number,
    lng: number,
    over: Partial<DestinationIndexEntry> = {},
  ): DestinationIndexEntry {
    return {
      id,
      catalog: 'test',
      sourceId: id,
      featureType: 'city',
      displayName: name,
      aliases: [],
      hierarchy: [],
      center: { lat, lng },
      population: 40_000,
      ...over,
    };
  }

  it('carries a reach that covers every base it proposes', () => {
    const portfolio = buildRegionPortfolio({
      entries: [
        feature('m', 'Metro', 35.68, 139.76, { population: 9_000_000, prominence: 96 }),
        feature('m2', 'Inner', 35.7, 139.78, { population: 400_000 }),
        feature('m3', 'Inner Two', 35.66, 139.7, { population: 300_000 }),
        feature('far', 'Far', 36.56, 139.88, { population: 500_000, prominence: 70 }),
      ],
      mode: 'drive',
      nights: 16,
      destinationName: 'Testland',
    });

    /*
     * More than one base, asserted before the loop below — which compares each
     * base's distance from the first and is therefore vacuous on a single-base
     * portfolio, where the only distance measured is a point from itself.
     */
    expect(portfolio.route.length).toBeGreaterThan(1);
    expect(portfolio.baseReasons).toHaveLength(portfolio.route.length);
    for (const entry of portfolio.baseReasons) expect(entry.reason.length).toBeGreaterThan(10);

    /* Every proposed base is inside the reach the portfolio publishes. */
    const anchor = portfolio.route[0]!.center;
    for (const base of portfolio.route) {
      const km = Math.hypot(
        (base.center.lat - anchor.lat) * 111,
        (base.center.lng - anchor.lng) * 111 * Math.cos((anchor.lat * Math.PI) / 180),
      );
      expect(km).toBeLessThanOrEqual(portfolio.reachRadiusKm);
    }
  });

  it('short trips do not acquire distant bases the preview cannot justify', () => {
    const portfolio = buildRegionPortfolio({
      entries: [
        feature('m', 'Metro', 35.68, 139.76, { population: 9_000_000, prominence: 96 }),
        feature('m2', 'Inner', 35.7, 139.78, { population: 400_000 }),
        feature('m3', 'Inner Two', 35.66, 139.7, { population: 300_000 }),
        feature('m4', 'Inner Three', 35.72, 139.72, { population: 250_000 }),
        feature('far', 'Far', 36.56, 139.88, { population: 500_000, prominence: 70 }),
      ],
      mode: 'transit',
      nights: 6,
      destinationName: 'Testland',
    });

    expect(portfolio.basesProposed).toBe(1);
    expect(portfolio.excluded.some((entry) => entry.cluster.name === 'Far')).toBe(true);
    /* And the reach stays the reach of one base, not of a hundred-kilometre hop. */
    expect(portfolio.reachRadiusKm).toBeLessThan(100);
  });
});

describe('the graph is the same decision, drawn', () => {
  it('marks bases, satellites and exclusions distinctly and links them with typed edges', () => {
    const near = cluster('near', 'Near', 35.9, 139.9, { memberCount: 4, weight: 12 });
    const structure = chooseBaseStructure({
      clusters: [DENSE_CORE, near, DISTANT_PROMINENT],
      reach: 'drive',
      nights: 5,
      maxBaseChanges: null,
    });
    const graph = travelRegionGraph({ destinationName: 'Testland', structure });

    const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
    expect(kinds.get('core')).toBe('core');
    expect(kinds.get('near')).toBe('satellite');
    expect(kinds.get('far')).toBe('excluded_area');

    const dayTrip = graph.edges.find((edge) => edge.to === 'near');
    expect(dayTrip?.kind).toBe('day_trip_from');
    /* Every duration on the graph is typed as the estimate it is. */
    for (const edge of graph.edges) expect(edge.travel.basis).toBe('estimated');
  });
});

describe('the constants behave the way the decision assumes', () => {
  it('turns cluster weight into days without ever returning zero', () => {
    expect(daysWorthOf(0)).toBe(1);
    expect(daysWorthOf(4)).toBe(1);
    expect(daysWorthOf(400)).toBe(7);
  });

  /**
   * The minutes threshold and the kilometre one have to be the same statement.
   *
   * They are computed from the same pair of tables, so a cluster is a day trip
   * in minutes exactly when it is one in kilometres. Worth asserting because
   * the two are used in different files and a future edit to one speed would
   * otherwise silently move the boundary in only one of them.
   *
   * Note the direction that is *not* asserted: a walker's day reach is longer
   * in minutes than a driver's, because twelve kilometres on foot takes more
   * of a day than seventy by car. That is the point of measuring reach in time.
   */
  it('agrees with itself about what a day trip is, in minutes and in kilometres', () => {
    for (const reach of ['walk', 'transit', 'drive'] as const) {
      const insideByKm = estimateTransferMinutes(
        { lat: 0, lng: 0 },
        { lat: (DAY_REACH_KM[reach] * 0.99) / 111, lng: 0 },
        reach,
      );
      const outsideByKm = estimateTransferMinutes(
        { lat: 0, lng: 0 },
        { lat: (DAY_REACH_KM[reach] * 1.2) / 111, lng: 0 },
        reach,
      );
      expect(insideByKm).toBeLessThanOrEqual(dayReachMinutes(reach));
      expect(outsideByKm).toBeGreaterThan(dayReachMinutes(reach));
    }
    expect(DAY_REACH_KM.walk).toBeLessThan(DAY_REACH_KM.transit);
    expect(DAY_REACH_KM.transit).toBeLessThan(DAY_REACH_KM.drive);
  });
});

/**
 * THE SEVEN-IDENTICAL-SENTENCES DEFECT, AS A CLASS.
 *
 * A live metropolis build (walking reach, hierarchy unthreaded) reported the
 * destination's own wards as rejected satellite areas, each carrying the same
 * paragraph — with a grammar error in it — seven times over. Three separate
 * fixes are asserted here: divisions of the destination are absorbed rather
 * than judged; identical refusals fold into one sentence; and the sentence
 * agrees with itself about number.
 */
describe('the destination’s own divisions, and how refusals read', () => {
  const core = cluster('core', 'Capital', 35.68, 139.76, { memberCount: 22, weight: 46 });
  /* Wards of the destination: real weight, just past a walking day reach. */
  const wardA = cluster('ward-a', 'South Ward', 35.56, 139.72, {
    weight: 10,
    hierarchy: ['Country', 'Capital'],
  });
  const wardB = cluster('ward-b', 'North Ward', 35.86, 139.65, {
    weight: 9,
    hierarchy: ['Country', 'Capital'],
  });
  /* A genuinely separate city, no containment claim. */
  const elsewhere = cluster('else', 'Elsewhere', 36.4, 139.1, { memberCount: 5, weight: 14 });

  it('absorbs divisions of the destination instead of rejecting them as areas', () => {
    const structure = chooseBaseStructure({
      clusters: [core, wardA, wardB, elsewhere],
      reach: 'walk',
      nights: 5,
      maxBaseChanges: 0,
      destinationName: 'Capital',
    });

    /* The wards are neither bases, nor satellites, nor rejections. */
    const rejectedIds = structure.rejected.map((entry) => entry.cluster.id);
    expect(rejectedIds).not.toContain('ward-a');
    expect(rejectedIds).not.toContain('ward-b');
    const satelliteIds = structure.bases.flatMap((base) =>
      base.satellites.map((entry) => entry.cluster.id),
    );
    expect(satelliteIds).not.toContain('ward-a');
    expect(satelliteIds).not.toContain('ward-b');

    expect(structure.absorbed?.map((entry) => entry.cluster.id).sort()).toEqual([
      'ward-a',
      'ward-b',
    ]);
    for (const entry of structure.absorbed ?? []) {
      expect(entry.reason).toContain('part of Capital');
    }

    /* And the graph carries no excluded_area node for ground inside the destination. */
    const graph = travelRegionGraph({ destinationName: 'Capital', structure });
    const excluded = graph.nodes.filter((node) => node.kind === 'excluded_area');
    expect(excluded.map((node) => node.id)).not.toContain('ward-a');
    expect(excluded.map((node) => node.id)).not.toContain('ward-b');
  });

  it('matches containment across scripts and casing via the fold', () => {
    const ward = cluster('w', 'Ward', 35.56, 139.72, {
      weight: 8,
      hierarchy: ['Country', 'CAPITAL'],
    });
    const structure = chooseBaseStructure({
      clusters: [core, ward],
      reach: 'walk',
      nights: 5,
      maxBaseChanges: 0,
      destinationName: 'capital',
    });
    expect(structure.absorbed?.map((entry) => entry.cluster.id)).toEqual(['w']);
  });

  it('leaves everything to compete when no hierarchy or destination is supplied', () => {
    const structure = chooseBaseStructure({
      clusters: [core, wardA, wardB],
      reach: 'walk',
      nights: 5,
      maxBaseChanges: 0,
    });
    expect(structure.absorbed).toBeUndefined();
    /* Pre-existing behaviour: the wards are judged like any other cluster. */
    expect(structure.rejected.length + structure.bases.length).toBeGreaterThan(1);
  });

  it('writes "holds" for one base and folds identical refusals into one sentence', () => {
    const far = (id: string, name: string, lat: number) =>
      cluster(id, name, lat, 141.5, { weight: 12, memberCount: 4 });
    const structure = chooseBaseStructure({
      clusters: [core, far('f1', 'Far One', 37.2), far('f2', 'Far Two', 37.4), far('f3', 'Far Three', 37.6)],
      reach: 'walk',
      nights: 5,
      maxBaseChanges: null,
    });

    const full = structure.rejected.filter((entry) => entry.rejection === 'trip_already_full');
    expect(full.length).toBeGreaterThan(1);
    for (const entry of full) {
      expect(entry.reason).toContain('which alone holds');
      expect(entry.reason).not.toContain('which alone hold about');
    }

    /* The identical sentences fold into one summary naming every area. */
    const summaries = structure.rejectionSummaries ?? [];
    const fullSummary = summaries.find((entry) => entry.rejection === 'trip_already_full');
    expect(fullSummary).toBeDefined();
    expect(fullSummary!.clusterNames.length).toBe(full.length);
    for (const entry of full) {
      expect(fullSummary!.clusterNames).toContain(entry.cluster.name);
    }
    /* One sentence, not one per cluster. */
    const identical = summaries.filter((entry) => entry.rejection === 'trip_already_full');
    expect(identical).toHaveLength(1);
  });

  it('writes "hold" when two bases share the days', () => {
    /*
     * Two bases a long way apart on a trip with room for both, plus a third
     * cluster that arrives once the days are spent — its refusal names both
     * bases and the verb has to agree with the plural subject.
     */
    const second = cluster('second', 'Second City', 37.9, 139.76, { memberCount: 8, weight: 24 });
    const third = cluster('third', 'Third City', 39.9, 139.76, { memberCount: 4, weight: 12 });
    const structure = chooseBaseStructure({
      clusters: [core, second, third],
      reach: 'drive',
      nights: 12,
      maxBaseChanges: null,
    });
    expect(structure.bases.length).toBe(2);
    const refusal = structure.rejected.find((entry) => entry.rejection === 'trip_already_full');
    expect(refusal).toBeDefined();
    expect(refusal!.reason).toContain('which alone hold about');
  });
});

/**
 * THE SAME FIX, ASSERTED THROUGH THE PRODUCTION ENTRY POINT.
 *
 * `chooseBaseStructure` gained containment awareness, and the tests above
 * proved it by handing it a hierarchy directly. Nothing on a real build did:
 * `buildRegionPortfolio` dropped `hierarchy` when it turned index entries into
 * clusters and never passed `destinationName` down, so the whole mechanism was
 * unreachable outside its own unit tests and a live metropolis went on
 * reporting its own wards as rejected areas.
 *
 * These assert the wiring, not the rule — they fail if either end of the thread
 * is cut again.
 */
describe('containment survives the trip from the index to the decision', () => {
  const feature = (
    id: string,
    name: string,
    lat: number,
    lng: number,
    over: Partial<DestinationIndexEntry> = {},
  ): DestinationIndexEntry => ({
    id,
    catalog: 'test',
    sourceId: id,
    featureType: 'city',
    displayName: name,
    aliases: [],
    hierarchy: [],
    center: { lat, lng },
    population: 40_000,
    ...over,
  });

  /* A metropolis, three of its own wards just outside a walking day reach, and
     one genuinely separate city. The live shape, with no destination named. */
  const entries = [
    feature('m', 'Metro', 35.68, 139.76, { population: 9_000_000, prominence: 96 }),
    feature('w1', 'South Ward', 35.53, 139.72, {
      population: 700_000,
      hierarchy: ['Country', 'Metro'],
    }),
    feature('w2', 'North Ward', 35.85, 139.66, {
      population: 650_000,
      hierarchy: ['Country', 'Metro'],
    }),
    feature('w3', 'East Ward', 35.7, 140.0, {
      population: 600_000,
      hierarchy: ['Country', 'Metro'],
    }),
    feature('other', 'Other City', 36.6, 139.2, { population: 500_000, prominence: 70 }),
  ];

  it('does not offer the destination’s own wards as excluded areas', () => {
    const portfolio = buildRegionPortfolio({
      entries,
      mode: 'walk',
      nights: 5,
      destinationName: 'Metro',
    });

    const excludedNames = portfolio.excluded.map((entry) => entry.cluster.name);
    for (const ward of ['South Ward', 'North Ward', 'East Ward']) {
      expect(excludedNames, `${ward} is part of the destination`).not.toContain(ward);
    }
    /* The separate city is still judged on its merits — the gate is containment,
       not "reject nothing". */
    expect(portfolio.allClusters.some((entry) => entry.name === 'Other City')).toBe(true);
  });

  it('carries the index hierarchy onto the cluster it seeds', () => {
    const portfolio = buildRegionPortfolio({
      entries,
      mode: 'walk',
      nights: 5,
      destinationName: 'Metro',
    });
    const ward = portfolio.allClusters.find((entry) => entry.name === 'South Ward');
    expect(ward?.hierarchy).toEqual(['Country', 'Metro']);
  });

  it('keeps the destination itself base-capable even when its own chain names it', () => {
    /*
     * The index publishes chains that can include the entry itself. Reading that
     * as containment would absorb the destination into whatever outranked it.
     */
    const structure = chooseBaseStructure({
      clusters: [
        cluster('rival', 'Rival', 35.0, 139.0, { memberCount: 20, weight: 40 }),
        cluster('metro', 'Metro', 35.68, 139.76, {
          memberCount: 18,
          weight: 36,
          hierarchy: ['Country', 'Metro'],
        }),
      ],
      reach: 'drive',
      nights: 10,
      maxBaseChanges: null,
      destinationName: 'Metro',
    });
    expect(structure.absorbed).toBeUndefined();
    const known = [
      ...structure.bases.map((base) => base.cluster.id),
      ...structure.bases.flatMap((base) => base.satellites.map((entry) => entry.cluster.id)),
      ...structure.rejected.map((entry) => entry.cluster.id),
    ];
    expect(known).toContain('metro');
  });
});
