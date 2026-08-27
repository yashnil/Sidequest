import 'server-only';

/**
 * THE THREE CEILINGS THE RUNNER ITSELF ENFORCES, RESOLVED IN ONE PLACE.
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

/**
 * HOW MANY LIVE BUILDS MAY RUN AT ONCE, ACROSS THE WHOLE DEPLOYMENT.
 *
 * The third ceiling, and the one that was missing entirely: the unique index
 * bounds concurrent builds *per trip*, and nothing bounded them in total. Fifty
 * trips were fifty simultaneous processes, each with its own model budget and
 * each talking to the same four services.
 *
 * **One, and the reason is politeness rather than comfort.** Every outbound
 * gate this app has — Nominatim at one request a second, Overpass at one per
 * 1.2 s, Valhalla at one per 1.1 s — is a promise chain in module scope, and
 * those modules say so: "concurrency collapses to a queue no matter how many
 * compilations are running", "one queue for one host". That was true when a
 * compilation ran inside the web process and stopped being true the day the
 * compile worker landed and moved the state into a process per build. N
 * concurrent builds multiply every one of those agreed rates by exactly N, and
 * these are volunteer-run services whose policies are written per application,
 * not per process.
 *
 * At one, the compiler's share of each of those services is one queue again,
 * which is what those comments claim. It is not the whole claim and this file
 * will not pretend otherwise: the web process makes its own occasional
 * geocoder call for destination resolution, so a busy minute is still two
 * processes rather than one. That path is bounded by the per-action fences in
 * `lib/net/rate-limit` and is a request or two, not a build's worth.
 *
 * Configurable, because an operator who has moved to self-hosted endpoints has
 * bought the right to raise it — and should read this first. Raising it without
 * moving the gates out of process is a decision to exceed a published limit.
 *
 * It stays at one, and the *refusal* it used to cause is what changed: a second
 * traveller now waits in a bounded queue and is told where they are, rather
 * than being turned away on the one action in this product that costs money and
 * matters most. See `maxQueuedCompilations` below — the queue defers spend, it
 * does not add any, so no ceiling in `daily-ceiling.ts` moves.
 */
export function maxConcurrentCompilations(): number {
  const configured = Number(process.env.SIDEQUEST_MAX_CONCURRENT_COMPILATIONS ?? '');
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
}

/**
 * HOW MANY BUILDS MAY WAIT FOR THAT ONE SLOT.
 *
 * A queue with no bound is a refusal with the refusal hidden: the traveller is
 * told "yours will start" and then waits behind an arbitrary number of builds
 * that each take minutes. So the depth is set by the longest wait this product
 * is willing to promise rather than by memory.
 *
 * Three, against a 12-minute per-build deadline (`compileDeadlineMs`) plus the
 * worker's grace: the last place in a full queue is behind one running build
 * and two waiting ones, so the promise being made is "under an hour, worst
 * case, and usually much less" — builds observably finish around eight minutes
 * and a warm evidence store cuts that further. A fourth place would promise
 * over an hour, which is not a wait, it is an abandonment with a spinner on it.
 *
 * Beyond the bound the answer is an honest refusal that says the queue is full
 * and what to do — never a silent drop, and never a place in a line whose
 * length we would not admit to.
 */
export function maxQueuedCompilations(): number {
  /*
   * Read as "was anything configured" rather than through `Number`, because
   * zero is a *legitimate* setting here — an operator may turn the queue off
   * and keep the old refusal — and `Number('')` is also zero. The ceilings
   * above can use `>= 1` to reject an unset variable; this one cannot, and a
   * default that silently resolved to zero would have shipped the defect.
   */
  const raw = process.env.SIDEQUEST_MAX_QUEUED_COMPILATIONS?.trim();
  if (!raw) return 3;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 3;
}

/**
 * HOW LONG A PARKED BUILD MAY HOLD ITS PLACE BEFORE WE STOP PROMISING.
 *
 * A queued job has no process, so the heartbeat cannot speak for it — see
 * `isAbandoned`, which exempts it for exactly that reason. Something still has
 * to end a place in line held by a traveller who closed the tab, or the queue
 * silently shortens for everybody else and that trip can never start another
 * build.
 *
 * Derived from the same two numbers that justify the depth rather than picked:
 * the deepest legitimate wait is every build ahead plus this one, each bounded
 * by the compile deadline and the worker's hard-stop grace. A job still parked
 * past that has not been unlucky, it has been forgotten — and is ended with a
 * retryable verdict that says so.
 */
export function queueWaitCeilingMs(): number {
  return (maxQueuedCompilations() + 1) * (compileDeadlineMs() + DEADLINE_GRACE_MS);
}
