import 'server-only';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_SQL } from './schema';

/**
 * Local persistence driver.
 *
 * Real server-side storage rather than in-memory or browser state: a trip
 * survives a refresh, a restart and a different browser, which is the point.
 * The schema mirrors the Postgres tables this moves to once a Supabase project
 * exists, so swapping the driver does not change any calling code.
 */

const globalForDb = globalThis as unknown as { sidequestDb?: Database.Database };

function resolveDatabasePath(): string {
  const configured = process.env.SIDEQUEST_DB_PATH;
  if (configured) {
    return configured.startsWith('/')
      ? configured
      : join(/* turbopackIgnore: true */ process.cwd(), configured);
  }
  return join(/* turbopackIgnore: true */ process.cwd(), 'data', 'sidequest.db');
}

export function getDb(): Database.Database {
  // Next's dev server re-evaluates modules on change; without the global the
  // process would leak a file handle per reload.
  if (globalForDb.sidequestDb) return globalForDb.sidequestDb;

  const path = resolveDatabasePath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  globalForDb.sidequestDb = db;
  return db;
}
