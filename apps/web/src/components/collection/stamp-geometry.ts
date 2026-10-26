/**
 * THE COLLECTION'S ARITHMETIC — pure, so the stamps and the cover can be
 * asserted without a browser.
 *
 * A stamp is drawn from the trip's own persisted geography (`TripShape`):
 * the bases in sleeping order and the placed stops, projected into a disc.
 * Nothing here invents a point. A trip with no coordinates gets no route,
 * only its name and dates on the ring, and a dotted inner ring that says
 * "not drawn yet" in the same vocabulary the maps use for "not measured".
 *
 * Import-free (types only) so a unit test reads it directly.
 */

export interface ShapeInput {
  center: { lat: number; lng: number } | null;
  bases: readonly { name: string; lat: number; lng: number }[];
  stops: readonly { lat: number; lng: number; day: number }[];
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface ProjectedShape {
  bases: (ProjectedPoint & { name: string; index: number })[];
  stops: ProjectedPoint[];
  /** The destination's centre, drawn only when there is nothing else to draw. */
  center: ProjectedPoint | null;
  /** The real extent the drawing covers, for the corner labels of a cover. */
  extent: { north: number; south: number; east: number; west: number } | null;
  /** Drawing units per degree of latitude (0 when the shape is one place): what a straight-line scale bar is computed from. */
  pxPerDegree: number;
}

/** Longitudes unwrapped around a reference so a trip across the antimeridian stays one shape. */
function unwrap(lng: number, ref: number): number {
  let d = lng - ref;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return ref + d;
}

/**
 * Project the trip into a box (`width` × `height`, inset by `pad`) with a
 * local equirectangular projection — longitude scaled by the cosine of the
 * mean latitude, which is what makes Iceland look like Iceland at this size.
 * Aspect is preserved; a single point (or a cluster under ~100 m) sits in the
 * middle rather than being blown up to fill the box.
 */
export function projectShape(shape: ShapeInput, box: { width: number; height: number; pad: number }): ProjectedShape {
  const all = [...shape.bases, ...shape.stops].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const cx = box.width / 2;
  const cy = box.height / 2;
  if (all.length === 0) {
    return { bases: [], stops: [], center: shape.center ? { x: cx, y: cy } : null, extent: shape.center ? { north: shape.center.lat, south: shape.center.lat, east: shape.center.lng, west: shape.center.lng } : null, pxPerDegree: 0 };
  }
  const ref = all[0]!.lng;
  const lngs = all.map((p) => unwrap(p.lng, ref));
  const lats = all.map((p) => p.lat);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const midLat = (north + south) / 2;
  const k = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const spanX = (east - west) * k;
  const spanY = north - south;
  const span = Math.max(spanX, spanY);
  const innerW = box.width - box.pad * 2;
  const innerH = box.height - box.pad * 2;
  /* Under ~100 m the "shape" is one place: centre it, do not magnify it. */
  const scale = span < 0.001 ? 0 : Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity);
  const midX = ((east + west) / 2) * k;
  const midY = (north + south) / 2;
  const project = (lat: number, lng: number): ProjectedPoint => ({
    x: round(cx + (unwrap(lng, ref) * k - midX) * scale),
    y: round(cy - (lat - midY) * scale),
  });
  return {
    bases: shape.bases.map((b, index) => ({ ...project(b.lat, b.lng), name: b.name, index })),
    stops: shape.stops.map((s) => project(s.lat, s.lng)),
    center: null,
    extent: { north, south, east: normaliseLng(east), west: normaliseLng(west) },
    pxPerDegree: Number.isFinite(scale) ? scale : 0,
  };
}

function normaliseLng(lng: number): number {
  let v = lng;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Consecutive identical bases (two stays in one town) collapse to one mark on the line. */
export function baseLine(bases: readonly ProjectedPoint[]): ProjectedPoint[] {
  const out: ProjectedPoint[] = [];
  for (const b of bases) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - b.x) > 0.5 || Math.abs(last.y - b.y) > 0.5) out.push(b);
  }
  return out;
}

/** A small stable hash of a trip id: the stamp's tilt and serial come from it, so a trip looks the same every visit. */
export function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** −6° … +6°, never flat: a stamp pressed by a hand. */
export function stampTilt(id: string): number {
  const t = (idHash(id) % 1300) / 100 - 6.5;
  return Math.abs(t) < 1.2 ? (t < 0 ? -1.8 : 1.8) : Math.round(t * 10) / 10;
}

/**
 * Catalogue numbers: the order trips were *taken in* (start date, then id),
 * over the whole collection — never over a filtered view, so a number belongs
 * to its trip and does not move when somebody searches.
 */
export function catalogueNumbers(rows: readonly { id: string; startDate: string }[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  return new Map(sorted.map((row, i) => [row.id, i + 1]));
}

export function formatCatalogue(n: number): string {
  return `No. ${String(n).padStart(2, '0')}`;
}

/** Days between two ISO dates (UTC calendar days). */
function dayDiff(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export type Countdown = { kind: 'until'; days: number } | { kind: 'during'; day: number; of: number } | { kind: 'past' } | { kind: 'open' };

/**
 * Where today sits against the trip: "in 41 days", "day 3 of 9", or past.
 * `today` comes from the server (`renderInstant`) so the figure cannot
 * disagree between the server render and hydration.
 */
export function countdown(row: { startDate: string; nights: number; timing: 'fixed' | 'chosen' | 'open' }, today: string): Countdown {
  if (row.timing === 'open' || !row.startDate) return { kind: 'open' };
  const until = dayDiff(today, row.startDate);
  const days = row.nights + 1;
  if (until > 0) return { kind: 'until', days: until };
  if (-until < days) return { kind: 'during', day: -until + 1, of: days };
  return { kind: 'past' };
}

export function countdownWords(c: Countdown): string | null {
  switch (c.kind) {
    case 'until':
      return c.days === 1 ? 'Tomorrow' : `In ${c.days} days`;
    case 'during':
      return `Day ${c.day} of ${c.of}`;
    case 'past':
      return 'Been and gone';
    default:
      return null;
  }
}

/**
 * The one trip the collection opens on: under way now, else the nearest one
 * still ahead with real dates, else none. Ideas with open timing and past
 * trips never take the cover — the cover is the trip somebody is about to live.
 */
export function coverTrip<T extends { id: string; startDate: string; nights: number; timing: 'fixed' | 'chosen' | 'open'; lifecycle: string }>(rows: readonly T[], today: string): T | null {
  const live = rows.filter((r) => r.lifecycle !== 'archived' && r.lifecycle !== 'past');
  const during = live.find((r) => countdown(r, today).kind === 'during');
  if (during) return during;
  const ahead = live
    .map((r) => ({ r, c: countdown(r, today) }))
    .filter((x): x is { r: T; c: { kind: 'until'; days: number } } => x.c.kind === 'until')
    .sort((a, b) => a.c.days - b.c.days || a.r.id.localeCompare(b.r.id));
  return ahead[0]?.r ?? null;
}
