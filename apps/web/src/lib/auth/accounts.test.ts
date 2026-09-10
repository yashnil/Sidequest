import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ACCOUNTS AND THE OWNERSHIP BOUNDARY, V6 §22/§50.
 *
 * Two real accounts, one anonymous browser, one cookie jar that can be
 * swapped. The claims: a trip made while signed in answers to the account
 * from any browser; a claimed trip stops answering to the cookie that made
 * it; another account is refused; anonymous is refused; claiming moves only
 * this cookie's unclaimed trips; the dashboard lists the account's trips plus
 * the browser's unclaimed ones.
 */

const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`); }, notFound: () => { throw new Error('notFound'); } }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-accounts-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_AUTH_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_AUTH_PROVIDER;
  delete process.env.SIDEQUEST_ACTION_FENCES;
  rmSync(dir, { recursive: true, force: true });
});

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Hokkaido',
  regionId: 'dynamic',
  startDate: '2027-06-13',
  endDate: '2027-06-20',
  arrivalTime: '15:00',
  departureTime: '11:00',
  adults: 3,
  children: 0,
  travelerNeeds: [],
};

async function signInAs(email: string) {
  const { fixtureSignInAction } = await import('@/app/(product)/signin/actions');
  const result = await fixtureSignInAction({ email });
  expect(result.ok).toBe(true);
}

describe('accounts', () => {
  it('a trip made while signed in belongs to the account, and another account or an anonymous browser is refused', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const { tripAccessRefusal, FOREIGN_ACCOUNT_TRIP_REFUSAL } = await import('@/lib/net/trip-access');
    const { currentUserId, signOutUser } = await import('@/lib/auth/session');
    const { sessionToken } = await import('@/lib/net/caller');

    await signInAs('a@example.com');
    const a = await currentUserId();
    expect(a).toBeTruthy();
    const trip = createTrip(BASICS, await sessionToken({ mint: true }), a);
    expect(await tripAccessRefusal(trip.id)).toBeNull();

    /* The same account from a fresh browser: allowed. */
    jar.clear();
    await signInAs('a@example.com');
    expect(await tripAccessRefusal(trip.id)).toBeNull();

    /* Another account, from the ORIGINAL browser cookie: refused — the cookie is no longer authorisation once the trip has an account. */
    await signOutUser();
    await signInAs('b@example.com');
    expect(await tripAccessRefusal(trip.id)).toBe(FOREIGN_ACCOUNT_TRIP_REFUSAL);

    /* Anonymous: refused. */
    await signOutUser();
    expect(await tripAccessRefusal(trip.id)).toBe(FOREIGN_ACCOUNT_TRIP_REFUSAL);
  });

  it('claiming moves only this browser’s unclaimed trips, once, and the dashboard lists both kinds', async () => {
    const { createTrip, listTripsFor, tripOwner } = await import('@/lib/db/repository');
    const { sessionToken } = await import('@/lib/net/caller');
    const { claimBrowserTripsAction, unclaimedTripCountAction } = await import('@/app/(product)/signin/actions');
    const { currentUserId } = await import('@/lib/auth/session');

    /* Browser one makes two anonymous trips. */
    const tokenOne = (await sessionToken({ mint: true }))!;
    const t1 = createTrip(BASICS, tokenOne, null);
    const t2 = createTrip({ ...BASICS, destinationInput: 'Madhya Pradesh' }, tokenOne, null);
    /* Browser two makes one. */
    const jarOne = new Map(jar);
    jar.clear();
    const tokenTwo = (await sessionToken({ mint: true }))!;
    const t3 = createTrip({ ...BASICS, destinationInput: 'Hong Kong' }, tokenTwo, null);
    expect(tokenTwo).not.toBe(tokenOne);

    /* Browser one signs in and claims. */
    jar.clear();
    for (const [k, v] of jarOne) jar.set(k, v);
    await signInAs('a@example.com');
    const a = (await currentUserId())!;
    expect(await unclaimedTripCountAction()).toBe(2);
    const claimed = await claimBrowserTripsAction();
    expect(claimed).toEqual({ ok: true, trips: 2, travelers: 0 });
    expect(tripOwner(t1.id)?.userId).toBe(a);
    expect(tripOwner(t2.id)?.userId).toBe(a);
    expect(tripOwner(t3.id)?.userId).toBeNull();
    expect(await unclaimedTripCountAction()).toBe(0);
    /* Idempotent. */
    expect(await claimBrowserTripsAction()).toEqual({ ok: true, trips: 0, travelers: 0 });

    /* The dashboard: the account's two, and nothing of browser two's. */
    const rows = listTripsFor({ userId: a, ownerToken: tokenOne });
    expect(rows.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());
    /* Browser two, signed out, still sees its own unclaimed trip and none of A's. */
    expect(listTripsFor({ userId: null, ownerToken: tokenTwo }).map((r) => r.id)).toEqual([t3.id]);
  });

  it('sign-out revokes the session so the cookie no longer identifies anyone', async () => {
    const { currentUser, signOutUser } = await import('@/lib/auth/session');
    const { AUTH_COOKIE } = await import('@/lib/auth/config');
    const { userForSessionToken } = await import('@/lib/db/auth-repository');
    await signInAs('a@example.com');
    const token = jar.get(AUTH_COOKIE)!;
    expect(await currentUser()).not.toBeNull();
    await signOutUser();
    expect(await currentUser()).toBeNull();
    expect(userForSessionToken(token)).toBeNull();
  });

  it('the fixture door is refused when the deployment did not open it', async () => {
    delete process.env.SIDEQUEST_AUTH_PROVIDER;
    const { fixtureSignInAction } = await import('@/app/(product)/signin/actions');
    const result = await fixtureSignInAction({ email: 'x@example.com' });
    expect(result.ok).toBe(false);
  });

  it('the fixture door is refused in production without an explicit allowance', async () => {
    const { authProviders } = await import('@/lib/auth/config');
    expect(authProviders({ NODE_ENV: 'production', SIDEQUEST_AUTH_PROVIDER: 'fixture' }).fixture).toBe(false);
    expect(authProviders({ NODE_ENV: 'production', SIDEQUEST_AUTH_PROVIDER: 'fixture', SIDEQUEST_AUTH_FIXTURE: 'allow' }).fixture).toBe(true);
    expect(authProviders({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' }).google).toBe(false);
    expect(authProviders({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's', SIDEQUEST_BASE_URL: 'https://sidequest.example' }).google).toBe(true);
  });

  it('the lifecycle: booked needs a booked stay or way there, and the calendar is never overridable', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const { sessionToken } = await import('@/lib/net/caller');
    const { setLifecycleAction } = await import('@/app/(product)/trips/dashboard-actions');
    const { addBookedItem } = await import('@/lib/db/intelligence-repository');
    const { dashboardRowsFor } = await import('@/lib/trips/dashboard');
    const token = (await sessionToken({ mint: true }))!;
    const trip = createTrip(BASICS, token, null);
    const refused = await setLifecycleAction(trip.id, 'booked');
    expect(refused.ok).toBe(false);
    addBookedItem(trip.id, { type: 'lodging', title: 'Furano guesthouse', date: '2027-06-14', status: 'booked', locked: true } as never);
    const allowed = await setLifecycleAction(trip.id, 'booked');
    expect(allowed.ok).toBe(true);
    const row = dashboardRowsFor({ userId: null, ownerToken: token }, new Date('2026-09-09T00:00:00Z'))[0]!;
    expect(row.lifecycle).toBe('booked');
    expect(row.bookedCount).toBe(1);
    const past = dashboardRowsFor({ userId: null, ownerToken: token }, new Date('2027-07-01T00:00:00Z'))[0]!;
    expect(past.lifecycle).toBe('past');
  });
});
