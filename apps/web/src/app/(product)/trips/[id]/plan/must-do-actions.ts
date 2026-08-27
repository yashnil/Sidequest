'use server';

import { revalidatePath } from 'next/cache';
import { mustDoDecisionKindSchema, type MustDoDecision } from '@sidequest/core';
import { getIntent, saveComposerAnswers } from '@/lib/db/compiler-repository';
import { getSelections, getTrip, setSelection } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { compiledRegionFor } from '@/lib/region';

/**
 * A DECISION ONLY A PERSON CAN TAKE, STORED WHERE IT WILL SURVIVE.
 *
 * Written onto the composer rather than into a table of its own, and that is
 * the point rather than a shortcut: the composer column is the trip's record of
 * *what a person said*, and a decision about a request has to live beside the
 * text that produced the request. It survives a refresh, a rebuild and a
 * recompilation, because a recompiled artifact reads the same list back.
 *
 * Two kinds and no more. "Leave it out" and "I meant that one" are the only two
 * things a traveller can honestly say about a request the system could not
 * settle. There is deliberately no "try again": the second look has already run,
 * and a button that repeats a search whose answer is known is a button that
 * lies.
 *
 * The composer answers are re-read and re-written whole, so a decision cannot
 * race a composer edit into a partial row.
 */
export async function decideMustDoAction(
  tripId: string,
  requestId: string,
  kind: string,
  chosenId?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
    const refusal = await tripAccessRefusal(tripId);
    if (refusal) return { ok: false, error: refusal };

    const parsedKind = mustDoDecisionKindSchema.safeParse(kind);
    if (!parsedKind.success) return { ok: false, error: 'That is not something we can record.' };
    if (parsedKind.data === 'chose' && !chosenId) {
      return { ok: false, error: 'We did not catch which one you meant.' };
    }

    const intent = getIntent(tripId);
    const answers = intent?.composer;
    if (!answers) {
      return { ok: false, error: 'There is nothing saved for this trip to attach that to.' };
    }

    const decision: MustDoDecision = {
      requestId,
      kind: parsedKind.data,
      ...(chosenId ? { chosenId } : {}),
      decidedAt: new Date().toISOString(),
    };
    /*
     * Last one wins, and the earlier one goes. A traveller who withdraws
     * something and then picks a match has changed their mind, and keeping both
     * rows would leave the reader to guess which is current.
     */
    const kept = (answers.mustDoDecisions ?? []).filter((entry) => entry.requestId !== requestId);
    saveComposerAnswers(tripId, {
      ...answers,
      mustDoDecisions: [...kept, decision].slice(-24),
      updatedAt: new Date().toISOString(),
    });

    /**
     * A CHOICE IS ALSO A PICK.
     *
     * The runner marks a `covered` must-do as the traveller's own selection so
     * that `must_include_unscheduled` — an error the reviser refuses to fix away
     * — applies to it. A choice taken *after* the build has to do the same thing
     * or the guarantee has a hole exactly where the traveller did the most work:
     * they settled an ambiguity, and the plan quietly did not carry it.
     *
     * Same two rules as the runner: only a place this region actually holds, and
     * never over the top of something they have already said about it.
     */
    if (parsedKind.data === 'chose' && chosenId) {
      try {
        const region = compiledRegionFor(tripId);
        const known = region?.places.some((place) => place.id === chosenId) ?? false;
        const already = getSelections(tripId).some((entry) => entry.placeId === chosenId);
        if (known && !already) setSelection(tripId, chosenId, 'included', 'user');
      } catch (error) {
        console.error('Could not mark a chosen must-do as included', { tripId, error });
      }
    }

    revalidatePath(`/trips/${tripId}/plan`);
    revalidatePath(`/trips/${tripId}/discover`);
    return { ok: true };
  } catch (error) {
    console.error('Failed to record a must-do decision', error);
    return { ok: false, error: 'That did not save. Nothing has changed.' };
  }
}
