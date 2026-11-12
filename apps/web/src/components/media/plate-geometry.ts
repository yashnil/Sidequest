import { LAND_BITS, LAND_COLS, LAND_NORTH, LAND_ROWS, LAND_STEP } from '../advisor/world-dots';
import { MEDIA_CONTEXT_SPECS, type MediaContext } from '@/lib/media/frame';

/**
 * THE GEOGRAPHY UNDER A PLACE WITH NO PHOTOGRAPH — COMPUTED, NEVER INVENTED.
 *
 * Pure and import-light so it can be asserted in a unit test. Everything drawn
 * comes from the place's own coordinates and extent, and from Natural Earth's
 * 1:110m land (the same public-domain 2° mask the advisor's world map uses):
 *
 * - land as a dot lattice in a local equirectangular window around the place
 *   (x scaled by cos(latitude) so a degree east is as long as it really is);
 * - graticule lines at real whole-degree intervals, labelled;
 * - the extent as a ring at its true radius, when it is large enough to see;
 * - the place itself as one flare waypoint, at its true position.
 *
 * The coastline is coarse — 2° cells — and the plate says it is a map drawn
 * from coordinates rather than pretending to be anything finer.
 */

export interface PlateInput {
  lat: number;
  lng: number;
  radiusKm?: number;
  context: MediaContext;
}

export interface PlateGeometry {
  width: number;
  height: number;
  /** Path data: one hair-length stroke per land dot. */
  land: string;
  landDots: number;
  /** Lattice spacing, in viewBox units. */
  step: number;
  point: { x: number; y: number };
  /** Extent ring radius in viewBox units, or null when it would be smaller than the waypoint. */
  ring: number | null;
  graticule: { kind: 'lat' | 'lng'; value: number; at: number; label: string }[];
  /** Degrees of longitude across the frame. */
  spanLng: number;
}

/** Base viewBox width per context, and how many degrees of longitude the frame spans. */
const LAYOUT: Record<MediaContext, { width: number; span: number; columns: number }> = {
  hero: { width: 1200, span: 44, columns: 58 },
  card: { width: 600, span: 34, columns: 38 },
  thumb: { width: 300, span: 22, columns: 20 },
  strip: { width: 1400, span: 70, columns: 84 },
};

let bytes: Uint8Array | null = null;
function landBytes(): Uint8Array {
  if (bytes) return bytes;
  bytes = typeof atob === 'function' ? Uint8Array.from(atob(LAND_BITS), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(LAND_BITS, 'base64'));
  return bytes;
}

/** True when Natural Earth's 2° mask has land at this position. */
export function isLand(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const row = Math.floor((LAND_NORTH - lat) / LAND_STEP);
  if (row < 0 || row >= LAND_ROWS) return false;
  const wrapped = ((((lng + 180) % 360) + 360) % 360);
  const col = Math.min(LAND_COLS - 1, Math.floor(wrapped / LAND_STEP));
  const index = row * LAND_COLS + col;
  return Boolean(landBytes()[index >> 3]! & (0x80 >> (index & 7)));
}

const KM_PER_DEGREE = 111.32;

export function plateGeometry(input: PlateInput): PlateGeometry {
  const layout = LAYOUT[input.context];
  const width = layout.width;
  const height = Math.round(width / MEDIA_CONTEXT_SPECS[input.context].aspect);
  const lat0 = Math.max(-80, Math.min(80, input.lat));
  const cos = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  /* Pixels per degree of latitude; a degree of longitude is `k × cos`. */
  const k = width / (layout.span * cos);
  /*
   * The waypoint sits a little right of centre and above it — a composition,
   * not a claim: the window simply starts further west and further north.
   */
  const point = { x: Math.round(width * 0.62), y: Math.round(height * 0.46) };
  const lngAt = (x: number): number => input.lng + (x - point.x) / (k * cos);
  const latAt = (y: number): number => lat0 - (y - point.y) / k;

  const step = width / layout.columns;
  let land = '';
  let landDots = 0;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      if (!isLand(latAt(y), lngAt(x))) continue;
      land += `M${x.toFixed(1)} ${y.toFixed(1)}h.01`;
      landDots += 1;
    }
  }

  const radiusKm = input.radiusKm ?? 0;
  const ringPx = radiusKm > 0 ? (radiusKm / KM_PER_DEGREE) * k : 0;
  const ring = ringPx >= step * 0.6 ? Math.round(ringPx * 10) / 10 : null;

  /* Whole-degree graticule at an interval that gives three to six lines across. */
  const interval = [1, 2, 5, 10, 15, 20, 30].find((candidate) => layout.span / candidate <= 6) ?? 30;
  const graticule: PlateGeometry['graticule'] = [];
  const west = lngAt(0);
  const east = lngAt(width);
  for (let value = Math.ceil(west / interval) * interval; value <= east; value += interval) {
    const at = point.x + (value - input.lng) * k * cos;
    const normal = ((((value + 180) % 360) + 360) % 360) - 180;
    graticule.push({ kind: 'lng', value: normal, at: Math.round(at * 10) / 10, label: `${Math.abs(normal)}°${normal < 0 ? 'W' : normal > 0 ? 'E' : ''}` });
  }
  const north = latAt(0);
  const south = latAt(height);
  for (let value = Math.ceil(south / interval) * interval; value <= north; value += interval) {
    if (value > 90 || value < -90) continue;
    const at = point.y - (value - lat0) * k;
    graticule.push({ kind: 'lat', value, at: Math.round(at * 10) / 10, label: `${Math.abs(value)}°${value < 0 ? 'S' : value > 0 ? 'N' : ''}` });
  }

  return { width, height, land, landDots, step, point, ring, graticule, spanLng: layout.span };
}

/** "43.00° N · 42.80° E" — the coordinates the plate is drawn from. */
export function coordinateLabel(lat: number, lng: number): string {
  const fmt = (value: number) => Math.abs(value).toFixed(2);
  return `${fmt(lat)}° ${lat < 0 ? 'S' : 'N'} · ${fmt(lng)}° ${lng < 0 ? 'W' : 'E'}`;
}
