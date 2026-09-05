import 'server-only';

/**
 * The instant a dynamic server page is being rendered at.
 *
 * React's purity rule exists because a component that reads the clock during
 * render can produce a different answer every time it re-renders, and two parts
 * of one screen can then disagree. Neither applies here, and both are worth
 * saying out loud rather than leaving to a suppression comment:
 *
 * - The itinerary page is `force-dynamic`. It is rendered once per request, on
 *   the server, and never re-rendered on the client. There is no second render
 *   to disagree with.
 * - The value is read exactly once and threaded down as a prop, so every day on
 *   the page judges the same forecast against the same instant. Reading it
 *   inside each `DayWeather` — which is what this function exists to prevent —
 *   is the version that could genuinely disagree with itself.
 *
 * It is a function in its own module rather than an inline `Date.now()` so the
 * reasoning has somewhere to live, and so any second caller has to read it.
 */
export function renderInstant(): number {
  /*
   * LIVE WORLD V1 — Today mode is tested against a fixed instant. The
   * fixture clock is honoured only when the composer is the offline fixture,
   * which no real deployment runs; a live build always reads the real clock.
   */
  const fixture = process.env.SIDEQUEST_FIXTURE_NOW;
  if (fixture && process.env.SIDEQUEST_COMPOSER_PROVIDER === 'fixture') {
    const parsed = Date.parse(fixture);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
