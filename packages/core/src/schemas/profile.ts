import { z } from 'zod';
import { transportPrioritySchema } from './access';
import { preferenceSignalSchema } from './interpretation';
import {
  altitudeComfortSchema,
  baseMoveToleranceSchema,
  budgetEnvelopeSchema,
  convenienceSpendSchema,
  dayTripAppetiteSchema,
  guideWillingnessSchema,
  hardConstraintSchema,
  hikeAppetiteSchema,
  iconicCrowdStrategySchema,
  interviewLogSchema,
  lateNightAppetiteSchema,
  lodgingStyleSchema,
  preferenceProvenanceSchema,
  coverageStrategySchema,
  toleranceSchema,
  transferWillingnessSchema,
  walkingToleranceSchema,
} from './interview';
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
  freeTimeAppetiteSchema,
  INTERESTS,
  interestLevelsSchema,
  interestSchema,
  paceSchema,
  physicalIntensitySchema,
  regionalExpansionSchema,
} from './common';

/**
 * The questionnaire's step identities, declared here rather than in
 * `questionnaire/definition` because the *answers* now reference them: a
 * traveller can hand a whole step to us ("decide for me"), and that statement
 * is part of the durable answer set. Schemas must not import from the
 * questionnaire package — the dependency runs the other way — so the canonical
 * list lives with the schema and `QUESTIONNAIRE_STEPS` re-exports it.
 */
export const QUESTIONNAIRE_STEP_IDS = [
  'interests',
  'rhythm',
  'budget',
  'food',
  'discovery',
  'transport',
  'region',
  'constraints',
  'review',
] as const;
export const questionnaireStepIdSchema = z.enum(QUESTIONNAIRE_STEP_IDS);

/**
 * Raw questionnaire output. Kept separate from the canonical profile so the form
 * can evolve (wording, ordering, extra questions) without breaking scoring, and
 * so the transform between the two is a single tested function.
 */
export const questionnaireAnswersSchema = z.object({
  /*
   * Keyed on the interests this traveller was actually offered. See
   * `interestLevelsSchema` for why an exhaustive record could not survive the
   * vocabulary growing, and why an absent grading reads as `low` everywhere.
   */
  interests: interestLevelsSchema,
  pace: paceSchema,
  dayStart: dayStartSchema,
  dailyIntensity: dailyIntensitySchema,
  /**
   * How much unscheduled time the traveller asked for.
   *
   * Defaulted, like every other question added after the first questionnaire
   * shipped: `answers_json` is stored raw and reparsed on every read, so a trip
   * saved before this existed must stay parseable.
   *
   * Asked on the composer's first screen and, until this landed, read by
   * nothing — the placebo shape this schema already refuses elsewhere. It is
   * the answer readiness needs: `pace` says how much a day can hold, and only
   * this says how much of that the traveller wanted filled.
   */
  freeTime: freeTimeAppetiteSchema.default('balanced'),
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
  /** MVP V3 — the traveller's own words about food, kept verbatim. Never parsed into `dietaryNeeds`. */
  dietaryNotes: z.string().max(300).optional(),
  /**
   * MVP V3, Stage 14 — "Something else" on any preference question.
   *
   * Keyed by question id, the traveller's own sentence beside the option they
   * chose: "I'm very fit but don't want two huge hiking days back to back" is a
   * real preference that no enum in this file can hold, and forcing it into the
   * nearest one is the product deciding it knows better. Rendered verbatim into
   * the composition brief; never parsed back into a setting.
   */
  preferenceNotes: z.record(z.string().max(60), z.string().max(300)).optional(),
  /**
   * Steps the traveller explicitly handed to us, as opposed to steps they
   * accepted the defaults on.
   *
   * The two look identical in the answer values — a default is a value either
   * way — and they are different statements: "balanced pace" chosen is a
   * preference, "balanced pace" left alone is silence, and "you decide" is an
   * instruction. Anything downstream that wants to know whether it may trade a
   * defaulted answer away can read this; nothing is obliged to.
   *
   * Optional rather than defaulted so that every existing hand-built
   * `QuestionnaireAnswers` literal — the benchmark adapter builds two — keeps
   * compiling. Absent means the affordance predates the answers, which is the
   * same claim as an empty list.
   */
  decideForMe: z.array(questionnaireStepIdSchema).optional(),
  /**
   * THE ADAPTIVE INTERVIEW'S OWN DIMENSIONS (questionnaire v2).
   *
   * Every one of these is defaulted so a trip saved before the interview
   * existed still parses. The defaults are the *silent* values — what a
   * traveller who was never asked looks like — and `provenance` is what
   * separates silence from a choice: a value with no provenance entry was
   * never put to anybody.
   */
  ...interviewAnswerFields(),
});
export type QuestionnaireAnswers = z.infer<typeof questionnaireAnswersSchema>;

/**
 * The v2 answer fields, as a function so the shape is stated once and read by
 * both the answers schema and the profile's `interview` block.
 */
export function interviewAnswerFields() {
  return {
    /** Trade-offs. */
    baseMoveTolerance: baseMoveToleranceSchema.default('move_if_it_saves_time'),
    iconicCrowdStrategy: iconicCrowdStrategySchema.default('go_at_odd_hours'),
    convenienceSpend: convenienceSpendSchema.default('balance'),
    /** Lodging and spend. */
    lodgingStyle: lodgingStyleSchema.default('no_preference'),
    rusticLodgingOk: z.boolean().default(true),
    budgetEnvelope: budgetEnvelopeSchema.optional(),
    /** Remote, water, air, altitude. */
    guideWillingness: guideWillingnessSchema.default('sometimes'),
    privateTransfers: transferWillingnessSchema.default('if_needed'),
    boatsAndFerries: toleranceSchema.default('fine'),
    internalFlights: toleranceSchema.default('fine'),
    remoteComfort: toleranceSchema.default('fine'),
    altitudeComfort: altitudeComfortSchema.default('fine'),
    hikeAppetite: hikeAppetiteSchema.default('half_day'),
    /** Cities. */
    walkingTolerance: walkingToleranceSchema.default('moderate'),
    stairsAndHills: toleranceSchema.default('fine'),
    lateNights: lateNightAppetiteSchema.default('sometimes'),
    dayTripAppetite: dayTripAppetiteSchema.default('one_day_trip'),
    /** Broad destinations. */
    scopeStrategy: coverageStrategySchema.default('best_subset'),
    /** Groups. */
    everyoneEveryDay: z.boolean().default(true),
    groupNotes: z.string().max(500).optional(),
    /** Hard constraints and explicit names. Never inferred from prose. */
    hardConstraints: z.array(hardConstraintSchema).max(24).default([]),
    hardNotes: z.string().max(500).optional(),
    mustInclude: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
    mustAvoid: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
    /** Where each answer came from, keyed by interview question id. */
    provenance: z.record(z.string(), preferenceProvenanceSchema).default({}),
    /** What was asked, decided and skipped, and the screening that shaped it. */
    interview: interviewLogSchema.optional(),
  };
}

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
/**
 * 4 — the adaptive interview: trade-off answers, comfort dimensions, lodging,
 * hard constraints and per-answer provenance ride on the profile so every
 * consumer can tell an explicit "cannot" from an assumed "would rather not".
 */
export const TRAVELER_PROFILE_VERSION = 4 as const;

export const travelerProfileSchema = z.object({
  version: z.literal(TRAVELER_PROFILE_VERSION),
  interests: interestLevelsSchema,
  pace: paceSchema,
  dayStart: dayStartSchema,
  dailyIntensity: dailyIntensitySchema,
  /**
   * How much unscheduled time this traveller asked for. Carried through from
   * the answers rather than re-derived: `pace` says how much a day *can* hold,
   * and only this says how much of that they wanted filled. Defaulted so a
   * profile stored before the field existed stays parseable and reads as the
   * middle answer.
   */
  freeTime: freeTimeAppetiteSchema.default('balanced'),
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
  /**
   * The interview's own dimensions, copied from the answers after
   * normalisation. Read by the composition summary, the review screen and the
   * reconciler; never re-derived downstream.
   */
  interview: z.object({
    baseMoveTolerance: baseMoveToleranceSchema,
    iconicCrowdStrategy: iconicCrowdStrategySchema,
    convenienceSpend: convenienceSpendSchema,
    lodgingStyle: lodgingStyleSchema,
    rusticLodgingOk: z.boolean(),
    budgetEnvelope: budgetEnvelopeSchema.optional(),
    guideWillingness: guideWillingnessSchema,
    privateTransfers: transferWillingnessSchema,
    boatsAndFerries: toleranceSchema,
    internalFlights: toleranceSchema,
    remoteComfort: toleranceSchema,
    altitudeComfort: altitudeComfortSchema,
    hikeAppetite: hikeAppetiteSchema,
    walkingTolerance: walkingToleranceSchema,
    stairsAndHills: toleranceSchema,
    lateNights: lateNightAppetiteSchema,
    dayTripAppetite: dayTripAppetiteSchema,
    scopeStrategy: coverageStrategySchema,
    everyoneEveryDay: z.boolean(),
    groupNotes: z.string().max(500).optional(),
    mustInclude: z.array(z.string()).default([]),
    mustAvoid: z.array(z.string()).default([]),
    /** Minutes at base every day must end by, when the traveller made that hard. */
    mustBeBackByMinute: z.number().int().min(0).max(1440).optional(),
    /** Minutes on foot a day may hold, when a hard ceiling was stated. */
    maxWalkingMinutesPerDay: z.number().int().min(0).max(1440).optional(),
  }),
  /** Typed hard constraints, verbatim from the answers. Filters, never nudges. */
  hard: z.array(hardConstraintSchema).default([]),
  /** Provenance by interview question id — explicit vs assumed, and why. */
  provenance: z.record(z.string(), preferenceProvenanceSchema).default({}),
  /**
   * MVP V3 — "Something else": what the traveller wrote beside a chosen option,
   * keyed by question id and carried verbatim into the composition brief.
   * Optional so every profile stored before this field parses unchanged.
   */
  preferenceNotes: z.record(z.string().max(60), z.string().max(300)).optional(),
  derived: derivedProfileSchema,
});
export type TravelerProfile = z.infer<typeof travelerProfileSchema>;
