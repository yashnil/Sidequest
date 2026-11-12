import type { RouteShapeKind } from '../destinations/route-shape';
import type { GeoBounds } from '../schemas/geography';
import { haversineKm } from '../travel/estimate';

/**
 * DOES THE PROPOSAL COVER THE ROUTE?
 *
 * The scan's sufficiency check counts places; a route-shaped trip can hold
 * thirty well-placed places along one coast of an island and still be no ring
 * road at all (a live Iceland scan, 2026-11: 31 placed, nothing north or east
 * of the south coast). This check reads the placed places and bases against
 * whatever geometry Sidequest has for the destination, and names the parts the
 * proposal does not reach so the scan's one supplement can ask for them.
 *
 * In order of evidence:
 * - **extent**: a published or part-built box for the destination. Eight
 *   compass sectors around its centre; a sector counts when something placed
 *   sits in it at least 40% of the way to the box's edge.
 * - **stops**: the resolved stops of a linear route the traveller spelled out.
 *   Each stop needs something placed beside it, and each stretch between two
 *   stops something near its middle.
 * - **spread**: neither. A loop must enclose ground — places strung along one
 *   line are one side of it — so the spread across the line of the places
 *   must be a fair share of their length. A road trip whose places all sit in
 *   a small corner of what the trip could reach is clustered.
 *
 * Unknown ≠ false: with too few placed points, or no basis at all, the answer
 * is `checked: false` and nothing is asked for. Pure; no provider, no model.
 */

export interface RouteCoverageInput {
  kind: RouteShapeKind;
  points: readonly { coordinates: { lat: number; lng: number } }[];
  /** The destination's box, when one was published or built from resolved parts. */
  extent?: GeoBounds | null;
  /** Resolved stops of a linear route, in order. */
  stops?: readonly { label: string; center: { lat: number; lng: number } }[];
  /** How far the trip may reach from its centre, in km. */
  reachKm: number;
}

export interface RouteCoverage {
  checked: boolean;
  basis: 'extent' | 'stops' | 'spread' | 'none';
  covered: boolean;
  /** What the proposal does not reach, as compass directions ("north") or stretches ("between A and B"). */
  uncovered: string[];
  /** One developer-facing sentence with the numbers. */
  note: string;
}

const WINDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;
/** A sector counts when something sits this share of the way to the destination's edge. */
const SECTOR_DEPTH = 0.4;
/** Sectors a loop may leave empty (a box's corners are often sea). */
const LOOP_EMPTY_SECTORS = 2;
const TOURING_EMPTY_SECTORS = 3;
/** A loop's places must spread across their own line by this share of its length. */
const LOOP_MIN_WIDTH_SHARE = 0.35;
/** A road trip's places clustered within this share of the trip's reach are one corner of it. */
const TOURING_MIN_SPREAD_SHARE = 0.25;
const MIN_POINTS = 5;

/** Equirectangular km about a reference latitude: good enough to tell a line from a ring. */
function projector(lat0: number) {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  return (p: { lat: number; lng: number }) => ({ x: p.lng * kx, y: p.lat * 110.57 });
}

function windOf(dx: number, dy: number): (typeof WINDS)[number] {
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return WINDS[Math.round(bearing / 45) % 8]!;
}

export function routeCoverage(input: RouteCoverageInput): RouteCoverage {
  const points = input.points.map((p) => p.coordinates);
  const none = (note: string): RouteCoverage => ({ checked: false, basis: 'none', covered: true, uncovered: [], note });
  if (points.length < MIN_POINTS) return none(`Only ${points.length} placed points; too few to judge the route.`);

  // --- a box for the destination -----------------------------------------------------------
  const box = input.extent ?? null;
  if (box && haversineKm(box.southWest, box.northEast) >= 100) {
    const center = { lat: (box.southWest.lat + box.northEast.lat) / 2, lng: (box.southWest.lng + box.northEast.lng) / 2 };
    const project = projector(center.lat);
    const c = project(center);
    const sw = project(box.southWest);
    const ne = project(box.northEast);
    const halfW = Math.max(1, (ne.x - sw.x) / 2);
    const halfH = Math.max(1, (ne.y - sw.y) / 2);
    const reached = new Set<string>();
    for (const point of points) {
      const p = project(point);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      if (dx === 0 && dy === 0) continue;
      /* Distance from the centre to the box's edge along this bearing. */
      const toEdge = Math.min(dx === 0 ? Infinity : halfW / Math.abs(dx), dy === 0 ? Infinity : halfH / Math.abs(dy)) * Math.hypot(dx, dy);
      if (Math.hypot(dx, dy) >= SECTOR_DEPTH * toEdge) reached.add(windOf(dx, dy));
    }
    const uncovered = WINDS.filter((w) => !reached.has(w));
    const allowed = input.kind === 'loop' ? LOOP_EMPTY_SECTORS : input.kind === 'touring' ? TOURING_EMPTY_SECTORS : LOOP_EMPTY_SECTORS;
    return { checked: true, basis: 'extent', covered: uncovered.length <= allowed, uncovered: uncovered.length <= allowed ? [] : [...uncovered], note: `${8 - uncovered.length} of 8 parts of the destination's extent reached.` };
  }

  // --- the stops of a linear route -----------------------------------------------------------
  const stops = input.stops ?? [];
  if (input.kind === 'linear' && stops.length >= 2) {
    const nearest = (target: { lat: number; lng: number }) => Math.min(...points.map((p) => haversineKm(p, target)));
    const uncovered: string[] = [];
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i]!;
      const span = Math.max(i > 0 ? haversineKm(stops[i - 1]!.center, stop.center) : 0, i < stops.length - 1 ? haversineKm(stop.center, stops[i + 1]!.center) : 0);
      if (nearest(stop.center) > Math.max(40, 0.15 * span)) uncovered.push(`near ${stop.label}`);
      if (i > 0) {
        const from = stops[i - 1]!;
        const length = haversineKm(from.center, stop.center);
        const middle = { lat: (from.center.lat + stop.center.lat) / 2, lng: (from.center.lng + stop.center.lng) / 2 };
        if (length > 120 && nearest(middle) > Math.max(50, 0.3 * length)) uncovered.push(`between ${from.label} and ${stop.label}`);
      }
    }
    return { checked: true, basis: 'stops', covered: uncovered.length === 0, uncovered, note: `${stops.length} stops checked; ${uncovered.length} stretch${uncovered.length === 1 ? '' : 'es'} with nothing placed.` };
  }
  if (input.kind === 'linear') return none('A route from one end to another with no resolved ends; nothing to compare with.');

  // --- the spread of what was placed ----------------------------------------------------------
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const project = projector(lat0);
  const xy = points.map(project);
  const mx = xy.reduce((s, p) => s + p.x, 0) / xy.length;
  const my = xy.reduce((s, p) => s + p.y, 0) / xy.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of xy) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  /* The principal axis of the places: the line they are strung along. */
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = xy.map((p) => (p.x - mx) * ux + (p.y - my) * uy);
  const across = xy.map((p) => -(p.x - mx) * uy + (p.y - my) * ux);
  const length = Math.max(...along) - Math.min(...along);
  const width = Math.max(...across) - Math.min(...across);
  if (input.kind === 'loop') {
    if (length < 60) return none(`The places span ${Math.round(length)} km; too small to read as a loop or not.`);
    const need = LOOP_MIN_WIDTH_SHARE * length;
    if (width >= need) return { checked: true, basis: 'spread', covered: true, uncovered: [], note: `The places span ${Math.round(length)} by ${Math.round(width)} km: they enclose ground.` };
    /* Both sides of the line that hold nothing far from it; the model knows which one the road takes. */
    const left = Math.max(0, ...across);
    const right = Math.max(0, ...across.map((a) => -a));
    const sides: string[] = [];
    if (left < need) sides.push(windOf(-uy, ux));
    if (right < need) sides.push(windOf(uy, -ux));
    return { checked: true, basis: 'spread', covered: false, uncovered: sides, note: `The places run ${Math.round(length)} km along one line (${windOf(ux, uy)}–${windOf(-ux, -uy)}) and only ${Math.round(width)} km across it: one side of a loop.` };
  }
  const spread = Math.hypot(length, width);
  if (spread < TOURING_MIN_SPREAD_SHARE * input.reachKm) {
    return { checked: true, basis: 'spread', covered: false, uncovered: ['beyond the area the places already cover'], note: `The places sit within ${Math.round(spread)} km of each other on a trip that can reach ${Math.round(input.reachKm)} km.` };
  }
  return { checked: true, basis: 'spread', covered: true, uncovered: [], note: `The places spread ${Math.round(spread)} km.` };
}
