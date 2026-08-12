'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Panel, buttonClass } from '@/components/ui';

/**
 * WHEN "HELP ME DECIDE" BREAKS.
 *
 * The product-wide boundary would catch this, and its copy is deliberately
 * generic: "your trip is safe". On this route there is no trip yet, so that
 * sentence answers a question nobody asked and leaves the real one — *are my
 * answers gone?* — unanswered.
 *
 * They are not. A decision session is a row written the moment the four
 * questions are submitted, and the id is in the URL, which is what makes a
 * refresh free. That is the only thing worth saying here, and the retry is
 * offered first because most of what reaches this is transient.
 */
export default function DecideError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /*
   * An error boundary swaps the page's content without changing the URL, so a
   * keyboard user is left holding focus on a control that no longer exists and
   * a screen-reader user is told nothing happened.
   */
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    // Named fields only: the error object carries whatever threw it, which for
    // a provider failure includes the outbound request and its headers.
    console.error('Decide route failed', {
      name: error.name,
      message: error.message,
      ...(error.digest ? { digest: error.digest } : {}),
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
      <p className="eyebrow">Where should I go</p>
      <h1
        ref={heading}
        tabIndex={-1}
        /*
          `focus:`, not `outline-none`, and not `focus-visible:`.

          This heading is a programmatic focus target: the boundary moves
          focus here on mount so a screen-reader user is told what happened
          instead of being left on a page that silently changed under them.
          `outline-none` then removed the only thing that told a *sighted*
          keyboard user where focus had gone — the same defect the benchmark
          lock dialog fixed, in the same words, and never applied here.

          `focus-visible:` would not do it: focus arrives from script rather
          than from a key press, so the browser heuristic declines. See
          `ReviewSurface.tsx` #lock-confirm-heading for the argument in full.
        */
        className="mt-3 rounded-sm font-display text-3xl leading-tight text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2"
      >
        That did not load
      </h1>
      <p className="mt-4 leading-relaxed text-ink-muted">
        Your answers are saved — they were stored the moment you submitted them, and this page is
        the only thing that failed. Trying again usually works.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" onClick={reset} className={buttonClass('primary')}>
          Try again
        </button>
        <Link href="/decide" className={buttonClass('secondary')}>
          Start again
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
