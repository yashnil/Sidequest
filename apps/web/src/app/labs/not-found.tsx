import Link from 'next/link';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY } from '@/components/benchmark/copy';
import { Panel, buttonClass } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * A 404 THAT DOES NOT ANNOUNCE THE PRODUCT.
 *
 * This exists because of a leak found by pointing the browser check at a URL
 * that did not resolve. Next serves the *closest* `not-found`, and with none
 * under `/labs` every miss here fell through to the application's — which
 * renders the full product chrome: the wordmark in the header, a "New trip"
 * link, and a footer paragraph naming the product three times. A reviewer who
 * mistyped a session id, or followed a stale link, would have been told exactly
 * what they were reviewing.
 *
 * The reason it was easy to miss is that nothing in the comparison's own code
 * was wrong. The leak was in a page nobody thought of as part of this surface,
 * reached by a path nobody had walked. That is also the argument for asserting
 * on `page.content()` rather than only on the source.
 */
export default function LabsNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-3 py-16 sm:px-8">
      <Panel className="p-5">
        <h1 className="font-display text-2xl text-ink">{NEUTRAL_COPY.errorTitle}</h1>
        <p className="measure mt-3 text-sm leading-relaxed text-ink-muted">
          {NEUTRAL_COPY.errorBody}
        </p>
        <Link href="/labs/benchmark" className={`${buttonClass('secondary')} mt-5`}>
          {LABS_COPY.homeLabel}
        </Link>
      </Panel>
    </div>
  );
}
