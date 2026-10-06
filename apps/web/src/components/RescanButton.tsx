'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass } from './ui';
import { callAction } from './client-action';
import { startDiscoveryScanAction } from '@/app/(product)/trips/[id]/discover/scan-actions';

/**
 * V1 CONVERGENCE — RESCAN, WITH A CONFIRMATION, BECAUSE IT REPLACES THE BOARD'S PLACES.
 *
 * Two presses: the first says what will happen (a new search replaces the
 * places on this board; the traveller's own picks survive only on places that
 * come back), the second starts it. The page then shows the scan's progress
 * and returns to the new board when it is ready.
 */
export function RescanButton({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function rescan() {
    setError(null);
    startTransition(async () => {
      const outcome = await callAction(() => startDiscoveryScanAction(tripId, { autoBuild: false }));
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      if (!outcome.value.ok) {
        setError(outcome.value.error);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => setConfirming(true)} data-testid="board-rescan">
        Rescan
      </button>
    );
  }
  return (
    <div className="w-full basis-full rounded-[var(--radius-card)] border border-rule p-4 sm:max-w-md" role="group" aria-labelledby="rescan-confirm-text" data-testid="board-rescan-confirm">
      <p id="rescan-confirm-text" className="type-small text-ink">
        A new search replaces the places on this board. Your picks on places that still appear are kept; picks on places that don’t come back are dropped.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonClass('primary', 'sm')} onClick={rescan} disabled={pending} data-testid="board-rescan-go">
          {pending ? 'Starting…' : 'Rescan now'}
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirming(false)} disabled={pending}>
          Keep this board
        </button>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}
