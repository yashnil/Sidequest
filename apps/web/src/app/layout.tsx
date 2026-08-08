import type { Metadata, Viewport } from 'next';
import './globals.css';

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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col paper-grain">{children}</body>
    </html>
  );
}
