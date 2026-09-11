'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass, cx } from '@/components/ui';
import { TripCard, type DashboardCardRow } from './trips/TripCard';
import { deleteTripAction } from './actions';

/**
 * THE HOME STRIP — THE TRIPS SOMEBODY MOST LIKELY CAME BACK FOR.
 *
 * V8 §8. The landing page owes a returning visitor something smaller and
 * faster than the dashboard: the two or three trips they are most likely to
 * reopen, as the same rich card the dashboard uses — picture or route sketch,
 * dates as a figure, where the plan stands — so a trip looks the same on every
 * screen that lists it. Everything about *what* a card says is decided on the
 * server (`dashboardRowsFor`, `tripProgress`); this owns only the two
 * interactions a strip needs: showing the rest, and removing one.
 *
 * ## Removal is two presses, and deliberately not a dialog
 *
 * A `window.confirm` is unstyled, unannounced to some assistive technology, and
 * cannot be reached by the keyboard on iOS Safari in a `useTransition`. The card
 * turns into its own confirmation instead: the question is in the flow of the
 * page, both answers are real buttons, and pressing anything else cancels it.
 */

/** How many cards stand on their own before the rest are folded away. */
const VISIBLE = 3;

export function TripList({ rows }: { rows: DashboardCardRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const shown = expanded ? rows : rows.slice(0, VISIBLE);
  const hidden = rows.length - shown.length;

  function remove(tripId: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteTripAction(tripId);
      setConfirming(null);
      if (!result.ok) setError(result.error ?? 'We could not remove that.');
      else router.refresh();
    });
  }

  return (
    <div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((row) =>
          confirming === row.id ? (
            <li key={row.id} className="card-raised flex min-w-0 flex-col justify-center rounded-[var(--radius-panel)] p-5">
              <p className="type-body text-ink">
                Remove <span className="font-semibold">{row.title}</span>? This deletes the answers and any
                research done for it, and cannot be undone.
              </p>
              {/* No island in a row that cannot narrow: see `trip-list.test.ts`. */}
              <div className="mt-4 flex min-w-0 flex-wrap gap-2">
                <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setConfirming(null)} disabled={pending}>
                  Keep it
                </button>
                {/*
                  Destructive, and coloured by the palette's warning token rather
                  than by a filled red button: `bg-clay text-paper` inverts in dark
                  mode and would be a different control in the two themes.
                */}
                <button type="button" className={cx(buttonClass('secondary', 'sm'), 'border-clay text-clay')} onClick={() => remove(row.id)} disabled={pending}>
                  {pending ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </li>
          ) : (
            <TripCard key={row.id} row={row} onError={setError} controls={{ kind: 'remove', onRemove: () => setConfirming(row.id) }} />
          ),
        )}
      </ul>

      {/*
        The rest, reachable rather than discarded: a trip could exist, be
        finished, and be unreachable from anywhere in the product when the strip
        simply cut the list. A count somebody can press is the smallest honest fix.
      */}
      {hidden > 0 ? (
        <button type="button" className={cx(buttonClass('ghost', 'sm'), 'mt-4')} onClick={() => setExpanded(true)}>
          Show {hidden} more trip{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
      {expanded && rows.length > VISIBLE ? (
        <button type="button" className={cx(buttonClass('ghost', 'sm'), 'mt-4')} onClick={() => setExpanded(false)}>
          Show fewer
        </button>
      ) : null}
    </div>
  );
}
