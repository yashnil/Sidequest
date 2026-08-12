import { describe, expect, it } from 'vitest';
import { geographicScopeSchema, type GeographicScope, type SourceRecord } from '@sidequest/core';
import { assemblePack, layerSpatialCoverage } from './assemble';
import { partitionScope, scopeBounds } from './partition';

/**
 * THE COVERAGE ACCEPTANCE CHECK, PINNED TO THE FAILURE IT EXISTS FOR.
 *
 * A live metro build read one percent of its overlapping row groups — all in
 * the south-west corner — and assembled a `ready` pack whose places layer held
 * zero records north of the city centre. Every diagnostic already recorded was
 * green: budgets were reported as exhausted (normal), cells did not fail
 * (nothing errored), and the schema was satisfied. Nothing measured whether the
 * records actually span the ground the scope asked for. This suite is that
 * measurement's contract: badly lopsided places coverage is recorded in
 * diagnostics and demotes the pack to `partial`, never silently accepted.
 *
 * Nothing here names a destination. The fixture is "a city-sized box whose
 * records all sit in one corner", which is a shape, not a place.
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

function placeRecord(index: number, lat: number, lng: number): SourceRecord {
  return {
    id: `places:${index}`,
    layerId: 'places',
    sourceId: `${index}`,
    name: `Place ${index}`,
    alternateNames: [],
    coordinates: { lat, lng },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: `cell-${index % 4}`,
  };
}

function placesLayer(records: SourceRecord[]) {
  return {
    id: 'places',
    kind: 'primary_places' as const,
    catalog: 'overture',
    datasetPath: 'places/place',
    licenceId: 'CDLA-Permissive-2.0' as const,
    records,
    featuresRead: records.length,
    featuresRetained: records.length,
    failedCellIds: [],
  };
}

const DIAGNOSTICS = {
  filesInspected: 1,
  rowGroupsInspected: 10,
  rowGroupsRead: 5,
  bytesTransferred: 1000,
  durationMs: 100,
  budgetsExhausted: [],
  layerTimings: [],
};

/** 120 records confined to the south-west sixth of the box. The defect's shape. */
function cornerRecords(): SourceRecord[] {
  return Array.from({ length: 120 }, (_, index) =>
    placeRecord(index, 40.6 + (index % 10) * 0.003, -74.1 + (index % 12) * 0.002),
  );
}

/** 120 records spread over the whole box. */
function spreadRecords(): SourceRecord[] {
  return Array.from({ length: 120 }, (_, index) =>
    placeRecord(index, 40.6 + (index % 11) * 0.019, -74.1 + (index % 13) * 0.016),
  );
}

function divisionsLayer(records: SourceRecord[]) {
  return {
    id: 'divisions',
    kind: 'administrative_divisions' as const,
    catalog: 'overture',
    datasetPath: 'divisions/division_area',
    licenceId: 'CDLA-Permissive-2.0' as const,
    records,
    featuresRead: records.length * 3,
    featuresRetained: records.length,
    failedCellIds: [],
  };
}

function divisionRecord(index: number, lat: number, lng: number): SourceRecord {
  return {
    ...placeRecord(index, lat, lng),
    id: `divisions:${index}`,
    layerId: 'divisions',
    planningRole: 'administrative',
    sourceCategory: 'neighborhood',
    sourceCategoryPath: [],
    attributes: { subtype: 'neighborhood' },
  };
}

/** 120 divisions confined to one strip: the retained cap, read in file order. */
function cornerDivisions(): SourceRecord[] {
  return Array.from({ length: 120 }, (_, index) =>
    divisionRecord(index, 40.6 + (index % 10) * 0.003, -74.1 + (index % 12) * 0.002),
  );
}

function spreadDivisions(): SourceRecord[] {
  return Array.from({ length: 120 }, (_, index) =>
    divisionRecord(index, 40.6 + (index % 11) * 0.019, -74.1 + (index % 13) * 0.016),
  );
}

describe('layer spatial coverage', () => {
  const scope = scopeFor();
  const partition = partitionScope(scope);
  const bounds = scopeBounds(scope);

  it('flags a well-populated layer confined to one corner as lopsided', () => {
    const coverage = layerSpatialCoverage([placesLayer(cornerRecords())], partition, bounds);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.lopsided).toBe(true);
    expect(coverage[0]!.latSpanFraction).toBeLessThan(0.4);
  });

  it('accepts the same population spread over the box', () => {
    const coverage = layerSpatialCoverage([placesLayer(spreadRecords())], partition, bounds);
    expect(coverage[0]!.lopsided).toBe(false);
    expect(coverage[0]!.latSpanFraction).toBeGreaterThan(0.9);
  });

  it('does not accuse a small layer: sixty records along one valley is a place, not a defect', () => {
    const few = cornerRecords().slice(0, 60);
    const coverage = layerSpatialCoverage([placesLayer(few)], partition, bounds);
    expect(coverage[0]!.lopsided).toBe(false);
  });
});

describe('assembly with lopsided places coverage', () => {
  const scope = scopeFor();
  const partition = partitionScope(scope);
  const release = {
    catalog: 'overture',
    releaseId: '2026-07',
    resolvedAt: '2026-08-11T00:00:00.000Z',
  };

  it('records the defect in diagnostics and demotes the pack to partial', () => {
    const pack = assemblePack({
      id: 'pack-test',
      scope,
      releases: [release],
      partition,
      layers: [placesLayer(cornerRecords())],
      diagnostics: DIAGNOSTICS,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });

    expect(pack.state).toBe('partial');
    const coverage = pack.diagnostics.spatialCoverage?.find((entry) => entry.layerId === 'places');
    expect(coverage?.lopsided).toBe(true);
  });

  it('leaves a genuinely covered pack ready, with the measurement still recorded', () => {
    const pack = assemblePack({
      id: 'pack-test',
      scope,
      releases: [release],
      partition,
      layers: [placesLayer(spreadRecords())],
      diagnostics: DIAGNOSTICS,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });

    expect(pack.state).toBe('ready');
    const coverage = pack.diagnostics.spatialCoverage?.find((entry) => entry.layerId === 'places');
    expect(coverage).toBeDefined();
    expect(coverage!.lopsided).toBe(false);
  });

  /**
   * The layer that decides what *belongs*, read in a strip.
   *
   * The places check above was written for "what there is to do". Divisions
   * answer a different question and are the only thing that answers it: a city
   * publishes no polygon, so membership comes out of this layer and nowhere
   * else. Measured on the Tokyo pack stored on this machine — 800 division
   * features read, the 320-record cap retained, spanning a quarter of the box's
   * latitude and not one ward of the destination itself — the pack was written
   * `ready`, and the board that came out of it said "0 of which could hold a
   * morning" with nothing anywhere connecting the two.
   */
  it('demotes a pack whose administrative layer was read in a strip', () => {
    const pack = assemblePack({
      id: 'pack-test',
      scope,
      releases: [release],
      partition,
      layers: [placesLayer(spreadRecords()), divisionsLayer(cornerDivisions())],
      diagnostics: DIAGNOSTICS,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });

    expect(pack.state).toBe('partial');
    expect(pack.failure).toBeUndefined();
    const coverage = pack.diagnostics.spatialCoverage?.find(
      (entry) => entry.layerId === 'divisions',
    );
    expect(coverage?.lopsided).toBe(true);
  });

  it('leaves a pack ready when its administrative layer spans the box', () => {
    const pack = assemblePack({
      id: 'pack-test',
      scope,
      releases: [release],
      partition,
      layers: [placesLayer(spreadRecords()), divisionsLayer(spreadDivisions())],
      diagnostics: DIAGNOSTICS,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });
    expect(pack.state).toBe('ready');
  });

  it('keeps the coverage measurement out of the content hash, like every other diagnostic', () => {
    const corner = assemblePack({
      id: 'pack-test',
      scope,
      releases: [release],
      partition,
      layers: [placesLayer(cornerRecords())],
      diagnostics: DIAGNOSTICS,
      now: new Date('2026-08-11T00:00:00.000Z'),
    });
    const again = assemblePack({
      id: 'pack-test',
      scope,
      releases: [release],
      partition,
      layers: [placesLayer(cornerRecords())],
      diagnostics: { ...DIAGNOSTICS, durationMs: 999 },
      now: new Date('2026-08-11T00:00:00.000Z'),
    });
    expect(corner.contentHash).toBe(again.contentHash);
  });
});
