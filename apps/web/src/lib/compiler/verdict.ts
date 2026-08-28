import {
  COMPILATION_ERROR_COPY,
  isRetryable,
  type CompilationErrorCode,
  type StageRecord,
} from '@sidequest/core';

/**
 * THE VERDICT A TRAVELLER READS WHEN A BUILD ENDS BADLY, DECIDED IN ONE PLACE.
 *
 * Two live failures proved that an error *code* alone cannot carry the verdict:
 *
 * - A transient data-catalogue outage ended a run as `coverage_insufficient`,
 *   and the traveller read "There is not enough here to plan on" — a false,
 *   non-retryable claim about the *destination*, when the job's own stage
 *   records said the catalogue never answered and an identical scope succeeded
 *   hours later with seven thousand records. The compiler is honest to record a
 *   gap and continue; the *presentation* was not honest to convert "our source
 *   was unreachable" into "your destination is empty".
 *
 * - The worker's wall-clock kill wrote `budget_exhausted`, so a build that
 *   simply ran out of *time* read "We ran out of lookups" — the wrong cause on
 *   the headline, contradicted by the stage row on the same screen — and was
 *   denied the retry that a warm evidence store makes cheap and likely to
 *   finish.
 *
 * So the copy and the retryability are decided here, from everything the job
 * row actually holds — the code, the detail, and the stage records — and both
 * render paths (the server render and the poll) call this one function. The
 * default remains `COMPILATION_ERROR_COPY` + `isRetryable`; only the two cases
 * where the code demonstrably misstates the cause are branched.
 */

/**
 * How the worker's hard-deadline kill identifies itself in `errorDetail`.
 *
 * One constant, written by `worker/main.ts` and read by `compilationVerdict`,
 * so the writer and the reader cannot drift apart. The error-code vocabulary is
 * shared schema and gaining a code there is a migration; the detail string is
 * already persisted per job and is exactly as durable as the classification
 * needs.
 */
export const TIME_CEILING_DETAIL_PREFIX = 'Stopped at the overall time ceiling';

/**
 * How a build that lost its place in the queue identifies itself in
 * `errorDetail`.
 *
 * The same device as the prefix above, chosen for the same reason: the error
 * code vocabulary is shared schema and gaining a code there is a migration,
 * while the detail string is already persisted per job. `provider_rate_limited`
 * is the honest code — the deployment did throttle this build — but its copy,
 * "A source asked us to slow down", would tell a traveller their *source*
 * failed when in fact nobody ever collected the place they were holding.
 */
export const QUEUE_WAIT_DETAIL_PREFIX = 'Gave up its place in the build queue';

/**
 * The stage outcome `compileRegion` records when the region-pack provider
 * reported itself unavailable — as opposed to `'no regional place data
 * configured'`, which it records when no provider exists at all. The first is
 * weather; the second is configuration; only the first may be told as
 * transient. Pinned by `verdict.test.ts` so a compiler-side reword breaks a
 * named test instead of silently reverting the outage branch.
 */
export const PACK_UNAVAILABLE_OUTCOME = 'no regional place data';

/** What a terminal job's failure means to the person reading the screen. */
export interface CompilationVerdict {
  message: string;
  /** Shown as a "Try again" button, so it must be honest. */
  retryable: boolean;
  /** Which branch spoke: a named transient cause, or the code's own copy. */
  cause: 'time_ceiling' | 'catalogue_unreachable' | 'queue_wait_expired' | CompilationErrorCode;
}

/** The honest sentence for a build the clock ended, not the lookup ledger. */
export const TIME_CEILING_MESSAGE =
  'This build ran out of time before it finished. Nothing was lost — the next attempt continues from what was already read and kept.';

/**
 * The honest sentence for a build that failed because the catalogue was
 * unreachable. It names our source as the thing that failed, makes no claim
 * about the destination, and earns its retry offer: the identical scope
 * fingerprint has been observed to succeed on the next attempt.
 */
export const CATALOGUE_UNREACHABLE_MESSAGE =
  'We could not reach the map data service just now, so this build had nothing to read. That says nothing about your destination — try again in a few minutes.';

/**
 * The honest sentence for a build that waited in line longer than this
 * deployment is willing to promise, and was never collected.
 *
 * It says the truthful thing — the build never started, so nothing was spent
 * and nothing was read — and it earns its retry offer outright: starting again
 * simply asks for a place in line again, and the queue is very often empty by
 * the time somebody comes back to a page they left.
 */
export const QUEUE_WAIT_MESSAGE =
  'This build waited for a free slot longer than we are willing to hold one open, so we let its place go. It never started, so nothing was spent and nothing was lost — starting it again puts it back in line.';

/**
 * Whether this run's stage records show the region pack was never read because
 * the catalogue did not answer — the one situation in which a downstream
 * `coverage_insufficient` is a fact about our sources rather than about the
 * ground. A pack stage that ran (`done`, with a record count) means the ground
 * really was read, and a thin verdict over it stands.
 */
export function packNeverRead(stages: readonly StageRecord[]): boolean {
  return stages.some(
    (record) =>
      record.stage === 'building_region_pack' &&
      record.status === 'skipped' &&
      record.outcome === PACK_UNAVAILABLE_OUTCOME,
  );
}

export function compilationVerdict(job: {
  errorCode: CompilationErrorCode;
  errorDetail?: string | undefined;
  stages: readonly StageRecord[];
}): CompilationVerdict {
  if (
    job.errorCode === 'budget_exhausted' &&
    job.errorDetail !== undefined &&
    job.errorDetail.startsWith(TIME_CEILING_DETAIL_PREFIX)
  ) {
    return { cause: 'time_ceiling', message: TIME_CEILING_MESSAGE, retryable: true };
  }

  if (
    job.errorCode === 'provider_rate_limited' &&
    job.errorDetail !== undefined &&
    job.errorDetail.startsWith(QUEUE_WAIT_DETAIL_PREFIX)
  ) {
    return { cause: 'queue_wait_expired', message: QUEUE_WAIT_MESSAGE, retryable: true };
  }

  if (job.errorCode === 'coverage_insufficient' && packNeverRead(job.stages)) {
    return {
      cause: 'catalogue_unreachable',
      message: CATALOGUE_UNREACHABLE_MESSAGE,
      retryable: true,
    };
  }

  /**
   * A BUILD THE TRAVELLER STOPPED IS THE MOST RESTARTABLE THING HERE.
   *
   * `isRetryable` answers a different question from this field, and conflating
   * them left a one-way door. It asks whether a *failure* was transient and
   * worth another attempt on its own merits — and a cancellation is not a
   * failure at all, so it answers no, correctly. This field decides whether the
   * screen offers the traveller the button, and there the answer is obviously
   * yes: they pressed stop, and picking it up again is the whole reason they
   * would come back.
   *
   * What the conflation produced: pressing "Stop this build" left the plan
   * screen on its `compiling` step forever with no retry control, while the
   * trip list labelled the same trip "You stopped this" and offered "Pick it up
   * again" — pointing at a screen with no way to do it. `retryCompilationAction`
   * accepts a cancelled job already; there was simply no button.
   */
  if (job.errorCode === 'cancelled_by_user') {
    return {
      cause: job.errorCode,
      message: COMPILATION_ERROR_COPY[job.errorCode],
      retryable: true,
    };
  }

  return {
    cause: job.errorCode,
    message: COMPILATION_ERROR_COPY[job.errorCode],
    retryable: isRetryable(job.errorCode),
  };
}
