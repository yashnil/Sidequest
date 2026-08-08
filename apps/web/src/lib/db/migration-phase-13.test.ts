import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COLUMN_MIGRATIONS, INDEX_MIGRATIONS, SCHEMA_SQL } from './schema';
import { PRE_PHASE_13_SCHEMA } from './fixtures/pre-phase-13-schema';

/**
 * MIGRATING A REAL PHASE-12 DATABASE ACROSS PHASE 13.
 *
 * Phase 13 adds eleven tables and changes none, which is the easiest kind of
 * migration and therefore the kind most likely to be assumed rather than
 * checked. Two things have to be true and neither is obvious:
 *
 * **Nothing already stored moves.** A trip somebody made last month, an artifact
 * they were shown, an itinerary they are about to travel on — every one has to
 * come out of the upgrade byte-identical. A benchmark that perturbed the product
 * it was measuring would be worthless twice over.
 *
 * **The new tables arrive empty.** Arriving *empty* is the assertion, not merely
 * arriving. A table that came up populated with a placeholder session would put
 * a comparison in the results view that nobody ran.
 *
 * The schema fixture is a frozen literal, never an import of the live schema. If
 * somebody "updates" it, this file migrates the present to the present and
 * passes forever while proving nothing.
 */

const NOW = '2026-08-01T10:00:00.000Z';

const BENCHMARK_TABLES = [
  'benchmark_sessions',
  'benchmark_assignments',
  'benchmark_runs',
  'benchmark_plans',
  'benchmark_native_artifacts',
  'benchmark_questions',
  'benchmark_validations',
  'benchmark_metrics',
  'benchmark_reviews',
  'benchmark_review_drafts',
  'benchmark_post_reveal',
  'benchmark_corrections',
  'benchmark_model_calls',
  'benchmark_operations',
  'benchmark_shared_worlds',
  'benchmark_session_clock',
] as const;

let directory: string;

/** Exactly what `getDb()` does on open: schema, then columns, then indexes. */
function migrate(databasePath: string): void {
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const apply = db.transaction(() => {
    for (const migration of COLUMN_MIGRATIONS) {
      const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as {
        name: string;
      }[];
      if (columns.length === 0) continue;
      if (columns.some((column) => column.name === migration.column)) continue;
      db.exec(
        `ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`,
      );
    }
  });
  apply();
  for (const statement of INDEX_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch {
      // The driver swallows these too, and for the same reason: an index is an
      // optimisation, and a database that got three of four is faster than one
      // that rolled all four back because a table it does not have was named.
    }
  }
  db.close();
}

/**
 * A database with real rows in it, written under the old schema.
 *
 * Deliberately modest — a trip, a profile, an itinerary and a compiled region.
 * The point is not breadth of coverage; the other migration tests have that. The
 * point is that these exact bytes are still here afterwards.
 */
function seedPhase12(db: Database.Database): void {
  db.prepare(
    `INSERT INTO trips
       (id, mode, destination_input, region_id, start_date, end_date, arrival_time,
        departure_time, adults, children, traveler_needs, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'trip-1',
    'known_destination',
    'Somewhere',
    'region-1',
    '2026-09-01',
    '2026-09-05',
    '14:00',
    '11:00',
    2,
    0,
    '[]',
    'planned',
    NOW,
    NOW,
  );

  db.prepare(
    `INSERT INTO traveler_profiles
       (trip_id, profile_version, answers_json, profile_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('trip-1', 3, '{"pace":"balanced"}', '{"version":3}', NOW, NOW);

  db.prepare(
    `INSERT INTO itineraries
       (trip_id, version, region_id, base_id, base_name, start_date, end_date, status,
        summary, diagnostics_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'trip-1',
    6,
    'region-1',
    'base-1',
    'A base',
    '2026-09-01',
    '2026-09-05',
    'ready',
    'A stored plan somebody may be about to travel on.',
    '{"plannerVersion":1}',
    NOW,
    NOW,
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-migration-p13-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('a Phase 12 database upgraded to Phase 13', () => {
  function openSeeded(): string {
    const path = join(directory, 'phase12.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(PRE_PHASE_13_SCHEMA);
    seedPhase12(db);
    db.close();
    return path;
  }

  it('starts without a single benchmark table', () => {
    const path = openSeeded();
    const db = new Database(path);
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]).map((row) => row.name),
    );
    db.close();
    for (const table of BENCHMARK_TABLES) {
      expect(names.has(table), `${table} should not exist before the upgrade`).toBe(false);
    }
  });

  it('gains every benchmark table, and every one of them arrives empty', () => {
    const path = openSeeded();
    migrate(path);

    const db = new Database(path);
    for (const table of BENCHMARK_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
      expect(row.total, `${table} arrived with rows in it`).toBe(0);
    }
    db.close();
  });

  it('leaves every stored payload byte-identical', () => {
    const path = openSeeded();

    const before = new Database(path);
    const tripBefore = before.prepare('SELECT * FROM trips WHERE id = ?').get('trip-1');
    const profileBefore = before
      .prepare('SELECT * FROM traveler_profiles WHERE trip_id = ?')
      .get('trip-1');
    const itineraryBefore = before
      .prepare('SELECT * FROM itineraries WHERE trip_id = ?')
      .get('trip-1');
    before.close();

    migrate(path);

    const after = new Database(path);
    expect(after.prepare('SELECT * FROM trips WHERE id = ?').get('trip-1')).toEqual(tripBefore);
    expect(
      after.prepare('SELECT * FROM traveler_profiles WHERE trip_id = ?').get('trip-1'),
    ).toEqual(profileBefore);
    expect(after.prepare('SELECT * FROM itineraries WHERE trip_id = ?').get('trip-1')).toEqual(
      itineraryBefore,
    );
    after.close();
  });

  it('is a no-op the second time it runs', () => {
    const path = openSeeded();
    migrate(path);

    const first = new Database(path);
    const snapshot = JSON.stringify(
      (first.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all() as unknown[]),
    );
    first.close();

    migrate(path);

    const second = new Database(path);
    const again = JSON.stringify(
      (second.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all() as unknown[]),
    );
    second.close();

    expect(again).toBe(snapshot);
  });

  it('never cascades a benchmark session away with a trip', () => {
    /*
     * The one foreign key this phase deliberately does not create.
     *
     * Every other trip-scoped table in this schema cascades, which is right for
     * a traveller's own data and exactly wrong for a record of an experiment: a
     * benchmark that vanished because somebody tidied up a trip would take the
     * evidence with it. `trip_id` is a plain column, and this asserts it stays
     * one rather than trusting the DDL to be read.
     */
    const path = openSeeded();
    migrate(path);

    const db = new Database(path);
    const keys = db.prepare('PRAGMA foreign_key_list(benchmark_sessions)').all() as {
      table: string;
      on_delete: string;
    }[];
    expect(keys.some((key) => key.table === 'trips')).toBe(false);
    db.close();
  });

  it('refuses a metric that is unavailable and yet carries a number', () => {
    const path = openSeeded();
    migrate(path);
    const db = new Database(path);
    seedSession(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO benchmark_metrics
             (session_id, run_id, metric_key, availability, value_num, unit,
              unavailable_reason, detail, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run('s-1', 'r-1', 'totalWallTimeMs', 'unavailable', 0, 'ms', 'run_failed', 'why', NOW),
    ).toThrow();
    db.close();
  });

  it('refuses a measured metric with no number, which is how an absence becomes a zero', () => {
    const path = openSeeded();
    migrate(path);
    const db = new Database(path);
    seedSession(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO benchmark_metrics
             (session_id, run_id, metric_key, availability, value_num, unit,
              unavailable_reason, detail, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run('s-1', 'r-1', 'modelCalls', 'measured', null, null, null, null, NOW),
    ).toThrow();
    db.close();
  });

  it('refuses an infinite metric, which JSON would silently turn into null', () => {
    const path = openSeeded();
    migrate(path);
    const db = new Database(path);
    seedSession(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO benchmark_metrics
             (session_id, run_id, metric_key, availability, value_num, unit,
              unavailable_reason, detail, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run('s-1', 'r-1', 'inputTokens', 'measured', Infinity, 'tokens', null, null, NOW),
    ).toThrow();
    db.close();
  });

  it('allows only one active claim per operation identity', () => {
    const path = openSeeded();
    migrate(path);
    const db = new Database(path);
    seedSession(db);

    const insert = db.prepare(
      `INSERT INTO benchmark_operations
         (id, operation_key, session_id, kind, state, owner, attempt, started_at, heartbeat_at)
       VALUES (?,?,?,?,'running',?,?,?,?)`,
    );
    insert.run('op-1', 'key-1', 's-1', 'generate', 'owner-a', 1, NOW, NOW);
    expect(() => insert.run('op-2', 'key-1', 's-1', 'generate', 'owner-b', 2, NOW, NOW)).toThrow();
    db.close();
  });
});

function seedSession(db: Database.Database): void {
  db.prepare(
    `INSERT INTO benchmark_sessions
       (id, schema_version, case_id, benchmark_version, trip_id, idempotency_key,
        request_version, request_json, input_hash, locale, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'created',?,?)`,
  ).run('s-1', 1, null, 'test', null, 'idem-1', 1, '{}', 'hash', 'en', NOW, NOW);
  db.prepare(
    `INSERT INTO benchmark_runs (id, session_id, arm, schema_version, state, started_at)
     VALUES (?,?,?,?,'running',?)`,
  ).run('r-1', 's-1', 'sidequest', 1, NOW);
}
