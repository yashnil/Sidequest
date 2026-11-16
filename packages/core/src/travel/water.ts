/**
 * WATER BETWEEN TWO POINTS (audit pass, 2026-11).
 *
 * A leg no router measured is estimated from straight-line distance, and a
 * straight line does not know about the sea. "Drive to Mykines — ≈45 min,
 * estimated from map distance" was a plan for an island reached only by boat.
 * The router's silence is not evidence either way (V9.1: a routing silence is
 * never a verdict), so the geometry has to speak for itself.
 *
 * Two offline indexes (built by `packages/atlas/build/10-water.py`, loaded by
 * `@sidequest/atlas#loadWaterIndex`) answer two questions for a point: which
 * landmass it stands on (OpenStreetMap coastline land, ODbL, its own database)
 * and whether it is inside a large lake (HydroLAKES, CC BY 4.0). From those,
 * `assessCrossing` says what a *straight line* between two points crosses:
 *
 *   separate_land   the ends stand on different landmasses — no road joins
 *                   them without a bridge or a vehicle ferry, which only a
 *                   router that measured the pair can show
 *   water_between   same landmass, but most of the straight line is sea or
 *                   lake — the road, if there is one, goes around, and a
 *                   straight-line figure is not a journey
 *   land            the line is (mostly) over land; nothing changes
 *   unknown         an end could not be placed on land (far offshore, or no
 *                   index loaded) — unknown ≠ false, nothing changes
 *
 * This only ever *withdraws a straight-line estimate's claim*. A router's
 * measurement always outranks it (a bridge, a causeway and a car ferry are all
 * real roads to a router), and it never removes a stop: it changes what the
 * leg may say about how you get there. Pure: no I/O, no provider.
 */

export type CrossingVerdict = 'land' | 'separate_land' | 'water_between' | 'unknown';

export interface CrossingAssessment {
  verdict: CrossingVerdict;
  /** Share of the straight line over sea or lake, 0..1, when it was sampled. */
  waterShare: number | null;
  /** Whether the water on the line is mostly a lake (true), sea (false), or unknown/none (null). */
  lake: boolean | null;
}

interface LngLat {
  lat: number;
  lng: number;
}

const Q = 1e5;
const CORNER_EPS = 1e-6;
/** Land this large or larger wins a snap over a closer islet or sea stack. */
const SUBSTANTIAL_LAND_KM2 = 1;

interface Run {
  id: number;
  xs: Float64Array;
  ys: Float64Array;
}

interface CoastalCell {
  corner: number;
  runs: Run[];
}

/**
 * One decoded component index (land or lakes). Coastal cells are decoded
 * lazily, on first touch, and kept.
 */
export class ComponentIndex {
  private readonly sub: number;
  private readonly l1: Int32Array;
  private readonly subs: Int32Array;
  private readonly offsets: Uint32Array;
  private readonly payload: Uint8Array;
  private readonly areas: Float32Array;
  private readonly cache = new Map<number, CoastalCell>();

  constructor(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    if (magic !== 'SQWI') throw new Error('not a water index');
    const version = view.getUint16(4, true);
    if (version !== 1) throw new Error(`unsupported water index version ${version}`);
    this.sub = view.getUint16(6, true);
    let at = 8;
    this.l1 = copyInt32(bytes, at, 360 * 180);
    at += 360 * 180 * 4;
    const nSub = view.getUint32(at, true);
    at += 4;
    this.subs = copyInt32(bytes, at, nSub * this.sub * this.sub);
    at += nSub * this.sub * this.sub * 4;
    const nCoast = view.getUint32(at, true);
    at += 4;
    this.offsets = new Uint32Array(nCoast + 1);
    for (let i = 0; i <= nCoast; i += 1) this.offsets[i] = view.getUint32(at + i * 4, true);
    at += (nCoast + 1) * 4;
    const nIds = view.getUint32(at, true);
    at += 4;
    this.areas = new Float32Array(nIds);
    for (let i = 0; i < nIds; i += 1) this.areas[i] = view.getFloat32(at + i * 4, true);
    at += nIds * 4;
    this.payload = bytes.subarray(at);
  }

  /** Area in km² of a component, or 0 when unknown. */
  areaKm2(id: number): number {
    return this.areas[id] ?? 0;
  }

  private subCellRef(lng: number, lat: number): { kind: 'uniform'; id: number } | { kind: 'coastal'; index: number; cx: number; cy: number } {
    const x = Math.min(359.999999, Math.max(0, lng + 180));
    const y = Math.min(179.999999, Math.max(0, lat + 90));
    const i = Math.floor(x);
    const j = Math.floor(y);
    const top = this.l1[j * 360 + i]!;
    if (top >= 0) return { kind: 'uniform', id: top };
    const table = -top - 1;
    const a = Math.min(this.sub - 1, Math.floor((x - i) * this.sub));
    const b = Math.min(this.sub - 1, Math.floor((y - j) * this.sub));
    const v = this.subs[table * this.sub * this.sub + b * this.sub + a]!;
    if (v >= 0) return { kind: 'uniform', id: v };
    return { kind: 'coastal', index: -v - 1, cx: i * this.sub + a, cy: j * this.sub + b };
  }

  private cell(index: number, cx: number, cy: number): CoastalCell {
    const held = this.cache.get(index);
    if (held) return held;
    const p = this.payload;
    let at = this.offsets[index]!;
    const read = (): number => {
      let shift = 0;
      let out = 0;
      for (;;) {
        const b = p[at]!;
        at += 1;
        out += (b & 0x7f) * 2 ** shift;
        if (b < 0x80) return out;
        shift += 7;
      }
    };
    const unzig = (v: number): number => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);
    const corner = read();
    const nRuns = read();
    const ox = Math.round((cx / this.sub - 180) * Q);
    const oy = Math.round((cy / this.sub - 90) * Q);
    const runs: Run[] = [];
    for (let r = 0; r < nRuns; r += 1) {
      const id = read();
      const n = read();
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      let px = ox;
      let py = oy;
      for (let k = 0; k < n; k += 1) {
        px += unzig(read());
        py += unzig(read());
        xs[k] = px / Q;
        ys[k] = py / Q;
      }
      runs.push({ id, xs, ys });
    }
    const out = { corner, runs };
    this.cache.set(index, out);
    return out;
  }

  /** The component (1-based id) a point is inside, or 0 for none. */
  at(p: LngLat): number {
    const ref = this.subCellRef(p.lng, p.lat);
    if (ref.kind === 'uniform') return ref.id;
    const c = this.cell(ref.index, ref.cx, ref.cy);
    const sx = ref.cx / this.sub - 180 + CORNER_EPS;
    const sy = ref.cy / this.sub - 90 + CORNER_EPS;
    let current = c.corner;
    for (const run of c.runs) {
      for (let k = 0; k + 1 < run.xs.length; k += 1) {
        if (segmentsCross(sx, sy, p.lng, p.lat, run.xs[k]!, run.ys[k]!, run.xs[k + 1]!, run.ys[k + 1]!)) {
          current = current === run.id ? 0 : run.id;
        }
      }
    }
    return current;
  }

  /**
   * The nearest component within `maxKm` of a point that is not inside one
   * (a harbour pin a few metres offshore of a simplified coastline), or 0.
   */
  nearest(p: LngLat, maxKm: number): number {
    const inside = this.at(p);
    if (inside) return inside;
    const kmPerDegLat = 111.32;
    const kmPerDegLng = 111.32 * Math.max(0.05, Math.cos((p.lat * Math.PI) / 180));
    const spanCells = Math.max(1, Math.ceil((maxKm / kmPerDegLng) * this.sub));
    const spanCellsY = Math.max(1, Math.ceil((maxKm / kmPerDegLat) * this.sub));
    /* The closest approach of every component within reach. */
    const closest = new Map<number, number>();
    const offer = (id: number, km: number) => {
      if (km <= maxKm && km < (closest.get(id) ?? Number.POSITIVE_INFINITY)) closest.set(id, km);
    };
    const cx0 = Math.floor((p.lng + 180) * this.sub);
    const cy0 = Math.floor((p.lat + 90) * this.sub);
    for (let dy = -spanCellsY; dy <= spanCellsY; dy += 1) {
      for (let dx = -spanCells; dx <= spanCells; dx += 1) {
        const lng = (cx0 + dx + 0.5) / this.sub - 180;
        const lat = (cy0 + dy + 0.5) / this.sub - 90;
        if (lat <= -90 || lat >= 90) continue;
        const ref = this.subCellRef(((lng + 540) % 360) - 180, lat);
        if (ref.kind === 'uniform') {
          if (ref.id && (dx !== 0 || dy !== 0)) {
            /* A whole cell of land nearby: its nearest edge is at least the gap to the cell. */
            const gx = Math.max(0, Math.abs(dx) - 1) / this.sub;
            const gy = Math.max(0, Math.abs(dy) - 1) / this.sub;
            offer(ref.id, Math.hypot(gx * kmPerDegLng, gy * kmPerDegLat));
          }
          continue;
        }
        const c = this.cell(ref.index, ref.cx, ref.cy);
        for (const run of c.runs) {
          for (let k = 0; k + 1 < run.xs.length; k += 1) {
            offer(run.id, pointSegmentKm(p, run.xs[k]!, run.ys[k]!, run.xs[k + 1]!, run.ys[k + 1]!, kmPerDegLng, kmPerDegLat));
          }
        }
      }
    }
    /*
     * A pin in the water at the foot of a cliff is about the shore, not the sea
     * stack beside it: a substantial landmass within reach is preferred over a
     * closer islet (the live Faroe plan read a waterfall on its own island as a
     * crossing to a stack). Only where nothing substantial is near does the
     * closest islet stand.
     */
    let best = 0;
    let bestKm = Number.POSITIVE_INFINITY;
    let substantial = 0;
    let substantialKm = Number.POSITIVE_INFINITY;
    for (const [id, km] of closest) {
      if (km < bestKm) {
        bestKm = km;
        best = id;
      }
      if (this.areaKm2(id) >= SUBSTANTIAL_LAND_KM2 && km < substantialKm) {
        substantialKm = km;
        substantial = id;
      }
    }
    return substantial || best;
  }
}

function copyInt32(bytes: Uint8Array, at: number, n: number): Int32Array {
  const out = new Int32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, n * 4);
  for (let i = 0; i < n; i += 1) out[i] = view.getInt32(i * 4, true);
  return out;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Proper crossing of segment p1p2 with q1q2, half-open on q so a shared vertex counts once. */
function segmentsCross(p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number): boolean {
  const d1 = orient(p1x, p1y, p2x, p2y, q1x, q1y);
  const d2 = orient(p1x, p1y, p2x, p2y, q2x, q2y);
  if ((d1 > 0) === (d2 > 0)) return false;
  if (d1 === 0 && d2 === 0) return false;
  const d3 = orient(q1x, q1y, q2x, q2y, p1x, p1y);
  const d4 = orient(q1x, q1y, q2x, q2y, p2x, p2y);
  return (d3 > 0) !== (d4 > 0) && d3 !== 0 && d4 !== 0;
}

function pointSegmentKm(p: LngLat, ax: number, ay: number, bx: number, by: number, kx: number, ky: number): number {
  const px = (p.lng - ax) * kx;
  const py = (p.lat - ay) * ky;
  const vx = (bx - ax) * kx;
  const vy = (by - ay) * ky;
  const len = vx * vx + vy * vy;
  const t = len > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / len)) : 0;
  return Math.hypot(px - t * vx, py - t * vy);
}

export interface WaterIndex {
  land: ComponentIndex;
  lakes: ComponentIndex | null;
}

/** How far offshore a pin may sit and still count as on the nearest land (a harbour, a simplified coast). */
export const COAST_SNAP_KM = 1.5;
/**
 * A straight-line estimate whose line is mostly water on one landmass is raised
 * by this factor: the road goes around the bay, lake or estuary, and the
 * ordinary detour allowance assumes it goes roughly straight. Still labelled an
 * estimate; a router's figure always replaces it.
 */
export const WATER_DETOUR_FACTOR = 1.5;

export function aroundWaterMinutes(estimate: number): number {
  return Math.ceil((estimate * WATER_DETOUR_FACTOR) / 5) * 5;
}

/** Above this share of water on the straight line, a straight-line road figure is not a journey. */
export const WATER_SHARE_LIMIT = 0.5;
/** Shorter lines are not judged: a pier, a bay crossing on foot, a coastline's noise. */
const MIN_JUDGED_KM = 2;

function haversineKm(a: LngLat, b: LngLat): number {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * What the straight line from `a` to `b` crosses. See the header: this is a
 * statement about geometry, never about whether a road (bridge, causeway,
 * vehicle ferry) exists — only a router's measurement can say that.
 */
export function assessCrossing(index: WaterIndex | null, a: LngLat, b: LngLat): CrossingAssessment {
  if (!index) return { verdict: 'unknown', waterShare: null, lake: null };
  const km = haversineKm(a, b);
  if (!(km >= MIN_JUDGED_KM)) return { verdict: 'land', waterShare: null, lake: null };
  const la = index.land.nearest(a, COAST_SNAP_KM);
  const lb = index.land.nearest(b, COAST_SNAP_KM);
  if (!la || !lb) return { verdict: 'unknown', waterShare: null, lake: null };
  const samples = Math.min(400, Math.max(8, Math.ceil(km / 0.25)));
  let sea = 0;
  let lake = 0;
  for (let s = 1; s < samples; s += 1) {
    const t = s / samples;
    const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    if (!index.land.at(p)) sea += 1;
    else if (index.lakes && index.lakes.at(p)) lake += 1;
  }
  const waterShare = (sea + lake) / (samples - 1);
  const lakeMostly = sea + lake > 0 ? lake > sea : null;
  if (la !== lb) return { verdict: 'separate_land', waterShare, lake: lakeMostly };
  if (waterShare >= WATER_SHARE_LIMIT) return { verdict: 'water_between', waterShare, lake: lakeMostly };
  return { verdict: 'land', waterShare, lake: lakeMostly };
}

/** True when a straight-line estimate may stand for a road or foot journey between the two points. */
export function straightLineMayStandForLand(index: WaterIndex | null, a: LngLat, b: LngLat): boolean {
  const v = assessCrossing(index, a, b).verdict;
  return v === 'land' || v === 'unknown';
}
