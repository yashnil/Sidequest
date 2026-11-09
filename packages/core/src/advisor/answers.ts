import { z } from 'zod';
import { WORLD_REGIONS, type Experience } from './catalog/schema';

/**
 * WHAT THE DESTINATION ADVISOR LEARNS THAT THE COMPOSER DID NOT ALREADY HOLD.
 *
 * Deliberately small. When, how long, budget, party, transport, crowds,
 * climate, novelty, origin and how far to fly already live on
 * `TripComposerAnswers`, and a chosen destination carries them into the trip
 * unchanged — a second traveller profile would be a second product (§16 of the
 * brief). This record holds only what "where in the world" needs and the
 * composer never asked: which *kind* of outdoors, how adventurous on a scale
 * that reaches expedition, which parts of the world are in or out, and the
 * conversation's own memory (refinements, what was shown and set aside).
 */

/**
 * The traveller-facing interest vocabulary. Coarser than `EXPERIENCES` on
 * purpose: nobody answers "glaciers_ice: 2", people answer "mountains and
 * trekking". `FOCUS_EXPERIENCES` is the one mapping between the two.
 */
export const FOCUS_KEYS = [
  'mountains',
  'hiking',
  'wildlife',
  'lakes',
  'beaches',
  'rainforest',
  'road_trips',
  'desert',
  'volcanoes',
  'snow',
  'culture_food',
  'cities',
  'rail',
] as const;
export type FocusKey = (typeof FOCUS_KEYS)[number];

export const FOCUS_LABELS: Record<FocusKey, string> = {
  mountains: 'Mountains and trekking',
  hiking: 'Hiking',
  wildlife: 'Wildlife',
  lakes: 'Lakes',
  beaches: 'Beaches and coast',
  rainforest: 'Rainforest',
  road_trips: 'Scenic road trips',
  desert: 'Desert',
  volcanoes: 'Volcanoes and hot springs',
  snow: 'Snow and winter',
  culture_food: 'Culture and food',
  cities: 'Cities',
  rail: 'Rail journeys',
};

/**
 * Each focus as weighted experiences. Weights sum to one per focus, so a
 * traveller with four interests is not scored as wanting four times as much.
 */
export const FOCUS_EXPERIENCES: Record<FocusKey, Partial<Record<Experience, number>>> = {
  mountains: { high_mountains: 0.45, multi_day_trekking: 0.2, day_hiking: 0.25, glaciers_ice: 0.1 },
  hiking: { day_hiking: 0.65, multi_day_trekking: 0.35 },
  wildlife: { wildlife_general: 0.4, big_game_safari: 0.25, marine_wildlife: 0.2, birding: 0.15 },
  lakes: { lakes: 0.75, paddling_boating: 0.25 },
  beaches: { beaches_swimming: 0.55, coastal_scenery: 0.25, snorkel_dive: 0.2 },
  rainforest: { rainforest_biodiversity: 0.7, wildlife_general: 0.15, birding: 0.15 },
  road_trips: { scenic_driving: 1 },
  desert: { desert_landscapes: 0.8, night_skies: 0.2 },
  volcanoes: { volcanoes_geothermal: 0.75, hot_springs_wellness: 0.25 },
  snow: { winter_snow: 1 },
  culture_food: { villages_culture: 0.55, food: 0.45 },
  cities: { city_life: 0.7, food: 0.3 },
  rail: { rail_journeys: 0.7, villages_culture: 0.3 },
};

/**
 * PURSUITS: one thing a traveller named that no broad focus says precisely.
 *
 * "Hot springs" is not "volcanoes", "stargazing" is not "desert" and a food
 * trip is not half a culture trip. Each is read from the request's own words
 * and scored on the experience it actually is.
 */
export const PURSUIT_KEYS = ['stargazing', 'hot_springs', 'wellness', 'paddling', 'food', 'culture'] as const;
export type PursuitKey = (typeof PURSUIT_KEYS)[number];
export const PURSUIT_LABELS: Record<PursuitKey, string> = {
  stargazing: 'Dark skies and stargazing',
  hot_springs: 'Hot springs',
  wellness: 'Spa and wellness',
  paddling: 'On the water',
  food: 'Food and drink',
  culture: 'History and culture',
};
export const PURSUIT_EXPERIENCES: Record<PursuitKey, Partial<Record<Experience, number>>> = {
  stargazing: { night_skies: 0.85, desert_landscapes: 0.15 },
  hot_springs: { hot_springs_wellness: 0.8, volcanoes_geothermal: 0.2 },
  wellness: { hot_springs_wellness: 0.6, beaches_swimming: 0.2, lakes: 0.2 },
  paddling: { paddling_boating: 0.75, lakes: 0.15, coastal_scenery: 0.1 },
  food: { food: 0.8, villages_culture: 0.1, city_life: 0.1 },
  culture: { villages_culture: 0.85, city_life: 0.15 },
};

/**
 * MOODS: what a request says when it names no activity at all.
 *
 * "Somewhere beautiful and relaxing", "an unforgettable trip with friends",
 * "adventurous but not too difficult". These are not interests and are never
 * scored as if they were: each is a *leaning* across several experiences, any
 * one of which satisfies it (a superb coast is beautiful without also being a
 * mountain), used only while nothing more specific has been said, and stated
 * back as an assumption so one answer to "what do you most want to do?" replaces
 * it.
 */
export const MOOD_KEYS = ['scenic', 'relaxing', 'adventurous', 'social', 'memorable', 'romantic', 'family'] as const;
export type MoodKey = (typeof MOOD_KEYS)[number];
export const MOOD_LABELS: Record<MoodKey, string> = {
  scenic: 'Beautiful scenery',
  relaxing: 'Somewhere to relax',
  adventurous: 'Adventure',
  social: 'Fun with friends',
  memorable: 'Something unforgettable',
  romantic: 'Romantic',
  family: 'Easy family time',
};
export const MOOD_EXPERIENCES: Record<MoodKey, Partial<Record<Experience, number>>> = {
  scenic: { coastal_scenery: 0.25, high_mountains: 0.25, lakes: 0.2, day_hiking: 0.1, scenic_driving: 0.1, villages_culture: 0.1 },
  relaxing: { beaches_swimming: 0.35, lakes: 0.2, hot_springs_wellness: 0.15, coastal_scenery: 0.15, villages_culture: 0.1, food: 0.05 },
  adventurous: { day_hiking: 0.3, high_mountains: 0.2, paddling_boating: 0.15, volcanoes_geothermal: 0.1, wildlife_general: 0.1, rainforest_biodiversity: 0.1, desert_landscapes: 0.05 },
  social: { city_life: 0.3, beaches_swimming: 0.25, food: 0.2, day_hiking: 0.1, paddling_boating: 0.1, coastal_scenery: 0.05 },
  memorable: { high_mountains: 0.15, wildlife_general: 0.15, coastal_scenery: 0.15, villages_culture: 0.15, volcanoes_geothermal: 0.1, glaciers_ice: 0.1, desert_landscapes: 0.1, big_game_safari: 0.1 },
  romantic: { coastal_scenery: 0.25, beaches_swimming: 0.25, villages_culture: 0.2, food: 0.2, lakes: 0.1 },
  family: { beaches_swimming: 0.3, wildlife_general: 0.2, lakes: 0.15, day_hiking: 0.15, city_life: 0.1, villages_culture: 0.1 },
};

/** Anything an interest can be keyed by: a focus, a pursuit, or — while nothing else was said — a mood. */
export type InterestKey = FocusKey | PursuitKey | MoodKey;
export const ADVISOR_INTEREST_LABELS: Record<InterestKey, string> = { ...FOCUS_LABELS, ...PURSUIT_LABELS, ...MOOD_LABELS };

export const ADVENTURE_LEVELS = ['comfortable', 'active', 'rugged', 'expedition'] as const;
export type AdventureLevel = (typeof ADVENTURE_LEVELS)[number];
export const ADVENTURE_LABELS: Record<AdventureLevel, string> = {
  comfortable: 'Comfortable and easy to reach',
  active: 'Active, with a few big days',
  rugged: 'Rugged and remote',
  expedition: 'Expedition-style',
};

/** How the traveller wants to refine a shortlist, as one tap each. */
export const REFINEMENTS = [
  'more_adventurous',
  'easier',
  'cheaper',
  'warmer',
  'cooler',
  'less_crowded',
  'closer',
  'more_hiking',
  'more_wildlife',
  'more_beach',
  'more_unusual',
  'more_classic',
  'easier_logistics',
  'less_driving',
] as const;
export type Refinement = (typeof REFINEMENTS)[number];

export const REFINEMENT_LABELS: Record<Refinement, string> = {
  more_adventurous: 'More adventurous',
  easier: 'Gentler',
  cheaper: 'Less expensive',
  warmer: 'Warmer',
  cooler: 'Cooler',
  less_crowded: 'Less crowded',
  closer: 'Closer to home',
  more_hiking: 'More hiking',
  more_wildlife: 'More wildlife',
  more_beach: 'More beach time',
  more_unusual: 'More unusual',
  more_classic: 'More classic',
  easier_logistics: 'Easier logistics',
  less_driving: 'Less driving',
};

/** Pairs that undo one another: applying one removes the other rather than stacking both. */
export const OPPOSITE_REFINEMENT: Partial<Record<Refinement, Refinement>> = {
  more_adventurous: 'easier',
  easier: 'more_adventurous',
  warmer: 'cooler',
  cooler: 'warmer',
  more_unusual: 'more_classic',
  more_classic: 'more_unusual',
};

export const advisorAnswersSchema = z.object({
  /** Interests in the order the traveller ranked them; the first leads. */
  focus: z.array(z.enum(FOCUS_KEYS)).max(FOCUS_KEYS.length).default([]),
  /** True once the traveller has said which interest leads, so the order means something. */
  focusRanked: z.boolean().optional(),
  adventure: z.enum(ADVENTURE_LEVELS).optional(),
  /** Parts of the world in scope. Absent means anywhere. */
  regions: z.array(z.enum(WORLD_REGIONS)).max(WORLD_REGIONS.length).optional(),
  /**
   * Countries in scope (ISO 3166-1 alpha-2), for a named area that is a set of
   * countries rather than a world region — "the Balkans" is not all of southern
   * Europe, and reading it that way recommended the Azores.
   */
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(40).optional(),
  wildlifeKind: z.enum(['safari', 'marine', 'birds', 'any']).optional(),
  /** The traveller refused snow and ice ("hiking but no snow"): snowbound months are out, not merely unwanted. */
  avoidSnow: z.boolean().optional(),
  /** Interests the traveller explicitly refused ("no cities"): a place built around one is marked down, never ruled out. */
  refused: z.array(z.enum(FOCUS_KEYS)).max(FOCUS_KEYS.length).optional(),
  /** `glaciers` is read from the request ("glaciers and icebergs"): the ice is the point, not the climbing. */
  mountainStyle: z.enum(['base_day_hikes', 'hut_to_hut', 'high_altitude', 'glaciers']).optional(),
  /** The traveller asked for the northern (or southern) lights, which only high latitudes have. */
  aurora: z.boolean().optional(),
  /** `diving` and `snorkel` are read from the request ("world-class diving", "snorkelling off the beach"): the water is the point, not the sand. */
  swimStyle: z.enum(['warm_sea', 'lakes', 'either', 'diving', 'snorkel']).optional(),
  /** Specific things the request named that no focus says precisely ("hot springs", "stargazing"). */
  pursuits: z.array(z.enum(PURSUIT_KEYS)).max(PURSUIT_KEYS.length).optional(),
  /** What a request with no activity in it leans towards ("beautiful and relaxing"). Used only while `focus` and `pursuits` are empty. */
  moods: z.array(z.enum(MOOD_KEYS)).max(MOOD_KEYS.length).optional(),
  /** What the traveller typed, verbatim, so a reading can always be checked against it. */
  request: z.string().max(600).optional(),
  /** What Sidequest took as given without being told, in words, so it can be corrected. */
  assumptions: z.array(z.string().min(1).max(160)).max(12).default([]),
  refinements: z.array(z.enum(REFINEMENTS)).max(20).default([]),
  /** Catalog ids the traveller set aside ("show me something different"). */
  excluded: z.array(z.string().min(1).max(120)).max(60).default([]),
  /** "More like this one": a destination id whose profile becomes a soft target. */
  similarTo: z.string().min(1).max(120).optional(),
  /**
   * Destinations the request named as its geography ("trekking in the
   * Karakoram", "islands in Indonesia"), as atlas ids. Everything recommended
   * lies inside one of them. A named place is a scope, never the answer itself.
   */
  within: z.array(z.string().min(1).max(120)).max(6).optional(),
  /** The same scope in words, for the chips and the read-back. */
  withinLabels: z.array(z.string().min(1).max(80)).max(6).optional(),
  /** Destinations the request ruled out by name ("not Bali", "I have done Nepal"): nothing inside one is offered. */
  outside: z.array(z.string().min(1).max(120)).max(8).optional(),
  /** Where the traveller starts, when the request named a place the built-in list of departure cities does not hold. */
  originPoint: z.object({ lat: z.number(), lng: z.number(), label: z.string().max(80), countryCode: z.string().length(2).nullable() }).optional(),
  /** Words from the request no structured answer captured ("tea plantations", "fjords"), kept for lexical retrieval. */
  terms: z.array(z.string().min(2).max(40)).max(16).optional(),
  /** The same words as the traveller wrote them, in order ("tea plantations misty hills train rides"), for retrieval by meaning. */
  phrase: z.string().max(200).optional(),
  /** Advisor questions already put to the traveller, answered or skipped. */
  asked: z.array(z.string().min(1).max(40)).max(40).default([]),
});
export type AdvisorAnswers = z.infer<typeof advisorAnswersSchema>;

export function emptyAdvisorAnswers(): AdvisorAnswers {
  return { focus: [], assumptions: [], refinements: [], excluded: [], asked: [] };
}
