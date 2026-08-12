import { z } from 'zod';
import { interestSchema } from '../schemas/common';
import { DECISION_ANSWER_FIELDS, DECISION_QUESTION_IDS } from './decisions';
import { INTEREST_OFFER_BASES } from './offer';
import { DESTINATION_CLASSES } from './vocabulary';

/**
 * The intake contract a compiled region hands to the questionnaire.
 *
 * Both halves are optional on the region for the same reason every other
 * addition to that model is: an artifact compiled before they existed must
 * still parse and still plan. Absent means "this region has not told us what to
 * ask", and the intake falls back to the whole vocabulary and no follow-ups —
 * which is what it did before, so nothing regresses.
 */
export const destinationClassSchema = z.enum(DESTINATION_CLASSES);
export const interestOfferBasisSchema = z.enum(INTEREST_OFFER_BASES);

export const regionInterestOfferSchema = z.object({
  /** Ordered. The first row is the one this destination has most to offer for. */
  interests: z.array(interestSchema).min(1),
  classes: z.array(destinationClassSchema).default([]),
  basis: interestOfferBasisSchema,
});
export type RegionInterestOffer = z.infer<typeof regionInterestOfferSchema>;

export const decisionQuestionIdSchema = z.enum(DECISION_QUESTION_IDS);
export const decisionAnswerFieldSchema = z.enum(DECISION_ANSWER_FIELDS);

export const regionDecisionQuestionSchema = z.object({
  id: decisionQuestionIdSchema,
  prompt: z.string().min(1),
  /** Never optional: an unexplained destination-triggered question is trivia. */
  why: z.string().min(1),
  /** Never optional either — this is the measurement that justified asking. */
  evidence: z.string().min(1),
  answerField: decisionAnswerFieldSchema,
});
export type RegionDecisionQuestionRecord = z.infer<typeof regionDecisionQuestionSchema>;
