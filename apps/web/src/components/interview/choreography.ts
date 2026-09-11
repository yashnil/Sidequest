/**
 * V8 — THE INTERVIEW'S MOTION BUDGET, STATED ONCE.
 *
 * Every Motion for React call on the setup, interview, party and review
 * surfaces reads its duration from here, so the budget in the V8 brief is a
 * number in one file rather than a convention spread over ten. Seconds, because
 * that is Motion's unit; the CSS tokens in `globals.css` carry the same values
 * in milliseconds for the hover and press work that never touches JS.
 *
 * - A question replacing another: ≤ 260 ms.
 * - The trip portrait settling after an answer: ≤ 320 ms.
 * - The review's timing card crossing from pick to locked: ≤ 260 ms.
 * - The new-trip canvas crossing into the map: ≤ 420 ms.
 *
 * `useReducedMotion()` collapses each of these to zero at the call site; nothing
 * here may be depended on finishing.
 */
export const QUESTION_S = 0.24;
export const PORTRAIT_S = 0.3;
export const CROSSFADE_S = 0.24;
export const CANVAS_S = 0.4;

/** The product's `--ease-out`, as the cubic-bezier array Motion accepts. */
export const EASE_OUT: [number, number, number, number] = [0.2, 0.7, 0.2, 1];

export type Direction = 'forward' | 'back';

/**
 * A question entering from the side it came from: forward slides in from the
 * right, back from the left, and the outgoing one fades in place. The offset is
 * the same 18 px `.enter-forward` uses, so a CSS-animated screen and a
 * Motion-animated one move the same distance.
 */
export const QUESTION_VARIANTS = {
  initial: (direction: Direction) => ({ opacity: 0, x: direction === 'back' ? -18 : 18 }),
  animate: { opacity: 1, x: 0 },
  /*
   * The leaving question goes at once. Its slot is taken by the entering one,
   * and anything reading "which question is on screen" the moment Continue is
   * pressed (the browser suite does, and so does a screen reader) must find
   * exactly one. The directional entrance carries the movement.
   */
  exit: { opacity: 0, transition: { duration: 0 } },
} as const;

/** A transition that respects a reduced-motion preference by having no duration at all. */
export function timing(seconds: number, reduced: boolean | null): { duration: number; ease: typeof EASE_OUT } {
  return { duration: reduced ? 0 : seconds, ease: EASE_OUT };
}
