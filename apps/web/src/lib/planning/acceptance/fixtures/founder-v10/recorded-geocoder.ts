import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyNominatim, osmElementId, type NominatimPlace } from '@/lib/providers/nominatim';
import type { GeocodedLocality } from '../../../skeleton-adapter';

/**
 * V10 §17 — THE PUBLIC GEOCODER'S REAL ANSWERS FOR THE FOUNDER'S OWN BASE NAMES.
 *
 * Recorded from the public Nominatim instance on 2026-09-12, ODbL, and replayed
 * through the same `classifyNominatim` the product uses — so what the benchmark
 * asserts is the product's reading of real rows, not a synthetic world built to
 * pass.
 *
 * The recordings are the argument for the placement ladder on their own:
 *
 *   "Vík"                  → a village in Iceland, a town in Scotland, a district in Norway
 *   "Vík, Iceland"         → the village, and a farmyard
 *   "Höfn area"            → **nothing at all**; the draft's own hedge word returns zero rows
 *   "Höfn"                 → the town
 *   "Selfoss"              → the town, and two waterfalls of the same name
 *   "Jasper"               → three Jasper Counties in the United States
 *   "Jasper, Alberta, Canada" → the municipality
 *   "Field"                → places in the United States and Australia
 *   "Field, British Columbia, Canada" → the village
 *
 * A query that was not recorded answers "nothing", which the reconciler reads as
 * a blank rather than a refusal.
 */

const DIRS = ['src/lib/planning/acceptance/fixtures/founder-v10/nominatim', 'apps/web/src/lib/planning/acceptance/fixtures/founder-v10/nominatim'];

let table: { dir: string; queries: Record<string, string> } | null = null;

function load(): { dir: string; queries: Record<string, string> } {
  if (table) return table;
  for (const dir of DIRS) {
    try {
      const raw = readFileSync(join(process.cwd(), dir, 'index.json'), 'utf8');
      table = { dir: join(process.cwd(), dir), queries: (JSON.parse(raw) as { queries: Record<string, string> }).queries };
      return table;
    } catch {
      /* try the next root */
    }
  }
  throw new Error('the V10 founder geocoder recordings are missing');
}

const normalize = (query: string) => query.toLowerCase().replace(/\s+/g, ' ').trim();

/** The recorded rows for one query, or null when it was never recorded. */
export function recordedRows(query: string): NominatimPlace[] | null {
  const { dir, queries } = load();
  const file = queries[normalize(query)];
  if (!file) return null;
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as NominatimPlace[];
}

/** Every query the recordings hold, for the "did we ask what we think we asked" assertion. */
export function recordedQueries(): string[] {
  return Object.keys(load().queries);
}

/**
 * A geocoder in the reconciler's own shape, over the recordings, translated by
 * the same code the product uses. Logs every query it is asked.
 */
export function recordedGeocoder(log: string[] = []): (query: string) => Promise<readonly GeocodedLocality[]> {
  return async (query: string) => {
    log.push(query);
    const rows = recordedRows(query);
    if (!rows) return [];
    const out: GeocodedLocality[] = [];
    for (const place of rows) {
      const lat = Number(place.lat);
      const lng = Number((place as { lon?: string }).lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const sourceId = osmElementId(place) ?? (place.place_id !== undefined ? `nominatim/${place.place_id}` : null);
      if (!sourceId) continue;
      const { entityType } = classifyNominatim(place);
      out.push({
        sourceId,
        name: place.namedetails?.['name:en'] ?? place.name ?? place.display_name,
        lat,
        lng,
        ...(place.address?.['country_code'] ? { countryCode: place.address['country_code'] } : {}),
        entityType,
        ...(place.importance !== undefined ? { importance: place.importance } : {}),
      });
    }
    return out;
  };
}
