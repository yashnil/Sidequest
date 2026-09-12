import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9 — THE NEW DOORS ANSWER TO THE OWNER, LIKE EVERY OTHER TRIP DOOR.
 *
 * The recheck may reach a provider; revoking or replacing a share link changes
 * who can read a trip; a learned leaning belongs to an account. Each door is
 * driven here exactly as a browser would drive it — with a foreign cookie, then
 * the owner's, in the pattern `ownership-boundary.test.ts` set — so the defect
 * guarded against is "the door performs the check", not "the check exists".
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-recheck-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_AUTH_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_WEATHER_PROVIDER;
  delete process.env.SIDEQUEST_AUTH_PROVIDER;
  delete process.env.SIDEQUEST_ACTION_FENCES;
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

describe('the recheck and share doors, invoked with a foreign cookie', () => {
  type Invocation = (tripId: string) => Promise<{ ok: boolean; error?: string }>;
  const ACTIONS: { name: string; invoke: Invocation }[] = [
    { name: 'recheckStaleFactsAction', invoke: async (id) => (await import('./recheck-actions')).recheckStaleFactsAction(id) },
    { name: 'acknowledgeChangeAction', invoke: async (id) => (await import('./recheck-actions')).acknowledgeChangeAction(id, 'obs-1') },
    { name: 'revokeShareLinkAction', invoke: async (id) => (await import('@/app/(product)/trips/[id]/itinerary/share-actions')).revokeShareLinkAction(id) },
    { name: 'rotateShareLinkAction', invoke: async (id) => (await import('@/app/(product)/trips/[id]/itinerary/share-actions')).rotateShareLinkAction(id) },
  ];

  for (const action of ACTIONS) {
    it(`refuses ${action.name} for a foreign browser, and not for the owner`, async () => {
      const tripId = await seededTrip();
      const { FOREIGN_TRIP_REFUSAL } = await import('@/lib/net/trip-access');

      jar.set('sidequest_session', INTRUDER);
      const foreign = await action.invoke(tripId);
      expect(foreign.ok, `${action.name} let a foreign browser through`).toBe(false);
      expect(foreign.error).toBe(FOREIGN_TRIP_REFUSAL);

      jar.set('sidequest_session', OWNER);
      const own = await action.invoke(tripId);
      expect(own.error, `${action.name} refused its own maker`).not.toBe(FOREIGN_TRIP_REFUSAL);
    });
  }

  it('recheck on an unbuilt trip is a quiet skip for the owner, never a provider request', async () => {
    const tripId = await seededTrip();
    const { recheckStaleFactsAction } = await import('./recheck-actions');
    jar.set('sidequest_session', OWNER);
    const result = await recheckStaleFactsAction(tripId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toEqual({ ran: false, skipped: 'no_plan', lastCheckedAt: null });
    expect(result.observations).toEqual([]);
  });

  it('acknowledging a change writes only the owner’s trip, and only that observation', async () => {
    const tripId = await seededTrip();
    const other = await seededTrip();
    const { recordObservations, listObservations } = await import('@/lib/db/execution-repository');
    const { acknowledgeChangeAction } = await import('./recheck-actions');
    const base = { kind: 'forecast' as const, observedAt: '2026-08-01T12:00:00.000Z', previous: 'dry', current: 'rain', changed: true, dayNumbers: [2], summary: 'Day 2 now expects rain; it was dry when the plan was built.' };
    const [mine] = recordObservations(tripId, [{ ...base, factId: 'fact:forecast:2' }]);
    const [theirs] = recordObservations(other, [{ ...base, factId: 'fact:forecast:2' }]);

    jar.set('sidequest_session', INTRUDER);
    expect((await acknowledgeChangeAction(tripId, mine!.id)).ok).toBe(false);
    expect(listObservations(tripId)[0]?.acknowledgedAt).toBeNull();

    jar.set('sidequest_session', OWNER);
    /* The other trip's observation id, presented against this trip, touches nothing. */
    expect((await acknowledgeChangeAction(tripId, theirs!.id)).ok).toBe(true);
    expect(listObservations(other)[0]?.acknowledgedAt).toBeNull();
    expect((await acknowledgeChangeAction(tripId, mine!.id)).ok).toBe(true);
    expect(listObservations(tripId)[0]?.acknowledgedAt).not.toBeNull();
  });
});

describe('the learned-preference doors', () => {
  it('refuse a browser that is not signed in, and answer the signed-in account', async () => {
    const { dismissLearnedAction, restoreLearnedAction, confirmLearnedAction } = await import('@/app/(product)/profile/actions');
    for (const action of [dismissLearnedAction, restoreLearnedAction, confirmLearnedAction]) {
      const result = await action('interest:hiking');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Sign in');
    }

    const { fixtureSignInAction } = await import('@/app/(product)/signin/actions');
    expect((await fixtureSignInAction({ email: 'd@example.com' })).ok).toBe(true);
    expect((await dismissLearnedAction('interest:hiking')).ok).toBe(true);
    expect((await restoreLearnedAction('interest:hiking')).ok).toBe(true);
  });

  it('never dismiss or confirm a feature the ledger refuses to learn', async () => {
    const { fixtureSignInAction } = await import('@/app/(product)/signin/actions');
    expect((await fixtureSignInAction({ email: 'd@example.com' })).ok).toBe(true);
    const { dismissLearnedAction, confirmLearnedAction } = await import('@/app/(product)/profile/actions');
    expect((await dismissLearnedAction('diet:vegan')).ok).toBe(false);
    expect((await confirmLearnedAction('need:wheelchair')).ok).toBe(false);
  });
});
