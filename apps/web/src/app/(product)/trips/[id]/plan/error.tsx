'use client';

import { useParams } from 'next/navigation';
import { RouteFailure } from '@/components/RouteFailure';

/**
 * A SEGMENT BOUNDARY, SO ONE PANEL FAILING DOES NOT REPLACE THE WHOLE JOURNEY.
 *
 * The plan screen reports on research and scope; a build runs on the server
 * and keeps going whether or not this page is open, so retrying the page
 * cannot lose it. See `components/RouteFailure` for the shared promises.
 */
export default function PlanError({ error, reset, retry }: { error: Error & { digest?: string }; reset: () => void; retry?: () => void }) {
  const id = String(useParams()?.id ?? '');
  return (
    <RouteFailure
      error={error}
      reset={reset}
      retry={retry}
      route="plan"
      eyebrow="Your trip is safe"
      heading="This page hit a problem."
      preserved="Your trip answers are saved — the destination, your dates and every question you have answered are on the trip, not on this screen."
      detail="Anything running on the server carries on whether or not this page is open. Retrying reloads the page from what is stored."
      secondary={{ href: `/trips/${id}/questionnaire`, label: 'Return to trip review' }}
    />
  );
}
