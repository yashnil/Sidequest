import { z } from 'zod';
import { transportPrioritySchema } from './access';
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
  mobilityLimited: z.boolean(),
  accessibilityNotes: z.string().max(500).optional(),
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
 * 2 — transport became a planning constraint rather than a set of road-comfort
 * booleans: driving and total transportation now have separate budgets, and the
 * traveller's shuttle, walking and optimisation preferences are first-class.
 * `migrateTravelerProfile` upgrades v1 rows on read.
 */
export const TRAVELER_PROFILE_VERSION = 2 as const;

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
  regionalExpansion: regionalExpansionSchema,
  detourToleranceMinutes: z.number().int().min(0).max(180),
  avoidances: z.array(avoidanceSchema),
  accessibility: z.object({
    mobilityLimited: z.boolean(),
    notes: z.string().max(500).optional(),
  }),
  derived: derivedProfileSchema,
});
export type TravelerProfile = z.infer<typeof travelerProfileSchema>;
