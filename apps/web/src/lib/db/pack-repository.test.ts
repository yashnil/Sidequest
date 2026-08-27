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
  packRowId,
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
 *
 * Packs are compared by content hash rather than by the id the builder passed:
 * the store names a row after the ground, the schema and the release, which is
 * the defect the last section of this file exists for.
 */

/** The id the builder used to mint, and the collision it caused. */
function livePackId(releaseId: string): string {
  return `pack-relation/1-${releaseId}`;
}

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
  /** Cells the build could not read; a non-empty list makes the pack `partial`. */
  failedCellIds?: string[];
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
        failedCellIds: input.failedCellIds ?? [],
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
    expect(found?.contentHash).toBe(pack.contentHash);
    // The row is named after the ground it covers, and the stored pack carries
    // that name — so a compiled region naming a pack names something findable.
    expect(found?.id).toBe(packRowId(pack));
    expect(getRegionPack(packRowId(pack))?.contentHash).toBe(pack.contentHash);
  });

  it('does not offer a pack from a different release as a fresh hit', () => {
    saveRegionPack(packFor({ id: 'pack-old', releaseId: '2026-06-17.0' }));
    const pack = packFor({ id: 'pack-old', releaseId: '2026-06-17.0' });

    expect(
      findRegionPack({ scopeHash: pack.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' }),
    ).toBeNull();
    // It is still reachable as the deliberate last resort, which the caller labels.
    expect(findStaleRegionPack(pack.scopeHash)?.contentHash).toBe(pack.contentHash);
  });

  it('lets a build that finally read the ground replace a stored partial of the same identity', () => {
    /*
     * The row id is the identity of the ground, so a time-starved build and the
     * rebuild that completes it collide on id — and `INSERT OR IGNORE` alone
     * kept the starved one for the whole release. Measured live: a metropolitan
     * pack shipped four of six layers empty on a slow link, and no later build
     * could displace it.
     */
    const starved = packFor({
      id: 'pack-starved',
      releaseId: '2026-07-22.0',
      names: ['Only Survivor'],
      failedCellIds: ['g-0-0'],
    });
    expect(starved.state).toBe('partial');
    saveRegionPack(starved);

    const completed = packFor({
      id: 'pack-completed',
      releaseId: '2026-07-22.0',
      names: ['Harbour Museum', 'Old Fort', 'Grand Market'],
    });
    expect(completed.state).toBe('ready');
    const stored = saveRegionPack(completed);

    expect(stored.contentHash).toBe(completed.contentHash);
    const found = findRegionPack({
      scopeHash: completed.scopeHash,
      catalog: 'overture',
      releaseId: '2026-07-22.0',
    });
    expect(found?.contentHash).toBe(completed.contentHash);
    expect(found?.state).toBe('ready');
    /* Same identity, one row: the completion replaces, it does not accumulate. */
    expect(listRegionPacks().filter((row) => row.id === stored.id)).toHaveLength(1);
  });

  it('lets a fuller partial replace a thinner partial, and nothing replace a ready pack', () => {
    const thin = packFor({
      id: 'pack-thin',
      releaseId: '2026-07-22.0',
      names: ['One'],
      failedCellIds: ['g-0-0'],
    });
    saveRegionPack(thin);

    const fuller = packFor({
      id: 'pack-fuller',
      releaseId: '2026-07-22.0',
      names: ['One', 'Two', 'Three'],
      failedCellIds: ['g-0-0'],
    });
    const afterFuller = saveRegionPack(fuller);
    expect(afterFuller.contentHash).toBe(fuller.contentHash);

    const ready = packFor({ id: 'pack-ready', releaseId: '2026-07-22.0', names: ['One', 'Two'] });
    saveRegionPack(ready);

    /* A later, thinner build must not displace the ready pack — in either state. */
    const relapse = packFor({
      id: 'pack-relapse',
      releaseId: '2026-07-22.0',
      names: ['Only'],
      failedCellIds: ['g-0-0'],
    });
    const afterRelapse = saveRegionPack(relapse);
    expect(afterRelapse.contentHash).toBe(ready.contentHash);
    expect(afterRelapse.state).toBe('ready');
  });

  it('coalesces two builds racing for the same ground and release', () => {
    const first = packFor({ id: 'pack-a', releaseId: '2026-07-22.0', names: ['First'] });
    const second = packFor({ id: 'pack-b', releaseId: '2026-07-22.0', names: ['Second'] });

    const storedFirst = saveRegionPack(first);
    const storedSecond = saveRegionPack(second);

    // The loser reads back the winner rather than overwriting it, so a compiled
    // region can never name a pack that was replaced underneath it.
    expect(storedFirst.contentHash).toBe(first.contentHash);
    expect(storedSecond.contentHash).toBe(first.contentHash);
    expect(storedSecond.id).toBe(storedFirst.id);
    expect(listRegionPacks().filter((row) => row.state === 'ready')).toHaveLength(1);
  });

  it('never lets a failed build replace a usable pack', () => {
    const good = packFor({ id: 'pack-good', releaseId: '2026-07-22.0' });
    saveRegionPack(good);
    const bad = packFor({ id: 'pack-bad', releaseId: '2026-07-22.0', names: ['Nothing'] });
    saveRegionPack({ ...bad, state: 'failed', failure: { code: 'x', detail: 'Nothing came back.' } });

    const found = findRegionPack({
      scopeHash: bad.scopeHash,
      catalog: 'overture',
      releaseId: '2026-07-22.0',
    });
    expect(found?.contentHash).toBe(good.contentHash);
  });

  it('treats a corrupt payload as absent rather than crashing a compilation', () => {
    const pack = packFor({ id: 'pack-corrupt', releaseId: '2026-07-22.0' });
    saveRegionPack(pack);
    getDb()
      .prepare('UPDATE region_packs SET payload_json = ? WHERE id = ?')
      .run('{"schemaVersion":1,"id":', packRowId(pack));

    expect(
      findRegionPack({ scopeHash: pack.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' }),
    ).toBeNull();
    expect(getRegionPack(packRowId(pack))).toBeNull();
  });

  it('ignores a pack written under a schema version this build cannot read', () => {
    const pack = packFor({ id: 'pack-future', releaseId: '2026-07-22.0' });
    saveRegionPack(pack);
    getDb()
      .prepare('UPDATE region_packs SET schema_version = 99 WHERE id = ?')
      .run(packRowId(pack));

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
        ?.contentHash,
    ).toBe(pack.contentHash);
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
      })?.contentHash,
    ).toBe(stored.contentHash);
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

  /**
   * THE CACHE THAT NEVER WROTE.
   *
   * The builder minted `pack-{destinationCandidateId}-{releaseId}`, and that
   * string carries neither the schema version nor the bounds while the scope
   * hash carries both. Both tests below reproduce the live id exactly, because
   * the collision *is* the defect: with the builder's id as the primary key,
   * `INSERT OR IGNORE` silently discarded the new pack and the next build paid
   * the whole acquisition again.
   *
   * Nothing about the loss was visible from inside the build that suffered it —
   * the writer reads back, finds a row it cannot parse, and returns its own
   * in-memory pack — which is why this survived a live compilation of two
   * continents without anybody noticing the store was empty afterwards.
   */
  it('stores a fresh pack over a row this build can no longer read', () => {
    const pack = packFor({ id: livePackId('2026-07-22.0'), releaseId: '2026-07-22.0' });

    // What an earlier release of this product left behind: the same id, an
    // older schema, and therefore a different scope hash.
    getDb()
      .prepare(
        `INSERT INTO region_packs
           (id, scope_hash, catalog, release_id, schema_version, state, content_hash,
            record_count, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        livePackId('2026-07-22.0'),
        'v3/relation/1/40.6000/-74.1000/40.8000/-73.9000',
        'overture',
        '2026-07-22.0',
        3,
        'ready',
        'content-hash-from-an-older-schema',
        1,
        '{"schemaVersion":3}',
        '2026-07-01T00:00:00.000Z',
      );

    saveRegionPack(pack);

    expect(
      findRegionPack({ scopeHash: pack.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' })
        ?.contentHash,
    ).toBe(pack.contentHash);
  });

  it('keeps two packs for one destination when they describe different ground', () => {
    const shared = livePackId('2026-07-22.0');
    const narrow = packFor({ id: shared, releaseId: '2026-07-22.0', names: ['Narrow'] });
    const wide = packFor({
      id: shared,
      releaseId: '2026-07-22.0',
      names: ['Wide'],
      scope: scopeFor({
        shape: {
          kind: 'bounds',
          bounds: { southWest: { lat: 40.4, lng: -74.3 }, northEast: { lat: 41.0, lng: -73.7 } },
        },
      }),
    });
    // Precondition: one destination, one release, two boxes — which is the
    // ordinary case, because the box is derived from the traveller.
    expect(wide.scopeHash).not.toBe(narrow.scopeHash);

    saveRegionPack(narrow);
    saveRegionPack(wide);

    expect(listRegionPacks()).toHaveLength(2);
    expect(
      findRegionPack({ scopeHash: wide.scopeHash, catalog: 'overture', releaseId: '2026-07-22.0' })
        ?.contentHash,
    ).toBe(wide.contentHash);
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
