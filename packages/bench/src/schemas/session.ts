import { z } from 'zod';

/**
 * THE SESSION, THE BLINDING, AND THE HUMAN JUDGEMENT.
 *
 * A session is one head-to-head: one shared request, two runs, two neutral
 * plans, one randomised presentation, one locked review, one reveal, and up to
 * three correction rounds per system.
 *
 * The two draws below are the experimental design, and keeping them separate is
 * not fussiness. If "Plan A" were always shown first, or if one system were
 * always "Plan A", then position and identity would be perfectly confounded and
 * no first-position bias could ever be estimated — including by a later analysis
 * over many more sessions. Two independent draws cost nothing now and are
 * impossible to recover later.
 */

export const BENCHMARK_SESSION_VERSION = 1 as const;

export const PRODUCING_SYSTEMS = ['sidequest', 'baseline'] as const;
export const producingSystemSchema = z.enum(PRODUCING_SYSTEMS);
export type ProducingSystem = z.infer<typeof producingSystemSchema>;

export const PLAN_LABELS = ['A', 'B'] as const;
export const planLabelSchema = z.enum(PLAN_LABELS);
export type PlanLabel = z.infer<typeof planLabelSchema>;

/**
 * Drawn once, at session creation, and a stored fact thereafter.
 *
 * No later read, render, refresh, retry, correction round or aggregation may
 * re-draw it. That is what makes a reload byte-stable — and a layout that
 * changed on refresh would itself be a way to learn the mapping.
 */
export const blindAssignmentSchema = z
  .object({
    schemaVersion: z.literal(BENCHMARK_SESSION_VERSION),
    /** Draw 1: which system wears which label. Both stored, neither derived. */
    labelASystem: producingSystemSchema,
    labelBSystem: producingSystemSchema,
    /** Draw 2, independent of draw 1: which label is rendered first. */
    firstLabel: planLabelSchema,
    /** `seeded` marks an offline fixture session so it is never pooled with a live one. */
    source: z.enum(['system', 'seeded']),
    seed: z.string().min(1).nullable().default(null),
    /** The raw uniform draws, kept so the coin can be audited later. */
    drawLabel: z.number().min(0).lt(1),
    drawOrder: z.number().min(0).lt(1),
    assignedAt: z.string().datetime(),
  })
  .refine((assignment) => assignment.labelASystem !== assignment.labelBSystem, {
    message: 'The two labels must carry different systems',
    path: ['labelBSystem'],
  })
  .refine(
    (assignment) => (assignment.source === 'seeded') === (assignment.seed !== null),
    { message: 'A seeded assignment carries its seed; a live one does not', path: ['seed'] },
  );
export type BlindAssignment = z.infer<typeof blindAssignmentSchema>;

export function systemForLabel(assignment: BlindAssignment, label: PlanLabel): ProducingSystem {
  return label === 'A' ? assignment.labelASystem : assignment.labelBSystem;
}

export function labelForSystem(assignment: BlindAssignment, system: ProducingSystem): PlanLabel {
  return assignment.labelASystem === system ? 'A' : 'B';
}

/** The order the panels are rendered in. Read from the row, never recomputed. */
export function displayOrder(assignment: BlindAssignment): readonly [PlanLabel, PlanLabel] {
  return assignment.firstLabel === 'A' ? ['A', 'B'] : ['B', 'A'];
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */

/**
 * `review_locked` and `revealed` are irreversible, and they are enforced in SQL
 * rather than here: a disabled button and an application-level check are both
 * bypassed by a second tab and a direct POST.
 */
export const SESSION_STATES = [
  'created',
  /**
   * The world has been bought and the follow-up questions put to the traveller;
   * nothing is planning yet.
   *
   * A separate state rather than a flag on `running`, because it is the only
   * point in a comparison where the harness is waiting for a *person*. Every
   * latency figure that separates machine time from human time is measured
   * across it, and a state machine that could not name it would have had nowhere
   * honest to start that clock.
   */
  'preparing',
  'awaiting_answers',
  'running',
  'ready_for_review',
  'review_locked',
  'revealed',
  'corrections',
  'complete',
  'abandoned',
] as const;
export const sessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const IRREVERSIBLE_TRANSITIONS: readonly (readonly [SessionState, SessionState])[] = [
  ['ready_for_review', 'review_locked'],
  ['review_locked', 'revealed'],
];

/* ------------------------------------------------------------------ *
 * The rating instrument
 * ------------------------------------------------------------------ */

/**
 * Fifteen dimensions, asked once per plan.
 *
 * Every scale runs 1..7 with **7 always better**, and no scale relies on the
 * reviewer noticing that. The last item used to ask "how much work would this
 * need", anchored from a great deal of work up to none — a question about *more*
 * answered on a scale where higher meant *less*, at item fifteen of fifteen,
 * which is exactly where an instrument collects its mis-keys and exactly the bug
 * a single reviewer will never catch statistically. It now asks about readiness,
 * so the stem and the anchors run the same way.
 *
 * The wording is about the trip on the page, never about how it was made. No
 * question may contain fast, slow, generated, computed, verified, automatic,
 * system, model or algorithm.
 */
export const RATING_DIMENSIONS = [
  { id: 'overall_quality', question: 'Overall, how good is this trip?', low: 'Poor', high: 'Excellent' },
  { id: 'would_take', question: 'How likely would you be to actually take this trip as written?', low: 'Would not', high: 'Would take it as it is' },
  { id: 'personal_fit', question: 'How well does this trip match what you asked for?', low: 'Not at all', high: 'Completely' },
  { id: 'discovery_quality', question: 'How good are the places it chose?', low: 'Poor', high: 'Excellent' },
  { id: 'excitement', question: 'How much do you want to go on this trip?', low: 'Not at all', high: 'A great deal' },
  { id: 'pacing', question: 'How well judged is the amount packed into each day?', low: 'Badly judged', high: 'Well judged' },
  { id: 'logistical_realism', question: 'How workable does each day look in practice — timings, distances, order?', low: 'Not workable', high: 'Very workable' },
  { id: 'food_placement', question: 'How sensible are the meals — where they are and when?', low: 'Not sensible', high: 'Very sensible' },
  { id: 'transport_realism', question: 'How believable is the getting-around — the modes, and the times between places?', low: 'Not believable', high: 'Very believable' },
  { id: 'clarity', question: 'How easy is this to read and follow?', low: 'Hard', high: 'Easy' },
  /*
   * Asked as confidence in what the plan states, not as willingness to act on
   * it unchecked.
   *
   * The old wording made 7 mean "I would rely on this without checking any of
   * it", which is a disposition rather than a judgement about the plan — and the
   * disposition a careful reviewer will never report, however good the plan is.
   * It also quietly rewarded a plan for being trusted blindly, which is not the
   * property the benchmark is trying to detect.
   */
  { id: 'trust', question: 'How confident are you that what this says is correct?', low: 'Not at all confident', high: 'Completely confident' },
  { id: 'flexibility', question: 'How easy would it be to change this to suit you?', low: 'Hard', high: 'Easy' },
  { id: 'alternatives', question: 'How well does it offer other options when something will not work?', low: 'Badly', high: 'Well' },
  { id: 'handling_unknowns', question: 'When something is uncertain or unavailable, how well does it deal with that?', low: 'Badly', high: 'Well' },
  /*
   * Stated as readiness, so the stem and the anchors run the same way.
   *
   * "How much work would this need" asks about an amount of work, and the scale
   * beneath it ran from a great deal of work up to none — so the reviewer read a
   * question about *more* and answered on a scale where higher meant *less*. It
   * is the fifteenth item of fifteen, which is exactly where an instrument
   * collects its mis-keys, and a single reviewer would never catch it
   * statistically. Asking about readiness leaves 7 as the better end without
   * anybody having to invert anything in their head.
   */
  { id: 'effort_to_fix', question: 'How ready to use is this as written?', low: 'Needs a great deal of work', high: 'Ready as written' },
] as const;

export const RATING_DIMENSION_IDS = RATING_DIMENSIONS.map((d) => d.id);
export const ratingDimensionIdSchema = z.enum(
  RATING_DIMENSION_IDS as unknown as [string, ...string[]],
);
export type RatingDimensionId = (typeof RATING_DIMENSIONS)[number]['id'];

export const ratingScoreSchema = z.number().int().min(1).max(7);

/**
 * A plan that failed outright is not rated.
 *
 * Forcing seven-point judgements about a plan that does not exist produces noise
 * that is indistinguishable from a real low score. `not_rateable` carries the
 * reason instead, and the forced choices are still asked — a failure is a
 * perfectly legitimate reason to prefer the other plan.
 */
export const planRatingsSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('rated'),
    label: planLabelSchema,
    scores: z.record(ratingDimensionIdSchema, ratingScoreSchema),
  }),
  z.object({
    state: z.literal('not_rateable'),
    label: planLabelSchema,
    reason: z.string().min(1).max(300),
  }),
]);
export type PlanRatings = z.infer<typeof planRatingsSchema>;

/**
 * The forced choices.
 *
 * `tie` and `cannot_judge` are stored distinctly and never merged. A tie is a
 * judgement; "cannot judge" is a failure of the instrument, and pooling them
 * would hide the second inside the first.
 */
export const FORCED_CHOICE_QUESTIONS = [
  { id: 'would_book', question: 'Which trip would you book?', primary: true },
  { id: 'understands_you', question: 'Which one better understands what you asked for?', primary: false },
  { id: 'more_realistic', question: 'Which one feels more realistic?', primary: false },
  { id: 'more_interesting', question: 'Which one has the more interesting places?', primary: false },
  { id: 'fewer_changes', question: 'Which one would need fewer changes?', primary: false },
  { id: 'trust_more', question: 'Which one do you trust more?', primary: false },
] as const;

export const FORCED_CHOICE_IDS = FORCED_CHOICE_QUESTIONS.map((q) => q.id);
export const forcedChoiceIdSchema = z.enum(
  FORCED_CHOICE_IDS as unknown as [string, ...string[]],
);
export type ForcedChoiceId = (typeof FORCED_CHOICE_QUESTIONS)[number]['id'];

export const FORCED_CHOICE_OPTIONS = ['A', 'B', 'tie', 'cannot_judge'] as const;
export const forcedChoiceOptionSchema = z.enum(FORCED_CHOICE_OPTIONS);
export type ForcedChoiceOption = z.infer<typeof forcedChoiceOptionSchema>;

/** The question whose answer is the benchmark's primary metric. */
export const PRIMARY_FORCED_CHOICE: ForcedChoiceId = 'would_book';

export const blindReviewSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_SESSION_VERSION),
  sessionId: z.string().min(1),
  reviewer: z.string().min(1),
  ratings: z.array(planRatingsSchema).length(2),
  choices: z.record(forcedChoiceIdSchema, forcedChoiceOptionSchema),
  /** Required, on the primary choice only. Six required boxes produce six shrugs. */
  explanation: z.string().min(20).max(2000),
  /** How long each panel was open, so a first-position effect stays estimable. */
  panelTimeMs: z.record(planLabelSchema, z.number().int().min(0)).optional(),
  submittedAt: z.string().datetime(),
});
export type BlindReview = z.infer<typeof blindReviewSchema>;

/**
 * Asked only after the reveal, and never answered by anything but a person.
 *
 * Nulls here are real: an unanswered post-reveal question is stored as `null`
 * with the session still complete, because inventing an answer to "would you
 * wait this long" would be inventing the finding this whole phase exists to
 * collect.
 */
export const postRevealAnswersSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_SESSION_VERSION),
  sessionId: z.string().min(1),
  slowerPlanJustifiesWait: z.enum(['yes', 'no', 'depends']).nullable().default(null),
  wouldWaitForTheBetterPlan: z.enum(['yes', 'no', 'only_for_some_trips']).nullable().default(null),
  wouldUseForARealTrip: z.enum(['A', 'B', 'either', 'neither']).nullable().default(null),
  wouldPayMoreFor: z.enum(['A', 'B', 'no', 'unsure']).nullable().default(null),
  /**
   * The manual blinding audit, and worth more than the automated one: the token
   * scan proves the words are absent, and cannot prove the reviewer did not
   * infer identity from length, structure or tone.
   */
  suspectedIdentityBecause: z.string().max(2000).default(''),
  answeredAt: z.string().datetime().nullable().default(null),
});
export type PostRevealAnswers = z.infer<typeof postRevealAnswersSchema>;

/* ------------------------------------------------------------------ *
 * Corrections
 * ------------------------------------------------------------------ */

export const MAX_CORRECTION_ROUNDS = 3;

export const CORRECTION_OUTCOMES = ['applied', 'partial', 'failed', 'refused'] as const;
export const correctionOutcomeSchema = z.enum(CORRECTION_OUTCOMES);

export const correctionRoundSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_SESSION_VERSION),
  sessionId: z.string().min(1),
  system: producingSystemSchema,
  round: z.number().int().min(1).max(MAX_CORRECTION_ROUNDS),
  /** The plan this round revised. Also the compare-and-set token. */
  supersedesPlanId: z.string().min(1),
  resultPlanId: z.string().min(1).nullable().default(null),
  /** The same words go to both systems; the hash is what proves it. */
  instructionText: z.string().min(1).max(2000),
  instructionHash: z.string().min(1),
  outcome: correctionOutcomeSchema,
  /** Constraints that held before this round and no longer do. Validator output. */
  regressedFindingCodes: z.array(z.string().min(1)).default([]),
  newCriticalCount: z.number().int().min(0).nullable().default(null),
  newMajorCount: z.number().int().min(0).nullable().default(null),
  satisfaction: ratingScoreSchema.nullable().default(null),
  abandoned: z.boolean().default(false),
  abandonReason: z.string().max(500).nullable().default(null),
  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
});
export type CorrectionRound = z.infer<typeof correctionRoundSchema>;

/* ------------------------------------------------------------------ *
 * The question ledger
 * ------------------------------------------------------------------ */

/**
 * Every question either system asked, why, who answered it, and how long it
 * took.
 *
 * `transferredTo` is what makes "do not let one system win because it silently
 * received more traveller information" auditable rather than aspirational: any
 * answer given to one system and made available to the other is a row that says
 * so.
 *
 * `elapsedMs` is persisted rather than derived on read, because a question
 * auto-answered from the shared request legitimately took zero milliseconds
 * while an unanswered one has no elapsed time at all — and computing it from two
 * timestamps would collapse those into the same number.
 */
export const QUESTION_STAGES = [
  'shared_request',
  'preliminary_scan',
  'clarification',
  'questionnaire',
] as const;
export const questionStageSchema = z.enum(QUESTION_STAGES);

export const benchmarkQuestionSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_SESSION_VERSION),
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  /** Persisted, never rendered before the reveal. */
  askedBy: producingSystemSchema,
  stage: questionStageSchema,
  sequence: z.number().int().min(0),
  questionText: z.string().min(1).max(500),
  /** Required. A question nobody can justify should not have been asked. */
  whyItMatters: z.string().min(1).max(500),
  answerType: z.enum(['single_choice', 'multi_choice', 'boolean', 'text', 'number']),
  options: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).default([]),
  required: z.boolean().default(false),
  presentedAt: z.string().datetime(),
  answeredAt: z.string().datetime().nullable().default(null),
  elapsedMs: z.number().int().min(0).nullable().default(null),
  answerValues: z.array(z.string()).nullable().default(null),
  /** Whether the shared request already answered it, or a human had to. */
  answeredFrom: z.enum(['shared_request', 'traveller', 'unanswered']),
  /** Set when this answer was made available to the system that did not ask. */
  transferredTo: producingSystemSchema.nullable().default(null),
});
export type BenchmarkQuestion = z.infer<typeof benchmarkQuestionSchema>;
