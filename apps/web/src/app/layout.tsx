import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Fraunces, JetBrains_Mono } from 'next/font/google';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import './globals.css';

/*
 * PRODUCTION PASS — THE FIELD ATLAS PAIRING, SELF-HOSTED AT BUILD TIME.
 *
 * Fraunces (variable: optical size, SOFT, WONK) carries the voice — place
 * names, headlines, the wordmark. Its SOFT axis rounds the serifs so a
 * destination reads warm and hand-lettered at display size, and its optical
 * sizes keep it sturdy at card size, where Newsreader (V8) read quiet and
 * Instrument Serif (Production UI V1) went spindly. Bricolage Grotesque
 * (variable: optical size) carries every row a traveller scans: a grotesk with
 * enough character to be recognisable, generous counters at 15 px. JetBrains
 * Mono sets the figures a traveller compares — clock times, durations,
 * distances, coordinates — so they align without a table. All three are OFL
 * Google Fonts fetched by next/font at build time: no runtime request, no
 * layout shift. Exposed as CSS variables the theme reads.
 */
const displayFont = Fraunces({ subsets: ['latin', 'latin-ext'], axes: ['opsz', 'SOFT', 'WONK'], style: ['normal', 'italic'], variable: '--font-fraunces', display: 'swap' });
const uiFont = Bricolage_Grotesque({ subsets: ['latin', 'latin-ext'], axes: ['opsz'], variable: '--font-bricolage', display: 'swap' });
const monoFont = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-jetbrains', display: 'swap' });

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

const DESCRIPTION =
  'Answer one questionnaire and get a region, not a destination: the famous stops, the quiet ones, and an honest account of what to skip.';

/**
 * V9 §11 — INSTALLABLE AND SHAREABLE.
 *
 * `manifest` links the generated web manifest so a browser offers "Add to
 * Home Screen"; `openGraph` gives a pasted link a name and a description
 * (the share page adds its own picture). `metadataBase` makes the picture's
 * URL absolute when the deployment knows its own address.
 */
const baseUrl = process.env.SIDEQUEST_BASE_URL?.trim();

export const metadata: Metadata = {
  title: 'Sidequest — trips built around how you actually travel',
  description: DESCRIPTION,
  ...(baseUrl ? { metadataBase: new URL(baseUrl) } : {}),
  manifest: '/manifest.webmanifest',
  openGraph: {
    siteName: 'Sidequest',
    type: 'website',
    title: 'Sidequest — trips built around how you actually travel',
    description: DESCRIPTION,
  },
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
    <html lang="en" className={`${displayFont.variable} ${uiFont.variable} ${monoFont.variable}`}>
      <body className="flex min-h-dvh flex-col paper-grain">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
