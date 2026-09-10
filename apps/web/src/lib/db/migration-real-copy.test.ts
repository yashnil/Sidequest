import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 §51 — THE MIGRATION AGAINST A COPY OF A REAL DATABASE.
 *
 * Runs only when `SIDEQUEST_MIGRATION_SOURCE` names an existing SQLite file.
 * The source is never opened for writing: `VACUUM INTO` takes a consistent
 * copy (the WAL included) into a temp directory, and every assertion is
 * against the copy. What must hold: every trip, itinerary, draft, version,
 * booked item and readiness profile survives; the V6 tables exist; the six
 * formerly lazy tables carry their cascade; `user_version` is stamped; a
 * second open changes nothing.
 */

const SOURCE = process.env.SIDEQUEST_MIGRATION_SOURCE;
const enabled = Boolean(SOURCE && existsSync(SOURCE));

let dir: string;
let copy: string;

function count(db: Database.Database, table: string): number {
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!exists) return -1;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  if (!enabled) return;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-real-copy-'));
  copy = join(dir, 'copy.db');
  const source = new Database(SOURCE!, { readonly: true });
  source.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  source.close();
  delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
  process.env.SIDEQUEST_DB_PATH = copy;
  vi.resetModules();
});

afterEach(() => {
  if (!enabled) return;
  (globalThis as { sidequestDb?: { close(): void } }).sidequestDb?.close();
  delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)('migrating a copy of the real database', () => {
  it('keeps every row, adds the V6 tables and cascades, stamps the version, and is idempotent', async () => {
    const before = new Database(copy, { readonly: true });
    const tables = ['trips', 'itineraries', 'itinerary_days', 'itinerary_items', 'trip_drafts', 'composition_attempts', 'traveler_profiles', 'trip_intents', 'booked_plan_items', 'readiness_profiles', 'trip_checks', 'trip_intelligence', 'refinement_versions', 'refinement_runs', 'refinement_checkpoints', 'itinerary_locks'];
    const counts = Object.fromEntries(tables.map((t) => [t, count(before, t)]));
    const orphans = Object.fromEntries(['booked_plan_items', 'readiness_profiles', 'trip_checks', 'trip_intelligence', 'trip_fx_rates', 'itinerary_locks'].map((t) => [t, count(before, t) < 0 ? 0 : (before.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE trip_id NOT IN (SELECT id FROM trips)`).get() as { n: number }).n]));
    before.close();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { getDb } = await import('./client');
    const db = getDb();
    for (const [table, n] of Object.entries(counts)) {
      if (n < 0) continue;
      const expected = table in orphans ? n - (orphans[table] ?? 0) : n;
      expect(count(db, table), table).toBe(expected);
    }
    for (const table of ['users', 'auth_sessions', 'travelers', 'trip_party_members', 'preference_evidence', 'trip_status_history', 'trip_feedback']) expect(count(db, table), table).toBeGreaterThanOrEqual(0);
    for (const table of ['booked_plan_items', 'readiness_profiles', 'trip_checks', 'trip_intelligence', 'trip_fx_rates', 'itinerary_locks']) {
      const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[];
      expect(keys.some((k) => k.table === 'trips' && k.on_delete === 'CASCADE'), table).toBe(true);
    }
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(6);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    /* Every existing trip still reads through the repository, and none has an owner account yet. */
    const { getTrip } = await import('./repository');
    const ids = (db.prepare('SELECT id FROM trips').all() as { id: string }[]).map((r) => r.id);
    let readable = 0;
    for (const id of ids) if (getTrip(id)) readable += 1;
    expect(readable).toBe(ids.length);
    expect((db.prepare('SELECT COUNT(*) AS n FROM trips WHERE user_id IS NOT NULL').get() as { n: number }).n).toBe(0);
    process.stdout.write(`REAL COPY: ${ids.length} trips, ${counts.itineraries} itineraries, orphans dropped ${JSON.stringify(orphans)}\n`);

    /* Idempotent. */
    db.close();
    delete (globalThis as { sidequestDb?: unknown }).sidequestDb;
    vi.resetModules();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const again = (await import('./client')).getDb();
    expect(count(again, 'trips')).toBe(ids.length);
    expect(error).not.toHaveBeenCalled();
  });
});
