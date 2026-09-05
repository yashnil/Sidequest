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
    "img-src 'self' data: blob: https://upload.wikimedia.org https://commons.wikimedia.org https://tiles.openfreemap.org",
    "font-src 'self' data:",
    `connect-src 'self' https://tiles.openfreemap.org${connectExtras}`,
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
  ];
}

const nextConfig: NextConfig = {
  transpilePackages: ['@sidequest/bench', '@sidequest/core', '@sidequest/geo', '@sidequest/planner'],
  serverExternalPackages: ['better-sqlite3'],
  typedRoutes: false,
  /** Advertising the framework in a response header helps exactly one audience. */
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({ dev: process.env.NODE_ENV === 'development' }),
      },
    ];
  },
};

export default nextConfig;
