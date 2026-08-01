import { z } from 'zod';

/**
 * The questions Sidequest is allowed to interrupt a traveller with.
 *
 * The product promise is that one questionnaire is enough. Every question asked
 * after it is a small breach of that promise, so each one has to earn its place:
 * a question exists only when the answer *changes the plan*, and it carries the
 * reason it was asked so that claim can be checked rather than asserted.
 *
 * Which questions get asked is decided by deterministic rules over the
 * resolution and the profile — never by a model. A model may reword or merge
 * questions for readability; it cannot invent one and it cannot drop one. That
 * asymmetry is the whole design: language is a model's job, and deciding what
 * the system does not know is not.
 */

export const CLARIFICATION_REASONS = [
  /** Several places match the string and they are in different countries. */
  'destination_ambiguous',
  /** A country or large region: which part of it is the trip? */
  'scope_too_broad',
  /** One base or a circuit? Changes clustering, not just wording. */
  'base_strategy_unknown',
  /** Whether a car is on the table at all. */
  'car_availability_unknown',
  /** Ferries and small planes: acceptable, or a hard no? */
  'water_or_air_transfer_acceptance_unknown',
  /** Unpaved and remote roads, where the region has them. */
  'remote_road_comfort_unknown',
  /** Fixed arrival and departure points that constrain the route. */
  'gateway_unknown',
  /** The dates collide with a seasonal closure or a monsoon. */
  'seasonal_conflict',
  /** The named thing is not a place. */
  'query_not_a_place',
] as const;
export const clarificationReasonSchema = z.enum(CLARIFICATION_REASONS);
export type ClarificationReason = z.infer<typeof clarificationReasonSchema>;

export const CLARIFICATION_ANSWER_TYPES = [
  'single_choice',
  'multi_choice',
  'boolean',
  'text',
] as const;
export const clarificationAnswerTypeSchema = z.enum(CLARIFICATION_ANSWER_TYPES);
export type ClarificationAnswerType = z.infer<typeof clarificationAnswerTypeSchema>;

/**
 * Who decided this question should exist.
 *
 * `rule` is the only value that may appear on a required question. A model can
 * hold a `phrasing` credit on a rule-derived question — it wrote the words — but
 * a question whose *existence* is a model's idea is advisory by construction.
 */
export const CLARIFICATION_SOURCES = ['rule', 'rule_with_model_phrasing', 'model_suggested'] as const;
export const clarificationSourceSchema = z.enum(CLARIFICATION_SOURCES);
export type ClarificationSource = z.infer<typeof clarificationSourceSchema>;

export const clarificationOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  /** What choosing this actually does. Shown under the option, not as a tooltip. */
  detail: z.string().min(1).optional(),
});
export type ClarificationOption = z.infer<typeof clarificationOptionSchema>;

export const clarificationQuestionSchema = z
  .object({
    /** Stable across re-derivation, so a stored answer keeps matching its question. */
    id: z.string().min(1),
    reason: clarificationReasonSchema,
    question: z.string().min(1),
    /** Why this changes the trip. Shown to the traveller, not just logged. */
    whyItMatters: z.string().min(1),
    answerType: clarificationAnswerTypeSchema,
    options: z.array(clarificationOptionSchema).default([]),
    required: z.boolean(),
    source: clarificationSourceSchema,
    /** Only shown once another question has a particular answer. */
    dependsOn: z
      .object({ questionId: z.string().min(1), whenAnswerIn: z.array(z.string().min(1)).min(1) })
      .optional(),
  })
  .refine((value) => value.source === 'rule' || value.source === 'rule_with_model_phrasing' || !value.required, {
    message: 'A model-suggested question may not be required',
    path: ['required'],
  })
  .refine(
    (value) =>
      (value.answerType !== 'single_choice' && value.answerType !== 'multi_choice') ||
      value.options.length >= 2,
    { message: 'A choice question needs at least two options', path: ['options'] },
  );
export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;

export const clarificationAnswerSchema = z.object({
  questionId: z.string().min(1),
  /** Always a list, even for single choice. One shape to store and to read. */
  values: z.array(z.string().min(1)),
  answeredAt: z.string().min(1),
});
export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

export const CLARIFICATION_SET_VERSION = 1 as const;

export const clarificationSetSchema = z.object({
  schemaVersion: z.literal(CLARIFICATION_SET_VERSION),
  questions: z.array(clarificationQuestionSchema),
  answers: z.array(clarificationAnswerSchema).default([]),
});
export type ClarificationSet = z.infer<typeof clarificationSetSchema>;

/** Questions whose `dependsOn` condition is satisfied by the answers so far. */
export function visibleQuestions(set: ClarificationSet): ClarificationQuestion[] {
  const answersById = new Map(set.answers.map((answer) => [answer.questionId, answer.values]));
  return set.questions.filter((question) => {
    if (!question.dependsOn) return true;
    const parent = answersById.get(question.dependsOn.questionId);
    if (!parent) return false;
    return parent.some((value) => question.dependsOn?.whenAnswerIn.includes(value));
  });
}

/** Required, visible, and not yet answered. Non-empty means compilation must wait. */
export function unansweredRequired(set: ClarificationSet): ClarificationQuestion[] {
  const answered = new Set(
    set.answers.filter((answer) => answer.values.length > 0).map((answer) => answer.questionId),
  );
  return visibleQuestions(set).filter(
    (question) => question.required && !answered.has(question.id),
  );
}

export function answerFor(set: ClarificationSet, questionId: string): readonly string[] {
  return set.answers.find((answer) => answer.questionId === questionId)?.values ?? [];
}

export function singleAnswer(set: ClarificationSet, questionId: string): string | undefined {
  return answerFor(set, questionId)[0];
}
