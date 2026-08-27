import { describe, expect, it } from 'vitest';
import {
  geographicScopeSchema,
  type GeographicScope,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from './assemble';
import {
  buildInventory,
  UNWITNESSED_KIND_SEATS,
  WITNESS_CHANNEL_SILENT_TAG,
} from './inventory';
import { linkRecords, supersededRecordIds } from './link';
import { partitionScope } from './partition';

/**
 * THE WITNESS GATE, MADE OUTAGE-AWARE — AND ONLY OUTAGE-AWARE.
 *
 * The live failure this suite pins: the primary place layer of the current
 * catalogue release publishes **no** knowledge-base identifier for any record
 * — measured at zero across three metropolitan boxes — while the witness gate
 * (`requiresSignificanceEvidence`) was calibrated as if every layer could
 * answer. The result on a real dense-metro board: every place-layer worship
 * building and historic site died at the gate, while wikipedia-tagged
 * geographic obscura from the supplemental layers took the seats.
 *
 * The repair is a *degradation*, never a repeal, and each test here holds one
 * edge of it:
 *
 * - a layer that cannot carry the witness admits a **bounded** number of
 *   evidence-gated records per kind, marked as unverified — never silently;
 * - a layer that answers the question keeps the hard refusal, exactly as
 *   before;
 * - a pack in which **no** layer answers keeps the hard refusal too, because
 *   "this catalogue has no channel anywhere" and "this layer is silent while
 *   the channel demonstrably works" are different observations, and only the
 *   second licenses the degradation;
 * - an identifier or article stamped across many records witnesses none of
 *   them — it attests the shared entity, not a visitable place.
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
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

function packWith(records: SourceRecord[]) {
  const scope = scopeFor();
  return assemblePack({
    id: 'pack-test',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
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
    now: new Date('2026-08-11T00:00:00Z'),
  });
}

function inventoryOf(records: SourceRecord[]) {
  return buildInventory({ pack: packWith(records), scope: scopeFor() });
}

/** A place-layer worship building with nothing but its own listing — the shape the canon arrives in. */
function worshipPlace(suffix: string, lat: number): SourceRecord {
  return record({
    id: `places:worship-${suffix}`,
    sourceId: `worship-${suffix}`,
    name: `Old Quarter Hall ${suffix}`,
    sourceCategory: 'buddhist_place_of_worship',
    sourceCategoryPath: ['cultural_and_historic', 'place_of_worship', 'buddhist_place_of_worship'],
    websiteCandidates: ['https://example.org/hall'],
    coordinates: { lat, lng: -74.0 },
  });
}

/** A supplemental-layer record that proves the knowledge-base channel is alive in this pack. */
function answeringLandmark(): SourceRecord {
  return record({
    id: 'land:harbour-park',
    layerId: 'land',
    sourceId: 'harbour-park',
    name: 'Harbour Point Park',
    sourceCategory: 'park',
    sourceCategoryPath: [],
    planningRole: 'outdoor',
    wikidataId: 'Q7777',
    attributes: { wikipedia: 'aa:Harbour Point Park', leisure: 'park' },
    coordinates: { lat: 40.75, lng: -74.05 },
  });
}

describe('the witness gate degrades where the channel is structurally silent', () => {
  it('admits a gated place-layer record, marked, when its layer cannot carry the witness', () => {
    const inventory = inventoryOf([worshipPlace('a', 40.7), answeringLandmark()]);
    const hall = inventory.candidates.find(
      (candidate) => candidate.place.name === 'Old Quarter Hall a',
    );
    expect(hall).toBeDefined();
    /* The admission is marked, never silent. */
    expect(hall!.place.tags).toContain(WITNESS_CHANNEL_SILENT_TAG);
    /* Never a classics seat: nothing established prominence, and the fields say so. */
    expect(hall!.place.popularityScore).toBeLessThan(0.7);
    /* Kind-only significance — the degradation must not invent evidence. */
    expect(hall!.place.experienceSignificance).toBeLessThanOrEqual(0.2);
    /* Reported, so a thin-evidence board can explain itself. */
    expect(inventory.portfolio.unwitnessedAdmissions).toBe(1);
  });

  it('keeps the hard refusal where the record\'s own layer answers the question', () => {
    /* One place-layer record carrying an identifier makes the layer an answering one. */
    const answeringNeighbour = record({
      id: 'places:known-museum',
      sourceId: 'known-museum',
      name: 'Old Port Museum',
      wikidataId: 'Q9001',
      coordinates: { lat: 40.75, lng: -74.06 },
    });
    const inventory = inventoryOf([worshipPlace('a', 40.7), answeringNeighbour]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).not.toContain('Old Quarter Hall a');
    expect(
      inventory.portfolio.rejected.find(
        (entry) => entry.reason === 'insufficient_significance_evidence',
      )?.count,
    ).toBe(1);
    expect(inventory.portfolio.unwitnessedAdmissions).toBe(0);
  });

  it('keeps the hard refusal when no layer in the pack answers at all', () => {
    /*
     * A wholly silent pack cannot distinguish "the catalogue has no channel"
     * from "nobody has heard of any of this", so the conservative reading
     * stands: the gate refuses, exactly as it always has.
     */
    const inventory = inventoryOf([worshipPlace('a', 40.7)]);
    expect(inventory.candidates).toHaveLength(0);
    expect(inventory.portfolio.unwitnessedAdmissions).toBe(0);
  });

  it('bounds the degraded admission per kind and keeps it deterministic', () => {
    const halls = ['a', 'b', 'c', 'd', 'e'].map((suffix, index) =>
      worshipPlace(suffix, 40.7 + index * 0.02),
    );
    const inventory = inventoryOf([...halls, answeringLandmark()]);
    const admitted = inventory.candidates
      .map((candidate) => candidate.place.name)
      .filter((name) => name.startsWith('Old Quarter Hall'));
    expect(admitted).toHaveLength(UNWITNESSED_KIND_SEATS);
    /* Nothing separates the five, so the deterministic id order decides. */
    expect([...admitted].sort()).toEqual([
      'Old Quarter Hall a',
      'Old Quarter Hall b',
      'Old Quarter Hall c',
    ]);
    /* The rest are refused with the witness reason, not silently dropped. */
    expect(
      inventory.portfolio.rejected.find(
        (entry) => entry.reason === 'insufficient_significance_evidence',
      )?.count,
    ).toBe(halls.length - UNWITNESSED_KIND_SEATS);
    expect(inventory.portfolio.unwitnessedAdmissions).toBe(UNWITNESSED_KIND_SEATS);
  });

  it('gives each gated kind its own seats rather than one merged pool', () => {
    const halls = ['a', 'b', 'c', 'd'].map((suffix, index) =>
      worshipPlace(suffix, 40.7 + index * 0.02),
    );
    const sites = ['a', 'b'].map((suffix, index) =>
      record({
        id: `places:site-${suffix}`,
        sourceId: `site-${suffix}`,
        name: `Former Works ${suffix}`,
        sourceCategory: 'historic_site',
        sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
        coordinates: { lat: 40.61 + index * 0.02, lng: -73.95 },
      }),
    );
    const inventory = inventoryOf([...halls, ...sites, answeringLandmark()]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names.filter((name) => name.startsWith('Old Quarter Hall'))).toHaveLength(
      UNWITNESSED_KIND_SEATS,
    );
    /* The historic pool is under its own bound, not crowded out by the worship pool. */
    expect(names.filter((name) => name.startsWith('Former Works'))).toHaveLength(2);
  });
});

describe('an identifier fanned out across many records witnesses none of them', () => {
  /** Way-segments of one linear feature, each stamped with the line's identity. */
  function lineSegment(suffix: string, lat: number): SourceRecord {
    return record({
      id: `land:segment-${suffix}`,
      layerId: 'land',
      sourceId: `segment-${suffix}`,
      name: 'Harbour Freight Line',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q4040',
      attributes: { operator: 'City Rail', wikipedia: 'aa:Harbour Freight Line' },
      coordinates: { lat, lng: -74.02 },
    });
  }

  it('refuses every segment of a line whose article was stamped across the set', () => {
    const segments = ['a', 'b', 'c', 'd'].map((suffix, index) =>
      lineSegment(suffix, 40.62 + index * 0.04),
    );
    /* The control: a crossing with its own identity keeps its witness. */
    const namedCrossing = record({
      id: 'land:old-crossing',
      layerId: 'land',
      sourceId: 'old-crossing',
      name: 'Old Harbour Crossing',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q4141',
      attributes: { wikipedia: 'aa:Old Harbour Crossing' },
      coordinates: { lat: 40.78, lng: -73.92 },
    });
    const inventory = inventoryOf([...segments, namedCrossing]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    expect(names).not.toContain('Harbour Freight Line');
    expect(names).toContain('Old Harbour Crossing');
  });

  it('leaves a pair alone — a record and its twin are one place said twice', () => {
    const poi = record({
      id: 'places:garden-poi',
      sourceId: 'garden-poi',
      name: 'Quiet Stone Garden',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q5050',
      attributes: { wikipedia: 'aa:Quiet Stone Garden' },
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const polygon = record({
      id: 'land:garden-shape',
      layerId: 'land',
      sourceId: 'garden-shape',
      name: 'Quiet Stone Garden',
      sourceCategory: 'bridge',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      wikidataId: 'Q5050',
      attributes: { wikipedia: 'aa:Quiet Stone Garden' },
      coordinates: { lat: 40.7001, lng: -74.0001 },
    });
    const inventory = inventoryOf([poi, polygon]);
    const names = inventory.candidates.map((candidate) => candidate.place.name);
    /* The linker collapses the pair; the survivor keeps the witness and the seat. */
    expect(names).toContain('Quiet Stone Garden');
  });
});

describe('a collapse keeps the institution, not the event wearing its identity', () => {
  it('never lets an exhibition-venue record survive over the institution it points at', () => {
    /*
     * The stronger record by raw strength — more provenance rows, more
     * attributes — is the exhibition listing; the weaker one is the museum
     * itself. Before this preference the collapse kept the listing, so a
     * temporary exhibition's title became the surviving name of a permanent
     * institution.
     */
    const exhibition = record({
      id: 'places:show',
      sourceId: 'show',
      name: 'Treasures of the Deep — A Season Exhibition',
      sourceCategory: 'exhibition_and_trade_fair_venue',
      sourceCategoryPath: ['arts_and_entertainment', 'exhibition_and_trade_fair_venue'],
      wikidataId: 'Q6060',
      attributes: { website: 'https://example.org/show', opening_hours: 'Mo-Su', operator: 'Museum Trust' },
      sources: [
        { dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' },
        { dataset: 'secondary', licenceId: 'CDLA-Permissive-2.0' },
      ],
      coordinates: { lat: 40.7, lng: -74.0 },
    });
    const institution = record({
      id: 'places:museum',
      sourceId: 'museum',
      name: 'Harbour National Museum',
      sourceCategory: 'museum',
      sourceCategoryPath: ['arts_and_entertainment', 'museum'],
      wikidataId: 'Q6060',
      coordinates: { lat: 40.7002, lng: -74.0002 },
    });
    const records = [exhibition, institution];
    const superseded = supersededRecordIds(records, linkRecords(records));
    expect(superseded.has('places:show')).toBe(true);
    expect(superseded.has('places:museum')).toBe(false);
  });
});
