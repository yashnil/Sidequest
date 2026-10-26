import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { secureCookiesEnabled } from '../net/caller';
import { sessionSigningKey } from '../net/session-signature';
import { AUTH_STATE_LIFETIME_MINUTES } from '../db/auth-repository';

/**
 * PRODUCTION PASS — THE OAUTH `state` IS BOUND TO THE BROWSER THAT STARTED IT.
 *
 * The state row alone proved only that *somebody* started a sign-in. An
 * attacker could start one, stop at Google's redirect, and send the callback
 * URL to a victim, who would then be signed into the attacker's account — and,
 * on pressing "save my trips", move their trips into it (login CSRF).
 *
 * So `/start` sets a short-lived httpOnly cookie holding an HMAC of the state,
 * and `/callback` refuses unless the browser presenting the state also presents
 * that cookie. The cookie is cleared on every callback, so it is one-time. A
 * victim's browser never has the attacker's cookie, and the attacker cannot
 * set one for this origin.
 *
 * SameSite=Lax because the callback is a top-level GET navigation from Google,
 * which Lax cookies accompany; scoped to `/api/auth` so no other request carries it.
 */
export const OAUTH_BINDING_COOKIE = 'sidequest_oauth';

function bindingFor(state: string): string | null {
  const key = sessionSigningKey();
  if (!key) return null;
  return createHmac('sha256', key).update(`oauth-state:${state}`).digest('base64url');
}

function cookieOptions(maxAge: number) {
  return { httpOnly: true, sameSite: 'lax' as const, path: '/api/auth', maxAge, secure: secureCookiesEnabled() };
}

/** At `/start`: remember, in this browser, which state it was handed. */
export async function bindOAuthState(state: string): Promise<void> {
  const value = bindingFor(state);
  if (!value) return;
  (await cookies()).set(OAUTH_BINDING_COOKIE, value, cookieOptions(AUTH_STATE_LIFETIME_MINUTES * 60));
}

/** At `/callback`: does this browser hold the binding for this state? Clears the binding either way. */
export async function takeOAuthBinding(state: string): Promise<boolean> {
  const jar = await cookies();
  const presented = jar.get(OAUTH_BINDING_COOKIE)?.value ?? '';
  jar.set(OAUTH_BINDING_COOKIE, '', cookieOptions(0));
  const expected = bindingFor(state);
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
