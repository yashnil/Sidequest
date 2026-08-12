import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { partitionScope } from '@sidequest/compiler';
import { assemblePack } from '@sidequest/compiler';
import {
  geographicScopeSchema,
  type GeographicScope,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import { getDb } from './client';
import {
  findRegionPack,
  findStaleRegionPack,
  getRegionPack,
  listRegionPacks,
  pruneRegionPacks,
  readScopeGround,
  saveRegionPack,
} from './pack-repository';

/**
 * REGION PACKS IN THE STORE.
 *
 * What these assert is the difference between a cache and a source of truth. A
 * pack is named by a compiled region, so it has to be immutable; it is shared
 * between trips, so it has to survive one of them being deleted; and it is
 * expensive, so two racing builds must end up with one row rather than two.
 */

let directory: string;

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

function packFor(input: {
  id: string;
  releaseId: string;
  scope?: GeographicScope;
  names?: string[];
  createdAt?: string;
}): RegionPack {
  const scope = input.scope ?? scopeFor();
  const names = input.names ?? ['Harbour Museum'];
  const records: SourceRecord[] = names.map((name, index) => ({
    id: `places:${input.id}-${index}`,
    layerId: 'places',
    sourceId: `${input.id}-${index}`,
    name,
    alternateNames: [],
    coordinates: { lat: 40.7 + index * 0.001, lng: -74 },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  }));

  return assemblePack({
    id: input.id,
    scope,
    releases: [
      { catalog: 'overture', releaseId: input.releaseId, resolvedAt: '2026-08-01T00:00:00.000Z' },
    ],
    partition: partitionScope(scope),
    layers: [
      {
        id: 'places',
        kind: 'primary_places',
        catalog: 'overture',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0',
        records,
        featuresRead: records.length * 3,
        featuresRetained: records.length,
        failedCellIds: [],
      },
    ],
    diagnostics: {
      filesInspected: 1,
      rowGroupsInspected: 4,
      rowGroupsRead: 1,
      bytesTransferred: 1_000,
      durationMs: 100,
      budgetsExhausted: [],
      layerTimings: [],
    },
    now: new Date(input.createdAt ?? '2026-08-01T00:00:00.000Z'),
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-packs-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'packs.db');
  // The client caches one handle per process; drop it so each test gets a
  // database of its own rather than the first test's.
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  getDb();
});

afterEach(() => {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe('region pack storage', () => {
  it('stores and finds a pack by ground and release', () => {
    const pack = packFor({ id: 'pack-1', releaseId: '2026-07-22.0' });
    saveRegionPack(pack);

    const found = findRegionPack({
      scopeHash: pack.scopeHash,
      catalog: 'overture',
      releaseId: '2026-07-22.0',
    });
    expect(found?.id).toBe('pack-1');
    expect(found?.contentHash).toBe(pack.contentHash);
    expect(getRegionPack('pack-1')?.id).toBe('pack-1');
  });

  it('does not offer a pack from a different release as a fresh hit', () => {
    saveRegionPack(packFor({ id: 'pack-old', releaseId: '2026-06-17.0' }));
    const pack = packFor({ id: 'pack-old', releaseId: '2026-06-17.0' });

    expect(
      findRegionPack({ scopeHash: pack.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' }),
    ).toBeNull();
    // It is still reachable as the deliberate last resort, which the caller labels.
    expect(findStaleRegionPack(pack.scopeHash)?.id).toBe('pack-old');
  });

  it('coalesces two builds racing for the same ground and release', () => {
    const first = packFor({ id: 'pack-a', releaseId: '2026-07-22.0', names: ['First'] });
    const second = packFor({ id: 'pack-b', releaseId: '2026-07-22.0', names: ['Second'] });

    const storedFirst = saveRegionPack(first);
    const storedSecond = saveRegionPack(second);

    // The loser reads back the winner rather than overwriting it, so a compiled
    // region can never name a pack that was replaced underneath it.
    expect(storedFirst.id).toBe('pack-a');
    expect(storedSecond.id).toBe('pack-a');
    expect(listRegionPacks().filter((row) => row.state === 'ready')).toHaveLength(1);
  });

  it('never lets a failed build replace a usable pack', () => {
    saveRegionPack(packFor({ id: 'pack-good', releaseId: '2026-07-22.0' }));
    const bad = packFor({ id: 'pack-bad', releaseId: '2026-07-22.0' });
    saveRegionPack({ ...bad, state: 'failed', failure: { code: 'x', detail: 'Nothing came back.' } });

    const found = findRegionPack({
      scopeHash: bad.scopeHash,
      catalog: 'overture',
      releaseId: '2026-07-22.0',
    });
    expect(found?.id).toBe('pack-good');
  });

  it('treats a corrupt payload as absent rather than crashing a compilation', () => {
    const pack = packFor({ id: 'pack-corrupt', releaseId: '2026-07-22.0' });
    saveRegionPack(pack);
    getDb()
      .prepare('UPDATE region_packs SET payload_json = ? WHERE id = ?')
      .run('{"schemaVersion":1,"id":', 'pack-corrupt');

    expect(
      findRegionPack({ scopeHash: pack.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' }),
    ).toBeNull();
    expect(getRegionPack('pack-corrupt')).toBeNull();
  });

  it('ignores a pack written under a schema version this build cannot read', () => {
    const pack = packFor({ id: 'pack-future', releaseId: '2026-07-22.0' });
    saveRegionPack(pack);
    getDb().prepare('UPDATE region_packs SET schema_version = 99 WHERE id = ?').run('pack-future');

    expect(
      findRegionPack({ scopeHash: pack.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' }),
    ).toBeNull();
  });

  it('keeps two generations per piece of ground and sweeps the rest', () => {
    const scope = scopeFor();
    for (const [index, release] of ['2026-05-01.0', '2026-06-17.0', '2026-07-22.0'].entries()) {
      saveRegionPack(
        packFor({
          id: `pack-gen-${index}`,
          releaseId: release,
          scope,
          createdAt: `2026-0${5 + index}-01T00:00:00.000Z`,
        }),
      );
    }
    pruneRegionPacks();
    const rows = listRegionPacks();
    expect(rows).toHaveLength(2);
    // The newest survive, so an artifact built from the previous release can
    // still be explained after a refresh.
    expect(rows.map((row) => row.releaseId).sort()).toEqual(['2026-06-17.0', '2026-07-22.0']);
  });

  it('shares a pack between two trips to the same ground', () => {
    const wide = scopeFor({ nights: 3 });
    const narrow = scopeFor({ nights: 9, maxBaseChanges: 2 });
    const pack = packFor({ id: 'pack-shared', releaseId: '2026-07-22.0', scope: wide });
    saveRegionPack(pack);

    const other = packFor({ id: 'pack-other', releaseId: '2026-07-22.0', scope: narrow });
    // Same ground, different traveller: the same row answers both.
    expect(other.scopeHash).toBe(pack.scopeHash);
    expect(
      findRegionPack({ scopeHash: other.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' })
        ?.id,
    ).toBe('pack-shared');
  });

  /**
   * THE REBUILD THAT PAID FOR THE SAME CITY TWICE.
   *
   * A live pair of Tokyo builds re-fetched 3,787 records for ground already on
   * disk. The scope hash carries the *derived* bounding box, and that box is a
   * function of the traveller — nights, pace, whether they will drive — so two
   * trips to the same city routinely produce two different hashes for one piece
   * of ground and the second one missed everything.
   *
   * The rule these pin: same ground identity, same release, and a stored extent
   * that already contains what is being asked for, is a hit. More ground answers
   * a request for less. Less never answers a request for more.
   */
  it('answers a tighter scope from a pack that already covers the ground', () => {
    const wide = scopeFor({
      shape: {
        kind: 'bounds',
        bounds: { southWest: { lat: 40.5, lng: -74.2 }, northEast: { lat: 40.9, lng: -73.8 } },
      },
    });
    const stored = packFor({ id: 'pack-wide', releaseId: '2026-07-22.0', scope: wide });
    saveRegionPack(stored);

    const tighter = packFor({ id: 'pack-tight', releaseId: '2026-07-22.0', scope: scopeFor() });
    // Precondition: the two really are different keys, or this proves nothing.
    expect(tighter.scopeHash).not.toBe(stored.scopeHash);

    expect(
      findRegionPack({
        scopeHash: tighter.scopeHash,
        catalog: 'overture',
        releaseId: '2026-07-22.0',
      })?.id,
    ).toBe('pack-wide');
  });

  it('does not answer a wider scope from a pack that covers less ground', () => {
    const narrow = packFor({ id: 'pack-narrow', releaseId: '2026-07-22.0', scope: scopeFor() });
    saveRegionPack(narrow);

    const wider = packFor({
      id: 'pack-wider',
      releaseId: '2026-07-22.0',
      scope: scopeFor({
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: 40.4, lng: -74.3 }, northEast: { lat: 41.0, lng: -73.7 } },
        },
      }),
    });

    /*
     * The half that keeps this a cache rather than a lie: reusing the smaller
     * pack would silently plan a bigger region from data that never covered it,
     * and every place beyond the stored extent would simply not exist.
     */
    expect(
      findRegionPack({ scopeHash: wider.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' }),
    ).toBeNull();
  });

  it('never crosses from one piece of ground to another', () => {
    saveRegionPack(packFor({ id: 'pack-here', releaseId: '2026-07-22.0' }));

    const elsewhere = packFor({
      id: 'pack-elsewhere',
      releaseId: '2026-07-22.0',
      scope: scopeFor({ destinationCandidateId: 'relation/2', destinationName: 'Otherville' }),
    });

    expect(
      findRegionPack({
        scopeHash: elsewhere.scopeHash,
        catalog: 'overture',
        releaseId: '2026-07-22.0',
      }),
    ).toBeNull();
  });

  it('reads a ground identity that contains slashes of its own', () => {
    /*
     * `relation/1` is the ordinary shape of an OSM identifier, so the bounds are
     * read off the end of the key rather than by counting from the front. A
     * split that counted forwards mis-parsed every live scope hash while passing
     * against a fixture id with no slash in it.
     */
    const ground = readScopeGround('v9/relation/1/40.6000/-74.1000/40.8000/-73.9000');
    expect(ground?.identity).toBe('v9/relation/1');
    expect(ground?.bounds).toEqual({ swLat: 40.6, swLng: -74.1, neLat: 40.8, neLng: -73.9 });
    expect(readScopeGround('nonsense')).toBeNull();
  });
});
