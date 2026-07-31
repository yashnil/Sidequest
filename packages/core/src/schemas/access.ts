import { z } from 'zod';
import {
  isoDateSchema,
  MINUTES_PER_DAY,
  minuteOfDaySchema,
  parkingDifficultySchema,
} from './common';

/**
 * Transportation as a planning constraint rather than a label on a card.
 *
 * WHY THIS EXISTS
 *
 * Coordinates and a drive time are not permission to visit. Reds Meadow is the
 * case that forced the model: in peak season private vehicles are barred from
 * the valley between fixed hours, a shuttle replaces them, it runs only in
 * certain months, and the last bus out is the real end of the day. None of that
 * fits in a boolean, and a planner that reasons only about distance will happily
 * schedule a hike that cannot legally be reached and cannot be walked back from.
 *
 * FOUR KINDS OF STATE, KEPT APART
 *
 *   1. what is true about a place        → `Place` and this dataset
 *   2. what the traveller can/will do    → `TravelerProfile.transport`
 *   3. whether this trip can reach it    → `PlaceAccessAssessment`
 *   4. what actually got scheduled       → `AccessLeg` on the itinerary
 *
 * TIME MODEL
 *
 * Same convention as the itinerary: clock times are integer minutes from local
 * midnight, calendar dates are `YYYY-MM-DD` labels. No `Date`, no offsets, no
 * DST inside the planning model.
 *
 * STABLE VERSUS DYNAMIC
 *
 * Only rules that recur are encoded. A given year's road-crew schedule, fire
 * closure or snowpack is never a permanent rule — it travels as `volatility:
 * 'dynamic'` with a recheck note, so the product can say "verify this" without
 * pretending it has checked today.
 */

export const TRANSPORT_MODES = [
  'drive',
  'walk',
  'shuttle',
  'public_bus',
  'rail',
  'ferry',
  'rideshare',
  'private_transfer',
  'bicycle',
  /** Explicit "we do not model this yet" rather than a silent gap. */
  'unsupported',
] as const;
export const transportModeSchema = z.enum(TRANSPORT_MODES);
export type TransportMode = z.infer<typeof transportModeSchema>;

export const TRANSPORT_MODE_LABELS: Record<TransportMode, string> = {
  drive: 'Drive',
  walk: 'Walk',
  shuttle: 'Shuttle',
  public_bus: 'Bus',
  rail: 'Train',
  ferry: 'Ferry',
  rideshare: 'Taxi or rideshare',
  private_transfer: 'Private transfer',
  bicycle: 'Bike',
  unsupported: 'Not supported',
};

/**
 * What the traveller wants optimised when more than one legal way in exists.
 * A soft preference only: it orders options, it never makes an illegal one legal.
 */
export const TRANSPORT_PRIORITIES = [
  'cheapest',
  'fastest',
  'least_stressful',
  'most_scenic',
  'best_value',
] as const;
export const transportPrioritySchema = z.enum(TRANSPORT_PRIORITIES);
export type TransportPriority = z.infer<typeof transportPrioritySchema>;

export const TRANSPORT_PRIORITY_LABELS: Record<TransportPriority, string> = {
  cheapest: 'Cheapest',
  fastest: 'Fastest',
  least_stressful: 'Least stressful',
  most_scenic: 'Most scenic',
  best_value: 'Best overall value',
};

/**
 * How durable a fact is. This is the difference between something the planner may
 * encode as a rule and something it must only ever ask the traveller to check.
 */
export const ACCESS_VOLATILITIES = ['stable', 'seasonal_recurring', 'dynamic'] as const;
export const accessVolatilitySchema = z.enum(ACCESS_VOLATILITIES);
export type AccessVolatility = z.infer<typeof accessVolatilitySchema>;

export const accessProvenanceSchema = z.object({
  /**
   * - `official`  — read off the managing agency's own page on `lastVerified`.
   * - `authored`  — written from general knowledge, not checked against a source.
   * - `estimated` — a modelled or inferred figure, never a published one.
   */
  kind: z.enum(['official', 'authored', 'estimated']),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  /**
   * When the source was last read. Absent for `authored` data, because a
   * verification date on something nobody verified is worse than no date.
   */
  lastVerified: isoDateSchema.optional(),
  confidence: z.number().min(0).max(1),
  volatility: accessVolatilitySchema,
  /** What the traveller must confirm themselves. Required when dynamic. */
  recheckNote: z.string().min(1).optional(),
}).refine((value) => value.kind !== 'official' || value.lastVerified !== undefined, {
  message: 'Official data must record when it was verified',
  path: ['lastVerified'],
});
export type AccessProvenance = z.infer<typeof accessProvenanceSchema>;

/**
 * A gateway: somewhere you park, board, or hand over from one mode to the next.
 * `routingId` is its key in the travel-time matrix, so driving to a boarding
 * point is measured by exactly the same machinery as driving to a lake.
 */
export const accessPointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  locality: z.string().min(1),
  routingId: z.string().min(1),
  parking: z.object({
    available: z.boolean(),
    difficulty: parkingDifficultySchema,
    note: z.string().min(1).optional(),
  }),
  provenance: accessProvenanceSchema,
});
export type AccessPoint = z.infer<typeof accessPointSchema>;

/**
 * The usable edges of a service day.
 *
 * `lastReturnDeparture` is the one that decides whether a day is real: it is the
 * last moment you can be standing at the far stop and still get out. Missing it
 * is not an inconvenience, it is a night in the woods.
 */
export const serviceWindowSchema = z
  .object({
    firstDeparture: minuteOfDaySchema,
    lastOutboundDeparture: minuteOfDaySchema,
    lastReturnDeparture: minuteOfDaySchema,
  })
  .refine((value) => value.firstDeparture <= value.lastOutboundDeparture, {
    message: 'The last outbound departure cannot be before the first',
    path: ['lastOutboundDeparture'],
  })
  .refine((value) => value.lastOutboundDeparture <= value.lastReturnDeparture, {
    message: 'The last return cannot be before the last outbound departure',
    path: ['lastReturnDeparture'],
  })
  // Services running past midnight are a real thing and are not modelled here.
  // Rejecting them is honest; silently wrapping would produce a plan where the
  // traveller is scheduled to catch a bus that left nineteen hours earlier.
  .refine((value) => value.lastReturnDeparture < MINUTES_PER_DAY, {
    message: 'Services that cross midnight are not supported yet',
    path: ['lastReturnDeparture'],
  });
export type ServiceWindow = z.infer<typeof serviceWindowSchema>;

export const dayOfWeekSchema = z.number().int().min(0).max(6);
/** 0 = Sunday, matching `Date.prototype.getUTCDay`. */
export const DAY_OF_WEEK_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const monthNumberSchema = z.number().int().min(1).max(12);

/**
 * A recurring scheduled service — a shuttle, a trolley, a bus route.
 *
 * Deliberately a *recurring* calendar rather than dated timetable rows: this is
 * the shape of the fact that stays true year to year ("runs June to September,
 * daily, first bus 07:00"). A dated timetable would be stale within a season and
 * would encode one year's disruptions as permanent truth.
 */
export const transportServiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  operator: z.string().min(1),
  mode: transportModeSchema,
  boardingPointId: z.string().min(1),
  dropOffPointId: z.string().min(1),
  /** Months (1-12) the service normally runs. */
  operatingMonths: z.array(monthNumberSchema).min(1).max(12),
  /** Weekdays it runs, 0 = Sunday. */
  daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7),
  window: serviceWindowSchema,
  /** In-vehicle minutes, one way. */
  rideMinutes: z.number().int().min(0).max(600),
  /** Queue, board and wait slack applied in each direction. */
  transferBufferMinutes: z.number().int().min(0).max(180),
  /** Only set when the operator publishes one. Absent means "we do not know". */
  headwayMinutes: z.number().int().min(1).max(240).optional(),
  fareNote: z.string().min(1).optional(),
  bookingNote: z.string().min(1).optional(),
  provenance: accessProvenanceSchema,
}).refine(
  (service) =>
    service.window.lastOutboundDeparture + service.rideMinutes <=
    service.window.lastReturnDeparture,
  {
    // A departure you cannot get home from is a one-way trip, not a last usable
    // outbound. Catching it here means the impossibility is a data error rather
    // than a stop that mysteriously vanishes from the plan.
    message: 'The last outbound departure arrives after the last return leaves',
    path: ['window', 'lastOutboundDeparture'],
  },
);
export type TransportService = z.infer<typeof transportServiceSchema>;

/**
 * Whether you may bring your own vehicle all the way in.
 *
 * `prohibited_during_service` is the Reds Meadow case and the reason a boolean
 * will not do: the same road is drivable at 06:00 and closed to you at 10:00.
 */
export const PRIVATE_VEHICLE_POLICIES = [
  'allowed',
  'prohibited_during_service',
  'prohibited',
] as const;
export const privateVehiclePolicySchema = z.enum(PRIVATE_VEHICLE_POLICIES);
export type PrivateVehiclePolicy = z.infer<typeof privateVehiclePolicySchema>;

export const SERVICE_REQUIREMENTS = ['required', 'optional', 'none'] as const;
export const serviceRequirementSchema = z.enum(SERVICE_REQUIREMENTS);
export type ServiceRequirement = z.infer<typeof serviceRequirementSchema>;

/**
 * One legal way in, for one or more places that share it.
 *
 * `placeIds` is the load-bearing part: everything listed here is reached by a
 * single gateway sequence, so the planner pays for the drive, the parking and
 * the boarding **once**. Devils Postpile and Rainbow Falls are one rule; they are
 * not two stops that happen to be near each other.
 *
 * A rule is narrower than `Place.accessGroup`. The group answers "must these
 * land on the same day?"; the rule answers "do these share one entry sequence?".
 * Minaret Vista sits in the Reds Meadow group — same road, same day — while
 * having its own rule, because you drive to it and the shuttle does not serve it.
 */
export const accessRuleSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    placeIds: z.array(z.string().min(1)).min(1),
    /** Months this rule is in force. A place can have a summer rule and a winter one. */
    months: z.array(monthNumberSchema).min(1).max(12),
    /** Weekdays this rule is in force. Omitted means every day. */
    daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7).optional(),
    /** How you reach the gateway under your own steam. */
    approachMode: transportModeSchema,
    /**
     * Minutes for the approach, when it is not a drive.
     *
     * Driving is measured by the travel-time matrix, which is the one place road
     * times live. Walking to a bus stop is not in that matrix and never will be,
     * so it is stated here rather than derived from a car journey.
     */
    approachMinutes: z.number().int().min(0).max(240).optional(),
    /** Where the approach ends. Absent means the approach ends at the place itself. */
    gatewayPointId: z.string().min(1).optional(),
    privateVehicle: privateVehiclePolicySchema,
    serviceId: z.string().min(1).optional(),
    serviceRequirement: serviceRequirementSchema,
    /** On foot from the drop-off or the parking spot to the first activity. */
    walkMinutesFromDropOff: z.number().int().min(0).max(240).default(0),
    /** Getting between the places this rule serves, once you are inside. */
    internalTransfer: z
      .object({
        mode: transportModeSchema,
        minutes: z.number().int().min(0).max(240),
      })
      .default({ mode: 'walk', minutes: 0 }),
    permitRequired: z.boolean().default(false),
    permitNote: z.string().min(1).optional(),
    /** Shown verbatim; supplements the typed constraints, never replaces them. */
    notes: z.array(z.string().min(1)).default([]),
    provenance: accessProvenanceSchema,
  })
  .refine(
    (rule) => rule.serviceRequirement === 'none' || rule.serviceId !== undefined,
    { message: 'A rule that uses a service must name one', path: ['serviceId'] },
  )
  .refine(
    (rule) => rule.privateVehicle !== 'prohibited_during_service' || rule.serviceId !== undefined,
    {
      message: 'Vehicles can only be barred "during service" when there is a service',
      path: ['privateVehicle'],
    },
  )
  .refine(
    (rule) =>
      rule.privateVehicle === 'allowed' ||
      rule.serviceRequirement === 'required' ||
      rule.serviceRequirement === 'optional',
    {
      message: 'A rule that bars private vehicles must offer another way in',
      path: ['serviceRequirement'],
    },
  )
  .refine((rule) => rule.approachMode === 'drive' || rule.approachMinutes !== undefined, {
    message: 'A non-driving approach must say how long it takes',
    path: ['approachMinutes'],
  });
export type AccessRule = z.infer<typeof accessRuleSchema>;

/**
 * Everything needed to decide how a traveller reaches a set of places on a date.
 *
 * Validated as a whole rather than row by row: a rule that names a service that
 * does not exist, or a service that boards at a point nobody defined, is a
 * planner crash three stages later. It fails here instead, at the boundary.
 */
export const accessDatasetSchema = z
  .object({
    regionId: z.string().min(1),
    points: z.array(accessPointSchema),
    services: z.array(transportServiceSchema),
    rules: z.array(accessRuleSchema),
  })
  .superRefine((dataset, ctx) => {
    const pointIds = new Set<string>();
    for (const point of dataset.points) {
      if (pointIds.has(point.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate access point "${point.id}"`, path: ['points'] });
      }
      pointIds.add(point.id);
    }

    const serviceIds = new Set<string>();
    for (const service of dataset.services) {
      if (serviceIds.has(service.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate service "${service.id}"`, path: ['services'] });
      }
      serviceIds.add(service.id);
      for (const [field, id] of [
        ['boardingPointId', service.boardingPointId],
        ['dropOffPointId', service.dropOffPointId],
      ] as const) {
        if (!pointIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            message: `Service "${service.id}" ${field} "${id}" is not a known access point`,
            path: ['services'],
          });
        }
      }
    }

    const ruleIds = new Set<string>();
    for (const rule of dataset.rules) {
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate access rule "${rule.id}"`, path: ['rules'] });
      }
      ruleIds.add(rule.id);
      if (rule.gatewayPointId && !pointIds.has(rule.gatewayPointId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Rule "${rule.id}" gateway "${rule.gatewayPointId}" is not a known access point`,
          path: ['rules'],
        });
      }
      if (rule.serviceId && !serviceIds.has(rule.serviceId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Rule "${rule.id}" names service "${rule.serviceId}", which does not exist`,
          path: ['rules'],
        });
      }
      if (rule.provenance.volatility === 'dynamic' && !rule.provenance.recheckNote) {
        ctx.addIssue({
          code: 'custom',
          message: `Rule "${rule.id}" is dynamic but says nothing about what to recheck`,
          path: ['rules'],
        });
      }
    }

    // Several rules may cover one place at once — driving to the Lakes Basin and
    // riding the trolley to it are both true in July, and a car-free traveller
    // needs the second one to exist. Ambiguity is resolved by ranking them, not
    // by forbidding them.
  });
export type AccessDataset = z.infer<typeof accessDatasetSchema>;

// ---------------------------------------------------------------------------
// Calendar evaluation
// ---------------------------------------------------------------------------

/**
 * Weekday of a `YYYY-MM-DD` label.
 *
 * Parsed in UTC on purpose: the date is a label on a page of a calendar, not an
 * instant. Reading it in local time is how a Sunday-only service silently starts
 * running on Saturdays for anyone west of Greenwich.
 */
export function dayOfWeekFor(date: string): number {
  const parsed = new Date(`${date}T00:00:00Z`);
  // `Date.parse` accepts 2026-02-30 and rolls it to March 2. Left alone, the
  // month check would read February and the weekday would be March's — the same
  // input evaluated against two different days.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`"${date}" is not a calendar date.`);
  }
  return parsed.getUTCDay();
}

export function monthFor(date: string): number {
  const month = Number(date.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`"${date}" is not a calendar date.`);
  }
  return month;
}

export type ServiceAvailability =
  | { available: true }
  | { available: false; reason: 'out_of_season' | 'not_this_weekday' };

export function serviceAvailabilityOn(
  service: TransportService,
  date: string,
): ServiceAvailability {
  if (!service.operatingMonths.includes(monthFor(date))) {
    return { available: false, reason: 'out_of_season' };
  }
  if (!service.daysOfWeek.includes(dayOfWeekFor(date))) {
    return { available: false, reason: 'not_this_weekday' };
  }
  return { available: true };
}

export function ruleAppliesOn(rule: AccessRule, date: string): boolean {
  if (!rule.months.includes(monthFor(date))) return false;
  if (rule.daysOfWeek && !rule.daysOfWeek.includes(dayOfWeekFor(date))) return false;
  return true;
}


export function findService(
  dataset: AccessDataset,
  serviceId: string | undefined,
): TransportService | undefined {
  if (!serviceId) return undefined;
  return dataset.services.find((service) => service.id === serviceId);
}

export function findPoint(
  dataset: AccessDataset,
  pointId: string | undefined,
): AccessPoint | undefined {
  if (!pointId) return undefined;
  return dataset.points.find((point) => point.id === pointId);
}

/** Every rule that could govern this place, in dataset order. */
export function rulesForPlace(dataset: AccessDataset, placeId: string): AccessRule[] {
  return dataset.rules.filter((rule) => rule.placeIds.includes(placeId));
}
