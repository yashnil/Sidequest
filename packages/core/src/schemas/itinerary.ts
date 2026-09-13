import { z } from 'zod';
import { transportModeSchema } from './access';
import {
  isoDateSchema,
  httpUrlSchema,
  minuteOfDaySchema,
  physicalIntensitySchema,
} from './common';
import { dayFoodSummarySchema, foodPlanSchema, scheduledFoodSchema } from './food';
import { placementReportSchema } from '../route/critical';
import { gatewayPlanSchema } from '../gateway/plan';
import { experienceGraphSchema } from '../experience/graph';
import { accessConstraintSchema } from '../access/constraints';
import { qualityCompilerReportSchema } from '../quality/compiler-report';

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
 * 8 — a weather backup names the mode it is reached in.
 * `DayBackup.driveMinutesFromBase` became `travelMinutesFromBase` beside a new
 * `travelModeFromBase`. The rename is not cosmetic: since version 7 the writer
 * has been storing a *resolved* journey there — a walk, a train or a drive,
 * whichever the evidence supported — under a field name that says driving, with
 * the mode discarded. A version-7 plan therefore holds a number whose mode is
 * unrecoverable, and there is nothing to migrate from: the fact was never
 * written down. Rebuild, exactly as version 7 did for the same reason.
 *
 * 7 — a travel leg may have no duration. `minutes` and `km` are nullable and
 * `provenance` gained `unmeasured`, so a pair nobody routed is an absence rather
 * than a number. Days carry `unmeasuredLegCount` and travel totals count only
 * measured minutes. A version-6 plan cannot be rendered on this screen honestly:
 * every non-driving approach in one was a constant that the UI printed as an
 * estimate and summed into the day's travel total, so re-displaying it beside
 * totals that now mean "measured only" would understate the day and overstate
 * what was known. Rebuild rather than migrate — the missing values were never
 * recorded, so there is nothing to migrate from.
 *
 * 6 — meals are placed on the route rather than assumed at base. A meal item can
 * name a real venue, the window it was placed in, what that costs in detour
 * minutes and where the facts came from; days carry a food summary; and a
 * grocery run or a packed lunch is a scheduled thing rather than a gap. A
 * version-5 plan has "Lunch, 45 min" and nothing behind it — rendering that on a
 * screen which now names restaurants and quotes their hours would imply a check
 * that never happened, and its dinner block sits at base on a day whose route
 * ended forty minutes away.
 *
 * 5 — days are placed against weather and daylight. Each day carries the
 * evidence it was built from and which kind that was (a forecast, a historical
 * pattern, or nothing at all), weather-sensitive visits carry their own
 * assessment, and daylight-only visits are now scheduled inside a computed
 * sunrise-to-sunset window rather than merely flagged. A version-4 plan was
 * built with none of that: rendering it on a screen that now discusses weather
 * would imply a check that never happened, and it can contain a signed
 * daylight-only visit that ends after dark.
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
export const ITINERARY_VERSION = 8 as const;

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

/**
 * Why a leg carries no duration.
 *
 * A closed vocabulary rather than prose, because each of these is a different
 * product problem with a different remedy, and the traveller-facing sentence and
 * the readiness remedy are both derived from which one it is.
 */
export const UNMEASURED_TRAVEL_REASONS = [
  /** The mode this leg uses is one no configured routing provider can measure. */
  'mode_not_routed',
  /** The provider was asked and returned no route between these two points. */
  'no_route_found',
  /** A scheduled operator's own ride time, which nobody publishes as a duration. */
  'operator_unpublished',
  /** LIVE WORLD V1 — the traveller moved, reordered or added a stop; the leg beside it was measured for a different pair and is not re-measured on render. */
  'not_remeasured_after_edit',
  /** PRODUCT RECOVERY V1 — no configured router covered this pair (or none was configured, or the deadline had passed), and one end had no coordinate to estimate from. Nobody said "no route"; nobody was asked. */
  'provider_unavailable',
] as const;
export const unmeasuredTravelReasonSchema = z.enum(UNMEASURED_TRAVEL_REASONS);
export type UnmeasuredTravelReason = z.infer<typeof unmeasuredTravelReasonSchema>;

export const travelSegmentSchema = z
  .object({
    fromId: z.string().min(1),
    toId: z.string().min(1),
    fromName: z.string().min(1),
    toName: z.string().min(1),
    /**
     * Null when nobody measured this pair.
     *
     * Nullable rather than absent-or-zero on purpose. A leg that takes an unknown
     * amount of time is not a leg that takes no time, and the two were the same
     * value here until a car-free plan was found rendering a constant as a
     * measurement. A null can be refused by a total; a zero is silently summed.
     */
    minutes: z.number().int().min(0).nullable(),
    km: z.number().min(0).nullable(),
    mode: transportModeSchema,
    role: travelRoleSchema.default('approach'),
    /** Set when this leg is a ride on a scheduled service. */
    serviceId: z.string().min(1).optional(),
    /**
     * Carried through so the UI can never present a model as a measurement.
     * `official` means it came off a published timetable. `estimated` means an
     * authored dataset stated it and named a source. `unmeasured` means nobody
     * did, and then `minutes` is null — there is no fourth option in which a
     * number appears without somebody standing behind it.
     */
    provenance: z.enum(['measured', 'modelled', 'official', 'estimated', 'unmeasured']),
    /** Required exactly when `provenance` is `unmeasured`. */
    unmeasuredReason: unmeasuredTravelReasonSchema.optional(),
    /**
     * SET WHEN `mode` ABOVE IS A STAND-IN RATHER THAN THE JOURNEY.
     *
     * A car-free trip through a served region whose scheduled journeys nobody
     * could time is priced on the only network anybody measured — the
     * pedestrian one. The resolver keeps that walk rather than inventing a
     * train, so `mode` reads `walk` and `minutes` is the measured walk: an
     * honest upper bound on a journey the traveller will make by rail.
     *
     * The flag is what stops every reader downstream taking the stand-in for
     * the fact. Without it the only surface that knew was the row title, and
     * the mode chip beside it said WALK, the day booked all of it to
     * `walkMinutes`, and five separate strings told somebody who answered
     * twenty-five minutes to plan two hours on their feet. Anything that
     * classifies, totals or describes a leg by its mode must ask this first.
     *
     * Optional rather than defaulted, like `daylightOnly` above: absent means
     * the mode is the journey, and every ordinary leg on every timeline would
     * otherwise have to carry a `false` that says nothing.
     */
    unverifiedScheduled: z.literal(true).optional(),
    /**
     * LIVE WORLD V1 — what a measured figure actually is.
     *
     * `static` is a road network without traffic (Valhalla, or Google
     * TRAFFIC_UNAWARE); `traffic_aware` is a provider's figure for a specific
     * departure inside its horizon; `scheduled` is a published timetable;
     * `estimated` is Sidequest's own figure. A traffic-aware figure never
     * overwrites the static one: both are kept.
     */
    basis: z.enum(['static', 'traffic_aware', 'scheduled', 'estimated']).optional(),
    provider: z.string().min(1).optional(),
    measuredAt: z.string().datetime().optional(),
    effectiveDepartAt: z.string().datetime().optional(),
    staticMinutes: z.number().int().min(0).optional(),
    /** Encoded polyline (precision 5) of the route as the provider returned it. Only on measured legs. */
    geometry: z.string().min(1).optional(),
    /** The figure is the measured base-to-base leg; the day's stops sit en route and add time. */
    viaBases: z.literal(true).optional(),
    /** A traveller-readable transit shape, e.g. "24 min by metro + walk". */
    transitSummary: z.string().min(1).optional(),
    /**
     * PRODUCT RECOVERY V1 — what kind of estimate an `estimated` leg is.
     * `geo` is Sidequest's own figure from resolved coordinates (great-circle
     * distance × detour factor at a banded speed); `model` is the composing
     * model's figure. Present only when `provenance` is `estimated`.
     */
    estimateKind: z.enum(['geo', 'model']).optional(),
    /** The honest inputs behind a geo estimate. `approxKm` is a detour-adjusted figure, never a road measurement, and is never copied into `km`. */
    estimate: z.object({ straightLineKm: z.number().min(0), approxKm: z.number().min(0), kmh: z.number().min(0) }).optional(),
    /** Set when the model's transport hint was overridden because the geometry made it implausible (a 90 km "walk"). Carries the hinted mode. */
    modeCorrectedFrom: transportModeSchema.optional(),
    /**
     * V7 §8 — the multi-day episode this leg moves inside, by name, and the
     * movement the episode owns (a boat passage, a trail section, a game
     * drive). A leg that carries these is never a road leg, whatever the
     * matrix mode, and every surface draws it by `episodeMode`.
     */
    episode: z.string().min(1).optional(),
    episodeMode: z.enum(['boat', 'walk', 'four_wheel_drive', 'rail', 'car', 'bicycle', 'guide_or_lodge_transfer', 'horse', 'none']).optional(),
    /** V7 §9 — the draft's own word for how this leg moves (flight, high_speed_rail, taxi…), kept so intelligence never re-guesses it from a title. */
    hint: z.string().min(1).optional(),
  })
  .refine((leg) => (leg.provenance === 'unmeasured') === (leg.minutes === null), {
    message: 'A leg has a duration when and only when somebody measured or published one',
    path: ['minutes'],
  })
  .refine((leg) => leg.provenance !== 'unmeasured' || leg.unmeasuredReason !== undefined, {
    message: 'An unmeasured leg must say why it could not be measured',
    path: ['unmeasuredReason'],
  })
  .refine((leg) => leg.provenance === 'unmeasured' || leg.unmeasuredReason === undefined, {
    message: 'A leg with a duration cannot also carry a reason for having none',
    path: ['unmeasuredReason'],
  })
  /*
   * A measured walk is not a measurement of the journey it stands in for, so no
   * screen may put a measurement's confidence behind a duration for a route
   * nobody could confirm. `modelled` is the only honest label for it, and
   * refusing the plan at the door is cheaper than finding out from a badge.
   */
  .refine((leg) => leg.unverifiedScheduled !== true || leg.provenance === 'modelled', {
    message: 'A journey nobody could verify cannot carry a measurement’s confidence',
    path: ['provenance'],
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
    sourceUrl: httpUrlSchema.optional(),
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
  url: httpUrlSchema.optional(),
});
export type BookingRequirement = z.infer<typeof bookingRequirementSchema>;

/**
 * The weather a scheduled visit was placed against.
 *
 * Persisted with the plan for the same two reasons the opening-hours evidence
 * is: a stored itinerary has to be able to explain its own shape — "the exposed
 * hike is on Tuesday because Tuesday was the clear day in the forecast we read
 * at 08:12" — and a validator has to be able to catch a timeline that has
 * drifted from the evidence it claims to respect.
 *
 * `evidence` is the field that stops this being a lie. A record that says
 * `historical_pattern` may not be rendered in forecast language anywhere, and a
 * `forecast` carries the moment it was fetched so the UI can say when it goes
 * stale. Only present on activities the weather actually bore on.
 */
export const scheduledWeatherSchema = z.object({
  evidence: z.enum(['forecast', 'historical_pattern', 'unavailable']),
  suitability: z.enum(['favorable', 'workable', 'poor', 'incompatible', 'unknown']),
  /** One sentence. The reason the traveller reads. */
  summary: z.string().min(1),
  /** Stable codes, so the UI and validator do not parse prose. */
  reasonCodes: z.array(z.string().min(1)).default([]),
  /** Which weather point this came from, and what it cannot speak for. */
  locationId: z.string().min(1),
  locationLabel: z.string().min(1),
  /** ISO instant, on forecast evidence only. */
  fetchedAt: z.string().datetime().optional(),
  provider: z.string().min(1),
});
export type ScheduledWeather = z.infer<typeof scheduledWeatherSchema>;

export const itineraryItemSchema = z
  .object({
    id: z.string().min(1),
    kind: itineraryItemKindSchema,
    title: z.string().min(1),
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
    durationMinutes: z.number().int().min(0),
    /**
     * The attraction this item is about. Present on `activity` items and on the
     * travel legs that reach them; absent on meals, rest and free time.
     *
     * A scheduled meal names its venue in `food.venueId` rather than here, on
     * purpose: a food venue is not a `Place` and does not appear in `places`, so
     * putting its id in this field would make every consumer that resolves
     * `placeId` against the place table — the validator's duplicate check, the
     * day theme, the fingerprint's activity comparison — silently miss.
     */
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
    /** Set on activities the weather bore on. Absent means it did not. */
    weather: scheduledWeatherSchema.optional(),
    /** Set when this visit needs booking or a permit the traveller must arrange. */
    booking: bookingRequirementSchema.optional(),
    /**
     * Set on `meal` items the food planner decided. Absent means the block is a
     * bare gap in the day — which is what every meal on a version-5 plan was,
     * and is still the honest output when nothing verified fitted.
     */
    food: scheduledFoodSchema.optional(),
    /**
     * LIVE WORLD V1 closure — the Sidequest-owned result of an operational
     * check (business status, regular hours) made during reconciliation.
     * Provider hours and names are never stored; this is disposition and
     * provenance only, with an honest recheck flag.
     */
    operational: z
      .object({
        provider: z.string().min(1),
        checkedAt: z.string().min(1),
        outcome: z.enum(['open_at_time', 'opens_later', 'closes_earlier', 'closed_on_date', 'closed_permanently', 'closed_temporarily_now', 'hours_unknown', 'not_applicable', 'unavailable']),
        basis: z.enum(['regular', 'current', 'status_only', 'none']),
        recheck: z.boolean(),
        attribution: z.string().min(1),
        note: z.string().min(1),
      })
      .optional(),
    /**
     * Officially signed for daylight use only.
     *
     * As of version 5 this is *enforced*, not merely recorded: the visit is
     * scheduled inside a sunrise-to-sunset window computed for the place's own
     * weather point, with a buffer before sunset so the traveller is not walking
     * back to the car in the dark. `daylight` carries the window that was used,
     * so the timeline can state it and a validator can check it.
     *
     * The window is absent when no solar record could be computed. That is not
     * a licence to schedule freely — it means the light was not checked, the
     * copy says so, and the day is left as the other constraints made it.
     *
     * Optional rather than defaulted: absent means "not daylight-limited", and
     * every travel, meal and rest item on the timeline would otherwise have to
     * carry a `false` that says nothing.
     */
    daylightOnly: z.boolean().optional(),
    daylight: z
      .object({
        sunriseMinute: minuteOfDaySchema,
        sunsetMinute: minuteOfDaySchema,
        source: z.string().min(1),
      })
      .optional(),
    /**
     * A fact about this stop that changes without notice and that Sidequest has
     * not checked today. Never implies the opposite when absent — it means there
     * is nothing volatile on record, not that conditions were confirmed.
     */
    verifyBeforeTravel: z.string().min(1).optional(),
    /**
     * PRODUCT RECOVERY V1 — how precisely this item's clock time may be read.
     * `fixed` (booked or timetabled), `measured` (a router timed the legs
     * before it), `estimated` (Sidequest's own estimate sits before it — shown
     * with ≈), `band` (a leg before it could not be timed or estimated; shown
     * as a day part such as "Late morning"). On a travel item whose segment is
     * `unmeasured`, `allowanceMinutes` is the conservative allowance the
     * schedule holds — the item's duration — and is never a measurement.
     */
    timing: z.object({ precision: z.enum(['fixed', 'measured', 'estimated', 'band']), allowanceMinutes: z.number().int().min(0).optional() }).optional(),
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
    /** At the wheel. The only part a driving limit applies to. Measured minutes only. */
    driveMinutes: z.number().int().min(0),
    /**
     * PRODUCT RECOVERY V1 — minutes the schedule holds for legs Sidequest
     * estimated from map distance (`provenance: estimated`). Real time the day
     * spends, kept out of the measured buckets so a driving cap is never
     * enforced on an estimate and a "measured" total never quietly grows.
     */
    estimatedMinutes: z.number().int().min(0).default(0),
    /** PRODUCT RECOVERY V1 — allowance minutes held for legs nobody could time or estimate; the day shows bands, not clocks, wherever these sit. */
    allowanceMinutes: z.number().int().min(0).default(0),
    transitMinutes: z.number().int().min(0),
    /** On foot to reach something, not on foot as the activity itself. */
    walkMinutes: z.number().int().min(0),
    waitMinutes: z.number().int().min(0),
    /**
     * TIME THE DAY HOLDS FOR A JOURNEY NOBODY COULD PRICE.
     *
     * Its own bucket because none of the four above can hold it honestly. The
     * minutes are real — the schedule reserves them and the traveller loses
     * them — but the mode they were measured in is a stand-in: a walk priced on
     * the only network anybody measured, standing in for a scheduled journey
     * the compilation signed it could not time. Booking them to `walkMinutes`
     * was the audited defect: a car-free day stored
     * `{"travelMinutes":124,"walkMinutes":124}` for a traveller who answered
     * twenty-five minutes, and every surface reading that total repeated it.
     *
     * It still sums into `travelMinutes`, because the day genuinely spends it.
     * What it must never do is join a total that names a mode.
     *
     * Defaulted rather than required at the door, so a plan stored before this
     * bucket existed still reads back — every leg on one was classified by its
     * mode, which is the same as having none of these minutes.
     */
    unverifiedMinutes: z.number().int().min(0).default(0),
    /** Road distance only. A shuttle ride adds minutes here, not kilometres. */
    travelKm: z.number().min(0),
    freeMinutes: z.number().int().min(0),
    strenuousCount: z.number().int().min(0),
    /**
     * Legs on this day that nobody measured.
     *
     * Kept as a count rather than folded into the minute totals above, which is
     * the whole point: `travelMinutes` is a sum of durations somebody stands
     * behind, and a day with unmeasured legs has a travel total that is a floor
     * rather than an answer. Every surface that prints a total has to read this
     * beside it, and a validator refuses a budget verdict that depends on it.
     */
    unmeasuredLegCount: z.number().int().min(0),
    /**
     * V6 §12 — THE DAY'S MAJOR TRANSFER WAS NEITHER MEASURED NOR ESTIMATED.
     *
     * A relocation day whose base-to-base leg is an allowance used to show its
     * one small estimated hop as the day's travel ("≈10 min drive") while the
     * five-hour transfer sat in a band nobody read. When this is true every
     * surface says "major transfer not measured" and prints no small total.
     */
    unmeasuredMajorTransfer: z.boolean().optional(),
  })
  .refine(
    (totals) =>
      totals.travelMinutes ===
      totals.driveMinutes +
        totals.transitMinutes +
        totals.walkMinutes +
        totals.waitMinutes +
        totals.unverifiedMinutes +
        totals.estimatedMinutes +
        totals.allowanceMinutes,
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

/**
 * Somewhere else to go if the weather takes the day.
 *
 * A backup is a promise, so every field here exists to keep it honest. It names
 * a real place from this traveller's own board, one they have not marked as
 * uninteresting, that is reachable and open on this date, that is genuinely less
 * exposed to whatever is forecast, and that is not already on the plan
 * somewhere. If no candidate clears all of that, the day carries no backup and
 * says so — an invented fallback is worse than an admitted gap, because the
 * traveller only discovers the difference standing in the rain.
 *
 * Backups are kept apart from `items` on purpose. They are not scheduled, they
 * consume none of the day's capacity, and nothing in the totals counts them.
 */
export const dayBackupSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  /** What about the weather would send the traveller here. */
  trigger: z.string().min(1),
  /** Why this one copes better than what it would replace. */
  why: z.string().min(1),
  /** Which scheduled stop it stands in for, when it stands in for one. */
  replacesPlaceId: z.string().min(1).optional(),
  /** How you would get there, in one clause. */
  accessSummary: z.string().min(1),
  /** When it is open on this date, in one clause. */
  openingSummary: z.string().min(1),
  /**
   * ONE WAY FROM THE BASE, IN THE MODE THAT WOULD ACTUALLY BE USED.
   *
   * This was `driveMinutesFromBase`, and the name was false by the time it was
   * written. The value assigned to it is the backup candidate's
   * `travelMinutesFromBase`, which is resolved through `resolveLeg` and is a
   * walk, a train or a drive depending on the pair — so a stored plan could and
   * did carry a walking figure under a field that says driving, with the mode
   * dropped on the floor one line earlier.
   *
   * A field name is a contract with every future reader, and this one promised
   * something the writer never delivered.
   */
  travelMinutesFromBase: z.number().int().min(0),
  /**
   * The mode those minutes are in.
   *
   * Persisted rather than re-derived, because a stored plan is read back and
   * rendered without re-running the planner: there is nothing left at read time
   * that could work out whether forty minutes was a walk or a train. Its absence
   * is exactly why the old field could lie without anybody being able to tell.
   *
   * `unsupported` is excluded at the schema, not just at the writer. It means
   * "we do not know how this journey is made", and a backup is a promise made
   * for a morning with no slack — minutes whose mode is unknowable are the
   * lying scalar back under a third name, so a plan carrying one is refused at
   * the door rather than stored and rendered.
   */
  travelModeFromBase: transportModeSchema.exclude(['unsupported']),
  /** Anything about it that still needs checking. Never suppressed. */
  caution: z.string().min(1).optional(),
});
export type DayBackup = z.infer<typeof dayBackupSchema>;

/**
 * What the weather did to this day, and what it could not tell us.
 *
 * Derived from the evidence and the finished timeline rather than declared
 * alongside them, so it cannot drift. `evidence` is load-bearing: it decides
 * which words the UI is allowed to use, and mixing a forecast day and a
 * historical-pattern day under one label is the single most misleading thing
 * this feature could do.
 */
export const dayWeatherSummarySchema = z.object({
  /** Which kind of knowledge this day rests on. `unavailable` is a real answer. */
  evidence: z.enum(['forecast', 'historical_pattern', 'unavailable']),
  /** The weather point the day's stops mostly sat under. */
  locationId: z.string().min(1).optional(),
  locationLabel: z.string().min(1).optional(),
  /** One sentence describing the day. Never a forecast when evidence is not. */
  summary: z.string().min(1),
  temperatureMaxC: z.number().optional(),
  temperatureMinC: z.number().optional(),
  precipitationProbabilityPercent: z.number().min(0).max(100).nullable().default(null),
  precipitationMm: z.number().min(0).optional(),
  snowfallCm: z.number().min(0).optional(),
  windGustMaxKph: z.number().min(0).optional(),
  condition: z.string().min(1).optional(),
  sunriseMinute: minuteOfDaySchema.optional(),
  sunsetMinute: minuteOfDaySchema.optional(),
  /** ISO instant the forecast was retrieved. Absent on other evidence kinds. */
  fetchedAt: z.string().datetime().optional(),
  /** Minutes after `fetchedAt` beyond which the UI must call it stale. */
  staleAfterMinutes: z.number().int().min(1).optional(),
  /** Why weather moved something, in the traveller's words. Empty is normal. */
  decisions: z.array(z.string().min(1)).default([]),
  /** Weather facts worth reading before committing to the day. */
  cautions: z.array(z.string().min(1)).default([]),
  backups: z.array(dayBackupSchema).default([]),
  /** Set when nothing on the board could serve as an honest backup. */
  noBackupReason: z.string().min(1).optional(),
  provider: z.string().min(1),
  attribution: z.string().min(1),
});
export type DayWeatherSummary = z.infer<typeof dayWeatherSummarySchema>;

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
  weather: dayWeatherSummarySchema,
  food: dayFoodSummarySchema,
  intensity: z.enum(['light', 'moderate', 'intense']),
  warnings: z.array(z.string().min(1)).default([]),
  /** PRODUCT RECOVERY V1 — the day is only as precise as its least precise leg; `band` days are rendered in day parts. */
  timing: z.object({ precision: z.enum(['measured', 'estimated', 'band']), estimatedLegs: z.number().int().min(0), unknownLegs: z.number().int().min(0) }).optional(),
  /** V6 §5 — part of the party does something else today, and rejoins. Carried from the draft; never invented here. */
  split: z.object({ who: z.string().min(1), does: z.string().min(1), rejoin: z.string().min(1).optional() }).optional(),
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
  /** Totals across the whole trip, in the same five buckets as a day. */
  totals: z.object({
    driveMinutes: z.number().int().min(0),
    transitMinutes: z.number().int().min(0),
    walkMinutes: z.number().int().min(0),
    waitMinutes: z.number().int().min(0),
    /** See `dayTotalsSchema.unverifiedMinutes`. Never folded into the four. */
    unverifiedMinutes: z.number().int().min(0).default(0),
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
  /**
   * A typed requirement of the place is contradicted by the weather on every
   * date it could otherwise have gone on. Two situations only: an unsurfaced
   * approach that needs dry ground, and a signed daylight-only site with no day
   * long enough. Never "it looked like rain".
   */
  'weather_incompatible',
  /**
   * Chosen on a board that has since been rebuilt, and no candidate exists to
   * place.
   *
   * Its own code rather than `not_feasible`, because the two sentences are
   * about entirely different things: `not_feasible` says the place will not
   * work with this traveller's answers, and this says the place is not in front
   * of us at all. Collapsing them told somebody their pick was a bad fit when
   * what actually happened was that we rebuilt the board underneath them.
   */
  'selection_not_on_board',
  /**
   * The model's own trip draft named this place; Sidequest either could not
   * independently confirm it exists as described, or confirmed a real
   * identity for it but has not yet matched it to a board listing with fit,
   * hours and access evidence. Not a rejection: it survives here, by name,
   * with the model's own reason, rather than silently vanishing because
   * Sidequest's structured evidence for it was thin — see the Phase 17
   * baseline-first doctrine (`unknown != false`).
   */
  'model_proposal_unintegrated',
  /**
   * The routing provider affirmatively answered "no route" for this stop
   * while its base was routable — a real contradiction of the draft's own
   * day, not a gap in evidence. Only affirmative evidence ever produces
   * this; an unmeasured leg stays scheduled as unmeasured.
   */
  'route_contradicted',
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
  /**
   * Days were built and too little went on them to call the result a trip.
   *
   * Its own code rather than a second reading of `empty_itinerary`, because the
   * two are different states with the same cause and only one of them withholds
   * the plan: nothing scheduled is a refusal, and one stop across six days is a
   * plan that exists and cannot be presented as finished. A live build produced
   * the second and headed it "Ready, with cautions", because the status came
   * from conflicts alone and no conflict had occurred — every day was internally
   * valid and five of them were empty.
   *
   * A `REQUEST_NOT_MET_CODES` error, deliberately: the days that were built are
   * correct, so refusing the whole trip would replace a thin plan with no plan,
   * and the traveller is the one who decides what to do about it.
   */
  'coverage_below_pace',
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
  /**
   * A leg's stated minutes are physically impossible for its mode against the
   * distance on record — a ten-minute "walk" to a place the pack itself puts
   * 16.4 road-km away, which a stored Tokyo plan actually contained. An error,
   * not a caution: an itinerary stating impossible transport as fact is the
   * exact artifact the §16 validator class exists to refuse, and it guards the
   * rebuild path against packs poisoned with authored constants.
   */
  'travel_leg_speed_impossible',
  // --- Attraction operating hours ---------------------------------------
  // Deliberately separate from the access codes above. A place can be
  // reachable and shut, or open and unreachable, and a traveller told "this
  // does not work" deserves to know which of the two it was.
  /** Scheduled on a date it is not open at all. */
  'attraction_closed_on_date',
  /** V6 §11 — the arrival or departure point names a choice nobody has made ("New Chitose or Asahikawa Airport"). */
  'gateway_unresolved',
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
  // --- Weather and daylight ----------------------------------------------
  // A fourth block, kept apart from the three above for the reason they are
  // kept apart from each other: a traveller told "this does not work" deserves
  // to know whether it was the road, the gate, the clock or the sky. Only the
  // first two of these are errors — the rest are cautions, because a forecast
  // is an opinion and blocking a plan on one would be overreach.
  /** A signed daylight-only visit is scheduled outside the computed daylight. */
  'scheduled_outside_daylight',
  /**
   * An outdoor visit that runs past the day's own recorded sunset, without a
   * daylight-only sign. A caution, not an error — plenty of outdoor places are
   * lit or best after dark — but a pond visited entirely at night is a plan
   * the traveller deserves a sentence about, and a stored plan contained one.
   */
  'scheduled_after_dark',
  /** A typed weather requirement of the place is contradicted on its day. */
  'weather_incompatible_scheduled',
  /** Scheduled on a day the weather works against, with no better day free. */
  'poor_weather_scheduled',
  /** The forecast behind this plan has aged past its own freshness window. */
  'weather_evidence_stale',
  /** No weather could be obtained, so nothing was placed against it. */
  'weather_unavailable',
  /** The plan quotes weather against a place that has none recorded. */
  'weather_evidence_inconsistent',
  /** Historical patterns were used to rank days, which they cannot support. */
  'historical_pattern_used_as_forecast',
  /** A backup is closed, unreachable, disliked, duplicated or no safer. */
  'backup_not_usable',
  /** A weather-sensitive day has no honest fallback available. */
  'no_weather_backup',
  /** A place the traveller chose by hand could not be placed for weather. */
  'weather_blocked_manual_include',
  // --- Food ---------------------------------------------------------------
  // A fifth block. Food is the softest of the five layers and its severities
  // say so: exactly four errors, and every one of them is a fact rather than a
  // preference — a shut door, a shop visited after the food was needed, a
  // declared requirement the venue itself says it cannot meet, and a plan whose
  // stored summary disagrees with its own timeline. "Nothing good near this
  // trailhead" is a caution, and blocking a trip on one would teach people to
  // ignore the warnings that matter.
  /** A meal is scheduled at a venue that is shut on that date. */
  'food_venue_closed_on_date',
  /** A meal starts inside opening hours and runs past the closing time. */
  'meal_ends_after_venue_closes',
  /** Supplies are bought after the day that needs them has started. */
  'grocery_after_supplies_needed',
  /** The venue states it cannot meet a requirement the traveller declared. */
  'strict_dietary_conflict',
  /** A declared requirement nobody has confirmed this venue can meet. */
  'dietary_support_unverified',
  /** The hours behind a meal are ours, or a listing's, rather than the venue's. */
  'food_hours_unverified',
  /** The detour to a meal is past what the traveller said they would accept. */
  'food_detour_exceeds_tolerance',
  /** A booking the traveller has to make themselves and has not. */
  'food_reservation_unresolved',
  /** More special meals than the trip length and budget support. */
  'special_meal_quota_exceeded',
  /** A meal sits above the price band the traveller asked to stay inside. */
  'food_budget_mismatch',
  /** The same venue twice when other legal options existed. */
  'duplicate_food_venue',
  /** A packed meal with nowhere on the plan the food could have come from. */
  'packed_food_without_preparation',
  /** No verified venue fitted this day's route, hours and requirements. */
  'no_verified_food_option',
  /** A long day with nothing to eat scheduled on it at all. */
  'long_day_without_food',
  /** A venue the traveller asked for on the board could not be worked in. */
  'food_choice_unscheduled',
  /** A scheduled venue carries no source we could name. */
  'food_venue_missing_provenance',
  /** The day's stored food summary disagrees with the day's own timeline. */
  'food_plan_inconsistent',
  /** No food data reached the planner, so no meal names anywhere to eat. */
  'food_data_unavailable',
] as const;
export const validationIssueCodeSchema = z.enum(VALIDATION_ISSUE_CODES);

/**
 * The food block, as a set the reviser can test against.
 *
 * It exists so that the one thing the reviser must never do stays impossible:
 * a food problem is fixed by taking the food off the day, never by taking a
 * stop off it. Without this the generic "an error on day 3 means drop day 3's
 * lowest-priority stop" rule would trade Rainbow Falls for a closed bakery.
 */
export const FOOD_ISSUE_CODES: ReadonlySet<ValidationIssueCode> = new Set([
  'food_venue_closed_on_date',
  'meal_ends_after_venue_closes',
  'grocery_after_supplies_needed',
  'strict_dietary_conflict',
  'dietary_support_unverified',
  'food_hours_unverified',
  'food_detour_exceeds_tolerance',
  'food_reservation_unresolved',
  'special_meal_quota_exceeded',
  'food_budget_mismatch',
  'duplicate_food_venue',
  'packed_food_without_preparation',
  'no_verified_food_option',
  'long_day_without_food',
  'food_choice_unscheduled',
  'food_venue_missing_provenance',
  'food_plan_inconsistent',
  'food_data_unavailable',
]);
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
  /**
   * True when the planner resolved this by removing what the issue was about.
   *
   * The reviser has one move that makes an error disappear without fixing
   * anything: taking the subject away. Dropping the day's meals ends a
   * `strict_dietary_conflict` — the venue that could not meet the requirement is
   * no longer on the plan — and the issue list was then *reassigned* from a fresh
   * validation, so the finding vanished with it. What remained was a
   * warning-severity "no verified food option" and a revision note reading "what
   * we had picked did not hold up".
   *
   * That is a real fix and an unacceptable silence. A traveller who told us they
   * cannot eat something is owed the sentence "the place we had chosen said it
   * could not accommodate that", not a shrug. The issue now survives with its
   * original code, downgraded to a warning and carrying this flag, so the
   * finding is still in the record and the severity still reflects that the plan
   * no longer contains the hazard.
   */
  wasResolvedByRemoval: z.boolean().optional(),
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
  /** Put a weather-sensitive stop on a legal day with a better forecast. */
  'moved_for_weather',
  /** Attached a concrete fallback to a day the weather could take. */
  'attached_backup',
  /** Swapped a meal for one that fits the route, the clock or the budget. */
  'changed_meal',
  /** Booked reality, applied after reconciliation. See `applyBookedFacts`. */
  'base_locked_to_booking',
  'booked_stop_inserted',
  'departure_window_tightened',
  'arrival_window_tightened',
  /**
   * The traveller changed the plan themselves — removed a stop, swapped one,
   * asked for an easier day. Its own code because it is the one revision the
   * planner did not decide, and a surface that lists "what we adjusted" must
   * not claim the traveller's edits as its own judgement.
   */
  'traveller_edit',
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
  /**
   * The weather behind the plan's shape. `weatherEvidence` is the mixture the
   * trip actually held — a trip that starts inside the forecast horizon and ends
   * outside it legitimately holds two kinds at once, and flattening that to one
   * label would either invent a forecast or discard a real one.
   */
  weatherDatasetVersion: z.number().int().min(1),
  weatherProvider: z.string().min(1),
  weatherEvidence: z.array(z.enum(['forecast', 'historical_pattern', 'unavailable'])).min(1),
  /** When the dataset behind this plan was assembled. */
  weatherGeneratedAt: z.string().min(1),
  /**
   * Which generation of food data the plan was built against, or zero when none
   * reached it. Zero is a real answer and a different one from "version 1 with
   * nothing in it" — the second means we looked at the region and found nothing.
   */
  foodDatasetVersion: z.number().int().min(0),
  /** How many venues were in scope. Zero is a real and reportable answer. */
  foodVenuesConsidered: z.number().int().min(0),
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


/**
 * THE TRIP PACKAGE — THE MODEL-AUTHORED, SIDEQUEST-VERIFIED CONTENT THAT IS
 * NOT A TIMELINE ROW.
 *
 * The canonical generation path (`apps/web/src/lib/planning/reconcile.ts`)
 * composes a complete trip: bases with lodging guidance, a food strategy, a
 * transport strategy, preparation, packing, backups, deliberate omissions,
 * and the explicit disposition of every experience the draft proposed. None
 * of that is a day item, so it lives here, beside the days, persisted with
 * the plan and rendered by the same view. Optional on the schema so every
 * plan built by the deterministic planner before this existed still parses.
 */
export const ANCHOR_DISPOSITIONS = [
  'preserved',
  'preserved_with_verified_facts',
  'retained_unverified',
  'moved_same_day',
  'moved_other_day',
  'substituted',
  'rejected_contradiction',
  'rejected_hard_constraint',
  'unscheduled_capacity',
  /** PRODUCT RECOVERY V1 — a meal the model wrote as an anchor ("Killarney town pub dinner") became the day's meal intent instead of an attraction. Kept content, never a loss. */
  'folded_into_meal',
  /** V6 §11 — movement the model wrote as a stop ("Drive Bhopal to Bandhavgarh") is the day's transfer leg, never an attraction or a signature. */
  'folded_into_transfer',
  /** V6 §11 — an arrival or departure point the model wrote as a stop ("New Chitose Airport") is the terminal plan, never an attraction. */
  'folded_into_terminal',
] as const;
export const anchorDispositionSchema = z.enum(ANCHOR_DISPOSITIONS);
export type AnchorDispositionCode = z.infer<typeof anchorDispositionSchema>;

export const VERIFICATION_STATES = ['verified', 'partially_verified', 'unverified'] as const;
export const verificationStateSchema = z.enum(VERIFICATION_STATES);
export type VerificationState = z.infer<typeof verificationStateSchema>;

export const packageBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nights: z.number().int().min(0),
  why: z.string().min(1),
  area: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  verification: verificationStateSchema,
  placeId: z.string().min(1).optional(),
  /** Set when Sidequest inserted this base itself (a corridor waypoint), never by the draft. */
  insertedBySidequest: z.boolean().optional(),
  /**
   * PRODUCT RECOVERY V1 — an overnight base is a place to sleep, named for the
   * traveller. `name` above is the display name (the town, or the lodge the
   * draft meant); `canonicalName` is what the geocoder or provider called the
   * matched record; `baseKind` says what kind of place the traveller sleeps
   * in; `coordinates` let the map and the weather stand without a provider.
   */
  displayName: z.string().min(1).optional(),
  canonicalName: z.string().min(1).optional(),
  locality: z.string().min(1).optional(),
  baseKind: z.enum(['locality', 'neighbourhood', 'lodging_property', 'lodge', 'camp', 'remote_base', 'vessel', 'trail_camp', 'other']).optional(),
  coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
  /** V7 §8 — the episode this base belongs to (a ship, a trail camp, a safari camp), by name. */
  episode: z.string().min(1).optional(),
});
export type BaseKind = NonNullable<z.infer<typeof packageBaseSchema>['baseKind']>;

export const packageAnchorSchema = z.object({
  id: z.string().min(1),
  dayNumber: z.number().int().min(1),
  /** The day it ended up on, when it moved. */
  scheduledDayNumber: z.number().int().min(1).optional(),
  name: z.string().min(1),
  role: z.enum(['core', 'secondary', 'optional', 'flex']),
  category: z.string().min(1),
  disposition: anchorDispositionSchema,
  verification: verificationStateSchema,
  /**
   * PRODUCT RECOVERY V1 — what kind of thing the model wrote. Only a
   * `named_place` needs identity verification; an `area_experience` or
   * `route_experience` is geocoded for the map at low priority; a
   * `generic_experience` ("a traditional pub with live music") is never looked
   * up and is never presented as "not verified"; a `meal` is folded into the
   * day's meal intent.
   */
  anchorKind: z.enum(['named_place', 'area_experience', 'route_experience', 'generic_experience', 'meal', 'flex', 'transfer', 'gateway']).optional(),
  placeId: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  /**
   * LIVE WORLD V1 — how the name became a place, persisted so a rebuild reuses
   * the resolution instead of paying for it again. `providerRef` is the
   * provider's own id (a Google place id, an OSM `node/…`); `coordinates` let
   * the persisted identity stand on its own when the provider is off.
   */
  identity: z
    .object({
      method: z.enum(['persisted', 'board', 'compiled_place', 'places', 'backbone', 'osm', 'geocoder']),
      provider: z.string().min(1),
      providerRef: z.string().min(1).optional(),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      placeClass: z.enum(['business_venue', 'controlled_site', 'open_ground', 'area', 'transport_terminal', 'unknown']).optional(),
      confidence: z.enum(['exact', 'probable', 'weak']).optional(),
      attribution: z.string().min(1).optional(),
      resolvedAt: z.string().optional(),
    })
    .optional(),
});
export type PackageAnchor = z.infer<typeof packageAnchorSchema>;

export const tripPackageSchema = z.object({
  source: z.literal('model_draft'),
  draftVersion: z.number().int().min(1),
  /** The trip shape the model chose. Legacy values (`single_base`, `moving_route`, `loop`) still parse for stored plans. */
  archetype: z.enum(['single_base_urban', 'hub_and_spoke', 'road_trip', 'rail_route', 'island_hopping', 'fly_drive', 'multi_region', 'wilderness_gateway', 'guided_remote', 'lodge_circuit', 'mixed', 'single_base', 'moving_route', 'loop']),
  purpose: z.string().min(1),
  routeRationale: z.string().min(1),
  /**
   * MVP V3, Stage 30 — WHEN, answered on the plan itself.
   *
   * What this season opens and closes for this trip. Optional because a plan
   * stored before the field existed has nothing to say here, and silence is the
   * honest rendering of that.
   */
  timingRationale: z.string().min(1).optional(),
  assumptions: z.array(z.string().min(1)).default([]),
  tradeoffs: z.array(z.string().min(1)).default([]),
  bases: z.array(packageBaseSchema),
  foodStrategy: z.array(z.string().min(1)).default([]),
  transport: z.object({ summary: z.string().min(1), notes: z.array(z.string().min(1)).default([]) }),
  beforeYouGo: z.array(z.string().min(1)).default([]),
  packing: z.array(z.string().min(1)).default([]),
  backups: z
    .array(
      z.object({
        trigger: z.string().min(1),
        alternative: z.string().min(1),
        /** PRODUCT RECOVERY V1 — the days this backup belongs to, and how Sidequest decided that: the model named the day, or deterministic name matching against the day's own places, base and theme. A backup with no match is attached to no day. */
        dayNumbers: z.array(z.number().int().min(1)).optional(),
        match: z.enum(['authored', 'geographic', 'none']).optional(),
      }),
    )
    .default([]),
  omissions: z.array(z.object({ name: z.string().min(1), reason: z.string().min(1) })).default([]),
  unresolved: z.array(z.string().min(1)).default([]),
  anchors: z.array(packageAnchorSchema),
  verification: z.object({
    anchors: z.number().int().min(0),
    verified: z.number().int().min(0),
    partiallyVerified: z.number().int().min(0),
    unverified: z.number().int().min(0),
    scheduled: z.number().int().min(0),
    rejected: z.number().int().min(0),
    legsMeasured: z.number().int().min(0),
    legsUnmeasured: z.number().int().min(0),
    /** PRODUCT RECOVERY V1 — of the unmeasured legs, how many carry a Sidequest map-distance estimate (the rest are allowances shown as bands). */
    legsEstimated: z.number().int().min(0).optional(),
    /** True when the bounded verification deadline fired and later lookups were skipped. */
    deadlineReached: z.boolean(),
    providerNotes: z.array(z.string().min(1)).default([]),
  }),
  /** What to book first, in the model's judgement — lodges, internal flights, timed tickets. */
  bookingPriorities: z.array(z.string().min(1)).default([]),
  /**
   * V7 §8 — THE EPISODES, PERSISTED. One object per multi-day experience:
   * its days, its bases, its movement, its operator timing and its gateways.
   * The Days, Map, Plan, Budget, Bookings and Packing surfaces all read this
   * one record, which is what makes them agree.
   */
  episodes: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(['cruise', 'trek', 'safari', 'sleeper_train', 'expedition_boat', 'guided_overland', 'road_trip_segment', 'resort_stay', 'bike_tour', 'hut_to_hut']),
        dayNumbers: z.array(z.number().int().min(1)),
        baseIds: z.array(z.string().min(1)).default([]),
        mode: z.enum(['boat', 'walk', 'four_wheel_drive', 'rail', 'car', 'bicycle', 'guide_or_lodge_transfer', 'horse', 'none']),
        timing: z.enum(['operator', 'self', 'unknown']),
        startGateway: z.string().min(1).optional(),
        endGateway: z.string().min(1).optional(),
        meals: z.enum(['included', 'some', 'none']).optional(),
        why: z.string().min(1).optional(),
        /** Whether the transition into and out of the episode is a structured leg on the plan. */
        entryLeg: z.enum(['present', 'missing', 'not_needed']).default('not_needed'),
        exitLeg: z.enum(['present', 'missing', 'not_needed']).default('not_needed'),
      }),
    )
    .default([]),
  /**
   * V7 §3 — the travel reality the build ran under, persisted so the hub and
   * the intelligence read the same facts the interview promised. Untyped
   * here (the reality schema lives in `reality/schema.ts`); validated there.
   */
  reality: z.unknown().optional(),
  /**
   * QUALITY V1 — the draft preservation report: every proposed experience's
   * fate in numbers, silent loss (must be zero), and the draft-vs-final
   * substantive-day comparison. Persisted so the Verify section and the
   * acceptance tests read the same record.
   */
  preservation: z
    .object({
      version: z.literal(1),
      draftAnchors: z.number().int().min(0),
      kept: z.number().int().min(0),
      removed: z.number().int().min(0),
      silentLoss: z.number().int().min(0),
      counts: z.record(z.string(), z.number().int().min(0)),
      draftSubstantiveDays: z.number().int().min(0),
      finalSubstantiveDays: z.number().int().min(0),
      collapsedDays: z.array(z.object({ dayNumber: z.number().int().min(1), reasons: z.array(z.string()) })).default([]),
      summary: z.string().min(1),
    })
    .optional(),
  /** QUALITY V1 — the deterministic structural audit. Never a taste oracle; never deletes content. */
  quality: z
    .object({
      version: z.literal(1),
      passed: z.boolean(),
      errors: z.number().int().min(0),
      warnings: z.number().int().min(0),
      checks: z.array(z.object({ id: z.string().min(1), ok: z.boolean(), severity: z.enum(['error', 'warning']), detail: z.string().min(1) })),
    })
    .optional(),
  /** QUALITY V1 — stage timings of the build that produced this plan, milliseconds. */
  timings: z.record(z.string(), z.number()).optional(),
  /**
   * V6 §12 — the deterministic feasibility report. `verdict` decides whether
   * a screen may say "Ready"; the items say what still needs deciding.
   */
  feasibility: z
    .object({
      version: z.literal(1),
      verdict: z.enum(['feasible', 'feasible_with_cautions', 'unresolved_major_dependency', 'infeasible']),
      items: z.array(
        z.object({
          area: z.enum(['dates', 'bases', 'transport', 'time', 'daylight', 'physical', 'season', 'booking', 'food', 'party']),
          severity: z.enum(['blocker', 'dependency', 'caution']),
          dayNumber: z.number().int().min(1).optional(),
          detail: z.string().min(1),
        }),
      ),
      summary: z.string().min(1),
    })
    .optional(),
  /** V6 §55 — the structural metrics, one number per question, never collapsed. Keys are `StructuralMetrics`; stored as numbers (null for not applicable). */
  metrics: z.record(z.string(), z.number().nullable()).optional(),
  /**
   * V6 — the contract enforcement record: which lock the dates were held at,
   * who decided them, how many facts the model could not override, and every
   * conflict between the composition and a locked fact, with its resolution.
   * Persisted so a screen can say "the dates you chose held" with evidence.
   */
  contract: z
    .object({
      version: z.literal(1),
      contractVersion: z.string().min(1),
      timingLock: z.enum(['booked_lock', 'hard_lock', 'user_explicit', 'user_soft', 'sidequest_inferred', 'model_proposed']),
      timingDecidedBy: z.enum(['traveller', 'sidequest', 'nobody']),
      lockedFacts: z.number().int().min(0),
      conflicts: z
        .array(
          z.object({
            field: z.string().min(1),
            lock: z.enum(['booked_lock', 'hard_lock', 'user_explicit', 'user_soft', 'sidequest_inferred', 'model_proposed']),
            contractValue: z.string(),
            proposedValue: z.string(),
            resolution: z.enum(['contract_kept', 'normalised', 'field_rejected']),
            detail: z.string().min(1),
            at: z.string().min(1),
          }),
        )
        .default([]),
    })
    .optional(),
  /**
   * V10 §5 — every route-critical name's placement, with the queries the ladder
   * tried. Persisted because the founder's trip failed to place three ordinary
   * town names and left no trace anybody could act on.
   */
  placement: placementReportSchema.optional(),
  /**
   * V10 §7 — one spatial-order verdict per day. `corrected` says the stops were
   * reordered before the legs were built; `unplaceable` says the day could not
   * be judged and names what is missing, which is the state that hid the
   * founder's own reversal.
   */
  dayOrders: z
    .array(
      z.object({
        dayNumber: z.number().int().min(1),
        verdict: z.enum(['coherent', 'violation', 'unplaceable', 'trivial']),
        corrected: z.boolean(),
        plannedKm: z.number().nonnegative(),
        bestKm: z.number().nonnegative(),
        excessFraction: z.number(),
        violations: z.array(z.object({ kind: z.string().min(1), stopName: z.string().min(1).optional(), detail: z.string().min(1) })).default([]),
        unplaced: z.array(z.string().min(1)).default([]),
      }),
    )
    .optional(),
  /** V10 §8 — the arrival and departure gateway plan, with its allowances and its feasibility. */
  gateway: gatewayPlanSchema.optional(),
  /** V10 §4 — the hierarchical experience graph: components and access legs. */
  experiences: experienceGraphSchema.optional(),
  /** V10 §9 — the access constraints that shaped this plan, with their sources and dates. */
  accessConstraints: z.array(accessConstraintSchema).max(60).optional(),
  /** V10 §16 — the quality compiler's issues, after any safe deterministic correction. */
  qualityCompiler: qualityCompilerReportSchema.optional(),
});
export type TripPackage = z.infer<typeof tripPackageSchema>;

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
  foodPlan: foodPlanSchema,
  days: z.array(itineraryDaySchema).min(1),
  unscheduled: z.array(unscheduledPlaceSchema),
  issues: z.array(validationIssueSchema),
  diagnostics: planDiagnosticsSchema,
  /** Present on every plan the canonical model-draft path produced. See `tripPackageSchema`. */
  package: tripPackageSchema.optional(),
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
            /*
             * Whether the mode is the journey is part of the commitment, so it
             * is fingerprinted beside it: this function's charter names
             * "quietly turning a shuttle ride into a drive" as the thing it
             * exists to stop, and turning a journey nobody could price back
             * into a walk is the same move. Appended only where it is set, so
             * every ordinary leg fingerprints exactly as it always did.
             */
            item.travel
              ? `${item.travel.mode}${item.travel.unverifiedScheduled ? '~unverified' : ''}/${item.travel.role}/${item.travel.fromId}>${item.travel.toId}`
              : '-',
            item.hours
              ? `${item.hours.openMinute}-${item.hours.closeMinute}/${item.hours.lastAdmissionMinute ?? '-'}`
              : '-',
            item.booking ? item.booking.kind : '-',
            // The weather *decision*, not the weather. A model revising its
            // precipitation figure must not change the fingerprint; a stop
            // moving day, or a daylight window closing earlier, must.
            item.weather ? `${item.weather.evidence}/${item.weather.suitability}` : '-',
            item.daylight
              ? `${item.daylight.sunriseMinute}-${item.daylight.sunsetMinute}`
              : '-',
            // The food *decision*: which slot, what kind of stop, which venue,
            // and how far off the route it sits. A narration layer may rewrite
            // why a restaurant suits somebody; it may not swap the restaurant,
            // turn a packed lunch into a booking, or quietly shave the detour.
            // The price band and the dietary prose stay out — those describe
            // the choice rather than being it.
            item.food
              ? `${item.food.slot}/${item.food.stopKind}/${item.food.venueId ?? '-'}/${item.food.detourMinutes}`
              : '-',
          ].join(':'),
        )
        .join('|');
      const transport = [day.transport.primaryMode, ...day.transport.serviceIds].join('+');
      const anchor = day.availability.anchorPlaceId ?? '-';
      // Backups are structure: they are a commitment the plan makes about where
      // the traveller goes instead, and a narration layer must not be able to
      // swap one for another it likes the sound of. The mode is part of the
      // commitment — this function's own charter names "quietly turning a
      // shuttle ride into a drive" as the thing it exists to stop, and Phase
      // 15D made the mode a persisted fact, so it is fingerprinted with the
      // place it belongs to.
      const weather = [
        day.weather.evidence,
        ...day.weather.backups.map((backup) => `${backup.placeId}/${backup.travelModeFromBase}`),
      ].join('+');
      return `${day.dayNumber}@${day.date}#${day.window.startMinute}-${day.window.endMinute}{${transport}}<${anchor}>(${weather})[${items}]`;
    })
    .join('\n');

  return `${strategy}\n${days}`;
}
