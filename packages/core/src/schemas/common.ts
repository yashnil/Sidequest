import { z } from 'zod';

/**
 * Shared vocabulary for the domain. Every enum here is a closed set on purpose:
 * scoring, explanation copy and seed data all key off these values, so adding a
 * member is a deliberate change that the type checker surfaces at every call site.
 */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'Expected a YYYY-MM-DD date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a real calendar date');

export const isoTimeSchema = z.string().regex(ISO_TIME, 'Expected a 24-hour HH:MM time');

/**
 * THE TIME MODEL
 *
 * Every clock time in the domain is an integer number of minutes from local
 * midnight, and the calendar date lives separately as a `YYYY-MM-DD` label. No
 * `Date`, no offsets, no DST. A trip plan and a bus timetable are both wall-clock
 * by nature — "the last bus leaves at 19:00" means 19:00 where you are standing —
 * and modelling either as an absolute instant invites exactly the off-by-one-day
 * and timezone bugs that make an itinerary subtly, expensively wrong.
 */
export const MINUTES_PER_DAY = 24 * 60;

export const minuteOfDaySchema = z.number().int().min(0).max(MINUTES_PER_DAY);

export function formatMinuteOfDay(minute: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minute)));
  const hours = Math.floor(clamped / 60) % 24;
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseMinuteOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`"${value}" is not an HH:MM time.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export const coordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type Coordinates = z.infer<typeof coordinatesSchema>;

/**
 * A link that is safe to put in an `href`.
 *
 * `z.string().url()` does not check the scheme. Verified against the Zod this
 * repository pins: `javascript:alert(1)`, `data:text/html,…`, `file:///etc/passwd`
 * and `http://user:pass@169.254.169.254/` all pass it. Every source link in the
 * product is currently a constant written by hand in `data/`, so that has never
 * mattered — but the moment a compiled region can author a `sourceUrl` from a
 * page somebody else wrote, every one of those fields is an `href` an attacker
 * controls, stored in the database and rendered back.
 *
 * So the check belongs at the schema boundary, where the four `validateXDataset`
 * gates already live, rather than at each of the render sites that would
 * otherwise have to remember. Credentials are rejected too: `http://legit@10.0.0.1/`
 * reads as a link to `legit` and resolves to a private address.
 */
export const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
      return parsed.username === '' && parsed.password === '';
    },
    'Only http(s) links without an embedded username or password are allowed',
  );

/** What a traveller can care about. Seed place tags are drawn from this same list. */
export const INTERESTS = [
  'hiking',
  'easy_nature_walks',
  'scenic_viewpoints',
  'lakes_and_rivers',
  'scenic_drives',
  'wildlife',
  'geology_and_geothermal',
  'hot_springs',
  'history_and_culture',
  'food_and_towns',
  'photography_golden_hour',
  'stargazing',
] as const;
export const interestSchema = z.enum(INTERESTS);
export type Interest = z.infer<typeof interestSchema>;

export const INTEREST_LABELS: Record<Interest, string> = {
  hiking: 'Hiking',
  easy_nature_walks: 'Easy nature walks',
  scenic_viewpoints: 'Scenic viewpoints',
  lakes_and_rivers: 'Lakes & rivers',
  scenic_drives: 'Scenic drives',
  wildlife: 'Wildlife',
  geology_and_geothermal: 'Geology & geothermal',
  hot_springs: 'Hot springs',
  history_and_culture: 'History & culture',
  food_and_towns: 'Food & mountain towns',
  photography_golden_hour: 'Sunrise & sunset photography',
  stargazing: 'Stargazing',
};

/**
 * How often the traveller wants a category, not merely whether they like it.
 * This is the distinction that stops a "likes hiking" signal from producing a
 * trip that is nothing but hikes.
 */
export const INTEREST_LEVELS = ['avoid', 'low', 'occasional', 'frequent', 'core'] as const;
export const interestLevelSchema = z.enum(INTEREST_LEVELS);
export type InterestLevel = z.infer<typeof interestLevelSchema>;

export const INTEREST_LEVEL_LABELS: Record<InterestLevel, string> = {
  avoid: 'Skip it',
  low: 'Only if it is right there',
  occasional: 'Once or twice',
  frequent: 'A few times',
  core: 'Build the trip around it',
};

export const AVOIDANCES = [
  'crowds_and_tourist_traps',
  'long_hikes',
  'strenuous_activity',
  'long_drives',
  'rough_or_gravel_roads',
  'high_altitude_exertion',
  'early_mornings',
  'remote_areas_without_services',
  'expensive_activities',
  'cold_water',
  /**
   * The two weather avoidances. Separate from `cold_water`, which is about
   * getting into a lake, and from `high_altitude_exertion`, which is about
   * effort. These two are read against the actual forecast or the historical
   * pattern for the day a place would land on, so a traveller who says "not in
   * the heat" is not sent to the valley floor in August.
   */
  'extreme_heat',
  'extreme_cold',
] as const;
export const avoidanceSchema = z.enum(AVOIDANCES);
export type Avoidance = z.infer<typeof avoidanceSchema>;

export const AVOIDANCE_LABELS: Record<Avoidance, string> = {
  crowds_and_tourist_traps: 'Crowds and tourist traps',
  long_hikes: 'Long hikes',
  strenuous_activity: 'Strenuous activity',
  long_drives: 'Long drives',
  rough_or_gravel_roads: 'Rough or gravel roads',
  high_altitude_exertion: 'Hard effort at high altitude',
  early_mornings: 'Early mornings',
  remote_areas_without_services: 'Remote areas with no services',
  expensive_activities: 'Expensive activities',
  cold_water: 'Cold water',
  extreme_heat: 'Being out in extreme heat',
  extreme_cold: 'Being out in extreme cold',
};

export const PACES = ['slow', 'balanced', 'fast'] as const;
export const paceSchema = z.enum(PACES);
export type Pace = z.infer<typeof paceSchema>;

export const DAILY_INTENSITIES = ['light', 'moderate', 'intense'] as const;
export const dailyIntensitySchema = z.enum(DAILY_INTENSITIES);
export type DailyIntensity = z.infer<typeof dailyIntensitySchema>;

export const DAY_STARTS = ['early', 'normal', 'relaxed'] as const;
export const dayStartSchema = z.enum(DAY_STARTS);
export type DayStart = z.infer<typeof dayStartSchema>;

export const BUDGET_STYLES = ['budget', 'midrange', 'premium', 'luxury'] as const;
export const budgetStyleSchema = z.enum(BUDGET_STYLES);
export type BudgetStyle = z.infer<typeof budgetStyleSchema>;

/** Famous-attraction versus hidden-gem appetite. */
export const DISCOVERY_MIXES = ['mostly_classics', 'balanced', 'mostly_hidden', 'deep_cuts'] as const;
export const discoveryMixSchema = z.enum(DISCOVERY_MIXES);
export type DiscoveryMix = z.infer<typeof discoveryMixSchema>;

export const CROWD_TOLERANCES = ['avoid_crowds', 'mild', 'dont_mind'] as const;
export const crowdToleranceSchema = z.enum(CROWD_TOLERANCES);
export type CrowdTolerance = z.infer<typeof crowdToleranceSchema>;

export const REGIONAL_EXPANSIONS = [
  'destination_only',
  'nearby_30',
  'nearby_60',
  'nearby_120',
  'best_regional',
] as const;
export const regionalExpansionSchema = z.enum(REGIONAL_EXPANSIONS);
export type RegionalExpansion = z.infer<typeof regionalExpansionSchema>;

/**
 * Radius labels with no place names in them.
 *
 * These used to read "Stay in Mammoth Lakes itself" and "Build the best Eastern
 * Sierra trip" — one authored region's names, in the shared schema module every
 * other region would inherit them from. A region that has better wording supplies
 * it through `Region.questionnaireCopy`; this is what everywhere else gets, and
 * it is correct rather than merely neutral.
 */
export const REGIONAL_EXPANSION_LABELS: Record<RegionalExpansion, string> = {
  destination_only: 'Stay in the destination itself',
  nearby_30: 'Anything within about 30 minutes',
  nearby_60: 'Anything within about an hour',
  nearby_120: 'Up to two hours if it is worth it',
  best_regional: 'Build the best regional trip, wherever that leads',
};

/** 0 free, 1 cheap, 2 moderate, 3 expensive. A union so the type carries the range. */
export const costLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type CostLevel = z.infer<typeof costLevelSchema>;

export const PHYSICAL_INTENSITIES = ['none', 'easy', 'moderate', 'strenuous'] as const;
export const physicalIntensitySchema = z.enum(PHYSICAL_INTENSITIES);
export type PhysicalIntensity = z.infer<typeof physicalIntensitySchema>;

export const CROWD_LEVELS = ['quiet', 'moderate', 'busy', 'very_busy'] as const;
export const crowdLevelSchema = z.enum(CROWD_LEVELS);
export type CrowdLevel = z.infer<typeof crowdLevelSchema>;

// Weather sensitivity used to live here as a single three-value enum. It now
// lives in `schemas/weather.ts` as a typed profile, because one scalar could not
// tell "shuts on wind" from "a cloudy sunset is worthless" from "no shade in
// August" — and the planner has to act differently on each.

export const ROAD_SURFACES = ['paved', 'partly_unpaved', 'unpaved'] as const;
export const roadSurfaceSchema = z.enum(ROAD_SURFACES);
export type RoadSurface = z.infer<typeof roadSurfaceSchema>;

export const PARKING_DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export const parkingDifficultySchema = z.enum(PARKING_DIFFICULTIES);
export type ParkingDifficulty = z.infer<typeof parkingDifficultySchema>;

export const CLOSURE_RISKS = ['none', 'seasonal', 'high'] as const;
export const closureRiskSchema = z.enum(CLOSURE_RISKS);
export type ClosureRisk = z.infer<typeof closureRiskSchema>;

export const PLACE_CATEGORIES = [
  'viewpoint',
  'day_hike',
  'easy_walk',
  'lake',
  'scenic_drive',
  'geothermal',
  'hot_spring',
  'historic_site',
  'museum',
  'town_and_food',
  'gondola_or_tram',
  'national_monument',
  'wildlife_area',
] as const;
export const placeCategorySchema = z.enum(PLACE_CATEGORIES);
export type PlaceCategory = z.infer<typeof placeCategorySchema>;

export const PLACE_CATEGORY_LABELS: Record<PlaceCategory, string> = {
  viewpoint: 'Viewpoint',
  day_hike: 'Day hike',
  easy_walk: 'Easy walk',
  lake: 'Lake',
  scenic_drive: 'Scenic drive',
  geothermal: 'Geothermal',
  hot_spring: 'Hot spring',
  historic_site: 'Historic site',
  museum: 'Museum',
  town_and_food: 'Town & food',
  gondola_or_tram: 'Gondola',
  national_monument: 'National monument',
  wildlife_area: 'Wildlife area',
};

export const TIME_OF_DAY = ['sunrise', 'morning', 'afternoon', 'sunset', 'night', 'any'] as const;
export const timeOfDaySchema = z.enum(TIME_OF_DAY);
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;
