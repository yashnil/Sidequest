'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * V6 §33 — THE PHONE'S BOTTOM NAVIGATION.
 *
 * Three destinations, under the thumb: the trips you have, a new one, and the
 * account. It exists because the header's row of small links is the one part of
 * the product a person cannot reach one-handed on a phone, and because "where
 * are my trips" is the question a travel app is asked most often.
 *
 * ## Where it does not appear, and why that is an allow-list
 *
 * Three surfaces already own the bottom of a phone screen: the Trip Hub's own
 * four-view bar (rendered inside `ItineraryView`, `data-testid="trip-hub-bottom-nav"`),
 * the setup flow's single Continue, and the interview's build bar. Two bars
 * stacked is not a navigation, it is a mistake — and a deny-list of routes goes
 * stale the moment somebody adds a screen with its own bar.
 *
 * So this is an allow-list: the bar appears on the surfaces that are *lists and
 * settings*, never on the surfaces that are a flow. A new flow screen gets no
 * bar by default, which is the safe direction for the rule to fail in.
 */

/** Routes that are a place rather than a step, and have no bottom bar of their own. */
function showsBar(pathname: string): boolean {
  if (pathname === '/' || pathname === '/trips' || pathname === '/decide') return true;
  if (pathname === '/profile' || pathname === '/signin') return true;
  /* The party page is a settings screen hanging off a trip, and ends in a link rather than a bar. */
  return /^\/trips\/[^/]+\/party$/.test(pathname);
}

export function MobileNav({ signedIn, canSignIn }: { signedIn: boolean; canSignIn: boolean }) {
  const pathname = usePathname() ?? '/';
  if (!showsBar(pathname)) return null;

  const accountHref = signedIn ? '/profile' : '/signin';
  const items: { href: string; label: string; icon: React.ReactNode; active: boolean }[] = [
    { href: '/trips', label: 'Trips', icon: <TripsGlyph />, active: pathname === '/trips' || pathname === '/' },
    { href: '/trips/new', label: 'New trip', icon: <NewGlyph />, active: false },
  ];
  if (signedIn || canSignIn) {
    items.push({
      href: accountHref,
      label: signedIn ? 'Account' : 'Sign in',
      icon: <AccountGlyph />,
      active: pathname === accountHref,
    });
  }

  return (
    <nav
      aria-label="Sidequest"
      data-testid="product-bottom-nav"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm print:hidden sm:hidden"
    >
      <ul className="mx-auto flex max-w-md items-stretch">
        {items.map((item) => (
          <li key={item.href} className="flex-1">
            <Link
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={`relative flex min-h-[3.25rem] flex-col items-center justify-center gap-1 px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-[-2px] ${
                item.active ? 'text-ink' : 'text-ink-muted'
              }`}
            >
              <span aria-hidden="true" className={item.active ? 'text-accent' : 'text-ink-faint'}>
                {item.icon}
              </span>
              {item.label}
              {item.active ? (
                <span aria-hidden="true" className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent" />
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* Line glyphs at the weight of the product's rules, drawn rather than imported. */
const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function TripsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" {...STROKE}>
      <path d="M4 6.5 9.5 4 15 6.5 20 4v13.5L15 20l-5.5-2.5L4 20Z" />
      <path d="M9.5 4v13.5M15 6.5V20" />
    </svg>
  );
}

function NewGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" {...STROKE}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 8.25v7.5M8.25 12h7.5" />
    </svg>
  );
}

function AccountGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" {...STROKE}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c1.2-3.2 3.9-4.8 7-4.8s5.8 1.6 7 4.8" />
    </svg>
  );
}
