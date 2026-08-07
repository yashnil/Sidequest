import { describe, expect, it } from 'vitest';
import {
  admitToBoard,
  geographicScopeSchema,
  inclusionReasonOfPlace,
  isVisitableRole,
  packScopeHash,
  planningRoleOfPlace,
  regionPackSchema,
  SUPPORTING_ROLES,
  type GeographicScope,
  type SourceRecord,
} from '@sidequest/core';
import { compileRegion, matrixModeFor } from '../compile';
import { packBackedProviders, syntheticPack } from '../testing/pack-fakes';
import { SYNTHETIC_WORLDS, fakeProviders } from '../testing/fakes';
import { assemblePack, contentHashOf, failedPack } from './assemble';
import { buildInventory, foodVenueFromRecord, packLicences } from './inventory';
import { compare, linkRecords, supersededRecordIds } from './link';
import {
  CELL_OVERLAP_DEGREES,
  MAX_CELL_DEGREES,
  MAX_CELLS,
  MIN_CELL_DEGREES,
  cellSizeFor,
  partitionScope,
  scopeBounds,
} from './partition';
import { classifySourceCategory, isLandscapeScale } from './taxonomy';

/**
 * THE BACKBONE, OFFLINE.
 *
 * Every test here runs without a network, without a clock and without a
 * database. What they assert is the set of properties the live evaluations
 * turned out to depend on: partitioning is deterministic and covers what it
 * claims to, linking is evidence-based rather than optimistic, the taxonomy
 * table refuses the junk a commercial catalogue is full of, and a pack that
 * failed never presents itself as ready.
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

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'places:a',
    layerId: 'places',
    sourceId: 'a',
    name: 'Harbour Museum',
    alternateNames: [],
    coordinates: { lat: 40.7, lng: -74 },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    /*
     * An address that places it in the destination, which is what a real record
     * carries: the measured probe over stored packs found a locality name on
     * 83–98 % of candidates and a region name on under 6 %. A fixture record
     * with an empty containment block models a population that does not exist,
     * and under the corrected semantics it is honestly `membership_unknown` —
     * admitted to a provisional board, kept off the final one. Tests about
     * balancing, corroboration and role separation are not about that, so their
     * records say where they are.
     */
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

/**
 * The divisions a pack always has, and this fixture used not to.
 *
 * The destination is a locality, so the divisions layer publishes it: a country
 * and the town, with a box wide enough to hold the scope and every record, and a
 * chain running country → town. That chain is what `selectedDivisionIds`
 * resolves the destination to, and what a candidate's own locality name is
 * resolved *through*.
 */
function testDivisions(): SourceRecord[] {
  const wide = {
    southWest: { lat: 39.5, lng: -75 },
    northEast: { lat: 41.9, lng: -72.9 },
  };
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

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

describe('scope partitioning', () => {
  it('is deterministic: the same scope produces the same cells in the same order', () => {
    const scope = scopeFor();
    const first = partitionScope(scope);
    const second = partitionScope(scope);
    expect(first).toEqual(second);
  });

  it('scales the cell size to the scope, so retention is spread rather than sliced', () => {
    /**
     * A single cell over a whole city was the defect: the feature budget filled
     * from one contiguous corner of the source data and a live board came back
     * as one borough's parks. A scope gets a few cells across whatever its size.
     */
    const city = partitionScope(scopeFor());
    expect(city.cells.length).toBeGreaterThan(1);
    expect(city.strategy).toBe('grid');

    // A neighbourhood is small enough that one cell is the honest answer.
    const neighbourhood = partitionScope(
      scopeFor({
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: 40.72, lng: -74.01 }, northEast: { lat: 40.74, lng: -73.99 } },
        },
      }),
    );
    expect(neighbourhood.cells).toHaveLength(1);
    expect(neighbourhood.strategy).toBe('single');
    expect(cellSizeFor(0.02)).toBe(MIN_CELL_DEGREES);
    expect(cellSizeFor(10)).toBe(MAX_CELL_DEGREES);

    const country = partitionScope(
      scopeFor({
        breadth: 'country',
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: 36, lng: -9.5 }, northEast: { lat: 42, lng: -6 } },
        },
      }),
    );
    expect(country.cells.length).toBeGreaterThan(4);
    expect(country.strategy).toBe('grid');
  });

  it('never exceeds the global cell cap, and says how many it dropped', () => {
    const huge = partitionScope(
      scopeFor({
        breadth: 'multi_country',
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: -40, lng: -70 }, northEast: { lat: 10, lng: -35 } },
        },
      }),
    );
    expect(huge.cells.length).toBeLessThanOrEqual(MAX_CELLS);
    expect(huge.droppedCells).toBeGreaterThan(0);
  });

  it('keeps the cells nearest the middle when it has to drop some', () => {
    const plan = partitionScope(
      scopeFor({
        breadth: 'country',
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: -40, lng: -70 }, northEast: { lat: 10, lng: -35 } },
        },
      }),
    );
    const centre = { lat: -15, lng: -52.5 };
    const distances = plan.cells.map((cell) => {
      const lat = (cell.bounds.southWest.lat + cell.bounds.northEast.lat) / 2 - centre.lat;
      const lng = (cell.bounds.southWest.lng + cell.bounds.northEast.lng) / 2 - centre.lng;
      return Math.hypot(lat, lng);
    });
    // The first cell is the nearest one, and priority descends with distance.
    expect(distances[0]).toBeLessThanOrEqual(Math.min(...distances) + 0.001);
    expect(plan.cells[0]!.priority).toBeGreaterThan(plan.cells.at(-1)!.priority);
  });

  it('overlaps adjacent cells so a feature on a seam is in both, not neither', () => {
    const plan = partitionScope(
      scopeFor({
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: 40, lng: -74 }, northEast: { lat: 42, lng: -72 } },
        },
      }),
    );
    expect(plan.overlapDegrees).toBe(CELL_OVERLAP_DEGREES);
    // Every pair of cells that share an edge overlap by twice the margin.
    const seams = plan.cells.filter((cell) =>
      plan.cells.some(
        (other) =>
          other.id !== cell.id &&
          other.bounds.southWest.lat < cell.bounds.northEast.lat &&
          other.bounds.northEast.lat > cell.bounds.southWest.lat &&
          other.bounds.southWest.lng < cell.bounds.northEast.lng &&
          other.bounds.northEast.lng > cell.bounds.southWest.lng,
      ),
    );
    expect(seams.length).toBeGreaterThan(0);
  });

  it('cuts a corridor along its line rather than across its bounding box', () => {
    const plan = partitionScope(
      scopeFor({
        shape: {
          kind: 'corridor',
          waypoints: [
            { lat: 47.4, lng: 8.5 },
            { lat: 46.5, lng: 9.8 },
            { lat: 46.0, lng: 11.1 },
          ],
          corridorWidthKm: 40,
        },
      }),
    );
    expect(plan.strategy).toBe('corridor');
    expect(plan.cells.length).toBeGreaterThan(2);
    // A bounding grid over the same span would be far wider than the corridor.
    const bounds = scopeBounds(
      scopeFor({
        shape: {
          kind: 'corridor',
          waypoints: [
            { lat: 47.4, lng: 8.5 },
            { lat: 46.5, lng: 9.8 },
            { lat: 46.0, lng: 11.1 },
          ],
          corridorWidthKm: 40,
        },
      }),
    );
    const totalCellArea = plan.cells.reduce(
      (sum, cell) =>
        sum +
        (cell.bounds.northEast.lat - cell.bounds.southWest.lat) *
          (cell.bounds.northEast.lng - cell.bounds.southWest.lng),
      0,
    );
    const boxArea =
      (bounds.northEast.lat - bounds.southWest.lat) * (bounds.northEast.lng - bounds.southWest.lng);
    expect(totalCellArea).toBeLessThan(boxArea);
  });

  it('cuts an area set per area, so an archipelago does not read the sea between', () => {
    const plan = partitionScope(
      scopeFor({
        shape: {
          kind: 'areas',
          areas: [
            { id: 'a', name: 'North', center: { lat: 62.2, lng: -6.8 }, radiusKm: 20 },
            { id: 'b', name: 'South', center: { lat: 61.5, lng: -6.7 }, radiusKm: 20 },
          ],
        },
      }),
    );
    expect(plan.strategy).toBe('areas');
    expect(plan.cells.length).toBeGreaterThanOrEqual(2);
  });

  it('never produces an empty plan, even for a degenerate scope', () => {
    const plan = partitionScope(
      scopeFor({
        shape: { kind: 'radius', center: { lat: 0, lng: 0 }, radiusKm: 0.1 },
      }),
    );
    expect(plan.cells.length).toBeGreaterThanOrEqual(1);
  });

  it('never names a destination', () => {
    const one = partitionScope(scopeFor({ destinationName: 'Bali' }));
    const two = partitionScope(scopeFor({ destinationName: 'Denali National Park' }));
    expect(one.cells.map((cell) => cell.id)).toEqual(two.cells.map((cell) => cell.id));
  });
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

describe('cross-source linking', () => {
  it('treats a shared open identifier as identity', () => {
    const link = compare(
      record({ id: 'places:a', wikidataId: 'Q42' }),
      record({
        id: 'land:b',
        layerId: 'land',
        wikidataId: 'Q42',
        coordinates: { lat: 40.705, lng: -74.004 },
      }),
    );
    expect(link?.kind).toBe('same_entity');
    expect(link?.evidence).toContain('shared_wikidata_id');
  });

  it('treats a shared upstream record id as identity', () => {
    const link = compare(
      record({ id: 'places:a', sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0', recordId: 'w1@2' }] }),
      record({
        id: 'land:b',
        layerId: 'land',
        name: 'Something Else Entirely',
        sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0', recordId: 'w1@2' }],
      }),
    );
    expect(link?.kind).toBe('same_entity');
  });

  it('does not merge two branches of one chain that share a website', () => {
    const a = record({
      id: 'places:a',
      name: 'Harbour Coffee',
      planningRole: 'food',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['food_and_drink', 'cafe'],
      websiteCandidates: ['https://harbourcoffee.example/'],
    });
    const b = record({
      id: 'places:b',
      sourceId: 'b',
      name: 'Harbour Coffee',
      planningRole: 'food',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['food_and_drink', 'cafe'],
      websiteCandidates: ['https://www.harbourcoffee.example'],
      coordinates: { lat: 40.75, lng: -74.02 },
    });
    const link = compare(a, b);
    expect(link?.kind).toBe('colocated_distinct');
    expect(supersededRecordIds([a, b], [link!]).size).toBe(0);
  });

  it('does not merge the same name in two adjacent towns', () => {
    const a = record({ id: 'places:a', name: 'Riverside Park' });
    const b = record({
      id: 'places:b',
      sourceId: 'b',
      name: 'Riverside Park',
      coordinates: { lat: 41.4, lng: -74.6 },
    });
    const link = compare(a, b);
    expect(link?.kind).toBe('unresolved');
    expect(supersededRecordIds([a, b], link ? [link] : []).size).toBe(0);
  });

  it('merges a landscape feature two sources placed kilometres apart', () => {
    const a = record({
      id: 'places:a',
      name: 'Gunung Testing',
      sourceCategory: 'volcano',
      sourceCategoryPath: ['geographic_entities', 'natural_feature', 'volcano'],
    });
    const b = record({
      id: 'land:b',
      layerId: 'land',
      sourceId: 'b',
      name: 'Gunung Testing',
      sourceCategory: 'peak',
      sourceCategoryPath: [],
      // About four kilometres north.
      coordinates: { lat: 40.736, lng: -74 },
    });
    const link = compare(a, b);
    expect(link).not.toBeNull();
    expect(['same_entity', 'probable_same_entity']).toContain(link!.kind);
    expect(supersededRecordIds([a, b], [link!]).size).toBe(1);
  });

  it('does not merge two cafés forty metres apart', () => {
    const a = record({
      id: 'places:a',
      name: 'The Corner',
      planningRole: 'food',
      sourceCategory: 'cafe',
    });
    const b = record({
      id: 'places:b',
      sourceId: 'b',
      name: 'The Corner Two',
      planningRole: 'food',
      sourceCategory: 'cafe',
      coordinates: { lat: 40.70036, lng: -74 },
    });
    expect(compare(a, b)).toBeNull();
  });

  it('records a park and a feature inside it as parent and child, not duplicates', () => {
    const park = record({
      id: 'land:park',
      layerId: 'land',
      name: 'Northern Reserve',
      sourceCategory: 'nature_reserve',
      bounds: { southWest: { lat: 40.69, lng: -74.01 }, northEast: { lat: 40.71, lng: -73.99 } },
    });
    const trailhead = record({
      id: 'places:trailhead',
      name: 'Ridge Trailhead',
      sourceCategory: 'trailhead',
      coordinates: { lat: 40.7005, lng: -74.0005 },
      planningRole: 'support',
    });
    const link = compare(park, trailhead);
    expect(link?.kind).toBe('parent_child');
    expect(link?.parentRecordId).toBe('land:park');
    expect(supersededRecordIds([park, trailhead], [link!]).size).toBe(0);
  });

  it('matches across scripts through alternate names', () => {
    const a = record({ id: 'places:a', name: '國家自由紀念區', alternateNames: ['Liberty Memorial'] });
    const b = record({
      id: 'land:b',
      layerId: 'land',
      sourceId: 'b',
      name: 'Liberty Memorial',
      sourceCategory: 'museum',
      coordinates: { lat: 40.7002, lng: -74.0002 },
    });
    const link = compare(a, b);
    expect(link).not.toBeNull();
    expect(['same_entity', 'probable_same_entity']).toContain(link!.kind);
  });

  it('produces links in a stable order whatever order records arrive in', () => {
    const records = [
      record({ id: 'places:a', wikidataId: 'Q1' }),
      record({ id: 'land:b', layerId: 'land', sourceId: 'b', wikidataId: 'Q1' }),
      record({ id: 'places:c', sourceId: 'c', name: 'Something', coordinates: { lat: 40.71, lng: -74.01 } }),
    ];
    const forward = linkRecords(records);
    const backward = linkRecords([...records].reverse());
    expect(forward).toEqual(backward);
  });

  it('picks the better-evidenced record as the survivor', () => {
    const thin = record({ id: 'places:thin', wikidataId: 'Q7' });
    const rich = record({
      id: 'land:rich',
      layerId: 'land',
      sourceId: 'rich',
      wikidataId: 'Q7',
      websiteCandidates: ['https://example.org/'],
      attributes: { operator: 'Someone', opening_hours: 'Mo-Su 09:00-17:00' },
      sources: [
        { dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' },
        { dataset: 'Other', licenceId: 'ODbL-1.0' },
      ],
    });
    const superseded = supersededRecordIds([thin, rich], linkRecords([thin, rich]));
    expect([...superseded]).toEqual(['places:thin']);
  });
});

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

describe('taxonomy classification', () => {
  it('classifies from the source vocabulary, not from a name', () => {
    expect(classifySourceCategory({ category: 'museum' }).category).toBe('museum');
    expect(classifySourceCategory({ category: 'waterfall' }).category).toBe('lake');
    expect(classifySourceCategory({ category: 'peak' }).category).toBe('viewpoint');
    expect(classifySourceCategory({ category: 'hiking_trail' }).category).toBe('day_hike');
  });

  it('refuses the junk a commercial place catalogue is full of', () => {
    // Every one of these was on a live Discovery Board before it was fixed.
    expect(classifySourceCategory({ category: 'atm', path: ['pedestrian'] }).role).toBe('excluded');
    expect(
      classifySourceCategory({ category: 'insurance_agency', path: ['services_and_business'] }).role,
    ).toBe('excluded');
    expect(
      classifySourceCategory({
        category: 'dance_club',
        path: ['arts_and_entertainment', 'nightlife_venue', 'dance_club'],
      }).role,
    ).toBe('excluded');
  });

  it('treats a congregation as a support stop and a monument as an attraction', () => {
    const congregation = classifySourceCategory({
      category: 'christian_place_of_worship',
      path: ['cultural_and_historic', 'religious_organization', 'place_of_worship'],
    });
    expect(congregation.role).toBe('support');

    const temple = classifySourceCategory({ category: 'hindu_temple' });
    expect(temple.role).toBe('attraction');
    expect(temple.category).toBe('historic_site');
  });

  it('separates food, lodging and support from attractions', () => {
    expect(classifySourceCategory({ category: 'restaurant' }).role).toBe('food');
    expect(classifySourceCategory({ category: 'hotel', path: ['lodging'] }).role).toBe('lodging');
    expect(classifySourceCategory({ category: 'supermarket' }).role).toBe('support');
  });

  /**
   * The split that stops a country being counted as its largest city.
   *
   * Every one of these used to resolve to `attraction`, because the archetype
   * table only ever named a role for food, lodging, support and excluded and
   * everything else fell through a `?? 'attraction'`. One bucket meant one
   * ranking, and the only thing available to rank on before a traveller exists
   * is how richly somebody catalogued the record — which is a measurement of
   * commercial mapping density, and is dense in cities.
   */
  it('gives outdoor features, side quests, markets and gateways their own roles', () => {
    expect(classifySourceCategory({ category: 'waterfall' }).role).toBe('outdoor');
    expect(classifySourceCategory({ category: 'viewpoint' }).role).toBe('outdoor');
    expect(classifySourceCategory({ category: 'hiking_trail' }).role).toBe('outdoor');
    expect(classifySourceCategory({ category: 'beach' }).role).toBe('outdoor');

    expect(classifySourceCategory({ category: 'museum' }).role).toBe('attraction');
    expect(classifySourceCategory({ category: 'castle' }).role).toBe('attraction');

    // Short, ungated, and nothing anybody sells a ticket for.
    expect(classifySourceCategory({ category: 'memorial' }).role).toBe('side_quest');
    expect(classifySourceCategory({ category: 'plaza' }).role).toBe('side_quest');

    expect(classifySourceCategory({ category: 'market' }).role).toBe('market');
    expect(classifySourceCategory({ category: 'farmers_market' }).role).toBe('market');

    expect(classifySourceCategory({ category: 'ferry_terminal' }).role).toBe('gateway');
    expect(classifySourceCategory({ category: 'airport' }).role).toBe('gateway');
    expect(classifySourceCategory({ category: 'train_station' }).role).toBe('gateway');
  });

  /**
   * Real built geography is kept and labelled rather than thrown away, while
   * street furniture stays excluded. The two answer different questions, and
   * collapsing them means paying to re-read the catalogue for the first.
   */
  it('tells built infrastructure apart from street furniture', () => {
    expect(classifySourceCategory({ category: 'substation' }).role).toBe('infrastructure');
    expect(classifySourceCategory({ category: 'pipeline' }).role).toBe('infrastructure');
    expect(classifySourceCategory({ category: 'bench' }).role).toBe('excluded');
    expect(classifySourceCategory({ category: 'atm' }).role).toBe('excluded');
  });

  /** An outdoor feature is weather-bound by construction, not by convention. */
  it('never classifies an indoor thing as outdoor', () => {
    for (const category of ['waterfall', 'viewpoint', 'beach', 'lake', 'hiking_trail', 'hot_spring']) {
      const resolved = classifySourceCategory({ category });
      expect(resolved.role, category).toBe('outdoor');
      expect(resolved.exposure, category).not.toBe('indoor');
    }
  });

  it('falls back through the branch, not to an attraction', () => {
    expect(
      classifySourceCategory({ category: 'a_leaf_nobody_has_seen', path: ['cultural_and_historic'] })
        .role,
    ).toBe('attraction');
    expect(classifySourceCategory({ category: 'a_leaf_nobody_has_seen' }).role).toBe('excluded');
  });

  it('knows which features have arbitrary representative points', () => {
    expect(isLandscapeScale({ category: 'peak' })).toBe(true);
    expect(isLandscapeScale({ category: 'national_park' })).toBe(true);
    expect(isLandscapeScale({ category: 'cafe' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe('candidate inventory', () => {
  const scope = scopeFor();

  it('drops excluded and administrative records and keeps support ones', () => {
    const pack = syntheticPack(SYNTHETIC_WORLDS.transit_city!, scope);
    const inventory = buildInventory({ pack, scope });
    expect(inventory.diagnostics.excludedByRole).toBeGreaterThan(0);
    expect(inventory.candidates.length).toBeGreaterThan(0);
    expect(inventory.candidates.every((entry) => entry.place.name.length > 0)).toBe(true);
  });

  it('never puts a permanently closed record in the inventory', () => {
    const pack = syntheticPack(SYNTHETIC_WORLDS.transit_city!, scope);
    const inventory = buildInventory({ pack, scope });
    expect(inventory.candidates.some((entry) => entry.place.name.includes('Closed'))).toBe(false);
  });

  it('does not treat several contributors inside one record as corroboration', () => {
    const conflated = record({
      sources: [
        { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0' },
        { dataset: 'foursquare', licenceId: 'Apache-2.0' },
        { dataset: 'atp', licenceId: 'CC0-1.0' },
      ],
    });
    const pack = packWith([conflated]);
    const inventory = buildInventory({ pack, scope });
    expect(inventory.candidates[0]?.confidenceSignals).toEqual(['single_provider_only']);
    // The refs still travel, because they are provenance rather than agreement.
    expect(inventory.candidates[0]?.providerRefs).toHaveLength(3);
  });

  it('earns corroboration only when two layers found the same thing', () => {
    const pack = packWith([
      record({ id: 'places:a', wikidataId: 'Q9' }),
      record({
        id: 'land:b',
        layerId: 'land',
        sourceId: 'b',
        wikidataId: 'Q9',
        sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
      }),
    ]);
    const inventory = buildInventory({ pack, scope });
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]?.confidenceSignals).toContain('multiple_providers_agree');
  });

  it('never turns a source existence confidence into a Sidequest signal', () => {
    const confident = record({
      sources: [
        { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 },
      ],
    });
    const inventory = buildInventory({ pack: packWith([confident]), scope });
    const candidate = inventory.candidates[0]!;
    expect(candidate.confidenceSignals).toEqual(['single_provider_only']);
    // Nor into popularity, which is derived from how much was recorded.
    expect(candidate.place.popularityScore).toBeLessThan(0.5);
  });

  it('caps any one category so a dense region does not produce a board of one thing', () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      record({
        id: `places:m${index}`,
        sourceId: `m${index}`,
        name: `Museum ${index}`,
        coordinates: { lat: 40.7 + index * 0.001, lng: -74 + index * 0.001 },
      }),
    );
    const inventory = buildInventory({ pack: packWith(many), scope });
    expect(inventory.diagnostics.heldBackByCategoryCap).toBeGreaterThan(0);
    const museums = inventory.candidates.filter((entry) => entry.place.category === 'museum');
    expect(museums.length).toBeLessThanOrEqual(22);
  });

  it('orders candidates so a downstream truncation keeps the mix', () => {
    /**
     * The regression this exists for. A live New York build produced a hundred
     * candidates in rank order, every one of them a municipal park, and the
     * traveller's board came back with seventeen walks and two of everything
     * else. The inventory was broad; the *first hundred* of it was not.
     */
    const parks = Array.from({ length: 60 }, (_, index) =>
      record({
        id: `land:p${index}`,
        layerId: 'land',
        sourceId: `p${index}`,
        name: `Park ${index}`,
        sourceCategory: 'park',
        sourceCategoryPath: ['sports_and_recreation', 'park'],
        coordinates: { lat: 40.7 + index * 0.002, lng: -74 },
        // Richly described, which is what made them win the rank order.
        attributes: { operator: 'City', opening_hours: 'Mo-Su 06:00-22:00', fee: 'no' },
        websiteCandidates: [`https://parks.example/${index}`],
      }),
    );
    const museums = Array.from({ length: 12 }, (_, index) =>
      record({
        id: `places:m${index}`,
        sourceId: `m${index}`,
        name: `Museum ${index}`,
        coordinates: { lat: 40.75 + index * 0.002, lng: -73.98 },
      }),
    );

    const inventory = buildInventory({ pack: packWith([...parks, ...museums]), scope });
    const firstTwenty = inventory.candidates.slice(0, 20).map((entry) => entry.place.category);
    expect(new Set(firstTwenty).size).toBeGreaterThan(1);
    expect(firstTwenty.filter((category) => category === 'museum').length).toBeGreaterThan(3);
  });

  /**
   * The same regression, end to end through the inventory rather than through
   * the pure balancer: a dense, richly-described area against several sparse,
   * thinly-described ones, which is the shape every country has.
   *
   * Before the balancing pass this returned the capital and nothing else, and
   * the reason was not the ranking being wrong — it is that `knownness` measures
   * how thoroughly somebody catalogued a record, and cataloguing concentrates
   * where commerce does.
   */
  it('keeps candidates outside the densest area', () => {
    const capital = Array.from({ length: 100 }, (_, index) =>
      record({
        id: `places:cap${index}`,
        sourceId: `cap${index}`,
        name: `City museum ${index}`,
        coordinates: { lat: 40.7, lng: -74 },
        cellId: 'g-0-0',
        // Richly catalogued, which is what won the old global rank order.
        attributes: { operator: 'City', opening_hours: 'Mo-Su 10:00-18:00', fee: 'yes' },
        websiteCandidates: [`https://museum.example/${index}`],
        wikidataId: `Q${1000 + index}`,
      }),
    );
    const regions = Array.from({ length: 6 }, (_, area) =>
      Array.from({ length: 20 }, (_, index) =>
        record({
          id: `land:r${area}-${index}`,
          layerId: 'land',
          sourceId: `r${area}-${index}`,
          name: `Falls ${area}-${index}`,
          sourceCategory: 'waterfall',
          sourceCategoryPath: ['natural_features', 'waterfall'],
          coordinates: { lat: 41 + area * 0.5, lng: -73 - index * 0.01 },
          cellId: `g-${area + 1}-0`,
          // Bare records: a name and a position, which is all the outdoors
          // usually has.
          attributes: {},
        }),
      ),
    ).flat();

    const inventory = buildInventory({ pack: packWith([...capital, ...regions]), scope });
    const kept = inventory.candidates.filter((entry) => entry.place.category !== 'town_and_food');
    const fromCapital = kept.filter((entry) => entry.place.coordinates.lat === 40.7).length;

    expect(kept.length).toBeGreaterThan(20);
    expect(fromCapital / kept.length).toBeLessThan(0.7);
    expect(inventory.diagnostics.byArea.length).toBeGreaterThan(1);
    expect(inventory.diagnostics.concentration).toBeLessThan(0.7);
  });

  /**
   * The counts a supply verdict and a destination profile are built from.
   *
   * One `attractions` number could not distinguish a city of museums from a
   * coast of beaches, and both were being described with the same sentence.
   */
  it('reports what it kept by planning role', () => {
    const inventory = buildInventory({
      pack: packWith([
        /*
         * Named things, not kinds of thing. A record whose name is its own
         * category is refused as having no identity — see the eligibility
         * layer — so a fixture that used the bare category word would be
         * testing that refusal rather than the role counts.
         */
        record({ id: 'places:m1', sourceId: 'm1', name: 'Harbour Museum' }),
        record({
          id: 'land:w1',
          layerId: 'land',
          sourceId: 'w1',
          name: 'North Ridge Falls',
          sourceCategory: 'waterfall',
          sourceCategoryPath: ['natural_features', 'waterfall'],
        }),
        record({ id: 'places:k1', sourceId: 'k1', name: 'Bazaar', sourceCategory: 'market' }),
        record({ id: 'places:f1', sourceId: 'f1', name: 'Corner Cafe', sourceCategory: 'cafe' }),
        record({
          id: 'places:g1',
          sourceId: 'g1',
          name: 'North Harbour Terminal',
          sourceCategory: 'ferry_terminal',
        }),
      ]),
      scope,
    });

    const roles = Object.fromEntries(
      inventory.diagnostics.byRole.map((entry) => [entry.role, entry.kept]),
    );
    expect(roles.attraction).toBe(1);
    expect(roles.outdoor).toBe(1);
    expect(roles.market).toBe(1);
    expect(roles.gateway).toBe(1);
    // A market counts as somewhere to eat as well as something to do.
    expect(inventory.foodRecords.length).toBe(2);
  });

  /**
   * A pack written before the role split stored every candidate as
   * `attraction`, because that was the only positive role there was.
   * Classifying at read time is what lets those packs gain the split without
   * being rebuilt — and packs are immutable, so rebuilding is not an option.
   */
  // -------------------------------------------------------------------------
  // Portfolio integrity: the Bali shape
  // -------------------------------------------------------------------------

  /**
   * THE SUPPLY SHAPE THAT PRODUCED THE DEFECT.
   *
   * A live compilation put an international airport, a driver-for-hire and two
   * tour operators on a traveller's Discovery Board. Nothing was misclassified:
   * the taxonomy called the airport a gateway and the driver a transport
   * service, the pack stored those answers, and then `buildInventory` did
   *
   * ```ts
   * const candidates = [...ordered, ...support, ...gateways].map(toCandidate);
   * ```
   *
   * — one array, three kinds of thing, and nothing downstream able to tell them
   * apart. The fixture below is that shape: six real attractions buried in
   * twenty-odd practical records, which is what a densely-commercial,
   * thinly-mapped destination actually returns.
   */
  function baliShapedPack() {
    const attractions = [
      { id: 'm1', name: 'Harbour Museum', category: 'museum', path: ['arts_and_entertainment', 'museum'] },
      { id: 'm2', name: 'Textile Museum', category: 'museum', path: ['arts_and_entertainment', 'museum'] },
      { id: 'h1', name: 'Old Water Palace', category: 'historic_site', path: ['cultural_and_historic', 'historic_site'] },
      { id: 'w1', name: 'North Ridge Falls', category: 'waterfall', path: ['natural_features', 'waterfall'] },
      { id: 'w2', name: 'Cliffside Falls', category: 'waterfall', path: ['natural_features', 'waterfall'] },
      { id: 'v1', name: 'Terrace Lookout', category: 'viewpoint', path: ['geographic_entities', 'viewpoint'] },
    ].map((entry, index) =>
      record({
        id: `places:${entry.id}`,
        sourceId: entry.id,
        name: entry.name,
        sourceCategory: entry.category,
        sourceCategoryPath: entry.path,
        coordinates: { lat: 40.7 + index * 0.01, lng: -74 + index * 0.01 },
        cellId: index % 2 === 0 ? 'g-0-0' : 'g-1-0',
      }),
    );

    /*
     * The supporting supply, and it outnumbers the attractions three to one.
     * Every category here is a real leaf from a global business vocabulary and
     * every one of them reached a board.
     */
    const supporting = [
      { id: 'g1', name: 'Island International Airport', category: 'international_airport' },
      { id: 'g2', name: 'North Harbour Ferry Terminal', category: 'ferry_terminal' },
      { id: 'g3', name: 'Central Bus Station', category: 'bus_station' },
      { id: 't1', name: 'Best Driver On The Island', category: 'chauffeur_service' },
      { id: 't2', name: 'Sunrise Tours', category: 'tour_operator' },
      { id: 't3', name: 'Island Day Trips', category: 'tour_operator' },
      { id: 't4', name: 'Airport Transfer Service', category: 'taxi_service' },
      { id: 's1', name: 'Beachside Pharmacy', category: 'pharmacy' },
      { id: 's2', name: 'Hillside Pharmacy', category: 'pharmacy' },
      { id: 's3', name: 'Coast Road Fuel', category: 'gas_station' },
      { id: 's4', name: 'Valley Fuel Stop', category: 'gas_station' },
      { id: 's5', name: 'Park Visitor Centre', category: 'visitor_center' },
      { id: 'p1', name: 'Beach Car Park', category: 'parking' },
      { id: 'p2', name: 'Trailhead Car Park', category: 'parking' },
      { id: 'p3', name: 'Museum Car Park', category: 'parking' },
      { id: 'f1', name: 'Central Supermarket', category: 'supermarket' },
      { id: 'f2', name: 'Coast Road Grocery', category: 'grocery_store' },
      { id: 'f3', name: 'Harbour Cafe', category: 'cafe' },
      { id: 'f4', name: 'Terrace Restaurant', category: 'restaurant' },
    ].map((entry, index) =>
      record({
        id: `places:${entry.id}`,
        sourceId: entry.id,
        name: entry.name,
        sourceCategory: entry.category,
        sourceCategoryPath: ['travel_and_transportation', entry.category],
        coordinates: { lat: 40.71 + index * 0.003, lng: -73.98 - index * 0.003 },
        cellId: index % 2 === 0 ? 'g-0-0' : 'g-1-0',
        // Richly catalogued, which is exactly why they won the old ordering: an
        // international airport carries a site, hours, an operator and an open
        // identifier, and no museum in the region does.
        attributes: { operator: 'Island Authority', opening_hours: 'Mo-Su 00:00-24:00' },
        websiteCandidates: [`https://example.org/${entry.id}`],
        wikidataId: `Q${9000 + index}`,
      }),
    );

    return packWith([...attractions, ...supporting]);
  }

  it('is the regression: no utility record reaches the candidate list', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });

    /*
     * The board-facing array holds the six things there are to do, and nothing
     * else. Before the split it held twenty-five, of which nineteen were
     * transport, parking, fuel, pharmacies and meals.
     */
    expect(inventory.candidates).toHaveLength(6);
    const names = inventory.candidates.map((entry) => entry.place.name).sort();
    expect(names).toEqual([
      'Cliffside Falls',
      'Harbour Museum',
      'North Ridge Falls',
      'Old Water Palace',
      'Terrace Lookout',
      'Textile Museum',
    ]);

    // The named offenders from the live run, by name and by kind.
    for (const forbidden of [
      'Island International Airport',
      'Best Driver On The Island',
      'Sunrise Tours',
      'Island Day Trips',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it('gives every candidate a visitable role, on the place itself', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });
    for (const candidate of inventory.candidates) {
      const role = planningRoleOfPlace(candidate.place);
      expect(role, candidate.place.name).toBeDefined();
      expect(isVisitableRole(role!), `${candidate.place.name} is ${role}`).toBe(true);
      expect(admitToBoard(candidate.place).admitted, candidate.place.name).toBe(true);
    }
  });

  it('displays every support candidate as support, and never as a card', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });
    expect(inventory.supporting.length).toBeGreaterThan(0);
    for (const candidate of inventory.supporting) {
      const role = planningRoleOfPlace(candidate.place);
      expect(role, candidate.place.name).toBeDefined();
      expect(SUPPORTING_ROLES, candidate.place.name).toContain(role);
      const admission = admitToBoard(candidate.place);
      expect(admission.admitted, candidate.place.name).toBe(false);
      expect(admission.refusal).toBe('utility_role');
    }
  });

  it('carries a typed inclusion reason on every candidate it emits', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });
    for (const candidate of [...inventory.candidates, ...inventory.supporting]) {
      expect(inclusionReasonOfPlace(candidate.place), candidate.place.name).toBeDefined();
    }
  });

  /**
   * CS-4. Board size stopped meaning anything the moment the two counts were
   * summed: twenty-five records reads as a rich destination, six things to do
   * is what it actually was, and the difference is exactly what a traveller
   * needs to know before booking.
   */
  it('reports the attraction shortage rather than filling the board with infrastructure', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });
    const { supply } = inventory.portfolio;

    expect(supply.supply.visitable).toBe(6);
    expect(supply.maxHonestBoardSize).toBe(6);
    expect(inventory.candidates.length).toBeLessThanOrEqual(supply.maxHonestBoardSize);
    expect(supply.supportHeavy).toBe(true);
    expect(supply.shortfalls).toContain('support_outnumbers_visitable');
    // Four nights in the scope. Six anchors clears it; the honest number is
    // still six rather than the twenty-five the old array reported.
    expect(inventory.diagnostics.attractions).toBe(6);
    expect(inventory.diagnostics.attractions + inventory.diagnostics.support).toBeGreaterThan(
      inventory.diagnostics.attractions,
    );
  });

  it('counts attractions, support, food and gateways as separate pools per area', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });
    const slots = new Set(inventory.portfolio.pools.map((pool) => pool.slot));
    expect(slots.has('anchor')).toBe(true);
    expect(slots.has('support')).toBe(true);
    expect(slots.has('gateway')).toBe(true);
    expect(slots.has('food')).toBe(true);

    for (const pool of inventory.portfolio.pools) {
      // Every pool reports its own geography. A shortage of attractions in one
      // area is not repaired by a surplus of car parks in another.
      expect(pool.available, pool.slot).toBeGreaterThan(0);
      for (const area of pool.byArea) {
        expect(area.kept, `${pool.slot}/${area.areaId}`).toBeGreaterThan(0);
      }
    }
  });

  it('routes a grocery to the food layer instead of to the board', () => {
    const inventory = buildInventory({ pack: baliShapedPack(), scope });
    const foodNames = inventory.foodRecords.map((entry) => entry.name);
    expect(foodNames).toContain('Central Supermarket');
    expect(foodNames).toContain('Harbour Cafe');
    expect(inventory.candidates.map((entry) => entry.place.name)).not.toContain(
      'Central Supermarket',
    );
  });

  it('refuses a closed record, an outside-scope one and a nameless one, and says so', () => {
    const pack = packWith([
      record({ id: 'places:ok', sourceId: 'ok', name: 'Harbour Museum' }),
      record({
        id: 'places:shut',
        sourceId: 'shut',
        name: 'Old Gallery',
        operatingStatus: 'closed',
        coordinates: { lat: 40.72, lng: -74.02 },
      }),
      record({
        id: 'places:noname',
        sourceId: 'noname',
        name: 'Museum',
        coordinates: { lat: 40.73, lng: -74.03 },
      }),
      /*
       * Out of scope on its **own published evidence**, and not on a field
       * somebody stamped on it.
       *
       * This test used to attach `scopeRelationship: 'outside_scope'` to the
       * record after the pack was assembled, with a comment explaining that the
       * schema stripped it on parse. That is exactly the shape the closure
       * removes: a source adapter must not be able to declare a verdict, because
       * a verdict an adapter can write is a verdict an adapter can withhold. The
       * record now carries a different country code, which is a statement the
       * source made, and the gate reaches the same answer from it.
       */
      record({
        id: 'places:elsewhere',
        sourceId: 'elsewhere',
        name: 'County Historical Society',
        coordinates: { lat: 40.74, lng: -74.04 },
        containment: { countryCode: 'ZZ', localityName: 'Far Township', divisionIds: [] },
      }),
    ]);

    const inventory = buildInventory({ pack, scope });
    expect(inventory.candidates.map((entry) => entry.place.name)).toEqual(['Harbour Museum']);

    const reasons = Object.fromEntries(
      inventory.portfolio.rejected.map((entry) => [entry.reason, entry.count]),
    );
    expect(reasons.permanently_closed).toBe(1);
    expect(reasons.identity_too_thin).toBe(1);
    expect(reasons.outside_scope).toBe(1);
  });

  it('ignores a relationship a source adapter tried to stamp on a record', () => {
    /*
     * The gate property, as an assertion. Whatever a provider writes onto a
     * record, the trip-scope overlay decides — so a new adapter cannot grant
     * board eligibility by asserting it, and an old cached pack carrying a
     * verdict from a previous contract cannot resurrect it.
     */
    const pack = packWith([record({ id: 'places:ok', sourceId: 'ok', name: 'Harbour Museum' })]);
    const forged = {
      ...pack,
      layers: pack.layers.map((layer) => ({
        ...layer,
        records: layer.records.map((entry) =>
          entry.layerId === 'places'
            ? ({ ...entry, scopeRelationship: 'outside_scope' } as SourceRecord)
            : entry,
        ),
      })),
    };
    const inventory = buildInventory({ pack: forged, scope });
    expect(inventory.candidates.map((entry) => entry.place.name)).toEqual(['Harbour Museum']);
  });

  /**
   * The property that makes the fix structural rather than incidental.
   *
   * The redistribution pass exists so an unclaimed market quota is not lost, and
   * it reads back into the pool to find the records to spend it on. If it read
   * the raw records rather than the admitted ones, every gate above would be
   * reachable from below — which is precisely how a shortage of attractions
   * turns into a board of infrastructure.
   */
  it('never lets an unfilled quota rescue a record admission refused', () => {
    const inventory = buildInventory({
      pack: baliShapedPack(),
      scope,
      // A quota far larger than the visitable supply. Every unclaimed slot is
      // an invitation to reach back into the pool.
      limits: { maxAttractions: 140 },
    });
    expect(inventory.candidates).toHaveLength(6);
    for (const candidate of inventory.candidates) {
      expect(isVisitableRole(planningRoleOfPlace(candidate.place)!)).toBe(true);
    }
  });

  it('reclassifies a pack stored under the old single-role vocabulary', () => {
    const inventory = buildInventory({
      pack: packWith([
        record({
          id: 'land:w1',
          layerId: 'land',
          sourceId: 'w1',
          name: 'Falls',
          sourceCategory: 'waterfall',
          sourceCategoryPath: ['natural_features', 'waterfall'],
          // What an old pack holds for everything.
          planningRole: 'attraction',
        }),
      ]),
      scope,
    });

    expect(inventory.diagnostics.byRole).toContainEqual({ role: 'outdoor', kept: 1 });
  });

  it('unions the licences from the records rather than from the layer', () => {
    const pack = packWith([
      record({ id: 'places:a', sources: [{ dataset: 'meta', licenceId: 'CDLA-Permissive-2.0' }] }),
      record({
        id: 'places:b',
        sourceId: 'b',
        name: 'Second',
        coordinates: { lat: 40.8, lng: -73.9 },
        sources: [{ dataset: 'foursquare', licenceId: 'Apache-2.0' }],
      }),
    ]);
    const ids = packLicences(pack).map((entry) => entry.id);
    expect(ids).toContain('CDLA-Permissive-2.0');
    expect(ids).toContain('Apache-2.0');
  });

  it('builds a food venue whose hours are unknown until somebody publishes them', () => {
    const venue = foodVenueFromRecord({
      record: record({
        id: 'places:f',
        name: 'The Kitchen',
        planningRole: 'food',
        sourceCategory: 'restaurant',
        sourceCategoryPath: ['food_and_drink', 'restaurant'],
      }),
      scope,
      routingId: 'base-1',
    });
    expect(venue?.hours.kind).toBe('unknown');
    expect(venue?.priceEvidence).toBe('format_inferred');
    expect(venue?.provisioning).toBe('none');
  });
});

function packWith(records: SourceRecord[]) {
  const scope = scopeFor();
  return assemblePack({
    id: 'pack-test',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
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
      {
        id: 'places',
        kind: 'primary_places',
        catalog: 'test',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0',
        records: records.filter((entry) => entry.layerId === 'places'),
        featuresRead: records.length,
        featuresRetained: records.filter((entry) => entry.layerId === 'places').length,
        failedCellIds: [],
      },
      ...(records.some((entry) => entry.layerId === 'land')
        ? [
            {
              id: 'land',
              kind: 'supplemental_geography' as const,
              catalog: 'test',
              datasetPath: 'base/land',
              licenceId: 'ODbL-1.0' as const,
              records: records.filter((entry) => entry.layerId === 'land'),
              featuresRead: records.length,
              featuresRetained: records.filter((entry) => entry.layerId === 'land').length,
              failedCellIds: [],
            },
          ]
        : []),
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
    now: new Date('2026-01-01T00:00:00Z'),
  });
}

// ---------------------------------------------------------------------------
// Assembly and immutability
// ---------------------------------------------------------------------------

describe('pack assembly', () => {
  const scope = scopeFor();

  it('produces a schema-valid pack with a content hash', () => {
    const pack = syntheticPack(SYNTHETIC_WORLDS.transit_city!, scope);
    expect(() => regionPackSchema.parse(pack)).not.toThrow();
    expect(pack.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(pack.state).toBe('ready');
  });

  it('hashes over the records and the pin, not over the timings', () => {
    const a = syntheticPack(SYNTHETIC_WORLDS.transit_city!, scope);
    const b = { ...a, diagnostics: { ...a.diagnostics, durationMs: a.diagnostics.durationMs + 500 } };
    expect(contentHashOf(b)).toBe(a.contentHash);
  });

  it('changes the hash when a record changes', () => {
    const a = syntheticPack(SYNTHETIC_WORLDS.transit_city!, scope);
    const layer = a.layers[0]!;
    const b = {
      ...a,
      layers: [
        { ...layer, records: layer.records.map((r, i) => (i === 0 ? { ...r, name: 'Renamed' } : r)) },
        ...a.layers.slice(1),
      ],
    };
    expect(contentHashOf(b)).not.toBe(a.contentHash);
  });

  it('is partial, never ready, when a cell could not be read', () => {
    const pack = assemblePack({
      id: 'pack-partial',
      scope,
      releases: [{ catalog: 'test', releaseId: '1', resolvedAt: '2026-01-01T00:00:00Z' }],
      partition: partitionScope(scope),
      layers: [
        {
          id: 'places',
          kind: 'primary_places',
          catalog: 'test',
          datasetPath: 'places/place',
          licenceId: 'CDLA-Permissive-2.0',
          records: [record()],
          featuresRead: 1,
          featuresRetained: 1,
          failedCellIds: ['g-0-0'],
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
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(pack.state).toBe('partial');
  });

  it('is failed, never ready, when nothing came back', () => {
    const pack = assemblePack({
      id: 'pack-empty',
      scope,
      releases: [{ catalog: 'test', releaseId: '1', resolvedAt: '2026-01-01T00:00:00Z' }],
      partition: partitionScope(scope),
      layers: [],
      diagnostics: {
        filesInspected: 0,
        rowGroupsInspected: 0,
        rowGroupsRead: 0,
        bytesTransferred: 0,
        durationMs: 1,
        budgetsExhausted: [],
        layerTimings: [],
      },
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(pack.state).toBe('failed');
    expect(pack.completedAt).toBeUndefined();
    expect(pack.failure).toBeDefined();
  });

  it('builds a schema-valid failure record with a displayable reason', () => {
    const pack = failedPack({
      id: 'pack-failed',
      scope,
      releases: [{ catalog: 'test', releaseId: '1', resolvedAt: '2026-01-01T00:00:00Z' }],
      partition: partitionScope(scope),
      now: new Date('2026-01-01T00:00:00Z'),
      code: 'provider_unavailable',
      detail: 'The catalogue did not answer.',
    });
    expect(() => regionPackSchema.parse(pack)).not.toThrow();
    expect(pack.state).toBe('failed');
  });

  it('hashes the ground rather than the traveller, so two trips share a pack', () => {
    const a = packScopeHash({
      destinationCandidateId: 'relation/1',
      bounds: scopeBounds(scopeFor({ nights: 3 })),
    });
    const b = packScopeHash({
      destinationCandidateId: 'relation/1',
      bounds: scopeBounds(scopeFor({ nights: 9, maxBaseChanges: 2 })),
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real pipeline
// ---------------------------------------------------------------------------

describe('compiling through the backbone', () => {
  it('records the pack stages and stamps the artifact with its release', async () => {
    const scope = scopeFor();
    const stages: string[] = [];
    const result = await compileRegion({
      compilationId: 'region-pack-test',
      scope,
      dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      months: [8],
      providers: packBackedProviders(SYNTHETIC_WORLDS.transit_city!),
      now: new Date('2026-07-31T00:00:00.000Z'),
      onStage: (record) => {
        if (record.status === 'done' || record.status === 'skipped') stages.push(record.stage);
      },
    });

    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);

    expect(stages).toContain('resolving_source_release');
    expect(stages).toContain('partitioning_scope');
    expect(stages).toContain('building_region_pack');
    expect(stages).toContain('linking_sources');

    expect(result.region.regionPack).toBeDefined();
    expect(result.region.regionPack?.releaseId).toBe('2026-07-22.0');
    expect(result.region.regionPack?.state).toBe('ready');
    expect(result.region.places.length).toBeGreaterThan(0);
  });

  it('carries both licence families through to the artifact', async () => {
    const result = await compileRegion({
      compilationId: 'region-licence-test',
      scope: scopeFor(),
      dates: ['2026-08-01', '2026-08-02'],
      months: [8],
      providers: packBackedProviders(SYNTHETIC_WORLDS.transit_city!),
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.region.licences.map((entry) => entry.id);
    expect(ids).toContain('CDLA-Permissive-2.0');
    expect(ids).toContain('ODbL-1.0');
    // Share-alike first, because that is the one with a legal consequence.
    expect(result.region.sourceManifest.attributions[0]).toContain('OpenStreetMap');
  });

  it('is byte-identical across two runs of the same inputs', async () => {
    const inputs = {
      compilationId: 'region-determinism',
      scope: scopeFor(),
      dates: ['2026-08-01', '2026-08-02'],
      months: [8],
      now: new Date('2026-07-31T00:00:00.000Z'),
    } as const;
    const first = await compileRegion({
      ...inputs,
      providers: packBackedProviders(SYNTHETIC_WORLDS.transit_city!),
    });
    const second = await compileRegion({
      ...inputs,
      providers: packBackedProviders(SYNTHETIC_WORLDS.transit_city!),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.region)).toBe(JSON.stringify(second.region));
  });

  it('measures a spread-out region on roads even when nobody is driving', () => {
    /**
     * Two live destinations failed outright with "we could not work out travel
     * times across this region" — a national park and an island, both with the
     * scope's primary mode set to `walk` and no continuous pedestrian graph
     * across either. Every non-driving mode a scope allows travels on roads.
     */
    const walkableCity = scopeFor({
      transport: {
        primaryMode: 'walk',
        allowedModes: ['walk', 'public_bus', 'rail'],
        carAvailable: false,
        acceptsWaterOrAirTransfers: true,
        basis: 'clarification',
        note: 'No car.',
      },
      shape: {
        kind: 'bounds',
        bounds: { southWest: { lat: 40.72, lng: -74.01 }, northEast: { lat: 40.76, lng: -73.97 } },
      },
    });
    expect(matrixModeFor(walkableCity)).toBe('foot');

    const nationalPark = scopeFor({
      transport: walkableCity.transport,
      shape: {
        kind: 'bounds',
        bounds: { southWest: { lat: 63.0, lng: -151.5 }, northEast: { lat: 63.6, lng: -150.5 } },
      },
    });
    expect(matrixModeFor(nationalPark)).toBe('car');

    const driving = scopeFor();
    expect(matrixModeFor(driving)).toBe('car');
  });

  it('writes the measured drive from base onto every place it keeps', async () => {
    /**
     * `travelFromBase` was left at zero on every compiled place while the matrix
     * knew better, and three layers read it: the candidate-quality assessor
     * scores route feasibility from it, the regional-expansion helper decides
     * what counts as a day trip from it, and the board renders it.
     *
     * A live Bali build is what that costs. The board offered nine places as
     * zero-minute hops, auto-pick took all nine, and the planner then refused
     * every one of them for exceeding a daily driving limit — because the board
     * and the planner were reading different worlds and only one of them had the
     * travel times.
     */
    const result = await compileRegion({
      compilationId: 'region-travel-from-base',
      scope: scopeFor(),
      dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      months: [8],
      providers: packBackedProviders(SYNTHETIC_WORLDS.remote_road!),
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);

    const matrix = result.region.travelTimes;
    const baseId = result.region.bases.find(
      (base) => base.id === result.region.primaryBaseId,
    )!.routingId;
    const baseIndex = matrix.ids.indexOf(baseId);
    expect(baseIndex).toBeGreaterThanOrEqual(0);

    // Not merely non-zero — equal to what the matrix measured, which is the only
    // way the board and the planner can agree.
    for (const place of result.region.places) {
      const index = matrix.ids.indexOf(place.id);
      expect(place.travelFromBase.driveMinutes).toBe(
        Math.round(matrix.minutes[baseIndex]![index]!),
      );
    }
    expect(result.region.places.some((place) => place.travelFromBase.driveMinutes > 0)).toBe(true);
  });

  it('claims only the places a base can actually be routed to', async () => {
    const result = await compileRegion({
      compilationId: 'region-base-reach',
      scope: scopeFor(),
      dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      months: [8],
      providers: packBackedProviders(SYNTHETIC_WORLDS.ferry_island!),
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);

    const placeIds = new Set(result.region.places.map((place) => place.id));
    for (const base of result.region.bases) {
      // A live artifact claimed forty-three places within reach of a base whose
      // region held thirty-seven, because the claim was made before the matrix
      // dropped the unroutable ones.
      expect(base.placesWithinReach.length).toBeLessThanOrEqual(placeIds.size);
      for (const id of base.placesWithinReach) expect(placeIds.has(id)).toBe(true);
    }
  });

  it('never puts the same routing node in the matrix twice', async () => {
    /**
     * The regression this exists for.
     *
     * A food venue is priced against a node the matrix already holds — the base
     * it sleeps beside, or the trailhead it sits at. Adding that node a second
     * time makes the matrix schema refuse the whole artifact, and the traveller
     * is told "we do not have usable travel times for this region" about a
     * region whose travel times were fine.
     */
    const result = await compileRegion({
      compilationId: 'region-routing-ids',
      scope: scopeFor(),
      dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
      months: [8],
      providers: packBackedProviders(SYNTHETIC_WORLDS.transit_city!),
      now: new Date('2026-07-31T00:00:00.000Z'),
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const ids = result.region.travelTimes.ids;
    expect(new Set(ids).size).toBe(ids.length);
    // And every venue still has a row, rather than being quietly dropped.
    for (const venue of result.region.food?.venues ?? []) {
      expect(ids).toContain(venue.routingId);
    }
  });

  it('still compiles when no backbone provider is configured, and says the stages were skipped', async () => {
    const stages: { stage: string; status: string }[] = [];
    const result = await compileRegion({
      compilationId: 'region-no-backbone',
      // The six original worlds carry their own region id on their venues, so
      // the scope has to be the one that world would have produced.
      scope: scopeFor({ destinationCandidateId: 'transit-city' }),
      dates: ['2026-08-01', '2026-08-02'],
      months: [8],
      providers: fakeProviders(SYNTHETIC_WORLDS.transit_city!),
      now: new Date('2026-07-31T00:00:00.000Z'),
      onStage: (record) => stages.push({ stage: record.stage, status: record.status }),
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.region.regionPack).toBeUndefined();
    /*
     * Recorded as `skipped`, not omitted — and this assertion used to say the
     * opposite.
     *
     * A stage that is simply never reported leaves the progress screen holding
     * it at "Working" for ever, because nothing ever arrives to close it. The
     * comment beside the code always promised these were marked skipped; the
     * `else` branch that would have done it did not exist, and this test pinned
     * the absence in place.
     */
    const shaping = stages.filter((entry) => entry.stage === 'building_region_pack');
    expect(shaping.length).toBeGreaterThan(0);
    // What matters is that it *terminates*. A stage may be announced as running
    // first; what it may not do is never arrive anywhere.
    expect(shaping[shaping.length - 1]?.status).toBe('skipped');
  });
});
