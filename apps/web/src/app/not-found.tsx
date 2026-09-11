import Link from 'next/link';
import { buttonClass } from '@/components/ui';

/**
 * THE ROOT NOT-FOUND, AND WHY IT NAMES NOTHING.
 *
 * This used to render the product chrome, and that turned out to leak.
 *
 * Next includes the root not-found boundary in the flight payload of every
 * route beneath the root layout — including `/labs/benchmark`, whose entire
 * purpose is that a reviewer cannot tell which of two plans came from which
 * system, one of which is this product. Nothing was visible on screen. The
 * wordmark and the footer were simply *in the response*, which a right-click
 * reads as easily as a test does, and the leakage check caught it.
 *
 * So the boundary that every route carries says nothing about who made it —
 * and still answers the three questions a failure owes: what happened, what
 * is preserved, what to do now. The traveller-facing version with the chrome
 * and trip-shaped wording lives under `(product)/trips/[id]/not-found.tsx`.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-5 py-20 sm:px-8 sm:py-24">
      <div className="card-raised enter rounded-[var(--radius-panel)] p-6 text-center sm:p-8">
        <h1 className="display-lg text-ink">Nothing here</h1>
        <p className="mt-3 type-body text-ink-muted">That address does not lead anywhere.</p>
        <p className="mt-1 type-small text-ink-muted">Nothing you were working on is affected.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link href="/" className={buttonClass('primary')}>
            Go to the front page
          </Link>
          <Link href="/trips" className={buttonClass('secondary')}>
            Your trips
          </Link>
        </div>
      </div>
    </div>
  );
}
