import 'server-only';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COLUMN_MIGRATIONS, INDEX_MIGRATIONS, REFINEMENT_SCHEMA_SQL, SCHEMA_SQL, SCHEMA_USER_VERSION, V6_SCHEMA_SQL, V6_TABLE_REBUILDS } from './schema';

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
  /*
   * PRODUCTION LOCK V5 §35/§60 — the refinement tables are created here, once,
   * on the same path as every other table, rather than by a `setup()` the graph
   * calls on each request. A bootstrap that runs per request is a write on the
   * hot path and a migration nobody can point to.
   */
  db.exec(REFINEMENT_SCHEMA_SQL);
  /*
   * V6 — users, sessions, travellers, party, evidence, lifecycle history, and
   * the five formerly lazy tables. `users` has to exist before the column
   * migration adds `trips.user_id REFERENCES users(id)`.
   */
  db.exec(V6_SCHEMA_SQL);
  applyColumnMigrations(db);
  applyTableRebuilds(db);
  applyIndexMigrations(db);
  stampSchemaVersion(db);

  globalForDb.sidequestDb = db;
  return db;
}

/**
 * V6 — REBUILD A TABLE THAT EXISTS WITHOUT ITS FOREIGN KEY.
 *
 * Runs once per table: skipped when `PRAGMA foreign_key_list` already names
 * `trips`. One transaction per table, with `foreign_keys` left ON so the copy
 * itself refuses an orphan rather than carrying one. Orphans are counted and
 * logged; they are the rows this repair exists to stop accumulating.
 */
function applyTableRebuilds(db: Database.Database): void {
  for (const rebuild of V6_TABLE_REBUILDS) {
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(rebuild.table) as { name: string } | undefined;
    if (!exists) continue;
    const keys = db.prepare(`PRAGMA foreign_key_list(${rebuild.table})`).all() as { table: string }[];
    if (keys.some((key) => key.table === 'trips')) continue;
    const run = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${rebuild.table}__v6`);
      db.exec(rebuild.create);
      const cols = rebuild.columns.join(', ');
      const orphans = (db.prepare(`SELECT COUNT(*) AS n FROM ${rebuild.table} WHERE trip_id NOT IN (SELECT id FROM trips)`).get() as { n: number }).n;
      db.exec(`INSERT INTO ${rebuild.table}__v6 (${cols}) SELECT ${cols} FROM ${rebuild.table} WHERE trip_id IN (SELECT id FROM trips)`);
      db.exec(`DROP TABLE ${rebuild.table}`);
      db.exec(`ALTER TABLE ${rebuild.table}__v6 RENAME TO ${rebuild.table}`);
      for (const index of rebuild.indexes) db.exec(index);
      return orphans;
    });
    try {
      const orphans = run();
      if (orphans > 0) console.warn('Rebuilt a table with its foreign key; orphaned rows were not carried', { table: rebuild.table, orphans });
    } catch (error) {
      console.error('Could not rebuild a table with its foreign key; the old shape stands', { table: rebuild.table, error });
    }
  }
}

function stampSchemaVersion(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current < SCHEMA_USER_VERSION) db.pragma(`user_version = ${SCHEMA_USER_VERSION}`);
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

/**
 * Indexes over columns that arrive by migration.
 *
 * Runs after `applyColumnMigrations` because that is the only order in which it
 * can work: `SCHEMA_SQL` executes first and an index naming a column an old
 * database does not yet have would fail on precisely the databases the migration
 * exists to repair.
 *
 * Each statement is applied on its own rather than in one transaction. An index
 * is an optimisation, and a database that got three of four is faster than one
 * that rolled all four back because a table it does not have was named.
 */
function applyIndexMigrations(db: Database.Database): void {
  for (const statement of INDEX_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      console.error('Could not apply an index migration', { statement, error });
    }
  }
}
