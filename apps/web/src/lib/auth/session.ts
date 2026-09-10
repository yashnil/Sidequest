import 'server-only';
import { cookies, headers } from 'next/headers';
import { createSession, revokeSession, userForSessionToken, type UserRecord } from '../db/auth-repository';
import { secureCookiesEnabled } from '../net/caller';
import { AUTH_COOKIE } from './config';

/**
 * THE SIGNED-IN USER OF THIS REQUEST, OR NULL.
 *
 * Read from the `sidequest_auth` cookie against `auth_sessions`. Outside a
 * request scope (a worker, a test) there is no cookie jar and no user; that
 * is the same internal-caller shape `trip-access.ts` already documents.
 */
export async function currentUser(): Promise<UserRecord | null> {
  try {
    const jar = await cookies();
    const token = jar.get(AUTH_COOKIE)?.value;
    if (!token) return null;
    return userForSessionToken(token);
  } catch {
    return null;
  }
}

export async function currentUserId(): Promise<string | null> {
  return (await currentUser())?.id ?? null;
}

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

/** Mint a session for the user and set the cookie. Only callable where cookies can be written (actions, route handlers). */
export async function signInUser(userId: string): Promise<void> {
  const userAgent = await headers()
    .then((h) => h.get('user-agent'))
    .catch(() => null);
  const { token } = createSession(userId, { userAgent });
  const jar = await cookies();
  jar.set(AUTH_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_COOKIE_MAX_AGE_SECONDS, secure: secureCookiesEnabled() });
}

export async function signOutUser(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(AUTH_COOKIE)?.value;
  if (token) revokeSession(token);
  jar.set(AUTH_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, secure: secureCookiesEnabled() });
}
