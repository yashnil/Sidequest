'use client';

import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass } from '../ui';
import { callAction } from '../client-action';
import { rebuildWithImprovedPlanningAction, refreshTripInformationAction } from '@/app/(product)/trips/[id]/itinerary/refresh-actions';

/**
 * THE TWO MAINTENANCE DOORS IN THE TRIP'S `More` MENU.
 *
 * "Refresh trip information" adds evidence — photographs, identities, weather —
 * and says so, and says the plan is unchanged, because it is.
 *
 * "Rebuild with improved planning" appears only when the stored scan would be
 * planned differently today (`scanBaseUpgrade`: fewer hotel moves). It is the
 * one door here that can change the itinerary, so it says that first and asks
 * twice: a fresh scan, then the planner, through the same path "Plan with smart
 * defaults" takes. Nothing about it runs on its own.
 *
 * No `useRouter`: the refresh action revalidates the page itself, and the
 * component renders inside server-rendered document tests with no app router.
 */
export interface PlanningUpgrade {
  storedBaseCount: number;
  currentBaseCount: number;
}

export function TripRefreshControl({ tripId, upgrade }: { tripId: string; upgrade?: PlanningUpgrade | null }) {
  const [refreshing, startRefresh] = useTransition();
  const [rebuilding, startRebuild] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function refresh() {
    setError(null);
    setMessage(null);
    startRefresh(async () => {
      const outcome = await callAction(() => refreshTripInformationAction(tripId));
      if (!outcome.ok) return setError(outcome.message);
      if (!outcome.value.ok) return setError(outcome.value.error);
      setMessage(outcome.value.summary.throttled ? `Refreshed a few minutes ago. ${outcome.value.summary.message}` : outcome.value.summary.message);
    });
  }

  function rebuild() {
    setError(null);
    startRebuild(async () => {
      const outcome = await callAction(() => rebuildWithImprovedPlanningAction(tripId));
      if (!outcome.ok) return setError(outcome.message);
      if (!outcome.value.ok) return setError(outcome.value.error);
      /* A full navigation: the discover page shows the scan and then the build it starts. */
      window.location.assign(`/trips/${tripId}/discover`);
    });
  }

  return (
    <div className="flex flex-col gap-1" data-testid="trip-maintenance">
      <button type="button" className={buttonClass('ghost', 'sm')} onClick={refresh} disabled={refreshing} aria-busy={refreshing} data-testid="refresh-trip-information">
        {refreshing ? 'Refreshing…' : 'Refresh trip information'}
      </button>
      {message ? (
        <p className="px-2 text-xs leading-relaxed text-ink-muted" role="status" data-testid="refresh-trip-result">
          {message}
        </p>
      ) : null}
      {upgrade ? (
        confirming ? (
          <div className="rounded-[var(--radius-control)] border border-rule p-2" role="group" aria-labelledby="rebuild-improved-text" data-testid="rebuild-improved-confirm">
            <p id="rebuild-improved-text" className="text-xs leading-relaxed text-ink">
              This searches your destination again and plans the trip from scratch, so your days, stops and where you sleep may change. Your bookings are kept. On the places this trip already found, today’s planning would use {upgrade.currentBaseCount === 1 ? 'one place to sleep' : `${upgrade.currentBaseCount} places to sleep`} instead of {upgrade.storedBaseCount}; a fresh search can turn up different places, so the new plan may differ.
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              <button type="button" className={buttonClass('primary', 'sm')} onClick={rebuild} disabled={rebuilding} data-testid="rebuild-improved-go">
                {rebuilding ? 'Starting…' : 'Rebuild this trip'}
              </button>
              <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirming(false)} disabled={rebuilding}>
                Keep this plan
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirming(true)} data-testid="rebuild-improved">
            Rebuild with improved planning
          </button>
        )
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}
