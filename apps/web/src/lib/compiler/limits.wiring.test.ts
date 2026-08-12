import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE TWO CEILINGS, AT THE TWO SEAMS THEY CROSS.
 *
 * `limits.ts` exists to make one number govern each ceiling — the transport
 * refused the thirteenth model call while the ledger printed twenty, and live
 * builds ran eight minutes under a printed three-minute clock. The module was
 * written, both consumers were wired, and nothing asserted either wiring: an
 * adversary replaced `modelCallCeiling()` with `Number.MAX_SAFE_INTEGER` at
 * `providers.ts` and `compileDeadlineMs()` with the same at `runner.ts`, and
 * the whole repository suite stayed green. An infinite budget handed to a
 * transport whose only job is to enforce a finite one is an unbounded bill on
 * a runaway compilation, and nothing would have said so.
 *
 * These assert the **composition**, not the constants: what the web layer
 * actually hands the thing that enforces it, under the default and under a
 * configured override. The override matters as much as the default — a test
 * that only pinned the default would pass against a hardcoded 12.
 *
 * Nothing here reaches a provider. `createOpenProviders` is replaced by a
 * recorder that refuses to build a live stack at all, and `compileRegion` by
 * one that records the budget it was handed and stops.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/** What the live provider stack was asked to enforce, and a refusal to build one. */
const openProviderCalls: { maxModelCalls?: number }[] = [];
const REFUSED = 'the live stack is never built in this test';

vi.mock('../providers/live', async () => {
  const actual = await import('../providers/live');
  return {
    ...actual,
    createOpenProviders: (input: { maxModelCalls?: number }) => {
      openProviderCalls.push(input);
      /*
       * Thrown rather than faked. The subject is the argument, and a stub
       * provider set convincing enough to survive `withEvidenceStore` would be
       * a second implementation of the live stack living in a test file.
       */
      throw new Error(REFUSED);
    },
  };
});

/** The budget the runner threads into the compiler, captured at the boundary. */
const compileCalls: { budget?: { maxModelCalls?: number; maxDurationMs?: number } }[] = [];

vi.mock('@sidequest/compiler', async () => {
  const actual = await import('@sidequest/compiler');
  return {
    ...actual,
    compileRegion: (input: { budget?: { maxModelCalls?: number; maxDurationMs?: number } }) => {
      compileCalls.push(input);
      // The runner's own catch path takes it from here: the job fails, the
      // pulse stops, and the test reads what was on its way in.
      throw new Error('captured');
    },
  };
});

const ENV_KEYS = [
  'SIDEQUEST_COMPILER_MAX_AI_CALLS',
  'SIDEQUEST_COMPILER_DEADLINE_MS',
  'SIDEQUEST_COMPILER_PROVIDER',
  'SIDEQUEST_GEOCODER_PROVIDER',
  'SIDEQUEST_PLACE_BACKBONE',
  'SIDEQUEST_ROUTES_PROVIDER',
  'SIDEQUEST_RESEARCH_PROVIDER',
  'ANTHROPIC_API_KEY',
];

beforeEach(() => {
  releaseDatabase();
  openProviderCalls.length = 0;
  compileCalls.length = 0;
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-limits-wiring-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function goOpen(): void {
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'open';
  process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
  process.env.SIDEQUEST_PLACE_BACKBONE = 'overture';
  process.env.SIDEQUEST_ROUTES_PROVIDER = 'valhalla';
  process.env.SIDEQUEST_RESEARCH_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-test-never-a-real-key';
}

/** The one argument the recorder above saw, or a failure that says so. */
function onlyOpenProviderCall(): { maxModelCalls?: number } {
  expect(openProviderCalls, 'the open provider stack was never built').toHaveLength(1);
  return openProviderCalls[0]!;
}

describe('the model-call ceiling reaches the transport that enforces it', () => {
  it('hands the live stack the resolved ceiling rather than a number of its own', async () => {
    const { compilerProviders } = await import('./providers');
    const { modelCallCeiling } = await import('./limits');

    goOpen();
    expect(() => compilerProviders()).toThrow(REFUSED);
    expect(onlyOpenProviderCall().maxModelCalls).toBe(modelCallCeiling());
  });

  it('carries a configured override through, which a hardcoded default would not', async () => {
    const { compilerProviders } = await import('./providers');

    goOpen();
    process.env.SIDEQUEST_COMPILER_MAX_AI_CALLS = '4';
    expect(() => compilerProviders()).toThrow(REFUSED);
    expect(onlyOpenProviderCall().maxModelCalls).toBe(4);
  });
});

describe('both ceilings reach the compiler that prints and obeys them', () => {
  async function seededConfirmedTrip(): Promise<{ tripId: string; jobId: string }> {
    const { createTrip, getTrip } = await import('../db/repository');
    const repo = await import('../db/compiler-repository');
    const { compilerProviders } = await import('./providers');
    const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');
    const { startCompilation } = await import('./runner');

    const trip = createTrip({
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
    });
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
    const outcome = startCompilation(getTrip(trip.id)!);
    if (outcome.kind !== 'started') throw new Error(`expected a started job, got ${outcome.kind}`);
    return { tripId: trip.id, jobId: outcome.jobId };
  }

  it('threads the resolved ceilings into the budget it hands compileRegion', async () => {
    const { getTrip } = await import('../db/repository');
    const { runCompilation } = await import('./runner');
    const { compileDeadlineMs, modelCallCeiling } = await import('./limits');

    const { tripId, jobId } = await seededConfirmedTrip();
    await runCompilation({ trip: getTrip(tripId)!, jobId });

    expect(compileCalls, 'the compiler was never reached').toHaveLength(1);
    expect(compileCalls[0]!.budget).toEqual({
      maxModelCalls: modelCallCeiling(),
      maxDurationMs: compileDeadlineMs(),
    });
  });

  it('carries configured overrides for both, so the printed limit is the operative one', async () => {
    const { getTrip } = await import('../db/repository');
    const { runCompilation } = await import('./runner');

    process.env.SIDEQUEST_COMPILER_MAX_AI_CALLS = '7';
    process.env.SIDEQUEST_COMPILER_DEADLINE_MS = '90000';

    const { tripId, jobId } = await seededConfirmedTrip();
    await runCompilation({ trip: getTrip(tripId)!, jobId });

    expect(compileCalls[0]!.budget).toEqual({ maxModelCalls: 7, maxDurationMs: 90_000 });
  });
});
