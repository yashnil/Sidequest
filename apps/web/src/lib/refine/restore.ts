import 'server-only';
import { ITINERARY_VERSION, type Itinerary } from '@sidequest/core';
import { getDb } from '../db/client';
import { getTrip, saveItinerary } from '../db/repository';
import { saveTripDraft } from '../db/draft-repository';
import { currentVersion, getVersion, listRestorePoints, recordVersion, restoreRefusal, writePlanDecisions, type RestorePoint, type TripVersion } from './version-repository';

/**
 * ONE RESTORE, FOR EVERY WAY BACK.
 *
 * Undo after a hand edit, Undo in Ask Sidequest and "Restore this version" all
 * end here: the plan, its draft, its pins and its board decisions written back
 * together, and the result recorded as a new version, so a restore can itself
 * be undone. No model, no provider, no re-measure.
 */
export type RestoreOutcome = { ok: true; restored: TripVersion; version: number } | { ok: false; error: string };

function tripFacts(tripId: string): { startDate: string; endDate: string; itineraryVersion: number } | null {
  const trip = getTrip(tripId);
  return trip ? { startDate: trip.basics.startDate, endDate: trip.basics.endDate, itineraryVersion: ITINERARY_VERSION } : null;
}

export function restorePlanVersion(input: { tripId: string; version: number; request: string; changed: string }): RestoreOutcome {
  const trip = tripFacts(input.tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };
  let target: TripVersion | null;
  try {
    target = getVersion(input.tripId, input.version);
  } catch {
    return { ok: false, error: 'That version was built by an earlier version of Sidequest, so it can no longer be opened.' };
  }
  if (!target) return { ok: false, error: 'That version is no longer here.' };
  const plan: Itinerary = target.itinerary;
  const refusal = restoreRefusal({ planVersion: plan.version, startDate: plan.startDate, endDate: plan.endDate }, trip);
  if (refusal) return { ok: false, error: refusal };
  const restored = target;
  let version = 0;
  getDb().transaction(() => {
    saveItinerary(plan);
    if (restored.draft) saveTripDraft({ tripId: input.tripId, draft: restored.draft });
    if (restored.decisions) writePlanDecisions(input.tripId, restored.decisions);
    version = recordVersion({
      tripId: input.tripId,
      /* Read after the save, which may have recorded the plan it replaced. */
      previousVersion: currentVersion(input.tripId),
      request: input.request,
      summary: { changed: [input.changed], kept: [], rechecking: [] },
      itinerary: plan,
      draft: restored.draft,
    }).version;
  })();
  return { ok: true, restored, version };
}

export function restorePointsFor(tripId: string): RestorePoint[] {
  const trip = tripFacts(tripId);
  return trip ? listRestorePoints(tripId, trip) : [];
}
