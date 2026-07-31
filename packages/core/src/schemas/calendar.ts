import { z } from 'zod';

/**
 * Calendar primitives shared by every recurring schedule in the domain — the
 * transport service calendars in `schemas/access.ts` and the attraction
 * operating calendars in `schemas/hours.ts`.
 *
 * They live here rather than in either of those files because a weekday is not
 * an access concept or an opening-hours concept; it is a property of the date.
 * Both files re-export what they use, so no existing import path changed.
 *
 * A date is a `YYYY-MM-DD` label on a page of a calendar, never an instant.
 * Everything here reads it in UTC for exactly that reason: read in local time, a
 * Sunday-only service silently starts running on Saturdays for anyone west of
 * Greenwich.
 */

export const dayOfWeekSchema = z.number().int().min(0).max(6);
/** 0 = Sunday, matching `Date.prototype.getUTCDay`. */
export const DAY_OF_WEEK_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const monthNumberSchema = z.number().int().min(1).max(12);

/** `MM-DD`, for a closure that recurs on the same calendar date every year. */
export const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const monthDaySchema = z
  .string()
  .regex(MONTH_DAY, 'Expected an MM-DD calendar date')
  .refine(
    (value) => !Number.isNaN(Date.parse(`2024-${value}T00:00:00Z`)),
    'Not a real calendar date',
  );

/**
 * Rejects anything that is not a real `YYYY-MM-DD` day.
 *
 * `Date.parse` accepts `2026-02-30` and rolls it forward to March 2. Left alone,
 * a month check would read February while a weekday check read March — the same
 * input evaluated against two different days. The round trip is what stops that.
 */
export function assertCalendarDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`"${date}" is not a calendar date.`);
  }
  return parsed;
}

/** Weekday of a `YYYY-MM-DD` label. 0 = Sunday. */
export function dayOfWeekFor(date: string): number {
  return assertCalendarDate(date).getUTCDay();
}

/** Month (1-12) of a `YYYY-MM-DD` label. */
export function monthFor(date: string): number {
  return assertCalendarDate(date).getUTCMonth() + 1;
}

/** The `MM-DD` part of a `YYYY-MM-DD` label. */
export function monthDayFor(date: string): string {
  assertCalendarDate(date);
  return date.slice(5, 10);
}
