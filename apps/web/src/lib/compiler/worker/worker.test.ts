import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE WORKER PATH, DRIVEN FOR REAL: SPAWN, COMPILE, READ THE ROW.
 *
 * One running compilation used to freeze every route for eleven to sixteen
 * minutes, because the build ran on the request-serving process's event loop.
 * These tests prove the two properties that ended that:
 *
 * 1. **The same compile code runs to a real artifact in a spawned process.**
 *    A real fixture compilation — resolver, scope, job row, region — through
 *    `compile-worker.mjs` exactly as production spawns it, with the database
 *    as the only channel.
 * 2. **The web process's event loop stays live while it happens.** Measured,
 *    not asserted from architecture: the parent samples its own loop lag for
 *    the duration of the build.
 *
 * Everything here is the fixture stack. No network, no credentials, no spend.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-worker-'));
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
 * A trip with a confirmed fixture scope, exactly as the plan flow stores one —
 * through the same repositories, so the worker reads what production writes.
 */
async function seededConfirmedTrip(): Promise<{ tripId: string }> {
  const { createTrip } = await import('../../db/repository');
  const repo = await import('../../db/compiler-repository');
  const { compilerProviders } = await import('../providers');
  const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');

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
  const clarifications = rebuildClarificationSet({
    resolution,
    candidate,
    nights: 3,
    known: {},
  });
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

async function waitForTerminal(jobId: string, timeoutMs: number): Promise<string> {
  const { getJob } = await import('../../db/compiler-repository');
  const { isTerminal } = await import('@sidequest/core');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(jobId);
    if (job && isTerminal(job.state)) return job.state;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} still ${job?.state ?? 'missing'} after ${timeoutMs}ms`);
    }
    await new Promise((settle) => setTimeout(settle, 250));
  }
}

describe('the compile worker', () => {
  it(
    'runs a fixture compilation to a real artifact in a separate process, without blocking this one',
    { timeout: 120_000 },
    async () => {
      const { tripId } = await seededConfirmedTrip();
      const { getTrip } = await import('../../db/repository');
      const { startCompilation } = await import('../runner');
      const { launchCompilationWorker } = await import('./launch');
      const { getJob } = await import('../../db/compiler-repository');

      const outcome = startCompilation(getTrip(tripId)!);
      expect(outcome.kind).toBe('started');
      if (outcome.kind !== 'started') return;

      /*
       * The liveness measurement. The launch must return immediately, and this
       * process's event loop must stay responsive for the whole build — which
       * is precisely what the in-process design could not do. A 200 ms ceiling
       * on loop lag is generous for a healthy loop and impossible for one
       * hosting the compile.
       */
      const launchStarted = performance.now();
      const launched = launchCompilationWorker({ tripId, jobId: outcome.jobId });
      const launchMs = performance.now() - launchStarted;
      expect(launched.launched).toBe(true);
      expect(launchMs).toBeLessThan(250);

      let maxLagMs = 0;
      let expected = performance.now() + 50;
      const sampler = setInterval(() => {
        const now = performance.now();
        maxLagMs = Math.max(maxLagMs, now - expected);
        expected = now + 50;
      }, 50);

      try {
        const state = await waitForTerminal(outcome.jobId, 110_000);
        // The fixture worlds compile to `partial` by design (they carry
        // deliberate gaps); either finished state proves the path. On failure,
        // surface the job's own verdict — a bare state name sends whoever
        // reads the CI log spelunking through worker log files.
        const terminal = getJob(outcome.jobId);
        expect(
          ['ready', 'partial'],
          `job ended ${state}: ${terminal?.errorCode ?? '?'} — ${terminal?.errorDetail ?? ''}`,
        ).toContain(state);
      } finally {
        clearInterval(sampler);
      }

      const job = getJob(outcome.jobId)!;
      expect(job.compiledRegionId).toBeTruthy();
      expect(job.stages.some((stage) => stage.status === 'done')).toBe(true);

      /*
       * The number this whole workstream exists for. The in-process design
       * measured as multi-minute stalls; a spawned build must leave this loop
       * within interactive bounds throughout.
       */
      expect(maxLagMs).toBeLessThan(200);
    },
  );

  it(
    'honours a cancellation racing the build: the row stays cancelled and no artifact is adopted',
    { timeout: 120_000 },
    async () => {
      const { tripId } = await seededConfirmedTrip();
      const { getTrip } = await import('../../db/repository');
      const { startCompilation } = await import('../runner');
      const { launchCompilationWorker } = await import('./launch');
      const { getJob, requestCancel, getIntent } = await import('../../db/compiler-repository');

      const outcome = startCompilation(getTrip(tripId)!);
      if (outcome.kind !== 'started') throw new Error('expected a fresh job');

      const launched = launchCompilationWorker({ tripId, jobId: outcome.jobId });
      expect(launched.launched).toBe(true);

      /*
       * Cancel while the worker is still bootstrapping. The traveller's stop
       * must win whatever the worker goes on to produce: `requestCancel` flips
       * the row terminal now, and the guarded `completeJob` refuses the
       * finished artifact later.
       */
      requestCancel(tripId, new Date());
      expect(getJob(outcome.jobId)?.state).toBe('cancelled');

      // Give the worker time to finish its build and try to complete anyway.
      await new Promise((settle) => setTimeout(settle, 20_000));

      const job = getJob(outcome.jobId)!;
      expect(job.state).toBe('cancelled');
      expect(job.compiledRegionId).toBeUndefined();
      expect(getIntent(tripId)?.selectedCompiledRegionId).toBeNull();
    },
  );
});

describe('which side of the isolation boundary a build lands on', () => {
  /**
   * PR-REL-01 IS ONE TERNARY, AND NOTHING PINNED IT.
   *
   * Both tests above spawn `compile-worker.mjs` themselves, so both hold with
   * `compilerIsolationMode()` defaulting to `inline` — and an adversary flipped
   * exactly that default with the whole repository suite green. The production
   * expression of "compile work is isolated from the request-serving event
   * loop" is this one function's answer when nobody has configured anything,
   * because that answer is what `startCompilationAction` branches on. A
   * deployment that silently fell back to `inline` would restore the eleven-
   * to-sixteen-minute freeze the tests above were written to end, and they
   * would keep passing while it did.
   *
   * The action's own half of this — that it reaches `launchCompilationWorker`
   * rather than `after()` under the default — is asserted in
   * `plan/actions.rate-limit.test.ts`, which counts the launches it makes.
   */
  const ISOLATION = 'SIDEQUEST_COMPILER_ISOLATION';

  afterEach(() => {
    delete process.env[ISOLATION];
  });

  it('isolates by default, which is the production shape', async () => {
    const { compilerIsolationMode } = await import('./launch');
    delete process.env[ISOLATION];
    expect(compilerIsolationMode()).toBe('process');
  });

  it('runs inline only when a deployment says so, in as many words', async () => {
    const { compilerIsolationMode } = await import('./launch');
    process.env[ISOLATION] = 'inline';
    expect(compilerIsolationMode()).toBe('inline');
    process.env[ISOLATION] = ' INLINE ';
    expect(compilerIsolationMode()).toBe('inline');
  });

  it('falls back to isolation on anything it does not understand', () => {
    /**
     * The direction this fails matters, as it does for the labs gate: a typo
     * in a deployment variable must not quietly put a compilation back on the
     * request-serving loop.
     */
    return (async () => {
      const { compilerIsolationMode } = await import('./launch');
      for (const value of ['', ' ', 'in-line', 'true', 'worker', 'nope']) {
        process.env[ISOLATION] = value;
        expect(compilerIsolationMode(), `SIDEQUEST_COMPILER_ISOLATION=${value}`).toBe('process');
      }
    })();
  });
});
