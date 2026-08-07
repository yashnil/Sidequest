import {
  EMPTY_BASIS,
  MAX_ALTERNATIVES,
  RECONCILE_OUTCOME_COPY,
  RECONCILIATION_VERSION,
  UNNAMED_ENTRY_COPY,
  detailExplains,
  type BoardReconciliation,
  type ReconcileAlternative,
  type ReconciledSelection,
  type ReconcileOutcome,
  type ReconcileReasonCode,
  type ReconciliationBasis,
  type RemovalStage,
} from '../schemas/reconciliation';
import {
  selectionBoardRef,
  type ProvisionalBoard,
  type ProvisionalCard,
  type ProvisionalSelection,
} from '../schemas/provisional';

/**
 * WHAT HAPPENED TO THE THINGS YOU PICKED.
 *
 * Pure, total and deterministic. No database, no clock of its own, no I/O:
 * everything it needs arrives in the input, so the repository can run it inside
 * one synchronous transaction and get a genuinely atomic reconciliation pass.
 * Every provisional selection gets exactly one outcome — there is no path
 * through this function that leaves a choice unaccounted for, which is the whole
 * point.
 *
 * The failure it exists to prevent is a specific one, and it was present in two
 * places at once.
 *
 * `resolveCandidates` in the planner iterated the *board* and looked each
 * selection up inside it, so a selection whose place was no longer on the board
 * was never visited. It appeared in neither the scheduled list nor the rejected
 * one, despite that function's own comment promising that "there is no third
 * outcome where it quietly disappears".
 *
 * And this function had the same shape of hole: it iterated the selections but
 * `continue`d past any whose card was missing from the board, on the reasoning
 * that "there is nothing truthful to say about a card nobody can be shown". That
 * reasoning is wrong twice. A board is superseded on every rebuild, so the case
 * is routine rather than exotic. And the traveller is not asking to be shown a
 * card — they are asking what became of a decision they made, and "we no longer
 * have a record of it" is a truthful answer where silence is not.
 *
 * Both are closed. Every selection in, exactly one entry out, whatever the
 * intent and whatever the board holds:
 *
 *   - `interested`, `pinned`, `not_interested` and `hidden` all produce an
 *     entry. A "not for me" that was quietly forgotten is how a traveller ends
 *     up asking why we keep suggesting the same place.
 *   - A card absent from this board version produces an entry naming that fact
 *     rather than nothing at all.
 *   - A card absent from *everything* produces `disappeared_unexpectedly`, which
 *     is the pipeline admitting it lost track of something.
 *
 * ---
 *
 * THREE RULES ABOUT WHAT AN ENTRY MAY CLAIM, each of which was broken.
 *
 * **A board version is a fact about the mark, not about the check.** It comes
 * off the selection — the board the traveller was looking at when they decided —
 * and never off `board.version`, which is the board we happen to be reconciling
 * against. A mark whose board we cannot name says so; it does not say "1".
 *
 * **The outcome sentence is never displaced.** `explanation` is always the copy
 * for the outcome. A stage's own sentence sits *beside* it, and only when that
 * stage is the one that caused the removal.
 *
 * **A named survivor has to have survived.** `replaced_duplicate` asserted one
 * without ever checking, which is vacuous while deduplication runs before the
 * cut and becomes a lie the day it does not.
 */

export interface ReconcileInput {
  /** The board being reconciled against. Not necessarily the one marks were made on. */
  board: ProvisionalBoard;
  selections: readonly ProvisionalSelection[];
  /** Place ids that survived onto the final, compiled board. */
  finalPlaceIds: ReadonlySet<string>;
  /**
   * What the run concluded: removals with their causes, duplicate resolutions,
   * and the cards whose verified details moved.
   *
   * One structure rather than three loose arguments, because it is one thing —
   * the findings of the run that produced the final board — and because it is
   * persisted whole, so a mark made after the build can be reconciled against
   * the same conclusions the build reached.
   */
  basis?: ReconciliationBasis;
  /**
   * Names for identities this board version does not carry.
   *
   * Consulted for a selection whose card is missing here — typically because it
   * was made against a superseded board — and for a duplicate's survivor. The
   * caller supplies the final board's names; a lookup that still fails renders
   * as `UNNAMED_ENTRY_COPY` rather than as a raw identity, because a panel that
   * prints `place/osm/way/128374` where a name goes has told the traveller
   * nothing and looks broken doing it.
   */
  namesById?: ReadonlyMap<string, string>;
  compiledRegionId: string;
  /** Monotonic per trip. The compare-and-set token the store writes under. */
  reconciliationVersion?: number;
  now: Date;
}

export function reconcileBoard(input: ReconcileInput): BoardReconciliation {
  const basis = input.basis ?? EMPTY_BASIS;
  const cardsById = new Map(input.board.cards.map((card) => [card.placeId, card]));
  const removalsById = new Map(basis.removals.map((removal) => [removal.placeId, removal]));
  const survivorById = new Map(
    basis.duplicates.map((entry) => [entry.placeId, entry.survivorPlaceId]),
  );
  const changed = new Set(basis.changedPlaceIds);
  const entries: ReconciledSelection[] = [];

  for (const selection of input.selections) {
    const card = cardsById.get(selection.placeId);
    const survived = input.finalPlaceIds.has(selection.placeId);
    const replacedBy = survivorById.get(selection.placeId);
    /*
     * The assertion `replaced_duplicate` used to make without checking. A
     * survivor that is not on the final board did not survive, and saying "we
     * kept one of them" about a place that is not in the plan is the kind of
     * claim that costs more trust than the removal it was covering.
     */
    const survivorKept = replacedBy !== undefined && input.finalPlaceIds.has(replacedBy);

    const resolution = resolve({
      card,
      survived,
      replacedBy,
      survivorKept,
      changed: changed.has(selection.placeId),
      removal: removalsById.get(selection.placeId),
      selection,
    });

    /*
     * Alternatives are offered for a *pinned* loss only, and they are offered
     * rather than applied.
     *
     * Choosing a replacement on somebody's behalf while they are not looking is
     * how a plan comes to hold a place they never agreed to. And offering one
     * for every removal would bury the pinned ones, which are the only losses
     * that cost the traveller something they had actually decided.
     *
     * A card we no longer hold gets none: the suggestion is built from the
     * removed card's own cluster and role, and we have neither.
     */
    const pinnedLoss = selection.intent === 'pinned' && resolution.lost;
    const alternatives: ReconcileAlternative[] =
      pinnedLoss && card ? alternativesFor(card, input) : [];

    /*
     * The board the mark was made *on*. Absent is an answer, and it is a
     * different answer from version 1.
     */
    const madeOn = selectionBoardRef(selection);
    const replacementName = replacedBy
      ? (cardsById.get(replacedBy)?.name ?? input.namesById?.get(replacedBy))
      : undefined;

    entries.push({
      placeId: selection.placeId,
      name: nameFor(selection.placeId, card, input.namesById),
      ...(madeOn.known
        ? { provisionalBoardId: madeOn.boardId, provisionalBoardVersion: madeOn.version }
        : {}),
      intent: selection.intent,
      outcome: resolution.outcome,
      reasonCode: resolution.reasonCode,
      /*
       * Always the outcome copy. What happened is not the optional half.
       */
      explanation: RECONCILE_OUTCOME_COPY[resolution.outcome],
      ...(resolution.detail
        ? { detail: resolution.detail.text, detailStage: resolution.detail.stage }
        : {}),
      /*
       * The identity that actually reached the plan. Only ever a real one: for a
       * duplicate whose survivor is on the board it is the survivor, for a
       * retention it is the same id, and for every loss it is absent rather than
       * echoing back the id that did not make it.
       */
      ...(survivorKept && replacedBy
        ? { finalPlaceId: replacedBy }
        : survived
          ? { finalPlaceId: selection.placeId }
          : {}),
      ...(survivorKept && replacedBy ? { replacedByPlaceId: replacedBy } : {}),
      ...(survivorKept && replacementName ? { replacedByName: replacementName } : {}),
      alternatives,
      /*
       * Acknowledgement is demanded for a pinned loss and for nothing else.
       *
       * Demanding it everywhere would make it furniture, and a checkbox nobody
       * reads is worth less than no checkbox: it converts "we told them" from a
       * fact into a formality. A pinned place is the one case where the
       * traveller made a decision and did not get it.
       */
      acknowledgementRequired: pinnedLoss,
      /* Kept for readers written against version 1. Same first alternative. */
      ...(alternatives[0]
        ? { suggestedPlaceId: alternatives[0].placeId, suggestedName: alternatives[0].name }
        : {}),
    });
  }

  /*
   * What arrived that was not on the provisional board.
   *
   * The research funnel does not only subtract: a place that had no access rule
   * at the cut can acquire one, and duplicate resolution can promote a record
   * that was previously merged away. Reported so the final board's difference
   * from the provisional one is explained in both directions.
   */
  const provisionalIds = new Set(input.board.cards.map((card) => card.placeId));
  const added = [...input.finalPlaceIds].filter((id) => !provisionalIds.has(id)).sort();

  return {
    schemaVersion: RECONCILIATION_VERSION,
    tripId: input.board.tripId,
    provisionalBoardId: input.board.id,
    provisionalBoardVersion: input.board.version,
    compiledRegionId: input.compiledRegionId,
    reconciliationVersion: input.reconciliationVersion ?? 1,
    entries: entries.sort(
      (a, b) => rank(a.outcome) - rank(b.outcome) || a.name.localeCompare(b.name),
    ),
    addedPlaceIds: added,
    basis,
    reconciledAt: input.now.toISOString(),
  };
}

/**
 * What a row is called.
 *
 * The board first, then whatever the caller could resolve, then a sentence. The
 * identity itself is never a name: it is not readable, it explains nothing, and
 * a traveller who sees one concludes the panel is broken — which, at that point,
 * is a fair reading.
 */
function nameFor(
  placeId: string,
  card: ProvisionalCard | undefined,
  namesById: ReadonlyMap<string, string> | undefined,
): string {
  return card?.name ?? namesById?.get(placeId) ?? UNNAMED_ENTRY_COPY;
}

interface Resolution {
  outcome: ReconcileOutcome;
  reasonCode: ReconcileReasonCode;
  detail?: { text: string; stage: RemovalStage };
  /** Whether the traveller ended up without the thing they chose. */
  lost: boolean;
}

/**
 * The single decision table. Total by construction: every branch returns.
 *
 * Written as one function rather than as conditionals inside the loop so that
 * "is there a path with no outcome" is answerable by reading fifty lines, which
 * is precisely the question the old version got wrong.
 */
function resolve(context: {
  card: ProvisionalCard | undefined;
  survived: boolean;
  replacedBy: string | undefined;
  survivorKept: boolean;
  changed: boolean;
  removal: { outcome: ReconcileOutcome; detail?: string; detailStage?: RemovalStage } | undefined;
  selection: ProvisionalSelection;
}): Resolution {
  const { card, survived, replacedBy, survivorKept, changed, removal } = context;

  if (replacedBy !== undefined) {
    return survivorKept
      ? { outcome: 'replaced_duplicate', reasonCode: 'duplicate_resolved', lost: false }
      : {
          outcome: 'removed_duplicate_survivor_lost',
          reasonCode: 'duplicate_survivor_lost',
          lost: true,
        };
  }

  if (survived) {
    return changed
      ? { outcome: 'retained_with_changes', reasonCode: 'details_changed', lost: false }
      : { outcome: 'retained', reasonCode: 'survived', lost: false };
  }

  if (removal) {
    return {
      outcome: removal.outcome,
      reasonCode: reasonCodeFor(removal.outcome),
      /*
       * A sentence is attached only when the stage that produced it is the
       * stage that caused this outcome. An unattributed sentence, or one from
       * a stage that did not cause this, is a specific claim about the wrong
       * thing — worse than the generic sentence it would sit next to.
       */
      ...(removal.detail && detailExplains(removal.outcome, removal.detailStage)
        ? { detail: { text: removal.detail, stage: removal.detailStage! } }
        : {}),
      lost: true,
    };
  }

  /*
   * No card here, nothing on the final board, and no recorded removal.
   *
   * This is the branch that used to be a `continue`. Two shapes reach it and
   * they get different answers, because they are different failures: a choice
   * made on a board version we have superseded is explicable, and a choice we
   * cannot place at all is not.
   */
  if (!card) {
    return {
      outcome: 'disappeared_unexpectedly',
      reasonCode: 'not_present_on_this_board',
      lost: true,
    };
  }

  /*
   * On the board, off the final artifact, and nothing said why. The honest
   * default: it names the outcome without inventing the cause.
   */
  return {
    outcome: 'removed_insufficient_support',
    reasonCode: 'insufficient_published_support',
    lost: true,
  };
}

/**
 * Outcome to cause, for the outcomes a caller hands us pre-decided.
 *
 * Exhaustive over the enum rather than a `switch` with a `default`, so that
 * adding an outcome without deciding what causes it does not compile.
 */
const REASON_FOR_OUTCOME: Record<ReconcileOutcome, ReconcileReasonCode> = {
  retained: 'survived',
  retained_with_changes: 'details_changed',
  replaced_duplicate: 'duplicate_resolved',
  removed_duplicate_survivor_lost: 'duplicate_survivor_lost',
  removed_closed: 'closed_on_trip_dates',
  removed_safety_blocked: 'safety_advisory_blocks',
  removed_unreachable: 'no_route_measured',
  removed_redundant: 'contained_by_another_place',
  removed_insufficient_support: 'insufficient_published_support',
  removed_access_conflict: 'access_mode_conflict',
  removed_stale_record: 'source_record_invalid',
  removed_identity_invalid: 'identity_unresolvable',
  unresolved_budget: 'budget_exhausted',
  unresolved_infrastructure: 'provider_unavailable',
  unresolved_verification_failed: 'sources_conflict',
  disappeared_unexpectedly: 'unexplained',
};

function reasonCodeFor(outcome: ReconcileOutcome): ReconcileReasonCode {
  return REASON_FOR_OUTCOME[outcome];
}

/**
 * The best surviving stand-ins: same area, same role, highest preliminary fit.
 *
 * Same area because a replacement in another valley is a different trip; same
 * role because a market does not stand in for a hike. Deterministic to the last
 * tiebreak, so the suggestion does not move between two renders.
 *
 * Anything the traveller has already spoken about is excluded, in either
 * direction: offering back something they said no to is worse than offering
 * nothing, and offering something they already chose is not an offer.
 */
function alternativesFor(
  removed: ProvisionalCard,
  input: ReconcileInput,
): ReconcileAlternative[] {
  const spokenFor = new Set(input.selections.map((selection) => selection.placeId));
  return input.board.cards
    .filter(
      (card) =>
        card.placeId !== removed.placeId &&
        card.clusterId === removed.clusterId &&
        card.role === removed.role &&
        input.finalPlaceIds.has(card.placeId) &&
        !spokenFor.has(card.placeId),
    )
    .sort((a, b) => b.preliminaryFit - a.preliminaryFit || a.placeId.localeCompare(b.placeId))
    .slice(0, MAX_ALTERNATIVES)
    .map((card) => ({ placeId: card.placeId, name: card.name, basis: 'same_area_same_role' }));
}

/**
 * The order somebody reads in: our failures first, then removals, then the rest.
 *
 * `disappeared_unexpectedly` sorts above everything because it is the one
 * outcome that is a statement about us. Burying it under a list of closed
 * museums would be the polite version of the silence it replaced.
 */
function rank(outcome: ReconcileOutcome): number {
  if (outcome === 'disappeared_unexpectedly') return 0;
  if (outcome.startsWith('removed_')) return 1;
  if (outcome.startsWith('unresolved_')) return 2;
  if (outcome === 'replaced_duplicate') return 3;
  if (outcome === 'retained_with_changes') return 4;
  return 5;
}
