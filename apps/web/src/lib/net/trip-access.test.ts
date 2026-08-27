import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE OWNERSHIP RULE'S OWN MATRIX, AT THE MODULE THAT STATES IT.
 *
 * The doors are asserted in `ownership-boundary.test.ts`, which drives the real
 * pages and actions; this file pins the four answers the shared helper may give
 * and — the one no door test can show — the internal-caller exemption: outside
 * a request scope there is no browser to judge, and the benchmark driver and
 * the compile worker must keep working. `cookies()` throwing is exactly how
 * that context announces itself, so the mock here can do both.
 */

const jar = new Map<string, string>();
let requestScope = true;

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => {
    if (!requestScope) throw new Error('cookies was called outside a request scope');
    return {
      get: (name: string) => {
        const value = jar.get(name);
        return value === undefined ? undefined : { value };
      },
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
    };
  },
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
  requestScope = true;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-trip-access-'));
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

async function tripOwnedBy(owner: string | null): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, owner).id;
}

describe('who a trip answers to', () => {
  it('lets the browser that made it through, and hands the page its trip', async () => {
    const mine = await tripOwnedBy('session:mine');
    jar.set('sidequest_session', 'session:mine');

    const { tripAccessRefusal, ownedTrip } = await import('./trip-access');
    expect(await tripAccessRefusal(mine)).toBeNull();
    expect((await ownedTrip(mine))?.id).toBe(mine);
  });

  it('refuses a different browser with the same sentence the Share button uses', async () => {
    const theirs = await tripOwnedBy('session:theirs');
    jar.set('sidequest_session', 'session:mine');

    const { tripAccessRefusal, ownedTrip, FOREIGN_TRIP_REFUSAL } = await import('./trip-access');
    expect(await tripAccessRefusal(theirs)).toBe(FOREIGN_TRIP_REFUSAL);
    // A foreign trip reads as a missing one; the URL is not an oracle.
    expect(await ownedTrip(theirs)).toBeNull();
  });

  it('refuses a request that presents no cookie at all, and mints nothing', async () => {
    const theirs = await tripOwnedBy('session:theirs');

    const { tripAccessRefusal } = await import('./trip-access');
    expect(await tripAccessRefusal(theirs)).not.toBeNull();
    // Nothing left behind by a refusal: no session was minted into the jar.
    expect(jar.size).toBe(0);
  });

  it('refuses everyone for a trip that belongs to nobody', async () => {
    // Same rule as listing and deletion: rows nobody can claim answer to nobody.
    const unowned = await tripOwnedBy(null);
    jar.set('sidequest_session', 'session:mine');

    const { tripAccessRefusal, ownedTrip } = await import('./trip-access');
    expect(await tripAccessRefusal(unowned)).not.toBeNull();
    expect(await ownedTrip(unowned)).toBeNull();
  });

  it('exempts a caller with no request scope, which no HTTP request can be', async () => {
    const theirs = await tripOwnedBy('session:theirs');
    requestScope = false;

    const { tripAccessRefusal, ownedTrip } = await import('./trip-access');
    expect(await tripAccessRefusal(theirs)).toBeNull();
    expect((await ownedTrip(theirs))?.id).toBe(theirs);
  });
});
