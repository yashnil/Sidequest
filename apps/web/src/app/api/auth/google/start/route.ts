import { NextResponse, type NextRequest } from 'next/server';
import { authProviders } from '@/lib/auth/config';
import { googleAuthorizationUrl, newCodeVerifier, safeReturnTo } from '@/lib/auth/google';
import { redirectToPublicPath } from '@/lib/auth/redirects';
import { createAuthState } from '@/lib/db/auth-repository';
import { bindOAuthState } from '@/lib/auth/oauth-state';
import { guardAction, sessionToken } from '@/lib/net/caller';

export const dynamic = 'force-dynamic';

/**
 * Begin the Google round trip: mint a state and a PKCE verifier, remember
 * where to return and which browser cookie was presented (so the claim offer
 * after sign-in is about this browser's trips), and redirect.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (!authProviders().google) return redirectToPublicPath('/signin?error=unavailable');
  /* Production pass — every GET writes a state row, so it is fenced like any other row-writing door. */
  if (await guardAction('auth_start')) return redirectToPublicPath('/signin?error=busy');
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const codeVerifier = newCodeVerifier();
  const state = createAuthState({ provider: 'google', codeVerifier, returnTo, ownerToken: await sessionToken({ mint: false }) });
  const url = googleAuthorizationUrl({ state, codeVerifier });
  if (!url) return redirectToPublicPath('/signin?error=unavailable');
  /* Production pass — bind the state to this browser (login CSRF; see `oauth-state.ts`). */
  await bindOAuthState(state);
  return NextResponse.redirect(url);
}
