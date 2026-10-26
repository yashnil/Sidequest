import type { Itinerary, NextAction, NextActions } from '@sidequest/core';

/**
 * TODAY, BEFORE THE TRIP.
 *
 * Outside the trip's dates Today used to be a dead end: "Not travelling today ·
 * starts on 2026-11-10 · Back to trip". It now answers the three things a
 * traveller opening it early wants — how long until we go, what the first day
 * looks like, and what is left to do — from the same persisted plan and the
 * same deterministic next actions the hub reads. Pure: no clock of its own
 * (the trip-local date comes in), no provider, no model, and no urgency that
 * the next-action ranking did not already state.
 */
export interface FirstDayPreview {
  dayNumber: number;
  date: string;
  theme: string;
  baseName: string;
  /** The day's planned stops, in order, at most four. */
  stops: { title: string; startMinute: number }[];
  /** How many stops the day holds in all. */
  stopCount: number;
  /**
   * How far the clock can be read: `measured` prints times, `estimated` prints
   * them as approximate, `band` prints none (the day is shown in day parts on
   * the hub, so a minute here would claim more than the plan does).
   */
  timing: 'measured' | 'estimated' | 'band';
}

/** Whole calendar days from one ISO date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** "Tuesday 10 November 2026" — the ISO date as a person reads it. */
export function longDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "Tomorrow", "In 3 days", "In 2 weeks", read from a day count. Never a time of day. */
export function countdownWords(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `In ${days} days`;
  if (days < 60) return `In ${Math.round(days / 7)} weeks`;
  return `In ${Math.round(days / 30)} months`;
}

export function firstDayPreview(itinerary: Pick<Itinerary, 'days'>): FirstDayPreview | null {
  const day = itinerary.days[0];
  if (!day) return null;
  const stops = day.items.filter((item) => item.kind === 'activity');
  return {
    dayNumber: day.dayNumber,
    date: day.date,
    theme: day.theme.replace(/\.$/, ''),
    baseName: day.baseName,
    stops: stops.slice(0, 4).map((item) => ({ title: item.title, startMinute: item.startMinute })),
    stopCount: stops.length,
    timing: day.timing?.precision ?? 'measured',
  };
}

/**
 * The next actions, pointed at the hub.
 *
 * A node's `href` is an anchor inside the hub (`#book-first`, `#day-2`), which
 * means nothing on this page; the link is made absolute to the trip's hub so it
 * lands on the same section. The ranking, the words and any due date are the
 * next-action model's own.
 */
export function prepActions(nextActions: NextActions | null, tripId: string, limit = 3): (NextAction & { link: string })[] {
  if (!nextActions) return [];
  return nextActions.actions
    .filter((action) => action.kind !== 'travel')
    .slice(0, limit)
    .map((action) => ({ ...action, link: action.href.startsWith('#') ? `/trips/${tripId}/itinerary${action.href}` : action.href }));
}
