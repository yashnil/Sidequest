import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { authProviders } from './config';

/**
 * GOOGLE SIGN-IN, AS PLAIN OPENID CONNECT.
 *
 * Authorization code with PKCE, no library. The identity comes from Google's
 * `userinfo` endpoint fetched server-to-server with the access token the
 * token endpoint just issued — a TLS call to Google about a code Google just
 * minted — so no JWT is parsed or verified here and nothing from the browser
 * is trusted beyond the `code` and `state` the redirect carried, and `state`
 * is checked against a row this server wrote.
 *
 * Endpoints are Google's published, stable OIDC endpoints (the discovery
 * document at accounts.google.com/.well-known/openid-configuration names the
 * same three), pinned rather than discovered so the sign-in path makes
 * exactly two outbound requests.
 */

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleRedirectUri(baseUrl: string): string {
  return `${baseUrl}/api/auth/google/callback`;
}

export function newCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function googleAuthorizationUrl(input: { state: string; codeVerifier: string }): string | null {
  const providers = authProviders();
  if (!providers.google || !providers.baseUrl) return null;
  const params = new URLSearchParams({
    client_id: (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim(),
    redirect_uri: googleRedirectUri(providers.baseUrl),
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    code_challenge: codeChallengeFor(input.codeVerifier),
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

export interface GoogleIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Exchange the code for tokens and read the identity. Throws with a short reason on any failure; the caller renders one sentence. */
export async function exchangeGoogleCode(input: { code: string; codeVerifier: string; fetchImpl?: typeof fetch }): Promise<GoogleIdentity> {
  const providers = authProviders();
  if (!providers.google || !providers.baseUrl) throw new Error('google_not_configured');
  const doFetch = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim(),
    client_secret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim(),
    redirect_uri: googleRedirectUri(providers.baseUrl),
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
  });
  const tokenResponse = await doFetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12_000) });
  if (!tokenResponse.ok) throw new Error('token_exchange_failed');
  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error('no_access_token');
  const infoResponse = await doFetch(USERINFO_ENDPOINT, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(12_000) });
  if (!infoResponse.ok) throw new Error('userinfo_failed');
  const info = (await infoResponse.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!info.sub) throw new Error('no_subject');
  return { subject: info.sub, email: info.email ?? null, emailVerified: info.email_verified === true, name: info.name ?? null, picture: info.picture ?? null };
}

export { safeReturnTo } from './redirects';
