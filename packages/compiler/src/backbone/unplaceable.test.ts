import { describe, expect, it } from 'vitest';
import { geographicScopeSchema, type GeographicScope, type SourceRecord } from '@sidequest/core';
import { assemblePack } from './assemble';
import { partitionScope } from './partition';
import { buildInventory } from './inventory';

/**
 * WHAT HAPPENS TO A PLACE WE CANNOT PLACE.
 *
 * The worst board this product has produced was a major world city rendered as
 * forty-five restaurants in an outlying suburb. Nobody wrote a rule saying
 * "prefer restaurants". The rule that produced it was two tables agreeing with
 * each other:
 *
 *   `slotsFromPermissions` sends every attraction role except `side_quest` to
 *   the **anchor** slot, and `SLOTS_BY_RELATIONSHIP.membership_unknown` permits
 *   `discovery`, `food` and `support` — but not `anchor`.
 *
 * So wherever the divisions layer could not place records, the intersection of
 * those two was empty for every museum, temple, park and viewpoint, and each was
 * rejected as `role_ineligible_for_slot`. Restaurants and shops, whose own slots
 * *were* permitted, passed. A gap in our geography had silently become a claim
 * about what there is to do in a city.
 *
 * This file is the regression. The three properties it holds are the whole fix:
 * an unplaceable attraction is **demoted, not deleted**; a record with positive
 * evidence that it is elsewhere is **still refused**; and food never becomes a
 * thing to do.
 */

function scopeFor(): GeographicScope {
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
  });
}

/**
 * A record whose administrative membership nobody could establish.
 *
 * Empty `containment` is not an artificial shape: the containment probe over
 * stored packs found published region names on 1.5–5.9 % of candidates. A dense
 * metro where the divisions retention cap bites looks exactly like this.
 */
function unplaceable(overrides: Partial<SourceRecord>): SourceRecord {
  return {
    id: 'places:x',
    layerId: 'places',
    sourceId: 'x',
    name: 'Unplaced thing',
    alternateNames: [],
    coordinates: { lat: 40.7, lng: -74 },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

/**
 * The destination's own administrative chain.
 *
 * Present so the pack can tell the two failure modes apart. Without a divisions
 * layer nothing knows what country the destination is in, so a record claiming
 * `ZZ` is honestly unknown rather than positively elsewhere — and the guard
 * below would be asserting against a coincidence. With it, `AA` is established
 * and a `ZZ` record is refused on its own published evidence.
 */
function testDivisions(): SourceRecord[] {
  const wide = { southWest: { lat: 39.5, lng: -75 }, northEast: { lat: 41.9, lng: -72.9 } };
  return [
    {
      id: 'divisions:country',
      layerId: 'divisions',
      sourceId: 'country',
      name: 'Testland',
      alternateNames: [],
      coordinates: { lat: 40.7, lng: -74 },
      bounds: { southWest: { lat: 30, lng: -85 }, northEast: { lat: 50, lng: -65 } },
      sourceCategory: 'country',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      websiteCandidates: [],
      containment: { countryCode: 'AA', divisionIds: ['div-country'] },
      attributes: { subtype: 'country' },
      sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
      cellId: 'g-0-0',
    },
    {
      id: 'divisions:testville',
      layerId: 'divisions',
      sourceId: 'testville',
      name: 'Testville',
      alternateNames: [],
      coordinates: { lat: 40.7, lng: -74 },
      bounds: wide,
      sourceCategory: 'locality',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      websiteCandidates: [],
      containment: {
        countryCode: 'AA',
        regionName: 'AA-1',
        localityName: 'Testville',
        divisionIds: ['div-country', 'div-testville'],
      },
      attributes: { subtype: 'locality' },
      sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
      cellId: 'g-0-0',
    },
  ];
}

/**
 * @param divisions whether the pack knows the destination's administrative chain.
 *
 * Both states are real and they are the two halves of this file. A pack **with**
 * divisions can place its records, and can therefore say positively that a `ZZ`
 * record is somewhere else. A pack **without** them — which is what a dense
 * metro looks like when the divisions retention cap bites, and the measured
 * probe found 110–320 division records for a whole country — can say neither,
 * and every record in it is honestly `membership_unknown`.
 */
function packWith(records: SourceRecord[], scope: GeographicScope, divisions: boolean) {
  return assemblePack({
    id: 'pack-unplaceable',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
      ...(divisions
        ? [
            {
              id: 'divisions',
              kind: 'administrative_divisions' as const,
              catalog: 'test',
              datasetPath: 'divisions/division',
              licenceId: 'CDLA-Permissive-2.0' as const,
              records: testDivisions(),
              featuresRead: 2,
              featuresRetained: 2,
              failedCellIds: [],
            },
          ]
        : []),
      {
        id: 'places',
        kind: 'primary_places' as const,
        catalog: 'test',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0' as const,
        records,
        featuresRead: records.length,
        featuresRetained: records.length,
        failedCellIds: [],
      },
    ],
    diagnostics: {
      filesInspected: 1,
      rowGroupsInspected: 1,
      rowGroupsRead: 1,
      bytesTransferred: 1,
      durationMs: 1,
      budgetsExhausted: [],
      layerTimings: [],
    },
    // Fixed, because a pack's bytes must not depend on the afternoon it was built.
    now: new Date('2026-01-01T00:00:00Z'),
  });
}

/**
 * The city that came back as lunch.
 *
 * Five real attractions of five different kinds, and five places to eat, none of
 * which the divisions layer could place. Before the fix this pack produced a
 * board of five restaurants.
 */
function metroWithUnresolvedMembership(): SourceRecord[] {
  const attractions: [string, string, string[]][] = [
    ['City Museum', 'museum', ['arts_and_entertainment', 'museum']],
    ['Old Shrine', 'temple', ['religious', 'temple']],
    ['Riverside Park', 'park', ['landmarks_and_outdoors', 'park']],
    ['North Viewpoint', 'scenic_lookout', ['landmarks_and_outdoors', 'scenic_lookout']],
    ['Stone Gardens', 'garden', ['landmarks_and_outdoors', 'garden']],
  ];
  const eateries: [string, string, string[]][] = [
    ['Corner Noodles', 'restaurant', ['eat_and_drink', 'restaurant']],
    ['Station Bakery', 'bakery', ['eat_and_drink', 'bakery']],
    ['Cafe Two', 'cafe', ['eat_and_drink', 'cafe']],
    ['Third Kitchen', 'restaurant', ['eat_and_drink', 'restaurant']],
    ['Fourth Grill', 'restaurant', ['eat_and_drink', 'restaurant']],
  ];

  return [...attractions, ...eateries].map(([name, category, path], index) =>
    unplaceable({
      id: `places:${index}`,
      sourceId: `${index}`,
      name,
      sourceCategory: category,
      sourceCategoryPath: path,
      // Spread them so no area cap or dedupe collapses the set.
      coordinates: { lat: 40.7 + index * 0.002, lng: -74 + index * 0.002 },
    }),
  );
}

describe('a packet whose administrative membership nobody could resolve', () => {
  const scope = scopeFor();

  it('keeps its museums, temples, parks and viewpoints as things to do', () => {
    const inventory = buildInventory({
      pack: packWith(metroWithUnresolvedMembership(), scope, false),
      scope,
    });

    const names = inventory.candidates.map((entry) => entry.place.name);
    for (const expected of [
      'City Museum',
      'Old Shrine',
      'Riverside Park',
      'North Viewpoint',
      'Stone Gardens',
    ]) {
      expect(names, `${expected} was dropped for being unplaceable`).toContain(expected);
    }
  });

  it('reproduces the old failure as an assertion: food must not be all that survives', () => {
    /**
     * The shape of the defect, stated directly.
     *
     * Before the fix `candidates` was empty and every attraction appeared under
     * `role_ineligible_for_slot`. This asserts the inverse of that specific
     * outcome rather than a proxy for it, so a regression cannot pass by
     * producing a differently-wrong board.
     */
    const inventory = buildInventory({
      pack: packWith(metroWithUnresolvedMembership(), scope, false),
      scope,
    });

    expect(inventory.candidates.length).toBeGreaterThan(0);

    const refusedForSlot =
      inventory.portfolio.rejected.find((entry) => entry.reason === 'role_ineligible_for_slot')
        ?.count ?? 0;
    expect(refusedForSlot).toBe(0);

    // And the food is still food — it did not become something to do.
    const visitableNames = inventory.candidates.map((entry) => entry.place.name);
    for (const eatery of ['Corner Noodles', 'Station Bakery', 'Cafe Two']) {
      expect(visitableNames).not.toContain(eatery);
    }
    expect(inventory.foodRecords.map((record) => record.name)).toContain('Corner Noodles');
  });

  it('records the demotion rather than absorbing it', () => {
    const inventory = buildInventory({
      pack: packWith(metroWithUnresolvedMembership(), scope, false),
      scope,
    });
    // Five attractions could not be placed, so five could not anchor a day.
    expect(inventory.portfolio.anchorDemotions).toBe(5);
    expect(inventory.portfolio.membershipUnverified).toBeGreaterThan(0);
  });

  it('does not let an unplaceable attraction anchor a day', () => {
    /**
     * Demotion is not promotion. The whole point of `discovery` rather than
     * `anchor` is that a day is not built around a place we cannot locate.
     */
    const inventory = buildInventory({
      pack: packWith(metroWithUnresolvedMembership(), scope, false),
      scope,
    });
    const anchorPools = inventory.portfolio.pools.filter((pool) => pool.slot === 'anchor');
    expect(anchorPools.reduce((sum, pool) => sum + pool.kept, 0)).toBe(0);

    const discoveryPools = inventory.portfolio.pools.filter((pool) => pool.slot === 'discovery');
    expect(discoveryPools.reduce((sum, pool) => sum + pool.kept, 0)).toBeGreaterThan(0);
  });

  it('still refuses a record its own source says is in another country', () => {
    /**
     * The guard on the fix. Demotion rescues an *absence* of evidence; it must
     * never rescue evidence of absence. `outside_scope` permits no slot at all,
     * so this record has nothing to be demoted into.
     */
    const records = [
      ...metroWithUnresolvedMembership(),
      unplaceable({
        id: 'places:abroad',
        sourceId: 'abroad',
        name: 'Foreign Museum',
        coordinates: { lat: 40.72, lng: -74.02 },
        containment: { countryCode: 'ZZ', localityName: 'Elsewhere', divisionIds: [] },
      }),
    ];
    const inventory = buildInventory({ pack: packWith(records, scope, true), scope });

    expect(inventory.candidates.map((entry) => entry.place.name)).not.toContain('Foreign Museum');
    expect(inventory.supporting.map((entry) => entry.place.name)).not.toContain('Foreign Museum');
    expect(inventory.foodRecords.map((record) => record.name)).not.toContain('Foreign Museum');
  });
});
