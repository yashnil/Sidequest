import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PULSE: WHAT KEEPS "STILL RUNNING" TRUE WHILE IT IS TRUE.
 *
 * Heartbeats used to be written only at stage boundaries, and real stages run
 * past three minutes — so every healthy live build crossed the abandonment
 * threshold mid-stage and was offered up for a duplicate paid run. The pulse
 * writes on a clock instead, and doubles as the cancellation watch: the only
 * mid-flight reader of `cancel_requested` there has ever been.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-pulse-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-11T09:00:00.000Z');

async function seededRunningJob(): Promise<{ tripId: string; jobId: string }> {
  const { createTrip } = await import('../db/repository');
  const { startJob, markJobRunning } = await import('../db/compiler-repository');
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
  const result = startJob({ tripId: trip.id, scopeFingerprint: 'fp-1', now: NOW });
  if (result.kind !== 'started') throw new Error('expected a fresh job');
  markJobRunning(result.job.id, NOW);
  return { tripId: trip.id, jobId: result.job.id };
}

describe('the compilation pulse', () => {
  it('writes a fresh heartbeat every interval while the job runs', async () => {
    const { startCompilationPulse } = await import('./runner');
    const { getJob } = await import('../db/compiler-repository');
    const { jobId } = await seededRunningJob();

    const before = getJob(jobId)!.heartbeatAt;
    const stop = startCompilationPulse({ jobId, haltOnCancel: false, intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(3_500);
    const after = getJob(jobId)!.heartbeatAt;
    stop();

    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('notices a cancellation, records the spend so far, and stops beating', async () => {
    const { startCompilationPulse } = await import('./runner');
    const { requestCancel, getJob } = await import('../db/compiler-repository');
    const { tripId, jobId } = await seededRunningJob();

    const onCancelled = vi.fn();
    startCompilationPulse({ jobId, haltOnCancel: false, onCancelled, intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_500);
    requestCancel(tripId, new Date(NOW.getTime() + 2_000));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onCancelled).toHaveBeenCalledTimes(1);
    const cancelledAt = getJob(jobId)!.updatedAt;

    /*
     * And the pulse must not beat over the terminal row: a heartbeat written
     * onto a cancelled job would make `isAbandoned` false forever and the row
     * look freshly alive. Advancing further must change nothing.
     */
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJob(jobId)!.updatedAt).toBe(cancelledAt);
    expect(getJob(jobId)!.state).toBe('cancelled');
  });

  it('stops the process on cancellation only when this process exists for the job', async () => {
    const { startCompilationPulse } = await import('./runner');
    const { requestCancel } = await import('../db/compiler-repository');
    const { tripId, jobId } = await seededRunningJob();

    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      startCompilationPulse({ jobId, haltOnCancel: true, intervalMs: 1_000 });
      requestCancel(tripId, new Date(NOW.getTime() + 500));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it('self-stops once the job reaches any terminal state', async () => {
    const { startCompilationPulse } = await import('./runner');
    const { failJob, getJob } = await import('../db/compiler-repository');
    const { jobId } = await seededRunningJob();

    startCompilationPulse({ jobId, haltOnCancel: false, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_500);

    failJob({ jobId, code: 'internal_error', now: new Date(NOW.getTime() + 2_000) });
    const endedAt = getJob(jobId)!.heartbeatAt;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getJob(jobId)!.heartbeatAt).toBe(endedAt);
  });
});
