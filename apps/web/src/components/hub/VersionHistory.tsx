'use client';

import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass } from '../ui';
import { callAction } from '../client-action';
import { announceTripEdit } from './EditToast';
import { keepVersionAction, listRestorePointsAction, restoreVersionAction } from '@/app/(product)/trips/[id]/itinerary/actions';
import type { RestorePoint } from '@/lib/refine/version-repository';

/**
 * EARLIER VERSIONS OF THIS PLAN.
 *
 * Sits on the overview, not behind a menu: after a rebuild the question "where
 * did my old plan go" should have an answer on the page the traveller lands on.
 * The list is fetched when opened, so the page itself pays nothing for it.
 * Restoring is one press, because the toast it raises offers Undo.
 */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function VersionHistory({ tripId }: { tripId: string }) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => {
    startTransition(async () => {
      const outcome = await callAction(() => listRestorePointsAction(tripId));
      if (!outcome.ok) return setError(outcome.message);
      if (!outcome.value.ok) return setError(outcome.value.error);
      setError(null);
      setPoints(outcome.value.points);
    });
  };

  const restore = (version: number) => {
    setError(null);
    startTransition(async () => {
      const outcome = await callAction(() => restoreVersionAction(tripId, version));
      if (!outcome.ok) return setError(outcome.message);
      if (!outcome.value.ok) return setError(outcome.value.error ?? 'That could not be restored just then. Your plan is unchanged.');
      announceTripEdit(outcome.value, 'Restored.');
      const refreshed = await callAction(() => listRestorePointsAction(tripId));
      if (refreshed.ok && refreshed.value.ok) setPoints(refreshed.value.points);
    });
  };

  const keep = (point: RestorePoint) => {
    setError(null);
    startTransition(async () => {
      const outcome = await callAction(() => keepVersionAction(tripId, point.version, !point.saved));
      if (!outcome.ok) return setError(outcome.message);
      if (!outcome.value.ok) return setError(outcome.value.error);
      setPoints((current) => current?.map((row) => (row.version === point.version ? { ...row, saved: !point.saved } : row)) ?? current);
    });
  };

  return (
    <details
      className="hv-fold border-t border-rule pt-3 print:hidden"
      data-testid="trip-versions"
      onToggle={(event) => {
        if (event.currentTarget.open && points === null) load();
      }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 type-body text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-ink-faint">+</span>
        <span className="font-medium text-ink">Earlier versions</span>
        <span className="type-small max-sm:hidden">go back to a plan from before a rebuild or an edit</span>
      </summary>
      <div className="pb-4" aria-busy={pending}>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {points === null ? (
          <p className="type-small text-ink-muted">{pending ? 'Loading…' : ' '}</p>
        ) : (
          <ul className="divide-y divide-rule">
            {points.map((point) => (
              <li key={point.version} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2" data-testid="trip-version-row" data-version={point.version} data-current={point.current || undefined}>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="type-body text-ink">{point.label}</p>
                  <p className="type-small text-ink-muted">
                    {when(point.createdAt)} · {point.dayCount} {point.dayCount === 1 ? 'day' : 'days'}
                    {point.current ? ' · on your trip now' : ''}
                    {point.blocked ? ` · ${point.blocked}` : ''}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => keep(point)} disabled={pending} aria-pressed={point.saved} data-testid="trip-version-keep">
                    {point.saved ? 'Kept' : 'Keep'}
                  </button>
                  {!point.current && !point.blocked ? (
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => restore(point.version)} disabled={pending} data-testid="trip-version-restore">
                      Restore
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
