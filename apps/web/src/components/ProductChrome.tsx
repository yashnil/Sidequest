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
      {/*
        OPAQUE, NOT FROSTED.

        `bg-paper/85 backdrop-blur-sm` let card text ghost through the bar as it
        scrolled under: a blur that small does not dissolve 14px type, it smears
        it, so the wordmark sat on top of a legible-but-wrong second line of text
        on every long page in the product — the Discovery Board and the itinerary
        being the two longest. A solid ground costs nothing and is the only way a
        sticky header over dense editorial content stays readable.
      */}
      {/*
        EXPERIENCE V2 — A RESTRAINED SHELL, 56 PX TALL.

        Wordmark, room in the middle for the page's own trip context (rendered by
        the page beneath this bar, since the shell may not name a place — see
        `shell.spec.ts`), and the one utility link. Opaque, not frosted: 14 px
        type under a small blur smears rather than dissolves.
      */}
      <header className="sticky top-0 z-30 border-b border-rule bg-paper" data-testid="product-chrome">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-5 py-1.5 sm:px-6">
          <Link href="/" className="inline-flex min-h-11 shrink-0 items-center font-display text-[1.375rem] leading-none tracking-tight text-ink" aria-label="Sidequest home">
            Sidequest
          </Link>
          <span className="flex-1" />
          <Link href="/trips/new" className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm text-ink-muted hover:bg-paper-sunk hover:text-ink">
            New trip
          </Link>
        </div>
      </header>
      {/*
        `tabIndex={-1}`, which is what makes the skip link work.

        Without it the anchor moves the *scroll* to the main landmark and leaves
        keyboard focus exactly where it was — in the header — so the next Tab
        goes back to "New trip" and the skip has skipped nothing. A `main` is
        not focusable by default; this makes it a programmatic focus target
        without putting it in the tab order.
      */}
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <footer className="mt-12 max-sm:pb-[calc(7rem+env(safe-area-inset-bottom))] border-t border-rule">
        <div className="mx-auto max-w-[1600px] px-5 py-6 sm:px-6">
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
