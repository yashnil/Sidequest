import 'server-only';
import { cookies } from 'next/headers';
import { decisionOwnerToken, getDecisionSession, type DecisionSession } from '../db/decision-repository';
import { SESSION_COOKIE } from './caller';

/**
 * THE TRIP BOUNDARY, EXTENDED TO THE DECISION THAT PRECEDES THE TRIP.
 *
 * `lib/net/trip-access` states the one ownership rule — the browser holding the
 * trip's own session cookie is the only browser that may see or change it —
 * and calls the address-bar URL "the universal sharing gesture". Decision
 * sessions were built as a separate table after that rule landed, without an
 * owner column, so any holder of a `/decide/<id>` URL could read the
 * traveller's answers, rewrite them, and adopt the destination — minting the
 * resulting trip under the *stranger's* cookie and permanently locking the
 * legitimate traveller out ("You have already chosen for this one").
 *
 * Same rule, same shape, same refusal posture:
 *
 * - a foreign browser sees a missing session, so the URL is not an oracle;
 * - a session with no owner (written before the column existed) is refused to
 *   everybody rather than handed to whoever arrives next;
 * - internal callers outside a request scope — tests, workers — pass, exactly
 *   per the internal-caller exemption `trip-access` documents. That path is
 *   unreachable over HTTP, where a request scope always exists.
 *
 * `/share/<token>` remains the one deliberately unauthenticated surface in the
 * product; nothing in the decide flow was ever designed as a second one.
 */

/** The session this request presented, or the fact that there is no request. */
async function browserSession(): Promise<{ inRequest: boolean; token: string | null }> {
  try {
    const jar = await cookies();
    return { inRequest: true, token: jar.get(SESSION_COOKIE)?.value?.slice(0, 64) ?? null };
  } catch {
    // Outside a request scope: a worker, a test, an internal caller.
    return { inRequest: false, token: null };
  }
}

/**
 * Why this caller may not act on this decision session, or null when they may.
 *
 * The sentence is deliberately the same one a missing session gets from the
 * actions ("We could not find that.") — confirming to a stranger that the id
 * exists would be handing them the first half of what the guard withholds.
 */
export async function decisionAccessRefusal(id: string): Promise<string | null> {
  const { inRequest, token } = await browserSession();
  if (!inRequest) return null;
  const owner = decisionOwnerToken(id);
  if (!owner || !token || owner !== token) return 'We could not find that.';
  return null;
}

/**
 * The session, only when the asking browser started it.
 *
 * For the page: `const session = await ownedDecisionSession(id); if (!session)
 * notFound();` — a foreign session renders exactly as a missing one.
 */
export async function ownedDecisionSession(id: string): Promise<DecisionSession | null> {
  const session = getDecisionSession(id);
  if (!session) return null;
  return (await decisionAccessRefusal(id)) === null ? session : null;
}
