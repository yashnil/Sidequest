import 'server-only';
import { haversineKm, isNotAProperty, lodgingTypeFromName, nameSaysHotSpring, type LodgingAmenity, type LodgingLicence, type LodgingPropertyCandidate, type LodgingPropertyType } from '@sidequest/core';
import { readProviderCache, writeProviderCache } from '../../db/compiler-repository';
import { fileIntersects, latestRelease, themeFiles, type CatalogFile, type FetchOptions } from '../overture/catalog';
import { pointOf, rowPointInBox, scanFile, type BoundingBox, type ScanCounters } from '../overture/scan';

/**
 * OVERTURE LODGING — NAMED PLACES TO STAY FROM THE OPEN PLACE FILES.
 *
 * The same keyless GeoParquet reader the scan's food uses (`overture-food.ts`),
 * pointed at the `lodging` branch of Overture's taxonomy. Licences are
 * CDLA-Permissive-2.0 (Meta, Microsoft), Apache-2.0 (Foursquare) or CC0
 * (AllThePlaces); each row keeps its own.
 *
 * What a row may claim is what it records: a name, a position, a category, a
 * website, a town. Overture carries no amenities, so the only one read here is
 * a hot spring the property's own *name* states (温泉, "Onsen") — labelled as
 * such — and the public hot springs Overture lists nearby, which are attached
 * to its own rows only. A row is kept when the source is fairly sure it exists
 * (`confidence ≥ 0.7`) and does not say it is closed.
 */

export const MIN_OVERTURE_LODGING_CONFIDENCE = 0.7;
const BOX_BYTE_BUDGET = 40_000_000;
const BOX_DEADLINE_MS = 25_000;
const COLUMNS = ['id', 'names', 'confidence', 'operating_status', 'basic_category', 'taxonomy', 'websites', 'sources', 'addresses', 'bbox'] as const;

/** Overture's lodging leaves → the property type. A leaf not listed but under `lodging` is `other`. */
export const OVERTURE_LODGING_TYPE: Readonly<Record<string, LodgingPropertyType>> = {
  hotel: 'hotel',
  motel: 'motel',
  inn: 'inn',
  hostel: 'hostel',
  bed_and_breakfast: 'bed_and_breakfast',
  guest_house: 'guesthouse',
  cottage: 'cottage',
  cabin: 'cottage',
  chalet: 'cottage',
  resort: 'resort',
  beach_resort: 'resort',
  holiday_rental_home: 'holiday_rental',
  private_lodging: 'holiday_rental',
  vacation_rental: 'holiday_rental',
  apartment: 'apartment',
  serviced_apartment: 'apartment',
  campground: 'campsite',
  rv_park: 'campsite',
  mountain_hut: 'mountain_hut',
  ryokan: 'ryokan',
  lodge: 'lodge',
  lodging: 'other',
};

/** Generic source categories a name may refine ("inn" + 旅館 → ryokan). A specific one (hostel, campsite) stands. */
const REFINABLE: ReadonlySet<LodgingPropertyType> = new Set(['hotel', 'inn', 'other', 'guesthouse', 'bed_and_breakfast', 'hostel', 'lodge']);

const HOT_SPRING_LEAF = /^(hot_springs?|onsen|public_bath|bathhouse)$/;

const LICENCES: Record<string, LodgingLicence> = {
  'CDLA-Permissive-2.0': 'CDLA-Permissive-2.0',
  'Apache-2.0': 'Apache-2.0',
  'CC0-1.0': 'CC0-1.0',
};

export interface OvertureHotSpring {
  name: string;
  coordinates: { lat: number; lng: number };
}

export interface OvertureLodgingBox {
  candidates: LodgingPropertyCandidate[];
  hotSprings: OvertureHotSpring[];
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^["'«“]+|["'»”]+$/g, '').replace(/\s+/g, ' ') : '';
}

function taxonomyOf(row: Record<string, unknown>): { category: string | null; leaf: string; hierarchy: string[] } {
  const category = typeof row.basic_category === 'string' ? row.basic_category : null;
  const taxonomy = row.taxonomy as { primary?: unknown; hierarchy?: unknown } | null | undefined;
  const leaf = typeof taxonomy?.primary === 'string' ? taxonomy.primary : '';
  const hierarchy = Array.isArray(taxonomy?.hierarchy) ? taxonomy.hierarchy.filter((h): h is string => typeof h === 'string') : [];
  return { category, leaf, hierarchy };
}

function usable(row: Record<string, unknown>): boolean {
  const status = typeof row.operating_status === 'string' ? row.operating_status : null;
  if (status && status !== 'open') return false;
  const confidence = typeof row.confidence === 'number' ? row.confidence : 0;
  return confidence >= MIN_OVERTURE_LODGING_CONFIDENCE;
}

/** A public hot spring Overture lists, or null. Used only beside Overture's own lodging rows. */
export function overtureHotSpring(row: Record<string, unknown>): OvertureHotSpring | null {
  const { category, leaf } = taxonomyOf(row);
  if (!HOT_SPRING_LEAF.test(leaf) && !HOT_SPRING_LEAF.test(category ?? '')) return null;
  if (!usable(row)) return null;
  const name = cleanName((row.names as { primary?: unknown } | null | undefined)?.primary);
  const coordinates = pointOf(row);
  if (name.length < 2 || !coordinates) return null;
  return { name, coordinates };
}

/** One Overture place row → a lodging candidate, or null when it is not a place to stay we can stand behind. */
export function overtureLodgingRow(row: Record<string, unknown>): LodgingPropertyCandidate | null {
  const { category, leaf, hierarchy } = taxonomyOf(row);
  const inLodging = hierarchy[0] === 'lodging' || (category !== null && category in OVERTURE_LODGING_TYPE) || leaf in OVERTURE_LODGING_TYPE;
  if (!inLodging) return null;
  if (!usable(row)) return null;
  const names = row.names as { primary?: unknown; common?: unknown } | null | undefined;
  const name = cleanName(names?.primary);
  if (name.length < 2 || name.length > 120 || isNotAProperty(name)) return null;
  const coordinates = pointOf(row);
  const id = typeof row.id === 'string' ? row.id : null;
  if (!coordinates || !id) return null;

  const common = names?.common && typeof names.common === 'object' ? (names.common as Record<string, unknown>) : {};
  const english = cleanName(common.en);
  const sourceType = OVERTURE_LODGING_TYPE[leaf] ?? OVERTURE_LODGING_TYPE[category ?? ''] ?? 'other';
  const named = REFINABLE.has(sourceType) ? lodgingTypeFromName(name) ?? (english ? lodgingTypeFromName(english) : null) : null;
  const type = named ?? sourceType;

  const amenities: LodgingAmenity[] = [];
  if (nameSaysHotSpring(name) || (english && nameSaysHotSpring(english))) amenities.push({ kind: 'onsen', value: 'yes', basis: 'name' });

  const websites = Array.isArray(row.websites) ? row.websites : [];
  const website = websites.map(httpUrl).find((url): url is string => Boolean(url));
  const addresses = Array.isArray(row.addresses) ? (row.addresses as { locality?: unknown }[]) : [];
  const rawLocality = cleanName(addresses[0]?.locality);
  const locality = rawLocality && rawLocality === rawLocality.toUpperCase() && /\p{Lu}/u.test(rawLocality) ? rawLocality.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m) => m.toUpperCase()) : rawLocality;
  const sources = Array.isArray(row.sources) ? (row.sources as { license?: unknown; dataset?: unknown }[]) : [];
  const licence = sources.filter((s) => s && s.dataset !== 'Overture').map((s) => (typeof s.license === 'string' ? LICENCES[s.license] : undefined)).find(Boolean) ?? 'CDLA-Permissive-2.0';
  const confidence = typeof row.confidence === 'number' ? Math.round(row.confidence * 1000) / 1000 : undefined;

  return {
    source: 'overture',
    sourceId: `overture:${id}`,
    name,
    ...(english && english !== name ? { altName: english } : {}),
    coordinates,
    type,
    typeBasis: named ? 'name' : 'category',
    amenities,
    ...(website ? { website } : {}),
    ...(locality ? { locality } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    licence,
    attribution: licence === 'Apache-2.0' ? 'Overture Maps Foundation · includes Foursquare data (Apache-2.0)' : 'Overture Maps Foundation',
  };
}

/** Attach the nearest public hot spring from the same box (same source) within 600 m. */
export function withNearbyHotSprings(box: OvertureLodgingBox): LodgingPropertyCandidate[] {
  return box.candidates.map((candidate) => {
    let best: { name: string; metres: number } | null = null;
    for (const spring of box.hotSprings) {
      const metres = Math.round(haversineKm(candidate.coordinates, spring.coordinates) * 1000);
      if (metres <= 600 && (!best || metres < best.metres) && spring.name !== candidate.name) best = { name: spring.name, metres };
    }
    return best ? { ...candidate, nearbyHotSpring: best } : candidate;
  });
}

/* ---------- live reader ---------- */

let filesPromise: Promise<CatalogFile[]> | null = null;
let filesResolvedAt = 0;
const FILE_LIST_REFRESH_MS = 6 * 60 * 60 * 1000;

const catalogCache: FetchOptions['cache'] = {
  read: (key) => readProviderCache<unknown>(key, new Date()),
  write: (key, value, ttlMs) => writeProviderCache(key, 'overture-catalog', value, ttlMs, new Date()),
};

function placeFiles(options: FetchOptions): Promise<CatalogFile[]> {
  if (!filesPromise || Date.now() - filesResolvedAt > FILE_LIST_REFRESH_MS) {
    filesResolvedAt = Date.now();
    filesPromise = (async () => {
      const release = await latestRelease(options);
      return themeFiles({ release, theme: 'places', type: 'place', options });
    })();
    filesPromise.catch(() => {
      filesPromise = null;
    });
  }
  return filesPromise;
}

export async function liveReadLodgingBox(box: BoundingBox, limits: { deadlineMs: number; catalog?: FetchOptions }): Promise<OvertureLodgingBox & { bytes: number }> {
  const files = await placeFiles(limits.catalog ?? { cache: catalogCache });
  const counters: ScanCounters = { bytesTransferred: 0, rowGroupsInspected: 0, rowGroupsRead: 0, featuresRead: 0 };
  const candidates: LodgingPropertyCandidate[] = [];
  const hotSprings: OvertureHotSpring[] = [];
  for (const file of files.filter((f) => fileIntersects(f, box))) {
    await scanFile({
      url: file.url,
      box,
      columns: COLUMNS,
      requiredColumns: ['id', 'names', 'bbox'],
      reuseFooter: true,
      counters,
      budget: { maxRowGroups: 16, maxBytes: BOX_BYTE_BUDGET, maxFeaturesRead: 600_000, maxFeaturesRetained: 2_000, deadlineMs: limits.deadlineMs },
      accept: (row) => {
        if (!rowPointInBox(row, box)) return null;
        const lodging = overtureLodgingRow(row);
        if (lodging) {
          candidates.push(lodging);
          return true;
        }
        const spring = overtureHotSpring(row);
        if (spring) {
          hotSprings.push(spring);
          return true;
        }
        return null;
      },
    });
  }
  return { candidates, hotSprings, bytes: counters.bytesTransferred };
}

export interface OvertureLodgingDeps {
  readBox?: (box: BoundingBox, limits: { deadlineMs: number }) => Promise<OvertureLodgingBox & { bytes?: number }>;
  cache?: { read: (key: string) => OvertureLodgingBox | null; write: (key: string, value: OvertureLodgingBox) => void };
  now?: () => number;
}

const defaultCache: NonNullable<OvertureLodgingDeps['cache']> = {
  read: (key) => readProviderCache<OvertureLodgingBox>(key, new Date()),
  write: (key, value) => writeProviderCache(key, 'overture-lodging', value, 7 * 24 * 60 * 60 * 1000, new Date()),
};

export function overtureLodgingCacheKey(box: BoundingBox): string {
  return ['overture-lodging', 'v1', MIN_OVERTURE_LODGING_CONFIDENCE, box.south, box.west, box.north, box.east].map((v) => (typeof v === 'number' ? v.toFixed(4) : v)).join('|');
}

/**
 * One box of lodging rows, cached a week when non-empty (an empty answer is not
 * cached, so a transient failure never freezes a place as "nowhere to stay").
 * Throws on a failed read; the caller turns that into an absence.
 */
export async function fetchOvertureLodging(box: BoundingBox, deps: OvertureLodgingDeps = {}): Promise<{ candidates: LodgingPropertyCandidate[]; cacheHit: boolean }> {
  const cache = deps.cache ?? defaultCache;
  const key = overtureLodgingCacheKey(box);
  const cached = cache.read(key);
  if (cached) return { candidates: withNearbyHotSprings(cached), cacheHit: true };
  const now = deps.now ?? Date.now;
  const read = await (deps.readBox ?? liveReadLodgingBox)(box, { deadlineMs: now() + BOX_DEADLINE_MS });
  const value: OvertureLodgingBox = { candidates: read.candidates, hotSprings: read.hotSprings };
  if (value.candidates.length > 0) cache.write(key, value);
  return { candidates: withNearbyHotSprings(value), cacheHit: false };
}
