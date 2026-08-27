import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE AGGREGATE CEILING, WHICH NOTHING ELSE BOUNDS.
 *
 * Per-build budgets bound one build and the job index bounds one trip; fifty
 * trips were fifty fully budgeted live builds and the first sign was the
 * bill. The interesting cases are the refusals and the fallbacks — a ceiling
 * that only ever allows is the state this replaces.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

const ENV_KEYS = ['SIDEQUEST_DAILY_LIVE_COMPILATIONS', 'SIDEQUEST_DAILY_MODEL_CALLS'];

beforeEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-daily-ceiling-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-11T09:00:00.000Z');

describe('the daily spend gate', () => {
  it('allows while the day is under both ceilings', async () => {
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');
    recordDailySpend('live_compilations', 3, NOW);
    recordDailySpend('model_calls', 30, NOW);
    expect(dailySpendGate(NOW).allowed).toBe(true);
  });

  it('refuses at the compilation ceiling, in the traveller’s own words', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '2';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');
    recordDailySpend('live_compilations', 2, NOW);
    const decision = dailySpendGate(NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // The traveller's sentence: what ran out, what is kept, what to do next
      // — never a counter name or an apology for a defect.
      expect(decision.message).toContain('saved');
      expect(decision.message).toContain('tomorrow');
      expect(decision.message).not.toMatch(/SIDEQUEST_|ledger|counter/i);
    }
  });

  it('refuses at the model-call ceiling independently of compilations', async () => {
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '50';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');
    recordDailySpend('model_calls', 50, NOW);
    expect(dailySpendGate(NOW).allowed).toBe(false);
  });

  it('opens again the next day — the ledger is per UTC day, not cumulative', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '1';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');
    recordDailySpend('live_compilations', 1, NOW);
    expect(dailySpendGate(NOW).allowed).toBe(false);
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
    expect(dailySpendGate(tomorrow).allowed).toBe(true);
  });

  it('treats a malformed ceiling as the default, never as unlimited', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = 'lots';
    const { dailyLiveCompilationCeiling, dailyModelCallCeiling } = await import('./daily-ceiling');
    expect(dailyLiveCompilationCeiling()).toBe(60);
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '-4';
    expect(dailyModelCallCeiling()).toBe(800);
  });

  /**
   * THE DEFAULTS ARE A LAUNCH DECISION, SO THEY ARE PINNED LIKE ONE.
   *
   * Twenty builds a day is not a hundred-user launch: a quarter of a hundred
   * travellers building twice each is fifty-five, and the first hundred people
   * to try a product are the ones who must not be told to come back tomorrow.
   * The arithmetic behind both numbers is written out in the module header; this
   * exists so lowering them back is a decision somebody makes on purpose.
   */
  it('is sized for the launch cohort, and a caller gets a tenth of it', async () => {
    const { dailyLiveCompilationCeiling, dailyModelCallCeiling, dailySpendGate, recordDailySpend } =
      await import('./daily-ceiling');

    expect(dailyLiveCompilationCeiling()).toBe(60);
    expect(dailyModelCallCeiling()).toBe(800);

    // Six builds a day from one browser — more than the previous default
    // allowed, and it now takes ten distinct browsers to exhaust the day.
    for (let index = 0; index < 6; index += 1) {
      expect(dailySpendGate(NOW, 'session:abc').allowed).toBe(true);
      recordDailySpend('live_compilations', 1, NOW, 'session:abc');
    }
    expect(dailySpendGate(NOW, 'session:abc').allowed).toBe(false);
    expect(dailySpendGate(NOW, 'session:xyz').allowed).toBe(true);
  });

  it('honours an explicit zero as "no live builds today"', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '0';
    const { dailySpendGate } = await import('./daily-ceiling');
    expect(dailySpendGate(NOW).allowed).toBe(false);
  });
});

/**
 * THE SHARE, WHICH IS WHAT STOPS A CEILING BECOMING AN OUTAGE.
 *
 * The ledger began as one global counter, and a review measured the
 * consequence with the rate limiter's own numbers: one caller starting three
 * builds immediately and one a minute thereafter drains the whole deployment's
 * daily allowance in about seventeen minutes, after which everybody else is
 * told to come back tomorrow. These tests state the property that replaced it —
 * a caller runs out before the deployment does — and the honest limit of it:
 * with nobody to charge, only the global ceiling applies.
 */
describe('the per-caller share of the day', () => {
  it('refuses one caller while the deployment still has room', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '50';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');

    // A tenth of fifty is five. The sixth start from this browser is refused;
    // the deployment has spent five of fifty and is wide open.
    for (let index = 0; index < 5; index += 1) {
      expect(dailySpendGate(NOW, 'session:abc').allowed).toBe(true);
      recordDailySpend('live_compilations', 1, NOW, 'session:abc');
    }

    const hoggish = dailySpendGate(NOW, 'session:abc');
    expect(hoggish.allowed).toBe(false);
    if (!hoggish.allowed) {
      // Their share, not the deployment's — telling them Sidequest is finished
      // for the day would be a false statement about the system.
      expect(hoggish.message).toContain('your share');
      expect(hoggish.message).not.toContain('all the live research it can afford');
    }

    // The next visitor is unaffected, which is the whole point.
    expect(dailySpendGate(NOW, 'session:xyz').allowed).toBe(true);
    // …and so is the deployment ledger the global ceiling reads.
    expect(dailySpendGate(NOW).allowed).toBe(true);
  });

  it('still stops at the deployment ceiling once enough callers have spent', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '4';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');
    for (let index = 0; index < 4; index += 1) {
      recordDailySpend('live_compilations', 1, NOW, `session:visitor-${index}`);
    }
    const fresh = dailySpendGate(NOW, 'session:visitor-new');
    expect(fresh.allowed).toBe(false);
    if (!fresh.allowed) expect(fresh.message).toContain('tomorrow');
  });

  it('applies only the global ceiling when there is nobody to charge', async () => {
    /*
     * An internal caller — a worker, the benchmark driver, a test — has no
     * identity, and inventing one would hand every request its own fresh
     * allowance, which is worse than having none. *Absent*, not null: the two
     * are different arguments and the test below is the reason.
     */
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '20';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');
    for (let index = 0; index < 10; index += 1) recordDailySpend('live_compilations', 1, NOW);
    expect(dailySpendGate(NOW).allowed).toBe(true);
  });

  /**
   * DECLINING THE COOKIE WAS A DISCOUNT.
   *
   * The share is keyed on a session cookie, and a caller is free not to return
   * one. That made refusing identity *strictly better* than presenting it: an
   * attributed browser got a tenth of the day, and an anonymous caller — charged
   * to the deployment row and nothing else — had the whole of it. The fix is not
   * a better identity, because there is not one to be had here; it is that
   * everybody who cannot be told apart shares one allowance between them.
   */
  it('charges every request it cannot attribute to one shared pool', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '50';
    const { dailySpendGate, recordDailySpend } = await import('./daily-ceiling');

    // Five anonymous starts — from five different connections, for all anyone
    // here can tell — and the sixth is refused, exactly as one browser's would be.
    for (let index = 0; index < 5; index += 1) {
      expect(dailySpendGate(NOW, null).allowed).toBe(true);
      recordDailySpend('live_compilations', 1, NOW, null);
    }
    const anonymous = dailySpendGate(NOW, null);
    expect(anonymous.allowed, 'declining identity bought a bigger allowance').toBe(false);
    if (!anonymous.allowed) expect(anonymous.message).toContain('your share');

    // A traveller who does present a cookie is unaffected, and so is the
    // deployment: forty-five of fifty are still there for everybody else.
    expect(dailySpendGate(NOW, 'session:honest').allowed).toBe(true);
    expect(dailySpendGate(NOW).allowed).toBe(true);
  });
});

/**
 * EVERY OTHER SPENDER, WHICH THE LEDGER USED TO BE BLIND TO.
 *
 * `model_calls` was written from one place — a finished compilation's
 * diagnostics — while three other production paths reached the same billed
 * model. `reserveModelCalls` is the door those paths go through.
 */
describe('reserving model calls outside a compilation', () => {
  it('books the call against the day before it is made', async () => {
    const { dailySpendSoFar, reserveModelCalls } = await import('./daily-ceiling');
    expect(reserveModelCalls(1, { now: NOW, caller: 'session:abc' }).allowed).toBe(true);
    expect(dailySpendSoFar('model_calls', NOW)).toBe(1);
    expect(dailySpendSoFar('model_calls', NOW, 'session:abc')).toBe(1);
  });

  it('refuses once the day is spent, and books nothing when it refuses', async () => {
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '2';
    const { dailySpendSoFar, reserveModelCalls } = await import('./daily-ceiling');
    expect(reserveModelCalls(1, { now: NOW }).allowed).toBe(true);
    expect(reserveModelCalls(1, { now: NOW }).allowed).toBe(true);

    const refused = reserveModelCalls(1, { now: NOW });
    expect(refused.allowed).toBe(false);
    expect(dailySpendSoFar('model_calls', NOW)).toBe(2);
  });

  it('runs out for one caller at their share, while the deployment has room', async () => {
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '50';
    const { dailySpendSoFar, reserveModelCalls } = await import('./daily-ceiling');
    for (let index = 0; index < 5; index += 1) {
      expect(reserveModelCalls(1, { now: NOW, caller: 'session:abc' }).allowed).toBe(true);
    }
    expect(reserveModelCalls(1, { now: NOW, caller: 'session:abc' }).allowed).toBe(false);
    expect(reserveModelCalls(1, { now: NOW, caller: 'session:xyz' }).allowed).toBe(true);
    expect(dailySpendSoFar('model_calls', NOW)).toBe(6);
  });
});
