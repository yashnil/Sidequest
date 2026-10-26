/**
 * The pure half of the atlas map: what it draws and the arithmetic of the
 * coordinate bar. No DOM, no MapLibre, so it can be asserted in a unit test.
 */
export type AtlasPointState = 'chosen' | 'idle' | 'muted' | 'base' | 'meal' | 'done';

export interface AtlasPoint {
  id: string;
  lat: number;
  lng: number;
  /** The accessible name of the pin: what a screen reader says for it. */
  label: string;
  /** What is printed on the pin: a stop number, or nothing. */
  mark?: string;
  state?: AtlasPointState;
}

/**
 * A line on the map, named by its evidence rather than its colour.
 *
 * `measured` is a leg a router timed; `estimated` is Sidequest's own figure
 * from coordinates; `unmeasured` is a straight connector that claims nothing
 * about the road; `boat`/`rail`/`flight`/`trail` are drawn by mode.
 */
export type AtlasLineStyle = 'measured' | 'estimated' | 'unmeasured' | 'boat' | 'rail' | 'flight' | 'trail';

export interface AtlasLine {
  id: string;
  /** `[lng, lat]` pairs, the GeoJSON order. */
  coords: readonly (readonly [number, number])[];
  style: AtlasLineStyle;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The box around the points, widened a little when they are one point or a line so the camera never zooms into a creek. */
export function boundsOf(points: readonly { lat: number; lng: number }[], minSpan = 0.012): Bounds | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (valid.length === 0) return null;
  let west = Math.min(...valid.map((p) => p.lng));
  let east = Math.max(...valid.map((p) => p.lng));
  let south = Math.min(...valid.map((p) => p.lat));
  let north = Math.max(...valid.map((p) => p.lat));
  if (east - west < minSpan) {
    const mid = (east + west) / 2;
    west = mid - minSpan / 2;
    east = mid + minSpan / 2;
  }
  if (north - south < minSpan) {
    const mid = (north + south) / 2;
    south = mid - minSpan / 2;
    north = mid + minSpan / 2;
  }
  return { west, south, east, north };
}

/** `38.7077° N` — four decimals, hemisphere letter, the way a survey sheet labels its corners. */
export function formatCoordinate(value: number, axis: 'lat' | 'lng'): string {
  const hemisphere = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

const NICE = [1, 2, 5];

/**
 * A scale bar for the camera: the longest round distance that fits in about
 * ninety pixels at this latitude and zoom (512 px tiles, Web Mercator).
 */
export function scaleBar(lat: number, zoom: number, maxPx = 90): { px: number; label: string } | null {
  const metresPerPx = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
  if (!Number.isFinite(metresPerPx) || metresPerPx <= 0) return null;
  const maxMetres = metresPerPx * maxPx;
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxMetres)));
  let best = magnitude;
  for (const n of NICE) if (n * magnitude <= maxMetres) best = n * magnitude;
  const px = Math.round(best / metresPerPx);
  const label = best >= 1000 ? `${best / 1000} km` : `${best} m`;
  return { px, label };
}

/**
 * THE PLAN'S OWN DRAWING, IN THE ATLAS'S VOCABULARY.
 *
 * The day and trip maps are computed on the server (`dayMapModel`,
 * `overviewMapModel`) as marks with a class and connectors with an evidence
 * style. This translates them without adding or removing anything: a measured
 * leg stays solid (along the router's own geometry when it returned one), an
 * estimate stays dashed, a connector nobody measured stays a dotted line that
 * claims nothing about the road, and a boat, train or flight is drawn by mode.
 */
export interface PlanMark {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
  kind: 'gateway' | 'base' | 'signature' | 'stop' | 'place' | 'overnight_experience' | 'unresolved';
  order?: number;
}

export interface PlanConnector {
  id: string;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  style: string;
  path?: readonly { lat: number; lng: number }[];
}

const CONNECTOR_STYLE: Record<string, AtlasLineStyle> = {
  measured_drive: 'measured',
  measured_transit: 'measured',
  measured_walk: 'measured',
  estimated: 'estimated',
  unmeasured: 'unmeasured',
  sightline: 'unmeasured',
  conceptual: 'unmeasured',
  boat: 'boat',
  rail: 'rail',
  flight: 'flight',
  trail: 'trail',
};

export function planToAtlas(input: {
  marks: readonly PlanMark[];
  connectors?: readonly PlanConnector[];
  base?: { name: string; coordinates: { lat: number; lng: number } } | null;
  /** How a stop is named for a screen reader: "Stop 2: Belém Tower". */
  label?: (mark: PlanMark) => string;
}): { points: AtlasPoint[]; lines: AtlasLine[] } {
  const points: AtlasPoint[] = [];
  const seen = new Set<string>();
  if (input.base) {
    points.push({ id: 'base', lat: input.base.coordinates.lat, lng: input.base.coordinates.lng, label: `${input.base.name}, where you sleep`, mark: '⌂', state: 'base' });
  }
  for (const mark of input.marks) {
    if (seen.has(mark.id)) continue;
    seen.add(mark.id);
    /* The plan's own base mark at the base already drawn is the same bed, not a second one. */
    if (input.base && mark.kind === 'base' && nearlySame(mark.coordinates, input.base.coordinates)) continue;
    const state: AtlasPointState =
      mark.kind === 'base' || mark.kind === 'gateway' ? 'base' : mark.kind === 'place' || mark.kind === 'unresolved' ? 'muted' : 'chosen';
    points.push({
      id: mark.id,
      lat: mark.coordinates.lat,
      lng: mark.coordinates.lng,
      label: input.label ? input.label(mark) : mark.order !== undefined ? `Stop ${mark.order}: ${mark.name}` : mark.name,
      mark: state === 'base' ? (mark.kind === 'gateway' ? '✈' : '⌂') : mark.order !== undefined ? String(mark.order) : '',
      state,
    });
  }
  const lines: AtlasLine[] = (input.connectors ?? []).map((connector) => {
    const style = CONNECTOR_STYLE[connector.style] ?? 'unmeasured';
    const path = connector.path && connector.path.length >= 2 && style === 'measured' ? connector.path : [connector.from, connector.to];
    return { id: connector.id, style, coords: path.map((p) => [p.lng, p.lat] as const) };
  });
  return { points, lines };
}

/** Within about 60 m — one place written twice, not two places. */
function nearlySame(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
  return Math.abs(a.lat - b.lat) < 0.0006 && Math.abs(a.lng - b.lng) < 0.0006 / Math.max(0.2, Math.cos((a.lat * Math.PI) / 180));
}

/** Indices grouped by screen proximity (single linkage): a pin joins a group when it is within `px` of any member. */
export function groupClose(at: readonly { x: number; y: number }[], px: number): number[][] {
  const group = at.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) {
      if (Math.hypot(at[i]!.x - at[j]!.x, at[i]!.y - at[j]!.y) < px) group[find(i)] = find(j);
    }
  }
  const out = new Map<number, number[]>();
  at.forEach((_, i) => {
    const root = find(i);
    out.set(root, [...(out.get(root) ?? []), i]);
  });
  return [...out.values()];
}
