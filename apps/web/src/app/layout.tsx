import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, Instrument_Serif } from 'next/font/google';
import './globals.css';

/*
 * PRODUCTION UI V1 — one distinctive pairing, self-hosted at build time by
 * next/font (no runtime fetch, no layout shift): Instrument Serif for
 * editorial display, Instrument Sans (variable) for everything a traveller
 * scans. Both are OFL-licensed Google Fonts. Exposed as CSS variables the
 * theme reads; system fallbacks stay in the stack.
 */
const displayFont = Instrument_Serif({ subsets: ['latin', 'latin-ext'], weight: '400', style: ['normal', 'italic'], variable: '--font-instrument-serif', display: 'swap' });
const uiFont = Instrument_Sans({ subsets: ['latin', 'latin-ext'], variable: '--font-instrument-sans', display: 'swap' });

/**
 * THE DOCUMENT, AND NOTHING ELSE.
 *
 * Everything this file used to render — the wordmark, the "New trip" link, the
 * footer — now lives in `ProductChrome` and is rendered by `app/(product)`. The
 * reason is `/labs/benchmark`, an internal surface that shows two trip plans
 * blind and must not name either system, one of which is this product. A layout
 * nests; it does not subtract. So the shared part had to become the part that is
 * genuinely shared.
 *
 * No URL moved. A route group's name never appears in a path, so `(product)` is
 * a statement about who owns the chrome and not about where anything lives.
 *
 * The title here is the default a page overrides. It is deliberately the
 * product's, because every customer-facing route wants it; `/labs` sets its own
 * and marks itself `noindex`.
 */

export const metadata: Metadata = {
  title: 'Sidequest — trips built around how you actually travel',
  description:
    'Answer one questionnaire and get a region, not a destination: the famous stops, the quiet ones, and an honest account of what to skip.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /**
   * OPTING IN, SO THE SAFE-AREA INSETS ARE NON-ZERO.
   *
   * `env(safe-area-inset-*)` resolves to `0px` unless the document asks for the
   * full viewport. Without this line every `env()` in the stylesheet is a no-op
   * — and a `padding-bottom: env(safe-area-inset-bottom)` written to *protect* a
   * control silently becomes `padding-bottom: 0` and removes the padding it was
   * meant to extend. The board's pinned action bar and the footer's clearance
   * both depend on this being set.
   */
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${uiFont.variable}`}>
      <body className="flex min-h-dvh flex-col paper-grain">{children}</body>
    </html>
  );
}
