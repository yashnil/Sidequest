'use client';

import { useState, useTransition } from 'react';
import { buttonClass, ErrorNote } from './ui';
import { buildItineraryAction } from '@/app/trips/[id]/itinerary/actions';

/**
 * The primary action on the board. `useTransition` gives a real pending state and
 * the disabled button prevents a second submission — building twice would replace
 * the itinerary mid-write for no reason.
 */
export function BuildTripButton({
  tripId,
  hasItinerary,
  includedCount,
}: {
  tripId: string;
  hasItinerary: boolean;
  includedCount: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function build() {
    setError(null);
    startTransition(async () => {
      const result = await buildItineraryAction(tripId);
      // On success this redirects and never returns.
      if (!result.ok) setError(result.error ?? 'We could not build your trip just then.');
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={build}
        disabled={pending || includedCount === 0}
        className={buttonClass('primary')}
        aria-describedby={includedCount === 0 ? 'build-hint' : undefined}
      >
        {pending ? 'Building your trip…' : hasItinerary ? 'Rebuild my trip' : 'Build my trip'}
      </button>
      {includedCount === 0 ? (
        <p id="build-hint" className="mt-2 text-sm text-ink-muted">
          Include at least one place first, or use auto-pick.
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}
