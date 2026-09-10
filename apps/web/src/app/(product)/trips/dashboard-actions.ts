'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { overrideRefusal, readLifecycle, tripLifecycleSchema, type TripLifecycle } from '@sidequest/core';
import { currentUserId } from '@/lib/auth/session';
import { listBookedItems } from '@/lib/db/intelligence-repository';
import { duplicateTrip, getItinerary, getProfile, getTrip, recordLifecycleChange, renameTrip, setLifecycleOverride, setTripArchived } from '@/lib/db/repository';
import { sessionToken } from '@/lib/net/caller';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * THE DASHBOARD'S ACTIONS — RENAME, DUPLICATE, ARCHIVE, SET A STAGE.
 *
 * V6 §24/§25. Every one asks the ownership seam first. Deleting stays where
 * it was (`(product)/actions.ts#deleteTripAction`).
 */

export type DashboardActionResult = { ok: true; tripId?: string } | { ok: false; error: string };

const tripId = z.string().min(1).max(80);

export async function renameTripAction(id: string, title: string): Promise<DashboardActionResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  const cleaned = title.trim().slice(0, 80);
  renameTrip(id, cleaned.length > 0 ? cleaned : null);
  revalidatePath('/trips');
  return { ok: true };
}

export async function duplicateTripAction(id: string): Promise<DashboardActionResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  const copy = duplicateTrip(id, { ownerToken: await sessionToken({ mint: true }), userId: await currentUserId() });
  if (!copy) return { ok: false, error: 'We could not copy that trip just now. Nothing was changed.' };
  revalidatePath('/trips');
  return { ok: true, tripId: copy.id };
}

export async function archiveTripAction(id: string, archived: boolean): Promise<DashboardActionResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  setTripArchived(id, archived);
  recordLifecycleChange(id, archived ? 'archived' : 'planning', 'archive', archived ? 'Archived by the traveller.' : 'Restored by the traveller.');
  revalidatePath('/trips');
  return { ok: true };
}

/**
 * Set a lifecycle stage by hand. `booked` needs a booked stay or way there —
 * a label is not a booking — and the calendar is never overridable.
 */
export async function setLifecycleAction(id: string, lifecycle: string | null): Promise<DashboardActionResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  const trip = getTrip(id);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  if (lifecycle === null) {
    setLifecycleOverride(id, null);
    recordLifecycleChange(id, 'inferred', 'traveller', 'Let Sidequest set the stage.');
    revalidatePath('/trips');
    return { ok: true };
  }
  const parsed = tripLifecycleSchema.safeParse(lifecycle);
  if (!parsed.success) return { ok: false, error: 'That is not a stage we know.' };
  const facts = {
    trip,
    itineraryStatus: getItinerary(id)?.status ?? null,
    bookedTypes: listBookedItems(id).filter((b) => b.status === 'booked').map((b) => b.type),
    hasProfile: getProfile(id) !== null,
    now: new Date(),
  };
  const why = overrideRefusal(parsed.data as TripLifecycle, facts);
  if (why) return { ok: false, error: why };
  setLifecycleOverride(id, parsed.data);
  recordLifecycleChange(id, parsed.data, 'traveller', null);
  const reading = readLifecycle({ ...facts, trip: { ...trip, lifecycleOverride: parsed.data } });
  revalidatePath('/trips');
  return reading.overrideRefused ? { ok: false, error: 'That stage does not fit the facts of this trip.' } : { ok: true };
}
