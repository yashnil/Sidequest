import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A CALLER MAY NOT MINT ITSELF AN ALLOWANCE.
 *
 * The daily ceilings are charged twice — once to the deployment, once to the
 * caller — and the second row is what stops one visitor draining everybody
 * else's day. Its key came from `sidequest_session`, and `sessionToken` returned
 * whatever the browser presented. A cookie is written by the client, so sending
 * a fresh random value on every request opened a fresh per-caller row on every
 * request: the control cost nothing to evade, by a caller who had to do nothing
 * cleverer than not keep a cookie.
 *
 * `daily-ceiling`'s own header already names this failure — *"minting an
 * identity per request would hand every request a fresh personal allowance,
 * which is worse than having none"* — and then inherited it, because it trusted
 * a value it had not issued.
 *
 * These tests drive `callerKey` and the ledger, which is the pair the actions
 * use, and the adversary below is the exact one the fix exists for: a hundred
 * identities, each presented once.
 */

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar = new Map();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-session-identity-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
  process.env.SIDEQUEST_SESSION_SECRET = 'identity-test-secret';
  vi.resetModules();
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_SESSION_SECRET;
  delete process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS;
  rmSync(directory, { recursive: true, force: true });
});

describe('the identity a per-caller allowance is charged against', () => {
  it('is null for a token this server did not issue, however plausible it looks', async () => {
    const { callerKey } = await import('./caller');
    jar.set('sidequest_session', 'aa1f2e3d-4c5b-6a79-8b0c-1d2e3f405162');
    expect(await callerKey()).toBeNull();

    /* And a signature that is merely the right shape is not a signature. */
    jar.set('sidequest_session', 'aa1f2e3d-4c5b-6a79-8b0c-1d2e3f405162.0123456789abcdef');
    expect(await callerKey()).toBeNull();
  });

  it('is null on the request that has no cookie, and the token from the next one on', async () => {
    const { callerKey, sessionToken } = await import('./caller');
    /*
     * AN IDENTITY HAS TO SURVIVE A ROUND TRIP.
     *
     * This asserted the opposite — that a caller with no cookie "is minted one
     * and attributed" — and that assertion *was* the exploit written down as
     * correct behaviour. A signature stops a caller choosing a token; it does
     * nothing about a caller asking the server for one, and a client that
     * simply discards the `Set-Cookie` asks on every request.
     */
    expect(await callerKey()).toBeNull();

    /* Ownership still mints, which is what puts a cookie in the browser. */
    const minted = await sessionToken({ mint: true });
    expect(minted).not.toBeNull();
    expect(jar.get('sidequest_session')).toBe(minted);

    /* And from the request that presents it onwards, the browser has a share. */
    expect(await callerKey()).toBe(`session:${minted}`);
  });

  /**
   * THE ADVERSARY, AS THE THING IT ACTUALLY IS: A HUNDRED FRESH COOKIES.
   *
   * Before the fix each of these opened its own row, so a hundred presses cost
   * one hundredth of the day's allowance each and the per-caller ceiling never
   * bound. They now share the one pool every unattributable request shares, so
   * the fence closes on the same press it would close on for a caller who sent
   * no cookie at all.
   */
  it('refuses a caller who rotates its cookie at the same point as one who sends none', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '20';
    const { callerKey } = await import('./caller');
    const { dailySpendGate, recordDailySpend } = await import('../compiler/daily-ceiling');

    let allowed = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      /*
       * Both adversaries in one loop, alternating, because they are the same
       * adversary: a *forged* cookie and *no* cookie both have to land in the
       * shared pool. The second is the one that got through — the server was
       * handing out a fresh signed identity, and therefore a fresh allowance,
       * to anybody who declined to keep one.
       */
      if (attempt % 2 === 0) jar.set('sidequest_session', `forged-${attempt}-${'x'.repeat(8)}`);
      else jar.clear();
      const caller = await callerKey();
      const gate = dailySpendGate(new Date(), caller);
      if (!gate.allowed) break;
      allowed += 1;
      recordDailySpend('live_compilations', 1, new Date(), caller);
    }

    /*
     * A tenth of twenty, which is the share one caller gets. The number is read
     * from the ceiling rather than written here so the assertion cannot drift
     * away from the policy it is about.
     */
    const { perCallerShareOf } = await import('../compiler/daily-ceiling');
    expect(allowed).toBe(perCallerShareOf(20));
    expect(allowed).toBeLessThan(20);
  });

  /** An honest browser keeps its own share, which is the usability half. */
  it('leaves a browser that accepted the cookie its own allowance', async () => {
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '20';
    const { callerKey, sessionToken } = await import('./caller');
    const { dailySpendGate, recordDailySpend, perCallerShareOf } = await import(
      '../compiler/daily-ceiling'
    );

    /*
     * The honest browser accepts the cookie the server sets — which is the one
     * thing the adversaries above will not do, and now the only thing that
     * separates them.
     */
    const mine = await sessionToken({ mint: true });
    expect(mine).not.toBeNull();
    const jarWithMine = new Map(jar);

    /* Meanwhile a rotating adversary spends the shared pool dry. */
    for (let attempt = 0; attempt < perCallerShareOf(20); attempt += 1) {
      jar.clear();
      recordDailySpend('live_compilations', 1, new Date(), await callerKey());
    }

    jar = jarWithMine;
    const key = await callerKey();
    expect(key).toBe(`session:${mine}`);
    expect(dailySpendGate(new Date(), key).allowed).toBe(true);
  });
});
