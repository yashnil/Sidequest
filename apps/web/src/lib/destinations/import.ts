import 'server-only';
import { z } from 'zod';
import {
  DESTINATION_INDEX_VERSION,
  sanitizePlaceText,
  type DestinationFeatureType,
  type DestinationIndexEntry,
  type DestinationIndexRelease,
} from '@sidequest/core';
import { replaceDestinationIndex } from '../db/destination-index-repository';

/**
 * TURNING RAW CATALOGUE RECORDS INTO A DESTINATION INDEX.
 *
 * Every product decision about what a destination *is* lives here, and none of
 * it lives in the scan script — the script knows about parquet and byte ranges,
 * this knows about travel. That split is what lets the interesting half be
 * tested without a network.
 *
 * The three transformations that matter:
 *
 * 1. **English leads.** The catalogue's `primary` name is the local form, which
 *    is how a card came to be headed `Кыргыз Республикасы` for somebody who
 *    typed "Kyrgyzstan". The English common name becomes the display name where
 *    one exists; the local form is kept and shown beside it, never instead.
 * 2. **Hierarchy is resolved, not stored as codes.** A row saying `KG-GB` tells
 *    a traveller nothing. Parent chains are walked in memory, once, so a
 *    suggestion can say "City · Kyrgyzstan".
 * 3. **Extents are measured, never assumed.** Division records are points. A
 *    country's bounds are the bounding box of its own indexed children — a real
 *    measurement from source coordinates — and a feature with no children gets
 *    no bounds at all rather than a circle presented as a border.
 */

const rawSchema = z.object({
  sourceId: z.string().min(1),
  subtype: z.string().min(1),
  class: z.string().optional(),
  primaryName: z.string().min(1),
  englishName: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  localType: z.string().optional(),
  countryCode: z.string().optional(),
  regionCode: z.string().optional(),
  parentId: z.string().optional(),
  population: z.number().optional(),
  prominence: z.number().optional(),
  wikidata: z.string().optional(),
  bbox: z.object({ xmin: z.number(), xmax: z.number(), ymin: z.number(), ymax: z.number() }),
});
export type RawDivisionRecord = z.infer<typeof rawSchema>;

export const IMPORT_CATALOG = 'overture';

/**
 * A locality large enough to read as a city rather than a town.
 *
 * A threshold rather than the catalogue's `class`, because `class` is applied
 * inconsistently across countries — plenty of national capitals are recorded as
 * `town`. The label only affects what a dropdown row says, so a threshold that
 * is occasionally generous is the right kind of wrong.
 */
const CITY_POPULATION = 100_000;

function featureTypeFor(raw: RawDivisionRecord): DestinationFeatureType | null {
  switch (raw.subtype) {
    case 'country':
      return 'country';
    case 'dependency':
      return 'dependency';
    case 'region':
      return 'region';
    case 'county':
      return 'county';
    case 'localadmin':
    case 'locality': {
      const population = raw.population ?? 0;
      if (raw.class === 'city' || raw.class === 'borough' || population >= CITY_POPULATION) return 'city';
      return 'town';
    }
    case 'macrohood':
    case 'neighborhood':
      return 'district';
    default:
      return null;
  }
}

function centerOf(raw: RawDivisionRecord): { lat: number; lng: number } | null {
  const lat = (raw.bbox.ymin + raw.bbox.ymax) / 2;
  const lng = (raw.bbox.xmin + raw.bbox.xmax) / 2;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

interface Staged {
  entry: DestinationIndexEntry;
  parentId: string | undefined;
  regionCode: string | undefined;
}

/**
 * Build index entries from raw records.
 *
 * Pure, and separate from persistence, so the interesting transformations —
 * naming, hierarchy, extents — are testable against a handful of fixtures rather
 * than against a hundred thousand rows.
 */
export function buildIndexEntries(records: readonly RawDivisionRecord[]): DestinationIndexEntry[] {
  const staged = new Map<string, Staged>();
  /** Country code and region code both resolve through here to a display name. */
  const countryNames = new Map<string, string>();
  const regionNames = new Map<string, string>();

  for (const raw of records) {
    const featureType = featureTypeFor(raw);
    if (!featureType) continue;
    const center = centerOf(raw);
    if (!center) continue;

    const local = sanitizePlaceText(raw.primaryName);
    const english = raw.englishName ? sanitizePlaceText(raw.englishName) : undefined;
    if (local.length === 0 && !english) continue;

    const displayName = english && english.length > 0 ? english : local;
    const localName = local.length > 0 && local !== displayName ? local : undefined;

    const aliases = [...new Set(raw.aliases.map(sanitizePlaceText))].filter(
      (alias) => alias.length > 0 && alias !== displayName && alias !== localName,
    );

    const id = `${IMPORT_CATALOG}:${raw.sourceId}`;
    const entry: DestinationIndexEntry = {
      id,
      catalog: IMPORT_CATALOG,
      sourceId: raw.sourceId,
      featureType,
      displayName,
      ...(localName ? { localName } : {}),
      aliases,
      ...(raw.countryCode && /^[A-Za-z]{2}$/.test(raw.countryCode)
        ? { countryCode: raw.countryCode.toUpperCase() }
        : {}),
      ...(raw.regionCode ? { regionCode: raw.regionCode } : {}),
      hierarchy: [],
      center,
      ...(typeof raw.population === 'number' && raw.population >= 0
        ? { population: Math.round(raw.population) }
        : {}),
      ...(typeof raw.prominence === 'number' ? { prominence: raw.prominence } : {}),
      ...(raw.wikidata && /^Q\d+$/.test(raw.wikidata) ? { wikidataId: raw.wikidata } : {}),
    };

    staged.set(id, { entry, parentId: raw.parentId, regionCode: raw.regionCode });

    if (featureType === 'country' || featureType === 'dependency') {
      if (entry.countryCode) countryNames.set(entry.countryCode, displayName);
    }
    if (featureType === 'region' && raw.regionCode) {
      regionNames.set(raw.regionCode, displayName);
    }
  }

  /*
   * Extents, from children.
   *
   * A country's own record is a point, so its bounds come from the bounding box
   * of everything indexed inside it. That is a measurement rather than an
   * assumption, and it is what makes country-scale scope possible at all — the
   * broad-scope layer needs a real extent to decide whether a cluster is
   * reachable, and a radius around a centroid would put half of Kyrgyzstan in
   * China.
   */
  const countryExtent = new Map<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }>();
  const regionExtent = new Map<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }>();

  for (const { entry, regionCode } of staged.values()) {
    if (entry.countryCode) grow(countryExtent, entry.countryCode, entry.center);
    if (regionCode) grow(regionExtent, regionCode, entry.center);
  }

  const entries: DestinationIndexEntry[] = [];
  for (const item of staged.values()) {
    const { entry } = item;

    // Hierarchy: walk parents, coarse-to-fine, with a guard against a cycle in
    // somebody else's data.
    const chain: string[] = [];
    let cursor = item.parentId;
    let hops = 0;
    while (cursor && hops < 6) {
      const parent = staged.get(`${IMPORT_CATALOG}:${cursor}`);
      if (!parent) break;
      chain.unshift(parent.entry.displayName);
      cursor = parent.parentId;
      hops += 1;
    }
    if (chain.length === 0 && entry.countryCode) {
      const country = countryNames.get(entry.countryCode);
      if (country && country !== entry.displayName) chain.push(country);
      const region = item.regionCode ? regionNames.get(item.regionCode) : undefined;
      if (region && region !== entry.displayName) chain.push(region);
    }
    entry.hierarchy = chain;

    const extent =
      entry.featureType === 'country' || entry.featureType === 'dependency'
        ? entry.countryCode
          ? countryExtent.get(entry.countryCode)
          : undefined
        : entry.featureType === 'region'
          ? item.regionCode
            ? regionExtent.get(item.regionCode)
            : undefined
          : undefined;

    if (extent && extent.maxLat > extent.minLat && extent.maxLng > extent.minLng) {
      entry.bounds = {
        southWest: { lat: extent.minLat, lng: extent.minLng },
        northEast: { lat: extent.maxLat, lng: extent.maxLng },
      };
    }

    entries.push(entry);
  }

  return entries;
}

function grow(
  into: Map<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }>,
  key: string,
  point: { lat: number; lng: number },
): void {
  const existing = into.get(key);
  if (!existing) {
    into.set(key, { minLat: point.lat, maxLat: point.lat, minLng: point.lng, maxLng: point.lng });
    return;
  }
  existing.minLat = Math.min(existing.minLat, point.lat);
  existing.maxLat = Math.max(existing.maxLat, point.lat);
  existing.minLng = Math.min(existing.minLng, point.lng);
  existing.maxLng = Math.max(existing.maxLng, point.lng);
}

export interface ImportOutcome {
  entries: number;
  terms: number;
  skipped: number;
  release: DestinationIndexRelease;
}

/**
 * Parse NDJSON produced by the scan script and replace the index with it.
 *
 * A malformed line is skipped and counted rather than fatal: a scan of a hundred
 * thousand rows that fails on the last one because a publisher put a control
 * character in a name would be a build that can never complete.
 */
export function importDestinationIndex(input: {
  ndjson: string;
  releaseId: string;
  now: Date;
}): ImportOutcome {
  const records: RawDivisionRecord[] = [];
  let skipped = 0;

  for (const line of input.ndjson.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const record = rawSchema.safeParse(parsed);
    if (!record.success) {
      skipped += 1;
      continue;
    }
    records.push(record.data);
  }

  const entries = buildIndexEntries(records);
  const release: DestinationIndexRelease = {
    schemaVersion: DESTINATION_INDEX_VERSION,
    catalog: IMPORT_CATALOG,
    releaseId: input.releaseId,
    entryCount: entries.length,
    builtAt: input.now.toISOString(),
  };
  const written = replaceDestinationIndex({ entries, release });
  return { ...written, skipped, release };
}
