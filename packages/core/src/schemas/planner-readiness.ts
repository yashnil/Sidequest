import { z } from 'zod';
import { unscheduledReasonCodeSchema } from './itinerary';

/**
 * WHETHER A PLAN COULD BE BUILT, AND WHY NOT, IN A SHAPE SOMETHING CAN ACT ON.
 *
 * A plan with no stops is not a plan. It was being returned as one — five dated
 * days, a transport strategy, a food plan, `ready_with_cautions`, and a single
 * warning buried among seven others saying "nothing could be scheduled from your
 * selections". A live Bali compilation produced exactly that, and the traveller
 * would have been shown an itinerary consisting of five empty days.
 *
 * So a zero-stop outcome is a *refusal*, and a refusal owes an explanation that
 * is better than prose. This is that explanation: the funnel as counts, the
 * rejections grouped by their own reason codes, which of them dominated, and —
 * the part a traveller can actually use — which changes would plausibly help and
 * which would not.
 *
 * It is now produced on **every** attempt rather than only on a refusal, because
 * "this plan holds four of the nine things you picked" is worth saying out loud,
 * and because a readiness record that only exists on failure cannot be compared
 * across builds.
 *
 * Three rules keep it honest.
 *
 * **Every count is measured, never inferred.** `feasibleCount` is the number
 * that survived access, hours and daylight, not a number derived from the
 * others. Where a count could not be measured it is absent, not zero — the two
 * mean opposite things and a zero would read as a finding.
 *
 * **A remedy is only offered when the blockers support it.** Telling somebody to
 * widen their dates when the problem is a two-hour drive to everything sends
 * them to change the wrong thing, which is worse than saying nothing.
 *
 * **The level is a rule, not a score.** There is no percentage anywhere in this
 * file, because a percentage invites optimising a number instead of reading the
 * blocker underneath it.
 */

export const PLANNER_READINESS_VERSION = 2 as const;

/**
 * What the planner is entitled to do, given what survived.
 *
 * Four states, and the fourth is separate for a reason a traveller can feel: an
 * evidence gap and a provider outage want different words and different buttons.
 * "We looked and the answer is no" is not the same as "we could not look".
 */
export const PLANNER_READINESS_LEVELS = [
  /** Enough was placed that the plan stands on its own. */
  'ready',
  /** Something was placed, and less than was asked for. Usable, and honest. */
  'partial',
  /** Nothing could be placed. The itinerary is withheld. */
  'insufficient',
  /** Nothing could be measured, because something upstream did not answer. */
  'infrastructure_failure',
] as const;
export const plannerReadinessLevelSchema = z.enum(PLANNER_READINESS_LEVELS);
export type PlannerReadinessLevel = z.infer<typeof plannerReadinessLevelSchema>;

export const PLANNER_READINESS_LEVEL_LABELS: Record<PlannerReadinessLevel, string> = {
  ready: 'Enough to plan on',
  partial: 'Partly plannable',
  insufficient: 'Not enough to plan on',
  infrastructure_failure: 'We could not check',
};

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

/**
 * What the region supplied, before the traveller touched it.
 *
 * Optional as a block, because the planner is handed candidates and does not
 * always know how many the compiler started with. Absent means "not measured
 * here"; a zero would read as "nothing was found", which is a different and much
 * more alarming claim.
 */
export const plannerSupplySchema = z.object({
  /** Everything the inventory produced, before quality filtering. */
  discovered: z.number().int().min(0).optional(),
  /** What survived quality filtering and reached the board. */
  retained: z.number().int().min(0).optional(),
  /** How many had their official sources looked up. */
  researched: z.number().int().min(0).optional(),
});
export type PlannerSupply = z.infer<typeof plannerSupplySchema>;

/**
 * Where the funnel lost things, as measured counts at each gate.
 *
 * Each one is a different question, and collapsing them would lose the answer
 * that matters: "nothing has a travel time" and "everything is shut" both end at
 * zero and want completely different responses.
 */
export const plannerFunnelSchema = z.object({
  /** Everything on the board, before the traveller's selections were applied. */
  considered: z.number().int().min(0),
  /** Marked include or maybe. What the planner was actually asked to place. */
  selected: z.number().int().min(0),
  /** Selected, and with a travel-time row. Below this nothing can be measured. */
  eligible: z.number().int().min(0),
  /** Eligible, and with a legal way in on at least one day. */
  accessFeasible: z.number().int().min(0),
  /** Access-feasible, and open long enough on at least one day. */
  hoursFeasible: z.number().int().min(0),
  /** Everything that survived every gate, including weather and daylight. */
  feasible: z.number().int().min(0),
  /** Actually placed on a day. Zero is what makes this a refusal. */
  scheduled: z.number().int().min(0),
});
export type PlannerFunnel = z.infer<typeof plannerFunnelSchema>;

/** What could not be established, as opposed to what was established as "no". */
export const plannerUnresolvedSchema = z.object({
  /** Pairs the router refused. Above zero, some legs are guesses we will not make. */
  routePairs: z.number().int().min(0).default(0),
  /** Selected places whose opening hours nobody publishes. */
  criticalHours: z.number().int().min(0).default(0),
  /** Selected places with no established way in. */
  accessRequirements: z.number().int().min(0).default(0),
  /** Closures that overlap the trip and remove a place outright. */
  blockingClosures: z.number().int().min(0).default(0),
  /** Counters the compilation ran out of. Names a cost ceiling, not a gap. */
  exhaustedBudgets: z.array(z.string().min(1)).max(8).default([]),
});
export type PlannerUnresolved = z.infer<typeof plannerUnresolvedSchema>;

export const plannerReadinessSchema = z.object({
  schemaVersion: z.literal(PLANNER_READINESS_VERSION),
  level: plannerReadinessLevelSchema,
  funnel: plannerFunnelSchema,
  supply: plannerSupplySchema.prefault({}),
  unresolved: plannerUnresolvedSchema.prefault({}),
  daysRequested: z.number().int().min(0),
  /** Days that ended up with every meal the traveller asked for named. */
  daysWithFullMeals: z.number().int().min(0).default(0),
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

/**
 * Whether an itinerary may be shown at all.
 *
 * The one rule that must never be softened for convenience: a plan with nothing
 * in it is withheld. It is a function rather than a comparison at each call site
 * so there is exactly one place the rule lives, and so a test can name it.
 */
export function mayShowItinerary(readiness: PlannerReadiness): boolean {
  return readiness.funnel.scheduled > 0;
}
