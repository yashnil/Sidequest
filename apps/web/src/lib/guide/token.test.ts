import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_TOKEN_TTL_MS, mintGuideToken, verifyGuideToken } from './token';

/** The renderer's pass opens one trip, one variant, for five minutes — and nothing else. */
describe('guide render token', () => {
  const previous = process.env.SIDEQUEST_SESSION_SECRET;
  beforeAll(() => {
    process.env.SIDEQUEST_SESSION_SECRET = 'test-secret-for-guide-tokens';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SIDEQUEST_SESSION_SECRET;
    else process.env.SIDEQUEST_SESSION_SECRET = previous;
  });

  it('verifies for the trip and variant it was minted for', () => {
    const now = 1_800_000_000_000;
    const token = mintGuideToken('trip-1', 'compact', now)!;
    expect(verifyGuideToken(token, 'trip-1', 'compact', now + 1000)).toBe(true);
  });

  it('refuses another trip, another variant, an expired or a tampered token', () => {
    const now = 1_800_000_000_000;
    const token = mintGuideToken('trip-1', 'compact', now)!;
    expect(verifyGuideToken(token, 'trip-2', 'compact', now)).toBe(false);
    expect(verifyGuideToken(token, 'trip-1', 'complete', now)).toBe(false);
    expect(verifyGuideToken(token, 'trip-1', 'compact', now + GUIDE_TOKEN_TTL_MS + 1)).toBe(false);
    expect(verifyGuideToken(`${token.slice(0, -2)}xx`, 'trip-1', 'compact', now)).toBe(false);
    expect(verifyGuideToken(null, 'trip-1', 'compact', now)).toBe(false);
  });
});
