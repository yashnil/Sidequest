import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAnswersInput } from './actions';

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
 * These tests drive the actions the browser posts to, in the pattern of
 * `ownership.test.ts` and `actions.rate-limit.test.ts`: the cookie jar is a
 * mock, switching browsers is `jar.clear()`, and the assertions are about what
 * a foreign or scripted caller is actually told and what the database actually
 * holds afterwards.
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
 * The ranking is stubbed to fail fast: these tests are about the guards in
 * front of it, and the guards must answer before any ranking work happens. A
 * call that reaches the stub is recorded, because "the guard refused" and "the
 * ranking failed" must be distinguishable in every assertion below.
 */
const rankingCalls: string[] = [];
vi.mock('@/lib/destinations/recommend', () => ({
  recommendDestinations: async () => {
    rankingCalls.push('called');
    throw new Error('ranking stub');
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
  rankingCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-decide-ownership-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const ANSWERS: DecisionAnswersInput = {
  dateMode: 'undecided',
  nights: 6,
  shape: null,
  transport: null,
  pace: null,
  themes: ['outdoors'],
  outdoorIntensity: null,
  budget: null,
  adults: 2,
  children: 0,
  avoid: '',
};

/**
 * Start a session through the real door, as the browser named by `owner`.
 * The action redirects on success — which throws in a test — so the id is
 * read back from the row the door wrote.
 */
async function sessionStartedBy(owner: string): Promise<string> {
  jar.set('sidequest_session', owner);
  const { startDecisionAction } = await import('./actions');
  await startDecisionAction(ANSWERS).catch((error: unknown) => {
    // NEXT_REDIRECT is success by another name; anything else is a failure.
    if (!String((error as { digest?: string }).digest ?? error).includes('NEXT_REDIRECT')) {
      throw error;
    }
  });
  const { getDb } = await import('@/lib/db/client');
  const rows = getDb().prepare('SELECT id FROM decision_sessions ORDER BY created_at').all() as {
    id: string;
  }[];
  const last = rows[rows.length - 1];
  expect(last).toBeDefined();
  return last!.id;
}

describe('a decision session belongs to the browser that started it', () => {
  it('stamps the starting browser onto the session row', async () => {
    const id = await sessionStartedBy('session:mine');
    const { decisionOwnerToken } = await import('@/lib/db/decision-repository');
    expect(decisionOwnerToken(id)).toBe('session:mine');
  });

  it('refuses to rewrite the answers from a different browser, and keeps them', async () => {
    const id = await sessionStartedBy('session:mine');

    jar.set('sidequest_session', 'session:theirs');
    const { saveDecisionAnswersAction } = await import('./actions');
    const result = await saveDecisionAnswersAction(id, { ...ANSWERS, adults: 9 });

    // The same sentence a missing session gets: the URL must not be an oracle.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('We could not find that.');

    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    expect(getDecisionSession(id)?.answers.adults).toBe(2);
  });

  it('refuses to build a shortlist for a different browser, before any ranking work', async () => {
    const id = await sessionStartedBy('session:mine');

    jar.set('sidequest_session', 'session:theirs');
    const { buildShortlistAction } = await import('./actions');
    const result = await buildShortlistAction(id);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('We could not find that.');
    expect(rankingCalls, 'a refused stranger must not spend ranking work').toHaveLength(0);
  });

  it('refuses adoption from a different browser: no trip is minted, the session stays open', async () => {
    const id = await sessionStartedBy('session:mine');

    jar.set('sidequest_session', 'session:theirs');
    const { adoptDestinationAction } = await import('./actions');
    const result = await adoptDestinationAction(id, 'any-entry');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('We could not find that.');

    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    expect(getDecisionSession(id)?.resolvedTripId).toBeNull();
    const { getDb } = await import('@/lib/db/client');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM trips').get()).toEqual({ n: 0 });
  });

  it('still lets the owning browser save its own answers — the control', async () => {
    const id = await sessionStartedBy('session:mine');

    const { saveDecisionAnswersAction } = await import('./actions');
    const result = await saveDecisionAnswersAction(id, { ...ANSWERS, adults: 3 });

    expect(result.ok, result.error).toBe(true);
    const { getDecisionSession } = await import('@/lib/db/decision-repository');
    expect(getDecisionSession(id)?.answers.adults).toBe(3);
  });

  it('refuses a session that has no owner to every browser, not to whoever arrives next', async () => {
    // A legacy row, written before the owner column existed.
    const { createDecisionSession } = await import('@/lib/db/decision-repository');
    const { emptyComposerAnswers } = await import('@sidequest/core');
    const id = createDecisionSession(
      emptyComposerAnswers('help_me_decide', new Date()),
      null,
      new Date(),
    );

    jar.set('sidequest_session', 'session:anyone');
    const { saveDecisionAnswersAction } = await import('./actions');
    expect((await saveDecisionAnswersAction(id, ANSWERS)).ok).toBe(false);
  });
});

describe('the decide surface sits inside the rate fence', () => {
  it('refuses unbounded session creation, and writes no row for the refused call', async () => {
    jar.set('sidequest_session', 'session:script');
    const { startDecisionAction } = await import('./actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const allowance = ACTION_RATE_RULES.decide_start.capacity;

    for (let i = 0; i < allowance; i += 1) {
      await startDecisionAction(ANSWERS).catch((error: unknown) => {
        if (!String((error as { digest?: string }).digest ?? error).includes('NEXT_REDIRECT')) {
          throw error;
        }
      });
    }

    // The next press is a refusal that returns rather than redirects.
    const refused = await startDecisionAction(ANSWERS);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/getting a lot of requests|busy right now/);

    const { getDb } = await import('@/lib/db/client');
    const { n } = getDb().prepare('SELECT COUNT(*) AS n FROM decision_sessions').get() as {
      n: number;
    };
    expect(n, 'a refused creation must leave no row behind').toBe(allowance);
  });

  it('refuses unbounded shortlist builds from one caller', async () => {
    const id = await sessionStartedBy('session:mine');
    const { buildShortlistAction } = await import('./actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const allowance = ACTION_RATE_RULES.decide_shortlist.capacity;

    for (let i = 0; i < allowance; i += 1) {
      // The stubbed ranking fails; the token is still spent, which is the
      // property under test — a failing build is still a build attempt.
      const result = await buildShortlistAction(id);
      expect(result.error).not.toMatch(/getting a lot of requests|busy right now/);
    }

    const refused = await buildShortlistAction(id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/getting a lot of requests|busy right now/);
    expect(rankingCalls, 'the refused call must not reach the ranking').toHaveLength(allowance);
  });
});
