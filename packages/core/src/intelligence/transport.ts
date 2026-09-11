import { z } from 'zod';
import type { TransportMode } from '../schemas/access';
import type { TravelSegment } from '../schemas/itinerary';

/**
 * THE MULTIMODAL LEG.
 *
 * The reconciler's `TravelSegment` is road-centric because the router is: a
 * mode the router cannot drive becomes `unsupported`. That is the right thing
 * for a matrix and the wrong thing for a traveller, who is going to take the
 * ferry either way. This leg model says what the movement *is*, how its
 * duration was established, and whether the traffic figure on it means
 * anything today.
 */
export const LEG_MODES = [
  'walk',
  'bicycle',
  'metro',
  'tram',
  'bus',
  'rail',
  'car',
  'taxi',
  'rideshare',
  'ferry',
  'boat',
  'flight',
  'four_wheel_drive',
  'private_transfer',
  'guide_transfer',
  'lodge_transfer',
  'shuttle',
  'unknown_local',
] as const;
export const legModeSchema = z.enum(LEG_MODES);
export type LegMode = z.infer<typeof legModeSchema>;

export const LEG_MODE_LABELS: Record<LegMode, string> = {
  walk: 'On foot',
  bicycle: 'By bicycle',
  metro: 'Metro',
  tram: 'Tram',
  bus: 'Bus',
  rail: 'Train',
  car: 'Drive',
  taxi: 'Taxi',
  rideshare: 'Rideshare',
  ferry: 'Ferry',
  boat: 'Boat',
  flight: 'Flight',
  four_wheel_drive: '4×4 drive',
  private_transfer: 'Private transfer',
  guide_transfer: 'With your guide',
  lodge_transfer: 'Lodge transfer',
  shuttle: 'Shuttle',
  unknown_local: 'Local transport',
};

/** Modes a road router can meaningfully time. Everything else is not a road question. */
export const ROAD_ROUTABLE_MODES: ReadonlySet<LegMode> = new Set(['walk', 'bicycle', 'bus', 'car', 'taxi', 'rideshare', 'four_wheel_drive', 'private_transfer', 'shuttle']);

export const DURATION_BASES = ['measured_static', 'traffic_aware', 'scheduled_transit', 'estimated', 'unmeasured'] as const;
export const durationBasisSchema = z.enum(DURATION_BASES);
export type DurationBasis = z.infer<typeof durationBasisSchema>;

export const DURATION_BASIS_LABELS: Record<DurationBasis, string> = {
  measured_static: 'Measured on the road network, no traffic',
  traffic_aware: 'Measured with traffic for that time',
  scheduled_transit: 'From a published timetable',
  estimated: 'Estimated',
  unmeasured: 'Not measured',
};

export const TRAFFIC_STATES = ['not_applicable', 'live', 'typical', 'unknown'] as const;
export const trafficStateSchema = z.enum(TRAFFIC_STATES);
export type TrafficState = z.infer<typeof trafficStateSchema>;

export const transportLegSchema = z.object({
  id: z.string().min(1),
  dayNumber: z.number().int().min(1).optional(),
  mode: legModeSchema,
  originId: z.string().min(1),
  originName: z.string().min(1),
  destinationId: z.string().min(1),
  destinationName: z.string().min(1),
  departMinute: z.number().int().min(0).max(1440).optional(),
  arriveMinute: z.number().int().min(0).max(1440).optional(),
  durationMinutes: z.number().int().min(0).nullable(),
  km: z.number().min(0).nullable(),
  durationBasis: durationBasisSchema,
  trafficState: trafficStateSchema,
  /** `impossible` is reserved for affirmative evidence; a mode the router cannot route is `plausible`. */
  plausibility: z.enum(['measured', 'plausible', 'impossible']),
  unmeasuredReason: z.enum(['mode_not_road_routable', 'no_route_found', 'operator_unpublished', 'provider_unavailable']).optional(),
  operator: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  bookingRequired: z.enum(['required', 'recommended', 'not_needed', 'unknown']).default('unknown'),
  /** `base_move` legs move the traveller's bed; `terminal` legs touch an airport, station or port. */
  role: z.enum(['approach', 'return', 'base_move', 'terminal', 'transfer']),
  /** LIVE WORLD V1 — provenance of a measured figure and its persisted shape. */
  provider: z.string().min(1).optional(),
  measuredAt: z.string().optional(),
  staticMinutes: z.number().int().min(0).optional(),
  effectiveDepartAt: z.string().optional(),
  /** Compact encoded polyline (precision 5) of the measured route; absent when unmeasured. */
  geometry: z.string().min(1).optional(),
  /** The figure is the base-to-base measurement; the day's stops sit en route. */
  viaBases: z.literal(true).optional(),
  /** V7 §8 — the multi-day episode this leg moves inside, by name; drawn and priced as the episode's movement, never as a road leg. */
  episode: z.string().min(1).optional(),
  episodeMode: z.string().min(1).optional(),
  transitSummary: z.string().min(1).optional(),
  costEstimate: z.object({ currency: z.string().min(1), low: z.number().min(0), high: z.number().min(0), basis: z.string().min(1) }).optional(),
  notes: z.array(z.string().min(1)).default([]),
});
export type TransportLeg = z.infer<typeof transportLegSchema>;

/** The draft's transport hints, as the model writes them. Kept in sync with `DRAFT_TRANSPORTS`. */
export type DraftTransportHint = 'walk' | 'metro' | 'rail' | 'bus' | 'car' | 'ferry' | 'boat' | 'flight' | 'private_transfer' | 'four_wheel_drive' | 'guide_or_lodge_transfer' | 'horse' | 'taxi' | 'high_speed_rail' | 'unknown';

export function legModeFromHint(hint: DraftTransportHint | undefined): LegMode | null {
  switch (hint) {
    case 'walk':
      return 'walk';
    case 'metro':
      return 'metro';
    case 'rail':
      return 'rail';
    case 'bus':
      return 'bus';
    case 'car':
      return 'car';
    case 'ferry':
      return 'ferry';
    case 'boat':
      return 'boat';
    case 'flight':
      return 'flight';
    case 'private_transfer':
      return 'private_transfer';
    case 'four_wheel_drive':
      return 'four_wheel_drive';
    case 'guide_or_lodge_transfer':
    case 'horse':
      return 'guide_transfer';
    case 'taxi':
      return 'taxi';
    case 'high_speed_rail':
      return 'rail';
    default:
      return null;
  }
}

export function legModeFromTransportMode(mode: TransportMode, hint?: DraftTransportHint): LegMode {
  const hinted = legModeFromHint(hint);
  switch (mode) {
    case 'drive':
      return hinted === 'four_wheel_drive' ? 'four_wheel_drive' : 'car';
    case 'walk':
      return 'walk';
    case 'shuttle':
      return 'shuttle';
    case 'public_bus':
      return 'bus';
    case 'rail':
      return hinted === 'metro' ? 'metro' : 'rail';
    case 'ferry':
      return hinted === 'boat' ? 'boat' : 'ferry';
    case 'rideshare':
      return 'rideshare';
    case 'private_transfer':
      return hinted === 'guide_transfer' ? 'guide_transfer' : 'private_transfer';
    case 'bicycle':
      return 'bicycle';
    case 'unsupported':
      return hinted ?? 'unknown_local';
  }
}

/**
 * HOW A DURATION WAS ESTABLISHED, FROM THE SEGMENT'S OWN PROVENANCE.
 *
 * `measured` comes from a static road router: measured, never traffic-aware.
 * `official` is a timetable. `modelled` and `estimated` are estimates.
 */
export function durationBasisOf(segment: Pick<TravelSegment, 'provenance' | 'unverifiedScheduled' | 'basis'>): DurationBasis {
  switch (segment.provenance) {
    case 'measured':
      // LIVE WORLD V1 — the leg itself says what kind of figure it holds.
      return segment.basis === 'traffic_aware' ? 'traffic_aware' : segment.basis === 'scheduled' ? 'scheduled_transit' : segment.basis === 'estimated' ? 'estimated' : 'measured_static';
    case 'official':
      return segment.unverifiedScheduled ? 'estimated' : 'scheduled_transit';
    case 'modelled':
    case 'estimated':
      return 'estimated';
    case 'unmeasured':
      return 'unmeasured';
  }
}

/** How far ahead a live-traffic figure means anything. Two hours is generous. */
export const LIVE_TRAFFIC_HORIZON_MINUTES = 120;

/**
 * TRAFFIC SEMANTICS.
 *
 * Live traffic is only a fact about a departure inside the horizon, and only
 * when the provider actually measured it. A static figure on a trip months
 * away is `not_applicable` for roads (typical traffic is unknown to the static
 * router) — it is never presented as "live". Non-road modes have no traffic.
 */
export function trafficStateFor(input: { mode: LegMode; basis: DurationBasis; departAt: Date | null; now: Date; providerTrafficAware: boolean }): TrafficState {
  if (!ROAD_ROUTABLE_MODES.has(input.mode) || input.mode === 'walk' || input.mode === 'bicycle') return 'not_applicable';
  if (input.basis === 'traffic_aware') {
    if (!input.departAt) return 'unknown';
    const minutesAhead = (input.departAt.getTime() - input.now.getTime()) / 60_000;
    return minutesAhead >= -30 && minutesAhead <= LIVE_TRAFFIC_HORIZON_MINUTES ? 'live' : 'typical';
  }
  if (input.basis === 'measured_static') return input.providerTrafficAware ? 'typical' : 'not_applicable';
  return 'unknown';
}

export function legFromSegment(input: {
  id: string;
  dayNumber: number;
  segment: TravelSegment;
  hint?: DraftTransportHint;
  departMinute?: number;
  arriveMinute?: number;
  role?: TransportLeg['role'];
  departAt: Date | null;
  now: Date;
  providerTrafficAware?: boolean;
}): TransportLeg {
  const hinted = legModeFromHint(input.hint);
  /*
   * A leg the router could not route, on a day the model moved by boat or
   * with a guide, is that boat or that guide — the router's fallback mode
   * ("drive back") is a stand-in the router itself could not measure.
   */
  const episodeHinted: LegMode | null = input.segment.episodeMode === 'boat' ? 'boat' : input.segment.episodeMode === 'walk' ? 'walk' : input.segment.episodeMode === 'rail' ? 'rail' : input.segment.episodeMode === 'four_wheel_drive' ? 'four_wheel_drive' : input.segment.episodeMode === 'horse' || input.segment.episodeMode === 'guide_or_lodge_transfer' ? 'guide_transfer' : null;
  const mode = episodeHinted ?? (input.segment.provenance === 'unmeasured' && (input.segment.unmeasuredReason === 'mode_not_routed' || input.segment.unmeasuredReason === 'operator_unpublished') && hinted && !ROAD_ROUTABLE_MODES.has(hinted) ? hinted : legModeFromTransportMode(input.segment.mode, input.hint));
  const basis = durationBasisOf(input.segment);
  const roadRoutable = ROAD_ROUTABLE_MODES.has(mode);
  const unmeasuredReason: TransportLeg['unmeasuredReason'] | undefined =
    basis !== 'unmeasured'
      ? undefined
      : !roadRoutable
        ? 'mode_not_road_routable'
        : input.segment.unmeasuredReason === 'no_route_found'
          ? 'no_route_found'
          : input.segment.unmeasuredReason === 'operator_unpublished'
            ? 'operator_unpublished'
            : 'provider_unavailable';
  return transportLegSchema.parse({
    id: input.id,
    dayNumber: input.dayNumber,
    mode,
    originId: input.segment.fromId,
    originName: input.segment.fromName,
    destinationId: input.segment.toId,
    destinationName: input.segment.toName,
    ...(input.departMinute !== undefined ? { departMinute: input.departMinute } : {}),
    ...(input.arriveMinute !== undefined ? { arriveMinute: input.arriveMinute } : {}),
    durationMinutes: input.segment.minutes,
    km: input.segment.km,
    durationBasis: basis,
    trafficState: trafficStateFor({ mode, basis, departAt: input.departAt, now: input.now, providerTrafficAware: input.providerTrafficAware ?? false }),
    /*
     * A road router that returned nothing for a flight has said nothing about
     * the flight. `impossible` needs a contradiction — a closed road, an
     * operator saying the service does not run — and nothing here is one.
     */
    plausibility: basis === 'unmeasured' ? 'plausible' : 'measured',
    ...(unmeasuredReason ? { unmeasuredReason } : {}),
    ...(input.segment.provider ? { provider: input.segment.provider } : {}),
    ...(input.segment.measuredAt ? { measuredAt: input.segment.measuredAt } : {}),
    ...(input.segment.staticMinutes !== undefined ? { staticMinutes: input.segment.staticMinutes } : {}),
    ...(input.segment.effectiveDepartAt ? { effectiveDepartAt: input.segment.effectiveDepartAt } : {}),
    ...(input.segment.geometry ? { geometry: input.segment.geometry } : {}),
    ...(input.segment.viaBases ? { viaBases: true as const } : {}),
    ...(input.segment.episode ? { episode: input.segment.episode } : {}),
    ...(input.segment.episodeMode ? { episodeMode: input.segment.episodeMode } : {}),
    ...(input.segment.transitSummary ? { transitSummary: input.segment.transitSummary } : {}),
    ...(input.segment.serviceId ? { serviceId: input.segment.serviceId } : {}),
    bookingRequired: mode === 'flight' || mode === 'ferry' || mode === 'guide_transfer' || mode === 'lodge_transfer' ? 'recommended' : 'unknown',
    role: input.role ?? (input.segment.role === 'return' ? 'return' : input.segment.role === 'transfer' ? 'transfer' : 'approach'),
    notes: [],
  });
}

/**
 * OPTION COMPARISON FOR A MAJOR LEG.
 *
 * No universal score. Each option carries what is known about it on the six
 * axes travellers actually weigh, and the recommendation reads the profile:
 * a "least hassle" traveller is steered to the lowest transfer burden, a
 * "cheapest" one to the lowest cost band. Axes without evidence stay unknown.
 */
export const transportOptionSchema = z.object({
  legId: z.string().min(1),
  legLabel: z.string().min(1),
  mode: legModeSchema,
  durationMinutes: z.number().int().min(0).nullable(),
  durationBasis: durationBasisSchema,
  costBand: z.enum(['low', 'medium', 'high', 'unknown']),
  transferBurden: z.enum(['low', 'medium', 'high', 'unknown']),
  scenic: z.enum(['low', 'medium', 'high', 'unknown']),
  hotelDisruption: z.enum(['none', 'some', 'unknown']),
  ease: z.enum(['easy', 'moderate', 'demanding', 'unknown']),
  recommended: z.boolean(),
  why: z.string().min(1),
});
export type TransportOption = z.infer<typeof transportOptionSchema>;

export const MODE_TRAITS: Record<LegMode, { costBand: TransportOption['costBand']; transferBurden: TransportOption['transferBurden']; scenic: TransportOption['scenic']; ease: TransportOption['ease'] }> = {
  walk: { costBand: 'low', transferBurden: 'low', scenic: 'medium', ease: 'easy' },
  bicycle: { costBand: 'low', transferBurden: 'low', scenic: 'medium', ease: 'moderate' },
  metro: { costBand: 'low', transferBurden: 'medium', scenic: 'low', ease: 'easy' },
  tram: { costBand: 'low', transferBurden: 'medium', scenic: 'medium', ease: 'easy' },
  bus: { costBand: 'low', transferBurden: 'medium', scenic: 'medium', ease: 'moderate' },
  rail: { costBand: 'medium', transferBurden: 'medium', scenic: 'high', ease: 'easy' },
  car: { costBand: 'medium', transferBurden: 'low', scenic: 'high', ease: 'moderate' },
  taxi: { costBand: 'medium', transferBurden: 'low', scenic: 'low', ease: 'easy' },
  rideshare: { costBand: 'medium', transferBurden: 'low', scenic: 'low', ease: 'easy' },
  ferry: { costBand: 'medium', transferBurden: 'medium', scenic: 'high', ease: 'moderate' },
  boat: { costBand: 'medium', transferBurden: 'medium', scenic: 'high', ease: 'moderate' },
  flight: { costBand: 'high', transferBurden: 'high', scenic: 'low', ease: 'demanding' },
  four_wheel_drive: { costBand: 'high', transferBurden: 'low', scenic: 'high', ease: 'demanding' },
  private_transfer: { costBand: 'high', transferBurden: 'low', scenic: 'medium', ease: 'easy' },
  guide_transfer: { costBand: 'high', transferBurden: 'low', scenic: 'high', ease: 'easy' },
  lodge_transfer: { costBand: 'medium', transferBurden: 'low', scenic: 'high', ease: 'easy' },
  shuttle: { costBand: 'low', transferBurden: 'medium', scenic: 'medium', ease: 'easy' },
  unknown_local: { costBand: 'unknown', transferBurden: 'unknown', scenic: 'unknown', ease: 'unknown' },
};
