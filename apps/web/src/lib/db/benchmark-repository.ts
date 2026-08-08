import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  type BenchmarkPlan,
  type BenchmarkQuestion,
  type BenchmarkTripRequest,
  type BlindAssignment,
  type ProducingSystem,
  type SessionState,
  benchmarkPlanSchema,
  benchmarkQuestionSchema,
  benchmarkTripRequestSchema,
  blindAssignmentSchema,
  planFingerprint,
  stableHash,
} from '@sidequest/bench';
import { getDb } from './client';

/**
 * SESSIONS, RUNS, PLANS — THE APPEND-ONLY HALF OF THE BENCHMARK STORE.
 *
 * Every write here either inserts a row or moves one named lifecycle column.
 * Nothing rewrites a plan, a question's payload, or a recorded answer, because
 * an experiment whose earlier results can be edited afterwards is not evidence.
 *
 * The concurrency posture is the one the rest of this directory already uses:
 * the database decides, not the application. A duplicate start is refused by a
 * unique index rather than by a disabled button, and losing that race is a
 * normal outcome that gets reported rather than thrown.
 */

export const BENCHMARK_VERSION = 'phase-13/2026-08-06.1';

export interface BenchmarkSession {
  id: string;
  caseId: string | null;
  benchmarkVersion: string;
  tripId: string | null;
  request: BenchmarkTripRequest;
  inputHash: string;
  locale: string;
  state: SessionState;
  reviewLockedAt: string | null;
  revealedAt: string | null;
  /**
   * Whether paid operations were permitted when this comparison was started.
   *
   * The one honest basis for calling a session live. Inferring it from the spend
   * ledger dropped every session whose compilation was warm enough to make no
   * model call — a one-sided exclusion correlated with the outcome.
   */
  paidMode: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SessionStart =
  | { kind: 'created'; session: BenchmarkSession }
  | { kind: 'adopted'; session: BenchmarkSession };

interface SessionRow {
  id: string;
  case_id: string | null;
  benchmark_version: string;
  trip_id: string | null;
  request_json: string;
  input_hash: string;
  locale: string;
  state: string;
  review_locked_at: string | null;
  revealed_at: string | null;
  paid_mode: number;
  created_at: string;
  updated_at: string;
}

const SESSION_COLUMNS =
  'id, case_id, benchmark_version, trip_id, request_json, input_hash, locale, state, review_locked_at, revealed_at, paid_mode, created_at, updated_at';

function toSession(row: SessionRow): BenchmarkSession | null {
  const parsed = benchmarkTripRequestSchema.safeParse(JSON.parse(row.request_json));
  // Dropped rather than coerced, for the reason the rest of this directory
  // drops a payload it cannot parse: a session whose request was written under
  // a different contract is not comparable with one written under this one, and
  // silently repairing it would hide that.
  if (!parsed.success) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    benchmarkVersion: row.benchmark_version,
    tripId: row.trip_id,
    request: parsed.data,
    inputHash: row.input_hash,
    locale: row.locale,
    state: row.state as SessionState,
    reviewLockedAt: row.review_locked_at,
    revealedAt: row.revealed_at,
    paidMode: row.paid_mode === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Start a session, or adopt the one an earlier press of the same button made.
 *
 * `idempotencyKey` is caller-supplied and stable for one submission. A retried
 * POST — the browser's, or a double click — reaches the same key and gets the
 * same session back, rather than opening a second comparison against a request
 * the reviewer only made once.
 */
export function createBenchmarkSession(input: {
  request: BenchmarkTripRequest;
  idempotencyKey: string;
  caseId?: string;
  locale?: string;
  now: Date;
}): SessionStart {
  const db = getDb();
  const nowIso = input.now.toISOString();
  const inputHash = stableHash(input.request);
  const id = `bench:${randomUUID()}`;

  const insert = db.prepare(
    `INSERT INTO benchmark_sessions
       (id, schema_version, case_id, benchmark_version, trip_id, idempotency_key,
        request_version, request_json, input_hash, locale, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'created',?,?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  );
  const result = insert.run(
    id,
    1,
    input.caseId ?? null,
    BENCHMARK_VERSION,
    null,
    input.idempotencyKey,
    input.request.schemaVersion,
    JSON.stringify(input.request),
    inputHash,
    input.locale ?? 'en',
    nowIso,
    nowIso,
  );

  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM benchmark_sessions WHERE idempotency_key = ?`)
    .get(input.idempotencyKey) as SessionRow | undefined;
  if (!row) throw new Error('The benchmark session vanished between writing and reading it.');
  const session = toSession(row);
  if (!session) throw new Error('The benchmark session was written in an unreadable shape.');

  return Number(result.changes ?? 0) > 0
    ? { kind: 'created', session }
    : { kind: 'adopted', session };
}

export function getBenchmarkSession(sessionId: string): BenchmarkSession | null {
  const row = getDb()
    .prepare(`SELECT ${SESSION_COLUMNS} FROM benchmark_sessions WHERE id = ?`)
    .get(sessionId) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function listBenchmarkSessions(limit = 100): BenchmarkSession[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM benchmark_sessions
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as SessionRow[];
  return rows.map(toSession).filter((session): session is BenchmarkSession => session !== null);
}

/**
 * Move the session's state, but only from where the caller thinks it is.
 *
 * The `expected` clause is the whole point. Two tabs both pressing "run" would
 * otherwise both succeed, and the second would restart a comparison the first
 * had already begun.
 *
 * The heartbeat moves with it. See `reclaimStalledSession` for why a lock with
 * no way to release it is a trap rather than a lock.
 */
export function advanceSessionState(input: {
  sessionId: string;
  from: SessionState;
  to: SessionState;
  now: Date;
  /** Who is holding it, for the states that are held rather than passed through. */
  owner?: string;
}): boolean {
  const nowIso = input.now.toISOString();
  const result = getDb()
    .prepare(
      `UPDATE benchmark_sessions
          SET state = ?, updated_at = ?, state_owner = ?, state_heartbeat_at = ?
        WHERE id = ? AND state = ?`,
    )
    .run(input.to, nowIso, input.owner ?? '', nowIso, input.sessionId, input.from);
  return Number(result.changes ?? 0) > 0;
}

/**
 * How long an in-flight state may go without a pulse before anybody may take it.
 *
 * Generous, because the two states it guards are genuinely long: buying a
 * region's places, routes, hours and forecast runs to minutes, and a compilation
 * runs longer. What it bounds is the case where nobody is working on it at all.
 */
export const SESSION_LEASE_MS = 20 * 60_000;

/** Say the holder is still alive. Cheap, and safe to call on a poll. */
export function heartbeatSession(sessionId: string, now: Date): void {
  getDb()
    .prepare(
      `UPDATE benchmark_sessions SET state_heartbeat_at = ?
        WHERE id = ? AND state IN ('preparing','running')`,
    )
    .run(now.toISOString(), sessionId);
}

/**
 * A LOCK WITH NO RELEASE IS A TRAP.
 *
 * `preparing` and `running` are entered by a compare-and-set and were left only
 * by the same invocation — which runs inside `after()`, and Next makes no promise
 * about that surviving a process restart. So a hot reload, a recycled container
 * or an OOM during the world purchase left the session in a state nothing could
 * move it out of: the first press refuses because the state is not `created`, the
 * second because it is not `awaiting_answers`, the orchestrator's claim because
 * it is neither, and both run rows sit at `running` for ever. The world had
 * already been bought and paid for.
 *
 * Every other durable claim in this schema has a heartbeat for exactly this
 * reason. This gives the two session states the same treatment: a claim whose
 * pulse has stopped for longer than the lease is returned to the state it was
 * claimed from, and the next press picks it up.
 *
 * Returns whether anything was reclaimed, so a caller can say so rather than
 * silently appearing to work.
 */
export function reclaimStalledSession(sessionId: string, now: Date): boolean {
  const staleBefore = new Date(now.getTime() - SESSION_LEASE_MS).toISOString();
  const result = getDb()
    .prepare(
      `UPDATE benchmark_sessions
          SET state = CASE state
                        WHEN 'preparing' THEN 'created'
                        WHEN 'running' THEN 'awaiting_answers'
                        ELSE state
                      END,
              state_owner = '',
              state_heartbeat_at = ?,
              updated_at = ?
        WHERE id = ?
          AND state IN ('preparing','running')
          AND state_heartbeat_at != ''
          AND state_heartbeat_at <= ?`,
    )
    .run(now.toISOString(), now.toISOString(), sessionId, staleBefore);
  return Number(result.changes ?? 0) > 0;
}

/**
 * Record that this comparison was started with paid operations permitted.
 *
 * Written once, at the press, from the switches in force at that moment — not
 * inferred afterwards from whether any money happened to be spent. Set-once, so
 * a later run under different switches cannot rewrite what an earlier one was.
 */
export function markSessionPaidMode(sessionId: string, now: Date): void {
  getDb()
    .prepare(
      `UPDATE benchmark_sessions SET paid_mode = 1, updated_at = ?
        WHERE id = ? AND paid_mode = 0`,
    )
    .run(now.toISOString(), sessionId);
}

export function attachTripToSession(sessionId: string, tripId: string, now: Date): void {
  getDb()
    .prepare(
      `UPDATE benchmark_sessions SET trip_id = ?, updated_at = ?
        WHERE id = ? AND trip_id IS NULL`,
    )
    .run(tripId, now.toISOString(), sessionId);
}

/* ------------------------------------------------------------------ *
 * Assignment
 * ------------------------------------------------------------------ */

/** Written once, with the session. A second call changes nothing. */
export function saveAssignment(sessionId: string, assignment: BlindAssignment): void {
  getDb()
    .prepare(
      `INSERT INTO benchmark_assignments
         (session_id, schema_version, label_a_system, label_b_system, first_label,
          source, seed, draw_label, draw_order, assigned_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(
      sessionId,
      assignment.schemaVersion,
      assignment.labelASystem,
      assignment.labelBSystem,
      assignment.firstLabel,
      assignment.source,
      assignment.seed,
      assignment.drawLabel,
      assignment.drawOrder,
      assignment.assignedAt,
    );
}

export function getAssignment(sessionId: string): BlindAssignment | null {
  const row = getDb()
    .prepare(
      `SELECT schema_version, label_a_system, label_b_system, first_label, source,
              seed, draw_label, draw_order, assigned_at
         FROM benchmark_assignments WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        schema_version: number;
        label_a_system: string;
        label_b_system: string;
        first_label: string;
        source: string;
        seed: string | null;
        draw_label: number;
        draw_order: number;
        assigned_at: string;
      }
    | undefined;
  if (!row) return null;

  const parsed = blindAssignmentSchema.safeParse({
    schemaVersion: row.schema_version,
    labelASystem: row.label_a_system,
    labelBSystem: row.label_b_system,
    firstLabel: row.first_label,
    source: row.source,
    seed: row.seed,
    drawLabel: row.draw_label,
    drawOrder: row.draw_order,
    assignedAt: row.assigned_at,
  });
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export type RunState = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface BenchmarkRun {
  id: string;
  sessionId: string;
  arm: ProducingSystem;
  promptVersion: string | null;
  model: string | null;
  state: RunState;
  failureKind: string | null;
  failureDetail: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Cold, warm, mixed or unknown, as the run itself observed it.
   *
   * `null` until the metric writer has run. Kept on the run rather than in the
   * metric table because that table holds one row per `Measurement` and this is a
   * classification: it had nowhere to go there, was dropped on write, and every
   * latency figure pooled first runs with repeats as a result.
   */
  warmth: string | null;
  warmthBasis: string | null;
}

interface RunRow {
  id: string;
  session_id: string;
  arm: string;
  prompt_version: string | null;
  model: string | null;
  state: string;
  failure_kind: string | null;
  failure_detail: string | null;
  started_at: string;
  finished_at: string | null;
  warmth: string | null;
  warmth_basis: string | null;
}

const RUN_COLUMNS =
  'id, session_id, arm, prompt_version, model, state, failure_kind, failure_detail, started_at, finished_at, warmth, warmth_basis';

function toRun(row: RunRow): BenchmarkRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    arm: row.arm as ProducingSystem,
    promptVersion: row.prompt_version,
    model: row.model,
    state: row.state as RunState,
    failureKind: row.failure_kind,
    failureDetail: row.failure_detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    warmth: row.warmth,
    warmthBasis: row.warmth_basis,
  };
}

/**
 * The warmth verdict, written beside the run it describes.
 *
 * Separate from `settleRun` because the two are written at different moments and
 * by different callers: a run settles when it stops, and its metric set — warmth
 * included — is computed afterwards, by the harness, from what the run left
 * behind. Idempotent, and it never overwrites an observation with an absence: a
 * later recomputation that could not read the classification must not erase one
 * that could.
 */
export function saveRunWarmth(input: {
  runId: string;
  warmth: string;
  basis: string;
}): void {
  getDb()
    .prepare(
      `UPDATE benchmark_runs SET warmth = ?, warmth_basis = ?
        WHERE id = ? AND (warmth IS NULL OR warmth = 'unknown' OR ? != 'unknown')`,
    )
    .run(input.warmth, input.basis, input.runId, input.warmth);
}

/**
 * One run per arm per session, enforced by the index.
 *
 * Adopt-not-error on a second call, so a retry that lost the race gets the row
 * it was going to create rather than an exception a reviewer did nothing to
 * deserve.
 */
export function startRun(input: {
  sessionId: string;
  arm: ProducingSystem;
  now: Date;
}): BenchmarkRun {
  const db = getDb();
  const id = `run:${input.arm}:${randomUUID()}`;
  db.prepare(
    `INSERT INTO benchmark_runs
       (id, session_id, arm, schema_version, state, started_at)
     VALUES (?,?,?,?,'running',?)
     ON CONFLICT(session_id, arm) DO NOTHING`,
  ).run(id, input.sessionId, input.arm, 1, input.now.toISOString());

  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE session_id = ? AND arm = ?`)
    .get(input.sessionId, input.arm) as RunRow | undefined;
  if (!row) throw new Error('The benchmark run vanished between writing and reading it.');
  return toRun(row);
}

export function settleRun(input: {
  runId: string;
  state: Exclude<RunState, 'pending' | 'running'>;
  failureKind?: string | null;
  failureDetail?: string | null;
  promptVersion?: string | null;
  model?: string | null;
  now: Date;
}): void {
  getDb()
    .prepare(
      `UPDATE benchmark_runs
          SET state = ?, failure_kind = ?, failure_detail = ?,
              prompt_version = COALESCE(?, prompt_version),
              model = COALESCE(?, model),
              finished_at = ?
        WHERE id = ? AND state IN ('pending','running')`,
    )
    .run(
      input.state,
      input.failureKind ?? null,
      input.failureDetail ?? null,
      input.promptVersion ?? null,
      input.model ?? null,
      input.now.toISOString(),
      input.runId,
    );
}

export function getRuns(sessionId: string): BenchmarkRun[] {
  const rows = getDb()
    .prepare(`SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE session_id = ? ORDER BY arm`)
    .all(sessionId) as RunRow[];
  return rows.map(toRun);
}

export function getRunForArm(sessionId: string, arm: ProducingSystem): BenchmarkRun | null {
  const row = getDb()
    .prepare(`SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE session_id = ? AND arm = ?`)
    .get(sessionId, arm) as RunRow | undefined;
  return row ? toRun(row) : null;
}

/* ------------------------------------------------------------------ *
 * Plans
 * ------------------------------------------------------------------ */

export interface StoredPlan {
  id: string;
  sessionId: string;
  runId: string;
  planVersion: number;
  supersedesPlanId: string | null;
  contentHash: string;
  fingerprint: string;
  plan: BenchmarkPlan;
  createdAt: string;
}

interface PlanRow {
  id: string;
  session_id: string;
  run_id: string;
  plan_version: number;
  supersedes_plan_id: string | null;
  content_hash: string;
  fingerprint: string;
  payload_json: string;
  created_at: string;
}

const PLAN_COLUMNS =
  'id, session_id, run_id, plan_version, supersedes_plan_id, content_hash, fingerprint, payload_json, created_at';

function toStoredPlan(row: PlanRow): StoredPlan | null {
  const parsed = benchmarkPlanSchema.safeParse(JSON.parse(row.payload_json));
  if (!parsed.success) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    planVersion: row.plan_version,
    supersedesPlanId: row.supersedes_plan_id,
    contentHash: row.content_hash,
    fingerprint: row.fingerprint,
    plan: parsed.data,
    createdAt: row.created_at,
  };
}

/**
 * Insert a plan at the next version for its run.
 *
 * `expectedSupersedes` is the stale-write guard for correction rounds: a round
 * that began against version 2 may only land while version 2 is still the head.
 * A reviewer who submitted two corrections quickly, or two tabs racing, would
 * otherwise silently lose one and be shown the other as though nothing had
 * happened. `null` means "this is the first plan for this run".
 *
 * The whole read-then-insert sits in one transaction, so the version it reads
 * is the version it writes against.
 */
export function insertPlan(input: {
  sessionId: string;
  runId: string;
  plan: BenchmarkPlan;
  expectedSupersedesPlanId: string | null;
  now: Date;
}): { kind: 'inserted'; stored: StoredPlan } | { kind: 'stale'; head: StoredPlan | null } {
  const db = getDb();

  const write = db.transaction(():
    | { kind: 'inserted'; stored: StoredPlan }
    | { kind: 'stale'; head: StoredPlan | null } => {
    const headRow = db
      .prepare(
        `SELECT ${PLAN_COLUMNS} FROM benchmark_plans
          WHERE run_id = ? ORDER BY plan_version DESC LIMIT 1`,
      )
      .get(input.runId) as PlanRow | undefined;
    const head = headRow ? toStoredPlan(headRow) : null;

    if ((head?.id ?? null) !== input.expectedSupersedesPlanId) {
      return { kind: 'stale', head };
    }

    const nextVersion = (head?.planVersion ?? 0) + 1;
    const payload = JSON.stringify(input.plan);
    const id = `plan:${input.runId}:v${nextVersion}`;
    db.prepare(
      `INSERT INTO benchmark_plans
         (id, session_id, run_id, plan_version, supersedes_plan_id, schema_version,
          content_hash, fingerprint, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      input.sessionId,
      input.runId,
      nextVersion,
      head?.id ?? null,
      input.plan.schemaVersion,
      stableHash(input.plan),
      planFingerprint(input.plan),
      payload,
      input.now.toISOString(),
    );

    const row = db
      .prepare(`SELECT ${PLAN_COLUMNS} FROM benchmark_plans WHERE id = ?`)
      .get(id) as PlanRow;
    const stored = toStoredPlan(row);
    if (!stored) throw new Error('A benchmark plan was written in an unreadable shape.');
    return { kind: 'inserted', stored };
  });

  return write();
}

export function headPlanForRun(runId: string): StoredPlan | null {
  const row = getDb()
    .prepare(
      `SELECT ${PLAN_COLUMNS} FROM benchmark_plans
        WHERE run_id = ? ORDER BY plan_version DESC LIMIT 1`,
    )
    .get(runId) as PlanRow | undefined;
  return row ? toStoredPlan(row) : null;
}

export function planVersionsForRun(runId: string): StoredPlan[] {
  const rows = getDb()
    .prepare(`SELECT ${PLAN_COLUMNS} FROM benchmark_plans WHERE run_id = ? ORDER BY plan_version`)
    .all(runId) as PlanRow[];
  return rows.map(toStoredPlan).filter((plan): plan is StoredPlan => plan !== null);
}

export function getPlan(planId: string): StoredPlan | null {
  const row = getDb()
    .prepare(`SELECT ${PLAN_COLUMNS} FROM benchmark_plans WHERE id = ?`)
    .get(planId) as PlanRow | undefined;
  return row ? toStoredPlan(row) : null;
}

/* ------------------------------------------------------------------ *
 * Native artifacts
 * ------------------------------------------------------------------ */

/**
 * What a system produced in its own idiom.
 *
 * Kept because the neutral conversion is lossy by design and somebody will
 * eventually want to know whether a defect was in the plan or in the conversion.
 * Never rendered before the reveal — the shape alone would identify the system.
 */
export function saveNativeArtifact(input: {
  runId: string;
  planId: string | null;
  kind: string;
  payload: unknown;
  now: Date;
}): void {
  const hash = stableHash(input.payload);
  getDb()
    .prepare(
      `INSERT INTO benchmark_native_artifacts
         (id, run_id, plan_id, kind, schema_version, content_hash, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id, kind, content_hash) DO NOTHING`,
    )
    .run(
      `native:${input.runId}:${input.kind}:${hash}`,
      input.runId,
      input.planId,
      input.kind,
      1,
      hash,
      JSON.stringify(input.payload),
      input.now.toISOString(),
    );
}

export function nativeArtifactsForRun(runId: string): { kind: string; payload: unknown }[] {
  const rows = getDb()
    .prepare(
      `SELECT kind, payload_json FROM benchmark_native_artifacts
        WHERE run_id = ? ORDER BY created_at`,
    )
    .all(runId) as { kind: string; payload_json: string }[];
  /*
   * A row that will not parse costs its own artifact, never the page.
   *
   * These are rendered on the post-reveal report. A bare `JSON.parse` on the way
   * out meant one malformed row — a truncated write, a schema that moved — would
   * throw through a server component and give the reviewer a neutral error where
   * their results should be. `getSharedWorld` already guards for the same reason.
   */
  return rows.flatMap((row) => {
    try {
      return [{ kind: row.kind, payload: JSON.parse(row.payload_json) as unknown }];
    } catch {
      return [];
    }
  });
}

/* ------------------------------------------------------------------ *
 * Questions
 * ------------------------------------------------------------------ */

export function saveQuestion(question: BenchmarkQuestion): void {
  getDb()
    .prepare(
      `INSERT INTO benchmark_questions
         (id, session_id, asked_by, stage, sequence, schema_version, payload_json,
          presented_at, answered_at, elapsed_ms, answer_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      question.questionId,
      question.sessionId,
      question.askedBy,
      question.stage,
      question.sequence,
      question.schemaVersion,
      JSON.stringify(question),
      question.presentedAt,
      question.answeredAt,
      question.elapsedMs,
      question.answerValues === null ? null : JSON.stringify(question.answerValues),
    );
}

/**
 * How much answer one question may carry.
 *
 * The shared schema bounds every field a system writes and none of the one a
 * browser supplies, which is the half that arrives from outside. Left unbounded,
 * an oversized reply is written into `payload_json` and then refused by the
 * schema on the way back out — and `listQuestions` drops a row it cannot parse,
 * so the question would vanish from the pooled list and from the counts instead
 * of announcing itself. Bounded here rather than in the shared schema because
 * this is the only door the value comes through, and widening the schema would
 * relax it for every system that already writes within it.
 */
export const MAX_ANSWER_VALUES = 32;
export const MAX_ANSWER_VALUE_LENGTH = 500;

/**
 * Record an answer, once, and only while the review is still open.
 *
 * `answered_at IS NULL` in the guard makes the first answer the one that counts.
 * A resubmitted form changes no rows, which keeps the elapsed time honest — a
 * second press would otherwise overwrite the real thinking time with nearly
 * zero.
 *
 * The `EXISTS` clause is the second guard and it is here rather than in the
 * caller for the reason every other guard in this directory is: `elapsed_ms` is
 * a reported metric, and a locked review whose questions could still be answered
 * would let a number that has already been published quietly change afterwards.
 * A disabled control does not stop a second tab.
 *
 * The row is rebuilt and re-parsed before it is written, so nothing lands in
 * `payload_json` that cannot be read back. A write that produces an unreadable
 * row is worse than a refused one: the refusal is visible and the unreadable row
 * is silently filtered out of every later read.
 */
export function answerQuestion(input: {
  sessionId: string;
  questionId: string;
  values: string[];
  answeredFrom: 'shared_request' | 'traveller';
  elapsedMs: number;
  transferredTo?: ProducingSystem | null;
  now: Date;
}): boolean {
  if (input.values.length > MAX_ANSWER_VALUES) return false;
  if (input.values.some((value) => value.length > MAX_ANSWER_VALUE_LENGTH)) return false;

  const db = getDb();
  const row = db
    .prepare('SELECT payload_json FROM benchmark_questions WHERE session_id = ? AND id = ?')
    .get(input.sessionId, input.questionId) as { payload_json: string } | undefined;
  if (!row) return false;

  const parsed = benchmarkQuestionSchema.safeParse(JSON.parse(row.payload_json));
  if (!parsed.success) return false;

  const rewritten = benchmarkQuestionSchema.safeParse({
    ...parsed.data,
    answeredAt: input.now.toISOString(),
    elapsedMs: input.elapsedMs,
    answerValues: input.values,
    answeredFrom: input.answeredFrom,
    transferredTo: input.transferredTo ?? null,
  } satisfies BenchmarkQuestion);
  if (!rewritten.success) return false;
  const updated = rewritten.data;

  const result = db
    .prepare(
      `UPDATE benchmark_questions
          SET answered_at = ?, elapsed_ms = ?, answer_json = ?, payload_json = ?
        WHERE session_id = ? AND id = ? AND answered_at IS NULL
          AND EXISTS (
            SELECT 1 FROM benchmark_sessions s
             WHERE s.id = benchmark_questions.session_id
               AND s.review_locked_at IS NULL
               /*
                * And only while the question round is still open.
                *
                * Once the traveller has asked for the plans, an answer arriving
                * afterwards cannot reach either planner — but it would still be
                * written, and the record would then show a question answered
                * before a plan that was built without it. That is worse than a
                * refusal: it is a false account of what each system was told.
                */
               AND s.state IN ('created','preparing','awaiting_answers')
          )`,
    )
    .run(
      updated.answeredAt,
      updated.elapsedMs,
      JSON.stringify(updated.answerValues),
      JSON.stringify(updated),
      input.sessionId,
      input.questionId,
    );
  return Number(result.changes ?? 0) > 0;
}

export function listQuestions(sessionId: string): BenchmarkQuestion[] {
  const rows = getDb()
    .prepare(
      'SELECT payload_json FROM benchmark_questions WHERE session_id = ? ORDER BY sequence, id',
    )
    .all(sessionId) as { payload_json: string }[];
  return rows
    .map((row) => benchmarkQuestionSchema.safeParse(JSON.parse(row.payload_json)))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
}

/* ------------------------------------------------------------------ *
 * The shared world
 * ------------------------------------------------------------------ */

export interface StoredSharedWorld {
  payload: unknown;
  preparationMs: number;
  contentHash: string;
  gatheredAt: string;
}

/**
 * The world both arms plan against, written once and never rewritten.
 *
 * `DO NOTHING` on conflict rather than an upsert, and that is the whole point:
 * the follow-up questions the traveller is answering were derived from this
 * world, so replacing it between the question and the answer would mean the
 * plans were built against facts the questions did not come from. A second
 * preparation of the same session adopts the first world rather than buying
 * another.
 */
export function saveSharedWorld(input: {
  sessionId: string;
  payload: unknown;
  preparationMs: number;
  now: Date;
}): void {
  getDb()
    .prepare(
      `INSERT INTO benchmark_shared_worlds
         (session_id, schema_version, content_hash, preparation_ms, payload_json, gathered_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(
      input.sessionId,
      1,
      stableHash(input.payload),
      Math.max(0, Math.round(input.preparationMs)),
      JSON.stringify(input.payload),
      input.now.toISOString(),
    );
}

export function getSharedWorld(sessionId: string): StoredSharedWorld | null {
  const row = getDb()
    .prepare(
      `SELECT content_hash, preparation_ms, payload_json, gathered_at
         FROM benchmark_shared_worlds WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        content_hash: string;
        preparation_ms: number;
        payload_json: string;
        gathered_at: string;
      }
    | undefined;
  if (!row) return null;
  try {
    return {
      payload: JSON.parse(row.payload_json),
      preparationMs: row.preparation_ms,
      contentHash: row.content_hash,
      gatheredAt: row.gathered_at,
    };
  } catch {
    // A world that will not parse is a world nobody has. Returning null sends
    // the caller down the "no world" path it already handles, rather than
    // throwing through a session that could still record two failed arms.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The session clock
 * ------------------------------------------------------------------ */

export interface SessionClock {
  startedAt: string;
  questionsReadyAt: string | null;
  answersClosedAt: string | null;
  finishedAt: string | null;
}

/**
 * Open the session clock, once.
 *
 * This is `t0` for every session-level latency figure, and it is stamped at the
 * press rather than when the first arm starts — because the shared preparation
 * and the question round both happen before either arm exists, and a clock that
 * started after them would report a wait shorter than the one somebody actually
 * sat through.
 */
export function openSessionClock(sessionId: string, now: Date): void {
  getDb()
    .prepare(
      `INSERT INTO benchmark_session_clock (session_id, started_at)
       VALUES (?,?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(sessionId, now.toISOString());
}

/**
 * Move one of the clock's three later stamps, first-write-wins.
 *
 * Three literal statements rather than one with the column interpolated. The
 * interpolated version worked and was worse in two ways at once: no argument
 * could reach the column name, but nothing said so at the call site — and the
 * architecture test that reads this directory's SQL to check the schema's own
 * MUTABLE markers could not see the columns at all, so three genuinely mutable
 * columns read as never written.
 */
const CLOCK_STAMPS = {
  questionsReadyAt: `UPDATE benchmark_session_clock SET questions_ready_at = ?
                      WHERE session_id = ? AND questions_ready_at IS NULL`,
  answersClosedAt: `UPDATE benchmark_session_clock SET answers_closed_at = ?
                     WHERE session_id = ? AND answers_closed_at IS NULL`,
  finishedAt: `UPDATE benchmark_session_clock SET finished_at = ?
                WHERE session_id = ? AND finished_at IS NULL`,
} as const;

export function stampSessionClock(
  sessionId: string,
  stamp: keyof typeof CLOCK_STAMPS,
  now: Date,
): void {
  getDb().prepare(CLOCK_STAMPS[stamp]).run(now.toISOString(), sessionId);
}

export function getSessionClock(sessionId: string): SessionClock | null {
  const row = getDb()
    .prepare(
      `SELECT started_at, questions_ready_at, answers_closed_at, finished_at
         FROM benchmark_session_clock WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        started_at: string;
        questions_ready_at: string | null;
        answers_closed_at: string | null;
        finished_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    startedAt: row.started_at,
    questionsReadyAt: row.questions_ready_at,
    answersClosedAt: row.answers_closed_at,
    finishedAt: row.finished_at,
  };
}
