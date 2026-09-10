import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 MIGRATION — ACCOUNTS, PEOPLE, CASCADES, ON A DATABASE THAT HAS SOMETHING IN IT.
 *
 * Three things have to be true of an existing database after the first V6
 * connection, and each is checked here against a hand-written pre-V6 shape
 * rather than the current schema:
 *
 * 1. The new tables exist and `trips.user_id` references `users`.
 * 2. The five tables Ship V1 recorded as lazily created — written without a
 *    foreign key — are rebuilt with `ON DELETE CASCADE`, every row whose trip
 *    still exists is carried, and an orphan is not.
 * 3. `PRAGMA user_version` is stamped, and a second connection changes nothing.
 */

const PRE_V6 = `
CREATE TABLE trips (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, destination_input TEXT NOT NULL,
  region_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  arrival_time TEXT NOT NULL, departure_time TEXT NOT NULL,
  adults INTEGER NOT NULL, children INTEGER NOT NULL,
  traveler_needs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  owner_token TEXT, share_token TEXT
);
CREATE TABLE booked_plan_items (
  id TEXT PRIMARY KEY, trip_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE readiness_profiles (
  trip_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE trip_checks (
  trip_id TEXT NOT NULL, list TEXT NOT NULL, item_id TEXT NOT NULL, checked_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, list, item_id)
);
CREATE TABLE trip_intelligence (
  trip_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL, built_at TEXT NOT NULL
);
CREATE TABLE trip_fx_rates (
  trip_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE itinerary_locks (
  trip_id TEXT NOT NULL, place_id TEXT NOT NULL, day_number INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, place_id)
);
`;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidequest-v6-'));
  path = join(dir, 'pre-v6.db');
  const db = new Database(path);
  db.exec(PRE_V6);
  const now = '2026-09-01T00:00:00.000Z';
  db.prepare(`INSERT INTO trips VALUES ('t1','known_destination','Hokkaido','dynamic','2027-06-13','2027-06-20','15:00','11:00',3,0,'[]','planned',?,?, 'owner-a', NULL)`).run(now, now);
  db.prepare(`INSERT INTO booked_plan_items VALUES ('b1','t1','{"type":"lodging"}',?)`).run(now);
  db.prepare(`INSERT INTO booked_plan_items VALUES ('b-orphan','t-gone','{"type":"flight"}',?)`).run(now);
  db.prepare(`INSERT INTO readiness_profiles VALUES ('t1','{"passport":"x"}',?)`).run(now);
  db.prepare(`INSERT INTO readiness_profiles VALUES ('t-gone','{"passport":"orphan"}',?)`).run(now);
  db.prepare(`INSERT INTO trip_checks VALUES ('t1','packing','p1',?)`).run(now);
  db.prepare(`INSERT INTO itinerary_locks VALUES ('t1','place-1',2,?)`).run(now);
  db.close();
  vi.resetModules();
  process.env.SIDEQUEST_DB_PATH = path;
  delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
});

afterEach(() => {
  const db = (globalThis as { sidequestDb?: { close(): void } }).sidequestDb;
  db?.close();
  delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('the V6 migration', () => {
  it('adds accounts, people, evidence and lifecycle tables and links trips to users', async () => {
    const { getDb } = await import('./client');
    const db = getDb();
    const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name));
    for (const name of ['users', 'auth_sessions', 'auth_states', 'travelers', 'trip_party_members', 'preference_evidence', 'trip_status_history', 'saved_ideas', 'trip_feedback']) expect(tables.has(name), name).toBe(true);
    const columns = (db.prepare('PRAGMA table_info(trips)').all() as { name: string }[]).map((c) => c.name);
    for (const name of ['user_id', 'title', 'lifecycle_override', 'timing_lock', 'archived_at']) expect(columns, name).toContain(name);
    const keys = db.prepare('PRAGMA foreign_key_list(trips)').all() as { table: string; from: string }[];
    expect(keys.some((k) => k.table === 'users' && k.from === 'user_id')).toBe(true);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(6);
  });

  it('rebuilds the lazily created tables with a cascade, keeps every live row and drops the orphans', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getDb } = await import('./client');
    const db = getDb();
    for (const table of ['booked_plan_items', 'readiness_profiles', 'trip_checks', 'trip_intelligence', 'trip_fx_rates', 'itinerary_locks']) {
      const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[];
      expect(keys.some((k) => k.table === 'trips' && k.on_delete === 'CASCADE'), table).toBe(true);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM booked_plan_items').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM readiness_profiles').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT payload_json FROM readiness_profiles WHERE trip_id = ?').get('t1') as { payload_json: string }).payload_json).toBe('{"passport":"x"}');
    expect((db.prepare('SELECT COUNT(*) AS n FROM itinerary_locks').get() as { n: number }).n).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/orphaned rows/), expect.objectContaining({ table: 'booked_plan_items', orphans: 1 }));
    /* And the cascade is real: deleting the trip deletes its booked items, readiness profile, checks and locks. */
    db.prepare('DELETE FROM trips WHERE id = ?').run('t1');
    expect((db.prepare('SELECT COUNT(*) AS n FROM booked_plan_items').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM readiness_profiles').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM trip_checks').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM itinerary_locks').get() as { n: number }).n).toBe(0);
    warn.mockRestore();
  });

  it('is idempotent: a second connection rebuilds nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await import('./client');
    first.getDb().close();
    delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
    vi.resetModules();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = await import('./client');
    const db = second.getDb();
    expect((db.prepare('SELECT COUNT(*) AS n FROM booked_plan_items').get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%__v6'`).all() as unknown[]).length).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});
