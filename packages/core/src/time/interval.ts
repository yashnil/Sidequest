/**
 * The one interval-intersection mechanism in the domain.
 *
 * Deciding whether a visit is legal means intersecting several independent
 * constraints — the hours the day has, the hours a shuttle can carry you, the
 * hours the gate is open — and then asking whether what is left holds the visit.
 * Before this existed each planner stage did its own `Math.max(a, b)` inline,
 * which is how three stages end up disagreeing about whether an endpoint counts.
 *
 * INTERVALS ARE CLOSED: `[startMinute, endMinute]`, both inclusive, in minutes
 * from local midnight. Two intervals that meet at a single minute — one ending
 * at 720, the next starting at 720 — genuinely touch, because that is how the
 * itinerary timeline packs items back to back and how the validator reads them.
 * A zero-length interval is legal and holds only a zero-minute activity.
 */

export interface MinuteInterval {
  startMinute: number;
  endMinute: number;
}

/** Null when the two do not overlap at all. */
export function intersectMinuteIntervals(
  a: MinuteInterval,
  b: MinuteInterval,
): MinuteInterval | null {
  const startMinute = Math.max(a.startMinute, b.startMinute);
  const endMinute = Math.min(a.endMinute, b.endMinute);
  return startMinute <= endMinute ? { startMinute, endMinute } : null;
}

/** Whether the interval is long enough to hold `minutes` of activity. */
export function intervalHolds(interval: MinuteInterval, minutes: number): boolean {
  return interval.endMinute - interval.startMinute >= minutes;
}
