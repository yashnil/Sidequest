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
 * So the boundary that every route carries says nothing about who made it. The
 * traveller-facing version, with the chrome and the trip-shaped wording, lives
 * at `(product)/not-found.tsx` and is what a stale trip link reaches.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-5 py-24 text-center sm:px-8">
      <h1 className="font-display text-4xl text-ink">Nothing here</h1>
      <p className="mt-3 text-ink-muted">That address does not lead anywhere.</p>
      <Link href="/" className={`${buttonClass('secondary')} mt-8`}>
        Go back
      </Link>
    </div>
  );
}
