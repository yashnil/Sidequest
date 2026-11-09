#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * STAGE 03 — THE WORLD'S NOTABLE FEATURES, FROM WIKIDATA.
 *
 *   node packages/atlas/build/03-features.mjs
 *
 * One query per class against the Wikidata Query Service: every item of that
 * class that has a coordinate and at least `minLinks` Wikimedia sitelinks. The
 * result is a layer of ~80k named, located, typed things — national parks,
 * ranges, volcanoes, glaciers, beaches, ski areas, reefs, castles, World
 * Heritage Sites — that later stages use two ways:
 *
 *  - as **measured evidence** of what a destination offers ("14 beaches and two
 *    marine parks within its extent" is a count, not a model's opinion);
 *  - as **destination candidates in their own right** where a class is one
 *    people travel to (a national park, a range, an archipelago), so a place
 *    with no Wikivoyage article is still discoverable.
 *
 * Every class id below was checked by label with `wbgetentities` on
 * 2026-11-08 — a remembered QID is never trusted (a guessed "game reserve" was
 * a medieval judge). `verifyClasses()` re-checks them on every run and refuses
 * to continue on a mismatch.
 *
 * Licence: Wikidata is CC0. Etiquette: one query at a time, a descriptive
 * User-Agent, two seconds between queries, results cached per class so a rerun
 * asks only for what is missing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const OUT_DIR = join(CACHE, 'work', 'features');
const OUT = join(CACHE, 'work', 'features.ndjson');
const UA = 'SidequestAtlasBuild/0.1 (offline destination index build; open-data research)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * kind → the classes that make it up. `label` is what Wikidata must call the
 * class; `min` is the sitelink floor that keeps a class to its notable members
 * (a class with hundreds of thousands of instances gets a high floor, and the
 * terrain itself — not a count of named peaks — is what measures mountains).
 * `tree: true` follows subclasses, used only where the tree is small.
 */
export const FEATURE_CLASSES = [
  ['park', 'Q46169', 'national park', 1, { tree: true }],
  ['park', 'Q1761072', 'state park', 4],
  ['park', 'Q728904', 'nature park', 4],
  ['park', 'Q179049', 'nature reserve', 5],
  ['park', 'Q473972', 'protected area', 5],
  ['park', 'Q158454', 'biosphere reserve', 3],
  ['park', 'Q2445527', 'wilderness area', 3],
  ['park', 'Q1324355', 'geopark', 2],
  ['park', 'Q53444003', 'UNESCO Global Geopark', 1],
  ['wildlife', 'Q1714375', 'game reserve', 1],
  ['wildlife', 'Q1377575', 'wildlife refuge', 3],
  ['wildlife', 'Q20268591', 'wildlife reserve', 2],
  ['range', 'Q46831', 'mountain range', 4],
  ['range', 'Q1061151', 'massif', 4],
  ['peak', 'Q8502', 'mountain', 10],
  ['pass', 'Q133056', 'mountain pass', 6],
  ['volcano', 'Q8072', 'volcano', 2],
  ['volcano', 'Q169358', 'stratovolcano', 2],
  ['volcano', 'Q159954', 'caldera', 3],
  ['glacier', 'Q35666', 'glacier', 4],
  ['lake', 'Q23397', 'lake', 8],
  ['lake', 'Q187223', 'lagoon', 4],
  ['waterfall', 'Q34038', 'waterfall', 3],
  ['beach', 'Q40080', 'beach', 1],
  ['beach', 'Q1021711', 'seaside resort', 3],
  ['ski', 'Q130003', 'ski resort', 1],
  ['ski', 'Q3034650', 'ski area', 1],
  ['spring', 'Q177380', 'hot spring', 1],
  ['spring', 'Q655311', 'onsen', 1],
  ['spring', 'Q4946461', 'spa town', 4],
  ['island', 'Q23442', 'island', 8],
  ['islands', 'Q33837', 'archipelago', 4],
  ['islands', 'Q1402592', 'island group', 4],
  ['islands', 'Q42523', 'atoll', 3],
  ['canyon', 'Q150784', 'canyon', 3],
  ['cave', 'Q35509', 'cave', 5],
  ['cave', 'Q2232001', 'show cave', 2],
  ['desert', 'Q8514', 'desert', 4],
  ['fjord', 'Q45776', 'fjord', 3],
  ['reef', 'Q11292', 'coral reef', 1],
  ['reef', 'Q184358', 'reef', 3],
  ['reef', 'Q1367500', 'marine protected area', 2],
  ['reef', 'Q1185274', 'marine park', 2],
  ['reef', 'Q2141554', 'recreational dive site', 1],
  ['heritage', 'Q23413', 'castle', 8],
  ['heritage', 'Q839954', 'archaeological site', 8],
  ['heritage', 'Q15661340', 'ancient city', 5],
  ['heritage', 'Q44613', 'monastery', 8],
  ['heritage', 'Q5393308', 'Buddhist temple', 8],
  ['heritage', 'Q842402', 'Hindu temple', 8],
  ['heritage', 'Q845945', 'Shinto shrine', 8],
  ['heritage', 'Q16560', 'palace', 10],
  ['heritage', 'Q676050', 'old town', 3],
  ['museum', 'Q33506', 'museum', 15],
  ['trail', 'Q2143825', 'hiking trail', 2],
  ['trail', 'Q13405588', 'long-distance trail', 2],
  ['rail', 'Q420962', 'heritage railway', 2],
  ['drive', 'Q1406331', 'scenic route', 1],
  ['wine', 'Q2140699', 'wine-producing region', 2],
  ['darksky', 'Q3457162', 'dark-sky preserve', 1],
  ['valley', 'Q39816', 'valley', 6],
  ['landform', 'Q34763', 'peninsula', 8],
  ['landform', 'Q75520', 'plateau', 6],
  ['landform', 'Q185113', 'cape', 8],
  ['resort', 'Q317548', 'resort town', 4],
  ['resort', 'Q2393184', 'hill station', 2],
  ['resort', 'Q1200957', 'tourist destination', 4],
  ['attraction', 'Q570116', 'tourist attraction', 8],
].map(([kind, qid, label, min, options]) => ({ kind, qid, label, min, tree: options?.tree === true }));

async function api(url) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (response?.ok) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        /* a rate-limit page is plain text; wait and ask again */
      }
    }
    await sleep(5000 * (attempt + 1));
  }
  throw new Error(`no answer from ${url.slice(0, 120)}`);
}

async function verifyClasses() {
  const ids = [...new Set(FEATURE_CLASSES.map((entry) => entry.qid)), 'Q9259'];
  const labels = new Map();
  for (let index = 0; index < ids.length; index += 50) {
    const body = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.slice(index, index + 50).join('|')}&props=labels&languages=en&format=json`);
    for (const [id, entity] of Object.entries(body.entities ?? {})) labels.set(id, entity.labels?.en?.value ?? null);
    await sleep(1500);
  }
  const wrong = FEATURE_CLASSES.filter((entry) => labels.get(entry.qid) !== entry.label);
  if (labels.get('Q9259') !== 'World Heritage Site') wrong.push({ qid: 'Q9259', label: 'World Heritage Site' });
  if (wrong.length > 0) {
    throw new Error(`class ids no longer match their labels: ${wrong.map((entry) => `${entry.qid} expected "${entry.label}" got "${labels.get(entry.qid)}"`).join('; ')}`);
  }
}

const SELECT = 'SELECT ?item ?label ?coord ?sl ?iso ?elev ?area';
const BODY = `
  ?item wdt:P625 ?coord; wikibase:sitelinks ?sl.
  OPTIONAL { ?item rdfs:label ?label. FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item wdt:P17/wdt:P297 ?iso }
  OPTIONAL { ?item wdt:P2044 ?elev }
  OPTIONAL { ?item p:P2046/psn:P2046/wikibase:quantityAmount ?area }`;

function classQuery(entry) {
  const path = entry.tree ? 'wdt:P31/wdt:P279*' : 'wdt:P31';
  return `${SELECT} WHERE { ?item ${path} wd:${entry.qid}. ${BODY} FILTER(?sl >= ${entry.min}) }`;
}

const WHS_QUERY = `${SELECT} ?criterion WHERE { ?item wdt:P1435 wd:Q9259. ${BODY} OPTIONAL { ?item wdt:P2614 ?criterionItem. ?criterionItem rdfs:label ?criterion. FILTER(LANG(?criterion) = "en") } }`;

async function sparql(query) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, {
      headers: { 'user-agent': UA, accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    if (response?.ok) {
      const text = await response.text();
      try {
        return JSON.parse(text).results.bindings;
      } catch {
        /* a timeout arrives as a truncated body */
      }
    }
    await sleep(15_000 * (attempt + 1));
  }
  return null;
}

function rowsOf(bindings) {
  const out = [];
  for (const row of bindings) {
    const match = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(row.coord?.value ?? '');
    if (!match) continue;
    const lng = Number(match[1]);
    const lat = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({
      qid: row.item.value.split('/').pop(),
      name: row.label?.value ?? null,
      lat: Math.round(lat * 1e4) / 1e4,
      lng: Math.round(lng * 1e4) / 1e4,
      sl: Number(row.sl?.value ?? 0),
      iso: row.iso?.value ?? null,
      elevM: row.elev ? Math.round(Number(row.elev.value)) : null,
      /* psn: normalises every area to square metres */
      areaKm2: row.area ? Math.round(Number(row.area.value) / 1e4) / 100 : null,
      criterion: row.criterion?.value ?? null,
    });
  }
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await verifyClasses();
  console.log(`verified ${FEATURE_CLASSES.length} class ids by label`);

  const jobs = [...FEATURE_CLASSES.map((entry) => ({ key: `${entry.kind}-${entry.qid}`, kind: entry.kind, query: classQuery(entry), fallback: entry.tree ? classQuery({ ...entry, tree: false }) : null })), { key: 'whs-Q9259', kind: 'whs', query: WHS_QUERY, fallback: null }];
  const failed = [];
  for (const job of jobs) {
    const file = join(OUT_DIR, `${job.key}.json`);
    if (existsSync(file)) continue;
    let bindings = await sparql(job.query);
    if (!bindings && job.fallback) bindings = await sparql(job.fallback);
    if (!bindings) {
      failed.push(job.key);
      console.log(`${job.key}: NO ANSWER`);
      continue;
    }
    const rows = rowsOf(bindings);
    writeFileSync(file, JSON.stringify({ kind: job.kind, fetchedAt: new Date().toISOString(), rows }));
    console.log(`${job.key}: ${rows.length} rows`);
    await sleep(2000);
  }

  /* Merge: one line per item, every kind it was found under, the first coordinate Wikidata gave. */
  const merged = new Map();
  const counts = {};
  for (const job of jobs) {
    const file = join(OUT_DIR, `${job.key}.json`);
    if (!existsSync(file)) continue;
    const { kind, rows } = JSON.parse(readFileSync(file, 'utf8'));
    for (const row of rows) {
      let entry = merged.get(row.qid);
      if (!entry) {
        entry = { qid: row.qid, name: row.name, lat: row.lat, lng: row.lng, sl: row.sl, kinds: [], countries: [], elevM: row.elevM, areaKm2: row.areaKm2, whs: null };
        merged.set(row.qid, entry);
      }
      if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
      if (row.iso && !entry.countries.includes(row.iso)) entry.countries.push(row.iso);
      if (entry.elevM === null && row.elevM !== null) entry.elevM = row.elevM;
      if (row.areaKm2 !== null && (entry.areaKm2 === null || row.areaKm2 > entry.areaKm2)) entry.areaKm2 = row.areaKm2;
      if (kind === 'whs' && row.criterion) {
        /* Criteria (i)–(vi) are cultural, (vii)–(x) natural. */
        const natural = /\((vii|viii|ix|x)\)/.test(row.criterion);
        entry.whs = entry.whs === null ? (natural ? 'natural' : 'cultural') : entry.whs === (natural ? 'natural' : 'cultural') ? entry.whs : 'mixed';
      } else if (kind === 'whs' && entry.whs === null) entry.whs = 'unknown';
    }
  }
  const lines = [];
  for (const entry of merged.values()) {
    if (!entry.name) continue;
    for (const kind of entry.kinds) counts[kind] = (counts[kind] ?? 0) + 1;
    lines.push(JSON.stringify(entry));
  }
  writeFileSync(OUT, `${lines.join('\n')}\n`);
  writeFileSync(join(CACHE, 'work', 'features-stats.json'), JSON.stringify({ builtAt: new Date().toISOString(), items: lines.length, byKind: counts, failed }, null, 1));
  console.log(`${lines.length} features → ${OUT}`, counts, failed.length ? `FAILED: ${failed.join(', ')}` : '');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
