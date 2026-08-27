import 'server-only';
import { cookies } from 'next/headers';
import type { Trip } from '@sidequest/core';
import { getTrip, tripOwnerToken } from '../db/repository';
import { SESSION_COOKIE } from './caller';

/**
 * ONE BOUNDARY FOR EVERY TRIP DOOR, NOT A BOUNDARY PER BUTTON.
 *
 * The ownership rule existed and was applied to exactly three doors — the trip
 * list, the Remove button and the Share button — while every `/trips/{id}/*`
 * page rendered the full owner view to whoever held the id, and the twenty-odd
 * other trip-mutating actions took any id they were handed. A review
 * demonstrated the consequence with an anonymous browser: the whole itinerary,
 * "Share this plan" and "Make this day easier" included. The product ships a
 * dedicated read-only share surface at `/share/<token>`; the address-bar URL —
 * the universal sharing gesture — must not quietly hand out a second, mutable
 * one.
 *
 * So the rule is stated once, here, and every trip-scoped page and mutating
 * action asks it: **the browser holding the trip's own session cookie is the
 * only browser that may see or change the trip.** Same boundary
 * `deleteTripAction` and `createShareLinkAction` already use — the
 * `sidequest_session` cookie against `trips.owner_token`, no account involved.
 * A trip with no owner is refused for the same reason it is listed to nobody:
 * "whoever arrives next may work on the rows nobody can claim" is not a rule
 * worth having. `/share/<token>` remains the one unauthenticated view.
 *
 * ## The internal-caller exemption, and why it is not a hole
 *
 * The benchmark driver, the compile worker and unit tests call these actions
 * directly, outside any request. There is no cookie jar there — `cookies()`
 * throws — and therefore no browser to judge: the guard passes. That path is
 * unreachable over HTTP, where a request scope always exists, so an external
 * caller cannot choose it. A request that *has* a jar and simply presents no
 * cookie is a browser like any other and is refused; nothing is minted for it,
 * because a request about to be refused should leave nothing behind.
 */

/**
 * The refusal, in the traveller's words. The honest sentence for the one
 * ordinary way to hit this — your own trip, opened in a different browser —
 * and it deliberately confirms nothing beyond what the same sentence on the
 * Remove and Share buttons already does.
 */
export const FOREIGN_TRIP_REFUSAL =
  'This trip was made in a different browser, so only that browser can work on it.';

/** The session this request presented, or the fact that there is no request. */
async function browserSession(): Promise<{ inRequest: boolean; token: string | null }> {
  try {
    const jar = await cookies();
    return { inRequest: true, token: jar.get(SESSION_COOKIE)?.value?.slice(0, 64) ?? null };
  } catch {
    // Outside a request scope: the benchmark driver, a worker, a test.
    return { inRequest: false, token: null };
  }
}

/**
 * Why this caller may not act on this trip, or null when they may.
 *
 * For server actions: `if (refusal) return { ok: false, error: refusal }`, in
 * whatever result shape the action already speaks. Cheap on purpose — one
 * cookie read and one indexed column read — so it can sit in front of every
 * mutating action without anybody being tempted to skip it.
 */
export async function tripAccessRefusal(tripId: string): Promise<string | null> {
  const { inRequest, token } = await browserSession();
  if (!inRequest) return null;
  const owner = tripOwnerToken(tripId);
  if (!owner || !token || owner !== token) return FOREIGN_TRIP_REFUSAL;
  return null;
}

/**
 * The trip, only when the asking browser made it.
 *
 * For pages: `const trip = await ownedTrip(id); if (!trip) notFound();` — a
 * foreign trip renders exactly as a missing one, which is what keeps the URL
 * from being an oracle. Internal callers get the trip, per the exemption above.
 */
export async function ownedTrip(tripId: string): Promise<Trip | null> {
  const trip = getTrip(tripId);
  if (!trip) return null;
  return (await tripAccessRefusal(tripId)) === null ? trip : null;
}
