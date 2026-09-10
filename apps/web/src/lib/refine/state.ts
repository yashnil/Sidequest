import { z } from 'zod';

/**
 * WHAT A REFINEMENT IS, AS DATA.
 *
 * PRODUCTION LOCK V5 §36–§39. The graph state is deliberately **small and made
 * of references**. It holds the trip's id and version, not the trip; the ids of
 * the days and activities in the blast radius, not their content. A twenty-page
 * rendered itinerary in graph state would be checkpointed on every node
 * transition, and a checkpoint is a database write.
 *
 * Nothing here stores raw model reasoning, secrets or inferred personal
 * characteristics (§50). Trip-scoped facts only: V5 builds no cross-trip
 * personality memory.
 */

/**
 * WHAT THE TRAVELLER IS ASKING FOR.
 *
 * §37. Deliberately wider than a keyword matcher could support, and
 * deliberately not derived from keywords: the model classifies the request
 * alongside proposing the patch, in the same call, because "make Day 4 easier"
 * and "make Day 4 easier by dropping the hike" are the same words and different
 * intents.
 *
 * The two that carry no mutation are load-bearing: `ask_about_trip` and
 * `explain_decision` must be answerable **without touching the trip at all**,
 * and a traveller who asks "why did you leave out X?" and gets a changed
 * itinerary has been badly served.
 */
export const REFINEMENT_INTENTS = [
  'ask_about_trip',
  'explain_decision',
  'change_activity',
  'add_activity',
  'remove_activity',
  'move_activity',
  'change_day',
  'change_pace',
  'change_priority',
  'change_transport',
  'change_stay',
  'change_base',
  'change_route',
  'change_timing',
  'change_booked_fact',
  'change_diet_rule',
  'preserve_x_change_y',
  'try_alternative',
  'major_replan',
] as const;
export const refinementIntentSchema = z.enum(REFINEMENT_INTENTS);
export type RefinementIntent = z.infer<typeof refinementIntentSchema>;

/** True for an intent that answers a question and must not change the trip. */
export function intentIsReadOnly(intent: RefinementIntent): boolean {
  return intent === 'ask_about_trip' || intent === 'explain_decision';
}

/**
 * True for an intent a deterministic handler settles with no model call (§41).
 *
 * Locking, unlocking, removing a named activity, marking something optional and
 * restoring a version are all mechanical. Spending a model call on them would be
 * cost with no judgement in it.
 */
export function intentIsDeterministic(intent: RefinementIntent): boolean {
  return intent === 'remove_activity' || intent === 'move_activity';
}

/* ------------------------------------------------------------------ *
 * Locks and the preservation contract
 * ------------------------------------------------------------------ */

/** What a traveller can pin with "keep this no matter what" (§45). */
export const LOCK_KINDS = ['activity', 'day', 'base', 'lodging', 'booking', 'timing', 'trip_fact'] as const;
export const lockKindSchema = z.enum(LOCK_KINDS);
export type LockKind = z.infer<typeof lockKindSchema>;

export const refinementLockSchema = z.object({
  kind: lockKindSchema,
  /** The activity id, day number, base id or fact name this lock is about. */
  ref: z.string().min(1).max(120),
  /** What the traveller sees. Never invented: this is the thing's own name. */
  label: z.string().max(160),
  lockedAt: z.string().min(1),
});
export type RefinementLock = z.infer<typeof refinementLockSchema>;

/**
 * EVERY REFINEMENT SAYS WHAT IT WILL NOT TOUCH (§39).
 *
 * Explicit rather than implied by the blast radius, and the difference matters:
 * a blast radius is Sidequest's calculation, and a preserve list is a promise.
 * When they disagree the promise wins, and the traveller is told why.
 */
export const preservationContractSchema = z.object({
  /** Held exactly as they are. Activity ids, day numbers, base ids, fact names. */
  preserve: z.array(z.string().max(120)).max(200),
  /** What this refinement is allowed to alter. */
  change: z.array(z.string().max(120)).max(200),
  /** What has to be looked at again afterwards, because something it depended on moved. */
  recheck: z.array(z.string().max(120)).max(200),
});
export type PreservationContract = z.infer<typeof preservationContractSchema>;

/* ------------------------------------------------------------------ *
 * The blast radius
 * ------------------------------------------------------------------ */

/**
 * WHAT THIS EDIT MAY REACH (§38).
 *
 * "Make Day 4 easier" touches day 4's activities, its timing and its travel. It
 * does not touch the hotel, the other days, the booked facts, the diet or
 * anything locked. "I want less driving overall" touches the base sequence,
 * several transfer days and possibly the lodging. A system that cannot tell
 * those apart regenerates the whole trip for a one-day request, which is both
 * expensive and the fastest way to lose work the traveller was happy with.
 */
export const blastRadiusSchema = z.object({
  days: z.array(z.number().int().min(1).max(40)).max(40),
  bases: z.array(z.string().max(120)).max(20),
  /** Trip-level facts: `timing`, `transport`, `pace`, `diet`, `thesis`. */
  facts: z.array(z.string().max(60)).max(20),
  /** True when the request genuinely reaches the whole trip. Rare, and stated rather than assumed. */
  wholeTrip: z.boolean(),
  /** One sentence a traveller could read about why this is the scope. */
  reason: z.string().max(300),
});
export type BlastRadius = z.infer<typeof blastRadiusSchema>;

/* ------------------------------------------------------------------ *
 * The graph state
 * ------------------------------------------------------------------ */

export const refinementStatusSchema = z.enum(['classifying', 'proposing', 'awaiting_answer', 'applying', 'verifying', 'done', 'failed', 'rejected']);
export type RefinementStatus = z.infer<typeof refinementStatusSchema>;

export const clarifyingQuestionSchema = z.object({
  /** One question, high-value, whose answer changes the route (§42). */
  question: z.string().min(1).max(400),
  /** Two to four concrete choices. A question with no options is a chat message. */
  options: z.array(z.string().min(1).max(200)).min(2).max(4),
  /** Why the answer matters, so the traveller can tell a real fork from a fussy one. */
  because: z.string().max(300).optional(),
});
export type ClarifyingQuestion = z.infer<typeof clarifyingQuestionSchema>;

/**
 * The state one refinement carries.
 *
 * Read this as a form being filled in: the request and the versions arrive at
 * the start, the intent and the radius are decided next, the patch is proposed,
 * and the outcome is written last. Everything is either a reference or a short
 * string.
 */
export interface TripRefinementState {
  tripId: string;
  /** The version the patch was computed against. Optimistic concurrency (§48). */
  canonicalTripVersion: number;
  travelerProfileVersion: number;

  /** The traveller's own words, verbatim and untrusted. */
  userRequest: string;

  intent?: RefinementIntent;

  locks: RefinementLock[];

  blastRadius?: BlastRadius;
  contract?: PreservationContract;

  /** Set when the model needs one answer before it can propose anything (§42). */
  pendingQuestion?: ClarifyingQuestion;
  /** The traveller's answer, once given. One extra call is then allowed and no more. */
  answer?: string;

  /** The compact patch, as JSON. Referenced by id; never a whole itinerary. */
  proposedPatch?: unknown;

  /** What the change means has to be measured again (§51). */
  verificationNeeded: string[];

  previousVersion?: number;
  status: RefinementStatus;
  /** Hard-capped. Two is the ceiling, and only with an interrupt in between (§41). */
  modelCallsThisAction: number;
  errors: string[];
}

/** The ceiling on model calls for one refinement action. See §41. */
export const MAX_REFINEMENT_MODEL_CALLS = 2;
