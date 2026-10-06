'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { buttonClass } from '@/components/ui';
import { callAction, newBuildKey } from '@/components/client-action';
import { retryBuildAction } from '@/app/(product)/trips/[id]/questionnaire/actions';

/**
 * V1 CONVERGENCE — "RETRY THE DRAFT" THAT RETRIES THE DRAFT.
 *
 * The itinerary page's recovery link was labelled "Retry the draft" and only
 * navigated to the questionnaire, where the traveller had to find and press
 * Build again. This starts the build from the saved answers — the same durable
 * run "Try build again" starts on the build screen, refused up front by the
 * same preflight — and goes to the build screen to watch it.
 */
export function RecoveryBuildButton({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  function build() {
    setError(null);
    key.current ??= newBuildKey();
    const buildKey = key.current;
    start(async () => {
      const outcome = await callAction(() => retryBuildAction(tripId, buildKey));
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      if (!outcome.value.ok) {
        setError(outcome.value.error);
        return;
      }
      router.push(`/trips/${tripId}/build`);
    });
  }
  return (
    <div className="mt-6">
      <button type="button" onClick={build} disabled={pending} className={buttonClass('primary')} data-testid="recovery-primary">
        {pending ? 'Starting…' : 'Build from my saved answers'}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-ink" role="alert" data-testid="recovery-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
