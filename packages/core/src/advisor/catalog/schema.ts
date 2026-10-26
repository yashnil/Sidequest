import { z } from 'zod';

/**
 * THE DESTINATION CATALOG — WHAT "WHERE SHOULD I GO" IS ALLOWED TO ANSWER WITH.
 *
 * The recommender this replaces ranked the destination *index*: Overture
 * divisions, which are administrative by construction (country, region, county,
 * locality). Asked for "outdoors in summer: hiking, wildlife, mountains, lakes,
 * coast", it returned Republika Srpska, the Municipality of Staro Nagoričane
 * and Varna — all scored 100 on 17% of the evidence, because the only thing the
 * index could say about any of them was how many settlements they held. An
 * administrative polygon is not a holiday, and a count of towns is not evidence
 * of mountains.
 *
 * A catalog entry is a **travel destination**: somewhere a person could spend
 * several days, with named bases to sleep in, a season, and things to do that
 * are stated rather than inferred from settlement density. Every attribute is an
 * editorial reading with a stated basis (`evidence`), never a provider fact, and
 * the parts that can be checked against the world — the climate — are checked at
 * shortlist time and say so.
 *
 * Scales are deliberately coarse (0–3). A finer scale would imply a precision
 * no editorial reading has, and the ranker's job is to separate a glacier trek
 * from a beach week, not 7.2 from 7.4.
 */

export const WORLD_REGIONS = [
  'northern_europe',
  'western_europe',
  'southern_europe',
  'central_eastern_europe',
  'caucasus_central_asia',
  'middle_east',
  'north_africa',
  'east_africa',
  'southern_africa',
  'west_central_africa',
  'indian_ocean',
  'south_asia',
  'southeast_asia',
  'east_asia',
  'oceania',
  'pacific_islands',
  'north_america_west',
  'north_america_east',
  'north_america_north',
  'mexico_central_america',
  'caribbean',
  'south_america_north',
  'south_america_south',
  'polar',
] as const;
export type WorldRegion = (typeof WORLD_REGIONS)[number];

export const WORLD_REGION_LABELS: Record<WorldRegion, string> = {
  northern_europe: 'Northern Europe',
  western_europe: 'Western Europe',
  southern_europe: 'Southern Europe',
  central_eastern_europe: 'Central & Eastern Europe',
  caucasus_central_asia: 'Caucasus & Central Asia',
  middle_east: 'Middle East',
  north_africa: 'North Africa',
  east_africa: 'East Africa',
  southern_africa: 'Southern Africa',
  west_central_africa: 'West & Central Africa',
  indian_ocean: 'Indian Ocean',
  south_asia: 'South Asia',
  southeast_asia: 'Southeast Asia',
  east_asia: 'East Asia',
  oceania: 'Australia & New Zealand',
  pacific_islands: 'Pacific Islands',
  north_america_west: 'Western North America',
  north_america_east: 'Eastern North America',
  north_america_north: 'Alaska & Northern Canada',
  mexico_central_america: 'Mexico & Central America',
  caribbean: 'Caribbean',
  south_america_north: 'Northern South America',
  south_america_south: 'Southern South America',
  polar: 'Polar regions',
};

/** The continent-scale bucket a world region belongs to, for "closer to home". */
export const CONTINENT_OF: Record<WorldRegion, 'europe' | 'asia' | 'africa' | 'americas' | 'oceania' | 'polar'> = {
  northern_europe: 'europe',
  western_europe: 'europe',
  southern_europe: 'europe',
  central_eastern_europe: 'europe',
  caucasus_central_asia: 'asia',
  middle_east: 'asia',
  north_africa: 'africa',
  east_africa: 'africa',
  southern_africa: 'africa',
  west_central_africa: 'africa',
  indian_ocean: 'africa',
  south_asia: 'asia',
  southeast_asia: 'asia',
  east_asia: 'asia',
  oceania: 'oceania',
  pacific_islands: 'oceania',
  north_america_west: 'americas',
  north_america_east: 'americas',
  north_america_north: 'americas',
  mexico_central_america: 'americas',
  caribbean: 'americas',
  south_america_north: 'americas',
  south_america_south: 'americas',
  polar: 'polar',
};

/**
 * What a destination is, as a traveller would plan it.
 *
 * Not an administrative type. "A national park" and "a travel region" are both
 * places you could spend a week; "a municipality" is not on this list because
 * it is not a kind of holiday.
 */
export const DESTINATION_KINDS = [
  'national_park',
  'travel_region',
  'mountain_range',
  'island',
  'island_group',
  'coast',
  'lake_district',
  'country_circuit',
  'city_and_surroundings',
  'desert',
  'wilderness',
] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/**
 * The experiences a destination offers, each 0–3:
 * 0 = absent or not worth travelling for, 1 = available, 2 = strong, 3 = among
 * the best reasons anyone goes there.
 */
export const EXPERIENCES = [
  'day_hiking',
  'multi_day_trekking',
  'high_mountains',
  'glaciers_ice',
  'volcanoes_geothermal',
  'lakes',
  'beaches_swimming',
  'coastal_scenery',
  'snorkel_dive',
  'paddling_boating',
  'big_game_safari',
  'wildlife_general',
  'marine_wildlife',
  'birding',
  'rainforest_biodiversity',
  'desert_landscapes',
  'scenic_driving',
  'rail_journeys',
  'winter_snow',
  'hot_springs_wellness',
  'villages_culture',
  'food',
  'city_life',
  'night_skies',
] as const;
export type Experience = (typeof EXPERIENCES)[number];

export const EXPERIENCE_LABELS: Record<Experience, string> = {
  day_hiking: 'Day hiking',
  multi_day_trekking: 'Multi-day trekking',
  high_mountains: 'High mountains',
  glaciers_ice: 'Glaciers and ice',
  volcanoes_geothermal: 'Volcanoes and hot ground',
  lakes: 'Lakes',
  beaches_swimming: 'Beaches and swimming',
  coastal_scenery: 'Coastal scenery',
  snorkel_dive: 'Snorkelling and diving',
  paddling_boating: 'Kayaks and boats',
  big_game_safari: 'Safari',
  wildlife_general: 'Wildlife',
  marine_wildlife: 'Whales, seals and sea life',
  birding: 'Birds',
  rainforest_biodiversity: 'Rainforest',
  desert_landscapes: 'Desert',
  scenic_driving: 'Scenic drives',
  rail_journeys: 'Rail journeys',
  winter_snow: 'Snow and winter',
  hot_springs_wellness: 'Hot springs',
  villages_culture: 'Villages and culture',
  food: 'Food',
  city_life: 'City life',
  night_skies: 'Night skies',
};

const level = z.number().int().min(0).max(3);
const twelve = <T extends z.ZodTypeAny>(item: T) => z.array(item).length(12);

export const catalogDestinationSchema = z.object({
  /** Stable slug. Never reused for a different place. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(2).max(60),
  /** What the card says under the name: "Northern Norway", "Kyrgyzstan". */
  context: z.string().min(2).max(60),
  kind: z.enum(DESTINATION_KINDS),
  /** ISO 3166-1 alpha-2, every country the destination is planned across. */
  countries: z.array(z.string().length(2).regex(/^[A-Z]{2}$/)).min(1).max(4),
  worldRegion: z.enum(WORLD_REGIONS),
  center: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  /** Roughly how far the planned ground spreads from the centre. */
  radiusKm: z.number().min(5).max(1500),
  /**
   * The phrase the planning pipeline resolves when somebody picks this. It goes
   * through the same semantic gate as anything typed (V8.1), so it names the
   * place the way a traveller would type it, country included.
   */
  resolveAs: z.string().min(3).max(80),
  /** The Wikidata item for the destination itself — for its photograph, never a map. */
  wikidataId: z.string().regex(/^Q\d+$/).optional(),
  /** Two to four real towns or lodges a traveller would actually sleep in. */
  bases: z.array(z.string().min(2).max(40)).min(1).max(5),
  nights: z.object({ min: z.number().int().min(1).max(30), ideal: z.number().int().min(1).max(30), max: z.number().int().min(1).max(45) }),
  experiences: z.partialRecord(z.enum(EXPERIENCES), level).refine((value) => Object.keys(value).length >= 3, 'at least three experiences'),
  /** Three to five specific, distinctive things — named, not generic. */
  highlights: z.array(z.string().min(8).max(90)).min(3).max(5),
  /** One sentence: what this place is, for somebody who has never heard of it. */
  pitch: z.string().min(30).max(220),
  /** Outdoor-travel suitability per month, Jan..Dec, 0 = avoid/closed, 3 = best. */
  season: twelve(level),
  /** Typical daytime high in °C per month at the bases, Jan..Dec. */
  highC: twelve(z.number().int().min(-40).max(50)),
  /** Typical rainy days per month, coarse: 0 dry, 1 some, 2 wet, 3 very wet. */
  wet: twelve(level),
  /** Daily on-the-ground cost, 1 = budget-friendly … 4 = expensive everywhere. */
  cost: z.number().int().min(1).max(4),
  lodging: z.object({ simple: z.boolean(), comfortable: z.boolean(), luxury: z.boolean() }),
  /** The easiest worthwhile version of the trip and the typical one, 0 = gentle … 3 = expedition. */
  challenge: z.object({ easiest: level, typical: level }),
  /** 0 = easy, well-served … 3 = remote, few services. */
  remoteness: level,
  /** How busy the peak season is, 0 = quiet … 3 = crowded. */
  crowds: level,
  /**
   * How familiar the destination is to an international traveller, 0 = little
   * known … 3 = world-famous. **Never a ranking boost.** It is read only against
   * the traveller's own appetite for the familiar or the unusual.
   */
  familiarity: level,
  access: z.object({
    /** IATA codes of the airports a traveller would fly into. */
    airports: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(4),
    /** From a major international hub: 0 = direct and easy … 3 = several connections or a long overland leg. */
    reach: level,
    car: z.enum(['unnecessary', 'helpful', 'essential']),
    transit: z.enum(['good', 'limited', 'poor']),
    /** Honest one-liner about getting around. */
    note: z.string().min(10).max(160),
  }),
  /** Suitable with children, 0 = not really … 3 = very. */
  family: level,
  /** Manageable with limited mobility, 0 = hardly … 3 = well. */
  lowMobility: level,
  /** Two or three real downsides, plainly. */
  tradeoffs: z.array(z.string().min(10).max(140)).min(1).max(3),
  /** Seasonal or safety notes worth knowing. Practical, never alarmist, never a legal claim. */
  cautions: z.array(z.string().min(10).max(160)).max(3).default([]),
  evidence: z.object({
    basis: z.literal('sidequest_editorial'),
    asOf: z.string().regex(/^\d{4}-\d{2}$/),
    /** Where a reader can check the reading: a Wikivoyage article, a park authority. */
    references: z.array(z.string().min(3).max(120)).min(1).max(4),
  }),
});

export type CatalogDestination = z.infer<typeof catalogDestinationSchema>;
