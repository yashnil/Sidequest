// QUALITY V1 — dump one trip's raw draft, stored itinerary (with its package:
// preservation report, quality audit, timings) and booked items from the
// SQLite database into JSON artifacts. Read-only. Usage:
//   node apps/web/scripts/dump-trip.mjs <db-path> <trip-id> <out-dir>
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [dbPath, tripId, outDir] = process.argv.slice(2);
if (!dbPath || !tripId || !outDir) {
  console.error('usage: dump-trip.mjs <db-path> <trip-id> <out-dir>');
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });
mkdirSync(outDir, { recursive: true });
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const draft = db.prepare('SELECT * FROM trip_drafts WHERE trip_id = ? ORDER BY created_at DESC LIMIT 1').get(tripId);
const itinerary = db.prepare('SELECT * FROM itineraries WHERE trip_id = ?').get(tripId);
const drafts = draft ? Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, k.endsWith('_json') ? parse(v) : v])) : null;
const plan = itinerary ? Object.fromEntries(Object.entries(itinerary).map(([k, v]) => [k, k.endsWith('_json') ? parse(v) : v])) : null;
writeFileSync(resolve(outDir, 'trip-draft.json'), JSON.stringify(drafts, null, 2));
writeFileSync(resolve(outDir, 'itinerary.json'), JSON.stringify(plan, null, 2));
const days = db.prepare('SELECT * FROM itinerary_days WHERE trip_id = ? ORDER BY day_number').all(tripId).map((day) => ({
  ...Object.fromEntries(Object.entries(day).map(([k, v]) => [k, k.endsWith('_json') ? parse(v) : v])),
  items: db.prepare('SELECT * FROM itinerary_items WHERE trip_id = ? AND day_number = ? ORDER BY start_minute').all(tripId, day.day_number).map((item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, k.endsWith('_json') ? parse(v) : v]))),
}));
writeFileSync(resolve(outDir, 'days.json'), JSON.stringify(days, null, 2));
// COMPOSITION RELIABILITY — every attempt's raw visible answer and the parser's verdict, for replay without a model call.
const attempts = db.prepare('SELECT * FROM composition_attempts WHERE trip_id = ? ORDER BY created_at').all(tripId).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k.endsWith('_json') ? parse(v) : v])));
writeFileSync(resolve(outDir, 'composition-attempts.json'), JSON.stringify(attempts, null, 2));
const pkg = plan?.package_json ?? plan?.package ?? null;
if (pkg) {
  writeFileSync(resolve(outDir, 'preservation.json'), JSON.stringify({ preservation: pkg.preservation ?? null, quality: pkg.quality ?? null, timings: pkg.timings ?? null, verification: pkg.verification ?? null }, null, 2));
}
console.log(`dumped ${tripId}: draft ${draft ? 'yes' : 'no'}, itinerary ${itinerary ? 'yes' : 'no'}, attempts ${attempts.length} → ${outDir}`);
