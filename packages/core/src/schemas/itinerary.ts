import { z } from 'zod';
import { isoDateSchema, physicalIntensitySchema } from './common';

/**
 * The scheduled output of the planner — the fourth and last of the four kinds of
 * state this domain keeps deliberately separate:
 *
 *   1. source facts about a place        → `Place` (curated, never mutated)
 *   2. traveller-specific computed fit   → `FitAssessment`
 *   3. trip-specific feasibility         → the planner's own candidate type
 *   4. the scheduled itinerary           → everything in this file
 *
 * TIME MODEL
 *
 * Every clock time is an integer number of minutes from local midnight, and the
 * calendar date lives once, on the day. No `Date`, no offsets, no DST. A trip
 * plan is wall-clock by nature — "leave at 08:30" means 08:30 where you are
 * standing — and modelling it as an absolute instant would invite exactly the
 * off-by-one-day and timezone bugs that make itineraries subtly wrong.
 */

export const ITINERARY_VERSION = 1 as const;

export const MINUTES_PER_DAY = 24 * 60;

export const minuteOfDaySchema = z.number().int().min(0).max(MINUTES_PER_DAY);

export function formatMinuteOfDay(minute: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minute)));
  const hours = Math.floor(clamped / 60) % 24;
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function parseMinuteOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`"${value}" is not an HH:MM time.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** What a block of time on a day actually is. */
export const ITINERARY_ITEM_KINDS = [
  'activity',
  'travel',
  'meal',
  'rest',
  'free_time',
] as const;
export const itineraryItemKindSchema = z.enum(ITINERARY_ITEM_KINDS);
export type ItineraryItemKind = z.infer<typeof itineraryItemKindSchema>;

export const travelSegmentSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  fromName: z.string().min(1),
  toName: z.string().min(1),
  minutes: z.number().int().min(0),
  km: z.number().min(0),
  mode: z.enum(['car', 'foot', 'transit']),
  /** Carried through so the UI can never present a model as a measurement. */
  provenance: z.enum(['measured', 'modelled', 'estimated']),
});
export type TravelSegment = z.infer<typeof travelSegmentSchema>;

export const itineraryItemSchema = z
  .object({
    id: z.string().min(1),
    kind: itineraryItemKindSchema,
    title: z.string().min(1),
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
    durationMinutes: z.number().int().min(0),
    /** Present on `activity` items; absent on meals, rest and free time. */
    placeId: z.string().min(1).optional(),
    travel: travelSegmentSchema.optional(),
    /** Why the planner put this here. Shown to the traveller. */
    reason: z.string().min(1),
    note: z.string().min(1).optional(),
    weatherSensitive: z.boolean().default(false),
    seasonalNote: z.string().min(1).optional(),
    accessWarning: z.string().min(1).optional(),
    physicalIntensity: physicalIntensitySchema.optional(),
  })
  .refine((item) => item.endMinute >= item.startMinute, {
    message: 'An item cannot end before it starts',
    path: ['endMinute'],
  })
  .refine((item) => item.durationMinutes === item.endMinute - item.startMinute, {
    message: 'Duration must match the start and end times',
    path: ['durationMinutes'],
  });
export type ItineraryItem = z.infer<typeof itineraryItemSchema>;

/**
 * The hours actually available on a given day, after arrival and departure
 * constraints and the traveller's preferred start time.
 */
export const dailyWindowSchema = z
  .object({
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
    usableMinutes: z.number().int().min(0),
    /** Why this day is shorter or later than a normal one, when it is. */
    note: z.string().min(1).optional(),
  })
  .refine((window) => window.endMinute >= window.startMinute, {
    message: 'A day cannot end before it starts',
    path: ['endMinute'],
  });
export type DailyWindow = z.infer<typeof dailyWindowSchema>;

export const dayTotalsSchema = z.object({
  activityMinutes: z.number().int().min(0),
  travelMinutes: z.number().int().min(0),
  travelKm: z.number().min(0),
  freeMinutes: z.number().int().min(0),
  strenuousCount: z.number().int().min(0),
});
export type DayTotals = z.infer<typeof dayTotalsSchema>;

export const itineraryDaySchema = z.object({
  dayNumber: z.number().int().min(1),
  date: isoDateSchema,
  baseId: z.string().min(1),
  baseName: z.string().min(1),
  /** Derived deterministically from what is actually scheduled. */
  theme: z.string().min(1),
  window: dailyWindowSchema,
  items: z.array(itineraryItemSchema),
  totals: dayTotalsSchema,
  intensity: z.enum(['light', 'moderate', 'intense']),
  warnings: z.array(z.string().min(1)).default([]),
});
export type ItineraryDay = z.infer<typeof itineraryDaySchema>;

export const UNSCHEDULED_REASON_CODES = [
  'seasonally_closed',
  'not_feasible',
  'no_time_left',
  'exceeds_daily_travel',
  'exceeds_intensity',
  'frequency_reached',
  'lower_priority',
  'missing_travel_data',
] as const;
export const unscheduledReasonCodeSchema = z.enum(UNSCHEDULED_REASON_CODES);
export type UnscheduledReasonCode = z.infer<typeof unscheduledReasonCodeSchema>;

/**
 * A place the traveller chose that did not make it into the plan. Never silently
 * dropped: everything selected either appears on a day or appears here with a
 * reason, and — where one exists — the smallest change that would fix it.
 */
export const unscheduledPlaceSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  /** Whether the traveller chose this by hand or it came from auto-pick. */
  wasManual: z.boolean(),
  reasonCode: unscheduledReasonCodeSchema,
  reason: z.string().min(1),
  suggestedRemedy: z.string().min(1).optional(),
});
export type UnscheduledPlace = z.infer<typeof unscheduledPlaceSchema>;

export const VALIDATION_ISSUE_CODES = [
  'items_overlap',
  'item_outside_window',
  'place_unavailable',
  'daily_travel_exceeded',
  'travel_without_time',
  'intensity_exceeded',
  'missing_meal_break',
  'edge_day_overfull',
  'frequency_exceeded',
  'duplicate_place',
  'matrix_entry_missing',
  'must_include_unscheduled',
  'base_not_returned',
  'inconsistent_timestamps',
  'empty_itinerary',
] as const;
export const validationIssueCodeSchema = z.enum(VALIDATION_ISSUE_CODES);
export type ValidationIssueCode = z.infer<typeof validationIssueCodeSchema>;

export const ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const;
export const issueSeveritySchema = z.enum(ISSUE_SEVERITIES);
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;

export const validationIssueSchema = z.object({
  code: validationIssueCodeSchema,
  severity: issueSeveritySchema,
  message: z.string().min(1),
  dayNumber: z.number().int().min(1).optional(),
  placeId: z.string().min(1).optional(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const REVISION_ACTION_CODES = [
  'reordered_stops',
  'moved_to_another_day',
  'dropped_lowest_priority',
  'increased_buffer',
  'replaced_with_free_time',
  'separated_strenuous',
  'left_unresolved',
] as const;
export const revisionActionCodeSchema = z.enum(REVISION_ACTION_CODES);
export type RevisionActionCode = z.infer<typeof revisionActionCodeSchema>;

export const revisionActionSchema = z.object({
  code: revisionActionCodeSchema,
  description: z.string().min(1),
  dayNumber: z.number().int().min(1).optional(),
  placeId: z.string().min(1).optional(),
});
export type RevisionAction = z.infer<typeof revisionActionSchema>;

export const planDiagnosticsSchema = z.object({
  plannerVersion: z.number().int().min(1),
  generatedAt: z.string().min(1),
  matrixProvenance: z.enum(['measured', 'modelled', 'estimated']),
  matrixNote: z.string().min(1),
  revisionPasses: z.number().int().min(0),
  revisions: z.array(revisionActionSchema),
  capacity: z.object({
    usableMinutes: z.number().int().min(0),
    activityMinutes: z.number().int().min(0),
    travelMinutes: z.number().int().min(0),
    freeMinutes: z.number().int().min(0),
  }),
  counts: z.object({
    considered: z.number().int().min(0),
    scheduled: z.number().int().min(0),
    unscheduled: z.number().int().min(0),
  }),
});
export type PlanDiagnostics = z.infer<typeof planDiagnosticsSchema>;

/**
 * A plain state backed by real validator output. Deliberately not a number: a
 * "quality score" implies a measurement the planner cannot make, and invites
 * people to optimise a figure instead of reading the actual conflict.
 */
export const ITINERARY_STATUSES = ['ready', 'ready_with_cautions', 'needs_decision'] as const;
export const itineraryStatusSchema = z.enum(ITINERARY_STATUSES);
export type ItineraryStatus = z.infer<typeof itineraryStatusSchema>;

export const ITINERARY_STATUS_COPY: Record<ItineraryStatus, { label: string; blurb: string }> = {
  ready: {
    label: 'Ready',
    blurb: 'Every day fits, and nothing you chose was dropped without a reason.',
  },
  ready_with_cautions: {
    label: 'Ready, with cautions',
    blurb: 'The plan works. A few things are worth reading before you commit.',
  },
  needs_decision: {
    label: 'Needs a decision',
    blurb: 'Something you asked for cannot be scheduled as things stand. Your call.',
  },
};

export const itinerarySchema = z.object({
  version: z.literal(ITINERARY_VERSION),
  tripId: z.string().min(1),
  regionId: z.string().min(1),
  baseId: z.string().min(1),
  baseName: z.string().min(1),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  status: itineraryStatusSchema,
  summary: z.string().min(1),
  days: z.array(itineraryDaySchema).min(1),
  unscheduled: z.array(unscheduledPlaceSchema),
  issues: z.array(validationIssueSchema),
  diagnostics: planDiagnosticsSchema,
});
export type Itinerary = z.infer<typeof itinerarySchema>;

/**
 * A stable structural fingerprint of the plan: what is scheduled, in what order,
 * at what times, on what day. Deliberately excludes prose and diagnostics.
 *
 * Its job is to make the §27 rule enforceable — when a narration layer is added,
 * a test asserts this string is byte-identical before and after narration, so the
 * LLM provably cannot move a stop or change a time.
 */
export function itineraryStructureFingerprint(itinerary: Itinerary): string {
  return itinerary.days
    .map((day) => {
      const items = day.items
        .map((item) =>
          [item.kind, item.placeId ?? '-', item.startMinute, item.endMinute].join(':'),
        )
        .join('|');
      return `${day.dayNumber}@${day.date}#${day.window.startMinute}-${day.window.endMinute}[${items}]`;
    })
    .join('\n');
}
