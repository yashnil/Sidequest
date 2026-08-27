import { describe, expect, it } from 'vitest';
import { geographicScopeSchema, type GeographicScope, type SourceRecord } from '@sidequest/core';
import { assemblePack } from './assemble';
import { buildInventory } from './inventory';
import { partitionScope } from './partition';

/**
 * THE SUPPLEMENTAL LAYERS REACHING THE ANCHOR POOL, END TO END.
 *
 * The shape this file replays, measured on a fresh dense-metro pack
 * (2026-07-22): every one of 1,627 supplemental records (land, water,
 * land_use, infrastructure) publishes a real polygon extent and **no
 * administrative evidence at all** — no locality, no chain — while the
 * divisions layer's retained records are leaves whose own boxes are a few
 * metres across. Every park the geographic layers carried was therefore
 * `membership_unknown`, 638 attractions were demoted out of the anchor slot,
 * and the outdoor anchor pool was so undersubscribed that admission was
 * unconditional — ordering never bound, and whatever the place catalogue
 * misfiled held board seats unchallenged.
 *
 * Two properties are pinned here, because they only exist together:
 *
 * 1. **Membership resolves through the compiler**, not only in the containment
 *    unit: a polygon standing on ground the destination's own subdivisions
 *    sample comes out of `buildInventory` as an anchor-eligible candidate.
 * 2. **The seats that open are ordered.** Resolving membership makes the
 *    outdoor pool oversubscribed for the first time, and the warning attached
 *    to that fix was explicit: the seats must go by the significance ordering
 *    the phase built, never by id or insertion order. The junk records here
 *    carry the *lowest* ids and arrive *first*, so any ordering that
 *    degenerates to either seats them — and the evidenced parks carry the
 *    knowledge-base identifiers and articles that significance actually reads.
 *
 * Nothing here names a real place; every record is a kind of thing with a kind
 * of evidence, which is the only vocabulary the engine may reason in.
 */

const CENTRE = { lat: 40.7, lng: -74 } as const;
const KM_PER_DEGREE_LAT = 111.19;

function eastNorthOf(kmEast: number, kmNorth: number): { lat: number; lng: number } {
  return {
    lat: CENTRE.lat + kmNorth / KM_PER_DEGREE_LAT,
    lng: CENTRE.lng + kmEast / (KM_PER_DEGREE_LAT * Math.cos((CENTRE.lat * Math.PI) / 180)),
  };
}

function boxAround(point: { lat: number; lng: number }, km: number) {
  const dLat = km / KM_PER_DEGREE_LAT;
  const dLng = km / (KM_PER_DEGREE_LAT * Math.cos((CENTRE.lat * Math.PI) / 180));
  return {
    southWest: { lat: point.lat - dLat, lng: point.lng - dLng },
    northEast: { lat: point.lat + dLat, lng: point.lng + dLng },
  };
}

function scopeFor(): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'fixture/metro',
    destinationName: 'Selected City',
    destinationEntityType: 'city',
    breadth: 'city',
    center: CENTRE,
    countryCode: 'AA',
    administrative: {
      countryCode: 'AA',
      regionCode: 'AA-SR',
      aliases: [],
      hierarchy: [],
      divisionIds: ['div-city'],
    },
    timeZones: ['UTC'],
    shape: { kind: 'radius', center: CENTRE, radiusKm: 40 },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'walk',
      allowedModes: ['walk', 'rail'],
      carAvailable: false,
      acceptsWaterOrAirTransfers: false,
      basis: 'default',
      note: 'Fixture transport.',
    },
    maxBaseChanges: 0,
    nights: 5,
    rationale: 'A membership fixture.',
    confidence: { level: 'high', signals: [], note: 'Fixture.' },
    decidedBy: [],
    confirmedByUser: true,
  });
}

/** A leaf division as the real layer publishes one: a point-box and a chain. */
function leaf(input: {
  id: string;
  name: string;
  locality: string;
  chain: string[];
  point: { lat: number; lng: number };
}): SourceRecord {
  return {
    id: `divisions:${input.id}`,
    layerId: 'divisions',
    sourceId: input.id,
    name: input.name,
    alternateNames: [],
    coordinates: input.point,
    bounds: {
      southWest: { lat: input.point.lat, lng: input.point.lng },
      northEast: { lat: input.point.lat + 0.00001, lng: input.point.lng + 0.00001 },
    },
    sourceCategory: 'neighborhood',
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: {
      countryCode: 'AA',
      regionName: 'AA-SR',
      localityName: input.locality,
      divisionIds: input.chain,
    },
    attributes: { subtype: 'neighborhood' },
    sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

/** Wards of the destination, each sampled by its own leaves in two dimensions. */
function divisions(): SourceRecord[] {
  const wards = [
    { ward: 'div-ward-a', locality: 'North Ward', at: (east: number, north: number) => eastNorthOf(east, north + 6) },
    { ward: 'div-ward-b', locality: 'South Ward', at: (east: number, north: number) => eastNorthOf(east, north - 6) },
  ];
  return wards.flatMap(({ ward, locality, at }, wardIndex) =>
    [
      { id: `leaf-${wardIndex}-1`, name: `${locality} West Quarter`, point: at(-7, -3) },
      { id: `leaf-${wardIndex}-2`, name: `${locality} East Quarter`, point: at(7, 3) },
      { id: `leaf-${wardIndex}-3`, name: `${locality} Mid Quarter`, point: at(0, 0) },
    ].map((entry) =>
      leaf({
        id: entry.id,
        name: entry.name,
        locality,
        chain: ['div-country', 'div-city', ward, `div-${entry.id}`],
        point: entry.point,
      }),
    ),
  );
}

/** A supplemental park: a polygon, a point, and no address — the real shape. */
function park(input: {
  id: string;
  name: string;
  point: { lat: number; lng: number };
  evidenced?: boolean;
}): SourceRecord {
  return {
    id: `land_use:${input.id}`,
    layerId: 'land_use',
    sourceId: input.id,
    name: input.name,
    alternateNames: [],
    coordinates: input.point,
    bounds: boxAround(input.point, 0.4),
    sourceCategory: 'park',
    sourceCategoryPath: ['park'],
    planningRole: 'outdoor',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    ...(input.evidenced
      ? {
          wikidataId: `Q${input.id.replace(/\D/g, '') || '77'}`,
          attributes: { wikipedia: `xx:${input.name}` },
        }
      : { attributes: {} }),
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
    cellId: 'g-0-0',
  } as SourceRecord;
}

/**
 * The pool: three parks the world has written about, carrying knowledge-base
 * identifiers and articles, filed at the **end** with the **highest** ids —
 * and twenty-four bare scraps of mapped ground filed first with the lowest
 * ids. An ordering that reads insertion or id seats the scraps; significance
 * seats the parks. Names share no six-character stem and points sit hundreds
 * of metres apart, so neither the fragment fold nor the linker mistakes them
 * for one another.
 */
const SCRAP_STEMS = [
  'Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel',
  'Iris', 'Juniper', 'Katsura', 'Larch', 'Maple', 'Nutmeg', 'Oak', 'Pine',
  'Quince', 'Rowan', 'Spruce', 'Tupelo', 'Vetch', 'Wisteria', 'Yarrow', 'Zelkova',
] as const;

function oversubscribedOutdoorPool(): SourceRecord[] {
  const scraps = SCRAP_STEMS.map((stem, index) => {
    const east = -5.5 + (index % 12);
    const north = index < 12 ? 6.8 : -6.8;
    return park({
      id: `aa-scrap-${String(index).padStart(2, '0')}`,
      name: `${stem} Strip`,
      point: eastNorthOf(east, north),
    });
  });
  const evidenced = [
    park({ id: 'zz-park-1', name: 'Meridian Commons', point: eastNorthOf(-1, 5.9), evidenced: true }),
    park({ id: 'zz-park-2', name: 'Lantern Waters', point: eastNorthOf(1.2, -5.9), evidenced: true }),
    park({ id: 'zz-park-3', name: 'Quarry Heath', point: eastNorthOf(2.4, 5.7), evidenced: true }),
  ];
  return [...scraps, ...evidenced];
}

function packWith(records: SourceRecord[]) {
  const scope = scopeFor();
  return assemblePack({
    id: 'pack-membership-test',
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
        records: divisions(),
        featuresRead: divisions().length,
        featuresRetained: divisions().length,
        failedCellIds: [],
      },
      {
        id: 'land_use',
        kind: 'supplemental_geography' as const,
        catalog: 'test',
        datasetPath: 'base/land_use',
        licenceId: 'ODbL-1.0' as const,
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
    now: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('supplemental membership through the compiler', () => {
  it('seats a geometry-only park as an anchor, with its membership verified', () => {
    const inventory = buildInventory({
      pack: packWith([park({ id: 'zz-park-1', name: 'Meridian Commons', point: eastNorthOf(0, 6.5), evidenced: true })]),
      scope: scopeFor(),
    });
    const commons = inventory.candidates.find((entry) => entry.place.name.includes('Meridian'));
    expect(commons).toBeDefined();
    /* Verified membership, not the demoted-discovery consolation. */
    expect(commons!.place.tags).toContain('included:inside_selected_division');
    expect(inventory.portfolio.anchorDemotions).toBe(0);
    const anchorPool = inventory.portfolio.pools.find(
      (pool) => pool.slot === 'anchor' && pool.role === 'outdoor',
    );
    expect(anchorPool?.kept).toBe(1);
  });

  it('orders the seats that open by significance, never by id or arrival', () => {
    /*
     * The caution attached to the membership fix, as a test. Twenty-seven
     * outdoor records now resolve membership and compete for a board of at
     * most twelve, so for the first time the pool oversubscribes and ordering
     * binds. The twenty-four scraps arrive first and carry the lowest ids; the
     * three evidenced parks arrive last and carry the highest. If the pool's
     * ordering degenerates to id or insertion, every seat goes to a scrap and
     * this fails.
     */
    const inventory = buildInventory({
      pack: packWith(oversubscribedOutdoorPool()),
      scope: scopeFor(),
      limits: { maxAttractions: 12 },
    });
    const outdoorPool = inventory.portfolio.pools.find(
      (pool) => pool.slot === 'anchor' && pool.role === 'outdoor',
    );
    /* The pool genuinely oversubscribes: more available than seats. */
    expect(outdoorPool?.available).toBe(27);
    const names = inventory.candidates.map((entry) => entry.place.name);
    expect(names.length).toBeLessThanOrEqual(12);
    for (const evidencedName of ['Meridian Commons', 'Lantern Waters', 'Quarry Heath']) {
      expect(names.some((name) => name.includes(evidencedName))).toBe(true);
    }
    /* And the seats were contested, not merely granted: scraps were refused. */
    expect(names.filter((name) => name.includes('Strip')).length).toBeLessThan(SCRAP_STEMS.length);
  });
});
