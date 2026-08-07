import 'server-only';
import {
  modelInterpretationResponseSchema,
  type ModelInterpretationResponse,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * ONE TRAVELLER'S SENTENCE, REMEMBERED FOR ONE TRIP.
 *
 * The counterpart to the evidence store, and deliberately its mirror image. A
 * fact about a museum is universal, so `evidence_*` is keyed on the subject and
 * outlives every trip that ever used it — the architecture test asserts those
 * tables carry no `trip_id` and cascade from nothing. A *reading of somebody's
 * words* is the opposite kind of thing: it is about one person, it is worth
 * nothing to anybody else, and reusing it across travellers would mean one
 * person's phrasing steering another person's board. So this table carries a
 * `trip_id`, cascades from `trips`, and the same architecture test asserts
 * that in the other direction.
 *
 * What it buys is narrow and real: the reading survives a refresh, a back
 * button and a closed laptop, so the one call the trip is allowed is not spent
 * twice on the same sentence. The key covers every version that could change
 * the answer — taxonomy, prompt, response schema, model, locale — so a contract
 * bump re-derives rather than serving a reading produced under different rules.
 *
 * Nothing here is load-bearing. Emptying the table costs one model call and
 * loses no traveller input: the verbatim text lives on the composer, and the
 * chips live on the interpretation.
 */

/** Long enough to survive a session, short enough that a stale contract expires. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheRow {
  payload_json: string;
}

/**
 * A stored reading, or nothing.
 *
 * A row that no longer parses is treated as absent rather than repaired. The
 * same policy the provisional board uses, and for a sharper reason here: a
 * half-understood cached reading is a chip proposed against somebody's words
 * with no way to check what produced it.
 */
export function getCachedInterpretation(
  tripId: string,
  cacheKey: string,
  now: Date,
): ModelInterpretationResponse | null {
  const row = getDb()
    .prepare<[string, string, string], CacheRow>(
      `SELECT payload_json FROM interpretation_cache
        WHERE trip_id = ? AND cache_key = ? AND expires_at > ?`,
    )
    .get(tripId, cacheKey, now.toISOString());
  if (!row) return null;
  try {
    const parsed = modelInterpretationResponseSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveCachedInterpretation(
  tripId: string,
  cacheKey: string,
  payload: ModelInterpretationResponse,
  now: Date,
): void {
  // Validated on the way in as well as on the way out, so a malformed reading
  // can never be *stored*, let alone served.
  const validated = modelInterpretationResponseSchema.parse(payload);
  getDb()
    .prepare(
      `INSERT INTO interpretation_cache (cache_key, trip_id, payload_json, created_at, expires_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(trip_id, cache_key) DO UPDATE SET payload_json = excluded.payload_json,
                                                     created_at   = excluded.created_at,
                                                     expires_at   = excluded.expires_at`,
    )
    .run(
      cacheKey,
      tripId,
      JSON.stringify(validated),
      now.toISOString(),
      new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
    );
}

/** Housekeeping. Never called on a render path. */
export function pruneExpiredInterpretations(now: Date): number {
  const result = getDb()
    .prepare('DELETE FROM interpretation_cache WHERE expires_at <= ?')
    .run(now.toISOString());
  return Number(result.changes ?? 0);
}

// ---------------------------------------------------------------------------
// THE SINGLE FLIGHT
// ---------------------------------------------------------------------------

/**
 * ONE PAID OPERATION, HELD BY ONE CLAIMANT, DURABLY.
 *
 * The cache above answers "have we asked this before?" and it answered it well
 * enough that the ceiling looked enforced. It was not. The action read
 * `interpretation.modelPass.calls > 0`, then `await`ed the provider — and an
 * `await` is where another invocation runs. Two clicks, two tabs, a double
 * submit or a refresh mid-flight all observed `calls: 0`, all bought a call, and
 * the record still said one. A cache cannot fix that, because the thing being
 * raced is the *gap between reading a fact and acting on it*, and the cache is
 * only written after the act.
 *
 * So the ceiling is a lease rather than a counter. `model_operations` carries a
 * unique partial index over `(operation_key) WHERE state IN ('pending','running')`,
 * which makes "somebody already holds this" a constraint the database enforces
 * rather than a condition code checks. better-sqlite3 is synchronous, so the
 * insert either returns or throws *before control leaves the function* — there
 * is no interleaving point inside it, and the claim is therefore atomic against
 * every other claimant in this process and, through the index, against every
 * other process too.
 *
 * The states, and what each one means to a claimant that arrives after it:
 *
 * - `pending` / `running` — somebody holds it. Wait, or read their answer. Never
 *   call.
 * - `succeeded` — there is an answer. Replay it; charge nothing.
 * - `failed_retryable` — an outage or a crashed holder. A bounded number of
 *   further attempts is allowed.
 * - `failed_terminal` — the provider answered with something unusable. Retrying
 *   a model that just returned nonsense is how a bounded fallback becomes an
 *   unbounded bill, so nobody tries again. A render cannot spend money.
 * - `superseded` — the traveller changed the text under a holder. Its answer is
 *   about a sentence that no longer exists and must never be applied.
 *
 * **A crashed holder does not wedge the trip.** Every holder writes a heartbeat;
 * a claim first expires any active row whose heartbeat has gone stale, recording
 * it as `failed_retryable` with `lease_expired`, and then competes normally. The
 * lease is a fixed window rather than a lock held for the request's lifetime,
 * because a process that has been killed cannot release a lock.
 *
 * **Usage is recorded whether or not the call worked.** `calls`, tokens and cost
 * are on the row and are written by `settleModelOperation` on every terminal
 * path. A failed provider call costs money; a ledger that only records successes
 * under-reports spend precisely when spend is going wrong.
 *
 * **It stays trip-scoped.** The row carries `trip_id` and cascades from `trips`,
 * and `operationKeyFor` puts the trip id in the key — so two travellers who type
 * the same sentence are two operations, and neither can wait on or replay the
 * other's answer. `fallback.test.ts` asserts the cache half of this rule; the
 * lease is held to the same one.
 */

export const MODEL_OPERATION_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'superseded',
] as const;
export type ModelOperationState = (typeof MODEL_OPERATION_STATES)[number];

/** Active means "somebody holds this". The unique index covers exactly these. */
const ACTIVE_STATES: readonly ModelOperationState[] = ['pending', 'running'];

/**
 * How long a holder may go quiet before its lease is reclaimed.
 *
 * Comfortably longer than the provider's own 30 s timeout, so a slow-but-alive
 * call is never stolen from, and short enough that a killed process does not
 * cost the traveller a minute of a spinner.
 */
export const MODEL_OPERATION_LEASE_MS = 45_000;

/**
 * Total attempts for one operation identity, across every claimant and restart.
 *
 * Three, and not "one per request": a genuine outage deserves a second go, and
 * an unbounded retry on a paid call is the failure mode this whole file exists
 * to prevent. A `failed_terminal` attempt closes the identity regardless of how
 * many attempts remain.
 */
export const MODEL_OPERATION_MAX_ATTEMPTS = 3;

export interface ModelOperationUsage {
  /** Paid provider calls this attempt made. Zero is a real answer. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export interface ModelOperation {
  id: string;
  operationKey: string;
  tripId: string;
  kind: string;
  state: ModelOperationState;
  owner: string;
  attempt: number;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  result: unknown;
  failureKind: string | null;
  detail: string | null;
  usage: ModelOperationUsage;
}

interface OperationRow {
  id: string;
  operation_key: string;
  trip_id: string;
  kind: string;
  state: string;
  owner: string;
  attempt: number;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  result_json: string | null;
  failure_kind: string | null;
  detail: string | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
}

const SELECT_COLUMNS = `id, operation_key, trip_id, kind, state, owner, attempt, started_at,
   heartbeat_at, finished_at, result_json, failure_kind, detail, calls,
   input_tokens, output_tokens, cost_micro_usd`;

function toOperation(row: OperationRow): ModelOperation {
  let result: unknown = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch {
      // An unreadable payload is an absent one. The row still records that the
      // attempt happened and what it cost, which is the part that must not be
      // lost; the answer itself is recoverable by asking again.
      result = null;
    }
  }
  return {
    id: row.id,
    operationKey: row.operation_key,
    tripId: row.trip_id,
    kind: row.kind,
    state: (MODEL_OPERATION_STATES as readonly string[]).includes(row.state)
      ? (row.state as ModelOperationState)
      : 'failed_terminal',
    owner: row.owner,
    attempt: row.attempt,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    result,
    failureKind: row.failure_kind,
    detail: row.detail,
    usage: {
      calls: row.calls,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costMicroUsd: row.cost_micro_usd,
    },
  };
}

/**
 * The operation's identity: everything that could change the answer, plus the trip.
 *
 * The trip is in the key and not merely in a column, because the key is what the
 * unique index and the wait loop match on. Without it, one traveller's holder
 * would make a second traveller a loser on their own sentence — the exact
 * cross-traveller bleed the interpretation cache is trip-scoped to prevent.
 */
export function operationKeyFor(input: { tripId: string; kind: string; cacheKey: string }): string {
  return `${input.tripId}|${input.kind}|${input.cacheKey}`;
}

export type ClaimOutcome =
  /** This claimant holds the lease and is the only one that may call. */
  | { kind: 'won'; operation: ModelOperation }
  /** Somebody else holds it. Wait on them; do not call. */
  | { kind: 'lost'; operation: ModelOperation }
  /** It is already answered, or already failed for good. Replay; do not call. */
  | { kind: 'settled'; operation: ModelOperation }
  /** Every permitted attempt has been used. Do not call. */
  | { kind: 'exhausted'; operation: ModelOperation | null };

/**
 * Claim the lease, or find out who has it. One synchronous transaction.
 *
 * There is deliberately no `await` anywhere in this function, and there must
 * never be one: the whole guarantee is that expiry, inspection and insertion
 * happen with no interleaving point between them. The `INSERT` is still wrapped
 * in a `try`, because a *different process* can win the index between this
 * transaction and its commit, and losing that race is a normal outcome rather
 * than an error.
 */
export function claimModelOperation(input: {
  tripId: string;
  kind: string;
  cacheKey: string;
  owner: string;
  now: Date;
  leaseMs?: number;
  maxAttempts?: number;
}): ClaimOutcome {
  const db = getDb();
  const operationKey = operationKeyFor(input);
  const leaseMs = input.leaseMs ?? MODEL_OPERATION_LEASE_MS;
  const maxAttempts = input.maxAttempts ?? MODEL_OPERATION_MAX_ATTEMPTS;
  const nowIso = input.now.toISOString();
  const staleBefore = new Date(input.now.getTime() - leaseMs).toISOString();
  const placeholders = ACTIVE_STATES.map(() => '?').join(',');

  const claim = db.transaction((): ClaimOutcome => {
    // 1. A holder that stopped breathing releases its lease, and the release is
    //    recorded as an attempt that failed rather than as an attempt that never
    //    happened — otherwise a crash loop would be invisible and unbounded.
    db.prepare(
      `UPDATE model_operations
          SET state = 'failed_retryable', failure_kind = 'lease_expired',
              finished_at = ?, detail = 'The holder stopped reporting before it finished.'
        WHERE operation_key = ? AND state IN (${placeholders}) AND heartbeat_at <= ?`,
    ).run(nowIso, operationKey, ...ACTIVE_STATES, staleBefore);

    // 2. Somebody is holding it right now.
    const active = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM model_operations
          WHERE operation_key = ? AND state IN (${placeholders})
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(operationKey, ...ACTIVE_STATES) as OperationRow | undefined;
    if (active) return { kind: 'lost', operation: toOperation(active) };

    // 3. It is already answered, or already failed in a way nobody retries.
    //    Checked before the attempt count so a terminal failure closes the
    //    identity even with attempts to spare: a render that re-asked a provider
    //    which just returned nonsense would spend money on every paint.
    const settled = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM model_operations
          WHERE operation_key = ? AND state IN ('succeeded','failed_terminal')
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(operationKey) as OperationRow | undefined;
    if (settled) return { kind: 'settled', operation: toOperation(settled) };

    // 4. Bounded retry. Every row for this identity counts, whoever wrote it.
    const priorRow = db
      .prepare('SELECT COUNT(*) AS total FROM model_operations WHERE operation_key = ?')
      .get(operationKey) as { total: number };
    const prior = Number(priorRow?.total ?? 0);
    if (prior >= maxAttempts) {
      const last = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM model_operations
            WHERE operation_key = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .get(operationKey) as OperationRow | undefined;
      return { kind: 'exhausted', operation: last ? toOperation(last) : null };
    }

    // 5. The claim itself. The unique partial index is what makes this the only
    //    winner; the code above is what makes losing informative.
    const id = `op:${input.now.getTime().toString(36)}:${input.owner}:${prior + 1}`;
    db.prepare(
      `INSERT INTO model_operations
         (id, operation_key, trip_id, kind, state, owner, attempt, started_at, heartbeat_at)
       VALUES (?,?,?,?,'running',?,?,?,?)`,
    ).run(id, operationKey, input.tripId, input.kind, input.owner, prior + 1, nowIso, nowIso);

    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM model_operations WHERE id = ?`)
      .get(id) as OperationRow;
    return { kind: 'won', operation: toOperation(row) };
  });

  try {
    return claim();
  } catch (error) {
    /*
     * Another process won the index. That is not a failure; it is the answer.
     * Re-read and report it as a loss rather than throwing at a traveller who
     * did nothing wrong.
     */
    const active = db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM model_operations
          WHERE operation_key = ? AND state IN (${placeholders})
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(operationKey, ...ACTIVE_STATES) as OperationRow | undefined;
    if (active) return { kind: 'lost', operation: toOperation(active) };
    console.error('Could not claim a model operation', { operationKey, error });
    return { kind: 'exhausted', operation: null };
  }
}

/** Still alive. Returns false once the row is no longer the caller's to hold. */
export function heartbeatModelOperation(id: string, now: Date): boolean {
  const result = getDb()
    .prepare(
      `UPDATE model_operations SET heartbeat_at = ?
        WHERE id = ? AND state IN ('pending','running')`,
    )
    .run(now.toISOString(), id);
  return Number(result.changes ?? 0) > 0;
}

/**
 * End the operation, recording what it cost whichever way it ended.
 *
 * `usage` is written on every terminal state, including the failures. A provider
 * that took the request, burned the tokens and returned an unusable answer has
 * spent real money, and a ledger that only counts successes is wrong in exactly
 * the situation where somebody is looking at it.
 *
 * A row that has already ended is **not** rewritten. The case that matters is
 * `superseded`: the traveller changed the text while a holder was in flight, and
 * a holder that then reported success would turn a reading of a deleted sentence
 * back into a live answer that a later claimant could replay. The returned row
 * is whatever the store actually holds, so a caller can see it did not land.
 */
export function settleModelOperation(input: {
  id: string;
  state: Exclude<ModelOperationState, 'pending' | 'running'>;
  now: Date;
  result?: unknown;
  failureKind?: string;
  detail?: string;
  usage?: Partial<ModelOperationUsage>;
}): ModelOperation | null {
  const db = getDb();
  const usage = {
    calls: input.usage?.calls ?? 0,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    costMicroUsd: input.usage?.costMicroUsd ?? 0,
  };
  db.prepare(
    `UPDATE model_operations
        SET state = ?, finished_at = ?, heartbeat_at = ?, result_json = ?,
            failure_kind = ?, detail = ?, calls = ?, input_tokens = ?,
            output_tokens = ?, cost_micro_usd = ?
      WHERE id = ? AND state IN ('pending','running')`,
  ).run(
    input.state,
    input.now.toISOString(),
    input.now.toISOString(),
    input.result === undefined ? null : JSON.stringify(input.result),
    input.failureKind ?? null,
    input.detail ?? null,
    usage.calls,
    usage.inputTokens,
    usage.outputTokens,
    usage.costMicroUsd,
    input.id,
  );
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM model_operations WHERE id = ?`)
    .get(input.id) as OperationRow | undefined;
  return row ? toOperation(row) : null;
}

/** The latest row for an identity, whatever state it is in. */
export function latestModelOperation(input: {
  tripId: string;
  kind: string;
  cacheKey: string;
}): ModelOperation | null {
  const row = getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM model_operations
        WHERE operation_key = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(operationKeyFor(input)) as OperationRow | undefined;
  return row ? toOperation(row) : null;
}

/**
 * Everything the trip is still holding for a kind, other than one identity.
 *
 * Called when the text changes: the holder is now working on a sentence that no
 * longer exists, and its answer must never be applied to the new one. Marking it
 * `superseded` rather than deleting it keeps the attempt — and its cost — on the
 * record.
 */
export function supersedeModelOperations(input: {
  tripId: string;
  kind: string;
  keepCacheKey: string;
  now: Date;
}): number {
  const keep = operationKeyFor({
    tripId: input.tripId,
    kind: input.kind,
    cacheKey: input.keepCacheKey,
  });
  const result = getDb()
    .prepare(
      `UPDATE model_operations
          SET state = 'superseded', finished_at = ?,
              detail = 'The traveller changed the text while this was running.'
        WHERE trip_id = ? AND kind = ? AND operation_key <> ?
          AND state IN ('pending','running')`,
    )
    .run(input.now.toISOString(), input.tripId, input.kind, keep);
  return Number(result.changes ?? 0);
}

/**
 * Wait for the holder to finish, for a bounded time, without calling anything.
 *
 * Polling rather than a notification because better-sqlite3 has no listener and
 * a loser has nothing useful to do meanwhile. The `await` in the loop is the
 * point: it yields the event loop so the holder's own `await` can resolve, which
 * is what makes a same-process loser actually observe the winner's result rather
 * than deadlocking behind it.
 *
 * Returns whatever the row says when the clock runs out. A caller must treat a
 * still-active row as "no answer yet" and say so, rather than calling.
 */
export async function awaitModelOperation(input: {
  tripId: string;
  kind: string;
  cacheKey: string;
  timeoutMs: number;
  pollMs?: number;
  clock?: () => number;
}): Promise<ModelOperation | null> {
  const pollMs = input.pollMs ?? 25;
  const clock = input.clock ?? (() => Date.now());
  const deadline = clock() + Math.max(0, input.timeoutMs);

  for (;;) {
    const operation = latestModelOperation(input);
    if (!operation) return null;
    if (!ACTIVE_STATES.includes(operation.state)) return operation;
    if (clock() >= deadline) return operation;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
