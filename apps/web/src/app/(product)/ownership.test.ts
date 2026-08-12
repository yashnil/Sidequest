import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHOSE TRIPS THESE ARE.
 *
 * A review loaded the live homepage and read: "Or pick up one of your 180
 * trips… Your trips … Harbour City … Open the plan · Remove … Show 174 more
 * trips". `listTrips()` had no owner predicate and `trips` had no owner column,
 * so every visitor was shown every trip in the database under a second-person
 * heading, with a control that deletes them. §22 asks for trip ownership and no
 * cross-user leakage.
 *
 * The boundary is the browser's `sidequest_session` cookie — no account, no
 * login, nothing personal, and the product's "no account needed" promise is
 * untouched. These tests state the two halves that matter: one browser cannot
 * *see* another's trips, and cannot *delete* one either, because a list
 * predicate alone would leave the destructive action taking any id it was
 * handed.
 *
 * The cookie jar is a mock, and switching browsers is `jar.clear()`.
 */

const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
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

/** A trip made by a named browser, through the repository the doors use. */
async function tripOwnedBy(owner: string | null): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, owner).id;
}

describe('the trips a browser is shown', () => {
  it('lists its own and not another browser’s', async () => {
    const { listTrips } = await import('@/lib/db/repository');
    const mine = await tripOwnedBy('session:mine');
    await tripOwnedBy('session:theirs');

    const listed = listTrips('session:mine');
    expect(listed.map((trip) => trip.id)).toEqual([mine]);
  });

  it('shows a first-time visitor nothing rather than everything', async () => {
    const { listTrips } = await import('@/lib/db/repository');
    await tripOwnedBy('session:mine');
    await tripOwnedBy('session:theirs');

    // A browser with no cookie yet has made nothing, and "nothing" is the
    // honest answer. This is the exact call the homepage makes on a first
    // visit, where a page render cannot mint a token.
    expect(listTrips(null)).toEqual([]);
  });

  it('lists an unowned legacy trip to nobody', async () => {
    const { listTrips } = await import('@/lib/db/repository');
    await tripOwnedBy(null);

    expect(listTrips('session:mine')).toEqual([]);
    expect(listTrips(null)).toEqual([]);
  });
});

describe('the Remove button on somebody else’s trip', () => {
  it('refuses a delete from a different browser, and the trip survives', async () => {
    const theirs = await tripOwnedBy('session:theirs');

    jar.set('sidequest_session', 'session:mine');
    const { deleteTripAction } = await import('./actions');
    const result = await deleteTripAction(theirs);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('different browser');

    const { getTrip } = await import('@/lib/db/repository');
    expect(getTrip(theirs)).not.toBeNull();
  });

  it('refuses a delete from a browser with no session at all', async () => {
    const theirs = await tripOwnedBy('session:theirs');

    const { deleteTripAction } = await import('./actions');
    expect((await deleteTripAction(theirs)).ok).toBe(false);

    const { getTrip } = await import('@/lib/db/repository');
    expect(getTrip(theirs)).not.toBeNull();
  });

  it('still removes a trip for the browser that made it', async () => {
    /*
     * The control. A guard that refused everybody would pass both assertions
     * above and break the product, so the ordinary case is asserted beside
     * them.
     */
    const mine = await tripOwnedBy('session:mine');
    jar.set('sidequest_session', 'session:mine');

    const { deleteTripAction } = await import('./actions');
    expect((await deleteTripAction(mine)).ok).toBe(true);

    const { getTrip } = await import('@/lib/db/repository');
    expect(getTrip(mine)).toBeNull();
  });
});

describe('the doors that make trips', () => {
  it('stamps the browser onto the trip, so it appears in that browser’s list', async () => {
    /*
     * Through the real composer action rather than the repository, because the
     * defect this closes is not "the column exists" — it is "the door writes
     * it". A door that forgot would make a trip nobody can ever see again.
     */
    jar.set('sidequest_session', 'session:mine');
    const { createTripFromComposer } = await import('./trips/new/actions');
    const created = await createTripFromComposer({
      destinationText: 'Harbour City',
      destinationEntryId: null,
      dateMode: 'exact',
      startDate: '2026-09-01',
      endDate: '2026-09-04',
      flexDays: 0,
      month: 9,
      season: 'autumn',
      wantsDateRecommendation: false,
      wantsLengthRecommendation: false,
      nights: 3,
      arrivalPrecision: 'unknown',
      departurePrecision: 'unknown',
      adults: 2,
      children: 0,
      travelerNeeds: [],
      shape: null,
      pace: null,
      transport: null,
      budget: null,
      themes: [],
      crowdTolerance: null,
      outdoorIntensity: null,
      foodImportance: null,
      freeTime: null,
      mustDo: '',
      avoid: '',
      origin: '',
    });
    expect(created.ok, created.error ?? JSON.stringify(created.fieldErrors)).toBe(true);

    const { listTrips } = await import('@/lib/db/repository');
    expect(listTrips('session:mine')).toHaveLength(1);
    expect(listTrips('session:theirs')).toHaveLength(0);
  });
});
