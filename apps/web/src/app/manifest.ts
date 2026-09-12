import type { MetadataRoute } from 'next';

/**
 * V9 §11 — INSTALLABLE.
 *
 * The manifest a browser needs before it offers "Add to Home Screen": a
 * name, a start page, standalone display and icons. Colours are the design
 * system's paper and atlas grounds; the icons are the generated ones in
 * `icon.tsx`, so nothing here points at a file that can drift. Served at
 * `/manifest.webmanifest` and linked from the root layout.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sidequest',
    short_name: 'Sidequest',
    description: 'Your trips, built around how you actually travel — and with you offline.',
    start_url: '/trips',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f3ed',
    theme_color: '#101d24',
    icons: [
      { src: '/icon/app', sizes: '192x192', type: 'image/png' },
      { src: '/icon/large', sizes: '512x512', type: 'image/png' },
      { src: '/icon/large', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
