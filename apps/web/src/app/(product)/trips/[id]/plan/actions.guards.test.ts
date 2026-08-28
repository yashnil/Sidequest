import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintSessionToken } from '@/lib/net/session-signature';

/*
 * ONE BROWSER, AND A CREDENTIAL THIS SERVER MINTED.
 *
 * A value the client picked is not an identity — that is the whole of the
 * per-caller spend fix — so a test presenting a bare string measures the shared
 * unattributed pool rather than a browser's own share, which is not what any
 * assertion below is about. The secret is pinned here so the token is a pure
 * function and needs no database.
 */
process.env.SIDEQUEST_SESSION_SECRET = 'guards-test-secret';
const BROWSER = mintSessionToken('test-browser');

/**
 * THE GUARDS, ASSERTED AT THE ACTIONS RATHER THAN AT THE MODULES.
 *
 * Both cost controls in front of the paid journey were module-tested and
 * wiring-untested, and a review demonstrated what that is worth: the body of
 * `rateGuard` could be replaced with `return null` — killing every rate limit
 * on every spending action at once — and the entire suite stayed green, because
 * `rate-limit.test.ts` calls the bucket directly and no test calls the actions.
 * The same held for the model spend: `daily-ceiling.test.ts` proved the
 * arithmetic while two normal-journey actions made billed model calls the
 * ledger had never heard of.
 *
 * So these tests drive the exported server actions themselves. They reach no
 * provider: every case here refuses *before* the network call, which is the
 * property under test — a refusal that has already cost the provider something
 * is not a refusal.
 *
 * `next/headers` is mocked because a server action outside a request scope can
 * see neither. Mocking it is what gives these tests a stable caller identity,
 * so the per-caller fence is the one being measured rather than the
 * deployment-wide one.
 */

const jar = new Map<string, string>();

/*
 * `revalidatePath` throws outside a request scope — it is framework plumbing
 * for a router this test has no reason to have. Stubbed rather than avoided, so
 * the actions can be driven all the way through their success paths.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

/*
 * The worker launcher, stubbed to launch nothing.
 *
 * One case below drives `startCompilationAction` far enough to reach it, and a
 * unit test must not spawn a compile worker — nor fall through to the inline
 * `after()` path, which throws outside a request scope. Reporting a successful
 * launch is the shape that leaves the action's own logic intact while the
 * process it would have started does not exist.
 */
vi.mock('@/lib/compiler/worker/launch', () => ({
  compilerIsolationMode: () => 'process',
  launchCompilationWorker: () => ({ launched: true }),
}));

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

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

const OPEN_STACK = {
  SIDEQUEST_COMPILER_PROVIDER: 'open',
  SIDEQUEST_GEOCODER_PROVIDER: 'nominatim',
  SIDEQUEST_PLACE_BACKBONE: 'overture',
  SIDEQUEST_ROUTES_PROVIDER: 'valhalla',
  SIDEQUEST_RESEARCH_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-test-never-a-real-key',
} as const;

const ENV_KEYS = [
  ...Object.keys(OPEN_STACK),
  'SIDEQUEST_DAILY_LIVE_COMPILATIONS',
  'SIDEQUEST_DAILY_MODEL_CALLS',
  'SIDEQUEST_GEOCODER_URL',
];

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  // One stable browser identity: the ownership boundary refuses a request
  // presenting no cookie, and every guard below is measured on an owner's
  // ordinary presses. The per-caller ledger test keys on this same value.
  /*
   * A cookie THIS SERVER MINTED, which is the only kind that is an identity.
   * A value the client chose is not attributable — that is the whole of the
   * spend-ceiling fix — so a test presenting a bare string would be measuring
   * the unattributed pool rather than a browser's own share.
   */
  jar.set('sidequest_session', BROWSER);
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-action-guards-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

async function seededTrip(): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const repo = await import('@/lib/db/compiler-repository');
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
    BROWSER,
  );
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
  return trip.id;
}

function goOpen(): void {
  for (const [key, value] of Object.entries(OPEN_STACK)) process.env[key] = value;
  /*
   * A loopback endpoint, so that if any case here ever does reach the resolver
   * it is refused by the SSRF guard before a socket opens rather than by a
   * timeout against somebody's donated server. No test in this file may leave
   * the machine.
   */
  process.env.SIDEQUEST_GEOCODER_URL = 'http://127.0.0.1:9';
}

describe('the rate limit in front of the actions that spend', () => {
  it('refuses the fourth compile start from one browser in a burst', async () => {
    const tripId = await seededTrip();
    const { startCompilationAction } = await import('./actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');

    /*
     * The trip has no confirmed scope, so every allowed press is refused by the
     * *scope* guard a moment later. That is deliberate: it keeps the test off
     * every provider while still proving the token was taken, because the
     * limiter sits in front of `startCompilation` and therefore in front of the
     * refusal that follows it.
     */
    const burst: string[] = [];
    for (let press = 0; press < ACTION_RATE_RULES.compile_start.capacity + 1; press += 1) {
      const result = await startCompilationAction(tripId);
      expect(result.ok).toBe(false);
      burst.push(result.error ?? '');
    }

    const allowed = burst.slice(0, ACTION_RATE_RULES.compile_start.capacity);
    expect(allowed.every((message) => message.includes('still yours to confirm'))).toBe(true);

    const refused = burst[burst.length - 1]!;
    expect(refused).toMatch(/lot of requests from this connection/);
    // The traveller's sentence, not a status code or a header name.
    expect(refused).toContain('your trip is saved');
    expect(refused).not.toMatch(/SIDEQUEST_|429|bucket/);
  });

  it('refuses a burst of destination lookups before the geocoder is asked', async () => {
    const tripId = await seededTrip();
    const { resolveDestinationAction } = await import('./actions');
    const { ACTION_RATE_RULES } = await import('@/lib/net/rate-limit');

    let refused: string | undefined;
    for (let press = 0; press < ACTION_RATE_RULES.destination_resolve.capacity + 1; press += 1) {
      const result = await resolveDestinationAction(tripId);
      if (press === ACTION_RATE_RULES.destination_resolve.capacity) refused = result.error;
    }
    expect(refused).toMatch(/lot of requests from this connection/);
  });
});

describe('the daily model ceiling in front of destination resolution', () => {
  it('refuses before the resolver is built once the day is spent', async () => {
    const tripId = await seededTrip();
    goOpen();
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '0';

    const { resolveDestinationAction } = await import('./actions');
    const { dailySpendSoFar } = await import('@/lib/compiler/daily-ceiling');

    const result = await resolveDestinationAction(tripId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('live research');
    // Nothing was booked for a call that was never made, and — the point of
    // the ordering — no provider was constructed to make it.
    expect(dailySpendSoFar('model_calls', new Date())).toBe(0);
  });

  it('books the model call the resolver is about to make', async () => {
    const tripId = await seededTrip();
    goOpen();
    /*
     * One call in the day's allowance. The reservation is taken, the resolver
     * then fails on this machine because no provider is reachable from a test —
     * and the booking stands, which is the property: a spend recorded from the
     * *result* would miss every call that timed out, which is the shape a
     * runaway produces.
     */
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '4';
    const { resolveDestinationAction } = await import('./actions');
    const { dailySpendSoFar } = await import('@/lib/compiler/daily-ceiling');

    await resolveDestinationAction(tripId).catch(() => undefined);
    expect(dailySpendSoFar('model_calls', new Date())).toBe(1);
  });

  it('charges the fixture stack nothing, because it reaches no model', async () => {
    const tripId = await seededTrip();
    const { resolveDestinationAction } = await import('./actions');
    const { dailySpendSoFar } = await import('@/lib/compiler/daily-ceiling');

    await resolveDestinationAction(tripId);
    expect(dailySpendSoFar('model_calls', new Date())).toBe(0);
  });
});

/**
 * THE CALLER TRAVELS WITH THE START.
 *
 * The daily ceiling is only a per-caller ceiling if somebody hands it a caller,
 * and that hand-off is one argument in one action. Without it the ledger is a
 * single global counter and one visitor exhausts the deployment's research for
 * the day — measured by a reviewer at roughly seventeen minutes — while
 * everybody else is told to come back tomorrow.
 */
describe('the per-caller daily share, from the action that starts a build', () => {
  it('refuses this browser at its share while the deployment has room', async () => {
    // A known cookie, so the ledger can be pre-loaded against the exact key the
    // action will derive.
    jar.set('sidequest_session', BROWSER);

    const tripId = await seededConfirmedTrip();
    goOpen();
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '20';

    const { recordDailySpend, dailySpendSoFar } = await import('@/lib/compiler/daily-ceiling');
    for (let index = 0; index < 5; index += 1) {
      recordDailySpend('live_compilations', 1, new Date(), `session:${BROWSER}`);
    }

    const { startCompilationAction } = await import('./actions');
    const result = await startCompilationAction(tripId);

    expect(result.ok).toBe(false);
    // Their share, and the deployment is demonstrably not exhausted: five of
    // twenty. A global-only ledger would have allowed this press.
    expect(result.error).toContain('your share');
    expect(dailySpendSoFar('live_compilations', new Date())).toBe(5);
  });
});

/**
 * A trip with a confirmed region, built entirely on the fixture stack.
 *
 * The scope has to exist for the spend gate to be reached at all — an
 * unconfirmed one is refused earlier and would make the test above pass for the
 * wrong reason. Nothing here touches a network provider.
 */
async function seededConfirmedTrip(): Promise<string> {
  const tripId = await seededTrip();
  const repo = await import('@/lib/db/compiler-repository');
  const { compilerProviders } = await import('@/lib/compiler/providers');
  const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');

  const { providers } = compilerProviders();
  const resolution = await providers.resolver.resolve({ query: 'Harbour City', now: new Date() });
  repo.saveResolution(tripId, resolution);
  const candidate = resolution.candidates[0]!;
  repo.saveSelectedCandidate(tripId, candidate.id);
  const clarifications = rebuildClarificationSet({ resolution, candidate, nights: 3, known: {} });
  repo.saveClarifications(tripId, clarifications);
  repo.saveScope(
    tripId,
    deriveScope({ candidate, clarifications, nights: 3, revision: 1, transitMeasurable: false }),
  );
  const intent = repo.getIntent(tripId)!;
  repo.saveScope(tripId, {
    ...intent.scope!,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
  return tripId;
}
