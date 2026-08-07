import { z } from 'zod';
import { coordinatesSchema, placeCategorySchema } from './common';
import { planningRoleSchema } from './region-pack';
import { boardGroupSchema } from './discovery';

/**
 * A BOARD BEFORE ANY OF IT HAS BEEN VERIFIED.
 *
 * `AVAILABILITY_AFTER.finding` has promised "a provisional board — nothing on it
 * is verified yet" since Phase 11, and there has never been one. A traveller
 * watched five phases go by and got their first look at anything real after the
 * research funnel, the router and the planner had all finished — minutes, and
 * every penny of the model budget, before the screen showed a place.
 *
 * This is that board. It is emitted at the one boundary where the pipeline holds
 * real candidates and has not yet bought anything: after food discovery, before
 * `enriching_priority_candidates`.
 *
 * ---
 *
 * THE RULE THAT DECIDES EVERY FIELD BELOW: **a provisional card may not carry a
 * number it has not measured.**
 *
 * It is tempting to reuse `DiscoveryCandidate` and fill the gaps with zeros. That
 * is exactly the Bali defect, and it is worth restating because it is so easy to
 * re-introduce: `travelFromBase` is `{distanceKm: 0, driveMinutes: 0}` from the
 * moment a candidate is built until the route matrix corrects it. Every
 * comparison against zero passes. A day carrying one satisfies every drive
 * limit, every daylight check and every buffer rule — silently.
 *
 * So this is a **different type**, and the difference is what makes the mistake
 * unrepresentable rather than merely discouraged. There is no minutes field on a
 * provisional card. There is no `travelFromBase`. There is no hours field, no
 * cost, no booking requirement, no safety state, no accessibility, no dietary
 * suitability. Not because they are unknown — because at this point in the
 * pipeline **nobody has asked**, and a field with a plausible value in it is
 * indistinguishable from a field with a fact in it.
 *
 * What a provisional card *may* carry is what the source itself said and what
 * pure geometry and arithmetic can derive from it: identity, position, role,
 * cluster, which base it sits nearest, and a preliminary fit computed from the
 * traveller's own stated interests. Every one of those is checkable.
 */

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * How confident the *source* is that this thing exists and is what it says.
 *
 * Deliberately not a verification state. `FactVerificationState` means "we read
 * a page and reconciled what it said", and nothing here has read a page. This is
 * a much weaker claim — how many independent datasets named this record — and it
 * has its own vocabulary so the two can never be confused on screen or in a
 * comparison.
 */
export const SOURCE_PRESENCE = ['single_source', 'multiple_sources', 'linked_identity'] as const;
export const sourcePresenceSchema = z.enum(SOURCE_PRESENCE);
export type SourcePresence = z.infer<typeof sourcePresenceSchema>;

export const SOURCE_PRESENCE_LABELS: Record<SourcePresence, string> = {
  single_source: 'One dataset lists this',
  multiple_sources: 'More than one dataset lists this',
  linked_identity: 'Listed and cross-referenced to an open identifier',
};

/**
 * What still has to be established before this card can be planned around.
 *
 * Rendered on the card. A traveller who can see *what* is missing can judge
 * whether to pin it; one who is told only "unverified" cannot.
 */
export const PENDING_FACTS = [
  'opening_hours',
  'admission_cost',
  'booking_requirement',
  'seasonal_access',
  'travel_time',
  'safety_and_preparation',
] as const;
export const pendingFactSchema = z.enum(PENDING_FACTS);
export type PendingFact = z.infer<typeof pendingFactSchema>;

export const PENDING_FACT_LABELS: Record<PendingFact, string> = {
  opening_hours: 'when it is open',
  admission_cost: 'what it costs',
  booking_requirement: 'whether it needs booking',
  seasonal_access: 'whether it is open on your dates',
  travel_time: 'how long it takes to get there',
  safety_and_preparation: 'what to bring or watch for',
};

export const provisionalCardSchema = z.object({
  /** The same id the final board will use, so a selection survives the transition. */
  placeId: z.string().min(1),
  name: z.string().min(1),
  /** The local form where a source published one. Never translated. */
  localName: z.string().min(1).optional(),
  locality: z.string().min(1),
  /** What kind of thing it is, from the source's own vocabulary through the table. */
  category: placeCategorySchema,
  /** What it is *for* — attraction, side quest, outdoor, market, support, gateway. */
  role: planningRoleSchema,
  /** The source's own leaf category string, verbatim. Shown to explain the role. */
  sourceCategory: z.string().min(1),
  coordinates: coordinatesSchema,

  /** Which geometric cluster it fell into. Pure geometry; no router involved. */
  clusterId: z.string().min(1),
  clusterName: z.string().min(1),
  /**
   * The base this cluster is nearest to, as an identity only.
   *
   * A relationship, never a distance. "This sits in the area you would base at
   * X" is a true statement about grouping; "this is 40 minutes from X" is a
   * statement about a road nobody has measured.
   */
  nearestBaseId: z.string().min(1),
  nearestBaseName: z.string().min(1),

  /**
   * 0–1, from the traveller's own stated interests against this place's own
   * categories. Arithmetic over two lists — no evidence, no route, no model.
   */
  preliminaryFit: z.number().min(0).max(1),
  /** Which of their interests it matched. Rendered as the reason for the score. */
  matchedInterests: z.array(z.string().min(1)).default([]),
  /**
   * Confirmed free-text preferences this card satisfies.
   *
   * Only ever *confirmed* ones: an interpretation the traveller has not accepted
   * must not be visible as a reason a place was suggested.
   */
  matchedPreferences: z.array(z.string().min(1)).default([]),

  presence: sourcePresenceSchema,
  /** Dataset names, for attribution. Never a claim that they corroborate. */
  sources: z.array(z.string().min(1)).default([]),
  /** Set when this record is a feature inside another card on this board. */
  parentPlaceId: z.string().min(1).optional(),
  /** Set when this record was merged with another during deduplication. */
  mergedFromCount: z.number().int().nonnegative().default(0),

  /** The board section, from the same grouping vocabulary the final board uses. */
  group: boardGroupSchema,
  /** What has still to be established. Rendered, never empty in practice. */
  pending: z.array(pendingFactSchema).default([]),

  /**
   * The only value this may ever take.
   *
   * A literal rather than an enum so that a card claiming to be verified is a
   * parse error rather than a rendering bug.
   */
  evidence: z.literal('provisional'),
});
export type ProvisionalCard = z.infer<typeof provisionalCardSchema>;

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export const PROVISIONAL_BOARD_VERSION = 1 as const;

export const provisionalBoardSchema = z.object({
  schemaVersion: z.literal(PROVISIONAL_BOARD_VERSION),
  id: z.string().min(1),
  tripId: z.string().min(1),
  jobId: z.string().min(1),
  /**
   * The scope this was projected from.
   *
   * A board whose fingerprint no longer matches the trip's scope is a board for
   * a different trip — the same staleness rule a compilation job already
   * follows, and the reason a second build cannot adopt the first one's answers.
   */
  scopeFingerprint: z.string().min(1),
  /**
   * A monotonic version within a trip.
   *
   * A provisional board already shown to somebody is never mutated. A rebuild
   * mints a new version and supersedes the old one, which stays readable —
   * because "why did that place disappear" has no answer if the thing it
   * disappeared from was overwritten.
   */
  version: z.number().int().positive(),
  supersedesBoardId: z.string().min(1).optional(),

  cards: z.array(provisionalCardSchema).default([]),
  clusters: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        baseId: z.string().min(1),
        baseName: z.string().min(1),
        cardCount: z.number().int().nonnegative(),
      }),
    )
    .default([]),

  /** The funnel that produced it, so a thin board can be explained rather than excused. */
  counts: z.object({
    discovered: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
    shortlisted: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative(),
    droppedThin: z.number().int().nonnegative(),
    droppedNoAccessRule: z.number().int().nonnegative(),
    /**
     * Refused as transport, services or infrastructure — not as thin.
     *
     * Separate from every other drop count because the two are different
     * statements about a region. "We found little" is about the ground; "we
     * found an airport and eleven drivers" is about what the catalogue is dense
     * in. Collapsing them would let a support-heavy read look like a sparse one.
     */
    droppedUtilityRole: z.number().int().nonnegative().default(0),
  }),
  /** Kept by planning role. What makes a board of forty museums visible as one. */
  byRole: z.array(z.object({ role: planningRoleSchema, count: z.number().int().nonnegative() })).default([]),

  /**
   * Structural assertions, enforced by the schema rather than by a comment.
   *
   * A board that had verified anything, or measured a travel time, could not
   * parse. These are the three claims most likely to creep back in, so they are
   * the three the type refuses.
   */
  estimated: z.literal(true),
  verifiedClaimCount: z.literal(0),
  travelTimesMeasured: z.literal(false),

  builtAt: z.string().min(1),
});
export type ProvisionalBoard = z.infer<typeof provisionalBoardSchema>;

// ---------------------------------------------------------------------------
// What the traveller does with it
// ---------------------------------------------------------------------------

/**
 * Four answers, and deliberately not the three the final board uses.
 *
 * `SELECTION_STATUSES` is `included | maybe | excluded` and the *planner* reads
 * it, so nothing provisional may be added to it. The questions are different
 * too: on a final board the question is "do you want this?", and here it is "is
 * this worth us going and finding out about?". `pinned` is the answer that costs
 * money, which is why it is its own value rather than a stronger `included`.
 */
export const PROVISIONAL_INTENTS = ['interested', 'pinned', 'not_interested', 'hidden'] as const;
export const provisionalIntentSchema = z.enum(PROVISIONAL_INTENTS);
export type ProvisionalIntent = z.infer<typeof provisionalIntentSchema>;

export const PROVISIONAL_INTENT_LABELS: Record<ProvisionalIntent, string> = {
  interested: 'Interested',
  pinned: 'Must do',
  not_interested: 'Not for me',
  hidden: 'Hide it',
};

/**
 * WHICH BOARD A MARK WAS MADE ON.
 *
 * Three states, and the third is the reason this is a type rather than a pair of
 * optional fields. A mark is either made against a board we can name, or made
 * against a board we *cannot* name — and the second of those is a fact about our
 * records rather than a default that can be filled in.
 *
 * A stored mark that predates board identity being recorded genuinely has no
 * board attached. Reading it as version 1 would assert it was made on the first
 * board, which nobody knows and which is exactly the misattribution the version
 * exists to prevent: "you unpinned it" and "the board you pinned it on no longer
 * exists" become the same row again, one layer down.
 */
export const boardRefSchema = z.union([
  z.object({ known: z.literal(false) }),
  z.object({
    known: z.literal(true),
    boardId: z.string().min(1),
    version: z.number().int().positive(),
  }),
]);
export type BoardRef = z.infer<typeof boardRefSchema>;

export const BOARD_UNKNOWN: BoardRef = { known: false };

export function boardRef(
  boardId: string | null | undefined,
  version: number | null | undefined,
): BoardRef {
  if (!boardId || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return BOARD_UNKNOWN;
  }
  return { known: true, boardId, version };
}

/** The label for a board we cannot name. Never an invented version number. */
export const BOARD_UNKNOWN_LABEL = 'board not recorded';

export function boardRefLabel(ref: BoardRef): string {
  return ref.known ? `v${ref.version}` : BOARD_UNKNOWN_LABEL;
}

export const provisionalSelectionSchema = z.object({
  placeId: z.string().min(1),
  intent: provisionalIntentSchema,
  updatedAt: z.string().min(1),
  /**
   * The board this mark was made on, as an identity rather than as a guess.
   *
   * Optional because a row written before marks carried board identity exists
   * and must keep working. Absent reads as `BOARD_UNKNOWN`, which is an explicit
   * state and never version 1.
   */
  boardId: z.string().min(1).optional(),
  boardVersion: z.number().int().positive().optional(),
  /**
   * Monotonic per (trip, place). The compare-and-set token for one card's mark.
   *
   * A stale worker holding version 3 cannot overwrite version 4, and a duplicate
   * delivery of version 3 is a no-op rather than a second event.
   */
  actionVersion: z.number().int().positive().optional(),
});
export type ProvisionalSelection = z.infer<typeof provisionalSelectionSchema>;

/** The board a selection was made on, resolved to the three-state reading. */
export function selectionBoardRef(selection: ProvisionalSelection): BoardRef {
  return boardRef(selection.boardId, selection.boardVersion);
}

// ---------------------------------------------------------------------------
// Every mark anybody ever made, in the order they made it
// ---------------------------------------------------------------------------

/**
 * WHAT A TRAVELLER DID, AS AN EVENT RATHER THAN AS A CURRENT VALUE.
 *
 * A selection row answers "what do you think of this place". It cannot answer
 * the question a reconciliation panel actually gets asked: I changed my mind
 * twice and then the board was rebuilt — which of those did you act on?
 *
 * The four intents plus `cleared`, because taking a mark back is a decision too
 * and a withdrawal that leaves no trace is the same silence the whole
 * reconciliation module exists to close.
 */
export const PROVISIONAL_ACTION_TYPES = [...PROVISIONAL_INTENTS, 'cleared'] as const;
export const provisionalActionTypeSchema = z.enum(PROVISIONAL_ACTION_TYPES);
export type ProvisionalActionType = z.infer<typeof provisionalActionTypeSchema>;

/**
 * Where an action ends up. Total: every action is in exactly one of these.
 *
 * `pending` is a real state and not the absence of one. It says: recorded, and
 * no final board has accounted for it yet — which is the honest reading when
 * nothing has been compiled, when a build failed, and when a build is still
 * running. The defect this closes is a mark recorded *after* reconciliation ran,
 * which used to end in no state at all while the panel counted it among "all N
 * decisions you made".
 */
export const ACTION_RECONCILIATION_STATES = [
  /** Recorded. No final board has accounted for it yet. */
  'pending',
  /** Accounted for, against a named final board. */
  'reconciled',
  /** A later mark on the same card replaced it before anything accounted for it. */
  'superseded',
  /** The traveller took the mark back. There is nothing to account for. */
  'withdrawn',
] as const;
export const actionReconciliationStateSchema = z.enum(ACTION_RECONCILIATION_STATES);
export type ActionReconciliationState = z.infer<typeof actionReconciliationStateSchema>;

/** Whether this action still needs a final board to say something about it. */
export function isTerminalActionState(state: ActionReconciliationState): boolean {
  return state !== 'pending';
}

export const provisionalActionSchema = z.object({
  tripId: z.string().min(1),
  placeId: z.string().min(1),
  /** The board it was made on. Unknown is a state, not a missing value. */
  board: boardRefSchema,
  action: provisionalActionTypeSchema,
  actionVersion: z.number().int().positive(),
  recordedAt: z.string().min(1),
  state: actionReconciliationStateSchema,
  /** The final board that accounted for it, where one has. */
  reconciledRegionId: z.string().min(1).optional(),
  reconciledAt: z.string().min(1).optional(),
});
export type ProvisionalAction = z.infer<typeof provisionalActionSchema>;

/**
 * How many pins may steer the research budget.
 *
 * A ceiling rather than a refusal: pinning a fifteenth place is allowed and
 * simply does not buy a fifteenth research subject. Without it, "pin everything"
 * is a button that spends the whole model budget on one traveller's curiosity —
 * and the budget is what stops a compilation costing more than it is worth.
 */
export const MAX_PINS_THAT_STEER_RESEARCH = 12;

/**
 * The traveller's answers, as the research funnel reads them.
 *
 * A *priority signal*, never a promise. A pinned place still has to survive
 * evidence, access and routing — pinning cannot make a closed museum open.
 */
export interface ResearchPriorityHints {
  pinned: readonly string[];
  interested: readonly string[];
  suppressed: readonly string[];
}

export function priorityHintsFrom(
  selections: readonly ProvisionalSelection[],
): ResearchPriorityHints {
  const pinned: string[] = [];
  const interested: string[] = [];
  const suppressed: string[] = [];
  for (const selection of selections) {
    if (selection.intent === 'pinned') pinned.push(selection.placeId);
    else if (selection.intent === 'interested') interested.push(selection.placeId);
    else suppressed.push(selection.placeId);
  }
  return {
    pinned: pinned.slice(0, MAX_PINS_THAT_STEER_RESEARCH),
    interested,
    suppressed,
  };
}
