#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * STAGE 02 — WHO EACH WIKIVOYAGE PAGE IS, ACCORDING TO WIKIDATA.
 *
 *   node packages/atlas/build/02-wikidata.mjs
 *
 * Every Wikivoyage destination page is linked to a Wikidata item. This stage
 * asks Wikidata, for each of those items: what it is an instance of, which
 * country it is in (as an ISO code), where it is, how many people live there,
 * how high it is, how large it is, how many Wikimedia projects have a page on
 * it, and what else it is called in English. Those become a destination's
 * stable identity, its aliases and its measured size — and the sitelink count
 * is the only popularity signal the atlas uses.
 *
 * One query per 150 items, POSTed, with `wdt:` (truthy) statements only so a
 * city with forty historical population figures returns its preferred one.
 * Cached per batch; a rerun asks only for batches it does not have.
 *
 * Licence: Wikidata is CC0.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const WORK = join(CACHE, 'work');
const BATCH_DIR = join(WORK, 'entities');
const OUT = join(WORK, 'entities.ndjson');
const UA = 'SidequestAtlasBuild/0.1 (offline destination index build; open-data research)';
const BATCH = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pages that can become or shape a destination. Topics, phrasebooks and disambiguations cannot. */
const WANTED = new Set(['city', 'region', 'park', 'ruralarea', 'country', 'extraregion', 'itinerary', 'district', 'diveguide', 'continent', 'continentalsection']);

async function wikivoyageQids() {
  const qids = new Set();
  const lines = createInterface({ input: createReadStream(join(WORK, 'wikivoyage.ndjson')) });
  for await (const line of lines) {
    if (!line) continue;
    const page = JSON.parse(line);
    if (WANTED.has(page.type) && page.qid) qids.add(page.qid);
  }
  return [...qids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function query(qids) {
  return `SELECT ?item (SAMPLE(?label) AS ?name) (SAMPLE(?desc) AS ?description) (SAMPLE(?sl) AS ?sitelinks) (SAMPLE(?coord) AS ?where)
  (MAX(?pop) AS ?population) (MAX(?elev) AS ?elevation) (MAX(?area) AS ?areaM2) (SAMPLE(?selfIso) AS ?isIso)
  (GROUP_CONCAT(DISTINCT ?type; separator="|") AS ?types) (GROUP_CONCAT(DISTINCT ?iso; separator="|") AS ?isos) (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
WHERE {
  VALUES ?item { ${qids.map((qid) => `wd:${qid}`).join(' ')} }
  ?item wikibase:sitelinks ?sl.
  OPTIONAL { ?item rdfs:label ?label. FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?item wdt:P31 ?t. BIND(STRAFTER(STR(?t), "entity/") AS ?type) }
  OPTIONAL { ?item wdt:P17/wdt:P297 ?iso }
  OPTIONAL { ?item wdt:P297 ?selfIso }
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?item wdt:P1082 ?pop }
  OPTIONAL { ?item wdt:P2044 ?elev }
  OPTIONAL { ?item p:P2046/psn:P2046/wikibase:quantityAmount ?area }
  OPTIONAL { ?item skos:altLabel ?alias. FILTER(LANG(?alias) = "en") }
} GROUP BY ?item`;
}

async function sparql(text) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { 'user-agent': UA, accept: 'application/sparql-results+json', 'content-type': 'application/x-www-form-urlencoded' },
      body: `query=${encodeURIComponent(text)}`,
      signal: AbortSignal.timeout(90_000),
    }).catch(() => null);
    if (response?.ok) {
      const body = await response.text();
      try {
        return JSON.parse(body).results.bindings;
      } catch {
        /* truncated on timeout */
      }
    }
    await sleep(10_000 * (attempt + 1));
  }
  return null;
}

function rowOf(binding) {
  const point = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(binding.where?.value ?? '');
  const number = (field) => (binding[field] ? Number(binding[field].value) : null);
  return {
    qid: binding.item.value.split('/').pop(),
    name: binding.name?.value ?? null,
    description: binding.description?.value ?? null,
    sl: number('sitelinks') ?? 0,
    lat: point ? Math.round(Number(point[2]) * 1e4) / 1e4 : null,
    lng: point ? Math.round(Number(point[1]) * 1e4) / 1e4 : null,
    population: number('population'),
    elevM: number('elevation') === null ? null : Math.round(number('elevation')),
    areaKm2: number('areaM2') === null ? null : Math.round(number('areaM2') / 1e4) / 100,
    iso: binding.isIso?.value ?? null,
    types: (binding.types?.value ?? '').split('|').filter(Boolean),
    countries: (binding.isos?.value ?? '').split('|').filter(Boolean),
    aliases: (binding.aliases?.value ?? '').split('|').filter(Boolean).slice(0, 12),
  };
}

async function main() {
  mkdirSync(BATCH_DIR, { recursive: true });
  const qids = await wikivoyageQids();
  console.log(`${qids.length} Wikidata items to describe`);
  const failed = [];
  for (let index = 0; index < qids.length; index += BATCH) {
    const file = join(BATCH_DIR, `${String(index / BATCH).padStart(4, '0')}.json`);
    if (existsSync(file)) continue;
    const batch = qids.slice(index, index + BATCH);
    const bindings = await sparql(query(batch));
    if (!bindings) {
      failed.push(index);
      console.log(`batch ${index}: NO ANSWER`);
      continue;
    }
    writeFileSync(file, JSON.stringify(bindings.map(rowOf)));
    if ((index / BATCH) % 20 === 0) console.log(`batch ${index / BATCH} of ${Math.ceil(qids.length / BATCH)}`);
    await sleep(700);
  }
  const lines = [];
  for (let index = 0; index < qids.length; index += BATCH) {
    const file = join(BATCH_DIR, `${String(index / BATCH).padStart(4, '0')}.json`);
    if (!existsSync(file)) continue;
    for (const row of JSON.parse(readFileSync(file, 'utf8'))) lines.push(JSON.stringify(row));
  }
  writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`${lines.length} entities → ${OUT}${failed.length ? ` · ${failed.length} batches failed (rerun to retry)` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
