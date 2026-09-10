'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getActiveJob } from '@/lib/db/compiler-repository';
import { deleteTrip, getTrip } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * THE ONE THING A TRIP LIST HAS TO BE ABLE TO DO AND COULD NOT.
 *
 * There was no way to remove a trip. Sixty rows accumulated in the live
 * database — half of them abandoned experiments against the same destination —
 * and the homepage's answer was to show the first eight by creation date and
 * hide the rest, which is how the only trip in the product with a finished plan
 * came to be invisible on the screen that lists trips.
 *
 * Capping a list is not a substitute for being able to clear it. This is the
 * missing half.
 *
 * What is left here is the *policy*: who may be deleted and when. The statement
 * itself is `deleteTrip` in `lib/db/repository`, where every other statement
 * against `trips` lives — an action that reaches for `getDb()` directly is one
 * more place a schema change has to be chased to.
 */

const tripIdSchema = z.string().uuid();

export interface DeleteTripResult {
  ok: boolean;
  error?: string;
}

export async function deleteTripAction(tripId: string): Promise<DeleteTripResult> {
  if (!tripIdSchema.safeParse(tripId).success) {
    return { ok: false, error: 'We could not find that trip.' };
  }

  const trip = getTrip(tripId);
  if (!trip) {
    // Already gone. Reporting success is the honest answer to "make this not
    // exist" — and a second click on a row somebody has just removed must not
    // produce an error about a trip they can no longer see.
    return { ok: true };
  }

  /**
   * ONLY THE BROWSER THAT MADE IT MAY REMOVE IT.
   *
   * The homepage used to list every trip in the database as "your trips" with
   * this button on each row, so the destructive half of that defect is here.
   * Scoping the *list* is not enough on its own: the action takes an id, and an
   * id is all it ever took.
   *
   * A trip with no owner belongs to nobody and is refused too. It is not
   * listed anywhere, so nothing offers this button for it; a call naming one is
   * a caller who found the id somewhere else, and "you may delete the rows
   * nobody can claim" is not a rule worth having.
   *
   * `mint: false` deliberately: minting a session here would hand the caller an
   * identity and then compare it against the trip's, which always fails — but
   * it would also mean a delete request created a cookie, and a request that is
   * about to be refused should leave nothing behind.
   */
  /* V6 §50 — one boundary: the account when the trip has one, the browser cookie otherwise. */
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  /**
   * NOT WHILE SOMETHING IS WRITING TO IT.
   *
   * A compilation holds the job row open and writes stages, a work plan and
   * eventually an artifact against this trip id. Deleting underneath it leaves
   * the worker inserting rows whose foreign key no longer resolves — which
   * `foreign_keys = ON` turns into a thrown constraint in a background process
   * nobody is watching. Refused rather than raced; stopping the build is
   * already a control on the build screen.
   */
  if (getActiveJob(tripId)) {
    return {
      ok: false,
      error:
        'That trip is being researched right now. Stop the build first, then you can remove it.',
    };
  }

  try {
    deleteTrip(tripId);
  } catch (error) {
    console.error('Failed to delete trip', { tripId, error });
    return { ok: false, error: 'We could not remove that just then. Nothing was lost — try again.' };
  }

  revalidatePath('/');
  return { ok: true };
}
