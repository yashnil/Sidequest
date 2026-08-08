import Link from 'next/link';

/**
 * THE PRODUCT'S OWN SHELL, WHICH NO LONGER BELONGS TO THE DOCUMENT.
 *
 * This was the body of the root layout. It moved because the root layout is the
 * one component every route in the application shares, and one route now must
 * not show any of it.
 *
 * `/labs/benchmark` renders two trip plans side by side without telling the
 * reviewer which system produced which, and one of the two systems is this
 * product. A wordmark in the header, a "New trip" link and a footer paragraph
 * that all name it would put the word on a page whose whole purpose is that the
 * word is absent — and would force the automated leakage check to carve out an
 * exception, which is the point at which such a check stops being worth having.
 *
 * So the root layout is now the document and nothing else, this component holds
 * the chrome, and the two route groups each decide whether they want it. Nothing
 * about the customer journey changed: the URLs are identical, because a route
 * group's name never appears in a path.
 *
 * The rule that was here before still stands and is still enforced by
 * `shell.spec.ts`: **the shell may not name a place.** Anything about where the
 * traveller is going comes from a persisted trip and is rendered by the page.
 */
export function ProductChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/85 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3.5 sm:px-8">
          <Link
            href="/"
            className="shrink-0 font-display text-xl tracking-tight text-ink"
            aria-label="Sidequest home"
          >
            Sidequest
          </Link>
          {/*
            Nothing else lives up here.

            Trip context is rendered by the page that knows about the trip,
            immediately below this bar. The alternative — a slot the layout
            fills — would mean the shell reading the database on every request
            to decide what to say, which is how a global header comes to hold a
            destination-specific claim in the first place.
          */}
          <span className="flex-1" />
          <Link href="/trips/new" className="shrink-0 text-sm text-ink-muted hover:text-pine">
            New trip
          </Link>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="mt-16 border-t border-rule">
        <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8">
          <p className="measure text-xs leading-relaxed text-ink-faint">
            Sidequest plans from published sources — map data, official pages, climate records —
            and each of them is incomplete somewhere. A finished plan is frozen to the day it was
            built and will not notice a change made afterwards. Check opening times, road status
            and anything you are booking against the official source shown on the card.
          </p>
        </div>
      </footer>
    </>
  );
}
