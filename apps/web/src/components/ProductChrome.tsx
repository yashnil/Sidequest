import Link from 'next/link';
import type { ChromeAccount } from '@/lib/auth/chrome';
import { MobileNav } from './MobileNav';
import { SignOutButton } from './SignOutButton';

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
 *
 * V6 §33 — the navigation.
 *
 * - Signed out: Sidequest · Trips · New trip · Sign in.
 * - Signed in: Sidequest · Trips · Explore · New trip · the account.
 *
 * **Explore is a signed-in door.** It used to sit in the header for everybody,
 * hidden below `sm`, which put a fourth destination in front of a first-time
 * visitor whose only question is "what is this". The landing page already
 * carries "Help me decide where to go" as one of its three doors, so nothing is
 * unreachable; the header simply stops competing with it.
 *
 * On a phone the header keeps the wordmark and the account only, and the real
 * navigation is `MobileNav` — a bottom bar, under the thumb, on the surfaces
 * that do not already own the bottom of the screen.
 *
 * ## Heights are load-bearing here
 *
 * `globals.chrome.test.ts` derives `--chrome-height` from this file's own class
 * names: the header row's `py-*`, and the tallest `min-h-*` in the file. Six
 * sticky surfaces are pinned under the header with that token. Adding a control
 * taller than `min-h-11`, or changing the row's padding, moves the header and
 * must move the token with it — the test says so with the arithmetic.
 *
 * ## The account arrives as a prop, and the component is synchronous
 *
 * Reading the session cookie here made this an async component, and an async
 * component nested inside another one suspends — which is fine in a request and
 * fatal in `renderToStaticMarkup`, where a unit test renders the home page to a
 * string. `chromeAccount()` does the reading in the layout that mounts this, so
 * the shell stays a plain function of its props.
 */
export function ProductChrome({ children, account }: { children: React.ReactNode; account: ChromeAccount }) {
  const user = account.user;
  const signInAvailable = account.signInAvailable;
  const initials = user ? (user.displayName ?? user.email ?? '?').trim().charAt(0).toUpperCase() : null;
  const navLink =
    'inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm text-ink-muted transition-colors hover:bg-paper-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/95 backdrop-blur-sm" data-testid="product-chrome">
        <div className="mx-auto flex max-w-[1600px] items-center gap-1 px-5 py-1.5 sm:gap-2 sm:px-6">
          <Link
            href="/"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 font-display text-[1.375rem] leading-none tracking-tight text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
            aria-label="Sidequest home"
          >
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-accent" />
            Sidequest
          </Link>
          <nav aria-label="Primary" className="ml-1 flex items-center gap-1 sm:ml-3">
            {/* On a phone these are in the bottom bar instead; two navigations at once is one too many. */}
            <Link href="/trips" className={`${navLink} max-sm:hidden`} data-testid="nav-trips">
              Trips
            </Link>
            {user ? (
              <Link href="/decide" className={`${navLink} max-sm:hidden`} data-testid="nav-explore">
                Explore
              </Link>
            ) : null}
          </nav>
          <span className="flex-1" />
          <Link
            href="/trips/new"
            className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-rule px-3.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2 max-sm:hidden"
            data-testid="nav-new-trip"
          >
            New trip
          </Link>
          {user ? (
            <details className="relative" data-testid="nav-account">
              <summary
                className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full px-2 text-sm text-ink hover:bg-paper-sunk focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"
                aria-label="Your account"
              >
                <span aria-hidden="true" className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink text-xs font-medium text-paper">
                  {initials}
                </span>
              </summary>
              <div className="absolute right-0 z-40 mt-1 w-60 rounded-[var(--radius-panel)] border border-rule bg-paper-raised p-1.5 shadow-[var(--shadow-card)]">
                <p className="truncate px-2.5 pt-1.5 pb-2 text-sm font-medium text-ink" data-testid="nav-account-name">
                  {user.displayName ?? user.email}
                </p>
                <Link
                  href="/profile"
                  className="block min-h-11 rounded-[var(--radius-control)] px-2.5 py-2.5 text-sm text-ink hover:bg-paper-sunk focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                  data-testid="nav-profile"
                >
                  Travel profile
                </Link>
                <SignOutButton />
              </div>
            </details>
          ) : signInAvailable ? (
            <Link
              href="/signin"
              className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm text-ink-muted transition-colors hover:bg-paper-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
              data-testid="nav-signin"
            >
              Sign in
            </Link>
          ) : null}
        </div>
      </header>
      {/*
        The skip link's target, and it now shows when it has been used.
        `outline-none` was on this element: the one thing a keyboard user gets
        for pressing "Skip to content" is the knowledge that focus moved, and
        that class removed it. `focus:` rather than `focus-visible:` because the
        move is programmatic — the browser's focus-visible heuristic declines for
        a focus that did not come from a key press on this element.
      */}
      <main
        id="main"
        tabIndex={-1}
        className="flex-1 focus:outline-2 focus:outline-pine focus:outline-offset-[-4px]"
      >
        {children}
      </main>
      <footer className="mt-12 max-sm:pb-[calc(7rem+env(safe-area-inset-bottom))] border-t border-rule">
        <div className="mx-auto max-w-[1600px] px-5 py-6 sm:px-6">
          {/*
            ONE SENTENCE, NOT A DISCLAIMER PANEL.
            The paragraph here ran to four lines of small grey type on every
            screen in the product — a caveat repeated so often it stopped being
            read. What survives is the part a traveller can act on: a plan is a
            snapshot, so check the things you are about to pay for.
          */}
          <p className="type-small text-ink-muted">
            Sidequest plans from published sources and freezes a plan on the day it is built. Check
            opening times, road status and anything you are booking before you rely on it.
          </p>
        </div>
      </footer>
      <MobileNav signedIn={Boolean(user)} canSignIn={signInAvailable} />
    </>
  );
}
