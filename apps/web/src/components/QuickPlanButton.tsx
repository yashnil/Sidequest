'use client';

import { useState, useTransition } from 'react';
import { buttonClass, ErrorNote } from './ui';
import { buildQuickPlanAction } from '@/app/(product)/trips/[id]/quickplan/actions';

/**
 * Phase 17's minimal-first entry point. One press, no questionnaire required —
 * see `lib/planning/hybrid.ts`.
 */
export function QuickPlanButton({ tripId, hasPlan }: { tripId: string; hasPlan: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function build() {
    setError(null);
    startTransition(async () => {
      const result = await buildQuickPlanAction(tripId);
      // On success this redirects and never returns.
      if (result && !result.ok) {
        setError(result.error ?? 'We could not compose your trip just then.');
      }
    });
  }

  return (
    <div>
      <button type="button" onClick={build} disabled={pending} className={buttonClass('primary')}>
        {pending ? 'Composing your trip…' : hasPlan ? 'Compose it again' : 'Plan the whole trip for me'}
      </button>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? 'Composing your trip. This can take up to a minute.' : ''}
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}
