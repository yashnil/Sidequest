import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * THE GENERATION DEADLINE, AS SOMETHING A REQUEST IN FLIGHT CAN HEAR.
 *
 * MVP V3, Stage 25. The product budget is 120 seconds and builds were exceeding
 * it — not because anything ignored the deadline, but because every check was
 * *before* the work. `reconcile.ts` asks `deadlineReached()` before it starts a
 * lookup and never again, so a geocode begun one millisecond inside the budget
 * still ran to its own 12-second timeout, and the traveller waited past two
 * minutes for an answer Sidequest had already decided to stop improving.
 *
 * Two things fix that, and both are needed:
 *
 * 1. **A margin.** The verification deadline reserves the slowest provider
 *    timeout, so a request begun at the last legal moment finishes inside the
 *    budget even if nothing cancels it. Deterministic; no plumbing.
 * 2. **A signal every provider fetch honours** — this module. One
 *    `AbortController` per build, published on an async context so it reaches
 *    the six provider call sites without threading a parameter through every
 *    seam, and merged with each provider's own timeout. When the budget fires,
 *    open sockets close rather than being waited on.
 *
 * `AsyncLocalStorage` rather than a module variable, because two travellers can
 * be building at the same moment in one process and a shared abort controller
 * would cancel a stranger's trip.
 */

const store = new AsyncLocalStorage<AbortSignal>();

/** Runs `fn` with `signal` published as the ambient generation deadline. */
export function withGenerationDeadline<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return store.run(signal, fn);
}

/** The ambient deadline, when the caller is inside a generation. */
export function generationSignal(): AbortSignal | undefined {
  return store.getStore();
}

/**
 * A provider's own timeout, combined with the generation deadline when there is
 * one. Every outbound fetch in a verification path uses this instead of a bare
 * `AbortSignal.timeout`, so both limits apply and whichever fires first wins.
 */
export function requestSignal(timeoutMs: number): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  const deadline = generationSignal();
  if (!deadline) return own;
  if (deadline.aborted) return deadline;
  return AbortSignal.any([own, deadline]);
}

/**
 * The slowest a single provider request may be, used to size the margin the
 * verification deadline reserves. Kept here beside the mechanism rather than
 * derived from each provider, because it is a *budget* decision: raise a
 * provider timeout past this and the margin, not the provider, is what needs
 * revisiting.
 */
export const MAX_PROVIDER_REQUEST_MS = 12_000;
