#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * STAGE 10 — WHICH ANIMALS ARE DOCUMENTED AROUND A DESTINATION, FROM GBIF.
 *
 *   node packages/atlas/build/10-wildlife.mjs               # resolve taxa, crawl what is missing, assemble
 *   node packages/atlas/build/10-wildlife.mjs --taxa        # resolve and print the taxon table only
 *   node packages/atlas/build/10-wildlife.mjs --plan        # say what would be asked, ask nothing
 *   node packages/atlas/build/10-wildlife.mjs --assemble    # rebuild the outputs from the cache, ask nothing
 *   node packages/atlas/build/10-wildlife.mjs --budget 45   # stop asking after 45 minutes (the default)
 *   node packages/atlas/build/10-wildlife.mjs --max 500     # ask at most 500 new questions this run
 *
 * The estimators for safari, birding and marine wildlife had almost nothing to
 * stand on: a count of Wikidata "game reserves" nearby. This stage gives them
 * documented presence, on a one-degree grid. A radius query per candidate is
 * about 13,000 questions; candidates share cells, so each is read from the
 * ONE-DEGREE CELL THAT CONTAINS ITS CENTRE (about 111 km north-south, and
 * narrower with latitude — the same scale as the 50 km cap the brief set, and
 * coarse enough that GBIF's ~0.2° blurring of threatened species does not move
 * a record out). The cell is asked once: which species of bird, mammal, sea
 * turtle, manta and whale shark have been recorded there since 2000, and how
 * many records of each? The answer is a facet (species → record count), so
 * nothing is paged and no individual record is ever downloaded. Cells are asked
 * in priority order (curated, protected areas and parks, rural areas, the rest)
 * under a wall-clock budget, so a partial crawl covers what matters most, and a
 * candidate whose cell was not reached has no row rather than an empty one.
 * The honest limit: a town beside a game reserve shares the reserve's cell and
 * reads the reserve's animals. `cell` is on every row so a consumer can tell.
 *
 * WHAT IS MEASURED AND WHAT IS NOT. A record count measures observers, not
 * animals: central London has more bird records than the Serengeti. So the
 * outputs lead with distinct species and presence, keep the record totals only
 * as the denominators a consumer needs to normalise (`birdRecords`,
 * `mammalRecords`), and add a rarefied bird richness — the number of species
 * expected in a random 1,000 (and 200) of the area's bird records — which is
 * comparable between a heavily and a lightly watched place. Absence of a record
 * is never absence of an animal: a candidate with `mammalRecords: 0` is
 * unobserved, not empty (unknown ≠ false).
 *
 * LICENCE. GBIF mediates data under three licences, chosen per publisher and
 * carried per record: CC0 1.0, CC BY 4.0 and CC BY-NC 4.0. This build asks only
 * for the first two (`license=CC0_1_0&license=CC_BY_4_0`), so nothing
 * non-commercial enters the atlas. CC BY needs attribution of the publishers,
 * and GBIF's data-user agreement asks that data be cited, "where appropriate
 * through use of a Digital Object Identifier": every answer's `datasetKey`
 * facet is therefore kept and summed into `wildlife-datasets.json` — exactly
 * the list (dataset key + record count) GBIF's "derived dataset" tool takes to
 * mint one citable DOI for this build.
 *
 * ETIQUETTE. GBIF: "Rapid or numerous queries to search APIs may be rate
 * limited … If this happens, you will receive an HTTP 429 error, and you should
 * reduce your query rate". Two requests in flight at most, a pause after each,
 * every answer cached on disk by the hash of its URL so a rerun asks only for
 * what is missing; on a 429 or 503 every worker stops for a growing interval
 * and the crawl continues on one connection. The bulk-download API would be the
 * kinder tool for a job this size but needs an account, and this build uses
 * none.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eachLine } from './lib/geo-index.mjs';
import { politeJson, requestKey, sleep } from './lib/polite-http.mjs';
import { BIRD_GROUPS, DOMESTIC_FORMS, LAND_GROUPS, MARINE_GROUPS, WHOLE_CLASSES } from './lib/wildlife-taxa.mjs';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const WORK = join(CACHE, 'work');
const RAW = join(CACHE, 'raw', 'gbif');
const API = 'https://api.gbif.org/v1';
/** The GBIF Backbone Taxonomy's dataset key, read from the API's own documentation of the backbone; checked on every run in `resolveTaxa`. */
const BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c';

/** Fixed so the cache key is stable; raise the upper year in a later build and every question is asked afresh. */
const YEARS = '2000,2026';
const REGION_MAX_RADIUS_KM = 150;
/** How many cells that hold only control cities are asked early, so the comparison exists even after a short crawl. */
const CONTROL_CELLS = 300;
const SPECIES_FACET_LIMIT = 5000;
/** A species with fewer records than this is "seen once or twice": a vagrant, a misidentification, a point on a country centroid. */
const ROBUST_MIN_RECORDS = 3;

const FILTER = [
  ['limit', '0'],
  ['year', YEARS],
  ['license', 'CC0_1_0'],
  ['license', 'CC_BY_4_0'],
  ['hasCoordinate', 'true'],
  ['hasGeospatialIssue', 'false'],
  ['occurrenceStatus', 'PRESENT'],
  /* Everything except FOSSIL_SPECIMEN, LIVING_SPECIMEN (zoos, botanic gardens) and MATERIAL_CITATION (a place named in a paper). */
  ['basisOfRecord', 'HUMAN_OBSERVATION'],
  ['basisOfRecord', 'MACHINE_OBSERVATION'],
  ['basisOfRecord', 'OBSERVATION'],
  ['basisOfRecord', 'PRESERVED_SPECIMEN'],
  ['basisOfRecord', 'MATERIAL_SAMPLE'],
  ['basisOfRecord', 'OCCURRENCE'],
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

/* ── Cached requests ──────────────────────────────────────────────────────── */

function cachePath(kind, url) {
  const key = requestKey(url);
  return join(RAW, kind, key.slice(0, 2), `${key}.json`);
}

function readCached(kind, url) {
  const path = cachePath(kind, url);
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    /* The file is keyed by a hash; hold it to the question it claims to answer. */
    return stored.url === url ? stored.body : null;
  } catch {
    return null;
  }
}

function writeCached(kind, url, body) {
  const path = cachePath(kind, url);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ url, fetchedAt: new Date().toISOString(), body }));
}

async function cachedJson(kind, url, { keep = (body) => body, valid = () => true, onBusy = null } = {}) {
  const hit = readCached(kind, url);
  if (hit !== null) return hit;
  const body = await politeJson(url, { onBusy });
  if (!valid(body)) throw new Error(`unexpected answer shape from ${url.slice(0, 160)}`);
  const kept = keep(body);
  writeCached(kind, url, kept);
  return kept;
}

/* ── Taxa: names → backbone keys, never typed by hand ─────────────────────── */

async function matchTaxon({ name, rank }) {
  const url = `${API}/species/match?name=${encodeURIComponent(name)}&rank=${rank}&kingdom=Animalia&strict=true`;
  const body = await cachedJson('taxa', url);
  if (body.matchType !== 'EXACT' || body.rank !== rank) return { name, rank, problem: `no exact ${rank} match (${body.matchType ?? 'NONE'}${body.rank ? `, ${body.rank}` : ''})` };
  /* A synonym resolves to the name the occurrence index files its records under. */
  const key = body.acceptedUsageKey ?? body.usageKey;
  let accepted = body.scientificName;
  if (body.acceptedUsageKey) {
    const usage = await cachedJson('taxa', `${API}/species/${key}`);
    if (usage.rank !== rank) return { name, rank, problem: `synonym of a ${usage.rank}: ${usage.scientificName}` };
    accepted = usage.scientificName;
  }
  return { name, rank, key, scientificName: accepted, status: body.status, synonym: Boolean(body.acceptedUsageKey), classKey: body.classKey ?? null, speciesKey: rank === 'SPECIES' ? key : (body.speciesKey ?? null) };
}

/** The search index stops answering in useful time past this offset (a page at 10,000 took over a minute), so a larger taxon is walked child by child. */
const DEEP_PAGING_LIMIT = 9000;

const keepPage = (body) => ({ count: body.count, endOfRecords: body.endOfRecords, results: body.results.map((row) => ({ key: row.key, datasetKey: row.datasetKey, rank: row.rank })) });
const validPage = (body) => Array.isArray(body?.results) && typeof body.endOfRecords === 'boolean';

/** Every species the backbone files under a higher taxon (accepted or doubtful — both carry occurrence records). */
async function speciesUnder(key) {
  const keys = new Set();
  for (const status of ['ACCEPTED', 'DOUBTFUL']) {
    for (let offset = 0; ; offset += 1000) {
      const url = `${API}/species/search?datasetKey=${BACKBONE}&highertaxonKey=${key}&rank=SPECIES&status=${status}&limit=1000&offset=${offset}`;
      const page = await cachedJson('taxa', url, { valid: validPage, keep: keepPage });
      if (offset === 0 && page.count > DEEP_PAGING_LIMIT) {
        for (const child of await childrenOf(key)) {
          if (child.rank === 'SPECIES') keys.add(child.key);
          else for (const found of await speciesUnder(child.key)) keys.add(found);
        }
        return keys;
      }
      for (const row of page.results) {
        if (row.datasetKey && row.datasetKey !== BACKBONE) throw new Error(`species search left the backbone (${row.datasetKey})`);
        keys.add(row.key);
      }
      if (page.endOfRecords || page.results.length === 0) break;
      await sleep(150);
    }
  }
  return keys;
}

/** The direct children of a backbone taxon. */
async function childrenOf(key) {
  const children = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await cachedJson('taxa', `${API}/species/${key}/children?limit=1000&offset=${offset}`, { valid: validPage, keep: keepPage });
    children.push(...page.results);
    if (page.endOfRecords || page.results.length === 0) break;
  }
  return children;
}

async function resolveTaxa() {
  const problems = [];
  const resolve = async (entry) => {
    const resolved = await matchTaxon(entry);
    if (resolved.problem) problems.push(`${entry.name}: ${resolved.problem}`);
    return resolved;
  };

  const classes = {};
  for (const [id, entry] of Object.entries(WHOLE_CLASSES)) classes[id] = await resolve(entry);

  /** speciesKey → Set of group ids */
  const groupsOf = new Map();
  const table = [];
  const queryRoots = new Set();
  const addGroups = async (groups, realm) => {
    for (const [group, entries] of Object.entries(groups)) {
      for (const entry of entries) {
        const resolved = await resolve(entry);
        if (resolved.problem) continue;
        const members = entry.rank === 'SPECIES' ? new Set([resolved.key]) : await speciesUnder(resolved.key);
        for (const key of members) {
          if (!groupsOf.has(key)) groupsOf.set(key, new Set());
          groupsOf.get(key).add(group);
        }
        table.push({ realm, group, name: entry.name, rank: entry.rank, key: resolved.key, scientificName: resolved.scientificName, synonym: resolved.synonym, classKey: resolved.classKey, species: members.size });
        /* Anything outside the two whole classes has to be asked for by name. */
        if (resolved.classKey !== classes.birds?.key && resolved.classKey !== classes.mammals?.key) queryRoots.add(resolved.key);
      }
    }
  };
  await addGroups(LAND_GROUPS, 'land');
  await addGroups(MARINE_GROUPS, 'marine');
  await addGroups(BIRD_GROUPS, 'bird');

  const domestic = [];
  for (const entry of DOMESTIC_FORMS) {
    const wild = await matchTaxon({ name: entry.of, rank: 'SPECIES' });
    const form = await matchTaxon(entry);
    /* A domestic form the backbone does not file under the wild species needs no subtraction. */
    if (wild.problem || form.problem) continue;
    if (form.speciesKey !== wild.key) continue;
    domestic.push({ of: wild.key, ofName: entry.of, key: form.key, name: entry.name });
  }

  if (problems.length > 0) throw new Error(`taxa that did not resolve exactly — fix the name, never the key:\n  ${problems.join('\n  ')}`);

  const mammalSpecies = await speciesUnder(classes.mammals.key);
  const otherSpecies = new Set();
  for (const root of queryRoots) {
    const row = table.find((entry) => entry.key === root);
    if (row.rank === 'SPECIES') otherSpecies.add(root);
    else for (const key of await speciesUnder(root)) otherSpecies.add(key);
  }

  const groupRealm = Object.fromEntries([...Object.keys(LAND_GROUPS).map((group) => [group, 'land']), ...Object.keys(MARINE_GROUPS).map((group) => [group, 'marine']), ...Object.keys(BIRD_GROUPS).map((group) => [group, 'bird'])]);
  return { classes, table, groupsOf, groupRealm, domestic, mammalSpecies, otherSpecies, queryRoots: [...queryRoots].sort((a, b) => a - b) };
}

/* ── Which candidates ─────────────────────────────────────────────────────── */

/** A stable 0..n-1 bucket of an id, for the control sample of cities. */
function bucket(id, n) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) % n;
}

/** East and southern Africa as a box: only used to keep every city there as a control, and to report by property. */
const inSavannaAfrica = (lat, lng) => lat >= -35 && lat <= 5 && lng >= 11 && lng <= 42;

const cellOf = (lat, lng) => ({ south: Math.min(89, Math.floor(lat)), west: Math.min(179, Math.floor(lng)) });
const cellKey = (cell) => `${cell.south}:${cell.west}`;

async function selectCandidates() {
  const selected = [];
  const add = (row, why, order) => selected.push({ id: row.id, lat: Math.round(row.lat * 1000) / 1000, lng: Math.round(row.lng * 1000) / 1000, extentKm: row.radiusKm ?? null, why, order, cell: cellOf(row.lat, row.lng) });

  const curated = JSON.parse(readFileSync(join(WORK, 'curated.json'), 'utf8'));
  for (const entry of curated.entries) add({ id: `curated:${entry.id}`, lat: entry.center.lat, lng: entry.center.lng, radiusKm: entry.radiusKm }, 'curated', 0);

  await eachLine(join(WORK, 'candidates.ndjson'), (row) => {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return;
    const radius = row.radiusKm ?? 0;
    if (row.curated) return add(row, 'curated_twin', 1);
    if (row.scopeOnly) return undefined;
    if (row.source === 'wikidata') return radius <= REGION_MAX_RADIUS_KM ? add(row, `wikidata:${row.featureKind}`, row.featureKind === 'national_park' || row.featureKind === 'protected_area' ? 2 : 4) : undefined;
    if (row.wvType === 'park') return add(row, 'park', 2);
    if (row.wvType === 'ruralarea') return add(row, 'ruralarea', 3);
    if (row.wvType === 'region') return radius <= REGION_MAX_RADIUS_KM ? add(row, 'region', 5) : undefined;
    /* Cities are the control: every one in east and southern Africa, and one in thirty elsewhere. */
    if (row.wvType === 'city' && (inSavannaAfrica(row.lat, row.lng) || bucket(row.id, 30) === 0)) return add(row, 'city_control', 6);
    return undefined;
  });
  selected.sort((a, b) => a.order - b.order);
  return selected;
}

/* ── The one question ─────────────────────────────────────────────────────── */

function occurrenceUrl(cell, taxonKeys) {
  const params = [...FILTER, ...taxonKeys.map((key) => ['taxonKey', String(key)]), ['decimalLatitude', `${cell.south},${cell.south + 1}`], ['decimalLongitude', `${cell.west},${cell.west + 1}`]];
  for (const [facet, limit] of FACETS) {
    params.push(['facet', facet]);
    params.push([`${facet}.facetLimit`, String(limit)]);
  }
  return `${API}/occurrence/search?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

/* acceptedTaxonKey is in the same answer so a dog can be told from a wolf without a second question. */
const FACETS = [
  ['speciesKey', SPECIES_FACET_LIMIT],
  ['acceptedTaxonKey', SPECIES_FACET_LIMIT],
  ['classKey', 50],
  ['datasetKey', 1000],
];

const validOccurrence = (body) => typeof body?.count === 'number' && Array.isArray(body.facets);

/* ── Numbers ──────────────────────────────────────────────────────────────── */

/** ln Γ(x), Stirling's series after shifting x above 8; good to ~1e-10, far past what a species count needs. */
function lgamma(x) {
  let shift = 0;
  let value = x;
  while (value < 8) {
    shift += Math.log(value);
    value += 1;
  }
  const inverse = 1 / (value * value);
  return (value - 0.5) * Math.log(value) - value + 0.9189385332046727 + (1 / value) * (1 / 12 - inverse * (1 / 360 - inverse * (1 / 1260 - inverse / 1680))) - shift;
}

/**
 * Rarefied richness: the number of species expected in a random sample of
 * `n` of the records (Hurlbert 1971). Null when there are fewer than `n`
 * records — the place has not been watched enough to say.
 */
function rarefied(counts, n) {
  let total = 0;
  for (const count of counts) total += count;
  if (total < n) return null;
  const base = lgamma(total - n + 1) - lgamma(total + 1);
  let expected = 0;
  for (const count of counts) {
    if (total - count < n) expected += 1;
    else expected += 1 - Math.exp(lgamma(total - count + 1) - lgamma(total - count - n + 1) + base);
  }
  return Math.round(expected * 10) / 10;
}

/* ── Assemble one row ─────────────────────────────────────────────────────── */

function rowFor(candidate, answer, dogRecords, taxa) {
  const species = answer.facets.SPECIES_KEY ?? [];
  const classes = new Map((answer.facets.CLASS_KEY ?? []).map(([key, count]) => [Number(key), count]));
  const birdCounts = [];
  let mammalSpecies = 0;
  let mammalSpecies3 = 0;
  let birdSum = 0;
  let mammalSum = 0;
  const realms = { land: new Map(), marine: new Map(), bird: new Map() };

  for (const [name, rawCount] of species) {
    const key = Number(name);
    let count = rawCount;
    const domestic = taxa.domesticOf.get(key);
    if (domestic) count = Math.max(0, rawCount - dogRecords);
    const isMammal = taxa.mammalSpecies.has(key);
    const isOther = taxa.otherSpecies.has(key);
    if (isMammal) {
      /* A species left with nothing once its domestic form is taken out is not a documented wild mammal. */
      if (count > 0) {
        mammalSpecies += 1;
        if (count >= ROBUST_MIN_RECORDS) mammalSpecies3 += 1;
      }
      mammalSum += rawCount;
    } else if (!isOther) {
      birdCounts.push(count);
      birdSum += count;
    }
    if (count <= 0) continue;
    const groups = taxa.groupsOf.get(key);
    if (!groups) continue;
    for (const group of groups) realms[taxa.groupRealm[group]].set(key, { count, groups: [...groups].filter((other) => taxa.groupRealm[other] === taxa.groupRealm[group]) });
  }

  const summarise = (found) => {
    const groups = {};
    let records = 0;
    let robust = 0;
    for (const [, entry] of found) {
      records += entry.count;
      if (entry.count >= ROBUST_MIN_RECORDS) robust += 1;
      for (const group of entry.groups) {
        const slot = (groups[group] ??= { species: 0, species3: 0, records: 0 });
        slot.species += 1;
        if (entry.count >= ROBUST_MIN_RECORDS) slot.species3 += 1;
        slot.records += entry.count;
      }
    }
    return { species: found.size, species3: robust, records, groups, taxa: [...found].map(([key, entry]) => [key, entry.count]).sort((a, b) => b[1] - a[1]) };
  };

  const birdRecords = classes.get(taxa.classes.birds.key) ?? 0;
  const mammalRecords = classes.get(taxa.classes.mammals.key) ?? 0;
  const penguins = summarise(realms.bird);
  return {
    id: candidate.id,
    lat: candidate.lat,
    lng: candidate.lng,
    extentKm: candidate.extentKm,
    cell: cellKey(candidate.cell),
    records: answer.count,
    birdRecords,
    mammalRecords,
    birdSpecies: birdCounts.length,
    birdSpecies3: birdCounts.filter((count) => count >= ROBUST_MIN_RECORDS).length,
    birdSpeciesRare1k: rarefied(birdCounts, 1000),
    birdSpeciesRare200: rarefied(birdCounts, 200),
    mammalSpecies,
    mammalSpecies3,
    flagship: summarise(realms.land),
    marine: summarise(realms.marine),
    penguinSpecies: penguins.species,
    domesticRemoved: dogRecords,
    datasets: (answer.facets.DATASET_KEY ?? []).length,
    /* Species-level records can never outnumber the class's records; if they do, a key was filed under the wrong class. */
    consistent: birdSum <= birdRecords && mammalSum <= mammalRecords,
    truncated: species.length >= SPECIES_FACET_LIMIT,
  };
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  mkdirSync(RAW, { recursive: true });
  const taxa = await resolveTaxa();
  taxa.domesticOf = new Map(taxa.domestic.map((entry) => [entry.of, entry]));
  const queryTaxa = [taxa.classes.birds.key, taxa.classes.mammals.key, ...taxa.queryRoots];
  writeFileSync(
    join(WORK, 'wildlife-taxa.json'),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        backbone: BACKBONE,
        classes: taxa.classes,
        queryTaxonKeys: queryTaxa,
        domestic: taxa.domestic,
        groups: taxa.table,
        mammalSpeciesInBackbone: taxa.mammalSpecies.size,
      },
      null,
      1,
    ),
  );
  console.log(`taxa: ${taxa.table.length} named taxa in ${Object.keys(taxa.groupRealm).length} groups → ${taxa.groupsOf.size} species keys; ${taxa.mammalSpecies.size} mammal species in the backbone; query asks for taxonKey ${queryTaxa.join(', ')}; domestic forms subtracted: ${taxa.domestic.map((entry) => entry.name).join(', ') || 'none'}`);
  if (flag('taxa')) {
    for (const row of taxa.table) console.log(`  ${row.realm.padEnd(6)} ${row.group.padEnd(22)} ${row.rank.padEnd(8)} ${String(row.key).padEnd(9)} ${row.name}${row.synonym ? ` → ${row.scientificName}` : ''}${row.rank === 'SPECIES' ? '' : ` (${row.species} species)`}`);
    return;
  }

  const candidates = await selectCandidates();
  const byWhy = {};
  for (const candidate of candidates) byWhy[candidate.why] = (byWhy[candidate.why] ?? 0) + 1;

  /* Keep only what the assembly reads: the acceptedTaxonKey facet is otherwise a second copy of the species list. */
  const domesticNames = new Set(taxa.domestic.map((entry) => String(entry.key)));
  const keepOccurrence = (body) => ({
    count: body.count,
    facets: Object.fromEntries(body.facets.map((facet) => [facet.field, facet.field === 'ACCEPTED_TAXON_KEY' ? facet.counts.filter((entry) => domesticNames.has(entry.name)).map((entry) => [entry.name, entry.count]) : facet.counts.map((entry) => [entry.name, entry.count])])),
  });

  /* Cells, in the order worth asking them. */
  const cells = new Map();
  for (const candidate of candidates) {
    const key = cellKey(candidate.cell);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { key, ...candidate.cell, order: 99, members: 0, weight: 0, nonControl: 0 }));
    cell.members += 1;
    cell.order = Math.min(cell.order, candidate.order);
    if (candidate.why !== 'city_control') cell.nonControl += 1;
  }
  /* Early cells that hold nothing but control cities, picked by hash so the sample is arbitrary but stable. */
  const controlOnly = [...cells.values()].filter((cell) => cell.nonControl === 0).sort((a, b) => bucket(a.key, 100003) - bucket(b.key, 100003));
  for (const cell of controlOnly.slice(0, CONTROL_CELLS)) cell.order = 2.5;
  const ordered = [...cells.values()].sort((a, b) => a.order - b.order || b.members - a.members || a.key.localeCompare(b.key));
  const urlOf = (cell) => occurrenceUrl(cell, queryTaxa);
  const missing = ordered.filter((cell) => readCached('occ', urlOf(cell)) === null);
  const cellsByOrder = {};
  for (const cell of ordered) cellsByOrder[cell.order] = (cellsByOrder[cell.order] ?? 0) + 1;
  console.log(`${candidates.length} candidates`, byWhy, `in ${ordered.length} one-degree cells`, cellsByOrder, `— ${ordered.length - missing.length} answered already, ${missing.length} to ask`);
  if (flag('plan')) return;

  /* ── Crawl ── */
  const failures = [];
  let stoppedByBudget = false;
  if (!flag('assemble') && missing.length > 0) {
    const max = Number(option('max', missing.length));
    const deadline = Date.now() + Number(option('budget', 45)) * 60_000;
    const queue = missing.slice(0, max);
    let workers = Math.max(1, Math.min(3, Number(option('concurrency', 2))));
    let pauseUntil = 0;
    let busy = 0;
    const onBusy = (attempt) => {
      busy += 1;
      pauseUntil = Math.max(pauseUntil, Date.now() + 60_000 * (attempt + 1));
      workers = 1;
    };
    const started = Date.now();
    let done = 0;
    let next = 0;
    const work = async (index) => {
      for (;;) {
        while (Date.now() < pauseUntil || index >= workers) {
          if (next >= queue.length || Date.now() >= deadline) return;
          await sleep(1000);
        }
        if (Date.now() >= deadline) {
          stoppedByBudget = next < queue.length;
          return;
        }
        const cell = queue[next];
        next += 1;
        if (!cell) return;
        try {
          await cachedJson('occ', urlOf(cell), { valid: validOccurrence, keep: keepOccurrence, onBusy });
        } catch (error) {
          failures.push({ cell: cell.key, error: String(error?.message ?? error).slice(0, 200) });
        }
        done += 1;
        if (done % 100 === 0 || done === queue.length) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`${new Date().toISOString()} ${done}/${queue.length} asked, ${rate.toFixed(2)}/s, ${failures.length} failed, ${busy} busy signals, ${workers} connection(s)`);
        }
        await sleep(150);
      }
    };
    await Promise.all([0, 1, 2].map((index) => work(index)));
    if (stoppedByBudget) console.log(`stopped by the time budget after ${done} questions; rerun to continue`);
  }

  /* ── Assemble ── */
  const lines = [];
  const datasets = new Map();
  const counted = new Set();
  let unanswered = 0;
  let inconsistent = 0;
  let truncated = 0;
  for (const candidate of candidates) {
    const answer = readCached('occ', occurrenceUrl(candidate.cell, queryTaxa));
    if (answer === null) {
      unanswered += 1;
      continue;
    }
    const dogRecords = (answer.facets.ACCEPTED_TAXON_KEY ?? []).reduce((sum, [, count]) => sum + count, 0);
    const row = { ...rowFor(candidate, answer, dogRecords, taxa), why: candidate.why };
    if (!row.consistent) inconsistent += 1;
    if (row.truncated) truncated += 1;
    lines.push(JSON.stringify(row));
    const key = cellKey(candidate.cell);
    if (!counted.has(key)) {
      counted.add(key);
      for (const [dataset, count] of answer.facets.DATASET_KEY ?? []) datasets.set(dataset, (datasets.get(dataset) ?? 0) + count);
    }
  }
  writeFileSync(join(WORK, 'wildlife.ndjson'), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  writeFileSync(
    join(WORK, 'wildlife-datasets.json'),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        note: "GBIF datasets that contributed records to the cell answers this build read, with the number of records counted from each. This is the list GBIF's derived-dataset tool takes to mint one citable DOI.",
        filter: Object.fromEntries(['year', 'license', 'basisOfRecord', 'hasGeospatialIssue', 'occurrenceStatus'].map((name) => [name, FILTER.filter(([key]) => key === name).map(([, value]) => value)])),
        cells: counted.size,
        datasets: [...datasets].sort((a, b) => b[1] - a[1]).map(([datasetKey, records]) => ({ datasetKey, records })),
      },
      null,
      1,
    ),
  );
  writeFileSync(join(WORK, 'wildlife-stats.json'), JSON.stringify({ builtAt: new Date().toISOString(), candidates: candidates.length, byWhy, cells: ordered.length, cellsAnswered: counted.size, rows: lines.length, unanswered, inconsistent, truncated, datasets: datasets.size, stoppedByBudget, failures: failures.slice(0, 200) }, null, 1));
  console.log(`${lines.length} rows from ${counted.size} of ${ordered.length} cells → ${join(WORK, 'wildlife.ndjson')}; ${unanswered} candidates without an answered cell, ${inconsistent} inconsistent, ${truncated} truncated, ${datasets.size} contributing datasets${failures.length ? `, ${failures.length} FAILED this run (rerun to ask again)` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
