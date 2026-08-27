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
 *
 * The name a row is stored under is derived here rather than accepted from the
 * builder — see `packRowId`, and read it before changing anything in this file.
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

/**
 * A scope hash, split into the two things it actually says.
 *
 * `packScopeHash` composes `v{n}/{candidateId}/{swLat}/{swLng}/{neLat}/{neLng}`.
 * The candidate id is a provider identifier and may itself contain slashes, so
 * the bounds are read off the *end* rather than by counting from the front — a
 * naive split silently mis-parsed every OSM-style `relation/12345` id.
 *
 * Returns `null` for anything it cannot read, and every caller treats that as
 * "no widening", which keeps an unparseable key exactly as strict as it is now.
 */
interface ScopeGround {
  /** Version and candidate id: the piece of ground, independent of any radius. */
  identity: string;
  bounds: { swLat: number; swLng: number; neLat: number; neLng: number };
}

export function readScopeGround(scopeHash: string): ScopeGround | null {
  const parts = scopeHash.split('/');
  if (parts.length < 6) return null;
  const numbers = parts.slice(-4).map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const [swLat, swLng, neLat, neLng] = numbers as [number, number, number, number];
  return {
    identity: parts.slice(0, -4).join('/'),
    bounds: { swLat, swLng, neLat, neLng },
  };
}

/**
 * Whether a stored pack's ground contains the ground being asked for.
 *
 * The epsilon is a hair over the 4-decimal rounding `packScopeHash` applies
 * (about 11 m), so two derivations of the same boundary that differ only in the
 * last digit count as the same ground rather than as a miss.
 */
const BOUNDS_EPSILON = 0.0002;

function covers(stored: ScopeGround['bounds'], wanted: ScopeGround['bounds']): boolean {
  return (
    stored.swLat <= wanted.swLat + BOUNDS_EPSILON &&
    stored.swLng <= wanted.swLng + BOUNDS_EPSILON &&
    stored.neLat >= wanted.neLat - BOUNDS_EPSILON &&
    stored.neLng >= wanted.neLng - BOUNDS_EPSILON
  );
}

/** Escapes the two wildcards SQLite's LIKE recognises. */
function likePrefix(identity: string): string {
  return `${identity.replace(/[\\%_]/g, (char) => `\\${char}`)}/%`;
}

/**
 * A usable pack for this ground built from this release, newest first.
 *
 * TWO LOOKUPS, AND THE SECOND ONE IS THE POINT.
 *
 * The exact-hash query is unchanged and still runs first, so nothing that hits
 * today behaves differently. What it could not do is recognise the same ground
 * arriving under a different boundary: the hash carries the derived bounding
 * box, and the box is a function of the *traveller* — nights, pace, whether
 * they will drive — rather than of the destination. So a second Tokyo trip with
 * a slightly different radius missed a stored pack covering the same city and
 * re-fetched 3,787 records to learn what was already on disk.
 *
 * The widening asks the question the cache was always meant to answer: is there
 * a pack for *this piece of ground*, from *this release*, whose extent already
 * contains what is being asked for? A pack covering more ground answers a
 * request for less; the reverse never does, and is not offered.
 */
export function findRegionPack(input: {
  scopeHash: string;
  catalog: string;
  releaseId: string;
}): RegionPack | null {
  const db = getDb();
  const rows = db
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

  const wanted = readScopeGround(input.scopeHash);
  if (!wanted) return null;

  const nearby = db
    .prepare(
      `SELECT * FROM region_packs
        WHERE scope_hash LIKE ? ESCAPE '\\' AND catalog = ? AND release_id = ?
          AND state IN ('ready', 'partial')
        ORDER BY created_at DESC
        LIMIT 10`,
    )
    .all(likePrefix(wanted.identity), input.catalog, input.releaseId) as PackRow[];

  for (const row of nearby) {
    const stored = readScopeGround(row.scope_hash);
    if (!stored || !covers(stored.bounds, wanted.bounds)) continue;
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
 * THE NAME A PACK IS STORED UNDER, DERIVED FROM WHAT MAKES ONE PACK DIFFERENT
 * FROM ANOTHER.
 *
 * THE CACHE THAT NEVER WROTE. The builder minted
 * `pack-{destinationCandidateId}-{releaseId}`, and that string carries neither
 * the schema version nor the bounds — while `scope_hash` carries both. The row
 * id is the primary key, so `INSERT OR IGNORE` silently discarded any pack
 * whose id already existed:
 *
 * - a fresh v4 pack could not persist over a v3 row for the same city, because
 *   the two ids are identical and only the *scope hashes* differ by version;
 * - two trips to one destination whose derived boxes differ — the box is a
 *   function of the traveller — collided on id, so the second was thrown away.
 *
 * Neither loss was visible: `saveRegionPack` reads back the winner, finds a row
 * this build cannot parse, and returns the in-memory pack, so the *current*
 * build works and the next one pays the whole 94–126 MB acquisition again. That
 * is why the compiler re-bought Tokyo on every build and why an offline gate
 * kept judging a pack no current code had written.
 *
 * So the identity is composed from the four things that make two packs
 * genuinely different — schema version, ground, catalogue, release — and the
 * builder's own id is not one of them. Different ground or a different schema is
 * a different row; an equivalent pack is the same row and is reused.
 */
export function packRowId(pack: RegionPack): string {
  const release = pack.releases[0];
  return [
    `v${pack.schemaVersion}`,
    pack.scopeHash,
    release?.catalog ?? 'unknown',
    release?.releaseId ?? 'unknown',
  ].join('|');
}

/**
 * Store a pack: never replace a usable one with a worse one, and never let a
 * worse one squat on the identity of a better one.
 *
 * `INSERT OR IGNORE` against the unique partial index is the concurrency
 * story: two tabs, two web instances or a retry racing the original all end up
 * with one winning row, and the loser reads it back rather than overwriting. A
 * pack that is not `ready` or `partial` is outside the index, so failed builds
 * can accumulate and be swept without ever competing.
 *
 * What IGNORE alone could not express is *completion*. The row id is the
 * identity of the ground — schema, scope, catalogue, release — so a rebuild
 * that finally reads the ground a partial pack missed arrives under the same
 * id, and IGNORE was silently discarding it: one time-starved build became the
 * truth about a destination for the whole release, measured live when a
 * metropolitan pack shipped four of six layers empty and no later build could
 * displace it. So a strictly better pack — a `ready` one over a `partial` one,
 * or more retained ground in the same state — replaces the row; anything else
 * is ignored exactly as before. Races still converge: replacement happens only
 * on strict improvement, so two equal builds keep the first and two unequal
 * builds keep the better regardless of order.
 *
 * The stored pack carries the row's own id, so the artifact that names a pack
 * names something `getRegionPack` can find. The builder's id is provenance
 * about one build; the row's id is the identity of the ground.
 *
 * Returns the pack that is actually stored, which may be the other build's.
 */
export function saveRegionPack(pack: RegionPack): RegionPack {
  const db = getDb();
  const release = pack.releases[0];
  if (!release) return pack;

  const named: RegionPack = { ...pack, id: packRowId(pack) };

  const stored = db.transaction((): RegionPack => {
    /*
     * A failed row is not a pack anybody can read, and it must not squat on the
     * identity of the ground it failed to cover. The sweep below removes them
     * anyway; this is the case where the sweep did not get to run.
     */
    db.prepare(`DELETE FROM region_packs WHERE id = ? AND state NOT IN ('ready', 'partial')`).run(
      named.id,
    );

    const existing = db
      .prepare(`SELECT state, record_count FROM region_packs WHERE id = ?`)
      .get(named.id) as { state: string; record_count: number } | undefined;
    const rank = (state: string): number => (state === 'ready' ? 1 : 0);
    const strictlyBetter =
      existing !== undefined &&
      isPackUsable(named.state) &&
      (rank(named.state) > rank(existing.state) ||
        (rank(named.state) === rank(existing.state) &&
          named.diagnostics.featuresRetained > existing.record_count));

    if (strictlyBetter) {
      db.prepare(
        `UPDATE region_packs
            SET state = ?, content_hash = ?, record_count = ?, payload_json = ?,
                created_at = ?, expires_at = ?, schema_version = ?
          WHERE id = ?`,
      ).run(
        named.state,
        named.contentHash,
        named.diagnostics.featuresRetained,
        JSON.stringify(named),
        named.createdAt,
        named.refreshRecommendedAfter ?? null,
        named.schemaVersion,
        named.id,
      );
    } else {
      db.prepare(
        `INSERT OR IGNORE INTO region_packs
           (id, scope_hash, catalog, release_id, schema_version, state, content_hash,
            record_count, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        named.id,
        named.scopeHash,
        release.catalog,
        release.releaseId,
        named.schemaVersion,
        named.state,
        named.contentHash,
        named.diagnostics.featuresRetained,
        JSON.stringify(named),
        named.createdAt,
        named.refreshRecommendedAfter ?? null,
      );
    }

    if (!isPackUsable(named.state)) return named;
    const winner = findRegionPack({
      scopeHash: named.scopeHash,
      catalog: release.catalog,
      releaseId: release.releaseId,
    });
    return winner ?? named;
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
