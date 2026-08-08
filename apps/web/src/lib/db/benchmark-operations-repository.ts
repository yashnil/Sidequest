import 'server-only';
import { stableHash } from '@sidequest/bench';
import { getDb } from './client';

/**
 * DURABLE SINGLE FLIGHT FOR BENCHMARK WORK.
 *
 * The same shape as `model_operations`, for the same reasons, and deliberately a
 * separate table rather than a reuse of that one: `model_operations.trip_id`
 * carries a cascading foreign key to `trips`, and a benchmark record that
 * vanished when somebody deleted a trip would take the evidence with it.
 *
 * A lease with a heartbeat rather than an expiry timestamp, because a process
 * killed mid-call must release its claim rather than wedge a session for ever —
 * and because the alternative, a fixed timeout, is always either too short for a
 * slow model call or too long for a reviewer waiting at a screen.
 *
 * There is no `await` anywhere inside `claimBenchmarkOperation`, and there must
 * never be one. The guarantee is that expiry, inspection and insertion happen
 * with no interleaving point between them.
 */

export const BENCHMARK_OPERATION_LEASE_MS = 180_000;
export const BENCHMARK_OPERATION_MAX_ATTEMPTS = 2;

const ACTIVE_STATES = ['pending', 'running'] as const;

export type BenchmarkOperationState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'superseded';

export interface BenchmarkOperation {
  id: string;
  operationKey: string;
  sessionId: string;
  kind: string;
  state: BenchmarkOperationState;
  owner: string;
  attempt: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  resultRef: string | null;
  failureKind: string | null;
  detail: string | null;
}

export type BenchmarkClaim =
  | { kind: 'won'; operation: BenchmarkOperation }
  | { kind: 'lost'; operation: BenchmarkOperation }
  | { kind: 'settled'; operation: BenchmarkOperation }
  | { kind: 'exhausted'; operation: BenchmarkOperation | null };

const COLUMNS =
  'id, operation_key, session_id, kind, state, owner, attempt, started_at, heartbeat_at, finished_at, result_ref, failure_kind, detail';

interface Row {
  id: string;
  operation_key: string;
  session_id: string;
  kind: string;
  state: string;
  owner: string;
  attempt: number;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  result_ref: string | null;
  failure_kind: string | null;
  detail: string | null;
}

function toOperation(row: Row): BenchmarkOperation {
  return {
    id: row.id,
    operationKey: row.operation_key,
    sessionId: row.session_id,
    kind: row.kind,
    state: row.state as BenchmarkOperationState,
    owner: row.owner,
    attempt: row.attempt,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    resultRef: row.result_ref,
    failureKind: row.failure_kind,
    detail: row.detail,
  };
}

/**
 * Claim an operation, or find out why you cannot.
 *
 * Five steps, one transaction, no `await`:
 *
 * 1. A holder that stopped breathing releases its lease, recorded as an attempt
 *    that failed rather than one that never happened — otherwise a crash loop
 *    would be both invisible and unbounded.
 * 2. Somebody is holding it right now.
 * 3. It is already answered, or already failed in a way nobody retries. Checked
 *    before the attempt count, so a terminal failure closes the identity even
 *    with attempts to spare: re-asking a provider that just returned nonsense
 *    would spend money on every retry.
 * 4. Bounded retry. Every row for this identity counts, whoever wrote it.
 * 5. The claim. The unique partial index is what makes this the only winner; the
 *    code above is what makes losing informative.
 */
export function claimBenchmarkOperation(input: {
  sessionId: string;
  kind: string;
  operationKey: string;
  owner: string;
  now: Date;
  leaseMs?: number;
  maxAttempts?: number;
}): BenchmarkClaim {
  const db = getDb();
  const leaseMs = input.leaseMs ?? BENCHMARK_OPERATION_LEASE_MS;
  const maxAttempts = input.maxAttempts ?? BENCHMARK_OPERATION_MAX_ATTEMPTS;
  const nowIso = input.now.toISOString();
  const staleBefore = new Date(input.now.getTime() - leaseMs).toISOString();
  const placeholders = ACTIVE_STATES.map(() => '?').join(',');

  const claim = db.transaction((): BenchmarkClaim => {
    db.prepare(
      `UPDATE benchmark_operations
          SET state = 'failed_retryable', failure_kind = 'lease_expired',
              finished_at = ?, detail = 'The holder stopped reporting before it finished.'
        WHERE operation_key = ? AND state IN (${placeholders}) AND heartbeat_at <= ?`,
    ).run(nowIso, input.operationKey, ...ACTIVE_STATES, staleBefore);

    const active = db
      .prepare(
        `SELECT ${COLUMNS} FROM benchmark_operations
          WHERE operation_key = ? AND state IN (${placeholders})
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(input.operationKey, ...ACTIVE_STATES) as Row | undefined;
    if (active) return { kind: 'lost', operation: toOperation(active) };

    const settled = db
      .prepare(
        `SELECT ${COLUMNS} FROM benchmark_operations
          WHERE operation_key = ? AND state IN ('succeeded','failed_terminal')
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(input.operationKey) as Row | undefined;
    if (settled) return { kind: 'settled', operation: toOperation(settled) };

    const priorRow = db
      .prepare('SELECT COUNT(*) AS total FROM benchmark_operations WHERE operation_key = ?')
      .get(input.operationKey) as { total: number };
    const prior = Number(priorRow?.total ?? 0);
    if (prior >= maxAttempts) {
      const last = db
        .prepare(
          `SELECT ${COLUMNS} FROM benchmark_operations
            WHERE operation_key = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .get(input.operationKey) as Row | undefined;
      return { kind: 'exhausted', operation: last ? toOperation(last) : null };
    }

    /*
     * The identity is in the id, not just the timestamp.
     *
     * `bop:${millisecond}:${owner}:${attempt}` collided whenever two *different*
     * operations were claimed by the same owner in the same millisecond — which
     * is not exotic: the harness claims a question round and a generation for one
     * session, and any caller pinning a logical clock does it every time. The
     * insert then hit the primary key, the catch below found no active row for
     * this key, and the claim came back `exhausted` — reported to the reviewer as
     * "this request has used every attempt it is allowed", for an operation that
     * had never been attempted at all.
     *
     * Including the operation key makes the id say what it identifies. The
     * attempt count still comes from the rows for this key, so the ceiling is
     * unchanged.
     */
    const id = `bop:${stableHash(input.operationKey)}:${input.now.getTime().toString(36)}:${input.owner}:${prior + 1}`;
    db.prepare(
      `INSERT INTO benchmark_operations
         (id, operation_key, session_id, kind, state, owner, attempt, started_at, heartbeat_at)
       VALUES (?,?,?,?,'running',?,?,?,?)`,
    ).run(
      id,
      input.operationKey,
      input.sessionId,
      input.kind,
      input.owner,
      prior + 1,
      nowIso,
      nowIso,
    );

    const row = db.prepare(`SELECT ${COLUMNS} FROM benchmark_operations WHERE id = ?`).get(id) as Row;
    return { kind: 'won', operation: toOperation(row) };
  });

  try {
    return claim();
  } catch {
    // Another process won the index. That is not a failure; it is the answer.
    const active = db
      .prepare(
        `SELECT ${COLUMNS} FROM benchmark_operations
          WHERE operation_key = ? AND state IN (${placeholders})
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(input.operationKey, ...ACTIVE_STATES) as Row | undefined;
    if (active) return { kind: 'lost', operation: toOperation(active) };
    return { kind: 'exhausted', operation: null };
  }
}

/** Still alive. Returns false once the row is no longer the caller's to hold. */
export function heartbeatBenchmarkOperation(id: string, now: Date): boolean {
  const result = getDb()
    .prepare(
      `UPDATE benchmark_operations SET heartbeat_at = ?
        WHERE id = ? AND state IN ('pending','running')`,
    )
    .run(now.toISOString(), id);
  return Number(result.changes ?? 0) > 0;
}

export function settleBenchmarkOperation(input: {
  id: string;
  state: Exclude<BenchmarkOperationState, 'pending' | 'running'>;
  now: Date;
  resultRef?: string | null;
  failureKind?: string | null;
  detail?: string | null;
}): BenchmarkOperation | null {
  const db = getDb();
  db.prepare(
    `UPDATE benchmark_operations
        SET state = ?, finished_at = ?, heartbeat_at = ?, result_ref = ?,
            failure_kind = ?, detail = ?
      WHERE id = ? AND state IN ('pending','running')`,
  ).run(
    input.state,
    input.now.toISOString(),
    input.now.toISOString(),
    input.resultRef ?? null,
    input.failureKind ?? null,
    input.detail ?? null,
    input.id,
  );
  const row = db.prepare(`SELECT ${COLUMNS} FROM benchmark_operations WHERE id = ?`).get(input.id) as
    | Row
    | undefined;
  return row ? toOperation(row) : null;
}

export function latestBenchmarkOperation(operationKey: string): BenchmarkOperation | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM benchmark_operations
        WHERE operation_key = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(operationKey) as Row | undefined;
  return row ? toOperation(row) : null;
}

/**
 * Wait for the holder to finish, for a bounded time, without calling anything.
 *
 * Polling rather than a notification because the driver has no listener, and a
 * loser has nothing useful to do meanwhile. The `await` in the loop is the point:
 * it yields the event loop so the holder's own `await` can resolve, which is what
 * makes a same-process loser observe the winner's result instead of deadlocking
 * behind it.
 */
export async function awaitBenchmarkOperation(input: {
  operationKey: string;
  timeoutMs: number;
  pollMs?: number;
  clock?: () => number;
}): Promise<BenchmarkOperation | null> {
  const clock = input.clock ?? (() => Date.now());
  const pollMs = input.pollMs ?? 250;
  const deadline = clock() + input.timeoutMs;

  for (;;) {
    const operation = latestBenchmarkOperation(input.operationKey);
    if (operation && operation.state !== 'pending' && operation.state !== 'running') {
      return operation;
    }
    if (clock() >= deadline) return operation;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
