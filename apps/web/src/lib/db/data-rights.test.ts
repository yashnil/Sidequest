import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

/**
 * PRODUCTION PASS — "DELETE ALL MY DATA" LEAVES NOTHING BEHIND.
 *
 * Enumerated from the live schema rather than from a hand list: every table
 * with a column that names a trip, an account or a browser owner gets a row for
 * the person being deleted and a row for a stranger, and after the deletion no
 * table may still hold the person's row while every stranger's row survives. A
 * table added later is covered the moment it exists — or, if a row cannot be
 * synthesised for it, it must be named in `NOT_SYNTHESISED` with a reason.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-data-rights-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

/** Columns that tie a row to a person, directly or through their trip. */
const TRIP_COLUMNS = ['trip_id', 'resolved_trip_id'];
const OWNER_COLUMNS = ['user_id', 'owner_token'];

/** Tables a generic row cannot be built for, with why that is safe. Kept empty unless a reason is written. */
const NOT_SYNTHESISED = new Map<string, string>([]);

interface Column { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }
interface ForeignKey { table: string; from: string; to: string }

function columnsOf(db: Database.Database, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Column[];
}

let counter = 0;

/** Insert one row with every NOT NULL column filled; foreign keys come from `links` or are left null. */
function insertGeneric(db: Database.Database, table: string, values: Record<string, unknown>, links: Record<string, Record<string, unknown>>): void {
  const columns = columnsOf(db, table);
  const fks = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all() as ForeignKey[];
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.name in values) {
      row[column.name] = values[column.name];
      continue;
    }
    const fk = fks.find((entry) => entry.from === column.name);
    if (fk && links[fk.table] && fk.to in links[fk.table]!) {
      row[column.name] = links[fk.table]![fk.to];
      continue;
    }
    if (fk) {
      if (column.notnull) throw new Error(`${table}.${column.name} needs a ${fk.table} row`);
      continue;
    }
    if (column.notnull && column.dflt_value === null) {
      counter += 1;
      const type = column.type.toUpperCase();
      row[column.name] = /INT/.test(type) ? (column.pk ? counter : 0) : /REAL|NUM/.test(type) ? 0 : /BLOB/.test(type) ? Buffer.from('x') : /_json$/.test(column.name) ? '{}' : `${table}-${column.name}-${counter}`;
    } else if (column.pk && !/INT/i.test(column.type)) {
      counter += 1;
      row[column.name] = `${table}-pk-${counter}`;
    }
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((name) => row[name]));
}

describe('deleting everything a person owns', () => {
  it('empties every table that names their trips, account or browser, and touches nobody else', async () => {
    const { getDb } = await import('./client');
    const { deleteOwnerData } = await import('./data-rights-repository');
    const db = getDb();

    const person = { userId: 'user-me', ownerToken: 'cookie-me' };
    const stranger = { userId: 'user-them', ownerToken: 'cookie-them' };
    for (const who of [person, stranger]) {
      insertGeneric(db, 'users', { id: who.userId, provider: 'fixture', provider_subject: who.userId }, {});
    }
    const trips = {
      mineOnAccount: 'trip-mine-account',
      mineInBrowser: 'trip-mine-browser',
      theirs: 'trip-theirs',
      /* A trip on someone else's account that this browser happened to make: the cookie must not reach it. */
      theirsMadeHere: 'trip-theirs-made-here',
    };
    insertGeneric(db, 'trips', { id: trips.mineOnAccount, user_id: person.userId, owner_token: 'cookie-old' }, {});
    insertGeneric(db, 'trips', { id: trips.mineInBrowser, user_id: null, owner_token: person.ownerToken }, {});
    insertGeneric(db, 'trips', { id: trips.theirs, user_id: stranger.userId, owner_token: stranger.ownerToken }, {});
    insertGeneric(db, 'trips', { id: trips.theirsMadeHere, user_id: stranger.userId, owner_token: person.ownerToken }, {});

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((t) => t.name)
      .filter((name) => name !== 'trips' && name !== 'users')
      .filter((name) => columnsOf(db, name).some((c) => TRIP_COLUMNS.includes(c.name) || OWNER_COLUMNS.includes(c.name)));
    expect(tables.length).toBeGreaterThan(40);

    const failed: string[] = [];
    // Parents first, so a child row can link to them.
    const order = ['travelers', ...tables.filter((t) => t !== 'travelers')];
    const seeded = new Set<string>();
    for (const table of order) {
      if (NOT_SYNTHESISED.has(table)) continue;
      const columns = columnsOf(db, table).map((c) => c.name);
      const seeds: { trip: string; user: string | null; token: string | null }[] = [
        { trip: trips.mineOnAccount, user: person.userId, token: null },
        { trip: trips.mineInBrowser, user: null, token: person.ownerToken },
        { trip: trips.theirs, user: stranger.userId, token: stranger.ownerToken },
      ];
      try {
        const userRequired = columnsOf(db, table).some((c) => c.name === 'user_id' && c.notnull === 1);
        for (const seed of seeds) {
          /* An account-only table has no browser-owned row to seed. */
          if (userRequired && seed.user === null) continue;
          const values: Record<string, unknown> = {};
          for (const column of TRIP_COLUMNS) if (columns.includes(column)) values[column] = seed.trip;
          if (columns.includes('user_id')) values.user_id = seed.user;
          if (columns.includes('owner_token')) values.owner_token = seed.token;
          const traveler = db.prepare('SELECT id FROM travelers WHERE COALESCE(user_id, owner_token) = ?').get(seed.user ?? seed.token) as { id: string } | undefined;
          insertGeneric(db, table, values, { trips: { id: seed.trip }, users: seed.user ? { id: seed.user } : {}, ...(traveler ? { travelers: { id: traveler.id } } : {}) });
        }
        seeded.add(table);
      } catch (error) {
        failed.push(`${table}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failed, 'a table with a person column could not be seeded; add it to NOT_SYNTHESISED with a reason').toEqual([]);

    const report = deleteOwnerData(person);
    expect(report.trips).toBe(2);
    expect(report.account).toBe(true);

    const mine = [trips.mineOnAccount, trips.mineInBrowser, person.userId, person.ownerToken];
    for (const table of seeded) {
      const columns = columnsOf(db, table).map((c) => c.name).filter((c) => TRIP_COLUMNS.includes(c) || OWNER_COLUMNS.includes(c));
      const where = columns.map((c) => `${c} IN (${mine.map(() => '?').join(', ')})`).join(' OR ');
      const left = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...columns.flatMap(() => mine)) as { n: number }).n;
      expect(left, `${table} still holds the deleted person's rows`).toBe(0);
      const theirs = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(theirs, `${table} lost the stranger's row`).toBeGreaterThan(0);
    }
    expect(db.prepare('SELECT id FROM trips ORDER BY id').all()).toEqual([{ id: trips.theirs }, { id: trips.theirsMadeHere }]);
    expect(db.prepare('SELECT id FROM users').all()).toEqual([{ id: stranger.userId }]);
  });

  it('downloads what a browser owns without its credentials', async () => {
    const { getDb } = await import('./client');
    const { exportOwnerData } = await import('./data-rights-repository');
    const db = getDb();
    insertGeneric(db, 'trips', { id: 'trip-export', user_id: null, owner_token: 'cookie-export', share_token: 'share-secret' }, {});
    insertGeneric(db, 'trip_feedback', { trip_id: 'trip-export' }, { trips: { id: 'trip-export' } });
    const exported = exportOwnerData({ userId: null, ownerToken: 'cookie-export' });
    expect(exported.owner.kind).toBe('browser');
    expect(exported.trips).toHaveLength(1);
    expect(exported.trips[0]!.tables.trip_feedback).toHaveLength(1);
    const text = JSON.stringify(exported);
    expect(text).not.toContain('cookie-export');
    expect(text).not.toContain('share-secret');
    expect(exportOwnerData({ userId: null, ownerToken: 'someone-else' }).trips).toHaveLength(0);
  });
});
