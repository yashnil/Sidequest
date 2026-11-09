#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * Refreshes the travel-advisory snapshots the atlas carries.
 *
 *   node packages/atlas/build/advisories.mjs && node packages/atlas/build/06-assemble.mjs
 *
 * Two outputs, one run:
 *
 *   .atlas-cache/raw/advisories/TravelAdvisories.json   the U.S. Department of State feed exactly as
 *                                                        before — stage 06 still reads this file.
 *   .atlas-cache/work/advisories-v2.json                several authorities, their REGIONAL scope kept:
 *                                                        which parts of a country a warning applies to,
 *                                                        in the authority's own words, dated and linked.
 *
 * Authorities (each one's reuse terms are recorded in `lib/advisory-parse.mjs#AUTHORITIES`):
 *
 *   us   U.S. Department of State        one JSON request
 *   uk   UK FCDO, GOV.UK Content API     one index request + one per country (≤ 4 requests a second;
 *                                        the API allows 10)
 *   ca   Global Affairs Canada open data one index request + one per country
 *
 * Every response is cached under `.atlas-cache/raw/advisories/<authority>/`. A country page is asked
 * for again only when the authority's own index says it changed since the cached copy, so a re-run
 * on an unchanged day costs three requests. Parsing is deterministic and offline: no model reads an
 * advisory, and nothing is ever inferred to be safe because no warning was found.
 *
 *   --offline       parse what is cached; no network at all
 *   --refresh       ignore the cache and ask for everything again
 *   --only=us,uk    limit the authorities fetched (the others are read from cache if present)
 *
 * A "do not travel" removes a destination only while the snapshot is fresh (`ADVISORY_FRESH_DAYS`);
 * re-run this before a release — advisories change far more often than mountains do, and nothing
 * else in the atlas needs rebuilding for it (stage 06 takes seconds).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AUTHORITIES, buildSnapshot, summarise } from './lib/advisory-parse.mjs';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const RAW = join(CACHE, 'raw', 'advisories');
const OUT = join(CACHE, 'work', 'advisories-v2.json');
const USER_AGENT = 'SidequestAtlasBuild/0.1 (open-data research)';

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const REFRESH = args.has('--refresh');
const onlyArg = [...args].find((arg) => arg.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const wanted = (authority) => !OFFLINE && (!ONLY || ONLY.has(authority));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
let requests = 0;

/** One polite GET: our own name, a deadline, and two retries on the answers that mean "later". */
async function get(url, { timeout = 60_000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    requests += 1;
    let response;
    try {
      response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      if (attempt >= 2) throw new Error(`${url}: ${error.message}`, { cause: error });
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    if (response.ok) return response.text();
    if (attempt >= 2 || (response.status !== 429 && response.status < 500)) throw new Error(`${url} answered ${response.status}`);
    await sleep(Number(response.headers.get('retry-after')) * 1_000 || 3_000 * (attempt + 1));
  }
}

/** Runs `task` over `items`, `width` at a time, each worker pausing `gap` ms between requests. */
async function pooled(items, width, gap, task) {
  const queue = [...items];
  const failures = [];
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          if (await task(item)) await sleep(gap);
        } catch (error) {
          failures.push({ item, error: error.message });
        }
      }
    }),
  );
  return failures;
}

/* ── U.S. Department of State ─────────────────────────────────────────────────────────────────── */

async function fetchUs() {
  const url = 'https://cadataapi.state.gov/api/TravelAdvisories';
  const text = await get(url, { timeout: 180_000 });
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length < 150) throw new Error(`unexpected advisory payload (${Array.isArray(rows) ? rows.length : typeof rows} rows)`);
  /* The legacy path first: stage 06 reads it, byte for byte what the feed sent. */
  save(join(RAW, 'TravelAdvisories.json'), text);
  save(join(RAW, 'us', 'TravelAdvisories.json'), text);
  console.log(`us  ${rows.length} advisories → ${join(RAW, 'TravelAdvisories.json')}`);
}

/* ── UK FCDO through the GOV.UK Content API ───────────────────────────────────────────────────── */

async function fetchUk() {
  const base = 'https://www.gov.uk/api/content/foreign-travel-advice';
  const indexText = await get(base);
  const index = JSON.parse(indexText);
  const children = index?.links?.children ?? [];
  if (children.length < 150) throw new Error(`unexpected GOV.UK index (${children.length} countries)`);
  save(join(RAW, 'uk', '_index.json'), indexText);
  let fetched = 0;
  const failures = await pooled(children, 2, 500, async (child) => {
    const slug = child.base_path.split('/').pop();
    const file = join(RAW, 'uk', `${slug}.json`);
    if (!REFRESH && existsSync(file)) {
      /* The index carries each page's last public change; an unchanged page is not asked for twice. */
      const cached = readJson(file);
      if (Date.parse(cached.public_updated_at) >= Date.parse(child.public_updated_at)) return false;
    }
    const text = await get(`${base}/${slug}`);
    if (!JSON.parse(text)?.details?.parts) throw new Error('no parts in the answer');
    save(file, text);
    fetched += 1;
    return true;
  });
  console.log(`uk  ${children.length} countries in the index, ${fetched} fetched, ${children.length - fetched - failures.length} unchanged in cache${failures.length ? `, ${failures.length} FAILED: ${failures.map((failure) => `${failure.item.base_path} (${failure.error})`).join('; ')}` : ''}`);
}

/* ── Global Affairs Canada ────────────────────────────────────────────────────────────────────── */

async function fetchCa() {
  const base = 'https://data.international.gc.ca/travel-voyage';
  const indexText = await get(`${base}/index-alpha-eng.json`);
  const index = JSON.parse(indexText);
  const keys = Object.keys(index?.data ?? {});
  if (keys.length < 150) throw new Error(`unexpected Canadian index (${keys.length} countries)`);
  save(join(RAW, 'ca', '_index.json'), indexText);
  let fetched = 0;
  const failures = await pooled(keys, 2, 500, async (key) => {
    const file = join(RAW, 'ca', `cta-cap-${key}.json`);
    if (!REFRESH && existsSync(file)) {
      const cached = readJson(file);
      if ((cached.metadata?.generated?.timestamp ?? 0) >= (index.data[key]['date-published']?.timestamp ?? Infinity)) return false;
    }
    const text = await get(`${base}/cta-cap-${key}.json`);
    if (!JSON.parse(text)?.data?.eng) throw new Error('no English advice in the answer');
    save(file, text);
    fetched += 1;
    return true;
  });
  console.log(`ca  ${keys.length} countries in the index, ${fetched} fetched, ${keys.length - fetched - failures.length} unchanged in cache${failures.length ? `, ${failures.length} FAILED: ${failures.map((failure) => `${failure.item} (${failure.error})`).join('; ')}` : ''}`);
}

/* ── run ──────────────────────────────────────────────────────────────────────────────────────── */

const fetchers = { us: fetchUs, uk: fetchUk, ca: fetchCa };
const fetchErrors = {};
for (const [authority, fetcher] of Object.entries(fetchers)) {
  if (!wanted(authority)) continue;
  try {
    await fetcher();
  } catch (error) {
    /* One authority being down must not cost the others, nor the copy already on disk. */
    fetchErrors[authority] = error.message;
    console.error(`${authority}  fetch failed (${error.message}); using what is cached`);
  }
}
/* The U.S. feed is what stage 06 depends on: with nothing on disk at all, that is an error, as it always was. */
if (!existsSync(join(RAW, 'TravelAdvisories.json'))) throw new Error(`no U.S. advisory feed on disk${fetchErrors.us ? `: ${fetchErrors.us}` : ''}`);

const raw = { us: null, uk: null, ca: null };
const usFile = existsSync(join(RAW, 'us', 'TravelAdvisories.json')) ? join(RAW, 'us', 'TravelAdvisories.json') : join(RAW, 'TravelAdvisories.json');
raw.us = { rows: readJson(usFile) };
if (existsSync(join(RAW, 'uk', '_index.json'))) {
  const index = readJson(join(RAW, 'uk', '_index.json'));
  const pages = {};
  for (const file of readdirSync(join(RAW, 'uk'))) if (file.endsWith('.json') && file !== '_index.json') pages[file.slice(0, -5)] = readJson(join(RAW, 'uk', file));
  raw.uk = { index, pages };
}
if (existsSync(join(RAW, 'ca', '_index.json'))) {
  const index = readJson(join(RAW, 'ca', '_index.json'));
  const pages = {};
  for (const key of Object.keys(index.data)) if (existsSync(join(RAW, 'ca', `cta-cap-${key}.json`))) pages[key] = readJson(join(RAW, 'ca', `cta-cap-${key}.json`));
  raw.ca = { index, pages };
}

/* Offline, "fetched" means when the cached copies were saved: re-parsing must never make old advice look new. */
const savedAt = () => new Date(Math.max(...[join(RAW, 'TravelAdvisories.json'), join(RAW, 'uk', '_index.json'), join(RAW, 'ca', '_index.json')].filter(existsSync).map((file) => statSync(file).mtimeMs))).toISOString();
const snapshot = buildSnapshot(raw, { fetchedAt: OFFLINE ? savedAt() : new Date().toISOString(), fetchErrors });
save(OUT, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`${Object.keys(snapshot.countries).length} countries from ${Object.keys(snapshot.authorities).length} of ${Object.keys(AUTHORITIES).length} authorities → ${OUT} (${requests} requests)`);
for (const line of summarise(snapshot)) console.log(line);
