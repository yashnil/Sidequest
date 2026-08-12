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
 * product's name does not appear on it. Nothing was on screen; the wordmark was
 * simply in the response, and the leakage check found it.
 *
 * Here it applies to the routes it is actually about. "No such trip" was never
 * the right thing to say about an arbitrary bad address anyway.
 */
export default function ProductNotFound() {
  return (
    <div className="mx-auto max-w-xl px-5 py-24 text-center sm:px-8">
      <h1 className="font-display text-4xl text-ink">We cannot find that trip</h1>
      {/*
        "It was created against a database that has since been cleared" was the
        second half of this sentence. It is our word for what happened, in our
        vocabulary, about our infrastructure — and a traveller reading it can do
        nothing with it except worry. What they need is whether their other
        trips are affected, and a way on.
      */}
      <p className="mt-3 leading-relaxed text-ink-muted">
        The link may be old, or the trip may have been removed. Anything else you have planned is
        unaffected.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/" className={buttonClass('primary')}>
          Your trips
        </Link>
        <Link href="/trips/new" className={buttonClass('secondary')}>
          Start a new one
        </Link>
      </div>
    </div>
  );
}
