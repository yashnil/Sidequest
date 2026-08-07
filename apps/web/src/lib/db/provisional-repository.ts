import 'server-only';
import {
  BOARD_UNKNOWN,
  EMPTY_BASIS,
  ACTION_RECONCILIATION_STATES,
  boardAcknowledgementsSchema,
  boardRef,
  boardReconciliationSchema,
  provisionalActionSchema,
  provisionalBoardSchema,
  provisionalSelectionSchema,
  reconcileBoard,
  reconciliationBasisSchema,
  type ActionReconciliationState,
  type BoardAcknowledgement,
  type BoardAcknowledgements,
  type BoardReconciliation,
  type BoardRef,
  type ProvisionalAction,
  type ProvisionalActionType,
  type ProvisionalBoard,
  type ProvisionalIntent,
  type ProvisionalSelection,
  type ReconciliationBasis,
} from '@sidequest/core';
import { getDb } from './client';
import { z } from 'zod';

/** The driver handle, named off the accessor so this module imports no driver types. */
type Db = ReturnType<typeof getDb>;

/**
 * THE BOARD SHOWN BEFORE ANYTHING WAS BOUGHT, AND WHAT BECAME OF IT.
 *
 * Five tables, and the split is the design.
 *
 * - **`provisional_boards`** is immutable and versioned. A board somebody has
 *   already looked at is never rewritten; a rebuild inserts a higher version and
 *   names the one it supersedes. Without that, "why did that place disappear"
 *   has no answer, because the thing it disappeared from was overwritten.
 * - **`provisional_selections`** is keyed on the *trip*, not the board. Revising
 *   the board must not lose what somebody already said about a place that is
 *   still on it. It holds the **current** answer per card.
 * - **`provisional_actions`** is append-only and holds every answer anybody ever
 *   gave, with the identity of the board it was given against and an explicit
 *   reconciliation state. This is the table that closes the defect below.
 * - **`board_reconciliations`** is the **current** account of what verification
 *   changed. One row per trip, guarded by a compare-and-set on
 *   `reconciliation_version`. Its `acknowledged_json` column is written on a
 *   *different* schedule from `payload_json`: the payload is what the compiler
 *   found, the acknowledgements are what the traveller has read. Folding the
 *   second into the first would mean rewriting an audit record every time
 *   somebody clicks a button, and a record you rewrite on interaction is not an
 *   audit record.
 * - **`board_reconciliation_history`** holds every account that was ever
 *   current, so a superseded one is inspectable rather than gone.
 *
 * ---
 *
 * THE DEFECT THIS SHAPE EXISTS TO CLOSE.
 *
 * Reconciliation used to be a single event: the compile finished, one pass ran,
 * one row was written, and the board stayed interactive afterwards. So a mark
 * made one second later got **no reconciliation state at all** — neither
 * accounted for nor recorded as outstanding — while the panel above it said "the
 * full record — all N decisions you made". A build that failed or was cancelled
 * wrote nothing, and the previous build's account stayed on screen beside the
 * new board.
 *
 * The replacement is a state model rather than an event. Every action carries
 * `(tripId, boardId, boardVersion, placeId, action, actionVersion, recordedAt)`
 * and ends in exactly one of `pending`, `reconciled`, `superseded`, `withdrawn`.
 * `reconcilePendingActions` is idempotent, synchronous and transactional, and is
 * run from both ends — after a compile commits, and after every selection write.
 * When there is no compiled region, actions stay `pending`, which is a state
 * somebody can query rather than an omission.
 *
 * `better-sqlite3` is synchronous, so `db.transaction(...)` around a pure
 * reconciliation pass is genuinely atomic in-process: nothing can interleave
 * between the read of the pending set and the write of the account. Across
 * processes the guard is the compare-and-set on `reconciliation_version` plus
 * the unique indexes — a worker holding an older version cannot overwrite a
 * newer account, and a replayed action version is a no-op at the database.
 *
 * None of it is load-bearing for a plan. A compiled region carries its own copy
 * of everything it was built from, so every table here can be emptied and no
 * stored itinerary changes — what is lost is the ability to explain a removal,
 * which is why it is kept rather than derived.
 */

interface BoardRow {
  payload_json: string;
  version: number;
}

/**
 * A stored board that no longer parses is treated as absent.
 *
 * The `planner_readiness` policy, and for the same reason: losing a preview is
 * cheaper than losing the screen it sits on. A provisional board is a
 * convenience by construction — the compiled artifact is the only thing a plan
 * is ever built from.
 */
export function getProvisionalBoard(tripId: string): ProvisionalBoard | null {
  const row = getDb()
    .prepare<[string], BoardRow>(
      `SELECT payload_json, version FROM provisional_boards
        WHERE trip_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(tripId);
  if (!row) return null;
  try {
    const parsed = provisionalBoardSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The identity of the board a traveller is currently being shown, if any. */
export function latestBoardIdentity(tripId: string): BoardRef {
  const row = getDb()
    .prepare<[string], { id: string; version: number }>(
      `SELECT id, version FROM provisional_boards
        WHERE trip_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(tripId);
  return boardRef(row?.id, row?.version);
}

export interface SaveBoardResult {
  /** The stored identity, whether or not this call is what stored it. */
  boardId: string;
  version: number;
  /** False when this job had already produced a board. */
  stored: boolean;
}

/**
 * Stores a board and stamps it on its job, in one transaction.
 *
 * Two things were wrong with the previous shape, and both had the same cause —
 * two statements that have to agree were issued separately.
 *
 * A crash between them left a stored board that no job pointed at. And the
 * insert conflicted only on `id`, while the table also carries a **unique index
 * on `job_id`**: a second board emitted by one job did not conflict on the
 * primary key, so it raised a constraint error instead of being ignored — and
 * the runner's `try` swallowed it, so a build could lose its board with nothing
 * anywhere saying so.
 *
 * A job produces one board by design. A second one is therefore not an error to
 * report to a traveller and not something to overwrite the first with: it is a
 * no-op, returned explicitly so the caller can log it rather than infer it.
 */
export function saveProvisionalBoard(board: ProvisionalBoard, now: Date): SaveBoardResult {
  const db = getDb();
  const write = db.transaction((): SaveBoardResult => {
    const existing = db
      .prepare<[string], { id: string; version: number }>(
        'SELECT id, version FROM provisional_boards WHERE job_id = ?',
      )
      .get(board.jobId);
    if (existing) {
      return { boardId: existing.id, version: existing.version, stored: false };
    }

    const previous = db
      .prepare<[string], { version: number; id: string }>(
        `SELECT version, id FROM provisional_boards
          WHERE trip_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(board.tripId);

    const version = (previous?.version ?? 0) + 1;
    const id = `${board.id}-v${version}`;
    const stored: ProvisionalBoard = {
      ...board,
      id,
      version,
      ...(previous ? { supersedesBoardId: previous.id } : {}),
    };

    db.prepare(
      `INSERT INTO provisional_boards
         (id, trip_id, job_id, scope_fingerprint, schema_version, version,
          supersedes_board_id, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      id,
      stored.tripId,
      stored.jobId,
      stored.scopeFingerprint,
      stored.schemaVersion,
      version,
      stored.supersedesBoardId ?? null,
      JSON.stringify(stored),
      now.toISOString(),
    );

    /*
     * Stamped on the job with a conditional write rather than a read-modify-
     * write, so it can never clobber `stages_json` — which the stage recorder is
     * writing to on its own schedule from the same process.
     */
    db.prepare(
      `UPDATE compilation_jobs SET provisional_board_id = ?
        WHERE id = ? AND provisional_board_id IS NULL`,
    ).run(id, stored.jobId);

    return { boardId: id, version, stored: true };
  });
  return write();
}

// ---------------------------------------------------------------------------
// Selections and the actions behind them
// ---------------------------------------------------------------------------

interface SelectionRow {
  place_id: string;
  intent: string;
  updated_at: string;
  board_id: string | null;
  board_version: number | null;
  action_version: number | null;
}

export function getProvisionalSelections(tripId: string): ProvisionalSelection[] {
  const rows = getDb()
    .prepare<[string], SelectionRow>(
      `SELECT place_id, intent, updated_at, board_id, board_version, action_version
         FROM provisional_selections WHERE trip_id = ?
        ORDER BY place_id`,
    )
    .all(tripId);

  const selections: ProvisionalSelection[] = [];
  for (const row of rows) {
    /*
     * `board_id` is nullable and stays nullable. A mark recorded before board
     * identity was carried genuinely has no board attached; defaulting it to
     * version 1 would assert it was made on the first board, which is the exact
     * misattribution the field exists to prevent.
     */
    const made = boardRef(row.board_id, row.board_version);
    const parsed = provisionalSelectionSchema.safeParse({
      placeId: row.place_id,
      intent: row.intent,
      updatedAt: row.updated_at,
      ...(made.known ? { boardId: made.boardId, boardVersion: made.version } : {}),
      ...(row.action_version && row.action_version > 0
        ? { actionVersion: row.action_version }
        : {}),
    });
    if (parsed.success) selections.push(parsed.data);
  }
  return selections;
}

export interface SelectionWriteOptions {
  /**
   * The board the card was rendered from.
   *
   * Supplied by the caller because only the caller knows it: the board the
   * traveller was looking at when they pressed the button is the board the mark
   * was made on, and a board rebuilt between the render and the click would make
   * "whatever is latest now" the wrong answer. Omitted, it falls back to the
   * latest board, which is right in every case except that race. `null` records
   * the mark with no board at all, which is what a caller that genuinely does
   * not know should say.
   */
  board?: { id: string; version: number } | null;
  /**
   * An explicit action version, for a caller replaying a known action.
   *
   * A redelivery of version 3 is a no-op at the unique index rather than a
   * second event, which is what makes at-least-once delivery safe here without a
   * distributed lock.
   */
  actionVersion?: number;
}

export interface SelectionWriteResult {
  actionVersion: number;
  /** False when this exact action version had already been recorded. */
  recorded: boolean;
  /** The board the mark was attributed to. Unknown is an answer. */
  board: BoardRef;
}

/**
 * Records what somebody said about a card, as an event and as a current value.
 *
 * Both writes in one transaction, because a current value with no event behind
 * it cannot be reconciled and an event with no current value is not what the
 * board renders. The action version is monotonic per `(trip, place)` and is the
 * compare-and-set token: a stale writer holding version 3 cannot overwrite
 * version 4, and a replay of version 3 writes nothing.
 */
export function setProvisionalSelection(
  tripId: string,
  placeId: string,
  intent: ProvisionalIntent,
  now: Date,
  options?: SelectionWriteOptions,
): SelectionWriteResult {
  provisionalSelectionSchema.parse({ placeId, intent, updatedAt: now.toISOString() });
  return recordAction(tripId, placeId, intent, now, options);
}

/**
 * Takes a mark back.
 *
 * Appended as a `cleared` action in the `withdrawn` state rather than deleted
 * silently: withdrawing is a decision, and a withdrawal that leaves no trace is
 * the same silence every other part of this module exists to close. `withdrawn`
 * is terminal on arrival because there is nothing for a final board to say about
 * an opinion that no longer exists.
 */
export function clearProvisionalSelection(
  tripId: string,
  placeId: string,
  now: Date = new Date(),
  options?: SelectionWriteOptions,
): SelectionWriteResult {
  return recordAction(tripId, placeId, 'cleared', now, options);
}

function recordAction(
  tripId: string,
  placeId: string,
  action: ProvisionalActionType,
  now: Date,
  options?: SelectionWriteOptions,
): SelectionWriteResult {
  const db = getDb();
  const write = db.transaction((): SelectionWriteResult => {
    const identity =
      options?.board === null
        ? BOARD_UNKNOWN
        : options?.board
          ? boardRef(options.board.id, options.board.version)
          : latestBoardIdentity(tripId);

    const highest =
      db
        .prepare<[string, string], { v: number }>(
          `SELECT COALESCE(MAX(action_version), 0) AS v FROM provisional_actions
            WHERE trip_id = ? AND place_id = ?`,
        )
        .get(tripId, placeId)?.v ?? 0;
    const current =
      db
        .prepare<[string, string], { action_version: number | null }>(
          `SELECT action_version FROM provisional_selections
            WHERE trip_id = ? AND place_id = ?`,
        )
        .get(tripId, placeId)?.action_version ?? 0;

    const version = options?.actionVersion ?? Math.max(highest, current) + 1;
    const state: ActionReconciliationState = action === 'cleared' ? 'withdrawn' : 'pending';

    const inserted = db
      .prepare(
        `INSERT INTO provisional_actions
           (trip_id, place_id, board_id, board_version, action, action_version,
            recorded_at, reconciliation_state)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(trip_id, place_id, action_version) DO NOTHING`,
      )
      .run(
        tripId,
        placeId,
        identity.known ? identity.boardId : null,
        identity.known ? identity.version : null,
        action,
        version,
        now.toISOString(),
        state,
      );

    /*
     * Duplicate delivery. The unique index absorbed it, so nothing else may run:
     * superseding an earlier action or rewriting the current value on the
     * strength of a replay would turn an at-least-once delivery into a state
     * change.
     */
    if (inserted.changes === 0) {
      return { actionVersion: version, recorded: false, board: identity };
    }

    /*
     * An earlier mark on the same card that nothing has accounted for yet is
     * `superseded`, not `pending`. That is what keeps the pending set at most one
     * action per card, which is what makes the reconciliation pass idempotent
     * without deduplicating anything at read time.
     */
    db.prepare(
      `UPDATE provisional_actions
          SET reconciliation_state = 'superseded'
        WHERE trip_id = ? AND place_id = ? AND action_version < ?
          AND reconciliation_state = 'pending'`,
    ).run(tripId, placeId, version);

    if (action === 'cleared') {
      db.prepare(
        `DELETE FROM provisional_selections
          WHERE trip_id = ? AND place_id = ? AND COALESCE(action_version, 0) <= ?`,
      ).run(tripId, placeId, version);
      return { actionVersion: version, recorded: true, board: identity };
    }

    db.prepare(
      `INSERT INTO provisional_selections
         (trip_id, place_id, intent, updated_at, board_id, board_version,
          action_version, reconciliation_state, reconciled_region_id, reconciled_at)
       VALUES (?,?,?,?,?,?,?, 'pending', NULL, NULL)
       ON CONFLICT(trip_id, place_id) DO UPDATE SET
         intent               = excluded.intent,
         updated_at           = excluded.updated_at,
         board_id             = excluded.board_id,
         board_version        = excluded.board_version,
         action_version       = excluded.action_version,
         reconciliation_state = 'pending',
         reconciled_region_id = NULL,
         reconciled_at        = NULL
       WHERE excluded.action_version > COALESCE(provisional_selections.action_version, 0)`,
    ).run(
      tripId,
      placeId,
      action,
      now.toISOString(),
      identity.known ? identity.boardId : null,
      identity.known ? identity.version : null,
      version,
    );

    return { actionVersion: version, recorded: true, board: identity };
  });
  return write();
}

interface ActionRow {
  place_id: string;
  board_id: string | null;
  board_version: number | null;
  action: string;
  action_version: number;
  recorded_at: string;
  reconciliation_state: string;
  reconciled_region_id: string | null;
  reconciled_at: string | null;
}

/**
 * Every mark anybody ever made on this trip, oldest first.
 *
 * A read path, so a row that will not parse is skipped rather than thrown: a
 * history nobody can open because one row is malformed is worse than a history
 * with a gap in it, and the gap is visible in the count.
 */
export function listProvisionalActions(tripId: string): ProvisionalAction[] {
  const rows = getDb()
    .prepare<[string], ActionRow>(
      `SELECT place_id, board_id, board_version, action, action_version, recorded_at,
              reconciliation_state, reconciled_region_id, reconciled_at
         FROM provisional_actions WHERE trip_id = ?
        ORDER BY id`,
    )
    .all(tripId);

  const actions: ProvisionalAction[] = [];
  for (const row of rows) {
    const parsed = provisionalActionSchema.safeParse({
      tripId,
      placeId: row.place_id,
      board: boardRef(row.board_id, row.board_version),
      action: row.action,
      actionVersion: row.action_version,
      recordedAt: row.recorded_at,
      state: row.reconciliation_state,
      ...(row.reconciled_region_id ? { reconciledRegionId: row.reconciled_region_id } : {}),
      ...(row.reconciled_at ? { reconciledAt: row.reconciled_at } : {}),
    });
    if (parsed.success) actions.push(parsed.data);
  }
  return actions;
}

/**
 * The invariant, as a query.
 *
 * "Every action ends in an explicit reconciliation state" is only a promise if
 * it can be checked, and it can only be checked if the states are countable from
 * the database rather than inferred from code. A row in no state at all — the
 * defect this replaced — shows up here as a total that does not add up.
 */
export function actionStateCounts(
  tripId: string,
): Record<ActionReconciliationState, number> & { total: number; unrecognised: number } {
  const rows = getDb()
    .prepare<[string], { reconciliation_state: string; n: number }>(
      `SELECT reconciliation_state, COUNT(*) AS n FROM provisional_actions
        WHERE trip_id = ? GROUP BY reconciliation_state`,
    )
    .all(tripId);

  const counts = {
    pending: 0,
    reconciled: 0,
    superseded: 0,
    withdrawn: 0,
    total: 0,
    unrecognised: 0,
  };
  for (const row of rows) {
    counts.total += row.n;
    if ((ACTION_RECONCILIATION_STATES as readonly string[]).includes(row.reconciliation_state)) {
      counts[row.reconciliation_state as ActionReconciliationState] += row.n;
    } else {
      counts.unrecognised += row.n;
    }
  }
  return counts;
}

/** How many marks are still waiting for a final board to say something. */
export function pendingActionCount(tripId: string): number {
  return (
    getDb()
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM provisional_actions
          WHERE trip_id = ? AND reconciliation_state = 'pending'`,
      )
      .get(tripId)?.n ?? 0
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface AccountRow {
  provisional_board_id: string;
  provisional_board_version: number;
  compiled_region_id: string;
  schema_version: number;
  reconciliation_version: number;
  payload_json: string;
  created_at: string;
}

function accountRow(db: Db, tripId: string): AccountRow | undefined {
  return db
    .prepare<[string], AccountRow>(
      `SELECT provisional_board_id, provisional_board_version, compiled_region_id,
              schema_version, reconciliation_version, payload_json, created_at
         FROM board_reconciliations WHERE trip_id = ?`,
    )
    .get(tripId);
}

function parseAccount(payload: string): BoardReconciliation | null {
  try {
    const parsed = boardReconciliationSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The current account, whatever it is about.
 *
 * A stored payload that no longer parses reads as absent — never as a throw out
 * of a read path. Callers that are rendering beside a specific artifact must use
 * `getReconciliationFor`, because an account of a *different* build is worse
 * than no account: it is a confident, detailed, wrong answer.
 */
export function getReconciliation(tripId: string): BoardReconciliation | null {
  const row = getDb()
    .prepare<[string], { payload_json: string }>(
      'SELECT payload_json FROM board_reconciliations WHERE trip_id = ?',
    )
    .get(tripId);
  return row ? parseAccount(row.payload_json) : null;
}

/**
 * The account **for this artifact**, or nothing.
 *
 * `saveReconciliation` only ever ran on a successful build, so a build that
 * failed left the previous build's account in place — and the discovery page
 * read it without ever comparing its `compiledRegionId` to the region it was
 * rendering. Build 2 failing put build 1's list of removals above build 2's
 * board, with every sentence in it stated in the present tense.
 *
 * The identity comparison is the whole fix, and it belongs here rather than at
 * each call site so that a future page cannot forget it.
 */
export function getReconciliationFor(
  tripId: string,
  compiledRegionId: string,
): BoardReconciliation | null {
  const account = getReconciliation(tripId);
  return account && account.compiledRegionId === compiledRegionId ? account : null;
}

/**
 * Writes the account under a compare-and-set on `reconciliation_version`.
 *
 * Returns whether it landed. A worker holding version 2 cannot overwrite an
 * account already at 3 — it loses, silently and correctly, and is told so. That
 * is the entire stale-writer defence and it needs no lock.
 *
 * The account it replaces is copied into `board_reconciliation_history` first,
 * so a superseded account is inspectable rather than gone. `INSERT OR IGNORE`
 * against the unique `(trip, region, version)` key makes a retry write nothing
 * rather than a second copy.
 *
 * `acknowledged_json` is cleared only when the compiled region changes. A
 * rebuild must not inherit the last build's acknowledgements — that would let it
 * suppress its own bad news — but a *later mark against the same artifact*
 * rewrites this row too, and making somebody re-acknowledge a removal they
 * already read because they pinned something else afterwards is a different
 * kind of dishonesty.
 */
export function saveReconciliation(reconciliation: BoardReconciliation, now: Date): boolean {
  const db = getDb();
  const write = db.transaction((): boolean => {
    db.prepare(
      `INSERT OR IGNORE INTO board_reconciliation_history
         (trip_id, provisional_board_id, provisional_board_version, compiled_region_id,
          reconciliation_version, schema_version, payload_json, created_at)
       SELECT trip_id, provisional_board_id, provisional_board_version, compiled_region_id,
              reconciliation_version, schema_version, payload_json, created_at
         FROM board_reconciliations WHERE trip_id = ?`,
    ).run(reconciliation.tripId);

    const result = db
      .prepare(
        `INSERT INTO board_reconciliations
           (trip_id, provisional_board_id, provisional_board_version, compiled_region_id,
            schema_version, payload_json, reconciliation_version, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(trip_id) DO UPDATE SET
           provisional_board_id      = excluded.provisional_board_id,
           provisional_board_version = excluded.provisional_board_version,
           compiled_region_id        = excluded.compiled_region_id,
           schema_version            = excluded.schema_version,
           payload_json              = excluded.payload_json,
           reconciliation_version    = excluded.reconciliation_version,
           acknowledged_json         = CASE
             WHEN board_reconciliations.compiled_region_id = excluded.compiled_region_id
             THEN board_reconciliations.acknowledged_json
             ELSE NULL END,
           created_at                = excluded.created_at
         WHERE excluded.reconciliation_version > board_reconciliations.reconciliation_version`,
      )
      .run(
        reconciliation.tripId,
        reconciliation.provisionalBoardId,
        reconciliation.provisionalBoardVersion,
        reconciliation.compiledRegionId,
        reconciliation.schemaVersion,
        JSON.stringify(reconciliation),
        reconciliation.reconciliationVersion,
        now.toISOString(),
      );

    return result.changes > 0;
  });
  return write();
}

/** Every account that was ever current for this trip, oldest first. */
export function listReconciliationHistory(tripId: string): BoardReconciliation[] {
  const rows = getDb()
    .prepare<[string], { payload_json: string }>(
      `SELECT payload_json FROM board_reconciliation_history
        WHERE trip_id = ? ORDER BY id`,
    )
    .all(tripId);
  const accounts: BoardReconciliation[] = [];
  for (const row of rows) {
    const parsed = parseAccount(row.payload_json);
    if (parsed) accounts.push(parsed);
  }
  return accounts;
}

/**
 * Where a reconciliation pass ended up. Always one of these; never nothing.
 */
export type ReconcilePendingState =
  /** Nothing has ever been marked on this trip. */
  | 'no_actions'
  /** Marks exist and no provisional board does, so nothing can be reconciled. */
  | 'no_board'
  /** Nothing has been compiled yet. The marks stay `pending`, which is true. */
  | 'awaiting_compiled_region'
  /** A region is selected and its stored artifact will not parse. */
  | 'compiled_region_unreadable'
  /** The account already covers this artifact and nothing is outstanding. */
  | 'already_current'
  /** An account was written and every pending action is now accounted for. */
  | 'reconciled'
  /** Somebody else wrote a newer account while this pass was assembling one. */
  | 'lost_to_newer_writer';

export interface ReconcilePendingResult {
  state: ReconcilePendingState;
  compiledRegionId?: string;
  reconciliationVersion?: number;
  /** Actions this pass moved out of `pending`. */
  reconciledActions: number;
  /** Actions still `pending` afterwards. */
  pendingActions: number;
}

export interface ReconcilePendingInput {
  tripId: string;
  now: Date;
  /**
   * The artifact a build has just committed.
   *
   * Omitted, the trip's currently selected artifact is used — which is what a
   * mark made later needs, since by then the build that produced it is over.
   */
  compiledRegionId?: string;
  /**
   * What that build concluded: removals and their causes, duplicate
   * resolutions, and cards whose verified details moved.
   *
   * Supplied by a build, persisted with the account, and read back from the
   * account for every later pass against the same artifact. Without persisting
   * it a mark made a minute after the build could only ever resolve to the
   * honest default — so somebody who pinned a museum that is shut on their dates
   * would be told "nobody publishes enough about it", which is both wrong and
   * unhelpful.
   */
  basis?: ReconciliationBasis;
}

/**
 * ACCOUNTS FOR EVERY OUTSTANDING MARK, AND CAN BE RUN AGAIN SAFELY.
 *
 * Synchronous and transactional, so the read of the pending set and the write of
 * the account cannot be separated by anything. Idempotent: a second call with
 * nothing pending writes nothing at all and reports the account already current.
 *
 * The three moments it has to be right about:
 *
 *   - **before** a final board exists — every action stays `pending`, and that
 *     is reported rather than being an absence somebody has to notice;
 *   - **when one arrives** — every pending action is accounted for in one
 *     transaction, and the account carries the version it was written at;
 *   - **after** — a mark made later is pending again, this call runs again from
 *     the selection write, and the account is rewritten at a higher version with
 *     the prior one moved into history.
 *
 * A *superseding* artifact reopens every action that was reconciled against the
 * old one. Not the superseded and withdrawn ones: those were replaced or taken
 * back by the traveller, and re-accounting for them would resurrect opinions
 * they had already moved on from.
 */
export function reconcilePendingActions(input: ReconcilePendingInput): ReconcilePendingResult {
  const db = getDb();
  const run = db.transaction((): ReconcilePendingResult => {
    const { tripId, now } = input;
    const pendingBefore = pendingActionCount(tripId);
    const counts = actionStateCounts(tripId);
    const account = accountRow(db, tripId);

    /*
     * A database written before `provisional_actions` existed holds selections
     * and no actions at all. Those marks are real and still have to be
     * accounted for, so the "nothing has ever been marked" test looks at both
     * tables. Nothing backfills an action row for them: inventing an event with
     * a recorded time nobody observed would be rewriting history to make a
     * query tidier.
     */
    const selectionCount =
      db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM provisional_selections WHERE trip_id = ?',
        )
        .get(tripId)?.n ?? 0;

    if (counts.total === 0 && selectionCount === 0 && !account) {
      return { state: 'no_actions', reconciledActions: 0, pendingActions: 0 };
    }

    const regionId = input.compiledRegionId ?? selectedRegionId(tripId);
    if (!regionId) {
      return {
        state: 'awaiting_compiled_region',
        reconciledActions: 0,
        pendingActions: pendingBefore,
      };
    }

    const superseding = account !== undefined && account.compiled_region_id !== regionId;
    if (superseding) reopenReconciledActions(db, tripId);

    const pending = pendingActionCount(tripId);
    if (
      !superseding &&
      pending === 0 &&
      account !== undefined &&
      account.compiled_region_id === regionId
    ) {
      return {
        state: 'already_current',
        compiledRegionId: regionId,
        reconciliationVersion: account.reconciliation_version,
        reconciledActions: 0,
        pendingActions: 0,
      };
    }

    const board = getProvisionalBoard(tripId);
    if (!board) {
      return { state: 'no_board', reconciledActions: 0, pendingActions: pending };
    }

    const final = finalBoardFor(regionId);
    if (!final) {
      return {
        state: 'compiled_region_unreadable',
        compiledRegionId: regionId,
        reconciledActions: 0,
        pendingActions: pending,
      };
    }

    /*
     * The conclusions of the run that produced this artifact. Handed in by a
     * build; read back off the stored account for every later pass against the
     * same artifact; empty when a superseding artifact arrives without one, in
     * which case removals resolve to the honest default rather than borrowing
     * the previous build's reasons.
     */
    const basis =
      input.basis ??
      (account && account.compiled_region_id === regionId
        ? storedBasis(account.payload_json)
        : EMPTY_BASIS);

    const nextVersion = (account?.reconciliation_version ?? 0) + 1;

    const reconciliation = reconcileBoard({
      board,
      selections: getProvisionalSelections(tripId),
      finalPlaceIds: final.placeIds,
      basis,
      namesById: final.namesById,
      compiledRegionId: regionId,
      reconciliationVersion: nextVersion,
      now,
    });

    if (!saveReconciliation(reconciliation, now)) {
      return {
        state: 'lost_to_newer_writer',
        compiledRegionId: regionId,
        reconciledActions: 0,
        pendingActions: pendingActionCount(tripId),
      };
    }

    const moved = db
      .prepare(
        `UPDATE provisional_actions
            SET reconciliation_state = 'reconciled',
                reconciled_region_id = ?,
                reconciled_at        = ?
          WHERE trip_id = ? AND reconciliation_state = 'pending'`,
      )
      .run(regionId, now.toISOString(), tripId);

    db.prepare(
      `UPDATE provisional_selections
          SET reconciliation_state = 'reconciled',
              reconciled_region_id = ?,
              reconciled_at        = ?
        WHERE trip_id = ?`,
    ).run(regionId, now.toISOString(), tripId);

    return {
      state: 'reconciled',
      compiledRegionId: regionId,
      reconciliationVersion: nextVersion,
      reconciledActions: moved.changes,
      pendingActions: pendingActionCount(tripId),
    };
  });
  return run();
}

/**
 * Which artifact this trip is currently pointed at.
 *
 * One column, read directly rather than through the intent record. The intent
 * record parses a clarification set, a resolution and a scope, any one of which
 * can fail to parse on an old row — and none of which has anything to do with
 * which artifact is selected. Threading the reconciliation through them would
 * mean an unrelated malformed blob silently leaves every mark pending.
 */
function selectedRegionId(tripId: string): string | null {
  return (
    getDb()
      .prepare<[string], { selected_compiled_region_id: string | null }>(
        'SELECT selected_compiled_region_id FROM trip_intents WHERE trip_id = ?',
      )
      .get(tripId)?.selected_compiled_region_id ?? null
  );
}

/**
 * WHAT THE FINAL BOARD HOLDS, READ AS A PROJECTION RATHER THAN AS AN ARTIFACT.
 *
 * Reconciliation needs two things from a compiled region: which identities
 * reached the plan, and what they are called. It does not need the routing
 * matrix, the coverage report or the evidence layer, and making it parse all of
 * them would mean an artifact one unrelated schema change away from unreadable
 * takes the *explanation* of every removal down with it — on a screen whose only
 * job is to account for what happened.
 *
 * So this reads the narrowest shape that answers the question. An artifact with
 * no readable identities is `null`, which the caller reports as an explicit
 * state; it never throws out of a read path and it never invents an empty final
 * board, because "nothing survived" and "we cannot read what survived" would
 * otherwise produce the same, devastating, account.
 */
const finalBoardShape = z.object({
  places: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .default([]),
});

interface FinalBoardProjection {
  placeIds: ReadonlySet<string>;
  namesById: ReadonlyMap<string, string>;
}

function finalBoardFor(compiledRegionId: string): FinalBoardProjection | null {
  const row = getDb()
    .prepare<[string], { payload_json: string }>(
      'SELECT payload_json FROM compiled_regions WHERE id = ?',
    )
    .get(compiledRegionId);
  if (!row) return null;
  try {
    const parsed = finalBoardShape.safeParse(JSON.parse(row.payload_json));
    if (!parsed.success) return null;
    return {
      placeIds: new Set(parsed.data.places.map((place) => place.id)),
      namesById: new Map(parsed.data.places.map((place) => [place.id, place.name])),
    };
  } catch {
    return null;
  }
}

function reopenReconciledActions(db: Db, tripId: string): void {
  db.prepare(
    `UPDATE provisional_actions
        SET reconciliation_state = 'pending', reconciled_region_id = NULL, reconciled_at = NULL
      WHERE trip_id = ? AND reconciliation_state = 'reconciled'`,
  ).run(tripId);
  db.prepare(
    `UPDATE provisional_selections
        SET reconciliation_state = 'pending', reconciled_region_id = NULL, reconciled_at = NULL
      WHERE trip_id = ?`,
  ).run(tripId);
}

/** A stored account's basis, or an empty one. Never a throw out of a read. */
function storedBasis(payload: string): ReconciliationBasis {
  try {
    const value = JSON.parse(payload) as { basis?: unknown };
    const parsed = reconciliationBasisSchema.safeParse(value.basis ?? {});
    return parsed.success ? parsed.data : EMPTY_BASIS;
  } catch {
    return EMPTY_BASIS;
  }
}

// ---------------------------------------------------------------------------
// Acknowledgements
// ---------------------------------------------------------------------------

/**
 * WHO SAW WHAT.
 *
 * A pinned place that was removed and scrolled past unread is, from the
 * traveller's side, the same event as one that was removed silently. The panel
 * therefore demands an acknowledgement for those rows, and this is where the
 * answer lives.
 *
 * Stored in its own column rather than inside the reconciliation payload, and
 * keyed on the compiled region it refers to. An acknowledgement of last week's
 * compilation does not carry over to this one — otherwise a rebuild would
 * suppress its own bad news, which is the failure mode the whole panel exists to
 * prevent, reintroduced through the back door.
 *
 * Null rather than an empty object when nothing has been acknowledged: an empty
 * object would claim the panel had been shown and nothing needed reading, and
 * those are different states.
 */
export function getAcknowledgements(tripId: string): BoardAcknowledgements | null {
  const row = getDb()
    .prepare<[string], { acknowledged_json: string | null }>(
      'SELECT acknowledged_json FROM board_reconciliations WHERE trip_id = ?',
    )
    .get(tripId);
  if (!row?.acknowledged_json) return null;
  try {
    const parsed = boardAcknowledgementsSchema.safeParse(JSON.parse(row.acknowledged_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Records one acknowledgement, replacing any earlier one for the same place.
 *
 * Transactional, and it returns whether it matched. It used to be a
 * read-modify-write with an unconditional `UPDATE … WHERE trip_id = ?` and a
 * `void` return, so acknowledging an entry on a trip whose account had since
 * been replaced — or removed — reported success having written nothing, and the
 * row stayed marked unread with a confirmation on screen saying otherwise.
 *
 * The `compiled_region_id` in the predicate is doing real work: it refuses the
 * write outright when the account on disk is about a different build, rather
 * than attaching an acknowledgement of build 1's removal to build 2's account.
 *
 * A whole-set replacement when the compiled region changes rather than a merge:
 * acknowledgements are about one account of one compilation, and merging across
 * builds is exactly how a stale acknowledgement silences a fresh removal.
 */
export function acknowledgeReconciliationEntry(
  tripId: string,
  compiledRegionId: string,
  entry: BoardAcknowledgement,
): boolean {
  const db = getDb();
  const write = db.transaction((): boolean => {
    const row = db
      .prepare<[string, string], { acknowledged_json: string | null }>(
        `SELECT acknowledged_json FROM board_reconciliations
          WHERE trip_id = ? AND compiled_region_id = ?`,
      )
      .get(tripId, compiledRegionId);
    if (!row) return false;

    let carried: BoardAcknowledgement[] = [];
    if (row.acknowledged_json) {
      try {
        const parsed = boardAcknowledgementsSchema.safeParse(JSON.parse(row.acknowledged_json));
        if (parsed.success && parsed.data.compiledRegionId === compiledRegionId) {
          carried = parsed.data.entries;
        }
      } catch {
        carried = [];
      }
    }

    const next = boardAcknowledgementsSchema.parse({
      tripId,
      compiledRegionId,
      entries: [
        ...carried.filter((candidate) => candidate.placeId !== entry.placeId),
        entry,
      ].sort((a, b) => a.placeId.localeCompare(b.placeId)),
    });

    const result = db
      .prepare(
        `UPDATE board_reconciliations SET acknowledged_json = ?
          WHERE trip_id = ? AND compiled_region_id = ?`,
      )
      .run(JSON.stringify(next), tripId, compiledRegionId);
    return result.changes > 0;
  });
  return write();
}
