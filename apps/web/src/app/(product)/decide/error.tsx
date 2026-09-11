'use client';

import { RouteFailure } from '@/components/RouteFailure';

/**
 * WHEN "HELP ME DECIDE" BREAKS.
 *
 * On this route there is no trip yet, so the sentence that matters is about
 * the decision session: it is a row written the moment the four questions are
 * submitted, and its id is in the URL, which is what makes a retry free. See
 * `components/RouteFailure` for the shared promises.
 */
export default function DecideError({ error, reset, retry }: { error: Error & { digest?: string }; reset: () => void; retry?: () => void }) {
  return (
    <RouteFailure
      error={error}
      reset={reset}
      retry={retry}
      route="decide"
      eyebrow="Where should I go"
      heading="This page hit a problem."
      preserved="Your answers are saved — they were stored the moment you submitted them, and this page is the only thing that failed."
      detail="Retrying reloads the page from what is stored."
      secondary={{ href: '/decide', label: 'Start a new search' }}
    />
  );
}
