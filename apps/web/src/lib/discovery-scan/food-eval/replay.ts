import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { haversineKm } from '@sidequest/core';
import type { OverpassElement, OverpassResult } from '../../providers/overpass';
import type { BoundingBox } from '../../providers/overture/scan';

/**
 * FOOD EVALUATION — THE RECORDED WORLD, REPLAYED.
 *
 * One fixture per scenario (`fixtures/<label>.json.gz`, written by
 * `record.harness.ts`): for every 1.5 km box, the raw Overture place rows and
 * the raw OpenStreetMap elements that the keyless sources returned on the day
 * of recording. Raw on purpose — below the reader's confidence floor, closed
 * rows, shops — so the reader under test decides what to keep and a change to
 * it is measured against the same world.
 *
 * `null` for a source means nobody answered for that box when it was recorded;
 * it replays as the same absence (a failed box), never as "nothing there".
 */

export interface RecordedOvertureRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  confidence: number;
  status?: string;
  basic?: string;
  leaf?: string;
  hierarchy?: string[];
  /** `categories.primary` from the older schema, when it differs from the taxonomy leaf. */
  legacy?: string;
  brand?: string;
  brandWikidata?: string;
  website?: string;
  locality?: string;
  country?: string;
  sources: { dataset?: string; license?: string; updated?: string }[];
}

export interface RecordedOsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface RecordedBox {
  label: string;
  center: { lat: number; lng: number };
  overture: { rows: RecordedOvertureRow[]; mealRowsInBox: number; shopRowsInBox: number; brandedKeys: string[] } | null;
  osm: RecordedOsmElement[] | null;
}

export interface RecordedFoodFixture {
  label: string;
  recordedAt: string;
  overtureRelease: string;
  notes: string;
  boxes: RecordedBox[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadFoodFixture(label: string): RecordedFoodFixture {
  return JSON.parse(gunzipSync(readFileSync(join(HERE, 'fixtures', `${label}.json.gz`))).toString('utf8')) as RecordedFoodFixture;
}

/** The recorded box a requested box is, when its centre is the same point (within 60 m). */
export function recordedBoxFor(fixture: RecordedFoodFixture, box: BoundingBox): RecordedBox | null {
  const center = { lat: (box.north + box.south) / 2, lng: (box.east + box.west) / 2 };
  let best: { box: RecordedBox; km: number } | null = null;
  for (const candidate of fixture.boxes) {
    const km = haversineKm(candidate.center, center);
    if (!best || km < best.km) best = { box: candidate, km };
  }
  return best && best.km <= 0.06 ? best.box : null;
}

/** A recorded row in the shape the Overture place files publish it, so the product's own reader parses it. */
export function asOvertureRow(row: RecordedOvertureRow): Record<string, unknown> {
  return {
    id: row.id,
    names: { primary: row.name },
    confidence: row.confidence,
    operating_status: row.status ?? null,
    basic_category: row.basic ?? null,
    taxonomy: { primary: row.leaf ?? null, hierarchy: row.hierarchy ?? [] },
    categories: { primary: row.legacy ?? row.leaf ?? null },
    brand: row.brand || row.brandWikidata ? { names: { primary: row.brand ?? null }, wikidata: row.brandWikidata ?? null } : null,
    websites: row.website ? [row.website] : [],
    sources: row.sources.map((s) => ({ dataset: s.dataset, license: s.license, update_time: s.updated })),
    addresses: row.locality || row.country ? [{ locality: row.locality ?? null, country: row.country ?? null }] : [],
    bbox: { xmin: row.lng, xmax: row.lng, ymin: row.lat, ymax: row.lat },
  };
}

export function asOverpassElement(element: RecordedOsmElement): OverpassElement {
  return { type: element.type, id: element.id, lat: element.lat, lon: element.lon, tags: element.tags } as OverpassElement;
}

export function overpassAnswer(elements: OverpassElement[]): OverpassResult {
  return { elements, dataTimestamp: null, calls: 1, cacheHit: false, bytes: 0, failedGroups: [] };
}
