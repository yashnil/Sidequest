/**
 * V8 §14 — WHERE A PLACED LOCALITY SITS INSIDE THE GENERATION MAP'S FRAME.
 *
 * The build reports every locality it has actually put on the map, in the
 * order it placed them (`GenerationProgressView.placed`, real lookups only).
 * The generation screen draws each one as a mark over the destination frame
 * and joins consecutive marks with a drawn line, so the route skeleton appears
 * as the draft makes it available.
 *
 * This is the projection and nothing else: a plate-carrée fit of the
 * destination's published bounds — or, when no bounds were published, a box
 * around its centre — widened to include every placed point and padded so a
 * mark never sits on the edge. The result is a percentage position inside the
 * frame, which is what an absolutely positioned label needs and what an SVG
 * `viewBox="0 0 100 100"` with `preserveAspectRatio="none"` draws lines in.
 *
 * Honest about what it is: the overlay is a *sketch* over the basemap, not a
 * registration with it. The basemap fits the same bounds with its own padding,
 * so a mark lands near, not on, the town it names; the caption under the frame
 * says the line is placement order rather than a measured route.
 */

export interface PlacedPoint {
  name: string;
  lat: number;
  lng: number;
}

export interface GeoBox {
  southWest: { lat: number; lng: number };
  northEast: { lat: number; lng: number };
}

export interface ProjectedPoint extends PlacedPoint {
  /** 0–100, left to right. */
  x: number;
  /** 0–100, top to bottom. */
  y: number;
}

/** The narrowest box a frame is allowed to be, in degrees, so one point is not a division by zero. */
const MIN_SPAN_DEG = 0.25;
/** Room between the outermost mark and the frame's edge, as a fraction of the box. */
const PADDING = 0.12;

export function projectPlaced(points: readonly PlacedPoint[], frame: { center: { lat: number; lng: number }; bounds?: GeoBox | null }): ProjectedPoint[] {
  if (points.length === 0) return [];
  let south = frame.bounds?.southWest.lat ?? frame.center.lat - MIN_SPAN_DEG;
  let north = frame.bounds?.northEast.lat ?? frame.center.lat + MIN_SPAN_DEG;
  let west = frame.bounds?.southWest.lng ?? frame.center.lng - MIN_SPAN_DEG;
  let east = frame.bounds?.northEast.lng ?? frame.center.lng + MIN_SPAN_DEG;
  for (const point of points) {
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
    west = Math.min(west, point.lng);
    east = Math.max(east, point.lng);
  }
  if (north - south < MIN_SPAN_DEG) {
    const mid = (north + south) / 2;
    south = mid - MIN_SPAN_DEG / 2;
    north = mid + MIN_SPAN_DEG / 2;
  }
  if (east - west < MIN_SPAN_DEG) {
    const mid = (east + west) / 2;
    west = mid - MIN_SPAN_DEG / 2;
    east = mid + MIN_SPAN_DEG / 2;
  }
  const latPad = (north - south) * PADDING;
  const lngPad = (east - west) * PADDING;
  south -= latPad;
  north += latPad;
  west -= lngPad;
  east += lngPad;
  const width = east - west;
  const height = north - south;
  return points.map((point) => ({
    ...point,
    x: round(((point.lng - west) / width) * 100),
    y: round(((north - point.lat) / height) * 100),
  }));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Elapsed seconds as a calm figure: "48s" under a minute, "1:32" above it.
 * A count of seconds is a fact; nothing here estimates what is left.
 */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
