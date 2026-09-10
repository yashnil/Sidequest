import { describe, expect, it } from 'vitest';
import { publicUrlFor, redirectToPublicPath, safeReturnTo } from './redirects';

/**
 * THE CANONICAL-ORIGIN RULE FOR AUTH REDIRECTS.
 *
 * A server-issued redirect back into Sidequest is `SIDEQUEST_BASE_URL` plus a
 * validated same-origin path. The request's own origin never takes part, so
 * nothing about how the container is addressed (Railway's
 * `http://localhost:8080`) can reach a traveller.
 */

const PUBLIC = 'https://sidequestweb-production.up.railway.app';

describe('safeReturnTo', () => {
  it('keeps a same-origin path, query included', () => {
    expect(safeReturnTo('/trips/abc')).toBe('/trips/abc');
    expect(safeReturnTo('/signin?error=state')).toBe('/signin?error=state');
  });

  it('falls back for anything that is not a path', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example', 'evil.example', '/a://b', '/x\r\nLocation: https://evil.example', '', null, undefined, `/${'a'.repeat(400)}`]) {
      expect(safeReturnTo(bad)).toBe('/trips');
    }
  });

  it('takes a caller-supplied fallback', () => {
    expect(safeReturnTo(null, '/')).toBe('/');
  });
});

describe('redirectToPublicPath', () => {
  it('joins the path to the configured public origin, never to the request', () => {
    const env = { SIDEQUEST_BASE_URL: `${PUBLIC}/` };
    expect(publicUrlFor('/trips', env)).toBe(`${PUBLIC}/trips`);
    const response = redirectToPublicPath('/trips/abc', env);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${PUBLIC}/trips/abc`);
  });

  it('sends a foreign destination to /trips on the public origin', () => {
    const env = { SIDEQUEST_BASE_URL: PUBLIC };
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      expect(redirectToPublicPath(bad, env).headers.get('location')).toBe(`${PUBLIC}/trips`);
    }
  });

  it('issues a relative Location when no public origin is configured, so the browser resolves it against the URL it requested', () => {
    const response = redirectToPublicPath('/signin?error=unavailable', {});
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/signin?error=unavailable');
  });
});
