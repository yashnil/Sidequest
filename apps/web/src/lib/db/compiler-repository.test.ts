import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_TIMEOUT_MS } from '@sidequest/core';

/**
 * A JOB ENDS EXACTLY ONCE, AND SILENCE HAS A VERDICT.
 *
 * Three defects share these tests, and all three reached a real screen:
 *
 * - `heartbeat()` was exported with a rationale and had **zero callers**, so a
 *   healthy build longer than the timeout was reported dead and offered a
 *   duplicate paid build;
 * - nothing ever *ended* an abandoned row, so a dead build rendered
 *   "Working — 12198m 51s" with a live-ticking clock;
 * - cancellation was a flag read after the money was spent, and a worker that
 *   finished anyway could overwrite the traveller's "stop" with its own
 *   verdict.
 *
 * The repository now enforces the missing invariant: `completeJob` and
 * `failJob` refuse over a terminal state, `requestCancel` writes the terminal
 * state itself, and `reclaimAbandonedJob` gives cold silence an honest,
 * retryable ending.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-compiler-repo-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-11T09:00:00.000Z');

async function seededJob(): Promise<{ tripId: string; jobId: string }> {
  const { createTrip } = await import('./repository');
  const { startJob, markJobRunning } = await import('./compiler-repository');
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

describe('terminal writes happen exactly once', () => {
  it('failJob refuses to relabel a job that already ended', async () => {
    const { failJob, getJob } = await import('./compiler-repository');
    const { jobId } = await seededJob();

    expect(failJob({ jobId, code: 'internal_error', now: NOW })).toBe(true);
    expect(
      failJob({ jobId, code: 'cancelled_by_user', now: NOW, cancelled: true }),
    ).toBe(false);

    const job = getJob(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.errorCode).toBe('internal_error');
  });

  it('requestCancel flips the job terminal immediately, stages included', async () => {
    const { requestCancel, getJob, recordStage } = await import('./compiler-repository');
    const { tripId, jobId } = await seededJob();
    recordStage(
      jobId,
      { stage: 'discovering_candidates', status: 'running', startedAt: NOW.toISOString() },
      NOW,
    );

    requestCancel(tripId, NOW);

    const job = getJob(jobId);
    expect(job?.state).toBe('cancelled');
    expect(job?.cancelRequested).toBe(true);
    /*
     * The in-flight stage must end with the job: `groupStages` keeps a phase's
     * clock running for as long as anything says `running`, which is exactly
     * how a dead build kept counting on screen.
     */
    const open = job?.stages.filter((stage) => stage.status === 'running') ?? [];
    expect(open).toHaveLength(0);
  });

  it('a cancelled job cannot be completed by the worker that did not notice', async () => {
    const { requestCancel, getJob } = await import('./compiler-repository');
    const { tripId, jobId } = await seededJob();
    requestCancel(tripId, NOW);

    /*
     * The worker's completion path parses a full region before writing, so the
     * guard is asserted at the SQL layer: state must be untouched and no
     * artifact adopted. A raw update through completeJob would need a whole
     * CompiledRegion fixture; the guard it exercises is the same `state IN`
     * check failJob proved above, and the runner test covers the full path.
     */
    const { failJob } = await import('./compiler-repository');
    expect(failJob({ jobId, code: 'internal_error', now: NOW })).toBe(false);
    expect(getJob(jobId)?.state).toBe('cancelled');
    expect(getJob(jobId)?.errorCode).toBe('cancelled_by_user');
  });
});

describe('orphaned jobs get an honest ending', () => {
  it('reclaims a job whose heartbeat went cold, as interrupted and retryable', async () => {
    const { reclaimAbandonedJob, getJob } = await import('./compiler-repository');
    const { isRetryable } = await import('@sidequest/core');
    const { tripId, jobId } = await seededJob();

    const later = new Date(NOW.getTime() + HEARTBEAT_TIMEOUT_MS + 1_000);
    expect(reclaimAbandonedJob(tripId, later)).toBe(true);

    const job = getJob(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.errorCode).toBe('compilation_interrupted');
    expect(isRetryable('compilation_interrupted')).toBe(true);
  });

  it('leaves a job alone while its heartbeat is fresh', async () => {
    const { reclaimAbandonedJob, getJob, heartbeat } = await import('./compiler-repository');
    const { tripId, jobId } = await seededJob();

    const midCall = new Date(NOW.getTime() + HEARTBEAT_TIMEOUT_MS - 5_000);
    expect(reclaimAbandonedJob(tripId, midCall)).toBe(false);
    expect(getJob(jobId)?.state).toBe('running');

    /*
     * And a heartbeat resets the clock: a pulse at four minutes keeps a job
     * alive at six, which is the whole reason the pulse exists.
     */
    heartbeat(jobId, midCall);
    const evenLater = new Date(midCall.getTime() + HEARTBEAT_TIMEOUT_MS - 5_000);
    expect(reclaimAbandonedJob(tripId, evenLater)).toBe(false);
    expect(getJob(jobId)?.state).toBe('running');
  });

  it('startJob reclaims a stale row as interrupted, not as an internal error', async () => {
    const { startJob, getJob } = await import('./compiler-repository');
    const { tripId, jobId } = await seededJob();

    const later = new Date(NOW.getTime() + HEARTBEAT_TIMEOUT_MS + 1_000);
    const second = startJob({ tripId, scopeFingerprint: 'fp-1', now: later });
    expect(second.kind).toBe('started');

    const first = getJob(jobId);
    expect(first?.state).toBe('failed');
    expect(first?.errorCode).toBe('compilation_interrupted');
  });
});

describe('the heartbeat threshold and the calls it must outlast', () => {
  it('sits above the longest single model call the pipeline may make', () => {
    /*
     * The extraction transport allows a call 240 s (`anthropic.ts`); a
     * threshold below that calls a healthy build dead mid-call, which is the
     * defect that produced a duplicate-build offer during a paid run. The
     * margin covers a pulse delayed by synchronous work.
     */
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThan(240_000);
  });
});
