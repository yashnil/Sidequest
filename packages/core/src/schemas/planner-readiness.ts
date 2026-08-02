import { z } from 'zod';
import { unscheduledReasonCodeSchema } from './itinerary';

/**
 * WHY NOTHING COULD BE PLANNED, IN A SHAPE SOMETHING CAN ACT ON.
 *
 * A plan with no stops is not a plan. It was being returned as one — five dated
 * days, a transport strategy, a food plan, `ready_with_cautions`, and a single
 * warning buried among seven others saying "nothing could be scheduled from your
 * selections". A live Bali compilation produced exactly that, and the traveller
 * would have been shown an itinerary consisting of five empty days.
 *
 * So a zero-stop outcome is now a *refusal*, and a refusal owes an explanation
 * that is better than prose. This is that explanation: the funnel as counts, the
 * rejections grouped by their own reason codes, which of them dominated, and —
 * the part a traveller can actually use — which changes would plausibly help and
 * which would not.
 *
 * Two rules keep it honest.
 *
 * **Every count is measured, never inferred.** `feasible` is the number that
 * survived access, hours and daylight, not a number derived from the others.
 *
 * **A remedy is only offered when the blockers support it.** Telling somebody to
 * widen their dates when the problem is a two-hour drive to everything sends
 * them to change the wrong thing, which is worse than saying nothing.
 */

export const PLANNER_READINESS_VERSION = 1 as const;

/**
 * The changes that can move a blocked plan, as a closed set.
 *
 * Closed because each one maps to a specific control the traveller has, and a
 * free-text suggestion nobody can click is advice rather than a remedy.
 */
export const PLANNER_REMEDIES = [
  /** Nothing is wrong with the inputs; a provider failed and may not next time. */
  'retry',
  /** The ground is too small or too far from where the plan is anchored. */
  'adjust_scope',
  /** The daily travel limits, or whether a car is available at all. */
  'adjust_transport',
  /** Facts we could not establish; a rebuild may find them. */
  'refresh_evidence',
  /** Auto-pick chose badly, or chose things that cannot work together. */
  'choose_manually',
  /** There genuinely is not enough time in the trip. */
  'more_days',
] as const;
export const plannerRemedySchema = z.enum(PLANNER_REMEDIES);
export type PlannerRemedy = z.infer<typeof plannerRemedySchema>;

export const PLANNER_REMEDY_LABELS: Record<PlannerRemedy, string> = {
  retry: 'Try building again',
  adjust_scope: 'Change the region or where you are based',
  adjust_transport: 'Change your travel limits',
  refresh_evidence: 'Rebuild the region to look for more evidence',
  choose_manually: 'Pick the stops yourself',
  more_days: 'Give the trip more days',
};

export const plannerRejectionSchema = z.object({
  reasonCode: unscheduledReasonCodeSchema,
  count: z.number().int().min(1),
  /** A couple of names, so the number has something concrete behind it. */
  examples: z.array(z.string().min(1)).max(3).default([]),
});
export type PlannerRejection = z.infer<typeof plannerRejectionSchema>;

export const plannerRemedyAssessmentSchema = z.object({
  remedy: plannerRemedySchema,
  /**
   * Whether this would plausibly change the outcome.
   *
   * Both values are useful and the `false` ones are the more useful half: a
   * traveller who has been told that more days will not help stops spending
   * their afternoon adding days.
   */
  likelyToHelp: z.boolean(),
  /** One sentence naming what it would change, in the traveller's terms. */
  detail: z.string().min(1),
});
export type PlannerRemedyAssessment = z.infer<typeof plannerRemedyAssessmentSchema>;

export const plannerReadinessSchema = z.object({
  schemaVersion: z.literal(PLANNER_READINESS_VERSION),
  /** Everything on the board, before the traveller's selections were applied. */
  consideredCount: z.number().int().min(0),
  /** Marked include or maybe. What the planner was actually asked to place. */
  selectedCount: z.number().int().min(0),
  /** Selected, and with a travel-time row. Below this nothing can be measured. */
  eligibleCount: z.number().int().min(0),
  /** Eligible, and reachable and open on at least one day of the trip. */
  feasibleCount: z.number().int().min(0),
  /** Actually placed on a day. Zero is what makes this a refusal. */
  scheduledCount: z.number().int().min(0),
  /** Every rejection, grouped by its own reason code, largest first. */
  rejections: z.array(plannerRejectionSchema).default([]),
  /**
   * The one or two codes that account for most of the loss.
   *
   * Separate from `rejections` because a list of eight codes is data and the
   * dominant one is the answer. A traveller reads the answer.
   */
  dominantBlockers: z.array(plannerRejectionSchema).max(3).default([]),
  remedies: z.array(plannerRemedyAssessmentSchema).default([]),
  /** One sentence a person could read aloud. Never a percentage. */
  summary: z.string().min(1),
});
export type PlannerReadiness = z.infer<typeof plannerReadinessSchema>;

/** The remedies worth showing, in the order a traveller should try them. */
export function suggestedRemedies(readiness: PlannerReadiness): PlannerRemedyAssessment[] {
  return readiness.remedies.filter((entry) => entry.likelyToHelp);
}

/** The ones explicitly ruled out, so a traveller stops trying them. */
export function ruledOutRemedies(readiness: PlannerReadiness): PlannerRemedyAssessment[] {
  return readiness.remedies.filter((entry) => !entry.likelyToHelp);
}
