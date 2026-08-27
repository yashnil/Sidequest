import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE FENCE, WHERE IT IS ACTUALLY NAILED DOWN.
 *
 * `lib/net/rate-limit.test.ts` proves the bucket arithmetic thoroughly, and
 * every one of its tests calls the limiter directly. That is precisely the
 * split an adversary found: replacing the body of `rateGuard` with `return
 * null` — deleting every rate limit on every action that can spend money at
 * once — left the entire repository suite green. A limiter nothing calls is a
 * module, not a control.
 *
 * So these drive the **actions the browser posts to**, and assert the refusal
 * arrives from them: the sentence a refused traveller reads, and the absence
 * of the work the refused click was asking for. The two guarded spenders are
 * covered because they are the two that reach outside — `compile_start` in
 * front of a billable job, `destination_resolve` in front of a volunteer-run
 * geocoder. The preflight shares the same `rateGuard`, so it shares the proof.
 *
 * Nothing here reaches a network, a credential or a model: the compiler runs
 * on the fixture stack, and the worker launcher is replaced by a recorder so
 * no process is spawned.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/**
 * The Next request-scope facilities the action reaches for, stubbed at the
 * module edge because a unit test is not a request.
 *
 * `next/headers` is stubbed rather than left to throw so the request carries
 * the identity a browser's would: one session cookie, no `x-forwarded-for`.
 * That is the shape `requestIdentities` is built around — with no trusted
 * proxy hops configured there is deliberately no address identity — and it is
 * the caller's own fence, not the deployment-wide one, that must refuse an
 * ordinary browser holding the button down.
 *
 * The launcher is stubbed so a passing test does not fork a compile worker per
 * trip; nothing about the limiter depends on it.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/server', () => ({ after: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      name === 'sidequest_session' ? { name, value: 'session-under-test' } : undefined,
    set: () => {},
  }),
}));

const launches: { tripId: string; jobId: string }[] = [];
vi.mock('@/lib/compiler/worker/launch', async () => {
  const actual = await import('@/lib/compiler/worker/launch');
  return {
    ...actual,
    launchCompilationWorker: (input: { tripId: string; jobId: string }) => {
      launches.push(input);
      return { launched: true as const };
    },
  };
});

beforeEach(() => {
  releaseDatabase();
  launches.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-action-rate-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A trip with a confirmed scope, ready to compile.
 *
 * Distinct trips rather than repeated clicks on one, because the action adopts
 * an already-running build *before* it reaches the limiter — that click spends
 * nothing and must not be charged. The abuse the fence exists to stop is many
 * builds, not a double-click, so the scenario is many trips.
 */
async function seededConfirmedTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const repo = await import('@/lib/db/compiler-repository');
  const { compilerProviders } = await import('@/lib/compiler/providers');
  const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');

  const trip = createTrip(
    {
      mode: 'known_destination',
      destinationInput: 'Harbour City',
      regionId: 'open-world',
      startDate: '2026-09-01',
      endDate: '2026-09-04',
      arrivalTime: '10:00',
      departureTime: '18:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
    },
    // Owned by the browser the cookie stub names: since the ownership
    // boundary landed, an unowned trip is refused before the limiter — and
    // the limiter is what this file measures.
    'session-under-test',
  );
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
  const { providers } = compilerProviders();
  const resolution = await providers.resolver.resolve({ query: 'Harbour City', now: new Date() });
  repo.saveResolution(trip.id, resolution);
  const candidate = resolution.candidates[0]!;
  repo.saveSelectedCandidate(trip.id, candidate.id);
  const clarifications = rebuildClarificationSet({ resolution, candidate, nights: 3, known: {} });
  repo.saveClarifications(trip.id, clarifications);
  repo.saveScope(
    trip.id,
    deriveScope({ candidate, clarifications, nights: 3, revision: 1, transitMeasurable: false }),
  );
  const intent = repo.getIntent(trip.id)!;
  repo.saveScope(trip.id, {
    ...intent.scope!,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
  return trip.id;
}

describe('startCompilationAction and the rate limit in front of it', () => {
  it('refuses the burst-plus-one start in the traveller’s words, and starts no job for it', async () => {
    const { ACTION_RATE_RULES, rateLimitedCopy } = await import('@/lib/net/rate-limit');
    const { startCompilationAction } = await import('./actions');
    const { getLatestJob } = await import('@/lib/db/compiler-repository');

    const capacity = ACTION_RATE_RULES.compile_start.capacity;
    const trips: string[] = [];
    for (let index = 0; index <= capacity; index += 1) trips.push(await seededConfirmedTrip());

    // The burst the rule allows: every one of these is a real start.
    for (let index = 0; index < capacity; index += 1) {
      expect(await startCompilationAction(trips[index]!), `start ${index + 1}`).toEqual({
        ok: true,
      });
    }

    const refused = await startCompilationAction(trips[capacity]!);
    expect(refused.ok).toBe(false);
    /*
     * The exact sentence, not merely "an error": the whole point of
     * `rateLimitedCopy` is that a refused traveller is told their trip is
     * saved and roughly when to come back, and an action that refused with a
     * stack trace would satisfy a looser assertion.
     */
    expect(refused.ok === false && refused.error).toContain('getting a lot of requests');
    expect(refused.ok === false && refused.error).toBe(
      rateLimitedCopy(60 / ACTION_RATE_RULES.compile_start.refillPerMinute),
    );

    // …and the refusal happened before anything existed to pay for.
    expect(getLatestJob(trips[capacity]!)).toBeNull();
    expect(launches).toHaveLength(capacity);
  });

  it('adopts a build already running rather than charging the second click for it', async () => {
    /**
     * The other direction, and the reason the guard sits where it does rather
     * than at the top of the action. A double-click on a build that is already
     * going spends nothing new — the job index absorbs it — so charging it a
     * token would make the fence punish exactly the traveller it is there to
     * protect. Adoption is checked first, and this is what says so.
     */
    const { startCompilationAction } = await import('./actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');

    const trip = await seededConfirmedTrip();
    for (let click = 0; click < ACTION_RATE_RULES.compile_start.capacity + 3; click += 1) {
      expect(await startCompilationAction(trip), `click ${click + 1}`).toEqual({ ok: true });
    }
    // One build, however many clicks.
    expect(launches).toHaveLength(1);
  });
});

describe('resolveDestinationAction and the rate limit in front of the geocoder', () => {
  it('refuses past the burst, and does not resolve the refused request', async () => {
    /**
     * This one guards somebody else's server. The geocoder is volunteer-run
     * with a usage policy, so a refused resolve must cost it nothing — which
     * is why the guard sits after the free checks and before the round-trip,
     * and why this asserts that no resolution was stored for the refused trip.
     */
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');
    const { resolveDestinationAction } = await import('./actions');
    const { getIntent } = await import('@/lib/db/compiler-repository');
    const { createTrip } = await import('@/lib/db/repository');
    const repo = await import('@/lib/db/compiler-repository');

    const capacity = ACTION_RATE_RULES.destination_resolve.capacity;
    const trips: string[] = [];
    for (let index = 0; index <= capacity; index += 1) {
      const trip = createTrip(
        {
          mode: 'known_destination',
          destinationInput: 'Harbour City',
          regionId: 'open-world',
          startDate: '2026-09-01',
          endDate: '2026-09-04',
          arrivalTime: '10:00',
          departureTime: '18:00',
          adults: 2,
          children: 0,
          travelerNeeds: [],
        },
        'session-under-test',
      );
      repo.saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
      trips.push(trip.id);
    }

    for (let index = 0; index < capacity; index += 1) {
      expect((await resolveDestinationAction(trips[index]!)).ok, `resolve ${index + 1}`).toBe(true);
    }

    const refused = await resolveDestinationAction(trips[capacity]!);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('getting a lot of requests');
    expect(getIntent(trips[capacity]!)?.resolution ?? null).toBeNull();
  });
});
