#!/usr/bin/env node
/* eslint-disable no-console -- a command-line report: its output is the point. */
/**
 * Find or check the Wikidata item for every destination-catalog entry.
 *
 *   node packages/core/scripts/catalog-wikidata.mjs <data-file.ts> [--check]
 *
 * A remembered QID is not evidence: the wrong one puts a duke's portrait on a
 * fjord. So this asks Wikidata by name, and accepts a candidate only when its
 * own coordinate (P625) lies inside the destination's stated footprint
 * (radiusKm + 150 km of the centre). It prints one line per entry:
 *
 *   OK      <id>  <QID>  <label>  <km> km  image:<yes|no>
 *   CHANGE  <id>  had <QID> → suggest <QID> ...
 *   NONE    <id>  no candidate within the footprint
 *
 * It never edits the file. One request per entry at a time, with a
 * descriptive User-Agent, as Wikimedia's API etiquette asks.
 */
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!file) {
  console.error('usage: catalog-wikidata.mjs <data-file.ts> [--check]');
  process.exit(2);
}
const jiti = createJiti(fileURLToPath(import.meta.url));
const mod = await jiti.import(path.resolve(file));
const entries = Object.values(mod).find(Array.isArray);
if (!entries) {
  console.error('no exported array in', file);
  process.exit(2);
}

const UA = 'SidequestCatalogCheck/0.1 (local development; contact via repository owner)';
async function api(params) {
  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`;
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': UA } });
    if (response.ok) return response.json();
    status = response.status;
    /* A 429 says how long to wait; honour it rather than hammering a volunteer-run service. */
    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60_000)));
  }
  throw new Error(`wikidata ${status}`);
}

function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

async function describe(ids) {
  if (ids.length === 0) return {};
  const data = await api({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims', languages: 'en' });
  const out = {};
  for (const [id, entity] of Object.entries(data.entities ?? {})) {
    const coord = entity.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    out[id] = {
      label: entity.labels?.en?.value ?? '?',
      point: coord ? { lat: coord.latitude, lng: coord.longitude } : null,
      image: Boolean(entity.claims?.P948 || entity.claims?.P18),
    };
  }
  return out;
}

let bad = 0;
for (const entry of entries) {
  const limit = entry.radiusKm + 150;
  const names = [...new Set([entry.name, entry.resolveAs.split(',')[0].trim()])];
  const found = new Set(entry.wikidataId ? [entry.wikidataId] : []);
  if (!checkOnly) {
    for (const name of names) {
      const search = await api({ action: 'wbsearchentities', search: name, language: 'en', limit: '7', type: 'item' });
      for (const hit of search.search ?? []) found.add(hit.id);
    }
  }
  const info = await describe([...found]);
  const ok = Object.entries(info)
    .filter(([, value]) => value.point && km(value.point, entry.center) <= limit)
    .map(([id, value]) => ({ id, ...value, km: Math.round(km(value.point, entry.center)) }))
    .sort((a, b) => Number(b.image) - Number(a.image) || a.km - b.km);
  const current = entry.wikidataId ? ok.find((candidate) => candidate.id === entry.wikidataId) : null;
  if (current) {
    console.log(`OK      ${entry.id}  ${current.id}  ${current.label}  ${current.km} km  image:${current.image ? 'yes' : 'no'}`);
  } else if (ok.length > 0) {
    bad += entry.wikidataId ? 1 : 0;
    const head = ok[0];
    const had = entry.wikidataId ? `had ${entry.wikidataId} (${info[entry.wikidataId]?.label ?? 'not found'}) → ` : '';
    console.log(`CHANGE  ${entry.id}  ${had}suggest ${head.id}  ${head.label}  ${head.km} km  image:${head.image ? 'yes' : 'no'}   others: ${ok.slice(1, 4).map((c) => `${c.id} ${c.label}`).join('; ')}`);
  } else {
    bad += entry.wikidataId ? 1 : 0;
    console.log(`NONE    ${entry.id}  no candidate within ${limit} km${entry.wikidataId ? ` (had ${entry.wikidataId}: ${info[entry.wikidataId]?.label ?? 'not found'})` : ''}`);
  }
}
process.exit(bad > 0 && checkOnly ? 1 : 0);
