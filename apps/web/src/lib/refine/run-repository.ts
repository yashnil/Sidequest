import 'server-only';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import type { ClarifyingQuestion, RefinementIntent } from './state';

/**
 * ONE REFINEMENT AT A TIME, AND A DOUBLE PRESS IS ONE PRESS.
 *
 * PRODUCTION LOCK V5 §48 and §59.
 *
 * ## The concurrency policy, chosen deliberately
 *
 * The spec offers three: queue, cancel-and-replace, or reject. **Reject** is
 * implemented, and the reason is the shape of the failure the other two produce.
 *
 * A queue means the second request is computed against a trip the traveller has
 * not seen yet — they wrote "actually keep the hike but change the hotel" about
 * the trip on their screen, not about whatever the first edit is going to make.
 * Cancel-and-replace has the same problem plus a partially applied first edit to
 * clean up. Rejecting is the only one where every request is interpreted against
 * the trip the person was actually looking at.
 *
 * The lease is a **partial unique index** (`idx_refinement_runs_active`) rather
 * than an application-level check, because a check-then-insert has a window and an
 * index does not.
 *
 * ## Idempotency
 *
 * A double-submitted press, a retried request and a resumed interrupt all arrive
 * with the same `idempotencyKey` and return the same run. Without it, one
 * traveller pressing Send twice produces two refinements, two model calls and two
 * versions of a trip they asked to change once.
 */

export type RefinementRunStatus = 'running' | 'awaiting_answer' | 'done' | 'failed' | 'rejected';

export interface RefinementRun {
  id: string;
  tripId: string;
  threadId: string;
  idempotencyKey: string | null;
  status: RefinementRunStatus;
  baseVersion: number;
  request: string;
  intent: RefinementIntent | null;
  modelCalls: number;
  question: ClarifyingQuestion | null;
  result: unknown;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: string;
  trip_id: string;
  thread_id: string;
  idempotency_key: string | null;
  status: string;
  base_version: number;
  request: string;
  intent: string | null;
  model_calls: number;
  question_json: string | null;
  result_json: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

function parseRun(row: RunRow): RefinementRun {
  return {
    id: row.id,
    tripId: row.trip_id,
    threadId: row.thread_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as RefinementRunStatus,
    baseVersion: row.base_version,
    request: row.request,
    intent: (row.intent as RefinementIntent | null) ?? null,
    modelCalls: row.model_calls,
    question: row.question_json ? (JSON.parse(row.question_json) as ClarifyingQuestion) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export class RefinementBusyError extends Error {
  readonly activeRun: RefinementRun;
  constructor(activeRun: RefinementRun) {
    super(activeRun.status === 'awaiting_answer' ? 'Sidequest is waiting on your answer to the last change before it can start another.' : 'Sidequest is still working on your last change. It will be ready in a moment.');
    this.name = 'RefinementBusyError';
    this.activeRun = activeRun;
  }
}

/** The run currently holding the lease for this trip, if any. */
export function activeRun(tripId: string): RefinementRun | null {
  const row = getDb().prepare("SELECT * FROM refinement_runs WHERE trip_id = ? AND status IN ('running', 'awaiting_answer')").get(tripId) as RunRow | undefined;
  return row ? parseRun(row) : null;
}

export function getRun(id: string): RefinementRun | null {
  const row = getDb().prepare('SELECT * FROM refinement_runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? parseRun(row) : null;
}

/**
 * Take the lease, or say who has it.
 *
 * Returns `{ reused: true }` for an idempotent repeat, so a caller can tell "you
 * already asked this" from "somebody else is mid-edit" — two situations that look
 * the same from the database and need opposite answers on screen.
 */
export function beginRun(input: { tripId: string; threadId: string; request: string; baseVersion: number; idempotencyKey?: string; now?: Date }): { run: RefinementRun; reused: boolean } {
  const db = getDb();
  const now = (input.now ?? new Date()).toISOString();
  if (input.idempotencyKey) {
    const existing = db.prepare('SELECT * FROM refinement_runs WHERE trip_id = ? AND idempotency_key = ?').get(input.tripId, input.idempotencyKey) as RunRow | undefined;
    if (existing) return { run: parseRun(existing), reused: true };
  }
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO refinement_runs (id, trip_id, thread_id, idempotency_key, status, base_version, request, model_calls, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, 0, ?, ?)`,
    ).run(id, input.tripId, input.threadId, input.idempotencyKey ?? null, input.baseVersion, input.request, now, now);
  } catch (error) {
    /*
     * The partial unique index refused it: somebody is mid-edit. Distinguished
     * from any other constraint failure by looking for the actual holder rather
     * than by matching an error message, which is driver-specific and changes.
     */
    const holder = activeRun(input.tripId);
    if (holder) throw new RefinementBusyError(holder);
    throw error;
  }
  return { run: getRun(id)!, reused: false };
}

/** Record progress without releasing the lease. */
export function updateRun(input: { id: string; status?: RefinementRunStatus; intent?: RefinementIntent | null; modelCalls?: number; question?: ClarifyingQuestion | null; result?: unknown; error?: string | null; now?: Date }): void {
  const now = (input.now ?? new Date()).toISOString();
  const terminal = input.status === 'done' || input.status === 'failed' || input.status === 'rejected';
  getDb()
    .prepare(
      `UPDATE refinement_runs SET
         status = COALESCE(@status, status),
         intent = COALESCE(@intent, intent),
         model_calls = COALESCE(@model_calls, model_calls),
         question_json = CASE WHEN @question_set = 1 THEN @question_json ELSE question_json END,
         result_json = CASE WHEN @result_set = 1 THEN @result_json ELSE result_json END,
         error = CASE WHEN @error_set = 1 THEN @error ELSE error END,
         updated_at = @now,
         finished_at = CASE WHEN @terminal = 1 THEN @now ELSE finished_at END
       WHERE id = @id`,
    )
    .run({
      id: input.id,
      status: input.status ?? null,
      intent: input.intent ?? null,
      model_calls: input.modelCalls ?? null,
      question_set: input.question === undefined ? 0 : 1,
      question_json: input.question ? JSON.stringify(input.question) : null,
      result_set: input.result === undefined ? 0 : 1,
      result_json: input.result === undefined ? null : JSON.stringify(input.result),
      error_set: input.error === undefined ? 0 : 1,
      error: input.error ?? null,
      now,
      terminal: terminal ? 1 : 0,
    });
}

/** The most recent runs for a trip, newest first. For the conversation panel. */
export function listRuns(tripId: string, limit = 20): RefinementRun[] {
  const rows = getDb().prepare('SELECT * FROM refinement_runs WHERE trip_id = ? ORDER BY started_at DESC LIMIT ?').all(tripId, limit) as RunRow[];
  return rows.map(parseRun);
}

/**
 * Release a lease whose process died.
 *
 * A run left `running` by a crashed request would hold the lease forever and lock
 * the traveller out of their own trip. Nothing here retries the work: the trip is
 * unchanged (§49) and the traveller can ask again.
 */
export function releaseStaleRuns(input: { olderThanMs: number; now?: Date }): number {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.olderThanMs).toISOString();
  const result = getDb()
    .prepare("UPDATE refinement_runs SET status = 'failed', error = 'This change was interrupted and did not finish. Your trip is unchanged.', updated_at = ?, finished_at = ? WHERE status = 'running' AND started_at < ?")
    .run(now.toISOString(), now.toISOString(), cutoff);
  return result.changes;
}
