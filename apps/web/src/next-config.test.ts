import { describe, expect, it } from 'vitest';
import nextConfig, { securityHeaders } from '../next.config';

/**
 * THE SECURITY HEADERS, ASSERTED WITHOUT A SERVER.
 *
 * The running dev server keeps whatever config it started with, so the check
 * that exists *now* is this one: the policy function itself, and the config
 * wiring that serves it on every route. What matters most is the production
 * shape — `unsafe-eval` is a development concession for React Refresh and must
 * never appear outside it.
 */

function headerMap(options: { dev: boolean }): Map<string, string> {
  return new Map(securityHeaders(options).map((entry) => [entry.key, entry.value]));
}

describe('the security header policy', () => {
  it('locks framing, sniffing, referrers and transport', () => {
    const headers = headerMap({ dev: false });
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('allows exactly the image hosts the product renders, and no script host at all', () => {
    const csp = headerMap({ dev: false }).get('Content-Security-Policy')!;
    // Wikimedia imagery is a deliberate decision (see wikimedia.ts); the
    // fallback graphics are data URIs. Nothing else loads into an <img>.
    expect(csp).toContain(
      "img-src 'self' data: https://upload.wikimedia.org https://commons.wikimedia.org",
    );
    // No third-party script origin, ever. Open-Meteo is server-side and must
    // not appear anywhere in a browser policy.
    expect(csp).not.toContain('open-meteo');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('keeps unsafe-eval a development-only concession', () => {
    expect(headerMap({ dev: false }).get('Content-Security-Policy')).not.toContain('unsafe-eval');
    expect(headerMap({ dev: true }).get('Content-Security-Policy')).toContain('unsafe-eval');
  });

  it('is wired onto every route, with the framework banner off', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    const keys = rules[0]!.headers.map((entry) => entry.key);
    expect(keys).toContain('Content-Security-Policy');
    expect(keys).toContain('Strict-Transport-Security');
  });
});
