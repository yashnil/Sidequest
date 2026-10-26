import 'server-only';
import { getDb } from './client';
import { getActiveJob } from './compiler-repository';

/**
 * PRODUCTION PASS — DELETE AND DOWNLOAD EVERYTHING A PERSON OWNS.
 *
 * Two owners, matching `lib/net/trip-access.ts` exactly:
 *
 * - **an account** (`userId`) owns every trip whose `user_id` is theirs, and
 *   every `users`-keyed row (sessions, travellers, evidence, saved ideas,
 *   dismissals) — all of which cascade from `users`;
 * - **a browser** (`ownerToken`, the presented `sidequest_session` cookie) owns
 *   the *unclaimed* rows it made: trips, travellers, evidence and saved ideas
 *   with that token and no `user_id`, its decision sessions and its pending
 *   sign-in states. A row already on an account is never touched through the
 *   cookie, for the same reason `claimBrowserResources` never moves one.
 *
 * Most trip rows go by `ON DELETE CASCADE` from `trips` (`foreign_keys = ON`,
 * `client.ts`). The few tables that name a trip without a foreign key are
 * listed in `UNKEYED_TRIP_TABLES` and cleared explicitly; the cascade test
 * (`data-rights.test.ts`) enumerates every table with a trip, user or owner
 * column and fails if a new one is added that this module does not empty.
 *
 * What is deliberately **kept**: the day's spend ledger and rate buckets
 * (`daily_provider_spend`, `rate_limit_buckets`). They hold a pseudonymous key
 * and a counter, expire on their own, and deleting them would let a browser
 * reset its own allowance by pressing "Delete all my data".
 */

export interface DataOwner {
  userId: string | null;
  ownerToken: string | null;
}

/** Tables that name a trip but carry no foreign key to `trips`, with the column that does. */
export const UNKEYED_TRIP_TABLES: readonly { table: string; column: string }[] = [
  { table: 'compilation_work_plans', column: 'trip_id' },
  { table: 'decision_sessions', column: 'resolved_trip_id' },
  { table: 'benchmark_sessions', column: 'trip_id' },
];

/** Tables keyed by the browser's owner token, without a foreign key to anything the account cascade reaches. */
export const OWNER_TOKEN_TABLES: readonly string[] = ['travelers', 'preference_evidence', 'saved_ideas'];

function tableExists(table: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/** Every trip this owner may delete or download. */
export function ownedTripIds(owner: DataOwner): string[] {
  const db = getDb();
  const ids = new Set<string>();
  if (owner.userId) {
    for (const row of db.prepare('SELECT id FROM trips WHERE user_id = ?').all(owner.userId) as { id: string }[]) ids.add(row.id);
  }
  if (owner.ownerToken) {
    for (const row of db.prepare('SELECT id FROM trips WHERE owner_token = ? AND user_id IS NULL').all(owner.ownerToken) as { id: string }[]) ids.add(row.id);
  }
  return [...ids];
}

/** True when a compilation is writing to one of these trips — deleting under it would orphan its writes. */
export function anyTripBusy(tripIds: readonly string[]): boolean {
  return tripIds.some((id) => getActiveJob(id) !== null);
}

export interface DeletionReport {
  trips: number;
  account: boolean;
}

/**
 * Delete one trip and the rows that name it without a foreign key. The trip
 * row's cascade takes the rest, its share link and its calendar feeds included.
 */
export function deleteTripCompletely(tripId: string): void {
  const db = getDb();
  db.transaction(() => {
    for (const { table, column } of UNKEYED_TRIP_TABLES) {
      if (tableExists(table)) db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(tripId);
    }
    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
  })();
}

/**
 * Everything this owner holds, in one transaction. With `userId` set the
 * account row goes too, and with it every session (sign-out everywhere).
 */
export function deleteOwnerData(owner: DataOwner): DeletionReport {
  const db = getDb();
  const tripIds = ownedTripIds(owner);
  const run = db.transaction(() => {
    for (const id of tripIds) {
      for (const { table, column } of UNKEYED_TRIP_TABLES) {
        if (tableExists(table)) db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
      }
      db.prepare('DELETE FROM trips WHERE id = ?').run(id);
    }
    if (owner.ownerToken) {
      for (const table of OWNER_TOKEN_TABLES) {
        if (tableExists(table)) db.prepare(`DELETE FROM ${table} WHERE owner_token = ? AND user_id IS NULL`).run(owner.ownerToken);
      }
      if (tableExists('decision_sessions')) db.prepare('DELETE FROM decision_sessions WHERE owner_token = ?').run(owner.ownerToken);
      if (tableExists('auth_states')) db.prepare('DELETE FROM auth_states WHERE owner_token = ?').run(owner.ownerToken);
    }
    let account = false;
    if (owner.userId) {
      /* `users` cascades auth_sessions, travellers, evidence, saved ideas, dismissals and any trip still on it. */
      account = db.prepare('DELETE FROM users WHERE id = ?').run(owner.userId).changes > 0;
    }
    return { trips: tripIds.length, account };
  });
  return run();
}

/** Columns that are credentials or their hashes; a download never carries them. */
const CREDENTIAL_COLUMN = /(^|_)(token|token_hash|secret|code_verifier|state)$/;

function exportable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (CREDENTIAL_COLUMN.test(key)) continue;
    if (value instanceof Uint8Array) {
      out[key] = { encoding: 'base64', data: Buffer.from(value).toString('base64') };
      continue;
    }
    if (typeof value === 'string' && /_json$/.test(key)) {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        /* not JSON after all — keep the text */
      }
    }
    out[key] = value;
  }
  return out;
}

/** Every table with a `trip_id` foreign key to `trips`, read from the live schema so a new table is never missed. */
export function tripChildTables(): string[] {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables
    .map((t) => t.name)
    .filter((name) => (db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as { table: string; from: string }[]).some((fk) => fk.table === 'trips' && fk.from === 'trip_id'));
}

export interface OwnerExport {
  format: 'sidequest-export';
  version: 1;
  exportedAt: string;
  owner: { kind: 'account' | 'browser' };
  account: Record<string, unknown> | null;
  trips: { trip: Record<string, unknown>; tables: Record<string, Record<string, unknown>[]> }[];
  people: Record<string, unknown>[];
  preferenceEvidence: Record<string, unknown>[];
  savedIdeas: Record<string, unknown>[];
  preferenceDismissals: Record<string, unknown>[];
  decisionSessions: Record<string, unknown>[];
}

function ownedRows(table: string, owner: DataOwner): Record<string, unknown>[] {
  if (!tableExists(table)) return [];
  const db = getDb();
  const rows: Record<string, unknown>[] = [];
  if (owner.userId) rows.push(...(db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(owner.userId) as Record<string, unknown>[]));
  if (owner.ownerToken) rows.push(...(db.prepare(`SELECT * FROM ${table} WHERE owner_token = ? AND user_id IS NULL`).all(owner.ownerToken) as Record<string, unknown>[]));
  return rows.map(exportable);
}

/** The whole of what this owner holds, as JSON-safe data. Credentials are left out; everything else is theirs. */
export function exportOwnerData(owner: DataOwner, now: Date = new Date()): OwnerExport {
  const db = getDb();
  const children = tripChildTables();
  const trips = ownedTripIds(owner).map((id) => {
    const trip = exportable((db.prepare('SELECT * FROM trips WHERE id = ?').get(id) ?? {}) as Record<string, unknown>);
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of children) {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE trip_id = ?`).all(id) as Record<string, unknown>[];
      if (rows.length > 0) tables[table] = rows.map(exportable);
    }
    return { trip, tables };
  });
  const accountRow = owner.userId ? (db.prepare('SELECT * FROM users WHERE id = ?').get(owner.userId) as Record<string, unknown> | undefined) : undefined;
  const dismissals = owner.userId && tableExists('preference_dismissals')
    ? (db.prepare('SELECT * FROM preference_dismissals WHERE user_id = ?').all(owner.userId) as Record<string, unknown>[]).map(exportable)
    : [];
  const decisions = owner.ownerToken && tableExists('decision_sessions')
    ? (db.prepare('SELECT * FROM decision_sessions WHERE owner_token = ?').all(owner.ownerToken) as Record<string, unknown>[]).map(exportable)
    : [];
  return {
    format: 'sidequest-export',
    version: 1,
    exportedAt: now.toISOString(),
    owner: { kind: owner.userId ? 'account' : 'browser' },
    account: accountRow ? exportable(accountRow) : null,
    trips,
    people: ownedRows('travelers', owner),
    preferenceEvidence: ownedRows('preference_evidence', owner),
    savedIdeas: ownedRows('saved_ideas', owner),
    preferenceDismissals: dismissals,
    decisionSessions: decisions,
  };
}
