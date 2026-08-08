import 'server-only';
import {
  type BenchReport,
  type BlindReview,
  type CorrectionRound,
  type Measurement,
  type PostRevealAnswers,
  type ProducingSystem,
  type RunMetrics,
  MAX_CORRECTION_ROUNDS,
  benchReportSchema,
  blindReviewSchema,
  correctionRoundSchema,
  measurementSchema,
  type MetricKey,
  postRevealAnswersSchema,
  stableHash,
  timingViolations,
  unitIsCanonical,
} from '@sidequest/bench';
import { getDb } from './client';
import { saveRunWarmth } from './benchmark-repository';

/**
 * REVIEW, REVEAL, CORRECTIONS, METRICS, AND SPEND.
 *
 * The half of the benchmark store where the experiment's integrity actually
 * lives. Three guarantees, each enforced by a `WHERE` clause rather than by an
 * application check, because a disabled button and an `if` statement are both
 * walked past by a second tab and a direct POST:
 *
 * - a review locks, and a locked review cannot be edited — nor can a correction
 *   round begin afterwards, which would replace the very plan that was rated;
 * - a reveal happens once, and cannot be undone;
 * - a correction round that began against an older plan cannot land on a newer
 *   one, and the pair of arms takes a round together or not at all.
 *
 * And one guarantee enforced by the schema: a metric that was not measured is
 * stored as NULL with a reason, and the table's CHECK constraint makes the
 * alternative — a zero standing in for an absence — unrepresentable.
 */

/* ------------------------------------------------------------------ *
 * Validation results
 * ------------------------------------------------------------------ */

export function saveValidation(input: {
  sessionId: string;
  planId: string;
  report: BenchReport;
  now: Date;
}): void {
  getDb()
    .prepare(
      `INSERT INTO benchmark_validations
         (id, session_id, plan_id, schema_version, critical_count, major_count,
          minor_count, informational_count, unknown_count, attempted, decided,
          payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(plan_id) DO NOTHING`,
    )
    .run(
      `validation:${input.planId}`,
      input.sessionId,
      input.planId,
      input.report.schemaVersion,
      input.report.counts.critical,
      input.report.counts.major,
      input.report.counts.minor,
      input.report.counts.informational,
      input.report.counts.unknown,
      input.report.verifiability.attempted,
      input.report.verifiability.decided,
      JSON.stringify(input.report),
      input.now.toISOString(),
    );
}

export function getValidation(planId: string): BenchReport | null {
  const row = getDb()
    .prepare('SELECT payload_json FROM benchmark_validations WHERE plan_id = ?')
    .get(planId) as { payload_json: string } | undefined;
  if (!row) return null;
  const parsed = benchReportSchema.safeParse(JSON.parse(row.payload_json));
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/**
 * Write the whole metric set for a run.
 *
 * One row per metric rather than one JSON blob, because the results dashboard
 * aggregates across sessions and a blob would mean parsing every session to
 * average one number. And because the CHECK constraint that makes an absence
 * unrepresentable can only be written against columns.
 *
 * There is deliberately no `?? 0` anywhere in this function. That coalescence is
 * exactly how the equivalent ledger elsewhere in this schema lost the
 * distinction between "nothing was spent" and "nobody counted".
 *
 * Every value is parsed by the shared schema before it is bound, because the
 * type is a compile-time promise and this is a runtime boundary. A hand-built
 * `{ state: 'measured', value: NaN }` satisfies the type and satisfies a check on
 * the `state` field alone; SQLite then stores the NaN as NULL and the CHECK
 * rejects the whole write, taking the fifteen well-formed metrics beside it. A
 * value that will not parse is recorded as the absence it actually is, so one bad
 * instrument costs one metric rather than the run's entire metric set.
 */
export function saveRunMetrics(input: {
  sessionId: string;
  runId: string;
  metrics: RunMetrics;
  now: Date;
}): void {
  const db = getDb();
  const nowIso = input.now.toISOString();
  const insert = db.prepare(
    `INSERT INTO benchmark_metrics
       (session_id, run_id, metric_key, availability, value_num, unit,
        unavailable_reason, detail, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id, metric_key) DO UPDATE SET
       availability = excluded.availability,
       value_num = excluded.value_num,
       unit = excluded.unit,
       unavailable_reason = excluded.unavailable_reason,
       detail = excluded.detail,
       computed_at = excluded.computed_at`,
  );

  const write = db.transaction(() => {
    for (const [key, value] of Object.entries(input.metrics)) {
      const measurement = readMeasurement(key, value);
      if (measurement === null) continue;
      if (measurement.state === 'measured') {
        insert.run(input.sessionId, input.runId, key, 'measured', measurement.value, measurement.unit, null, null, nowIso);
      } else {
        insert.run(input.sessionId, input.runId, key, 'unavailable', null, null, measurement.reason, measurement.detail, nowIso);
      }
    }
  });
  write();

  /*
   * WARMTH IS NOT A MEASUREMENT, SO IT GOES SOMEWHERE ELSE — RATHER THAN NOWHERE.
   *
   * The loop above stores one row per `Measurement`, and warmth is a
   * classification with no number in it. It therefore matched nothing, was
   * skipped in silence, and never came back: the dashboard reported every run as
   * unknown warmth and pooled cold and warm latencies in the same averages —
   * losing the one covariate the pre-registered rules name as making a latency
   * comparison readable at all.
   *
   * It is written to its own column on the run, beside the sentence saying what
   * it was observed from.
   */
  saveRunWarmth({
    runId: input.runId,
    warmth: input.metrics.warmth,
    basis: input.metrics.warmthBasis,
  });

  /*
   * THE ORDERING CHECK, RUN WHERE THE NUMBERS ARE WRITTEN.
   *
   * `timingViolations` had no caller outside its own tests, so a clock that
   * disagreed with itself would have been recorded, aggregated and printed with
   * nothing anywhere noticing. A check nobody runs is a comment.
   *
   * A violation means the *instrument* is wrong, not that a system is slow, and
   * the two must never be confused in a report — so it is logged as an operator
   * fault rather than turned into a finding about a plan. The metrics still land:
   * losing a run's whole metric set over a disordered stamp would be a worse
   * trade than recording it with a loud line beside it.
   */
  const violations = timingViolations(input.metrics);
  if (violations.length > 0) {
    console.error('A benchmark run recorded an impossible clock', {
      runId: input.runId,
      violations,
    });
  }
}

/**
 * One metric, written on its own.
 *
 * For the three session-level figures, which are not the arm's to produce: the
 * arm writes its whole set when it stops, and the harness upserts the session
 * clock over the top once both arms have. Sharing the same insert, and the same
 * unit check, is what keeps the two writers from disagreeing about what a metric
 * row looks like.
 */
export function saveMetric(input: {
  sessionId: string;
  runId: string;
  /**
   * A key the unit table knows.
   *
   * Typed rather than `string`, because `canonicalUnitFor` answers `null` for an
   * unrecognised key and `unitIsCanonical` then waves it through — so a typo
   * would store an unchecked row under a name nothing reads, and both results
   * pages would print "Not measured" with nothing saying anything had gone
   * wrong.
   */
  key: MetricKey;
  measurement: Measurement;
  now: Date;
}): void {
  const checked = readMeasurement(input.key, input.measurement);
  if (checked === null) return;
  const nowIso = input.now.toISOString();
  const statement = getDb().prepare(
    `INSERT INTO benchmark_metrics
       (session_id, run_id, metric_key, availability, value_num, unit,
        unavailable_reason, detail, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id, metric_key) DO UPDATE SET
       availability = excluded.availability,
       value_num = excluded.value_num,
       unit = excluded.unit,
       unavailable_reason = excluded.unavailable_reason,
       detail = excluded.detail,
       computed_at = excluded.computed_at`,
  );
  if (checked.state === 'measured') {
    statement.run(input.sessionId, input.runId, input.key, 'measured', checked.value, checked.unit, null, null, nowIso);
  } else {
    statement.run(input.sessionId, input.runId, input.key, 'unavailable', null, null, checked.reason, checked.detail, nowIso);
  }
}

/**
 * The measurement, or the absence that describes why there is not one.
 *
 * Fields that were never measurements at all — `schemaVersion`, `runId`,
 * `warmth`, `warmthBasis` — have no shape the schema accepts and are skipped
 * with `null`. Anything that looks like a measurement and fails to parse is a
 * broken instrument, and saying so is the only honest thing left: dropping it
 * would leave a blank the dashboard renders identically to a metric nobody
 * thought to collect.
 *
 * The unit is checked against the shared table as well as the shape. Both arms
 * write into this one table, and the same quantity arriving labelled
 * `micro_usd` from one and `count` from the other is how a later reader
 * mis-scales a cost by a factor of a million. A mis-labelled value is recorded
 * as the instrument fault it is rather than stored with a label nobody can
 * trust.
 */
function readMeasurement(key: string, value: unknown): Measurement | null {
  if (typeof value !== 'object' || value === null) return null;
  const state = (value as { state?: unknown }).state;
  if (state !== 'measured' && state !== 'unavailable') return null;

  const parsed = measurementSchema.safeParse(value);
  if (!parsed.success) {
    return {
      state: 'unavailable',
      reason: 'instrument_failed',
      detail: 'The recorded measurement did not satisfy the shared measurement schema.',
    };
  }
  if (!unitIsCanonical(key, parsed.data)) {
    return {
      state: 'unavailable',
      reason: 'instrument_failed',
      detail: `This value was labelled in units this metric does not use, so it cannot be compared with the other arm's and is not stored.`,
    };
  }
  return parsed.data;
}

export function readRunMetrics(runId: string): Record<string, Measurement> {
  const rows = getDb()
    .prepare(
      `SELECT metric_key, availability, value_num, unit, unavailable_reason, detail
         FROM benchmark_metrics WHERE run_id = ?`,
    )
    .all(runId) as {
    metric_key: string;
    availability: string;
    value_num: number | null;
    unit: string | null;
    unavailable_reason: string | null;
    detail: string | null;
  }[];

  const out: Record<string, Measurement> = {};
  for (const row of rows) {
    if (row.availability === 'measured' && row.value_num !== null && row.unit !== null) {
      out[row.metric_key] = { state: 'measured', value: row.value_num, unit: row.unit };
    } else if (row.unavailable_reason !== null && row.detail !== null) {
      out[row.metric_key] = {
        state: 'unavailable',
        reason: row.unavailable_reason as Measurement extends { reason: infer R } ? R : never,
        detail: row.detail,
      } as Measurement;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Review draft, lock, and reveal
 * ------------------------------------------------------------------ */

/**
 * The in-progress review.
 *
 * The one benchmark row that is rewritten, and it is not evidence: it exists so
 * a refresh forty minutes into a fifteen-dimension rating form does not cost the
 * reviewer forty minutes. It becomes evidence only by being copied into
 * `benchmark_reviews` at the lock, and the guard below refuses to save a draft
 * once that has happened.
 */
export function saveReviewDraft(sessionId: string, draft: unknown, now: Date): boolean {
  const db = getDb();
  const locked = db
    .prepare('SELECT review_locked_at FROM benchmark_sessions WHERE id = ?')
    .get(sessionId) as { review_locked_at: string | null } | undefined;
  if (!locked || locked.review_locked_at !== null) return false;

  db.prepare(
    `INSERT INTO benchmark_review_drafts (session_id, payload_json, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(draft), now.toISOString());
  return true;
}

export function getReviewDraft(sessionId: string): unknown | null {
  const row = getDb()
    .prepare('SELECT payload_json FROM benchmark_review_drafts WHERE session_id = ?')
    .get(sessionId) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) : null;
}

export type LockOutcome = 'locked' | 'already_locked' | 'wrong_state';

/**
 * Lock the review. Irreversible, and set-once in SQL.
 *
 * The whole thing is one transaction: the review row and the lock timestamp
 * either both land or neither does. A session with a lock timestamp and no
 * review, or a review nobody locked, would each be a state the rest of the code
 * has no honest way to render.
 *
 * `review_locked_at IS NULL` in the guard is what makes a second submission a
 * no-op rather than a second opinion formed after seeing something.
 */
export function lockReview(input: {
  sessionId: string;
  review: BlindReview;
  now: Date;
}): LockOutcome {
  const db = getDb();
  const nowIso = input.now.toISOString();

  const attempt = db.transaction((): LockOutcome => {
    const moved = db
      .prepare(
        `UPDATE benchmark_sessions
            SET state = 'review_locked', review_locked_at = ?, updated_at = ?
          WHERE id = ? AND state = 'ready_for_review' AND review_locked_at IS NULL`,
      )
      .run(nowIso, nowIso, input.sessionId);

    if (Number(moved.changes ?? 0) === 0) {
      const existing = db
        .prepare('SELECT review_locked_at FROM benchmark_sessions WHERE id = ?')
        .get(input.sessionId) as { review_locked_at: string | null } | undefined;
      return existing?.review_locked_at ? 'already_locked' : 'wrong_state';
    }

    db.prepare(
      `INSERT INTO benchmark_reviews
         (id, session_id, reviewer, schema_version, payload_json, submitted_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      `review:${input.sessionId}`,
      input.sessionId,
      input.review.reviewer,
      input.review.schemaVersion,
      JSON.stringify(input.review),
      nowIso,
    );
    return 'locked';
  });

  return attempt();
}

export function getReview(sessionId: string): BlindReview | null {
  const row = getDb()
    .prepare('SELECT payload_json FROM benchmark_reviews WHERE session_id = ?')
    .get(sessionId) as { payload_json: string } | undefined;
  if (!row) return null;
  const parsed = blindReviewSchema.safeParse(JSON.parse(row.payload_json));
  return parsed.success ? parsed.data : null;
}

export type RevealOutcome = 'revealed' | 'already_revealed' | 'not_locked';

/**
 * Reveal the identities. Irreversible, and only after the lock.
 *
 * Ordering is the experiment: a reviewer who could see which system produced
 * which plan before committing their ratings has not produced a blind rating,
 * and no later care recovers it. `state = 'review_locked'` in the guard is what
 * makes the order structural rather than a matter of following the screens in
 * the intended sequence.
 */
export function revealIdentities(sessionId: string, now: Date): RevealOutcome {
  const db = getDb();
  const nowIso = now.toISOString();
  const result = db
    .prepare(
      `UPDATE benchmark_sessions
          SET state = 'revealed', revealed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'review_locked' AND revealed_at IS NULL`,
    )
    .run(nowIso, nowIso, sessionId);

  if (Number(result.changes ?? 0) > 0) return 'revealed';
  const existing = db
    .prepare('SELECT revealed_at FROM benchmark_sessions WHERE id = ?')
    .get(sessionId) as { revealed_at: string | null } | undefined;
  return existing?.revealed_at ? 'already_revealed' : 'not_locked';
}

/** The single gate every reveal-only surface asks. Server-side, never a flag. */
export function identitiesAreRevealed(sessionId: string): boolean {
  const row = getDb()
    .prepare('SELECT revealed_at FROM benchmark_sessions WHERE id = ?')
    .get(sessionId) as { revealed_at: string | null } | undefined;
  return row?.revealed_at !== null && row?.revealed_at !== undefined;
}

export function savePostRevealAnswers(answers: PostRevealAnswers): boolean {
  if (!identitiesAreRevealed(answers.sessionId)) return false;
  getDb()
    .prepare(
      `INSERT INTO benchmark_post_reveal (session_id, schema_version, payload_json, answered_at)
       VALUES (?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         payload_json = excluded.payload_json, answered_at = excluded.answered_at`,
    )
    .run(answers.sessionId, answers.schemaVersion, JSON.stringify(answers), answers.answeredAt);
  return true;
}

export function getPostRevealAnswers(sessionId: string): PostRevealAnswers | null {
  const row = getDb()
    .prepare('SELECT payload_json FROM benchmark_post_reveal WHERE session_id = ?')
    .get(sessionId) as { payload_json: string } | undefined;
  if (!row) return null;
  const parsed = postRevealAnswersSchema.safeParse(JSON.parse(row.payload_json));
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ *
 * Corrections
 * ------------------------------------------------------------------ */

export type CorrectionClaim =
  | { kind: 'claimed'; round: number }
  | { kind: 'limit_reached'; used: number }
  | { kind: 'stale'; headPlanId: string | null }
  | { kind: 'already_running'; round: number }
  | { kind: 'review_locked' };

interface CorrectionRequest {
  sessionId: string;
  system: ProducingSystem;
  expectedHeadPlanId: string;
  instructionText: string;
  now: Date;
}

/**
 * The body of a claim, with no transaction of its own.
 *
 * Extracted so that one system and both systems can be claimed under the same
 * rules from two different transaction boundaries. Every read it makes has to
 * happen inside whichever transaction its caller opened, because a count or a
 * head plan read outside one is a suggestion rather than a fact.
 */
function claimOne(db: ReturnType<typeof getDb>, input: CorrectionRequest): CorrectionClaim {
  /*
   * The refusal that has to come first.
   *
   * A locked review is a published rating of a particular pair of plans, and a
   * correction round inserts a new head plan version. Granting one afterwards
   * would leave the plan on screen a plan nobody rated, with nothing anywhere
   * saying the two had diverged. The reveal is a stricter state still, and it
   * cannot be reached without the lock, so testing the lock covers both.
   *
   * Here rather than in the action for the reason the lock itself is in SQL: a
   * `disabled` attribute is walked past by a second tab and by a direct POST.
   */
  const session = db
    .prepare('SELECT review_locked_at FROM benchmark_sessions WHERE id = ?')
    .get(input.sessionId) as { review_locked_at: string | null } | undefined;
  if (!session || session.review_locked_at !== null) return { kind: 'review_locked' };

  const head = db
    .prepare(
      `SELECT p.id AS id FROM benchmark_plans p
         JOIN benchmark_runs r ON r.id = p.run_id
        WHERE r.session_id = ? AND r.arm = ?
        ORDER BY p.plan_version DESC LIMIT 1`,
    )
    .get(input.sessionId, input.system) as { id: string } | undefined;
  if ((head?.id ?? null) !== input.expectedHeadPlanId) {
    return { kind: 'stale', headPlanId: head?.id ?? null };
  }

  const running = db
    .prepare(
      `SELECT round FROM benchmark_corrections
        WHERE session_id = ? AND system = ? AND completed_at IS NULL
        ORDER BY round DESC LIMIT 1`,
    )
    .get(input.sessionId, input.system) as { round: number } | undefined;
  if (running) return { kind: 'already_running', round: running.round };

  const usedRow = db
    .prepare(
      'SELECT COUNT(*) AS total FROM benchmark_corrections WHERE session_id = ? AND system = ?',
    )
    .get(input.sessionId, input.system) as { total: number };
  const used = Number(usedRow?.total ?? 0);
  if (used >= MAX_CORRECTION_ROUNDS) return { kind: 'limit_reached', used };

  const round = used + 1;
  const record: CorrectionRound = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    system: input.system,
    round,
    supersedesPlanId: input.expectedHeadPlanId,
    resultPlanId: null,
    instructionText: input.instructionText,
    instructionHash: stableHash(input.instructionText),
    outcome: 'failed',
    regressedFindingCodes: [],
    newCriticalCount: null,
    newMajorCount: null,
    satisfaction: null,
    abandoned: false,
    abandonReason: null,
    requestedAt: input.now.toISOString(),
    completedAt: null,
  };

  db.prepare(
    `INSERT INTO benchmark_corrections
       (id, session_id, system, round, supersedes_plan_id, result_plan_id,
        instruction_hash, schema_version, payload_json, requested_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    `correction:${input.sessionId}:${input.system}:${round}`,
    input.sessionId,
    input.system,
    round,
    input.expectedHeadPlanId,
    null,
    record.instructionHash,
    1,
    JSON.stringify(record),
    record.requestedAt,
  );
  return { kind: 'claimed', round };
}

function roundsUsedBy(db: ReturnType<typeof getDb>, sessionId: string, system: ProducingSystem) {
  const used = db
    .prepare(
      'SELECT COUNT(*) AS total FROM benchmark_corrections WHERE session_id = ? AND system = ?',
    )
    .get(sessionId, system) as { total: number } | undefined;
  return Number(used?.total ?? 0);
}

/**
 * Claim the next correction round for one system.
 *
 * Four refusals, and each is a datum rather than an error. The review is locked:
 * the ratings are in, and a new plan version would make them ratings of
 * something that is no longer on screen. The limit is reached: the reviewer
 * wanted a fourth round, which is worth knowing. The head plan moved: a round
 * started against something that is no longer current, and applying it would
 * silently discard whatever replaced it. A round is already running: two tabs,
 * one instruction.
 *
 * The bound is enforced by the unique index on `(session, system, round)` as
 * well as by the count inside, because a count read outside a transaction is a
 * suggestion.
 */
export function claimCorrectionRound(input: CorrectionRequest): CorrectionClaim {
  const db = getDb();
  const claim = db.transaction((): CorrectionClaim => claimOne(db, input));

  try {
    return claim();
  } catch {
    // The unique index refused it: another writer took this round between the
    // count and the insert. That is the answer, not a failure.
    return { kind: 'already_running', round: roundsUsedBy(db, input.sessionId, input.system) };
  }
}

export type PairedCorrectionClaim =
  | { kind: 'claimed'; rounds: readonly { system: ProducingSystem; round: number }[] }
  | { kind: 'refused'; refusals: readonly { system: ProducingSystem; claim: CorrectionClaim }[] };

/** Thrown to roll the pair back, and to carry out why. Never escapes this file. */
class PairedRefusal extends Error {
  constructor(readonly refusals: readonly { system: ProducingSystem; claim: CorrectionClaim }[]) {
    super('A correction round was refused for at least one system.');
    this.name = 'PairedRefusal';
  }
}

/**
 * Claim the same round for every system, or for none of them.
 *
 * The correction operation sends one instruction to both plans and tells the
 * reviewer it did. Claiming them one transaction at a time made that sentence
 * conditionally false: one arm could take the round and the other refuse — for a
 * head plan that had moved, or a round already running — leaving one system a
 * round ahead of its rival in a comparison whose entire point is that both got
 * the same help. The reviewer would see one confirmation and have no way to know.
 *
 * So both are claimed inside a single transaction and a refusal from either
 * throws, which is what makes the insert that already landed roll back.
 */
export function claimCorrectionRoundForBoth(input: {
  sessionId: string;
  heads: readonly { system: ProducingSystem; expectedHeadPlanId: string }[];
  instructionText: string;
  now: Date;
}): PairedCorrectionClaim {
  const db = getDb();

  const claim = db.transaction((): PairedCorrectionClaim => {
    const outcomes = input.heads.map((head) => ({
      system: head.system,
      claim: claimOne(db, {
        sessionId: input.sessionId,
        system: head.system,
        expectedHeadPlanId: head.expectedHeadPlanId,
        instructionText: input.instructionText,
        now: input.now,
      }),
    }));

    const refusals = outcomes.filter((outcome) => outcome.claim.kind !== 'claimed');
    if (refusals.length > 0) throw new PairedRefusal(refusals);

    return {
      kind: 'claimed',
      rounds: outcomes.map((outcome) => ({
        system: outcome.system,
        round: outcome.claim.kind === 'claimed' ? outcome.claim.round : 0,
      })),
    };
  });

  try {
    return claim();
  } catch (error) {
    if (error instanceof PairedRefusal) return { kind: 'refused', refusals: error.refusals };
    // The unique index refused an insert: another writer took one of these
    // rounds. Nothing landed, because the transaction carried both.
    return {
      kind: 'refused',
      refusals: input.heads.map((head) => ({
        system: head.system,
        claim: {
          kind: 'already_running',
          round: roundsUsedBy(db, input.sessionId, head.system),
        } satisfies CorrectionClaim,
      })),
    };
  }
}

export function completeCorrectionRound(input: {
  sessionId: string;
  system: ProducingSystem;
  round: number;
  update: Partial<CorrectionRound>;
  now: Date;
}): boolean {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT payload_json FROM benchmark_corrections WHERE session_id = ? AND system = ? AND round = ?',
    )
    .get(input.sessionId, input.system, input.round) as { payload_json: string } | undefined;
  if (!row) return false;

  const parsed = correctionRoundSchema.safeParse(JSON.parse(row.payload_json));
  if (!parsed.success) return false;

  const merged: CorrectionRound = {
    ...parsed.data,
    ...input.update,
    completedAt: input.now.toISOString(),
  };

  const result = db
    .prepare(
      `UPDATE benchmark_corrections
          SET payload_json = ?, result_plan_id = ?, completed_at = ?
        WHERE session_id = ? AND system = ? AND round = ? AND completed_at IS NULL`,
    )
    .run(
      JSON.stringify(merged),
      merged.resultPlanId,
      merged.completedAt,
      input.sessionId,
      input.system,
      input.round,
    );
  return Number(result.changes ?? 0) > 0;
}

export function listCorrections(sessionId: string): CorrectionRound[] {
  const rows = getDb()
    .prepare(
      'SELECT payload_json FROM benchmark_corrections WHERE session_id = ? ORDER BY round, system',
    )
    .all(sessionId) as { payload_json: string }[];
  return rows
    .map((row) => correctionRoundSchema.safeParse(JSON.parse(row.payload_json)))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
}

/* ------------------------------------------------------------------ *
 * Model-call ledger
 * ------------------------------------------------------------------ */

export interface ModelCallRecord {
  sessionId: string;
  runId: string | null;
  operationKey: string;
  arm: ProducingSystem;
  operation: string;
  provider: string;
  model: string;
  promptVersion: string;
  requestId: string | null;
  attempt: number;
  /** `null` when the caller counted calls and not tokens. Never zero for that. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `null` when the model has no entry in the checked-in rate table. */
  costMicroUsd: number | null;
  costUnavailableReason: string | null;
  outcome: 'succeeded' | 'failed';
  failureKind: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/**
 * Record a call, whether or not it worked.
 *
 * A provider that took the request, burned the tokens and returned an unusable
 * answer has spent real money. A ledger that only counted successes would be
 * wrong in precisely the situation where somebody is looking at it — which is
 * why every caller writes this on the failure path too.
 */
export function recordModelCall(record: ModelCallRecord): void {
  getDb()
    .prepare(
      `INSERT INTO benchmark_model_calls
         (id, session_id, run_id, operation_key, arm, operation, provider, model,
          prompt_version, schema_version, request_id, attempt, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd,
          cost_unavailable_reason, outcome, failure_kind, started_at, finished_at, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(operation_key, attempt) DO NOTHING`,
    )
    .run(
      `call:${record.operationKey}:${record.attempt}`,
      record.sessionId,
      record.runId,
      record.operationKey,
      record.arm,
      record.operation,
      record.provider,
      record.model,
      record.promptVersion,
      1,
      record.requestId,
      record.attempt,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheWriteTokens,
      record.costMicroUsd,
      record.costUnavailableReason,
      record.outcome,
      record.failureKind,
      record.startedAt,
      record.finishedAt,
      record.durationMs,
    );
}

/**
 * Record a call from an arm that cannot hand over one row per call.
 *
 * `recordModelCall` is shaped for a per-call wrapper: it wants an operation key,
 * an attempt number and a prompt version, all of which exist because the baseline
 * arm goes through a ledger object that sits around each individual request. The
 * deterministic arm has no such seam — its model use happens inside the compiler,
 * which reports totals for a job rather than events — so it had no way to write
 * here at all, and every penny it spent was missing from a ledger that the budget
 * ceiling reads. A ledger that is short by a whole arm does not under-report by a
 * little; it authorises spending nobody approved.
 *
 * This is the door for either arm. It derives the operation key from the identity
 * the caller already has, so a repeated write for the same operation is refused
 * by the unique index rather than counted twice. Where an arm can only report
 * totals for a stage, one row stands for that stage: the cost is the figure the
 * ceiling needs, and `operation` says what it covers.
 *
 * A cost the caller could not establish must arrive as `null` with a reason. It
 * is never defaulted here, for the reason the column exists.
 */
export function recordArmModelCall(input: {
  sessionId: string;
  runId: string | null;
  arm: ProducingSystem;
  /** What this row accounts for. One request, or one stage that reports totals. */
  operation: string;
  attempt?: number;
  provider: string;
  model: string;
  promptVersion?: string | null;
  requestId?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicroUsd: number | null;
  costUnavailableReason?: string | null;
  outcome: 'succeeded' | 'failed';
  failureKind?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
}): void {
  const attempt = input.attempt ?? 1;
  const finishedAt = input.finishedAt ?? null;
  recordModelCall({
    sessionId: input.sessionId,
    runId: input.runId,
    /*
     * The run, not just the session.
     *
     * `${sessionId}:${arm}:${operation}` with a default attempt of 1 collided
     * across re-runs of the same session, and the ledger's `ON CONFLICT DO
     * NOTHING` then silently dropped the second compilation's spend — from the
     * very table the spending ceiling reads. The run id is what distinguishes two
     * attempts at the same operation.
     */
    operationKey: `${input.sessionId}:${input.runId ?? 'norun'}:${input.arm}:${input.operation}`,
    arm: input.arm,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion ?? 'unstated',
    requestId: input.requestId ?? null,
    attempt,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    costMicroUsd: input.costMicroUsd,
    costUnavailableReason:
      input.costUnavailableReason ?? (input.costMicroUsd === null ? 'usage_not_reported' : null),
    outcome: input.outcome,
    failureKind: input.failureKind ?? null,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt === null ? null : finishedAt.toISOString(),
    durationMs: finishedAt === null ? null : finishedAt.getTime() - input.startedAt.getTime(),
  });
}

export function modelCallsForSession(sessionId: string): ModelCallRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id, run_id, operation_key, arm, operation, provider, model,
              prompt_version, request_id, attempt, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_micro_usd,
              cost_unavailable_reason, outcome, failure_kind, started_at,
              finished_at, duration_ms
         FROM benchmark_model_calls WHERE session_id = ? ORDER BY started_at`,
    )
    .all(sessionId) as Record<string, unknown>[];

  return rows.map((row) => ({
    sessionId: row.session_id as string,
    runId: row.run_id as string | null,
    operationKey: row.operation_key as string,
    arm: row.arm as ProducingSystem,
    operation: row.operation as string,
    provider: row.provider as string,
    model: row.model as string,
    promptVersion: row.prompt_version as string,
    requestId: row.request_id as string | null,
    attempt: row.attempt as number,
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    cacheReadTokens: row.cache_read_tokens as number,
    cacheWriteTokens: row.cache_write_tokens as number,
    costMicroUsd: row.cost_micro_usd as number | null,
    costUnavailableReason: row.cost_unavailable_reason as string | null,
    outcome: row.outcome as 'succeeded' | 'failed',
    failureKind: row.failure_kind as string | null,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    durationMs: row.duration_ms as number | null,
  }));
}

export interface BenchmarkSpend {
  /**
   * The priced total, or `null` when calls were made and not one of them could
   * be priced. Zero means zero: no calls, or calls that genuinely cost nothing.
   */
  costMicroUsd: number | null;
  /** The sum over the calls that could be priced. A floor when `unpricedCalls`. */
  pricedMicroUsd: number;
  unpricedCalls: number;
  calls: number;
}

/**
 * Total spend for a session, and whether that total is complete.
 *
 * `COALESCE(SUM(...), 0)` was the whole defect. `SUM` over an empty set is NULL,
 * and so is `SUM` over a set in which every cost is NULL — so a session whose
 * every call went to a model with no row in the rate table reported the same
 * figure as a session that made no calls at all. The number is then read out on
 * the results screen as a cost comparison, which is the one place the two must
 * not be confused.
 *
 * So the sum is returned as `null` in exactly that case, and the counts travel
 * beside it. A partially priced session keeps its total, because a floor is
 * genuinely useful, and `unpricedCalls` is what says it is a floor.
 */
export function sessionSpend(sessionId: string): BenchmarkSpend {
  const row = getDb()
    .prepare(
      `SELECT SUM(cost_micro_usd) AS total,
              SUM(CASE WHEN cost_micro_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
              COUNT(*) AS calls
         FROM benchmark_model_calls WHERE session_id = ?`,
    )
    .get(sessionId) as
    | { total: number | null; unpriced: number | null; calls: number | null }
    | undefined;
  return toSpend(row);
}

/**
 * Spend across every session, for the live-budget ceiling.
 *
 * A `null` total here is not a display problem, it is a refusal: with calls on
 * the ledger and no price against any of them, nobody knows what has been spent,
 * and a ceiling that treated the unknown as zero would authorise the whole budget
 * again on every unpriced model. The caller has to handle the `null`, and
 * handling it means declining to spend.
 */
export function totalBenchmarkSpendMicroUsd(): BenchmarkSpend {
  const row = getDb()
    .prepare(
      `SELECT SUM(cost_micro_usd) AS total,
              SUM(CASE WHEN cost_micro_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
              COUNT(*) AS calls
         FROM benchmark_model_calls`,
    )
    .get() as { total: number | null; unpriced: number | null; calls: number | null } | undefined;
  return toSpend(row);
}

function toSpend(
  row: { total: number | null; unpriced: number | null; calls: number | null } | undefined,
): BenchmarkSpend {
  const calls = Number(row?.calls ?? 0);
  const unpricedCalls = Number(row?.unpriced ?? 0);
  const pricedMicroUsd = Number(row?.total ?? 0);
  return {
    costMicroUsd: calls > 0 && unpricedCalls === calls ? null : pricedMicroUsd,
    pricedMicroUsd,
    unpricedCalls,
    calls,
  };
}
