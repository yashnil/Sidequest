import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Wikimedia from '@/lib/providers/wikimedia';
import type * as AdvisorActions from './advisor-actions';
import type * as SidequestCore from '@sidequest/core';

/**
 * WHOSE DECISION THIS IS, AND HOW FAST ANYONE MAY MAKE ONE.
 *
 * A review demonstrated both halves from a second browser with no cookies:
 * every decision action succeeded against a known session UUID — reading the
 * traveller's answers, rewriting them, and adopting the destination into a
 * trip owned by the *stranger's* cookie, after which the legitimate traveller
 * reads "You have already chosen for this one" for ever — and two hundred
 * scripted session-creations produced two hundred rows with no refusal at any
 * layer, because the decide surface sat outside `ACTION_RATE_RULES` entirely.
 *
 * Those guards were written for the ranker the destination advisor replaced,
 * and this file is what keeps them on the advisor's actions now that the old
 * ones are gone. It drives the actions the browser posts to, in the pattern of
 * `ownership.test.ts` and `actions.rate-limit.test.ts`: the cookie jar is a
 * mock, switching browsers is a different cookie (or none), and the assertions
 * are about what a foreign or scripted caller is actually told and what the
 * database actually holds afterwards.
 */

const jar = new Map<string, string>();

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
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

/**
 * Everything behind the guards is stubbed to record that it was reached: the
 * ranking, the research call and the image lookups. These tests are about the
 * guards in front of that work, and the guards must answer before any of it
 * happens — so "the guard refused" and "the work failed" have to be
 * distinguishable in every assertion below.
 */
const work = { ranking: 0, research: 0, imagery: 0 };

vi.mock('@/lib/destinations/advisor', () => ({
  adviseFor: async () => {
    work.ranking += 1;
    throw new Error('ranking stub');
  },
  widenWithResearch: async () => {
    work.research += 1;
    throw new Error('research stub');
  },
}));

/** A stored list is always "weak enough to research", so only the guards decide whether research is reached. */
/* Whether a list is weak enough to widen is a pure question answered in core; here it is always yes, so the guards in front of the widening are what is under test. */
vi.mock('@sidequest/core', async (original) => ({ ...(await original<typeof SidequestCore>()), needsResearch: () => true }));

/**
 * The curated catalog alone — the advisor's own documented fallback when the
 * atlas file cannot be read — so these tests do not depend on that file.
 */
vi.mock('@/lib/atlas/world', async () => {
  const { arrayWorld, destinationCatalog, DESTINATION_CATALOG_VERSION } = await import('@sidequest/core');
  const world = arrayWorld(destinationCatalog(), DESTINATION_CATALOG_VERSION);
  return { advisorWorld: () => ({ world, atlas: null, version: DESTINATION_CATALOG_VERSION, degraded: 'test' }) };
});

vi.mock('@/lib/providers/wikimedia', async (original) => ({
  ...(await original<typeof Wikimedia>()),
  resolveImageryForSubjects: async () => {
    work.imagery += 1;
    return [];
  },
}));

let dir: string;
const researchChoice = process.env.SIDEQUEST_ADVISOR_RESEARCH;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/*
 * The first import of the actions compiles the advisor, the catalog and the
 * repositories behind them. Paid here, once, rather than inside whichever test
 * happens to run first and against its five seconds.
 */
beforeAll(async () => {
  await import('./advisor-actions');
}, 120_000);

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  work.ranking = 0;
  work.research = 0;
  work.imagery = 0;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-advisor-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  /* On, so that the research step is reachable and only the guards keep a caller from it. */
  process.env.SIDEQUEST_ADVISOR_RESEARCH = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  if (researchChoice === undefined) delete process.env.SIDEQUEST_ADVISOR_RESEARCH;
  else process.env.SIDEQUEST_ADVISOR_RESEARCH = researchChoice;
  rmSync(dir, { recursive: true, force: true });
});

const REQUEST = 'hiking and mountains in July, a week';
const REFUSAL = 'We could not find that.';
const THROTTLED = /getting a lot of requests|busy right now/;

/** NEXT_REDIRECT is success by another name; anything else is a failure. */
function redirected(error: unknown): string {
  const digest = String((error as { digest?: string }).digest ?? error);
  if (!digest.includes('NEXT_REDIRECT')) throw error;
  return digest;
}

/**
 * Start a session through the real door, as the browser named by `owner`.
 * The action redirects on success — which throws in a test — so the id is
 * read back from the row the door wrote.
 */
async function sessionStartedBy(owner: string): Promise<string> {
  jar.set('sidequest_session', owner);
  const { startAdvisorAction } = await import('./advisor-actions');
  await startAdvisorAction({ text: REQUEST }).catch(redirected);
  const { getDb } = await import('@/lib/db/client');
  const rows = getDb().prepare('SELECT id FROM decision_sessions ORDER BY created_at').all() as { id: string }[];
  const last = rows[rows.length - 1];
  expect(last).toBeDefined();
  return last!.id;
}

/**
 * The same session with a real shortlist on disk — built by the advisor's own
 * pure ranking, exactly the shape the build action stores — so that every
 * action a stranger presses would otherwise have had something to act on.
 * Returns one destination that list offers.
 */
async function withStoredShortlist(id: string): Promise<string> {
  const { arrayWorld, buildAdvisorShortlist, destinationCatalog, DESTINATION_CATALOG_VERSION } = await import('@sidequest/core');
  const { getDecisionSession, saveDecisionShortlist } = await import('@/lib/db/decision-repository');
  const session = getDecisionSession(id);
  expect(session).not.toBeNull();
  const shortlist = buildAdvisorShortlist({
    answers: session!.answers,
    catalog: arrayWorld(destinationCatalog(), DESTINATION_CATALOG_VERSION),
    catalogVersion: DESTINATION_CATALOG_VERSION,
    now: new Date(),
  });
  saveDecisionShortlist(id, shortlist, new Date());
  const stored = getDecisionSession(id)?.advisor;
  expect(stored, 'the stored shortlist must read back as an advisor shortlist').not.toBeNull();
  expect(stored!.picks.length).toBeGreaterThan(0);
  return stored!.picks[0]!.id;
}

interface Snapshot {
  session: unknown;
  trips: number;
}

/** Everything a refused press must leave exactly as it found it. */
async function snapshot(id: string): Promise<Snapshot> {
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  return {
    session: db.prepare('SELECT * FROM decision_sessions WHERE id = ?').get(id),
    trips: (db.prepare('SELECT COUNT(*) AS n FROM trips').get() as { n: number }).n,
  };
}

type Actions = typeof AdvisorActions;
type Result = { ok: boolean; error?: string };

/** Every advisor action that takes a session id, pressed the way the screen presses it. */
const PRESSES: readonly [name: keyof Actions, press: (actions: Actions, id: string, pickId: string) => Promise<Result>][] = [
  [
    'saveAdvisorAnswersAction',
    async (actions, id) => {
      const { getDecisionSession } = await import('@/lib/db/decision-repository');
      return actions.saveAdvisorAnswersAction(id, { ...getDecisionSession(id)!.answers, adults: 9 });
    },
  ],
  ['buildAdvisorShortlistAction', (actions, id) => actions.buildAdvisorShortlistAction(id)],
  ['refineAdvisorAction', (actions, id) => actions.refineAdvisorAction(id, { different: true })],
  ['adoptAdvisorPickAction', (actions, id, pickId) => actions.adoptAdvisorPickAction(id, pickId)],
  ['resolveAdvisorImageryAction', (actions, id) => actions.resolveAdvisorImageryAction(id)],
  ['widenAdvisorShortlistAction', (actions, id) => actions.widenAdvisorShortlistAction(id)],
];

const STRANGERS: readonly [label: string, arrive: () => void][] = [
  ['a different browser', () => jar.set('sidequest_session', 'session-theirs')],
  ['a browser with no cookie at all', () => jar.clear()],
];

describe('a decision session belongs to the browser that started it', () => {
  it('stamps the starting browser onto the session row', async () => {
    const id = await sessionStartedBy('session-mine');
    const { decisionOwnerToken } = await import('@/lib/db/decision-repository');
    expect(decisionOwnerToken(id)).toBe('session-mine');
  });

  describe.each(STRANGERS)('from %s', (_label, arrive) => {
    it.each(PRESSES)('%s is refused as a missing session, before any work, and writes nothing', async (_name, press) => {
      const id = await sessionStartedBy('session-mine');
      const pickId = await withStoredShortlist(id);
      const before = await snapshot(id);

      arrive();
      const result = await press(await import('./advisor-actions'), id, pickId);

      // The same sentence a missing session gets: the URL must not be an oracle.
      expect(result.ok).toBe(false);
      expect(result.error).toBe(REFUSAL);
      expect(work, 'a refused stranger must not spend ranking, research or image work').toEqual({ ranking: 0, research: 0, imagery: 0 });
      // Byte for byte: the answers, the stored list, the open state and the timestamp.
      expect(await snapshot(id)).toEqual(before);
    });
  });

  it('refuses adoption from a different browser: no trip is minted, the session stays open for its owner', async () => {
    const id = await sessionStartedBy('session-mine');
    const pickId = await withStoredShortlist(id);

    jar.set('sidequest_session', 'session-theirs');
    const { adoptAdvisorPickAction } = await import('./advisor-actions');
    expect((await adoptAdvisorPickAction(id, pickId)).error).toBe(REFUSAL);

    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    expect(getDecisionSession(id)?.resolvedTripId).toBeNull();

    // The control: the very same press from the owner mints exactly one trip,
    // under the owner's cookie, and closes the session.
    jar.set('sidequest_session', 'session-mine');
    const digest = await adoptAdvisorPickAction(id, pickId).then(
      (result) => expect.fail(`the owner's adoption returned instead of redirecting: ${result.error}`),
      redirected,
    );
    const tripId = getDecisionSession(id)?.resolvedTripId;
    expect(tripId).toBeTruthy();
    expect(digest).toContain(`/trips/${tripId}/plan`);
    const { getDb } = await import('@/lib/db/client');
    expect(getDb().prepare('SELECT id, owner_token FROM trips').all()).toEqual([{ id: tripId, owner_token: 'session-mine' }]);
  });

  it('does not let a stranger learn whether the deployment is busy, or drain the owner’s allowance', async () => {
    const id = await sessionStartedBy('session-mine');
    await withStoredShortlist(id);
    const { buildAdvisorShortlistAction, refineAdvisorAction, resolveAdvisorImageryAction } = await import('./advisor-actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');

    // Ownership answers before the fence: however often a stranger presses, the
    // answer is the missing-session sentence and never the throttling one.
    jar.set('sidequest_session', 'session-theirs');
    for (let i = 0; i < ACTION_RATE_RULES.decide_shortlist.capacity * 3; i += 1) {
      for (const result of [await buildAdvisorShortlistAction(id), await refineAdvisorAction(id, { reset: true }), await resolveAdvisorImageryAction(id)]) {
        expect(result.error).toBe(REFUSAL);
      }
    }

    // And the owner's next press is still served: it reaches the (stubbed) ranking.
    jar.set('sidequest_session', 'session-mine');
    const mine = await buildAdvisorShortlistAction(id);
    expect(mine.error).not.toMatch(THROTTLED);
    expect(work.ranking).toBe(1);
  });

  it('still lets the owning browser act on its own session — the control', async () => {
    const id = await sessionStartedBy('session-mine');
    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    const actions = await import('./advisor-actions');

    const saved = await actions.saveAdvisorAnswersAction(id, { ...getDecisionSession(id)!.answers, adults: 3 });
    expect(saved.ok, saved.error).toBe(true);
    expect(getDecisionSession(id)?.answers.adults).toBe(3);

    // With a list on disk, each remaining action gets past its guards to the work behind them.
    await withStoredShortlist(id);
    expect((await actions.resolveAdvisorImageryAction(id)).ok).toBe(true);
    expect(work.imagery).toBe(1);
    await actions.widenAdvisorShortlistAction(id);
    expect(work.research).toBe(1);
    await actions.buildAdvisorShortlistAction(id);
    await actions.refineAdvisorAction(id, { different: true });
    expect(work.ranking).toBe(2);
  });

  it('keeps what a browser must not change: the mode and the absence of a destination', async () => {
    const id = await sessionStartedBy('session-mine');
    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    const { saveAdvisorAnswersAction } = await import('./advisor-actions');

    const result = await saveAdvisorAnswersAction(id, {
      ...getDecisionSession(id)!.answers,
      mode: 'known_destination',
      destinationQuery: 'Somewhere the browser made up',
    });

    expect(result.ok, result.error).toBe(true);
    const stored = getDecisionSession(id)!.answers;
    expect(stored.mode).toBe('help_me_decide');
    expect(stored.destinationQuery).toBeUndefined();
    expect(stored.destination).toBeUndefined();
  });

  describe('a session that has no owner is refused to every browser, not handed to whoever arrives next', () => {
    /** A legacy row, written before the owner column existed. */
    async function unownedSession(): Promise<string> {
      const { createDecisionSession } = await import('@/lib/db/decision-repository');
      const { emptyAdvisorAnswers, emptyComposerAnswers } = await import('@sidequest/core');
      const now = new Date();
      return createDecisionSession({ ...emptyComposerAnswers('help_me_decide', now), discovery: emptyAdvisorAnswers() }, null, now);
    }

    it.each(PRESSES)('%s', async (_name, press) => {
      const id = await unownedSession();
      const pickId = await withStoredShortlist(id);
      const before = await snapshot(id);

      jar.set('sidequest_session', 'session-anyone');
      const result = await press(await import('./advisor-actions'), id, pickId);

      expect(result.ok).toBe(false);
      expect(result.error).toBe(REFUSAL);
      expect(work).toEqual({ ranking: 0, research: 0, imagery: 0 });
      expect(await snapshot(id)).toEqual(before);
    });
  });
});

describe('the decide surface sits inside the rate fence', () => {
  it('refuses unbounded session creation, and writes no row for the refused call', async () => {
    jar.set('sidequest_session', 'session-script');
    const { startAdvisorAction } = await import('./advisor-actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const allowance = ACTION_RATE_RULES.decide_start.capacity;

    for (let i = 0; i < allowance; i += 1) {
      await startAdvisorAction({ text: REQUEST }).catch(redirected);
    }

    // The next press is a refusal that returns rather than redirects.
    const refused = await startAdvisorAction({ text: REQUEST });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(THROTTLED);

    const { getDb } = await import('@/lib/db/client');
    const { n } = getDb().prepare('SELECT COUNT(*) AS n FROM decision_sessions').get() as { n: number };
    expect(n, 'a refused creation must leave no row behind').toBe(allowance);
  });

  it('refuses unbounded shortlist builds from one caller', async () => {
    const id = await sessionStartedBy('session-mine');
    const { buildAdvisorShortlistAction } = await import('./advisor-actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const allowance = ACTION_RATE_RULES.decide_shortlist.capacity;

    for (let i = 0; i < allowance; i += 1) {
      // The stubbed ranking fails; the token is still spent, which is the
      // property under test — a failing build is still a build attempt.
      const result = await buildAdvisorShortlistAction(id);
      expect(result.error).not.toMatch(THROTTLED);
    }

    const refused = await buildAdvisorShortlistAction(id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(THROTTLED);
    expect(work.ranking, 'the refused call must not reach the ranking').toBe(allowance);
  });

  it('fences the interview step, which reads no stored row and so has no owner to check', async () => {
    const id = await sessionStartedBy('session-mine');
    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    const answers = getDecisionSession(id)!.answers;
    const before = await snapshot(id);
    const { advisorStepAction } = await import('./advisor-actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const allowance = ACTION_RATE_RULES.decide_step.capacity;

    /*
     * The clock is held still for the loop. Each step really ranks the world,
     * so forty of them take seconds — and this bucket refills every two — which
     * would make "the forty-first is refused" a statement about how fast the
     * machine is rather than about the fence.
     */
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    try {
      // Any browser may ask what the next question would be for answers it holds
      // itself: nothing stored is read, so there is nothing of the owner's to leak.
      jar.set('sidequest_session', 'session-script');
      for (let i = 0; i < allowance; i += 1) {
        const step = await advisorStepAction(answers);
        expect(step.ok, `step ${i + 1} of ${allowance} was refused early`).toBe(true);
        expect(step.worldSize).toBeGreaterThan(0);
      }

      // The next one is refused, and a refusal carries no ranking at all.
      const refused = await advisorStepAction(answers);
      expect(refused).toMatchObject({ ok: false, questionId: null, ready: false, leaders: [], values: [], worldSize: 0 });

      // The script's allowance is its own: the owner is still served.
      jar.set('sidequest_session', 'session-mine');
      expect((await advisorStepAction(answers)).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // And nothing was written or spent by any of it.
    expect(await snapshot(id)).toEqual(before);
    expect(work).toEqual({ ranking: 0, research: 0, imagery: 0 });
  }, 60_000);

  it('draws the refinement, the research and the pictures from that same allowance', async () => {
    const id = await sessionStartedBy('session-mine');
    await withStoredShortlist(id);
    const actions = await import('./advisor-actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');

    for (let i = 0; i < ACTION_RATE_RULES.decide_shortlist.capacity; i += 1) {
      await actions.buildAdvisorShortlistAction(id);
    }
    const spent = { ...work };

    const refined = await actions.refineAdvisorAction(id, { different: true });
    expect(refined.ok).toBe(false);
    expect(refined.error).toMatch(THROTTLED);
    // Returned without a sentence on purpose: the page reads a false result as
    // "no pictures yet" and "no wider list", which is right for throttling too.
    expect(await actions.resolveAdvisorImageryAction(id)).toEqual({ ok: false });
    expect(await actions.widenAdvisorShortlistAction(id)).toEqual({ ok: false });
    expect(work, 'a throttled press must not reach the work it was fencing').toEqual(spent);
  });
});
