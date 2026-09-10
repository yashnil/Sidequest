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
 * ## V6 — this is the landing page's short list, not the dashboard
 *
 * `/trips` is where a traveller's trips live now: pictures, lifecycle sections,
 * search, the lot. What the landing page owes a returning visitor is smaller and
 * faster — the two or three trips they are most likely to have come back for,
 * as one press each. So the rows are set as a *route*: a hairline rail down the
 * left with a mark per trip, the destination at reading size, and everything
 * else as one quiet line under it. No table, no columns, no id.
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
const VISIBLE = 4;

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

      <ul className="grid gap-3 sm:grid-cols-2">
        {shown.map((row) => (
          <li
            key={row.id}
            className="group relative min-w-0 rounded-[var(--radius-card)] border border-rule bg-paper-raised transition-colors hover:border-ink-faint"
          >
            {confirming === row.id ? (
              <div className="flex min-w-0 flex-col p-4">
                <p className="text-sm leading-relaxed text-ink">
                  Remove <span className="font-medium">{row.destination}</span>? This deletes the
                  answers and any research done for it, and cannot be undone.
                </p>
                {/* Same rule as the action cluster below: no island in a row
                    that cannot narrow. See the note there for the measurement. */}
                <div className="mt-3 flex min-w-0 flex-wrap gap-2">
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
              /* A flex column, so the two clusters inside it are flex *items* and
                 `min-w-0` on them means what it says: see `trip-list.test.ts`. */
              <div className="flex min-w-0 flex-col p-4">
                {/*
                  The whole card is the link, drawn as an overlay rather than as
                  a wrapper, so the Remove button inside it is still its own
                  target rather than a nested interactive element.
                */}
                <Link
                  href={row.href}
                  className="absolute inset-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                >
                  <span className="sr-only">
                    {row.destination} — {row.action}
                  </span>
                </Link>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <p className="min-w-0 font-display text-xl leading-tight text-ink group-hover:text-pine">
                    {row.destination}
                  </p>
                  <Badge tone={row.tone}>{row.label}</Badge>
                </div>
                <p className="mt-1.5 text-sm text-ink-muted">
                  {row.dates} · {row.nights} night{row.nights === 1 ? '' : 's'}
                </p>
                <div className="relative mt-3 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="text-sm font-medium text-ink group-hover:text-pine">
                    {row.action}
                    <span aria-hidden="true" className="ml-1 inline-block transition-transform group-hover:translate-x-0.5">
                      →
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirming(row.id)}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-1 text-sm text-ink-faint hover:text-clay focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
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
