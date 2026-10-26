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
};

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
  mountainStyle: z.enum(['base_day_hikes', 'hut_to_hut', 'high_altitude']).optional(),
  swimStyle: z.enum(['warm_sea', 'lakes', 'either']).optional(),
  /** What the traveller typed, verbatim, so a reading can always be checked against it. */
  request: z.string().max(600).optional(),
  /** What Sidequest took as given without being told, in words, so it can be corrected. */
  assumptions: z.array(z.string().min(1).max(160)).max(12).default([]),
  refinements: z.array(z.enum(REFINEMENTS)).max(20).default([]),
  /** Catalog ids the traveller set aside ("show me something different"). */
  excluded: z.array(z.string().min(1).max(60)).max(60).default([]),
  /** "More like this one": a catalog id whose profile becomes a soft target. */
  similarTo: z.string().min(1).max(60).optional(),
  /** Advisor questions already put to the traveller, answered or skipped. */
  asked: z.array(z.string().min(1).max(40)).max(40).default([]),
});
export type AdvisorAnswers = z.infer<typeof advisorAnswersSchema>;

export function emptyAdvisorAnswers(): AdvisorAnswers {
  return { focus: [], assumptions: [], refinements: [], excluded: [], asked: [] };
}
