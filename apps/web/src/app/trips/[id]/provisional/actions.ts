'use server';

import { revalidatePath } from 'next/cache';
import { provisionalIntentSchema, type ProvisionalIntent } from '@sidequest/core';
import {
  clearProvisionalSelection,
  latestBoardIdentity,
  reconcilePendingActions,
  setProvisionalSelection,
} from '@/lib/db/provisional-repository';
import { getTrip } from '@/lib/db/repository';

/**
 * What somebody said about a card they cannot yet be told the hours of.
 *
 * Written immediately, on its own table, in its own vocabulary. Not
 * `discovery_selections`: the planner reads that enum, its three values answer a
 * different question ("do you want this?" rather than "is this worth us going
 * and finding out about?"), and a provisional pick is a research priority
 * signal rather than a decision.
 *
 * Two things happen here that did not before, and both close the same defect: a
 * mark made after the build finished used to end in no state at all — neither
 * reconciled nor recorded as outstanding — while the panel counted it among "all
 * N decisions you made".
 */
export async function setProvisionalIntentAction(
  tripId: string,
  placeId: string,
  intent: ProvisionalIntent | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip.' };

  try {
    const now = new Date();
    /*
     * The board the card was rendered from, stamped onto the mark.
     *
     * A mark is a decision about a board somebody was looking at. Without the
     * identity, "you unpinned it" and "the board you pinned it on no longer
     * exists" are the same row, and a removal gets blamed on a board the
     * traveller never saw.
     *
     * Read here rather than passed from the client because the client is not a
     * source of truth about which board is current — and because the one case
     * this reading gets wrong (a rebuild between render and click) resolves to
     * the newer board, which is the safer of the two wrong answers: the mark is
     * attributed to a board that exists rather than to one that has been
     * superseded.
     */
    const board = latestBoardIdentity(tripId);
    const options = board.known
      ? { board: { id: board.boardId, version: board.version } }
      : { board: null };

    if (intent === null) clearProvisionalSelection(tripId, placeId, now, options);
    else {
      setProvisionalSelection(
        tripId,
        placeId,
        provisionalIntentSchema.parse(intent),
        now,
        options,
      );
    }

    /*
     * And reconciled now, if there is anything to reconcile against.
     *
     * A no-op when nothing has been compiled — the mark stays `pending`, which is
     * an explicit and queryable state rather than a silence — and idempotent when
     * the account is already current. This is what makes a late mark a mark that
     * gets an answer rather than one that quietly never does.
     */
    reconcilePendingActions({ tripId, now });
  } catch (error) {
    console.error('Could not record a provisional choice', { tripId, placeId, error });
    return { ok: false, error: 'We could not save that just then. Try again.' };
  }

  revalidatePath(`/trips/${tripId}/provisional`);
  revalidatePath(`/trips/${tripId}/discover`);
  return { ok: true };
}
