import {
  buildTravelerProfile,
  defaultAnswers,
  estimateLegMinutes,
  haversineKm,
  operatingOn,
  type FoodDataset,
  type FoodVenue,
  type ItineraryDay,
  type ItineraryItem,
  type ScanPoint,
  type TravelerProfile,
} from '@sidequest/core';
import { ADAPTER_SEAMS, groundFromFixture, nameMeals } from './adapter';
import { loadFoodFixture, type RecordedFoodFixture } from './replay';
import { FOOD_SCENARIOS, type FoodScenario, type ScenarioPoint, type ScenarioTraveller } from './scenarios';

/**
 * FOOD EVALUATION — WHAT THE TRAVELLER WOULD HAVE BEEN TOLD, MEASURED.
 *
 * Deterministic, offline, and deliberately a *judge that does not share code
 * with the thing it judges*. The product's two food steps run on the recorded
 * world (`adapter.ts`); everything below — what counts as a duplicate, a chain,
 * "near the route", "open at that hour", a sparse meal — is decided here, by
 * rules written once and not changed between the baseline and the after run.
 *
 * Two things are kept apart that are easy to blur:
 *
 *  - the **dataset** is what the scan's food step kept (≤ a few dozen venues);
 *  - the **world** is everything the recording holds around the trip's points
 *    (`worldOf`), read by the judge's own rules.
 *
 * "Sparse" is judged against the world. A dinner in a harbour town with fifty
 * restaurants that the scan simply never looked at is a *coverage miss*, not a
 * sparse area, and the two are counted separately.
 *
 * The day structure is a stand-in, stated plainly: places are assigned to the
 * nearest base, chained nearest-neighbour, cut into days, and given lunch after
 * the stop that carries the clock past a quarter past noon and dinner back at
 * the base — the same shape the structure planner writes, without its scoring.
 * The numbers are about food given a plausible day, not about day construction.
 */

export const EVAL_START_DATE = '2027-05-10'; // a Monday
const TODAY = '2026-11-09';
const DAY_START = 9 * 60;
const LUNCH_AFTER = 12 * 60 + 15;
const DINNER_AT = 19 * 60;

/* ------------------------------------------------------------------ *
 * The reference judge
 * ------------------------------------------------------------------ */

/** Unicode-aware name fold: letters and digits of any script, lower-cased, accents removed. */
export function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[(（][^)）]*[)）]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const tokens = (name: string): string[] => foldName(name).split(' ').filter((t) => t.length >= 2);

/**
 * Two records of one place: the same folded name within 80 m, or — within 40 m —
 * one name's words all contained in the other's ("Costa" / "Costa Coffee").
 */
export function referenceSameVenue(a: { name: string; coordinates: { lat: number; lng: number } }, b: { name: string; coordinates: { lat: number; lng: number } }): boolean {
  const km = haversineKm(a.coordinates, b.coordinates);
  if (km > 0.08) return false;
  const fa = foldName(a.name);
  const fb = foldName(b.name);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  if (km > 0.04) return false;
  const ta = tokens(a.name);
  const tb = tokens(b.name);
  if (ta.length === 0 || tb.length === 0) return false;
  const [small, large] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return small.some((t) => t.length >= 3) && small.every((t) => large.has(t));
}

/** A branch name without its branch: no bracketed note, no trailing "… 店 / Branch". */
function chainFold(name: string): string {
  const parts = foldName(name).split(' ');
  if (parts.length > 1 && /(店|branch|filial|sucursal|filiale)$/.test(parts[parts.length - 1]!)) parts.pop();
  return parts.join(' ');
}

export interface ChainReference {
  isChain: (name: string) => boolean;
  evidence: (name: string) => 'brand_wikidata' | 'repeated_name' | null;
  size: number;
}

/**
 * Which names are chains, judged over the *whole* recorded corpus — every
 * scenario's rows, both sources — so it sees more than any one trip's scan can:
 * a name that carries a brand's Wikidata item anywhere, or stands at three or
 * more separate addresses (150 m apart) across the corpus. No list of brands.
 */
export function buildChainReference(fixtures: readonly RecordedFoodFixture[]): ChainReference {
  const wikidata = new Set<string>();
  const sites = new Map<string, { lat: number; lng: number }[]>();
  const seenIds = new Set<string>();
  const addSite = (key: string, point: { lat: number; lng: number }) => {
    if (!key) return;
    const list = sites.get(key) ?? [];
    if (!list.some((p) => haversineKm(p, point) < 0.15)) list.push(point);
    sites.set(key, list);
  };
  for (const fixture of fixtures) {
    for (const box of fixture.boxes) {
      for (const row of box.overture?.rows ?? []) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        const key = chainFold(row.name);
        if (row.brandWikidata && key) wikidata.add(key);
        if (row.confidence >= 0.7) addSite(key, { lat: row.lat, lng: row.lng });
      }
      for (const element of box.osm ?? []) {
        const id = `${element.type}/${element.id}`;
        if (seenIds.has(id) || !element.tags.name) continue;
        seenIds.add(id);
        const key = chainFold(element.tags.name);
        if (element.tags['brand:wikidata'] && key) wikidata.add(key);
        addSite(key, { lat: element.lat, lng: element.lon });
      }
    }
  }
  const repeated = new Set([...sites.entries()].filter(([, list]) => list.length >= 3).map(([key]) => key));
  const evidence = (name: string) => {
    const key = chainFold(name);
    if (!key) return null;
    if (wikidata.has(key)) return 'brand_wikidata' as const;
    if (repeated.has(key)) return 'repeated_name' as const;
    // A branch name glued to its brand ("丸亀製麺吉祥院店") still starts with it.
    for (const known of wikidata) if (known.length >= 3 && !known.includes(' ') && key.startsWith(known) && !/^[a-z0-9 ]+$/.test(known)) return 'brand_wikidata' as const;
    return null;
  };
  return { isChain: (name) => evidence(name) !== null, evidence, size: wikidata.size + repeated.size };
}

const isLatin = (text: string) => !/[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}]/u.test(text);
const SHOP_SERVICE = new Set<FoodVenue['serviceType']>(['grocery', 'market']);

/** How far a named meal may be from the day it interrupts and still count as "within about ten minutes". */
function withinTenMinutes(carFree: boolean, kmFromRoute: number, detourKm: number): boolean {
  if (kmFromRoute <= 0.8) return true;
  return !carFree && detourKm <= 5;
}

/**
 * Whether somewhere is within reach of a meal, where the traveller is at the
 * hour they eat it.
 *
 * Lunch happens after the stop before it: on foot, a short walk from that stop
 * (or from the next one, when the next one is a short hop away); by car, beside
 * that stop, or within half an hour's drive of it and a modest detour off the
 * leg onward. A village two hours down the road home is not lunch.
 *
 * Dinner happens after the day: the same, or beside the base — however far the
 * last stop was from it.
 */
function reachable(carFree: boolean, slot: 'lunch' | 'dinner', venue: { lat: number; lng: number }, origin: { lat: number; lng: number }, next: { lat: number; lng: number } | null): boolean {
  const fromOrigin = haversineKm(origin, venue);
  const fromNext = next ? haversineKm(next, venue) : Number.POSITIVE_INFINITY;
  const beside = carFree ? 1.2 : 2;
  if (fromOrigin <= beside) return true;
  if (slot === 'dinner' && fromNext <= beside) return true;
  if (carFree) return fromNext <= beside && next !== null && haversineKm(origin, next) <= 5;
  const detour = next ? fromOrigin + fromNext - haversineKm(origin, next) : fromOrigin;
  return fromOrigin <= 25 && detour <= 8;
}

const routeKm = (venue: { lat: number; lng: number }, origin: { lat: number; lng: number }, next: { lat: number; lng: number } | null) =>
  Math.min(haversineKm(origin, venue), next ? haversineKm(next, venue) : Number.POSITIVE_INFINITY);

/**
 * THE RECORDED WORLD — every place to eat or buy food the keyless sources hold
 * around the trip's points, read by the judge's own rules rather than the
 * product's.
 */
export interface WorldVenue {
  name: string;
  coordinates: { lat: number; lng: number };
  /** `meal`: somewhere to sit down or take away a meal. `light`: a café or bakery. `shop`: food to carry. */
  kind: 'meal' | 'light' | 'shop';
}

const NOT_A_MEAL = /^(dessert_shop|donut_shop|ice_cream_shop|gelato_shop|frozen_yogurt_shop|candy_store|chocolatier|internet_cafe|juice_bar|smoothie_juice_bar|bubble_tea_shop|liquor_store)$/;
const WORLD_SHOP = /^(grocery_store|supermarket|convenience_store|food_and_beverage_store|produce_store|butcher_shop|delicatessen|health_food_store|farmers_market|market)$/;

export function worldOf(fixture: RecordedFoodFixture): WorldVenue[] {
  const out: WorldVenue[] = [];
  const seen = new Set<string>();
  for (const box of fixture.boxes) {
    for (const row of box.overture?.rows ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.confidence < 0.7 || (row.status && row.status !== 'open')) continue;
      const words = [row.leaf ?? '', ...(row.hierarchy ?? [])];
      if (words.some((w) => NOT_A_MEAL.test(w))) continue;
      const coordinates = { lat: row.lat, lng: row.lng };
      const basic = row.basic ?? '';
      if (/^(restaurant|fast_food_restaurant|food_court)$/.test(basic) || (basic === 'casual_eatery' && row.leaf !== 'bakery') || row.leaf === 'pub' || row.leaf === 'gastropub') out.push({ name: row.name, coordinates, kind: 'meal' });
      else if (/^(cafe|coffee_shop)$/.test(basic) || row.leaf === 'bakery' || row.leaf === 'tea_room') out.push({ name: row.name, coordinates, kind: 'light' });
      else if (WORLD_SHOP.test(basic) || WORLD_SHOP.test(row.leaf ?? '') || /grocery_store$/.test(row.leaf ?? '')) out.push({ name: row.name, coordinates, kind: 'shop' });
    }
    for (const element of box.osm ?? []) {
      const id = `${element.type}/${element.id}`;
      if (seen.has(id) || !element.tags.name) continue;
      seen.add(id);
      const coordinates = { lat: element.lat, lng: element.lon };
      const amenity = element.tags.amenity ?? '';
      const shop = element.tags.shop ?? '';
      if (/^(restaurant|fast_food|food_court|pub)$/.test(amenity)) out.push({ name: element.tags.name, coordinates, kind: 'meal' });
      else if (amenity === 'cafe' || shop === 'bakery') out.push({ name: element.tags.name, coordinates, kind: 'light' });
      else if (/^(supermarket|convenience|greengrocer|deli|butcher)$/.test(shop) || amenity === 'marketplace') out.push({ name: element.tags.name, coordinates, kind: 'shop' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A plausible trip
 * ------------------------------------------------------------------ */

interface EvalMeal {
  slot: 'lunch' | 'dinner';
  itemId: string;
  origin: { lat: number; lng: number };
  next: { lat: number; lng: number } | null;
}

interface EvalDay {
  day: ItineraryDay;
  base: ScenarioPoint;
  firstStop: ScenarioPoint | null;
  anchorCoordinates: Map<string, { lat: number; lng: number }>;
  meals: EvalMeal[];
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function legMinutes(carFree: boolean, from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const km = haversineKm(from, to);
  const mode = carFree ? (km <= 1.6 ? 'walk' : 'rail') : 'drive';
  return estimateLegMinutes({ from, to, mode })?.minutes ?? 60;
}

function meal(id: string, title: string, start: number, minutes: number): ItineraryItem {
  return { id, kind: 'meal', title, startMinute: start, endMinute: start + minutes, durationMinutes: minutes, reason: 'Time held for a meal; nothing is booked.' } as unknown as ItineraryItem;
}

export function buildEvalDays(scenario: FoodScenario): EvalDay[] {
  const dayCount = scenario.nights + 1;
  const byBase = new Map<string, ScenarioPoint[]>(scenario.bases.map((b) => [b.id, []]));
  for (const place of scenario.places) {
    const nearest = [...scenario.bases].sort((a, z) => haversineKm(a.coordinates, place.coordinates) - haversineKm(z.coordinates, place.coordinates) || a.id.localeCompare(z.id))[0]!;
    byBase.get(nearest.id)!.push(place);
  }
  // Days per base, proportional to its time on site; every base with places gets at least one.
  const used = scenario.bases.filter((b) => byBase.get(b.id)!.length > 0);
  const weight = (b: ScenarioPoint) => byBase.get(b.id)!.reduce((n, p) => n + (p.minutes ?? 60), 0);
  const total = used.reduce((n, b) => n + weight(b), 0) || 1;
  const daysFor = new Map(used.map((b) => [b.id, Math.max(1, Math.round((weight(b) / total) * dayCount))]));
  for (let guard = 0; guard < 50; guard += 1) {
    const sum = [...daysFor.values()].reduce((n, v) => n + v, 0);
    if (sum === dayCount) break;
    const order = [...used].sort((a, z) => weight(z) / daysFor.get(z.id)! - weight(a) / daysFor.get(a.id)! || a.id.localeCompare(z.id));
    if (sum < dayCount) daysFor.set(order[0]!.id, daysFor.get(order[0]!.id)! + 1);
    else {
      const shrink = [...order].reverse().find((b) => daysFor.get(b.id)! > 1);
      if (!shrink) break;
      daysFor.set(shrink.id, daysFor.get(shrink.id)! - 1);
    }
  }

  const days: EvalDay[] = [];
  let dayNumber = 1;
  for (const base of used) {
    // Nearest-neighbour chain from the base keeps each day's stops beside each other.
    const remaining = [...byBase.get(base.id)!];
    const chain: ScenarioPoint[] = [];
    let at = base.coordinates;
    while (remaining.length > 0) {
      remaining.sort((a, z) => haversineKm(at, a.coordinates) - haversineKm(at, z.coordinates) || a.id.localeCompare(z.id));
      const next = remaining.shift()!;
      chain.push(next);
      at = next.coordinates;
    }
    const baseDays = daysFor.get(base.id)!;
    const perDay = Math.min(4, Math.max(1, Math.ceil(chain.length / baseDays)));
    for (let k = 0; k < baseDays; k += 1) {
      const stops = chain.slice(k * perDay, (k + 1) * perDay);
      const isLast = dayNumber === dayCount;
      const items: ItineraryItem[] = [];
      const anchorCoordinates = new Map<string, { lat: number; lng: number }>();
      const meals: EvalMeal[] = [];
      let clock = DAY_START;
      let position = base.coordinates;
      let hadLunch = false;
      const lunchId = `d${dayNumber}-lunch`;
      const pushLunch = (after: ScenarioPoint | null, nextStop: ScenarioPoint | null) => {
        // The two sentences the planner's composer writes for a lunch it has no food area for.
        const farFromBase = after ? legMinutes(scenario.carFree, base.coordinates, after.coordinates) > 45 : false;
        const title = after ? (after.wild && farFromBase ? `Pack a lunch — food is thin out near ${after.name}` : `Casual lunch in ${after.name}, near the midday stop`) : `Lunch in ${base.name}`;
        items.push(meal(lunchId, title, clock, 45));
        meals.push({ slot: 'lunch', itemId: lunchId, origin: after?.coordinates ?? base.coordinates, next: nextStop?.coordinates ?? base.coordinates });
        clock += 45;
        hadLunch = true;
      };
      stops.forEach((stop, index) => {
        clock += legMinutes(scenario.carFree, position, stop.coordinates);
        const minutes = stop.minutes ?? 60;
        const id = `d${dayNumber}-stop-${index + 1}`;
        items.push({ id, kind: 'activity', title: stop.name, startMinute: clock, endMinute: clock + minutes, durationMinutes: minutes, reason: '' } as unknown as ItineraryItem);
        anchorCoordinates.set(id, stop.coordinates);
        clock += minutes;
        position = stop.coordinates;
        if (!hadLunch && clock >= LUNCH_AFTER) pushLunch(stop, stops[index + 1] ?? null);
      });
      if (!hadLunch) {
        if (stops.length === 0) clock = Math.max(clock, 12 * 60 + 30);
        pushLunch(stops[stops.length - 1] ?? null, null);
      }
      if (!isLast) {
        clock += legMinutes(scenario.carFree, position, base.coordinates);
        const start = Math.max(clock, DINNER_AT);
        const dinnerId = `d${dayNumber}-dinner`;
        items.push(meal(dinnerId, `Dinner in ${base.name}`, start, 60));
        meals.push({ slot: 'dinner', itemId: dinnerId, origin: stops[stops.length - 1]?.coordinates ?? base.coordinates, next: base.coordinates });
      }
      const day = { dayNumber, date: addDays(EVAL_START_DATE, dayNumber - 1), baseId: base.id, baseName: base.name, theme: 'Evaluation day', items } as unknown as ItineraryDay;
      days.push({ day, base, firstStop: stops[0] ?? null, anchorCoordinates, meals });
      dayNumber += 1;
    }
  }
  return days;
}

export function profileFor(scenario: FoodScenario, traveller: ScenarioTraveller): TravelerProfile {
  const context = { travelerNeeds: [], tripDays: scenario.nights + 1 };
  const profile = buildTravelerProfile({ ...defaultAnswers(context) }, context);
  return {
    ...profile,
    food: { ...profile.food, dietaryNeeds: traveller.dietaryNeeds, everydayPriceBand: traveller.everydayPriceBand },
    ...(traveller.cuisines.length > 0 ? { preferenceNotes: { food: `We love ${traveller.cuisines.join(' and ')}.` } } : {}),
  } as TravelerProfile;
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round2(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
}

export type Told = 'venue_named_beyond_reach' | 'shop_named' | 'advice_from_data' | 'says_not_checked' | 'generic_pack_advice' | 'prose_claims_a_meal_there' | 'silent';
const emptyTold = (): Record<Told, number> => ({ venue_named_beyond_reach: 0, shop_named: 0, advice_from_data: 0, says_not_checked: 0, generic_pack_advice: 0, prose_claims_a_meal_there: 0, silent: 0 });

export interface DatasetReport {
  status: string;
  source: string | null;
  boxesPlanned: number;
  boxesFailed: number;
  venues: number;
  byServiceType: Record<string, number>;
  mealVenues: number;
  provisionShops: number;
  /** Scan points whose surroundings hold somewhere to eat in the recorded world, and how many of those the dataset covers. */
  pointsCovered: { n: number; ofPointsWithFoodInWorld: number; pct: number | null; allPoints: number };
  basesWithDinnerVenue: { n: number; of: number };
  duplicatePairs: number;
  duplicateExamples: string[];
  chain: { venues: number; pct: number | null; byEvidence: Record<string, number>; flaggedByProduct: number; pctOfWorld: number | null };
  nonLatinNames: { kept: number; pctOfKept: number | null; pctOfWorld: number | null };
  hoursEvidence: { venues: number; pct: number | null };
  dietaryEvidence: { venues: number; pct: number | null };
  cuisine: { labelled: number; pct: number | null; distinct: number };
  localityIsDestinationName: { venues: number; pct: number | null };
}

export interface PlanReport {
  traveller: string;
  meals: { total: number; lunches: number; dinners: number };
  named: { n: number; pct: number | null };
  proximity: { withinTenMinutes: number; pct: number | null; medianKmFromRoute: number | null; p90KmFromRoute: number | null; maxKmFromRoute: number | null };
  chains: { named: number; pctOfNamed: number | null; avoidable: number; practicalButPassedOver: number };
  variety: { distinctVenues: number; repeats: number; cuisineLabelled: number; distinctCuisines: number; sameCuisineBackToBack: number };
  mealType: { dinnerAtCafeOrBakery: number; mealAtShop: number };
  preferences: { cuisineAsked: string[]; matched: number; achievable: number; dietaryAsked: string[]; withEvidence: number; achievableWithEvidence: number; saidNotConfirmed: number; namedAtUnsuitable: number };
  hours: { namedWithEvidence: number; pctOfNamed: number | null; scheduledOutsideHours: number; saidNotConfirmed: number; namedWithoutEvidence: number };
  /** Somewhere to eat exists within reach in the recorded world, and the plan named nowhere. */
  coverageMiss: { meals: number; told: Record<Told, number> };
  /** Nothing to eat within reach in the recorded world. */
  sparse: { meals: number; lunches: number; dinners: number; days: number; shopNearBaseOrOnTheWay: number; told: Record<Told, number> };
  examples: string[];
}

export interface ScenarioReport {
  label: string;
  kind: string;
  destination: string;
  carFree: boolean;
  days: number;
  fixture: { recordedAt: string; overtureRelease: string; boxes: number; overtureRows: number; osmElements: number; osmBoxesUnanswered: number; world: { meal: number; light: number; shop: number; duplicatePairs: number } };
  dataset: DatasetReport;
  plans: PlanReport[];
}

export interface FoodEvalReport {
  label: string;
  seams: string;
  startDate: string;
  chainReferenceNames: number;
  scenarios: ScenarioReport[];
  totals: Record<string, number | null>;
}

function datasetReport(scenario: FoodScenario, world: readonly WorldVenue[], grounding: Awaited<ReturnType<typeof groundFromFixture>>, chains: ChainReference): DatasetReport {
  const venues = grounding.dataset?.venues ?? [];
  const byServiceType: Record<string, number> = {};
  for (const v of venues) byServiceType[v.serviceType] = (byServiceType[v.serviceType] ?? 0) + 1;
  const mealVenues = venues.filter((v) => v.mealPeriods.some((p) => p === 'lunch' || p === 'dinner'));
  const points = [...scenario.bases, ...scenario.places];
  const eatable = world.filter((w) => w.kind !== 'shop');
  const pointsWithWorld = points.filter((p) => eatable.some((w) => haversineKm(w.coordinates, p.coordinates) <= 1.0));
  const covered = pointsWithWorld.filter((p) => mealVenues.some((v) => haversineKm(v.coordinates, p.coordinates) <= 1.5)).length;
  const basesWith = scenario.bases.filter((b) => venues.some((v) => v.mealPeriods.includes('dinner') && haversineKm(v.coordinates, b.coordinates) <= 1.5)).length;
  const duplicates: string[] = [];
  for (let i = 0; i < venues.length; i += 1) {
    for (let j = i + 1; j < venues.length; j += 1) {
      if (referenceSameVenue(venues[i]!, venues[j]!)) duplicates.push(`${venues[i]!.name} ≈ ${venues[j]!.name} (${Math.round(haversineKm(venues[i]!.coordinates, venues[j]!.coordinates) * 1000)} m)`);
    }
  }
  const byEvidence: Record<string, number> = {};
  let chainVenues = 0;
  for (const v of venues) {
    const evidence = chains.evidence(v.name);
    if (!evidence) continue;
    chainVenues += 1;
    byEvidence[evidence] = (byEvidence[evidence] ?? 0) + 1;
  }
  const nonLatinKept = venues.filter((v) => !isLatin(v.name)).length;
  const cuisines = new Set(venues.flatMap((v) => v.cuisines));
  const count = (test: (v: FoodVenue) => boolean) => venues.filter(test).length;
  return {
    status: grounding.status,
    source: grounding.source,
    boxesPlanned: grounding.boxes,
    boxesFailed: grounding.failedBoxes,
    venues: venues.length,
    byServiceType,
    mealVenues: mealVenues.length,
    provisionShops: count((v) => SHOP_SERVICE.has(v.serviceType)),
    pointsCovered: { n: covered, ofPointsWithFoodInWorld: pointsWithWorld.length, pct: pct(covered, pointsWithWorld.length), allPoints: points.length },
    basesWithDinnerVenue: { n: basesWith, of: scenario.bases.length },
    duplicatePairs: duplicates.length,
    duplicateExamples: duplicates.slice(0, 6),
    chain: {
      venues: chainVenues,
      pct: pct(chainVenues, venues.length),
      byEvidence,
      flaggedByProduct: count((v) => v.tags.some((t) => t === 'chain' || t.startsWith('chain:'))),
      pctOfWorld: pct(eatable.filter((w) => chains.isChain(w.name)).length, eatable.length),
    },
    nonLatinNames: { kept: nonLatinKept, pctOfKept: pct(nonLatinKept, venues.length), pctOfWorld: pct(eatable.filter((w) => !isLatin(w.name)).length, eatable.length) },
    hoursEvidence: { venues: count((v) => v.hours.kind !== 'unknown'), pct: pct(count((v) => v.hours.kind !== 'unknown'), venues.length) },
    dietaryEvidence: { venues: count((v) => v.dietary.length > 0), pct: pct(count((v) => v.dietary.length > 0), venues.length) },
    cuisine: { labelled: count((v) => v.cuisines.length > 0), pct: pct(count((v) => v.cuisines.length > 0), venues.length), distinct: cuisines.size },
    localityIsDestinationName: { venues: count((v) => v.locality === scenario.destination), pct: pct(count((v) => v.locality === scenario.destination), venues.length) },
  };
}

function planReport(scenario: FoodScenario, traveller: ScenarioTraveller, dataset: FoodDataset | null, world: readonly WorldVenue[], chains: ChainReference): PlanReport {
  const days = buildEvalDays(scenario);
  const profile = profileFor(scenario, traveller);
  const venueUse = new Map<string, number>();
  if (dataset) {
    for (const d of days) nameMeals({ day: d.day, food: dataset, profile, anchorCoordinates: d.anchorCoordinates, base: d.base.coordinates, baseName: d.base.name, venueUse, carFree: scenario.carFree });
  }
  const venues = dataset?.venues ?? [];
  const byId = new Map(venues.map((v) => [v.id, v]));
  const shops = world.filter((w) => w.kind === 'shop' || w.kind === 'light');
  const report: PlanReport = {
    traveller: traveller.label,
    meals: { total: 0, lunches: 0, dinners: 0 },
    named: { n: 0, pct: null },
    proximity: { withinTenMinutes: 0, pct: null, medianKmFromRoute: null, p90KmFromRoute: null, maxKmFromRoute: null },
    chains: { named: 0, pctOfNamed: null, avoidable: 0, practicalButPassedOver: 0 },
    variety: { distinctVenues: 0, repeats: 0, cuisineLabelled: 0, distinctCuisines: 0, sameCuisineBackToBack: 0 },
    mealType: { dinnerAtCafeOrBakery: 0, mealAtShop: 0 },
    preferences: { cuisineAsked: traveller.cuisines, matched: 0, achievable: 0, dietaryAsked: traveller.dietaryNeeds, withEvidence: 0, achievableWithEvidence: 0, saidNotConfirmed: 0, namedAtUnsuitable: 0 },
    hours: { namedWithEvidence: 0, pctOfNamed: null, scheduledOutsideHours: 0, saidNotConfirmed: 0, namedWithoutEvidence: 0 },
    coverageMiss: { meals: 0, told: emptyTold() },
    sparse: { meals: 0, lunches: 0, dinners: 0, days: 0, shopNearBaseOrOnTheWay: 0, told: emptyTold() },
    examples: [],
  };
  const example = (text: string) => {
    if (report.examples.length < 14) report.examples.push(text);
  };
  const kms: number[] = [];
  const usedVenues = new Map<string, number>();
  const cuisinesNamed: string[] = [];
  let previousCuisine: string | null = null;
  const supportsNeed = (v: FoodVenue, need: string) => v.dietary.some((c) => c.need === need && (c.evidence === 'venue_states_support' || c.evidence === 'menu_lists_options'));
  const matchesCuisine = (v: FoodVenue) => traveller.cuisines.some((c) => v.cuisines.some((vc) => vc.toLowerCase().includes(c.toLowerCase())));

  for (const d of days) {
    let sparseToday = false;
    for (const m of d.meals) {
      report.meals.total += 1;
      if (m.slot === 'lunch') report.meals.lunches += 1;
      else report.meals.dinners += 1;
      const item = d.day.items.find((i) => i.id === m.itemId)!;
      const food = item.food;
      const text = `${item.title} ${item.reason ?? ''}`;
      const worldHere = world.filter((w) => (m.slot === 'dinner' ? w.kind === 'meal' : w.kind !== 'shop') && reachable(scenario.carFree, m.slot, w.coordinates, m.origin, m.next));
      const candidates = venues.filter((v) => v.mealPeriods.includes(m.slot) && reachable(scenario.carFree, m.slot, v.coordinates, m.origin, m.next));
      const namedVenue = food?.stopKind === 'venue' && food.venueId ? byId.get(food.venueId) ?? null : null;
      const inReach = namedVenue ? reachable(scenario.carFree, m.slot, namedVenue.coordinates, m.origin, m.next) : false;

      if (namedVenue) {
        report.named.n += 1;
        const fromOrigin = haversineKm(m.origin, namedVenue.coordinates);
        const fromNext = m.next ? haversineKm(m.next, namedVenue.coordinates) : Number.POSITIVE_INFINITY;
        const kmFromRoute = Math.min(fromOrigin, fromNext);
        const detour = m.next ? fromOrigin + fromNext - haversineKm(m.origin, m.next) : fromOrigin;
        kms.push(kmFromRoute);
        if (withinTenMinutes(scenario.carFree, kmFromRoute, detour)) report.proximity.withinTenMinutes += 1;
        usedVenues.set(namedVenue.id, (usedVenues.get(namedVenue.id) ?? 0) + 1);

        if (chains.isChain(namedVenue.name)) {
          report.chains.named += 1;
          if (worldHere.some((w) => !chains.isChain(w.name) && routeKm(w.coordinates, m.origin, m.next) <= kmFromRoute + 0.3)) {
            report.chains.avoidable += 1;
            example(`avoidable chain: day ${d.day.dayNumber} ${m.slot} — ${namedVenue.name}`);
          }
        }
        const cuisine = namedVenue.cuisines[0] ?? null;
        if (cuisine) {
          report.variety.cuisineLabelled += 1;
          cuisinesNamed.push(cuisine);
          if (previousCuisine === cuisine) report.variety.sameCuisineBackToBack += 1;
        }
        previousCuisine = cuisine;
        if (m.slot === 'dinner' && (namedVenue.serviceType === 'cafe' || namedVenue.serviceType === 'bakery')) report.mealType.dinnerAtCafeOrBakery += 1;
        if (SHOP_SERVICE.has(namedVenue.serviceType)) report.mealType.mealAtShop += 1;

        if (traveller.cuisines.length > 0 && matchesCuisine(namedVenue)) report.preferences.matched += 1;
        for (const need of traveller.dietaryNeeds) {
          if (namedVenue.dietary.some((c) => c.need === need && c.evidence === 'venue_states_unsuitable')) report.preferences.namedAtUnsuitable += 1;
          else if (supportsNeed(namedVenue, need)) report.preferences.withEvidence += 1;
          else if (food?.dietaryUnverified?.includes(need)) report.preferences.saidNotConfirmed += 1;
        }

        if (namedVenue.hours.kind === 'unknown') {
          report.hours.namedWithoutEvidence += 1;
          if (food?.hoursUnknown) report.hours.saidNotConfirmed += 1;
        } else {
          report.hours.namedWithEvidence += 1;
          if (namedVenue.hours.kind === 'scheduled') {
            const on = operatingOn(namedVenue.hours, d.day.date);
            const start = item.startMinute + (food?.walkMinutesFromRouting ?? 0);
            if (!(on.status === 'open' && on.windows.some((w) => start >= w.openMinute && item.endMinute <= w.closeMinute))) {
              report.hours.scheduledOutsideHours += 1;
              example(`outside hours: day ${d.day.dayNumber} ${m.slot} — ${namedVenue.name} at ${Math.floor(start / 60)}:${String(start % 60).padStart(2, '0')}`);
            }
          }
        }
      }

      // A chain that was materially the practical choice: the only thing in reach, or much nearer than any independent.
      const chainKm = Math.min(...worldHere.filter((w) => chains.isChain(w.name)).map((w) => routeKm(w.coordinates, m.origin, m.next)), Number.POSITIVE_INFINITY);
      const independentKm = Math.min(...worldHere.filter((w) => !chains.isChain(w.name)).map((w) => routeKm(w.coordinates, m.origin, m.next)), Number.POSITIVE_INFINITY);
      const margin = scenario.carFree ? 0.5 : 3;
      if (Number.isFinite(chainKm) && chainKm + margin < independentKm) {
        const namedKm = namedVenue ? routeKm(namedVenue.coordinates, m.origin, m.next) : Number.POSITIVE_INFINITY;
        if (namedKm > chainKm + margin) {
          report.chains.practicalButPassedOver += 1;
          example(`practical chain passed over: day ${d.day.dayNumber} ${m.slot} (${namedVenue ? `named ${namedVenue.name} ${round2(namedKm)} km away` : 'nothing named'}; a chain was ${round2(chainKm)} km away)`);
        }
      }

      if (traveller.cuisines.length > 0 && candidates.some(matchesCuisine)) report.preferences.achievable += 1;
      for (const need of traveller.dietaryNeeds) if (candidates.some((v) => supportsNeed(v, need))) report.preferences.achievableWithEvidence += 1;

      // A shop counts as named only on a meal the plan itself marked as carried or bought — never because a café shares the town's name.
      const shopNamed = Boolean(food && food.stopKind !== 'venue') && shops.some((w) => w.name.length >= 3 && text.includes(w.name));
      const told: Told =
        namedVenue && !inReach
          ? 'venue_named_beyond_reach'
          : shopNamed
            ? 'shop_named'
            : food?.stopKind === 'packed' || food?.stopKind === 'grocery'
              ? 'advice_from_data'
              : food?.stopKind === 'unplanned'
                ? 'says_not_checked'
              : /pack (a )?lunch|picnic|carry/i.test(item.title)
                ? 'generic_pack_advice'
                : /\b(lunch|dinner) in\b/i.test(item.title)
                  ? 'prose_claims_a_meal_there'
                  : 'silent';
      if (worldHere.length === 0) {
        sparseToday = true;
        report.sparse.meals += 1;
        if (m.slot === 'lunch') report.sparse.lunches += 1;
        else report.sparse.dinners += 1;
        const shopAvailable = world.some((w) => w.kind !== 'meal' && (haversineKm(w.coordinates, d.base.coordinates) <= 1.5 || (d.firstStop ? reachable(scenario.carFree, 'lunch', w.coordinates, d.base.coordinates, d.firstStop.coordinates) : false)));
        if (shopAvailable) report.sparse.shopNearBaseOrOnTheWay += 1;
        if (!(namedVenue && inReach)) {
          report.sparse.told[told] += 1;
          example(`sparse ${m.slot}, day ${d.day.dayNumber} (${told}): "${item.title}"`);
        }
      } else if (!namedVenue || !inReach) {
        report.coverageMiss.meals += 1;
        report.coverageMiss.told[told] += 1;
        example(`coverage miss: ${m.slot}, day ${d.day.dayNumber} — ${worldHere.length} places within reach in the recorded world; told "${item.title}"`);
      }
    }
    if (sparseToday) report.sparse.days += 1;
  }

  report.named.pct = pct(report.named.n, report.meals.total);
  report.proximity.pct = pct(report.proximity.withinTenMinutes, report.named.n);
  report.proximity.medianKmFromRoute = quantile(kms, 0.5);
  report.proximity.p90KmFromRoute = quantile(kms, 0.9);
  report.proximity.maxKmFromRoute = kms.length > 0 ? round2(Math.max(...kms)) : null;
  report.chains.pctOfNamed = pct(report.chains.named, report.named.n);
  report.variety.distinctVenues = usedVenues.size;
  report.variety.repeats = [...usedVenues.values()].reduce((n, v) => n + (v - 1), 0);
  report.variety.distinctCuisines = new Set(cuisinesNamed).size;
  report.hours.pctOfNamed = pct(report.hours.namedWithEvidence, report.named.n);
  return report;
}

export async function evaluateScenario(scenario: FoodScenario, chains: ChainReference): Promise<ScenarioReport> {
  const fixture = loadFoodFixture(scenario.label);
  const world = worldOf(fixture);
  const points: ScanPoint[] = [
    ...scenario.bases.map((b) => ({ id: b.id, kind: 'base' as const, key: b.id, name: b.name, coordinates: b.coordinates })),
    ...scenario.places.map((p) => ({ id: p.id, kind: 'place' as const, key: p.id, name: p.name, coordinates: p.coordinates })),
  ];
  const grounding = await groundFromFixture({ fixture, regionId: `eval-${scenario.label}`, destinationName: scenario.destination, countryCode: scenario.countryCode, points, today: TODAY });
  let worldDuplicates = 0;
  const eatable = world.filter((w) => w.kind !== 'shop');
  // Quadratic, bounded by a coarse grid: only compare venues that share a ~110 m cell or a neighbour.
  const grid = new Map<string, WorldVenue[]>();
  for (const w of eatable) {
    const cx = Math.floor(w.coordinates.lat * 1000);
    const cy = Math.floor(w.coordinates.lng * 1000);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (const other of grid.get(`${cx + dx}:${cy + dy}`) ?? []) if (referenceSameVenue(w, other)) worldDuplicates += 1;
    grid.set(`${cx}:${cy}`, [...(grid.get(`${cx}:${cy}`) ?? []), w]);
  }
  return {
    label: scenario.label,
    kind: scenario.kind,
    destination: scenario.destination,
    carFree: scenario.carFree,
    days: scenario.nights + 1,
    fixture: {
      recordedAt: fixture.recordedAt,
      overtureRelease: fixture.overtureRelease,
      boxes: fixture.boxes.length,
      overtureRows: fixture.boxes.reduce((n, b) => n + (b.overture?.rows.length ?? 0), 0),
      osmElements: fixture.boxes.reduce((n, b) => n + (b.osm?.length ?? 0), 0),
      osmBoxesUnanswered: fixture.boxes.filter((b) => b.osm === null).length,
      world: { meal: world.filter((w) => w.kind === 'meal').length, light: world.filter((w) => w.kind === 'light').length, shop: world.filter((w) => w.kind === 'shop').length, duplicatePairs: worldDuplicates },
    },
    dataset: datasetReport(scenario, world, grounding, chains),
    plans: scenario.travellers.map((traveller) => planReport(scenario, traveller, grounding.dataset, world, chains)),
  };
}

export async function evaluateFood(label: string): Promise<FoodEvalReport> {
  const chains = buildChainReference(FOOD_SCENARIOS.map((s) => loadFoodFixture(s.label)));
  const scenarios: ScenarioReport[] = [];
  for (const scenario of FOOD_SCENARIOS) scenarios.push(await evaluateScenario(scenario, chains));

  const plans = scenarios.flatMap((s) => s.plans);
  const sum = (pick: (p: PlanReport) => number) => plans.reduce((n, p) => n + pick(p), 0);
  const dsum = (pick: (d: DatasetReport) => number) => scenarios.reduce((n, s) => n + pick(s.dataset), 0);
  const named = sum((p) => p.named.n);
  const totals: Record<string, number | null> = {
    venues: dsum((d) => d.venues),
    duplicatePairsInDataset: dsum((d) => d.duplicatePairs),
    chainVenuePct: pct(dsum((d) => d.chain.venues), dsum((d) => d.venues)),
    chainVenuesFlaggedByProduct: dsum((d) => d.chain.flaggedByProduct),
    venuesWithHoursEvidencePct: pct(dsum((d) => d.hoursEvidence.venues), dsum((d) => d.venues)),
    venuesWithDietaryEvidencePct: pct(dsum((d) => d.dietaryEvidence.venues), dsum((d) => d.venues)),
    venuesWithCuisinePct: pct(dsum((d) => d.cuisine.labelled), dsum((d) => d.venues)),
    venuesWhoseLocalityIsTheDestinationNamePct: pct(dsum((d) => d.localityIsDestinationName.venues), dsum((d) => d.venues)),
    provisionShops: dsum((d) => d.provisionShops),
    scanPointsWithFoodCoveredPct: pct(dsum((d) => d.pointsCovered.n), dsum((d) => d.pointsCovered.ofPointsWithFoodInWorld)),
    meals: sum((p) => p.meals.total),
    mealsNamedPct: pct(named, sum((p) => p.meals.total)),
    namedWithinTenMinutesPct: pct(sum((p) => p.proximity.withinTenMinutes), named),
    namedChainPct: pct(sum((p) => p.chains.named), named),
    avoidableChainMeals: sum((p) => p.chains.avoidable),
    practicalChainPassedOver: sum((p) => p.chains.practicalButPassedOver),
    repeatedVenueMeals: sum((p) => p.variety.repeats),
    sameCuisineBackToBack: sum((p) => p.variety.sameCuisineBackToBack),
    cuisinePreferenceMatched: sum((p) => p.preferences.matched),
    cuisinePreferenceAchievable: sum((p) => p.preferences.achievable),
    dietaryWithEvidence: sum((p) => p.preferences.withEvidence),
    dietaryAchievableWithEvidence: sum((p) => p.preferences.achievableWithEvidence),
    dietarySaidNotConfirmed: sum((p) => p.preferences.saidNotConfirmed),
    dietaryNamedAtUnsuitable: sum((p) => p.preferences.namedAtUnsuitable),
    namedWithHoursEvidencePct: pct(sum((p) => p.hours.namedWithEvidence), named),
    scheduledOutsideHours: sum((p) => p.hours.scheduledOutsideHours),
    namedWithoutHoursEvidence: sum((p) => p.hours.namedWithoutEvidence),
    hoursSaidNotConfirmed: sum((p) => p.hours.saidNotConfirmed),
    dinnerAtCafeOrBakery: sum((p) => p.mealType.dinnerAtCafeOrBakery),
    coverageMissMeals: sum((p) => p.coverageMiss.meals),
    coverageMissToldAMealIsThere: sum((p) => p.coverageMiss.told.prose_claims_a_meal_there),
    coverageMissSaysNotChecked: sum((p) => p.coverageMiss.told.says_not_checked),
    coverageMissToldToPack: sum((p) => p.coverageMiss.told.generic_pack_advice + p.coverageMiss.told.advice_from_data + p.coverageMiss.told.shop_named),
    sparseMeals: sum((p) => p.sparse.meals),
    sparseDays: sum((p) => p.sparse.days),
    sparseWithAShopNearBaseOrOnTheWay: sum((p) => p.sparse.shopNearBaseOrOnTheWay),
    sparseToldShopNamed: sum((p) => p.sparse.told.shop_named),
    sparseToldAdviceFromData: sum((p) => p.sparse.told.advice_from_data),
    sparseSaysNotChecked: sum((p) => p.sparse.told.says_not_checked),
    budgetTravellerNamedPct: pct(plans.filter((p) => p.traveller.startsWith('budget')).reduce((n, p) => n + p.named.n, 0), plans.filter((p) => p.traveller.startsWith('budget')).reduce((n, p) => n + p.meals.total, 0)),
    sparseToldGenericPackAdvice: sum((p) => p.sparse.told.generic_pack_advice),
    sparseToldAMealIsThere: sum((p) => p.sparse.told.prose_claims_a_meal_there),
    sparseToldDistantVenue: sum((p) => p.sparse.told.venue_named_beyond_reach),
    sparseToldNothing: sum((p) => p.sparse.told.silent),
  };
  return { label, seams: ADAPTER_SEAMS, startDate: EVAL_START_DATE, chainReferenceNames: chains.size, scenarios, totals };
}
