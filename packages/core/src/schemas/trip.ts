import { z } from 'zod';
import { isoDateSchema, isoTimeSchema } from './common';

export const TRIP_MODES = ['known_destination', 'help_me_decide', 'optimize_existing'] as const;
export const tripModeSchema = z.enum(TRIP_MODES);
export type TripMode = z.infer<typeof tripModeSchema>;

/**
 * Group facts that change the plan rather than just the header. Each of these
 * has a downstream consequence, which is why the list is short: `mobility_limited`
 * caps physical intensity and hides the intensity question, `altitude_sensitive`
 * penalises strenuous high-elevation stops, and so on.
 */
export const TRAVELER_NEEDS = [
  'kids_under_12',
  'seniors_in_group',
  'mobility_limited',
  'altitude_sensitive',
] as const;
export const travelerNeedSchema = z.enum(TRAVELER_NEEDS);
export type TravelerNeed = z.infer<typeof travelerNeedSchema>;

export const TRAVELER_NEED_LABELS: Record<TravelerNeed, string> = {
  kids_under_12: 'Kids under 12',
  seniors_in_group: 'Older travellers in the group',
  mobility_limited: 'Someone with limited mobility',
  altitude_sensitive: 'Someone sensitive to altitude',
};

export const MAX_TRIP_NIGHTS = 30;

export const tripBasicsSchema = z
  .object({
    mode: tripModeSchema,
    destinationInput: z.string().trim().min(2, 'Tell us where you are going'),
    regionId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    arrivalTime: isoTimeSchema,
    departureTime: isoTimeSchema,
    adults: z.number().int().min(1).max(12),
    children: z.number().int().min(0).max(12),
    travelerNeeds: z.array(travelerNeedSchema).default([]),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'The end date has to be on or after the start date',
    path: ['endDate'],
  })
  .refine((value) => countNights(value.startDate, value.endDate) <= MAX_TRIP_NIGHTS, {
    message: `Trips longer than ${MAX_TRIP_NIGHTS} nights are not supported yet`,
    path: ['endDate'],
  });
export type TripBasics = z.infer<typeof tripBasicsSchema>;

export const TRIP_STATUSES = ['draft', 'profiled', 'discovering', 'planned'] as const;
export const tripStatusSchema = z.enum(TRIP_STATUSES);
export type TripStatus = z.infer<typeof tripStatusSchema>;

export const tripSchema = z.object({
  id: z.string().min(1),
  basics: tripBasicsSchema,
  status: tripStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Trip = z.infer<typeof tripSchema>;

/** Whole days on the ground, inclusive of arrival and departure days. */
export function countTripDays(startDate: string, endDate: string): number {
  return countNights(startDate, endDate) + 1;
}

export function countNights(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/**
 * Every calendar date of the trip, inclusive.
 *
 * Stepped in UTC because these are labels on a calendar, not instants — reading
 * them locally is how a trip gains or loses a day across a timezone boundary,
 * and how a Thursday-only shuttle silently becomes a Wednesday one.
 */
export function tripDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return dates;

  // Guard against a malformed range producing an unbounded loop.
  let guard = 0;
  while (cursor <= last && guard < 400) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return dates;
}

/** Calendar months (1-12) the trip touches, used for seasonal access checks. */
export function tripMonths(startDate: string, endDate: string): number[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const months = new Set<number>();
  const cursor = new Date(start);
  // Step by day so a trip that spans a month boundary reports both months.
  while (cursor <= end && months.size < 12) {
    months.add(cursor.getUTCMonth() + 1);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...months].sort((a, b) => a - b);
}
