/**
 * THE OWNERSHIP COOKIE'S NAME, LIFETIME AND ATTRIBUTES — AND NOTHING ELSE.
 *
 * Import-free on purpose. `lib/net/caller` (which owned these) reads the
 * database and `next/headers`; `proxy.ts` must renew this cookie on a
 * traveller's way to their trips and may import neither. One definition, two
 * readers: `caller` re-exports everything here, so "the proxy renews with one
 * lifetime and the action mints with another" cannot happen.
 */

/** One cookie for the two things that need a per-browser identity. */
export const SESSION_COOKIE = 'sidequest_session';

/**
 * HOW LONG AN ANONYMOUS TRAVELLER GOES ON OWNING THEIR OWN TRIPS.
 *
 * This cookie was minted with no lifetime and no expiry, which makes it a
 * *session* cookie: the browser drops it when it quits. There are no accounts
 * in this product, and `trips.owner_token` is this value and nothing else, so
 * quitting the browser did not sign anybody out — it destroyed the only claim
 * they had. Every trip they had made became a row nobody can reach:
 * `tripAccessRefusal` refuses it, `listTrips` lists it to nobody, and there is
 * no recovery path because there is nothing to recover *to*. A compilation is
 * minutes of work and real money, and an ordinary browser quit was throwing it
 * away.
 *
 * A hundred and eighty days, because the horizon this has to cover is a trip:
 * people plan months before they leave, and the plan has to still be theirs
 * while they are standing in the destination reading it. Bounded rather than
 * indefinite — a cookie that never expires on a product that asks for no
 * account is a tracking identifier, whatever it was minted for — and inside the
 * 400-day ceiling browsers clamp cookie lifetimes to, so what is asked for is
 * what is stored rather than something quietly shorter.
 *
 * RELEASE PASS — the hundred and eighty days are measured from the traveller's
 * last visit to their trips, not from the first thing they ever did here. The
 * cookie was written exactly once, at mint, so its clock started on the first
 * action and never moved: somebody who made their first trip in January and
 * planned an August holiday in June lost every trip in July, mid-plan, with no
 * account to recover them to — the exact failure the paragraph above says this
 * lifetime exists to prevent. `proxy.ts` now re-sends the same value with a
 * fresh lifetime on the way to the trip surfaces (`renewableSessionValue`).
 * Still bounded: a browser that stays away for the whole window loses the
 * cookie, which is what "bounded rather than indefinite" was protecting.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/**
 * WHETHER THE ONE OWNERSHIP CREDENTIAL MAY CROSS PLAINTEXT.
 *
 * Minted without `Secure`, this cookie is sent on any http request to the host
 * and can be *written* by anyone who can answer one. For a value that is the
 * whole of trip ownership, that is the boundary itself travelling in the clear.
 *
 * Production is told from development the way `next.config.ts` already tells
 * them apart and by nothing else: `NODE_ENV`. That file's unconditional HSTS
 * header states the same assumption — a deployment is served over TLS.
 *
 * `NODE_ENV` alone is not enough here, and the gap is not hypothetical.
 * `next start` runs at NODE_ENV=production, and `playwright.config.ts` starts
 * exactly that on `http://127.0.0.1`: a production build over plaintext, where
 * a `Secure` cookie survives only by a browser's loopback-is-trustworthy
 * policy, which is not something this repository controls. Every trip-owning
 * journey in that suite rides on this cookie, so the one environment that
 * serves a production build without TLS pins the attribute down, on the same
 * bargain and with the same exact-string comparison as
 * `SIDEQUEST_ACTION_FENCES=off`: any other value, including a blank or a typo,
 * leaves `Secure` on, so a deployment cannot drift into plaintext by accident.
 */
export function secureCookiesEnabled(): boolean {
  if (process.env.SIDEQUEST_SECURE_COOKIES === 'off') return false;
  return process.env.NODE_ENV === 'production';
}

/**
 * The attributes the credential is written with, as a function of the
 * environment rather than of the ambient one — the same reason `securityHeaders`
 * in `next.config.ts` takes its environment as an argument: the production shape
 * is then assertable without booting a server.
 *
 * `httpOnly` because nothing in the browser reads this value; it exists to be
 * compared server-side against `trips.owner_token`. `sameSite: 'lax'` because
 * the trip surfaces are reached by ordinary top-level navigation — a
 * `/trips/{id}` link opened from a mail client must still arrive carrying the
 * owner's cookie, or the owner is refused their own trip — while the mutating
 * actions, which are cross-site POSTs when they are forged, are not.
 */
export function sessionCookieOptions(options: { secure: boolean }) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    secure: options.secure,
  };
}

/**
 * RELEASE PASS — WHETHER A PRESENTED VALUE IS ONE THE PROXY MAY WRITE BACK.
 *
 * Renewal re-sends the browser's own cookie with a fresh lifetime. It is not a
 * mint and not a validation — ownership still compares the whole value against
 * `trips.owner_token` — but a response header is not somewhere to echo
 * arbitrary client bytes, so only the shape this deployment mints (a UUID, or a
 * UUID with its sixteen-hex signature) or an older opaque token in the same
 * alphabet is renewed. Anything else is left exactly as the browser has it.
 */
export function renewableSessionValue(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{16,64}$/.test(value);
}

/**
 * RELEASE PASS — WHICH REQUESTS RENEW.
 *
 * A traveller reading their trips: a `GET` to the trip list or to anything
 * under a trip. Not every request — a `Set-Cookie` on each asset-adjacent or
 * API response is noise, and the question renewal answers is "is this browser
 * still using its trips", which those do not ask. Not `POST` — an action that
 * needs the cookie mints or reads it itself.
 */
export function renewsSessionCookie(method: string, pathname: string): boolean {
  if (method !== 'GET') return false;
  return pathname === '/trips' || pathname.startsWith('/trips/');
}
