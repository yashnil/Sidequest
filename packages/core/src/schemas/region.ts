import { z } from 'zod';
import { coordinatesSchema, regionalExpansionSchema } from './common';
import { regionDecisionQuestionSchema, regionInterestOfferSchema } from '../interests/schema';

/**
 * The sentences only this region can write.
 *
 * Copy naming a highway, a lake or a town used to live in the questionnaire's
 * step definitions — inside a package that is meant to work anywhere. That made
 * "How far from Mammoth Lakes?" a property of the engine rather than of the
 * Eastern Sierra, and a second region would have inherited it.
 *
 * It lives here instead, and it is optional: a compiled region nobody has
 * written prose for gets generic wording rather than a placeholder that names
 * the wrong valley.
 */
export const regionQuestionnaireCopySchema = z.object({
  /** How the region is named mid-sentence: "the Eastern Sierra". */
  proseName: z.string().min(1),
  /** Label for keeping to the destination itself. */
  destinationOnlyLabel: z.string().min(1),
  /** What each extra radius actually opens up here. */
  expansionExamples: z.partialRecord(regionalExpansionSchema, z.string().min(1)).default({}),
  /**
   * Radii that are reachable without a car **here**.
   *
   * A rule, not a preference. It used to be hard-coded — a non-driver was capped
   * at thirty minutes everywhere — which is true of a valley served by one
   * trolley and false of anywhere with a rail network.
   */
  carFreeExpansions: z.array(regionalExpansionSchema).min(1),
  regionStepIntro: z.string().min(1),
  discoveryIntro: z.string().min(1),
  transportIntro: z.string().min(1),
});
export type RegionQuestionnaireCopy = z.infer<typeof regionQuestionnaireCopySchema>;

/**
 * A region is the unit Sidequest actually plans against. "Mammoth Lakes" is a
 * town; the trip is the Eastern Sierra. The base/satellite split is what lets
 * the product answer "what nearby is worth the detour" instead of only "what is
 * inside the place you typed".
 */
export const regionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The place the traveller typed, and where they will sleep. */
  baseName: z.string().min(1),
  baseCoordinates: coordinatesSchema,
  summary: z.string().min(1),
  /** Outer bound of what this region can ever include. */
  maxRadiusKm: z.number().min(1),
  /** Strings a user might type that resolve to this region. */
  aliases: z.array(z.string().min(1)).default([]),
  /**
   * Why getting around this region works the way it does.
   *
   * A region fact, kept on the region. The strategy builder used to assert that
   * *any* destination "is a corridor with everything hanging off one highway",
   * which happens to be true of the Eastern Sierra and false of Tokyo.
   */
  transportSummary: z.string().min(1),
  /** What a traveller loses here by not driving. Region-specific, so it lives here. */
  noVehicleSummary: z.string().min(1),
  /** Why roads here close, when they do. Absent where nothing closes seasonally. */
  seasonalRoadSummary: z.string().min(1).optional(),
  /** Region-owned wording for the questionnaire. Absent falls back to generic. */
  questionnaireCopy: regionQuestionnaireCopySchema.optional(),
  /**
   * Which interests this region can honestly be graded on, and the follow-ups
   * its own geography justifies asking.
   *
   * The counterpart to `questionnaireCopy` for the two things that are not
   * wording: *which questions exist* and *which extra ones are worth an
   * interruption*. Both are derived from what the compilation actually found —
   * see `interests/offer.ts` and `interests/decisions.ts` — so a region with no
   * thermal ground in it never asks about hot springs, and a region nobody can
   * cross without a car asks about one.
   *
   * Optional, like everything added to this model after it shipped: an artifact
   * compiled before these existed parses and plans exactly as it did, and the
   * intake falls back to the whole vocabulary with no follow-ups.
   */
  interestOffer: regionInterestOfferSchema.optional(),
  decisionQuestions: z.array(regionDecisionQuestionSchema).max(3).optional(),
});
export type Region = z.infer<typeof regionSchema>;

export const WORTH_DETOUR_LABELS = [
  'core_to_trip',
  'definitely_worth_it',
  'worth_it_if_you_like_this',
  'only_if_nearby',
  'too_far_for_this_trip',
  'skip_for_your_style',
  /**
   * We could not establish the journey, so we will not pass a verdict on it.
   *
   * Added in Phase 15D beside `DetourClass.unknown`. Before it, a candidate
   * whose route nobody could measure was labelled `too_far_for_this_trip` on the
   * card — a confident sentence about the place, produced by a provider that
   * did not answer. The traveller had no way to tell the two apart, and the
   * remedy for each is entirely different.
   */
  'reach_unverified',
] as const;
export const worthDetourLabelSchema = z.enum(WORTH_DETOUR_LABELS);
export type WorthDetourLabel = z.infer<typeof worthDetourLabelSchema>;

export const WORTH_DETOUR_COPY: Record<WorthDetourLabel, string> = {
  core_to_trip: 'Core to your trip',
  definitely_worth_it: 'Worth the detour',
  worth_it_if_you_like_this: 'Worth it if this is your thing',
  only_if_nearby: 'Only if you are already nearby',
  too_far_for_this_trip: 'Too far for this trip',
  skip_for_your_style: 'Not your style',
  reach_unverified: 'We could not check the journey',
};
