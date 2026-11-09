import 'server-only';
import { chainTags, parseOsmOpeningHours, type FoodVenue } from '@sidequest/core';
import type { NormalizedOsmPlace } from './overpass';

/**
 * OSM FOOD — ONE CONVERSION FROM A MAPPED EATERY TO A `FoodVenue`.
 *
 * Shared by the compiler's food stage (`live.ts`) and the Discovery Scan's
 * food grounding (`discovery-scan/food.ts`), so the two paths cannot disagree
 * about what a mapped restaurant may claim.
 */

/**
 * A MAPPED EATERY, NORMALISED — AND HONEST ABOUT WHAT IT DOES NOT KNOW.
 *
 * Three fields carry almost all the risk here, and all three default to the
 * cautious answer:
 *
 * - **hours** are the map's `opening_hours` when the whole tag can be read
 *   (`parseOsmOpeningHours`), and `unknown` otherwise, which says so on the plan
 *   rather than guessing.
 * - **price** is `format_inferred` from the kind of venue, never a band anybody
 *   published, and the label says so.
 * - **dietary** claims come only from explicit `diet:*` tags, and land at
 *   `menu_lists_options` — never `venue_states_support`, which the schema
 *   reserves for the venue's own page and which is the only level a traveller
 *   with an allergy should ever act on.
 */
export function osmFoodVenue(
  osm: NormalizedOsmPlace,
  target: { regionId: string; destinationName: string; routingId: string; today?: string },
): FoodVenue | null {
  const { routingId } = target;
  const [key = '', value = ''] = osm.primaryTag.split('=');
  const serviceType = FOOD_SERVICE_BY_TAG[`${key}=${value}`];
  if (!serviceType) return null;

  /**
   * A shop nobody has confirmed the hours of is not a provisioning stop.
   *
   * The food schema refuses a provisioning venue without confirmed hours *and*
   * refuses a groceries meal period without provisioning, so an unconfirmed
   * grocery is unrepresentable — which is the schema being right: a packed lunch
   * nobody could buy strands the whole of the next day. This branch used to
   * build one anyway and hand the compiler a food dataset its own integrity gate
   * rejected.
   */
  if (serviceType === 'grocery' || serviceType === 'market') return null;

  const dietary: FoodVenue['dietary'] = [];
  for (const [tag, need] of DIET_TAGS) {
    const tagged = osm.planningTags[tag];
    if (tagged === 'yes' || tagged === 'only') {
      dietary.push({
        need,
        evidence: 'menu_lists_options',
        note: 'Community map data records this as available. Confirm with the venue if it matters.',
      });
    }
  }

  const website = osm.planningTags.website ?? osm.planningTags['contact:website'];
  let bookingUrl: string | undefined;
  if (website) {
    try {
      const url = new URL(website);
      if (url.protocol === 'https:' || url.protocol === 'http:') bookingUrl = url.toString();
    } catch {
      bookingUrl = undefined;
    }
  }

  return {
    id: `food-${osm.elementId.replace('/', '-')}`,
    regionId: target.regionId,
    name: osm.name,
    locality: target.destinationName,
    shortDescription: `${FOOD_SERVICE_WORDS[serviceType]} recorded in the map data for ${target.destinationName}.`,
    coordinates: osm.coordinates,
    tags: [osm.primaryTag, ...(osm.planningTags['brand:wikidata'] ? chainTags('brand_wikidata') : osm.planningTags.brand ? chainTags('brand_name') : [])],
    source: {
      name: 'OpenStreetMap',
      kind: 'osm',
      url: bookingUrl ?? osm.url,
      confidence: 0.6,
      lastVerified: target.today ?? new Date().toISOString().slice(0, 10),
      element: {
        elementId: osm.elementId,
        database: 'openstreetmap',
        licenceId: 'ODbL-1.0',
        ...(osm.sourceTimestamp ? { sourceTimestamp: osm.sourceTimestamp } : {}),
        url: osm.url,
      },
    },
    serviceType,
    mealPeriods: FOOD_MEAL_PERIODS[serviceType],
    cuisines: osm.planningTags.cuisine ? [osm.planningTags.cuisine.split(';')[0]!] : [],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: FOOD_SERVICE_MINUTES[serviceType],
    reservation: { requirement: 'unknown' },
    takeaway: osm.planningTags.takeaway === 'yes' ? 'confirmed' : 'unknown',
    /**
     * Provisioning is downgraded to `none` while hours are unknown.
     *
     * The food schema refuses a provisioning stop with unconfirmed hours, and it
     * is right to: a packed lunch nobody could buy strands the whole of the next
     * day. If research confirms the hours, the venue is rebuilt with its
     * provisioning intact.
     */
    provisioning: 'none',
    dietary,
    hours: osmHours(osm.planningTags.opening_hours),
    routingId,
    walkMinutesFromRouting: 0,
  };
}

/**
 * What the map says about when it is open, kept only when the whole tag can be
 * read (`parseOsmOpeningHours`). Community-recorded, so `unverified` and with a
 * recheck note: enough to avoid a door the map says is shut, not a promise.
 */
function osmHours(tag: string | undefined): FoodVenue['hours'] {
  const parsed = tag ? parseOsmOpeningHours(tag) : null;
  const provenance = (confidence: number, recheckNote: string) => ({ kind: 'estimated' as const, sourceName: 'OpenStreetMap contributors', confidence, volatility: 'dynamic' as const, recheckNote });
  if (!parsed) {
    return { kind: 'unknown', hoursConfidence: 'unverified', note: 'Nobody publishes hours for this that we could read.', provenance: provenance(0.3, 'We have no confirmed hours for this. Check before you go.') };
  }
  const recorded = provenance(0.55, 'Hours as recorded on OpenStreetMap, which may be out of date. Check before you go.');
  if (parsed.kind === 'always_open') return { kind: 'always_open', hoursConfidence: 'unverified', provenance: recorded };
  return { kind: 'scheduled', hoursConfidence: 'unverified', periods: parsed.periods, closedAnnualDates: [], provenance: recorded };
}

export const FOOD_SERVICE_BY_TAG: Record<string, FoodVenue['serviceType'] | undefined> = {
  'amenity=restaurant': 'restaurant',
  'amenity=cafe': 'cafe',
  'amenity=fast_food': 'takeaway',
  'amenity=food_court': 'food_hall',
  'amenity=pub': 'restaurant',
  'amenity=bar': 'restaurant',
  'amenity=marketplace': 'market',
  'shop=bakery': 'bakery',
  'shop=supermarket': 'grocery',
  'shop=convenience': 'grocery',
  'shop=greengrocer': 'grocery',
  'shop=deli': 'grocery',
  'shop=butcher': 'grocery',
};

export const FOOD_SERVICE_WORDS: Record<FoodVenue['serviceType'], string> = {
  restaurant: 'A restaurant',
  cafe: 'A café',
  bakery: 'A bakery',
  market: 'A market',
  grocery: 'A food shop',
  food_hall: 'A food hall',
  takeaway: 'A takeaway',
};

export const FOOD_MEAL_PERIODS: Record<FoodVenue['serviceType'], FoodVenue['mealPeriods']> = {
  restaurant: ['lunch', 'dinner'],
  cafe: ['breakfast', 'lunch', 'coffee'],
  bakery: ['breakfast', 'coffee'],
  market: ['lunch', 'groceries'],
  grocery: ['groceries'],
  food_hall: ['lunch', 'dinner'],
  takeaway: ['lunch', 'dinner'],
};

export const FOOD_SERVICE_MINUTES: Record<FoodVenue['serviceType'], number> = {
  restaurant: 75,
  cafe: 30,
  bakery: 15,
  market: 40,
  grocery: 20,
  food_hall: 45,
  takeaway: 20,
};

export const DIET_TAGS: readonly [string, FoodVenue['dietary'][number]['need']][] = [
  ['diet:vegetarian', 'vegetarian'],
  ['diet:vegan', 'vegan'],
  ['diet:gluten_free', 'gluten_free'],
  ['diet:halal', 'halal'],
  ['diet:kosher', 'kosher'],
];
