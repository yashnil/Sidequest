'use server';

import { revalidatePath } from 'next/cache';
import {
  autoSelect,
  countTripDays,
  selectionStatusSchema,
  type SelectionStatus,
} from '@sidequest/core';
import {
  clearSelection,
  getProfile,
  getSelections,
  getTrip,
  replaceAutoSelections,
  setSelection,
} from '@/lib/db/repository';
import { boardFor, resolveTripRegion } from '@/lib/region';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface AutoPickResult extends ActionResult {
  /**
   * The full selection state after the write. A server revalidation cannot
   * update the board's client state on its own, so the action hands back what it
   * actually stored rather than leaving the UI to guess.
   */
  selections?: Record<string, SelectionStatus>;
  notes?: string[];
}

export async function setSelectionAction(
  tripId: string,
  placeId: string,
  status: SelectionStatus | null,
): Promise<ActionResult> {
  try {
    if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
    if (status === null) {
      clearSelection(tripId, placeId);
    } else {
      setSelection(tripId, placeId, selectionStatusSchema.parse(status), 'user');
    }
    revalidatePath(`/trips/${tripId}/discover`);
    return { ok: true };
  } catch (error) {
    console.error('Failed to save selection', error);
    return { ok: false, error: 'That choice did not save. We have put the card back how it was.' };
  }
}

/**
 * Recomputes the balanced starting set. Anything the traveller decided by hand is
 * left alone — auto-pick proposes, it does not overrule.
 */
export async function autoPickAction(tripId: string): Promise<AutoPickResult> {
  try {
    const trip = getTrip(tripId);
    if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

    const profile = getProfile(tripId);
    if (!profile) {
      return { ok: false, error: 'Finish the questionnaire first so we know what to pick for.' };
    }

    const resolved = resolveTripRegion(trip);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const board = boardFor(trip, profile, resolved.context);
    const selection = autoSelect({
      candidates: board.candidates,
      profile,
      tripDays: countTripDays(trip.basics.startDate, trip.basics.endDate),
    });

    replaceAutoSelections(tripId, selection.selectedIds);
    revalidatePath(`/trips/${tripId}/discover`);

    const selections: Record<string, SelectionStatus> = {};
    for (const stored of getSelections(tripId)) selections[stored.placeId] = stored.status;
    return { ok: true, selections, notes: selection.notes };
  } catch (error) {
    console.error('Failed to auto-pick', error);
    return { ok: false, error: 'We could not build a selection just then. Try again.' };
  }
}
