import 'server-only';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COLUMN_MIGRATIONS, SCHEMA_SQL } from './schema';

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
  /**
   * Wait for a write lock rather than failing on contact with one.
   *
   * WAL gives one writer and many readers; a second writer gets `SQLITE_BUSY`
   * *immediately* without this. Two compilations racing for the same evidence row
   * is the normal case now that evidence is shared, and "the second one threw"
   * would be a caching layer that gets worse under the load it exists for.
   */
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  applyColumnMigrations(db);

  globalForDb.sidequestDb = db;
  return db;
}

/**
 * Brings an existing database up to the current column set.
 *
 * SQLite cannot express "add this column if it is not already there" in DDL, so
 * the check is explicit. Wrapped in one transaction: a half-migrated schema is
 * worse than an unmigrated one, because the failure surfaces later and further
 * from its cause.
 */
function applyColumnMigrations(db: Database.Database): void {
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
}
