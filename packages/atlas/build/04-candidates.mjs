#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * STAGE 04 — FROM PAGES AND ITEMS TO DESTINATION CANDIDATES.
 *
 *   node packages/atlas/build/04-candidates.mjs
 *
 * Merges the three identity sources into one list of candidate destinations
 * and attaches everything that can be known about each without a raster:
 *
 *  - **Who it is**: a stable id (`wv:<Wikivoyage title>` or `wd:<QID>`), its
 *    Wikidata item, its names and aliases, its country, its place in the travel
 *    hierarchy (Wikivoyage's `IsPartOf` chain — a hierarchy drawn by travellers,
 *    not by administrations), a centre and an extent.
 *  - **Whether it is a destination**: the page's status, how much is written,
 *    how many things to see, do and sleep are listed (its own and its
 *    districts'), whether the country or region page lists it among its nine
 *    cities or nine "other destinations". A geographic entity is not a holiday;
 *    these are the signals that it has been one for somebody.
 *  - **What it offers, as evidence**: per experience, weighted keyword hits in
 *    the guide (never the "Go next" section, which is about other places) and
 *    the notable Wikidata features inside its extent. Evidence, not scores —
 *    stage 06 turns evidence into scores by fitting against editorial labels.
 *  - **How to reach it**: the nearest airports with scheduled service.
 *  - **Its index terms** for lexical retrieval.
 *
 * It also emits `points.ndjson`, the list of centres stage 05 samples climate,
 * terrain and sea temperature for — every candidate and every curated entry.
 *
 * Pure function of the files in `.atlas-cache/work` and `raw`; no network.
 */
import { createReadStream, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { EXPERIENCES, EXPERIENCE_PATTERNS, PRACTICAL_PATTERNS, tokens } from './lib/vocabulary.mjs';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const WORK = join(CACHE, 'work');
const RAW = join(CACHE, 'raw');

const DEST_TYPES = new Set(['city', 'region', 'park', 'ruralarea', 'country', 'extraregion', 'itinerary']);
const SCOPE_TYPES = new Set(['continent', 'continentalsection']);

const rad = (deg) => (deg * Math.PI) / 180;
export function km(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function ndjson(file, each) {
  const lines = createInterface({ input: createReadStream(file) });
  for await (const line of lines) if (line) each(JSON.parse(line));
}

/** A one-degree grid over points, for "everything within r km". */
class Grid {
  constructor() {
    this.cells = new Map();
  }
  add(lat, lng, value) {
    const key = `${Math.floor(lat)}:${Math.floor(lng)}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = []));
    cell.push({ lat, lng, value });
  }
  near(lat, lng, radiusKm, each) {
    const dLat = Math.min(90, radiusKm / 111 + 0.01);
    const cos = Math.max(0.05, Math.cos(rad(lat)));
    const dLng = Math.min(180, radiusKm / (111 * cos) + 0.01);
    for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la += 1) {
      for (let lo = Math.floor(lng - dLng); lo <= Math.floor(lng + dLng); lo += 1) {
        const wrapped = ((((lo + 180) % 360) + 360) % 360) - 180;
        const cell = this.cells.get(`${la}:${wrapped}`);
        if (!cell) continue;
        for (const point of cell) {
          const d = km(lat, lng, point.lat, point.lng);
          if (d <= radiusKm) each(point.value, d);
        }
      }
    }
  }
}

function csvRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const saturate = (x, k) => 1 - Math.exp(-x / k);

/** Section weights for keyword evidence: what a guide says to do counts more than what it mentions in passing. */
const SECTION_WEIGHT = { lead: 2, understand: 1, see: 1.5, do: 2, body: 1 };

function textEvidence(page) {
  const parts = [];
  for (const [section, weight] of Object.entries(SECTION_WEIGHT)) {
    const text = section === 'lead' ? page.lead : page.sections?.[section];
    if (text) parts.push([text.toLowerCase(), weight]);
  }
  const eat = (page.sections?.eat ?? '').toLowerCase();
  const drink = (page.sections?.drink ?? '').toLowerCase();
  const hits = {};
  for (const experience of EXPERIENCES) {
    const pattern = EXPERIENCE_PATTERNS[experience];
    let total = 0;
    for (const [text, weight] of parts) total += weight * (text.match(pattern)?.length ?? 0);
    if (experience === 'food' && eat) total += 0.5 * (eat.match(pattern)?.length ?? 0);
    if (experience === 'city_life' && drink) total += 0.5 * (drink.match(pattern)?.length ?? 0);
    if (total > 0) hits[experience] = Math.round(total * 10) / 10;
  }
  const practical = {};
  const around = `${page.sections?.getaround ?? ''} ${page.sections?.getin ?? ''} ${page.sections?.understand ?? ''} ${page.sections?.sleep ?? ''} ${page.sections?.do ?? ''}`.toLowerCase();
  for (const [key, pattern] of Object.entries(PRACTICAL_PATTERNS)) {
    const count = around.match(pattern)?.length ?? 0;
    if (count > 0) practical[key] = count;
  }
  return { hits, practical };
}

/** Which feature kinds are evidence for which experience, and how strongly. */
const FEATURE_EVIDENCE = {
  day_hiking: { trail: 1, park: 0.6, peak: 0.4, waterfall: 0.5, canyon: 0.5 },
  multi_day_trekking: { trail: 1, range: 0.5, park: 0.3 },
  high_mountains: { range: 0.8, peak: 0.7, glacier: 0.6, pass: 0.5 },
  glaciers_ice: { glacier: 1, fjord: 0.3 },
  volcanoes_geothermal: { volcano: 1, spring: 0.3 },
  lakes: { lake: 1 },
  beaches_swimming: { beach: 1 },
  coastal_scenery: { beach: 0.4, fjord: 0.8, landform: 0.5, island: 0.4, islands: 0.5 },
  snorkel_dive: { reef: 1 },
  paddling_boating: { lake: 0.4, fjord: 0.5, reef: 0.2 },
  big_game_safari: { wildlife: 1 },
  wildlife_general: { park: 0.7, wildlife: 1 },
  marine_wildlife: { reef: 0.6 },
  birding: { park: 0.3, wildlife: 0.5 },
  rainforest_biodiversity: { park: 0.3 },
  desert_landscapes: { desert: 1, canyon: 0.6 },
  scenic_driving: { drive: 1, pass: 0.5 },
  rail_journeys: { rail: 1 },
  winter_snow: { ski: 1 },
  hot_springs_wellness: { spring: 1 },
  villages_culture: { heritage: 1, whs_cultural: 1.5, museum: 0.3 },
  food: { wine: 1 },
  city_life: { museum: 1 },
  night_skies: { darksky: 1 },
};

/** What a Wikidata feature class becomes when it is a destination itself. */
const FEATURE_DESTINATION = {
  park: { kind: 'protected_area', minLinks: 8, radiusKm: 25 },
  range: { kind: 'mountain_range', minLinks: 9, radiusKm: 70 },
  islands: { kind: 'island_group', minLinks: 8, radiusKm: 60 },
  island: { kind: 'island', minLinks: 14, radiusKm: 20 },
  ski: { kind: 'ski_area', minLinks: 5, radiusKm: 10 },
  lake: { kind: 'lake_district', minLinks: 22, radiusKm: 25 },
  desert: { kind: 'desert', minLinks: 12, radiusKm: 120 },
  canyon: { kind: 'travel_region', minLinks: 10, radiusKm: 20 },
  valley: { kind: 'travel_region', minLinks: 12, radiusKm: 30 },
  fjord: { kind: 'coast', minLinks: 10, radiusKm: 30 },
  volcano: { kind: 'travel_region', minLinks: 20, radiusKm: 20 },
  wildlife: { kind: 'protected_area', minLinks: 5, radiusKm: 30 },
};

function cleanName(title) {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function normal(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function main() {
  const started = Date.now();
  /* ── Load ─────────────────────────────────────────────────────────────── */
  const curated = JSON.parse(readFileSync(join(WORK, 'curated.json'), 'utf8'));
  const redirects = new Map();
  const aliasesByTarget = new Map();
  await ndjson(join(WORK, 'wikivoyage-redirects.ndjson'), (row) => {
    redirects.set(row.from, row.to);
    if (!row.anchor) {
      const list = aliasesByTarget.get(row.to) ?? [];
      if (list.length < 8) list.push(row.from);
      aliasesByTarget.set(row.to, list);
    }
  });
  const resolveTitle = (title) => {
    let current = title;
    for (let hop = 0; hop < 4 && redirects.has(current); hop += 1) current = redirects.get(current);
    return current;
  };

  const entities = new Map();
  await ndjson(join(WORK, 'entities.ndjson'), (row) => entities.set(row.qid, row));

  const nationalParks = new Set();
  for (const file of readdirSync(join(WORK, 'features'))) {
    if (!file.startsWith('park-Q46169')) continue;
    for (const row of JSON.parse(readFileSync(join(WORK, 'features', file), 'utf8')).rows) nationalParks.add(row.qid);
  }
  const features = [];
  const featureGrid = new Grid();
  const featureByQid = new Map();
  await ndjson(join(WORK, 'features.ndjson'), (row) => {
    features.push(row);
    featureByQid.set(row.qid, row);
    featureGrid.add(row.lat, row.lng, row);
  });

  /* Airports with scheduled service and an IATA code: where a traveller can actually land. */
  const airportGrid = new Grid();
  const airports = [];
  {
    const rows = csvRows(readFileSync(join(RAW, 'ourairports', 'airports.csv'), 'utf8'));
    const head = rows[0];
    const col = (name) => head.indexOf(name);
    for (const row of rows.slice(1)) {
      const type = row[col('type')];
      if (type !== 'large_airport' && type !== 'medium_airport') continue;
      if (row[col('scheduled_service')] !== 'yes' || !row[col('iata_code')]) continue;
      const airport = { iata: row[col('iata_code')], name: row[col('name')], lat: Number(row[col('latitude_deg')]), lng: Number(row[col('longitude_deg')]), size: type === 'large_airport' ? 'large' : 'medium', iso: row[col('iso_country')] };
      if (!Number.isFinite(airport.lat) || !Number.isFinite(airport.lng)) continue;
      airports.push(airport);
      airportGrid.add(airport.lat, airport.lng, airport);
    }
  }
  const nearestAirports = (lat, lng) => {
    for (const radius of [150, 400, 1200, 3000]) {
      const found = [];
      airportGrid.near(lat, lng, radius, (airport, d) => found.push({ iata: airport.iata, name: airport.name, km: Math.round(d), size: airport.size }));
      if (found.length === 0) continue;
      found.sort((a, b) => a.km - b.km);
      const out = found.slice(0, 2);
      const hub = found.find((airport) => airport.size === 'large');
      if (hub && !out.includes(hub)) out.push(hub);
      if (hub || radius >= 1200) return out.slice(0, 3);
    }
    return [];
  };

  /* ── Wikivoyage pages ─────────────────────────────────────────────────── */
  const pages = new Map();
  const documentFrequency = new Map();
  let documents = 0;
  await ndjson(join(WORK, 'wikivoyage.ndjson'), (page) => {
    if (!DEST_TYPES.has(page.type) && !SCOPE_TYPES.has(page.type) && page.type !== 'district' && page.type !== 'diveguide') return;
    const { hits, practical } = textEvidence(page);
    const text = `${page.lead ?? ''} ${page.sections?.understand ?? ''} ${page.sections?.see ?? ''} ${page.sections?.do ?? ''} ${page.sections?.body ?? ''}`;
    const counts = new Map();
    for (const term of tokens(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 160);
    if (DEST_TYPES.has(page.type)) {
      documents += 1;
      for (const [term] of top) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    pages.set(page.title, {
      title: page.title,
      qid: page.qid,
      type: page.type,
      status: page.status,
      parent: page.parent ? resolveTitle(page.parent) : null,
      geo: page.geo,
      bytes: page.bytes,
      firstSentence: page.firstSentence,
      listings: page.listings,
      top: page.top,
      listed: page.listed,
      regionItems: page.regionItems ?? [],
      hits,
      practical,
      termCounts: top,
      words: text.length / 6,
      hasSleep: Boolean(page.sections?.sleep) || page.listings.sleep > 0,
    });
  });
  console.log(`${pages.size} pages, ${entities.size} entities, ${features.length} features, ${airports.length} airports (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  /* Children, by the travel hierarchy. */
  const children = new Map();
  for (const page of pages.values()) {
    if (!page.parent) continue;
    const list = children.get(page.parent) ?? [];
    list.push(page.title);
    children.set(page.parent, list);
  }

  /* Where each page is: its own {{geo}}, else its Wikidata coordinate. */
  const pointOf = (page) => {
    if (page.geo) return { lat: page.geo.lat, lng: page.geo.lng, zoom: page.geo.zoom ?? null };
    const entity = page.qid ? entities.get(page.qid) : null;
    return entity && entity.lat !== null ? { lat: entity.lat, lng: entity.lng, zoom: null } : null;
  };

  /* The chain of ancestors and the country, by walking IsPartOf. */
  const ancestry = (page) => {
    const chain = [];
    let current = page.parent;
    for (let hop = 0; hop < 12 && current; hop += 1) {
      const parent = pages.get(current);
      if (!parent || chain.includes(current)) break;
      chain.push(current);
      current = parent.parent;
    }
    return chain;
  };
  const isoOfPage = (page) => (page.qid ? entities.get(page.qid)?.iso ?? null : null);
  const countryOf = (page, chain) => {
    if (page.type === 'country') return { title: page.title, iso: isoOfPage(page) };
    for (const title of chain) {
      const parent = pages.get(title);
      if (parent?.type === 'country') return { title, iso: isoOfPage(parent) };
    }
    return null;
  };

  /* Prominence: the most senior page that lists this one among its cities or other destinations. */
  const prominence = new Map();
  const note = (title, level) => {
    const resolved = resolveTitle(title);
    if ((prominence.get(resolved) ?? 0) < level) prominence.set(resolved, level);
  };
  for (const page of pages.values()) {
    const level = page.type === 'continent' || page.type === 'continentalsection' ? 1 : page.type === 'country' ? 0.9 : page.type === 'region' || page.type === 'extraregion' ? (pages.get(page.parent ?? '')?.type === 'country' ? 0.65 : 0.45) : 0;
    if (level === 0) continue;
    for (const title of [...(page.listed?.cities ?? []), ...(page.listed?.other ?? [])]) note(title, level);
    for (const title of page.listed?.regions ?? []) note(title, level * 0.8);
  }

  /* ── Candidates from Wikivoyage ───────────────────────────────────────── */
  const candidates = [];
  const byQid = new Map();
  const cityGrid = new Grid();
  for (const page of pages.values()) {
    if (page.type !== 'city') continue;
    const point = pointOf(page);
    if (point) cityGrid.add(point.lat, point.lng, page);
  }

  for (const page of pages.values()) {
    if (!DEST_TYPES.has(page.type) && !SCOPE_TYPES.has(page.type)) continue;
    const point = pointOf(page);
    const kids = (children.get(page.title) ?? []).map((title) => pages.get(title)).filter(Boolean);
    const kidPoints = kids.map((kid) => pointOf(kid)).filter(Boolean);
    let centre = point;
    if (!centre && kidPoints.length > 0) {
      centre = { lat: kidPoints.reduce((sum, p) => sum + p.lat, 0) / kidPoints.length, lng: kidPoints.reduce((sum, p) => sum + p.lng, 0) / kidPoints.length, zoom: null };
    }
    if (!centre) continue;
    const entity = page.qid ? entities.get(page.qid) ?? null : null;
    const chain = ancestry(page);
    const country = countryOf(page, chain);
    const countries = country?.iso ? [country.iso] : (entity?.countries ?? []).slice(0, 4);
    if (page.type === 'country' && entity?.iso) countries.splice(0, countries.length, entity.iso);

    /* Extent: Wikidata's area where it has one, the spread of the children, the map zoom the editors chose, a default by type. */
    const cos = Math.max(0.1, Math.cos(rad(centre.lat)));
    const byZoom = centre.zoom ? (20000 * cos) / 2 ** centre.zoom : null;
    const byArea = entity?.areaKm2 ? Math.sqrt(entity.areaKm2 / Math.PI) * 1.25 : null;
    const spread = kidPoints.map((p) => km(centre.lat, centre.lng, p.lat, p.lng)).sort((a, b) => a - b);
    const byChildren = spread.length >= 3 ? spread[Math.floor(spread.length * 0.85)] * 1.1 : null;
    const population = entity?.population ?? null;
    const defaults = { city: population ? Math.min(35, Math.max(4, 3 + Math.sqrt(population) / 150)) : 6, region: 60, park: 22, ruralarea: 18, country: 250, extraregion: 120, itinerary: 60, continent: 2500, continentalsection: 1200 };
    const limits = { city: [3, 45], region: [8, 900], park: [4, 250], ruralarea: [4, 120], country: [10, 1800], extraregion: [8, 1500], itinerary: [10, 800], continent: [1500, 5000], continentalsection: [300, 3000] };
    let radiusKm = page.type === 'city' ? defaults.city : byArea ?? (byChildren && byZoom ? Math.max(byChildren, Math.min(byZoom, byChildren * 2.5)) : byChildren ?? byZoom ?? defaults[page.type]);
    radiusKm = Math.min(limits[page.type][1], Math.max(limits[page.type][0], radiusKm));

    /* Listings: its own, plus its districts' (a huge city keeps its sights on district pages). */
    const listings = { ...page.listings };
    const districtTitles = kids.filter((kid) => kid.type === 'district');
    for (const district of districtTitles) for (const key of Object.keys(listings)) listings[key] += district.listings[key] ?? 0;
    const hits = { ...page.hits };
    for (const district of districtTitles) for (const [experience, value] of Object.entries(district.hits)) hits[experience] = (hits[experience] ?? 0) + 0.5 * value;

    candidates.push({
      id: `wv:${page.title}`,
      source: 'wikivoyage',
      title: page.title,
      name: cleanName(page.title),
      qid: page.qid ?? null,
      wvType: page.type,
      status: page.status,
      scopeOnly: SCOPE_TYPES.has(page.type),
      lat: Math.round(centre.lat * 1e4) / 1e4,
      lng: Math.round(centre.lng * 1e4) / 1e4,
      radiusKm: Math.round(radiusKm * 10) / 10,
      parents: chain.map((title) => `wv:${title}`),
      countryTitle: country?.title ?? null,
      countries,
      population,
      sitelinks: entity?.sl ?? 0,
      wdTypes: entity?.types ?? [],
      /* The item's own ISO 3166-1 code: set for a sovereign country, absent for a dependency that merely belongs to one. */
      ownIso: entity?.iso ?? null,
      wdElevM: entity?.elevM ?? null,
      wdAreaKm2: entity?.areaKm2 ?? null,
      description: entity?.description ?? null,
      aliases: [...new Set([...(entity?.aliases ?? []), ...(aliasesByTarget.get(page.title) ?? [])])].filter((alias) => normal(alias) !== normal(page.title)).slice(0, 10),
      bytes: page.bytes,
      listings,
      districts: districtTitles.length,
      childCount: kids.filter((kid) => kid.type !== 'district').length,
      prominence: prominence.get(page.title) ?? 0,
      firstSentence: page.firstSentence ?? '',
      topSee: (page.top?.see ?? []).map((entry) => entry.name).filter(Boolean).slice(0, 8),
      topDo: (page.top?.do ?? []).map((entry) => entry.name).filter(Boolean).slice(0, 6),
      listed: { cities: (page.listed?.cities ?? []).map(resolveTitle).slice(0, 12), other: (page.listed?.other ?? []).map(resolveTitle).slice(0, 12), regions: (page.listed?.regions ?? []).map(resolveTitle).slice(0, 16) },
      hits,
      practical: page.practical,
      words: Math.round(page.words),
      hasSleep: page.hasSleep,
      termCounts: page.termCounts,
    });
    if (page.qid) byQid.set(page.qid, candidates[candidates.length - 1]);
  }
  /*
   * Extra-hierarchical regions — the Alps, Patagonia, the Himalayas — are the
   * names travellers actually use, and nothing "is part of" them: Wikivoyage
   * files every town under an administrative parent instead. What such a page
   * does have is a list of the regions it spans. Those become its members, and
   * its extent is the ground they cover — not a circle guessed from a map zoom.
   */
  {
    const held = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const dropped = new Set();
    for (const candidate of candidates) {
      if (candidate.wvType !== 'extraregion') continue;
      const page = pages.get(candidate.title);
      const titles = [...new Set((page.listed?.regions ?? []).map(resolveTitle))];
      const members = titles.map((title) => held.get(`wv:${title}`)).filter((member) => member && member.id !== candidate.id && !member.scopeOnly && member.wvType !== 'country' && member.wvType !== 'city');
      const countriesListed = titles.map((title) => held.get(`wv:${title}`)).filter((member) => member && member.wvType === 'country');
      if (members.length >= 2 && countriesListed.length <= members.length) {
        candidate.members = members.map((member) => member.id);
        const lat = members.reduce((sum, member) => sum + member.lat, 0) / members.length;
        const lng = members.reduce((sum, member) => sum + member.lng, 0) / members.length;
        if (!page.geo) {
          candidate.lat = Math.round(lat * 1e4) / 1e4;
          candidate.lng = Math.round(lng * 1e4) / 1e4;
        }
        const reach = Math.max(...members.map((member) => km(candidate.lat, candidate.lng, member.lat, member.lng) + 0.6 * member.radiusKm));
        candidate.radiusKm = Math.round(Math.min(1500, Math.max(candidate.radiusKm, reach)) * 10) / 10;
        if (candidate.countries.length === 0) candidate.countries = [...new Set(members.flatMap((member) => member.countries))].slice(0, 4);
      } else if (!page.geo || page.geo.source === 'mapframe') {
        /* No coordinate of its own and no members: an index page, not a place. */
        dropped.add(candidate.id);
      }
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (!dropped.has(candidates[index].id)) continue;
      if (candidates[index].qid) byQid.delete(candidates[index].qid);
      candidates.splice(index, 1);
    }
  }
  const wvCount = candidates.length;

  /* ── Candidates from Wikidata alone: places nobody has written a guide to ─ */
  const wvGrid = new Grid();
  for (const candidate of candidates) wvGrid.add(candidate.lat, candidate.lng, candidate);
  const regionGrid = new Grid();
  for (const candidate of candidates) if (['region', 'country', 'ruralarea', 'extraregion'].includes(candidate.wvType)) regionGrid.add(candidate.lat, candidate.lng, candidate);
  let dataOnly = 0;
  for (const feature of features) {
    if (byQid.has(feature.qid)) continue;
    let rule = null;
    for (const kind of feature.kinds) {
      const candidateRule = FEATURE_DESTINATION[kind];
      if (!candidateRule) continue;
      const floor = kind === 'park' && nationalParks.has(feature.qid) ? 2 : candidateRule.minLinks;
      if (feature.sl >= floor && (!rule || candidateRule.radiusKm > rule.radiusKm)) rule = { ...candidateRule, feature: kind };
    }
    if (!rule) continue;
    /* A marine sanctuary is water: evidence that the sea is worth seeing, not a place to base a trip. */
    if (rule.feature === 'park' && feature.kinds.includes('reef')) continue;
    /* A range's reach, when Wikidata gives no area: the better known, the bigger — the Karakoram is not seventy kilometres across. */
    const byNotability = rule.feature === 'range' ? Math.min(330, Math.max(rule.radiusKm, 30 + 2.3 * feature.sl)) : rule.radiusKm;
    const radiusKm = Math.min(rule.feature === 'range' || rule.feature === 'desert' ? 600 : 160, Math.max(4, feature.areaKm2 ? Math.sqrt(feature.areaKm2 / Math.PI) * 1.25 : byNotability));
    /* The same place under another id: a guide page with this name within its extent. */
    let twin = false;
    const mine = normal(feature.name);
    wvGrid.near(feature.lat, feature.lng, Math.max(30, radiusKm), (other, d) => {
      const theirs = normal(other.name);
      /* The same name is the same place. A longer name that contains it is the same place only when it sits on top of it — "Karakoram Highway" is not the Karakoram. */
      if (theirs === mine) twin = true;
      else if (d <= 20 && other.wvType !== 'itinerary' && Math.min(theirs.length, mine.length) >= 6 && (theirs.includes(mine) || mine.includes(theirs))) twin = true;
    });
    if (twin) continue;
    /* Its place in the hierarchy: the smallest guide region whose extent covers it, in the same country. */
    let parent = null;
    regionGrid.near(feature.lat, feature.lng, 400, (region, d) => {
      if (d > region.radiusKm * 1.1) return;
      if (feature.countries.length > 0 && region.countries.length > 0 && !region.countries.some((iso) => feature.countries.includes(iso))) return;
      if (!parent || region.radiusKm < parent.radiusKm) parent = region;
    });
    const kind = rule.feature === 'park' && nationalParks.has(feature.qid) ? 'national_park' : rule.kind;
    candidates.push({
      id: `wd:${feature.qid}`,
      source: 'wikidata',
      title: null,
      name: feature.name,
      qid: feature.qid,
      wvType: null,
      featureKind: kind,
      status: null,
      scopeOnly: false,
      lat: feature.lat,
      lng: feature.lng,
      radiusKm: Math.round(radiusKm * 10) / 10,
      parents: parent ? [parent.id, ...parent.parents] : [],
      countryTitle: parent?.countryTitle ?? null,
      countries: feature.countries.slice(0, 4),
      population: null,
      sitelinks: feature.sl,
      wdTypes: [],
      wdElevM: feature.elevM,
      wdAreaKm2: feature.areaKm2,
      description: null,
      aliases: [],
      bytes: 0,
      listings: { see: 0, do: 0, eat: 0, drink: 0, sleep: 0, buy: 0, go: 0, other: 0 },
      districts: 0,
      childCount: 0,
      prominence: 0,
      firstSentence: '',
      topSee: [],
      topDo: [],
      listed: { cities: [], other: [], regions: [] },
      hits: {},
      practical: {},
      words: 0,
      hasSleep: false,
      termCounts: tokens(feature.name).map((term) => [term, 3]),
      whs: feature.whs ?? null,
    });
    dataOnly += 1;
  }
  console.log(`${wvCount} guide candidates + ${dataOnly} data-only candidates`);

  /* ── Evidence from features inside each extent ────────────────────────── */
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of candidates) {
    /* A place nobody has written up is credited only with what lies close to it: a wide circle would hand it a whole country's sights. */
    const reach = Math.min(candidate.scopeOnly ? 0 : Math.max(candidate.radiusKm, candidate.wvType === 'city' ? 25 : 12), candidate.source === 'wikidata' ? 80 : 400);
    const kinds = {};
    const names = [];
    let highestPeak = null;
    if (reach > 0) {
      featureGrid.near(candidate.lat, candidate.lng, reach, (feature, d) => {
        if (feature.qid === candidate.qid) return;
        const weight = Math.log2(1 + feature.sl) / 4;
        const whs = feature.whs === 'natural' ? ['whs_natural'] : feature.whs === 'cultural' ? ['whs_cultural'] : feature.whs ? ['whs_natural', 'whs_cultural'] : [];
        for (const kind of [...feature.kinds, ...whs]) {
          const slot = (kinds[kind] ??= { n: 0, w: 0 });
          slot.n += 1;
          slot.w += weight;
        }
        if (feature.kinds.includes('peak') && feature.elevM && (!highestPeak || feature.elevM > highestPeak)) highestPeak = feature.elevM;
        names.push({ name: feature.name, sl: feature.sl, kinds: feature.kinds, d });
      });
    }
    /* The feature's own classes count for itself (a national park is evidence of a national park). */
    const self = candidate.qid ? featureByQid.get(candidate.qid) : null;
    if (self) for (const kind of self.kinds) (kinds[kind] ??= { n: 0, w: 0 }).w += 1.5;
    for (const slot of Object.values(kinds)) slot.w = Math.round(slot.w * 100) / 100;
    candidate.featureKinds = kinds;
    candidate.selfKinds = self?.kinds ?? [];
    candidate.whs = candidate.whs ?? self?.whs ?? null;
    candidate.highestPeakM = highestPeak;
    candidate.nearFeatures = names
      .filter((entry) => entry.name && !/^Q\d+$/.test(entry.name))
      .sort((a, b) => b.sl - a.sl)
      .slice(0, 6)
      .map((entry) => entry.name);
    const featureSignal = {};
    for (const experience of EXPERIENCES) {
      let total = 0;
      for (const [kind, weight] of Object.entries(FEATURE_EVIDENCE[experience] ?? {})) total += weight * (kinds[kind]?.w ?? 0);
      if (total > 0) featureSignal[experience] = Math.round(total * 100) / 100;
    }
    candidate.featureSignal = featureSignal;
    candidate.airports = nearestAirports(candidate.lat, candidate.lng);
  }

  /* ── Roll evidence up the hierarchy ───────────────────────────────────── */
  /* A region page often says little itself and lists the places that say it; what its strongest children offer, it offers. */
  const kidsOf = new Map();
  for (const candidate of candidates) {
    const parent = candidate.parents[0];
    if (!parent) continue;
    const list = kidsOf.get(parent) ?? [];
    list.push(candidate);
    kidsOf.set(parent, list);
  }
  const depth = (candidate) => candidate.parents.length;
  const bottomUp = [...candidates].sort((a, b) => depth(b) - depth(a));
  for (const candidate of bottomUp) {
    const kids = kidsOf.get(candidate.id) ?? [];
    const rolled = {};
    const sub = { see: 0, do: 0, sleep: 0, eat: 0 };
    let descendants = 0;
    for (const kid of kids) {
      descendants += 1 + (kid.descendants ?? 0);
      for (const key of Object.keys(sub)) sub[key] += (kid.listings[key] ?? 0) + (kid.subListings?.[key] ?? 0);
    }
    for (const experience of EXPERIENCES) {
      const values = kids.map((kid) => Math.max(saturate(kid.hits[experience] ?? 0, 6), kid.rolled?.[experience] ?? 0)).sort((a, b) => b - a);
      if (values.length === 0 || values[0] === 0) continue;
      const top = values.slice(0, 3);
      rolled[experience] = Math.round(0.9 * (top.reduce((sum, value) => sum + value, 0) / Math.max(2, top.length)) * 1000) / 1000;
    }
    candidate.rolled = rolled;
    candidate.subListings = sub;
    candidate.descendants = descendants;
  }

  /* ── Places to sleep ──────────────────────────────────────────────────── */
  for (const candidate of candidates) {
    if (candidate.wvType === 'city') {
      candidate.bases = [candidate.name];
      continue;
    }
    const listedCities = candidate.listed.cities.map((title) => byId.get(`wv:${title}`)).filter(Boolean);
    const scored = (list) => [...list].sort((a, b) => b.prominence + Math.min(1, b.listings.sleep / 10) + (b.status === 'guide' || b.status === 'star' ? 0.3 : 0) - (a.prominence + Math.min(1, a.listings.sleep / 10) + (a.status === 'guide' || a.status === 'star' ? 0.3 : 0)));
    let bases = [...new Set(scored(listedCities).filter((city) => city.id !== candidate.id && city.wvType === 'city').map((city) => city.name))].slice(0, 4);
    if (bases.length < 2) {
      const near = [];
      cityGrid.near(candidate.lat, candidate.lng, Math.min(250, Math.max(40, candidate.radiusKm * 1.4)), (page, d) => {
        const city = byId.get(`wv:${page.title}`);
        if (city && city.hasSleep) near.push({ city, d });
      });
      near.sort((a, b) => a.d / Math.max(20, candidate.radiusKm) - Math.min(1, a.city.listings.sleep / 8) - (b.d / Math.max(20, candidate.radiusKm) - Math.min(1, b.city.listings.sleep / 8)));
      for (const { city } of near) if (bases.length < 3 && !bases.includes(city.name) && city.id !== candidate.id) bases.push(city.name);
    }
    candidate.bases = bases;
    /*
     * Where people actually sleep. A region's centre is a point on a map — the
     * Big Island's is a 2,400 m saddle, Hawaii's is open sea — and the climate
     * there is not the climate of the trip. The first base that is a known
     * town gives the point stage 05 samples for "conditions where you stay".
     */
    const reach = Math.max(60, candidate.radiusKm * 1.6);
    for (const name of bases) {
      let best = null;
      cityGrid.near(candidate.lat, candidate.lng, Math.min(900, reach), (page, d) => {
        if (cleanName(page.title) !== name) return;
        const point = pointOf(page);
        if (point && (!best || d < best.d)) best = { lat: point.lat, lng: point.lng, d };
      });
      if (best) {
        candidate.basePoint = { lat: Math.round(best.lat * 1e4) / 1e4, lng: Math.round(best.lng * 1e4) / 1e4, name };
        break;
      }
    }
  }

  /* ── Curated twins ────────────────────────────────────────────────────── */
  let twins = 0;
  for (const entry of curated.entries) {
    let twin = entry.wikidataId ? byQid.get(entry.wikidataId) ?? byId.get(`wd:${entry.wikidataId}`) ?? null : null;
    if (!twin) {
      const mine = normal(entry.name);
      let best = null;
      wvGrid.near(entry.center.lat, entry.center.lng, Math.max(60, entry.radiusKm), (other, d) => {
        const theirs = normal(other.name);
        if (theirs !== mine && !(theirs.length >= 6 && mine.startsWith(theirs))) return;
        if (!best || d < best.d) best = { other, d };
      });
      twin = best?.other ?? null;
    }
    if (twin && !twin.curated) {
      twin.curated = entry.id;
      twins += 1;
    }
  }
  console.log(`${twins} of ${curated.entries.length} curated entries have an atlas twin`);

  /* ── Index terms ──────────────────────────────────────────────────────── */
  const vocabulary = new Map();
  for (const candidate of candidates) {
    /*
     * Two kinds of term. Rare words are mostly this place's own proper nouns
     * (useful for finding it by a sight's name). Words many guides share are
     * the concepts a traveller types ("monastery", "glacier", "apricot") — but
     * only when this guide keeps coming back to them: a word used once is
     * prose, a word used three times is a subject. Left to tf-idf alone the
     * names and the one-off oddities crowd the subjects out.
     */
    const rare = [];
    const shared = [];
    const length = 0.25 + 0.75 * (candidate.words / 900 || 1);
    for (const [term, tf] of candidate.termCounts) {
      const df = documentFrequency.get(term) ?? 0;
      if (candidate.source !== 'wikivoyage') {
        rare.push([term, 4]);
        continue;
      }
      if (df < 3) continue;
      const idf = Math.log(1 + (documents - df + 0.5) / (df + 0.5));
      const bm = (tf * 2.2) / (tf + 1.2 * length);
      if (df < 40) rare.push([term, bm * idf]);
      else if (df <= documents * 0.05 && tf >= 2) shared.push([term, bm * Math.sqrt(idf) * 1.6]);
    }
    rare.sort((a, b) => b[1] - a[1]);
    shared.sort((a, b) => b[1] - a[1]);
    candidate.terms = [...shared.slice(0, 20), ...rare.slice(0, 12)].map(([term, weight]) => [term, Math.round(weight * 100) / 100]);
    for (const [term] of candidate.terms) vocabulary.set(term, (vocabulary.get(term) ?? 0) + 1);
    delete candidate.termCounts;
  }

  /* ── Write ────────────────────────────────────────────────────────────── */
  const lines = candidates.map((candidate) => JSON.stringify(candidate));
  writeFileSync(join(WORK, 'candidates.ndjson'), `${lines.join('\n')}\n`);
  /* Curated entries name their bases too; the first one a guide page exists for gives their base point. */
  const curatedBasePoints = {};
  for (const entry of curated.entries) {
    for (const name of entry.bases) {
      let best = null;
      cityGrid.near(entry.center.lat, entry.center.lng, Math.min(900, Math.max(80, entry.radiusKm * 1.6)), (page, d) => {
        if (normal(cleanName(page.title)) !== normal(name)) return;
        const point = pointOf(page);
        if (point && (!best || d < best.d)) best = { lat: point.lat, lng: point.lng, d };
      });
      if (best) {
        curatedBasePoints[entry.id] = { lat: Math.round(best.lat * 1e4) / 1e4, lng: Math.round(best.lng * 1e4) / 1e4, name };
        break;
      }
    }
  }
  const points = [];
  for (const candidate of candidates) {
    if (candidate.scopeOnly) continue;
    points.push(JSON.stringify({ id: candidate.id, lat: candidate.lat, lng: candidate.lng, radiusKm: candidate.radiusKm }));
    if (candidate.basePoint) points.push(JSON.stringify({ id: `${candidate.id}#base`, lat: candidate.basePoint.lat, lng: candidate.basePoint.lng, radiusKm: 10 }));
  }
  for (const entry of curated.entries) {
    points.push(JSON.stringify({ id: `cur:${entry.id}`, lat: entry.center.lat, lng: entry.center.lng, radiusKm: entry.radiusKm }));
    const base = curatedBasePoints[entry.id];
    if (base) points.push(JSON.stringify({ id: `cur:${entry.id}#base`, lat: base.lat, lng: base.lng, radiusKm: 10 }));
  }
  writeFileSync(join(WORK, 'points.ndjson'), `${points.join('\n')}\n`);
  const curatedAirports = Object.fromEntries(curated.entries.map((entry) => [entry.id, nearestAirports(entry.center.lat, entry.center.lng)]));
  writeFileSync(join(WORK, 'curated-airports.json'), JSON.stringify(curatedAirports));
  const byType = {};
  for (const candidate of candidates) byType[candidate.wvType ?? `wikidata:${candidate.featureKind}`] = (byType[candidate.wvType ?? `wikidata:${candidate.featureKind}`] ?? 0) + 1;
  writeFileSync(join(WORK, 'candidates-stats.json'), JSON.stringify({ builtAt: new Date().toISOString(), candidates: candidates.length, guide: wvCount, dataOnly, curatedTwins: twins, vocabulary: vocabulary.size, documents, byType, points: points.length }, null, 1));
  console.log(`${candidates.length} candidates, ${points.length} points, vocabulary ${vocabulary.size} → ${WORK} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
