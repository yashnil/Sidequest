import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerInput } from './actions';

/**
 * THE FENCE IN FRONT OF THE LAST UNFENCED WRITE LOOP.
 *
 * A security pass found `createTripFromComposer` validating its input and then
 * writing a trips row plus composer answers with no rateGuard, no token, no
 * refusal at any layer — the identical shape `decide_start` was fenced for
 * ("two hundred POSTs were two hundred rows and two hundred redirects"), on
 * the trips surface, where the live database already held dozens of ownerless
 * rows nothing can list, edit or delete.
 *
 * Same discipline as `plan/actions.rate-limit.test.ts`: these drive the action
 * the browser posts to, because a limiter nothing calls is a module, not a
 * control — replacing the guard with `return null` fails the refusal assertion
 * below, which is the neuter-proof. Nothing here reaches a network: the action
 * writes only local rows.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/*
 * The Next request-scope facilities, stubbed at the module edge exactly as the
 * plan-surface fence test stubs them: one session cookie, no forwarded-for, so
 * the refusal exercised is the caller's own fence — the one an ordinary
 * browser holding the button down meets first.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      name === 'sidequest_session' ? { name, value: 'session-under-test' } : undefined,
    set: () => {},
  }),
}));

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-trip-create-rate-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

/** A valid composer payload — the cheapest well-formed body a script would loop. */
function composerPayload(): ComposerInput {
  return {
    destinationText: 'Harbour City',
    destinationEntryId: null,
    dateMode: 'exact',
    startDate: '2026-09-01',
    endDate: '2026-09-04',
    flexDays: 0,
    month: 9,
    season: 'autumn',
    wantsDateRecommendation: false,
    wantsLengthRecommendation: false,
    nights: 3,
    arrivalPrecision: 'unknown',
    departurePrecision: 'unknown',
    adults: 2,
    children: 0,
    travelerNeeds: [],
    shape: null,
    pace: null,
    transport: null,
    budget: null,
    themes: [],
    crowdTolerance: null,
    outdoorIntensity: null,
    foodImportance: null,
    freeTime: null,
    mustDo: '',
    avoid: '',
    origin: '',
  };
}

describe('createTripFromComposer and the rate limit in front of the trips table', () => {
  it('refuses the burst-plus-one create in the traveller’s words, and writes no row for it', async () => {
    const { ACTION_RATE_RULES, rateLimitedCopy } = await import('@/lib/net/rate-limit');
    const { createTripFromComposer } = await import('./actions');
    const { listTrips } = await import('@/lib/db/repository');

    const capacity = ACTION_RATE_RULES.trip_create.capacity;

    // The burst the rule allows: every one of these is a real trip.
    for (let index = 0; index < capacity; index += 1) {
      const created = await createTripFromComposer(composerPayload());
      expect(created.ok, `create ${index + 1}`).toBe(true);
    }
    expect(listTrips('session-under-test')).toHaveLength(capacity);

    const refused = await createTripFromComposer(composerPayload());
    expect(refused.ok).toBe(false);
    /*
     * The exact sentence, not merely "an error": a refused traveller is told
     * roughly when to come back, and an action refusing with a stack trace
     * would satisfy a looser assertion.
     */
    expect(refused.error).toContain('getting a lot of requests');
    expect(refused.error).toBe(rateLimitedCopy(60 / ACTION_RATE_RULES.trip_create.refillPerMinute));
    expect(refused.href).toBe('');

    // …and the refusal happened before anything was written.
    expect(listTrips('session-under-test')).toHaveLength(capacity);
  });

  it('does not spend a token on an invalid payload — a person fixing form errors is not charged', async () => {
    /*
     * The guard sits after validation on purpose: a rejected payload writes
     * nothing, so charging it would throttle exactly the traveller the fence
     * protects — somebody resubmitting a form they are correcting.
     */
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const { createTripFromComposer } = await import('./actions');

    const invalid = { ...composerPayload(), destinationText: '' };
    for (let index = 0; index < ACTION_RATE_RULES.trip_create.capacity + 3; index += 1) {
      const result = await createTripFromComposer(invalid);
      expect(result.ok).toBe(false);
      expect(result.fieldErrors, 'an invalid payload is a validation refusal').toBeDefined();
    }

    // Every token is still there for the corrected submission.
    const corrected = await createTripFromComposer(composerPayload());
    expect(corrected.ok, corrected.error ?? '').toBe(true);
  });
});
