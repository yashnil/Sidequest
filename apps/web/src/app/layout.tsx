import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

/**
 * THE GLOBAL SHELL, WHICH NOW BELONGS TO NO PARTICULAR PLACE.
 *
 * What was here before: a fixed `EASTERN SIERRA` label beside the wordmark, and
 * a footer explaining that seasonal access moves with the snowpack. Both were
 * true of one valley in California and shown to somebody planning Kyrgyzstan.
 *
 * The replacement rule is simple and enforced by `shell.spec.ts`: **the shell
 * may not name a place.** Anything about where the traveller is going comes from
 * a persisted trip and is rendered by the page, not by the chrome.
 *
 * The footer says the three things that are true of every destination this
 * product will ever plan — the data is somebody else's, it is incomplete, and it
 * is frozen at compile time — and says them quietly, because a disclaimer that
 * dominates a page is one nobody reads.
 */

export const metadata: Metadata = {
  title: 'Sidequest — trips built around how you actually travel',
  description:
    'Answer one questionnaire and get a region, not a destination: the famous stops, the quiet ones, and an honest account of what to skip.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col paper-grain">
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
            <Link
              href="/trips/new"
              className="shrink-0 text-sm text-ink-muted hover:text-pine"
            >
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
      </body>
    </html>
  );
}
