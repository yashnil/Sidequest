import {
  foodDatasetSchema,
  type FoodDataset,
  type FoodHoursConfidence,
  type FoodVenueInput,
} from '../schemas/food';
import type { FoodProvider } from '../food/provider';
import type { OperatingPeriod } from '../schemas/hours';
import type { SourceProvenance } from '../schemas/provenance';

/**
 * EASTERN SIERRA FOOD — twenty venues, and two places the agencies say have none.
 *
 * THE EDITORIAL LAW OF THIS FILE
 *
 * Every fact below was read off a page on 2026-07-31 and every record says which
 * page and how well it held up. Three things this region does that the
 * attraction data never had to cope with, and how each is handled:
 *
 *   1. Almost nothing publishes a closing time. The pattern is "daily from
 *      11am" and then "until close". A closing time is therefore *authored
 *      conservatively* and marked `closing_time_estimated`, never presented as
 *      published. The traveller is told to ring.
 *   2. Several official websites are broken — a 500, an invalid TLS certificate,
 *      a dead DNS record. Where the venue's own site could not be read, the
 *      provenance says `authored` and names what was read instead. It is never
 *      upgraded to `official` because a tourism board happened to agree.
 *   3. Winter and summer schedules are the norm here, not the exception. Only
 *      genuinely seasonal businesses carry a month restriction. A year-round
 *      business whose winter hours we could not read is *not* encoded as shut in
 *      winter, because that is a false statement dressed as a fact — see the
 *      exclusions at the foot of this file.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 *
 * No ratings and no review counts: a five-star average is a popularity signal,
 * and this product ranks by fit. No menu items beyond the ones a venue itself
 * calls a signature. No dietary claim that the venue did not make in its own
 * words — a DMO directory tagging somewhere "gluten-free option" is the
 * directory's tag, not the kitchen's, and the difference matters to the one
 * person it matters to most. No temporary closure, no "hours this week", no
 * roadworks schedule. Nothing dated.
 */

const VERIFIED_ON = '2026-07-31';
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Read off the business's own website on `VERIFIED_ON`. */
function official(sourceName: string, sourceUrl: string, extra?: Partial<SourceProvenance>): SourceProvenance {
  return {
    kind: 'official',
    sourceName,
    sourceUrl,
    lastVerified: VERIFIED_ON,
    confidence: 0.9,
    volatility: 'stable',
    ...extra,
  };
}

/**
 * Written from something other than the venue's own site — its own social
 * account, a county tourism board, a chamber listing. Never called official, and
 * never above 0.75, because the venue has not said it.
 */
function secondhand(
  sourceName: string,
  sourceUrl: string,
  recheckNote: string,
  confidence = 0.65,
): SourceProvenance {
  return {
    kind: 'authored',
    sourceName,
    sourceUrl,
    confidence,
    volatility: 'dynamic',
    recheckNote,
  };
}

function everyDay(label: string, openMinute: number, closeMinute: number): OperatingPeriod {
  return { label, months: ALL_MONTHS, windows: [{ openMinute, closeMinute }] };
}

const H = (hour: number, minute = 0) => hour * 60 + minute;

function scheduled(
  periods: readonly OperatingPeriod[],
  provenance: SourceProvenance,
  extra?: { hoursConfidence?: FoodHoursConfidence; note?: string },
) {
  return {
    kind: 'scheduled' as const,
    periods: [...periods],
    closedAnnualDates: [],
    hoursConfidence: extra?.hoursConfidence ?? ('published' as const),
    ...(extra?.note ? { note: extra.note } : {}),
    provenance,
  };
}

const CURATED_SOURCE = { kind: 'curated', confidence: 0.8, lastVerified: VERIFIED_ON } as const;
const OFFICIAL_SOURCE = { kind: 'official', confidence: 0.9, lastVerified: VERIFIED_ON } as const;

const VENUES: FoodVenueInput[] = [
  // -------------------------------------------------------------------------
  // Mammoth Lakes — early starts
  // -------------------------------------------------------------------------
  {
    id: 'black-velvet-coffee',
    regionId: 'eastern-sierra',
    name: 'Black Velvet Coffee',
    locality: 'Mammoth Lakes',
    shortDescription:
      'Roasts its own beans on Main Street and opens at six, which is what makes it the stop on the way to a trailhead rather than a place you go for breakfast.',
    coordinates: { lat: 37.64754, lng: -118.971895 },
    tags: ['early', 'roaster', 'en-route'],
    serviceType: 'cafe',
    mealPeriods: ['coffee', 'snack'],
    cuisines: ['Coffee'],
    priceBand: 'budget',
    // Their own site publishes a drink menu and no prices; the band is the town
    // DMO's "under $12" listing, which is a directory figure and says so.
    priceEvidence: 'directory_band',
    serviceMinutes: 15,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'none',
    dietary: [],
    localSpecialty: {
      label: 'Roasted on site',
      note: 'One of the few genuine roasters between Bishop and Lee Vining.',
      sourceUrl: 'https://www.blackvelvetcoffee.com/',
    },
    hours: scheduled([everyDay('Daily', H(6), H(18))], official('Black Velvet Coffee', 'https://www.blackvelvetcoffee.com/contact-us')),
    routingId: 'node-mammoth-main-street',
    walkMinutesFromRouting: 1,
    source: { ...OFFICIAL_SOURCE, name: 'Black Velvet Coffee', url: 'https://www.blackvelvetcoffee.com/' },
  },
  {
    id: 'looney-bean-mammoth',
    regionId: 'eastern-sierra',
    name: 'Looney Bean',
    locality: 'Mammoth Lakes',
    shortDescription:
      'Been roasting here since 1992, bakes its own pastries, and opens at six with breakfast burritos — the practical version of breakfast before a long day out.',
    coordinates: { lat: 37.645701, lng: -118.966892 },
    tags: ['early', 'roaster', 'en-route'],
    serviceType: 'cafe',
    mealPeriods: ['breakfast', 'coffee', 'snack'],
    cuisines: ['Coffee', 'Breakfast'],
    priceBand: 'budget',
    priceEvidence: 'directory_band',
    serviceMinutes: 25,
    reservation: { requirement: 'walk_in_only' },
    takeaway: 'unknown',
    provisioning: 'snacks',
    dietary: [],
    hours: scheduled(
      [everyDay('Daily', H(6), H(17))],
      official('Looney Bean Mammoth', 'https://www.looneybeanmammoth.com/pages/location-and-hours', {
        volatility: 'seasonal_recurring',
        recheckNote:
          'Their own page says hours may vary slightly around holidays and during winter storms.',
      }),
    ),
    routingId: 'node-mammoth-old-mammoth-road',
    walkMinutesFromRouting: 1,
    source: { ...OFFICIAL_SOURCE, name: 'Looney Bean Mammoth', url: 'https://www.looneybeanmammoth.com/' },
  },
  {
    id: 'shea-schats-bakery',
    regionId: 'eastern-sierra',
    name: "Shea Schat's Bakery",
    locality: 'Mammoth Lakes',
    shortDescription:
      'Old-world bakery on Main Street with a sandwich counter, open from six. The Mammoth branch of the Schat family tradition — a different business from the Bishop one.',
    coordinates: { lat: 37.647293, lng: -118.970826 },
    tags: ['early', 'bread', 'takeaway'],
    serviceType: 'bakery',
    mealPeriods: ['breakfast', 'coffee', 'lunch', 'snack'],
    cuisines: ['Bakery', 'Sandwiches'],
    priceBand: 'budget',
    priceEvidence: 'directory_band',
    serviceMinutes: 20,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'packed_meals',
    dietary: [],
    localSpecialty: {
      label: 'Sheepherder bread',
      note: 'The Basque loaf the Owens Valley is known for, in its Mammoth incarnation.',
    },
    hours: scheduled(
      [everyDay('Daily', H(6), H(18))],
      secondhand(
        'Mammoth Lakes Tourism',
        'https://www.visitmammoth.com/',
        "Their own website returns a server error, so these hours come from the town's tourism listing rather than from the bakery. Worth a look at the door.",
      ),
      { hoursConfidence: 'unverified' },
    ),
    routingId: 'node-mammoth-main-street',
    walkMinutesFromRouting: 1,
    source: { ...CURATED_SOURCE, confidence: 0.6, name: 'Mammoth Lakes Tourism', url: 'https://www.visitmammoth.com/' },
  },
  {
    id: 'old-new-york-deli-bakery',
    regionId: 'eastern-sierra',
    name: 'Old New York Deli & Bakery Co.',
    locality: 'Mammoth Lakes',
    shortDescription:
      'Boiled bagels, house cream cheeses and a proper deli counter at the Village. The one place here that will take an order ahead for you to carry out.',
    coordinates: { lat: 37.651126, lng: -118.985194 },
    tags: ['takeaway', 'deli', 'packed-lunch'],
    serviceType: 'bakery',
    mealPeriods: ['breakfast', 'coffee', 'lunch', 'snack'],
    cuisines: ['Deli', 'Bagels'],
    priceBand: 'budget',
    priceEvidence: 'directory_band',
    serviceMinutes: 20,
    reservation: { requirement: 'walk_in_only' },
    takeaway: 'confirmed',
    provisioning: 'packed_meals',
    dietary: [],
    hours: scheduled(
      [everyDay('Daily', H(6), H(16))],
      official('Old New York Deli & Bakery Co.', 'https://www.oldnewyork.com/', {
        volatility: 'dynamic',
        recheckNote:
          'Their own site prints these hours and then adds "hours vary per season, please call". Ring before a day depends on them.',
      }),
      { hoursConfidence: 'unverified' },
    ),
    routingId: 'the-village-at-mammoth',
    walkMinutesFromRouting: 2,
    source: { ...OFFICIAL_SOURCE, name: 'Old New York Deli & Bakery Co.', url: 'https://www.oldnewyork.com/' },
  },
  {
    id: 'the-stove-mammoth',
    regionId: 'eastern-sierra',
    name: 'The Stove',
    locality: 'Mammoth Lakes',
    shortDescription:
      'Forty-odd years of omelettes, pancakes and homemade pie on Old Mammoth Road. A sit-down breakfast rather than a stop on the way — it opens at seven, not at dawn.',
    coordinates: { lat: 37.636817, lng: -118.966876 },
    tags: ['breakfast', 'diner', 'long-standing'],
    serviceType: 'restaurant',
    mealPeriods: ['breakfast', 'lunch'],
    cuisines: ['American', 'Diner'],
    priceBand: 'moderate',
    priceEvidence: 'directory_band',
    serviceMinutes: 60,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'none',
    dietary: [],
    localSpecialty: {
      label: 'Homemade pies',
      note: 'Family-run for more than forty years, and the pies are on their own signage.',
    },
    hours: scheduled(
      [everyDay('Daily', H(7), H(14))],
      secondhand(
        "The Stove's own Instagram",
        'https://www.instagram.com/thestovemammoth/',
        'Their website will not load, so this is their own social account. Expect a queue on a summer weekend morning.',
        0.7,
      ),
    ),
    routingId: 'node-mammoth-old-mammoth-road',
    walkMinutesFromRouting: 2,
    source: { ...CURATED_SOURCE, confidence: 0.7, name: "The Stove's own Instagram", url: 'https://www.instagram.com/thestovemammoth/' },
  },

  // -------------------------------------------------------------------------
  // Mammoth Lakes — provisioning
  // -------------------------------------------------------------------------
  {
    id: 'vons-mammoth-lakes',
    regionId: 'eastern-sierra',
    name: 'Vons',
    locality: 'Mammoth Lakes',
    shortDescription:
      'The full supermarket on Old Mammoth Road, open around the clock, with a deli counter. Where a packed lunch and a day of trail food actually come from.',
    coordinates: { lat: 37.638691, lng: -118.96546 },
    tags: ['grocery', 'packed-lunch', '24-hour'],
    serviceType: 'grocery',
    mealPeriods: ['groceries', 'snack'],
    cuisines: [],
    priceBand: 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: 25,
    reservation: { requirement: 'walk_in_only' },
    takeaway: 'confirmed',
    provisioning: 'packed_meals',
    dietary: [],
    hours: {
      kind: 'always_open',
      hoursConfidence: 'published',
      note: 'The in-store pharmacy keeps much narrower hours than the shop, and shuts over the middle of the day.',
      provenance: official('Vons store page', 'https://local.vons.com/ca/mammoth-lakes/481-old-mammoth-rd.html'),
    },
    routingId: 'node-mammoth-old-mammoth-road',
    walkMinutesFromRouting: 1,
    source: { ...OFFICIAL_SOURCE, name: 'Vons', url: 'https://local.vons.com/ca/mammoth-lakes/481-old-mammoth-rd.html' },
  },
  {
    id: 'grocery-outlet-mammoth',
    regionId: 'eastern-sierra',
    name: 'Grocery Outlet',
    locality: 'Mammoth Lakes',
    shortDescription:
      'Independently run discount grocery on Old Mammoth Road. Stock is opportunistic, so it is a cheaper shop rather than a reliable one for anything specific.',
    coordinates: { lat: 37.645986, lng: -118.965878 },
    tags: ['grocery', 'budget', 'packed-lunch'],
    serviceType: 'grocery',
    mealPeriods: ['groceries', 'snack'],
    cuisines: [],
    priceBand: 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: 25,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'packed_meals',
    dietary: [],
    hours: scheduled(
      [everyDay('Daily', H(7), H(21))],
      {
        // Deliberately no URL. The chain has no page for this store and a link
        // to Instagram's front door is not a source; naming what was read is
        // the honest version of the same disclosure.
        kind: 'authored',
        sourceName: "the store's own social account",
        confidence: 0.7,
        volatility: 'dynamic',
        recheckNote:
          'The chain has no working page for this store, so these hours are its own social post matched against the town tourism listing.',
      },
    ),
    routingId: 'node-mammoth-old-mammoth-road',
    walkMinutesFromRouting: 1,
    source: { ...CURATED_SOURCE, confidence: 0.7, name: "The store's own Instagram" },
  },

  // -------------------------------------------------------------------------
  // Mammoth Lakes — lunch and dinner
  // -------------------------------------------------------------------------
  {
    id: 'mammoth-brewing-eatery',
    regionId: 'eastern-sierra',
    name: 'Mammoth Brewing Company',
    locality: 'Mammoth Lakes',
    shortDescription:
      "The town's brewery, with a kitchen attached. Walk-in only, no bookings taken, and the most explicit about what it can do for a dietary requirement of anywhere here.",
    coordinates: { lat: 37.6487734, lng: -118.9834999 },
    tags: ['brewery', 'casual', 'walk-in'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'snack', 'dinner'],
    cuisines: ['American', 'Brewpub'],
    priceBand: 'moderate',
    priceEvidence: 'published_menu',
    serviceMinutes: 75,
    reservation: {
      requirement: 'walk_in_only',
      note: 'Their own site says plainly that they do not take reservations.',
    },
    takeaway: 'confirmed',
    provisioning: 'none',
    dietary: [
      {
        need: 'gluten_free',
        evidence: 'venue_states_support',
        note: 'Their published menu offers a gluten-free bun and a gluten-free buckwheat flatbread crust, each for a surcharge.',
        sourceUrl: 'https://mammothbrewingco.com/eatery-menu/',
      },
      {
        need: 'vegan',
        evidence: 'venue_states_support',
        note: 'Their published menu offers vegan cheese and a quinoa falafel bowl with vegan tzatziki.',
        sourceUrl: 'https://mammothbrewingco.com/eatery-menu/',
      },
      {
        need: 'vegetarian',
        evidence: 'menu_lists_options',
        note: 'The published menu carries a veggie burger, a falafel bowl and salads.',
        sourceUrl: 'https://mammothbrewingco.com/eatery-menu/',
      },
    ],
    hours: scheduled(
      [everyDay('Daily', H(11, 30), H(21))],
      official('Mammoth Brewing Company', 'https://mammothbrewingco.com/eatery-menu/', {
        volatility: 'dynamic',
        recheckNote:
          'They publish an opening time and then "until close", and warn of early closures in the shoulder seasons. The closing time here is ours, not theirs.',
      }),
      { hoursConfidence: 'closing_time_estimated' },
    ),
    routingId: 'node-mammoth-main-street',
    walkMinutesFromRouting: 1,
    source: { ...OFFICIAL_SOURCE, name: 'Mammoth Brewing Company', url: 'https://mammothbrewingco.com/' },
  },
  {
    id: 'robertos-cafe-mammoth',
    regionId: 'eastern-sierra',
    name: "Roberto's Cafe",
    locality: 'Mammoth Lakes',
    shortDescription:
      "Mexican, family-run since 1985, and the town institution people actually name. Closed Mondays. Takeaway when they are not slammed.",
    coordinates: { lat: 37.6418615, lng: -118.9664378 },
    tags: ['casual', 'long-standing', 'walk-in'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'dinner'],
    cuisines: ['Mexican'],
    priceBand: 'moderate',
    priceEvidence: 'published_menu',
    serviceMinutes: 70,
    reservation: {
      requirement: 'walk_in_only',
      note: 'Their own site says they do not take reservations.',
    },
    takeaway: 'confirmed',
    provisioning: 'none',
    dietary: [
      {
        need: 'gluten_free',
        evidence: 'venue_states_support',
        note: 'Their own site discusses gluten, noting that the corn-based dishes — tacos, tamales, enchiladas — are made without it. They make no claim about a shared kitchen.',
        sourceUrl: 'https://robertoscafe.com/',
      },
      {
        need: 'vegetarian',
        evidence: 'menu_lists_options',
        note: 'Their own site lists vegetarian options.',
        sourceUrl: 'https://robertoscafe.com/',
      },
    ],
    hours: scheduled(
      [
        {
          label: 'Tuesday to Sunday',
          months: ALL_MONTHS,
          daysOfWeek: [0, 2, 3, 4, 5, 6],
          windows: [{ openMinute: H(11), closeMinute: H(21) }],
        },
      ],
      official("Roberto's Cafe", 'https://robertoscafe.com/contact/', {
        volatility: 'dynamic',
        recheckNote:
          'They publish an opening time and no closing time. The 21:00 here is a conservative reading, not theirs.',
      }),
      { hoursConfidence: 'closing_time_estimated' },
    ),
    routingId: 'node-mammoth-old-mammoth-road',
    walkMinutesFromRouting: 2,
    source: { ...OFFICIAL_SOURCE, name: "Roberto's Cafe", url: 'https://robertoscafe.com/' },
  },
  {
    id: 'toomeys-mammoth',
    regionId: 'eastern-sierra',
    name: "Toomey's",
    locality: 'Mammoth Lakes',
    shortDescription:
      'Californian cooking with game meats and seafood, at the Village. Open eleven to nine, which makes it one of the few places that will feed you at an awkward hour.',
    coordinates: { lat: 37.649814, lng: -118.9841288 },
    tags: ['village', 'walk-in'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'dinner'],
    cuisines: ['Californian', 'New American'],
    priceBand: 'upscale',
    priceEvidence: 'published_menu',
    serviceMinutes: 80,
    reservation: { requirement: 'unknown' },
    takeaway: 'confirmed',
    provisioning: 'none',
    // Their published menu carries no dietary marking of any kind. Vegetarian
    // dishes exist on it; that is a menu fact, not a claim by the kitchen, and
    // the difference is the whole point of this field.
    dietary: [],
    hours: scheduled([everyDay('Daily', H(11), H(21))], official("Toomey's", 'https://toomeysmammoth.com/menu.html')),
    routingId: 'the-village-at-mammoth',
    walkMinutesFromRouting: 2,
    source: { ...OFFICIAL_SOURCE, name: "Toomey's", url: 'https://toomeysmammoth.com/' },
  },
  {
    id: 'the-mogul-mammoth',
    regionId: 'eastern-sierra',
    name: 'The Mogul',
    locality: 'Mammoth Lakes',
    shortDescription:
      'A steakhouse that has been here since the nineties, open seven nights, dinner from half five. Prices are on their own menu, which is rarer here than it should be.',
    coordinates: { lat: 37.6451273, lng: -118.9666974 },
    tags: ['dinner', 'special'],
    serviceType: 'restaurant',
    mealPeriods: ['dinner'],
    cuisines: ['Steakhouse', 'American'],
    priceBand: 'upscale',
    priceEvidence: 'published_menu',
    serviceMinutes: 95,
    reservation: {
      // No `bookingUrl`: they take bookings on the telephone, and rendering a
      // homepage as "book with them" implies an online table that is not there.
      requirement: 'recommended',
      note: 'They take bookings by telephone, on 760-934-3039.',
    },
    provisioning: 'none',
    dietary: [
      {
        need: 'vegetarian',
        evidence: 'menu_lists_options',
        note: 'Their published menu carries a vegetarian section.',
        sourceUrl: 'https://themogul.com/m-entree.htm',
      },
    ],
    hours: scheduled(
      [everyDay('Daily', H(17, 30), H(21, 30))],
      official('The Mogul', 'https://themogul.com/', {
        volatility: 'dynamic',
        recheckNote:
          'They publish a dinner opening and no closing time, and make no statement about the seasons. The close here is ours.',
      }),
      { hoursConfidence: 'closing_time_estimated' },
    ),
    routingId: 'node-mammoth-old-mammoth-road',
    walkMinutesFromRouting: 2,
    source: { ...OFFICIAL_SOURCE, name: 'The Mogul', url: 'https://themogul.com/' },
  },

  // -------------------------------------------------------------------------
  // Convict Lake — nine miles out, and open all year
  // -------------------------------------------------------------------------
  {
    id: 'convict-lake-restaurant',
    regionId: 'eastern-sierra',
    name: 'Restaurant at Convict Lake',
    locality: 'Convict Lake',
    shortDescription:
      'Dinner under the Convict Lake headwall, seven nights a week and year-round, which is unusual out here.',
    coordinates: { lat: 37.5976932, lng: -118.8507354 },
    tags: ['special', 'scenic', 'booking'],
    serviceType: 'restaurant',
    mealPeriods: ['dinner'],
    cuisines: ['Continental', 'Trout'],
    priceBand: 'special',
    // Their fine-dining page publishes dishes and no prices. The band is read
    // off the composition of the menu, which is a judgement and says so.
    priceEvidence: 'format_inferred',
    serviceMinutes: 105,
    reservation: {
      requirement: 'recommended',
      note: 'Their own site says reservations are strongly recommended for the dining room; the lounge is first come, first served.',
      bookingUrl: 'https://convictlake.com/fine-dining/',
    },
    provisioning: 'none',
    dietary: [
      {
        need: 'gluten_free',
        evidence: 'venue_states_support',
        note: 'Their own page states: "Our entrees are gluten free except Beef Wellington, Fettuccini, Trout and Filet Mignon." They make no claim about a shared kitchen.',
        sourceUrl: 'https://convictlake.com/fine-dining/',
      },
    ],
    localSpecialty: {
      label: 'Alpers trout',
      note: 'Trout farmed in the Owens Valley, and the dish this restaurant is known for beyond the region.',
      sourceUrl: 'https://convictlake.com/fine-dining/',
    },
    hours: scheduled(
      [everyDay('Daily', H(17, 30), H(21, 30))],
      official('Convict Lake Resort', 'https://convictlake.com/our-resort/hours/', {
        volatility: 'dynamic',
        recheckNote:
          'They publish an opening time and no close, and ask you to ring for private-event closures, which are not listed anywhere. The close here is ours.',
      }),
      { hoursConfidence: 'closing_time_estimated' },
    ),
    routingId: 'convict-lake',
    walkMinutesFromRouting: 0,
    source: { ...OFFICIAL_SOURCE, name: 'Convict Lake Resort', url: 'https://convictlake.com/fine-dining/' },
  },
  {
    id: 'convict-lake-general-store',
    regionId: 'eastern-sierra',
    name: 'Convict Lake General Store',
    locality: 'Convict Lake',
    shortDescription:
      'Opens at six at the resort, which makes it the only provisioning stop out here that is awake before a dawn start.',
    coordinates: { lat: 37.5976932, lng: -118.8507354 },
    tags: ['store', 'early', 'snacks'],
    serviceType: 'market',
    mealPeriods: ['groceries', 'snack', 'coffee'],
    cuisines: [],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 15,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'snacks',
    dietary: [],
    hours: scheduled(
      [
        {
          label: 'Monday to Saturday',
          months: ALL_MONTHS,
          daysOfWeek: [1, 2, 3, 4, 5, 6],
          windows: [{ openMinute: H(6), closeMinute: H(20) }],
        },
        {
          label: 'Sunday',
          months: ALL_MONTHS,
          daysOfWeek: [0],
          windows: [{ openMinute: H(6), closeMinute: H(19) }],
        },
      ],
      official('Convict Lake Resort', 'https://convictlake.com/our-resort/hours/'),
    ),
    routingId: 'convict-lake',
    walkMinutesFromRouting: 0,
    source: { ...OFFICIAL_SOURCE, name: 'Convict Lake Resort', url: 'https://convictlake.com/our-resort/hours/' },
  },

  // -------------------------------------------------------------------------
  // June Lake and Mono Basin — seasonal, and honest about it
  // -------------------------------------------------------------------------
  {
    id: 'june-lake-brewing',
    regionId: 'eastern-sierra',
    name: 'June Lake Brewing',
    locality: 'June Lake',
    shortDescription:
      'Taproom with a Mexican food truck parked alongside, open every day of the year including Christmas. Card only, no cash, no bookings.',
    coordinates: { lat: 37.7787017, lng: -119.0759567 },
    tags: ['casual', 'walk-in', 'june-lake'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'snack', 'dinner'],
    cuisines: ['Mexican', 'Brewpub'],
    priceBand: 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: 60,
    reservation: {
      requirement: 'walk_in_only',
      note: 'Their own site says no reservations and no private events. Card only — they do not take cash.',
    },
    provisioning: 'none',
    dietary: [],
    hours: scheduled(
      [everyDay('Daily', H(12), H(19))],
      official('June Lake Brewing', 'https://www.junelakebrewing.com/where.html', {
        volatility: 'dynamic',
        recheckNote:
          'The taproom runs to eight but the food truck stops at seven, so the window here is the food. Which truck is cooking changes — their own listings page is out of date.',
      }),
    ),
    routingId: 'node-june-lake-village',
    walkMinutesFromRouting: 1,
    source: { ...OFFICIAL_SOURCE, name: 'June Lake Brewing', url: 'https://www.junelakebrewing.com/' },
  },
  {
    id: 'tiger-bar-june-lake',
    regionId: 'eastern-sierra',
    name: 'Tiger Bar & Cafe',
    locality: 'June Lake',
    shortDescription:
      'Trading since 1932 and the only place in June Lake that serves all three meals — but its website has gone and nobody publishes its hours.',
    coordinates: { lat: 37.780021, lng: -119.0755952 },
    tags: ['long-standing', 'june-lake'],
    serviceType: 'restaurant',
    mealPeriods: ['breakfast', 'lunch', 'dinner'],
    cuisines: ['American', 'Diner'],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 70,
    reservation: { requirement: 'unknown' },
    provisioning: 'none',
    dietary: [],
    hours: {
      kind: 'unknown',
      hoursConfidence: 'unverified',
      note: 'Mono County lists it as serving breakfast, lunch and dinner. Nobody publishes the times, and its own domain no longer resolves.',
      provenance: {
        kind: 'authored',
        sourceName: 'Mono County Tourism',
        sourceUrl: 'https://www.monocounty.org/listing/tiger-bar-&-cafe/663/',
        confidence: 0.4,
        volatility: 'dynamic',
        recheckNote:
          'Ring before you go — we could not confirm its hours, or that it is still trading.',
      },
    },
    routingId: 'node-june-lake-village',
    walkMinutesFromRouting: 1,
    source: { ...CURATED_SOURCE, confidence: 0.5, name: 'Mono County Tourism', url: 'https://www.monocounty.org/listing/tiger-bar-&-cafe/663/' },
  },
  {
    id: 'silver-lake-resort-cafe',
    regionId: 'eastern-sierra',
    name: 'Silver Lake Cafe',
    locality: 'June Lake',
    shortDescription:
      'A 1916 resort at the top of the June Lake Loop with a counter cafe and a store. Breakfast from seven, and shut for the winter.',
    coordinates: { lat: 37.7801005, lng: -119.1287541 },
    tags: ['seasonal', 'june-lake', 'breakfast'],
    serviceType: 'cafe',
    mealPeriods: ['breakfast', 'coffee', 'lunch', 'snack', 'groceries'],
    cuisines: ['American', 'Diner'],
    priceBand: 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: 45,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'snacks',
    dietary: [],
    localSpecialty: {
      label: 'The Silver Lake burger',
      note: 'Their own words, and the resort has been here since 1916.',
      sourceUrl: 'https://www.silverlakeresort.net/store-cafe/',
    },
    hours: scheduled(
      [
        {
          label: 'Season',
          months: [4, 5, 6, 7, 8, 9, 10],
          windows: [{ openMinute: H(7), closeMinute: H(14) }],
        },
      ],
      official('Silver Lake Resort', 'https://www.silverlakeresort.net/store-cafe/', {
        volatility: 'seasonal_recurring',
        recheckNote:
          'Open roughly late April to mid-October, and the upper loop road closes for the winter. The store next door runs later than the cafe. Season boundaries move with the snowpack, so the two ends of this are ours rather than theirs.',
      }),
      { hoursConfidence: 'unverified' },
    ),
    routingId: 'node-silver-lake',
    walkMinutesFromRouting: 0,
    source: { ...OFFICIAL_SOURCE, name: 'Silver Lake Resort', url: 'https://www.silverlakeresort.net/store-cafe/' },
  },
  {
    id: 'whoa-nellie-deli',
    regionId: 'eastern-sierra',
    name: 'Whoa Nellie Deli',
    locality: 'Lee Vining',
    shortDescription:
      'Inside the petrol station at the Tioga Pass junction, and the most famous food stop on this stretch of 395. Open from half six, seasonally.',
    coordinates: { lat: 37.9474179, lng: -119.113622 },
    tags: ['seasonal', 'en-route', 'mono-basin'],
    serviceType: 'restaurant',
    mealPeriods: ['breakfast', 'coffee', 'lunch', 'snack', 'dinner', 'groceries'],
    cuisines: ['Californian', 'Seafood'],
    priceBand: 'moderate',
    // The menu is published as images we could not read prices from.
    priceEvidence: 'format_inferred',
    serviceMinutes: 55,
    reservation: { requirement: 'walk_in_only' },
    provisioning: 'snacks',
    dietary: [],
    localSpecialty: {
      label: 'Fish tacos',
      note: 'Their own site calls them world famous. What is checkable is that this stop has been at the Tioga junction since 1996 and is the one people name on this stretch of the highway.',
      sourceUrl: 'http://www.whoanelliedeli.com/menu-1',
    },
    hours: scheduled(
      [
        {
          // April to October, because that is what the note beside this says.
          // Five to nine was narrower than the source and made the planner
          // state, as a fact, that a place open on 2 October was shut.
          label: 'Season',
          months: [4, 5, 6, 7, 8, 9, 10],
          windows: [
            { openMinute: H(6, 30), closeMinute: H(10, 45) },
            { openMinute: H(11), closeMinute: H(21) },
          ],
        },
      ],
      official('Whoa Nellie Deli', 'http://www.whoanelliedeli.com/menu-1', {
        volatility: 'seasonal_recurring',
        recheckNote:
          'Open roughly the end of April to the first week of October, and the season tracks the Tioga Pass opening — it slips in a heavy snow year, so the two ends of the season are ours rather than theirs.',
      }),
      { hoursConfidence: 'unverified' },
    ),
    routingId: 'node-lee-vining-junction',
    walkMinutesFromRouting: 0,
    source: { ...OFFICIAL_SOURCE, name: 'Whoa Nellie Deli', url: 'http://www.whoanelliedeli.com/' },
  },

  // -------------------------------------------------------------------------
  // Bishop — forty minutes south, and where a southern day naturally ends
  // -------------------------------------------------------------------------
  {
    id: 'erick-schats-bakkery',
    regionId: 'eastern-sierra',
    name: "Erick Schat's Bakkerÿ",
    locality: 'Bishop',
    shortDescription:
      'The Owens Valley institution: sheepherder bread on the same stone hearths since the thirties, and the reason most people stop in Bishop at all.',
    coordinates: { lat: 37.3678518, lng: -118.3957086 },
    tags: ['bishop', 'bread', 'early', 'takeaway'],
    serviceType: 'bakery',
    mealPeriods: ['breakfast', 'coffee', 'lunch', 'snack'],
    cuisines: ['Bakery', 'Sandwiches'],
    priceBand: 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: 30,
    reservation: { requirement: 'walk_in_only' },
    takeaway: 'confirmed',
    provisioning: 'packed_meals',
    dietary: [],
    localSpecialty: {
      label: 'Original Sheepherder Bread',
      note: 'Brought to the valley by Basque sheepherders and trademarked here in 1938.',
    },
    hours: scheduled(
      [everyDay('Daily', H(6), H(17))],
      secondhand(
        "The bakery's own pages",
        'https://schatsbakkery.wordpress.com/about/',
        'Their main website will not serve a valid certificate. Every source agrees they open at six, seven days; the closing time here is a conservative reading and sources disagree on it.',
        0.6,
      ),
      { hoursConfidence: 'closing_time_estimated' },
    ),
    routingId: 'bishop-town',
    walkMinutesFromRouting: 1,
    source: { ...CURATED_SOURCE, confidence: 0.7, name: "Erick Schat's Bakkerÿ", url: 'https://schatsbakkery.wordpress.com/about/' },
  },
  {
    id: 'mahogany-smoked-meats',
    regionId: 'eastern-sierra',
    name: 'Mahogany Smoked Meats',
    locality: 'Bishop',
    shortDescription:
      'Smoking meat north of Bishop since 1922, with a deli counter that opens at half six. Breakfast burritos until half ten only, and they say so themselves.',
    coordinates: { lat: 37.3760108, lng: -118.4176885 },
    tags: ['bishop', 'early', 'takeaway', 'packed-lunch'],
    serviceType: 'market',
    mealPeriods: ['breakfast', 'lunch', 'snack', 'groceries'],
    cuisines: ['Smokehouse', 'Deli'],
    priceBand: 'budget',
    priceEvidence: 'format_inferred',
    serviceMinutes: 25,
    reservation: { requirement: 'walk_in_only' },
    takeaway: 'confirmed',
    provisioning: 'packed_meals',
    dietary: [],
    localSpecialty: {
      label: 'A century of jerky',
      note: 'Their own site says old-school methods for over a hundred years, and it has been on this stretch of the 395 since 1922.',
      sourceUrl: 'https://smokedmeats.com/pages/smokehouse-deli',
    },
    hours: scheduled(
      [everyDay('Daily', H(6, 30), H(17))],
      official('Mahogany Smoked Meats', 'https://smokedmeats.com/pages/smokehouse-deli'),
    ),
    routingId: 'node-bishop-north',
    walkMinutesFromRouting: 0,
    source: { ...OFFICIAL_SOURCE, name: 'Mahogany Smoked Meats', url: 'https://smokedmeats.com/' },
  },
  {
    id: 'holy-smoke-bishop',
    regionId: 'eastern-sierra',
    name: 'Holy Smoke Texas Style BBQ',
    locality: 'Bishop',
    shortDescription:
      'Texas barbecue a hundred metres across Main Street from the bakery, which makes it the obvious early dinner if a southern day runs long. Shut on Tuesdays.',
    coordinates: { lat: 37.3681644, lng: -118.3950154 },
    tags: ['bishop', 'casual'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'dinner'],
    cuisines: ['Barbecue'],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 65,
    reservation: { requirement: 'unknown' },
    provisioning: 'none',
    dietary: [],
    hours: scheduled(
      [
        {
          label: 'Wednesday to Monday',
          months: ALL_MONTHS,
          daysOfWeek: [0, 1, 3, 4, 5, 6],
          windows: [{ openMinute: H(11), closeMinute: H(20) }],
        },
      ],
      secondhand(
        'Bishop Chamber of Commerce',
        'https://members.bishopchamberofcommerce.com/list/member/holy-smoke-texas-style-bbq-149',
        'Their own website refuses every request. The Tuesday closure and the eleven o\'clock opening are consistent everywhere; the closing time is not, and the one here is conservative.',
        0.6,
      ),
      { hoursConfidence: 'closing_time_estimated' },
    ),
    routingId: 'bishop-town',
    walkMinutesFromRouting: 1,
    source: { ...CURATED_SOURCE, confidence: 0.6, name: 'Bishop Chamber of Commerce', url: 'https://members.bishopchamberofcommerce.com/list/member/holy-smoke-texas-style-bbq-149' },
  },
];

/**
 * Places the managing agency states have no food, in the agency's own words.
 *
 * A record rather than an absence, because the two behave differently. "We have
 * not indexed this valley" and "the National Park Service says there is nothing
 * in it" support completely different sentences, and only the second lets a plan
 * say *pack a lunch before you leave town* with a straight face.
 *
 * Deliberately one entry. A second was written for Minaret Vista, on the
 * grounds that the Inyo National Forest page for it lists no food, no store and
 * no picnic facilities — and then removed, because an argument from silence on a
 * viewpoint's own web page is not the same kind of claim as the Park Service
 * writing down that there is nothing in the valley. Minaret Vista is fifteen
 * minutes from a town full of restaurants; treating it as remote sent a
 * traveller shopping at dawn for a lunch they then ate in a diner.
 */
const GAPS: FoodDataset['gaps'] = [
  {
    area: 'the Reds Meadow valley',
    placeIds: ['devils-postpile', 'rainbow-falls'],
    note: 'The National Park Service states there are no restaurants or concession-operated facilities within the monument, and advises packing a lunch or snacks before entering the valley.',
    provenance: official(
      'National Park Service — Devils Postpile',
      'https://www.nps.gov/depo/planyourvisit/eatingsleeping.htm',
    ),
  },
];

/**
 * Parsed at module load, exactly like the hours and access datasets. A record
 * that will not validate should take the build down rather than the first
 * traveller who asks for dinner.
 */
export const EASTERN_SIERRA_FOOD: FoodDataset = foodDatasetSchema.parse({
  version: 1,
  regionId: 'eastern-sierra',
  venues: VENUES,
  gaps: GAPS,
});

export const easternSierraFoodProvider: FoodProvider = {
  name: 'eastern-sierra-curated-food',
  async getFoodVenues() {
    return EASTERN_SIERRA_FOOD;
  },
};

/**
 * DELIBERATELY EXCLUDED, and why. Each of these was researched and left out.
 *
 * - **Lakefront Restaurant (Tamarack Lodge).** A strong special-meal candidate
 *   whose only readable schedule is an explicit summer-2026 snapshot from a
 *   resort that runs different winter hours and shuts in the shoulder seasons.
 *   Encoding the summer window would mark it *closed* from October to May, which
 *   is false; encoding it year-round would state hours nobody published. Convict
 *   Lake covers the same need and is genuinely year-round.
 * - **The Mule House Cafe, Reds Meadow.** The one food service in the valley,
 *   and its Thursday-to-Sunday split is not a business decision — it follows the
 *   multi-year road reconstruction and the convoy schedule. That is exactly the
 *   class of temporary fact this dataset keeps out. The NPS gap record above is
 *   the honest answer for that valley.
 * - **Eleven53 Cafe** at the top of the gondola: gondola-dependent and
 *   season-dependent, and the hours found were a live snapshot.
 * - **Stellar Brew, Good Life Cafe, Gomez's.** Hours came only from directories
 *   that contradict each other or the venue itself. Two officially-sourced 06:00
 *   cafes already cover the early start.
 * - **Tom's Place, Rock Creek Lakes Resort.** Both refuse every request; the
 *   widely-repeated hours are aggregator-only.
 * - **Petra's Bistro, Slocums, Base Camp Cafe, Ohanas 395, Carson Peak Inn,
 *   Bishop Burger Barn.** Closed, permanently or indefinitely. Two of them still
 *   have live pages on somebody else's site, which is the whole argument for
 *   reading a business's own channel rather than a directory.
 */
