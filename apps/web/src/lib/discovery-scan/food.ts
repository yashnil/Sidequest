import 'server-only';
import {
  FOOD_DATASET_VERSION,
  MODELLED_WALK_KMH,
  foodVenueSchema,
  haversineKm,
  snapFoodRouting,
  type DietaryClaim,
  type DietaryNeed,
  type FoodDataset,
  type FoodVenue,
  type PriceBand,
  type ScanFoodArea,
  type ScanPoint,
} from '@sidequest/core';
import { fetchMealPois, normalizeElement, type BoundingBox, type OverpassOptions, type OverpassResult } from '../providers/overpass';
import { osmFoodVenue } from '../providers/osm-food';
import { cacheFor, TTL } from '../providers/open-verification';
import { geocode } from '../providers/nominatim';

/**
 * V1 CONVERGENCE — SOMEWHERE REAL TO EAT, FROM OPEN MAP DATA.
 *
 * The scan proposes places and food *areas*; it never had venues, so every
 * meal was intent prose. This step asks OpenStreetMap (Overpass) for the
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
 * Bounded and polite — the public Overpass policy is the reason for every
 * number here: sequential requests through the client's own spacing gate, one
 * selector group per box, ≤ 8 boxes of ~1.5 km, ≤ 60 venues, a stage deadline,
 * the provider cache, and a stop after two boxes in a row are refused. A
 * failure is an absence: the region simply has no food data and every meal
 * stays an honest intent. The scan never fails for food.
 */

export const MAX_FOOD_BOXES = 8;
export const MAX_FOOD_VENUES = 60;
/** Half the side of a box. 0.75 km keeps nearly every venue inside the 1.5 km door walk of the point it was drawn around. */
export const FOOD_BOX_HALF_KM = 0.75;
const FOOD_STAGE_BUDGET_MS = 40_000;
/** Two box centres closer than this would ask Overpass for mostly the same venues. */
const MIN_BOX_SEPARATION_KM = 1.2;
/** A food area further than this from every scan point cannot yield a venue the matrix can price. */
const FOOD_AREA_REACH_KM = 2;
const MAX_FOOD_AREAS = 3;
const MAX_BASE_BOXES = 3;
const CONSECUTIVE_FAILURES_BEFORE_STOPPING = 2;

export type ScanFoodStatus = 'grounded' | 'partial' | 'empty' | 'unavailable' | 'disabled' | 'fixture';

export interface ScanFoodGrounding {
  /** Null when nothing usable came back — the region then has no food data, which is unknown, never "no food". */
  dataset: FoodDataset | null;
  status: ScanFoodStatus;
  source: 'openstreetmap' | 'fixture' | null;
  providerName?: string;
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
];

function normalName(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

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

/**
 * Ground the scan's meals in OSM venues. Never throws: every failure becomes a
 * status and a sentence for the coverage report.
 */
export async function groundScanFood(input: GroundScanFoodInput, deps: GroundScanFoodDeps = {}): Promise<ScanFoodGrounding> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = () => now() - started > FOOD_STAGE_BUDGET_MS;
  const fetchMeals = deps.fetchMeals ?? fetchMealPois;
  const cache = deps.cache ?? cacheFor<OverpassResult>('overpass-food', TTL.poi);
  const anchors = input.points.map((p) => ({ id: p.id, coordinates: p.coordinates }));

  let foodAreas: { name: string; coordinates: { lat: number; lng: number } }[] = [];
  const geocodeArea = deps.geocodeArea === undefined ? defaultGeocodeArea : deps.geocodeArea;
  if (geocodeArea && input.foodAreas.length > 0) foodAreas = await placeFoodAreas(input, geocodeArea, deadline);

  const boxes = planFoodBoxes({ points: input.points, foodAreas });
  const perBox = Math.max(8, Math.ceil(MAX_FOOD_VENUES / Math.max(1, boxes.length)));
  const venues: FoodVenue[] = [];
  const seenIds = new Set<string>();
  let calls = 0;
  let attempted = 0;
  let failedBoxes = 0;
  let consecutiveFailures = 0;
  let unroutable = 0;
  let stoppedEarly = false;

  for (const box of boxes) {
    if (venues.length >= MAX_FOOD_VENUES) break;
    if (deadline() || consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_STOPPING) {
      stoppedEarly = true;
      break;
    }
    attempted += 1;
    let result: OverpassResult;
    try {
      result = await fetchMeals(foodBoxAround(box.center), { limit: perBox * 3, retries: 0, deadlineMs: started + FOOD_STAGE_BUDGET_MS, cache });
      calls += result.calls;
      consecutiveFailures = 0;
      if (result.failedGroups.length > 0) failedBoxes += 1;
    } catch {
      failedBoxes += 1;
      consecutiveFailures += 1;
      continue;
    }
    let kept = 0;
    /*
     * Local places over chains. A plan that sends somebody to a national chain
     * for lunch in a city full of food has not done the one thing a food
     * recommendation is for; where the box holds at least a few independent
     * venues, branded chains (OSM `brand` / `brand:wikidata`) are left out. In a
     * food desert a chain is better than nothing and stays.
     */
    const locals = result.elements.filter((element) => !isChain(element));
    const candidates = locals.length >= MIN_LOCAL_VENUES ? locals : result.elements;
    for (const element of candidates) {
      if (kept >= perBox || venues.length >= MAX_FOOD_VENUES) break;
      const normalized = normalizeElement(element);
      if (!normalized) continue;
      // A bar is somewhere to drink, not a meal the plan can promise.
      if (normalized.primaryTag === 'amenity=bar') continue;
      const snap = snapFoodRouting({ coordinates: normalized.coordinates, anchors, walkKmh: MODELLED_WALK_KMH });
      if (!snap) {
        unroutable += 1;
        continue;
      }
      const built = osmFoodVenue(normalized, { regionId: input.regionId, destinationName: input.destinationName, routingId: snap.routingId, today: input.today });
      if (!built || seenIds.has(built.id)) continue;
      // The same venue mapped twice (a node and its building) — one name, a few metres apart.
      if (venues.some((v) => normalName(v.name) === normalName(built.name) && haversineKm(v.coordinates, built.coordinates) <= 0.15)) continue;
      const unsuitable: DietaryClaim[] = DIET_TAG_NEEDS.filter(([tag]) => normalized.planningTags[tag] === 'no').map(([, need]) => ({
        need,
        evidence: 'venue_states_unsuitable',
        note: 'Community map data records this as not offered here.',
      }));
      const parsed = foodVenueSchema.safeParse({
        ...built,
        priceBand: SCAN_PRICE_BY_SERVICE[built.serviceType],
        dietary: [...built.dietary, ...unsuitable],
        walkMinutesFromRouting: snap.walkMinutesFromRouting,
      });
      if (!parsed.success) continue;
      seenIds.add(built.id);
      venues.push(parsed.data);
      kept += 1;
    }
  }

  const status: ScanFoodStatus =
    boxes.length === 0
      ? 'empty'
      : venues.length === 0
        ? failedBoxes > 0 || stoppedEarly
          ? 'unavailable'
          : 'empty'
        : failedBoxes > 0 || stoppedEarly
          ? 'partial'
          : 'grounded';
  const detail =
    status === 'unavailable'
      ? 'The map data service did not answer for food, so meals are described rather than named.'
      : status === 'empty'
        ? `OpenStreetMap records no restaurants or cafés within a short walk of the ${boxes.length} spot${boxes.length === 1 ? '' : 's'} we checked; meals are described rather than named.`
        : `${venues.length} restaurants, cafés and takeaways from OpenStreetMap, within a short walk of the bases and stops${status === 'partial' ? ` (${failedBoxes + (boxes.length - attempted)} of ${boxes.length} areas could not be checked)` : ''}. Hours and prices are not confirmed.`;
  return {
    dataset: venues.length > 0 ? { version: FOOD_DATASET_VERSION, regionId: input.regionId, venues, gaps: [] } : null,
    status,
    source: venues.length > 0 ? 'openstreetmap' : null,
    providerName: 'openstreetmap-overpass',
    boxes: attempted,
    failedBoxes,
    calls,
    unroutable,
    detail,
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
