import type { TransportMode } from '../schemas/access';
import { haversineKm } from './estimate';

/**
 * V11 §3 — BAD NUMBERS DIE BEFORE THE UI.
 *
 * The founder's Kyrgyzstan trip printed, as a *measured* private transfer:
 *
 *     Bishkek → Karakol · 434 km · 5209 min   (86 hr 50 min)
 *
 * 5.0 km/h, for a car, on a paved highway that takes about six hours. It then
 * propagated into six traveller-facing places, including a day that "runs about
 * 4719 minutes past your usual end" and a stop scheduled at 24:00.
 *
 * Two things let it through, and this module replaces both.
 *
 * 1. **openrouteservice had no gate at all.** Valhalla had one; the router that
 *    answers outside Valhalla's coverage did not, so exactly the destinations
 *    with the least other evidence had the least screening.
 * 2. **The gate Valhalla had would not have caught it.** Its `auto` floor was
 *    5 km/h and the leg implies 5.0. A floor that admits walking pace for a car
 *    is not a plausibility check.
 *
 * WHAT THIS IS NOT. It is not a second opinion on the road network and it never
 * substitutes a number of its own. A provider result is either believable enough
 * to schedule a day from or it is an **absence** — `insufficient_evidence`,
 * exactly as V9.1 §ROUTING-CONTRADICTION settled for a declined matrix cell.
 * A refused measurement never becomes "no route", never removes a stop, and
 * never contradicts anything. Unknown ≠ false, and a bad measurement is a
 * species of unknown.
 *
 * The coordinates survive a refusal. A leg whose duration we distrust is still
 * a leg between two placed points, so placement, mapping and ordering all keep
 * working; only the clock loses its figure.
 */

/** Why a provider measurement was refused. Every value is an absence, never a verdict about the world. */
export const IMPLAUSIBILITY_REASONS = [
  /** Implied speed is below what the mode can do over this distance — the Bishkek→Karakol shape. */
  'too_slow_for_mode',
  /** Implied speed is above what the mode can do — a drive at 300 km/h, a walk at 40. */
  'too_fast_for_mode',
  /** Road distance cannot correspond to the straight line between the endpoints. */
  'distance_exceeds_geometry',
  /** Road distance is far *below* the straight line: the two cannot both be true. */
  'distance_below_geometry',
  /** Two distinct places reported as taking no time at all. */
  'zero_minutes_between_distinct_places',
  /** Longer than any single leg of this mode plausibly is, whatever the distance. */
  'duration_exceeds_mode_ceiling',
] as const;
export type ImplausibilityReason = (typeof IMPLAUSIBILITY_REASONS)[number];

export const IMPLAUSIBILITY_NOTES: Record<ImplausibilityReason, string> = {
  too_slow_for_mode: 'the journey time implies a speed this mode cannot be travelling at',
  too_fast_for_mode: 'the journey time implies a speed this mode cannot reach',
  distance_exceeds_geometry: 'the road distance cannot correspond to how far apart these two points are',
  distance_below_geometry: 'the road distance is shorter than the straight line between the two points',
  zero_minutes_between_distinct_places: 'two different places cannot be no time apart',
  duration_exceeds_mode_ceiling: 'no single journey of this kind runs this long',
};

export interface LegPlausibility {
  ok: boolean;
  reason?: ImplausibilityReason;
  /** Implied average speed, km/h, when both a distance and a duration were supplied. */
  impliedKmh?: number;
  /** Straight-line km between the endpoints, when both were placed. */
  straightLineKm?: number;
}

/**
 * What a mode can actually do, as an *envelope* rather than a typical figure.
 *
 * Every bound is deliberately outside real-world experience in both directions,
 * because the job is to reject the impossible and never the merely unusual. The
 * floors are the half that matters: the old 5 km/h car floor is why a 434 km
 * journey at walking pace was believed.
 *
 * `sustainedFloorKmh` only applies once a leg is long enough that congestion,
 * crossings and parking cannot dominate it — a 2 km city crawl really can
 * average 6 km/h, a 400 km one cannot. `ceilingMinutes` is the separate,
 * blunter question: whatever the distance, no single leg of this kind runs
 * longer than this without being a different thing entirely.
 */
interface ModeEnvelope {
  /** Above this implied average speed the measurement is not this mode. */
  maxKmh: number;
  /**
   * Speed floors banded by leg length, ascending, the last band applying beyond.
   * `[uptoKm, minKmh]`, and a floor of 0 means "this length is exempt".
   *
   * Banding is the whole point. A 1.5 km city hop really can average 4 km/h and
   * a 15 km one 13 km/h, so a single floor either admits the Bishkek→Karakol
   * crawl or refuses ordinary congestion. Below the first band overhead
   * dominates and nothing is judged; past the last, the leg is on open road and
   * the full floor applies.
   */
  floors: readonly (readonly [number, number])[];
  /** No single leg of this mode plausibly runs longer than this, whatever the distance. */
  ceilingMinutes: number;
}

/**
 * Modes a router measures on a road or path network. A ferry, a flight, a horse
 * and an operator transfer are deliberately absent — nothing measures them here,
 * so there is no measurement to screen, and inventing an envelope for them would
 * be the "provider failure ≠ impossibility" mistake in a new place.
 */
const MODE_ENVELOPES: Partial<Record<TransportMode, ModeEnvelope>> = {
  /*
   * 20 km/h sustained over open road is already generous to the worst real
   * mountain and border cases, which sit around 30. The middle band exists for
   * the 22 km leg the founder's trip reported at 4.9 km/h: too long for
   * congestion to explain, too short for the open-road floor to reach.
   */
  drive: { maxKmh: 140, floors: [[10, 0], [25, 8], [Number.POSITIVE_INFINITY, 20]], ceilingMinutes: 16 * 60 },
  rideshare: { maxKmh: 140, floors: [[10, 0], [25, 8], [Number.POSITIVE_INFINITY, 20]], ceilingMinutes: 8 * 60 },
  /* A driver on rough mountain road is the slowest legitimate road case. */
  private_transfer: { maxKmh: 140, floors: [[10, 0], [25, 8], [Number.POSITIVE_INFINITY, 15]], ceilingMinutes: 16 * 60 },
  shuttle: { maxKmh: 130, floors: [[10, 0], [25, 8], [Number.POSITIVE_INFINITY, 15]], ceilingMinutes: 8 * 60 },
  /* A stopping service is legitimately slow, and a rural one legitimately slower. */
  public_bus: { maxKmh: 120, floors: [[10, 0], [25, 7], [Number.POSITIVE_INFINITY, 12]], ceilingMinutes: 16 * 60 },
  rail: { maxKmh: 330, floors: [[30, 0], [Number.POSITIVE_INFINITY, 20]], ceilingMinutes: 24 * 60 },
  walk: { maxKmh: 9, floors: [[2, 0], [Number.POSITIVE_INFINITY, 2]], ceilingMinutes: 14 * 60 },
  bicycle: { maxKmh: 45, floors: [[5, 0], [Number.POSITIVE_INFINITY, 6]], ceilingMinutes: 14 * 60 },
};

/** The speed floor that applies to a leg of this length. */
function floorFor(envelope: ModeEnvelope, km: number): number {
  return envelope.floors.find(([upto]) => km <= upto)?.[1] ?? envelope.floors[envelope.floors.length - 1]![1];
}

/**
 * The road/straight-line ratio above which a distance cannot describe these two
 * points.
 *
 * Fifteen, which is the figure Valhalla's own gate already used in production
 * and is therefore known not to misfire. A tighter ratio is tempting and wrong:
 * a fjord, a switchbacked pass and an island road all legitimately reach eight
 * or ten times the straight line, and refusing those would trade one founder
 * defect for a class of new ones in exactly the geography Sidequest is for. The
 * measurement this exists to catch — 208 km between two points 6.1 km apart —
 * is at **34×**, so fifteen catches it twice over.
 */
const MAX_DETOUR_RATIO = 15;
/** Below 300 m, snapping noise dominates every ratio, so no geometric test is meaningful. */
const GEOMETRY_NOISE_KM = 0.3;
/**
 * A road distance may not be meaningfully shorter than the straight line.
 *
 * Geometrically the ratio cannot go below 1 at all, so anything here is slack
 * for the endpoints being snapped away from the points we asked about — a
 * trailhead pulled two kilometres to the nearest road moves a short leg a long
 * way proportionally. Generous, because the signature this catches (a road
 * distance a tenth of the straight line, which is what a coordinate inversion
 * looks like) is nowhere near the boundary.
 */
const MIN_DETOUR_RATIO = 0.6;

/**
 * Screen one provider measurement.
 *
 * Returns `ok: true` whenever there is nothing to object to, **including when
 * there is not enough information to object with** — a leg with no distance, no
 * endpoints or an unsupported mode passes, because refusing on absence is the
 * error this module exists to avoid making in the other direction.
 */
export function assessLegPlausibility(input: {
  minutes: number | null | undefined;
  km?: number | null | undefined;
  from?: { lat: number; lng: number } | null | undefined;
  to?: { lat: number; lng: number } | null | undefined;
  mode: TransportMode;
}): LegPlausibility {
  const { minutes, mode } = input;
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return { ok: true };

  const from = input.from ?? null;
  const to = input.to ?? null;
  const straightLineKm = from && to ? haversineKm(from, to) : undefined;
  /* Spread FIRST in every return below, so `ok` and `reason` are never shadowed by it. */
  const base: Omit<LegPlausibility, 'ok' | 'reason'> = straightLineKm === undefined ? {} : { straightLineKm };

  const envelope = MODE_ENVELOPES[mode];

  /*
   * Zero minutes between two distinct places. Checked before the envelope
   * because it needs no distance and no mode: the geometry alone settles it,
   * and it is the shape that printed "0 min Walk to Karakol · base to base".
   */
  if (minutes === 0 && straightLineKm !== undefined && straightLineKm > GEOMETRY_NOISE_KM) {
    return { ...base, ok: false, reason: 'zero_minutes_between_distinct_places' };
  }

  if (!envelope) return { ...base, ok: true };

  const km = input.km ?? null;
  const hasKm = km !== null && Number.isFinite(km) && km >= 0;

  /*
   * Geometry first: a road distance that cannot describe these two points makes
   * every speed derived from it meaningless, so there is no point asking about
   * speed afterwards.
   */
  if (hasKm && straightLineKm !== undefined && straightLineKm > GEOMETRY_NOISE_KM) {
    const ratio = km / straightLineKm;
    if (ratio > MAX_DETOUR_RATIO) return { ...base, ok: false, reason: 'distance_exceeds_geometry' };
    if (ratio < MIN_DETOUR_RATIO) return { ...base, ok: false, reason: 'distance_below_geometry' };
  }

  /*
   * Speed, before the ceiling, because it is the more diagnostic answer: "this
   * implies 5 km/h" tells an operator what happened and "this is longer than
   * any drive" does not. Measured against the road distance where there is one
   * and the straight line otherwise — a straight line is a *lower bound* on the
   * road, so a leg too slow against it is too slow, full stop, while one that
   * looks too fast against it may simply have taken a shorter road than assumed.
   * Hence the floor uses either and the ceiling only uses a real road distance.
   */
  const speedKm = hasKm ? km : straightLineKm;
  const withSpeed: Omit<LegPlausibility, 'ok' | 'reason'> =
    speedKm !== undefined && speedKm > 0 && minutes > 0 ? { ...base, impliedKmh: Math.round((speedKm / (minutes / 60)) * 10) / 10 } : base;

  if (speedKm !== undefined && speedKm > 0 && minutes > 0) {
    const impliedKmh = speedKm / (minutes / 60);
    if (hasKm && impliedKmh > envelope.maxKmh) return { ...withSpeed, ok: false, reason: 'too_fast_for_mode' };
    if (impliedKmh < floorFor(envelope, speedKm)) return { ...withSpeed, ok: false, reason: 'too_slow_for_mode' };
  }

  /*
   * The ceiling last, as the backstop for a duration with nothing else to judge
   * it by: a router that answers 87 hours and no distance has still said
   * something impossible.
   */
  if (minutes > envelope.ceilingMinutes) return { ...withSpeed, ok: false, reason: 'duration_exceeds_mode_ceiling' };

  return { ...withSpeed, ok: true };
}

/** Convenience: the boolean, for call sites that only branch on it. */
export function isPlausibleMeasurement(input: Parameters<typeof assessLegPlausibility>[0]): boolean {
  return assessLegPlausibility(input).ok;
}

/**
 * The mode a router profile was actually asked about, for screening its answer.
 *
 * A matrix asked as `car` answers for anything on four wheels; screening a
 * private transfer against the *car* envelope rather than its own is correct,
 * because the car network is what was measured. This is the only place that
 * mapping is made, so a caller cannot quietly screen a boat against a car.
 */
export function screeningModeFor(profile: 'car' | 'foot' | 'bicycle' | 'transit'): TransportMode {
  switch (profile) {
    case 'car':
      return 'drive';
    case 'foot':
      return 'walk';
    case 'bicycle':
      return 'bicycle';
    case 'transit':
      return 'public_bus';
  }
}
