'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { REFINEMENT_LABELS, REFINEMENTS, type Refinement } from '@sidequest/core';
import { adoptAdvisorPickAction, refineAdvisorAction, type RefineInput } from '@/app/(product)/decide/advisor-actions';
import { buttonClass, cx, ErrorNote } from '@/components/ui';

/**
 * The shortlist's interactive parts. Every button is one server action that
 * re-ranks from the stored answers; nothing is computed here.
 */

function useRefine(sessionId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const run = (key: string, input: RefineInput) => {
    setError(null);
    setActive(key);
    start(async () => {
      const result = await refineAdvisorAction(sessionId, input);
      if (!result.ok) setError(result.error ?? 'That did not work.');
      router.refresh();
      setActive(null);
    });
  };
  return { pending, error, active, run };
}

export function AdvisorPickActions({ sessionId, pickId, name, primary = false }: { sessionId: string; pickId: string; name: string; primary?: boolean }) {
  const { pending, error, active, run } = useRefine(sessionId);
  const [adopting, startAdopt] = useTransition();
  const [adoptError, setAdoptError] = useState<string | null>(null);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={adopting}
          onClick={() =>
            startAdopt(async () => {
              const result = await adoptAdvisorPickAction(sessionId, pickId);
              if (result && !result.ok) setAdoptError(result.error ?? 'Could not start that trip.');
            })
          }
          className={buttonClass(primary ? 'accent' : 'secondary', primary ? 'lg' : 'md')}
          aria-label={`Plan a trip to ${name}`}
        >
          {adopting ? 'Starting your trip…' : 'Plan this trip'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(`similar:${pickId}`, { similarTo: pickId })}
          className="min-h-11 rounded-full px-3 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          aria-label={`Show places more like ${name}`}
        >
          {active === `similar:${pickId}` ? 'Finding…' : 'More like this'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(`aside:${pickId}`, { setAside: pickId })}
          className="min-h-11 rounded-full px-3 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          aria-label={`Set ${name} aside`}
        >
          {active === `aside:${pickId}` ? 'Replacing…' : 'Not for me'}
        </button>
      </div>
      {error || adoptError ? (
        <div className="mt-3">
          <ErrorNote>{error ?? adoptError}</ErrorNote>
        </div>
      ) : null}
    </div>
  );
}

const SHOWN: Refinement[] = [...REFINEMENTS];

export function AdvisorRefineBar({ sessionId, applied }: { sessionId: string; applied: boolean }) {
  const { pending, error, active, run } = useRefine(sessionId);
  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Refine the shortlist">
        {SHOWN.map((refinement) => (
          <button
            key={refinement}
            type="button"
            disabled={pending}
            onClick={() => run(refinement, { refinement })}
            className={cx(
              'min-h-11 rounded-full border px-3.5 py-2 text-sm transition-colors',
              active === refinement ? 'border-ink bg-ink text-bone' : 'border-ink/20 text-ink hover:border-ink',
              pending && active !== refinement && 'opacity-60',
            )}
          >
            {active === refinement ? 'Re-ranking…' : REFINEMENT_LABELS[refinement]}
          </button>
        ))}
        <button
          type="button"
          disabled={pending}
          onClick={() => run('different', { different: true })}
          className={cx('min-h-11 rounded-full border border-flare px-3.5 py-2 text-sm text-ink transition-colors hover:bg-flare/10', active === 'different' && 'bg-flare/20')}
        >
          {active === 'different' ? 'Looking elsewhere…' : 'Something completely different'}
        </button>
        {applied ? (
          <button type="button" disabled={pending} onClick={() => run('reset', { reset: true })} className="min-h-11 px-2 text-sm text-ink-muted underline underline-offset-4 hover:text-ink">
            Undo all nudges
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
    </div>
  );
}
