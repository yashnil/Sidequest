'use client';

import { useParams } from 'next/navigation';
import { RouteFailure } from '@/components/RouteFailure';

/**
 * A SEGMENT BOUNDARY, SO ONE PANEL FAILING DOES NOT REPLACE THE WHOLE JOURNEY.
 *
 * Everything the traveller marked on the board is stored against the trip;
 * the board is rebuilt from what was researched, so a reload costs nothing.
 * See `components/RouteFailure` for the shared promises.
 */
export default function DiscoverError({ error, reset, retry }: { error: Error & { digest?: string }; reset: () => void; retry?: () => void }) {
  const id = String(useParams()?.id ?? '');
  return (
    <RouteFailure
      error={error}
      reset={reset}
      retry={retry}
      route="discover"
      eyebrow="Your picks are safe"
      heading="The board did not load."
      preserved="Everything you marked is stored against your trip rather than held on this page, so nothing you picked has been lost."
      detail="The board is rebuilt from what was researched, so retrying costs nothing."
      secondary={{ href: `/trips/${id}/plan`, label: 'Return to the plan' }}
    />
  );
}
