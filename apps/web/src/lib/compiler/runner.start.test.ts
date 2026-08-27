import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE START GATE: WHERE THE DAILY CEILING ACTUALLY BITES.
 *
 * The ledger tests next door prove the arithmetic; these prove the wiring —
 * that a live start consults the gate before any job exists, records its
 * reservation the moment one does, and that the fixture stack never pays a
 * spend gate it does not owe. `startCompilation` reaches no provider before
 * `startJob`, which is what makes this testable with fake switch values and
 * no network.
 */

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
  'SIDEQUEST_MAX_CONCURRENT_COMPILATIONS',
];

beforeEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-start-gate-'));
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

/** Seeded under the fixture stack; the scope does not depend on the provider. */
async function seededConfirmedTrip(destination = 'Harbour City'): Promise<{ tripId: string }> {
  const { createTrip } = await import('../db/repository');
  const repo = await import('../db/compiler-repository');
  const { compilerProviders } = await import('./providers');
  const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');

  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: destination,
    regionId: 'open-world',
    startDate: '2026-09-01',
    endDate: '2026-09-04',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  repo.saveDestinationQuery(trip.id, 'known_destination', destination);
  const { providers } = compilerProviders();
  const resolution = await providers.resolver.resolve({ query: destination, now: new Date() });
  repo.saveResolution(trip.id, resolution);
  const candidate = resolution.candidates[0]!;
  repo.saveSelectedCandidate(trip.id, candidate.id);
  const clarifications = rebuildClarificationSet({ resolution, candidate, nights: 3, known: {} });
  repo.saveClarifications(trip.id, clarifications);
  const scope = deriveScope({
    candidate,
    clarifications,
    nights: 3,
    revision: 1,
    transitMeasurable: false,
  });
  repo.saveScope(trip.id, scope);
  const intent = repo.getIntent(trip.id)!;
  repo.saveScope(trip.id, {
    ...intent.scope!,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
  return { tripId: trip.id };
}

function goOpen(): void {
  for (const [key, value] of Object.entries(OPEN_STACK)) process.env[key] = value;
}

describe('startCompilation and the daily ceiling', () => {
  it('refuses a live start once the day is spent, in the traveller’s words', async () => {
    const { tripId } = await seededConfirmedTrip();
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');

    goOpen();
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '0';
    const outcome = startCompilation(getTrip(tripId)!);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.code).toBe('budget_exhausted');
      expect(outcome.message).toContain('saved');
      expect(outcome.message).not.toMatch(/SIDEQUEST_/);
    }
  });

  it('reserves one live compilation on the ledger the moment a job starts', async () => {
    const { tripId } = await seededConfirmedTrip();
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { dailySpendSoFar } = await import('./daily-ceiling');

    goOpen();
    const outcome = startCompilation(getTrip(tripId)!);
    expect(outcome.kind).toBe('started');
    expect(dailySpendSoFar('live_compilations')).toBe(1);
  });

  it('never gates the fixture stack, which cannot spend', async () => {
    const { tripId } = await seededConfirmedTrip();
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');

    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '0';
    const outcome = startCompilation(getTrip(tripId)!);
    expect(outcome.kind).toBe('started');
  });

  it('adopts an already-running live job instead of refusing it at a full ledger', async () => {
    const { tripId } = await seededConfirmedTrip();
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');

    goOpen();
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '1';
    const first = startCompilation(getTrip(tripId)!);
    expect(first.kind).toBe('started');

    /*
     * The ledger is now at its ceiling, and the same traveller presses the
     * button again. That click spends nothing new — the build is already
     * going — so it must adopt, not refuse.
     */
    const second = startCompilation(getTrip(tripId)!);
    expect(second.kind).toBe('already_running');
  });
});

/**
 * HOW MANY BUILDS AT ONCE, WHICH WAS NOT BOUNDED BY ANYTHING.
 *
 * The unique job index bounds builds *per trip*; nothing bounded them in total,
 * so fifty trips were fifty simultaneous worker processes. That is a cost
 * problem and, worse, a politeness one: every outbound gate this app owns is a
 * promise chain in module scope, and those modules claim "concurrency collapses
 * to a queue no matter how many compilations are running". They were right until
 * the compile worker moved that state into one process per build, after which N
 * builds meant N times the rate this application promised four volunteer-run
 * services.
 */
describe('startCompilation and the concurrency bound', () => {
  it('never starts a second concurrent live build, and queues it instead', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { occupiedCompilationSlots } = await import('../db/compiler-repository');

    goOpen();
    expect(startCompilation(getTrip(first)!).kind).toBe('started');

    /*
     * The bound is what this test is about and it still holds: the second trip
     * does not get a concurrent build. What it gets instead is the correction —
     * it used to be `blocked`, which meant a third of a launch cohort's presses
     * were turned away on the most expensive action in the product with no line
     * and no retry. The queue's own behaviour, bound and honesty live in
     * `queue.test.ts`; what belongs here is that nothing started.
     */
    const outcome = startCompilation(getTrip(second)!);
    expect(outcome.kind, 'a second trip started a second concurrent live build').toBe('queued');
    expect(occupiedCompilationSlots(new Date()), 'two builds hold slots at once').toBe(1);
  });

  it('lets an operator who has moved off the shared services raise it', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');

    goOpen();
    process.env.SIDEQUEST_MAX_CONCURRENT_COMPILATIONS = '2';
    expect(startCompilation(getTrip(first)!).kind).toBe('started');
    expect(startCompilation(getTrip(second)!).kind).toBe('started');
  });

  it('never counts a build whose process is gone against the deployment', async () => {
    const { HEARTBEAT_TIMEOUT_MS } = await import('@sidequest/core');
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');

    goOpen();
    const now = new Date();
    expect(startCompilation(getTrip(first)!, now).kind).toBe('started');

    /*
     * The slot must not be held by a corpse. Without the heartbeat cut-off, one
     * process killed mid-build locks the whole deployment out of compiling until
     * somebody happens to open that trip's page and reclaim it.
     */
    const later = new Date(now.getTime() + HEARTBEAT_TIMEOUT_MS + 1_000);
    expect(startCompilation(getTrip(second)!, later).kind).toBe('started');
  });
});
