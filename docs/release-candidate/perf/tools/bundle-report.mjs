#!/usr/bin/env node
/**
 * ROUTE-LEVEL JAVASCRIPT AND CSS, READ FROM WHAT THE SERVER ACTUALLY SENDS.
 *
 *   node bundle-report.mjs --seed seed.json --out bundles.json
 *
 * The Turbopack build prints no per-route sizes, so this asks the running
 * production server for each page, reads the `<script src>` and stylesheet
 * links out of the HTML (the chunks the first view makes the browser fetch)
 * and sizes each file on disk, raw and gzipped. It also fingerprints every
 * chunk for code that should never reach a browser: the destination atlas and
 * its ranking, the curated catalog, the planner, the database.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const staticDir = join(root, 'apps', 'web', '.next', 'static');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs), []),
);
const PORT = Number(process.env.PORT ?? 4420);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const seed = args.seed ? JSON.parse(readFileSync(args.seed, 'utf8')) : {};
const cookie = (seed.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');

/** A string that only that body of code contains. Presence in a client chunk is the finding. */
const SERVER_ONLY_MARKERS = {
  atlasRanking: ['potion-base', 'samplePoints', 'attachEmbeddings'],
  curatedCatalog: ['DESTINATION_CATALOG_VERSION', 'bestMonths', 'signatureExperiences'],
  advisorScorer: ['activitySeason', 'climateChecked', 'needsResearch'],
  planner: ['greedy insertion', 'structure-planner', 'verificationDeadline'],
  database: ['better-sqlite3', 'CREATE TABLE', 'PRAGMA'],
  modelSdk: ['anthropic-version', 'x-api-key'],
};
const LIBRARY_MARKERS = {
  react: ['react-dom', 'scheduler'],
  nextRuntime: ['__next_f', 'next-router-state-tree'],
  motion: ['whileInView', 'AnimatePresence', 'useMotionValue'],
  zod: ['ZodError', 'invalid_type'],
  maplibre: ['maplibregl', 'maplibre-gl'],
};

const sizes = new Map();
function sizeOf(path) {
  if (sizes.has(path)) return sizes.get(path);
  const file = join(root, 'apps', 'web', '.next', path.replace(/^\/_next\//, ''));
  let entry;
  try {
    const bytes = readFileSync(file);
    const text = bytes.toString('utf8');
    const found = (table) => Object.entries(table).filter(([, needles]) => needles.some((needle) => text.includes(needle))).map(([name]) => name);
    entry = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, libraries: found(LIBRARY_MARKERS), serverOnly: path.endsWith('.js') ? found(SERVER_ONLY_MARKERS) : [] };
  } catch {
    entry = { raw: 0, gzip: 0, libraries: [], serverOnly: [], missing: true };
  }
  sizes.set(path, entry);
  return entry;
}

const PAGES = {
  landing: { url: '/' },
  decide: { url: '/decide' },
  tripNew: { url: '/trips/new' },
  ...(seed.decisionId ? { shortlist: { url: `/decide/${seed.decisionId}`, owned: true } } : {}),
  ...(seed.tripId ? { trip: { url: `/trips/${seed.tripId}/itinerary`, owned: true } } : {}),
};

const report = { at: new Date().toISOString(), pages: {}, allChunks: {}, serverOnlyCodeInClientChunks: [] };
for (const [name, page] of Object.entries(PAGES)) {
  const response = await fetch(`${ORIGIN}${page.url}`, { headers: page.owned && cookie ? { cookie } : {} });
  const html = await response.text();
  const scripts = [...new Set([...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"(?![^>]*noModule)[^>]*>/g)].map((m) => m[1]))];
  const styles = [...new Set([...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]))];
  const fontPreloads = [...new Set([...(response.headers.get('link') ?? '').matchAll(/<(\/_next\/static\/media\/[^>]+)>; rel=preload; as="font"/g)].map((m) => m[1]))];
  const sum = (list, key) => list.reduce((total, path) => total + sizeOf(path)[key], 0);
  report.pages[name] = {
    status: response.status,
    htmlBytes: Buffer.byteLength(html),
    htmlGzipBytes: gzipSync(html, { level: 6 }).length,
    scripts: scripts.length,
    scriptRawBytes: sum(scripts, 'raw'),
    scriptGzipBytes: sum(scripts, 'gzip'),
    styles: styles.length,
    styleRawBytes: sum(styles, 'raw'),
    styleGzipBytes: sum(styles, 'gzip'),
    fontPreloads: fontPreloads.length,
    fontPreloadBytes: sum(fontPreloads, 'raw'),
    largestScripts: scripts.map((path) => ({ path: path.split('/').pop(), ...sizeOf(path) })).sort((a, b) => b.gzip - a.gzip).slice(0, 8),
  };
  const p = report.pages[name];
  console.log(`${name.padEnd(10)} html ${String(p.htmlGzipBytes).padStart(6)} gz | js ${String(p.scripts).padStart(2)} files ${String(p.scriptGzipBytes).padStart(7)} gz (${p.scriptRawBytes} raw) | css ${p.styleGzipBytes} gz (${p.styleRawBytes} raw) | font preloads ${p.fontPreloads} = ${p.fontPreloadBytes}`);
}

/* Every chunk the build emitted, whether or not a measured page asks for it. */
for (const file of readdirSync(join(staticDir, 'chunks'))) {
  if (!file.endsWith('.js')) continue;
  const entry = sizeOf(`/_next/static/chunks/${file}`);
  report.allChunks[file] = entry;
  if (entry.serverOnly.length > 0) report.serverOnlyCodeInClientChunks.push({ file, markers: entry.serverOnly, gzip: entry.gzip });
}
report.totalClientJs = { files: Object.keys(report.allChunks).length, raw: Object.values(report.allChunks).reduce((t, e) => t + e.raw, 0), gzip: Object.values(report.allChunks).reduce((t, e) => t + e.gzip, 0) };
console.log(`all client JS: ${report.totalClientJs.files} files, ${report.totalClientJs.gzip} gz (${report.totalClientJs.raw} raw)`);
console.log(`server-only markers in client chunks: ${report.serverOnlyCodeInClientChunks.length === 0 ? 'none' : JSON.stringify(report.serverOnlyCodeInClientChunks)}`);
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
