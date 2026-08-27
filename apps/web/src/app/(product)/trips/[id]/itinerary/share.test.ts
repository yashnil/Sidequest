import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHO MAY MINT A SHARE LINK.
 *
 * The token is unguessable, but minting one must still be the owner's act: an
 * action that minted for whoever supplied a trip id would let anybody who
 * learned an id — a shoulder-surfed URL, a pasted screenshot — turn it into a
 * durable public link to somebody else's holiday. The boundary is the same one
 * the Remove button uses: the browser's `sidequest_session` cookie against the
 * trip's `owner_token`, no account required.
 *
 * Driven through the exported server action rather than the repository, for the
 * reason `ownership.test.ts` states: the defect worth guarding against is not
 * "the check exists", it is "the door performs it".
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-share-action-'));
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

describe('the Share control on somebody else’s trip', () => {
  it('refuses a different browser, and mints nothing', async () => {
    const theirs = await tripOwnedBy('session:theirs');
    jar.set('sidequest_session', 'session:mine');

    const { createShareLinkAction } = await import('./actions');
    const result = await createShareLinkAction(theirs);

    expect(result.ok).toBe(false);
    expect(result.path).toBeUndefined();

    /*
     * Refusal must leave no token behind: a minted-but-unreturned token is a
     * live public link nobody knows exists.
     */
    const { getDb } = await import('@/lib/db/client');
    const row = getDb()
      .prepare('SELECT share_token FROM trips WHERE id = ?')
      .get(theirs) as { share_token: string | null };
    expect(row.share_token).toBeNull();
  });

  it('refuses a browser with no session at all', async () => {
    const theirs = await tripOwnedBy('session:theirs');
    const { createShareLinkAction } = await import('./actions');
    expect((await createShareLinkAction(theirs)).ok).toBe(false);
  });

  it('refuses a trip that belongs to nobody', async () => {
    // Same rule as deletion: "you may share the rows nobody can claim" is not
    // a rule worth having.
    const unowned = await tripOwnedBy(null);
    jar.set('sidequest_session', 'session:mine');
    const { createShareLinkAction } = await import('./actions');
    expect((await createShareLinkAction(unowned)).ok).toBe(false);
  });
});

describe('the Share control on your own trip', () => {
  it('hands back a token path, not a trip-id path', async () => {
    /*
     * The control. And the shape assertion is the security half: a share path
     * carrying the trip id would hand every reader the owner surfaces.
     */
    const mine = await tripOwnedBy('session:mine');
    jar.set('sidequest_session', 'session:mine');

    const { createShareLinkAction } = await import('./actions');
    const result = await createShareLinkAction(mine);

    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/^\/share\/[A-Za-z0-9_-]{22,}$/);
    expect(result.path).not.toContain(mine);
  });

  it('answers a second press with the same link', async () => {
    const mine = await tripOwnedBy('session:mine');
    jar.set('sidequest_session', 'session:mine');

    const { createShareLinkAction } = await import('./actions');
    const first = await createShareLinkAction(mine);
    const second = await createShareLinkAction(mine);
    expect(second.path).toBe(first.path);
  });

  it('tells the truth about a trip that no longer exists', async () => {
    jar.set('sidequest_session', 'session:mine');
    const { createShareLinkAction } = await import('./actions');
    const result = await createShareLinkAction('e2a2f2ce-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
  });
});
