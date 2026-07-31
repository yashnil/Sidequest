import { z } from 'zod';
import { transportModeSchema } from './access';
import {
  isoDateSchema,
  minuteOfDaySchema,
  physicalIntensitySchema,
} from './common';

export { MINUTES_PER_DAY, formatMinuteOfDay, minuteOfDaySchema, parseMinuteOfDay } from './common';

/**
 * The scheduled output of the planner — the fourth and last of the four kinds of
 * state this domain keeps deliberately separate:
 *
 *   1. source facts about a place        → `Place` (curated, never mutated)
 *   2. traveller-specific computed fit   → `FitAssessment`
 *   3. trip-specific feasibility         → the planner's own candidate type
 *   4. the scheduled itinerary           → everything in this file
 *
 * The time model — minutes from local midnight, with the date as a separate
 * label — lives in `schemas/common.ts` and is re-exported here.
 */

/**
 * Bump this whenever a stored plan could now be *wrong* rather than merely old.
 *
 * A plan is read back and rendered without re-running the validator — the issues
 * it carries were computed when it was built. So the version is the only thing
 * standing between a traveller and a screen that confidently states a fact which
 * has since stopped being true. When in doubt, bump: a rebuild costs a click and
 * keeps every selection.
 *
 * 4 — Manzanar became two places. The compound record's visitor-centre hours no
 * longer belong to the site that kept its id, so a version-3 plan can quote a
 * window against a place that has none. Any change to the shape of the place
 * data that a stored item embeds belongs here.
 *
 * 3 — activities are scheduled inside verified operating hours. Each visit
 * carries the window it was placed in, its last admission, its booking
 * requirements and where those facts came from, and each day carries an
 * availability summary. A version-2 plan was built without any of that and could
 * legally contain a visit that starts after the gate shuts.
 *
 * 2 — the timeline carries typed multimodal transportation. Travel segments name
 * a transport mode and a role rather than `car | foot | transit`, day totals
 * split driving from riding, walking and waiting, and every day carries a
 * transport summary.
 */
export const ITINERARY_VERSION = 4 as const;

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

/** What a transportation leg is doing, so a timeline can label it without prose. */
export const TRAVEL_ROLES = ['approach', 'wait', 'ride', 'walk', 'transfer', 'return'] as const;
export const travelRoleSchema = z.enum(TRAVEL_ROLES);
export type TravelRole = z.infer<typeof travelRoleSchema>;

export const travelSegmentSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  fromName: z.string().min(1),
  toName: z.string().min(1),
  minutes: z.number().int().min(0),
  km: z.number().min(0),
  mode: transportModeSchema,
  role: travelRoleSchema.default('approach'),
  /** Set when this leg is a ride on a scheduled service. */
  serviceId: z.string().min(1).optional(),
  /**
   * Carried through so the UI can never present a model as a measurement.
   * `official` means it came off a published timetable.
   */
  provenance: z.enum(['measured', 'modelled', 'official', 'estimated']),
});
export type TravelSegment = z.infer<typeof travelSegmentSchema>;

/**
 * The operating evidence a scheduled visit was placed against.
 *
 * Persisted with the plan rather than recomputed on render, for two reasons.
 * A stored itinerary has to be able to explain itself — "we put you here at
 * 09:05 because it opens at 09:00 and stops admitting at 17:45, read off the
 * park's own page on 30 July" — and a validator has to be able to catch a
 * timeline that has drifted from the hours it claims to respect.
 *
 * Only present on activities the hours actually constrain. A roadside viewpoint
 * with no gate carries nothing, because a badge reading "open 24 hours" on every
 * natural attraction in a region teaches people to stop reading badges.
 */
export const scheduledHoursSchema = z
  .object({
    openMinute: minuteOfDaySchema,
    closeMinute: minuteOfDaySchema,
    /** Published last entry, when the operator publishes one. */
    lastAdmissionMinute: minuteOfDaySchema.optional(),
    /** Which recurring period this came from — "Summer", "Visitor centre". */
    periodLabel: z.string().min(1).optional(),
    /** How the source was obtained, so the UI can never call a guess official. */
    sourceKind: z.enum(['official', 'authored', 'estimated']),
    sourceName: z.string().min(1),
    sourceUrl: z.string().url().optional(),
    lastVerified: isoDateSchema.optional(),
    confidence: z.number().min(0).max(1),
  })
  .refine((hours) => hours.closeMinute > hours.openMinute, {
    message: 'A scheduled opening window must close after it opens',
    path: ['closeMinute'],
  });
export type ScheduledHours = z.infer<typeof scheduledHoursSchema>;

/**
 * Something the traveller has to arrange themselves before the day will work.
 *
 * Sidequest books nothing. A required reservation is handed back with the
 * official link attached; it is never resolved, and the plan never implies one
 * exists.
 */
export const BOOKING_KINDS = ['reservation', 'timed_entry', 'permit'] as const;
export const bookingKindSchema = z.enum(BOOKING_KINDS);
export type BookingKind = z.infer<typeof bookingKindSchema>;

export const BOOKING_KIND_LABELS: Record<BookingKind, string> = {
  reservation: 'Booking needed',
  timed_entry: 'Timed entry',
  permit: 'Entry permit',
};

export const bookingRequirementSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  kind: bookingKindSchema,
  note: z.string().min(1).optional(),
  url: z.string().url().optional(),
});
export type BookingRequirement = z.infer<typeof bookingRequirementSchema>;

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
    /** Set on activities whose opening hours constrained where they were placed. */
    hours: scheduledHoursSchema.optional(),
    /** Set when this visit needs booking or a permit the traveller must arrange. */
    booking: bookingRequirementSchema.optional(),
    /**
     * Officially signed for daylight use only. Carried so the traveller is told
     * and so the fact survives into a stored plan — *not* enforced: Sidequest
     * has no sunrise or sunset times yet, and every surface that shows this says
     * as much rather than implying the light was checked.
     *
     * Optional rather than defaulted: absent means "not daylight-limited", and
     * every travel, meal and rest item on the timeline would otherwise have to
     * carry a `false` that says nothing.
     */
    daylightOnly: z.boolean().optional(),
    /**
     * A fact about this stop that changes without notice and that Sidequest has
     * not checked today. Never implies the opposite when absent — it means there
     * is nothing volatile on record, not that conditions were confirmed.
     */
    verifyBeforeTravel: z.string().min(1).optional(),
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

export const dayTotalsSchema = z
  .object({
    activityMinutes: z.number().int().min(0),
    /** Every minute spent getting somewhere: driving, riding, walking, waiting. */
    travelMinutes: z.number().int().min(0),
    /** At the wheel. The only part a driving limit applies to. */
    driveMinutes: z.number().int().min(0),
    transitMinutes: z.number().int().min(0),
    /** On foot to reach something, not on foot as the activity itself. */
    walkMinutes: z.number().int().min(0),
    waitMinutes: z.number().int().min(0),
    /** Road distance only. A shuttle ride adds minutes here, not kilometres. */
    travelKm: z.number().min(0),
    freeMinutes: z.number().int().min(0),
    strenuousCount: z.number().int().min(0),
  })
  .refine(
    (totals) =>
      totals.travelMinutes ===
      totals.driveMinutes + totals.transitMinutes + totals.walkMinutes + totals.waitMinutes,
    {
      message: 'Total transport time must be the sum of its parts',
      path: ['travelMinutes'],
    },
  );
export type DayTotals = z.infer<typeof dayTotalsSchema>;

/** How a single day is actually got through. */
export const dayTransportSchema = z.object({
  /** The mode that carries the most minutes. `walk` on a day spent in town. */
  primaryMode: transportModeSchema,
  /** Every mode used, in the order it is first used. */
  modes: z.array(transportModeSchema),
  /** Scheduled services this day depends on. */
  serviceIds: z.array(z.string().min(1)).default([]),
  /** The last departure this day is built around, when there is one. */
  lastReturnNote: z.string().min(1).optional(),
  parkingNotes: z.array(z.string().min(1)).default([]),
  accessNotes: z.array(z.string().min(1)).default([]),
  /** Conditions that change year to year and must be confirmed before travel. */
  verifyBeforeTravel: z.array(z.string().min(1)).default([]),
});
export type DayTransport = z.infer<typeof dayTransportSchema>;

/**
 * What the day's opening hours did to its shape.
 *
 * Derived from the timeline rather than declared alongside it, so it cannot
 * drift. The anchor is the useful part: on a day containing one place that shuts
 * at four and three that never shut, the plan is really "be at the one with a
 * closing time by this hour, and fit the rest around it" — and saying so is more
 * use than a list of times the traveller has to compare themselves.
 */
export const dayAvailabilitySchema = z.object({
  /** The stop whose hours fixed the shape of the day, when one did. */
  anchorPlaceId: z.string().min(1).optional(),
  anchorNote: z.string().min(1).optional(),
  /** Stops with no closing time, which can move if the day changes. */
  flexiblePlaceIds: z.array(z.string().min(1)).default([]),
  /** Hours facts worth reading before committing to the day. */
  cautions: z.array(z.string().min(1)).default([]),
  /** Hours that change without notice and have not been checked today. */
  verifyBeforeTravel: z.array(z.string().min(1)).default([]),
  /** Unresolved bookings and permits. Never resolved by Sidequest. */
  bookings: z.array(bookingRequirementSchema).default([]),
});
export type DayAvailability = z.infer<typeof dayAvailabilitySchema>;

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
  transport: dayTransportSchema,
  availability: dayAvailabilitySchema,
  intensity: z.enum(['light', 'moderate', 'intense']),
  warnings: z.array(z.string().min(1)).default([]),
});
export type ItineraryDay = z.infer<typeof itineraryDaySchema>;

/**
 * The trip's transportation position, derived from what was actually scheduled.
 *
 * Every field here is either a fact from the access data or a conclusion drawn
 * from the finished plan. There is no cost total: without fares, fuel prices and
 * parking charges, a number would be a guess with a currency symbol on it.
 */
export const TRANSPORT_ASSESSMENTS = ['low', 'moderate', 'high'] as const;
export const transportAssessmentSchema = z.enum(TRANSPORT_ASSESSMENTS);
export type TransportAssessment = z.infer<typeof transportAssessmentSchema>;

export const transportStrategySchema = z.object({
  primaryMode: transportModeSchema,
  /** A genuine alternative, or null when there honestly is not one. */
  secondaryMode: transportModeSchema.nullable(),
  headline: z.string().min(1),
  /** Why this mode suits this traveller in this region. */
  rationale: z.array(z.string().min(1)).min(1),
  /** What this choice costs them, stated plainly. */
  tradeoffs: z.array(z.string().min(1)).default([]),
  /** What a traveller without the primary mode would lose. */
  withoutPrimary: z.string().min(1).optional(),
  convenience: transportAssessmentSchema,
  stress: transportAssessmentSchema,
  parkingSummary: z.string().min(1),
  transitSummary: z.string().min(1),
  seasonalWarnings: z.array(z.string().min(1)).default([]),
  verifyBeforeTravel: z.array(z.string().min(1)).default([]),
  /** Totals across the whole trip, in the same four buckets as a day. */
  totals: z.object({
    driveMinutes: z.number().int().min(0),
    transitMinutes: z.number().int().min(0),
    walkMinutes: z.number().int().min(0),
    waitMinutes: z.number().int().min(0),
    driveKm: z.number().min(0),
  }),
  /** Says in one line where the numbers came from. Never omitted. */
  dataDisclosure: z.string().min(1),
});
export type TransportStrategy = z.infer<typeof transportStrategySchema>;

export const UNSCHEDULED_REASON_CODES = [
  'seasonally_closed',
  'not_feasible',
  'no_time_left',
  'exceeds_daily_travel',
  'exceeds_intensity',
  'frequency_reached',
  'lower_priority',
  'missing_travel_data',
  /** No legal way in on any day of the trip, for this traveller. */
  'access_unavailable',
  /** There is a way in, but the service does not run on the days that were free. */
  'service_not_operating',
  /** It fits on paper but not before the last way out. */
  'missed_last_return',
  'transport_mode_unavailable',
  /** Shut on every day of the trip — season, weekday or published closure. */
  'closed_on_trip_dates',
  /** Open on some day, but never for long enough, or never early enough. */
  'hours_do_not_fit',
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
  // --- Transportation and access ---------------------------------------
  'required_mode_unavailable',
  'service_out_of_season',
  'service_not_operating_on_date',
  'missed_last_return',
  'access_window_too_short',
  'duplicate_access_sequence',
  'parking_unavailable',
  'road_surface_incompatible',
  'remote_area_incompatible',
  'missing_access_data',
  'daily_drive_exceeded',
  'daily_transport_exceeded',
  'transport_leg_without_endpoint',
  'inconsistent_transport_totals',
  'strategy_mode_mismatch',
  // --- Attraction operating hours ---------------------------------------
  // Deliberately separate from the access codes above. A place can be
  // reachable and shut, or open and unreachable, and a traveller told "this
  // does not work" deserves to know which of the two it was.
  /** Scheduled on a date it is not open at all. */
  'attraction_closed_on_date',
  /** Scheduled to begin before it opens. */
  'arrives_before_opening',
  /** Scheduled to begin after it stops admitting people. */
  'arrives_after_last_admission',
  /** Scheduled to run past closing time. */
  'visit_ends_after_closing',
  /** Its open hours and the way in never overlap on the scheduled day. */
  'no_operating_window_in_access_window',
  /** A booking or permit the traveller has to arrange and has not. */
  'booking_unresolved',
  /** Scheduled on hours nobody has confirmed. */
  'operating_hours_unknown',
  /** A scheduled place has no operating record at all. */
  'missing_operating_data',
  /** The stored hours evidence disagrees with the times on the timeline. */
  'operating_evidence_inconsistent',
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
  /** Took a stop out of a shared access group so the rest of it still fits. */
  'shortened_access_group',
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
  /** Which generation of opening-hours data the plan was built against. */
  operatingHoursVersion: z.number().int().min(1),
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
  transportStrategy: transportStrategySchema,
  days: z.array(itineraryDaySchema).min(1),
  unscheduled: z.array(unscheduledPlaceSchema),
  issues: z.array(validationIssueSchema),
  diagnostics: planDiagnosticsSchema,
});
export type Itinerary = z.infer<typeof itinerarySchema>;

/**
 * A stable structural fingerprint of the plan: what is scheduled, in what order,
 * at what times, on what day, **by what means**, and **inside which opening
 * window**.
 *
 * Its job is to make the §27 rule enforceable — when a narration layer is added,
 * a test asserts this string is byte-identical before and after narration, so the
 * LLM provably cannot move a stop, change a time, swap a mode, quietly turn a
 * shuttle ride into a drive, or relax the window a visit was placed inside.
 * Transport and hours are both in here precisely because prose about them is the
 * most tempting thing for a model to "improve".
 *
 * Deliberately excludes prose, totals and diagnostics: those are descriptions of
 * the structure, not the structure itself.
 */
export function itineraryStructureFingerprint(itinerary: Itinerary): string {
  const strategy = [
    itinerary.transportStrategy.primaryMode,
    itinerary.transportStrategy.secondaryMode ?? '-',
  ].join('>');

  const days = itinerary.days
    .map((day) => {
      const items = day.items
        .map((item) =>
          [
            item.kind,
            item.placeId ?? '-',
            item.startMinute,
            item.endMinute,
            item.travel
              ? `${item.travel.mode}/${item.travel.role}/${item.travel.fromId}>${item.travel.toId}`
              : '-',
            item.hours
              ? `${item.hours.openMinute}-${item.hours.closeMinute}/${item.hours.lastAdmissionMinute ?? '-'}`
              : '-',
            item.booking ? item.booking.kind : '-',
          ].join(':'),
        )
        .join('|');
      const transport = [day.transport.primaryMode, ...day.transport.serviceIds].join('+');
      const anchor = day.availability.anchorPlaceId ?? '-';
      return `${day.dayNumber}@${day.date}#${day.window.startMinute}-${day.window.endMinute}{${transport}}<${anchor}>[${items}]`;
    })
    .join('\n');

  return `${strategy}\n${days}`;
}
