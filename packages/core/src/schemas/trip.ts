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

/**
 * HOW WELL AN ARRIVAL OR DEPARTURE IS KNOWN.
 *
 * The same six values the composer already models (`ARRIVAL_PRECISIONS`),
 * declared here so the trip row can carry one without `schemas/trip.ts`
 * depending on `schemas/composer.ts`. `edge-truth.test.ts` asserts the two
 * lists never drift.
 */
export const EDGE_PRECISIONS = ['exact', 'morning', 'afternoon', 'evening', 'unknown', 'not_booked'] as const;
export const edgePrecisionSchema = z.enum(EDGE_PRECISIONS);
export type EdgePrecision = z.infer<typeof edgePrecisionSchema>;

/**
 * THE ONE TEST A SURFACE MAY USE BEFORE PRINTING A CLOCK TIME FOR AN EDGE.
 *
 * True only when the traveller gave an exact time. An absent precision is a
 * trip stored before the field existed and reads as unknown, so an old row
 * stops asserting a time it never had.
 */
export function edgeIsStatable(precision: EdgePrecision | undefined): boolean {
  return precision === 'exact';
}

/**
 * What a surface may say about an edge, at the precision that is actually known.
 *
 * Always safe to print. `time` is passed separately rather than read from the
 * trip so that a caller cannot accidentally hand this the allowance and get it
 * back as a fact: it is used only when `precision` is `exact`.
 */
export function describeEdgeTime(precision: EdgePrecision | undefined, time: string): string {
  switch (precision) {
    case 'exact':
      return `at ${time}`;
    case 'morning':
      return 'in the morning';
    case 'afternoon':
      return 'in the afternoon';
    case 'evening':
      return 'in the evening or later';
    case 'not_booked':
      return 'not booked yet';
    default:
      return 'time not set yet';
  }
}

export const MAX_TRIP_NIGHTS = 30;

export const tripBasicsSchema = z
  .object({
    mode: tripModeSchema,
    /**
     * A place name, and bounded like one.
     *
     * Every other identifier in this object is capped — the counts, the dates,
     * the enums — and this was not, on the one field that is free text typed by
     * a stranger and then carried to a geocoder, to a compiler and into a model
     * prompt. Unbounded free text on that path is an amplifier: a megabyte of it
     * costs a request per creation, tokens per creation, and a row that every
     * later render reads back.
     *
     * 200 is not a guess. It is the same bound `destinationQuery` carries in
     * `composer.ts` — the field this one is built from — so the two halves of
     * the same string cannot disagree about what is acceptable. The longest
     * real place names in the destination index are well inside it.
     */
    destinationInput: z
      .string()
      .trim()
      .min(2, 'Tell us where you are going')
      .max(200, 'That is longer than a place name'),
    regionId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    /**
     * THE PLANNING ALLOWANCE, NOT A FACT ABOUT A FLIGHT.
     *
     * PRODUCTION LOCK V5 §7. These two fields are required, so a trip has
     * always held two clock times — and when nobody knew the real ones, they
     * held `15:00` and `11:00`, invented at trip creation. That would be
     * defensible as an internal allowance and nothing more. It was not: three
     * traveller-facing surfaces printed them as facts ("Arriving at 15:00, so
     * the day starts after you have landed and settled", "Day 6 ends with your
     * departure at 11:00", and the same figures in the quality audit).
     *
     * They keep their meaning — the minute planning may assume — and the
     * precision beside them now says whether any surface may *print* one.
     * `edgeIsStatable` is the only test any renderer should use.
     */
    arrivalTime: isoTimeSchema,
    departureTime: isoTimeSchema,
    /**
     * How well the traveller actually knows each edge.
     *
     * Optional so every trip stored before this field parses; an absent value
     * reads as `unknown`, which is the honest reading of a row written when the
     * product had no way to record the difference — and which makes the times
     * above unprintable rather than silently trusted.
     */
    arrivalPrecision: edgePrecisionSchema.optional(),
    departurePrecision: edgePrecisionSchema.optional(),
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
