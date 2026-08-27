import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_INTERVAL_MS } from '@sidequest/core';

/**
 * THE PULSE, AT THE ONE CALL SITE THAT MAKES IT REAL.
 *
 * The defect this fixed is written out at the call site: `heartbeat()` was
 * exported with a rationale and had **zero callers**, so the only heartbeat
 * writes were the stage-boundary ones — and real stages run past the ninety
 * seconds `isAbandoned` allows. Every healthy live build was reported dead
 * mid-stage and the screen offered a second paid build while the first was
 * still spending.
 *
 * The fix is one line inside `runCompilation`. `runner.pulse.test.ts` proves
 * the pulse itself, thoroughly, by driving `startCompilationPulse` directly —
 * and an adversary deleted the call site, leaving `const stopPulse = () => {}`,
 * with the entire repository suite green. That is the identical shape of the
 * bug that was just fixed: a mechanism nobody invokes, defended by tests that
 * invoke it themselves.
 *
 * So this drives `runCompilation` and asserts the two things the call site is
 * responsible for, both observed **while a stage is still running**:
 *
 * 1. the heartbeat advances during the stage, not only at its boundaries; and
 * 2. a cancellation raised mid-stage is noticed, and what the run had spent by
 *    then is recorded.
 *
 * `compileRegion` is replaced by one that parks — that is the long stage, and
 * the only way to be inside one without spending anything. Virtual time, so
 * the real fifteen-second interval costs nothing.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/** Released by the test once it has seen what it came for. */
let releaseStage: (() => void) | null = null;
let stageEntered: Promise<void> | null = null;

vi.mock('@sidequest/compiler', async () => {
  const actual = await import('@sidequest/compiler');
  return {
    ...actual,
    compileRegion: async () => {
      let entered: () => void = () => {};
      stageEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const parked = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      entered();
      await parked;
      throw new Error('stage abandoned by the test');
    },
  };
});

beforeEach(() => {
  releaseDatabase();
  releaseStage = null;
  stageEntered = null;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-pulse-wiring-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Wait until the run is genuinely inside the long stage.
 *
 * A setup barrier, not a retried assertion: everything asserted below is about
 * what happens *during* a stage, so reading the row before the runner has
 * reached one would be measuring the wrong moment. Today the runner awaits
 * nothing before `compileRegion`, so the mock is entered synchronously and this
 * returns on the first turn; the loop exists so that the day something async
 * lands in front of it, this fails by name rather than by a heartbeat that
 * mysteriously did not advance. Microtask turns rather than timer ticks,
 * because the clock here is virtual and must stay under the test's control.
 */
async function insideTheStage(): Promise<void> {
  for (let turn = 0; turn < 50 && stageEntered === null; turn += 1) await Promise.resolve();
  if (stageEntered === null) {
    throw new Error('the compilation never reached its compile stage, so nothing here was measured');
  }
  await stageEntered;
}

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

describe('runCompilation installs the pulse around the compile call', () => {
  it('keeps the heartbeat fresh while one stage runs long', async () => {
    const { getTrip } = await import('../db/repository');
    const { getJob } = await import('../db/compiler-repository');
    const { runCompilation } = await import('./runner');

    const { tripId, jobId } = await seededConfirmedTrip();
    const run = runCompilation({ trip: getTrip(tripId)!, jobId });
    await insideTheStage();

    /*
     * The beat at the start of the run, written by `markJobRunning`. Nothing
     * else writes one until the stage ends — which, here, it never does.
     */
    const atStageStart = getJob(jobId)!.heartbeatAt;

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 1_000);
    const midStage = getJob(jobId)!.heartbeatAt;

    releaseStage?.();
    await run;

    expect(Date.parse(midStage)).toBeGreaterThan(Date.parse(atStageStart));
  });

  it('notices a cancellation raised mid-stage and records what the run had spent', async () => {
    const { getTrip } = await import('../db/repository');
    const { getJob, getStoredOperationalDiagnostics, requestCancel } = await import(
      '../db/compiler-repository'
    );
    const { runCompilation } = await import('./runner');

    const { tripId, jobId } = await seededConfirmedTrip();
    const run = runCompilation({ trip: getTrip(tripId)!, jobId });
    await insideTheStage();

    /*
     * Nothing has been written about cost yet: every other `saveOperationalDiagnostics`
     * call is downstream of the compile call, and the compile call has not
     * returned. So whatever appears below came from the pulse.
     */
    expect(getStoredOperationalDiagnostics(jobId)).toBeNull();

    requestCancel(tripId, new Date());
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1_000);

    expect(getJob(jobId)!.state).toBe('cancelled');
    expect(
      getStoredOperationalDiagnostics(jobId),
      'a cancelled build recorded nothing about what it had already spent',
    ).not.toBeNull();

    releaseStage?.();
    await run;
  });

  /**
   * STOP, WHEN THE WORKER HAD NOT STARTED YET.
   *
   * `markJobRunning` was an unguarded write of `state = 'running'`, so a job
   * cancelled between the click that queued it and the worker that picked it up
   * came *back to life* — and then spent its whole budget, because the pulse
   * stops on a terminal state and this one no longer had one. The window is not
   * theoretical: spawning a Node process and loading the compiler is the
   * slowest part of a build's first second, and Stop is offered from the moment
   * the progress screen renders.
   *
   * Asserted at the seam that costs money: the compiler is never reached.
   */
  it('never compiles a job that was stopped before this process took it', async () => {
    const { getTrip } = await import('../db/repository');
    const { getJob, requestCancel } = await import('../db/compiler-repository');
    const { runCompilation } = await import('./runner');

    const { tripId, jobId } = await seededConfirmedTrip();
    requestCancel(tripId, new Date());

    const run = runCompilation({ trip: getTrip(tripId)!, jobId });
    try {
      // Every chance to reach the compiler, on the same microtask budget the
      // barrier above uses. A run that has not entered the stage by now is a
      // run that never will.
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
      expect(stageEntered, 'a stopped build reached the compiler and started spending').toBeNull();
    } finally {
      // Only reachable when the guard failed and the stage really is parked.
      releaseStage?.();
    }

    expect(await run).toBeNull();
    // …and the traveller's verdict is still theirs, not overwritten by ours.
    expect(getJob(jobId)!.state).toBe('cancelled');
    expect(getJob(jobId)!.errorCode).toBe('cancelled_by_user');
  });
});
