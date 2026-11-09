import { operatingOn, type RecurringCalendar } from '../hours/availability';
import { PRICE_BAND_ORDER, type FoodDataset, type FoodVenue, type PriceBand, type ScheduledFood } from '../schemas/food';
import { haversineKm } from '../travel/estimate';
import { isChainVenue } from './identity';
import cuisinePrior from './cuisine-prior.json';

/**
 * WHICH TABLE FOR THIS MEAL, AND WHAT TO SAY WHEN THERE IS NONE.
 *
 * Every term below is priced in the one unit a traveller feels: kilometres of
 * extra distance a candidate is allowed to cost. A venue's score is its distance
 * plus these; lowest wins. `reach` scales them to how the trip moves (a kilometre
 * on foot is worth about three in a car), and the total discount is capped, so
 * taste can reorder what is close but can never send anyone across town.
 *
 * Evidence raises a venue. Missing evidence never lowers one: no term penalises
 * unknown hours, an unconfirmed diet or an unknown price.
 */
export const MEAL_RANK_KM = {
  /** You said you like it (matched against the venues' own cuisine labels). */
  likedCuisine: -1,
  /** You said you do not. */
  dislikedCuisine: 2,
  /** The cuisine this area has unusually much of, from the data. */
  localCuisine: -0.5,
  /** Open hours on record that cover this meal. */
  hoursConfirmed: -0.3,
  /** Each earlier meal on this trip with the same cuisine (counted up to three). */
  cuisineAlreadyEaten: 0.3,
  /** An outlet of something: an independent wins unless it is this much further. */
  chain: 0.8,
  /** On top of `chain`: an evening is the meal people remember, and a chain outlet is seldom what they came for. */
  chainAtDinner: 0.8,
  /** A coffee shop can feed you at lunch; a kitchen is better. */
  coffeeShopAtLunch: 1,
  /** A takeaway counter is fuel, a weak dinner. */
  takeawayAtDinner: 0.8,
  /** Pubs usually serve food, but the record does not say so. */
  pubFoodNotConfirmed: 0.3,
  /** Above the traveller's band only by inference from the kind of place. */
  inferredPriceAboveBand: 0.3,
} as const;

const MAX_DISCOUNT_UNITS = 1.5;

export function mealRankReach(carFree: boolean): number {
  return carFree ? 1 : 3;
}

export interface MealRankInput {
  venue: FoodVenue;
  slot: 'lunch' | 'dinner';
  carFree: boolean;
  wishes: CuisineWishes;
  /** Lower-case cuisine → meals already named on this trip with it. */
  cuisineUses: ReadonlyMap<string, number>;
  everydayPriceBand: PriceBand;
  hoursFit: VenueHoursFit;
}

/** Kilometre-equivalents to add to this venue's distance. Pure; every term is in `MEAL_RANK_KM`. */
export function mealRankAdjustment(input: MealRankInput): number {
  const { venue, slot, wishes, cuisineUses, hoursFit } = input;
  const t = MEAL_RANK_KM;
  const cuisines = venue.cuisines.map((c) => c.toLowerCase());
  let discount = 0;
  let penalty = 0;
  if (cuisines.some((c) => wishes.liked.has(c))) discount += t.likedCuisine;
  if (venue.tags.includes(LOCAL_CUISINE_TAG)) discount += t.localCuisine;
  if (hoursFit === 'open') discount += t.hoursConfirmed;
  if (cuisines.some((c) => wishes.disliked.has(c))) penalty += t.dislikedCuisine;
  penalty += Math.min(3, Math.max(0, ...cuisines.map((c) => cuisineUses.get(c) ?? 0))) * t.cuisineAlreadyEaten;
  if (isChainVenue(venue)) penalty += t.chain + (slot === 'dinner' ? t.chainAtDinner : 0);
  if (slot === 'lunch' && venue.tags.includes('overture:coffee_shop')) penalty += t.coffeeShopAtLunch;
  if (slot === 'dinner' && venue.serviceType === 'takeaway') penalty += t.takeawayAtDinner;
  if (venue.tags.includes('overture:pub')) penalty += t.pubFoodNotConfirmed;
  if (venue.priceEvidence === 'format_inferred' && PRICE_BAND_ORDER[venue.priceBand] > PRICE_BAND_ORDER[input.everydayPriceBand]) penalty += t.inferredPriceAboveBand;
  return (Math.max(discount, -MAX_DISCOUNT_UNITS) + penalty) * mealRankReach(input.carFree);
}

/* ---------- what the traveller said they like ---------- */

export interface CuisineWishes {
  liked: ReadonlySet<string>;
  disliked: ReadonlySet<string>;
}

const NEGATION = /\b(no|not|never|avoid|hate|hates|dislike|dislikes|without|don'?t|doesn'?t|allergic)\b/i;

/**
 * Which of the cuisines on offer the traveller's own words mention.
 *
 * Sidequest asks no cuisine question, so the stated preference is free text. The
 * vocabulary is the region's venue labels, so this needs no list of foods and can
 * only ever match something that is really on offer. A negation in the three
 * words before a mention turns it into a dislike. It orders, never gates.
 */
export function readCuisineWishes(texts: readonly (string | undefined)[], vocabulary: readonly string[]): CuisineWishes {
  const liked = new Set<string>();
  const disliked = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    const text = raw.toLowerCase();
    for (const label of new Set(vocabulary.map((v) => v.toLowerCase()))) {
      if (label.length < 3) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
      for (const match of text.matchAll(pattern)) {
        const clause = text.slice(0, match.index).split(/[.,;!?]/).pop() ?? '';
        const nearby = clause.trim().split(/\s+/).slice(-3).join(' ');
        (NEGATION.test(nearby) ? disliked : liked).add(label);
      }
    }
  }
  for (const label of disliked) liked.delete(label);
  return { liked, disliked };
}

/* ---------- local cuisine, from frequency ---------- */

export const LOCAL_CUISINE_TAG = 'local-cuisine';

const PRIOR = cuisinePrior as Readonly<Record<string, number>>;
const PRIOR_FLOOR = 0.005;

/**
 * The cuisines this trip's ground has unusually much of: at least four venues,
 * at least 8% of everything labelled here, and at least 1.8× their share in the
 * corpus prior (`cuisine-prior.json`, generated from the recorded fixtures by
 * the food harness). A statement about what is common, never about what is good
 * or what originated here.
 */
export function localCuisines(labels: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const out = new Set<string>();
  if (labels.length < 12) return out;
  for (const [label, count] of counts) {
    const share = count / labels.length;
    if (count >= 4 && share >= 0.08 && share / Math.max(PRIOR[label] ?? 0, PRIOR_FLOOR) >= 1.8) out.add(label);
  }
  return out;
}

/* ---------- is it open for this meal ---------- */

export type VenueHoursFit = 'open' | 'closed' | 'unknown';

/** Whether the record says the venue is open for the whole of this meal. No record is `unknown`, never `closed`. */
export function venueHoursFit(venue: Pick<FoodVenue, 'hours'>, date: string, startMinute: number, endMinute: number): VenueHoursFit {
  const on = operatingOn(venue.hours as RecurringCalendar, date);
  if (on.status === 'unknown') return 'unknown';
  if (on.status === 'always_open') return 'open';
  if (on.status === 'closed') return 'closed';
  return on.windows.some((window) => startMinute >= window.openMinute && endMinute <= window.closeMinute) ? 'open' : 'closed';
}

/* ---------- nowhere to eat: the honest alternatives ---------- */

export interface MealAlternative {
  title: string;
  reason: string;
  food: ScheduledFood;
}

type Point = { lat: number; lng: number };

const SHOP_WORD: Record<string, string> = { grocery: 'grocery', convenience: 'convenience store', market: 'market', bakery: 'bakery', cafe: 'café' };
const SHOP_RANK: Record<string, number> = { grocery: 0, market: 1, convenience: 1, bakery: 2, cafe: 3 };

function shopKindOf(venue: FoodVenue): string | null {
  if (venue.serviceType === 'bakery') return 'bakery';
  if (venue.serviceType === 'cafe') return 'cafe';
  if (venue.serviceType === 'market') return 'market';
  if (venue.serviceType !== 'grocery') return null;
  return venue.tags.includes('overture:convenience') ? 'convenience' : 'grocery';
}

/** Whether the data read the ground around `point` and found no place to eat. */
export function searchedAndEmpty(food: Pick<FoodDataset, 'searched'>, point: Point): boolean {
  return (food.searched ?? []).some((area) => area.mealVenues === 0 && haversineKm(area.center, point) <= area.radiusKm);
}

function baseFood(slot: 'lunch' | 'dinner', stopKind: ScheduledFood['stopKind'], routeContext: ScheduledFood['routeContext']): ScheduledFood {
  return { slot, stopKind, routeContext, dietary: [], dietaryUnverified: [], hoursUnknown: false, detourMinutes: 0, isSpecialMeal: false, fromUserChoice: false, alternatives: [] };
}

/**
 * What a meal with no venue says instead. Only runs where a food step ran.
 *
 *  - The plan already says to carry food, or the data read this ground and lists
 *    nowhere to eat: name the shop to buy it from (near the base, or on the way
 *    out), or, with no shop on record either, say to carry food from home base
 *    and eat before leaving or after returning.
 *  - Nobody looked here: say that, and do not tell anyone to pack a lunch in a
 *    place that may be full of restaurants.
 *
 * Every sentence reads a field. "Lists nowhere" is about the data, never the
 * world; a shop's hours are stated as unconfirmed unless a record covers them.
 */
export function mealAlternativeFor(input: {
  slot: 'lunch' | 'dinner';
  food: FoodDataset;
  date: string;
  dayNumber: number;
  origin: Point;
  base: Point | null;
  baseName: string;
  firstStop: Point | null;
  nearName: string | null;
  carFree: boolean;
  plannedToCarry: boolean;
}): MealAlternative | null {
  const { slot, food, origin, base, firstStop, carFree, plannedToCarry } = input;
  if (!food.searched || food.searched.length === 0) return null;
  const near = input.nearName ?? input.baseName;
  const empty = searchedAndEmpty(food, origin);

  if (!plannedToCarry && !empty) {
    return {
      title: '',
      reason: `We did not find a place to name for this meal around ${near}. There may well be somewhere, so choose on the day; nothing is booked.`,
      food: baseFood(slot, 'unplanned', 'near_route'),
    };
  }
  if (slot === 'dinner' && !base) return null;

  const beside = carFree ? 1.2 : 3;
  const shops = base
    ? food.venues.flatMap((venue) => {
        const kind = shopKindOf(venue);
        if (!kind || (slot === 'dinner' && (kind === 'bakery' || kind === 'cafe'))) return [];
        if (operatingOn(venue.hours as RecurringCalendar, input.date).status === 'closed') return [];
        const fromBase = haversineKm(base, venue.coordinates);
        const onTheWay = !carFree && firstStop !== null && fromBase <= 25 && fromBase + haversineKm(venue.coordinates, firstStop) - haversineKm(base, firstStop) <= 8;
        if (fromBase > beside && !onTheWay) return [];
        return [{ venue, kind, fromBase, score: fromBase + SHOP_RANK[kind]! * mealRankReach(carFree) * 0.5 }];
      })
    : [];
  shops.sort((a, b) => a.score - b.score || a.venue.name.localeCompare(b.venue.name));
  const shop = shops[0];

  const noneNear = empty ? `Open place data lists nowhere to eat around ${near}, which does not prove there is nothing` : `We have not found anywhere to eat around ${near}`;
  const provenance = shop ? (shop.venue.source.kind === 'osm' ? 'Named from OpenStreetMap map data (© OpenStreetMap contributors)' : shop.venue.source.kind === 'overture' ? 'Named from open place data (© Overture Maps Foundation)' : "Named from the region's own food data") : '';
  if (shop) {
    const where = shop.fromBase <= 1 ? `close to your base in ${input.baseName}` : `${Math.round(shop.fromBase)} km from your base in ${input.baseName}, on your way out`;
    const hoursKnown = shop.venue.hours.kind !== 'unknown';
    const hoursLine = hoursKnown ? 'Check its hours before you rely on it.' : 'Its hours are not confirmed, so if it is shut, buy what you need the day before.';
    const word = SHOP_WORD[shop.kind]!;
    return {
      title: slot === 'dinner' ? `Dinner — self-cater from ${shop.venue.name}` : shop.kind === 'cafe' ? `Lunch — eat at ${shop.venue.name} before you set out` : `Lunch to carry — buy it at ${shop.venue.name}`,
      reason: `${noneNear}. ${shop.venue.name} is a ${word} ${where}.${shop.kind === 'cafe' ? ' Eat before you set out, or ask whether they will make something to take with you.' : ''} ${hoursLine} ${provenance}; nothing is booked.`,
      food: {
        ...baseFood(slot, slot === 'lunch' ? 'packed' : 'grocery', shop.fromBase <= 1 ? 'at_base' : 'on_route'),
        venueId: shop.venue.id,
        venueName: shop.venue.name,
        serviceType: shop.venue.serviceType,
        hoursUnknown: !hoursKnown,
        preparedOnDayNumber: input.dayNumber,
      },
    };
  }
  if (slot === 'dinner') {
    return { title: '', reason: `We did not find a place to name for dinner around ${input.baseName}. There may well be somewhere, so ask where you are staying; nothing is booked.`, food: baseFood(slot, 'unplanned', 'at_base') };
  }
  return {
    title: `Bring lunch — nothing to buy is listed near ${near}`,
    reason: `${noneNear}, and no food shop is on record near your base either. Bring food from before you set out, eat before you leave, or eat when you are back in ${input.baseName}.`,
    food: { ...baseFood(slot, 'packed', 'off_route'), preparedOnDayNumber: input.dayNumber },
  };
}
