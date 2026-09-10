import { NextResponse } from 'next/server';
import { authProviders } from './config';

/**
 * EVERY SERVER-ISSUED REDIRECT BACK INTO SIDEQUEST IS BUILT FROM THE
 * CONFIGURED PUBLIC ORIGIN, NEVER FROM THE REQUEST THE SERVER SAW.
 *
 * Behind a platform proxy (Railway, and any `next start` bound to 0.0.0.0)
 * Next builds `request.url` in a route handler from its OWN listen address —
 * `http://localhost:${PORT}/...` (`next-server.js` `attachRequestMeta`) — not
 * from the hostname the traveller typed. `new URL(path, request.url)` therefore
 * sends a real browser to `http://localhost:8080/trips`. `Host` and
 * `X-Forwarded-Host` are not the answer either: whoever can write those headers
 * would then choose where sign-in lands. `SIDEQUEST_BASE_URL` exists precisely
 * to state the external origin, and it is already the origin Google's
 * `redirect_uri` is registered under, so the three URIs of the OAuth round trip
 * (authorize, token exchange, post-auth return) cannot drift apart.
 *
 * When no public origin is configured (local development without Google) the
 * redirect is a RELATIVE `Location`, which the browser resolves against the
 * URL it actually requested — proxy-safe by construction, and the only shape
 * that can never name an internal host.
 */

/** Where to send the browser after sign-in: only a same-origin path, never a URL. */
export function safeReturnTo(raw: string | null | undefined, fallback = '/trips'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.length > 400) return fallback;
  /*
   * `//host`, `/\host` and `\\host` are all scheme-relative to a WHATWG parser
   * (a backslash is a slash for http URLs), and a control character would
   * split the header. Any of them means "not a path".
   */
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('://')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return fallback;
  return raw;
}

/** The absolute public URL for a same-origin path, or the path itself when no public origin is configured. */
export function publicUrlFor(path: string, env: Record<string, string | undefined> = process.env): string {
  const safe = safeReturnTo(path);
  const base = authProviders(env).baseUrl;
  return base ? `${base}${safe}` : safe;
}

/**
 * A redirect into Sidequest. `path` is validated as a same-origin path first
 * (anything else becomes `/trips`), then joined to `SIDEQUEST_BASE_URL`.
 */
export function redirectToPublicPath(path: string, env: Record<string, string | undefined> = process.env): NextResponse {
  const location = publicUrlFor(path, env);
  if (location.startsWith('/')) return new NextResponse(null, { status: 307, headers: { location } });
  return NextResponse.redirect(location, 307);
}
