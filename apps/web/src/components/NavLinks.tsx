'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from './ui';
import { Wordmark } from './brand/SidequestMark';

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
            className={cx(LINK, 'relative', active ? 'text-ink after:absolute after:inset-x-3.5 after:bottom-1.5 after:h-[2px] after:bg-flare' : 'text-ink-muted hover:text-ink')}
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
 * PRODUCTION PASS — THE COLOPHON.
 *
 * A field guide ends with its colophon: who made it, what it is drawn from,
 * and the small print. Here that is the mark, the one sentence a traveller can
 * act on (a plan is a snapshot — check what you pay for), the legal and
 * support pages, and the data credits every map in the product depends on.
 * Hidden on the build screen, which owns its whole ground.
 */
export function ChromeFooter({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  if (/^\/trips\/[^/]+\/build$/.test(pathname)) return null;
  const year = new Date().getFullYear();
  return (
    <footer className="mt-16 border-t-[1.5px] border-ink max-sm:pb-[calc(7rem+env(safe-area-inset-bottom))]" data-testid="chrome-footer">
      <div className="mx-auto grid max-w-[1600px] gap-8 px-5 py-10 sm:px-6 md:grid-cols-[1.2fr_1fr_1fr]">
        <div className="max-w-md">
          <Wordmark className="text-xl text-ink" markSize={22} />
          <p className="mt-3 type-small text-ink-muted">{children}</p>
        </div>
        <nav aria-label="About Sidequest" className="grid content-start gap-1 text-sm">
          <span className="sheet-label mb-1 text-ink-muted">Sidequest</span>
          <Link className="inline-flex min-h-8 w-fit items-center text-ink-muted hover:text-ink" href="/support">Help & contact</Link>
          <Link className="inline-flex min-h-8 w-fit items-center text-ink-muted hover:text-ink" href="/privacy">Privacy</Link>
          <Link className="inline-flex min-h-8 w-fit items-center text-ink-muted hover:text-ink" href="/terms">Terms</Link>
        </nav>
        <div className="grid content-start gap-1 text-sm">
          <span className="sheet-label mb-1 text-ink-muted">Map data</span>
          <p className="type-meta">
            © <a className="underline decoration-ink/20 underline-offset-2 hover:text-ink" href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · tiles by{' '}
            <a className="underline decoration-ink/20 underline-offset-2 hover:text-ink" href="https://openfreemap.org">OpenFreeMap</a> · terrain from{' '}
            <a className="underline decoration-ink/20 underline-offset-2 hover:text-ink" href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>
          </p>
          <p className="coordbar mt-2 text-ink-faint">© {year} Sidequest · a survey of places</p>
        </div>
      </div>
    </footer>
  );
}
