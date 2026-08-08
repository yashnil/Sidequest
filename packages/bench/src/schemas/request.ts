import { z } from 'zod';

/**
 * THE SHARED TRAVELLER REQUEST.
 *
 * One object, handed to both competing planners, byte-identical. Everything a
 * benchmark session knows about the traveller before either system has done any
 * work of its own.
 *
 * Three properties are load-bearing, and each is enforced rather than promised.
 *
 * **It carries stated answers only.** Not one field here is derived. Sidequest's
 * profile holds values like `maxDailyTransportMinutes`, `frequencyCaps` and
 * `effectiveDetourMinutes` that its own transform computes from what the
 * traveller said. Putting any of those in this request would hand one system a
 * model the other would have to reinvent, and would do it invisibly.
 * `derived-leakage.test.ts` asserts the absence by name.
 *
 * **It has one vocabulary.** The repository already holds three different words
 * for crowd tolerance, two for pace, two spellings of mid-range and two
 * transport enumerations, because each grew where it was needed. A benchmark
 * that reached for the wrong one would silently drop an answer at the boundary
 * and nobody would see it. So this file defines the canonical terms, and the two
 * adapters that translate into each system are total and tested.
 *
 * **Every field states which systems can act on it.** See `FIELD_TIERS` below.
 * A field one system structurally cannot consume is still sent to both — hiding
 * it from the system that *can* use it would fabricate a traveller who never
 * said it — but the asymmetry is recorded rather than left to be discovered in
 * the results.
 */

export const BENCHMARK_REQUEST_VERSION = 1 as const;

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are ISO calendar labels, YYYY-MM-DD');

export const isoTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times are 24-hour HH:MM');

/* ------------------------------------------------------------------ *
 * Destination and dates
 * ------------------------------------------------------------------ */

export const DESTINATION_MODES = ['known', 'undecided'] as const;
export const destinationModeSchema = z.enum(DESTINATION_MODES);
export type DestinationMode = z.infer<typeof destinationModeSchema>;

/**
 * What the traveller typed, and — when a session has already resolved it — the
 * identity both systems must plan against.
 *
 * `identity` is set by the benchmark harness after one shared resolution step,
 * never by either competitor. Two systems that each geocoded the same words and
 * landed on different places would be planning different trips, and the
 * comparison would be meaningless before it began.
 */
export const destinationSchema = z.object({
  mode: destinationModeSchema,
  /** Exactly what the traveller wrote. Never normalised away. */
  text: z.string().trim().min(2).max(200),
  identity: z
    .object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      countryCode: z.string().length(2).optional(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .nullable()
    .default(null),
});

export const DATE_MODES = ['exact', 'flexible', 'month', 'undecided'] as const;
export const dateModeSchema = z.enum(DATE_MODES);

export const datesSchema = z
  .object({
    mode: dateModeSchema,
    startDate: isoDate.nullable().default(null),
    endDate: isoDate.nullable().default(null),
    /** How many days either way the traveller could shift, on `flexible`. */
    flexDays: z.number().int().min(0).max(30).default(0),
    /** 1-12, on `month`. */
    month: z.number().int().min(1).max(12).nullable().default(null),
    year: z.number().int().min(2000).max(2100).nullable().default(null),
    /** Nights on the ground. Stated even when dates are exact, so a flexible
     *  request still carries a length both systems must respect. */
    nights: z.number().int().min(1).max(30),
  })
  .refine((d) => d.mode !== 'exact' || (d.startDate !== null && d.endDate !== null), {
    message: 'An exact-date request must carry both dates',
    path: ['startDate'],
  })
  .refine((d) => d.startDate === null || d.endDate === null || d.endDate >= d.startDate, {
    message: 'The end date has to be on or after the start date',
    path: ['endDate'],
  });

export const ARRIVAL_PRECISIONS = [
  'exact',
  'morning',
  'afternoon',
  'evening',
  'unknown',
] as const;
export const arrivalPrecisionSchema = z.enum(ARRIVAL_PRECISIONS);

export const edgeTimingSchema = z.object({
  precision: arrivalPrecisionSchema,
  /** Present only when `precision` is `exact`. */
  time: isoTime.nullable().default(null),
});

/* ------------------------------------------------------------------ *
 * Party
 * ------------------------------------------------------------------ */

/**
 * Mobility and dietary needs are their own fields and are never inferred from
 * prose. That is not a benchmark convention — it is a boundary the production
 * system already enforces, because a model reading "my knee is a bit dodgy" and
 * quietly capping a trip's intensity is a decision nobody asked it to make. The
 * benchmark inherits the boundary so neither system has to guess.
 */
export const MOBILITY_CONSTRAINTS = [
  'none',
  'limited_walking',
  'no_stairs',
  'wheelchair_user',
  'low_stamina',
  'altitude_sensitive',
] as const;
export const mobilityConstraintSchema = z.enum(MOBILITY_CONSTRAINTS);

export const DIETARY_REQUIREMENTS = [
  'vegetarian',
  'vegan',
  'gluten_free',
  'dairy_free',
  'nut_allergy',
  'halal',
  'kosher',
] as const;
export const dietaryRequirementSchema = z.enum(DIETARY_REQUIREMENTS);

export const partySchema = z.object({
  adults: z.number().int().min(1).max(12),
  children: z.number().int().min(0).max(12),
  /** Ages, when the traveller gave them. An empty list is not "no children". */
  childAges: z.array(z.number().int().min(0).max(17)).max(12).default([]),
  seniorsInGroup: z.boolean().default(false),
  mobility: z.array(mobilityConstraintSchema).default([]),
  /** Free text the traveller chose to give about access needs. Never inferred. */
  mobilityNotes: z.string().max(500).default(''),
  dietary: z.array(dietaryRequirementSchema).default([]),
  /**
   * The line between "I would rather" and "I cannot". Two different plans and
   * two different sentences follow from it, so it is asked rather than guessed.
   */
  dietaryStrict: z.boolean().default(false),
});

/* ------------------------------------------------------------------ *
 * Movement
 * ------------------------------------------------------------------ */

export const TRANSPORT_PREFERENCES = [
  'drive',
  'public_transport',
  'mixed',
  'guided_or_transfers',
  'no_preference',
] as const;
export const transportPreferenceSchema = z.enum(TRANSPORT_PREFERENCES);

export const TRANSIT_PREFERENCES = ['prefer', 'accept', 'avoid'] as const;
export const transitPreferenceSchema = z.enum(TRANSIT_PREFERENCES);

export const movementSchema = z.object({
  preference: transportPreferenceSchema,
  publicTransit: transitPreferenceSchema,
  carAvailable: z.boolean(),
  comfortableMountainRoads: z.boolean().default(false),
  comfortableUnpavedRoads: z.boolean().default(false),
  willUseShuttlesAndFerries: z.boolean().default(true),
  /** At the wheel, per day. Meaningful only when `carAvailable`. */
  maxDailyDriveMinutes: z.number().int().min(0).max(600),
  /** Driving plus riding plus walking to reach things. Always the larger cap. */
  maxDailyTravelMinutes: z.number().int().min(30).max(720),
  maxAccessWalkMinutes: z.number().int().min(0).max(180).default(30),
  /** How many places the traveller is willing to sleep in. */
  desiredBaseCount: z.number().int().min(1).max(8),
  maxBaseChanges: z.number().int().min(0).max(10),
});

/* ------------------------------------------------------------------ *
 * Rhythm
 * ------------------------------------------------------------------ */

export const PACES = ['slow', 'balanced', 'fast'] as const;
export const paceSchema = z.enum(PACES);

export const ACTIVITY_INTENSITIES = ['light', 'moderate', 'intense'] as const;
export const activityIntensitySchema = z.enum(ACTIVITY_INTENSITIES);

export const FREE_TIME_APPETITES = ['packed', 'balanced', 'lots'] as const;
export const freeTimeAppetiteSchema = z.enum(FREE_TIME_APPETITES);

export const EARLY_MORNING_TOLERANCES = ['happily', 'sometimes', 'never'] as const;
export const earlyMorningToleranceSchema = z.enum(EARLY_MORNING_TOLERANCES);

export const rhythmSchema = z.object({
  pace: paceSchema,
  activityIntensity: activityIntensitySchema,
  freeTime: freeTimeAppetiteSchema,
  earlyMornings: earlyMorningToleranceSchema,
});

/* ------------------------------------------------------------------ *
 * Taste
 * ------------------------------------------------------------------ */

/**
 * The interest vocabulary.
 *
 * Wider than the production questionnaire's twelve, because the case library has
 * to describe a nightlife weekend and a museum city as well as a mountain trip,
 * and a benchmark request that could not express those would decide the result
 * by omission. The adapter into Sidequest maps what maps and records the rest as
 * `not_representable` — visibly, in the parity report.
 */
export const INTERESTS = [
  'hiking',
  'easy_nature_walks',
  'scenic_viewpoints',
  'lakes_and_rivers',
  'beaches_and_swimming',
  'scenic_drives',
  'wildlife',
  'geology_and_geothermal',
  'hot_springs',
  'history_and_culture',
  'museums_and_galleries',
  'architecture',
  'food_and_towns',
  'markets_and_street_food',
  'fine_dining',
  'cafes',
  'nightlife',
  'shopping',
  'local_neighbourhoods',
  'festivals_and_events',
  'photography_golden_hour',
  'stargazing',
  'wellness_and_spa',
  'boats_and_ferries',
  'trains',
  'winter_sports',
  'diving_and_snorkelling',
  'theme_parks',
] as const;
export const interestSchema = z.enum(INTERESTS);
export type BenchmarkInterest = z.infer<typeof interestSchema>;

/**
 * How often, not merely whether. This is the distinction that stops "likes
 * hiking" from producing a trip that is nothing but hikes, and it is the one
 * both systems are given verbatim.
 */
export const INTEREST_LEVELS = ['avoid', 'low', 'occasional', 'frequent', 'core'] as const;
export const interestLevelSchema = z.enum(INTEREST_LEVELS);

export const CROWD_TOLERANCES = ['avoid_crowds', 'mild', 'dont_mind'] as const;
export const crowdToleranceSchema = z.enum(CROWD_TOLERANCES);

export const DISCOVERY_MIXES = [
  'mostly_classics',
  'balanced',
  'mostly_hidden',
  'deep_cuts',
] as const;
export const discoveryMixSchema = z.enum(DISCOVERY_MIXES);

export const IMPORTANCE = ['not_at_all', 'a_little', 'matters', 'central'] as const;
export const importanceSchema = z.enum(IMPORTANCE);

export const INDOOR_OUTDOOR_BALANCES = [
  'mostly_indoor',
  'balanced',
  'mostly_outdoor',
] as const;
export const indoorOutdoorBalanceSchema = z.enum(INDOOR_OUTDOOR_BALANCES);

/**
 * Hard avoidances. The word "hard" is doing work: these are filters, not
 * leanings, and a plan that contains one has broken a stated constraint rather
 * than made a debatable choice. The neutral validators treat a violation here as
 * critical, which is why the list is closed and why soft dislikes live in
 * `dislikes` as free text instead.
 */
export const HARD_AVOIDANCES = [
  'crowds_and_tourist_traps',
  'long_hikes',
  'strenuous_activity',
  'long_drives',
  'rough_or_unpaved_roads',
  'high_altitude_exertion',
  'early_mornings',
  'remote_areas_without_services',
  'expensive_activities',
  'cold_water',
  'extreme_heat',
  'extreme_cold',
  'boats_and_ferries',
  'nightlife',
  'heights_and_exposure',
  'small_aircraft',
] as const;
export const hardAvoidanceSchema = z.enum(HARD_AVOIDANCES);

export const tasteSchema = z.object({
  interests: z.record(interestSchema, interestLevelSchema),
  crowdTolerance: crowdToleranceSchema,
  discoveryMix: discoveryMixSchema,
  foodImportance: importanceSchema,
  nightlifeImportance: importanceSchema,
  indoorOutdoorBalance: indoorOutdoorBalanceSchema,
  /**
   * Named experiences the traveller will be disappointed to miss. Free text on
   * purpose: a closed list could not hold "the sunrise hike my brother did".
   * A validator checks only that the plan either contains it or says why not.
   */
  mustDo: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  dislikes: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  hardAvoidances: z.array(hardAvoidanceSchema).default([]),
});

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

export const TOLERANCES = ['fine', 'prefer_not', 'cannot'] as const;
export const toleranceSchema = z.enum(TOLERANCES);

export const CLIMATE_PREFERENCES = [
  'warm',
  'mild',
  'cool',
  'cold_and_snowy',
  'no_preference',
] as const;
export const climatePreferenceSchema = z.enum(CLIMATE_PREFERENCES);

export const conditionsSchema = z.object({
  climate: climatePreferenceSchema,
  heat: toleranceSchema,
  cold: toleranceSchema,
  rain: toleranceSchema,
  snow: toleranceSchema,
});

/* ------------------------------------------------------------------ *
 * Practicalities
 * ------------------------------------------------------------------ */

export const BUDGET_BANDS = ['budget', 'midrange', 'premium', 'luxury'] as const;
export const budgetBandSchema = z.enum(BUDGET_BANDS);

export const ACCOMMODATION_PREFERENCES = [
  'hostel',
  'basic_hotel',
  'boutique_hotel',
  'apartment',
  'resort',
  'luxury_hotel',
  'nature_lodge',
  'no_preference',
] as const;
export const accommodationPreferenceSchema = z.enum(ACCOMMODATION_PREFERENCES);

export const RESERVATION_TOLERANCES = [
  'happy_to_book_ahead',
  'a_few_is_fine',
  'keep_it_spontaneous',
] as const;
export const reservationToleranceSchema = z.enum(RESERVATION_TOLERANCES);

export const GUIDED_TOUR_PREFERENCES = ['prefer', 'sometimes', 'avoid'] as const;
export const guidedTourPreferenceSchema = z.enum(GUIDED_TOUR_PREFERENCES);

export const practicalitiesSchema = z.object({
  budget: budgetBandSchema,
  accommodation: accommodationPreferenceSchema,
  reservations: reservationToleranceSchema,
  guidedTours: guidedTourPreferenceSchema,
});

/* ------------------------------------------------------------------ *
 * The request
 * ------------------------------------------------------------------ */

export const benchmarkTripRequestSchema = z
  .object({
    schemaVersion: z.literal(BENCHMARK_REQUEST_VERSION),
    /** Stable across a session. Part of every single-flight operation identity. */
    requestId: z.string().min(1),
    destination: destinationSchema,
    dates: datesSchema,
    arrival: edgeTimingSchema,
    departure: edgeTimingSchema,
    /** Where they are travelling from. Free text; neither system books flights. */
    origin: z.string().trim().max(120).default(''),
    party: partySchema,
    movement: movementSchema,
    rhythm: rhythmSchema,
    taste: tasteSchema,
    conditions: conditionsSchema,
    practicalities: practicalitiesSchema,
    /**
     * Anything else the traveller wanted to say.
     *
     * Delivered to both systems as untrusted content. It is the one field an
     * attacker controls, and the one field a prompt-injection test targets.
     */
    freeText: z.string().max(2000).default(''),
  })
  .refine(
    (request) =>
      INTERESTS.some((interest) => {
        const level = request.taste.interests[interest];
        return level === 'occasional' || level === 'frequent' || level === 'core';
      }),
    {
      message: 'A request with no interest above "only if it is right there" cannot personalise anything',
      path: ['taste', 'interests'],
    },
  )
  .refine(
    (request) => request.movement.carAvailable || request.movement.maxDailyDriveMinutes === 0,
    {
      message: 'A request without a car cannot state a driving allowance',
      path: ['movement', 'maxDailyDriveMinutes'],
    },
  )
  .refine(
    (request) => request.movement.maxDailyTravelMinutes >= request.movement.maxDailyDriveMinutes,
    {
      message: 'Total travel time cannot be less than the driving time inside it',
      path: ['movement', 'maxDailyTravelMinutes'],
    },
  )
  .refine((request) => request.movement.maxBaseChanges + 1 >= request.movement.desiredBaseCount, {
    message: 'Reaching that many bases needs at least that many moves',
    path: ['movement', 'maxBaseChanges'],
  })
  .refine(
    (request) =>
      request.party.dietary.length > 0 || request.party.dietaryStrict === false,
    {
      message: 'Strictness is a property of a stated dietary requirement',
      path: ['party', 'dietaryStrict'],
    },
  );
export type BenchmarkTripRequest = z.infer<typeof benchmarkTripRequestSchema>;

/* ------------------------------------------------------------------ *
 * Parity tiers
 * ------------------------------------------------------------------ */

/**
 * WHICH SYSTEMS CAN ACT ON WHICH FIELD.
 *
 * The single most likely way this benchmark produces a wrong answer is by one
 * system silently receiving more usable information than the other. Two
 * asymmetries exist and they run in opposite directions:
 *
 * - A field with no consumer in the deterministic pipeline is free leverage for
 *   a language model, which will happily honour "boutique hotels, no guided
 *   tours" whether or not anything downstream models it.
 * - A value the pipeline derives from stated answers would be free leverage for
 *   the pipeline if the request carried it. It does not; see the header.
 *
 * So every field is tiered, both systems receive every field, and the tier is
 * reported next to the result rather than silently absorbed into it.
 *
 * - `both` — both systems can act on it, meaning the same thing.
 * - `stated_to_both` — stated verbatim to both; only the language-model planner
 *   can currently act on it. Reported separately, never scored head to head.
 *
 * There is deliberately no third tier for "hide from one system". Withholding a
 * field from the system that could use it would invent a traveller who never
 * said it, which is a worse error than the asymmetry it would paper over.
 */
export const FIELD_TIERS = {
  'destination.mode': 'both',
  'destination.text': 'both',
  'destination.identity': 'both',
  'dates.mode': 'both',
  'dates.startDate': 'both',
  'dates.endDate': 'both',
  'dates.flexDays': 'stated_to_both',
  'dates.month': 'both',
  'dates.year': 'both',
  'dates.nights': 'both',
  'arrival': 'both',
  'departure': 'both',
  'origin': 'stated_to_both',
  'party.adults': 'both',
  'party.children': 'both',
  'party.childAges': 'stated_to_both',
  'party.seniorsInGroup': 'both',
  'party.mobility': 'both',
  'party.mobilityNotes': 'both',
  'party.dietary': 'both',
  'party.dietaryStrict': 'both',
  'movement.preference': 'both',
  'movement.publicTransit': 'stated_to_both',
  'movement.carAvailable': 'both',
  'movement.comfortableMountainRoads': 'both',
  'movement.comfortableUnpavedRoads': 'both',
  'movement.willUseShuttlesAndFerries': 'both',
  'movement.maxDailyDriveMinutes': 'both',
  'movement.maxDailyTravelMinutes': 'both',
  'movement.maxAccessWalkMinutes': 'both',
  'movement.desiredBaseCount': 'both',
  'movement.maxBaseChanges': 'both',
  'rhythm.pace': 'both',
  'rhythm.activityIntensity': 'both',
  'rhythm.freeTime': 'stated_to_both',
  'rhythm.earlyMornings': 'both',
  'taste.interests': 'both',
  'taste.crowdTolerance': 'both',
  'taste.discoveryMix': 'both',
  'taste.foodImportance': 'stated_to_both',
  'taste.nightlifeImportance': 'stated_to_both',
  'taste.indoorOutdoorBalance': 'stated_to_both',
  'taste.mustDo': 'both',
  'taste.dislikes': 'both',
  'taste.hardAvoidances': 'both',
  'conditions.climate': 'stated_to_both',
  'conditions.heat': 'both',
  'conditions.cold': 'both',
  'conditions.rain': 'stated_to_both',
  'conditions.snow': 'stated_to_both',
  'practicalities.budget': 'both',
  'practicalities.accommodation': 'stated_to_both',
  'practicalities.reservations': 'stated_to_both',
  'practicalities.guidedTours': 'stated_to_both',
  'freeText': 'both',
} as const satisfies Record<string, 'both' | 'stated_to_both'>;

export type BenchmarkFieldPath = keyof typeof FIELD_TIERS;
export type FieldTier = (typeof FIELD_TIERS)[BenchmarkFieldPath];

/**
 * THE ASYMMETRY, DERIVED RATHER THAN WRITTEN OUT BY HAND.
 *
 * The pre-registered decision rules have to state which fields only one planner
 * can act on, because those fields are excluded from the head-to-head verdict.
 * That list was typed into the document by hand and said eight; the table above
 * says fourteen. A document under-reporting the asymmetry it exists to disclose
 * is worse than one that never mentioned it, because a reader takes the number
 * on trust.
 *
 * So the list is generated from the table and the document quotes this constant
 * by name. A test asserts the count the document prints, which means editing the
 * table without editing the document breaks a test rather than quietly making a
 * pre-registered document wrong.
 */
export const STATED_TO_BOTH_FIELDS: readonly BenchmarkFieldPath[] = (
  Object.keys(FIELD_TIERS) as BenchmarkFieldPath[]
).filter((path) => FIELD_TIERS[path] === 'stated_to_both');

/**
 * Names a benchmark request may never carry, because each is something a system
 * computes rather than something a traveller said. Asserted by test.
 */
export const FORBIDDEN_DERIVED_KEYS = [
  'derived',
  'maxDailyTransportMinutes',
  'activitySlotsPerDay',
  'frequencyCaps',
  'effectiveDetourMinutes',
  'hiddenGemTarget',
  'comfortableCostLevel',
  'maxPhysicalIntensity',
  'preferredPhysicalIntensity',
  'specialMealBudget',
  'everydayPriceBand',
  'preferenceSignals',
] as const;
