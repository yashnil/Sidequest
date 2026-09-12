import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9 MIGRATION — EXECUTION TABLES ON AN EMPTY DATABASE AND ON A V6 SHAPE.
 *
 * What must hold after the first V9 connection: the seven execution tables
 * exist, each cascades from `trips` (or `users`), every pre-existing row is
 * untouched, `user_version` reads 9, and a second connection changes nothing.
 * The V6 shape is written by hand rather than imported, so this test keeps
 * meaning when the current schema moves on.
 */

const V6_SHAPE = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, display_name TEXT, picture_url TEXT,
  provider TEXT NOT NULL, provider_subject TEXT NOT NULL, home_airport TEXT, profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, UNIQUE (provider, provider_subject)
);
CREATE TABLE trips (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL, destination_input TEXT NOT NULL,
  region_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  arrival_time TEXT NOT NULL, departure_time TEXT NOT NULL,
  adults INTEGER NOT NULL, children INTEGER NOT NULL,
  traveler_needs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  owner_token TEXT, share_token TEXT, timing_lock TEXT, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, title TEXT
);
CREATE TABLE booked_plan_items (
  id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

const V9_TABLES = ['trip_decisions', 'booking_resolutions', 'booking_imports', 'calendar_feeds', 'trip_fact_observations', 'trip_fact_checks', 'preference_dismissals'] as const;

let dir: string;
let path: string;

function open(): Database.Database {
  return new Database(path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidequest-v9-'));
  path = join(dir, 'pre-v9.db');
  const db = new Database(path);
  db.exec(V6_SHAPE);
  db.prepare("INSERT INTO users (id, provider, provider_subject, created_at, last_seen_at) VALUES ('u1', 'fixture', 's1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date, arrival_time, departure_time, adults, children, status, created_at, updated_at, owner_token, user_id) VALUES ('t1', 'known_destination', 'Kyoto', 'dynamic', '2026-10-12', '2026-10-16', '15:00', '11:00', 2, 0, 'planned', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'tok', 'u1')").run();
  db.prepare("INSERT INTO booked_plan_items (id, trip_id, payload_json, created_at) VALUES ('b1', 't1', '{\"id\":\"b1\",\"tripId\":\"t1\",\"type\":\"lodging\",\"title\":\"Hotel Granvia\",\"status\":\"booked\",\"locked\":true,\"createdAt\":\"2026-01-01T00:00:00.000Z\"}', '2026-01-01T00:00:00Z')").run();
  db.close();
  delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
  process.env.SIDEQUEST_DB_PATH = path;
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { sidequestDb?: { close(): void } }).sidequestDb?.close();
  delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('the V9 migration', () => {
  it('adds the execution tables with their cascades, keeps every row, stamps user_version 9', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getDb } = await import('./client');
    const db = getDb();
    for (const table of V9_TABLES) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      expect(exists, table).toBeTruthy();
      const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[];
      const parent = table === 'preference_dismissals' ? 'users' : 'trips';
      expect(keys.some((k) => k.table === parent && k.on_delete === 'CASCADE'), `${table} cascades from ${parent}`).toBe(true);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM booked_plan_items').get() as { n: number }).n).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(9);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('cascades execution rows when a trip is deleted, and a second open changes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getDb } = await import('./client');
    const repo = await import('./execution-repository');
    const db = getDb();
    repo.recordDecision('t1', { key: 'route', chosen: 'Kyoto only', lock: 'user_explicit', decidedBy: 'traveller' });
    repo.setBookingResolution('t1', { bookingItemId: 'booking:rental', resolution: 'skipped', note: 'We will not drive' });
    const feed = repo.createCalendarFeed('t1');
    expect(repo.tripForFeedToken(feed.token)).toBe('t1');
    repo.recordObservations('t1', [{ factId: 'fact:forecast:2', kind: 'forecast', observedAt: '2026-10-01T00:00:00Z', previous: 'Clear', current: 'Rain', changed: true, dayNumbers: [2], summary: 'Day 2 now expects rain.' }]);
    repo.recordFactCheck('t1', { checked: 1 });
    repo.dismissFeature('u1', 'early_starts');
    expect(repo.listDecisions('t1')).toHaveLength(1);
    expect(repo.listBookingResolutions('t1')).toEqual([{ bookingItemId: 'booking:rental', resolution: 'skipped', note: 'We will not drive' }]);
    expect(repo.listObservations('t1')).toHaveLength(1);
    expect(repo.listDismissedFeatures('u1')).toEqual(['early_starts']);

    /* The token is stored hashed, never in clear; a revoked feed resolves to nothing. */
    const stored = db.prepare('SELECT token_hash FROM calendar_feeds').get() as { token_hash: string };
    expect(stored.token_hash).not.toContain(feed.token);
    expect(repo.revokeCalendarFeeds('t1')).toBe(1);
    expect(repo.tripForFeedToken(feed.token)).toBeNull();

    db.prepare("DELETE FROM trips WHERE id = 't1'").run();
    for (const table of ['trip_decisions', 'booking_resolutions', 'calendar_feeds', 'trip_fact_observations', 'trip_fact_checks']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }

    db.close();
    delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
    vi.resetModules();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const again = (await import('./client')).getDb();
    expect(again.pragma('user_version', { simple: true })).toBe(9);
    expect(error).not.toHaveBeenCalled();
    expect((again.prepare('SELECT COUNT(*) AS n FROM preference_dismissals').get() as { n: number }).n).toBe(1);
  });

  it('applies to an empty database in one open', async () => {
    rmSync(path);
    const empty = open();
    empty.close();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getDb } = await import('./client');
    const db = getDb();
    for (const table of V9_TABLES) expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table).toBeTruthy();
    expect(db.pragma('user_version', { simple: true })).toBe(9);
  });
});
