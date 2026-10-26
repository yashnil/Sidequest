import type { NextConfig } from 'next';

/**
 * SECURITY HEADERS, DECLARED WHERE EVERY ROUTE INHERITS THEM.
 *
 * Exported as a function of the environment so a unit test can assert the
 * production policy without booting a server — the running dev server does not
 * reflect edits to this file until it restarts, so the test is the check that
 * exists *now* and the restart is when the headers become observable.
 *
 * The CSP names what the product actually loads and nothing more:
 *
 * - **Scripts and styles are self plus inline.** Next injects inline bootstrap
 *   scripts and style tags; there is no third-party script anywhere in the
 *   product and this policy is what keeps it that way. Development adds
 *   `unsafe-eval` because React Refresh evaluates — production does not.
 * - **Images: self, data URIs, and Wikimedia.** Place and destination imagery
 *   is served from `upload.wikimedia.org` by deliberate decision (see
 *   `wikimedia.ts`); the coordinate-derived fallback graphics are data URIs.
 *   Open-Meteo never appears here: weather is fetched server-side and arrives
 *   in the page as numbers, not as a browser request.
 * - **connect-src self** — every client fetch is a server action on this
 *   origin. Development adds websockets for hot reload.
 * - **frame-ancestors none**: nothing embeds this product; refusing framing is
 *   free clickjacking protection.
 */
export function securityHeaders(options: { dev: boolean }): { key: string; value: string }[] {
  const scriptExtras = options.dev ? " 'unsafe-eval'" : '';
  const connectExtras = options.dev ? ' ws: wss:' : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${scriptExtras}`,
    "style-src 'self' 'unsafe-inline'",
    /*
     * QUALITY V1 — the optional OpenFreeMap basemap (`SIDEQUEST_MAP_PROVIDER=openfreemap`).
     * Vector tiles, glyphs and sprites come from tiles.openfreemap.org; MapLibre
     * renders them in a worker from a blob URL. Listed unconditionally: a host
     * in a CSP is not a request, and the map only reaches it when configured.
     */
    /*
     * PRODUCTION PASS — the landing globe's relief: AWS Terrain Tiles (open
     * data, Terrarium PNGs) from `s3.amazonaws.com/elevation-tiles-prod`.
     * MapLibre fetches raster-dem tiles with `fetch`, so the host is needed in
     * connect-src as well as img-src.
     */
    "img-src 'self' data: blob: https://upload.wikimedia.org https://thumb.wikimedia.org https://commons.wikimedia.org https://tiles.openfreemap.org https://s3.amazonaws.com",
    "font-src 'self' data:",
    `connect-src 'self' https://tiles.openfreemap.org https://s3.amazonaws.com${connectExtras}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    /*
     * A year, subdomains included. Harmless on localhost — browsers ignore HSTS
     * over plain http — and load-bearing the moment this is served over TLS.
     */
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    /*
     * PRODUCTION PASS — powerful features this product never uses are refused
     * outright, so an injected script or a framed page cannot ask for them.
     * Geolocation included: nothing in `src/` reads the device position. If a
     * feature starts needing one, allow `self` for that feature only.
     */
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
  ];
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=(), interest-cohort=()';

/**
 * PRODUCTION PASS — paths that must never be indexed even when robots allows
 * the site: a share link is a capability URL and a trip page is private, so a
 * search engine that learns either from a link elsewhere still must not list it.
 */
export const NOINDEX_SOURCES = ['/share/:path*', '/trips/:path*', '/api/:path*', '/profile', '/labs/:path*'];

const nextConfig: NextConfig = {
  transpilePackages: ['@sidequest/bench', '@sidequest/core', '@sidequest/geo', '@sidequest/planner'],
  serverExternalPackages: ['better-sqlite3'],
  typedRoutes: false,
  /** Advertising the framework in a response header helps exactly one audience. */
  poweredByHeader: false,
  /*
   * PRODUCTION PASS — nothing renders `next/image`, so the optimizer endpoint
   * (`/_next/image`) only ever served as attack surface (the 16.3 SSRF/RCE
   * advisories). Images are served as-is.
   */
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({ dev: process.env.NODE_ENV === 'development' }),
      },
      ...NOINDEX_SOURCES.map((source) => ({ source, headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] })),
      /*
       * V9 §11 — the trip service worker. `no-cache` so a browser revalidates
       * the worker file on every check and a new version actually replaces the
       * old one; `Service-Worker-Allowed: /` so a worker served from the site
       * root may control the trip, Today, Pack and share pages.
       */
      {
        source: '/trip-offline-sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
