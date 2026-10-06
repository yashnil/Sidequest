/**
 * WHICH SIGN-IN DOORS THIS DEPLOYMENT HAS. Import-free, like `switches.ts`,
 * so the capability registry, the doctor and the pages agree.
 *
 * - `google`: OpenID Connect with PKCE against Google, on when a client id
 *   and secret are set and the deployment knows its own public origin.
 * - `fixture`: an email-only door for the browser suite and local
 *   development. Refused in production unless `SIDEQUEST_AUTH_FIXTURE=allow`
 *   is set explicitly — a deployment must not drift into a passwordless
 *   sign-in because a test variable leaked into its environment.
 */
export interface AuthProviders {
  google: boolean;
  fixture: boolean;
  /** True when at least one door is open. When false, nothing in the product mentions signing in. */
  any: boolean;
  baseUrl: string | null;
}

export function authProviders(env: Record<string, string | undefined> = process.env): AuthProviders {
  const baseUrl = (env.SIDEQUEST_BASE_URL ?? '').trim().replace(/\/+$/, '') || null;
  const google = Boolean((env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim() && (env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim() && baseUrl);
  const fixtureAsked = (env.SIDEQUEST_AUTH_PROVIDER ?? '').trim().toLowerCase() === 'fixture';
  /*
   * V1 CONVERGENCE — ONE DOOR. `SIDEQUEST_ACTION_FENCES=off` used to unlock
   * this too, which made a rate-limit switch (set by the browser suite, and
   * plausibly by an operator chasing a throttling bug) a passwordless
   * sign-in switch in production. Only the explicit allow opens it now.
   */
  const fixture = fixtureAsked && (env.NODE_ENV !== 'production' || (env.SIDEQUEST_AUTH_FIXTURE ?? '').trim() === 'allow');
  return { google, fixture, any: google || fixture, baseUrl };
}

export const AUTH_COOKIE = 'sidequest_auth';
