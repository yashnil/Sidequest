import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STAGE_OBSERVATION_VERSION, type StageObservation } from '@sidequest/core';
import { getDb } from './client';
import {
  comparableObservations,
  observedRunCount,
  pruneStageObservations,
  recordStageObservation,
  runBucket,
} from './timing-repository';

/**
 * THE TABLE A PROGRESS POLL READS, EVERY 1.2 SECONDS, WHILE SOMEBODY WAITS.
 *
 * Two claims are asserted here, and the second is the one that was false.
 *
 * 1. An observation round-trips: what was written is what comes back, and a row
 *    the current schema cannot read is dropped rather than coerced.
 * 2. **Every read this file performs is an index seek.** `runBucket` used to be
 *    `payload_json LIKE '%"jobId":"…"%'` — a predicate SQLite can only answer by
 *    deserialising every row in a table capped at fifty thousand — and the
 *    composite index that looked like cover led with `breadth`, which no query
 *    here has ever constrained.
 *
 * The second claim is checked with `EXPLAIN QUERY PLAN` rather than with a
 * timing, because a timing on a small fixture table passes against the defect: a
 * scan of two hundred rows is fast. The plan says what SQLite will do at fifty
 * thousand, which is the number that matters.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-timing-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'timing.db');
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
});

afterEach(() => {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function observation(over: Partial<StageObservation> = {}): StageObservation {
  return {
    schemaVersion: STAGE_OBSERVATION_VERSION,
    jobId: 'job-1',
    stage: 'retrieving_pages',
    phase: 'verifying',
    outcome: 'done',
    startedAt: '2026-08-02T12:00:00.000Z',
    completedAt: '2026-08-02T12:00:42.000Z',
    durationMs: 42_000,
    breadth: 'city',
    shape: 'city',
    warmth: 'cold',
    degraded: false,
    providerCalls: 3,
    cacheHits: 1,
    retries: 0,
    observedAt: '2026-08-02T12:00:42.000Z',
    ...over,
  } as StageObservation;
}

/** The plan SQLite would use, as one string per step. */
function planFor(sql: string, ...parameters: unknown[]): string {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(parameters as never[])) as { detail: string }[];
  return rows.map((row) => row.detail).join(' | ');
}

describe('an observation, written and read back', () => {
  it('records the job id as a column, not only inside the document', () => {
    recordStageObservation(observation({ jobId: 'job-columned' }));

    const row = getDb()
      .prepare(`SELECT job_id FROM stage_observations LIMIT 1`)
      .get() as { job_id: string | null };
    expect(row.job_id).toBe('job-columned');
  });

  it('classifies a run from its own most recent observation', () => {
    recordStageObservation(observation({ jobId: 'job-a', warmth: 'cold', shape: 'city' }));
    recordStageObservation(
      observation({ jobId: 'job-b', warmth: 'warm', shape: 'broad_country', degraded: true }),
    );

    expect(runBucket('job-a')).toEqual({ shape: 'city', warmth: 'cold', degraded: false });
    expect(runBucket('job-b')).toEqual({
      shape: 'broad_country',
      warmth: 'warm',
      degraded: true,
    });
    expect(runBucket('job-that-never-ran')).toBeNull();
  });

  it('still finds a run whose rows were written before job_id was a column', () => {
    /*
     * The migration leaves old rows with a NULL column and the job id inside
     * `payload_json`. Dropping them would silently remove every estimate a
     * long-running deployment had accumulated, so they are read through a second
     * lookup that only runs when the indexed one misses.
     */
    const legacy = observation({ jobId: 'job-legacy', warmth: 'mixed', shape: 'park_remote' });
    getDb()
      .prepare(
        `INSERT INTO stage_observations
           (job_id, stage, outcome, breadth, warmth, duration_ms, payload_json, observed_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacy.stage,
        legacy.outcome,
        legacy.breadth,
        legacy.warmth,
        legacy.durationMs,
        JSON.stringify(legacy),
        legacy.observedAt,
      );

    expect(runBucket('job-legacy')).toEqual({
      shape: 'park_remote',
      warmth: 'mixed',
      degraded: false,
    });
  });

  it('drops a row the current schema cannot read rather than guessing a bucket', () => {
    getDb()
      .prepare(
        `INSERT INTO stage_observations
           (job_id, stage, outcome, breadth, warmth, duration_ms, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'job-v1',
        'retrieving_pages',
        'done',
        'city',
        'cold',
        1000,
        JSON.stringify({ schemaVersion: 1, jobId: 'job-v1', stage: 'retrieving_pages' }),
        '2026-08-02T12:00:00.000Z',
      );

    expect(runBucket('job-v1')).toBeNull();
    expect(comparableObservations({ shape: 'city', warmth: 'cold', degraded: false })).toEqual([]);
  });

  it('counts distinct runs in a bucket rather than rows', () => {
    for (const stage of ['retrieving_pages', 'extracting_facts', 'reconciling_facts'] as const) {
      recordStageObservation(observation({ jobId: 'job-one', stage }));
    }
    recordStageObservation(observation({ jobId: 'job-two' }));

    expect(comparableObservations({ shape: 'city', warmth: 'cold', degraded: false })).toHaveLength(4);
    expect(observedRunCount({ shape: 'city', warmth: 'cold', degraded: false })).toBe(2);
  });

  it('prunes oldest-first and leaves the newest', () => {
    for (let index = 0; index < 6; index += 1) {
      recordStageObservation(
        observation({
          jobId: `job-${index}`,
          observedAt: `2026-08-0${index + 1}T12:00:00.000Z`,
        }),
      );
    }

    expect(pruneStageObservations(2)).toBe(4);
    const kept = comparableObservations({ shape: 'city', warmth: 'cold', degraded: false });
    expect(kept.map((entry) => entry.jobId).sort()).toEqual(['job-4', 'job-5']);
  });
});

/**
 * THE PLANS.
 *
 * `SCAN stage_observations` in any of these is the defect returning. The
 * assertions name the index rather than merely forbidding the word, because a
 * plan can avoid a scan by using the *wrong* index and still read far more rows
 * than it needs — which is what `idx_stage_observations_bucket` did while
 * leading with a column nothing constrains.
 */
describe('every read this repository performs is an index seek', () => {
  beforeEach(() => {
    for (let index = 0; index < 40; index += 1) {
      recordStageObservation(observation({ jobId: `job-${index % 8}` }));
    }
    // ANALYZE, so the planner chooses on statistics rather than on nothing —
    // otherwise the plan asserted here is not the plan production would use.
    getDb().exec('ANALYZE');
  });

  it('finds a run by its job id through the job index, and never scans', () => {
    const plan = planFor(
      `SELECT payload_json FROM stage_observations WHERE job_id = ? ORDER BY id DESC LIMIT 1`,
      'job-3',
    );
    expect(plan).toContain('idx_stage_observations_job');
    expect(plan).not.toMatch(/\bSCAN stage_observations\b/);
  });

  it('reads legacy rows through the same index rather than over the whole table', () => {
    const plan = planFor(
      `SELECT payload_json FROM stage_observations
        WHERE job_id IS NULL AND payload_json LIKE ?
        ORDER BY id DESC LIMIT 1`,
      '%"jobId":"job-3"%',
    );
    expect(plan).toContain('idx_stage_observations_job');
    expect(plan).not.toMatch(/\bSCAN stage_observations\b/);
  });

  it('narrows the bucket read on the columns the predicate actually holds', () => {
    const plan = planFor(
      `SELECT payload_json FROM stage_observations
        WHERE warmth = ? AND outcome = 'done'
        ORDER BY observed_at DESC
        LIMIT ?`,
      'cold',
      100,
    );
    expect(plan).toContain('idx_stage_observations_lookup');
    expect(plan).not.toMatch(/\bSCAN stage_observations\b/);
  });

  /**
   * The predicate that was there, kept as an assertion about *why* it went.
   *
   * A `LIKE` with a leading wildcard is unindexable by construction, so this
   * plan is a scan whatever indexes exist. It is here so that anybody tempted to
   * reintroduce it can see, in one line, what it costs.
   */
  it('shows the old predicate for what it was: a scan of the whole table', () => {
    const plan = planFor(
      `SELECT payload_json FROM stage_observations WHERE payload_json LIKE ? ORDER BY id DESC LIMIT 1`,
      '%"jobId":"job-3"%',
    );
    expect(plan).toMatch(/\bSCAN stage_observations\b/);
  });
});
