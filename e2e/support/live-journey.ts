/**
 * THE LIVE JOURNEY, AS A MEASURING INSTRUMENT.
 *
 * This module exists because the previous live harness reported five values that
 * were not product results, and nobody could tell from the report that they were
 * not. Against two ten-minute compiles — New York and Bali — it wrote:
 *
 *     timeToProvisionalBoardMs: null
 *     provisionalCards: 0
 *     boardCards: 0
 *     reconciliationShown: false
 *     weatherState: null
 *
 * Every one of those was an instrument fault, and two of them were faults that
 * *looked exactly like* the product failing:
 *
 *   1. **The provisional watch was shorter than the thing it was watching.**
 *      300 attempts at 2 s is a ten-minute window, and the compiles it was
 *      pointed at took 625 s and 617 s of compile time on top of composer,
 *      preflight and scope. It stopped looking before the artifact was emitted.
 *      For New York the board *was* persisted — 45 cards, version 1, later
 *      confirmed by hand in the database — while the harness reported nothing.
 *
 *   2. **It measured a redirect and called it a board.** `/discover` redirects
 *      to the questionnaire when a trip has no profile. The harness never
 *      completed one, so `boardCards`, `reconciliationShown` and `weatherState`
 *      were all read off the questionnaire screen. A redirect is not a low
 *      score; it is a measurement that did not happen.
 *
 *   3. **It counted with a role the page has never rendered.** Provisional cards
 *      are `data-testid="provisional-card"` on a panel `div`;
 *      `getByRole('article')` matches none of them. That is the same defect
 *      already recorded against the shortlist, in a second place.
 *
 *   4. **Unavailable measurements were serialised as zero.** `.catch(() => 0)`
 *      and `.catch(() => false)` turn "the instrument failed" into "the product
 *      produced nothing", and the two are indistinguishable downstream.
 *
 *   5. **The throwaway database was deleted before the assertions were done.**
 *      Bali's board-level behaviour is permanently unverifiable for that run.
 *
 * The corrections here are generic rather than per-destination:
 *
 *   - **Milestones are polled on persisted artifacts**, not on page timing, and
 *     the provisional board is detected independently of the compile finishing.
 *   - **The evaluation deadline is bounded and explicit**, derived in one place
 *     from a budget whose invariants are checkable, and it can never be shorter
 *     than the compile it contains.
 *   - **`Measured<T>` runs all the way down to the driver.** There is no place in
 *     the port surface where an adapter can hand back a bare `0`, `null`, `-1` or
 *     `false` in a slot where a measurement belongs — the compiler rejects it.
 *     A `not_measured` carries a *typed* reason, and it does not carry a value at
 *     all, so nothing downstream can read a substituted default out of one.
 *   - **A redirect is a harness failure**, recorded with its status and final
 *     URL, and it blocks exactly the fields downstream of it rather than
 *     scoring them. A navigation that never completed is a third thing again:
 *     whether that route redirects is then *unknown*, not `true`.
 *   - **A failed UI assertion cannot erase a compile metric** — blocking writes
 *     only into fields nothing has measured yet.
 *   - **Teardown runs after publication, never before**, and paid spend is read
 *     on every terminal path including the failed ones.
 *
 * Deliberately dependency-free. No Playwright, no sqlite, no `@sidequest/core`:
 * everything the journey touches arrives through a port, which is what lets the
 * whole thing run offline against fakes in `e2e/live/harness.test.ts`, and what
 * lets `e2e/live/phase-12.eval.ts` stay a thin adapter over real ones.
 */

/**
 * Bumped from 2 when `Measured<T>` reached the driver port and the serialised
 * shape changed: a `not_measured` no longer carries a `value` key of any kind,
 * so a reader cannot pull a null — let alone a zero — out of an absence.
 */
export const HARNESS_VERSION = '3';

// ---------------------------------------------------------------------------
// MEASUREMENTS — the "not measured" / "measured zero" distinction, made structural
// ---------------------------------------------------------------------------

/**
 * WHY A MEASUREMENT IS ABSENT, FROM A CLOSED VOCABULARY.
 *
 * A free-text sentence was the previous version of this, and a free-text
 * sentence cannot be grouped, counted, or asserted on without a regular
 * expression. More to the point it cannot be *reviewed*: "we did not measure
 * this" and "we could not reach the page" and "the page was there and the markup
 * was not" are three different findings with three different owners, and a
 * paragraph flattens them into one.
 *
 * Every code names a distinct failure of the instrument, not of the product:
 *
 *   - `navigation_failed`     the browser never completed the navigation, so
 *                             nothing at all is known about that surface —
 *                             including whether it redirects.
 *   - `redirected_away`       the navigation completed somewhere else, so every
 *                             reading on that page would describe a different
 *                             page.
 *   - `deadline_expired`      the wait window closed before the surface or the
 *                             artifact appeared. A deadline, never a duration.
 *   - `markup_absent`         the surface rendered, and the markup being counted
 *                             was not in it. Distinct from a count of zero: the
 *                             container has to be present for zero to mean zero.
 *   - `response_absent`       the navigation completed without a document
 *                             response — a same-document navigation has no HTTP
 *                             status, and `-1` is not one either.
 *   - `provider_disabled`     the thing under measurement was switched off for
 *                             this run, so its absence says nothing about it.
 *   - `precondition_failed`   an earlier step did not produce what this step
 *                             needed, so this step was skipped rather than run
 *                             and scored.
 *   - `probe_threw`           the probe itself raised. Recorded with the message,
 *                             because "the database is locked" and "there is no
 *                             board" are not the same report.
 */
export type NotMeasuredCode =
  | 'navigation_failed'
  | 'redirected_away'
  | 'deadline_expired'
  | 'markup_absent'
  | 'response_absent'
  | 'provider_disabled'
  | 'precondition_failed'
  | 'probe_threw';

export interface NotMeasuredReason {
  readonly code: NotMeasuredCode;
  /** What specifically happened, in a sentence somebody can act on. */
  readonly detail: string;
}

/** How each code reads to a person. One place, so every surface says it the same way. */
export const NOT_MEASURED_PHRASES: Record<NotMeasuredCode, string> = {
  navigation_failed: 'the browser never completed the navigation',
  redirected_away: 'redirected away from the surface under test',
  deadline_expired: 'the wait window expired before it appeared',
  markup_absent: 'the surface rendered but the markup being counted was absent',
  response_absent: 'the navigation carried no document response, so there is no status',
  provider_disabled: 'the provider was disabled for this run',
  precondition_failed: 'a precondition failed, so this step was skipped',
  probe_threw: 'the probe raised',
};

/**
 * The `not_measured` arm, on its own and free of the value type.
 *
 * Standalone so `notMeasured(...)` is assignable to `Measured<number>`,
 * `Measured<string>` and `Measured<SpendLedger>` alike without a type argument.
 * The alternative — a generic constructor — made every call site restate the
 * type, and a call site that has to restate a type is a call site that will one
 * day restate it wrongly.
 */
export interface NotMeasured {
  readonly state: 'not_measured';
  readonly because: NotMeasuredReason;
}

/**
 * A value this harness reports is either something it saw or something it did
 * not, and the type says which.
 *
 * There is no third state and no default. The `not_measured` arm has **no
 * `value` property at all** — not `0`, not `null` — so a reader that reaches for
 * one gets a compile error rather than a substituted default, and a JSON
 * consumer finds no numeric-looking field to misread.
 */
export type Measured<T> = { readonly state: 'measured'; readonly value: T } | NotMeasured;

/**
 * A measurement that was taken.
 *
 * `null` and `undefined` are refused: "I measured nothing" is the sentence this
 * whole module exists to make unsayable, and the only honest spelling of it is a
 * `notMeasured` with a code.
 */
export function measured<T>(value: T): Measured<T> {
  if (value === null || value === undefined) {
    throw new Error('measured() refuses null/undefined — use notMeasured() with a reason');
  }
  return { state: 'measured', value };
}

export function notMeasured(code: NotMeasuredCode, detail: string): NotMeasured {
  if (detail.trim().length === 0) {
    // An unexplained absence is the thing this module exists to prevent, so the
    // one way to produce one is closed rather than documented.
    throw new Error('notMeasured() requires a detail — an unexplained absence is a defect');
  }
  return { state: 'not_measured', because: { code, detail } };
}

export function isMeasured<T>(
  measurement: Measured<T>,
): measurement is { readonly state: 'measured'; readonly value: T } {
  return measurement.state === 'measured';
}

/** The value if it was measured, `null` otherwise. Never a substituted default. */
export function valueOf<T>(measurement: Measured<T>): T | null {
  return measurement.state === 'measured' ? measurement.value : null;
}

/** Derive one measurement from another without inventing a value for an absence. */
export function mapMeasured<T, U>(
  measurement: Measured<T>,
  transform: (value: T) => U,
): Measured<U> {
  return measurement.state === 'measured' ? measured(transform(measurement.value)) : measurement;
}

/**
 * Bridge a port that answers `T | null` — a SQL row that is not there, say —
 * into a measurement with a typed reason for the absence.
 */
export function fromNullable<T>(
  value: T | null | undefined,
  code: NotMeasuredCode,
  detail: string,
): Measured<T> {
  return value === null || value === undefined ? notMeasured(code, detail) : measured(value);
}

/**
 * JSON shape.
 *
 * The two arms share no keys beyond `state`. A `not_measured` serialises with a
 * typed reason and a rendered sentence and *nothing that reads as data* — which
 * is the point: `JSON.stringify` of an absence must not produce something a
 * spreadsheet would happily plot.
 */
export type SerialisedMeasurement =
  | { readonly state: 'measured'; readonly value: unknown }
  | {
      readonly state: 'not_measured';
      readonly because: NotMeasuredReason;
      /** The same fact as prose, so a reader skimming JSON cannot miss it. */
      readonly reads: string;
    };

export function serialise<T>(measurement: Measured<T>): SerialisedMeasurement {
  return measurement.state === 'measured'
    ? { state: 'measured', value: measurement.value }
    : {
        state: 'not_measured',
        because: measurement.because,
        reads: renderAbsence(measurement.because),
      };
}

export function renderAbsence(because: NotMeasuredReason): string {
  return `not measured (${NOT_MEASURED_PHRASES[because.code]}) — ${because.detail}`;
}

/** A compact, unambiguous rendering of a measured value for a one-line report. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * One field, one line, and an absence that can never be mistaken for a number.
 *
 * `provisionalCards: not measured (redirected away from the surface under test)
 * — requested /trips/x/discover, landed on /trips/x/questionnaire`.
 */
export function renderMeasurement<T>(field: string, measurement: Measured<T>): string {
  return measurement.state === 'measured'
    ? `${field}: ${renderValue(measurement.value)}`
    : `${field}: ${renderAbsence(measurement.because)}`;
}

/** The same, over a record of them — the printable form of a whole report. */
export function renderMeasurements(
  measurements: Record<string, SerialisedMeasurement>,
): readonly string[] {
  return Object.keys(measurements)
    .sort()
    .map((field) => {
      const entry = measurements[field]!;
      return entry.state === 'measured'
        ? `${field}: ${renderValue(entry.value)}`
        : `${field}: ${entry.reads}`;
    });
}

// ---------------------------------------------------------------------------
// THE FIELD MANIFEST
// ---------------------------------------------------------------------------

/**
 * Every field this journey is expected to produce, named up front.
 *
 * The manifest is what stops an unreached step from being silently absent. A
 * field nobody measured is filled in at publication as a `not_measured` with
 * code `precondition_failed` — which is a different statement from `0`, and the
 * only honest one available.
 */
export const EXPECTED_FIELDS: readonly (readonly [string, string])[] = [
  ['tripId', 'the trip this journey created'],
  ['indexSuggestion', 'whether the destination index offered a suggestion'],
  ['timeToPreflightMs', 'composer submit → preflight rendered'],
  ['reachedScope', 'whether the scope screen was reached'],
  ['timeToProvisionalBoardMs', 'build started → provisional board persisted'],
  ['provisionalBoardVersion', 'version of the persisted provisional board'],
  ['provisionalBoardCardsPersisted', 'cards on the board as stored'],
  ['provisionalRouteRedirected', 'whether /provisional redirected'],
  ['provisionalCardsRendered', 'cards the provisional route rendered'],
  ['provisionalBoardVersionAgrees', 'rendered board version === persisted version'],
  ['provisionalMarksApplied', 'test interactions applied to provisional cards'],
  ['compileMs', 'build started → job reached a terminal state'],
  ['compileState', 'the terminal job state (ready, partial, failed, cancelled)'],
  ['compileErrorCode', 'the job error code, when it has one'],
  ['profileCompleted', 'whether the questionnaire was completed'],
  ['discoverRouteRedirected', 'whether /discover redirected'],
  ['boardCards', 'cards the discovery board rendered'],
  ['boardVersion', 'board version stamped on the discovery board'],
  ['boardSummary', 'the discovery board summary line'],
  ['reconciliationShown', 'whether the reconciliation panel rendered'],
  ['reconciliationVersion', 'persisted reconciliation version'],
  ['pinnedRemovals', 'pinned losses rendered with a reason'],
  ['weatherState', 'the weather panel text'],
  ['weatherSnapshotStatus', 'persisted weather snapshot status'],
  ['itineraryRouteStatus', 'HTTP status of /itinerary'],
  ['itineraryDays', 'days on the persisted itinerary'],
  ['stageObservations', 'stage observations recorded during the run'],
  ['spend', 'paid spend, read from the ledger'],
  ['consoleErrors', 'console and page errors seen by the browser'],
];

// ---------------------------------------------------------------------------
// THE EVALUATION BUDGET
// ---------------------------------------------------------------------------

/**
 * A bounded, explicit deadline for every wait in the journey.
 *
 * Bounded because an unbounded live evaluation is a way to spend money in your
 * sleep. Explicit because the previous version's ten-minute provisional window
 * was not a decision anybody made — it was `300` and `2_000` sitting next to
 * each other in a loop, and it happened to be shorter than the product.
 *
 * The numbers are set against measured reality with headroom: the longest live
 * compiles recorded were 625 s (New York) and 617 s (Bali), so a 45-minute
 * compile deadline is roughly four times the worst observed case. It is a
 * ceiling on how long the harness will *wait*, not a claim about how long a
 * compile *should* take: exceeding it is reported as `deadline_expired`, never
 * as a product timing.
 */
export interface EvaluationBudget {
  readonly tripCreationMs: number;
  readonly preflightMs: number;
  readonly scopeMs: number;
  /** The compile deadline. Everything inside a build is bounded by this. */
  readonly compileMs: number;
  /**
   * How much longer the provisional watch may run *after* the compile is
   * terminal. Small and non-zero: the board is written before the expensive
   * work, so if it is not there when the job ends it is not coming — but a
   * commit and a job-state write are two statements, and the grace covers the
   * gap between them rather than hiding it.
   */
  readonly provisionalGraceMs: number;
  readonly profileMs: number;
  readonly pollIntervalMs: number;
}

export const DEFAULT_BUDGET: EvaluationBudget = {
  tripCreationMs: 90_000,
  preflightMs: 180_000,
  scopeMs: 180_000,
  compileMs: 45 * 60_000,
  provisionalGraceMs: 20_000,
  profileMs: 120_000,
  pollIntervalMs: 2_000,
};

/**
 * THE PROVISIONAL DEADLINE IS DERIVED, NOT DECLARED.
 *
 * There is deliberately no `provisionalMs` field to set independently. The
 * original defect was exactly an independent provisional window that drifted
 * shorter than the compile it lived inside; making it a function of the compile
 * deadline means that cannot recur by editing one constant.
 */
export function provisionalDeadline(budget: EvaluationBudget): number {
  return budget.compileMs + budget.provisionalGraceMs;
}

/** Budget rules that must hold. Returned rather than thrown so they are testable. */
export function budgetViolations(budget: EvaluationBudget): string[] {
  const violations: string[] = [];
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value <= 0) violations.push(`${name} must be a positive number`);
  }
  if (provisionalDeadline(budget) <= budget.compileMs) {
    violations.push('the provisional watch must outlast the compile it is watching');
  }
  if (budget.pollIntervalMs > budget.compileMs / 10) {
    violations.push('the poll interval is too coarse to resolve the compile deadline');
  }
  return violations;
}

/** Overrides from the environment, for a destination that legitimately runs long. */
export function budgetFromEnv(env: Record<string, string | undefined>): EvaluationBudget {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    tripCreationMs: read('SIDEQUEST_EVAL_TRIP_MS', DEFAULT_BUDGET.tripCreationMs),
    preflightMs: read('SIDEQUEST_EVAL_PREFLIGHT_MS', DEFAULT_BUDGET.preflightMs),
    scopeMs: read('SIDEQUEST_EVAL_SCOPE_MS', DEFAULT_BUDGET.scopeMs),
    compileMs: read('SIDEQUEST_EVAL_COMPILE_MS', DEFAULT_BUDGET.compileMs),
    provisionalGraceMs: read('SIDEQUEST_EVAL_GRACE_MS', DEFAULT_BUDGET.provisionalGraceMs),
    profileMs: read('SIDEQUEST_EVAL_PROFILE_MS', DEFAULT_BUDGET.profileMs),
    pollIntervalMs: read('SIDEQUEST_EVAL_POLL_MS', DEFAULT_BUDGET.pollIntervalMs),
  };
}

// ---------------------------------------------------------------------------
// PORTS
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * ONE NAVIGATION, WITH WHAT ACTUALLY HAPPENED TO IT.
 *
 * A union rather than a record with nullable fields, because three things can
 * happen and only two of them used to be representable:
 *
 *   - it landed where we aimed it;
 *   - it landed somewhere else — `finalPath` is separate from `requested`
 *     because the whole board-level gap was a navigation that succeeded,
 *     returned 200, and landed on the questionnaire;
 *   - **it never completed at all**, which the old shape wrote down as
 *     `status: null, finalPath: <whatever the browser still had open>,
 *     redirected: true` — and the journey then published
 *     `provisionalRouteRedirected: observed true`. A failed navigation was
 *     reported as an *observed redirect*. It is not one: after a failed
 *     navigation nobody knows whether that route redirects.
 */
export type RouteVisit =
  | {
      readonly outcome: 'navigated';
      readonly requested: string;
      readonly finalPath: string;
      /** The final document's status. Absent for a same-document navigation. */
      readonly status: Measured<number>;
      readonly redirected: boolean;
    }
  | {
      readonly outcome: 'navigation_failed';
      readonly requested: string;
      /** Why the browser never completed it. Carried into every blocked field. */
      readonly detail: string;
    };

/** Whether this navigation ended somewhere other than where it was aimed. */
export function redirection(visit: RouteVisit): Measured<boolean> {
  return visit.outcome === 'navigated'
    ? measured(visit.redirected)
    : notMeasured(
        'navigation_failed',
        `${visit.requested} never loaded (${visit.detail}) — whether that route redirects is unknown, which is neither true nor false`,
      );
}

export interface PersistedJob {
  readonly id: string;
  readonly state: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}

export interface PersistedBoard {
  readonly boardId: string;
  readonly version: number;
  readonly cardCount: number;
  readonly createdAt: string;
}

export interface SpendLedger {
  /** Which ledgers answered. Named so a partial read is visible as one. */
  readonly sources: readonly string[];
  readonly counters: Record<string, number>;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicroUsd: number;
}

/**
 * The persisted side of the product.
 *
 * Every milestone in this journey is a question about a row, because a row is
 * the only thing that survives a page that navigated away, a watcher context
 * that closed, and a poll that was looking at the wrong screen. These stay
 * `T | null` — a query that returns no row is unambiguous, and the journey turns
 * each `null` into a typed reason at the point where it knows what the absence
 * means.
 */
export interface JourneyStore {
  latestJob(tripId: string): PersistedJob | null;
  provisionalBoard(tripId: string): PersistedBoard | null;
  reconciliation(tripId: string): { version: number; pendingActions: number } | null;
  weatherSnapshot(tripId: string): { status: string; fetchedAt: string } | null;
  itinerary(tripId: string): { id: string; days: number } | null;
  spend(tripId: string): SpendLedger | null;
  stageObservations(): number;
  close(): void;
}

/** What the harness counts. Semantics here; selectors in the adapter. */
export type CountableKind = 'provisional_card' | 'board_card' | 'pinned_removal';

/** What the harness looks for. Same split, same reason. */
export type PanelKind =
  | 'provisional_board'
  | 'discovery_board'
  | 'board_summary'
  | 'reconciliation_panel'
  | 'weather_snapshot';

export interface TripSpec {
  readonly destination: string;
  readonly start: string;
  readonly end: string;
  readonly themes: readonly string[];
  readonly transport: string;
}

/**
 * THE BROWSER SIDE. EVERY METHOD MAY FAIL; NONE OF THEM MAY LIE.
 *
 * Every observation is a `Measured<T>`. That is the correction, and it is a
 * correction to the *type*, not to the adapter: while `count()` returned
 * `Promise<number | null>` an adapter could — and did — write
 * `if (total === 0) return 0` on a page that had never rendered the container,
 * and nothing downstream could tell that apart from a board with no cards. With
 * `Promise<Measured<number>>` the substituted default is not expressible: `0`
 * alone does not typecheck, and `measured(0)` is a claim the adapter has to be
 * willing to make.
 */
export interface JourneyDriver {
  createTrip(
    spec: TripSpec,
  ): Promise<{ tripId: Measured<string>; indexSuggestion: Measured<boolean> }>;
  reachScope(
    strategy: string,
  ): Promise<{ reached: Measured<boolean>; preflightMs: Measured<number> }>;
  startCompilation(): Promise<Measured<boolean>>;
  completeProfile(): Promise<Measured<boolean>>;
  visit(path: string): Promise<RouteVisit>;
  count(kind: CountableKind): Promise<Measured<number>>;
  present(kind: PanelKind): Promise<Measured<boolean>>;
  text(kind: PanelKind): Promise<Measured<string>>;
  boardVersion(kind: PanelKind): Promise<Measured<number>>;
  markProvisionalCards(limit: number): Promise<Measured<number>>;
  screenshot(name: string): Promise<void>;
  consoleErrors(): readonly string[];
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// MILESTONES
// ---------------------------------------------------------------------------

export interface MilestoneSpec<T> {
  readonly name: string;
  /** Returns the artifact when it exists, `null` while it does not. */
  readonly probe: () => Promise<T | null> | (T | null);
  readonly deadlineMs: number;
  readonly intervalMs: number;
  /**
   * A reason to stop before the deadline that is *not* a timeout.
   *
   * "The compile finished and there is still no board" and "we waited 45 minutes"
   * are different findings and they are reported differently. Returning a reason
   * ends the wait with that reason.
   */
  readonly abortWhen?: () => Promise<NotMeasuredReason | null> | (NotMeasuredReason | null);
}

export interface MilestoneOutcome<T> {
  readonly name: string;
  readonly measured: Measured<T>;
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly endedBy: 'observed' | 'aborted' | 'deadline';
  readonly probeErrors: number;
}

/**
 * Poll a persisted artifact until it exists, the run says it never will, or the
 * bounded deadline passes.
 *
 * The loop is written against `clock.now()` rather than against an attempt count
 * for one reason: an attempt count is a duration only if every attempt takes the
 * time you assumed. The previous harness's 300 attempts at 2 s were not ten
 * minutes — each turn also paid for a full page load, so the real window was
 * longer than the constant said and still shorter than the product, and nobody
 * could work out which from reading it.
 */
export async function awaitMilestone<T>(
  clock: Clock,
  spec: MilestoneSpec<T>,
): Promise<MilestoneOutcome<T>> {
  const started = clock.now();
  let attempts = 0;
  let probeErrors = 0;
  let lastError: string | null = null;

  for (;;) {
    attempts += 1;
    try {
      const found = await spec.probe();
      if (found !== null && found !== undefined) {
        return {
          name: spec.name,
          measured: measured(found),
          elapsedMs: clock.now() - started,
          attempts,
          endedBy: 'observed',
          probeErrors,
        };
      }
    } catch (error) {
      probeErrors += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (spec.abortWhen) {
      let abort: NotMeasuredReason | null = null;
      try {
        abort = await spec.abortWhen();
      } catch (error) {
        probeErrors += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (abort !== null) {
        return {
          name: spec.name,
          measured: notMeasured(abort.code, abort.detail),
          elapsedMs: clock.now() - started,
          attempts,
          endedBy: 'aborted',
          probeErrors,
        };
      }
    }

    const elapsed = clock.now() - started;
    if (elapsed >= spec.deadlineMs) {
      const suffix =
        probeErrors > 0 ? `; ${probeErrors} probe error(s), last: ${lastError ?? 'unknown'}` : '';
      return {
        name: spec.name,
        measured: notMeasured(
          'deadline_expired',
          `milestone "${spec.name}" was not observed within its ${Math.round(
            spec.deadlineMs / 1000,
          )}s evaluation deadline after ${attempts} probes${suffix} — this is a deadline, not a product result`,
        ),
        elapsedMs: elapsed,
        attempts,
        endedBy: 'deadline',
        probeErrors,
      };
    }

    await clock.sleep(spec.intervalMs);
  }
}

/**
 * The terminal compile states, copied rather than imported.
 *
 * `@sidequest/core` owns the vocabulary and this module deliberately imports
 * nothing, so the list is duplicated with the reason written down: an evaluation
 * harness that fails to build because a package moved is an evaluation that does
 * not run. `partial` is terminal and is not failure — a region that finished
 * with its gaps enumerated is a result this harness must be able to report.
 */
export const TERMINAL_COMPILE_STATES: readonly string[] = [
  'ready',
  'partial',
  'failed',
  'cancelled',
];

export function isTerminalCompileState(state: string): boolean {
  return TERMINAL_COMPILE_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// THE RECORDER
// ---------------------------------------------------------------------------

export interface HarnessFailure {
  readonly kind:
    | 'unexpected_redirect'
    | 'navigation_failed'
    | 'step_threw'
    | 'driver_refused'
    | 'milestone_missed'
    | 'publication_failed'
    | 'report_integrity';
  readonly step: string;
  readonly detail: string;
  readonly route?: RouteVisit;
}

export interface FinalReport {
  readonly harnessVersion: string;
  readonly destination: string;
  readonly slug: string;
  readonly start: string;
  readonly end: string;
  readonly strategy: string;
  readonly budget: EvaluationBudget;
  readonly measurements: Record<string, SerialisedMeasurement>;
  readonly milestones: Record<
    string,
    { elapsedMs: number; attempts: number; endedBy: string; probeErrors: number; measured: boolean }
  >;
  readonly routeVisits: readonly RouteVisit[];
  readonly harnessFailures: readonly HarnessFailure[];
  /** Fields with no measurement, and why. The honest half of the report. */
  readonly notMeasured: readonly { field: string; because: NotMeasuredReason; reads: string }[];
  /** Broken invariants in the report itself. Non-empty means do not trust it. */
  readonly integrity: readonly string[];
  readonly ok: boolean;
}

/**
 * Accumulates the report, and refuses to let a later step overwrite an earlier
 * measurement with a blank.
 *
 * `record` is for something that was measured. `blockIfAbsent` is for the fields
 * downstream of a failure. The split is the mechanism behind "one missing UI
 * assertion cannot erase valid compile metrics": blocking can only write where
 * nothing has been written.
 */
export class JourneyRecorder {
  private readonly fields = new Map<string, Measured<unknown>>();
  private readonly milestones = new Map<string, MilestoneOutcome<unknown>>();
  private readonly visits: RouteVisit[] = [];
  private readonly failures: HarnessFailure[] = [];

  record<T>(field: string, measurement: Measured<T>): Measured<T> {
    this.fields.set(field, measurement as Measured<unknown>);
    return measurement;
  }

  /** Record a value a `T | null` port may have refused to produce. */
  recordMaybe<T>(
    field: string,
    value: T | null | undefined,
    code: NotMeasuredCode,
    detail: string,
  ): Measured<T> {
    return this.record(field, fromNullable(value, code, detail));
  }

  blockIfAbsent(fields: readonly string[], code: NotMeasuredCode, detail: string): void {
    for (const field of fields) {
      if (!this.fields.has(field)) this.fields.set(field, notMeasured(code, detail));
    }
  }

  has(field: string): boolean {
    return this.fields.has(field);
  }

  /** The measurement, or `undefined` if nothing has been recorded for it yet. */
  get<T>(field: string): Measured<T> | undefined {
    return this.fields.get(field) as Measured<T> | undefined;
  }

  milestone<T>(outcome: MilestoneOutcome<T>): MilestoneOutcome<T> {
    this.milestones.set(outcome.name, outcome as MilestoneOutcome<unknown>);
    if (outcome.measured.state === 'not_measured') {
      this.failures.push({
        kind: 'milestone_missed',
        step: outcome.name,
        detail: renderAbsence(outcome.measured.because),
      });
    }
    return outcome;
  }

  visit(visit: RouteVisit): RouteVisit {
    this.visits.push(visit);
    return visit;
  }

  fail(failure: HarnessFailure): void {
    this.failures.push(failure);
  }

  /**
   * Close the report.
   *
   * Fills every manifest field nobody measured with a typed absence, walks the
   * result for the one invariant this whole module exists to hold, and says
   * plainly whether the report can be trusted.
   */
  finalise(context: {
    destination: string;
    slug: string;
    start: string;
    end: string;
    strategy: string;
    budget: EvaluationBudget;
  }): FinalReport {
    for (const entry of EXPECTED_FIELDS) {
      const [field, description] = entry;
      if (!this.fields.has(field)) {
        this.fields.set(
          field,
          notMeasured(
            'precondition_failed',
            `the journey never reached the step that measures this (${description}) — no value was observed, and none is being reported`,
          ),
        );
      }
    }

    const measurements: Record<string, SerialisedMeasurement> = {};
    const absent: { field: string; because: NotMeasuredReason; reads: string }[] = [];
    const integrity: string[] = [];

    for (const [field, measurement] of [...this.fields.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )) {
      measurements[field] = serialise(measurement);
      if (measurement.state === 'measured') {
        if (measurement.value === null || measurement.value === undefined) {
          integrity.push(`${field}: marked measured but carries no value`);
        }
      } else {
        absent.push({
          field,
          because: measurement.because,
          reads: renderAbsence(measurement.because),
        });
        if (measurement.because.detail.trim().length === 0) {
          integrity.push(`${field}: not measured, with no detail`);
        }
      }
    }

    for (const violation of budgetViolations(context.budget)) {
      integrity.push(`budget: ${violation}`);
    }
    /*
     * Integrity violations are appended to the *returned* failures rather than
     * pushed onto the recorder, so `finalise` can be called twice — it is, when
     * publication fails and the failure itself has to reach the report — without
     * the second call inventing duplicate findings.
     */
    const failures: HarnessFailure[] = [...this.failures];
    if (integrity.length > 0) {
      failures.push({ kind: 'report_integrity', step: 'finalise', detail: integrity.join('; ') });
    }

    const milestones: FinalReport['milestones'] = {};
    for (const [name, outcome] of this.milestones.entries()) {
      milestones[name] = {
        elapsedMs: outcome.elapsedMs,
        attempts: outcome.attempts,
        endedBy: outcome.endedBy,
        probeErrors: outcome.probeErrors,
        measured: outcome.measured.state === 'measured',
      };
    }

    return {
      harnessVersion: HARNESS_VERSION,
      destination: context.destination,
      slug: context.slug,
      start: context.start,
      end: context.end,
      strategy: context.strategy,
      budget: context.budget,
      measurements,
      milestones,
      routeVisits: [...this.visits],
      harnessFailures: failures,
      notMeasured: absent,
      integrity,
      ok: failures.length === 0,
    };
  }
}

/**
 * The whole report as lines a person reads, absences included and marked.
 *
 * Exported rather than left to each eval script, because "render it legibly" is
 * exactly the kind of thing three call sites do three ways, and one of the three
 * ends up printing `[object Object]` where an absence should be.
 */
export function renderReport(report: FinalReport): readonly string[] {
  return [
    `=== ${report.destination} — harness ${report.harnessVersion} ===`,
    ...renderMeasurements(report.measurements),
    `failures: ${report.harnessFailures.length}`,
    ...report.harnessFailures.map((failure) => `  - [${failure.kind}] ${failure.step}: ${failure.detail}`),
    `not measured: ${report.notMeasured.length}`,
    ...report.notMeasured.map((entry) => `  - ${entry.field}: ${entry.reads}`),
  ];
}

// ---------------------------------------------------------------------------
// THE JOURNEY
// ---------------------------------------------------------------------------

export interface LiveJourneyOptions {
  readonly destination: string;
  readonly slug: string;
  readonly start: string;
  readonly end: string;
  readonly strategy: string;
  readonly transport: string;
  readonly themes: readonly string[];
  /** How many provisional cards to mark, as the test interaction. */
  readonly marks: number;
  readonly budget: EvaluationBudget;
}

export interface LiveJourneyDeps {
  readonly clock: Clock;
  readonly store: JourneyStore;
  readonly driver: JourneyDriver;
  /** Writes the report. Must resolve before anything is destroyed. */
  readonly publish: (report: FinalReport) => Promise<void> | void;
  /**
   * Destroys the throwaway database. Optional, and never called before
   * `publish` has resolved.
   */
  readonly teardown?: () => Promise<void> | void;
}

export interface JourneyRun {
  readonly report: FinalReport;
  readonly published: boolean;
  readonly teardownPerformed: boolean;
  /**
   * What happened, in order.
   *
   * Present in the returned value rather than in a test-only hook because
   * "teardown ran after publication" is a property somebody should be able to
   * check from the outside, on the real run as well as the fake one.
   */
  readonly order: readonly string[];
}

/** Fields that only exist once the provisional route has been opened. */
const PROVISIONAL_ROUTE_FIELDS = [
  'provisionalCardsRendered',
  'provisionalBoardVersionAgrees',
  'provisionalMarksApplied',
];

/** Fields that only exist once `/discover` has rendered a board. */
const BOARD_FIELDS = [
  'boardCards',
  'boardVersion',
  'boardSummary',
  'reconciliationShown',
  'pinnedRemovals',
  'weatherState',
];

/**
 * The whole journey, in the order the requirements name.
 *
 * Each step is wrapped: a step that throws becomes a harness failure and blocks
 * only the fields downstream of itself. Nothing here aborts the run, because the
 * run's most valuable output — the compile metrics and the spend — is produced
 * in the middle and was previously thrown away by a failure at the end.
 */
export async function runLiveJourney(
  deps: LiveJourneyDeps,
  options: LiveJourneyOptions,
): Promise<JourneyRun> {
  const { clock, store, driver } = deps;
  const recorder = new JourneyRecorder();
  const order: string[] = [];

  const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    order.push(name);
    try {
      await run();
      return true;
    } catch (error) {
      recorder.fail({
        kind: 'step_threw',
        step: name,
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  /**
   * Open a route and say both things about it: whether it redirected, and
   * whether anything on it is safe to measure.
   *
   * The two are not the same question, and collapsing them is what published a
   * failed navigation as `provisionalRouteRedirected: true`. `redirection()`
   * answers the first — `not_measured` when the browser never got there.
   * `onTarget` answers the second, and it is false for a redirect, for a failed
   * navigation, and for a 4xx/5xx alike.
   */
  const openExactly = async (
    path: string,
    stepName: string,
  ): Promise<{ visit: RouteVisit; onTarget: boolean }> => {
    const visit = recorder.visit(await driver.visit(path));

    if (visit.outcome === 'navigation_failed') {
      recorder.fail({
        kind: 'navigation_failed',
        step: stepName,
        detail: `${visit.requested} never loaded (${visit.detail}) — nothing on that route was measured, and nothing about it is known`,
        route: visit,
      });
      return { visit, onTarget: false };
    }

    if (visit.redirected || visit.finalPath !== visit.requested) {
      recorder.fail({
        kind: 'unexpected_redirect',
        step: stepName,
        detail: `requested ${visit.requested}, landed on ${visit.finalPath} (status ${
          valueOf(visit.status) ?? 'unknown'
        }) — every measurement on this route would have been describing a different page`,
        route: visit,
      });
      return { visit, onTarget: false };
    }

    const status = valueOf(visit.status);
    if (status !== null && status >= 400) {
      recorder.fail({
        kind: 'driver_refused',
        step: stepName,
        detail: `${visit.requested} answered ${status}`,
        route: visit,
      });
      return { visit, onTarget: false };
    }
    return { visit, onTarget: true };
  };

  let tripId: string | null = null;
  let buildStartedAt: number | null = null;

  // -- 1. create the trip ---------------------------------------------------
  await step('create_trip', async () => {
    const created = await driver.createTrip({
      destination: options.destination,
      start: options.start,
      end: options.end,
      themes: options.themes,
      transport: options.transport,
    });
    recorder.record('indexSuggestion', created.indexSuggestion);
    recorder.record('tripId', created.tripId);
    tripId = valueOf(created.tripId);
  });

  if (tripId === null) {
    recorder.blockIfAbsent(
      EXPECTED_FIELDS.map((entry) => entry[0]),
      'precondition_failed',
      'the trip was never created, so no step after the composer ran',
    );
    return await conclude(deps, recorder, options, order);
  }

  const trip: string = tripId;

  // -- 2/3. preflight, scope, and the build ---------------------------------
  await step('reach_scope', async () => {
    const scope = await driver.reachScope(options.strategy);
    recorder.record('reachedScope', scope.reached);
    recorder.record('timeToPreflightMs', scope.preflightMs);
    if (scope.reached.state !== 'measured' || !scope.reached.value) {
      recorder.fail({
        kind: 'driver_refused',
        step: 'reach_scope',
        detail: 'the scope screen was never reached',
      });
    }
  });

  let started = false;
  await step('start_compilation', async () => {
    const outcome = await driver.startCompilation();
    started = outcome.state === 'measured' && outcome.value;
    if (started) buildStartedAt = clock.now();
    else {
      recorder.fail({
        kind: 'driver_refused',
        step: 'start_compilation',
        detail:
          outcome.state === 'measured'
            ? 'the build was never started'
            : renderAbsence(outcome.because),
      });
    }
  });

  if (!started || buildStartedAt === null) {
    recorder.blockIfAbsent(
      [
        'timeToProvisionalBoardMs',
        'provisionalBoardVersion',
        'provisionalBoardCardsPersisted',
        'provisionalRouteRedirected',
        ...PROVISIONAL_ROUTE_FIELDS,
        'compileMs',
        'compileState',
        'compileErrorCode',
      ],
      'precondition_failed',
      'the build never started, so nothing about it was measured',
    );
  }

  const buildStart: number = buildStartedAt ?? clock.now();

  // -- 4/5. the provisional board, on the persisted artifact -----------------
  //
  // Polled on `provisional_boards`, not on a page, and with a deadline derived
  // from the compile deadline. This is the step the old harness gave up on ten
  // minutes into a ten-and-a-half-minute compile.
  let board: PersistedBoard | null = null;
  if (started) {
    await step('await_provisional_board', async () => {
      const outcome = recorder.milestone(
        await awaitMilestone<PersistedBoard>(clock, {
          name: 'provisional_board_persisted',
          deadlineMs: provisionalDeadline(options.budget),
          intervalMs: options.budget.pollIntervalMs,
          probe: () => store.provisionalBoard(trip),
          abortWhen: () => {
            const job = store.latestJob(trip);
            if (job && isTerminalCompileState(job.state)) {
              return {
                code: 'precondition_failed',
                detail: `the compile reached terminal state "${job.state}" with no provisional board persisted — this is a product finding, not a timeout`,
              };
            }
            return null;
          },
        }),
      );
      if (outcome.measured.state === 'measured') {
        board = outcome.measured.value;
        recorder.record('timeToProvisionalBoardMs', measured(clock.now() - buildStart));
        recorder.record('provisionalBoardVersion', measured(board.version));
        recorder.record('provisionalBoardCardsPersisted', measured(board.cardCount));
      } else {
        const because = outcome.measured.because;
        const absent = notMeasured(because.code, because.detail);
        recorder.record('timeToProvisionalBoardMs', absent);
        recorder.record('provisionalBoardVersion', absent);
        recorder.record('provisionalBoardCardsPersisted', absent);
        recorder.blockIfAbsent(
          ['provisionalRouteRedirected', ...PROVISIONAL_ROUTE_FIELDS],
          because.code,
          because.detail,
        );
      }
    });
  }

  // -- 6/7/8. the provisional route, its version, its cards, the interactions -
  if (board !== null) {
    await step('open_provisional_route', async () => {
      const persisted: PersistedBoard = board!;
      const path = `/trips/${trip}/provisional`;
      const { visit, onTarget } = await openExactly(path, 'open_provisional_route');
      recorder.record('provisionalRouteRedirected', redirection(visit));
      if (!onTarget) {
        recorder.blockIfAbsent(
          PROVISIONAL_ROUTE_FIELDS,
          visit.outcome === 'navigation_failed' ? 'navigation_failed' : 'redirected_away',
          `${path} did not render — the provisional board was persisted (version ${persisted.version}, ${persisted.cardCount} cards) but the route did not show it, so nothing on that page was measured`,
        );
        return;
      }
      await driver.screenshot(`${options.slug}-provisional`);

      recorder.record(
        'provisionalBoardVersionAgrees',
        mapMeasured(
          await driver.boardVersion('provisional_board'),
          (version) => version === persisted.version,
        ),
      );
      recorder.record('provisionalCardsRendered', await driver.count('provisional_card'));
      recorder.record('provisionalMarksApplied', await driver.markProvisionalCards(options.marks));
    });
  }

  // -- 9. a terminal — or explicitly partial — compile state -----------------
  if (started) {
    await step('await_compile_terminal', async () => {
      const outcome = recorder.milestone(
        await awaitMilestone<PersistedJob>(clock, {
          name: 'compile_terminal',
          deadlineMs: options.budget.compileMs,
          intervalMs: options.budget.pollIntervalMs,
          probe: () => {
            const job = store.latestJob(trip);
            return job && isTerminalCompileState(job.state) ? job : null;
          },
        }),
      );
      if (outcome.measured.state === 'measured') {
        const job = outcome.measured.value;
        recorder.record('compileMs', measured(clock.now() - buildStart));
        recorder.record('compileState', measured(job.state));
        recorder.record(
          'compileErrorCode',
          fromNullable(
            job.errorCode,
            'precondition_failed',
            'the job carried no error code, which is what a clean finish looks like',
          ),
        );
      } else {
        const because = outcome.measured.because;
        const absent = notMeasured(because.code, because.detail);
        recorder.record('compileMs', absent);
        recorder.record('compileState', absent);
        recorder.record('compileErrorCode', absent);
      }
      await driver.screenshot(`${options.slug}-compile`);
    });
  }

  // -- 10. the profile, before the route that requires one -------------------
  //
  // The whole board-level gap was this step not existing. `/discover` redirects
  // to the questionnaire for a trip with no profile, so a harness that skips it
  // measures the questionnaire and reports it as a board.
  let profiled = false;
  await step('complete_profile', async () => {
    const { visit, onTarget } = await openExactly(
      `/trips/${trip}/questionnaire`,
      'complete_profile',
    );
    if (!onTarget) {
      recorder.record(
        'profileCompleted',
        notMeasured(
          visit.outcome === 'navigation_failed' ? 'navigation_failed' : 'redirected_away',
          'the questionnaire route did not render, so no profile was attempted',
        ),
      );
      return;
    }
    const outcome = await driver.completeProfile();
    recorder.record('profileCompleted', outcome);
    profiled = outcome.state === 'measured' && outcome.value;
    if (!profiled) {
      recorder.fail({
        kind: 'driver_refused',
        step: 'complete_profile',
        detail: 'the questionnaire was not completed — /discover will redirect',
      });
    }
  });

  // -- 11/12. the final route, asserted not to redirect ----------------------
  if (!profiled) {
    recorder.blockIfAbsent(
      ['discoverRouteRedirected', ...BOARD_FIELDS],
      'precondition_failed',
      'no traveller profile was stored, and /discover redirects to the questionnaire without one — so nothing on the board was measured rather than measured as empty',
    );
  } else {
    await step('open_discovery_board', async () => {
      const path = `/trips/${trip}/discover`;
      const { visit, onTarget } = await openExactly(path, 'open_discovery_board');
      recorder.record('discoverRouteRedirected', redirection(visit));
      if (!onTarget) {
        recorder.blockIfAbsent(
          BOARD_FIELDS,
          visit.outcome === 'navigation_failed' ? 'navigation_failed' : 'redirected_away',
          `${path} did not render the discovery board — see the recorded route visit for the status and the page it landed on`,
        );
        return;
      }
      await driver.screenshot(`${options.slug}-board`);

      recorder.record('boardCards', await driver.count('board_card'));
      recorder.record('boardVersion', await driver.boardVersion('discovery_board'));
      recorder.record('boardSummary', await driver.text('board_summary'));
      recorder.record('reconciliationShown', await driver.present('reconciliation_panel'));
      recorder.record('pinnedRemovals', await driver.count('pinned_removal'));
      recorder.record('weatherState', await driver.text('weather_snapshot'));
    });
  }

  // -- 12b. the persisted counterparts of the same three things --------------
  //
  // Both halves, always. A browser check that fails leaves the row check
  // standing, which is the difference between "unverified" and "we know".
  await step('read_persisted_states', async () => {
    const reconciliation = store.reconciliation(trip);
    recorder.recordMaybe(
      'reconciliationVersion',
      reconciliation?.version ?? null,
      'precondition_failed',
      'no reconciliation account exists for this trip',
    );
    const weather = store.weatherSnapshot(trip);
    recorder.recordMaybe(
      'weatherSnapshotStatus',
      weather?.status ?? null,
      'provider_disabled',
      'no weather snapshot was persisted — this run never asked for one',
    );
  });

  // -- 12c. the itinerary ----------------------------------------------------
  await step('check_itinerary', async () => {
    const visit = recorder.visit(await driver.visit(`/trips/${trip}/itinerary`));
    /*
     * `?? -1` was here. A navigation that never completed was published as an
     * observed status of minus one — a sentinel wearing a measurement's
     * clothes, in the one manifest built to make that impossible. The status is
     * now a `Measured<number>` inside the visit itself, so there is nowhere for
     * a sentinel to be written.
     */
    recorder.record(
      'itineraryRouteStatus',
      visit.outcome === 'navigated'
        ? visit.status
        : notMeasured(
            'navigation_failed',
            `the itinerary route never answered (${visit.detail}), so no status was observed`,
          ),
    );
    const itinerary = store.itinerary(trip);
    recorder.recordMaybe(
      'itineraryDays',
      itinerary?.days ?? null,
      'precondition_failed',
      'no itinerary was built by this journey, so it has no days — this is the absence of a step, not a day count of zero',
    );
  });

  // -- 13. persisted evaluation metrics --------------------------------------
  await step('read_stage_observations', async () => {
    recorder.record('stageObservations', measured(store.stageObservations()));
  });

  return await conclude(deps, recorder, options, order);
}

/**
 * Spend, integrity, publication, teardown — in that order, on every path.
 *
 * Separate function because it must run identically for a clean journey and for
 * one that fell over at the composer. §6 wants usage recorded even for failed
 * calls, and the run somebody will actually examine is the failed one.
 */
async function conclude(
  deps: LiveJourneyDeps,
  recorder: JourneyRecorder,
  options: LiveJourneyOptions,
  order: string[],
): Promise<JourneyRun> {
  order.push('read_spend');
  try {
    const recorded = recorder.get<string>('tripId');
    const id = recorded === undefined ? null : valueOf(recorded);
    if (typeof id === 'string' && id.length > 0) {
      recorder.recordMaybe(
        'spend',
        deps.store.spend(id),
        'probe_threw',
        'the spend ledger could not be read — this run may have cost money that is not recorded here',
      );
    } else {
      recorder.record(
        'spend',
        notMeasured(
          'precondition_failed',
          'no trip id, so no ledger to read — any spend before the trip existed is not attributable to it',
        ),
      );
    }
  } catch (error) {
    recorder.fail({
      kind: 'step_threw',
      step: 'read_spend',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  order.push('read_console_errors');
  try {
    recorder.record('consoleErrors', measured([...deps.driver.consoleErrors()]));
  } catch {
    recorder.record(
      'consoleErrors',
      notMeasured('probe_threw', 'the driver could not report console errors'),
    );
  }

  order.push('close_driver');
  await deps.driver.close().catch(() => undefined);

  order.push('finalise_report');
  const report = recorder.finalise({
    destination: options.destination,
    slug: options.slug,
    start: options.start,
    end: options.end,
    strategy: options.strategy,
    budget: options.budget,
  });

  order.push('publish_report');
  let published = false;
  try {
    await deps.publish(report);
    published = true;
  } catch (error) {
    recorder.fail({
      kind: 'publication_failed',
      step: 'publish_report',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  /*
   * THE DATABASE OUTLIVES THE REPORT.
   *
   * Bali's board behaviour is permanently unverified because a throwaway
   * database was deleted while assertions were still outstanding. The ordering
   * below is the whole correction: teardown is reachable only through a
   * successful publication, and a failed publication leaves the evidence where
   * somebody can still go and look at it.
   */
  let teardownPerformed = false;
  if (published && deps.teardown) {
    order.push('teardown');
    try {
      await deps.teardown();
      teardownPerformed = true;
    } catch (error) {
      recorder.fail({
        kind: 'step_threw',
        step: 'teardown',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (deps.teardown) {
    order.push('teardown_skipped');
  }

  return {
    report: published
      ? report
      : recorder.finalise({
          destination: options.destination,
          slug: options.slug,
          start: options.start,
          end: options.end,
          strategy: options.strategy,
          budget: options.budget,
        }),
    published,
    teardownPerformed,
    order,
  };
}
