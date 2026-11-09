import 'server-only';
import {
  FOOD_DATASET_VERSION,
  MODELLED_WALK_KMH,
  foodVenueSchema,
  genericNameTokens,
  haversineKm,
  localCuisines,
  sameVenue,
  snapFoodRouting,
  type DietaryClaim,
  type DietaryNeed,
  type FoodDataset,
  type FoodVenue,
  type PriceBand,
  type ScanFoodArea,
  type ScanPoint,
  type ScanFoodSource,
} from '@sidequest/core';
import { fetchMealPois, normalizeElement, type BoundingBox, type OverpassOptions, type OverpassResult } from '../providers/overpass';
import { osmFoodVenue } from '../providers/osm-food';
import { cacheFor, TTL } from '../providers/open-verification';
import { geocode } from '../providers/nominatim';
import { fetchOvertureFood, markRepeatedNamesAsChains, overtureFoodVenue, type OvertureFoodRow } from '../providers/overture-food';
import { isPoiProviderEnabled } from '../providers/switches';

/**
 * V1 CONVERGENCE — SOMEWHERE REAL TO EAT, FROM OPEN MAP DATA.
 *
 * The scan proposes places and food *areas*; it never had venues, so every
 * meal was intent prose. This step asks open place data — Overture's place
 * files first, OpenStreetMap (Overpass) only for boxes Overture leaves thin
 * (release pass, 2026-11; see `groundScanFood`) — for the
 * restaurants, cafés and takeaways in a few small boxes — around the bases,
 * the food areas the proposal named, and the densest clusters of things to
 * do — and keeps each one only when it is within a door walk of a point the
 * scan's travel-time matrix already holds (`snapFoodRouting`, exactly the
 * compiler's rule), so a meal's detour is priced against a real row and the
 * matrix never grows.
 *
 * What a venue may claim is what the map records and no more: hours stay
 * `unknown`, the price band is inferred from the kind of place and says so,
 * dietary support comes only from explicit `diet:*` tags (and a `diet:*=no`
 * tag is kept as a reason *not* to name it for that diet).
 *
 * Bounded and polite: ≤ 8 boxes of ~1.5 km, ≤ 60 venues, a stage deadline and
 * the provider cache throughout; Overture boxes four at a time over ranged
 * reads; Overpass sequential through the client's own spacing gate, one
 * selector group per box, eight seconds a request, twelve in all, and a stop
 * after two boxes in a row are refused (the public Overpass policy). A
 * failure is an absence: the region simply has no food data and every meal
 * stays an honest intent. The scan never fails for food.
 */

/*
 * Food-pass (2026-11): 8 boxes and 60 venues covered 54% of the scan points with
 * food around them on the recorded corpus. Overture reads four boxes at a time
 * in 1.3–3 s each, so sixteen boxes stay inside the stage budget.
 */
export const MAX_FOOD_BOXES = 16;
export const MAX_FOOD_VENUES = 120;
/** A base feeds several dinners; everywhere else feeds one lunch. */
const BASE_BOX_VENUES = 16;
/** Shops are kept apart from the meal allowance: one per box is all a remote day needs. */
const SHOPS_PER_BOX = 3;
const MAX_CHAINS_PER_BOX = 2;
/** How far from a box centre its answer speaks for: the box's own corner, near enough. */
const SEARCHED_RADIUS_KM = 1;
/** Half the side of a box. 0.75 km keeps nearly every venue inside the 1.5 km door walk of the point it was drawn around. */
export const FOOD_BOX_HALF_KM = 0.75;
const FOOD_STAGE_BUDGET_MS = 40_000;
/** Two box centres closer than this would ask Overpass for mostly the same venues. */
const MIN_BOX_SEPARATION_KM = 1.2;
/** A food area further than this from every scan point cannot yield a venue the matrix can price. */
const FOOD_AREA_REACH_KM = 2;
const MAX_FOOD_AREAS = 3;
const MAX_BASE_BOXES = 5;
const CONSECUTIVE_FAILURES_BEFORE_STOPPING = 2;

export type ScanFoodStatus = 'grounded' | 'partial' | 'empty' | 'unavailable' | 'disabled' | 'fixture';

export interface ScanFoodGrounding {
  /** Null when nothing usable came back — the region then has no food data, which is unknown, never "no food". */
  dataset: FoodDataset | null;
  status: ScanFoodStatus;
  source: ScanFoodSource;
  providerName?: string;
  /** Where the time went, for the scan's diagnostics. */
  timings?: { overtureMs: number; overtureBytes: number; overtureVenues: number; osmVenues: number; overpassBoxes: number; totalMs: number; farFromBox: number };
  boxes: number;
  failedBoxes: number;
  calls: number;
  /** Venues the map returned that no scan point was within a door walk of. */
  unroutable: number;
  detail: string;
}

export interface FoodBox {
  center: { lat: number; lng: number };
  label: string;
  kind: 'base' | 'food_area' | 'cluster';
}

/** A ~1.5 km box around a point. */
export function foodBoxAround(center: { lat: number; lng: number }): BoundingBox {
  const dLat = FOOD_BOX_HALF_KM / 111;
  const dLng = FOOD_BOX_HALF_KM / (111 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return { south: center.lat - dLat, north: center.lat + dLat, west: center.lng - dLng, east: center.lng + dLng };
}

/**
 * Where to look, in priority order: the bases (where most dinners happen),
 * the food areas the proposal named that sit near a scan point, then the
 * places with the most other places around them (where lunch falls). Box
 * centres closer than `MIN_BOX_SEPARATION_KM` are merged into the first.
 */
export function planFoodBoxes(input: {
  points: readonly ScanPoint[];
  foodAreas: readonly { name: string; coordinates: { lat: number; lng: number } }[];
  maxBoxes?: number;
}): FoodBox[] {
  const maxBoxes = input.maxBoxes ?? MAX_FOOD_BOXES;
  const boxes: FoodBox[] = [];
  const tryAdd = (box: FoodBox): void => {
    if (boxes.length >= maxBoxes) return;
    if (boxes.some((b) => haversineKm(b.center, box.center) < MIN_BOX_SEPARATION_KM)) return;
    boxes.push(box);
  };
  for (const base of input.points.filter((p) => p.kind === 'base').slice(0, MAX_BASE_BOXES)) {
    tryAdd({ center: base.coordinates, label: base.name, kind: 'base' });
  }
  for (const area of input.foodAreas.slice(0, MAX_FOOD_AREAS)) {
    const nearest = Math.min(...input.points.map((p) => haversineKm(p.coordinates, area.coordinates)));
    if (Number.isFinite(nearest) && nearest <= FOOD_AREA_REACH_KM) tryAdd({ center: area.coordinates, label: area.name, kind: 'food_area' });
  }
  const places = input.points.filter((p) => p.kind === 'place');
  const dense = places
    .map((p, index) => ({ p, index, neighbours: places.filter((q) => q !== p && haversineKm(p.coordinates, q.coordinates) <= 2).length }))
    .sort((a, b) => b.neighbours - a.neighbours || a.index - b.index);
  for (const { p } of dense) tryAdd({ center: p.coordinates, label: p.name, kind: 'cluster' });
  return boxes;
}

/** Inferred from the kind of place, never read off a menu; `priceEvidence: format_inferred` says so on screen. */
const SCAN_PRICE_BY_SERVICE: Record<FoodVenue['serviceType'], PriceBand> = {
  restaurant: 'moderate',
  food_hall: 'budget',
  takeaway: 'budget',
  cafe: 'budget',
  bakery: 'budget',
  market: 'budget',
  grocery: 'budget',
};

const DIET_TAG_NEEDS: readonly [string, DietaryNeed][] = [
  ['diet:vegetarian', 'vegetarian'],
  ['diet:vegan', 'vegan'],
  ['diet:gluten_free', 'gluten_free'],
  ['diet:halal', 'halal'],
  ['diet:kosher', 'kosher'],
];

export interface GroundScanFoodInput {
  regionId: string;
  destinationName: string;
  points: readonly ScanPoint[];
  foodAreas: readonly ScanFoodArea[];
  center: { lat: number; lng: number };
  maxDistanceKm: number;
  countryCode?: string;
  countryName?: string;
  /** ISO date for `lastVerified`. */
  today: string;
}

export interface GroundScanFoodDeps {
  fetchMeals?: (box: BoundingBox, options: OverpassOptions) => Promise<OverpassResult>;
  /** Null when no geocoder is configured; food areas are then simply not boxed. */
  geocodeArea?: ((query: string) => Promise<{ lat: number; lng: number; countryCode?: string } | null>) | null;
  now?: () => number;
  cache?: OverpassOptions['cache'];
  /** Overture reader. Undefined → the live one when `overtureFoodEnabled()`; null → not asked. */
  overture?: typeof fetchOvertureFood | null;
  /** Whether Overpass may fill thin boxes. Defaults to: a reader was injected, or the POI provider is on. */
  overpass?: boolean;
}

async function defaultGeocodeArea(query: string): Promise<{ lat: number; lng: number; countryCode?: string } | null> {
  const result = await geocode(query, { limit: 3 });
  const first = result.places[0];
  if (!first) return null;
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const countryCode = first.address?.country_code?.toUpperCase();
  return { lat, lng, ...(countryCode ? { countryCode } : {}) };
}

async function placeFoodAreas(input: GroundScanFoodInput, geocodeArea: NonNullable<GroundScanFoodDeps['geocodeArea']>, deadline: () => boolean) {
  const placed: { name: string; coordinates: { lat: number; lng: number } }[] = [];
  const country = input.countryName ? `, ${input.countryName}` : '';
  for (const area of input.foodAreas.slice(0, MAX_FOOD_AREAS)) {
    if (deadline()) break;
    try {
      const hit = await geocodeArea(`${area.name}, ${area.locality}${country}`);
      if (!hit) continue;
      if (input.countryCode && hit.countryCode && hit.countryCode !== input.countryCode.toUpperCase()) continue;
      const point = { lat: hit.lat, lng: hit.lng };
      if (haversineKm(input.center, point) > input.maxDistanceKm) continue;
      placed.push({ name: area.name, coordinates: point });
    } catch {
      /* a geocoder failure is an absence */
    }
  }
  return placed;
}

/** Venues to aim for per box from the first source before a second is asked to fill in. */
export const THIN_BOX_VENUES = 4;
/** A hung Overpass instance costs this, not the client's default 25 s. */
const OVERPASS_SUPPLEMENT_TIMEOUT_MS = 8_000;
/** The whole supplement's allowance once Overture has answered: a filler is never worth the scan's patience. */
const OVERPASS_SUPPLEMENT_BUDGET_MS = 12_000;

/**
 * Which order to name venues in, within one box: independents over chains where
 * there are a few independents, then the source's
 * own confidence, nudged by a published website (somebody can check the menu).
 * `mixByMeal` then interleaves meals and coffee.
 */
function rankOverture(rows: readonly OvertureFoodRow[]): OvertureFoodRow[] {
  const quality = (r: OvertureFoodRow) => r.confidence + (r.website ? 0.05 : 0) - (r.pub ? 0.05 : 0) + (r.dietary ? 1 : 0);
  const sorted = [...rows].sort((a, b) => quality(b) - quality(a) || a.name.localeCompare(b.name));
  const locals = sorted.filter((r) => !r.chain);
  const chains = sorted.filter((r) => r.chain);
  /*
   * Independents first; a chain stays in the running rather than being deleted,
   * because the meal step may find it is materially the practical choice. Only
   * a few per box where independents abound, so they cannot crowd the list.
   */
  return [...locals, ...(locals.length >= MIN_LOCAL_VENUES ? chains.slice(0, MAX_CHAINS_PER_BOX) : chains)];
}

/** Take one venue per cuisine in turn, so a box's share is not eight of the same thing. Order within a cuisine is the rank. */
function diversifyByCuisine(rows: readonly OvertureFoodRow[], local: ReadonlySet<string>): OvertureFoodRow[] {
  const groups = new Map<string, OvertureFoodRow[]>();
  for (const row of rows) {
    if (row.chain) continue;
    const key = row.cuisine ?? '';
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // Stable sort: the cuisines this ground has unusually much of go round first, the rest in rank order.
  const queues = [...groups.entries()].sort(([a], [b]) => Number(local.has(b)) - Number(local.has(a))).map(([, list]) => [...list]);
  const out: OvertureFoodRow[] = [];
  while (queues.some((queue) => queue.length > 0)) for (const queue of queues) if (queue.length > 0) out.push(queue.shift()!);
  return [...out, ...rows.filter((row) => row.chain)];
}

/**
 * Interleave sit-down meals and coffee so a box's share is not all cafés (or all
 * restaurants): roughly two meals for every café.
 */
function mixByMeal(rows: readonly OvertureFoodRow[], local: ReadonlySet<string> = new Set()): OvertureFoodRow[] {
  const allMeals = rows.filter((r) => r.serviceType === 'restaurant' || r.serviceType === 'food_hall' || r.serviceType === 'takeaway');
  const meals = diversifyByCuisine(allMeals, local);
  const light = rows.filter((r) => !allMeals.includes(r));
  const out: OvertureFoodRow[] = [];
  while (meals.length > 0 || light.length > 0) {
    for (let k = 0; k < 2 && meals.length > 0; k += 1) out.push(meals.shift()!);
    if (light.length > 0) out.push(light.shift()!);
  }
  return out;
}

/** Overture first unless the deployment pins food to Overpass or turns it off. */
export function overtureFoodEnabled(): boolean {
  const choice = process.env.SIDEQUEST_FOOD_PROVIDER?.trim().toLowerCase();
  return choice !== 'off' && choice !== 'overpass';
}

/**
 * Ground the scan's meals in real venues. Never throws: every failure becomes a
 * status and a sentence for the coverage report.
 *
 * Release pass (2026-11) — two sources, in order. Overture's open place files
 * answer every box in parallel in a few seconds (`providers/overture-food.ts`);
 * the public Overpass instances, which used to be the only source, were measured
 * timing out at 25–30 s per box and left three of five live scans with no food
 * at all. Overpass is now a bounded supplement: asked only for boxes Overture
 * left thin (fewer than `THIN_BOX_VENUES`), only when the POI provider is
 * switched on, one request at a time, each capped at eight seconds.
 */
export async function groundScanFood(input: GroundScanFoodInput, deps: GroundScanFoodDeps = {}): Promise<ScanFoodGrounding> {
  const now = deps.now ?? Date.now;
  const started = now();
  const stageDeadline = started + FOOD_STAGE_BUDGET_MS;
  const deadline = () => now() > stageDeadline;
  const fetchMeals = deps.fetchMeals ?? fetchMealPois;
  const cache = deps.cache ?? cacheFor<OverpassResult>('overpass-food', TTL.poi);
  const anchors = input.points.map((p) => ({ id: p.id, coordinates: p.coordinates }));
  const useOverture = deps.overture === undefined ? overtureFoodEnabled() : deps.overture !== null;
  const useOverpass = deps.overpass ?? (deps.fetchMeals !== undefined || isPoiProviderEnabled());

  let foodAreas: { name: string; coordinates: { lat: number; lng: number } }[] = [];
  const geocodeArea = deps.geocodeArea === undefined ? defaultGeocodeArea : deps.geocodeArea;
  if (geocodeArea && input.foodAreas.length > 0) foodAreas = await placeFoodAreas(input, geocodeArea, deadline);

  const boxes = planFoodBoxes({ points: input.points, foodAreas });
  const evenShare = Math.max(8, Math.ceil(MAX_FOOD_VENUES / Math.max(1, boxes.length)));
  const perBoxOf = (index: number) => (boxes[index]!.kind === 'base' ? Math.max(evenShare, BASE_BOX_VENUES) : evenShare);
  const venues: FoodVenue[] = [];
  const keptPerBox = boxes.map(() => 0);
  const seenIds = new Set<string>();
  let unroutable = 0;
  let farFromBox = 0;
  let osmEvidenceMerged = 0;
  /** Box index → places to eat its answer held, whether or not they were kept. An unanswered box is absent, never zero. */
  const answered = new Map<number, number>();
  let generic: ReadonlySet<string> = new Set();

  /** Snap, dedupe and parse one built venue into box `index`. Returns whether it was kept. */
  const admit = (index: number, built: FoodVenue | null, snap: { routingId: string; walkMinutesFromRouting: number }, extraDietary: DietaryClaim[] = []): boolean => {
    if (!built || seenIds.has(built.id)) return false;
    // The same venue twice (a node and its building, or one venue in both sources). What the second record knows that the first does not is kept.
    const twin = venues.findIndex((v) => sameVenue(v, built, generic));
    if (twin >= 0) {
      const kept = venues[twin]!;
      const dietary = [...kept.dietary, ...built.dietary, ...extraDietary].filter((claim, i, all) => all.findIndex((c) => c.need === claim.need) === i);
      const gainsHours = kept.hours.kind === 'unknown' && built.hours.kind !== 'unknown';
      const gainsCuisine = kept.cuisines.length === 0 && built.cuisines.length > 0;
      if (gainsHours || gainsCuisine || dietary.length > kept.dietary.length) {
        venues[twin] = { ...kept, dietary, ...(gainsHours ? { hours: built.hours } : {}), ...(gainsCuisine ? { cuisines: built.cuisines } : {}) };
        if (built.source.kind === 'osm') osmEvidenceMerged += 1;
      }
      return false;
    }
    const parsed = foodVenueSchema.safeParse({
      ...built,
      priceBand: SCAN_PRICE_BY_SERVICE[built.serviceType],
      dietary: [...built.dietary, ...extraDietary],
      routingId: snap.routingId,
      walkMinutesFromRouting: snap.walkMinutesFromRouting,
    });
    if (!parsed.success) return false;
    seenIds.add(built.id);
    venues.push(parsed.data);
    keptPerBox[index]! += 1;
    return true;
  };

  /* ---- 1. Overture, every box at once ---- */
  let overtureBoxesAnswered = 0;
  let overtureVenues = 0;
  let overtureBytes = 0;
  let overtureMs = 0;
  if (useOverture && boxes.length > 0) {
    const results = await (deps.overture ?? fetchOvertureFood)(boxes.map((b) => foodBoxAround(b.center)), { deadlineMs: stageDeadline - 8_000 });
    const marked = markRepeatedNamesAsChains(results.map((r) => r?.rows ?? []));
    const allRows = marked.flat();
    generic = genericNameTokens(allRows.map((row) => row.name));
    const local = localCuisines([...new Map(allRows.map((row) => [row.id, row])).values()].flatMap((row) => (row.cuisine && !row.shop ? [row.cuisine] : [])));
    const consider = (index: number, row: OvertureFoodRow): boolean => {
      if (haversineKm(row.coordinates, boxes[index]!.center) > FOOD_BOX_HALF_KM * 1.5) {
        farFromBox += 1;
        return false;
      }
      const snap = snapFoodRouting({ coordinates: row.coordinates, anchors, walkKmh: MODELLED_WALK_KMH });
      if (!snap) {
        unroutable += 1;
        return false;
      }
      return admit(index, overtureFoodVenue(row, { regionId: input.regionId, destinationName: input.destinationName, routingId: snap.routingId, today: input.today, localCuisine: local }), snap);
    };
    results.forEach((result, index) => {
      if (!result) return;
      overtureBoxesAnswered += 1;
      overtureBytes += result.bytes;
      overtureMs = Math.max(overtureMs, result.ms);
      const eateries = marked[index]!.filter((row) => !row.shop);
      answered.set(index, eateries.length);
      for (const row of mixByMeal(rankOverture(eateries), local)) {
        if (keptPerBox[index]! >= perBoxOf(index) || venues.length >= MAX_FOOD_VENUES) break;
        if (consider(index, row)) overtureVenues += 1;
      }
      // Shops sit outside the meal allowance: full groceries first, the most certain of each kind.
      const shops = marked[index]!.filter((row) => row.shop).sort((a, b) => Number(a.shop === 'convenience') - Number(b.shop === 'convenience') || b.confidence - a.confidence || a.name.localeCompare(b.name));
      let shopsKept = 0;
      for (const row of shops) {
        if (shopsKept >= SHOPS_PER_BOX) break;
        if (consider(index, row)) {
          shopsKept += 1;
          overtureVenues += 1;
          keptPerBox[index]! -= 1;
        }
      }
    });
  }

  /* ---- 2. Overpass, only where Overture left a box thin ---- */
  let calls = 0;
  let attempted = 0;
  let failedBoxes = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;
  let osmVenues = 0;
  const thin = boxes.map((_, index) => index).filter((index) => !useOverture || keptPerBox[index]! < THIN_BOX_VENUES);
  const supplementDeadline = useOverture ? Math.min(stageDeadline, now() + OVERPASS_SUPPLEMENT_BUDGET_MS) : stageDeadline;
  if (useOverpass) {
    for (const index of thin) {
      const box = boxes[index]!;
      if (venues.length >= MAX_FOOD_VENUES) break;
      if (now() > supplementDeadline || consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_STOPPING) {
        stoppedEarly = true;
        break;
      }
      attempted += 1;
      let result: OverpassResult;
      try {
        result = await fetchMeals(foodBoxAround(box.center), { limit: perBoxOf(index) * 3, retries: 0, deadlineMs: supplementDeadline, cache, requestTimeoutMs: Math.max(1_000, Math.min(OVERPASS_SUPPLEMENT_TIMEOUT_MS, supplementDeadline - now())) });
        calls += result.calls;
        consecutiveFailures = 0;
        if (result.failedGroups.length > 0) failedBoxes += 1;
      } catch {
        failedBoxes += 1;
        consecutiveFailures += 1;
        continue;
      }
      /*
       * Local places first. Chains (OSM `brand` / `brand:wikidata`) stay in the
       * running, a couple per box where independents abound, because a chain can
       * be materially the practical choice; the meal step weighs that.
       */
      const locals = result.elements.filter((element) => !isChain(element));
      const brandedElements = result.elements.filter((element) => isChain(element));
      answered.set(index, (answered.get(index) ?? 0) + result.elements.filter((element) => element.tags?.amenity !== 'bar').length);
      const candidates = [...locals, ...(locals.length >= MIN_LOCAL_VENUES ? brandedElements.slice(0, MAX_CHAINS_PER_BOX) : brandedElements)];
      for (const element of candidates) {
        if (keptPerBox[index]! >= perBoxOf(index) || venues.length >= MAX_FOOD_VENUES) break;
        const normalized = normalizeElement(element);
        if (!normalized) continue;
        // A bar is somewhere to drink, not a meal the plan can promise.
        if (normalized.primaryTag === 'amenity=bar') continue;
        const snap = snapFoodRouting({ coordinates: normalized.coordinates, anchors, walkKmh: MODELLED_WALK_KMH });
        if (!snap) {
          unroutable += 1;
          continue;
        }
        const unsuitable: DietaryClaim[] = DIET_TAG_NEEDS.filter(([tag]) => normalized.planningTags[tag] === 'no').map(([, need]) => ({
          need,
          evidence: 'venue_states_unsuitable',
          note: 'Community map data records this as not offered here.',
        }));
        const built = osmFoodVenue(normalized, { regionId: input.regionId, destinationName: input.destinationName, routingId: snap.routingId, today: input.today });
        if (admit(index, built, snap, unsuitable)) osmVenues += 1;
      }
    }
  } else if (!useOverture) {
    stoppedEarly = boxes.length > 0;
  }

  // A box nobody could answer: Overture failed it and Overpass was not asked or refused.
  const unanswered = boxes.filter((_, index) => keptPerBox[index] === 0).length;
  const overtureFailed = useOverture ? boxes.length - overtureBoxesAnswered : 0;
  const anyFailure = failedBoxes > 0 || stoppedEarly || (overtureFailed > 0 && unanswered > 0);
  const status: ScanFoodStatus = boxes.length === 0 ? 'empty' : venues.length === 0 ? (anyFailure ? 'unavailable' : 'empty') : anyFailure ? 'partial' : 'grounded';
  // OSM evidence merged onto an Overture venue is still OSM data, and its licence and credit travel with it.
  const source: ScanFoodGrounding['source'] = venues.length === 0 ? null : overtureVenues > 0 && osmVenues + osmEvidenceMerged > 0 ? 'overture+openstreetmap' : overtureVenues > 0 ? 'overture' : 'openstreetmap';
  const shopCount = venues.filter((v) => v.serviceType === 'grocery' || v.serviceType === 'market').length;
  const from = source === 'overture+openstreetmap' ? 'Overture Maps and OpenStreetMap' : source === 'overture' ? 'Overture Maps' : 'OpenStreetMap';
  const detail =
    status === 'unavailable'
      ? 'The open place data did not answer for food, so meals are described rather than named.'
      : status === 'empty'
        ? `The open place data records no restaurants or cafés within a short walk of the ${boxes.length} spot${boxes.length === 1 ? '' : 's'} we checked; meals are described rather than named.`
        : `${venues.length - shopCount} restaurants, cafés and takeaways${shopCount > 0 ? ` and ${shopCount} food shops` : ''} from ${from}, within a short walk of the bases and stops${status === 'partial' ? ` (${unanswered} of ${boxes.length} areas returned nothing)` : ''}. Hours and prices are not confirmed.`;
  return {
    dataset: venues.length > 0 ? { version: FOOD_DATASET_VERSION, regionId: input.regionId, venues, gaps: [], searched: [...answered.entries()].map(([index, mealVenues]) => ({ center: boxes[index]!.center, radiusKm: SEARCHED_RADIUS_KM, mealVenues })) } : null,
    status,
    source,
    providerName: source === 'overture' ? 'overture-places' : source === 'openstreetmap' ? 'openstreetmap-overpass' : source ? 'overture-places+openstreetmap-overpass' : undefined,
    boxes: boxes.length,
    failedBoxes: failedBoxes + overtureFailed,
    calls,
    unroutable,
    detail,
    timings: { overtureMs, overtureBytes, overtureVenues, osmVenues, overpassBoxes: attempted, totalMs: now() - started, farFromBox },
  };
}

/**
 * The fixture food dataset: deterministic, plainly synthetic venues beside the
 * first bases and places, reached only under the fixture switches so tests and
 * the browser suite exercise named meals with zero network. The names say
 * "(fixture)" so one can never pass for a real recommendation, and the diet
 * claims cover both directions (a vegetarian-friendly café, a grill that says
 * it cannot do vegetarian) so the diet rule is exercised too.
 */
export function fixtureScanFood(input: { regionId: string; destinationName: string; points: readonly ScanPoint[]; today: string }): ScanFoodGrounding {
  const anchors = input.points.filter((p) => p.kind === 'base').slice(0, 2).concat(input.points.filter((p) => p.kind === 'place').slice(0, 8));
  const venues: FoodVenue[] = [];
  anchors.forEach((anchor, i) => {
    for (let k = 0; k < 2; k += 1) {
      const n = i * 2 + k + 1;
      const variant = n % 3;
      const coordinates = { lat: anchor.coordinates.lat + 0.002 * (k === 0 ? 1 : -1), lng: anchor.coordinates.lng + 0.0015 };
      const snap = snapFoodRouting({ coordinates, anchors: input.points.map((p) => ({ id: p.id, coordinates: p.coordinates })), walkKmh: MODELLED_WALK_KMH });
      if (!snap) continue;
      const serviceType: FoodVenue['serviceType'] = variant === 1 ? 'cafe' : 'restaurant';
      const dietary: DietaryClaim[] =
        variant === 1
          ? [{ need: 'vegetarian', evidence: 'menu_lists_options', note: 'Fixture: records vegetarian options.' }]
          : variant === 2
            ? [{ need: 'vegetarian', evidence: 'venue_states_unsuitable', note: 'Fixture: a grill with nothing vegetarian.' }]
            : [];
      venues.push(
        foodVenueSchema.parse({
          id: `food-fixture-${n}`,
          regionId: input.regionId,
          name: `${variant === 2 ? 'Test Grill' : variant === 1 ? 'Test Café' : 'Test Kitchen'} ${n} (fixture)`,
          locality: input.destinationName,
          shortDescription: 'A synthetic venue for tests; not a real place.',
          coordinates,
          tags: ['fixture'],
          source: { name: 'Sidequest test fixture (synthetic)', kind: 'curated', confidence: 0.1, lastVerified: input.today },
          serviceType,
          mealPeriods: serviceType === 'cafe' ? ['breakfast', 'lunch', 'coffee'] : ['lunch', 'dinner'],
          cuisines: [],
          priceBand: serviceType === 'cafe' ? 'budget' : 'moderate',
          priceEvidence: 'format_inferred',
          serviceMinutes: serviceType === 'cafe' ? 30 : 75,
          reservation: { requirement: 'unknown' },
          dietary,
          hours: {
            kind: 'unknown',
            hoursConfidence: 'unverified',
            note: 'Fixture venue; no hours.',
            provenance: { kind: 'estimated', sourceName: 'Sidequest test fixture', confidence: 0.1, volatility: 'dynamic', recheckNote: 'Synthetic venue — nothing to check.' },
          },
          routingId: snap.routingId,
          walkMinutesFromRouting: snap.walkMinutesFromRouting,
        }),
      );
    }
  });
  return {
    dataset: venues.length > 0 ? { version: FOOD_DATASET_VERSION, regionId: input.regionId, venues, gaps: [] } : null,
    status: 'fixture',
    source: venues.length > 0 ? 'fixture' : null,
    boxes: 0,
    failedBoxes: 0,
    calls: 0,
    unroutable: 0,
    detail: `${venues.length} synthetic test venues (fixture mode).`,
  };
}

const MIN_LOCAL_VENUES = 3;

/** A branded chain, as OpenStreetMap tags it. */
export function isChain(element: { tags?: Record<string, string> }): boolean {
  const tags = element.tags ?? {};
  return Boolean(tags.brand || tags['brand:wikidata'] || tags['brand:en']);
}
