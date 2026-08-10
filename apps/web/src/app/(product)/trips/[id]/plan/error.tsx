'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { buttonClass } from '@/components/ui';

/**
 * A SEGMENT BOUNDARY, SO ONE PANEL FAILING DOES NOT REPLACE THE WHOLE JOURNEY.
 *
 * The group boundary at `(product)/error.tsx` catches everything, which means it
 * also *replaces* everything: a failure while rendering one panel of the plan
 * screen sent the traveller to a generic apology with no sign of which stage
 * they had reached or what was still true.
 *
 * Nested boundaries are how Next scopes that. This one knows which screen it is
 * standing in, so it can say what survived and offer the action that belongs to
 * this point in the journey rather than "back to your trips".
 *
 * Same discipline as the group boundary: named fields in the log, never the
 * error object, because a provider failure carries its outbound request and
 * therefore its headers.
 */
export default function PlanError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const id = String(useParams()?.id ?? '');
  const heading = useRef<HTMLHeadingElement>(null);

  /*
   * Focus the heading when this replaces the page.
   *
   * A boundary swaps the content without changing the URL, so a keyboard or
   * screen-reader user is otherwise left with focus on a control that no longer
   * exists, on a page that never announced it had changed. The questionnaire
   * already does this on every step; an error screen needs it more, not less.
   */
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    console.error('plan route failed', {
      name: error.name,
      message: error.message,
      ...(error.digest ? { digest: error.digest } : {}),
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
      <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">The build</p>
      <h1
        ref={heading}
        tabIndex={-1}
        className="mt-3 font-display text-3xl leading-tight text-ink outline-none"
      >We lost track of that build</h1>
      <p className="mt-4 text-ink-muted">Nothing you answered is gone — the destination, your dates and every question you have already answered are stored on the trip, not on this screen. What failed is the page that reports progress.</p>
      <p className="mt-3 text-sm text-ink-muted">A build runs on the server, so it keeps going whether or not this page is open. Reloading picks it back up where it was.</p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
        <Link href={`/trips/${id}/edit`} className={buttonClass('secondary')}>
          Change this trip
        </Link>
      </div>

      {error.digest ? (
        <p className="mt-10 text-xs leading-relaxed text-ink-faint">
          If it keeps happening, this reference identifies what failed:{' '}
          <span className="font-mono text-ink-muted">{error.digest}</span>
        </p>
      ) : null}
    </div>
  );
}
