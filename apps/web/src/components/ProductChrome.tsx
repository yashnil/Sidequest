import Link from 'next/link';
import type { ChromeAccount } from '@/lib/auth/chrome';
import { MobileNav } from './MobileNav';
import { ChromeFooter, NavLinks } from './NavLinks';
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
  const places: { href: string; label: string; testId: string; place: 'trips' | 'explore' }[] = [
    { href: '/trips', label: 'Trips', testId: 'nav-trips', place: 'trips' },
    /*
     * V11 §B2 — Explore browses; `/decide` recommends.
     *
     * This pointed at `/decide`, so the header's "Explore" and the landing
     * page's "Help me choose" were two names for one screen. They are two
     * different questions: one is somebody with no idea what kind of trip they
     * want, the other is somebody ready to be asked. Explore hands off to
     * `/decide` when they are.
     */
    ...(user ? [{ href: '/explore', label: 'Explore', testId: 'nav-explore', place: 'explore' as const }] : []),
  ];
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-[var(--radius-control)] focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>
      {/*
        V8 — THE SHELL. A compact sticky bar with a wordmark that is a mark
        (the route dot before the name is the product's one glyph), the two
        places as pills with a filled active state, New trip as the single
        filled accent action, and the account as a disc. Backdrop material only
        here, where it separates the bar from a scrolling map or a dark band.
      */}
      <header className="sticky top-0 z-30 border-b border-rule/80 bg-paper/88 backdrop-blur-md" data-testid="product-chrome">
        <div className="mx-auto flex max-w-[1600px] items-center gap-1 px-5 py-1.5 sm:gap-2 sm:px-6">
          <Link
            href="/"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 font-display text-[1.5rem] leading-none tracking-tight text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
            aria-label="Sidequest home"
          >
            <span aria-hidden="true" className="relative inline-flex h-3 w-3 items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-accent/50" />
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            Sidequest
          </Link>
          <NavLinks items={places} />
          <span className="flex-1" />
          <Link
            href="/trips/new"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-paper shadow-[var(--shadow-card)] transition-[background-color,box-shadow,transform] duration-[var(--motion-fast)] hover:bg-accent-strong hover:shadow-[var(--shadow-raised)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2 max-sm:hidden"
            data-testid="nav-new-trip"
          >
            <span aria-hidden="true" className="text-base leading-none">+</span>
            New trip
          </Link>
          {user ? (
            <details className="relative" data-testid="nav-account">
              <summary
                className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full px-1.5 text-sm text-ink hover:bg-paper-sunk focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"
                aria-label="Your account"
              >
                <span aria-hidden="true" className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink font-display text-base text-paper shadow-[var(--shadow-card)]">
                  {initials}
                </span>
              </summary>
              <div className="absolute right-0 z-40 mt-2 w-64 rounded-[var(--radius-panel)] border border-rule bg-paper-raised p-1.5 shadow-[var(--shadow-float)]">
                <p className="truncate px-2.5 pt-2 pb-2.5 text-sm font-semibold text-ink" data-testid="nav-account-name">
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
              className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3.5 text-sm font-medium text-ink-muted transition-colors hover:bg-paper-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
              data-testid="nav-signin"
            >
              Sign in
            </Link>
          ) : null}
        </div>
      </header>
      {/*
        The skip link's target, and it shows when it has been used. `focus:`
        rather than `focus-visible:` because the move is programmatic.
      */}
      <main
        id="main"
        tabIndex={-1}
        className="flex-1 focus:outline-2 focus:outline-pine focus:outline-offset-[-4px]"
      >
        {children}
      </main>
      {/*
        ONE SENTENCE, NOT A DISCLAIMER PANEL. What survives is the part a
        traveller can act on: a plan is a snapshot, so check the things you are
        about to pay for. Hidden on the build screen, which owns its whole ground.
      */}
      <ChromeFooter>
        Sidequest plans from published sources and freezes a plan on the day it is built. Check opening times, road status and anything you are booking before you rely on it.
      </ChromeFooter>
      <MobileNav signedIn={Boolean(user)} canSignIn={signInAvailable} />
    </>
  );
}
