import type { TransportMode } from '@sidequest/core';
import { tryLeg, type TravelTimeMatrix } from '@sidequest/geo';

/**
 * WHAT A MODE CAN PHYSICALLY DO, IN ONE PLACE, FOR EVERY LAYER THAT ASKS.
 *
 * A stored Tokyo plan scheduled ten-minute "walks" to places its own pack
 * records as 16.4 road-km away — a legacy authored constant, rendered with the
 * confidence of a measurement, ten times over. Two layers need to catch that
 * class and they must agree exactly: `access.ts` before the unit is scheduled,
 * and `validate.ts` on the finished plan. When the two disagreed, the planner
 * accepted a leg the validator would later convict, the revision loop stripped
 * every stop trying to repair it, and the traveller was handed a refusal with no
 * cause in it.
 *
 * So the arithmetic lives here, imports nothing from the planner, and is the
 * single definition both sides read.
 *
 * Scheduled vehicles carry no ceiling: a bullet train outruns anything here and
 * asserting a bound for it would refuse real journeys.
 */
export const SPEED_CEILING_KMH: Record<string, number> = {
  walk: 6,
  bicycle: 25,
  drive: 110,
  rideshare: 110,
  private_transfer: 110,
};

/**
 * Below this, rounding noise dominates: a 0.3 km hop stated as one minute is
 * 18 km/h on paper and a perfectly ordinary street crossing in life.
 */
export const MIN_KM_FOR_SPEED_CHECK = 0.5;

/**
 * How much of another network's distance may be held against this mode.
 *
 * A road matrix measures roads. Reading its kilometres as the length of a walk
 * between the same two points is corroboration, not measurement: a footpath cuts
 * corners a car cannot, so the road figure can overstate the walk — and a
 * validator that convicts on an overstated distance refuses honest legs. An
 * authored "20 minute walk" to a place the road loops 3 km around is a perfectly
 * ordinary 1.2 km stroll, and the product used to call it impossible.
 *
 * Half is the deliberately generous floor: no pedestrian route between two points
 * is shorter than half the driving route in any geometry a city produces. It
 * keeps the 16.4-km-in-10-minutes class convicted (8.2 km on foot in ten minutes
 * is still 49 km/h) and stops the merely-optimistic ones from being.
 */
export const CROSS_NETWORK_DISTANCE_FLOOR = 0.5;

/**
 * Does the measured matrix cover a leg travelled this way?
 *
 * The matrix is measured in exactly one mode per compilation. A walking leg is a
 * real measurement when the matrix was measured on foot, and is nothing at all
 * when it was measured by car — a car's road time is not a slow walk, and
 * multiplying one to get the other is how the product used to produce a
 * fabricated number that looked derived.
 */
export function matrixMeasuresMode(matrix: TravelTimeMatrix, mode: TransportMode): boolean {
  if (mode === 'drive' || mode === 'rideshare' || mode === 'private_transfer') {
    return matrix.mode === 'car';
  }
  if (mode === 'walk') return matrix.mode === 'foot';
  // Scheduled modes are never in a road or pedestrian matrix, whatever it says.
  return false;
}

export interface CorroboratingDistance {
  /** What the matrix actually says, on its own network. Quote this to people. */
  measuredKm: number;
  /** The most of it that may be held against this mode. Judge on this. */
  usableKm: number;
  sameNetwork: boolean;
}

/**
 * The distance the matrix can honestly be held against a leg of this mode, or
 * null when it holds nothing for the pair.
 *
 * Same network: the measurement itself. Different network: the measurement
 * discounted to the floor above, because it is evidence about the same two
 * points rather than a measurement of this journey. Both figures are returned —
 * a refusal is judged on the discounted one and *worded* with the measured one,
 * because "we measured 16.4 km by road" is a fact a traveller can check and
 * "8.2 km" is an internal safety margin nobody would recognise.
 */
export function corroboratingKm(
  matrix: TravelTimeMatrix,
  fromId: string,
  toId: string,
  mode: TransportMode,
): CorroboratingDistance | null {
  const measured = tryLeg(matrix, fromId, toId);
  if (!measured) return null;
  const sameNetwork = matrixMeasuresMode(matrix, mode);
  return {
    measuredKm: measured.km,
    usableKm: sameNetwork ? measured.km : measured.km * CROSS_NETWORK_DISTANCE_FLOOR,
    sameNetwork,
  };
}

export interface ImpossibleSpeed {
  km: number;
  minutes: number;
  kmh: number;
  ceiling: number;
}

/**
 * Whether a stated duration over a stated distance is beyond what the mode can
 * do. Null whenever the question cannot be asked honestly — no ceiling for the
 * mode, or a distance too short for the arithmetic to mean anything.
 *
 * Zero minutes over real distance is infinite speed and is convicted: a zero
 * hides better than a ten, because it disappears into a timeline instead of
 * appearing on it.
 */
export function impossibleSpeed(
  mode: TransportMode,
  km: number,
  minutes: number,
): ImpossibleSpeed | null {
  const ceiling = SPEED_CEILING_KMH[mode];
  if (ceiling === undefined) return null;
  if (km < MIN_KM_FOR_SPEED_CHECK) return null;
  const kmh = minutes === 0 ? Number.POSITIVE_INFINITY : (km / minutes) * 60;
  if (kmh <= ceiling) return null;
  return { km, minutes, kmh, ceiling };
}

/** "on foot", "by rideshare" — the way a sentence names a mode. */
export function modePhrase(mode: TransportMode): string {
  return mode === 'walk' ? 'on foot' : `by ${mode.replace(/_/g, ' ')}`;
}

export function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}
