/**
 * HOW LONG SOMETHING HAS BEEN GOING, IN WORDS A PERSON USES.
 *
 * The progress screen printed `12458m 52s`. That is eight and a half days
 * expressed in minutes, on a card whose badge said "Working" — and both halves
 * of that sentence came from the same missing idea: the formatter had no unit
 * above the minute, and nothing anywhere asked whether the job was still alive.
 *
 * This half fixes the units. Minutes stop at two hours because past that point
 * the number stops being a duration somebody is waiting out and starts being a
 * date; hours stop at two days for the same reason.
 *
 * Every function refuses rather than guesses. A negative span — which happens
 * whenever a browser clock sits a few seconds behind the server that stamped
 * the row — is clamped to zero, because `-3s` on a progress screen reads as a
 * much worse bug than it is.
 */

/** The point past which minutes are no longer how anybody says it. */
const MINUTES_CEILING_SECONDS = 120 * 60;

/** The point past which hours are no longer how anybody says it. */
const HOURS_CEILING_SECONDS = 48 * 60 * 60;

/**
 * `8s` · `4m 20s` · `1h 12m` · `3 days`.
 *
 * Seconds are dropped once minutes are in play at all beyond an hour: nobody
 * waiting on a two-hour build cares about the 41 on the end, and a figure that
 * changes every second is a figure the eye cannot rest on.
 */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.round(seconds);

  if (whole < 60) return `${whole}s`;

  if (whole < MINUTES_CEILING_SECONDS) {
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  if (whole < HOURS_CEILING_SECONDS) {
    const hours = Math.floor(whole / 3600);
    const minutes = Math.round((whole % 3600) / 60);
    // 59.6 minutes rounding to 60 would render "2h 60m".
    if (minutes >= 60) return `${hours + 1}h`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  const days = Math.round(whole / 86_400);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * How long ago something happened, as a phrase that ends a sentence.
 *
 * Used where a build stopped rather than where one is running: "stopped 3 days
 * ago" is what somebody needs in order to decide whether to start it again, and
 * a live-ticking clock on a dead job is the specific lie this replaced.
 *
 * Null when the timestamp will not read, so the caller writes a sentence
 * without it rather than one containing the word `undefined`.
 */
export function formatTimeAgo(iso: string | undefined, now: Date): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));

  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 7200) return 'an hour ago';
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hours ago`;
  if (seconds < 172_800) return 'yesterday';
  if (seconds < 2_592_000) return `${Math.round(seconds / 86_400)} days ago`;
  const months = Math.round(seconds / 2_592_000);
  return months <= 1 ? 'last month' : `${months} months ago`;
}
