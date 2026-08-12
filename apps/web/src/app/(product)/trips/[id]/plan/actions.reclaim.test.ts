import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_TIMEOUT_MS } from '@sidequest/core';

/**
 * THE POLL THAT ENDS AN ORPHAN, THROUGH THE ACTION THE SCREEN ACTUALLY CALLS.
 *
 * The repository test proves `reclaimAbandonedJob`; this proves the screen's
 * own poll invokes it — the gap that let "Working — 12198m 51s" render was
 * precisely that the reporting path never wrote anything.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-reclaim-action-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('compilationSnapshotAction', () => {
  it('flips a cold job to interrupted on the row, not merely in the reply', async () => {
    const { createTrip } = await import('@/lib/db/repository');
    const { startJob, markJobRunning, getJob } = await import('@/lib/db/compiler-repository');
    const { compilationSnapshotAction } = await import('./actions');

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
    const started = startJob({
      tripId: trip.id,
      scopeFingerprint: 'fp-1',
      now: new Date(Date.now() - HEARTBEAT_TIMEOUT_MS - 60_000),
    });
    if (started.kind !== 'started') throw new Error('expected a fresh job');
    markJobRunning(started.job.id, new Date(Date.now() - HEARTBEAT_TIMEOUT_MS - 60_000));

    const snapshot = await compilationSnapshotAction(trip.id);

    // The reply is honest…
    expect(snapshot.state).toBe('failed');
    expect(snapshot.retryable).toBe(true);
    expect(snapshot.errorMessage).toContain('Nothing was lost');

    // …and, the part that was missing, so is the row: the next poll, the plan
    // page and the retry guard all read the same terminal verdict.
    const job = getJob(started.job.id);
    expect(job?.state).toBe('failed');
    expect(job?.errorCode).toBe('compilation_interrupted');
  });

  it('refuses an oversized trip id without touching the database', async () => {
    const { compilationSnapshotAction } = await import('./actions');
    const snapshot = await compilationSnapshotAction('x'.repeat(500));
    expect(snapshot.state).toBe('none');
  });
});
