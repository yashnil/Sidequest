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

/**
 * V11 §1 — A POSITION ON A DAY'S TIMELINE, WHICH MAY RUN PAST MIDNIGHT.
 *
 * A minute *of day* is a clock reading and is bounded at 24:00: opening hours,
 * sunset and a departure time are all that, and widening them would be a lie
 * about what those fields mean.
 *
 * An itinerary item's position is a different thing. A day that overruns puts
 * real stops past midnight, and the scheduler used to clamp them — which did
 * not merely misplace them, it **destroyed their durations**, because an item's
 * duration is derived as `endMinute - startMinute` and both ends clamped to the
 * same 24:00. That is how a real journey shipped to a traveller as
 * "0 min Walk to Karakol · base to base measured".
 *
 * So a timeline minute may run into the following day. Two days of range is
 * deliberate: it is enough for any overrun a scheduler should ever produce and
 * still refuses a value that is simply wrong.
 */
export const TIMELINE_MINUTE_LIMIT = MINUTES_PER_DAY * 2;
export const timelineMinuteSchema = z.number().int().min(0).max(TIMELINE_MINUTE_LIMIT);

/**
 * A timeline minute as a traveller reads it, and whether it has crossed into
 * the next day. The clock wraps; the fact that it wrapped is returned rather
 * than hidden, because "01:30" on day 4 with no further signal is a worse lie
 * than the clamp was.
 */
export function formatTimelineMinute(minute: number): { text: string; nextDay: boolean } {
  const rounded = Math.max(0, Math.round(minute));
  const nextDay = rounded >= MINUTES_PER_DAY;
  const within = rounded % MINUTES_PER_DAY;
  return { text: `${String(Math.floor(within / 60)).padStart(2, '0')}:${String(within % 60).padStart(2, '0')}`, nextDay };
}

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

/**
 * WHAT A TRAVELLER CAN CARE ABOUT — THE WHOLE VOCABULARY, NOT THE OFFER.
 *
 * This list is the union of everything Sidequest can rank a place against. It
 * is deliberately *not* the set of rows a traveller is shown: which of these a
 * given destination can honestly serve is decided per region, from that
 * region's own evidence, by `interests/offer.ts`.
 *
 * The distinction is the fix for a shipped defect. The list was one hard-coded
 * outdoor taxonomy served verbatim to every destination, so a traveller
 * planning a dense city was asked to grade scenic drives, geothermal ground,
 * hot springs and stargazing, and had no row at all for museums, temples,
 * neighbourhoods or the coast. It was simultaneously a questionnaire failure
 * and a research failure: the graded answers steer candidate acquisition, so
 * the pipeline went looking for mountain-town material in a metropolis.
 *
 * ADDITIVE ONLY. Every id here has been valid since it was introduced and stays
 * valid, because stored traveller profiles are keyed on these strings and a
 * removed id would silently drop a preference somebody stated. Labels may be
 * corrected — a label is copy — and `food_and_towns` was, because "Food &
 * mountain towns" is a sentence about one valley.
 *
 * Seed place tags are drawn from this same list.
 */
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
  /**
   * The built and inhabited half of the vocabulary, added in Phase 16.
   *
   * Each one exists because a real destination could not be described without
   * it, and each one is gated on evidence: a region with no museum in it never
   * offers `museums_and_galleries`, exactly as a region with no thermal ground
   * never offers `geology_and_geothermal`. Nothing here is offered to a
   * traveller on the strength of the vocabulary alone.
   */
  'museums_and_galleries',
  'architecture_and_landmarks',
  'neighbourhoods_and_local_life',
  'markets_and_street_food',
  'beaches_and_swimming',
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
  // Was "Food & mountain towns". The mountains were a fact about one region,
  // printed on the only food row every destination in the product had.
  food_and_towns: 'Food & local eating',
  photography_golden_hour: 'Sunrise & sunset photography',
  stargazing: 'Stargazing',
  museums_and_galleries: 'Museums & galleries',
  architecture_and_landmarks: 'Architecture & landmarks',
  neighbourhoods_and_local_life: 'Neighbourhoods & local life',
  markets_and_street_food: 'Markets & street food',
  beaches_and_swimming: 'Beaches & swimming',
};


/**
 * How often the traveller wants a category, not merely whether they like it.
 * This is the distinction that stops a "likes hiking" signal from producing a
 * trip that is nothing but hikes.
 */
/**
 * HOW MUCH UNSCHEDULED TIME THE TRAVELLER ASKED FOR.
 *
 * The composer has asked this question since it shipped ("Free time") and
 * nothing downstream read the answer, which made it a placebo — the failure
 * mode this codebase names explicitly about `high_altitude_exertion`. It
 * belongs here rather than only in the composer's own schema because the
 * consumer is the readiness verdict: how full a plan has to be before it is
 * *this traveller's* finished trip is a question only they can answer, and a
 * single constant answering it for everybody is what let a plan holding two
 * fifths of its own paced volume read "Ready — the plan works".
 */
export const FREE_TIME_APPETITES = ['packed', 'balanced', 'lots'] as const;
export const freeTimeAppetiteSchema = z.enum(FREE_TIME_APPETITES);
export type FreeTimeAppetite = z.infer<typeof freeTimeAppetiteSchema>;

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

/**
 * A traveller's grading, keyed on interests they were actually offered.
 *
 * Partial, and that is the point rather than a looseness. `z.record` over an
 * enum is exhaustive in the Zod this repository pins, so every stored answer
 * set had to name every interest that existed when it was written — which meant
 * that the moment the vocabulary grew, a completed questionnaire stopped
 * parsing and the traveller lost it. Since the offer is now per-destination, a
 * complete grading is not even a thing an honest wizard can produce: a city
 * traveller is never asked about hot springs, and recording `low` for a
 * question nobody put to them would be an answer we invented.
 *
 * Every reader already resolves an absent level to `low` at the point of use —
 * the same value an untouched row carries — so absence and "only if it is
 * right there" behave identically, which is the truth in both cases.
 */
export const interestLevelsSchema = z.partialRecord(interestSchema, interestLevelSchema);
export type InterestLevels = z.infer<typeof interestLevelsSchema>;

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
