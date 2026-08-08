import type { Metadata } from 'next';
import Link from 'next/link';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY } from '@/components/benchmark/copy';

export const dynamic = 'force-dynamic';

/**
 * THE SHELL THAT NAMES NOTHING.
 *
 * The root layout is the document and nothing else, and the product's header,
 * wordmark and footer live in `app/(product)`. That split exists for this file:
 * a layout nests, it does not subtract, so the only way for one route to have no
 * product chrome was for the chrome to stop being in the layout every route
 * shares. What is left here is a skip link, a `main` landmark and one link back
 * to the index — and the index is called "Plan comparison", which is a
 * description of the screen rather than a name of anything.
 *
 * `robots: noindex, nofollow` because this is an internal evaluation surface. It
 * shows two competitors' output side by side and the whole exercise depends on
 * the reviewer not knowing which is which; a search result naming it would be an
 * odd way for that to leak, and costs one line to prevent.
 */

export const metadata: Metadata = {
  title: NEUTRAL_COPY.suiteName,
  description: LABS_COPY.shellDescription,
  robots: { index: false, follow: false },
};

export default function LabsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        {LABS_COPY.skipToContent}
      </a>
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-3 py-3 sm:px-8">
          <Link
            href="/labs/benchmark"
            className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-ink"
          >
            {NEUTRAL_COPY.suiteName}
          </Link>
          <span className="flex-1" />
          <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </>
  );
}
