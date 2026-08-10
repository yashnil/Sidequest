'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Panel, buttonClass } from '@/components/ui';

/**
 * WHAT A TRAVELLER SEES WHEN SOMETHING BREAKS.
 *
 * There was no error boundary anywhere in the customer journey — the only one in
 * the app was in the labs tree — so any unhandled server error on any product
 * route rendered the framework's own error page: a stack trace in development, a
 * blank apology in production, and no route back to the trip either way.
 *
 * This is deliberately not a diagnostic. The traveller cannot act on a digest
 * and does not want one; what they need is to know their trip is still there and
 * to have somewhere to press. The digest is logged for us and shown only as the
 * small reference a support conversation would need.
 *
 * `reset()` is offered first because most of what reaches here is transient — a
 * database lock, a provider timing out during a render that should not have been
 * asking a provider anything. Trying again costs nothing and often works.
 */
export default function ProductError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /**
   * FOCUS FOLLOWS THE CONTENT, ON THE WIDEST BOUNDARY OF THE THREE.
   *
   * An error boundary swaps the page's content without changing the URL, so a
   * keyboard user is left holding focus on a control that no longer exists —
   * and a screen-reader user is told nothing happened at all. The three nested
   * boundaries all move focus to their heading; this one, which catches
   * everything the other three do not, was the one that did not.
   */
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    /*
     * Named fields only. The error object carries whatever threw it, which for a
     * provider failure includes the outbound request and therefore its headers —
     * the discipline the rest of the codebase already holds to.
     */
    console.error('Product route failed', {
      name: error.name,
      message: error.message,
      ...(error.digest ? { digest: error.digest } : {}),
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
      <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Something went wrong</p>
      <h1
        ref={heading}
        tabIndex={-1}
        className="mt-3 font-display text-3xl leading-tight text-ink outline-none"
      >
        That page did not load
      </h1>
      <p className="mt-4 text-ink-muted">
        Your trip is safe — everything you have answered and chosen is stored, and none of it
        depends on this page rendering. This is almost always temporary.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
        <Link href="/" className={buttonClass('secondary')}>
          Back to your trips
        </Link>
      </div>

      {error.digest ? (
        <Panel className="mt-10 p-4">
          <p className="text-xs leading-relaxed text-ink-faint">
            If it keeps happening, this reference identifies what failed:{' '}
            <span className="font-mono text-ink-muted">{error.digest}</span>
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
