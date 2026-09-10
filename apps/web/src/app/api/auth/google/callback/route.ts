import { NextResponse, type NextRequest } from 'next/server';
import { authProviders } from '@/lib/auth/config';
import { exchangeGoogleCode, safeReturnTo } from '@/lib/auth/google';
import { signInUser } from '@/lib/auth/session';
import { consumeAuthState, upsertUser } from '@/lib/db/auth-repository';

export const dynamic = 'force-dynamic';

/**
 * Finish the Google round trip. Every failure lands back on the sign-in page
 * with a one-word reason the page turns into a sentence; nothing is signed
 * in on any failure, and the state row is consumed whatever happens.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const back = (reason: string) => NextResponse.redirect(new URL(`/signin?error=${reason}`, request.url));
  if (!authProviders().google) return back('unavailable');
  const params = request.nextUrl.searchParams;
  const state = params.get('state') ?? '';
  const stored = consumeAuthState(state);
  if (!stored || stored.provider !== 'google') return back('state');
  if (params.get('error') || !params.get('code')) return back('denied');
  try {
    const identity = await exchangeGoogleCode({ code: params.get('code')!, codeVerifier: stored.codeVerifier });
    const user = upsertUser({ provider: 'google', subject: identity.subject, email: identity.email, emailVerified: identity.emailVerified, displayName: identity.name, pictureUrl: identity.picture });
    await signInUser(user.id);
  } catch (error) {
    console.warn('Google sign-in did not complete', { reason: error instanceof Error ? error.message : 'unknown' });
    return back('exchange');
  }
  return NextResponse.redirect(new URL(safeReturnTo(stored.returnTo), request.url));
}
