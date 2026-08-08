/**
 * THE SESSION ID, AS IT ACTUALLY ARRIVES.
 *
 * A benchmark session is identified as `bench:<uuid>`, and the colon does not
 * survive the round trip: Next hands the dynamic segment to the page
 * percent-encoded, so `params.sessionId` is `bench%3A…` while the stored row is
 * `bench:…`. Every lookup missed, every route rendered the global not-found, and
 * the failure looked exactly like "the session does not exist" — which is the
 * one explanation that is both plausible and wrong.
 *
 * Decoded in one place rather than at each call site, because the three routes
 * under this segment all need it and a fourth added later would inherit the bug
 * rather than the fix.
 *
 * `try` because `decodeURIComponent` throws on a stray `%`, and a malformed URL
 * should reach the lookup and be refused as a missing session rather than crash
 * the render.
 */
export function sessionIdFromParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
