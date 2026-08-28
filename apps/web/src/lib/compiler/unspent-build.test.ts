import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A BUILD THAT DELIVERED NOTHING DOES NOT COST THE TRAVELLER A BUILD.
 *
 * The live-compilation unit is reserved at the press, which is right — a
 * ceiling discovered by crossing it is not a ceiling, and a queued build is one
 * build that will run. What was missing is the other half: nothing could ever
 * give it back. A build that failed before it reached a provider still spent
 * one of the six a browser gets in a day, and on a deployment whose research
 * credential is rejected *every* build fails exactly that way — so a traveller
 * is locked out for twenty-four hours by a product that never did any work for
 * them.
 *
 * Asserted on the ledger rather than on the runner's return value, because the
 * ledger is the thing the next press is measured against.
 */

let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-unspent-build-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe('the daily live-compilation reserve', () => {
  it('comes back to both rows when a build ends having spent nothing', async () => {
    const { recordDailySpend, dailySpendSoFar, refundLiveCompilation } = await import(
      './daily-ceiling'
    );
    const now = new Date('2026-08-27T10:00:00.000Z');
    const caller = 'session:one-browser';

    recordDailySpend('live_compilations', 1, now, caller);
    expect(dailySpendSoFar('live_compilations', now)).toBe(1);
    expect(dailySpendSoFar('live_compilations', now, caller)).toBe(1);

    refundLiveCompilation(now, caller);
    expect(dailySpendSoFar('live_compilations', now)).toBe(0);
    expect(
      dailySpendSoFar('live_compilations', now, caller),
      'a refund that moved only the deployment row is a ceiling that lies to one of them',
    ).toBe(0);
  });

  it('cannot be pushed below zero into an allowance somebody could mint', async () => {
    const { dailySpendSoFar, refundLiveCompilation } = await import('./daily-ceiling');
    const now = new Date('2026-08-27T10:00:00.000Z');
    const caller = 'session:one-browser';

    refundLiveCompilation(now, caller);
    refundLiveCompilation(now, caller);
    expect(dailySpendSoFar('live_compilations', now)).toBe(0);
    expect(dailySpendSoFar('live_compilations', now, caller)).toBe(0);
  });

  it('carries the caller on the job row, because the press and the run are different processes', async () => {
    const { startJob, jobCallerKey } = await import('../db/compiler-repository');
    const { getDb } = await import('../db/client');
    getDb()
      .prepare(
        `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
           arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
         VALUES (?, 'known_destination', 'Somewhere', 'dynamic', '2026-10-12', '2026-10-17',
           '16:00', '09:00', 2, 0, '[]', 'draft', ?, ?)`,
      )
      .run('trip-unspent', '2026-08-27T09:00:00.000Z', '2026-08-27T09:00:00.000Z');

    const started = startJob({
      tripId: 'trip-unspent',
      scopeFingerprint: 'fingerprint',
      now: new Date('2026-08-27T10:00:00.000Z'),
      callerKey: 'session:one-browser',
    });
    if (started.kind !== 'started') throw new Error('the job did not start');
    expect(jobCallerKey(started.job.id)).toBe('session:one-browser');
  });
});
