import { z } from 'zod';
import { TRAVEL_MODE_LABELS, isOperatorMode, travelModeSchema, type TravelMode } from './vocabulary';

/**
 * V12.1 §3 §5 — A JOURNEY, NOT A DURATION WITH A LABEL ON IT.
 *
 * ── WHAT `TravelSegment` COULD NOT SAY ──────────────────────────────────────
 *
 * The persisted leg carries `provenance`, `basis`, `estimateKind` and
 * `unmeasuredReason`: four fields, all answering **how well the duration is
 * known**. Nothing on it answers **who controls the departure**, and the
 * consequence is that these four are one object today:
 *
 *     Tokyo → Kyoto, Shinkansen          a timetable nobody has read
 *     Banff → Jasper, hire car           a road nobody measured
 *     Karakol → Song-Köl, hired driver   an operator's own timing
 *     Ala-Köl, stage 2                   a trail with a guide's estimate
 *
 * All four render as **"allowance — not timed"**, because `travelState` in the
 * itinerary view switches on `provenance` alone. §19 names that sentence as one
 * a traveller must never read, and it is not a copy problem: the object has
 * nowhere to put the distinction.
 *
 * ── THE FOUR AXES, KEPT APART ───────────────────────────────────────────────
 *
 *   control   who decides when it leaves       traveller · network · timetable · operator · trail · air
 *   routing   what kind of thing could time it road · pedestrian · transit · timetable · trail · operator · air
 *   schedule  what shape its departures have   continuous · frequency · fixed · operator-set · unknown
 *   truth     what we actually know            measured · timetabled · operator-set · estimated · unknown · contradicted
 *
 * They are four because they vary independently. A hired car is
 * traveller-controlled, road-routed, continuous and — outside a tile build —
 * `unknown`. A Shinkansen is timetable-controlled, timetable-routed, fixed-departure
 * and, with no timetable provider, also `unknown`. **Same truth state, opposite
 * journeys**, and the traveller-facing sentence has to differ: "Train · schedule
 * to confirm" against "Drive · journey time to confirm".
 *
 * ── THE RULE THIS MODEL EXISTS TO ENFORCE ───────────────────────────────────
 *
 * `UNKNOWN` is not `CONTRADICTED`. V9.1 settled this for routing silences —
 * `AUTHORITATIVE_NO_ROUTE` only from a provider that evaluated two resolved
 * endpoints and explicitly said no — and V12.1 extends it to every mode: a
 * ferry nobody could find a schedule for is `unknown`; a ferry a source says is
 * out of service is `contradicted`; and only the second may remove anything.
 *
 * Pure. No provider, no clock, no model.
 */

/** Who decides when this journey departs. */
export const JOURNEY_CONTROLS = [
  /** The traveller leaves when they like: a car, a walk, a bike, a taxi. */
  'traveler_controlled',
  /** A network runs continuously enough that departures are not planned around: a metro, a city bus. */
  'network_controlled',
  /** A published timetable decides: intercity rail, a scheduled ferry, a flight. */
  'timetable_controlled',
  /** An operator decides, and tells the traveller: a lodge transfer, a trek shuttle, a safari vehicle. */
  'operator_controlled',
  /** Nobody decides; the traveller walks it and arrives when they arrive. */
  'trail',
  /** Air, which is timetabled but behaves differently enough to be its own thing (§14). */
  'air',
] as const;
export const journeyControlSchema = z.enum(JOURNEY_CONTROLS);
export type JourneyControl = z.infer<typeof journeyControlSchema>;

/** What kind of instrument could, in principle, time this. */
export const JOURNEY_ROUTINGS = ['road', 'pedestrian', 'bike', 'transit_network', 'timetable', 'trail', 'operator', 'air'] as const;
export const journeyRoutingSchema = z.enum(JOURNEY_ROUTINGS);
export type JourneyRouting = z.infer<typeof journeyRoutingSchema>;

/** What shape this journey's departures have. */
export const JOURNEY_SCHEDULES = ['continuous', 'frequency_based', 'fixed_departure', 'operator_set', 'unknown'] as const;
export const journeyScheduleSchema = z.enum(JOURNEY_SCHEDULES);
export type JourneySchedule = z.infer<typeof journeyScheduleSchema>;

/**
 * V12.1 §5 — WHAT IS ACTUALLY KNOWN ABOUT THIS JOURNEY.
 *
 * Separate from `TravelDurationState`, which stays exactly as it is. That one
 * answers "where did this number come from"; this one answers "what do we know
 * about this journey", and the two differ precisely where it matters: an
 * operator-set trek stage and a geo-estimated road leg are both
 * `geo_estimate`/`unknown` as durations, and are `OPERATOR_SET` and `ESTIMATED`
 * as journeys.
 */
export const JOURNEY_TRUTHS = [
  /** A router evaluated these two endpoints on this profile and returned a time. */
  'measured',
  /** A published timetable gives departures for this corridor. */
  'timetabled',
  /** An operator owns this movement and states its own timing. */
  'operator_set',
  /** Sidequest's own figure, from geometry or from the composing model. */
  'estimated',
  /** Nobody could say. The honest default, and never a verdict. */
  'unknown',
  /** An affirmative source says this journey cannot be made as planned. */
  'contradicted',
] as const;
export const journeyTruthSchema = z.enum(JOURNEY_TRUTHS);
export type JourneyTruth = z.infer<typeof journeyTruthSchema>;

/**
 * Why a journey is `unknown`.
 *
 * Every value here is a statement about **Sidequest**, which is the point: §11
 * found that five of the six causes of "not timed" are our own gaps, and they
 * all rendered as the same amber sentence as the one real verdict. A journey
 * whose truth is `contradicted` carries no reason from this list; it carries
 * `contradiction` instead.
 */
export const JOURNEY_UNKNOWN_REASONS = [
  /** No configured provider can time this mode at all. */
  'no_provider_for_mode',
  /** A provider exists for the mode but not for this ground. */
  'outside_provider_coverage',
  /** A provider was asked and did not usably answer: a timeout, a 5xx, a declined cell. */
  'provider_did_not_answer',
  /** An endpoint never resolved to a position. */
  'endpoint_unresolved',
  /** The measurement came back in a shape the plausibility envelope refuses. */
  'measurement_implausible',
  /** The operator has not published this, and the operator is the only source there could be. */
  'operator_has_not_published',
  /** Nothing was ever asked, because nothing needed to be. */
  'not_required',
] as const;
export const journeyUnknownReasonSchema = z.enum(JOURNEY_UNKNOWN_REASONS);
export type JourneyUnknownReason = z.infer<typeof journeyUnknownReasonSchema>;

/** A point this journey runs between, as the plan names it. */
export const journeyEndpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Where a traveller actually boards, when it differs from the place: a station, a port, a trailhead. */
  accessPoint: z.string().min(1).optional(),
});
export type JourneyEndpoint = z.infer<typeof journeyEndpointSchema>;

/**
 * How often this journey runs, where anything is known.
 *
 * Never invented. `perDay` is a count somebody published; `note` is the
 * sentence it came with. A corridor whose frequency is unknown carries no
 * `frequency` at all rather than a zero, for the same reason `minutes` is
 * nullable rather than zero: a count that is absent can be refused by a reader,
 * a zero is silently believed.
 */
export const journeyFrequencySchema = z.object({
  perDay: z.number().int().min(0).optional(),
  /** "Several a day", "Two sailings in summer" — an operator's own words, never ours. */
  note: z.string().min(1).max(160).optional(),
  source: z.string().min(1).max(120).optional(),
});
export type JourneyFrequency = z.infer<typeof journeyFrequencySchema>;

/** A window this journey leaves or arrives in. Minutes from local midnight, on a 0–48 h timeline (V11 §1). */
export const journeyWindowSchema = z.object({
  earliestMinute: z.number().int().min(0).max(2880),
  latestMinute: z.number().int().min(0).max(2880),
  /** Whether these are published departures or Sidequest's own allowance. */
  basis: z.enum(['published', 'operator_stated', 'allowance']),
});
export type JourneyWindow = z.infer<typeof journeyWindowSchema>;

export const JOURNEY_REQUIREMENTS = ['required', 'recommended', 'not_required', 'unknown'] as const;
export const journeyRequirementSchema = z.enum(JOURNEY_REQUIREMENTS);
export type JourneyRequirement = z.infer<typeof journeyRequirementSchema>;

/** Who has to do something before this journey can happen. */
export const JOURNEY_BOOKING_OWNERS = ['traveler', 'operator', 'nobody', 'unknown'] as const;
export const journeyBookingOwnerSchema = z.enum(JOURNEY_BOOKING_OWNERS);
export type JourneyBookingOwner = z.infer<typeof journeyBookingOwnerSchema>;

/** Where this journey's facts came from, and how quickly they go stale. */
export const journeyEvidenceSchema = z.object({
  source: z.enum(['router', 'timetable', 'operator', 'sidequest_estimate', 'model', 'booked_fact', 'none']),
  provider: z.string().min(1).optional(),
  measuredAt: z.string().datetime().optional(),
  /**
   * How long this fact stays true. A road geometry is stable for years; a ferry
   * timetable turns over with the season; an operator pickup is settled when the
   * operator says so. §24 reads this to decide what needs rechecking.
   */
  freshness: z.enum(['stable', 'seasonal', 'date_bound', 'volatile', 'unknown']),
});
export type JourneyEvidence = z.infer<typeof journeyEvidenceSchema>;

export const journeySchema = z.object({
  version: z.literal(1),
  origin: journeyEndpointSchema,
  destination: journeyEndpointSchema,
  mode: travelModeSchema,
  control: journeyControlSchema,
  routing: journeyRoutingSchema,
  schedule: journeyScheduleSchema,
  truth: journeyTruthSchema,
  /** Null when nothing could say. Never zero for an unknown journey (V11 §1, Product Recovery V1). */
  minutes: z.number().int().min(0).nullable(),
  km: z.number().min(0).nullable(),
  departWindow: journeyWindowSchema.optional(),
  arriveWindow: journeyWindowSchema.optional(),
  frequency: journeyFrequencySchema.optional(),
  reservation: journeyRequirementSchema,
  booking: journeyBookingOwnerSchema,
  operator: z.string().min(1).max(120).optional(),
  evidence: journeyEvidenceSchema,
  /** Whether the shape of the trip rests on this journey (V10 §19's route-critical set). */
  routeCritical: z.boolean(),
  /** Present exactly when `truth` is `unknown`. */
  unknownReason: journeyUnknownReasonSchema.optional(),
  /** Present exactly when `truth` is `contradicted`: the affirmative source, in one sentence. */
  contradiction: z.string().min(1).max(240).optional(),
  /** Set when the stated mode was refused and replaced, carrying the mode that was refused. */
  modeRefusedFrom: travelModeSchema.optional(),
  /** The multi-day experience this journey moves inside, by name. */
  episode: z.string().min(1).optional(),
});
export type Journey = z.infer<typeof journeySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * DERIVING THE THREE SEMANTIC AXES FROM A MODE
 *
 * These are defaults, not verdicts. A journey may be built with any combination
 * — a rail replacement bus is `rail`-corridor and road-routed — but a mode with
 * nothing else stated has one natural reading, and stating it in one place is
 * what stops every call site inferring its own.
 * ──────────────────────────────────────────────────────────────────────────── */

const CONTROL_BY_MODE: Record<TravelMode, JourneyControl> = {
  walk: 'traveler_controlled',
  bike: 'traveler_controlled',
  drive: 'traveler_controlled',
  taxi: 'traveler_controlled',
  private_transfer: 'operator_controlled',
  bus: 'timetable_controlled',
  urban_transit: 'network_controlled',
  rail: 'timetable_controlled',
  ferry: 'timetable_controlled',
  boat: 'operator_controlled',
  flight: 'air',
  shuttle: 'operator_controlled',
  four_wheel_drive: 'traveler_controlled',
  horse: 'operator_controlled',
  trail: 'trail',
  cable_car_or_lift: 'network_controlled',
  operator_transfer: 'operator_controlled',
  unknown: 'traveler_controlled',
};

const ROUTING_BY_MODE: Record<TravelMode, JourneyRouting> = {
  walk: 'pedestrian',
  bike: 'bike',
  drive: 'road',
  taxi: 'road',
  private_transfer: 'operator',
  bus: 'road',
  urban_transit: 'transit_network',
  rail: 'timetable',
  ferry: 'timetable',
  boat: 'operator',
  flight: 'air',
  shuttle: 'operator',
  four_wheel_drive: 'road',
  horse: 'trail',
  trail: 'trail',
  cable_car_or_lift: 'operator',
  operator_transfer: 'operator',
  unknown: 'road',
};

const SCHEDULE_BY_MODE: Record<TravelMode, JourneySchedule> = {
  walk: 'continuous',
  bike: 'continuous',
  drive: 'continuous',
  taxi: 'continuous',
  private_transfer: 'operator_set',
  bus: 'frequency_based',
  urban_transit: 'frequency_based',
  rail: 'fixed_departure',
  ferry: 'fixed_departure',
  boat: 'operator_set',
  flight: 'fixed_departure',
  shuttle: 'frequency_based',
  four_wheel_drive: 'continuous',
  horse: 'operator_set',
  trail: 'continuous',
  cable_car_or_lift: 'frequency_based',
  operator_transfer: 'operator_set',
  unknown: 'unknown',
};

export function controlForMode(mode: TravelMode): JourneyControl {
  return CONTROL_BY_MODE[mode];
}
export function routingForMode(mode: TravelMode): JourneyRouting {
  return ROUTING_BY_MODE[mode];
}
export function scheduleForMode(mode: TravelMode): JourneySchedule {
  return SCHEDULE_BY_MODE[mode];
}

/**
 * Whether this journey's departure is somebody else's to decide.
 *
 * The one predicate most of §18 and §22 rest on: a journey the traveller cannot
 * simply set off on needs either a schedule, an operator, or an honest
 * admission that neither is known — and it is the only kind that can produce a
 * booking action.
 */
export function departureIsSomebodyElses(journey: Pick<Journey, 'control'>): boolean {
  return journey.control === 'timetable_controlled' || journey.control === 'operator_controlled' || journey.control === 'network_controlled' || journey.control === 'air';
}

/**
 * Whether a router's silence about this journey means anything at all.
 *
 * A road router that cannot answer a ferry has said nothing about ferries. This
 * is the predicate that stops an instrument's limits being read as the world's.
 */
export function silenceIsMeaningless(journey: Pick<Journey, 'routing'>): boolean {
  return journey.routing !== 'road' && journey.routing !== 'pedestrian' && journey.routing !== 'bike';
}

/* ────────────────────────────────────────────────────────────────────────────
 * §19 — WHAT A TRAVELLER READS
 *
 * The forbidden words are enumerated in a test rather than in a comment:
 * "provider unsupported", "allowance", "operator-timed", "evidence
 * insufficient", "not routed", "unmeasured". None of them may appear in a
 * headline. The technical account stays on `Journey` itself, where the
 * disclosure panel and the print appendix read it.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface JourneyWords {
  /** The row: "Ferry · timetable to confirm". Never a field name, never a provider. */
  headline: string;
  /** One sentence on disclosure, when there is something worth saying. */
  detail: string | null;
}

function duration(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `~${hours}h` : `~${hours}h${String(rest).padStart(2, '0')}`;
}

/**
 * Traveller-facing words for a journey.
 *
 * The shape is always `<how you travel> · <what is known about the timing>`, so
 * a day reads as a list of journeys rather than as a list of measurement
 * states. The mode comes first because that is what somebody is deciding about.
 */
export function journeyWords(journey: Journey): JourneyWords {
  const mode = TRAVEL_MODE_LABELS[journey.mode];
  const time = duration(journey.minutes);
  const operator = journey.operator ? ` with ${journey.operator}` : '';

  switch (journey.truth) {
    case 'measured':
      return { headline: time ? `${mode} · ${time}` : mode, detail: journey.km !== null && journey.km > 0 ? `About ${Math.round(journey.km)} km by road.` : null };
    case 'timetabled':
      return {
        headline: time ? `${mode} · ${time}` : `${mode} · on the timetable`,
        detail: journey.frequency?.note ?? (journey.frequency?.perDay !== undefined ? `About ${journey.frequency.perDay} a day.` : 'Departure times come from the published timetable.'),
      };
    case 'operator_set':
      return {
        headline: time ? `${mode} · ${time}` : `${mode} · arranged for you`,
        detail: `Timing is set by whoever runs this${operator}, and they confirm it with you.`,
      };
    case 'estimated':
      return { headline: time ? `${mode} · ${time}` : mode, detail: 'A working figure from the distance, not a measured journey time.' };
    case 'contradicted':
      return { headline: `${mode} · not running`, detail: journey.contradiction ?? 'A source says this journey cannot be made as planned.' };
    case 'unknown':
    default:
      /*
       * THE FOUR SENTENCES THAT REPLACE "allowance — not timed".
       *
       * Which one a traveller reads depends on *who would know*, not on which
       * of our instruments failed. A train has a timetable somebody publishes;
       * an operator's transfer is theirs to confirm; a trail takes as long as
       * it takes; a road is ours to measure and we have not.
       */
      if (journey.control === 'timetable_controlled' || journey.control === 'air') {
        return { headline: `${mode} · schedule to confirm`, detail: `${mode} runs this route. We have not read the timetable for your dates yet, so no departure time is shown.` };
      }
      if (isOperatorMode(journey.mode) || journey.control === 'operator_controlled') {
        return { headline: `${mode} · arranged by your operator`, detail: `Whoever runs this sets the time and confirms it with you${operator ? `. ${journey.operator} is named in the plan.` : '.'}` };
      }
      if (journey.control === 'trail') {
        return { headline: `${mode} · on foot, at your own pace`, detail: 'A walking stage. How long it takes depends on the party, so the day is shown in parts rather than to the hour.' };
      }
      if (journey.control === 'network_controlled') {
        return { headline: `${mode} · frequent service`, detail: 'A network that runs often enough not to plan around. We have not timed this specific journey.' };
      }
      return { headline: `${mode} · journey time to confirm`, detail: 'We have not been able to time this one yet. The day holds room for it and shows times as parts of the day.' };
  }
}

/**
 * The short word on the chip beside a travel row.
 *
 * Shorter than the headline and derived from the same two facts, so the chip and
 * the row can never disagree. `null` means no chip at all: V11 §8 settled that a
 * badge on the ordinary case — "measured", twice a day, on a healthy plan —
 * conveys nothing and costs a line on every row.
 */
export function journeyBadge(journey: Journey): { word: string; tone: 'pine' | 'blue' | 'amber' | 'clay' | 'neutral' } | null {
  switch (journey.truth) {
    case 'measured':
      return null;
    case 'timetabled':
      return { word: 'timetable', tone: 'pine' };
    case 'operator_set':
      return { word: 'arranged for you', tone: 'blue' };
    case 'estimated':
      return { word: 'estimated', tone: 'blue' };
    case 'contradicted':
      return { word: 'not running', tone: 'clay' };
    case 'unknown':
    default:
      if (journey.control === 'timetable_controlled' || journey.control === 'air') return { word: 'schedule to confirm', tone: 'amber' };
      if (journey.control === 'operator_controlled') return { word: 'arranged for you', tone: 'blue' };
      if (journey.control === 'trail') return { word: 'at your own pace', tone: 'neutral' };
      if (journey.control === 'network_controlled') return { word: 'frequent service', tone: 'neutral' };
      return { word: 'time to confirm', tone: 'amber' };
  }
}

/**
 * How the map should draw this journey.
 *
 * Read from the journey's *routing*, not from a duration's provenance, which is
 * what `day-map-legs.ts` was doing with a chain of string comparisons against
 * the raw hint. A flight is an arc whether or not anybody timed it; a trail is
 * dotted whether or not a router refused it.
 */
export function journeyLineKind(journey: Journey): 'road' | 'pedestrian' | 'rail' | 'water' | 'air' | 'trail' | 'operator' {
  switch (journey.routing) {
    case 'air':
      return 'air';
    case 'trail':
      return 'trail';
    case 'timetable':
      return isWaterRouting(journey) ? 'water' : 'rail';
    case 'transit_network':
      return 'rail';
    case 'operator':
      return isWaterRouting(journey) ? 'water' : 'operator';
    case 'pedestrian':
      return 'pedestrian';
    case 'bike':
    case 'road':
    default:
      return 'road';
  }
}

function isWaterRouting(journey: Journey): boolean {
  return journey.mode === 'ferry' || journey.mode === 'boat';
}

/**
 * What §22 may raise as a traveller action.
 *
 * Only a journey somebody has to *do something about*: reserve a seat, book a
 * sailing, arrange a transfer. A journey we simply could not time is Sidequest's
 * own uncertainty and must never become a task — V11 §`owner`, applied here
 * because this is where the temptation is strongest.
 */
export function journeyNeedsTravelerAction(journey: Journey): boolean {
  if (journey.reservation === 'required') return true;
  if (journey.booking === 'traveler' && (journey.control === 'timetable_controlled' || journey.control === 'air')) return true;
  return false;
}
