import { describe, expect, it } from 'vitest';
import { hostedDeployment, requiredConfigProblems } from './capabilities.mjs';

const GOOD = {
  RAILWAY_ENVIRONMENT: 'production',
  RAILWAY_VOLUME_MOUNT_PATH: '/data',
  SIDEQUEST_DB_PATH: '/data/sidequest.db',
  SIDEQUEST_SESSION_SECRET: 'x'.repeat(64),
  SIDEQUEST_BASE_URL: 'https://sidequest.example.com',
  NODE_ENV: 'production',
};

describe('what a hosted deployment may not start without (private alpha)', () => {
  it('a correct hosted configuration starts', () => {
    expect(hostedDeployment(GOOD)).toBe(true);
    expect(requiredConfigProblems(GOOD)).toEqual([]);
  });

  it('a local or browser-suite server is never refused', () => {
    expect(requiredConfigProblems({ NODE_ENV: 'production', SIDEQUEST_DB_PATH: 'data/x.db' })).toEqual([]);
  });

  it('refuses a database off the volume, a missing secret, an unreachable base URL', () => {
    expect(requiredConfigProblems({ ...GOOD, SIDEQUEST_DB_PATH: 'data/sidequest.db' })[0]).toMatch(/absolute/);
    expect(requiredConfigProblems({ ...GOOD, SIDEQUEST_DB_PATH: '/app/sidequest.db' })[0]).toMatch(/not under the mounted volume/);
    expect(requiredConfigProblems({ ...GOOD, SIDEQUEST_SESSION_SECRET: '' })[0]).toMatch(/SESSION_SECRET/);
    expect(requiredConfigProblems({ ...GOOD, SIDEQUEST_BASE_URL: 'http://localhost:3000' })[0]).toMatch(/BASE_URL/);
    expect(requiredConfigProblems({ ...GOOD, SIDEQUEST_BASE_URL: 'https://web.railway.internal' })[0]).toMatch(/BASE_URL/);
  });

  it('a missing model key is a readiness verdict, not a refusal: existing trips stay readable', () => {
    expect(requiredConfigProblems({ ...GOOD, ANTHROPIC_API_KEY: '' })).toEqual([]);
  });
});
