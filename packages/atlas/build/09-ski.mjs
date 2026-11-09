#!/usr/bin/env node
/* eslint-disable no-console -- a command-line tool: its progress and results are its output. */
/**
 * STAGE 09 — THE WORLD'S SKI AREAS, FROM OPENSKIDATA (OpenSkiMap.org).
 *
 *   node packages/atlas/build/09-ski.mjs              # download once (if absent), write ski.ndjson, report
 *   node packages/atlas/build/09-ski.mjs --download   # download and verify only
 *
 * Wikidata knows about 1,400 "ski resorts"; it does not know which of them
 * still run, how many lifts they have or how much vertical. OpenSkiData does:
 * it is rebuilt daily from OpenStreetMap's pistes and aerialways, clustered
 * into ski areas, with run length by difficulty, lift counts and the elevation
 * range already computed per area. This stage reads ONE file — the ski-area
 * layer — and writes a self-contained table.
 *
 * LICENCE — read before touching this stage. From https://openskidata.org/
 * ("License & attribution", read 2026-11-09):
 *
 *   "The data is free to use, including commercially. It is derived from
 *    OpenStreetMap and is therefore available under the Open Database License
 *    (ODbL): if you distribute a modified version of the data, you must share
 *    it alike."
 *
 * ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/, read 2026-11-09).
 * This table is an extract of a substantial part of the contents, so it IS a
 * Derivative Database: §4.4b "Extraction or Re-utilisation of the whole or a
 * Substantial part of the Contents into a new database is a Derivative Database
 * and must comply with Section 4.4", so it can be published only under the ODbL
 * (§4.4a), with the licence or its URI and the notices kept (§4.2), and with a
 * machine-readable copy or the method of making it offered to recipients (§4.6).
 * The atlas beside it stays outside the licence only while the two remain
 * separate: §4.5a "You are not required to license Collective Databases under
 * this License if You incorporate this Database or a Derivative Database in the
 * collection". A traveller-facing result is a Produced Work (§4.5b is not a
 * Derivative Database; §4.3 requires a notice when it is shown publicly).
 * So this stage's output is deliberately:
 *   - derived from OpenSkiData and NOTHING else (no Wikidata, no atlas field is
 *     merged into a row — the country code and the Wikidata id are OpenSkiData's
 *     own columns);
 *   - written to its own file, which must ship as its own ODbL-labelled file
 *     next to the atlas and be joined to destinations in memory, by distance.
 * The count of candidates near a ski area that this stage *prints* is a report,
 * not an output: it is never written into `ski.ndjson` or into the atlas here.
 * Writing values computed from this table into `atlas.json.gz` at build time is
 * NOT that separation; whoever wires it in must keep the join at run time or
 * accept the ODbL for the atlas.
 *
 * Attribution required wherever the data is shown (OpenSkiData's own wording):
 *   "Data from OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors
 *    (ODbL), Skimap.org, Who's On First, © Mapterhorn"
 *
 * TERMS OF USE (same page): "Automated downloading is permitted at most once
 * per day. Direct use of the vector tiles at tiles.openskimap.org is not
 * permitted." This stage downloads two files, once, and refuses to download
 * again while its copy is under a day old. "The formats are not stable" — so
 * every field it reads is checked for presence and the run stops, loudly, if
 * the layout moved (`FORMAT_MAJOR`).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { continentFor } from './lib/continents.mjs';
import { eachLine, PointGrid } from './lib/geo-index.mjs';
import { downloadVerified, politeJson } from './lib/polite-http.mjs';

const CACHE = process.env.ATLAS_CACHE ?? '.atlas-cache';
const RAW = join(CACHE, 'raw', 'openskimap');
const WORK = join(CACHE, 'work');
const OUT = join(WORK, 'ski.ndjson');
const HOST = 'https://tiles.openskimap.org';
const AREAS = join(RAW, 'ski_areas.geojson');
const METADATA = join(RAW, 'metadata.json');
const RECEIPT = join(RAW, 'download.json');
/** The openskidata-format major version this stage was written against. */
const FORMAT_MAJOR = 16;

const ATTRIBUTION = "Data from OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors (ODbL), Skimap.org, Who's On First, © Mapterhorn";
const LICENCE = 'ODbL-1.0';

async function download() {
  mkdirSync(RAW, { recursive: true });
  if (existsSync(AREAS) && existsSync(METADATA) && existsSync(RECEIPT)) return JSON.parse(readFileSync(RECEIPT, 'utf8'));
  if (existsSync(RECEIPT)) {
    const ageHours = (Date.now() - statSync(RECEIPT).mtimeMs) / 3_600_000;
    if (ageHours < 24) throw new Error(`OpenSkiData permits automated downloading at most once per day; the last download was ${ageHours.toFixed(1)} h ago and its files are incomplete. Wait, do not retry.`);
  }
  const metadata = await politeJson(`${HOST}/metadata.json`);
  const expected = metadata?.files?.geojson?.skiAreas;
  if (!Number.isInteger(expected) || !Number.isInteger(metadata?.counts?.skiAreas?.total)) throw new Error('metadata.json no longer states the ski-area file size and count; refusing to download a file that cannot be verified');
  writeFileSync(METADATA, JSON.stringify(metadata, null, 1));
  /* The receipt is written before the body so a failed download still counts as today's one attempt. */
  writeFileSync(RECEIPT, JSON.stringify({ startedAt: new Date().toISOString(), complete: false }));
  const result = await downloadVerified(`${HOST}/geojson/ski_areas.geojson`, AREAS, { expectedBytes: expected });
  const receipt = { startedAt: new Date().toISOString(), complete: true, url: `${HOST}/geojson/ski_areas.geojson`, ...result, osmDataTimestamp: metadata.source?.openStreetMap?.dataTimestamp ?? null, builtAt: metadata.run?.finishedAt ?? null, formatVersion: metadata.formatVersion ?? null };
  writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1));
  return receipt;
}

/** A representative point: the feature's own point, or the middle of its bounding box. */
function centreOf(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return { lng: geometry.coordinates[0], lat: geometry.coordinates[1] };
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const walk = (node) => {
    if (typeof node[0] === 'number') {
      if (node[0] < minLng) minLng = node[0];
      if (node[0] > maxLng) maxLng = node[0];
      if (node[1] < minLat) minLat = node[1];
      if (node[1] > maxLat) maxLat = node[1];
    } else for (const child of node) walk(child);
  };
  walk(geometry.coordinates);
  if (!Number.isFinite(minLng)) return null;
  /* An area astride the antimeridian would average to the wrong side of the world; none exists, and this says so if one appears. */
  if (maxLng - minLng > 180) return null;
  return { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 };
}

const round = (value, places) => (Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null);

/** Sum `lengthInKm` (or `count`) over every difficulty of one activity's runs. */
function runsOf(statistics, activity) {
  const byDifficulty = statistics?.runs?.byActivity?.[activity]?.byDifficulty ?? {};
  const km = {};
  let total = 0;
  let count = 0;
  for (const [difficulty, entry] of Object.entries(byDifficulty)) {
    const length = Number(entry?.lengthInKm ?? 0);
    if (length > 0) km[difficulty] = round(length, 1);
    total += length;
    count += Number(entry?.count ?? 0);
  }
  return { km, total: round(total, 1), count };
}

function rowOf(feature) {
  const p = feature.properties ?? {};
  /* A point feature is its own centre; for a polygon OpenSkiData's own viewport centre (the middle of its runs and lifts) beats a bounding box. */
  const hint = feature.geometry?.type !== 'Point' && Array.isArray(p.viewportHint?.center) && p.viewportHint.center.every(Number.isFinite) ? { lng: p.viewportHint.center[0], lat: p.viewportHint.center[1] } : null;
  const centre = hint ?? centreOf(feature.geometry);
  if (!centre || Math.abs(centre.lat) > 90 || Math.abs(centre.lng) > 180) return null;
  const statistics = p.statistics ?? {};
  const lifts = statistics.lifts ?? {};
  let liftCount = 0;
  const liftTypes = {};
  for (const [type, entry] of Object.entries(lifts.byType ?? {})) {
    const count = Number(entry?.count ?? 0);
    liftCount += count;
    if (count > 0) liftTypes[type] = count;
  }
  const downhill = runsOf(statistics, 'downhill');
  const nordic = runsOf(statistics, 'nordic');
  const minElevM = round(statistics.minElevation, 0);
  const maxElevM = round(statistics.maxElevation, 0);
  const places = Array.isArray(p.places) ? p.places : [];
  const iso = places.map((place) => place?.iso3166_1Alpha2).find(Boolean) ?? null;
  return {
    id: p.id,
    name: p.name ?? null,
    lat: round(centre.lat, 4),
    lng: round(centre.lng, 4),
    countryIso: iso,
    region: places.map((place) => place?.localized?.en?.region).find(Boolean) ?? null,
    locality: places.map((place) => place?.localized?.en?.locality).find(Boolean) ?? null,
    status: p.status ?? null,
    activities: Array.isArray(p.activities) ? p.activities : [],
    liftCount,
    liftTypes,
    runKm: downhill.km,
    runKmTotal: downhill.total,
    runCount: downhill.count,
    nordicKm: nordic.total,
    minElevM,
    maxElevM,
    verticalM: minElevM !== null && maxElevM !== null ? maxElevM - minElevM : null,
    wikidata: p.wikidataID ?? null,
    sources: Array.isArray(p.sources) ? [...new Set(p.sources.map((source) => source?.type).filter(Boolean))] : [],
    runConvention: p.runConvention ?? null,
  };
}

async function main() {
  const receipt = await download();
  if (!receipt.complete) throw new Error('the last download did not complete; wait a day before asking again');
  console.log(`ski_areas.geojson: ${receipt.bytes} bytes, sha256 ${receipt.sha256.slice(0, 16)}…, OSM data as of ${receipt.osmDataTimestamp}`);
  if (process.argv.includes('--download')) return;

  const metadata = JSON.parse(readFileSync(METADATA, 'utf8'));
  const major = Number(String(metadata.formatVersion ?? '').split('.')[0]);
  if (major !== FORMAT_MAJOR) throw new Error(`openskidata-format is now ${metadata.formatVersion}; this stage was written against ${FORMAT_MAJOR}.x — re-read the schema before trusting the output`);

  /* Integrity, again, on every run: the bytes, the hash and the feature count must be what was published. */
  const bytes = readFileSync(AREAS);
  if (bytes.length !== metadata.files.geojson.skiAreas) throw new Error(`ski_areas.geojson is ${bytes.length} bytes; metadata.json says ${metadata.files.geojson.skiAreas}`);
  if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw new Error('ski_areas.geojson no longer matches the hash recorded when it was downloaded');
  const collection = JSON.parse(bytes.toString('utf8'));
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('ski_areas.geojson is not a FeatureCollection');
  if (collection.features.length !== metadata.counts.skiAreas.total) throw new Error(`ski_areas.geojson holds ${collection.features.length} features; metadata.json says ${metadata.counts.skiAreas.total}`);

  const rows = [];
  let unplaced = 0;
  for (const feature of collection.features) {
    const row = rowOf(feature);
    if (!row || !row.id) {
      unplaced += 1;
      continue;
    }
    rows.push(row);
  }
  /* The layout check: if these stop appearing, the format moved under us. */
  const withStatistics = rows.filter((row) => row.maxElevM !== null).length;
  const withCountry = rows.filter((row) => row.countryIso).length;
  const operating = rows.filter((row) => row.status === 'operating').length;
  const downhillCount = rows.filter((row) => row.activities.includes('downhill')).length;
  if (operating !== metadata.counts.skiAreas.operating || downhillCount !== metadata.counts.skiAreas.downhill) {
    throw new Error(`status/activities no longer read as published: operating ${operating} vs ${metadata.counts.skiAreas.operating}, downhill ${downhillCount} vs ${metadata.counts.skiAreas.downhill}`);
  }
  if (withStatistics < rows.length * 0.5 || withCountry < rows.length * 0.8) throw new Error(`the statistics or places layout moved: ${withStatistics} rows with elevation, ${withCountry} with a country, of ${rows.length}`);

  rows.sort((a, b) => (a.countryIso ?? 'ZZ').localeCompare(b.countryIso ?? 'ZZ') || (b.runKmTotal ?? 0) - (a.runKmTotal ?? 0) || a.id.localeCompare(b.id));
  mkdirSync(WORK, { recursive: true });
  writeFileSync(OUT, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  /* ── Report ─────────────────────────────────────────────────────────────── */
  const isOperatingDownhill = (row) => row.status === 'operating' && row.activities.includes('downhill');
  /** "A place you could ski": an operating downhill area with at least one lift OR mapped downhill runs. */
  const isLiftServed = (row) => isOperatingDownhill(row) && row.liftCount > 0;
  const byCountry = {};
  const byContinent = {};
  for (const row of rows) {
    const slot = (byCountry[row.countryIso ?? '??'] ??= { all: 0, operatingDownhill: 0, liftServed: 0, runKm: 0 });
    slot.all += 1;
    if (isOperatingDownhill(row)) {
      slot.operatingDownhill += 1;
      slot.runKm += row.runKmTotal ?? 0;
      const continent = continentFor(row.countryIso, row.lat, row.lng);
      byContinent[continent] = (byContinent[continent] ?? 0) + 1;
    }
    if (isLiftServed(row)) slot.liftServed += 1;
  }
  for (const slot of Object.values(byCountry)) slot.runKm = Math.round(slot.runKm);

  const stats = {
    builtAt: new Date().toISOString(),
    licence: LICENCE,
    attribution: ATTRIBUTION,
    source: { url: receipt.url, sha256: receipt.sha256, bytes: receipt.bytes, osmDataTimestamp: receipt.osmDataTimestamp, builtAt: receipt.builtAt, formatVersion: receipt.formatVersion },
    rows: rows.length,
    unplaced,
    byStatus: count(rows, (row) => row.status ?? 'unknown'),
    byActivity: { downhill: downhillCount, nordic: rows.filter((row) => row.activities.includes('nordic')).length, both: rows.filter((row) => row.activities.includes('downhill') && row.activities.includes('nordic')).length, neither: rows.filter((row) => row.activities.length === 0).length },
    bySource: count(rows, (row) => row.sources.slice().sort().join('+') || 'none'),
    operatingDownhill: rows.filter(isOperatingDownhill).length,
    operatingDownhillWithLifts: rows.filter(isLiftServed).length,
    withName: rows.filter((row) => row.name).length,
    withWikidata: rows.filter((row) => row.wikidata).length,
    withCountry,
    withElevation: withStatistics,
    operatingDownhillByContinent: byContinent,
    byCountry: Object.fromEntries(Object.entries(byCountry).sort((a, b) => b[1].operatingDownhill - a[1].operatingDownhill)),
  };

  /* How many atlas candidates sit near a place to ski — printed and kept in the stats file, never merged into either database. */
  const candidatesPath = join(WORK, 'candidates.ndjson');
  if (existsSync(candidatesPath)) {
    const grid = new PointGrid();
    for (const row of rows) if (isOperatingDownhill(row)) grid.add(row.lat, row.lng, row);
    const near = { candidates: 0, any15: 0, any30: 0, lifts15: 0, lifts30: 0, byType: {} };
    await eachLine(candidatesPath, (candidate) => {
      if (candidate.scopeOnly || !Number.isFinite(candidate.lat)) return;
      near.candidates += 1;
      let any15 = false;
      let any30 = false;
      let lifts15 = false;
      let lifts30 = false;
      grid.near(candidate.lat, candidate.lng, 30, (row, d) => {
        any30 = true;
        if (d <= 15) any15 = true;
        if (row.liftCount > 0) {
          lifts30 = true;
          if (d <= 15) lifts15 = true;
        }
      });
      const type = candidate.wvType ?? `wikidata:${candidate.featureKind}`;
      const slot = (near.byType[type] ??= { candidates: 0, any15: 0, any30: 0 });
      slot.candidates += 1;
      if (any15) {
        near.any15 += 1;
        slot.any15 += 1;
      }
      if (any30) {
        near.any30 += 1;
        slot.any30 += 1;
      }
      if (lifts15) near.lifts15 += 1;
      if (lifts30) near.lifts30 += 1;
    });
    stats.candidatesNearOperatingDownhill = near;
  }

  writeFileSync(join(WORK, 'ski-stats.json'), JSON.stringify(stats, null, 1));
  console.log(`${rows.length} ski areas → ${OUT} (${unplaced} without a usable geometry or id)`);
  console.log('status', stats.byStatus, 'activities', stats.byActivity, 'sources', stats.bySource);
  console.log(`operating downhill: ${stats.operatingDownhill} (${stats.operatingDownhillWithLifts} with at least one lift); named ${stats.withName}; with a Wikidata id ${stats.withWikidata}`);
  console.log('operating downhill by continent', byContinent);
  console.log('top countries (operating downhill / with lifts / downhill run km):', Object.entries(stats.byCountry).slice(0, 25).map(([iso, slot]) => `${iso} ${slot.operatingDownhill}/${slot.liftServed}/${slot.runKm}`).join(', '));
  if (stats.candidatesNearOperatingDownhill) {
    const near = stats.candidatesNearOperatingDownhill;
    console.log(`atlas candidates with an operating downhill area within 15 km: ${near.any15} of ${near.candidates}; within 30 km: ${near.any30}. With a lift-served one: ${near.lifts15} / ${near.lifts30}.`);
  }
}

function count(rows, keyOf) {
  const out = {};
  for (const row of rows) {
    const key = keyOf(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
