/**
 * THREAD IDENTITY — AND WHY IT IS NOT AUTHORIZATION.
 *
 * PRODUCTION LOCK V5 §35 and §61. A LangGraph thread id names a conversation. It
 * is a *lookup key*, and the single most common way a graph-backed feature grows
 * a hole is by treating it as a capability: anybody who can guess or is shown a
 * thread id can then read the checkpoints under it.
 *
 * So the rule is stated here, beside the function, rather than left to a reader
 * of the endpoints:
 *
 * > **Every caller must establish that this user owns this trip BEFORE
 * > constructing a thread id, and the ownership check may never be the thread id
 * > itself.** `refinement-actions.ts` calls `assertTripOwner` first, every time,
 * > and `ownership.test.ts` holds it to that.
 *
 * A thread id also carries no personal data (§50): a trip id is an opaque UUID,
 * and no email, name or destination goes into it. That matters because a thread
 * id is the string most likely to end up in a log line.
 */

const PREFIX = 'sidequest';

/**
 * The canonical refinement thread for a trip.
 *
 * One thread per trip rather than one per request: the point of the thread is
 * that a refinement interrupted by a question resumes in the *same*
 * conversation, and the traveller's next request continues it.
 *
 * The user id is deliberately absent. A trip has exactly one owner and the trip
 * id already determines it, so putting the user in the key would add a second
 * source of truth about ownership — and a mismatch between the two would be a
 * thread nobody could find rather than an access control failure caught early.
 */
export function refinementThreadId(tripId: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(tripId)) throw new Error('A refinement thread needs a plain trip id.');
  return `${PREFIX}:${tripId}`;
}

/**
 * ONE ACTION, ONE THREAD.
 *
 * PRODUCTION LOCK V5, final closure. `graph.invoke` on a thread RESUMES that
 * thread's checkpoint, so every refinement of a trip sharing one thread meant
 * every refinement inheriting the last one's channels. The live closure run
 * reported `modelCalls: 2` for a single call, and carried the previous run's
 * error beside its own.
 *
 * The wrong half of that is cosmetic. The dangerous half is that `interpret`
 * refuses once `modelCallsThisAction` reaches the ceiling: after two failed
 * refinements a trip would silently refuse every future one — no call, no
 * explanation, forever.
 *
 * `checkpoint_ns` was tried first and does not do this: LangGraph reserves it
 * for subgraphs and the root graph does not honour a caller's value. A thread
 * per run does, and costs nothing — the trip id stays the prefix, so ownership,
 * `tripIdOfThread` and the `ON DELETE CASCADE` from `trips` all behave as
 * before. A resume passes the same run and lands back in its own state.
 */
export function refinementRunThreadId(tripId: string, runId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) throw new Error('A refinement run thread needs a plain run id.');
  return `${refinementThreadId(tripId)}:run:${runId}`;
}

/**
 * A separate thread for "try another version" (§47).
 *
 * Branching by thread rather than by checkpoint fork keeps the canonical
 * conversation untouched while an alternative is explored, which is the property
 * that matters: accepting the branch promotes it, and abandoning it leaves the
 * current trip exactly as it was.
 */
export function alternativeThreadId(tripId: string, branch: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(branch)) throw new Error('A branch name is lowercase letters, digits and dashes.');
  return `${refinementThreadId(tripId)}:alt:${branch}`;
}

/** The trip a thread belongs to, for a log line or a cleanup pass. Never for authorization. */
export function tripIdOfThread(threadId: string): string | null {
  const match = /^sidequest:([A-Za-z0-9_-]{1,120})(?::alt:[a-z0-9-]{1,40}|:run:[A-Za-z0-9-]{1,64})?$/.exec(threadId);
  return match?.[1] ?? null;
}
