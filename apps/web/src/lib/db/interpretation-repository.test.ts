import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRIP_COMPOSER_VERSION,
  cacheKeyForSpans,
  classifyPreferences,
  spansForModel,
  type TripComposerAnswers,
} from '@sidequest/core';
import {
  MODEL_OPERATION_MAX_ATTEMPTS,
  claimModelOperation,
  getCachedInterpretation,
  heartbeatModelOperation,
  latestModelOperation,
  operationKeyFor,
  saveCachedInterpretation,
  settleModelOperation,
  supersedeModelOperations,
} from './interpretation-repository';
import { getDb } from './client';

/**
 * THE ONE PAID READING, AND WHETHER IT IS ACTUALLY ONE.
 *
 * The defect: `readUnresolvedTextAction` read `interpretation.modelPass.calls`
 * and *then* awaited the provider. An `await` is where another invocation runs,
 * so two concurrent server actions both observed zero, both bought a call, and
 * the record still said one. Two tabs, a double click, a refresh mid-flight and
 * a retried server action all open that window.
 *
 * The concurrency cases below were written against the unmodified action and
 * observed to fail — 2 requests bought 2 calls, 10 bought 10, 50 bought 50 —
 * before the lease existed. They are the regression, and they are the reason
 * this file drives the **real action** rather than a reproduction of it.
 *
 * The action is a Next server action, so its module graph is reached through the
 * `@/` alias, which Vitest does not resolve. Each `@/` specifier is therefore
 * mocked with a factory: the repositories resolve to their **real** modules
 * through a relative path, and only the provider is a fake, because the provider
 * is the thing being counted. Nothing here touches the network, a credential or
 * `.env.local`.
 */

interface ProviderCall {
  spans: readonly { text: string }[];
}

const provider = {
  calls: [] as ProviderCall[],
  /** How long one call takes. The window two racers can both slip through. */
  latencyMs: 25,
  configured: true,
  modelId: 'test-model-a',
  reply: (): unknown => ({
    proposals: [
      { spanIndex: 0, key: 'pace:slow', polarity: 'affirms', needsClarification: false },
    ],
  }),
  fail: null as null | 'provider_unavailable' | 'invalid_response',
  /** Simulates a holder that never returns — a killed process, from here. */
  hang: false,
};

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ redirect: () => {} }));
/*
 * THESE TWO USED TO BE EMPTY, AND USED TO DO NOTHING.
 *
 * The test config had no `@/` alias, so a `vi.mock('@/lib/db/repository')` named
 * a specifier nothing resolved to, and the file this test actually imports —
 * `./repository`, the same module by a different name — was never mocked. The
 * empty factories were inert, and the tests passed because of it rather than
 * despite it.
 *
 * Adding the alias so that components could be unit-tested made both mocks
 * suddenly real, and twenty tests started failing on a `createTrip` that had
 * been replaced with nothing.
 *
 * The fix is to say what was always meant. These modules are mocked only so that
 * importing a server action does not drag its whole import graph into a test
 * about a database lease; the modules themselves are wanted, and forwarding to
 * the real implementation is what the neighbouring line has always done.
 */
vi.mock('@/lib/db/repository', async () => await import('./repository'));
vi.mock('@/lib/region', async () => await import('../region'));
vi.mock('@/lib/db/compiler-repository', async () => await import('./compiler-repository'));
vi.mock(
  '@/lib/db/interpretation-repository',
  async () => await import('./interpretation-repository'),
);
vi.mock('@/lib/providers/interpretation-model', () => ({
  INTERPRETATION_PROMPT_VERSIONS: { interpretPreferences: 'interpret-preferences/test.1' },
  INTERPRETATION_MAX_CALLS: 1,
  interpretationModelId: () => provider.modelId,
  isInterpretationModelConfigured: () => provider.configured,
  createInterpretationModel: () => ({ callsRemaining: 1 }),
  proposeInterpretations: async (
    _model: unknown,
    input: { spans: readonly { text: string }[] },
  ) => {
    provider.calls.push({ spans: input.spans });
    if (provider.hang) await new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, provider.latencyMs));
    if (provider.fail === 'provider_unavailable') {
      return { ok: false as const, outcome: 'provider_unavailable' as const, calls: 1 as const };
    }
    if (provider.fail === 'invalid_response') {
      return { ok: false as const, outcome: 'invalid_response' as const, calls: 1 as const };
    }
    return { ok: true as const, response: provider.reply(), calls: 1 as const };
  },
}));

const UNRESOLVED = 'we would like somewhere we can potter about with no fixed plan at all';
const KIND = 'interpretation';

let directory: string;

function resetDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

function composerFor(mustDo: string): TripComposerAnswers {
  return {
    schemaVersion: TRIP_COMPOSER_VERSION,
    mode: 'known_destination',
    destinationQuery: 'Somewhere',
    dates: {
      mode: 'exact',
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      wantsRecommendation: false,
    },
    duration: { mode: 'fixed', nights: 4, wantsRecommendation: false },
    adults: 2,
    children: 0,
    travelerNeeds: [],
    themes: [],
    mustDo,
    interpretation: classifyPreferences({ mustDo }),
    skipped: [],
    updatedAt: '2026-08-03T00:00:00.000Z',
  };
}

async function makeTrip(mustDo = UNRESOLVED): Promise<string> {
  const { createTrip } = await import('./repository');
  const { saveComposerAnswers } = await import('./compiler-repository');
  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: 'Somewhere',
    regionId: 'dynamic',
    startDate: '2026-09-01',
    endDate: '2026-09-05',
    arrivalTime: '15:00',
    departureTime: '11:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  saveComposerAnswers(trip.id, composerFor(mustDo));
  return trip.id;
}

/** The key the action will derive for a trip's current text. */
function cacheKeyFor(mustDo: string): string {
  return cacheKeyForSpans({
    spans: spansForModel(classifyPreferences({ mustDo })).spans,
    taxonomyVersion: classifyPreferences({ mustDo }).lexiconVersion,
    promptVersion: 'interpret-preferences/test.1',
    modelId: provider.modelId,
    locale: 'en',
  });
}

async function read(tripId: string) {
  const { readUnresolvedTextAction } = await import('../../app/(product)/trips/[id]/questionnaire/actions');
  return readUnresolvedTextAction(tripId);
}

/** Puts the interpretation back to "never asked", the way an edit does. */
async function clearModelPass(tripId: string, mustDo = UNRESOLVED): Promise<void> {
  const { saveComposerAnswers } = await import('./compiler-repository');
  saveComposerAnswers(tripId, composerFor(mustDo));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-interp-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'interp.db');
  resetDb();
  provider.calls = [];
  provider.latencyMs = 25;
  provider.configured = true;
  provider.modelId = 'test-model-a';
  provider.fail = null;
  provider.hang = false;
});

afterEach(() => {
  resetDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

describe('the one-call ceiling under concurrency', () => {
  for (const racers of [2, 10, 50]) {
    it(`buys exactly one paid reading for ${racers} concurrent requests`, async () => {
      const tripId = await makeTrip();

      const results = await Promise.all(Array.from({ length: racers }, () => read(tripId)));

      expect(provider.calls).toHaveLength(1);
      // Every loser got the winner's answer rather than an error or a spinner.
      const applied = results.filter((result) => result.ok && result.outcome === 'proposed');
      expect(applied.length).toBe(racers);
      // And exactly one row was ever created for the identity.
      const rows = getDb()
        .prepare('SELECT COUNT(*) AS total FROM model_operations')
        .get() as { total: number };
      expect(rows.total).toBe(1);
    });
  }

  it('records the paid call once, not once per racer', async () => {
    const tripId = await makeTrip();
    await Promise.all(Array.from({ length: 8 }, () => read(tripId)));

    const operation = latestModelOperation({ tripId, kind: KIND, cacheKey: cacheKeyFor(UNRESOLVED) });
    expect(operation?.state).toBe('succeeded');
    expect(operation?.usage.calls).toBe(1);
    expect(operation?.attempt).toBe(1);
  });

  /**
   * A refresh is the same request again. It must replay, not re-buy — and the
   * replay must come back with the reading rather than with a shrug.
   */
  it('creates no second call on a refresh', async () => {
    const tripId = await makeTrip();
    const first = await read(tripId);
    expect(first.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);

    // The stored pass now says a call was spent; a second press is refused.
    expect((await read(tripId)).ok).toBe(false);
    expect(provider.calls).toHaveLength(1);

    // Even with that guard removed — which is what an edit-and-retype does to
    // the record — the lease still holds the ceiling.
    await clearModelPass(tripId);
    const replayed = await read(tripId);
    expect(replayed.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('failure is bounded, and its cost is recorded', () => {
  it('records usage for a failed call, not only for a successful one', async () => {
    provider.fail = 'provider_unavailable';
    const tripId = await makeTrip();
    const result = await read(tripId);

    expect(result.outcome).toBe('provider_unavailable');
    const operation = latestModelOperation({ tripId, kind: KIND, cacheKey: cacheKeyFor(UNRESOLVED) });
    expect(operation?.state).toBe('failed_retryable');
    expect(operation?.failureKind).toBe('provider_unavailable');
    // The provider took the request and burned the tokens. That is spend.
    expect(operation?.usage.calls).toBe(1);
    expect(operation?.finishedAt).not.toBeNull();
  });

  /**
   * An unusable answer will not become usable by being asked for again, and a
   * render that re-asked would spend money on every paint.
   */
  it('never re-calls after a terminal invalid answer', async () => {
    provider.fail = 'invalid_response';
    const tripId = await makeTrip();
    await read(tripId);
    expect(provider.calls).toHaveLength(1);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clearModelPass(tripId);
      const result = await read(tripId);
      expect(result.outcome).toBe('invalid_response');
    }
    expect(provider.calls).toHaveLength(1);

    const operation = latestModelOperation({ tripId, kind: KIND, cacheKey: cacheKeyFor(UNRESOLVED) });
    expect(operation?.state).toBe('failed_terminal');
  });

  it('allows a bounded number of attempts after a retryable failure and no more', async () => {
    provider.fail = 'provider_unavailable';
    const tripId = await makeTrip();

    for (let attempt = 0; attempt < MODEL_OPERATION_MAX_ATTEMPTS + 3; attempt += 1) {
      await clearModelPass(tripId);
      await read(tripId);
    }
    expect(provider.calls).toHaveLength(MODEL_OPERATION_MAX_ATTEMPTS);

    await clearModelPass(tripId);
    const beyond = await read(tripId);
    expect(beyond.outcome).toBe('budget_exhausted');
    expect(provider.calls).toHaveLength(MODEL_OPERATION_MAX_ATTEMPTS);
  });

  /**
   * A killed holder must not wedge the trip, and must not be waited on for ever.
   *
   * Simulated at the repository, because a process that never returns cannot be
   * awaited from inside the test that is waiting for it. The lease is claimed and
   * abandoned; a later claimant with a clock past the lease window takes it, and
   * the abandoned attempt is on the record as a failure rather than as nothing.
   */
  it('reclaims a lease whose holder stopped reporting', async () => {
    const tripId = await makeTrip();
    const key = { tripId, kind: KIND, cacheKey: 'k' };
    const start = new Date('2026-08-03T09:00:00.000Z');

    const first = claimModelOperation({ ...key, owner: 'a', now: start });
    expect(first.kind).toBe('won');

    // Immediately afterwards, the lease is held and nobody else may call.
    const blocked = claimModelOperation({
      ...key,
      owner: 'b',
      now: new Date(start.getTime() + 1_000),
    });
    expect(blocked.kind).toBe('lost');

    // A minute later the holder has said nothing.
    const reclaimed = claimModelOperation({
      ...key,
      owner: 'c',
      now: new Date(start.getTime() + 120_000),
    });
    expect(reclaimed.kind).toBe('won');

    const rows = getDb()
      .prepare("SELECT state, failure_kind FROM model_operations WHERE state = 'failed_retryable'")
      .all() as { state: string; failure_kind: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failure_kind).toBe('lease_expired');
  });

  it('stops accepting a heartbeat once the operation has ended', async () => {
    const now = new Date('2026-08-03T09:00:00.000Z');
    const claim = claimModelOperation({
      tripId: await makeTrip(),
      kind: KIND,
      cacheKey: 'k',
      owner: 'a',
      now,
    });
    expect(claim.kind).toBe('won');
    const id = (claim as { operation: { id: string } }).operation.id;
    expect(heartbeatModelOperation(id, new Date(now.getTime() + 1_000))).toBe(true);

    settleModelOperation({ id, state: 'succeeded', now, usage: { calls: 1 } });
    expect(heartbeatModelOperation(id, new Date(now.getTime() + 2_000))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('operation identity', () => {
  it('changes when the traveller changes the text', async () => {
    const original = 'we would like somewhere we can potter about with no fixed plan at all';
    const edited = 'we would like somewhere we can sit still with no fixed plan at all';
    expect(cacheKeyFor(original)).not.toBe(cacheKeyFor(edited));
    expect(
      operationKeyFor({ tripId: 't', kind: KIND, cacheKey: cacheKeyFor(original) }),
    ).not.toBe(operationKeyFor({ tripId: 't', kind: KIND, cacheKey: cacheKeyFor(edited) }));

    const tripId = await makeTrip(original);
    await read(tripId);
    expect(provider.calls).toHaveLength(1);

    // The edit re-parses and re-keys, so it is a new operation rather than a
    // replay of the answer to a sentence that no longer exists.
    await clearModelPass(tripId, edited);
    await read(tripId);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.spans.some((span) => span.text.includes('sit still'))).toBe(true);
  });

  it('retires an operation still running against text the traveller replaced', async () => {
    const tripId = await makeTrip();
    const stale = claimModelOperation({
      tripId,
      kind: KIND,
      cacheKey: 'the-old-sentence',
      owner: 'a',
      now: new Date(),
    });
    expect(stale.kind).toBe('won');

    const retired = supersedeModelOperations({
      tripId,
      kind: KIND,
      keepCacheKey: cacheKeyFor(UNRESOLVED),
      now: new Date(),
    });
    expect(retired).toBe(1);
    expect(
      latestModelOperation({ tripId, kind: KIND, cacheKey: 'the-old-sentence' })?.state,
    ).toBe('superseded');

    // And the current sentence proceeds normally rather than being blocked by it.
    const result = await read(tripId);
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  /**
   * A retired holder cannot come back to life.
   *
   * If a superseded row could still be settled as `succeeded`, a reading of a
   * sentence the traveller deleted would become a live answer that a later
   * claimant on that key could replay.
   */
  it('refuses to settle an operation the traveller already superseded', async () => {
    const tripId = await makeTrip();
    const claim = claimModelOperation({
      tripId,
      kind: KIND,
      cacheKey: 'the-old-sentence',
      owner: 'a',
      now: new Date(),
    });
    expect(claim.kind).toBe('won');
    const id = (claim as { operation: { id: string } }).operation.id;

    supersedeModelOperations({
      tripId,
      kind: KIND,
      keepCacheKey: cacheKeyFor(UNRESOLVED),
      now: new Date(),
    });

    const settled = settleModelOperation({
      id,
      state: 'succeeded',
      now: new Date(),
      result: { proposals: [] },
      usage: { calls: 1 },
    });
    expect(settled?.state).toBe('superseded');
    expect(settled?.result).toBeNull();
  });

  it('changes when the model identity changes', async () => {
    const tripId = await makeTrip();
    await read(tripId);
    expect(provider.calls).toHaveLength(1);

    provider.modelId = 'test-model-b';
    await clearModelPass(tripId);
    await read(tripId);
    // A different model is a different reading, so the stored one is not served.
    expect(provider.calls).toHaveLength(2);

    provider.modelId = 'test-model-a';
    await clearModelPass(tripId);
    await read(tripId);
    // And going back to the first model replays rather than re-buying.
    expect(provider.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('everything here stays trip-scoped', () => {
  it('gives two travellers who typed the same sentence two operations', async () => {
    const first = await makeTrip();
    const second = await makeTrip();
    expect(first).not.toBe(second);

    await read(first);
    await read(second);

    // The same words, and still two paid readings: neither trip may be served
    // one traveller's reading of another traveller's sentence.
    expect(provider.calls).toHaveLength(2);
    expect(
      operationKeyFor({ tripId: first, kind: KIND, cacheKey: cacheKeyFor(UNRESOLVED) }),
    ).not.toBe(operationKeyFor({ tripId: second, kind: KIND, cacheKey: cacheKeyFor(UNRESOLVED) }));

    const rows = getDb()
      .prepare('SELECT trip_id FROM model_operations ORDER BY trip_id')
      .all() as { trip_id: string }[];
    expect(new Set(rows.map((row) => row.trip_id)).size).toBe(2);
  });

  it('never serves one trip’s cached reading to another', async () => {
    const first = await makeTrip();
    const second = await makeTrip();
    const key = cacheKeyFor(UNRESOLVED);
    const now = new Date();

    saveCachedInterpretation(first, key, { proposals: [] }, now);
    expect(getCachedInterpretation(first, key, now)).toEqual({ proposals: [] });
    expect(getCachedInterpretation(second, key, now)).toBeNull();
  });

  it('drops a trip’s operations with the trip', async () => {
    const tripId = await makeTrip();
    await read(tripId);
    expect(
      (getDb().prepare('SELECT COUNT(*) AS total FROM model_operations').get() as { total: number })
        .total,
    ).toBe(1);

    getDb().prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    expect(
      (getDb().prepare('SELECT COUNT(*) AS total FROM model_operations').get() as { total: number })
        .total,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('nothing is bought when nothing should be', () => {
  it('spends nothing and claims nothing when the reader is switched off', async () => {
    provider.configured = false;
    const tripId = await makeTrip();
    const result = await read(tripId);

    expect(result.outcome).toBe('not_configured');
    expect(provider.calls).toHaveLength(0);
    expect(
      (getDb().prepare('SELECT COUNT(*) AS total FROM model_operations').get() as { total: number })
        .total,
    ).toBe(0);
  });

  it('spends nothing when the phrase table already read everything', async () => {
    const tripId = await makeTrip('hot springs and hiking');
    const result = await read(tripId);

    expect(result.outcome).toBe('nothing_unresolved');
    expect(provider.calls).toHaveLength(0);
  });

  it('replays a cached reading without claiming a lease', async () => {
    const tripId = await makeTrip();
    saveCachedInterpretation(tripId, cacheKeyFor(UNRESOLVED), { proposals: [] }, new Date());

    const result = await read(tripId);
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(0);
    expect(
      (getDb().prepare('SELECT COUNT(*) AS total FROM model_operations').get() as { total: number })
        .total,
    ).toBe(0);
  });
});
