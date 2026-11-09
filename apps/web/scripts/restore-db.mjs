#!/usr/bin/env node
/**
 * RELEASE PASS — PUT A VERIFIED BACKUP BACK, WITHOUT DESTROYING WHAT IT REPLACES.
 *
 *   node apps/web/scripts/restore-db.mjs <backup.db> <target.db>
 *
 * The counterpart of `backup-db.mjs`, which until now had none: the restore was
 * five manual steps in `docs/DEPLOYMENT.md` ("replace the file, delete the -wal
 * and -shm"), and each of them is a way to lose a database at the one moment
 * nobody is calm. A stale `-wal` left beside a replaced file is replayed over
 * the restored pages; a `cp` of a backup that is itself corrupt is discovered
 * when a traveller opens a trip. So this script does the steps in the only safe
 * order and refuses instead of guessing:
 *
 * 1. **The backup is verified before anything is touched** — it opens, passes
 *    `PRAGMA integrity_check` and has a `trips` table. Foreign-key violations
 *    are counted and reported, never a refusal: an emergency restore of a
 *    database with an old orphan row is still the right restore.
 * 2. **A running server is a refusal.** A WAL-mode connection holds a shared
 *    lock on the database file for as long as it is open, so asking for an
 *    exclusive one answers "is anything still attached?" exactly. Restoring
 *    under a live server leaves it writing to an unlinked inode — every write
 *    after the restore silently lost. Stop the service first.
 * 3. **The current database is moved aside, never deleted** — the file and its
 *    `-wal`/`-shm` siblings go to `<target>.pre-restore-<UTC stamp>*`, after a
 *    checkpoint so the aside copy is whole on its own.
 * 4. **The copy is made with SQLite's backup API**, then re-verified in place
 *    (integrity, row counts equal to the backup's) and left in WAL mode.
 * 5. **A failed verification puts the aside copy back** and exits non-zero.
 *
 * Read-only on the backup. Never prints a row's contents. The files it handles
 * hold travellers' ownership tokens and booking details: keep backups and the
 * `.pre-restore-*` copy as private as the database itself, and delete the aside
 * copy once the restore is confirmed.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');

const [backup, target] = process.argv.slice(2);
if (!backup || !target) {
  console.error('usage: node apps/web/scripts/restore-db.mjs <backup.db> <target.db>');
  process.exit(2);
}
if (!existsSync(backup)) {
  console.error(`no backup at ${backup}`);
  process.exit(2);
}
if (backup === target) {
  console.error('the backup and the target are the same file');
  process.exit(2);
}

/** The tables `backup-db.mjs` counts; equal counts are what "restored" means here. */
const TABLES = ['trips', 'trip_intents', 'itineraries', 'itinerary_days', 'itinerary_items', 'discovery_selections', 'discovery_scans', 'compiled_regions', 'share_links', 'calendar_feeds', 'trip_feedback', 'users'];
const SIBLINGS = ['', '-wal', '-shm'];

function tableCounts(db) {
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  return Object.fromEntries(TABLES.filter((table) => present.has(table)).map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n]));
}

/** Why this file is not a database worth restoring, or null. */
function verify(db) {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') return `integrity_check: ${String(integrity).slice(0, 120)}`;
  const trips = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trips'").get();
  if (!trips) return 'no trips table: this is not a Sidequest database';
  return null;
}

/* 1 — the backup, verified read-only before anything else is opened. */
let source;
let expected;
try {
  source = new Database(backup, { readonly: true, fileMustExist: true });
  const problem = verify(source);
  if (problem) {
    console.error(`refusing to restore: the backup failed verification (${problem})`);
    process.exit(1);
  }
  expected = tableCounts(source);
  const orphans = source.pragma('foreign_key_check').length;
  if (orphans > 0) console.error(`note: the backup has ${orphans} row(s) that fail foreign_key_check; restoring it as it is`);
} catch (error) {
  console.error(`refusing to restore: the backup could not be read (${error?.code ?? error?.name ?? 'error'})`);
  process.exit(1);
}

/* 2 — nothing may be attached to the target. 3 — move it aside whole. */
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const aside = `${target}.pre-restore-${stamp}`;
let movedAside = false;
if (existsSync(target)) {
  let current;
  try {
    current = new Database(target, { fileMustExist: true, timeout: 0 });
    current.pragma('locking_mode = EXCLUSIVE');
    /* Takes the exclusive file lock (or throws SQLITE_BUSY) and folds the WAL into the main file. */
    current.exec('BEGIN EXCLUSIVE; COMMIT;');
    current.pragma('wal_checkpoint(TRUNCATE)');
    current.close();
  } catch (error) {
    try { current?.close(); } catch { /* already closed */ }
    const busy = String(error?.code ?? '').startsWith('SQLITE_BUSY') || String(error?.code ?? '').startsWith('SQLITE_LOCKED');
    console.error(
      busy
        ? `refusing to restore: ${target} is open in another process. Stop the service first, then run this again.`
        : `refusing to restore: the current database at ${target} could not be opened (${error?.code ?? error?.name ?? 'error'}). Move it aside by hand if it is beyond use.`,
    );
    source.close();
    process.exit(1);
  }
  for (const suffix of SIBLINGS) {
    if (existsSync(`${target}${suffix}`)) renameSync(`${target}${suffix}`, `${aside}${suffix}`);
  }
  movedAside = true;
}

function putBack() {
  for (const suffix of SIBLINGS) rmSync(`${target}${suffix}`, { force: true });
  if (!movedAside) return;
  for (const suffix of SIBLINGS) {
    if (existsSync(`${aside}${suffix}`)) renameSync(`${aside}${suffix}`, `${target}${suffix}`);
  }
}

/* 4 — copy with the backup API, then verify the copy where it will be served from. */
const started = Date.now();
try {
  await source.backup(target);
  source.close();
  const restored = new Database(target, { fileMustExist: true });
  restored.pragma('journal_mode = WAL');
  const problem = verify(restored);
  const actual = tableCounts(restored);
  restored.close();
  const mismatch = Object.keys(expected).find((table) => expected[table] !== actual[table]);
  if (problem || mismatch) throw new Error(problem ?? `row count differs for ${mismatch}`);
  process.stdout.write(
    `restored ${target} from ${backup} in ${Date.now() - started} ms · integrity ok · ${Object.entries(actual).map(([table, n]) => `${table}=${n}`).join(' ')}\n` +
      (movedAside ? `previous database kept at ${aside} — delete it once the restore is confirmed\n` : ''),
  );
  process.exit(0);
} catch (error) {
  /* 5 — the restored copy is not trustworthy: put the previous database back. */
  try { source.close(); } catch { /* already closed */ }
  putBack();
  console.error(`restore failed (${error?.message ?? 'error'}); ${movedAside ? 'the previous database was put back' : 'nothing was left at the target'}`);
  process.exit(1);
}
