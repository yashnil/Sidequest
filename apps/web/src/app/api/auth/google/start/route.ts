import { NextResponse, type NextRequest } from 'next/server';
import { authProviders } from '@/lib/auth/config';
import { googleAuthorizationUrl, newCodeVerifier, safeReturnTo } from '@/lib/auth/google';
import { createAuthState } from '@/lib/db/auth-repository';
import { sessionToken } from '@/lib/net/caller';

export const dynamic = 'force-dynamic';

/**
 * Begin the Google round trip: mint a state and a PKCE verifier, remember
 * where to return and which browser cookie was presented (so the claim offer
 * after sign-in is about this browser's trips), and redirect.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (!authProviders().google) return NextResponse.redirect(new URL('/signin?error=unavailable', request.url));
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const codeVerifier = newCodeVerifier();
  const state = createAuthState({ provider: 'google', codeVerifier, returnTo, ownerToken: await sessionToken({ mint: false }) });
  const url = googleAuthorizationUrl({ state, codeVerifier });
  if (!url) return NextResponse.redirect(new URL('/signin?error=unavailable', request.url));
  return NextResponse.redirect(url);
}
