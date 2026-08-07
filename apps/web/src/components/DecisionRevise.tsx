'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DecisionComposer } from './DecisionComposer';
import type { DecisionAnswersInput } from '@/app/decide/actions';

/**
 * CHANGING YOUR MIND, WITHOUT STARTING OVER.
 *
 * Collapsed by default and open on one click, holding the same composer the
 * first screen used with the stored answers filled in. One component rather than
 * two, so a question added to the entry screen appears here as well — the
 * alternative is two forms that gradually disagree about what was asked.
 *
 * Saving deliberately clears the stored shortlist rather than labelling it
 * stale: a list built from different answers is not out of date, it is an answer
 * to a different question, and leaving it on screen beside the new answers is
 * the page disagreeing with itself.
 */
export function DecisionRevise({
  sessionId,
  climateEnabled,
  initial,
}: {
  sessionId: string;
  climateEnabled: boolean;
  initial: Partial<DecisionAnswersInput>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <section aria-labelledby="revise-heading">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="text-sm text-ink-muted underline underline-offset-4 hover:text-pine"
      >
        <span id="revise-heading">
          {open ? 'Leave my answers as they are' : 'Change what you told us'}
        </span>
      </button>

      {open ? (
        <div className="mt-8">
          <DecisionComposer
            sessionId={sessionId}
            climateEnabled={climateEnabled}
            indexReady
            initial={initial}
            onSaved={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
