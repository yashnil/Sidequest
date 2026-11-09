import 'server-only';
import type { FoodVenue, LicenceId } from '@sidequest/core';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';
import { CatalogError, fileIntersects, latestRelease, themeFiles, type CatalogFile, type FetchOptions } from './overture/catalog';
import { ScanError, pointOf, rowPointInBox, scanFile, type BoundingBox, type ScanCounters } from './overture/scan';

/**
 * OVERTURE FOOD — SOMEWHERE REAL TO EAT, READ STRAIGHT FROM THE OPEN PLACE FILES.
 *
 * Why this exists (release pass, 2026-11): the scan's food step asked the public
 * Overpass instances, and a live pass measured all three answering a
 * 1.5 km restaurant query in **30 s timeouts** (with `/api/status` itself
 * hanging) and the only one that answered taking 22 s. Food came back
 * "unavailable, 0 venues" on three of five live scans. The Overpass usage policy
 * also names apps for non-mapper audiences as an abuse pattern, so leaning on it
 * harder was never the answer.
 *
 * Overture's places theme is the same global catalogue the optional compiler
 * reads (`providers/overture/`): Meta, Microsoft and Foursquare records with an
 * existence `confidence`, an `operating_status`, a category taxonomy and
 * websites, published as GeoParquet on a public bucket. No key, no metered
 * cost, CDLA-Permissive / Apache / CC0 — a venue name may be stored in a trip,
 * which Google's terms forbid (`.claude-private/BLOCKER-google-terms.md`).
 * Measured over a 1.5 km box: 1.3–3 s and 3–8 MB per box (one row group, one
 * footer), Tenerife, Tokyo, Iceland and Kyrgyzstan alike.
 *
 * What a row may claim is what the source records and no more: hours stay
 * `unknown`, price is inferred from the kind of place, and no dietary claim is
 * made (the source carries none). A row is kept only when the source is fairly
 * sure it exists (`confidence ≥ MIN_CONFIDENCE`) and does not say it is closed.
 */

/** Overture's own guidance puts "probably real" around here; below it, a restaurant is a coin toss. */
export const MIN_OVERTURE_FOOD_CONFIDENCE = 0.7;
const BOX_BYTE_BUDGET = 24_000_000;
const BOX_DEADLINE_MS = 20_000;
const BOX_CONCURRENCY = 4;
const COLUMNS = ['id', 'names', 'confidence', 'operating_status', 'basic_category', 'taxonomy', 'brand', 'websites', 'sources', 'bbox'] as const;

/** Overture's `basic_category` → the food schema's service type. Absent → not a meal venue. */
export const OVERTURE_FOOD_SERVICE: Readonly<Record<string, FoodVenue['serviceType']>> = {
  restaurant: 'restaurant',
  casual_eatery: 'restaurant',
  fast_food_restaurant: 'takeaway',
  cafe: 'cafe',
  coffee_shop: 'cafe',
  bakery: 'bakery',
  food_court: 'food_hall',
};

export interface OvertureFoodRow {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
  serviceType: FoodVenue['serviceType'];
  /** `japanese`, `ramen`, … from the taxonomy leaf; absent when the leaf is just "restaurant". */
  cuisine?: string;
  confidence: number;
  chain: boolean;
  website?: string;
  licenceId: LicenceId;
  /** The newest `update_time` among the row's sources. */
  sourceTimestamp?: string;
}

export interface OvertureFoodBoxResult {
  rows: OvertureFoodRow[];
  bytes: number;
  ms: number;
  cacheHit: boolean;
}

export interface OvertureFoodDeps {
  /** Injected in tests; defaults to the live catalogue + GeoParquet reader. */
  readBox?: (box: BoundingBox, signal: { deadlineMs: number }) => Promise<{ rows: OvertureFoodRow[]; bytes: number }>;
  cache?: { read: (key: string) => OvertureFoodRow[] | null; write: (key: string, rows: OvertureFoodRow[]) => void };
  now?: () => number;
}

/**
 * A listing that is not somewhere to eat: a job advert or a delivery-only
 * kitchen. Words about the *listing*, never a venue's name — a live Bishkek read
 * returned "Вакансии «Империя Пиццы»" ("vacancies at …") as a restaurant.
 */
const NOT_A_MEAL_LEAF = /^(dessert_shop|donut_shop|ice_cream_shop|frozen_yogurt_shop|candy_store|chocolatier|internet_cafe|juice_bar|bubble_tea_shop|convenience_store)$/;

const NOT_A_VENUE = /\b(vacanc(y|ies)|we('| a)re hiring|jobs? at|careers?)\b|вакансии|ваканси[яй]|求人|delivery only|dark kitchen|ghost kitchen/i;

/**
 * The part of a name that stays the same across a chain's branches: no
 * bracketed note, no trailing branch word (`… 新宿東口店`, `… Branch`).
 */
export function chainKey(name: string): string {
  let key = name.normalize('NFKC').replace(/[(（][^)）]*[)）]/g, ' ').trim();
  const parts = key.split(/\s+/);
  if (parts.length > 1 && /(店|branch|filial|sucursal|filiale)$/i.test(parts[parts.length - 1]!)) key = parts.slice(0, -1).join(' ');
  return key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Mark rows as chains where the source did not: the same name three times
 * across the trip's boxes, or twice inside one. Overture leaves `brand` empty
 * for most branches (a live Tokyo read named Saizeriya, Sukiya and Denny's as
 * the "local" picks), and a repeated name is the evidence that is there.
 */
export function markRepeatedNamesAsChains(boxes: readonly (readonly OvertureFoodRow[])[]): OvertureFoodRow[][] {
  const across = new Map<string, number>();
  const within = new Set<string>();
  for (const rows of boxes) {
    const seen = new Map<string, number>();
    for (const row of rows) {
      const key = chainKey(row.name);
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      across.set(key, (across.get(key) ?? 0) + count);
      if (count >= 2) within.add(key);
    }
  }
  return boxes.map((rows) => rows.map((row) => {
    const key = chainKey(row.name);
    return row.chain || (key && (within.has(key) || (across.get(key) ?? 0) >= 3)) ? { ...row, chain: true } : row;
  }));
}

/** A row is a chain when any row in its box carries that name with a brand, or the name appears twice in the box in any category. */
export function markChainsFromBox(rows: readonly OvertureFoodRow[], brandedKeys: ReadonlySet<string>, seenKeys: ReadonlyMap<string, number>): OvertureFoodRow[] {
  return rows.map((row) => {
    const key = chainKey(row.name);
    // A branch name glued to the brand ("丸亀製麺吉祥院店") still starts with it.
    const branded = brandedKeys.has(key) || [...brandedKeys].some((k) => k.length >= 3 && key.startsWith(k));
    return !row.chain && key && (branded || (seenKeys.get(key) ?? 0) >= 2) ? { ...row, chain: true } : row;
  });
}

const LICENCES: Record<string, LicenceId> = {
  'CDLA-Permissive-2.0': 'CDLA-Permissive-2.0',
  'Apache-2.0': 'Apache-2.0',
  'CC0-1.0': 'CC0-1.0',
  'ODbL-1.0': 'ODbL-1.0',
};

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** One Overture place row → a food row, or null when it is not somewhere to eat we can stand behind. */
export function overtureFoodRow(row: Record<string, unknown>): OvertureFoodRow | null {
  const category = typeof row.basic_category === 'string' ? row.basic_category : null;
  let serviceType = category ? OVERTURE_FOOD_SERVICE[category] : undefined;
  if (!serviceType) return null;
  const status = typeof row.operating_status === 'string' ? row.operating_status : null;
  if (status && status !== 'open') return null;
  const confidence = typeof row.confidence === 'number' ? row.confidence : 0;
  if (confidence < MIN_OVERTURE_FOOD_CONFIDENCE) return null;
  const names = row.names as { primary?: unknown } | null | undefined;
  const name = typeof names?.primary === 'string' ? names.primary.trim().replace(/^["'«“]+|["'»”]+$/g, '') : '';
  if (name.length < 2 || name.length > 120) return null;
  if (NOT_A_VENUE.test(name)) return null;
  const coordinates = pointOf(row);
  if (!coordinates) return null;
  const id = typeof row.id === 'string' ? row.id : null;
  if (!id) return null;

  const taxonomy = row.taxonomy as { primary?: unknown; hierarchy?: unknown } | null | undefined;
  const leaf = typeof taxonomy?.primary === 'string' ? taxonomy.primary : '';
  const hierarchy = Array.isArray(taxonomy?.hierarchy) ? taxonomy.hierarchy.filter((h): h is string => typeof h === 'string') : [];
  /*
   * Somewhere for a sweet, not a meal: a donut or ice-cream shop is filed as a
   * "casual eatery", and a live Kyoto plan named Mister Donut for dinner. An
   * internet café is not a café either.
   */
  if ([leaf, ...hierarchy].some((h) => NOT_A_MEAL_LEAF.test(h))) return null;
  if (leaf === 'bakery' || hierarchy.includes('bakery')) serviceType = 'bakery';
  if (leaf === 'delicatessen' || leaf === 'sandwich_shop') serviceType = 'takeaway';
  const cuisine = leaf.endsWith('_restaurant') && leaf !== 'fast_food_restaurant' ? leaf.slice(0, -'_restaurant'.length).replace(/_/g, ' ') : undefined;

  const brand = row.brand as { names?: { primary?: unknown } | null; wikidata?: unknown } | null | undefined;
  const chain = Boolean((typeof brand?.names?.primary === 'string' && brand.names.primary) || (typeof brand?.wikidata === 'string' && brand.wikidata));

  const websites = Array.isArray(row.websites) ? row.websites : [];
  const website = websites.map(httpUrl).find((url): url is string => Boolean(url));

  const sources = Array.isArray(row.sources) ? (row.sources as { license?: unknown; update_time?: unknown; dataset?: unknown }[]) : [];
  const recordSources = sources.filter((s) => s && s.dataset !== 'Overture');
  const licenceId = recordSources.map((s) => (typeof s.license === 'string' ? LICENCES[s.license] : undefined)).find(Boolean) ?? 'CDLA-Permissive-2.0';
  const sourceTimestamp = recordSources
    .map((s) => (typeof s.update_time === 'string' ? s.update_time : ''))
    .filter(Boolean)
    .sort()
    .pop();

  return {
    id,
    name,
    coordinates,
    serviceType,
    ...(cuisine ? { cuisine } : {}),
    confidence,
    chain,
    ...(website ? { website } : {}),
    licenceId,
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
  };
}

/* ---------- live reader ---------- */

let filesPromise: Promise<{ releaseId: string; files: CatalogFile[] }> | null = null;
let filesResolvedAt = 0;
const FILE_LIST_REFRESH_MS = 6 * 60 * 60 * 1000;

const catalogCache: FetchOptions['cache'] = {
  read: (key) => readProviderCache<unknown>(key, new Date()),
  write: (key, value, ttlMs) => writeProviderCache(key, 'overture-catalog', value, ttlMs, new Date()),
};

/** The place files of the current release, resolved once per process (and cached a day in the provider cache). */
function placeFiles(): Promise<{ releaseId: string; files: CatalogFile[] }> {
  if (!filesPromise || Date.now() - filesResolvedAt > FILE_LIST_REFRESH_MS) {
    filesResolvedAt = Date.now();
    filesPromise = (async () => {
      const release = await latestRelease({ cache: catalogCache });
      const files = await themeFiles({ release, theme: 'places', type: 'place', options: { cache: catalogCache } });
      return { releaseId: release.releaseId, files };
    })();
    filesPromise.catch(() => {
      filesPromise = null;
    });
  }
  return filesPromise;
}

async function liveReadBox(box: BoundingBox, limits: { deadlineMs: number }): Promise<{ rows: OvertureFoodRow[]; bytes: number }> {
  const { files } = await placeFiles();
  const counters: ScanCounters = { bytesTransferred: 0, rowGroupsInspected: 0, rowGroupsRead: 0, featuresRead: 0 };
  const rows: OvertureFoodRow[] = [];
  const brandedKeys = new Set<string>();
  const seenKeys = new Map<string, number>();
  for (const file of files.filter((f) => fileIntersects(f, box))) {
    const result = await scanFile({
      url: file.url,
      box,
      columns: COLUMNS,
      requiredColumns: ['id', 'names', 'bbox'],
      reuseFooter: true,
      counters,
      budget: { maxRowGroups: 12, maxBytes: BOX_BYTE_BUDGET, maxFeaturesRead: 400_000, maxFeaturesRetained: 4_000, deadlineMs: limits.deadlineMs },
      accept: (row) => {
        if (!rowPointInBox(row, box)) return null;
        /*
         * Every row in the box, food or not, says whether a name is a chain: a
         * FamilyMart filed as a "restaurant" with no brand sits beside dozens of
         * branded FamilyMart convenience stores. Learned here, applied below.
         */
        const name = (row.names as { primary?: unknown } | null | undefined)?.primary;
        if (typeof name === 'string') {
          const key = chainKey(name);
          const brand = row.brand as { names?: { primary?: unknown } | null; wikidata?: unknown } | null | undefined;
          if (key && ((typeof brand?.names?.primary === 'string' && brand.names.primary) || (typeof brand?.wikidata === 'string' && brand.wikidata))) brandedKeys.add(key);
          if (key) seenKeys.set(key, (seenKeys.get(key) ?? 0) + 1);
        }
        return overtureFoodRow(row);
      },
    });
    rows.push(...result.rows);
  }
  return { rows: markChainsFromBox(rows, brandedKeys, seenKeys), bytes: counters.bytesTransferred };
}

const defaultCache: NonNullable<OvertureFoodDeps['cache']> = {
  read: (key) => readProviderCache<OvertureFoodRow[]>(key, new Date()),
  write: (key, rows) => writeProviderCache(key, 'overture-food', rows, 7 * 24 * 60 * 60 * 1000, new Date()),
};

export function overtureFoodCacheKey(box: BoundingBox): string {
  return ['overture-food', 'v2', MIN_OVERTURE_FOOD_CONFIDENCE, box.south, box.west, box.north, box.east].map((v) => (typeof v === 'number' ? v.toFixed(4) : v)).join('|');
}

/**
 * Read food rows for several small boxes, a few at a time.
 *
 * Each box resolves to its own result or to null (failed / past the deadline) —
 * a box that fails is an absence for that box only. A non-empty answer is cached
 * for a week; an empty one is not, so a transient failure never freezes a
 * region as "nowhere to eat".
 */
export async function fetchOvertureFood(
  boxes: readonly BoundingBox[],
  options: { deadlineMs: number },
  deps: OvertureFoodDeps = {},
): Promise<(OvertureFoodBoxResult | null)[]> {
  const now = deps.now ?? Date.now;
  const readBox = deps.readBox ?? liveReadBox;
  const cache = deps.cache ?? defaultCache;
  const results: (OvertureFoodBoxResult | null)[] = boxes.map(() => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= boxes.length) return;
      const box = boxes[index]!;
      const key = overtureFoodCacheKey(box);
      const cached = cache.read(key);
      if (cached) {
        results[index] = { rows: cached, bytes: 0, ms: 0, cacheHit: true };
        continue;
      }
      const started = now();
      if (started > options.deadlineMs) continue;
      try {
        const read = await readBox(box, { deadlineMs: Math.min(options.deadlineMs, started + BOX_DEADLINE_MS) });
        results[index] = { rows: read.rows, bytes: read.bytes, ms: now() - started, cacheHit: false };
        if (read.rows.length > 0) cache.write(key, read.rows);
      } catch (error) {
        const code = error instanceof ScanError || error instanceof CatalogError ? error.code : 'error';
        console.warn(`Overture food: box ${index + 1}/${boxes.length} not read (${code}) after ${now() - started} ms`, error instanceof Error ? error.message : error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BOX_CONCURRENCY, boxes.length) }, worker));
  return results;
}

/** One food row → a `FoodVenue` (before snapping and schema parsing, which the caller does). */
export function overtureFoodVenue(
  row: OvertureFoodRow,
  target: { regionId: string; destinationName: string; routingId: string; today: string },
): FoodVenue {
  const words: Record<FoodVenue['serviceType'], string> = {
    restaurant: 'A restaurant',
    cafe: 'A café',
    bakery: 'A bakery',
    takeaway: 'A takeaway',
    food_hall: 'A food hall',
    market: 'A market',
    grocery: 'A food shop',
  };
  const periods: Record<FoodVenue['serviceType'], FoodVenue['mealPeriods']> = {
    restaurant: ['lunch', 'dinner'],
    cafe: ['breakfast', 'lunch', 'coffee'],
    bakery: ['breakfast', 'coffee'],
    takeaway: ['lunch', 'dinner'],
    food_hall: ['lunch', 'dinner'],
    market: ['lunch'],
    grocery: ['lunch'],
  };
  const minutes: Record<FoodVenue['serviceType'], number> = { restaurant: 75, cafe: 30, bakery: 20, takeaway: 30, food_hall: 45, market: 45, grocery: 20 };
  return {
    id: `food-overture-${row.id}`,
    regionId: target.regionId,
    name: row.name,
    locality: target.destinationName,
    shortDescription: `${row.cuisine ? `${words[row.serviceType]} (${row.cuisine})` : words[row.serviceType]} listed in open place data for ${target.destinationName}.`,
    coordinates: row.coordinates,
    tags: [`overture:${row.serviceType}`],
    source: {
      name: 'Overture Maps',
      kind: 'overture',
      ...(row.website ? { url: row.website } : {}),
      confidence: Math.min(0.8, Math.round(row.confidence * 0.8 * 100) / 100),
      lastVerified: target.today,
      element: {
        elementId: row.id,
        database: 'overture',
        licenceId: row.licenceId,
        ...(row.sourceTimestamp ? { sourceTimestamp: row.sourceTimestamp } : {}),
      },
    },
    serviceType: row.serviceType,
    mealPeriods: periods[row.serviceType],
    cuisines: row.cuisine ? [row.cuisine] : [],
    priceBand: row.serviceType === 'restaurant' || row.serviceType === 'food_hall' ? 'moderate' : 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: minutes[row.serviceType],
    reservation: { requirement: 'unknown' },
    takeaway: 'unknown',
    provisioning: 'none',
    dietary: [],
    hours: {
      kind: 'unknown',
      hoursConfidence: 'unverified',
      note: 'Nobody publishes hours for this that we could read.',
      provenance: {
        kind: 'estimated',
        sourceName: 'Overture Maps',
        confidence: 0.3,
        volatility: 'dynamic',
        recheckNote: 'We have no confirmed hours for this. Check before you go.',
      },
    },
    routingId: target.routingId,
    walkMinutesFromRouting: 0,
  };
}
