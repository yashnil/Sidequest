'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import type { RefreshSummary } from '@/lib/trips/refresh-information';

/**
 * "REFRESH TRIP INFORMATION" — THE OWNER'S DOOR.
 *
 * New photographs, identities and weather for a trip that already exists, and
 * never a change to its plan (`lib/trips/refresh-information.ts` says exactly
 * what it touches). Owner only, like every recheck: a reader with a share link
 * can never spend a request on somebody else's trip. Throttled per trip inside
 * the refresh itself, so a repeated press replays the last answer for free.
 */
const tripIdSchema = z.string().min(1).max(80);

export type RefreshTripInformationResult = { ok: true; summary: RefreshSummary } | { ok: false; error: string };

export async function refreshTripInformationAction(tripId: string): Promise<RefreshTripInformationResult> {
  if (!tripIdSchema.safeParse(tripId).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  try {
    /* Loaded on press, not with the page: the providers it reaches have no business in the trip page's module graph. */
    const { refreshTripInformation } = await import('@/lib/trips/refresh-information');
    const result = await refreshTripInformation(tripId);
    if (result.ok && !result.summary.throttled) {
      revalidatePath(`/trips/${tripId}/itinerary`);
      revalidatePath(`/trips/${tripId}/discover`);
    }
    return result;
  } catch (error) {
    console.error('Trip refresh failed', { tripId, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, error: 'We could not refresh this trip just now. Your plan is unchanged.' };
  }
}

export type RebuildWithImprovedPlanningResult = { ok: true } | { ok: false; error: string };

/**
 * "REBUILD WITH IMPROVED PLANNING" — A FRESH SCAN, THEN THE PLANNER.
 *
 * Bases are chosen when a scan is assembled, so a better base rule reaches a
 * stored trip only through a new scan; this starts one with the auto-build
 * flag, the same door "Plan with smart defaults" uses (scan → planner build,
 * never `build.ts#buildItinerary`). The traveller pressed it after being told
 * it may change their days; the scan action keeps its own owner check, fence
 * and preflight.
 */
export async function rebuildWithImprovedPlanningAction(tripId: string): Promise<RebuildWithImprovedPlanningResult> {
  if (!tripIdSchema.safeParse(tripId).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const { startDiscoveryScanAction } = await import('../discover/scan-actions');
  const started = await startDiscoveryScanAction(tripId, { autoBuild: true });
  return started.ok ? { ok: true } : { ok: false, error: started.error };
}
