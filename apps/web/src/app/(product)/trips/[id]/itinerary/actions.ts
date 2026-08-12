'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Itinerary } from '@sidequest/core';
import {
  easeDay,
  removeStopFromDay,
  swapAlternativesForStop,
  swapStopOnDay,
  type ItineraryEditResult,
  type PlannerInput,
} from '@sidequest/planner';
import { type BuildResult, buildItinerary, plannerInputForTrip } from '@/lib/planning/build';
import {
  clearItineraryLock,
  getItinerary,
  getTrip,
  saveItinerary,
  setItineraryLock,
  setSelection,
} from '@/lib/db/repository';

export type { BuildResult } from '@/lib/planning/build';

/**
 * Builds and stores the itinerary, then navigates to it.
 *
 * The work moved to `@/lib/planning/build` so that exactly one sequence turns a
 * trip into a plan — see the note there. What stays here is the pair of things
 * only a browser needs: the cache invalidation, and the navigation. Both happen
 * strictly after the plan is safely written, and neither happens at all when it
 * was not.
 */
export async function buildItineraryAction(tripId: string): Promise<BuildResult> {
  const result = await buildItinerary(tripId);
  if (!result.ok) return result;

  revalidatePath(`/trips/${tripId}/itinerary`);
  // `redirect` throws, so nothing below it runs and the caller never sees this
  // return. It is here because a function typed as returning a result should
  // not rely on a thrown control-flow signal to satisfy its own signature.
  redirect(`/trips/${tripId}/itinerary`);
  return result;
}

// ---------------------------------------------------------------------------
// Smart editing (§11.1): structured intent → deterministic replan → validation.
// ---------------------------------------------------------------------------

/**
 * Every edit follows one shape: assemble the same planner input a rebuild
 * would use, load the stored plan through the version gate (a stale plan
 * cannot be edited — it renders read-only and rebuilds first), hand both to a
 * deterministic planner edit, and persist only what came back valid. The LLM
 * is nowhere in this file, which is the point of §11.1.
 */
export interface EditActionResult {
  ok: boolean;
  error?: string;
  /** One sentence describing what changed, for the toast. */
  changed?: string;
}

export interface SwapOffer {
  placeId: string;
  name: string;
  reason: string;
}

async function editContext(
  tripId: string,
): Promise<
  | { ok: true; input: PlannerInput; itinerary: Itinerary }
  | { ok: false; error: string }
> {
  const assembled = await plannerInputForTrip(tripId);
  if (!assembled.ok) return { ok: false, error: assembled.error };
  let itinerary;
  try {
    itinerary = getItinerary(tripId);
  } catch {
    return {
      ok: false,
      error: 'This plan was built by an earlier version — rebuild it before editing.',
    };
  }
  if (!itinerary) return { ok: false, error: 'There is no plan to edit yet. Build the trip first.' };
  return { ok: true, input: assembled.input, itinerary };
}

function persistEdit(tripId: string, result: ItineraryEditResult): EditActionResult {
  if (!result.ok) return { ok: false, error: result.message };
  try {
    saveItinerary(result.itinerary);
  } catch (error) {
    console.error('Failed to save edited itinerary', error);
    return { ok: false, error: 'The change was valid but could not be saved. Nothing was lost.' };
  }
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, changed: result.changed };
}

export async function removeStopAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
): Promise<EditActionResult> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  const result = removeStopFromDay(context.input, context.itinerary, dayNumber, placeId);
  const persisted = persistEdit(tripId, result);
  if (persisted.ok) {
    /*
     * The board reflects the decision: a removed stop is an excluded one, so
     * the next full rebuild does not resurrect what the traveller took off.
     * The lock, if any, goes with it — a pin on an excluded place is a
     * contradiction in storage.
     */
    setSelection(tripId, placeId, 'excluded', 'user');
    clearItineraryLock(tripId, placeId);
  }
  return persisted;
}

export async function swapAlternativesAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
): Promise<{ ok: boolean; error?: string; offers?: SwapOffer[] }> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  const offers = swapAlternativesForStop(context.input, context.itinerary, dayNumber, placeId);
  return {
    ok: true,
    offers: offers.map((offer) => ({
      placeId: offer.placeId,
      name: offer.name,
      reason: offer.reason,
    })),
  };
}

export async function swapStopAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
  replacementId: string,
): Promise<EditActionResult> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  const result = swapStopOnDay(context.input, context.itinerary, dayNumber, placeId, replacementId);
  const persisted = persistEdit(tripId, result);
  if (persisted.ok) {
    setSelection(tripId, placeId, 'excluded', 'user');
    setSelection(tripId, replacementId, 'included', 'user');
    clearItineraryLock(tripId, placeId);
  }
  return persisted;
}

export async function easeDayAction(tripId: string, dayNumber: number): Promise<EditActionResult> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, easeDay(context.input, context.itinerary, dayNumber));
}

/**
 * A lock is persistence plus a promise, not a replan: the plan already has the
 * stop where the traveller wants it. The next rebuild reads the pin.
 */
export async function toggleLockAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
  locked: boolean,
): Promise<EditActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };
  if (locked) setItineraryLock(tripId, placeId, dayNumber);
  else clearItineraryLock(tripId, placeId);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return {
    ok: true,
    changed: locked
      ? 'Locked. A rebuild will keep this stop on this day.'
      : 'Unlocked. A rebuild is free to move this stop again.',
  };
}
