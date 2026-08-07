import 'server-only';
import {
  MIN_OBSERVATIONS_FOR_ESTIMATE,
  estimateRemainingFrom,
  observationBucket,
  stageObservationSchema,
  type CompilationStage,
  type DestinationShape,
  type RemainingEstimate,
  type StageObservation,
  type Warmth,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * THE THIRD CLOCK, AND THE ONLY ONE THAT OUTLIVES A RUN.
 *
 * `schemas/timing.ts` describes the split: the artifact has no clock, the job
 * row has this run's clock, and this table has the history that makes one run
 * comparable to another. This module is the whole of the third column, and it
 * exists as a separate table rather than as more columns on `compilation_jobs`
 * for one reason — a job is deleted with its trip and history must not be.
 *
 * ## Which fields are columns, and which live in `payload_json`
 *
 * A field is a column when a `WHERE` needs it, and a document field otherwise.
 * That is the whole rule, and getting it wrong cost a table scan on every
 * progress poll: `job_id` was a document field, `runBucket` needed it in a
 * predicate, and the only way to ask for it was
 * `payload_json LIKE '%"jobId":"…"%'` over as many as fifty thousand rows —
 * every 1.2 seconds, for the whole of a build, for every traveller watching one.
 * The composite index made it worse by looking like cover: it led with
 * `breadth`, which no query in this file has ever constrained.
 *
 * So `job_id` is a real column with an index matching the predicate
 * (`idx_stage_observations_job`), and the bucket read has one that matches its
 * own (`idx_stage_observations_lookup`, leading with `warmth`). The rest — the
 * artifact id, the shape bucket, the degraded flag, provider calls, retries,
 * work units, the cancellation and failure categories — is read *after* the
 * narrowing and never appears in a `WHERE`, so it stays one validated document
 * that either parses or does not, which is what makes the drop-on-mismatch rule
 * below implementable at all.
 *
 * `timing-repository.test.ts` asserts the plans with `EXPLAIN QUERY PLAN`, so
 * "this is indexed" is a checked claim rather than a comment.
 *
 * ## Nothing here may fail a compilation
 *
 * Every write is wrapped. A build that produced a region and could not record
 * how long it took has produced a region; a build that threw while recording a
 * duration has lost one. The same posture `saveWorkPlan` takes, for the same
 * reason.
 */

/**
 * How many rows to keep.
 *
 * Twenty-six observations per build, so this is roughly two thousand builds of
 * history — far more than the estimator can use and small enough that the table
 * never becomes a thing anybody has to think about. Pruned oldest-first, because
 * a nine-month-old observation describes a pipeline that no longer exists.
 */
export const STAGE_OBSERVATION_RETENTION = 50_000;

/**
 * How many rows a bucket query may return.
 *
 * Bounded because the estimator computes percentiles in memory and an unbounded
 * read of this table on every progress poll is a slow page waiting to happen.
 * Ordered newest-first so the cap drops the oldest evidence rather than the most
 * relevant.
 */
export const OBSERVATION_READ_LIMIT = 2_000;

/**
 * Write one observation. Never throws.
 *
 * Parsed before it is written rather than after it is read: an observation that
 * cannot be validated is a row that will be dropped on every subsequent read,
 * which is a silent leak rather than an error. Better to refuse it here, where
 * the log line names the build that produced it.
 */
export function recordStageObservation(observation: StageObservation): void {
  try {
    const parsed = stageObservationSchema.parse(observation);
    getDb()
      .prepare(
        `INSERT INTO stage_observations
           (job_id, stage, outcome, breadth, warmth, duration_ms, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.jobId,
        parsed.stage,
        parsed.outcome,
        parsed.breadth,
        parsed.warmth,
        Math.round(parsed.durationMs),
        JSON.stringify(parsed),
        parsed.observedAt,
      );
  } catch (error) {
    console.error('Could not record a stage observation', {
      jobId: observation.jobId,
      stage: observation.stage,
      error,
    });
  }
}

/**
 * Observations comparable to the run described by `filter`.
 *
 * Two-step by design. SQL narrows on `warmth` and `outcome` — in that order,
 * which is the order `idx_stage_observations_lookup` leads with, and the reason
 * that index exists — and the shape and degraded buckets are applied in memory,
 * because neither is a column and inventing one would mean a migration. The
 * narrowing is still doing the work: `outcome = 'done'` alone removes every
 * failed and skipped row, which is most of what a struggling pipeline writes.
 *
 * A row that does not parse is **dropped, not coerced**. Version 1 rows have no
 * `degraded` flag; coercing one would mean guessing `false` and mixing a
 * provider outage into the healthy bucket, which is the exact contamination the
 * bucket exists to prevent.
 */
export function comparableObservations(filter: {
  shape: DestinationShape;
  warmth: Warmth;
  degraded: boolean;
  limit?: number;
}): StageObservation[] {
  const wanted = observationBucket(filter);
  const limit = Math.max(1, Math.min(filter.limit ?? OBSERVATION_READ_LIMIT, OBSERVATION_READ_LIMIT));

  try {
    const rows = getDb()
      .prepare(
        `SELECT payload_json FROM stage_observations
          WHERE warmth = ? AND outcome = 'done'
          ORDER BY observed_at DESC
          LIMIT ?`,
      )
      .all(filter.warmth, limit) as { payload_json: string }[];

    const observations: StageObservation[] = [];
    for (const row of rows) {
      const parsed = safeParseObservation(row.payload_json);
      if (!parsed) continue;
      if (observationBucket(parsed) !== wanted) continue;
      observations.push(parsed);
    }
    return observations;
  } catch (error) {
    console.error('Could not read stage observations', error);
    return [];
  }
}

/**
 * The remaining-time range for a run in progress, or nothing.
 *
 * Nothing is the expected answer for a long time after this ships, and that is
 * the design rather than a gap to be filled: `MIN_OBSERVATIONS_FOR_ESTIMATE`
 * distinct builds have to exist *in this bucket* first. Seeding the table to
 * make a number appear sooner would be fabricating the evidence the number
 * claims to rest on — the fixtures in `timing.test.ts` seed observations because
 * a test asserting the estimator works needs input, and nothing on the
 * production path does.
 */
export function estimateRemainingForRun(input: {
  remainingStages: readonly CompilationStage[];
  shape: DestinationShape;
  warmth: Warmth;
  degraded: boolean;
}): RemainingEstimate | null {
  if (input.remainingStages.length === 0) return null;
  const observations = comparableObservations(input);
  return estimateRemainingFrom({ ...input, observations });
}

/**
 * Which bucket a run in progress belongs to, according to the run itself.
 *
 * Read back off the observations this job has already written rather than
 * re-derived from the trip's scope, and the difference is not pedantry. Warmth
 * is not a property of the destination — it is a property of what the cache held
 * when this build started — so a progress screen that re-derived it would be
 * guessing, and would ask for a warm bucket's history while watching a cold
 * build. The run classified itself when it recorded its first stage; this reads
 * that classification back.
 *
 * Null until the first observation lands, which means no estimate until then.
 * That is correct: an estimate for a build we cannot yet classify is an estimate
 * from the wrong history.
 */
export function runBucket(
  jobId: string,
): { shape: DestinationShape; warmth: Warmth; degraded: boolean } | null {
  try {
    const db = getDb();

    /*
     * The indexed lookup, which is the whole of the hot path.
     *
     * `idx_stage_observations_job(job_id, id)` covers both the equality and the
     * `ORDER BY id DESC`, so this is a one-row index seek whatever the table
     * grows to. It replaces `payload_json LIKE '%"jobId":"…"%'`, which SQLite
     * could only answer by deserialising every row in the table — on a query
     * that runs on every 1.2-second progress poll.
     */
    const row = db
      .prepare(
        `SELECT payload_json FROM stage_observations
          WHERE job_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(jobId) as { payload_json: string } | undefined;

    const parsed = row ? safeParseObservation(row.payload_json) : null;
    if (parsed && parsed.jobId === jobId) {
      return { shape: parsed.shape, warmth: parsed.warmth, degraded: parsed.degraded };
    }

    /*
     * ROWS WRITTEN BEFORE `job_id` WAS A COLUMN.
     *
     * They carry the job id inside `payload_json` and nowhere else, so the seek
     * above cannot see them. This reads them, and only when the seek missed — a
     * build in progress writes its first observation with the column populated,
     * so a live run never reaches this line at all.
     *
     * It is still indexed rather than a scan: SQLite stores NULLs in an index,
     * so `job_id IS NULL ORDER BY id DESC` seeks into the same index and walks
     * only the legacy rows, a set that is fixed at migration time and shrinks to
     * nothing as the retention sweep ages them out. When it is empty this costs
     * one index probe.
     */
    const legacy = db
      .prepare(
        `SELECT payload_json FROM stage_observations
          WHERE job_id IS NULL AND payload_json LIKE ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(`%"jobId":${JSON.stringify(jobId)}%`) as { payload_json: string } | undefined;
    if (!legacy) return null;

    const fallback = safeParseObservation(legacy.payload_json);
    if (!fallback || fallback.jobId !== jobId) return null;
    return { shape: fallback.shape, warmth: fallback.warmth, degraded: fallback.degraded };
  } catch (error) {
    console.error('Could not read a run bucket', { jobId, error });
    return null;
  }
}

/** Distinct builds recorded in a bucket. Diagnostics, and the estimator's own bar. */
export function observedRunCount(filter: {
  shape: DestinationShape;
  warmth: Warmth;
  degraded: boolean;
}): number {
  return new Set(comparableObservations(filter).map((observation) => observation.jobId)).size;
}

/**
 * Drop the oldest rows beyond the retention cap. Returns how many went.
 *
 * Called from the same rare path a sweep runs on, never from a render. A table
 * that only ever grows is a slow query nobody notices until the day it is a slow
 * page.
 */
export function pruneStageObservations(keep = STAGE_OBSERVATION_RETENTION): number {
  try {
    const result = getDb()
      .prepare(
        `DELETE FROM stage_observations
          WHERE id NOT IN (
            SELECT id FROM stage_observations ORDER BY observed_at DESC, id DESC LIMIT ?
          )`,
      )
      .run(Math.max(0, Math.floor(keep)));
    return result.changes;
  } catch (error) {
    console.error('Could not prune stage observations', error);
    return 0;
  }
}

/**
 * JOIN THIS RUN'S OBSERVATIONS TO THE ARTIFACT IT PRODUCED.
 *
 * Written after the commit, and it cannot be written earlier. An observation is
 * stamped as its stage lands, and at that moment nobody knows whether the run
 * will end with an artifact at all — which is exactly what
 * `StageObservation.compiledRegionId`'s own comment describes: absent while the
 * build is still running, and absent for ever if it failed. The field had that
 * rationale written down and no writer, which is a comment describing a value
 * nobody produces.
 *
 * Never throws. A build that produced a region and failed to record the join has
 * produced a region.
 */
export function attachCompiledRegionToObservations(
  jobId: string,
  compiledRegionId: string,
): number {
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT rowid AS id, payload_json FROM stage_observations WHERE job_id = ?')
      .all(jobId) as { id: number; payload_json: string }[];
    const update = db.prepare('UPDATE stage_observations SET payload_json = ? WHERE rowid = ?');
    let changed = 0;
    db.transaction(() => {
      for (const row of rows) {
        const parsed = safeParseObservation(row.payload_json);
        if (!parsed || parsed.jobId !== jobId) continue;
        if (parsed.compiledRegionId === compiledRegionId) continue;
        update.run(JSON.stringify({ ...parsed, compiledRegionId }), row.id);
        changed += 1;
      }
    })();
    return changed;
  } catch (error) {
    console.error('Could not attach a compiled region to its observations', { jobId, error });
    return 0;
  }
}

function safeParseObservation(raw: string): StageObservation | null {
  try {
    const result = stageObservationSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export { MIN_OBSERVATIONS_FOR_ESTIMATE };
