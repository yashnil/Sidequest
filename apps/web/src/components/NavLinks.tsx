'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';

/**
 * V8 — THE HEADER'S PLACES, WITH A DESIGNED ACTIVE STATE.
 *
 * A route knows where it is; the header should too. The active place is a
 * filled ink pill rather than a default text link, so "you are in Trips" is
 * read at a glance. Client-side only for the pathname; the links themselves
 * are plain anchors the server rendered.
 */
const LINK =
  'inline-flex min-h-11 shrink-0 items-center rounded-full px-3.5 text-sm font-medium transition-colors duration-[var(--motion-fast)] focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

/** Which header place a path belongs to. Plain data, so the server can hand the list across the client boundary. */
function isActive(place: 'trips' | 'explore', pathname: string): boolean {
  if (place === 'trips') return pathname === '/trips' || (pathname.startsWith('/trips/') && !pathname.startsWith('/trips/new'));
  return pathname.startsWith('/decide');
}

export function NavLinks({ items }: { items: { href: string; label: string; testId: string; place: 'trips' | 'explore' }[] }) {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="Primary" className="ml-1 hidden items-center gap-1 sm:ml-3 sm:flex">
      {items.map((item) => {
        const active = isActive(item.place, pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cx(LINK, active ? 'bg-ink text-paper' : 'text-ink-muted hover:bg-paper-sunk hover:text-ink')}
            data-testid={item.testId}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The footer's one sentence, hidden on the surfaces that own the whole
 * screen: the build (a dark atlas that should end at the bottom edge) and the
 * flows whose bottom edge is a sticky action bar.
 */
export function ChromeFooter({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  if (/^\/trips\/[^/]+\/build$/.test(pathname)) return null;
  return (
    <footer className="mt-12 border-t border-rule max-sm:pb-[calc(7rem+env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-[1600px] px-5 py-6 sm:px-6">
        <p className="type-small text-ink-muted">{children}</p>
      </div>
    </footer>
  );
}
