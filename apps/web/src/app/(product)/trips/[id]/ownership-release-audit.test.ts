import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RELEASE AUDIT — THE DOORS THE OWNERSHIP SUITE HAD NOT YET KNOCKED ON.
 *
 * `ownership-boundary.test.ts` and its siblings drive most trip doors with a
 * foreign cookie; the audit listed the ones only a source regex stood behind.
 * Each is driven here as a stranger — a different browser, and a guest cookie
 * on a trip that has been claimed by an account — and must refuse without
 * changing a row. Secondary ids get their own cases: my trip's cookie, your
 * booking's or your traveller's id.
 */

const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/server', async (original) => ({ ...(await original<object>()), after: () => undefined }));
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
vi.mock('@/lib/compiler/worker/launch', () => ({ compilerIsolationMode: () => 'process', launchCompilationWorker: () => ({ launched: true }) }));

vi.setConfig({ testTimeout: 60_000 });

const OWNER = 'owner-browser-token-0123456789';
const STRANGER = 'stranger-browser-token-012345';
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
const BOOKING = { type: 'custom' as const, title: 'Private booking', status: 'booked' as const, locked: true };
const PERSON = { displayName: 'Mum', dietaryNeeds: [], dietaryStrict: false, needs: [] };

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-ownership-audit-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

async function tripOf(owner: string, userId: string | null = null): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  return createTrip(BASICS, owner, userId).id;
}

/** Everything a refused door must have left alone, as one comparable value. */
async function fingerprint(tripId: string): Promise<string> {
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const read = (sql: string): unknown[] => db.prepare(sql).all(tripId);
  return JSON.stringify([
    read('SELECT id, title, status, archived_at, lifecycle_override, start_date, end_date, share_token FROM trips WHERE id = ?'),
    read('SELECT * FROM booked_plan_items WHERE trip_id = ?'),
    read('SELECT * FROM readiness_profiles WHERE trip_id = ?'),
    read('SELECT * FROM trip_checks WHERE trip_id = ?'),
    read('SELECT * FROM trip_party_members WHERE trip_id = ?'),
    read('SELECT * FROM trip_feedback WHERE trip_id = ?'),
    read('SELECT * FROM generation_progress WHERE trip_id = ?'),
    (db.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n,
  ]);
}

type Door = [string, (id: string) => Promise<unknown>];

async function doors(): Promise<Door[]> {
  const itinerary = await import('./itinerary/actions');
  const refresh = await import('./itinerary/refresh-actions');
  const questionnaire = await import('./questionnaire/actions');
  const timing = await import('./questionnaire/timing-actions');
  const party = await import('./party/actions');
  const feedback = await import('./feedback/actions');
  const alpha = await import('./feedback/alpha-actions');
  const dashboard = await import('../dashboard-actions');
  const refine = await import('@/lib/refine/actions');
  const near = { lat: 1, lng: 1 };
  const answers = {} as never;
  return [
    ['addBookedItem', (id) => itinerary.addBookedItemAction(id, BOOKING as never)],
    ['removeBookedItem', (id) => itinerary.removeBookedItemAction(id, 'any')],
    ['updateBookedItem', (id) => itinerary.updateBookedItemAction(id, 'any', { title: 'x' })],
    ['saveReadinessProfile', (id) => itinerary.saveReadinessProfileAction(id, {} as never)],
    ['clearReadinessProfile', (id) => itinerary.clearReadinessProfileAction(id)],
    ['setCheck', (id) => itinerary.setCheckAction(id, 'packing', 'item', true)],
    ['moveStop', (id) => itinerary.moveStopAction(id, 1, 's', 2)],
    ['shiftStop', (id) => itinerary.shiftStopAction(id, 1, 's', 'later')],
    ['setStopDuration', (id) => itinerary.setStopDurationAction(id, 1, 's', 60)],
    ['addCustomStop', (id) => itinerary.addCustomStopAction(id, 1, { title: 'A stop' })],
    ['setStopKeep', (id) => itinerary.setStopKeepAction(id, 1, 's', 'must_keep')],
    ['fixDay', (id) => itinerary.fixDayAction(id, 1)],
    ['discoverStays', (id) => itinerary.discoverStaysAction(id, near)],
    ['discoverFood', (id) => itinerary.discoverFoodAction(id, near)],
    ['rebuildWithImprovedPlanning', (id) => refresh.rebuildWithImprovedPlanningAction(id)],
    ['refinementReady', (id) => refine.refinementReadyAction({ tripId: id })],
    ['completeAndBuild', (id) => questionnaire.completeAndBuildAction(id, answers)],
    ['startBuild', (id) => questionnaire.startBuildAction(id, answers, 'audit-build-key')],
    ['retryBuild', (id) => questionnaire.retryBuildAction(id, 'audit-build-key')],
    ['exploreExperiences', (id) => questionnaire.exploreExperiencesAction(id, answers)],
    ['recommendTripTiming', (id) => timing.recommendTripTimingAction(id)],
    ['acceptTripTiming', (id) => timing.acceptTripTimingAction(id, { startDate: '2026-10-01', endDate: '2026-10-04', month: 10, year: 2026, label: 'x', reasons: [] } as never)],
    ['renameTrip', (id) => dashboard.renameTripAction(id, 'Stolen')],
    ['duplicateTrip', (id) => dashboard.duplicateTripAction(id)],
    ['archiveTrip', (id) => dashboard.archiveTripAction(id, true)],
    ['setLifecycle', (id) => dashboard.setLifecycleAction(id, null)],
    ['addPerson', (id) => party.addPersonAction(id, PERSON as never)],
    ['updatePerson', (id) => party.updatePersonAction(id, 'any', PERSON as never)],
    ['attachPerson', (id) => party.attachPersonAction(id, 'any')],
    ['removePerson', (id) => party.removePersonAction(id, 'any')],
    ['submitFeedback', (id) => feedback.submitFeedbackAction(id, { loved: [], skip: [] } as never)],
    ['submitAlphaFeedback', (id) => alpha.submitAlphaFeedbackAction(id, { rating: 'useful' })],
  ];
}

function expectRefused(name: string, result: unknown): void {
  expect((result as { ok?: boolean }).ok, `${name} answered ${JSON.stringify(result)}`).toBe(false);
}

describe('a stranger knocking on a door the audit found untested', () => {
  it('is refused by every one, and nothing changes', async () => {
    const tripId = await tripOf(OWNER);
    const { addBookedItem } = await import('@/lib/db/intelligence-repository');
    addBookedItem(tripId, BOOKING as never);
    const before = await fingerprint(tripId);
    jar.set('sidequest_session', STRANGER);
    for (const [name, door] of await doors()) {
      expectRefused(name, await door(tripId));
      expect(await fingerprint(tripId), name).toBe(before);
    }
  });

  it('holds for a browser with no cookie at all', async () => {
    const tripId = await tripOf(OWNER);
    const before = await fingerprint(tripId);
    for (const [name, door] of await doors()) expectRefused(name, await door(tripId));
    expect(await fingerprint(tripId)).toBe(before);
  });

  it('reads nothing back through the two doors that answer with data', async () => {
    const tripId = await tripOf(OWNER);
    jar.set('sidequest_session', STRANGER);
    const { generationProgressAction } = await import('./questionnaire/progress-actions');
    expect(await generationProgressAction(tripId)).toBeNull();
    const { GET } = await import('@/app/api/trips/[id]/progress/route');
    const response = await GET(new Request('http://x/'), { params: Promise.resolve({ id: tripId }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

describe('a claimed trip answers to its account, not the cookie that made it', () => {
  it('refuses the original guest cookie on every door', async () => {
    const { upsertUser } = await import('@/lib/db/auth-repository');
    const user = upsertUser({ provider: 'fixture', subject: 'owner-sub', email: 'owner@example.test' });
    const tripId = await tripOf(OWNER, user.id);
    const before = await fingerprint(tripId);
    jar.set('sidequest_session', OWNER);
    for (const [name, door] of await doors()) expectRefused(name, await door(tripId));
    expect(await fingerprint(tripId)).toBe(before);
  });
});

describe('my trip, your row', () => {
  it('cannot read, edit or remove another trip’s booking by guessing its id', async () => {
    const mine = await tripOf(OWNER);
    const theirs = await tripOf(STRANGER);
    const { addBookedItem, listBookedItems } = await import('@/lib/db/intelligence-repository');
    const booked = addBookedItem(theirs, BOOKING as never);
    const before = JSON.stringify(listBookedItems(theirs));
    jar.set('sidequest_session', OWNER);
    const itinerary = await import('./itinerary/actions');
    expect((await itinerary.updateBookedItemAction(mine, booked.id, { title: 'Hijacked' })).ok).toBe(false);
    await itinerary.removeBookedItemAction(mine, booked.id);
    await itinerary.addConfirmationAction(mine, booked.id, { notes: 'Hijacked' } as never);
    expect(JSON.stringify(listBookedItems(theirs))).toBe(before);
  });

  it('cannot edit or attach another browser’s traveller', async () => {
    const mine = await tripOf(OWNER);
    const theirs = await tripOf(STRANGER);
    const party = await import('./party/actions');
    jar.set('sidequest_session', STRANGER);
    const added = await party.addPersonAction(theirs, PERSON as never);
    expect(added.ok).toBe(true);
    const { getDb } = await import('@/lib/db/client');
    const { traveler_id: travelerId } = getDb().prepare('SELECT traveler_id FROM trip_party_members WHERE trip_id = ?').get(theirs) as { traveler_id: string };
    jar.set('sidequest_session', OWNER);
    expectRefused('update', await party.updatePersonAction(mine, travelerId, { ...PERSON, displayName: 'Hijacked' } as never));
    expectRefused('attach', await party.attachPersonAction(mine, travelerId));
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM trip_party_members WHERE trip_id = ?').get(mine) as { n: number }).n).toBe(0);
    expect((getDb().prepare('SELECT display_name AS n FROM travelers WHERE id = ?').get(travelerId) as { n: string }).n).toBe('Mum');
  });
});

describe('the audit’s input and spend findings, through the real doors', () => {
  it('keeps a booked idea an idea when its price is edited', async () => {
    const tripId = await tripOf(OWNER);
    jar.set('sidequest_session', OWNER);
    const { addBookedItem, listBookedItems } = await import('@/lib/db/intelligence-repository');
    const idea = addBookedItem(tripId, { type: 'custom', title: 'An idea', status: 'idea', locked: false } as never);
    const { updateBookedItemAction } = await import('./itinerary/actions');
    expect((await updateBookedItemAction(tripId, idea.id, { cost: { amount: 10, currency: 'EUR' } })).ok).toBe(true);
    const [after] = listBookedItems(tripId);
    expect(after).toMatchObject({ status: 'idea', locked: false, cost: { amount: 10, currency: 'EUR' } });
  });

  it('refuses a check list that is not one, so the trip stays loadable', async () => {
    const tripId = await tripOf(OWNER);
    jar.set('sidequest_session', OWNER);
    const { setCheckAction } = await import('./itinerary/actions');
    expect((await setCheckAction(tripId, '__proto__' as never, 'item', true)).ok).toBe(false);
    const { getDb } = await import('@/lib/db/client');
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM trip_checks WHERE trip_id = ?').get(tripId) as { n: number }).n).toBe(0);
  });

  it('refuses a timing window the trip schema could never read back', async () => {
    const tripId = await tripOf(OWNER);
    jar.set('sidequest_session', OWNER);
    const { acceptTripTimingAction } = await import('./questionnaire/timing-actions');
    await acceptTripTimingAction(tripId, { startDate: '2026-10-01', endDate: '2027-01-30', month: 10, year: 2026, label: 'x', reasons: [] } as never);
    const { getTrip } = await import('@/lib/db/repository');
    expect(getTrip(tripId)?.basics.endDate).toBe(BASICS.endDate);
  });

  it('fences the synchronous build door, and counts it against the caller', async () => {
    const tripId = await tripOf(OWNER);
    jar.set('sidequest_session', OWNER);
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const { takeRateToken } = await import('@/lib/net/rate-limit');
    for (let n = 0; n < ACTION_RATE_RULES.build_start.capacity + 2; n += 1) takeRateToken(`build_start:session:${OWNER}`, ACTION_RATE_RULES.build_start);
    const generate = await import('@/lib/planning/production-plan');
    const spy = vi.spyOn(generate, 'generateSidequestPlanForTrip');
    const { completeAndBuildAction } = await import('./questionnaire/actions');
    const refused = await completeAndBuildAction(tripId, {} as never);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/lot of requests/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fences the places lookups', async () => {
    const tripId = await tripOf(OWNER);
    jar.set('sidequest_session', OWNER);
    const { ACTION_RATE_RULES, takeRateToken } = await import('@/lib/net/rate-limit');
    for (let n = 0; n < ACTION_RATE_RULES.place_lookup.capacity + 2; n += 1) takeRateToken(`place_lookup:session:${OWNER}`, ACTION_RATE_RULES.place_lookup);
    const { discoverFoodAction } = await import('./itinerary/actions');
    const result = await discoverFoodAction(tripId, { lat: 1, lng: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lot of requests/);
  });
});

describe('cookies spelled like the ledger’s own keys', () => {
  it('cannot name a shared-fence bucket', async () => {
    jar.set('sidequest_session', 'random-value-0123:@deployment');
    const { requestIdentities } = await import('@/lib/net/caller');
    expect(await requestIdentities()).toEqual([]);
  });

  it('still gets a bucket for a token in the alphabet this deployment mints', async () => {
    jar.set('sidequest_session', '0b9e2a51-6f0c-4c58-9d0e-3c1f6f4f7a10.0123456789abcdef');
    const { requestIdentities } = await import('@/lib/net/caller');
    expect(await requestIdentities()).toEqual(['session:0b9e2a51-6f0c-4c58-9d0e-3c1f6f4f7a10.0123456789abcdef']);
  });

  it('a forged `user:` cookie is no account on the daily ledger', async () => {
    jar.set('sidequest_session', 'user:somebody-else');
    const { callerKey } = await import('@/lib/net/caller');
    expect(await callerKey()).toBeNull();
  });
});
