import Link from 'next/link';
import { buttonClass } from '@/components/ui';

/**
 * Not found, on a trip route.
 *
 * Deeper than it looks like it should be, and deliberately. A not-found file in
 * the `(product)` group would sit at the same routing level as the root's,
 * because a route group is not a URL segment — and Next would then embed *this*
 * boundary, chrome and all, in the flight payload of every route in the
 * application. Including `/labs/benchmark`, whose whole purpose is that the
 * product's name does not appear on it.
 *
 * Three questions, in order: what happened, what is preserved, what to do now.
 * "It was created against a database that has since been cleared" was our word
 * for what happened, about our infrastructure, and a traveller could do nothing
 * with it except worry. What they need is whether their other trips are
 * affected, and a way on.
 */
export default function ProductNotFound() {
  return (
    <div className="mx-auto max-w-xl px-5 py-20 sm:px-8 sm:py-24">
      <div className="card-raised enter rounded-[var(--radius-panel)] p-6 text-center sm:p-8">
        <p className="eyebrow">Your trips are safe</p>
        <h1 className="display-lg mt-3 text-ink">We cannot find that trip</h1>
        <p className="mt-3 type-body text-ink-muted">The link may be old, or the trip may have been removed.</p>
        <p className="mt-1 type-small text-ink-muted">Anything else you have planned is unaffected.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link href="/trips" className={buttonClass('primary')}>
            Your trips
          </Link>
          <Link href="/trips/new" className={buttonClass('secondary')}>
            Start a new trip
          </Link>
        </div>
      </div>
    </div>
  );
}
