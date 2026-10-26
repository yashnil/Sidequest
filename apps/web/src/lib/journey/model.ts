import { decodePolyline, haversineKm, journeyFromSegment, journeyLineKind, TRANSPORT_MODE_LABELS, type Itinerary, type ItineraryDay, type ItineraryItem, type TravelSegment } from '@sidequest/core';

/**
 * THE JOURNEY, AS SOMETHING TO EXPLORE — derived, never planned.
 *
 * The Journey Explorer draws what the planner already decided: the same items,
 * in the same order, at the same coordinates, with the same travel records. This
 * module is a pure projection of a stored itinerary (no provider, no clock, no
 * model) into the shapes a map needs, so the map can never disagree with the
 * timeline and an edit that changes the itinerary changes the drawing on the
 * next render.
 *
 * TWO KINDS OF EVIDENCE PER LEG, KEPT APART.
 *
 * A travel *time* and a route *shape* are different facts and the planner
 * holds them separately: a router can time a leg without returning its line, an
 * estimate has a time and no line at all, and a published timetable has a time
 * and no geometry we may draw. So every leg carries
 *
 * - `time`: `measured` (a router or timetable answered), `estimated`
 *   (Sidequest's own figure from coordinates, or a model's), or `unknown`;
 * - `shape`: `routed` (the provider's own polyline, drawn along the road or
 *   path) or `straight` (two real positions joined by a chord that is never
 *   presented as a road, rail or trail).
 *
 * The map's line style follows the shape and the label states the time, so a
 * measured time over a straight chord reads "18 min · measured · straight line,
 * not the route", which is exactly what is known.
 */

export type JourneyModeKind = 'drive' | 'walk' | 'transit' | 'rail' | 'ferry' | 'flight' | 'cycle' | 'trail' | 'transfer' | 'unknown';
export type JourneyTime = 'measured' | 'estimated' | 'unknown';
export type JourneyShape = 'routed' | 'straight';
export type JourneyStopKind = 'base' | 'stop' | 'meal' | 'gateway';

export interface JourneyPoint {
  lat: number;
  lng: number;
}

export interface JourneyStop {
  /** The timeline item's id (the base uses `base:<dayNumber>`). */
  id: string;
  /** The place this stop is, when the plan names one — the key the board and the rows share. */
  placeId?: string;
  /** The number the row and the pin both wear; null for the base and for meals. */
  number: number | null;
  kind: JourneyStopKind;
  title: string;
  point: JourneyPoint;
  /** Minutes after midnight, when the stop is timed. */
  start?: number;
  end?: number;
  /** One sentence of why, from the plan. */
  why?: string;
}

export interface JourneyLeg {
  id: string;
  from: string;
  to: string;
  mode: JourneyModeKind;
  /** The plan's own word for the mode, for the label. */
  modeLabel: string;
  time: JourneyTime;
  minutes: number | null;
  shape: JourneyShape;
  /** Who drew the shape, when it is routed. */
  shapeSource?: string;
  /** `[lng, lat]` along the routed shape, or the two endpoints of the chord. */
  coords: [number, number][];
  /** Road km when routed and published, straight-line km otherwise — `distanceBasis` says which. */
  km: number;
  distanceBasis: 'routed' | 'straight_line';
  /** A flight or a long ferry: a disconnected segment, drawn as an arc and never as ground. */
  disconnected: boolean;
}

export interface JourneyDay {
  dayNumber: number;
  date: string;
  theme: string;
  baseId: string;
  baseName: string;
  stops: JourneyStop[];
  legs: JourneyLeg[];
  /** Stops the plan holds that no source has positioned: counted, never drawn. */
  unplaced: number;
  totals: { minutes: number | null; km: number; measuredLegs: number; legs: number; routedLegs: number };
}

export interface JourneyBase {
  id: string;
  name: string;
  point: JourneyPoint;
  nights: number;
  dayNumbers: number[];
}

export interface JourneyModel {
  days: JourneyDay[];
  bases: JourneyBase[];
  /** Moves between consecutive bases, from the day that makes the move. */
  moves: JourneyLeg[];
}

const MODE_OF_LINE: Record<ReturnType<typeof journeyLineKind>, JourneyModeKind> = {
  road: 'drive',
  pedestrian: 'walk',
  rail: 'rail',
  water: 'ferry',
  air: 'flight',
  trail: 'trail',
  operator: 'transfer',
};

/** What kind of movement a leg is, asked of the journey vocabulary rather than re-parsed from strings here. */
export function modeKindOf(segment: TravelSegment): JourneyModeKind {
  if (segment.mode === 'bicycle') return 'cycle';
  if (segment.mode === 'public_bus' || segment.mode === 'shuttle') return 'transit';
  if (segment.mode === 'unsupported') return 'unknown';
  try {
    return MODE_OF_LINE[journeyLineKind(journeyFromSegment(segment))] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function timeOf(segment: TravelSegment): JourneyTime {
  if (segment.provenance === 'measured' || segment.provenance === 'official') return 'measured';
  if (segment.provenance === 'estimated' || segment.provenance === 'modelled') return 'estimated';
  return 'unknown';
}

function routedPath(segment: TravelSegment | undefined): [number, number][] | null {
  if (!segment?.geometry || segment.provenance !== 'measured') return null;
  try {
    const decoded = decodePolyline(segment.geometry);
    return decoded.length > 1 ? decoded.map((p) => [p.lng, p.lat] as [number, number]) : null;
  } catch {
    return null;
  }
}

function legBetween(id: string, from: JourneyStop, to: JourneyStop, segment: TravelSegment | undefined): JourneyLeg {
  const straightKm = haversineKm(from.point, to.point);
  const path = routedPath(segment);
  const mode = segment ? modeKindOf(segment) : 'unknown';
  const time = segment ? timeOf(segment) : 'unknown';
  return {
    id,
    from: from.id,
    to: to.id,
    mode,
    modeLabel: segment ? (TRANSPORT_MODE_LABELS[segment.mode] ?? segment.mode) : 'Not stated',
    time,
    minutes: segment?.minutes ?? null,
    shape: path ? 'routed' : 'straight',
    ...(path && segment?.provider ? { shapeSource: segment.provider } : path ? { shapeSource: 'router' } : {}),
    coords: path ?? [[from.point.lng, from.point.lat], [to.point.lng, to.point.lat]],
    km: path && typeof segment?.km === 'number' ? segment.km : Math.round(straightKm * 10) / 10,
    distanceBasis: path && typeof segment?.km === 'number' ? 'routed' : 'straight_line',
    disconnected: mode === 'flight' || (mode === 'ferry' && straightKm > 25),
  };
}

function itemPoint(item: ItineraryItem, coordinates: Record<string, JourneyPoint>): JourneyPoint | null {
  return item.placeId ? (coordinates[item.placeId] ?? null) : null;
}

function firstSentence(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  return (match ? match[1] : trimmed) || undefined;
}

export function journeyDay(input: {
  day: ItineraryDay;
  coordinates: Record<string, JourneyPoint>;
  nameOf?: (placeId: string, fallback: string) => string;
  whyOf?: (placeId: string) => string | undefined;
}): JourneyDay {
  const { day, coordinates } = input;
  const basePoint = coordinates[day.baseId] ?? null;
  const base: JourneyStop | null = basePoint ? { id: `base:${day.dayNumber}`, number: null, kind: 'base', title: day.baseName, point: basePoint } : null;
  const stops: JourneyStop[] = [];
  const legs: JourneyLeg[] = [];
  let unplaced = 0;
  let number = 0;
  let cursor: JourneyStop | null = base;
  let pending: { id: string; segment: TravelSegment } | null = null;
  if (base) stops.push(base);

  for (const item of day.items) {
    if (item.kind === 'travel') {
      if (item.travel) pending = { id: item.id, segment: item.travel };
      if (item.travel?.role === 'return' && base && cursor && cursor !== base) {
        legs.push(legBetween(`${item.id}:return`, cursor, base, item.travel));
        cursor = base;
        pending = null;
      }
      continue;
    }
    if (item.kind !== 'activity' && item.kind !== 'meal') continue;
    const point = itemPoint(item, coordinates);
    if (!point) {
      if (item.kind === 'activity') unplaced += 1;
      continue;
    }
    const isStop = item.kind === 'activity';
    if (isStop) number += 1;
    const title = item.placeId && input.nameOf ? input.nameOf(item.placeId, item.title) : item.title;
    const why = firstSentence((item.placeId && input.whyOf?.(item.placeId)) || item.reason);
    const stop: JourneyStop = {
      id: item.id,
      ...(item.placeId ? { placeId: item.placeId } : {}),
      number: isStop ? number : null,
      kind: isStop ? 'stop' : 'meal',
      title,
      point,
      start: item.startMinute,
      end: item.startMinute + item.durationMinutes,
      ...(why ? { why } : {}),
    };
    stops.push(stop);
    if (cursor) legs.push(legBetween(pending?.id ?? `${item.id}:approach`, cursor, stop, pending?.segment));
    cursor = stop;
    pending = null;
  }

  const timed = legs.filter((leg) => leg.minutes !== null);
  return {
    dayNumber: day.dayNumber,
    date: day.date,
    theme: day.theme,
    baseId: day.baseId,
    baseName: day.baseName,
    stops,
    legs,
    unplaced,
    totals: {
      minutes: timed.length === legs.length ? timed.reduce((sum, leg) => sum + (leg.minutes ?? 0), 0) : null,
      km: Math.round(legs.reduce((sum, leg) => sum + leg.km, 0) * 10) / 10,
      measuredLegs: legs.filter((leg) => leg.time === 'measured').length,
      legs: legs.length,
      routedLegs: legs.filter((leg) => leg.shape === 'routed').length,
    },
  };
}

export function journeyModel(input: {
  itinerary: Itinerary;
  coordinates: Record<string, JourneyPoint>;
  nameOf?: (placeId: string, fallback: string) => string;
  whyOf?: (placeId: string) => string | undefined;
}): JourneyModel {
  const days = input.itinerary.days.map((day) => journeyDay({ day, coordinates: input.coordinates, ...(input.nameOf ? { nameOf: input.nameOf } : {}), ...(input.whyOf ? { whyOf: input.whyOf } : {}) }));
  const bases: JourneyBase[] = [];
  for (const day of input.itinerary.days) {
    const point = input.coordinates[day.baseId];
    if (!point) continue;
    const last = bases[bases.length - 1];
    if (last && last.id === day.baseId) {
      last.dayNumbers.push(day.dayNumber);
      continue;
    }
    const stay = input.itinerary.package?.bases.find((base) => base.id === day.baseId || base.placeId === day.baseId);
    bases.push({ id: day.baseId, name: day.baseName, point, nights: stay?.nights ?? 0, dayNumbers: [day.dayNumber] });
  }
  /*
   * A base move is drawn from the travel record of the day that makes it — the
   * planner's transfer leg — and otherwise as an untimed chord between the two
   * beds, so the whole-trip view shows the trip's spine without inventing how it
   * is travelled.
   */
  const moves: JourneyLeg[] = [];
  for (let index = 1; index < bases.length; index += 1) {
    const from = bases[index - 1]!;
    const to = bases[index]!;
    const day = input.itinerary.days.find((d) => d.dayNumber === to.dayNumbers[0]);
    const transfer = day?.items.find((item) => item.kind === 'travel' && item.travel && (item.travel.role === 'transfer' || item.travel.viaBases))?.travel;
    moves.push(
      legBetween(
        `move:${from.id}->${to.id}`,
        { id: `base:${from.id}`, number: null, kind: 'base', title: from.name, point: from.point },
        { id: `base:${to.id}`, number: null, kind: 'base', title: to.name, point: to.point },
        transfer,
      ),
    );
  }
  return { days, bases, moves };
}

/** A great-circle-ish arc for a disconnected segment: a curve that cannot be mistaken for a road. */
export function arcCoords(from: [number, number], to: [number, number], segments = 32): [number, number][] {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lift = Math.hypot(dx, dy) * 0.18;
  const cx = mx - dy * (lift / Math.max(Math.hypot(dx, dy), 1e-9));
  const cy = my + dx * (lift / Math.max(Math.hypot(dx, dy), 1e-9));
  const out: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    out.push([(1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2, (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2]);
  }
  return out;
}

/** The words a leg is labelled with: mode, time and its evidence, and — for a chord — that it is not the route. */
export function legLabel(leg: JourneyLeg, minutes: (value: number) => string): string {
  const time = leg.minutes === null ? 'time unknown' : `${leg.time === 'estimated' ? '≈' : ''}${minutes(leg.minutes)} · ${leg.time === 'measured' ? 'measured' : 'estimate'}`;
  const distance = `${leg.distanceBasis === 'routed' ? '' : '≈'}${leg.km < 10 ? leg.km.toFixed(1) : Math.round(leg.km)} km${leg.distanceBasis === 'routed' ? '' : ' straight-line'}`;
  const shape = leg.disconnected ? `${leg.modeLabel.toLowerCase()}, not drawn to its route` : leg.shape === 'routed' ? 'route as measured' : 'straight line, not the route';
  return `${leg.modeLabel} · ${time} · ${distance} · ${shape}`;
}
