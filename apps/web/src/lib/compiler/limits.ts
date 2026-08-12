import 'server-only';

/**
 * THE TWO CEILINGS THE RUNNER ITSELF ENFORCES, RESOLVED IN ONE PLACE.
 *
 * Both existed twice before this file. The model-call ceiling lived here in
 * the web app (default 12, wired into the transport) *and* in the compiler's
 * `DEFAULT_COMPILER_BUDGET` (20, printed by the ledger) — so the operational
 * diagnostics reported a limit of twenty on runs whose transport refused the
 * thirteenth call, and nobody reading a stored job could tell which number had
 * governed. The wall clock likewise: the compiler's `maxDurationMs` default of
 * three minutes was printed while live builds observably ran eight, because
 * the check only lands between stages and the stages had grown. One number per
 * ceiling now, resolved here and threaded into the budget the runner passes to
 * `compileRegion`, so the printed limit is the operative one.
 */

/** How many model calls one compilation may make. The transport enforces it. */
export function modelCallCeiling(): number {
  const configured = Number(process.env.SIDEQUEST_COMPILER_MAX_AI_CALLS ?? '');
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 12;
}

/**
 * The overall wall clock for one compilation, honest to observed builds.
 *
 * Live builds have been measured around eight minutes end to end, so the
 * ceiling sits at twelve: high enough that no healthy observed build is cut
 * down mid-flight, low enough that a wedged one stops the same quarter-hour
 * it wedged. The compiler checks this between stages and degrades to an
 * honest `partial`; the worker's hard stop (this value plus a grace period)
 * exists for the build that is stuck *inside* a stage and cannot reach a
 * check.
 */
export function compileDeadlineMs(): number {
  const configured = Number(process.env.SIDEQUEST_COMPILER_DEADLINE_MS ?? '');
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 720_000;
}

/**
 * How long past the deadline the worker waits before killing the build
 * outright. Wide enough for the compiler's own between-stage check to fire
 * first — the graceful path produces a partial region, the hard stop produces
 * only an honest failure — and for one last in-flight provider call to land.
 */
export const DEADLINE_GRACE_MS = 90_000;
