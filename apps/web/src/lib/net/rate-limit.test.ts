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

/*
 * The browser-suite stand-down. The end-to-end server pins
 * `SIDEQUEST_ACTION_FENCES=off` beside its fixture providers because the suite
 * is, by the fences' own definition, the loop they refuse; these two tests hold
 * the switch to exactly that one string, so a typo in an environment file
 * leaves every fence up rather than quietly down.
 */
describe('the fences stand down only on the exact test switch', () => {
  it('allows a drained bucket through when the switch says off', async () => {
    const { ACTION_RATE_RULES, takeActionTokens, takeRateToken } = await import('./rate-limit');
    const rule = ACTION_RATE_RULES.trip_create;
    for (let index = 0; index < rule.capacity + 5; index += 1) {
      takeRateToken('trip_create:ip:9.9.9.9', rule, NOW);
    }
    process.env.SIDEQUEST_ACTION_FENCES = 'off';
    try {
      expect(takeActionTokens('trip_create', ['ip:9.9.9.9'], rule, NOW).allowed).toBe(true);
    } finally {
      delete process.env.SIDEQUEST_ACTION_FENCES;
    }
  });

  it('keeps refusing on any other value, including a plausible typo', async () => {
    const { ACTION_RATE_RULES, takeActionTokens, takeRateToken } = await import('./rate-limit');
    const rule = ACTION_RATE_RULES.trip_create;
    for (let index = 0; index < rule.capacity + 5; index += 1) {
      takeRateToken('trip_create:ip:8.8.8.8', rule, NOW);
    }
    process.env.SIDEQUEST_ACTION_FENCES = 'Off';
    try {
      expect(takeActionTokens('trip_create', ['ip:8.8.8.8'], rule, NOW).allowed).toBe(false);
    } finally {
      delete process.env.SIDEQUEST_ACTION_FENCES;
    }
  });
});

/**
 * THE ONE FENCE THAT TAKES NO IDENTITY, AND THE ROTATION THAT DELETED IT.
 *
 * Both per-identity fences are worth what the identity is worth, which here is
 * nothing: `x-forwarded-for` is client-written without a trusted-proxy hop count
 * and a cookie is discarded for free. The deployment fence exists because it has
 * nothing to rotate — and the table's own size cap took it out anyway. A drained
 * bucket stops being written, so its `refilled_at` freezes; five thousand fresh
 * identities then sorted it past the keep-newest cut and deleted it, and a
 * missing bucket reads as a full one.
 */
describe('the deployment fence under identity rotation', () => {
  it('survives a table sweep driven by five thousand fresh identities', async () => {
    const { ACTION_RATE_RULES, takeActionTokens, takeRateToken } = await import('./rate-limit');
    const { getDb } = await import('../db/client');
    const rule = ACTION_RATE_RULES.compile_start;

    // Rotating identity every request, which costs an attacker nothing: each
    // fresh bucket is virgin, so only the shared fence ever refuses.
    let deploymentRefusals = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const decision = takeActionTokens('compile_start', [`session:${attempt}`], rule, NOW);
      if (!decision.allowed && decision.scope === 'deployment') deploymentRefusals += 1;
    }
    expect(deploymentRefusals, 'the shared fence never bit, so nothing below is measured')
      .toBeGreaterThan(0);

    /*
     * Five thousand more rotations, seeded directly rather than driven through
     * the limiter — the sweep is what is under test, and paying for five
     * thousand round trips to reach it would only make this slow. Every row is
     * newer than the drained fence, which is the whole mechanism.
     */
    const newer = new Date(NOW.getTime() + 1_000).toISOString();
    getDb().exec(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5200)
         INSERT INTO rate_limit_buckets (bucket_key, tokens, refilled_at)
         SELECT 'compile_start:session:rotated-' || n, 2, '${newer}' FROM seq`,
    );

    // One real call, at the same instant, to run the sweep.
    takeRateToken('compile_start:session:trigger', rule, NOW);

    const after = takeActionTokens('compile_start', ['session:brand-new'], rule, NOW);
    expect(after.allowed, 'rotation reset the fence that is supposed to be unrotatable').toBe(false);
    if (!after.allowed) expect(after.scope).toBe('deployment');
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
