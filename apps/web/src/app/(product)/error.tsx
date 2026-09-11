'use client';

import { usePathname } from 'next/navigation';
import { RouteFailure, tripIdFromPath } from '@/components/RouteFailure';

/**
 * THE GROUP BOUNDARY: EVERYTHING IN THE CUSTOMER JOURNEY THAT HAS NO NEARER ONE.
 *
 * V8 — it used to say "That page did not load" with a "Try again" that
 * re-rendered the page on the props it first loaded with, which on the
 * questionnaire meant an unanswered interview over saved answers. The shared
 * `RouteFailure` retries by re-fetching, names what is preserved, and — when
 * the path is inside a trip — returns to that trip's review rather than to
 * the list of trips.
 */
export default function ProductError({ error, reset, retry }: { error: Error & { digest?: string }; reset: () => void; retry?: () => void }) {
  const pathname = usePathname();
  const tripId = tripIdFromPath(pathname);
  return (
    <RouteFailure
      error={error}
      reset={reset}
      retry={retry}
      route="product"
      eyebrow="Your trip is safe"
      heading="This page hit a problem."
      preserved="Your trip answers are saved. Nothing on this page had to render for them to be kept."
      detail="This is almost always temporary. Retrying reloads the page from what is stored; it does not start anything over."
      secondary={tripId ? { href: `/trips/${tripId}/questionnaire`, label: 'Return to trip review' } : { href: '/trips', label: 'Back to your trips' }}
    />
  );
}
