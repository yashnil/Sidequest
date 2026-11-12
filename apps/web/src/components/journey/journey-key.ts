import type { JourneyLeg } from '@/lib/journey/model';

/**
 * THE JOURNEY MAP'S KEY, FROM WHAT IS DRAWN.
 *
 * The key listed all four line kinds whatever was on screen, so a day whose
 * every leg was a straight chord still carried "Route as measured" — a key
 * entry for a line nobody drew, beside lines it did not describe. It now lists
 * exactly the line kinds and mark kinds the current scene contains, in a fixed
 * order, once each; the same predicate the renderer filters its layers by
 * decides which entry a leg belongs to, so the two cannot drift.
 */
export type JourneyLineKind = 'routed' | 'straight_timed' | 'straight_unknown' | 'arc';
export type JourneyMarkKind = 'base' | 'stop_numbered' | 'stop_by_day' | 'meal' | 'cluster' | 'context';

export const LINE_KEY: Record<JourneyLineKind, string> = {
  routed: 'Route as measured — solid, along the road or path a router returned',
  straight_timed: 'Thin dashed: straight connection, not the road — the time is measured or estimated',
  straight_unknown: 'Dotted: straight connection, not the road — nobody measured it',
  arc: 'Arc: a flight or long crossing, never ground',
};

export const MARK_KEY: Record<JourneyMarkKind, string> = {
  base: 'Where you sleep',
  stop_numbered: 'A stop, numbered in the order of the day',
  stop_by_day: 'A stop, coloured and numbered by its day',
  meal: 'A meal',
  cluster: 'Places close together — press to zoom in',
  context: 'The rest of the trip, faint',
};

/** Which key entry a leg is drawn as: the same tests the map's layer filters use. */
export function lineKindOf(leg: Pick<JourneyLeg, 'shape' | 'time' | 'disconnected'>): JourneyLineKind {
  if (leg.disconnected) return 'arc';
  if (leg.shape === 'routed') return 'routed';
  return leg.time === 'unknown' ? 'straight_unknown' : 'straight_timed';
}

const LINE_ORDER: JourneyLineKind[] = ['routed', 'straight_timed', 'straight_unknown', 'arc'];
const MARK_ORDER: JourneyMarkKind[] = ['base', 'stop_numbered', 'stop_by_day', 'meal', 'cluster', 'context'];

export function journeyKey(input: {
  legs: readonly Pick<JourneyLeg, 'shape' | 'time' | 'disconnected' | 'coords'>[];
  pins: readonly { kind: string; dayNumber?: number | undefined; colour?: string | undefined }[];
  clusters?: number;
}): { lines: { kind: JourneyLineKind; text: string }[]; marks: { kind: JourneyMarkKind; text: string }[] } {
  const lines = new Set(input.legs.filter((leg) => leg.coords.length >= 2).map(lineKindOf));
  const marks = new Set<JourneyMarkKind>();
  for (const pin of input.pins) {
    if (pin.kind === 'base' || pin.kind === 'gateway') marks.add('base');
    else if (pin.kind === 'meal') marks.add('meal');
    else if (pin.kind === 'context') marks.add('context');
    else if (pin.kind === 'stop') marks.add(pin.colour ? 'stop_by_day' : 'stop_numbered');
  }
  if ((input.clusters ?? 0) > 0) marks.add('cluster');
  return {
    lines: LINE_ORDER.filter((kind) => lines.has(kind)).map((kind) => ({ kind, text: LINE_KEY[kind] })),
    marks: MARK_ORDER.filter((kind) => marks.has(kind)).map((kind) => ({ kind, text: MARK_KEY[kind] })),
  };
}
