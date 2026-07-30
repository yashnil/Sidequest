import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

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
      <body className="min-h-dvh paper-grain">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        <header className="border-b border-rule">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
            <Link href="/" className="font-display text-xl tracking-tight text-ink">
              Sidequest
            </Link>
            <span className="text-xs uppercase tracking-[0.18em] text-ink-faint">
              Eastern Sierra
            </span>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="mt-20 border-t border-rule">
          <div className="mx-auto max-w-6xl px-5 py-8 text-xs leading-relaxed text-ink-faint sm:px-8">
            Place data is curated and approximate. Seasonal access in the Eastern Sierra moves by
            weeks with the snowpack — check the official source linked on each card before you
            commit to a plan.
          </div>
        </footer>
      </body>
    </html>
  );
}
