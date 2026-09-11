import { formatMinuteOfDay } from '@sidequest/core';
import { formatMinutes } from '@/lib/format';
import { roundedDuration, roundedMinuteOfDay, roundedTravel, type ClockEdge } from '../plan-language';

/**
 * THE PLAN'S OWN WAYS OF PRINTING A TIME, A SPAN AND A DATE.
 *
 * Moved out of `ItineraryView` so the hub's own components (the day rail, the
 * overview cards, the day card) print a figure exactly as the timeline does.
 * Every rule here is about not overstating: a clock is rounded in the direction
 * that cannot make a claim false, a stay is rounded down, a journey up.
 */

/** A clock time as this page prints it: five-minute precision, in the direction that cannot make a claim false. */
export function clock(minute: number, edge: ClockEdge): string {
  return formatMinuteOfDay(roundedMinuteOfDay(minute, edge));
}

/** A span as this page prints it: rounded down, so it never overstates. */
export function span(minutes: number): string {
  return formatMinutes(roundedDuration(minutes));
}

/** A span of travel: rounded *up*, so it never understates the journey. */
export function travelSpan(minutes: number): string {
  return formatMinutes(roundedTravel(minutes));
}

/** "Wed 12 Aug" — a date a person reads, from the ISO one a machine stores. */
export function humanDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "12 Aug" — the date without its weekday, for a rail chip. */
export function shortDate(date: string): string {
  return humanDate(date).replace(/^\w+\s/, '');
}

export function firstSentence(text: string): string {
  const match = /^[^.!?]*[.!?]/.exec(text.trim());
  const sentence = (match ? match[0] : text).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}
