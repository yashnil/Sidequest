import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ONE THING STANDING BETWEEN A TRAVELLER AND EVERY TRIP THEY HAVE MADE.
 *
 * `caller.test.ts` asserts what the limiter may believe about who is asking.
 * This file asserts the other half of the same cookie's job, the half with no
 * fallback behind it: there are no accounts here, so `sidequest_session`
 * matched against `trips.owner_token` is the *whole* of ownership.
 *
 * It was minted with three attributes and neither of the two that decide
 * whether it survives:
 *
 *  - No `maxAge` and no `expires`, which makes it a session cookie. Quitting
 *    the browser — closing a laptop lid on a Tuesday — discarded the only claim
 *    the traveller had, and every trip they had made became a row that
 *    `tripAccessRefusal` refuses and `listTrips` lists to nobody. Permanently:
 *    there is no account to recover the claim to.
 *  - No `Secure`, so the credential that owns every trip was sent over
 *    plaintext and could be written by anyone who could answer a plaintext
 *    request to the host.
 *
 * So the restart below is simulated the way a browser actually does it — a
 * cookie with no lifetime does not come back — rather than by re-presenting a
 * value the test kept in a variable, which would pass against the defect.
 */

interface StoredCookie {
  value: string;
  options: {
    maxAge?: number;
    expires?: Date | number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string | boolean;
    path?: string;
  };
}

const jar = new Map<string, StoredCookie>();

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const stored = jar.get(name);
      return stored === undefined ? undefined : { value: stored.value };
    },
    set: (name: string, value: string, options: StoredCookie['options'] = {}) => {
      jar.set(name, { value, options });
    },
  }),
}));

/**
 * An ordinary quit and reopen: what a browser keeps is what it was given a
 * lifetime for, and nothing else.
 *
 * This is the assertion the whole file turns on, so it is modelled rather than
 * stipulated. Take the lifetime back out of the mint and this helper empties
 * the jar, which is precisely what it did to travellers.
 */
function quitAndReopenTheBrowser(): void {
  for (const [name, stored] of [...jar]) {
    const persisted = (stored.options.maxAge ?? 0) > 0 || stored.options.expires !== undefined;
    if (!persisted) jar.delete(name);
  }
}

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-session-cookie-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  vi.unstubAllEnvs();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-09-01',
  endDate: '2026-09-04',
  arrivalTime: '10:00',
  departureTime: '18:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

/** The cookie this request left in the jar, or a failure that says which one. */
async function mintedCookie(): Promise<StoredCookie> {
  const { sessionToken, SESSION_COOKIE } = await import('./caller');
  const minted = await sessionToken({ mint: true });
  expect(minted, 'nothing was minted').toBeTruthy();
  const stored = jar.get(SESSION_COOKIE);
  expect(stored, `nothing was written to ${SESSION_COOKIE}`).toBeDefined();
  return stored!;
}

describe('the lifetime of the anonymous ownership cookie', () => {
  it('mints a bounded, non-zero lifetime rather than a browser session', async () => {
    const { SESSION_COOKIE_MAX_AGE_SECONDS } = await import('./caller');
    const stored = await mintedCookie();

    // Written with the lifetime the module states, so an intentional change to
    // that constant moves this test with it and an accidental drop fails it.
    expect(stored.options.maxAge).toBe(SESSION_COOKIE_MAX_AGE_SECONDS);
    expect(stored.options.maxAge).toBeGreaterThan(0);

    /*
     * And the constant itself has to stay a sensible trip horizon. The bounds
     * are external facts, not the implementation restated: a month is shorter
     * than the gap between booking and travelling, and browsers clamp cookie
     * lifetimes to 400 days, so anything past that is asking for a longer claim
     * than can be granted — and is a tracking cookie rather than an ownership
     * one on a product with no accounts.
     */
    const DAY = 60 * 60 * 24;
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(30 * DAY);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeLessThanOrEqual(400 * DAY);
  });

  it('still owns the trip after the browser has been quit and reopened', async () => {
    const { sessionToken, SESSION_COOKIE } = await import('./caller');
    const { createTrip } = await import('@/lib/db/repository');

    const minted = await sessionToken({ mint: true });
    const trip = createTrip(BASICS, minted);

    // The whole defect, reproduced: quit, reopen, come back to the same trip.
    quitAndReopenTheBrowser();
    expect(jar.get(SESSION_COOKIE)?.value, 'the browser came back with no claim').toBe(minted);
    // And the second request reads the surviving cookie rather than minting a
    // second identity over the top of it.
    expect(await sessionToken({ mint: true })).toBe(minted);

    const { tripAccessRefusal, ownedTrip } = await import('./trip-access');
    expect(await tripAccessRefusal(trip.id)).toBeNull();
    expect((await ownedTrip(trip.id))?.id).toBe(trip.id);
  });

  it('reaches no other browser trip, before the restart or after it', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const theirs = createTrip(BASICS, 'session:theirs');
    const { tripAccessRefusal, ownedTrip, FOREIGN_TRIP_REFUSAL } = await import('./trip-access');

    await mintedCookie();
    expect(await tripAccessRefusal(theirs.id)).toBe(FOREIGN_TRIP_REFUSAL);
    expect(await ownedTrip(theirs.id)).toBeNull();

    // A cookie that now survives a restart must carry exactly the reach it had
    // before one: a durable claim to one's own trips, and to nothing else.
    quitAndReopenTheBrowser();
    expect(await tripAccessRefusal(theirs.id)).toBe(FOREIGN_TRIP_REFUSAL);
    expect(await ownedTrip(theirs.id)).toBeNull();
  });
});

describe('the transport the ownership cookie is allowed to cross', () => {
  it('marks it Secure on a deployment, where it would otherwise cross plaintext', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await mintedCookie()).options.secure).toBe(true);
  });

  it('leaves Secure off in development, which is served over plain http', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    // Falsy rather than strictly false: what matters is that the browser is not
    // asked to refuse the cookie, not which shape of "no" says so.
    expect((await mintedCookie()).options.secure).toBeFalsy();
  });

  it('leaves Secure off for the production build the browser suite serves over http', async () => {
    /*
     * `next start` reports itself as production, and `playwright.config.ts`
     * drives exactly that over http://127.0.0.1. Without this exemption the
     * suite's every trip-owning journey would depend on a browser choosing to
     * store a Secure cookie on a loopback origin.
     */
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SIDEQUEST_SECURE_COOKIES', 'off');
    expect((await mintedCookie()).options.secure).toBeFalsy();
  });

  it('takes any value but the exact exemption as leaving Secure on', async () => {
    // A blank or a typo is how a deployment would silently lose the attribute.
    const { secureCookiesEnabled } = await import('./caller');
    vi.stubEnv('NODE_ENV', 'production');
    for (const value of ['', 'OFF', 'false', 'no', 'off ']) {
      vi.stubEnv('SIDEQUEST_SECURE_COOKIES', value);
      expect(secureCookiesEnabled(), `"${value}" switched Secure off`).toBe(true);
    }
  });
});

describe('the attributes that were already right', () => {
  it('keeps the credential out of scripts and out of cross-site posts', async () => {
    const stored = await mintedCookie();
    // No script in this product reads it; it exists to be compared server-side.
    expect(stored.options.httpOnly).toBe(true);
    // Lax, not strict: a /trips/{id} link opened from a mail client is a
    // top-level navigation and must arrive carrying the owner's claim.
    expect(stored.options.sameSite).toBe('lax');
    // Every trip surface is under /trips, every action posts to one.
    expect(stored.options.path).toBe('/');
  });
});
