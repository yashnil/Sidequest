import type { Interest, PlaceCategory } from '../schemas/common';

/**
 * WHAT KIND OF PLACE THIS IS, AS THE INTAKE NEEDS TO KNOW IT.
 *
 * Four classes, chosen because they are the four that change what it is
 * reasonable to *ask* somebody. A dense city and a mountain valley do not
 * disagree about pace or budget; they disagree entirely about whether "how
 * often do you want a scenic drive" is a question or a non-sequitur.
 *
 * Deliberately coarse. A finer taxonomy — alpine versus subalpine, capital
 * versus market town — would multiply the packs below without changing a single
 * row a traveller sees, and every extra class is another place for a
 * destination to be mis-filed.
 *
 * A region may be several of these at once, and usually is: a coastal city is
 * both, and gets both packs.
 */
export const DESTINATION_CLASSES = ['urban', 'coastal', 'mountain', 'countryside'] as const;
export type DestinationClass = (typeof DESTINATION_CLASSES)[number];

/**
 * The interests every destination can be asked about.
 *
 * The bar for membership: a traveller could give a meaningful answer without
 * knowing anything about where they are going, *and* essentially anywhere
 * people travel can serve it. Somewhere to eat, something built by people,
 * something worth looking at, somewhere to walk, and the hour of the day the
 * light is good.
 *
 * Everything else is destination-conditional and lives in a pack.
 */
export const UNIVERSAL_INTERESTS: readonly Interest[] = [
  'food_and_towns',
  'history_and_culture',
  'scenic_viewpoints',
  'easy_nature_walks',
  'photography_golden_hour',
];

/**
 * What each class *may* offer, before any evidence is consulted.
 *
 * A pack is a candidate list, never an offer. Membership here says "this
 * question makes sense in a place of this kind"; whether the question gets
 * asked is decided in `offer.ts` from the region's own places. The two halves
 * are separate because a mountain region with no thermal ground in it must not
 * be asked about geothermal ground merely for being a mountain region.
 */
export const CLASS_INTEREST_PACKS: Record<DestinationClass, readonly Interest[]> = {
  urban: [
    'museums_and_galleries',
    'architecture_and_landmarks',
    'neighbourhoods_and_local_life',
    'markets_and_street_food',
    'history_and_culture',
    'food_and_towns',
    'easy_nature_walks',
    'scenic_viewpoints',
    'photography_golden_hour',
  ],
  coastal: [
    'beaches_and_swimming',
    'scenic_viewpoints',
    'wildlife',
    'lakes_and_rivers',
    'scenic_drives',
    'easy_nature_walks',
    'food_and_towns',
    'history_and_culture',
    'photography_golden_hour',
  ],
  mountain: [
    'hiking',
    'scenic_viewpoints',
    'lakes_and_rivers',
    'scenic_drives',
    'easy_nature_walks',
    'wildlife',
    'geology_and_geothermal',
    'hot_springs',
    'stargazing',
    'photography_golden_hour',
    'food_and_towns',
    'history_and_culture',
  ],
  countryside: [
    'scenic_drives',
    'easy_nature_walks',
    'lakes_and_rivers',
    'wildlife',
    'markets_and_street_food',
    'history_and_culture',
    'architecture_and_landmarks',
    'food_and_towns',
    'stargazing',
    'scenic_viewpoints',
    'photography_golden_hour',
  ],
};

/**
 * HOW A REGION PROVES IT CAN SERVE AN INTEREST.
 *
 * Three channels, in descending order of how much they know:
 *
 * 1. `interestTags` — the place already claims this interest. This is the
 *    classifier's own verdict and is always trusted.
 * 2. `categories` / `displayKinds` — the planning category, and the truthful
 *    noun a card prints when the category's label would be a lie.
 * 3. `sourceKeywords` — whole tokens of the source's own leaf category, which
 *    every compiled place carries as its first tag (`places=shinto_shrine`).
 *    This is the only channel with the resolution to tell a shrine from a
 *    castle, because the thirteen-value planning vocabulary cannot.
 *
 * Keywords, not exact categories, and deliberately: the backing catalogue holds
 * several hundred leaf categories and grows, so a fixed list would silently
 * stop recognising things. A keyword is a weaker claim and the right one —
 * `shrine` matches `shinto_shrine`, `temple` matches `buddhist_temple`, and
 * nothing in this file has to know which country it is looking at.
 *
 * TOKENS, NEVER RAW SUBSTRINGS, AND THE COMPOUNDS A TOKEN STILL GETS WRONG.
 *
 * The keywords were matched with `String.includes`, and a leaf category is a
 * snake_case compound, so a keyword was read out of the middle of an unrelated
 * word: measured over the 220 leaves the classifier recognises, `market`
 * matched `supermarket`, `quarter` matched `corporate_headquarters`, and `park`
 * matched `bicycle_parking` — a grocery run, an office and a bike rack claimed
 * as a market, a neighbourhood and a green space. `namesKind` matches whole
 * tokens instead, and a multi-token keyword matches a contiguous run, so
 * `hot_spring` still names one kind rather than two words that co-occur.
 *
 * A token boundary is not enough on its own, because the catalogue publishes
 * compounds whose head noun is the keyword and whose kind is not: an
 * `amusement_park` is a ticketed enclosure, not somewhere to take an easy walk,
 * and on the live boards of 2026-08-26 two of them — one under each of two
 * destinations — carried `easy_nature_walks` and were sold to the traveller as
 * that interest delivered. `sourceExclusions` names those compounds. Leaves,
 * never places: the same list is right in every country, which is the same bar
 * every other row in this table is held to.
 */
export interface InterestEvidenceRule {
  categories?: readonly PlaceCategory[];
  /** Compared case-insensitively against `Place.displayKind`. */
  displayKinds?: readonly string[];
  /** Compared case-insensitively as whole tokens of the source category tag. */
  sourceKeywords?: readonly string[];
  /**
   * Leaf categories this interest's keywords match and must not claim.
   *
   * A compound whose head noun is one of the keywords while its kind is
   * something else. Checked before the keywords, so an excluded leaf reaches no
   * keyword at all.
   */
  sourceExclusions?: readonly string[];
}

export const INTEREST_EVIDENCE: Record<Interest, InterestEvidenceRule> = {
  hiking: {
    categories: ['day_hike'],
    displayKinds: ['peak', 'volcano', 'glacier'],
    sourceKeywords: ['trail', 'hiking', 'trailhead', 'summit', 'peak', 'mountain'],
  },
  easy_nature_walks: {
    categories: ['easy_walk'],
    displayKinds: ['forest', 'hill'],
    sourceKeywords: ['park', 'garden', 'promenade', 'boardwalk', 'nature'],
    /*
     * The `*_park` compounds that are not green space. All three are the
     * catalogue's ticketed-enclosure family — the taxonomy already marks them
     * `paidEnclosure` — and a memorial park is a monument, which is the kind
     * its own `national_monument` category and its `history_and_culture` stamp
     * both already say.
     */
    sourceExclusions: ['amusement_park', 'theme_park', 'water_park', 'memorial_park'],
  },
  scenic_viewpoints: {
    categories: ['viewpoint', 'gondola_or_tram'],
    sourceKeywords: ['viewpoint', 'observation', 'lookout', 'overlook', 'scenic'],
  },
  lakes_and_rivers: {
    categories: ['lake'],
    displayKinds: ['river', 'pond', 'reservoir', 'waterfall', 'stream', 'canal', 'lagoon', 'fjord'],
    sourceKeywords: ['lake', 'river', 'waterfall', 'reservoir', 'canal'],
  },
  scenic_drives: {
    categories: ['scenic_drive'],
    sourceKeywords: ['scenic_drive', 'byway', 'mountain_pass', 'scenic_route'],
  },
  wildlife: {
    categories: ['wildlife_area'],
    sourceKeywords: ['wildlife', 'zoo', 'aquarium', 'nature_reserve', 'safari', 'birdwatch'],
  },
  geology_and_geothermal: {
    categories: ['geothermal'],
    displayKinds: ['volcano', 'glacier'],
    sourceKeywords: ['geyser', 'volcano', 'cave', 'crater', 'geolog', 'fumarole'],
  },
  hot_springs: {
    categories: ['hot_spring'],
    /* Both numbers: the catalogue publishes `hot_spring` and `hot_springs`. */
    sourceKeywords: ['hot_spring', 'hot_springs', 'onsen', 'thermal_bath', 'hot_bath'],
  },
  history_and_culture: {
    categories: ['historic_site', 'museum', 'national_monument'],
    /*
     * `historical` and `archaeological` are spelled out beside their stems.
     * Under the old substring match the stems reached them from inside the
     * longer word; a token match does not, and the leaves
     * `historical_landmark`, `landmark_and_historical_building` and
     * `archaeological_site` are ones the classifier recognises.
     */
    sourceKeywords: [
      'museum',
      'historic',
      'historical',
      'heritage',
      'castle',
      'temple',
      'shrine',
      'church',
      'cathedral',
      'monument',
      'palace',
      'ruins',
      'archaeological',
    ],
  },
  food_and_towns: {
    categories: ['town_and_food'],
    sourceKeywords: [
      'restaurant',
      'market',
      'marketplace',
      'cafe',
      'bakery',
      'brewery',
      'winery',
      'food',
    ],
  },
  /*
   * Piggybacks on what you would photograph rather than on a "photography"
   * category, which no catalogue publishes. A region with somewhere to stand
   * and something to look at can serve golden hour; one with neither cannot.
   */
  photography_golden_hour: {
    categories: ['viewpoint', 'gondola_or_tram'],
    displayKinds: ['beach', 'bay', 'peak', 'waterfall', 'bridge', 'lagoon', 'fjord'],
    sourceKeywords: ['viewpoint', 'observation', 'lookout', 'overlook'],
  },
  /*
   * The one interest with almost no catalogue signal, and left that way on
   * purpose. Dark sky is a property of a region rather than of a record, and
   * inferring it from "this is rural" would put a stargazing row in front of
   * travellers we have nothing to schedule for it. An authored region that tags
   * its places with the interest still offers it, via the tag channel.
   *
   * `observatory` was one of these keywords and is not one of these things.
   * The word is what a global place catalogue publishes for an **observation
   * deck** — the compiler's taxonomy says so where it classifies the leaf, and
   * classifies it as a viewpoint on exactly that reading. So every ticketed
   * daytime deck in the catalogue was stamped with a night-sky interest and
   * then sold as one: on the live board of 2026-08-26 a destination's
   * principal observation tower carried `stargazing` and told a traveller who
   * had graded it that this was that interest delivered. A deck with a lift and
   * a gift shop is not an answer to "where can I see the stars", and where the
   * catalogue gives us no way to tell an astronomical observatory from a
   * viewing platform the honest output is no claim at all.
   */
  stargazing: {
    sourceKeywords: ['dark_sky', 'planetarium'],
  },
  museums_and_galleries: {
    categories: ['museum'],
    sourceKeywords: ['museum', 'gallery', 'exhibition'],
  },
  architecture_and_landmarks: {
    categories: ['historic_site', 'national_monument'],
    displayKinds: ['bridge', 'plaza', 'pier', 'viaduct'],
    sourceKeywords: [
      'temple',
      'shrine',
      'church',
      'cathedral',
      'mosque',
      'synagogue',
      'castle',
      'palace',
      'monument',
      'pagoda',
      'landmark',
      'tower',
      'basilica',
      'fort',
      'citadel',
      'bridge',
      'architect',
    ],
  },
  neighbourhoods_and_local_life: {
    displayKinds: ['neighbourhood', 'neighborhood', 'plaza'],
    sourceKeywords: [
      'neighborhood',
      'neighbourhood',
      'district',
      'plaza',
      'square',
      'promenade',
      'pedestrian',
      'quarter',
    ],
  },
  markets_and_street_food: {
    sourceKeywords: [
      'market',
      'marketplace',
      'bazaar',
      'arcade',
      'food_hall',
      'food_court',
      'street_food',
    ],
  },
  beaches_and_swimming: {
    displayKinds: ['beach', 'bay', 'lagoon'],
    sourceKeywords: ['beach', 'seaside', 'swimming', 'lido', 'bathing'],
  },
};

/**
 * The interests whose presence says something about *what kind of place this
 * is*, as opposed to what there is to do in it.
 *
 * Used only to classify. A city has museums, neighbourhoods and markets; a
 * mountain region has trails, thermal ground and passes. Somewhere to eat and
 * somewhere to look at the sunset are true everywhere and say nothing, which is
 * exactly why they are the universal core and not signature interests.
 */
export const CLASS_SIGNATURES: Record<DestinationClass, readonly Interest[]> = {
  /*
   * `architecture_and_landmarks` is deliberately absent. Castles, monuments and
   * places of worship are everywhere people have lived, so a valley with three
   * historic sites in it read as a city — and then offered its traveller
   * museums and market halls it had none of. What is actually urban is the
   * density of *institutions and streets*: a museum quarter, a named
   * neighbourhood, a covered market.
   */
  urban: ['museums_and_galleries', 'neighbourhoods_and_local_life', 'markets_and_street_food'],
  coastal: ['beaches_and_swimming'],
  mountain: ['hiking', 'geology_and_geothermal', 'hot_springs', 'scenic_drives'],
  countryside: ['scenic_drives', 'wildlife', 'lakes_and_rivers', 'stargazing'],
};
