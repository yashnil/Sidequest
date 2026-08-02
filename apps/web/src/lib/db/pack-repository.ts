import 'server-only';
import {
  isPackUsable,
  regionPackSchema,
  REGION_PACK_VERSION,
  type RegionPack,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * REGION PACKS, STORED IMMUTABLY.
 *
 * Same discipline as `compiled_regions` and the same reason for it: a compiled
 * region records which pack it was built from, so a pack that could be edited in
 * place would silently change what an existing plan claims to rest on.
 *
 * The read path is deliberately three-tiered, because the three answers are
 * genuinely different things to tell a traveller:
 *
 * 1. a pack for this ground **and this release** — reuse it, say nothing;
 * 2. a pack for this ground from an **older** release — usable, and labelled;
 * 3. nothing — build one, or fail honestly.
 *
 * Every read parses through the schema. A row that no longer validates — a
 * schema version bump, a truncated write — is treated as absent and swept,
 * rather than being cast and blowing up two screens later.
 */

interface PackRow {
  id: string;
  scope_hash: string;
  catalog: string;
  release_id: string;
  schema_version: number;
  state: string;
  content_hash: string;
  record_count: number;
  payload_json: string;
  created_at: string;
  expires_at: string | null;
}

function parseRow(row: PackRow): RegionPack | null {
  if (row.schema_version !== REGION_PACK_VERSION) return null;
  try {
    return regionPackSchema.parse(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
}

/** A usable pack for this ground built from this release, newest first. */
export function findRegionPack(input: {
  scopeHash: string;
  catalog: string;
  releaseId: string;
}): RegionPack | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM region_packs
        WHERE scope_hash = ? AND catalog = ? AND release_id = ?
          AND state IN ('ready', 'partial')
        ORDER BY created_at DESC
        LIMIT 3`,
    )
    .all(input.scopeHash, input.catalog, input.releaseId) as PackRow[];

  for (const row of rows) {
    const pack = parseRow(row);
    if (pack && isPackUsable(pack.state)) return pack;
  }
  return null;
}

/**
 * The newest usable pack for this ground from *any* release.
 *
 * The deliberate last resort. Only reached when the catalogue or the data files
 * cannot be read at all, and the caller labels what it gets — because the
 * alternative in that situation is telling somebody their destination is empty,
 * which is a claim about the world rather than about a server.
 */
export function findStaleRegionPack(scopeHash: string): RegionPack | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM region_packs
        WHERE scope_hash = ? AND state IN ('ready', 'partial')
        ORDER BY created_at DESC
        LIMIT 5`,
    )
    .all(scopeHash) as PackRow[];

  for (const row of rows) {
    const pack = parseRow(row);
    if (pack) return pack;
  }
  return null;
}

export function getRegionPack(id: string): RegionPack | null {
  const row = getDb().prepare('SELECT * FROM region_packs WHERE id = ?').get(id) as
    | PackRow
    | undefined;
  return row ? parseRow(row) : null;
}

/**
 * Store a pack, and never replace a usable one with a worse one.
 *
 * `INSERT OR IGNORE` against the unique partial index is the whole concurrency
 * story: two tabs, two web instances or a retry racing the original all end up
 * with the row that got there first, and the loser reads it back rather than
 * overwriting. A pack that is not `ready` or `partial` is outside the index, so
 * failed builds can accumulate and be swept without ever competing.
 *
 * Returns the pack that is actually stored, which may be the other build's.
 */
export function saveRegionPack(pack: RegionPack): RegionPack {
  const db = getDb();
  const release = pack.releases[0];
  if (!release) return pack;

  const stored = db.transaction((): RegionPack => {
    db.prepare(
      `INSERT OR IGNORE INTO region_packs
         (id, scope_hash, catalog, release_id, schema_version, state, content_hash,
          record_count, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pack.id,
      pack.scopeHash,
      release.catalog,
      release.releaseId,
      pack.schemaVersion,
      pack.state,
      pack.contentHash,
      pack.diagnostics.featuresRetained,
      JSON.stringify(pack),
      pack.createdAt,
      pack.refreshRecommendedAfter ?? null,
    );

    if (!isPackUsable(pack.state)) return pack;
    const winner = findRegionPack({
      scopeHash: pack.scopeHash,
      catalog: release.catalog,
      releaseId: release.releaseId,
    });
    return winner ?? pack;
  })();

  pruneRegionPacks();
  return stored;
}

/**
 * How many packs to keep for one piece of ground.
 *
 * Two, so an existing compiled region built from the previous release can still
 * be explained after a refresh, and no more, because a pack is megabytes.
 */
const PACKS_PER_SCOPE = 2;

/** Total packs across the database. A development store, not a warehouse. */
const MAX_PACKS = 40;

/**
 * Sweep failed builds and superseded packs.
 *
 * Deliberately not a cascade from anything: a pack outlives the trip that
 * caused it to be built, which is the entire point of it being shared. So it is
 * swept on age and count rather than on ownership.
 */
export function pruneRegionPacks(): number {
  const db = getDb();
  let removed = 0;
  try {
    removed += db
      .prepare(`DELETE FROM region_packs WHERE state NOT IN ('ready', 'partial')`)
      .run().changes;

    removed += db
      .prepare(
        `DELETE FROM region_packs WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY scope_hash ORDER BY created_at DESC) AS rank
             FROM region_packs
           ) WHERE rank > ?
         )`,
      )
      .run(PACKS_PER_SCOPE).changes;

    removed += db
      .prepare(
        `DELETE FROM region_packs WHERE id IN (
           SELECT id FROM region_packs ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(MAX_PACKS).changes;
  } catch (error) {
    console.error('Could not prune region packs', error);
  }
  return removed;
}

export interface PackSummary {
  id: string;
  scopeHash: string;
  catalog: string;
  releaseId: string;
  state: string;
  recordCount: number;
  createdAt: string;
  bytes: number;
}

/** Every stored pack, for the technical panel. Never the payloads. */
export function listRegionPacks(): PackSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, scope_hash, catalog, release_id, state, record_count, created_at,
              LENGTH(payload_json) AS bytes
         FROM region_packs ORDER BY created_at DESC LIMIT 50`,
    )
    .all() as (Omit<PackRow, 'payload_json' | 'schema_version' | 'content_hash' | 'expires_at'> & {
    bytes: number;
  })[];

  return rows.map((row) => ({
    id: row.id,
    scopeHash: row.scope_hash,
    catalog: row.catalog,
    releaseId: row.release_id,
    state: row.state,
    recordCount: row.record_count,
    createdAt: row.created_at,
    bytes: row.bytes,
  }));
}
