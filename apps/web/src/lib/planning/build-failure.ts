/**
 * V1 CONVERGENCE, SLICE A — WHY A BUILD DID NOT HAPPEN, AS A TYPE.
 *
 * Before this, every way a build could fail reached the traveller as the same
 * sentence and the same "Try again" loop: a deployment with no model
 * credential, a key the vendor had revoked, a daily allowance that was spent,
 * a slow minute at the vendor and a draft that did not parse all read
 * "Sidequest couldn't finish this build", and the one fact that would have
 * told somebody what to do — the cause — reached only the server log.
 *
 * A `BuildFailureCause` is that cause, in Sidequest's own words. Each one has:
 *
 * - **copy** a traveller can read: no environment variable, no vendor name, no
 *   status code, no stack, nothing that only makes sense to an operator;
 * - **`retryable`**: whether pressing "Try build again" can change the outcome.
 *   A dead credential or a missing composer cannot be fixed by the traveller,
 *   and offering them the button anyway is the loop this file exists to end;
 * - an optional **next action** the screen can offer instead.
 *
 * The operator still gets the precise reason — in the log line keyed by the
 * failure reference, and in `/api/readiness` and `npm run doctor`. The two
 * audiences are never served by one string.
 *
 * Pure and import-free on purpose: the generation screen (a client
 * component), the progress route, the server actions and the tests all read
 * the same table. Extensible: a new cause is one entry in `BUILD_FAILURE_CAUSES`
 * and one in `COPY`, and the type system refuses a cause with no copy.
 * `must_do_conflict` and `planner_refused` are reserved for the planner-first
 * composer (V1 slice D) and are not produced by anything here yet.
 */

export const BUILD_FAILURE_CAUSES = [
  'composer_not_configured',
  'provider_auth_failure',
  'provider_quota_or_limit',
  'provider_timeout',
  'provider_unavailable',
  'invalid_model_response',
  'internal_generation_error',
  /* Reserved for the planner-first path (slice D). */
  'must_do_conflict',
  'planner_refused',
] as const;
export type BuildFailureCause = (typeof BUILD_FAILURE_CAUSES)[number];

/**
 * A narrower reading of a cause, where the copy must differ.
 *
 * - `daily_allowance`: the quota that was hit is Sidequest's own daily
 *   ceiling, not the vendor's — retrying today cannot help.
 * - `fixtures_refused`: the composer is unavailable because this production
 *   deployment carries a test-data switch without the explicit opt-in.
 */
export const BUILD_FAILURE_VARIANTS = ['daily_allowance', 'fixtures_refused'] as const;
export type BuildFailureVariant = (typeof BUILD_FAILURE_VARIANTS)[number];

export interface BuildFailureNextAction {
  kind: 'try_later' | 'try_tomorrow' | 'return_to_review' | 'edit_must_dos';
  label: string;
}

export interface BuildFailure {
  cause: BuildFailureCause;
  variant?: BuildFailureVariant;
  /** Whether "Try build again" can change the outcome. False hides the button. */
  retryable: boolean;
  /** One line, the failure's name in the traveller's terms. */
  heading: string;
  /** What happened and what is preserved, plainly. */
  message: string;
  nextAction: BuildFailureNextAction | null;
}

type Copy = Omit<BuildFailure, 'cause' | 'variant'>;

const NOTHING_LOST = 'Nothing was lost — your answers are saved';

const COPY: Record<BuildFailureCause, Copy> = {
  composer_not_configured: {
    retryable: false,
    heading: 'This site can’t build trips right now.',
    message: `Sidequest isn’t able to write new trips here at the moment, so no build was started. ${NOTHING_LOST}, and any trip already built still opens.`,
    nextAction: { kind: 'try_later', label: 'Come back later' },
  },
  provider_auth_failure: {
    retryable: false,
    heading: 'Sidequest can’t reach its trip planner right now.',
    message: `The planning service turned this site’s request away, and trying again won’t change that until it is fixed on our side. ${NOTHING_LOST}.`,
    nextAction: { kind: 'try_later', label: 'Come back later' },
  },
  provider_quota_or_limit: {
    retryable: true,
    heading: 'Sidequest is busy right now.',
    message: `Too many trips were being planned at once, so this one was not written. ${NOTHING_LOST} — wait a few minutes and try again.`,
    nextAction: { kind: 'try_later', label: 'Try again in a few minutes' },
  },
  provider_timeout: {
    retryable: true,
    heading: 'The draft took too long to write.',
    message: `Sidequest stopped waiting before the trip was finished. ${NOTHING_LOST} — trying again usually works.`,
    nextAction: null,
  },
  provider_unavailable: {
    retryable: true,
    heading: 'Sidequest’s trip planner didn’t answer.',
    message: `It looks like a brief outage. ${NOTHING_LOST} — try again in a minute.`,
    nextAction: { kind: 'try_later', label: 'Try again in a minute' },
  },
  invalid_model_response: {
    retryable: true,
    heading: 'Sidequest couldn’t finish this build.',
    message: 'The draft that came back wasn’t a usable trip, so we didn’t show it to you. Trying again writes a fresh one.',
    nextAction: null,
  },
  internal_generation_error: {
    retryable: true,
    heading: 'Sidequest couldn’t finish this build.',
    message: `Something went wrong on our side while putting the trip together. ${NOTHING_LOST} — you can try again.`,
    nextAction: null,
  },
  must_do_conflict: {
    retryable: false,
    heading: 'Your must-dos can’t all fit in this trip.',
    message: `Two or more of the things you said you must do can’t share these dates. ${NOTHING_LOST} — change or drop one and build again.`,
    nextAction: { kind: 'edit_must_dos', label: 'Review my must-dos' },
  },
  planner_refused: {
    retryable: false,
    heading: 'Sidequest couldn’t plan this trip from what it found.',
    message: `Your Discovery Board doesn’t have enough places to fill every day. ${NOTHING_LOST} — include a few more places, rescan, or shorten the trip.`,
    nextAction: { kind: 'return_to_review', label: 'Return to review' },
  },
};

const VARIANT_COPY: Record<BuildFailureVariant, Copy> = {
  daily_allowance: {
    retryable: false,
    heading: 'Today’s planning limit has been reached.',
    message: 'Sidequest has planned as many trips as it can today, so it isn’t starting a new build. Your answers and anything already built are saved — try again tomorrow.',
    nextAction: { kind: 'try_tomorrow', label: 'Try again tomorrow' },
  },
  fixtures_refused: COPY.composer_not_configured,
};

export function isBuildFailureCause(value: unknown): value is BuildFailureCause {
  return typeof value === 'string' && (BUILD_FAILURE_CAUSES as readonly string[]).includes(value);
}

/** The traveller-facing failure for a cause (and, where the copy differs, a variant). */
export function buildFailure(cause: BuildFailureCause, variant?: BuildFailureVariant): BuildFailure {
  const copy = variant ? VARIANT_COPY[variant] : COPY[cause];
  return { cause, ...(variant ? { variant } : {}), ...copy };
}

/**
 * Persisted as one short string (`cause` or `cause/variant`) on
 * `generation_progress.failure_cause`. Anything unreadable is null, and a null
 * cause renders as the pre-taxonomy copy rather than as a guess.
 */
export function encodeBuildFailure(failure: Pick<BuildFailure, 'cause' | 'variant'>): string {
  return failure.variant ? `${failure.cause}/${failure.variant}` : failure.cause;
}

export function decodeBuildFailure(raw: string | null | undefined): BuildFailure | null {
  if (!raw) return null;
  const [cause, variant] = raw.split('/');
  if (!isBuildFailureCause(cause)) return null;
  const knownVariant = (BUILD_FAILURE_VARIANTS as readonly string[]).includes(variant ?? '') ? (variant as BuildFailureVariant) : undefined;
  return buildFailure(cause, knownVariant);
}

/**
 * CLASSIFY A THROWN MODEL ERROR.
 *
 * Duck-typed rather than `instanceof`, so this file imports no SDK and a page
 * can import it: it reads the `code` a `ResearchModelError` carries, the HTTP
 * `status` an SDK error or a `ResearchModelError.httpStatus` carries, and the
 * error's `name` for aborts and timeouts.
 *
 * - 401 / 403, or `auth_rejected` → `provider_auth_failure`
 * - `not_configured` → `composer_not_configured`
 * - 429, or `rate_limited` → `provider_quota_or_limit`
 * - a timeout or an abort → `provider_timeout`
 * - 5xx, 529, or a request that never got an answer → `provider_unavailable`
 * - `malformed_output`, a schema or parse failure → `invalid_model_response`
 * - anything else → `internal_generation_error`
 */
export function classifyModelError(error: unknown): BuildFailureCause {
  if (error === null || typeof error !== 'object') return 'internal_generation_error';
  const e = error as { code?: unknown; status?: unknown; httpStatus?: unknown; name?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const statusRaw = typeof e.httpStatus === 'number' ? e.httpStatus : typeof e.status === 'number' ? e.status : null;
  const name = typeof e.name === 'string' ? e.name : '';
  return classifyByCodeAndStatus(code, statusRaw, name);
}

function classifyByCodeAndStatus(code: string | null, status: number | null, name = ''): BuildFailureCause {
  if (code === 'not_configured') return 'composer_not_configured';
  if (code === 'auth_rejected' || status === 401 || status === 403) return 'provider_auth_failure';
  if (code === 'rate_limited' || status === 429) return 'provider_quota_or_limit';
  if (code === 'timeout' || /timeout|abort/i.test(name) || status === 408) return 'provider_timeout';
  if (status !== null && (status >= 500 || status === 529)) return 'provider_unavailable';
  if (code === 'malformed_output' || /zod|syntax|parse/i.test(name)) return 'invalid_model_response';
  /* A request that failed with no status never got an answer: the network or the vendor, not us. */
  if (code === 'request_failed' && status === null) return 'provider_unavailable';
  return 'internal_generation_error';
}

/**
 * CLASSIFY A COMPOSITION OUTCOME (`composition.ts#generateTripDraft`).
 *
 * The composition folds a thrown error into a `failureKind`; `providerCode` and
 * `providerStatus` carry what the transport said, so a rate limit is not read
 * as "the draft was malformed" (which is what `failureKind` alone says for it).
 */
export function classifyCompositionFailure(outcome: { failureKind: string; providerCode?: string | null; providerStatus?: number | null }): BuildFailureCause {
  const code = outcome.providerCode ?? null;
  const status = outcome.providerStatus ?? null;
  if (code || status !== null) {
    const byProvider = classifyByCodeAndStatus(code, status);
    if (byProvider !== 'internal_generation_error') return byProvider;
  }
  switch (outcome.failureKind) {
    case 'timeout':
      return 'provider_timeout';
    case 'model_unavailable':
      return code === 'not_configured' ? 'composer_not_configured' : 'provider_auth_failure';
    case 'malformed_output':
      return 'invalid_model_response';
    case 'budget_exhausted':
    default:
      return 'internal_generation_error';
  }
}

/**
 * The failure fields a progress view carries, built once for the route, the
 * build page and the review — so the three cannot disagree about which words a
 * failed run shows.
 */
export interface FailureCopyView {
  cause: BuildFailureCause | null;
  retryable: boolean;
  heading: string | null;
  message: string | null;
  nextAction: BuildFailureNextAction | null;
}

export function failureCopyView(failure: BuildFailure | null): FailureCopyView {
  if (!failure) return { cause: null, retryable: true, heading: null, message: null, nextAction: null };
  return { cause: failure.cause, retryable: failure.retryable, heading: failure.heading, message: failure.message, nextAction: failure.nextAction };
}
