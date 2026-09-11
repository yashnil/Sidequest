'use client';

/**
 * V8 — A SERVER ACTION THAT DIES ON THE WIRE IS A STATE, NOT AN EXCEPTION.
 *
 * `fetch` rejecting inside `startTransition(async () => …)` reaches the
 * nearest error boundary in React 19, which is how one dropped Build request
 * in production replaced the whole interview with "That page did not load"
 * (`.claude-private/V8-BUILD-FAILURE.md`). Every call into a server action
 * from an interactive surface goes through this, so a transport failure comes
 * back as a value the screen has a sentence for, and the boundary is reserved
 * for rendering faults.
 */
export type ActionOutcome<T> = { ok: true; value: T } | { ok: false; transport: true; message: string };

export const TRANSPORT_FAILURE_MESSAGE = 'We could not reach Sidequest just then. Nothing you answered was lost — check your connection and try once more.';

/**
 * A server action that calls `redirect()` rejects on the client with a
 * framework signal, not a failure: the router has already been told where to
 * go. That rejection has to keep propagating, or the navigation is swallowed
 * and a console error is logged for a request that succeeded.
 */
function isNavigationSignal(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  const message = error instanceof Error ? error.message : '';
  return (typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_NOT_FOUND'))) || message === 'NEXT_REDIRECT' || message === 'NEXT_NOT_FOUND';
}

export async function callAction<T>(run: () => Promise<T>): Promise<ActionOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (isNavigationSignal(error)) throw error;
    /* Named fields only, and never the request: the error may carry it. */
    console.error('Server action unreachable', { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return { ok: false, transport: true, message: TRANSPORT_FAILURE_MESSAGE };
  }
}

/** A key for one press: reused by every retry of that press, so the server can tell a duplicate from a new decision. */
export function newBuildKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
