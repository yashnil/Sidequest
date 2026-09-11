'use client';

import { useParams } from 'next/navigation';
import { RouteFailure } from '@/components/RouteFailure';

/**
 * A SEGMENT BOUNDARY, SO ONE PANEL FAILING DOES NOT REPLACE THE WHOLE JOURNEY.
 *
 * The plan itself is saved; this is the page that renders it. Retrying reloads
 * the page; nothing here rebuilds the plan, so trying again cannot change what
 * it contains. See `components/RouteFailure` for the shared promises.
 */
export default function ItineraryError({ error, reset, retry }: { error: Error & { digest?: string }; reset: () => void; retry?: () => void }) {
  const id = String(useParams()?.id ?? '');
  return (
    <RouteFailure
      error={error}
      reset={reset}
      retry={retry}
      route="itinerary"
      eyebrow="Your plan is safe"
      heading="Your plan did not load."
      preserved="The plan itself is saved. This is the page that renders it, and it is the only part that failed."
      detail="Retrying reloads the page. Nothing here rebuilds the plan, so trying again cannot change what it contains."
      secondary={{ href: `/trips/${id}/questionnaire`, label: 'Return to trip review' }}
    />
  );
}
