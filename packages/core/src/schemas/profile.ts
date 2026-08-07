import { z } from 'zod';
import { transportPrioritySchema } from './access';
import { preferenceSignalSchema } from './interpretation';
import {
  breakfastStyleSchema,
  dietaryNeedSchema,
  foodPreferencesSchema,
  foodStyleSchema,
  specialMealAppetiteSchema,
} from './food';
import {
  avoidanceSchema,
  budgetStyleSchema,
  costLevelSchema,
  crowdToleranceSchema,
  dailyIntensitySchema,
  dayStartSchema,
  discoveryMixSchema,
  INTERESTS,
  interestLevelSchema,
  interestSchema,
  paceSchema,
  physicalIntensitySchema,
  regionalExpansionSchema,
} from './common';

/**
 * Raw questionnaire output. Kept separate from the canonical profile so the form
 * can evolve (wording, ordering, extra questions) without breaking scoring, and
 * so the transform between the two is a single tested function.
 */
export const questionnaireAnswersSchema = z.object({
  interests: z.record(interestSchema, interestLevelSchema),
  pace: paceSchema,
  dayStart: dayStartSchema,
  dailyIntensity: dailyIntensitySchema,
  budgetStyle: budgetStyleSchema,
  discoveryMix: discoveryMixSchema,
  crowdTolerance: crowdToleranceSchema,
  avoidTouristTraps: z.boolean(),
  willDrive: z.boolean(),
  comfortableMountainRoads: z.boolean(),
  comfortableGravelRoads: z.boolean(),
  maxDailyTravelMinutes: z.number().int().min(30).max(480),
  /**
   * Added after the first questionnaire shipped. Defaults keep every answer set
   * already in the database parseable — a saved trip must not become unreadable
   * because a later build asked one more question.
   */
  willUseShuttles: z.boolean().default(true),
  maxAccessWalkMinutes: z.number().int().min(0).max(120).default(25),
  transportPriority: transportPrioritySchema.default('best_value'),
  regionalExpansion: regionalExpansionSchema,
  detourToleranceMinutes: z.number().int().min(0).max(180),
  avoidances: z.array(avoidanceSchema).default([]),
  /**
   * Confirmed free-text preferences, as direction and size on a documented range.
   *
   * `interests` is a five-rung ladder and `avoidances` is a list of booleans, and
   * between them they cannot express "really rather not, but do not delete it" —
   * nine of the twelve avoidance keys have no graded channel at all. So
   * `applyInterpretation` writes what those two *can* carry and puts the whole
   * normalised vector here, where a ranker can read a magnitude instead of
   * re-deriving one from an enum name.
   *
   * Defaulted, like every other field added after the fact: `answers_json` is
   * stored raw and reparsed on every read, so a trip saved before this existed
   * must not become unreadable. An empty list means "nothing was interpreted",
   * which is different from and must not be confused with "no preferences".
   */
  preferenceSignals: z.array(preferenceSignalSchema).default([]),
  mobilityLimited: z.boolean(),
  accessibilityNotes: z.string().max(500).optional(),
  /**
   * Food. Six questions, all defaulted for the same reason `willUseShuttles` is:
   * `answers_json` is stored raw and reparsed on every read, so a saved trip must
   * not become unreadable because a later build asked one more question.
   *
   * Six and not sixteen. The questionnaire is the thing that buys the traveller
   * out of ten hours of tab-juggling, and turning it into a restaurant survey to
   * feed a scorer would be spending the budget it exists to save. Everything else
   * the food planner needs — how many meals a day has, whether a route passes
   * anywhere, what a stop costs in detour minutes — comes from the itinerary,
   * which is the whole point of doing this after the days are laid out.
   */
  breakfastStyle: breakfastStyleSchema.default('coffee_light'),
  foodStyle: foodStyleSchema.default('balanced'),
  specialMealAppetite: specialMealAppetiteSchema.default('one'),
  /** Whether a grocery stop and a rucksack are an acceptable answer to lunch. */
  willPackLunch: z.boolean().default(true),
  dietaryNeeds: z.array(dietaryNeedSchema).default([]),
  /**
   * The line between "I would rather" and "I cannot".
   *
   * Asked as its own question because the two produce different plans and
   * different sentences. A soft preference lets an unconfirmed venue win on
   * other merits; a strict requirement makes "nobody has confirmed this" a
   * reason to look elsewhere, and makes a packed lunch the safer answer.
   */
  dietaryStrict: z.boolean().default(false),
});
export type QuestionnaireAnswers = z.infer<typeof questionnaireAnswersSchema>;

/** A profile with every interest set to "only if it is right there" cannot personalise anything. */
export const validatedQuestionnaireAnswersSchema = questionnaireAnswersSchema.refine(
  (answers) =>
    INTERESTS.some((interest) => {
      const level = answers.interests[interest];
      return level === 'occasional' || level === 'frequent' || level === 'core';
    }),
  {
    message: 'Pick at least one thing you actually want to do on this trip',
    path: ['interests'],
  },
);

/**
 * Values the scorer reads directly. Deriving them once, here, keeps the scoring
 * functions free of preference interpretation and makes the interpretation itself
 * testable in isolation.
 */
export const derivedProfileSchema = z.object({
  /** Hard ceiling on effort, from intensity preference plus mobility/avoidances. */
  maxPhysicalIntensity: physicalIntensitySchema,
  /** The effort level that actually suits them, which is rarely the ceiling. */
  preferredPhysicalIntensity: physicalIntensitySchema,
  /** Cost level at which a place starts reading as expensive for this traveller. */
  comfortableCostLevel: costLevelSchema,
  /** How many real activities a day can hold at this pace. */
  activitySlotsPerDay: z.number().min(1).max(6),
  /** Per-interest ceiling on how many stops of that kind the trip may contain. */
  frequencyCaps: z.record(interestSchema, z.number().int().min(0)),
  /** One-way minutes from base the traveller will actually accept. */
  effectiveDetourMinutes: z.number().int().min(0),
  /** Target share of hidden-gem-leaning picks, 0-1. */
  hiddenGemTarget: z.number().min(0).max(1),
});
export type DerivedProfile = z.infer<typeof derivedProfileSchema>;

/**
 * 3 — food became a planning input rather than an absence. The traveller has a
 * breakfast habit, a dining style, an appetite for special meals, a position on
 * carrying a packed lunch, and — kept deliberately apart from all of those —
 * dietary needs and whether they are requirements or leanings.
 *
 * 2 — transport became a planning constraint rather than a set of road-comfort
 * booleans: driving and total transportation now have separate budgets, and the
 * traveller's shuttle, walking and optimisation preferences are first-class.
 *
 * `migrateTravelerProfile` rebuilds any older row from the answers that produced
 * it, so a bump here costs a stored profile nothing.
 */
export const TRAVELER_PROFILE_VERSION = 3 as const;

export const travelerProfileSchema = z.object({
  version: z.literal(TRAVELER_PROFILE_VERSION),
  interests: z.record(interestSchema, interestLevelSchema),
  pace: paceSchema,
  dayStart: dayStartSchema,
  dailyIntensity: dailyIntensitySchema,
  budgetStyle: budgetStyleSchema,
  discoveryMix: discoveryMixSchema,
  crowdTolerance: crowdToleranceSchema,
  avoidTouristTraps: z.boolean(),
  /**
   * Two budgets, not one.
   *
   * An hour behind the wheel on a mountain road and an hour on a shuttle with a
   * book are not the same hour, and a traveller who caps their driving has not
   * capped their willingness to be transported. Collapsing them into a single
   * number is what makes a car-free plan look impossible and a shuttle day look
   * like a violation.
   */
  transport: z.object({
    willDrive: z.boolean(),
    comfortableMountainRoads: z.boolean(),
    comfortableGravelRoads: z.boolean(),
    /** Minutes at the wheel a single day may contain. Zero without a car. */
    maxDailyDriveMinutes: z.number().int().min(0).max(480),
    /** Driving plus riding plus walking to reach things. Always the larger cap. */
    maxDailyTransportMinutes: z.number().int().min(30).max(600),
    willUseShuttles: z.boolean(),
    maxAccessWalkMinutes: z.number().int().min(0).max(120),
    priority: transportPrioritySchema,
  }),
  /**
   * How they eat, kept beside `transport` rather than inside `derived` for the
   * same reason: it mixes stated answers with values derived from them once, and
   * every consumer should read the derived ones rather than re-deriving.
   */
  food: foodPreferencesSchema,
  regionalExpansion: regionalExpansionSchema,
  detourToleranceMinutes: z.number().int().min(0).max(180),
  avoidances: z.array(avoidanceSchema),
  /** Carried through from the answers unchanged. See the note there. */
  preferenceSignals: z.array(preferenceSignalSchema).default([]),
  accessibility: z.object({
    mobilityLimited: z.boolean(),
    notes: z.string().max(500).optional(),
  }),
  derived: derivedProfileSchema,
});
export type TravelerProfile = z.infer<typeof travelerProfileSchema>;
