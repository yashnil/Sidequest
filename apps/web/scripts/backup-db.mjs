#!/usr/bin/env node
/**
 * PRIVATE ALPHA — AN ONLINE, CONSISTENT COPY OF THE SQLITE DATABASE.
 *
 *   node apps/web/scripts/backup-db.mjs <source.db> <destination.db>
 *
 * Uses SQLite's backup API through better-sqlite3, which is safe while the app
 * is running and writing (WAL included) — unlike `cp`, which can copy a
 * half-written page. Afterwards it opens the copy, runs `PRAGMA
 * integrity_check`, and prints row counts for the tables that hold travellers'
 * work, so a backup is verified when it is made rather than when it is needed.
 * Read-only on the source. Never prints a row's contents.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error('usage: node apps/web/scripts/backup-db.mjs <source.db> <destination.db>');
  process.exit(2);
}
if (!existsSync(source)) {
  console.error(`no database at ${source}`);
  process.exit(2);
}
if (existsSync(destination)) {
  console.error(`refusing to overwrite ${destination}`);
  process.exit(2);
}

const TABLES = ['trips', 'trip_intents', 'itineraries', 'itinerary_days', 'itinerary_items', 'discovery_selections', 'discovery_scans', 'compiled_regions', 'share_links', 'calendar_feeds', 'trip_feedback', 'users'];

const db = new Database(source, { readonly: true, fileMustExist: true });
const started = Date.now();
await db.backup(destination);
db.close();

const copy = new Database(destination, { readonly: true });
const integrity = copy.pragma('integrity_check', { simple: true });
const present = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const counts = TABLES.filter((t) => present.has(t)).map((t) => `${t}=${copy.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n}`);
copy.close();
process.stdout.write(`backup ${destination} in ${Date.now() - started} ms · integrity ${integrity} · ${counts.join(" ")}\n`);
process.exit(integrity === 'ok' ? 0 : 1);
