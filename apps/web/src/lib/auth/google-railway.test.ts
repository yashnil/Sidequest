import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE GOOGLE ROUND TRIP UNDER RAILWAY SEMANTICS.
 *
 * On Railway `next start` listens on 0.0.0.0:$PORT, and Next builds every
 * route handler's `request.url` from that listen address:
 * `http://localhost:8080/api/auth/google/callback?...`. The public origin is
 * `SIDEQUEST_BASE_URL`. This file drives the REAL start and callback handlers
 * with requests shaped exactly like that and asserts that no redirect a
 * traveller could follow ever names the internal origin — and that the three
 * URIs of the round trip (authorize `redirect_uri`, token-exchange
 * `redirect_uri`, post-auth return) share one origin.
 */

const PUBLIC = 'https://sidequestweb-production.up.railway.app';
const INTERNAL = 'http://localhost:8080';
const FORBIDDEN = [/localhost/, /127\.0\.0\.1/, /railway\.internal/, /evil\.example/];

const jar = new Map<string, string>();
const cookieWrites: Array<{ name: string; value: string; options: Record<string, unknown> | undefined }> = [];
const requestHeaders = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieWrites.push({ name, value, options });
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

let dir: string;
let tokenExchanges: URLSearchParams[] = [];

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/** Google, stubbed: the token endpoint and userinfo answer; nothing else is reachable. */
function stubGoogle(): void {
  tokenExchanges = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenExchanges.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return new Response(JSON.stringify({ sub: 'google-sub-1', email: 'traveller@example.com', email_verified: true, name: 'Traveller' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected outbound request: ${url}`);
  });
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  cookieWrites.length = 0;
  requestHeaders.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-google-railway-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_BASE_URL = PUBLIC;
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  stubGoogle();
});

afterEach(() => {
  vi.unstubAllGlobals();
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_BASE_URL;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.SIDEQUEST_ACTION_FENCES;
  delete process.env.SIDEQUEST_SECURE_COOKIES;
  rmSync(dir, { recursive: true, force: true });
});

/** Begin at /api/auth/google/start as Railway hands it to Next; return the state Google would echo back. */
async function start(returnTo: string | null): Promise<{ state: string; redirectUri: string }> {
  const { GET } = await import('@/app/api/auth/google/start/route');
  const query = returnTo === null ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await GET(new NextRequest(`${INTERNAL}/api/auth/google/start${query}`));
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get('location')!);
  expect(location.origin).toBe('https://accounts.google.com');
  return { state: location.searchParams.get('state')!, redirectUri: location.searchParams.get('redirect_uri')! };
}

async function callback(query: string): Promise<Response> {
  const { GET } = await import('@/app/api/auth/google/callback/route');
  return GET(new NextRequest(`${INTERNAL}/api/auth/google/callback?${query}`));
}

function expectPublicRedirect(response: Response, path: string): void {
  expect(response.status).toBe(307);
  const location = response.headers.get('location')!;
  expect(location).toBe(`${PUBLIC}${path}`);
  for (const pattern of FORBIDDEN) expect(location).not.toMatch(pattern);
}

describe('Google sign-in behind Railway', () => {
  it('returns the traveller to the public origin, not to the container, and uses one redirect_uri throughout', async () => {
    const { state, redirectUri } = await start(null);
    expect(redirectUri).toBe(`${PUBLIC}/api/auth/google/callback`);

    const response = await callback(`state=${encodeURIComponent(state)}&code=auth-code`);
    expectPublicRedirect(response, '/trips');

    expect(tokenExchanges).toHaveLength(1);
    expect(tokenExchanges[0]!.get('redirect_uri')).toBe(redirectUri);
    expect(tokenExchanges[0]!.get('code_verifier')).toBeTruthy();

    const { currentUser } = await import('@/lib/auth/session');
    const user = await currentUser();
    expect(user?.email).toBe('traveller@example.com');
  });

  it('honours a same-origin returnTo on the public origin', async () => {
    const { state } = await start('/trips/abc');
    expectPublicRedirect(await callback(`state=${encodeURIComponent(state)}&code=auth-code`), '/trips/abc');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', `${INTERNAL}/trips`])('sends a foreign returnTo (%s) to /trips on the public origin', async (returnTo) => {
    const { state } = await start(returnTo);
    expectPublicRedirect(await callback(`state=${encodeURIComponent(state)}&code=auth-code`), '/trips');
  });

  it('lands every failure on the public sign-in page', async () => {
    expectPublicRedirect(await callback('state=unknown&code=auth-code'), '/signin?error=state');

    const denied = await start(null);
    expectPublicRedirect(await callback(`state=${encodeURIComponent(denied.state)}&error=access_denied`), '/signin?error=denied');

    const failing = await start(null);
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 400 }));
    expectPublicRedirect(await callback(`state=${encodeURIComponent(failing.state)}&code=auth-code`), '/signin?error=exchange');
    expect(jar.get('sidequest_auth')).toBeUndefined();
  });

  it('never trusts Host or X-Forwarded-Host for the return', async () => {
    const { state } = await start('/trips/abc');
    const { GET } = await import('@/app/api/auth/google/callback/route');
    const response = await GET(
      new NextRequest(`${INTERNAL}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=auth-code`, {
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
      }),
    );
    expectPublicRedirect(response, '/trips/abc');
  });

  it('answers with a relative Location when the door is closed and no public origin is known', async () => {
    delete process.env.SIDEQUEST_BASE_URL;
    const { GET } = await import('@/app/api/auth/google/callback/route');
    const response = await GET(new NextRequest(`${INTERNAL}/api/auth/google/callback?state=x&code=y`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/signin?error=unavailable');
  });

  it('writes the session cookie for the public host — HttpOnly, Lax, path /, no Domain, Secure in production — and sign-out clears the same cookie', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { state } = await start(null);
      await callback(`state=${encodeURIComponent(state)}&code=auth-code`);
      const written = cookieWrites.find((write) => write.name === 'sidequest_auth');
      expect(written?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
      expect(written?.options).not.toHaveProperty('domain');
      expect((written?.options?.maxAge as number) > 0).toBe(true);

      const { signOutUser, currentUser } = await import('@/lib/auth/session');
      await signOutUser();
      const cleared = cookieWrites.filter((write) => write.name === 'sidequest_auth').at(-1);
      expect(cleared?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true, maxAge: 0 });
      expect(await currentUser()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
