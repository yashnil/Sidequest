import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COLUMN_MIGRATIONS, SCHEMA_SQL } from './schema';

/**
 * MIGRATING A DATABASE THAT ACTUALLY HAS SOMETHING IN IT.
 *
 * An empty database migrates trivially and proves nothing. What has to survive
 * is a database written by the build before this one, carrying the four things a
 * real user would have: an authored-region trip, a compiled-region trip, the
 * selections and itinerary they built, and a compilation that failed halfway.
 *
 * So the fixture below is the **pre-Phase-8 schema**, written out by hand rather
 * than imported — importing the current schema would make this test migrate the
 * present to the present and pass forever.
 */

/**
 * The schema as it stood before source-backed enrichment: no `source_documents`,
 * and compiled artifacts with no `evidence` key.
 */
const PRE_PHASE_8_SCHEMA = `
CREATE TABLE trips (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, destination_input TEXT NOT NULL,
  region_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  arrival_time TEXT NOT NULL, departure_time TEXT NOT NULL,
  adults INTEGER NOT NULL, children INTEGER NOT NULL,
  traveler_needs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE traveler_profiles (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL, answers_json TEXT NOT NULL, profile_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE discovery_selections (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (trip_id, place_id)
);
CREATE TABLE itineraries (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, region_id TEXT NOT NULL, base_id TEXT NOT NULL,
  base_name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT NOT NULL,
  transport_strategy_json TEXT NOT NULL DEFAULT '{}',
  food_plan_json TEXT NOT NULL DEFAULT '{}',
  issues_json TEXT NOT NULL DEFAULT '[]', unscheduled_json TEXT NOT NULL DEFAULT '[]',
  diagnostics_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE itinerary_days (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL, date TEXT NOT NULL, base_id TEXT NOT NULL,
  base_name TEXT NOT NULL, theme TEXT NOT NULL, intensity TEXT NOT NULL,
  window_json TEXT NOT NULL, totals_json TEXT NOT NULL,
  transport_json TEXT NOT NULL DEFAULT '{}', availability_json TEXT NOT NULL DEFAULT '{}',
  weather_json TEXT NOT NULL DEFAULT '{}', food_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (trip_id, day_number)
);
CREATE TABLE itinerary_items (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL,
  place_id TEXT, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL,
  item_json TEXT NOT NULL, PRIMARY KEY (trip_id, day_number, position)
);
CREATE TABLE food_selections (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  venue_id TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (trip_id, venue_id)
);
CREATE TABLE weather_cache (
  cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, stored_at TEXT NOT NULL
);
CREATE TABLE trip_intents (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, destination_query TEXT NOT NULL DEFAULT '',
  resolution_json TEXT, selected_candidate_id TEXT,
  clarifications_json TEXT NOT NULL DEFAULT '{}', scope_json TEXT,
  scope_revision INTEGER NOT NULL DEFAULT 0, selected_compiled_region_id TEXT,
  discovery_prefs_json TEXT, shortlist_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE compilation_jobs (
  id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  scope_fingerprint TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL,
  stages_json TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_detail TEXT,
  compiled_region_id TEXT, correlation_id TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_compilation_jobs_active
  ON compilation_jobs(trip_id) WHERE state IN ('queued', 'running');
CREATE TABLE compiled_regions (
  id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  scope_fingerprint TEXT NOT NULL, schema_version INTEGER NOT NULL,
  compiler_version TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE provider_cache (
  cache_key TEXT PRIMARY KEY, provider TEXT NOT NULL, payload_json TEXT NOT NULL,
  stored_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
`;

let directory: string;
let path: string;

/**
 * Exactly what `getDb()` does on open: apply the current schema, then the
 * additive column migrations.
 *
 * Applied in-process against the fixture rather than through `getDb()`, because
 * that function caches one handle on `globalThis` for the life of the process —
 * a second open in the same test run would silently reuse the first database and
 * the fixture would never be touched.
 */
function migrate(databasePath: string): void {
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const apply = db.transaction(() => {
    for (const migration of COLUMN_MIGRATIONS) {
      const columns = db
        .prepare(`PRAGMA table_info(${migration.table})`)
        .all() as { name: string }[];
      if (columns.length === 0) continue;
      if (columns.some((column) => column.name === migration.column)) continue;
      db.exec(
        `ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`,
      );
    }
  });
  apply();
  db.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-migration-'));
  path = join(directory, 'legacy.db');
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(PRE_PHASE_8_SCHEMA);

  const now = '2026-07-30T10:00:00.000Z';

  // (1) An authored-region trip, exactly as the seed flow writes one.
  db.prepare(
    `INSERT INTO trips VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'trip-authored', 'known', 'Eastern Sierra', 'eastern-sierra',
    '2026-08-12', '2026-08-16', '14:00', '11:00', 2, 0, '[]', 'planned', now, now,
  );
  db.prepare(`INSERT INTO traveler_profiles VALUES (?,?,?,?,?,?)`).run(
    'trip-authored', 1, '{"answers":[]}', '{"version":1}', now, now,
  );
  db.prepare(`INSERT INTO discovery_selections VALUES (?,?,?,?,?)`).run(
    'trip-authored', 'place-a', 'included', 'user', now,
  );
  db.prepare(`INSERT INTO food_selections VALUES (?,?,?,?,?)`).run(
    'trip-authored', 'venue-a', 'included', 'auto', now,
  );
  db.prepare(`INSERT INTO itineraries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'trip-authored', 4, 'eastern-sierra', 'base-a', 'A base',
    '2026-08-12', '2026-08-16', 'ready', 'A summary.', '{}', '{}', '[]', '[]', '{}', now, now,
  );
  db.prepare(`INSERT INTO itinerary_days VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'trip-authored', 1, '2026-08-12', 'base-a', 'A base', 'Arrival', 'light',
    '{}', '{}', '{}', '{}', '{}', '{}', '[]',
  );
  db.prepare(`INSERT INTO itinerary_items VALUES (?,?,?,?,?,?,?,?)`).run(
    'trip-authored', 1, 0, 'place', 'place-a', 540, 660, '{"kind":"place"}',
  );

  // (2) A Phase-7 compiled trip, whose artifact has no `evidence` key at all.
  db.prepare(`INSERT INTO trips VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'trip-compiled', 'known', 'Somewhere Else', 'compiled-xyz',
    '2026-09-01', '2026-09-05', '13:00', '10:00', 2, 0, '[]', 'planned', now, now,
  );
  db.prepare(`INSERT INTO trip_intents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'trip-compiled', 'known', 'Somewhere Else', null, 'cand-1', '{}',
    '{"schemaVersion":1}', 2, 'region-1', null, null, now, now,
  );
  db.prepare(`INSERT INTO compiled_regions VALUES (?,?,?,?,?,?,?)`).run(
    'region-1', 'trip-compiled', 'fingerprint-1', 1, 'sidequest-compiler/1',
    JSON.stringify({ schemaVersion: 1, id: 'region-1', places: [] }), now,
  );

  // (3) A compilation that died halfway, which a crash genuinely leaves behind.
  db.prepare(`INSERT INTO compilation_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'job-failed', 'trip-compiled', 'fingerprint-0', 'failed', 'discovering_candidates',
    '[{"stage":"expanding_region","status":"done"}]', now, now, now, now, 0,
    'provider_unavailable', 'The map service did not answer.', null, 'corr-1',
  );

  db.prepare(`INSERT INTO provider_cache VALUES (?,?,?,?,?)`).run(
    'geocode|x', 'nominatim', '[]', now, '2027-01-01T00:00:00.000Z',
  );
  db.close();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('a pre-Phase-8 database survives the upgrade', () => {
  it('gains the new tables without touching a single stored row', () => {
    const before = new Database(path);
    const counts = {
      trips: (before.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n,
      selections: (before.prepare('SELECT COUNT(*) AS n FROM discovery_selections').get() as { n: number }).n,
      items: (before.prepare('SELECT COUNT(*) AS n FROM itinerary_items').get() as { n: number }).n,
      jobs: (before.prepare('SELECT COUNT(*) AS n FROM compilation_jobs').get() as { n: number }).n,
      regions: (before.prepare('SELECT COUNT(*) AS n FROM compiled_regions').get() as { n: number }).n,
    };
    before.close();

    migrate(path);

    const after = new Database(path);
    expect((after.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n).toBe(counts.trips);
    expect((after.prepare('SELECT COUNT(*) AS n FROM discovery_selections').get() as { n: number }).n).toBe(counts.selections);
    expect((after.prepare('SELECT COUNT(*) AS n FROM itinerary_items').get() as { n: number }).n).toBe(counts.items);
    expect((after.prepare('SELECT COUNT(*) AS n FROM compilation_jobs').get() as { n: number }).n).toBe(counts.jobs);
    expect((after.prepare('SELECT COUNT(*) AS n FROM compiled_regions').get() as { n: number }).n).toBe(counts.regions);

    // The new table exists and starts empty.
    const documents = after
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_documents'")
      .all();
    expect(documents).toHaveLength(1);
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM source_documents').get() as { n: number }).n,
    ).toBe(0);
    after.close();
  });

  it('leaves a Phase-7 artifact byte-identical, so an old plan still points at what built it', () => {
    const before = new Database(path);
    const original = (
      before.prepare('SELECT payload_json FROM compiled_regions WHERE id = ?').get('region-1') as {
        payload_json: string;
      }
    ).payload_json;
    before.close();

    migrate(path);

    const after = new Database(path);
    const migrated = (
      after.prepare('SELECT payload_json FROM compiled_regions WHERE id = ?').get('region-1') as {
        payload_json: string;
      }
    ).payload_json;
    after.close();

    // An artifact is immutable. A migration that rewrote one — even to add an
    // empty `evidence` — would break the promise that a stored plan points at
    // exactly the evidence it was built from.
    expect(migrated).toBe(original);
    expect(JSON.parse(migrated).evidence).toBeUndefined();
  });

  it('keeps a half-finished job readable rather than orphaning it', () => {
    migrate(path);
    const after = new Database(path);
    const job = after
      .prepare('SELECT state, error_code, stages_json FROM compilation_jobs WHERE id = ?')
      .get('job-failed') as { state: string; error_code: string; stages_json: string };
    after.close();

    expect(job.state).toBe('failed');
    expect(job.error_code).toBe('provider_unavailable');
    expect(JSON.parse(job.stages_json)).toHaveLength(1);
  });

  it('is idempotent: migrating twice changes nothing', () => {
    migrate(path);
    const first = new Database(path);
    const schemaA = first.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    first.close();

    migrate(path);
    const second = new Database(path);
    const schemaB = second.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    second.close();

    expect(schemaB).toEqual(schemaA);
  });

  it('keeps the duplicate-compilation guard after migrating', () => {
    migrate(path);
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    const insert = db.prepare(
      `INSERT INTO compilation_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const args = (id: string) =>
      [
        id, 'trip-compiled', 'fp', 'running', 'discovering_candidates', '[]',
        'now', 'now', null, 'now', 0, null, null, null, `corr-${id}`,
      ] as const;
    insert.run(...args('job-live-1'));
    // The unique partial index is what stops two tabs starting two compilations.
    expect(() => insert.run(...args('job-live-2'))).toThrow();
    db.close();
  });
});
