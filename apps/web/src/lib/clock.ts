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
  return Date.now();
}
