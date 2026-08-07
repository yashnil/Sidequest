'use server';

import { revalidatePath } from 'next/cache';
import {
  autoSelect,
  countTripDays,
  selectionStatusSchema,
  type SelectionStatus,
} from '@sidequest/core';
import {
  clearFoodSelection,
  clearSelection,
  getProfile,
  getSelections,
  getTrip,
  replaceAutoSelections,
  setFoodSelection,
  setSelection,
} from '@/lib/db/repository';
import { boardFor, resolveTripRegion } from '@/lib/region';
import {
  acknowledgeReconciliationEntry,
  getReconciliation,
} from '@/lib/db/provisional-repository';
import { fetchWeatherSnapshot } from '@/lib/weather/refresh';

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
 * The traveller's opinion about a place to eat.
 *
 * Deliberately its own action rather than a third status on `setSelectionAction`:
 * a venue is not a place, has only two useful answers, and must never reach the
 * code that counts activity slots. `null` clears the opinion altogether, which
 * is a third state and a different thing from saying no.
 */
export async function setFoodSelectionAction(
  tripId: string,
  venueId: string,
  status: 'included' | 'excluded' | null,
): Promise<ActionResult> {
  try {
    if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
    if (status === null) {
      clearFoodSelection(tripId, venueId);
    } else {
      setFoodSelection(tripId, venueId, status, 'user');
    }
    revalidatePath(`/trips/${tripId}/discover`);
    return { ok: true };
  } catch (error) {
    console.error('Failed to save a food choice', error);
    return { ok: false, error: 'That choice did not save. We have put it back how it was.' };
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

    const resolved = await resolveTripRegion(trip);
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

/**
 * THE ONLY PLACE IN THE PRODUCT THAT ASKS ABOUT THE WEATHER.
 *
 * A server action, invoked by a button, with its outcome written down. That is
 * the whole of it: rendering `/discover` used to fetch a forecast because
 * resolving a region did, so a page load, a refresh, a back button and every
 * browser-test navigation each made an outbound request. Nothing on the page
 * suggested reload was an action with a cost, because nothing suggested it was
 * an action at all.
 *
 * Three properties this has and a render path cannot:
 *
 *   - It is *asked for*. Somebody pressed something.
 *   - Its status is persisted, including a failure. A refresh that fails and
 *     leaves no trace is a button that appears to do nothing.
 *   - It never mutates the itinerary or the compiled region. A newer forecast
 *     changes what a badge says; it does not silently re-plan somebody's trip
 *     underneath them. Rebuilding is a separate, explicit act.
 */
export async function refreshWeatherAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const { compiled, dates } = resolved.context;
  const outcome = await fetchWeatherSnapshot({
    tripId,
    compiled,
    dates,
    scopeKey: resolved.context.weatherScopeKey,
  });

  revalidatePath(`/trips/${tripId}/discover`);
  revalidatePath(`/trips/${tripId}/itinerary`);

  return outcome.ok
    ? { ok: true }
    : {
        ok: false,
        error: 'The weather source did not answer just then. Nothing on your plan changed.',
      };
}

/**
 * The form entry point for the refresh.
 *
 * A `<form action={…}>` needs a handler that takes `FormData` and returns
 * nothing, and the action above returns a result the caller can read. Wrapping
 * rather than changing the signature keeps the useful return value for
 * client-side callers, and keeps the page free of an inline `'use server'`
 * function — which is easy to write and easy to stop noticing is a network
 * boundary.
 */
export async function refreshWeatherFormAction(tripId: string): Promise<void> {
  await refreshWeatherAction(tripId);
}

/**
 * "I have seen that this was removed."
 *
 * The acknowledgement is stored against the *compiled region* as well as the
 * place, so a rebuild cannot inherit the last build's acknowledgements and
 * suppress its own bad news. Nothing about the plan changes: this records that
 * somebody was told, which is the only claim the product is entitled to make
 * about a pinned place it could not deliver.
 */
export async function acknowledgeRemovalAction(
  tripId: string,
  placeId: string,
): Promise<ActionResult> {
  try {
    const reconciliation = getReconciliation(tripId);
    if (!reconciliation) {
      return { ok: false, error: 'There is nothing to acknowledge on this trip any more.' };
    }
    const entry = reconciliation.entries.find((candidate) => candidate.placeId === placeId);
    if (!entry) {
      return { ok: false, error: 'We could not find that entry in the account.' };
    }

    /*
     * The write reports whether it matched, and the action believes it.
     *
     * It used to return nothing at all and issue an unconditional
     * `UPDATE … WHERE trip_id = ?`, so acknowledging an entry whose account had
     * since been replaced wrote no row and still reported success — leaving the
     * removal marked unread underneath a confirmation saying it had been read.
     * That is the exact failure the acknowledgement exists to prevent, produced
     * by the acknowledgement itself.
     */
    const recorded = acknowledgeReconciliationEntry(
      tripId,
      reconciliation.compiledRegionId,
      { placeId, outcome: entry.outcome, acknowledgedAt: new Date().toISOString() },
    );
    if (!recorded) {
      return {
        ok: false,
        error:
          'We could not record that just then — the account on file has moved on. Reload the page to see the current one.',
      };
    }
    revalidatePath(`/trips/${tripId}/discover`);
    return { ok: true };
  } catch (error) {
    console.error('Failed to record an acknowledgement', error);
    return { ok: false, error: 'That did not save. The entry is still marked as unread.' };
  }
}
