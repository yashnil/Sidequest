#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * STAGE 06 — EVIDENCE TO ESTIMATES, AND THE ARTIFACT THE PRODUCT LOADS.
 *
 *   node packages/atlas/build/06-assemble.mjs
 *
 * Reads the candidates (04) and their sampled climate, terrain and sea
 * temperature (05) and writes `packages/atlas/data/atlas.json.gz`: one compact,
 * columnar file the server loads once.
 *
 * WHAT IS MEASURED AND WHAT IS ESTIMATED. Coordinates, countries, hierarchy,
 * monthly climate, elevation, sea temperature, airport distances, price levels
 * and sitelink counts are measured or published facts and are stored as such.
 * Everything else about a derived destination is an **estimate**, and this
 * file is where each one is made:
 *
 * - **What it offers (24 experiences, 0–3).** Per experience, four evidence
 *   signals — its own guide text, what its children's guides say, the notable
 *   features inside its extent, a terrain/climate proxy — are combined by a
 *   non-negative linear model **fitted to the curated catalog's editorial
 *   labels** on the destinations both hold. The fit is cross-validated and the
 *   agreement is written to the manifest; nothing about a specific place is
 *   hand-set, and the model can only say "more evidence, higher score".
 * - **Confidence.** How much evidence stands behind those scores, from the
 *   guide's status and length and the features found. The scorer discounts a
 *   thin reading rather than trusting or discarding it.
 * - **Substance.** Whether there is enough here for several days.
 * - **Cost.** The World Bank household-consumption price level of the country,
 *   mapped onto the catalog's 1–4 scale through the catalog's own entries.
 * - **Nights, difficulty, remoteness, familiarity, getting around, who it
 *   suits.** Rules over the measured fields, each calibrated against the
 *   curated twins where a label exists and reported in the manifest.
 *
 * No network. Deterministic: the same inputs give the same bytes.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { EXPERIENCES } from './lib/vocabulary.mjs';
import { worldRegionFor, worldRegionByPoint, WORLD_REGIONS } from './lib/world-regions.mjs';
import { advisoryTables, areaWarningFor, landmassOf, ols, ownRoomEvidence, ownWeight, placeKey, polygonScopes, refiledParents, spreadFor, suspectLocation, median as medianOf } from './lib/evidence.mjs';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const WORK = join(CACHE, 'work');
const RAW = join(CACHE, 'raw');
const OUT_DIR = process.env.ATLAS_OUT ?? 'packages/atlas/data';
const VERSION = process.env.ATLAS_VERSION ?? '2026-11.1';
const BUILT_AT = process.env.ATLAS_BUILT_AT ?? new Date().toISOString();

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const saturate = (x, k) => 1 - Math.exp(-x / k);
const round = (x, places = 2) => Math.round(x * 10 ** places) / 10 ** places;

async function ndjson(file, each) {
  const lines = createInterface({ input: createReadStream(file) });
  for await (const line of lines) if (line) each(JSON.parse(line));
}

const CONTINENT = { northern_europe: 'europe', western_europe: 'europe', southern_europe: 'europe', central_eastern_europe: 'europe', caucasus_central_asia: 'asia', middle_east: 'asia', north_africa: 'africa', east_africa: 'africa', southern_africa: 'africa', west_central_africa: 'africa', indian_ocean: 'africa', south_asia: 'asia', southeast_asia: 'asia', east_asia: 'asia', oceania: 'oceania', pacific_islands: 'oceania', north_america_west: 'americas', north_america_east: 'americas', north_america_north: 'americas', mexico_central_america: 'americas', caribbean: 'americas', south_america_north: 'americas', south_america_south: 'americas', polar: 'polar' };
/** Countries with territory on another continent, whose far-flung parts are filed by where they are. */
const OVERSEAS_HOLDERS = new Set(['GB', 'FR', 'NL', 'US', 'DK', 'NO', 'ES', 'PT', 'AU', 'NZ', 'CL', 'EC', 'IN', 'YE', 'ZA', 'BR', 'CO', 'JP']);

const KINDS = ['national_park', 'travel_region', 'mountain_range', 'island', 'island_group', 'coast', 'lake_district', 'country_circuit', 'city_and_surroundings', 'desert', 'wilderness', 'city', 'town', 'country', 'protected_area', 'ski_area', 'route'];
const ISLAND_TYPES = new Set(['Q23442', 'Q33837', 'Q1402592', 'Q42523']);
const GROUP_TYPES = new Set(['Q33837', 'Q1402592']);

function kindOf(candidate) {
  if (candidate.source === 'wikidata') return candidate.featureKind;
  const island = candidate.wdTypes.some((type) => ISLAND_TYPES.has(type)) || candidate.selfKinds.includes('island') || candidate.selfKinds.includes('islands');
  const group = candidate.wdTypes.some((type) => GROUP_TYPES.has(type)) || candidate.selfKinds.includes('islands');
  switch (candidate.wvType) {
    case 'country':
      /* A page Wikivoyage files as a country but which has no ISO code of its own (a base area, a dependency) is a region of the country it belongs to. */
      return candidate.ownIso ? 'country' : 'travel_region';
    case 'city':
      if (island && (candidate.population ?? 0) < 400_000) return group ? 'island_group' : 'island';
      return (candidate.population ?? 0) >= 100_000 || candidate.listings.see + candidate.listings.do >= 25 ? 'city' : 'town';
    case 'park':
      return candidate.selfKinds.includes('park') || /national park/i.test(candidate.title) ? 'national_park' : 'protected_area';
    case 'itinerary':
      return 'route';
    default:
      if (group) return 'island_group';
      if (island) return 'island';
      if (candidate.selfKinds.includes('range')) return 'mountain_range';
      if (candidate.selfKinds.includes('desert')) return 'desert';
      if (candidate.selfKinds.includes('lake')) return 'lake_district';
      if (/\b(coast|riviera|costa|shore)\b/i.test(candidate.name)) return 'coast';
      return 'travel_region';
  }
}

const KIND_WORDS = { national_park: 'national park', travel_region: 'region', mountain_range: 'mountain range', island: 'island', island_group: 'island group', coast: 'stretch of coast', lake_district: 'lake', desert: 'desert', protected_area: 'protected area', ski_area: 'ski area', route: 'route', city: 'city', town: 'town', country: 'country', wilderness: 'wilderness' };

/** Terrain and climate proxies per experience, 0–1, from what stage 05 sampled. Zero where rasters say nothing. */
function measuredProxies(candidate, raster) {
  const out = {};
  const base = raster?.base ?? null;
  if (!base) return out;
  const high = raster.high ?? null;
  const relief = high ? high.elevM - base.elevM : Math.max(0, (raster.relief?.maxM ?? base.elevM) - base.elevM);
  const top = high?.elevM ?? raster.relief?.maxM ?? base.elevM;
  const annual = base.pr.reduce((sum, value) => sum + value, 0);
  const warmest = Math.max(...base.tmax);
  const coldest = Math.min(...base.tmax);
  const coastKm = raster.sea?.coastKm ?? null;
  const sst = raster.sea?.sst ?? null;
  out.day_hiking = clamp(relief / 900);
  out.multi_day_trekking = clamp((relief - 500) / 2200) * clamp(candidate.radiusKm / 30, 0.4, 1);
  out.high_mountains = clamp((top - 900) / 2600) * clamp(relief / 1200, 0.3, 1);
  if (high) out.glaciers_ice = clamp((7 - Math.max(...high.tmax)) / 9);
  if (coastKm !== null) {
    out.coastal_scenery = coastKm <= 12 ? 1 : coastKm <= 45 ? 0.5 : 0;
    const warmSea = sst ? clamp((Math.max(...sst) - 18) / 6) : clamp((warmest - 22) / 8);
    out.beaches_swimming = coastKm <= 12 ? warmSea : coastKm <= 30 ? 0.4 * warmSea : 0;
    out.snorkel_dive = coastKm <= 12 && sst ? clamp((Math.max(...sst) - 21) / 7) : 0;
    out.paddling_boating = coastKm <= 12 ? 0.4 : 0;
  }
  out.rainforest_biodiversity = clamp((annual - 1300) / 1500) * clamp((Math.min(...base.tmin) - 10) / 8);
  out.desert_landscapes = clamp((320 - annual) / 260);
  const mid = high ? { tmax: base.tmax.map((value, index) => (value + high.tmax[index]) / 2) } : base;
  out.winter_snow = clamp((4 - Math.min(...mid.tmax)) / 9) * (relief >= 400 ? 1 : 0.35);
  void coldest;
  if ((candidate.population ?? 0) > 0) out.city_life = clamp((Math.log10(candidate.population) - 4.4) / 2);
  out.food = saturate(candidate.listings.eat + (candidate.subListings?.eat ?? 0) * 0.2, 25);
  return out;
}

function signalsFor(candidate, raster) {
  const proxies = measuredProxies(candidate, raster);
  return EXPERIENCES.map((experience) => [
    saturate(candidate.hits[experience] ?? 0, 8),
    candidate.rolled?.[experience] ?? 0,
    saturate(candidate.featureSignal?.[experience] ?? 0, 3),
    proxies[experience] ?? 0,
  ]);
}

/** Non-negative least squares with an intercept, by projected gradient descent. Small, exact enough, dependency-free. */
function fitNonNegative(rows, targets, ridge = 0.02) {
  const width = rows[0].length;
  const weights = new Array(width).fill(0.2);
  let bias = 0;
  const rate = 0.05;
  for (let step = 0; step < 4000; step += 1) {
    const gradient = new Array(width).fill(0);
    let gradientBias = 0;
    for (let index = 0; index < rows.length; index += 1) {
      let prediction = bias;
      for (let column = 0; column < width; column += 1) prediction += weights[column] * rows[index][column];
      const error = prediction - targets[index];
      gradientBias += error;
      for (let column = 0; column < width; column += 1) gradient[column] += error * rows[index][column];
    }
    bias = clamp(bias - (rate * gradientBias) / rows.length, 0, 0.15);
    for (let column = 0; column < width; column += 1) weights[column] = Math.max(0, weights[column] - rate * (gradient[column] / rows.length + ridge * weights[column]));
  }
  return { weights, bias };
}

const predict = (model, row) => clamp(model.bias + model.weights.reduce((sum, weight, column) => sum + weight * row[column], 0));

function correlation(a, b) {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let top = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    top += (a[i] - meanA) * (b[i] - meanB);
    da += (a[i] - meanA) ** 2;
    db += (b[i] - meanB) ** 2;
  }
  return da === 0 || db === 0 ? 0 : top / Math.sqrt(da * db);
}

function interpolate(anchors, x) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let index = 1; index < anchors.length; index += 1) {
    if (x <= anchors[index][0]) {
      const [x0, y0] = anchors[index - 1];
      const [x1, y1] = anchors[index];
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

function advisoryLevels(countryNames) {
  const file = join(RAW, 'advisories', 'TravelAdvisories.json');
  if (!existsSync(file)) return { levels: {}, asOf: null, unmatched: [] };
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  const levels = {};
  const unmatched = [];
  let newest = '';
  const alias = { burma: 'myanmar', 'the bahamas': 'bahamas', 'the gambia': 'gambia', "cote d ivoire": 'ivory coast', 'cabo verde': 'cape verde', 'timor leste': 'east timor', 'czechia': 'czech republic', 'kingdom of denmark': 'denmark', 'the kyrgyz republic': 'kyrgyzstan', 'kyrgyz republic': 'kyrgyzstan', 'republic of the congo': 'republic of the congo', 'mainland china': 'china', 'north korea': 'north korea', 'south korea': 'south korea', turkiye: 'turkey', 'eswatini': 'eswatini', 'micronesia': 'federated states of micronesia', 'sao tome and principe': 'são tomé and príncipe' };
  const norm = (name) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, ' ').trim();
  const byName = new Map();
  for (const [iso, names] of countryNames) for (const name of names) if (!byName.has(norm(name))) byName.set(norm(name), iso);
  for (const row of rows) {
    const match = /^(.*?)\s*-\s*Level (\d)/.exec(row.Title ?? '');
    if (!match) continue;
    const key = norm(match[1]);
    const iso = byName.get(key) ?? byName.get(norm(alias[key] ?? ''));
    const date = (row.Updated ?? row.Published ?? '').slice(0, 10);
    if (date > newest) newest = date;
    if (!iso) {
      unmatched.push(match[1]);
      continue;
    }
    levels[iso] = { level: Number(match[2]), asOf: date };
  }
  return { levels, asOf: newest || null, unmatched };
}

async function main() {
  const started = Date.now();
  const curated = JSON.parse(readFileSync(join(WORK, 'curated.json'), 'utf8'));
  if (JSON.stringify(curated.experiences) !== JSON.stringify(EXPERIENCES)) throw new Error('the build vocabulary and the catalog disagree about the experience list');
  const curatedById = new Map(curated.entries.map((entry) => [entry.id, entry]));
  const curatedAirports = JSON.parse(readFileSync(join(WORK, 'curated-airports.json'), 'utf8'));

  const candidates = [];
  await ndjson(join(WORK, 'candidates.ndjson'), (row) => candidates.push(row));
  const sampled = new Map();
  if (existsSync(join(WORK, 'rasters.ndjson'))) await ndjson(join(WORK, 'rasters.ndjson'), (row) => sampled.set(row.id, row));
  /*
   * Two samples make one reading. The centre's disc says what the ground is
   * (the highest country, the relief, the nearest sea); the base town, where
   * there is one, says what the weather is where people sleep. The high
   * country must stand at least 400 m above whichever base is used.
   */
  const complete = (point) => Boolean(point && point.tmax && point.tmax.every((value) => value !== null) && point.tmin.every((value) => value !== null) && point.pr.every((value) => value !== null));
  const combined = (id) => {
    const centre = sampled.get(id) ?? null;
    const town = sampled.get(`${id}#base`) ?? null;
    const base = complete(town?.base) ? town.base : complete(centre?.base) ? centre.base : null;
    if (!base) return null;
    const tops = [centre?.high, centre?.base, town?.high].filter((point) => complete(point) && point.elevM >= base.elevM + 400).sort((a, b) => b.elevM - a.elevM);
    const seas = [town?.sea, centre?.sea].filter((sea) => sea && sea.coastKm !== null).sort((a, b) => (a.sst ? 0 : 1) - (b.sst ? 0 : 1) || a.coastKm - b.coastKm);
    return { id, base, high: tops[0] ?? null, relief: centre?.relief ?? town?.relief ?? null, sea: seas[0] ?? { coastKm: null, sst: null }, baseIsTown: base === town?.base };
  };
  const rasters = { get: (id) => combined(id), size: sampled.size };
  console.log(`${candidates.length} candidates, ${rasters.size} sampled points`);

  const indexOf = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const countryNames = new Map();
  const countryNameOf = new Map();
  for (const candidate of candidates) {
    if (candidate.wvType !== 'country' || !candidate.ownIso || candidate.countries.length !== 1 || candidate.countries[0] !== candidate.ownIso) continue;
    countryNames.set(candidate.countries[0], [candidate.name, ...candidate.aliases]);
    countryNameOf.set(candidate.countries[0], candidate.name);
  }

  /* ── Experience model: fit on the destinations the curated catalog also holds ── */
  const twins = candidates.filter((candidate) => candidate.curated && curatedById.has(candidate.curated));
  const signals = new Map(candidates.map((candidate) => [candidate.id, signalsFor(candidate, rasters.get(candidate.id))]));
  const models = [];
  const agreement = [];
  const FOLDS = 5;
  for (let e = 0; e < EXPERIENCES.length; e += 1) {
    const rows = twins.map((twin) => signals.get(twin.id)[e]);
    const targets = twins.map((twin) => (curatedById.get(twin.curated).experiences[EXPERIENCES[e]] ?? 0) / 3);
    const model = fitNonNegative(rows, targets);
    models.push(model);
    /* Held-out agreement: each fifth predicted by a model that never saw it. */
    const heldOut = new Array(rows.length).fill(0);
    for (let fold = 0; fold < FOLDS; fold += 1) {
      const train = rows.map((_, index) => index).filter((index) => index % FOLDS !== fold);
      const partial = fitNonNegative(train.map((index) => rows[index]), train.map((index) => targets[index]));
      for (let index = fold; index < rows.length; index += FOLDS) heldOut[index] = predict(partial, rows[index]);
    }
    const mae = heldOut.reduce((sum, value, index) => sum + Math.abs(value - targets[index]), 0) / Math.max(1, rows.length);
    const strong = targets.map((value) => (value >= 2 / 3 ? 1 : 0));
    const called = heldOut.map((value) => (value >= 0.5 ? 1 : 0));
    const hit = strong.filter((value, index) => value === 1 && called[index] === 1).length;
    agreement.push({
      experience: EXPERIENCES[e],
      weights: { text: round(model.weights[0]), children: round(model.weights[1]), features: round(model.weights[2]), terrain: round(model.weights[3]), bias: round(model.bias) },
      heldOut: { n: rows.length, correlation: round(correlation(heldOut, targets)), maeOn0to3: round(mae * 3), strongLabelled: strong.reduce((s, v) => s + v, 0), strongRecall: strong.some(Boolean) ? round(hit / strong.reduce((s, v) => s + v, 0)) : null, strongPrecision: called.some(Boolean) ? round(hit / called.reduce((s, v) => s + v, 0)) : null },
    });
  }

  /* ── Cost: the country price level, placed on the catalog's own 1–4 scale ── */
  const priceOf = (iso) => curated.priceLevels[iso]?.c ?? curated.priceLevels[iso]?.g ?? null;
  const priceByCost = [[], [], [], [], []];
  for (const entry of curated.entries) {
    const level = priceOf(entry.countries[0]);
    if (level !== null) priceByCost[entry.cost].push(level);
  }
  const costAnchors = [1, 2, 3, 4].map((cost) => [median(priceByCost[cost]), cost]).filter(([price]) => price !== null).sort((a, b) => a[0] - b[0]);
  /* Anchors must rise with price; a level whose median falls out of order is dropped rather than bent. */
  const monotone = costAnchors.filter(([, cost], index) => index === 0 || cost > costAnchors[index - 1][1]);
  const costFor = (iso) => {
    const price = iso ? priceOf(iso) : null;
    return price === null ? null : clamp(interpolate(monotone, price), 1, 4);
  };

  /* ── Familiarity: sitelinks against the catalog's own 0–3 reading ── */
  const famPairs = twins.filter((twin) => twin.sitelinks > 0).map((twin) => [Math.log(1 + twin.sitelinks), curatedById.get(twin.curated).familiarity]);
  const meanX = famPairs.reduce((s, [x]) => s + x, 0) / famPairs.length;
  const meanY = famPairs.reduce((s, [, y]) => s + y, 0) / famPairs.length;
  const slope = famPairs.reduce((s, [x, y]) => s + (x - meanX) * (y - meanY), 0) / famPairs.reduce((s, [x]) => s + (x - meanX) ** 2, 0);
  const familiarityFor = (candidate) => clamp(meanY + slope * (Math.log(1 + candidate.sitelinks) - meanX) + 0.5 * (candidate.prominence - 0.5), 0, 3);

  const advisories = advisoryLevels(countryNames);

  /* ── Real geography (stage 08), when it has been run ─────────────────── */
  const geometry = new Map();
  if (existsSync(join(WORK, 'geometry.ndjson'))) await ndjson(join(WORK, 'geometry.ndjson'), (row) => geometry.set(row.id, row));
  const polygonLines = [];
  if (existsSync(join(WORK, 'polygons.ndjson'))) await ndjson(join(WORK, 'polygons.ndjson'), (row) => polygonLines.push(row));
  const scopes = polygonScopes(polygonLines);
  let refiled = 0;
  for (const candidate of candidates) {
    const parents = refiledParents(candidate, scopes);
    if (parents.length !== candidate.parents.length) refiled += 1;
    candidate.parents = parents;
  }
  const landmassIndex = new Map([['', 0]]);
  const landmassId = (key) => {
    if (!key) return 0;
    if (!landmassIndex.has(key)) landmassIndex.set(key, landmassIndex.size);
    return landmassIndex.get(key);
  };

  /* ── Regional advisories from every authority ────────────────────────── */
  const advisoryFile = join(WORK, 'advisories-v2.json');
  const advisoriesV2 = existsSync(advisoryFile) ? JSON.parse(readFileSync(advisoryFile, 'utf8')) : null;
  const advisoryData = advisoriesV2 ? advisoryTables(advisoriesV2) : null;
  const advisoryRows = {};
  const warningFor = (iso, name, parentIds, division, radiusKm) => {
    if (!advisoryData || !iso) return null;
    const ancestors = parentIds.map((id) => placeKey(candidates[indexOf.get(id) ?? -1]?.name ?? '')).filter(Boolean);
    const own = placeKey(name);
    const divisionKey = division ? placeKey(division) : '';
    return areaWarningFor(advisoryData.prepared, iso, { places: [own, ...ancestors, divisionKey].filter(Boolean), division: divisionKey, name: own, ancestors, radiusKm });
  };

  /* ── Cost from dated listings: a prior from the hierarchy, updated by the place's own prices ── */
  const priced = new Map();
  if (existsSync(join(WORK, 'prices.ndjson'))) await ndjson(join(WORK, 'prices.ndjson'), (row) => priced.set(row.id, row));
  const priceYear = new Date().getUTCFullYear();
  const ownRoom = new Map();
  for (const [id, row] of priced) {
    const own = ownRoomEvidence(row.sleep, priceYear);
    if (own) ownRoom.set(id, own);
  }
  const countryPool = new Map();
  const ancestorPool = new Map();
  const add = (pool, key, value) => {
    const list = pool.get(key);
    if (list) list.push(value);
    else pool.set(key, [value]);
  };
  for (const candidate of candidates) {
    const own = ownRoom.get(candidate.id);
    if (!own || own.n < 3) continue;
    if (candidate.countries.length === 1) add(countryPool, candidate.countries[0], own.logUsd);
    for (const parent of candidate.parents.slice(0, 3)) if (candidates[indexOf.get(parent) ?? -1]?.wvType !== 'country') add(ancestorPool, parent, own.logUsd);
  }
  const without = (list, value) => {
    if (!list) return [];
    if (value === undefined) return list;
    const at = list.indexOf(value);
    return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)];
  };
  const priorSignals = (candidate) => {
    const self = ownRoom.get(candidate.id);
    const selfValue = self && self.n >= 3 ? self.logUsd : undefined;
    const iso = candidate.countries.length === 1 ? candidate.countries[0] : null;
    const peers = iso ? without(countryPool.get(iso), selfValue) : [];
    const country = peers.length >= 20 ? medianOf(peers) : null;
    let hierarchy = null;
    for (const parent of candidate.parents.slice(0, 3)) {
      const list = without(ancestorPool.get(parent), selfValue);
      if (list.length >= 3) {
        hierarchy = medianOf(list);
        break;
      }
    }
    const level = iso ? priceOf(iso) : null;
    return { country, hierarchy, world: level === null ? null : Math.log(level) };
  };
  const costShapes = [
    ['hierarchy', 'country', 'world'],
    ['country', 'world'],
    ['hierarchy', 'world'],
    ['world'],
  ];
  const costFits = costShapes.map((shape) => {
    const rows = [];
    const targets = [];
    for (const candidate of candidates) {
      const own = ownRoom.get(candidate.id);
      if (!own || own.n < 5) continue;
      const signals = priorSignals(candidate);
      if (shape.some((key) => signals[key] === null)) continue;
      rows.push([1, ...shape.map((key) => signals[key])]);
      targets.push(own.logUsd);
    }
    return { shape, beta: rows.length >= 30 ? ols(rows, targets) : null, n: rows.length };
  });
  const roomEstimate = (candidate) => {
    const signals = priorSignals(candidate);
    const fit = costFits.find(({ shape, beta }) => beta && shape.every((key) => signals[key] !== null));
    if (!fit) return null;
    const prior = fit.beta[0] + fit.shape.reduce((sum, key, index) => sum + fit.beta[index + 1] * signals[key], 0);
    const own = ownRoom.get(candidate.id);
    const weight = own ? ownWeight(own.nEff) : 0;
    const logUsd = own ? prior + weight * (own.logUsd - prior) : prior;
    return { logUsd, own, listingBased: Boolean(own) || fit.shape.length > 1 };
  };
  /*
   * The 1–4 scale stays anchored on the country, whose agreement with the
   * editorial labels is the better of the two; what the listings add is how far
   * this place sits from what its country's price level alone predicts. The one
   * coefficient is fitted on the curated entries and reported held-out.
   */
  const worldFit = costFits.find((fit) => fit.shape.length === 1 && fit.beta);
  const residualOf = (candidate, estimate) => {
    const iso = candidate.countries.length === 1 ? candidate.countries[0] : null;
    const level = iso ? priceOf(iso) : null;
    /* Only a place's own well-attested listings say how it differs from its country; inherited priors are the country again. */
    if (!worldFit || level === null || !estimate?.own || estimate.own.n < 5) return null;
    return estimate.logUsd - (worldFit.beta[0] + worldFit.beta[1] * Math.log(level));
  };
  const residualRows = [];
  for (const twin of twins) {
    const estimate = roomEstimate(twin);
    const residual = residualOf(twin, estimate);
    const country = costFor(twin.countries.length === 1 ? twin.countries[0] : null);
    if (residual === null || country === null) continue;
    residualRows.push({ residual, gap: curatedById.get(twin.curated).cost - country, country });
  }
  const slopeOf = (rows) => {
    const denominator = rows.reduce((sum, row) => sum + row.residual ** 2, 0);
    return denominator === 0 ? 0 : Math.max(0, rows.reduce((sum, row) => sum + row.residual * row.gap, 0) / denominator);
  };
  const costSlope = slopeOf(residualRows);
  const heldOut = residualRows.map((row, index) => Math.abs(row.gap - slopeOf(residualRows.filter((_, other) => other !== index)) * row.residual));
  const heldOutCountry = residualRows.map((row) => Math.abs(row.gap));
  const costCheck = { country: [], listings: [] };
  
  /* ── Per-row estimates ───────────────────────────────────────────────── */
  const N = candidates.length;
  const exp = new Uint8Array(N * EXPERIENCES.length);
  const u8 = () => new Uint8Array(N);
  const cols = { kind: u8(), region: u8(), flags: u8(), confidence: u8(), substance: u8(), familiarity: u8(), crowds: u8(), remoteness: u8(), easiest: u8(), typical: u8(), cost: u8(), costBasis: u8(), costSpread: u8(), reach: u8(), car: u8(), transit: u8(), family: u8(), lowMobility: u8(), lodging: u8() };
  const nights = new Uint8Array(N * 3);
  const landmass = new Uint16Array(N);
  const roomUsd = new Uint16Array(N);
  const priceYears = {};
  const clim = new Int16Array(N * 37).fill(-32768);
  const coast = new Int16Array(N).fill(-1);
  const highRows = [];
  const highData = [];
  const seaRows = [];
  const seaData = [];
  const airportTable = [];
  const airportIndex = new Map();
  const airportRef = new Int32Array(N * 3).fill(-1);
  const airportKm = new Uint16Array(N * 3);
  const names = [];
  const ids = [];
  const contexts = [];
  const resolveAs = [];
  const qids = [];
  const wv = [];
  const countriesCol = [];
  const lat = [];
  const lng = [];
  const radius = [];
  const parent = new Int32Array(N).fill(-1);
  const pitch = [];
  const highlights = [];
  const bases = [];
  const aliases = {};
  const members = {};
  const curatedTwin = {};
  const STATUS = { stub: 0.1, outline: 0.35, usable: 0.7, guide: 0.9, star: 1 };
  const CAR = { unknown: 0, unnecessary: 1, helpful: 2, essential: 3 };
  const TRANSIT = { unknown: 0, good: 1, limited: 2, poor: 3 };
  /*
   * CHELSA's day–night range collapses on small islands and tropical coasts
   * (Honolulu's February high reads 23.6 °C against a measured 27; Singapore's
   * December 27.4 against 30), because the cell behaves like the sea around
   * it, while the monthly MEAN is close to stations. A real land surface does
   * not have a diurnal half-range under about 3.5 °C, so the high and low are
   * restored around the unchanged mean wherever the grid says less. Inland,
   * where the range is already wider, nothing changes.
   */
  const MIN_HALF_RANGE = 3.5;
  const widen = (point) => {
    const tmax = [];
    const tmin = [];
    for (let month = 0; month < 12; month += 1) {
      const mean = (point.tmax[month] + point.tmin[month]) / 2;
      const half = Math.max(MIN_HALF_RANGE, (point.tmax[month] - point.tmin[month]) / 2);
      tmax.push(mean + half);
      tmin.push(mean - half);
    }
    return { ...point, tmax, tmin };
  };
  const packClimate = (raw) => {
    const point = widen(raw);
    return [Math.round(point.elevM), ...point.tmax.map((value) => Math.round(value * 10)), ...point.tmin.map((value) => Math.round(value * 10)), ...point.pr.map((value) => Math.round(value))];
  };
  const usable = complete;
  const calibration = { challenge: [], remoteness: [], crowds: [], nights: [], family: [], lowMobility: [], cost: [], familiarity: [] };
  const stats = { byKind: {}, byRegion: {}, withClimate: 0, withHigh: 0, withSea: 0, scopeOnly: 0, dataOnly: 0, guide: 0, costKnown: 0 };

  for (let i = 0; i < N; i += 1) {
    const candidate = candidates[i];
    const raster = rasters.get(candidate.id) ?? null;
    const kind = candidate.scopeOnly ? 'travel_region' : kindOf(candidate);
    const iso = candidate.countries[0] ?? null;
    /*
     * A country's travel region is where the country is; an overseas territory's
     * is where the territory is. When the two readings put a place on different
     * continents, the ground wins — the Chagos Islands are not northern Europe
     * for flying the Union flag. (The Canaries, Madeira and the Azores stay
     * with Iberia, which is how travellers and the curated catalog file them.)
     */
    const byCountry = iso ? worldRegionFor(iso, candidate.lat, candidate.lng) : null;
    const byPoint = worldRegionByPoint(candidate.lat, candidate.lng);
    const macaronesia = (iso === 'ES' || iso === 'PT') && candidate.lat >= 27 && candidate.lat <= 40 && candidate.lng >= -32 && candidate.lng <= -13;
    const region = byCountry && (macaronesia || CONTINENT[byCountry] === CONTINENT[byPoint] || !OVERSEAS_HOLDERS.has(iso)) ? byCountry : byPoint;
    const guide = candidate.source === 'wikivoyage';
    ids.push(candidate.id);
    names.push(candidate.name);
    qids.push(candidate.qid ?? '');
    wv.push(candidate.title ?? '');
    countriesCol.push(candidate.countries.join(','));
    lat.push(candidate.lat);
    lng.push(candidate.lng);
    radius.push(candidate.radiusKm);
    parent[i] = candidate.parents.length > 0 ? indexOf.get(candidate.parents[0]) ?? -1 : -1;
    cols.kind[i] = Math.max(0, KINDS.indexOf(kind));
    cols.region[i] = Math.max(0, WORLD_REGIONS.indexOf(region));
    if (candidate.aliases.length > 0) aliases[i] = candidate.aliases;
    {
      const listed = (candidate.members ?? []).map((id) => indexOf.get(id));
      const inside = [...(scopes.get(candidate.id) ?? [])].map((id) => indexOf.get(id));
      const rows = [...new Set([...listed, ...(inside.length >= 3 ? inside : [])])].filter((row) => row !== undefined && row !== i);
      if (rows.length > 0) members[i] = rows;
    }
    if (candidate.curated) curatedTwin[candidate.curated] = i;
    const located = geometry.get(candidate.id);
    const suspect = suspectLocation(candidate, located, kind);
    if (suspect) stats.suspectLocation = (stats.suspectLocation ?? 0) + 1;
    cols.flags[i] = (candidate.scopeOnly ? 1 : 0) | (candidate.curated ? 2 : 0) | (guide ? 0 : 4) | (suspect ? 8 : 0);
    landmass[i] = landmassId(landmassOf(candidate, located));
    if (candidate.countries.length === 1) {
      const warning = warningFor(candidate.countries[0], candidate.name, candidate.parents, located?.adm1?.name ?? null, candidate.radiusKm);
      if (warning) advisoryRows[i] = warning;
    }
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    stats.byRegion[region] = (stats.byRegion[region] ?? 0) + 1;
    if (candidate.scopeOnly) stats.scopeOnly += 1;
    if (guide) stats.guide += 1;
    else stats.dataOnly += 1;

    /* Experiences. */
    const rowSignals = signals.get(candidate.id);
    const scores = rowSignals.map((row, e) => predict(models[e], row) * 3);
    for (let e = 0; e < EXPERIENCES.length; e += 1) exp[i * EXPERIENCES.length + e] = Math.round(scores[e] * 10);
    const score = (experience) => scores[EXPERIENCES.indexOf(experience)];

    /* Confidence in those scores, and whether there is a trip here. */
    const seeDo = candidate.listings.see + candidate.listings.do;
    const below = (candidate.subListings?.see ?? 0) + (candidate.subListings?.do ?? 0);
    const featureCount = Object.values(candidate.featureKinds ?? {}).reduce((sum, slot) => sum + slot.n, 0);
    const status = guide ? (candidate.status ? STATUS[candidate.status] : candidate.wvType === 'extraregion' ? 0.5 : 0.3) : 0;
    const confidence = guide
      ? clamp(0.28 + 0.3 * status + 0.14 * saturate(candidate.words, 1800) + 0.1 * saturate(seeDo + 0.3 * below, 12) + 0.08 * saturate(featureCount, 6) + (raster?.base ? 0.05 : 0), 0.3, 0.93)
      : clamp(0.24 + 0.14 * saturate(featureCount, 6) + 0.12 * saturate(candidate.sitelinks, 25) + (raster?.base ? 0.06 : 0), 0.24, 0.55);
    const sleep = candidate.listings.sleep + 0.4 * (candidate.subListings?.sleep ?? 0);
    const substance = guide
      ? clamp(0.3 * status + 0.25 * saturate(seeDo + 0.5 * below, 14) + 0.15 * saturate(sleep, 6) + 0.15 * candidate.prominence + 0.15 * saturate(candidate.bytes, 14000) + (candidate.childCount >= 3 ? 0.08 : 0))
      : clamp(0.16 + 0.26 * saturate(candidate.sitelinks, 30) + 0.14 * saturate(featureCount, 8) + (candidate.whs ? 0.12 : 0) + (candidate.bases.length > 0 ? 0.08 : 0), 0, 0.62);
    cols.confidence[i] = Math.round(confidence * 100);
    cols.substance[i] = Math.round(substance * 100);

    /* Getting there: measured distances to scheduled airports. */
    const near = candidate.airports ?? [];
    near.forEach((airport, slot) => {
      let ref = airportIndex.get(airport.iata);
      if (ref === undefined) {
        ref = airportTable.length;
        airportIndex.set(airport.iata, ref);
        airportTable.push([airport.iata, airport.name, airport.size === 'large' ? 1 : 0]);
      }
      airportRef[i * 3 + slot] = ref;
      airportKm[i * 3 + slot] = Math.min(65535, airport.km);
    });
    const nearestKm = near[0]?.km ?? 2000;
    const hub = near.find((airport) => airport.size === 'large');
    const hubKm = hub?.km ?? 3000;
    const reach = hubKm <= 120 ? 0.3 : nearestKm <= 100 && hubKm <= 700 ? 1 : nearestKm <= 250 ? 1.6 : nearestKm <= 500 ? 2.3 : 3;
    const urban = (kind === 'city' && (candidate.population ?? 0) >= 100_000) ? 1 : 0;
    const remoteness = clamp(0.011 * Math.min(nearestKm, 250) + (hubKm > 700 ? 0.6 : hubKm > 350 ? 0.3 : 0) - 0.9 * urban + (guide ? 0 : 0.4) - 0.3 * saturate(sleep, 8), 0, 3);
    const typical = clamp(0.25 + 1.3 * (score('multi_day_trekking') / 3) + 0.6 * (score('high_mountains') / 3) + 0.35 * (remoteness / 3) + 0.2 * (score('day_hiking') / 3) - 0.3 * urban, 0, 3);
    const easiest = clamp(typical - 1.1, 0, 3);
    const familiarity = familiarityFor(candidate);
    const crowds = clamp(familiarity - (candidate.radiusKm > 150 ? 0.5 : 0) + 0.3 * urban - 0.3 * (remoteness / 3), 0, 3);
    cols.reach[i] = Math.round(reach * 10);
    cols.remoteness[i] = Math.round(remoteness * 10);
    cols.typical[i] = Math.round(typical * 10);
    cols.easiest[i] = Math.round(easiest * 10);
    cols.familiarity[i] = Math.round(familiarity * 10);
    cols.crowds[i] = Math.round(crowds * 10);

    const countryCost = costFor(iso);
    const estimate = roomEstimate(candidate);
    let cost = countryCost;
    const residual = residualOf(candidate, estimate);
    if (residual !== null && countryCost !== null) cost = clamp(countryCost + costSlope * residual, 1, 4);
    if (estimate?.listingBased && countryCost !== null) {
      roomUsd[i] = Math.min(65_000, Math.round(Math.exp(estimate.logUsd)));
      const nEff = estimate.own?.nEff ?? 0;
      const wide = kind === 'national_park' || kind === 'protected_area' || (candidate.radiusKm > 150 && kind !== 'country');
      cols.costSpread[i] = Math.round(spreadFor(nEff, wide) * 100) - 100;
      const observed = estimate.own && estimate.own.n >= 5 && estimate.own.age <= 7;
      cols.costBasis[i] = observed ? 2 : 1;
      if (estimate.own?.yearMin && estimate.own.yearMax) priceYears[i] = [estimate.own.yearMin, estimate.own.yearMax];
      if (candidate.curated && countryCost !== null) {
        const label = curatedById.get(candidate.curated).cost;
        costCheck.country.push(Math.abs(countryCost - label));
        costCheck.listings.push(Math.abs(cost - label));
      }
    }
    cols.cost[i] = cost === null ? 0 : Math.round(cost * 10);
    if (cost !== null) stats.costKnown += 1;

    /* How long it carries. */
    const area = candidate.wdAreaKm2 ?? Math.PI * candidate.radiusKm ** 2;
    let stay;
    if (kind === 'country') stay = area < 30_000 ? [4, 7, 12] : area < 150_000 ? [6, 10, 16] : area < 600_000 ? [8, 13, 21] : [12, 18, 28];
    else if (kind === 'city') stay = (candidate.population ?? 0) >= 1_500_000 || seeDo >= 60 ? [3, 4, 7] : [2, 3, 5];
    else if (kind === 'town') stay = seeDo >= 12 ? [2, 3, 4] : [1, 2, 3];
    else if (kind === 'route') stay = [4, 7, 14];
    else if (kind === 'island') stay = candidate.radiusKm >= 40 ? [4, 7, 12] : [3, 5, 8];
    else if (kind === 'island_group') stay = [5, 8, 14];
    else if (kind === 'ski_area') stay = [3, 6, 8];
    else if (kind === 'national_park' || kind === 'protected_area') stay = score('multi_day_trekking') >= 1.6 || candidate.radiusKm >= 45 ? [3, 5, 9] : [2, 3, 5];
    else stay = candidate.radiusKm >= 250 ? [7, 10, 16] : candidate.radiusKm >= 90 ? [5, 8, 12] : candidate.radiusKm >= 35 ? [4, 6, 9] : [2, 4, 6];
    nights.set(stay, i * 3);

    /* Getting around and who it suits: read from the guide's practical sections, absent when there is no guide. */
    const practical = candidate.practical ?? {};
    let car = 'unknown';
    let transit = 'unknown';
    if (guide && candidate.words >= 150) {
      const transitWords = practical.transit ?? 0;
      const carWords = practical.car ?? 0;
      transit = urban || transitWords >= 8 ? 'good' : transitWords >= 2 ? 'limited' : 'poor';
      if (kind === 'city' || kind === 'town') car = urban || transitWords >= carWords ? 'unnecessary' : 'helpful';
      else car = carWords >= 3 && transitWords <= 1 ? 'essential' : remoteness >= 2 && transitWords === 0 ? 'essential' : transitWords >= 8 && carWords <= 1 ? 'unnecessary' : 'helpful';
    }
    cols.car[i] = CAR[car];
    cols.transit[i] = TRANSIT[transit];
    let family = null;
    let lowMobility = null;
    let lodging = 0;
    if (guide && candidate.words >= 150) {
      const kindBase = { city: 2, town: 2, island: 2, island_group: 1.8, coast: 2.1, lake_district: 2, national_park: 1.5, protected_area: 1.4, travel_region: 1.7, country: 1.8, mountain_range: 1.2, desert: 1.2, route: 1.2, ski_area: 2 }[kind] ?? 1.6;
      family = clamp(kindBase + 0.6 * saturate(practical.family ?? 0, 4) + 0.3 * (score('beaches_swimming') / 3) - 0.55 * typical - 0.2 * remoteness, 0, 3);
      const mobilityBase = { city: 2, town: 1.6, coast: 1.7, lake_district: 1.7, island: 1.4, country: 1.7, travel_region: 1.5 }[kind] ?? 1.1;
      lowMobility = clamp(mobilityBase + 0.5 * urban + 0.4 * saturate(practical.accessible ?? 0, 3) - 0.5 * typical - 0.25 * remoteness, 0, 3);
      lodging = 8 | ((practical.budget ?? 0) > 0 || !urban ? 1 : 0) | (candidate.hasSleep ? 2 : 0) | ((practical.luxury ?? 0) >= 2 || (candidate.population ?? 0) >= 500_000 ? 4 : 0);
    }
    cols.family[i] = family === null ? 255 : Math.round(family * 10);
    cols.lowMobility[i] = lowMobility === null ? 255 : Math.round(lowMobility * 10);
    cols.lodging[i] = lodging;

    /* Words. */
    const countryName = iso ? countryNameOf.get(iso) ?? null : null;
    const parentNames = candidate.parents.map((id) => candidates[indexOf.get(id) ?? -1]).filter(Boolean);
    const nearestRegion = parentNames.find((entry) => entry.wvType !== 'country' && !entry.scopeOnly && entry.name !== candidate.name);
    const regionLabel = { northern_europe: 'Northern Europe', western_europe: 'Western Europe', southern_europe: 'Southern Europe', central_eastern_europe: 'Central & Eastern Europe', caucasus_central_asia: 'Caucasus & Central Asia', middle_east: 'Middle East', north_africa: 'North Africa', east_africa: 'East Africa', southern_africa: 'Southern Africa', west_central_africa: 'West & Central Africa', indian_ocean: 'Indian Ocean', south_asia: 'South Asia', southeast_asia: 'Southeast Asia', east_asia: 'East Asia', oceania: 'Australia & New Zealand', pacific_islands: 'Pacific Islands', north_america_west: 'Western North America', north_america_east: 'Eastern North America', north_america_north: 'Alaska & Northern Canada', mexico_central_america: 'Mexico & Central America', caribbean: 'Caribbean', south_america_north: 'Northern South America', south_america_south: 'Southern South America', polar: 'Polar regions' }[region];
    const context = kind === 'country' ? regionLabel : [nearestRegion?.name, countryName].filter(Boolean).filter((part, index, list) => list.indexOf(part) === index).join(', ') || regionLabel;
    contexts.push(context.slice(0, 60));
    resolveAs.push(kind === 'country' || !countryName || candidate.name.includes(countryName) ? candidate.name : `${candidate.name}, ${countryName}`);
    const sentence = guide ? candidate.firstSentence.replace(/\s+/g, ' ').trim() : '';
    pitch.push(sentence.length >= 25 ? (sentence.length > 220 ? `${sentence.slice(0, 217).replace(/\s+\S*$/, '')}…` : sentence) : `${/^[aeiou]/i.test(KIND_WORDS[kind] ?? 'place') ? 'An' : 'A'} ${KIND_WORDS[kind] ?? 'place'}${countryName ? ` in ${countryName}` : ''}${candidate.description ? ` — ${candidate.description}` : ''}.`);
    const picks = [];
    const push = (name) => {
      if (name && name.length >= 3 && name.length <= 60 && !picks.includes(name) && name !== candidate.name) picks.push(name);
    };
    candidate.topSee.slice(0, 3).forEach(push);
    candidate.topDo.slice(0, 2).forEach(push);
    candidate.nearFeatures.forEach((name) => picks.length < 5 && push(name));
    [...candidate.listed.other, ...candidate.listed.cities].forEach((title) => picks.length < 5 && push(title.replace(/\s*\([^)]*\)\s*$/, '')));
    highlights.push(picks.slice(0, 5));
    bases.push((candidate.bases ?? []).slice(0, 4));

    /* Climate, terrain, sea. */
    if (usable(raster?.base)) {
      clim.set(packClimate(raster.base), i * 37);
      stats.withClimate += 1;
      if (usable(raster.high)) {
        highRows.push(i);
        highData.push(...packClimate(raster.high));
        stats.withHigh += 1;
      }
      const coastKm = raster.sea?.coastKm ?? null;
      if (coastKm !== null) coast[i] = Math.min(32767, Math.round(coastKm));
      if (raster.sea?.sst && raster.sea.sst.every((value) => value !== null)) {
        seaRows.push(i);
        seaData.push(...raster.sea.sst.map((value) => Math.round(value * 10)));
        stats.withSea += 1;
      }
    }

    /* Calibration against the editorial reading, where one exists. */
    const entry = candidate.curated ? curatedById.get(candidate.curated) : null;
    if (entry) {
      calibration.challenge.push(Math.abs(typical - entry.challenge.typical));
      calibration.remoteness.push(Math.abs(remoteness - entry.remoteness));
      calibration.crowds.push(Math.abs(crowds - entry.crowds));
      calibration.familiarity.push(Math.abs(familiarity - entry.familiarity));
      calibration.nights.push(Math.abs(stay[1] - entry.nights.ideal));
      if (family !== null) calibration.family.push(Math.abs(family - entry.family));
      if (lowMobility !== null) calibration.lowMobility.push(Math.abs(lowMobility - entry.lowMobility));
      if (cost !== null) calibration.cost.push(Math.abs(cost - entry.cost));
    }
  }

  /* ── Lexical index: a vocabulary and per-row postings ─────────────────── */
  const vocab = new Map();
  const offsets = new Uint32Array(N + 1);
  const termIds = [];
  const termWeights = [];
  for (let i = 0; i < N; i += 1) {
    offsets[i] = termIds.length;
    for (const [term, weight] of candidates[i].terms ?? []) {
      let id = vocab.get(term);
      if (id === undefined) {
        id = vocab.size;
        vocab.set(term, id);
      }
      termIds.push(id);
      termWeights.push(Math.min(255, Math.round(weight * 25)));
    }
  }
  offsets[N] = termIds.length;

  /* ── Curated entries: the measured facts to lay beside their editorial reading ── */
  const curatedEnrichment = {};
  for (const entry of curated.entries) {
    const raster = rasters.get(`cur:${entry.id}`) ?? null;
    const twin = curatedTwin[entry.id];
    const out = { airports: curatedAirports[entry.id] ?? [] };
    if (twin !== undefined) out.twin = twin;
    const located = geometry.get(`cur:${entry.id}`);
    const landKey = landmassId(located?.land?.id ?? null);
    if (landKey) out.landmass = landKey;
    if (entry.countries.length === 1) {
      const warning = warningFor(entry.countries[0], entry.name, twin !== undefined ? candidates[twin].parents : [], located?.adm1?.name ?? null, entry.radiusKm ?? 100);
      if (warning) out.advisory = warning;
    }
    if (usable(raster?.base)) {
      out.base = packClimate(raster.base);
      if (usable(raster.high)) out.high = packClimate(raster.high);
      if (raster.sea?.coastKm !== null && raster.sea?.coastKm !== undefined) out.coastKm = Math.round(raster.sea.coastKm);
      if (raster.sea?.sst && raster.sea.sst.every((value) => value !== null)) out.sst = raster.sea.sst.map((value) => Math.round(value * 10));
    }
    curatedEnrichment[entry.id] = out;
  }

  const mean = (values) => (values.length === 0 ? null : round(values.reduce((s, v) => s + v, 0) / values.length));
  const sources = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
  const manifest = {
    format: 1,
    version: VERSION,
    builtAt: BUILT_AT,
    counts: { destinations: N - stats.scopeOnly, scopes: stats.scopeOnly, fromGuides: stats.guide - stats.scopeOnly, fromDataOnly: stats.dataOnly, curatedTwins: Object.keys(curatedTwin).length, curated: curated.entries.length, withMeasuredClimate: stats.withClimate, withHighCountry: stats.withHigh, withSeaTemperature: stats.withSea, withPriceLevel: stats.costKnown, vocabulary: vocab.size, airports: airportTable.length, byKind: stats.byKind, byWorldRegion: stats.byRegion },
    estimators: {
      experiences: { method: 'non-negative linear model per experience over four evidence signals (own guide text, children, Wikidata features in extent, terrain/climate proxy), fitted to curated editorial labels; 5-fold held-out agreement below', fittedOn: twins.length, agreement },
      meanAbsoluteErrorAgainstCurated: { challengeTypical0to3: mean(calibration.challenge), remoteness0to3: mean(calibration.remoteness), crowds0to3: mean(calibration.crowds), familiarity0to3: mean(calibration.familiarity), nightsIdeal: mean(calibration.nights), family0to3: mean(calibration.family), lowMobility0to3: mean(calibration.lowMobility), cost1to4: mean(calibration.cost) },
      cost: { method: 'World Bank household-consumption price level of the country, interpolated between the median price levels of curated entries at each cost level', anchors: monotone.map(([price, cost]) => ({ priceLevel: round(price, 3), cost })) },
      familiarity: { method: 'least-squares line from log(1 + Wikimedia sitelinks) to the curated 0–3 reading, plus guide prominence', slope: round(slope, 3), n: famPairs.length },
    },
    advisories: { source: 'U.S. Department of State travel advisories', asOf: advisories.asOf, countries: Object.keys(advisories.levels).length, unmatched: advisories.unmatched },
    sources,
  };

  const artifact = {
    format: 1,
    version: VERSION,
    builtAt: BUILT_AT,
    experiences: EXPERIENCES,
    kinds: KINDS,
    worldRegions: WORLD_REGIONS,
    n: N,
    ids,
    names,
    contexts,
    resolveAs,
    qids,
    wv,
    countries: countriesCol,
    lat,
    lng,
    radiusKm: radius,
    parent: b64(parent),
    aliases,
    members,
    pitch,
    highlights,
    bases,
    exp: b64(exp),
    nights: b64(nights),
    ...Object.fromEntries(Object.entries(cols).map(([key, value]) => [key, b64(value)])),
    clim: b64(clim),
    coastKm: b64(coast),
    landmass: b64(landmass),
    roomUsd: b64(roomUsd),
    priceYears,
    high: { rows: b64(Int32Array.from(highRows)), data: b64(Int16Array.from(highData)) },
    sea: { rows: b64(Int32Array.from(seaRows)), data: b64(Int16Array.from(seaData)) },
    airportTable,
    airportRef: b64(airportRef),
    airportKm: b64(airportKm),
    terms: { vocab: [...vocab.keys()], offsets: b64(offsets), ids: b64(Uint32Array.from(termIds)), weights: b64(Uint8Array.from(termWeights)) },
    advisories: { source: 'U.S. Department of State', asOf: advisories.asOf, levels: advisories.levels, ...(advisoryData ? { fetchedAt: advisoriesV2.fetchedAt, countries: advisoryData.countries, rows: advisoryRows } : {}) },
    curated: curatedEnrichment,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  /*
   * The embedding matrix is row-aligned with the candidates. It ships only when
   * it was built from exactly these rows; a stale matrix would attach one
   * place's meaning to another, so a mismatch drops it (the atlas works
   * without — lexical retrieval alone) and says so.
   */
  const rowsDigest = createHash('sha256').update(candidates.map((candidate) => candidate.id).join('\n')).digest('hex').slice(0, 16);
  artifact.rowsDigest = rowsDigest;
  let embeddings = { shipped: false, reason: 'not built (run 07-embeddings.py)' };
  const embeddingFile = join(WORK, 'embeddings.json');
  if (existsSync(embeddingFile)) {
    const raw = readFileSync(embeddingFile, 'utf8');
    const digest = /"rowsDigest":\s*"([0-9a-f]+)"/.exec(raw.slice(0, 2000))?.[1] ?? JSON.parse(raw).rowsDigest;
    if (digest === rowsDigest) {
      const zippedEmbeddings = gzipSync(raw, { level: 9 });
      writeFileSync(join(OUT_DIR, 'embeddings.json.gz'), zippedEmbeddings);
      embeddings = { shipped: true, model: 'minishlab/potion-base-8M (MIT)', dim: Number(/"dim":\s*(\d+)/.exec(raw.slice(0, 2000))?.[1] ?? 0), gzipBytes: zippedEmbeddings.length };
    } else {
      embeddings = { shipped: false, reason: `built for other rows (${digest} ≠ ${rowsDigest}); rerun 07-embeddings.py` };
    }
  }
  manifest.embeddings = embeddings;
  const json = JSON.stringify(artifact);
  const zipped = gzipSync(json, { level: 9 });
  writeFileSync(join(OUT_DIR, 'atlas.json.gz'), zipped);
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify({ ...manifest, bytes: { json: json.length, gzip: zipped.length } }, null, 1)}\n`);
  console.log(`${N} rows → ${join(OUT_DIR, 'atlas.json.gz')} (${(zipped.length / 1e6).toFixed(1)} MB gzip, ${(json.length / 1e6).toFixed(1)} MB json) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log('experience agreement (held-out r):', agreement.map((row) => `${row.experience} ${row.heldOut.correlation}`).join(' · '));
  console.log('embeddings:', JSON.stringify(embeddings));
  const meanOf = (list) => (list.length === 0 ? null : Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 1000) / 1000);
  console.log(`geometry: ${refiled} rows re-filed, ${stats.suspectLocation ?? 0} suspect locations, ${landmassIndex.size - 1} landmasses in use, ${Object.keys(members).length} rows with explicit members`);
  console.log(`advisories: ${Object.keys(advisoryRows).length} rows under a matched area warning`);
  console.log(`cost: fits ${costFits.map((fit) => `${fit.shape.join('+')} n=${fit.n}`).join(' · ')}; slope ${costSlope.toFixed(2)}; leave-one-out MAE vs curated on ${heldOut.length} twins: country ${meanOf(heldOutCountry)} → with listings ${meanOf(heldOut)}`);
  console.log('MAE vs curated:', manifest.estimators.meanAbsoluteErrorAgainstCurated);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
