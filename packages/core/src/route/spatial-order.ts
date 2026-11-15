import type { Coordinates } from '../schemas/common';

/**
 * V10 §7 — THE DETERMINISTIC SPATIAL-ORDER COMPILER.
 *
 * Once stops are placed, whether a day's order makes sense on the ground is a
 * question with an answer, and nobody was asking it. The founder's trip drove
 * past one roadside waterfall to reach a second 30 km further on, doubled back
 * 28 minutes for the first, and went on east again — a 29% detour the product
 * then described to the traveller as a route that "follows one direction of
 * travel".
 *
 * What this is:
 *
 * - **A detector, not an optimiser.** It measures the day's chain against the
 *   best ordering of the same stops with the same endpoints, and reports the
 *   excess. It does not reorder anything. The caller decides, and §7 forbids
 *   optimising blindly: sunrise and sunset intent, opening windows, booked
 *   facts and deliberate scenic sequencing all outrank distance, so a stop that
 *   is pinned is held at its own index and only the free stops are permuted.
 * - **Honest about missing placement.** A day with unplaced stops cannot be
 *   judged, and says so (`verdict: 'unplaceable'`). This matters more than it
 *   sounds: on the Iceland trip the day-3 violation was *invisible* precisely
 *   because the base was unplaced, so a checker that quietly skips such days
 *   goes quiet exactly when placement fails.
 * - **Three named violation kinds**, because they need different fixes:
 *   `reversal` (a stop that belongs en route is visited after passing it),
 *   `arrival_before_en_route` (the day reaches its destination base and then
 *   leaves again for something that was on the way), and `duplicate_crossing`
 *   (the chain covers the same ground more than twice).
 */

export const ORDER_VIOLATION_KINDS = ['reversal', 'arrival_before_en_route', 'duplicate_crossing', 'move_backtrack'] as const;
export type OrderViolationKind = (typeof ORDER_VIOLATION_KINDS)[number];

export interface OrderedStop {
  id: string;
  name: string;
  /** Null when nothing placed it: the day is then unjudgeable rather than clean. */
  coordinates: Coordinates | null;
  /**
   * True when this stop's position is a deliberate decision that distance may
   * not override: a sunset viewpoint, an opening window, a booked fact, a
   * must-keep, or a scenic sequence the composition stated.
   */
  pinned?: boolean;
  /** Why it is pinned, for the finding's own sentence. */
  pinnedReason?: string;
}

export interface SpatialOrderInput {
  /** Where the day starts: last night's base, or the arrival gateway on day one. */
  origin: { id: string; name: string; coordinates: Coordinates | null };
  /** Where the day ends: tonight's base, or the departure gateway on the last day. */
  destination: { id: string; name: string; coordinates: Coordinates | null };
  stops: readonly OrderedStop[];
  /**
   * Excess over the best ordering, as a fraction, before a day is called a
   * violation. 0.15 — a day may wander 15% for reasons geometry cannot see.
   */
  toleranceFraction?: number;
  /** Minimum absolute excess in kilometres, so a short urban day is never flagged over a few hundred metres. */
  toleranceKm?: number;
}

export interface OrderViolation {
  kind: OrderViolationKind;
  /** The stop the violation is about, when one stop explains it. */
  stopId?: string;
  stopName?: string;
  detail: string;
}

export interface SpatialOrderReport {
  verdict: 'coherent' | 'violation' | 'unplaceable' | 'trivial';
  /** Great-circle kilometres along the order as planned. */
  plannedKm: number;
  /** Great-circle kilometres along the best legal ordering. */
  bestKm: number;
  excessKm: number;
  excessFraction: number;
  /** The best legal ordering's stop ids, when one beat the plan. */
  bestOrder: readonly string[];
  violations: readonly OrderViolation[];
  /** Stops nothing placed; the reason a day is `unplaceable`. */
  unplaced: readonly string[];
}

const DEFAULT_TOLERANCE_FRACTION = 0.15;
const DEFAULT_TOLERANCE_KM = 8;
/** Above this many free stops the exact search is abandoned; days never reach it in practice. */
const EXACT_PERMUTATION_LIMIT = 8;

export function greatCircleKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la = toRad(a.lat);
  const lb = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function chainKm(points: readonly Coordinates[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += greatCircleKm(points[i - 1]!, points[i]!);
  return total;
}

/**
 * Every ordering of the free stops, with the pinned stops held at their own
 * indices. A pinned stop is a decision, so the search moves around it.
 */
function legalOrderings<T extends { pinned?: boolean }>(stops: readonly T[]): T[][] {
  const freeIndices = stops.map((s, i) => (s.pinned ? -1 : i)).filter((i) => i >= 0);
  const free = freeIndices.map((i) => stops[i]!);
  if (free.length <= 1) return [[...stops]];
  if (free.length > EXACT_PERMUTATION_LIMIT) return [[...stops]];
  const out: T[][] = [];
  const permute = (rest: T[], acc: T[]): void => {
    if (rest.length === 0) {
      const next = [...stops];
      for (const [n, index] of freeIndices.entries()) next[index] = acc[n]!;
      out.push(next);
      return;
    }
    for (let i = 0; i < rest.length; i += 1) permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!]);
  };
  permute(free, []);
  return out;
}

/**
 * How far along the origin→destination line a point projects, as a fraction.
 * Used only to *name* a reversal: a stop whose projection is behind the one
 * before it was passed on the way there.
 */
function projection(origin: Coordinates, destination: Coordinates, point: Coordinates): number {
  const scale = Math.cos((((origin.lat + destination.lat) / 2) * Math.PI) / 180);
  const ax = origin.lng * scale;
  const bx = destination.lng * scale;
  const px = point.lng * scale;
  const vx = bx - ax;
  const vy = destination.lat - origin.lat;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return 0;
  return ((px - ax) * vx + (point.lat - origin.lat) * vy) / len2;
}

export function compileSpatialOrder(input: SpatialOrderInput): SpatialOrderReport {
  const tolFraction = input.toleranceFraction ?? DEFAULT_TOLERANCE_FRACTION;
  const tolKm = input.toleranceKm ?? DEFAULT_TOLERANCE_KM;
  const unplaced = [
    ...(input.origin.coordinates ? [] : [input.origin.name]),
    ...input.stops.filter((s) => !s.coordinates).map((s) => s.name),
    ...(input.destination.coordinates ? [] : [input.destination.name]),
  ];
  const empty = { plannedKm: 0, bestKm: 0, excessKm: 0, excessFraction: 0, bestOrder: [] as string[], violations: [] as OrderViolation[] };
  if (unplaced.length > 0) return { verdict: 'unplaceable', ...empty, unplaced };
  if (input.stops.length < 2) return { verdict: 'trivial', ...empty, unplaced: [] };

  const origin = input.origin.coordinates!;
  const destination = input.destination.coordinates!;
  const plannedKm = chainKm([origin, ...input.stops.map((s) => s.coordinates!), destination]);

  let bestKm = plannedKm;
  let bestOrder: OrderedStop[] = [...input.stops];
  for (const ordering of legalOrderings(input.stops)) {
    const km = chainKm([origin, ...ordering.map((s) => s.coordinates!), destination]);
    if (km < bestKm - 1e-9) {
      bestKm = km;
      bestOrder = ordering;
    }
  }
  const excessKm = plannedKm - bestKm;
  const excessFraction = bestKm > 0 ? excessKm / bestKm : 0;
  if (excessKm <= tolKm || excessFraction <= tolFraction) {
    return { verdict: 'coherent', plannedKm, bestKm, excessKm, excessFraction, bestOrder: bestOrder.map((s) => s.id), violations: [], unplaced: [] };
  }

  const violations: OrderViolation[] = [];

  /*
   * A reversal: a stop sitting earlier along the day's own line than the stop
   * before it, by enough distance to matter. Named per stop, because the fix is
   * per stop — "this stop belongs before that one", not "the day is bad".
   */
  for (let i = 1; i < input.stops.length; i += 1) {
    const prev = input.stops[i - 1]!;
    const here = input.stops[i]!;
    const back = projection(origin, destination, prev.coordinates!) - projection(origin, destination, here.coordinates!);
    const gapKm = greatCircleKm(prev.coordinates!, here.coordinates!);
    if (back > 0.03 && gapKm > tolKm) {
      violations.push({
        kind: 'reversal',
        stopId: here.id,
        stopName: here.name,
        detail: `${here.name} sits ${Math.round(gapKm)} km back towards ${input.origin.name} from ${prev.name}; it is on the way, so visiting it after ${prev.name} doubles back.`,
      });
    }
  }

  /*
   * Arrival before an en-route stop: the chain reaches tonight's base and then
   * leaves again for somewhere that was on the approach.
   */
  for (let i = 1; i < input.stops.length; i += 1) {
    const prev = input.stops[i - 1]!;
    const here = input.stops[i]!;
    const prevToDest = greatCircleKm(prev.coordinates!, destination);
    const hereToDest = greatCircleKm(here.coordinates!, destination);
    if (prevToDest <= tolKm && hereToDest > tolKm * 3) {
      violations.push({
        kind: 'arrival_before_en_route',
        stopId: here.id,
        stopName: here.name,
        detail: `The day reaches ${input.destination.name} at ${prev.name} and then leaves again for ${here.name}, ${Math.round(hereToDest)} km away.`,
      });
    }
  }

  /* The same ground covered more than twice. */
  const straightKm = greatCircleKm(origin, destination);
  if (straightKm > tolKm && plannedKm > straightKm * 2.4) {
    violations.push({
      kind: 'duplicate_crossing',
      detail: `The day covers ${Math.round(plannedKm)} km to travel ${Math.round(straightKm)} km of ground, crossing the same stretch more than twice.`,
    });
  }

  if (violations.length === 0) {
    violations.push({
      kind: 'reversal',
      detail: `The order as planned runs ${Math.round(plannedKm)} km where ${Math.round(bestKm)} km covers the same stops.`,
    });
  }

  return { verdict: 'violation', plannedKm, bestKm, excessKm, excessFraction, bestOrder: bestOrder.map((s) => s.id), violations, unplaced: [] };
}

/** One traveller-readable sentence for a report, or null when there is nothing to say. */
export function describeOrderReport(report: SpatialOrderReport, dayNumber: number): string | null {
  if (report.verdict === 'unplaceable') return `Day ${dayNumber}'s order could not be checked: ${report.unplaced.slice(0, 3).join(', ')} ${report.unplaced.length === 1 ? 'has' : 'have'} not been placed on the map.`;
  if (report.verdict !== 'violation') return null;
  return `Day ${dayNumber}: ${report.violations[0]!.detail}`;
}

/* ============================================================================================
 * A MOVING DAY — WHICH SIDE OF THE MOVE EACH STOP BELONGS TO.
 * ============================================================================================ */

/**
 * Eval v3 — A BACKTRACK ACROSS THE MOVE.
 *
 * A live car-free Kyrgyzstan day moved Bishkek → Song-Kol by bus first thing,
 * then sent the traveller back to Osh Bazaar in Bishkek, then back up to the
 * lake for the night: three 160 km legs for one move. `compileSpatialOrder`
 * judged the chain Bishkek → Osh Bazaar → stargazing → Song-Kol and found it
 * coherent, because it did not know the day was laid out move-first.
 *
 * On a moving day every placed stop belongs to one side of the move: the
 * **origin side** when it is nearer last night's base than tonight's, the
 * **destination side** otherwise. Origin-side stops come before the move and
 * destination-side stops after it. A stop on the origin side visited after the
 * move (a move-first day) or after a destination-side stop (a free day) makes
 * the traveller return toward where they left: a `move_backtrack`.
 *
 * The correction is the smallest one that is safely derivable: a stable
 * partition — origin-side free stops first, destination-side after, each side
 * in its authored order — with pinned and unplaced stops held at their own
 * index (a pin is a decision; an unplaced stop is unknown, never "near"). When
 * the origin side is non-empty the move cannot open the day, and `moveAt` says
 * where it belongs.
 */

export type MoveSide = 'origin' | 'destination' | 'unknown';

/** Below this the two bases are one place, and a stop has no side. */
const SAME_PLACE_KM = 2;

export function moveSideOf(origin: Coordinates | null, destination: Coordinates | null, point: Coordinates | null): MoveSide {
  if (!origin || !destination || !point) return 'unknown';
  if (greatCircleKm(origin, destination) <= SAME_PLACE_KM) return 'unknown';
  return greatCircleKm(point, origin) < greatCircleKm(point, destination) ? 'origin' : 'destination';
}

export interface MoveDayInput {
  origin: { id: string; name: string; coordinates: Coordinates | null };
  destination: { id: string; name: string; coordinates: Coordinates | null };
  stops: readonly OrderedStop[];
  /** `start`: the day is laid out with the move first. `free`: the move is whichever leg crosses. */
  moveAt: 'start' | 'free';
}

export interface MoveDayReport {
  sides: Readonly<Record<string, MoveSide>>;
  violations: readonly OrderViolation[];
  /** The corrected order (the input order when nothing needed to move). */
  order: readonly string[];
  /** True when the corrected order differs from the input. */
  reordered: boolean;
  /**
   * Where the move belongs in the corrected order: `start` (nothing on the
   * origin side), `end` (nothing on the destination side) or `between` (after
   * the last origin-side stop). Only `start` permits a move-first day.
   */
  moveAt: 'start' | 'end' | 'between';
}

export function compileMoveDay(input: MoveDayInput): MoveDayReport {
  const origin = input.origin.coordinates;
  const destination = input.destination.coordinates;
  const sides: Record<string, MoveSide> = {};
  for (const stop of input.stops) sides[stop.id] = moveSideOf(origin, destination, stop.coordinates);
  const violations: OrderViolation[] = [];
  let arrived = input.moveAt === 'start';
  let arrivedAt: string | null = null;
  for (const stop of input.stops) {
    const side = sides[stop.id];
    if (side === 'destination' && !arrived) {
      arrived = true;
      arrivedAt = stop.name;
    } else if (side === 'origin' && arrived) {
      const km = origin && stop.coordinates ? Math.round(greatCircleKm(stop.coordinates, origin)) : 0;
      violations.push({
        kind: 'move_backtrack',
        stopId: stop.id,
        stopName: stop.name,
        detail: `${stop.name} is back near ${input.origin.name}${km > 0 ? ` (${km} km from it)` : ''} after the day has already moved on to ${arrivedAt ? `${arrivedAt}, near ${input.destination.name}` : input.destination.name}; it belongs before the move.`,
      });
    }
  }

  /* The stable partition, with pinned and unplaced stops held where they are. */
  const held = input.stops.map((s) => s.pinned === true || sides[s.id] === 'unknown');
  const free = input.stops.filter((_, i) => !held[i]);
  const sorted = [...free.filter((s) => sides[s.id] === 'origin'), ...free.filter((s) => sides[s.id] === 'destination')];
  let next = 0;
  const order = input.stops.map((stop, i) => (held[i] ? stop.id : sorted[next++]!.id));
  const reordered = order.some((id, i) => id !== input.stops[i]!.id);

  const originCount = input.stops.filter((s) => sides[s.id] === 'origin').length;
  const destinationCount = input.stops.filter((s) => sides[s.id] === 'destination').length;
  const moveAt = originCount === 0 ? 'start' : destinationCount === 0 ? 'end' : 'between';
  return { sides, violations, order, reordered, moveAt };
}
