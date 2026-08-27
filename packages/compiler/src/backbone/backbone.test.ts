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
import {
  buildInventory,
  DEFAULT_INVENTORY_LIMITS,
  foodVenueFromRecord,
  packLicences,
} from './inventory';
import {
  canonicalUrl,
  compare,
  linkRecords,
  namesFromCollapsedTwins,
  supersededRecordIds,
} from './link';
import { buildTripScopeOverlay } from './overlay';
import {
  CELL_OVERLAP_DEGREES,
  MAX_CELL_DEGREES,
  MAX_CELLS,
  MIN_CELL_DEGREES,
  boundsContain,
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

  it('schedules the whole of a country-shaped scope, with priority as read order only', () => {
    /*
     * The live failure this pins, in synthetic geography: a country-breadth
     * scope partitions to more cells than the old global cap of 24, and the
     * cap kept the cells nearest the centroid — for a coastal country that is
     * the empty interior — while dropping the edge cells where the biggest
     * city stands. Ground that is dropped here is never *scheduled* to be
     * read, and no budget, ranking or retention downstream can recover it.
     *
     * The cap was a read-cost proxy from before the byte-priced scan. The scan
     * now prices every read from parquet footers before spending, so a cell
     * whose ground holds nothing costs nothing — cell count is not the cost,
     * overlapping compressed bytes are. Priority survives as the read-order
     * hint; it must never again decide which ground exists.
     */
    const bounds = { southWest: { lat: -55, lng: -40 }, northEast: { lat: -51, lng: -30.6 } };
    const plan = partitionScope(scopeFor({ breadth: 'country', shape: { kind: 'bounds', bounds } }));
    /* The raw grid genuinely exceeds the old cap of 24 — that is the case under test. */
    expect(plan.cells.length).toBeGreaterThan(24);
    expect(plan.droppedCells).toBe(0);

    /* Positions on the scope's own edges — where a coastal capital stands. */
    const positions = [
      { lat: -54.9, lng: -39.9 }, // south-west corner
      { lat: -51.1, lng: -30.7 }, // north-east corner
      { lat: -53, lng: -39.95 }, // west edge, centre latitude
      { lat: -54.95, lng: -35 }, // south edge
      { lat: -51.05, lng: -35 }, // north edge
      { lat: -53, lng: -30.65 }, // east edge
    ];
    for (const position of positions) {
      expect(plan.cells.some((cell) => boundsContain(cell.bounds, position))).toBe(true);
    }

    /* Priority still orders reads from the traveller outward, ties stable. */
    const centre = { lat: -53, lng: -35.3 };
    const byPriority = [...plan.cells].sort((a, b) => b.priority - a.priority);
    const distanceOf = (cell: (typeof plan.cells)[number]): number => {
      const lat = (cell.bounds.southWest.lat + cell.bounds.northEast.lat) / 2 - centre.lat;
      const lng =
        ((cell.bounds.southWest.lng + cell.bounds.northEast.lng) / 2 - centre.lng) *
        Math.cos((centre.lat * Math.PI) / 180);
      return Math.hypot(lat, lng);
    };
    const distances = byPriority.map(distanceOf);
    expect(distances[0]).toBeLessThanOrEqual(Math.min(...distances) + 0.001);
    expect(byPriority[0]!.priority).toBeGreaterThan(byPriority.at(-1)!.priority);
  });

  it('keeps the coastal rim of a reach circle in the schedule, not only the interior', () => {
    /*
     * The same guarantee for the shape the live scope actually had: a reach
     * circle over a country. Its bounding grid clips the four corners the
     * circle never reaches, and everything that survives the trim must be
     * scheduled — a capital sits on a coast far more often than at a
     * country's centroid.
     */
    const centre = { lat: -53, lng: -35 };
    const plan = partitionScope(
      scopeFor({
        breadth: 'country',
        shape: { kind: 'radius', center: centre, radiusKm: 220 },
      }),
    );
    expect(plan.cells.length).toBeGreaterThan(24);
    expect(plan.droppedCells).toBe(0);

    /* A "capital" near the circle's western rim, at the centre's latitude. */
    const lngDelta = 220 / (111 * Math.cos((centre.lat * Math.PI) / 180));
    const westRim = { lat: centre.lat, lng: centre.lng - lngDelta * 0.97 };
    expect(plan.cells.some((cell) => boundsContain(cell.bounds, westRim))).toBe(true);
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

  it('sees through word segmentation between same-kind records at identity distance', () => {
    /*
     * The real shape: one catalogue writes a compound name as one word, another
     * as two, and `normalizeName` rightly keeps the space — so the two name
     * sets share nothing and a single place stayed two candidates. The folded
     * comparison closes exactly that, and only inside the bounded branch.
     */
    const one = record({ id: 'places:seg-a', sourceId: 'seg-a', name: 'Northgate Garden' });
    const two = record({
      id: 'places:seg-b',
      sourceId: 'seg-b',
      name: 'North Gate Garden',
      coordinates: { lat: 40.70045, lng: -74 },
    });
    const link = compare(one, two);
    expect(link?.kind).toBe('same_entity');
    expect(link?.evidence).toContain('name_and_category_and_proximity');
  });

  it('does not let a folded name match records that plan differently, or at a distance', () => {
    /* Different planning role: the fold never fires, however close. */
    const garden = record({ id: 'places:seg-c', sourceId: 'seg-c', name: 'Northgate Garden' });
    const cafe = record({
      id: 'places:seg-d',
      sourceId: 'seg-d',
      name: 'North Gate Garden',
      planningRole: 'food',
      sourceCategory: 'cafe',
      sourceCategoryPath: ['food_and_drink', 'cafe'],
      coordinates: { lat: 40.70045, lng: -74 },
    });
    expect(compare(garden, cafe)).toBeNull();
    /*
     * Distance: an *exact* name at five kilometres is a namesake worth flagging
     * as `name_only`; a segmentation-folded one is not evidence of anything.
     */
    const far = record({
      id: 'places:seg-e',
      sourceId: 'seg-e',
      name: 'North Gate Garden',
      coordinates: { lat: 40.745, lng: -74 },
    });
    expect(compare(garden, far)).toBeNull();
  });

  it('folds a designated area named with and without its designation into one entity', () => {
    /*
     * The measured country-pack shape: the geographic layer publishes the
     * national park as a polygon under a local-language primary with the
     * "<name> National Park" form among its alternates, and the place catalogue
     * publishes the same park as a POI under the proper name alone. Exact and
     * segmentation folds both refuse the pair — the names differ by exactly the
     * designation's generic noun — so two collapse components formed for one
     * canonical place and the served board seated the same park twice.
     */
    const polygon = record({
      id: 'land_use:sanctuary-polygon',
      layerId: 'land_use',
      sourceId: 'sanctuary-polygon',
      name: 'Parque Nacional Silverbrook',
      alternateNames: ['Silverbrook National Park'],
      sourceCategory: 'national_park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.702, lng: -74.002 },
      bounds: {
        southWest: { lat: 40.688, lng: -74.02 },
        northEast: { lat: 40.716, lng: -73.984 },
      },
    });
    const bareNamePoi = record({
      id: 'places:sanctuary-poi',
      sourceId: 'sanctuary-poi',
      name: 'Silverbrook',
      sourceCategory: 'national_park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7005, lng: -74.0005 },
    });
    const link = compare(polygon, bareNamePoi);
    expect(link?.kind).toBe('same_entity');
    expect(link?.evidence).toContain('name_and_category_and_proximity');
  });

  it('keeps one survivor for a designated area split across designation spellings', () => {
    /*
     * The whole component, as the pack held it: the polygon, the bare-name POI
     * and a park-category record carrying the designated form. Pre-fold the
     * exact-name pair collapsed and the bare-name POI stayed its own entity —
     * two survivors, two seats. A group the linker says is one thing keeps
     * exactly one record.
     */
    const polygon = record({
      id: 'land_use:sanctuary-polygon',
      layerId: 'land_use',
      sourceId: 'sanctuary-polygon',
      name: 'Parque Nacional Silverbrook',
      alternateNames: ['Silverbrook National Park'],
      sourceCategory: 'national_park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.702, lng: -74.002 },
      bounds: {
        southWest: { lat: 40.688, lng: -74.02 },
        northEast: { lat: 40.716, lng: -73.984 },
      },
    });
    const bareNamePoi = record({
      id: 'places:sanctuary-poi',
      sourceId: 'sanctuary-poi',
      name: 'Silverbrook',
      sourceCategory: 'national_park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7005, lng: -74.0005 },
    });
    const parkRecord = record({
      id: 'places:sanctuary-park',
      sourceId: 'sanctuary-park',
      name: 'Silverbrook National Park',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.712, lng: -73.99 },
    });
    const records = [polygon, bareNamePoi, parkRecord];
    const superseded = supersededRecordIds(records, linkRecords(records));
    expect(superseded.size).toBe(2);
  });

  it('never detaches a generic word from a plain park, a premises kind, or at a distance', () => {
    /*
     * `park` is not a designation kind: for a municipal park the generic word
     * is part of the proper name, and detaching it folded a control
     * metropolis's headline garden onto a differently-catalogued twin. The two
     * below stay two records however close they stand.
     */
    const namedPark = record({
      id: 'places:plain-park',
      sourceId: 'plain-park',
      name: 'Greenhollow National Park',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
    });
    const bareNeighbour = record({
      id: 'places:plain-bare',
      sourceId: 'plain-bare',
      name: 'Greenhollow',
      sourceCategory: 'park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7002, lng: -74.0002 },
    });
    expect(compare(namedPark, bareNeighbour)).toBeNull();

    /* Family-gated on both sides: a lake wearing the reserve's proper name is
     * a neighbour, not the reserve. */
    const reserve = record({
      id: 'places:res',
      sourceId: 'res',
      name: 'Riverport Nature Reserve',
      sourceCategory: 'nature_reserve',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
    });
    const lake = record({
      id: 'places:res-lake',
      sourceId: 'res-lake',
      name: 'Riverport',
      sourceCategory: 'lake',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7003, lng: -74.0001 },
    });
    expect(compare(reserve, lake)).toBeNull();

    /* And the fold never reaches past the identity radius or mints name_only. */
    const farPoi = record({
      id: 'places:far-poi',
      sourceId: 'far-poi',
      name: 'Silverbrook',
      sourceCategory: 'national_park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      coordinates: { lat: 40.85, lng: -74 },
    });
    const namedReserve = record({
      id: 'places:far-named',
      sourceId: 'far-named',
      name: 'Silverbrook National Park',
      sourceCategory: 'national_park',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
    });
    expect(compare(namedReserve, farPoi)).toBeNull();
  });

  it('measures separation to a published boundary, not to a representative point', () => {
    /*
     * The theme-park pair, in its measured geometry: a polygon over a kilometre
     * across whose representative point sits mid-ground, and a POI at the gate
     * ~100 m outside the boundary — 725 m from the point, so every radius
     * failed and the same park went forward twice, once per script. The name
     * lives only in the polygon's alternates and differs from the POI's by one
     * space, which is the whole cross-script case in one pair.
     */
    const polygon = record({
      id: 'land:park-polygon',
      layerId: 'land',
      sourceId: 'park-polygon',
      name: '青浜遊園地',
      alternateNames: ['Aohama Fun Land'],
      sourceCategory: 'theme_park',
      sourceCategoryPath: ['attractions_and_activities', 'theme_park'],
      coordinates: { lat: 40.63265, lng: -73.99815 },
      bounds: {
        southWest: { lat: 40.629, lng: -74.0043 },
        northEast: { lat: 40.6363, lng: -73.992 },
      },
    });
    const gatePoi = record({
      id: 'places:park-poi',
      sourceId: 'park-poi',
      name: 'Aohama Funland',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['attractions_and_activities', 'amusement_park'],
      coordinates: { lat: 40.62922, lng: -74.00546 },
    });
    const link = compare(polygon, gatePoi);
    expect(link?.kind).toBe('same_entity');
    /* The recorded separation is to the boundary the source published. */
    expect(link?.separationMetres).toBeLessThan(150);
  });

  it('treats a shared canonical page as identity where no script can agree', () => {
    /*
     * A catalogue records one palace once per language: two records at the same
     * point, primaries in scripts that never overlap, no alternates — so no
     * name comparison can ever succeed — both pointing at the same *page*. They
     * used to survive as `possible_duplicate`, which collapses nothing, and the
     * board showed the palace twice.
     */
    const vietnamese = record({
      id: 'places:pal-a',
      sourceId: 'pal-a',
      name: 'Cung điện Aohama',
      sourceCategory: 'palace',
      sourceCategoryPath: ['attractions_and_activities', 'palace'],
      websiteCandidates: ['http://palace.example/guide/visit.html'],
    });
    const cyrillic = record({
      id: 'places:pal-b',
      sourceId: 'pal-b',
      name: 'Аохамский дворец',
      sourceCategory: 'palace',
      sourceCategoryPath: ['attractions_and_activities', 'palace'],
      websiteCandidates: ['http://palace.example/guide/visit.html'],
      coordinates: { lat: 40.70001, lng: -74.00001 },
    });
    const link = compare(vietnamese, cyrillic);
    expect(link?.kind).toBe('same_entity');
    expect(link?.evidence).toContain('shared_canonical_website');
  });

  it('does not read a bare shared domain, or a shared page at a distance, as identity', () => {
    /* The chain case: every branch points at the homepage. Names disagree. */
    const branchA = record({
      id: 'places:br-a',
      sourceId: 'br-a',
      name: 'Cung điện Aohama',
      websiteCandidates: ['http://palace.example/'],
    });
    const branchB = record({
      id: 'places:br-b',
      sourceId: 'br-b',
      name: 'Аохамский дворец',
      websiteCandidates: ['http://palace.example/'],
      coordinates: { lat: 40.70001, lng: -74.00001 },
    });
    const near = compare(branchA, branchB);
    expect(near?.kind ?? 'none').not.toBe('same_entity');
    expect(near?.kind ?? 'none').not.toBe('probable_same_entity');
    /* And the same page five kilometres apart is two things sharing a page. */
    const farTwin = record({
      id: 'places:br-c',
      sourceId: 'br-c',
      name: 'Аохамский дворец',
      websiteCandidates: ['http://palace.example/guide/visit.html'],
      coordinates: { lat: 40.745, lng: -74 },
    });
    const pageA = record({
      id: 'places:br-d',
      sourceId: 'br-d',
      name: 'Cung điện Aohama',
      websiteCandidates: ['http://palace.example/guide/visit.html'],
    });
    expect(compare(pageA, farTwin)?.kind).toBe('colocated_distinct');
  });

  it('keeps a page shared beyond the pair from merging anything but records on one point', () => {
    /*
     * The full-pack shape of the operator-page case: three same-role records
     * wear one page. Two of them coincide to the metre — one catalogue row
     * recorded once per language — and the third is a pavilion thirty metres
     * away, well inside the identity radius, that the operator's site is
     * stamped onto. That third sharer is what proves the page is the
     * operator's, not one place's: the count refuses it, and only the
     * coincidence carries the twins. On a real pack the version without the
     * count merged a theme park, its polygon and three rides into one entity
     * whose survivor was a canoe ride.
     */
    const page = ['http://palace.example/guide/visit.html'];
    const twinA = record({
      id: 'places:tw-a',
      sourceId: 'tw-a',
      name: 'Cung điện Aohama',
      sourceCategory: 'palace',
      sourceCategoryPath: ['attractions_and_activities', 'palace'],
      websiteCandidates: page,
    });
    const twinB = record({
      id: 'places:tw-b',
      sourceId: 'tw-b',
      name: 'Аохамский дворец',
      sourceCategory: 'palace',
      sourceCategoryPath: ['attractions_and_activities', 'palace'],
      websiteCandidates: page,
    });
    const pavilion = record({
      id: 'places:tw-c',
      sourceId: 'tw-c',
      name: 'Aohama Pavilion',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['attractions_and_activities', 'historic_site'],
      websiteCandidates: page,
      coordinates: { lat: 40.70027, lng: -74 },
    });
    const records = [twinA, twinB, pavilion];
    const superseded = supersededRecordIds(records, linkRecords(records));
    expect(superseded.size).toBe(1);
    expect(superseded.has('places:tw-c')).toBe(false);
  });

  it('carries every script’s names onto the survivor of a cross-script collapse', () => {
    /*
     * PR-DISC-06's mechanism, over the collapses the cross-script matching now
     * produces: whichever record survives, the names the other one published —
     * including the only Latin form anywhere in the pair — reach the survivor,
     * so the card a traveller sees can be read.
     */
    const polygon = record({
      id: 'land:cs-polygon',
      layerId: 'land',
      sourceId: 'cs-polygon',
      name: '青浜遊園地',
      alternateNames: ['Aohama Fun Land'],
      sourceCategory: 'theme_park',
      sourceCategoryPath: ['attractions_and_activities', 'theme_park'],
      coordinates: { lat: 40.63265, lng: -73.99815 },
      bounds: {
        southWest: { lat: 40.629, lng: -74.0043 },
        northEast: { lat: 40.6363, lng: -73.992 },
      },
      sources: [
        { dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' },
        { dataset: 'other', licenceId: 'ODbL-1.0' },
      ],
    });
    const gatePoi = record({
      id: 'places:cs-poi',
      sourceId: 'cs-poi',
      name: 'Aohama Funland',
      sourceCategory: 'amusement_park',
      sourceCategoryPath: ['attractions_and_activities', 'amusement_park'],
      coordinates: { lat: 40.62922, lng: -74.00546 },
    });
    const records = [polygon, gatePoi];
    const links = linkRecords(records);
    const superseded = supersededRecordIds(records, links);
    expect(superseded.size).toBe(1);
    const survivor = records.find((entry) => !superseded.has(entry.id))!;
    const inherited = namesFromCollapsedTwins(records, links).get(survivor.id) ?? [];
    const surviving = new Set(
      [survivor.name, ...survivor.alternateNames, ...inherited].map((name) => name.toLowerCase()),
    );
    /* Both scripts survive, wherever each was published. */
    expect([...surviving].some((name) => name.includes('aohama'))).toBe(true);
    expect(surviving.has('青浜遊園地')).toBe(true);
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

  /**
   * THE SAME PARK, ONCE IN EACH LANGUAGE.
   *
   * The shape that put four copies of one harbour and three of one canal at the
   * top of live packs, reduced to its smallest form: a park published by the
   * place catalogue under its local name and again under its English one, plus
   * the land-use polygon of the same park. The polygon matches *both* names; the
   * two place records match neither each other's, because neither carries the
   * other's language as an alternate.
   *
   * The collapse used to walk the links one at a time and skip any link whose
   * partner had already gone, so the polygon — the thinner record of the three,
   * as a geometry-layer record usually is — was dropped by the first link and
   * the second link, the one that would have dropped a place record, was skipped
   * because its partner was gone. Both names went to the board. Identity is
   * transitive, and this is the assertion that the collapse is too.
   */
  it('collapses a group of records the linker joined only through a third', () => {
    /* Two provenance rows apiece, so the hub is the *weakest* of the three. */
    const contributed = [
      { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' as const },
      { dataset: 'other', licenceId: 'CDLA-Permissive-2.0' as const },
    ];
    const local = record({
      id: 'places:local',
      name: '東陽公園',
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      sources: contributed,
      coordinates: { lat: 40.7, lng: -74 },
    });
    const english = record({
      id: 'places:english',
      sourceId: 'english',
      name: 'Toyo Park',
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      sources: contributed,
      coordinates: { lat: 40.70005, lng: -74.00005 },
    });
    const polygon = record({
      id: 'land_use:polygon',
      layerId: 'land_use',
      sourceId: 'polygon',
      name: '東陽公園',
      alternateNames: ['Toyo Park'],
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      coordinates: { lat: 40.70002, lng: -74.00002 },
    });

    const records = [local, english, polygon];
    const links = linkRecords(records);
    // The premise: the polygon links to both names, and the two names do not
    // link to each other. Without that this test would prove nothing.
    expect(compare(local, english)).toBeNull();
    const superseded = supersededRecordIds(records, links);
    expect(superseded.size).toBe(2);
    expect(records.filter((entry) => !superseded.has(entry.id))).toHaveLength(1);
  });

  /**
   * A chain of segments is one watercourse, and the answer may not depend on
   * which end the linker reached first.
   *
   * Three records of one canal, where the two outer segments are far enough
   * apart to be only `name_only` and each links to the middle one. Reversing the
   * input reverses the link order, and the old pairwise collapse gave a
   * different survivor count for each direction — which also meant the pack's
   * content hash, which covers what survives, depended on I/O order.
   */
  it('leaves one survivor per group whatever order the records arrive in', () => {
    const segment = (id: string, lat: number, contributors: number): SourceRecord =>
      record({
        id,
        sourceId: id,
        layerId: 'water',
        name: '朝潮運河',
        sourceCategory: 'canal',
        sourceCategoryPath: ['physical'],
        planningRole: 'outdoor',
        sources: Array.from({ length: contributors }, (_, index) => ({
          dataset: `contributor-${index}`,
          licenceId: 'ODbL-1.0' as const,
        })),
        coordinates: { lat, lng: -74 },
      });
    /* The middle segment is the thinnest, so it is the one the collapse drops first. */
    const records = [
      segment('water:north', 40.7018, 2),
      segment('water:middle', 40.7009, 1),
      segment('water:south', 40.7, 2),
    ];

    const forward = supersededRecordIds(records, linkRecords(records));
    const backward = supersededRecordIds([...records].reverse(), linkRecords([...records].reverse()));
    expect(forward.size).toBe(2);
    expect([...forward].sort()).toEqual([...backward].sort());
  });

  /**
   * THE ROLE GATE, AND WHY IT STAYS.
   *
   * `name_and_category_and_proximity` requires the two records to plan the same
   * way, and the obvious complaint is that it refuses real twins — a monument
   * filed as a historic site by one layer and as parkland by another.
   *
   * It does, and the trade is measured rather than argued. Over a metro box
   * compiled from the live catalogue (release 2026-07-22.0) at the production
   * retention budget, 46 pairs matched on name within 1.5 km while planning
   * differently. Two were genuine twins. The other forty-four were **a thing
   * named after another thing** — a station, a bus stop, a neighbourhood polygon
   * or a pharmacy carrying the name of the park beside it. Merging on the name
   * alone would move a park to a railway station's coordinates or replace it
   * with a chemist, and the survivor is chosen by evidence rather than by role,
   * so there is no guarantee the thing left standing is the one worth visiting.
   *
   * The pairs that are genuinely one thing and share neither an identifier nor a
   * domain are the price. The ones that share either are already carried by the
   * routes above — the case that named this complaint, a broadcast tower and the
   * observation deck two metres from it, links today on a shared website.
   */
  it('refuses a name match between records that plan differently, and says what it costs', () => {
    const river = record({
      id: 'water:river',
      layerId: 'water',
      sourceId: 'river',
      name: '立会川',
      sourceCategory: 'river',
      sourceCategoryPath: ['physical'],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7, lng: -74 },
    });
    /* The station named after it, a hundred metres away — inside every distance
     * this file uses, so the role is the only thing refusing the merge. */
    const stationOfTheSameName = record({
      id: 'infrastructure:station',
      layerId: 'infrastructure',
      sourceId: 'station',
      name: '立会川',
      sourceCategory: 'railway_station',
      sourceCategoryPath: ['transit'],
      planningRole: 'gateway',
      coordinates: { lat: 40.7009, lng: -74 },
    });
    const namedAfterIt = supersededRecordIds(
      [river, stationOfTheSameName],
      linkRecords([river, stationOfTheSameName]),
    );
    expect(namedAfterIt.size).toBe(0);
    expect(compare(river, stationOfTheSameName)?.evidence).not.toContain(
      'name_and_category_and_proximity',
    );

    /*
     * And the same gate on a pair that really is one thing, kept here so the
     * cost of the refusal is written down beside the reason for it. Both records
     * survive; the link records that they look alike.
     */
    const marker = record({
      id: 'places:marker',
      name: '大森貝塚遺跡庭園',
      sourceCategory: 'historic_site',
      sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
      planningRole: 'attraction',
      coordinates: { lat: 40.7, lng: -74 },
    });
    const grounds = record({
      id: 'land_use:grounds',
      layerId: 'land_use',
      sourceId: 'grounds',
      name: '大森貝塚遺跡庭園',
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      coordinates: { lat: 40.70003, lng: -74 },
    });
    expect(supersededRecordIds([marker, grounds], linkRecords([marker, grounds])).size).toBe(0);
    expect(compare(marker, grounds)?.kind).toBe('possible_duplicate');

    /* The route that does carry a cross-role twin: a domain both sources publish. */
    const tower = record({
      id: 'infrastructure:tower',
      layerId: 'infrastructure',
      sourceId: 'tower',
      name: '東京タワー',
      sourceCategory: 'communication_tower',
      sourceCategoryPath: ['communication'],
      planningRole: 'infrastructure',
      websiteCandidates: ['https://www.example-tower.jp/'],
      coordinates: { lat: 40.7, lng: -74 },
    });
    const deck = record({
      id: 'places:deck',
      name: '東京タワー',
      sourceCategory: 'observatory',
      sourceCategoryPath: ['arts_and_entertainment', 'science_attraction', 'observatory'],
      planningRole: 'attraction',
      websiteCandidates: ['https://example-tower.jp'],
      coordinates: { lat: 40.700018, lng: -74 },
    });
    expect(compare(tower, deck)?.kind).toBe('same_entity');
    expect(supersededRecordIds([tower, deck], linkRecords([tower, deck])).size).toBe(1);
  });

  /**
   * A GLOSS IN BRACKETS IS A SECOND NAME, AND IT WAS BEING READ AS PART OF A
   * FIRST ONE.
   *
   * Catalogues publish a translation inside the primary field. Compared whole,
   * the parenthesised row has *no* name in common with the twin filed under the
   * bare form, so nothing links them and both reach the board. On the stored
   * Tokyo pack of 2026-08-12 that is one of the reasons the imperial palace
   * grounds appeared several times over, which §8.8 forbids by name.
   */
  it('matches a name published with its translation in brackets', () => {
    const listed = record({
      id: 'places:garden',
      name: '東御苑 (East Gardens)',
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7, lng: -74 },
    });
    const mapped = record({
      id: 'land_use:garden',
      layerId: 'land_use',
      sourceId: 'garden',
      name: '東御苑',
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7005, lng: -74 },
    });
    expect(compare(listed, mapped)?.evidence).toContain('name_and_category_and_proximity');
    expect(supersededRecordIds([listed, mapped], linkRecords([listed, mapped])).size).toBe(1);

    /* Two different places disambiguated in brackets are still two places. */
    const north = record({
      id: 'places:north',
      name: 'Springfield (North)',
      coordinates: { lat: 40.7, lng: -74 },
    });
    const south = record({
      id: 'places:south',
      name: 'Springfield (South)',
      coordinates: { lat: 40.9, lng: -74 },
    });
    expect(supersededRecordIds([north, south], linkRecords([north, south])).size).toBe(0);
  });

  /**
   * A DIRECTORY INDEX IS THE DIRECTORY.
   *
   * `nps.gov/stli` and `nps.gov/stli/index.htm` are one page, and on the stored
   * New York pack they are what two of the four Statue of Liberty rows point
   * at. Compared literally they were two pages, so the one piece of hard
   * identity evidence those records carried said nothing.
   */
  it('reads a directory index as the directory it is in', () => {
    expect(canonicalUrl('https://www.parks.example.gov/stli/index.htm')).toBe(
      canonicalUrl('http://parks.example.gov/stli'),
    );
    expect(canonicalUrl('https://parks.example.gov/stli/index.php')).toBe('parks.example.gov/stli');
    expect(canonicalUrl('https://parks.example.gov/stli/default.html')).toBe(
      'parks.example.gov/stli',
    );
    /* A page that merely ends in a filename is still its own page. */
    expect(canonicalUrl('https://parks.example.gov/stli/visit.html')).toBe(
      'parks.example.gov/stli/visit.html',
    );
  });

  /**
   * THE NAME A COLLAPSE WOULD OTHERWISE TAKE WITH IT.
   *
   * The survivor of a same-entity group carries its own data and none of the
   * loser's — including, on a dense non-Latin pack, the only name a traveller
   * can read. 71 of 123 shortlisted Tokyo cards led in a script the reader
   * cannot read while the land-use record the linker had just dropped held
   * "Kitanomaru Park". Names cross; nothing else does.
   */
  it('keeps the readable name a collapsed twin published', () => {
    const listed = record({
      id: 'places:park',
      name: '北の丸公園',
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      attributes: { operator: 'Somebody' },
      sources: [
        { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' },
        { dataset: 'primary-2', licenceId: 'CDLA-Permissive-2.0' },
      ],
      coordinates: { lat: 40.7, lng: -74 },
    });
    const mapped = record({
      id: 'land_use:park',
      layerId: 'land_use',
      sourceId: 'park',
      name: '北の丸公園',
      alternateNames: ['Kitanomaru Park', 'Parc Kitanomaru'],
      sourceCategory: 'park',
      sourceCategoryPath: ['park'],
      planningRole: 'outdoor',
      coordinates: { lat: 40.7003, lng: -74 },
    });
    const links = linkRecords([listed, mapped]);
    /* The better-evidenced record still survives; only the names travel. */
    expect([...supersededRecordIds([listed, mapped], links)]).toEqual(['land_use:park']);
    expect(namesFromCollapsedTwins([listed, mapped], links).get('places:park')).toContain(
      'Kitanomaru Park',
    );
    /* Nothing else crosses: a licence nobody chose is what this file forbids. */
    expect(namesFromCollapsedTwins([listed, mapped], links).get('places:park')).not.toContain(
      '北の丸公園',
    );
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

  it('gates a worship building on evidence and keeps a monument an attraction', () => {
    /*
     * The congregation guarantee, restated where its mechanism now lives. The
     * `place_of_worship` node used to be a support stop, which kept storefront
     * congregations off boards *and* typed a city's most famous temple as
     * plumbing — the same word carries both, and only evidence can tell them
     * apart. So the node is a witness-gated experience kind: an unwitnessed
     * congregation is refused by the significance gate (see the inventory test
     * of the same name below), a witnessed temple is finally an attraction.
     */
    const congregation = classifySourceCategory({
      category: 'christian_place_of_worship',
      path: ['cultural_and_historic', 'religious_organization', 'place_of_worship'],
    });
    expect(congregation.role).toBe('attraction');
    expect(congregation.requiresSignificanceEvidence).toBe(true);

    const temple = classifySourceCategory({ category: 'hindu_temple' });
    expect(temple.role).toBe('attraction');
    expect(temple.category).toBe('historic_site');
    expect(temple.requiresSignificanceEvidence).toBe(false);
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
      /*
       * The water palace carries an open identifier, because `historic_site` is
       * an *assertion about* a building rather than a kind of building and now
       * needs a witness — see the taxonomy's note on the leaf. A real palace has
       * one; the six condominiums a live board offered under the same leaf did
       * not. Without it this fixture would be asserting that a role separation
       * kept a record the significance gate had already removed.
       */
      { id: 'h1', name: 'Old Water Palace', category: 'historic_site', path: ['cultural_and_historic', 'historic_site'], wikidataId: 'Q4242' },
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
        ...(entry.wikidataId ? { wikidataId: entry.wikidataId } : {}),
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

  /**
   * THE CONGREGATION GUARANTEE AND THE FAMOUS TEMPLE, ONE VOCABULARY, TWO
   * VERDICTS.
   *
   * A global catalogue publishes both under the same words —
   * `*_place_of_worship` beneath a `place_of_worship` node — and for a release
   * the node was filed as a support stop, which held the storefront
   * congregations off boards by holding *every* worship building off them: on
   * a fresh dense-metro pack the destination's canonical temples normalised to
   * a cash machine's retention priority and were evicted unread. The node is
   * now a witness-gated experience kind, so the guarantee this test carries is
   * two-directional and the direction is decided by evidence, not vocabulary:
   * a worship record with a place-attesting witness is admitted as a visitable
   * candidate, and its unwitnessed twin — the neighbourhood chapel, the
   * storefront congregation — reaches neither the candidate list nor the
   * support portfolio. §29 A's live fixture asserts the same refusal end to
   * end; this is the compiler-level twin of it.
   */
  it('admits a witnessed worship building and refuses its unwitnessed twin everywhere', () => {
    const worship = (overrides: Partial<SourceRecord>) =>
      record({
        sourceCategory: 'buddhist_place_of_worship',
        sourceCategoryPath: ['cultural_and_historic', 'religious_organization', 'place_of_worship'],
        planningRole: 'attraction',
        ...overrides,
      });
    const witnessed = worship({
      id: 'places:great-temple',
      sourceId: 'great-temple',
      name: 'Great Gate Temple',
      wikidataId: 'Q424242',
      attributes: { wikipedia: 'aa:Great Gate Temple' },
      coordinates: { lat: 40.7, lng: -74 },
    });
    const unwitnessed = worship({
      id: 'places:street-chapel',
      sourceId: 'street-chapel',
      name: 'Fourth Street Congregation Hall',
      coordinates: { lat: 40.71, lng: -74.01 },
    });

    const inventory = buildInventory({ pack: packWith([witnessed, unwitnessed]), scope });

    const candidateNames = inventory.candidates.map((entry) => entry.place.name);
    expect(candidateNames).toContain('Great Gate Temple');
    expect(candidateNames).not.toContain('Fourth Street Congregation Hall');
    /* Refused, not demoted: a chapel is not a support stop either. */
    expect(inventory.supporting.map((entry) => entry.place.name)).not.toContain(
      'Fourth Street Congregation Hall',
    );

    /* And the admitted temple is an experience a traveller can be offered. */
    const temple = inventory.candidates.find((entry) => entry.place.name === 'Great Gate Temple')!;
    expect(isVisitableRole(planningRoleOfPlace(temple.place)!)).toBe(true);
  });

  it('lets a cross-layer knowledge-base twin rescue a branch-guessed record', () => {
    /*
     * The witness the eligibility layer cannot see on its own: the places row
     * carries no identifier and no article — its evidence lives on a twin in
     * another layer, resolved by `resolveKnowledgeBaseEvidence` and visible only
     * to the standing built inside `buildInventory`. The donor carries a
     * different planning role, so the linker (which folds only equal roles)
     * keeps them two records, while the knowledge twin (which matches on the
     * taxonomy kind) still donates across the 220 m between them. The donor
     * publishes the shared name only as an alternate, so the assertion on the
     * recipient's name cannot be satisfied by the donor being admitted instead.
     */
    const recipient = record({
      id: 'places:silk-poi',
      sourceId: 'silk-poi',
      name: 'Old Silk Market',
      sourceCategory: 'a_leaf_no_table_has_seen',
      sourceCategoryPath: ['arts_and_entertainment', 'a_leaf_no_table_has_seen'],
      coordinates: { lat: 40.7, lng: -74 },
    });
    const donor = record({
      id: 'land:silk-ground',
      layerId: 'land',
      sourceId: 'silk-ground',
      name: '旧絹市場',
      alternateNames: ['Old Silk Market'],
      wikidataId: 'Q7770001',
      sourceCategory: 'a_leaf_no_table_has_seen',
      sourceCategoryPath: ['arts_and_entertainment', 'a_leaf_no_table_has_seen'],
      planningRole: 'support',
      coordinates: { lat: 40.701976, lng: -74 },
    });

    const inventory = buildInventory({ pack: packWith([recipient, donor]), scope });

    /*
     * The recipient is admitted as discovery on the twin's evidence — asserted
     * by record identity, because the display-name layer may surface the
     * donor's Latin alternate and a name assertion could be satisfied by the
     * wrong record. Sever the standing hand-over at the `resolveEligibility`
     * call site and this record dies as `insufficient_travel_value` while its
     * donor survives — which is exactly the shape F3 measured live: a real
     * market refused under a bare `arts_and_entertainment` leaf while its
     * evidence sat one layer away.
     */
    expect(inventory.candidates.map((entry) => entry.place.id)).toContain('places:silk-poi');
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

// ---------------------------------------------------------------------------
// What the shortlist hands on
// ---------------------------------------------------------------------------

describe('what the shortlist hands on', () => {
  const scope = scopeFor();

  /**
   * An inventory built the way a dense city forces one to be built.
   *
   * The administrative layer placed only some of the ground, so every record it
   * missed is `membership_unknown` — eligible for the anchor slot by role,
   * refused it by scope, and demoted into the *discovery* pool of the role it
   * already had. That is what leaves a single role holding two populated pools,
   * and it is the ordinary state of a metropolis rather than an edge case: on
   * the live Tokyo pack 615 of the 653 outdoor records reached the inventory
   * that way. Modelled by handing the overlay only the records it could place,
   * which is the documented meaning of a record the overlay never saw.
   */
  function inventoryWherePlaced(
    records: SourceRecord[],
    placed: (record: SourceRecord) => boolean,
  ) {
    const pack = packWith(records);
    const all = pack.layers.flatMap((layer) => layer.records);
    return buildInventory({
      pack,
      scope,
      overlay: buildTripScopeOverlay({
        scope,
        records: all.filter((entry) => entry.layerId === 'divisions' || placed(entry)),
      }),
    });
  }

  /**
   * A destination whose every role has both a placed and an unplaceable half.
   *
   * Counts stay under `maxPerCategory` and under `maxAttractions` on purpose:
   * this fixture is about what happens to records the quotas **kept**, and a
   * fixture that also trips a cap could not tell a dropped record from a capped
   * one.
   */
  /** `count` records of one kind under one id prefix. */
  const poolOf = (count: number, prefix: string, park: boolean): SourceRecord[] =>
    Array.from({ length: count }, (_, index) =>
      record({
        id: `places:${prefix}${index}`,
        sourceId: `${prefix}${index}`,
        name: `${park ? 'Park' : 'Museum'} ${prefix}${index}`,
        ...(park
          ? {
              sourceCategory: 'park',
              sourceCategoryPath: ['sports_and_recreation', 'park'],
              coordinates: { lat: 40.75 + index * 0.001, lng: -73.95 + index * 0.001 },
            }
          : { coordinates: { lat: 40.7 + index * 0.001, lng: -74 + index * 0.001 } }),
      }),
    );

  /** The four pools, in whatever sizes a case wants them. */
  const poolsSized = (counts: readonly [number, number, number, number]): SourceRecord[] => [
    ...poolOf(counts[0], 'ma', false),
    ...poolOf(counts[1], 'md', false),
    ...poolOf(counts[2], 'pa', true),
    ...poolOf(counts[3], 'pd', true),
  ];

  function bothPools(): SourceRecord[] {
    return poolsSized([10, 10, 10, 10]);
  }

  /** The half the administrative layer reached. `…d…` is the half it did not. */
  const wasPlaced = (entry: SourceRecord): boolean => !/^places:[mp]d/.test(entry.id);

  /**
   * THE REGRESSION THIS EXISTS FOR.
   *
   * `interleaveByRole` was handed one entry per *pool*, so a role with both an
   * anchor and a discovery pool named itself twice and got two identical
   * buckets. Every round emitted its records once per copy while counting the
   * copies against the total it was waiting for, so it stopped half way: on a
   * live metropolis 129 selected records became 132 emitted ones holding 70
   * distinct places, and 59 records the quotas had already chosen were dropped
   * by a round index. Four of the six canonical attractions that pass admission
   * on that destination were among them.
   *
   * The assertion is deliberately about the *set*, not about any one record: the
   * shortlist is the last stage that may narrow on evidence, and anything it
   * loses after that point is lost to arithmetic.
   */
  it('hands on every record its quotas kept, exactly once', () => {
    const inventory = inventoryWherePlaced(bothPools(), wasPlaced);
    const ids = inventory.candidates.map((entry) => entry.place.id);

    /* The condition the defect needs: one role, two populated pools. */
    expect(inventory.portfolio.anchorDemotions).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      ids.length,
      'Every record the balance kept has to survive the ordering. A shorter list ' +
        'here means the shortlist threw away something it had already chosen, and ' +
        'nothing downstream can tell that from a destination with less to offer.',
    ).toBe(inventory.diagnostics.attractions);
  });

  /**
   * THE DROP DIRECTION, AND WHY THE TEST ABOVE CANNOT SEE IT.
   *
   * `interleaveByRole` is documented as "a permutation of its input, by
   * construction", and the two assertions that existed cover one direction of
   * that: it may not duplicate, and it may not overshoot its ceiling. It may
   * still *lose* something, and losing something is the direction the defect
   * actually took — 59 records the quotas had already chosen, discarded by a
   * round index on the live Tokyo pack.
   *
   * The assertion above looks like it covers this — it compares the emitted
   * count against what the quotas kept — and on its own fixture it cannot. The
   * emitting loop pushes a whole *round* at a time, one record per bucket, and
   * `bothPools` is four pools of ten. Any off-by-one in the round condition is
   * absorbed by a round that emits four: the loop is checked at 36, runs, and
   * lands on 40 exactly. Measured, not assumed — a round-index drop introduced
   * through the mutation harness leaves that test green and is noticed only by
   * six unrelated cases whose failure messages are about corroboration and
   * tie-breaking, which is a defence nobody could act on.
   *
   * So the shape of the pools is swept rather than chosen. What decides whether
   * a lost record is visible is the arithmetic of the last round — how many
   * buckets still have a member in it — and any single fixture is a bet on that
   * number. Uneven sizes, a pool of one, and a total that no round can land on
   * squarely are all included for that reason, and the count of cases actually
   * exercised is asserted so a sweep that swept nothing cannot pass.
   */
  it('loses nothing to a round index, whatever shape the pools are', () => {
    const shapes: [number, number, number, number][] = [
      [10, 10, 10, 10],
      [10, 10, 10, 9],
      [1, 10, 10, 10],
      [11, 3, 7, 2],
      [12, 1, 1, 1],
      [5, 4, 3, 2],
      [2, 1, 1, 1],
    ];
    let checked = 0;

    for (const shape of shapes) {
      const inventory = inventoryWherePlaced(poolsSized(shape), wasPlaced);
      const ids = inventory.candidates.map((entry) => entry.place.id);
      const where = shape.join('/');

      /* A shape that produced nothing says nothing about what survives it. */
      expect(ids.length, `${where} produced an empty shortlist`).toBeGreaterThan(0);
      expect(new Set(ids).size, `${where} handed on a record twice`).toBe(ids.length);
      expect({
        shape: where,
        handedOn: ids.length,
      }).toEqual({ shape: where, handedOn: inventory.diagnostics.attractions });
      checked += 1;
    }

    expect(checked, 'a sweep that swept nothing is a green test protecting nothing').toBe(
      shapes.length,
    );
  });

  /**
   * The other half of the same property, and the reason it is a separate
   * assertion: the broken ordering *overshot* as well as truncating, so the
   * shortlist could hand out more places than its own ceiling allows.
   */
  it('never hands on more than the attraction ceiling, whatever the pools look like', () => {
    const crowded = [
      ...bothPools(),
      ...Array.from({ length: 400 }, (_, index) =>
        record({
          id: `places:xd${index}`,
          sourceId: `xd${index}`,
          name: `Gallery ${index}`,
          sourceCategory: index % 2 === 0 ? 'art_gallery' : 'monument',
          sourceCategoryPath:
            index % 2 === 0
              ? ['arts_and_entertainment', 'art_gallery']
              : ['landmark_and_historical_building', 'monument'],
          coordinates: { lat: 40.62 + (index % 90) * 0.002, lng: -74.08 + (index % 70) * 0.002 },
        }),
      ),
    ];
    const inventory = inventoryWherePlaced(
      crowded,
      (entry) => wasPlaced(entry) && !/^places:xd/.test(entry.id),
    );
    const ids = inventory.candidates.map((entry) => entry.place.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(DEFAULT_INVENTORY_LIMITS.maxAttractions);
  });

  /**
   * THE FAILURE THE REPAIR ABOVE COULD HAVE CREATED.
   *
   * A shortlist that stops losing what it chose is worth nothing if it responds
   * by handing on everything well-evidenced in the densest corner. §12.2 wants
   * the customer-facing set deliberately bounded, and the bound has to survive
   * the *shape* that breaks it: hundreds of one richly-catalogued kind in one
   * place, against a handful of everything else.
   *
   * So this asserts what a downstream truncation sees rather than only the
   * total — the board, the autoselector and the planner all cut from the top of
   * this list, and a list that is bounded but monotonous fails them exactly as
   * badly as an unbounded one.
   */
  it('stays bounded and stays mixed when one kind floods the densest area', () => {
    const flood = Array.from({ length: 300 }, (_, index) =>
      record({
        id: `places:g${index}`,
        sourceId: `g${index}`,
        name: `Gallery ${index}`,
        sourceCategory: 'art_gallery',
        sourceCategoryPath: ['arts_and_entertainment', 'art_gallery'],
        coordinates: { lat: 40.7 + index * 0.00002, lng: -74 + index * 0.00002 },
        /* Thoroughly described, which is what used to decide the order. */
        attributes: { operator: 'City', opening_hours: 'Mo-Su 10:00-18:00', fee: 'yes' },
        websiteCandidates: [`https://gallery.example/${index}`],
      }),
    );
    const rest = [
      ...Array.from({ length: 6 }, (_, index) =>
        record({
          id: `places:t${index}`,
          sourceId: `t${index}`,
          name: `Temple ${index}`,
          sourceCategory: 'temple',
          sourceCategoryPath: ['religious_locations', 'temple'],
          coordinates: { lat: 40.78 - index * 0.004, lng: -73.92 + index * 0.004 },
        }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        record({
          id: `places:w${index}`,
          sourceId: `w${index}`,
          name: `Park ${index}`,
          sourceCategory: 'park',
          sourceCategoryPath: ['sports_and_recreation', 'park'],
          coordinates: { lat: 40.64 + index * 0.004, lng: -74.06 - index * 0.004 },
        }),
      ),
    ];

    const inventory = buildInventory({ pack: packWith([...flood, ...rest]), scope });
    const ids = inventory.candidates.map((entry) => entry.place.id);
    expect(ids.length).toBeLessThanOrEqual(DEFAULT_INVENTORY_LIMITS.maxAttractions);

    /* The source calls them galleries; the taxonomy files them under museums. */
    const galleries = inventory.candidates.filter((entry) => entry.place.category === 'museum');
    expect(galleries.length).toBeLessThanOrEqual(DEFAULT_INVENTORY_LIMITS.maxPerCategory);

    /* And the first slice a board would take is not one kind of thing. */
    const firstTwenty = inventory.candidates.slice(0, 20).map((entry) => entry.place.category);
    expect(new Set(firstTwenty).size).toBeGreaterThan(2);
    expect(firstTwenty.filter((category) => category === 'museum').length).toBeLessThan(12);
  });

  /**
   * WHAT DECIDES A TIE, NOW THAT A TIE IS THE COMMON CASE.
   *
   * Significance is rounded to two decimals, so a dense city hands the ranking
   * six hundred records of one role holding a couple of dozen distinct scores.
   * Underneath the score the only tiebreak was the source identifier, which over
   * these catalogues is a sort on hexadecimal — and on a live pack that put a
   * hundred-metre flower garden and a traffic-safety playground ahead of two of
   * the city's headline gardens purely on digits.
   *
   * The two records below are identical to the significance model and differ
   * only in the ground the source mapped, with the identifiers ordered against
   * the answer so an id sort cannot pass by accident.
   */
  it('breaks a tie on mapped ground rather than on the source identifier', () => {
    const bounded = (id: string, name: string, metres: number): SourceRecord =>
      record({
        id: `places:${id}`,
        sourceId: id,
        name,
        sourceCategory: 'park',
        sourceCategoryPath: ['sports_and_recreation', 'park'],
        coordinates: { lat: 40.7, lng: -74 },
        bounds: {
          southWest: { lat: 40.7, lng: -74 },
          northEast: { lat: 40.7 + metres / 111_320, lng: -74 },
        },
      });

    /* `a…` sorts before `z…`, and the larger ground belongs to `z…`. */
    const inventory = buildInventory({
      pack: packWith([bounded('a1', 'Pocket Green', 120), bounded('z9', 'The Great Park', 2_000)]),
      scope,
    });
    const names = inventory.candidates.map((entry) => entry.place.name);

    expect(names).toHaveLength(2);
    expect(
      names[0],
      'Both records are the same kind with the same evidence, so significance ' +
        'cannot separate them. What separates them has to be a measurement of the ' +
        'thing — not which identifier happens to sort first.',
    ).toBe('The Great Park');
  });

  /** And the tiebreak may never lift a record over a better-evidenced one. */
  it('never lets mapped ground outrank significance', () => {
    const sprawling = record({
      id: 'places:a1',
      sourceId: 'a1',
      name: 'Sprawling Green',
      sourceCategory: 'park',
      sourceCategoryPath: ['sports_and_recreation', 'park'],
      coordinates: { lat: 40.7, lng: -74 },
      bounds: {
        southWest: { lat: 40.7, lng: -74 },
        northEast: { lat: 40.73, lng: -74 },
      },
    });
    const established = record({
      id: 'places:z9',
      sourceId: 'z9',
      name: 'The Old Garden',
      sourceCategory: 'park',
      sourceCategoryPath: ['sports_and_recreation', 'park'],
      coordinates: { lat: 40.71, lng: -74.01 },
      alternateNames: ['Le Vieux Jardin', '旧庭園'],
      attributes: { wikidata: 'Q42', wikipedia: 'en:The Old Garden' },
      websiteCandidates: ['https://oldgarden.example'],
    });

    const inventory = buildInventory({ pack: packWith([sprawling, established]), scope });
    expect(inventory.candidates[0]?.place.name).toBe('The Old Garden');
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

  it('never hands a traveller with no car a road matrix, however spread out the ground', () => {
    /**
     * THIS TEST ASSERTED THE OPPOSITE, AND THE OPPOSITE WAS THE FOUNDER BUG.
     *
     * It was written for a real failure — two live destinations, a national park
     * and an island, refused outright because there is no continuous pedestrian
     * graph across either — and the fix it pinned was "measure on roads when
     * nobody is driving". That reasoning holds for the *salvage* and not for the
     * default, and as a default it is the substitution the whole transit
     * capability exists to prevent.
     *
     * The arithmetic is not marginal. A walking reach is three kilometres a
     * night capped at twelve, and a radius scope spans twice its radius: one
     * night spans twelve and measures on foot, and **every car-free trip of two
     * nights or more** spanned eighteen or more and measured on roads. Those
     * minutes reached the board with no mode on them, so a forty-kilometre
     * journey a traveller would make by bus, with two changes, was shown to them
     * as a twenty-three-minute hop.
     *
     * The salvage survives and is now visible instead of silent: the compiler
     * retries on the road network when the pedestrian graph comes back with
     * almost nothing, records the substitution on the artifact, and warns the
     * traveller in words. What is gone is the road matrix arriving as the first
     * answer for somebody who told us they have no car.
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
    /*
     * The ground is six hundred square kilometres of Denali and the traveller
     * has no car. The old answer was `car`; the true answer is that we measure
     * what they can actually walk and let the routeability dimension say the
     * trip is bigger than the way they can move around it.
     */
    expect(matrixModeFor(nationalPark)).toBe('foot');

    /*
     * The two halves of the claim, asserted together so neither can be satisfied
     * by a function that ignores its input: a driver still gets the road
     * network, and no non-driving scope of any size can reach it from here.
     */
    const driving = scopeFor();
    expect(matrixModeFor(driving)).toBe('car');

    const spans: [number, number][] = [
      [0.02, 0.02],
      [0.4, 0.4],
      [3, 3],
      [12, 12],
    ];
    for (const [latSpan, lngSpan] of spans) {
      const scope = scopeFor({
        transport: walkableCity.transport,
        shape: {
          kind: 'bounds',
          bounds: {
            southWest: { lat: 10, lng: 10 },
            northEast: { lat: 10 + latSpan, lng: 10 + lngSpan },
          },
        },
      });
      expect(matrixModeFor(scope)).not.toBe('car');
    }
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
