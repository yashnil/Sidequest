import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE FENCE IN FRONT OF THE ACTIONS THAT CAN SPEND.
 *
 * Persisted, because the moment it matters most — a stuck client re-firing —
 * is exactly when a dev server reloads its modules and an in-memory bucket
 * forgets everything. The refill math is the part worth pinning: a bucket that
 * refills too generously is no fence, and one that never refills locks a
 * legitimate traveller out of their own trip.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-rate-limit-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-11T09:00:00.000Z');
const RULE = { capacity: 3, refillPerMinute: 1 };

describe('the token bucket', () => {
  it('allows a burst up to capacity, then refuses with a wait', async () => {
    const { takeRateToken } = await import('./rate-limit');
    expect(takeRateToken('k', RULE, NOW).allowed).toBe(true);
    expect(takeRateToken('k', RULE, NOW).allowed).toBe(true);
    expect(takeRateToken('k', RULE, NOW).allowed).toBe(true);

    const fourth = takeRateToken('k', RULE, NOW);
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
      expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('refills with elapsed time and allows again', async () => {
    const { takeRateToken } = await import('./rate-limit');
    for (let index = 0; index < 3; index += 1) takeRateToken('k', RULE, NOW);
    expect(takeRateToken('k', RULE, NOW).allowed).toBe(false);

    const later = new Date(NOW.getTime() + 61_000);
    expect(takeRateToken('k', RULE, later).allowed).toBe(true);
    // …and only what elapsed, not a full reset: the next one refuses again.
    expect(takeRateToken('k', RULE, later).allowed).toBe(false);
  });

  it('keeps buckets apart: one hot key does not starve another', async () => {
    const { takeRateToken } = await import('./rate-limit');
    for (let index = 0; index < 4; index += 1) takeRateToken('hot', RULE, NOW);
    expect(takeRateToken('hot', RULE, NOW).allowed).toBe(false);
    expect(takeRateToken('cold', RULE, NOW).allowed).toBe(true);
  });

  it('survives a module reload, because the bucket is a row', async () => {
    const first = await import('./rate-limit');
    for (let index = 0; index < 3; index += 1) first.takeRateToken('k', RULE, NOW);

    // The dev-server condition: fresh module graph, same database.
    const { vi } = await import('vitest');
    vi.resetModules();
    const second = await import('./rate-limit');
    expect(second.takeRateToken('k', RULE, NOW).allowed).toBe(false);
  });
});

describe('the combined decision', () => {
  it('refuses when any identity is exhausted, with the longest wait', async () => {
    const { takeRateToken, takeRateTokens } = await import('./rate-limit');
    for (let index = 0; index < 3; index += 1) takeRateToken('act:ip:1.2.3.4', RULE, NOW);

    const decision = takeRateTokens('act', ['ip:1.2.3.4', 'session:fresh'], RULE, NOW);
    expect(decision.allowed).toBe(false);
  });

  it('allows when every identity has room', async () => {
    const { takeRateTokens } = await import('./rate-limit');
    expect(takeRateTokens('act', ['ip:1.2.3.4', 'session:s'], RULE, NOW).allowed).toBe(true);
  });
});

describe('the refusal copy', () => {
  it('is honest, actionable and free of protocol jargon', async () => {
    const { rateLimitedCopy } = await import('./rate-limit');
    const short = rateLimitedCopy(12);
    expect(short).toContain('Nothing was lost');
    expect(short).toMatch(/seconds/);
    expect(short).not.toMatch(/429|rate limit|token/i);

    const long = rateLimitedCopy(240);
    expect(long).toMatch(/minutes/);
  });
});
