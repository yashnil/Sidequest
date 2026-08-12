'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, ErrorNote, buttonClass, cx } from '@/components/ui';
import { deleteTripAction } from './actions';

/**
 * THE TRIP LIST, WHICH USED TO BE A LINK AND TWO ISO DATES.
 *
 * What was here: `trips.slice(0, 8)`, a ternary that called every non-draft trip
 * "Discovery board ready", `2026-10-12 → 2026-10-18`, and no way to remove
 * anything. Four separate failures adding up to one: the screen that lists a
 * traveller's trips could not truthfully describe a single one of them, and the
 * only trip in the live database with a finished plan was below the cut.
 *
 * Everything about *what* a row says is decided by `tripProgress`, on the
 * server, from persisted facts. This component owns only how it is presented and
 * the two interactions a list needs: showing the rest, and removing one.
 *
 * ## Removal is two presses, and deliberately not a dialog
 *
 * A `window.confirm` is unstyled, unannounced to some assistive technology, and
 * cannot be reached by the keyboard on iOS Safari in a `useTransition`. The row
 * turns into its own confirmation instead: the question is in the flow of the
 * page, both answers are real buttons, and pressing anything else cancels it.
 */

export interface TripListRow {
  id: string;
  destination: string;
  /** Already humanised on the server, so one formatter serves every surface. */
  dates: string;
  nights: number;
  state: string;
  label: string;
  action: string;
  href: string;
  tone: 'neutral' | 'pine' | 'amber' | 'blue' | 'clay';
}

/** How many rows stand on their own before the rest are folded away. */
const VISIBLE = 6;

export function TripList({ rows }: { rows: TripListRow[] }) {
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

      <ul className="divide-y divide-rule border-t border-rule">
        {shown.map((row) => (
          <li key={row.id}>
            {confirming === row.id ? (
              <div className="flex flex-wrap items-center gap-3 py-4">
                <p className="min-w-0 flex-1 text-sm text-ink">
                  Remove <span className="font-medium">{row.destination}</span>? This deletes the
                  answers and any research done for it, and cannot be undone.
                </p>
                {/* Same rule as the action cluster below: no island in a row
                    that cannot narrow. See the note there for the measurement. */}
                <div className="flex min-w-0 flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass('secondary', 'sm')}
                    onClick={() => setConfirming(null)}
                    disabled={pending}
                  >
                    Keep it
                  </button>
                  {/*
                    Destructive, and coloured by the palette's warning token
                    rather than by a filled red button. `bg-clay text-paper`
                    inverts in dark mode — clay becomes the light value and
                    paper the dark one — so the filled form would have been a
                    different control in the two themes.
                  */}
                  <button
                    type="button"
                    className={cx(buttonClass('secondary', 'sm'), 'border-clay text-clay')}
                    onClick={() => remove(row.id)}
                    disabled={pending}
                  >
                    {pending ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <Link
                  href={row.href}
                  className={cx(
                    'group flex min-h-11 min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1',
                    'focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2',
                  )}
                >
                  <span className="font-medium text-ink group-hover:text-pine">
                    {row.destination}
                  </span>
                  <span className="text-sm text-ink-muted">
                    {row.dates} · {row.nights} night{row.nights === 1 ? '' : 's'}
                  </span>
                </Link>
                {/*
                  THE ONE NODE IN THE PRODUCT THAT SCROLLS SIDEWAYS.

                  `shrink-0` on this cluster gave it a hard 363px floor. With
                  20px of page padding that puts its right edge at 383px, so the
                  homepage overflowed horizontally on every phone narrower than
                  that — measured 8px at 375 (iPhone SE/8), 23px at 360 (most
                  Androids), 63px at 320, in both colour schemes. Every other
                  route is clean from 320 up. The suite could not see it: its
                  only mobile width is 390, seven pixels above the threshold.

                  The row above already wraps, but a cluster that refuses to
                  shrink *and* refuses to wrap cannot participate in that. So it
                  wraps on its own account, and `min-w-0` lets it actually get
                  narrower than its content — without it a flex item's automatic
                  minimum size is its content, which is the same floor by a
                  different name.

                  `justify-end` keeps the cluster against the right edge when it
                  has a line to itself, which is where it sits today.
                */}
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
                  <Badge tone={row.tone}>{row.label}</Badge>
                  <Link
                    href={row.href}
                    className="inline-flex min-h-11 items-center text-sm text-ink-muted underline underline-offset-4 hover:text-pine"
                  >
                    {row.action}
                  </Link>
                  <button
                    type="button"
                    onClick={() => setConfirming(row.id)}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-sm text-ink-faint hover:text-clay focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                    aria-label={`Remove the ${row.destination} trip`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/*
        The rest, reachable rather than discarded.

        `slice(0, 8)` with nothing after it was the defect: there was no route to
        a trip below the cut from anywhere in the product, so a trip could exist,
        be finished, and be unreachable. A count somebody can press is the
        smallest honest fix.
      */}
      {hidden > 0 ? (
        <button
          type="button"
          className={cx(buttonClass('ghost', 'sm'), 'mt-4')}
          onClick={() => setExpanded(true)}
        >
          Show {hidden} more trip{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
      {expanded && rows.length > VISIBLE ? (
        <button
          type="button"
          className={cx(buttonClass('ghost', 'sm'), 'mt-4')}
          onClick={() => setExpanded(false)}
        >
          Show fewer
        </button>
      ) : null}
    </div>
  );
}
