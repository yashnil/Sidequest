import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { haversineKm } from '@sidequest/core';
import { fileIntersects, latestRelease, themeFiles, type FetchOptions } from '../../providers/overture/catalog';
import { pointOf, scanFile, type BoundingBox, type ScanCounters } from '../../providers/overture/scan';
import { chainKey } from '../../providers/overture-food';
import { foodBoxAround } from '../food';
import { FOOD_SCENARIOS, type FoodScenario } from './scenarios';
import type { RecordedBox, RecordedFoodFixture, RecordedOsmElement, RecordedOvertureRow } from './replay';

/**
 * RECORD THE FOOD FIXTURES — KEYLESS, ONCE, BY HAND.
 *
 *   SIDEQUEST_FOOD_RECORD=1 npx vitest run -c vitest.food.config.ts apps/web/src/lib/discovery-scan/food-eval/record.harness.ts
 *
 * For every scenario, one 1.5 km box around every base and every place (merged
 * where two centres are closer than the product's own box separation), read
 * from the two keyless sources the product itself uses:
 *
 *  - **Overture's place files** (public bucket, ranged GeoParquet reads): every
 *    food-and-drink or food-shop row in a box, kept *raw* — below the product's
 *    confidence floor too, closed rows too — so a change to what the reader
 *    keeps can be measured against the same recording. Capped per box by
 *    confidence. Rows of any category that carry a brand are kept as chain
 *    keys only (the reader learns "this name is a chain" from them).
 *  - **OpenStreetMap through public Overpass**: one union request per group of
 *    boxes (never one per box), eight seconds each, spaced apart, at most two
 *    attempts — the usage policy the client already follows. A group nobody
 *    answered is recorded as `osm: null`: an absence, replayed as one.
 *
 * Never part of `npm run test`; never run without the switch.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures');
const SCRATCH = process.env.SIDEQUEST_FOOD_RECORD_CACHE ?? join(tmpdir(), 'sidequest-food-record');
const ONLY = process.env.SIDEQUEST_FOOD_RECORD_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
/** `overture` or `osm` re-records one source and keeps the other half of the earlier recording. */
const SOURCES = process.env.SIDEQUEST_FOOD_RECORD_SOURCES ?? 'both';

const MIN_BOX_SEPARATION_KM = 1.2;
const FOOD_ROWS_PER_BOX = 260;
const SHOP_ROWS_PER_BOX = 40;
const COLUMNS = ['id', 'names', 'confidence', 'operating_status', 'basic_category', 'taxonomy', 'categories', 'brand', 'websites', 'sources', 'addresses', 'bbox'] as const;

/** What Overture files food under. Deliberately wide: the recording keeps the row's own category so the reader decides. */
const FOOD_WORDS = /(restaurant|eatery|cafe|coffee|bakery|(^|_)food(_|$)|(^|_)bar(_|$)|(^|_)pub(_|$)|gastropub|grocery|supermarket|convenience_store|(^|_)market(_|$)|delicatessen|butcher|tea_room|bistro|diner|pizz|sandwich|noodle|sushi)/;
const SHOP_WORDS = /(grocery|supermarket|convenience_store|food_and_beverage_store|(^|_)market(_|$)|delicatessen|butcher|greengrocer|produce_store|health_food|specialty_food)/;

function fileCache(): NonNullable<FetchOptions['cache']> {
  mkdirSync(SCRATCH, { recursive: true });
  const path = (key: string) => join(SCRATCH, `${key.replace(/[^a-z0-9]+/gi, '_').slice(0, 120)}.json`);
  return {
    read: (key) => (existsSync(path(key)) ? (JSON.parse(readFileSync(path(key), 'utf8')) as unknown) : null),
    write: (key, value) => writeFileSync(path(key), JSON.stringify(value)),
  };
}

function boxesFor(scenario: FoodScenario): { center: { lat: number; lng: number }; label: string }[] {
  const out: { center: { lat: number; lng: number }; label: string }[] = [];
  for (const point of [...scenario.bases, ...scenario.places]) {
    if (out.some((o) => haversineKm(o.center, point.coordinates) < MIN_BOX_SEPARATION_KM)) continue;
    out.push({ center: point.coordinates, label: point.name });
  }
  return out;
}

/** Boxes within a dozen kilometres of a seed are read in one pass over one covering box. */
function clusters<T extends { center: { lat: number; lng: number } }>(boxes: readonly T[]): T[][] {
  const out: T[][] = [];
  for (const box of boxes) {
    const home = out.find((group) => haversineKm(group[0]!.center, box.center) <= 12);
    if (home) home.push(box);
    else out.push([box]);
  }
  return out;
}

function cover(boxes: readonly BoundingBox[]): BoundingBox {
  return {
    south: Math.min(...boxes.map((x) => x.south)),
    north: Math.max(...boxes.map((x) => x.north)),
    west: Math.min(...boxes.map((x) => x.west)),
    east: Math.max(...boxes.map((x) => x.east)),
  };
}

const inBox = (point: { lat: number; lng: number }, box: BoundingBox) => point.lng >= box.west && point.lng <= box.east && point.lat >= box.south && point.lat <= box.north;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const round = (n: number) => Math.round(n * 1e6) / 1e6;

interface Kept {
  row: RecordedOvertureRow;
  shop: boolean;
}

async function recordOverture(scenario: FoodScenario, boxes: { center: { lat: number; lng: number }; label: string }[], files: Awaited<ReturnType<typeof themeFiles>>): Promise<{ perBox: (RecordedBox['overture'])[]; bytes: number }> {
  const perBox: { food: Kept[]; branded: Set<string>; answered: boolean }[] = boxes.map(() => ({ food: [], branded: new Set(), answered: false }));
  const small = boxes.map((x) => foodBoxAround(x.center));
  const counters: ScanCounters = { bytesTransferred: 0, rowGroupsInspected: 0, rowGroupsRead: 0, featuresRead: 0 };
  const indexed = boxes.map((x, index) => ({ ...x, index }));
  for (const group of clusters(indexed)) {
    const covering = cover(group.map((g) => small[g.index]!));
    try {
      for (const file of files.filter((f) => fileIntersects(f, covering))) {
        await scanFile({
          url: file.url,
          box: covering,
          columns: COLUMNS,
          requiredColumns: ['id', 'names', 'bbox'],
          reuseFooter: true,
          counters,
          budget: { maxRowGroups: 80, maxBytes: counters.bytesTransferred + 220_000_000, maxFeaturesRead: 12_000_000, maxFeaturesRetained: 10, deadlineMs: Date.now() + 240_000 },
          sink: { add: () => undefined },
          accept: (raw) => {
            const point = pointOf(raw);
            if (!point) return null;
            const homes = group.filter((g) => inBox(point, small[g.index]!));
            if (homes.length === 0) return null;
            const name = str((raw.names as { primary?: unknown } | null | undefined)?.primary);
            const id = str(raw.id);
            if (!name || !id) return null;
            const brand = raw.brand as { names?: { primary?: unknown } | null; wikidata?: unknown } | null | undefined;
            const brandName = str(brand?.names?.primary);
            const brandWikidata = str(brand?.wikidata);
            if (brandName || brandWikidata) for (const home of homes) perBox[home.index]!.branded.add(chainKey(name));
            const taxonomy = raw.taxonomy as { primary?: unknown; hierarchy?: unknown } | null | undefined;
            const leaf = str(taxonomy?.primary) ?? '';
            const hierarchy = Array.isArray(taxonomy?.hierarchy) ? taxonomy.hierarchy.filter((h): h is string => typeof h === 'string') : [];
            const basic = str(raw.basic_category) ?? '';
            const categories = raw.categories as { primary?: unknown } | null | undefined;
            const legacy = str(categories?.primary) ?? '';
            const words = [basic, leaf, legacy, ...hierarchy];
            if (!words.some((w) => FOOD_WORDS.test(w)) && !hierarchy.includes('food_and_drink')) return null;
            const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;
            if (confidence < 0.4) return null;
            const sources = Array.isArray(raw.sources) ? (raw.sources as { dataset?: unknown; license?: unknown; update_time?: unknown }[]) : [];
            const addresses = Array.isArray(raw.addresses) ? (raw.addresses as { locality?: unknown; country?: unknown }[]) : [];
            const websites = Array.isArray(raw.websites) ? raw.websites.filter((w): w is string => typeof w === 'string') : [];
            const row: RecordedOvertureRow = {
              id,
              name,
              lat: round(point.lat),
              lng: round(point.lng),
              confidence: Math.round(confidence * 1000) / 1000,
              ...(str(raw.operating_status) ? { status: str(raw.operating_status)! } : {}),
              ...(basic ? { basic } : {}),
              ...(leaf ? { leaf } : {}),
              ...(hierarchy.length > 0 ? { hierarchy } : {}),
              ...(legacy && legacy !== leaf ? { legacy } : {}),
              ...(brandName ? { brand: brandName } : {}),
              ...(brandWikidata ? { brandWikidata } : {}),
              ...(websites[0] ? { website: websites[0] } : {}),
              ...(str(addresses[0]?.locality) ? { locality: str(addresses[0]?.locality)! } : {}),
              ...(str(addresses[0]?.country) ? { country: str(addresses[0]?.country)! } : {}),
              sources: sources.map((s) => ({ ...(str(s.dataset) ? { dataset: str(s.dataset)! } : {}), ...(str(s.license) ? { license: str(s.license)! } : {}), ...(str(s.update_time) ? { updated: str(s.update_time)! } : {}) })),
            };
            const shop = words.some((w) => SHOP_WORDS.test(w)) && !/restaurant|eatery|cafe|coffee/.test(basic);
            for (const home of homes) perBox[home.index]!.food.push({ row, shop });
            return null;
          },
        });
      }
      for (const g of group) perBox[g.index]!.answered = true;
    } catch (error) {
      console.warn(`[record] ${scenario.label}: Overture cluster around "${group[0]!.label}" failed`, error instanceof Error ? error.message : error);
    }
  }
  return {
    bytes: counters.bytesTransferred,
    perBox: perBox.map((box) => {
      if (!box.answered) return null;
      const byConfidence = (a: Kept, z: Kept) => z.row.confidence - a.row.confidence || a.row.id.localeCompare(z.row.id);
      const meals = box.food.filter((k) => !k.shop).sort(byConfidence);
      const shops = box.food.filter((k) => k.shop).sort(byConfidence);
      return {
        rows: [...meals.slice(0, FOOD_ROWS_PER_BOX), ...shops.slice(0, SHOP_ROWS_PER_BOX)].map((k) => k.row),
        mealRowsInBox: meals.length,
        shopRowsInBox: shops.length,
        brandedKeys: [...box.branded].filter(Boolean).sort(),
      };
    }),
  };
}

/* ---------------- OpenStreetMap, politely ---------------- */

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const OSM_TAGS: readonly [string, readonly string[]][] = [
  ['amenity', ['restaurant', 'cafe', 'fast_food', 'food_court', 'pub', 'bar', 'marketplace']],
  ['shop', ['bakery', 'supermarket', 'convenience', 'greengrocer', 'deli', 'butcher']],
];
const OSM_KEEP_TAGS = /^(name|name:en|name:latin|int_name|amenity|shop|cuisine|opening_hours|brand|brand:wikidata|brand:en|operator|wikidata|website|contact:website|takeaway|diet:[a-z_]+|addr:city|addr:place|addr:suburb|organic|check_date(:opening_hours)?)$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function overpassQuery(boxes: readonly BoundingBox[]): string {
  const clauses = boxes
    .flatMap((box) => {
      const bbox = `${box.south.toFixed(5)},${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)}`;
      return OSM_TAGS.flatMap(([key, values]) => values.flatMap((value) => ['node', 'way'].map((el) => `${el}["${key}"="${value}"]["name"](${bbox});`)));
    })
    .join('\n  ');
  return `[out:json][timeout:8];\n(\n  ${clauses}\n);\nout center tags qt 2000;`;
}

async function askOverpass(boxes: readonly BoundingBox[]): Promise<RecordedOsmElement[] | null> {
  const query = overpassQuery(boxes);
  for (const endpoint of OVERPASS_ENDPOINTS.slice(0, 2)) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'user-agent': 'Sidequest/0.1 food-fixture-recorder (one-off, manual)', 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        console.warn(`[record] Overpass ${new URL(endpoint).host}: ${response.status}`);
        await sleep(4_000);
        continue;
      }
      const body = (await response.json()) as { elements?: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
      return (body.elements ?? []).flatMap((element) => {
        const lat = element.lat ?? element.center?.lat;
        const lon = element.lon ?? element.center?.lon;
        if (typeof lat !== 'number' || typeof lon !== 'number' || !element.tags) return [];
        const tags = Object.fromEntries(Object.entries(element.tags).filter(([key]) => OSM_KEEP_TAGS.test(key)));
        return [{ type: element.type as RecordedOsmElement['type'], id: element.id, lat: round(lat), lon: round(lon), tags }];
      });
    } catch (error) {
      console.warn(`[record] Overpass ${new URL(endpoint).host}: ${error instanceof Error ? error.message : error}`);
      await sleep(4_000);
    }
  }
  return null;
}

async function recordOsm(boxes: { center: { lat: number; lng: number } }[]): Promise<(RecordedOsmElement[] | null)[]> {
  const small = boxes.map((x) => foodBoxAround(x.center));
  const out: (RecordedOsmElement[] | null)[] = boxes.map(() => null);
  const GROUP = 6;
  for (let start = 0; start < boxes.length; start += GROUP) {
    const indexes = Array.from({ length: Math.min(GROUP, boxes.length - start) }, (_, k) => start + k);
    const elements = await askOverpass(indexes.map((i) => small[i]!));
    if (elements) for (const i of indexes) out[i] = elements.filter((e) => inBox({ lat: e.lat, lng: e.lon }, small[i]!));
    await sleep(3_000);
  }
  return out;
}

describe.runIf(process.env.SIDEQUEST_FOOD_RECORD === '1')('record food fixtures (network, keyless)', () => {
  for (const scenario of FOOD_SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.label))) {
    it(`records ${scenario.label}`, async () => {
      const cache = fileCache();
      const release = await latestRelease({ cache });
      const files = await themeFiles({ release, theme: 'places', type: 'place', options: { cache } });
      const boxes = boxesFor(scenario);
      const out = join(OUT, `${scenario.label}.json.gz`);
      const earlier = existsSync(out) ? (JSON.parse(gunzipSync(readFileSync(out)).toString('utf8')) as RecordedFoodFixture) : null;
      const earlierBox = (box: { center: { lat: number; lng: number } }) => earlier?.boxes.find((e) => haversineKm(e.center, box.center) < 0.05) ?? null;
      const started = Date.now();
      const overture = SOURCES === 'osm' ? { bytes: 0, perBox: boxes.map((box) => earlierBox(box)?.overture ?? null) } : await recordOverture(scenario, boxes, files);
      const overtureMs = Date.now() - started;
      const osm = SOURCES === 'overture' ? boxes.map((box) => earlierBox(box)?.osm ?? null) : await recordOsm(boxes);
      const fixture: RecordedFoodFixture = {
        label: scenario.label,
        recordedAt: new Date().toISOString(),
        overtureRelease: SOURCES === 'osm' && earlier ? earlier.overtureRelease : release.releaseId,
        notes: 'Raw rows from Overture place files (CDLA-Permissive-2.0 / Apache-2.0 per row) and OpenStreetMap via Overpass (ODbL-1.0, © OpenStreetMap contributors). Recorded for tests; capped per box by confidence.',
        boxes: boxes.map((box, index) => ({ label: box.label, center: box.center, overture: overture.perBox[index] ?? null, osm: osm[index] ?? null })),
      };
      mkdirSync(OUT, { recursive: true });
      writeFileSync(out, gzipSync(Buffer.from(JSON.stringify(fixture))));
      const rows = fixture.boxes.reduce((n, x) => n + (x.overture?.rows.length ?? 0), 0);
      const osmRows = fixture.boxes.reduce((n, x) => n + (x.osm?.length ?? 0), 0);
      console.warn(`[record] ${scenario.label}: ${boxes.length} boxes, ${rows} Overture rows (${(overture.bytes / 1e6).toFixed(1)} MB, ${overtureMs} ms), ${osmRows} OSM elements, OSM unanswered boxes ${fixture.boxes.filter((x) => x.osm === null).length}`);
      expect(fixture.boxes.length).toBeGreaterThan(0);
    }, 900_000);
  }
});
