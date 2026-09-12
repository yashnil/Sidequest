import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE SHARE LINK'S ONLY SECRET.
 *
 * A trip's plan is shared by handing someone a token, and the token is the
 * entire security model: there are no accounts, so nothing else stands between
 * a stranger and somebody's holiday. These tests state the properties that make
 * that model honest rather than hopeful — the token is long random rather than
 * guessable, minting twice does not rotate a link somebody already sent, and
 * resolution answers to the token *alone*. The last one is the one that keeps a
 * trip id out of the share URL: an implementation that also matched on id would
 * turn every enumerable id into a working share link, which is precisely the
 * cross-user leakage §22 forbids.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-share-'));
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

async function makeTrip(): Promise<string> {
  const { createTrip } = await import('./repository');
  return createTrip(BASICS, 'session:owner').id;
}

describe('minting a share token', () => {
  it('is URL-safe and carries at least 128 bits of randomness', async () => {
    const { ensureShareToken } = await import('./repository');
    const id = await makeTrip();
    const token = ensureShareToken(id);
    // 22 base64url characters is 132 bits; anything shorter is guessable-in-
    // principle and anything outside the charset breaks the URL it lives in.
    expect(token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });

  it('mints once: a second press returns the link already sent', async () => {
    /*
     * Somebody shares a link, then presses Share again next week. Rotating the
     * token would silently kill the copy their friend already has — revoking
     * and replacing are separate, deliberate presses (below) — so the second
     * answer must be the first one.
     */
    const { ensureShareToken } = await import('./repository');
    const id = await makeTrip();
    const first = ensureShareToken(id);
    expect(ensureShareToken(id)).toBe(first);
  });

  it('gives two trips two different tokens', async () => {
    const { ensureShareToken } = await import('./repository');
    const one = ensureShareToken(await makeTrip());
    const two = ensureShareToken(await makeTrip());
    expect(one).not.toBe(two);
  });

  it('answers null for a trip that does not exist, rather than minting an orphan', async () => {
    const { ensureShareToken } = await import('./repository');
    expect(ensureShareToken('e2a2f2ce-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('resolving a share token', () => {
  it('resolves a valid token to exactly its trip', async () => {
    const { ensureShareToken, tripForShareToken } = await import('./repository');
    const id = await makeTrip();
    await makeTrip(); // A second trip, so "any trip" cannot pass for "its trip".
    const token = ensureShareToken(id);
    expect(token).not.toBeNull();
    expect(tripForShareToken(token!)?.id).toBe(id);
  });

  it('resolves an invented token to nothing', async () => {
    const { ensureShareToken, tripForShareToken } = await import('./repository');
    ensureShareToken(await makeTrip());
    expect(tripForShareToken('AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('never resolves a trip id: the URL takes the token or it takes nothing', async () => {
    /*
     * The enumeration door. A lookup that also matched on trip id — an OR, a
     * fallback, a "helpful" redirect — would make every trip readable by its
     * id with no share ever created. The trip below has a share token, and its
     * id still must not open it.
     */
    const { ensureShareToken, tripForShareToken } = await import('./repository');
    const id = await makeTrip();
    ensureShareToken(id);
    expect(tripForShareToken(id)).toBeNull();
  });

  it('resolves an unshared trip to nothing, even by an empty-string probe', async () => {
    /*
     * Every unshared trip has share_token NULL, and SQL's `= ''` and `= NULL`
     * are both false — but an implementation that normalised or defaulted the
     * column could make one probe open every unshared trip at once. Stated
     * here so it cannot regress silently.
     */
    const { tripForShareToken } = await import('./repository');
    await makeTrip();
    expect(tripForShareToken('')).toBeNull();
  });
});

describe('a database from before share links existed', () => {
  it('gains the column on open and can mint a token for an old trip', async () => {
    /*
     * The trips table exactly as it stood before this column (and before
     * owner_token, which also arrives by migration): written by hand, because
     * importing the current schema would migrate the present to the present
     * and pass forever.
     */
    const legacy = new Database(join(dir, 'test.db'));
    legacy.exec(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, destination_input TEXT NOT NULL,
        region_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        arrival_time TEXT NOT NULL, departure_time TEXT NOT NULL,
        adults INTEGER NOT NULL, children INTEGER NOT NULL,
        traveler_needs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare('INSERT INTO trips VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'trip-legacy', 'known_destination', 'Harbour City', 'open-world',
        '2026-09-01', '2026-09-04', '10:00', '18:00', 2, 0, '[]', 'draft',
        '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z',
      );
    legacy.close();

    const { ensureShareToken, tripForShareToken } = await import('./repository');
    const token = ensureShareToken('trip-legacy');
    expect(token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(tripForShareToken(token!)?.id).toBe('trip-legacy');
  });
});

describe('revoking and replacing a share link (V9 §24)', () => {
  it('a revoked token opens nothing, exactly like a token that never existed', async () => {
    const { ensureShareToken, revokeShareToken, tripForShareToken } = await import('./repository');
    const id = await makeTrip();
    const token = ensureShareToken(id)!;
    expect(tripForShareToken(token)?.id).toBe(id);
    expect(revokeShareToken(id)).toBe(true);
    expect(tripForShareToken(token)).toBeNull();
    /* Revoking twice is not an error; it is a link that is already gone. */
    expect(revokeShareToken(id)).toBe(false);
    /* Sharing again mints a fresh token; the old one stays dead. */
    const fresh = ensureShareToken(id)!;
    expect(fresh).not.toBe(token);
    expect(tripForShareToken(fresh)?.id).toBe(id);
    expect(tripForShareToken(token)).toBeNull();
  });

  it('a rotated token opens the trip and the old one does not, with no instant in which both do', async () => {
    const { ensureShareToken, rotateShareToken, tripForShareToken } = await import('./repository');
    const id = await makeTrip();
    const old = ensureShareToken(id)!;
    const fresh = rotateShareToken(id);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(fresh).not.toBe(old);
    expect(tripForShareToken(fresh!)?.id).toBe(id);
    expect(tripForShareToken(old)).toBeNull();
  });

  it('rotating an unshared trip mints its first link; rotating a missing trip mints nothing', async () => {
    const { rotateShareToken, tripForShareToken } = await import('./repository');
    const id = await makeTrip();
    const token = rotateShareToken(id);
    expect(token).not.toBeNull();
    expect(tripForShareToken(token!)?.id).toBe(id);
    expect(rotateShareToken('e2a2f2ce-0000-4000-8000-000000000000')).toBeNull();
  });
});
