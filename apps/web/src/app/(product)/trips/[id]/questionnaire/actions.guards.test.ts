import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRIP_COMPOSER_VERSION,
  classifyPreferences,
  type TripComposerAnswers,
} from '@sidequest/core';

/**
 * THE COST CONTROLS IN FRONT OF THE QUESTIONNAIRE'S ONE BILLED CALL.
 *
 * A review found this action outside every aggregate control: the daily ledger
 * counted only what a *compilation* spent, and this had no rate limit at all.
 * Its own guards are per *trip* — one reading, three attempts — and trips are
 * free and unlimited to create, so "make a trip, press read" was an unbounded
 * bill for an unauthenticated caller.
 *
 * The provider is faked, exactly as `interpretation-repository.test.ts` fakes
 * it, because the thing under test is what happens *around* the call. Nothing
 * here touches a network, a credential or a real model.
 *
 * The second test is the one worth reading twice. The limiter is checked before
 * the lease and charged only by the invocation that wins it, so a free replay
 * is never throttled — the same rule the preflight already follows for a cache
 * hit. A test that only counted refusals would pass with the token taken in the
 * wrong place, so the free path is asserted explicitly.
 */

interface FakeProvider {
  calls: number;
  configured: boolean;
}
const provider: FakeProvider = { calls: 0, configured: true };

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ redirect: () => {} }));

const jar = new Map<string, string>();
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

vi.mock('@/lib/providers/interpretation-model', () => ({
  INTERPRETATION_PROMPT_VERSIONS: { interpretPreferences: 'interpret-preferences/test.1' },
  INTERPRETATION_MAX_CALLS: 1,
  interpretationModelId: () => 'test-model-a',
  isInterpretationModelConfigured: () => provider.configured,
  createInterpretationModel: () => ({ callsRemaining: 1 }),
  proposeInterpretations: async () => {
    provider.calls += 1;
    return {
      ok: true as const,
      response: {
        proposals: [
          { spanIndex: 0, key: 'pace:slow', polarity: 'affirms', needsClarification: false },
        ],
      },
      calls: 1 as const,
    };
  },
}));

const UNRESOLVED = 'we would like somewhere we can potter about with no fixed plan at all';

let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  jar.set('sidequest_session', 'test-browser');
  provider.calls = 0;
  provider.configured = true;
  delete process.env.SIDEQUEST_DAILY_MODEL_CALLS;
  directory = mkdtempSync(join(tmpdir(), 'sidequest-questionnaire-guards-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DAILY_MODEL_CALLS;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function composerFor(mustDo: string): TripComposerAnswers {
  return {
    schemaVersion: TRIP_COMPOSER_VERSION,
    mode: 'known_destination',
    mustDoDecisions: [],
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

/** A trip whose free text has something left over for the reader to look at. */
async function tripNeedingAReading(mustDo = UNRESOLVED): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const { saveComposerAnswers } = await import('@/lib/db/compiler-repository');
  const trip = createTrip(
    {
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
  },
    'test-browser',
  );
  saveComposerAnswers(trip.id, composerFor(mustDo));
  return trip.id;
}

async function read(tripId: string) {
  const { readUnresolvedTextAction } = await import('./actions');
  return readUnresolvedTextAction(tripId);
}

describe('the rate limit in front of the questionnaire reading', () => {
  it('refuses a burst of readings across freshly made trips', async () => {
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const capacity = ACTION_RATE_RULES.interpret_text.capacity;

    /*
     * The abuse loop from the finding, in miniature: a new trip per press, so
     * every one of them is a genuine purchase rather than a replay.
     */
    for (let press = 0; press < capacity; press += 1) {
      const trip = await tripNeedingAReading(`${UNRESOLVED} number ${press}`);
      expect((await read(trip)).ok).toBe(true);
    }
    expect(provider.calls).toBe(capacity);

    const oneMore = await tripNeedingAReading(`${UNRESOLVED} number ${capacity}`);
    const refused = await read(oneMore);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/lot of requests from this connection/);
    // And it refused before the provider, which is the whole point of a fence.
    expect(provider.calls).toBe(capacity);
  });

  it('charges nothing for a replay, so a refresh is never throttled', async () => {
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const trip = await tripNeedingAReading();

    expect((await read(trip)).ok).toBe(true);
    // Pressing again on a trip whose reading is done costs nothing and must
    // therefore take nothing: these are free replays of a finished answer.
    for (let press = 0; press < ACTION_RATE_RULES.interpret_text.capacity + 2; press += 1) {
      await read(trip);
    }
    expect(provider.calls).toBe(1);

    // One token spent in total, so a different trip still gets its reading.
    const other = await tripNeedingAReading(`${UNRESOLVED} elsewhere`);
    expect((await read(other)).ok).toBe(true);
    expect(provider.calls).toBe(2);
  });
});

describe('the daily model ceiling in front of the questionnaire reading', () => {
  it('books the call against the day before making it', async () => {
    const { dailySpendSoFar } = await import('@/lib/compiler/daily-ceiling');
    const trip = await tripNeedingAReading();

    expect((await read(trip)).ok).toBe(true);
    expect(provider.calls).toBe(1);
    expect(dailySpendSoFar('model_calls', new Date())).toBe(1);
    // Against this browser as well as the deployment, so one visitor cannot
    // spend the whole day's allowance.
    expect(dailySpendSoFar('model_calls', new Date(), 'session:test-browser')).toBe(1);
  });

  it('refuses once the day is spent, without burning the trip’s one reading', async () => {
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '0';
    const trip = await tripNeedingAReading();

    const refused = await read(trip);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('live research');
    expect(provider.calls).toBe(0);

    /*
     * The reading survives the refusal. A ceiling is not a failure of the
     * reading, so it must not consume one of the trip's three attempts or
     * record a model pass — a traveller who comes back tomorrow finds the
     * button still works.
     */
    delete process.env.SIDEQUEST_DAILY_MODEL_CALLS;
    const later = await read(trip);
    expect(later.ok).toBe(true);
    expect(provider.calls).toBe(1);
  });
});
