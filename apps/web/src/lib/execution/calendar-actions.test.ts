import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9 §10 — WHO MAY CREATE OR REVOKE A CALENDAR SUBSCRIPTION.
 *
 * The same boundary every trip door uses, driven through the exported server
 * actions in the pattern `ownership-boundary.test.ts` set: a foreign cookie
 * is refused with the shared sentence, the owner gets past the guard, the
 * token is stored only as a hash, and a revoked token opens nothing.
 */
const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'host' ? 'sidequest.test' : name === 'x-forwarded-proto' ? 'https' : null) }),
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-calendar-actions-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  delete process.env.SIDEQUEST_BASE_URL;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_BASE_URL;
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = 'owner-browser';
const INTRUDER = 'intruder-browser';

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

async function seededTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, OWNER).id;
}

describe('the calendar feed actions', () => {
  it('refuse a foreign browser and a browser with no cookie, and mint nothing for either', async () => {
    const tripId = await seededTrip();
    const { createCalendarFeedAction, revokeCalendarFeedAction, calendarFeedStatusAction } = await import('./calendar-actions');
    const { getDb } = await import('@/lib/db/client');

    jar.set('sidequest_session', INTRUDER);
    expect(await createCalendarFeedAction(tripId)).toEqual({ ok: false, error: expect.stringContaining('different browser') });
    expect(await revokeCalendarFeedAction(tripId)).toEqual({ ok: false, error: expect.stringContaining('different browser') });
    expect(await calendarFeedStatusAction(tripId)).toEqual({ ok: false, error: expect.stringContaining('different browser') });
    jar.clear();
    expect((await createCalendarFeedAction(tripId)).ok).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_feeds').get()).toEqual({ n: 0 });
  });

  it('hands the owner the URL once, stores only its hash, and completes the origin from the request', async () => {
    const tripId = await seededTrip();
    const { createCalendarFeedAction, calendarFeedStatusAction } = await import('./calendar-actions');
    const { hashFeedToken, tripForFeedToken } = await import('@/lib/db/execution-repository');
    const { getDb } = await import('@/lib/db/client');

    jar.set('sidequest_session', OWNER);
    const result = await createCalendarFeedAction(tripId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toMatch(/^\/api\/calendar\/[A-Za-z0-9_-]{40,}$/);
    expect(result.url).toBe(`https://sidequest.test${result.path}`);
    expect(result.webcal).toBe(`webcal://sidequest.test${result.path}`);
    const token = result.path.slice('/api/calendar/'.length);
    const row = getDb().prepare('SELECT token_hash, revoked_at FROM calendar_feeds WHERE trip_id = ?').get(tripId) as { token_hash: string; revoked_at: string | null };
    expect(row.token_hash).toBe(hashFeedToken(token));
    expect(row.revoked_at).toBeNull();
    expect(JSON.stringify(getDb().prepare('SELECT * FROM calendar_feeds').all())).not.toContain(token);
    expect(tripForFeedToken(token)).toBe(tripId);
    const status = await calendarFeedStatusAction(tripId);
    expect(status.ok && status.active !== null).toBe(true);
  });

  it('prefers the configured base URL over the request host', async () => {
    const tripId = await seededTrip();
    process.env.SIDEQUEST_BASE_URL = 'https://app.sidequest.example/';
    const { createCalendarFeedAction } = await import('./calendar-actions');
    jar.set('sidequest_session', OWNER);
    const result = await createCalendarFeedAction(tripId);
    expect(result.ok && result.url?.startsWith('https://app.sidequest.example/api/calendar/')).toBe(true);
  });

  it('revokes, after which the token opens nothing and a new one can be minted', async () => {
    const tripId = await seededTrip();
    const { createCalendarFeedAction, revokeCalendarFeedAction, calendarFeedStatusAction } = await import('./calendar-actions');
    const { tripForFeedToken } = await import('@/lib/db/execution-repository');

    jar.set('sidequest_session', OWNER);
    const first = await createCalendarFeedAction(tripId);
    if (!first.ok) throw new Error(first.error);
    const token = first.path.slice('/api/calendar/'.length);
    expect(await revokeCalendarFeedAction(tripId)).toEqual({ ok: true, revoked: 1 });
    expect(tripForFeedToken(token)).toBeNull();
    expect(await calendarFeedStatusAction(tripId)).toEqual({ ok: true, active: null });
    const second = await createCalendarFeedAction(tripId);
    expect(second.ok && second.path !== first.path).toBe(true);
  });
});
