import { z } from 'zod';
import {
  dayOfWeekSchema,
  monthDaySchema,
  monthNumberSchema,
} from './calendar';
import { httpUrlSchema, MINUTES_PER_DAY, minuteOfDaySchema } from './common';
import { sourceProvenanceSchema } from './provenance';

/**
 * WHEN A PLACE IS ACCEPTING VISITORS — as distinct from whether you can get there.
 *
 * These are three different facts and the planner has to pass all three:
 *
 *   1. transportation access   — is there a legal way to reach and leave it?
 *                                `schemas/access.ts`. Roads, shuttles, last bus.
 *   2. operating availability  — is it open when you arrive?  *this file*.
 *                                Staffed hours, closed weekdays, last admission.
 *   3. dynamic conditions      — has something temporary changed either of those?
 *                                Never encoded as a calendar; flagged for recheck.
 *
 * A place can be reachable and shut. It can be open and unreachable. Collapsing
 * the two into one `available` boolean is exactly how a plan ends up driving
 * eighty minutes to a locked gate, so they are evaluated independently and both
 * have to pass.
 *
 * The model is a *recurring* calendar, never a dated timetable. "Open daily
 * 09:00–18:00 from May to Labor Day" stays true year after year; "closed for
 * reconstruction Thursdays in September 2026" does not, and encoding the second
 * shape here would make the product confidently wrong next season. Facts of that
 * kind belong in `provenance.recheckNote` with `volatility: 'dynamic'`.
 *
 * Time model as everywhere else: minutes from *local* midnight, with the date as
 * a separate `YYYY-MM-DD` label. No `Date` inside the planning logic.
 */

/**
 * 1 — first release. Persisted alongside a plan so a stored itinerary can say
 * which generation of hours data it was built from.
 */
export const OPERATING_HOURS_DATASET_VERSION = 1 as const;

/**
 * One continuous stretch of a day the place is open.
 *
 * Closed at both ends: `[openMinute, closeMinute]`. `lastAdmissionMinute` is the
 * last moment you may *start* a visit, and is only ever set when the operator
 * publishes one — it is a genuinely different fact from the closing time, and
 * inferring one from the other would be inventing a rule.
 */
export const openingWindowSchema = z
  .object({
    openMinute: minuteOfDaySchema,
    closeMinute: minuteOfDaySchema,
    /** Officially published last entry. Absent means the operator publishes none. */
    lastAdmissionMinute: minuteOfDaySchema.optional(),
  })
  .refine((window) => window.closeMinute > window.openMinute, {
    // A window that closes before it opens is either a data error or an
    // overnight schedule. Overnight opening is not modelled: rejecting it is
    // honest, whereas wrapping it silently would schedule a visit that starts
    // today and ends yesterday. A genuinely 24-hour place is `always_open`.
    message: 'An opening window must close after it opens; overnight hours are not supported',
    path: ['closeMinute'],
  })
  .refine((window) => window.closeMinute <= MINUTES_PER_DAY, {
    message: 'An opening window cannot run past midnight',
    path: ['closeMinute'],
  })
  .refine(
    (window) =>
      window.lastAdmissionMinute === undefined ||
      (window.lastAdmissionMinute >= window.openMinute &&
        window.lastAdmissionMinute <= window.closeMinute),
    {
      message: 'Last admission has to fall inside the opening window',
      path: ['lastAdmissionMinute'],
    },
  );
export type OpeningWindow = z.infer<typeof openingWindowSchema>;

/**
 * A recurring stretch of the year with one schedule — "summer", "winter".
 *
 * `daysOfWeek` omitted means every day. Present and partial is how a
 * closed-weekday attraction is expressed, and the planner reads it to put the
 * place on a day it is actually open rather than dropping it.
 */
export const operatingPeriodSchema = z
  .object({
    label: z.string().min(1),
    /** Months (1-12) this schedule applies to. */
    months: z.array(monthNumberSchema).min(1).max(12),
    /** Weekdays it opens, 0 = Sunday. Omitted means every day. */
    daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7).optional(),
    /** One window for a normal day; more for a split schedule. */
    windows: z.array(openingWindowSchema).min(1).max(4),
  })
  .superRefine((period, ctx) => {
    const sorted = [...period.windows].sort((a, b) => a.openMinute - b.openMinute);
    for (let index = 0; index + 1 < sorted.length; index += 1) {
      if (sorted[index + 1]!.openMinute < sorted[index]!.closeMinute) {
        ctx.addIssue({
          code: 'custom',
          message: `"${period.label}" has two opening windows that overlap`,
          path: ['windows'],
        });
        return;
      }
    }
  });
export type OperatingPeriod = z.infer<typeof operatingPeriodSchema>;

/**
 * What the traveller has to arrange before they can walk in.
 *
 * Modelled, surfaced and persisted — never resolved. Sidequest does not book
 * anything, so a required reservation is a task the plan hands back to the
 * traveller with the official link, not a feasibility question the planner
 * pretends to have answered.
 */
export const admissionRequirementSchema = z
  .object({
    reservationRequired: z.boolean().default(false),
    /** A reservation for a specific slot, not merely for the day. */
    timedEntry: z.boolean().default(false),
    /** An entry permit issued by the operator. Distinct from an access permit. */
    permitRequired: z.boolean().default(false),
    walkInAllowed: z.boolean().default(true),
    /** Entry is capped, so arriving does not guarantee getting in. */
    capacityLimited: z.boolean().default(false),
    bookingUrl: httpUrlSchema.optional(),
    note: z.string().min(1).optional(),
  })
  .refine((value) => !value.timedEntry || value.reservationRequired, {
    message: 'Timed entry means a reservation is required',
    path: ['timedEntry'],
  })
  .refine(
    (value) =>
      (!value.reservationRequired && !value.permitRequired) ||
      value.note !== undefined ||
      value.bookingUrl !== undefined,
    {
      // Telling someone they need to book without telling them where or how is
      // a dead end dressed as guidance.
      message: 'A booking requirement must carry a note or an official link',
      path: ['note'],
    },
  );
export type AdmissionRequirement = z.infer<typeof admissionRequirementSchema>;

const NO_ADMISSION_REQUIREMENT: AdmissionRequirement = {
  reservationRequired: false,
  timedEntry: false,
  permitRequired: false,
  walkInAllowed: true,
  capacityLimited: false,
};

const calendarBase = {
  placeId: z.string().min(1),
  admission: admissionRequirementSchema.default(NO_ADMISSION_REQUIREMENT),
  /**
   * Officially signed as usable only between sunrise and sunset.
   *
   * A flag rather than a window, because Sidequest has no astronomy source and
   * inventing "06:00 to 20:00" would be a fabrication that looks exactly like a
   * verified fact. What it does today is mark the dependence so the traveller is
   * told, and so the fact survives in machine-readable form for the slice that
   * adds real sunrise and sunset times. The planner does not enforce it, and
   * every surface that shows it says so.
   */
  daylightOnly: z.boolean().default(false),
  /** Prose that supplements the typed facts. Never the only place a fact lives. */
  note: z.string().min(1).optional(),
  provenance: sourceProvenanceSchema,
};

/**
 * The three honest answers to "when is this open?".
 *
 * `unknown` exists so that missing data can never be mistaken for `always_open`.
 * A trailhead with no gate and a museum whose hours nobody has looked up are
 * different situations, and a planner that treats them identically will schedule
 * the museum at seven in the evening.
 */
export const OPERATING_CALENDAR_KINDS = ['always_open', 'scheduled', 'unknown'] as const;
export const operatingCalendarKindSchema = z.enum(OPERATING_CALENDAR_KINDS);
export type OperatingCalendarKind = z.infer<typeof operatingCalendarKindSchema>;

export const operatingCalendarSchema = z.discriminatedUnion('kind', [
  z.object({
    /**
     * No staffed hours: a roadside viewpoint, an unlocked trailhead. Whether you
     * can be there is governed entirely by the road, the season and the light —
     * which is `schemas/access.ts`'s business, not this file's.
     */
    kind: z.literal('always_open'),
    ...calendarBase,
  }),
  z.object({
    kind: z.literal('scheduled'),
    ...calendarBase,
    /** At least one recurring period. Months not covered read as closed. */
    periods: z.array(operatingPeriodSchema).min(1).max(6),
    /**
     * `MM-DD` closures the operator publishes as annual — Christmas Day and the
     * like. Deliberately not a holiday engine: only dates a source states.
     */
    closedAnnualDates: z.array(monthDaySchema).max(12).default([]),
  }),
  z.object({
    /**
     * We have no verified hours. The planner treats it as usable but flags it,
     * auto-selection demotes it, and the traveller is told to check. It is never
     * silently scheduled as if it were open around the clock.
     */
    kind: z.literal('unknown'),
    ...calendarBase,
  }),
]);
export type OperatingCalendar = z.infer<typeof operatingCalendarSchema>;

export const operatingHoursDatasetSchema = z
  .object({
    version: z.literal(OPERATING_HOURS_DATASET_VERSION),
    regionId: z.string().min(1),
    calendars: z.array(operatingCalendarSchema),
  })
  .superRefine((dataset, ctx) => {
    const seen = new Set<string>();
    for (const calendar of dataset.calendars) {
      if (seen.has(calendar.placeId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Two operating calendars claim "${calendar.placeId}"`,
          path: ['calendars'],
        });
      }
      seen.add(calendar.placeId);

      if (calendar.provenance.volatility === 'dynamic' && !calendar.provenance.recheckNote) {
        ctx.addIssue({
          code: 'custom',
          // A fact we have already decided changes without notice, with nothing
          // telling the traveller to check it, is the worst of both worlds.
          message: `"${calendar.placeId}" has hours that change without notice and no recheck note`,
          path: ['calendars'],
        });
      }

      if (calendar.kind === 'unknown' && calendar.provenance.kind === 'official') {
        ctx.addIssue({
          code: 'custom',
          message: `"${calendar.placeId}" cannot have official provenance for hours we do not know`,
          path: ['calendars'],
        });
      }
    }
  });
export type OperatingHoursDataset = z.infer<typeof operatingHoursDatasetSchema>;

export function findOperatingCalendar(
  dataset: OperatingHoursDataset,
  placeId: string,
): OperatingCalendar | undefined {
  return dataset.calendars.find((calendar) => calendar.placeId === placeId);
}
