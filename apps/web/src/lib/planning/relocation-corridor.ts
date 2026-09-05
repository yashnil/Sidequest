/**
 * DETERMINISTIC RELOCATION-CORRIDOR REMEDIATION.
 *
 * `assessRelocationFeasibility()`'s own bounded remedy (`skeleton-adapter.ts`)
 * already tries one thing when a relocation exceeds the traveller's hard
 * ceiling: a verified intermediate base already on the Discovery Board. The
 * live Iceland run exposed the gap in that alone — the board's own base
 * candidates come from `buildDiscoveryBoard()`'s attraction-scoring pass over
 * the compiled region's `places`, and an ordinary settlement with nothing to
 * *do* never clears that bar. Iceland's compiled region held zero places
 * tagged `relationship: 'base'` at all (confirmed by direct inspection, not
 * assumed) — an ingestion-time gap this module does not attempt to fix, only
 * to route around: an overnight locality is not the same claim as an
 * attraction candidate, so it does not need to survive the same filter.
 *
 * This module answers one narrow question with real, deterministic evidence:
 * given a relocation that is too long, is there a real, named settlement
 * roughly along the way whose two split legs both fit inside the ceiling?
 * Nothing here invents a name, a coordinate, a travel time, or a popularity
 * score — every candidate is a real, bounded-search answer, every leg is a
 * real measured or confirmed route.
 *
 * **Why a bounded area search, not a single exact-point lookup.** The first
 * version of this module asked one exact reverse-geocode question per sample
 * point — "what is at this precise coordinate" — and the live Iceland run
 * exposed the weakness directly: the Höfn→Akureyri corridor's sample points
 * landed inside `Þingeyjarsveit`/`Múlaþing`, real Icelandic municipalities
 * that are administrative regions, not settlements, even though real towns
 * plausibly exist a short distance away from those exact coordinates. A point
 * missing the town it is a few kilometres from is not evidence no town
 * exists nearby — it is evidence that one exact coordinate is a narrow way to
 * ask "what real settlement is near here". This module now asks a bounded
 * *area* question at each sample point instead — see `findNearbyLocalities`.
 *
 * **Why sampling now follows real route geometry, not the straight chord.**
 * A bounded area search around a *badly placed* sample point still finds
 * nothing. Offline analysis of the same real Iceland evidence exposed the
 * deeper cause: the sample points themselves were interpolated along the
 * great-circle *chord* between the two bases, and Höfn→Akureyri's real
 * drivable road curves substantially — along the coast, around genuinely
 * uninhabited central highlands the chord cuts straight through. The
 * recorded chord-sampled points ended up 40–110 km from the nearest real
 * settlement, far outside any reasonably bounded search radius. Given real
 * route geometry (`routeGeometry`, an ordered polyline from `from` to `to`),
 * this module now samples *along the route itself* (`pointAlongRoute`) —
 * still using the exact same time-fraction bias (`ceilingMinutes /
 * directMinutes`) `defaultSplitFractions` already computed, just walked
 * along the real path's cumulative distance instead of the chord's.
 * `routeGeometry` is optional and this module never fabricates it: absent
 * (no capability configured, or a genuine provider failure upstream), every
 * sample falls back to the exact prior straight-chord behaviour — a real,
 * honest degradation, not a silent one. `CorridorCandidate.foundVia` records
 * plainly which sampling method actually produced each accepted candidate.
 */

/** A bare coordinate — the one thing every caller of this module already has for a resolved base. */
export interface CorridorPoint {
  lat: number;
  lng: number;
}

/** A real settlement a reverse geocoder returned — never invented. */
export interface CorridorLocality {
  sourceId: string;
  name: string;
  lat: number;
  lng: number;
  entityType?: string;
}

/**
 * The one seam this module uses to ask "what real settlements are near
 * here" — never constructed here. Production wiring
 * (`productionFindNearbyLocalities` in `skeleton-orchestrator.ts`) prefers a
 * bounded Overpass `place=city/town/village/hamlet` search over the given
 * radius, falling back to Nominatim's exact-point `/reverse` only when the
 * map-data provider is unavailable; a test supplies a fixture directly. An
 * empty array means nothing real was found within `radiusKm` of that point —
 * a real, honest answer, not an error.
 */
export type CorridorLocalitySearch = (
  point: CorridorPoint,
  radiusKm: number,
) => Promise<readonly CorridorLocality[]>;

/** The same shape `SkeletonRouteConfirmationProvider` already returns — this module asks it directly for a candidate's two fresh legs, never through the ledger/memo machinery a *known* base pair uses. */
export type CorridorRouteConfirmer = (
  from: CorridorPoint,
  to: CorridorPoint,
) => Promise<{ found: boolean; minutes: number | null; km: number | null } | null>;

export interface CorridorCandidate {
  locality: CorridorLocality;
  legOneMinutes: number;
  legTwoMinutes: number;
  /** How much longer the two-leg path is than the direct one — 1.0 is no detour at all. Measured against the real route's own cumulative length when `routeGeometry` was available, the straight chord otherwise — see `findCorridorRemedyCandidates`'s own header. */
  detourRatio: number;
  /** Which sampling method actually found this candidate — a typed, honest record, never inferred after the fact: `'route_geometry'` only when a real polyline was used, `'straight_line'` when this module fell back to the chord. */
  foundVia: 'route_geometry' | 'straight_line';
}

export interface FindCorridorRemedyInput {
  from: CorridorPoint;
  to: CorridorPoint;
  ceilingMinutes: number;
  findNearbyLocalities: CorridorLocalitySearch;
  confirmRoute: CorridorRouteConfirmer;
  /**
   * The direct leg's own measured/confirmed minutes, when known — used to
   * bias sampling toward the split position that would actually bring both
   * halves under the ceiling, rather than blindly guessing a midpoint. Optional:
   * omitted, this module falls back to sampling near the geometric midpoint.
   */
  directMinutes?: number | null;
  /** A real settlement more than this many times the direct distance away, via the candidate, is a detour, not a waypoint — same 1.5x discipline `assessRelocationFeasibility`'s own board-tier remedy already uses. */
  maxDetourRatio?: number;
  /** Localities to skip outright (typically the two endpoints themselves), by source id. */
  excludeSourceIds?: ReadonlySet<string>;
  /** Real settlement vs. attraction/business/unclassified point — reuses `skeleton-adapter.ts`'s own `isLocalityCandidate` rule, injected so this module never forks that classification. */
  isLocalityCandidate: (locality: CorridorLocality) => boolean;
  /** Bounded, deterministic sample positions along the corridor, as fractions from `from` (0) to `to` (1). Overrides the biased-default sampling below when supplied — mainly for tests that want an exact, reviewable sample set. */
  splitFractions?: readonly number[];
  /** How far around each sample point to search for a real settlement — conservative and generic, not tuned to any one country. */
  searchRadiusKm?: number;
  /**
   * The real drivable route's own shape, ordered `from` → `to`, when known
   * — see this file's own header on why sampling prefers this over the
   * straight chord. Optional: fewer than 2 points (absent, empty, or a
   * single point) is treated identically to "not available", and every
   * sample falls back to `pointAlongGreatCircle`, exactly this module's
   * pre-existing behaviour. Never fabricated by this module — the caller
   * supplies real geometry or nothing at all.
   */
  routeGeometry?: readonly CorridorPoint[] | null;
}

const EARTH_RADIUS_KM = 6371.0088;
const DEFAULT_MAX_DETOUR_RATIO = 1.5;
/** Never search more positions than this in one remedy attempt — "keep search bounded", not exhaustive. */
const MAX_SAMPLE_POINTS = 4;
/**
 * How far around a sample point counts as "near the corridor here" —
 * conservative and generic. Wide enough that a real town whose exact centre
 * is off the interpolated route line still turns up (this is exactly what a
 * single exact-point reverse-geocode could not do), narrow enough that a
 * bounded area search stays a small, cheap query rather than a regional
 * sweep.
 */
const DEFAULT_SEARCH_RADIUS_KM = 20;
/** At most this many localities kept from one sample point's search — a busy area near one point should not crowd out the other samples. */
const MAX_CANDIDATES_PER_SAMPLE_POINT = 3;
/** At most this many distinct real settlements are ever routed against, across every sample point combined — bounds the number of route confirmations this remedy attempt can cost. */
const MAX_TOTAL_CANDIDATES = 6;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Straight-line (haversine) distance in km — the same formula `skeleton-adapter.ts`'s own `haversineKm` uses, kept local so this module has no import edge into that file. */
export function corridorDistanceKm(a: CorridorPoint, b: CorridorPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The point at `fraction` of the great-circle path from `from` (0) to `to`
 * (1) — spherical interpolation, not a flat-map straight line, so a long
 * corridor samples a point that is actually on the route's own geometry
 * rather than cutting through the globe. `from`/`to` themselves for a
 * degenerate (near-zero-distance) pair, since there is no meaningful
 * corridor to interpolate along.
 */
export function pointAlongGreatCircle(from: CorridorPoint, to: CorridorPoint, fraction: number): CorridorPoint {
  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);
  const lat2 = toRad(to.lat);
  const lng2 = toRad(to.lng);

  const sinLat = Math.sin((lat2 - lat1) / 2);
  const sinLng = Math.sin((lng2 - lng1) / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const angularDistance = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  if (angularDistance < 1e-10) return { ...from };

  const a = Math.sin((1 - fraction) * angularDistance) / Math.sin(angularDistance);
  const b = Math.sin(fraction * angularDistance) / Math.sin(angularDistance);
  const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
  const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lng = Math.atan2(y, x);
  return { lat: toDeg(lat), lng: toDeg(lng) };
}

/**
 * The real route's own cumulative length, in km — summed leg by leg between
 * consecutive polyline vertices. This, not the straight chord, is the
 * correct baseline once real geometry is known: a route that genuinely
 * curves is not a "detour" from itself, and comparing a candidate's via-
 * distance against the much shorter chord would reject a real, on-route
 * settlement purely because the road bends, exactly the failure mode a
 * curved real-world route like Höfn→Akureyri exposes.
 */
export function routeLengthKm(geometry: readonly CorridorPoint[]): number {
  let total = 0;
  for (let i = 0; i < geometry.length - 1; i += 1) {
    total += corridorDistanceKm(geometry[i]!, geometry[i + 1]!);
  }
  return total;
}

/**
 * The point at `fraction` of the real route's own cumulative distance along
 * its polyline, `from` (0) to `to` (1) — linear interpolation between the
 * two polyline vertices bracketing that distance. Vertices are typically
 * close together (a real routing engine's shape resolution), so this is a
 * fine approximation without needing spherical interpolation segment by
 * segment. Degenerate geometry (fewer than 2 points, or a zero-length
 * route) returns the first point; a caller should not invoke this at all
 * unless it already checked for at least 2 points — see
 * `findCorridorRemedyCandidates`'s own `usableGeometry` gate.
 */
export function pointAlongRoute(geometry: readonly CorridorPoint[], fraction: number): CorridorPoint {
  if (geometry.length === 0) return { lat: Number.NaN, lng: Number.NaN };
  if (geometry.length === 1) return { ...geometry[0]! };
  const clamped = Math.min(1, Math.max(0, fraction));
  const total = routeLengthKm(geometry);
  if (total <= 0) return { ...geometry[0]! };

  const target = clamped * total;
  let travelled = 0;
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const a = geometry[i]!;
    const b = geometry[i + 1]!;
    const segmentKm = corridorDistanceKm(a, b);
    if (travelled + segmentKm >= target || i === geometry.length - 2) {
      const remaining = target - travelled;
      const segmentFraction = segmentKm > 0 ? Math.min(1, remaining / segmentKm) : 0;
      return {
        lat: a.lat + (b.lat - a.lat) * segmentFraction,
        lng: a.lng + (b.lng - a.lng) * segmentFraction,
      };
    }
    travelled += segmentKm;
  }
  return { ...geometry[geometry.length - 1]! };
}

/**
 * Bounded, deterministic split positions — biased toward where a split
 * would actually help, not a blind midpoint. When the direct leg's own
 * minutes are known, the position that would land leg one right at the
 * ceiling (`ceilingMinutes / directMinutes`) is a real, principled "useful
 * split position" — item 5's own phrase — plus its mirror from the
 * destination side, plus the geometric midpoint for robustness when the
 * corridor is not time-symmetric. Clamped well inside (0, 1) so a sample
 * is never placed on top of either endpoint.
 */
function defaultSplitFractions(ceilingMinutes: number, directMinutes: number | null | undefined): readonly number[] {
  const clamp = (f: number) => Math.min(0.85, Math.max(0.15, f));
  if (!directMinutes || directMinutes <= 0) return [0.4, 0.5, 0.6];
  const fromCeiling = clamp(ceilingMinutes / directMinutes);
  const mirrored = clamp(1 - fromCeiling);
  const fractions = [fromCeiling, mirrored, 0.5];
  // Dedupe near-identical fractions (e.g. a near-symmetric route) without losing the bias.
  const unique: number[] = [];
  for (const f of fractions) {
    if (!unique.some((u) => Math.abs(u - f) < 0.03)) unique.push(f);
  }
  return unique.slice(0, MAX_SAMPLE_POINTS);
}

/**
 * THE ONE BOUNDED CORRIDOR SEARCH.
 *
 * Samples a small, deterministic set of points along the great-circle path
 * between the two endpoints and, at each one, searches a bounded area
 * (`searchRadiusKm`) for real settlements — not just whatever exact
 * coordinate the sample happens to land on, since a real town's own centre
 * can sit some distance from an interpolated route point. Measures both
 * split legs for every distinct real locality found across every sample,
 * and returns every candidate that is genuinely feasible (both legs within
 * the ceiling) and not a wild detour — sorted best first (shortest combined
 * travel, then least detour). An empty result is a real, honest "nothing
 * found here", not a search failure.
 */
export async function findCorridorRemedyCandidates(input: FindCorridorRemedyInput): Promise<readonly CorridorCandidate[]> {
  const maxDetourRatio = input.maxDetourRatio ?? DEFAULT_MAX_DETOUR_RATIO;
  const searchRadiusKm = input.searchRadiusKm ?? DEFAULT_SEARCH_RADIUS_KM;
  const fractions = (input.splitFractions ?? defaultSplitFractions(input.ceilingMinutes, input.directMinutes)).slice(
    0,
    MAX_SAMPLE_POINTS,
  );
  // Route geometry chooses *where* to search; it never substitutes for a
  // real measurement — every candidate below still needs a real
  // `confirmRoute` answer for both split legs regardless of which sampling
  // method found it.
  const usableGeometry = input.routeGeometry && input.routeGeometry.length >= 2 ? input.routeGeometry : null;
  const samplingMethod: 'route_geometry' | 'straight_line' = usableGeometry ? 'route_geometry' : 'straight_line';
  // The detour baseline: the real route's own length when known (a curving
  // real road is not a detour from itself), the straight chord otherwise —
  // exactly the pre-existing behaviour when no geometry is supplied.
  const directKm = usableGeometry ? routeLengthKm(usableGeometry) : corridorDistanceKm(input.from, input.to);
  const excluded = input.excludeSourceIds ?? new Set<string>();

  const seen = new Set<string>();
  const localities: CorridorLocality[] = [];
  pointLoop: for (const fraction of fractions) {
    const point = usableGeometry
      ? pointAlongRoute(usableGeometry, fraction)
      : pointAlongGreatCircle(input.from, input.to, fraction);
    const found = await input.findNearbyLocalities(point, searchRadiusKm);
    for (const locality of found.slice(0, MAX_CANDIDATES_PER_SAMPLE_POINT)) {
      if (excluded.has(locality.sourceId) || seen.has(locality.sourceId)) continue;
      if (!input.isLocalityCandidate(locality)) continue;
      // A safety bound independent of whatever the search capability itself
      // already enforces — a locality this module accepts must genuinely be
      // near the point it was searched for, not merely somewhere the search
      // happened to return.
      if (corridorDistanceKm(point, locality) > searchRadiusKm) continue;
      seen.add(locality.sourceId);
      localities.push(locality);
      if (localities.length >= MAX_TOTAL_CANDIDATES) break pointLoop;
    }
  }

  const candidates: CorridorCandidate[] = [];
  for (const locality of localities) {
    const legOne = await input.confirmRoute(input.from, locality);
    const legTwo = await input.confirmRoute(locality, input.to);
    if (!legOne?.found || legOne.minutes === null) continue;
    if (!legTwo?.found || legTwo.minutes === null) continue;
    if (legOne.minutes > input.ceilingMinutes || legTwo.minutes > input.ceilingMinutes) continue;

    const viaKm = corridorDistanceKm(input.from, locality) + corridorDistanceKm(locality, input.to);
    const detourRatio = directKm > 0 ? viaKm / directKm : 1;
    if (directKm > 0 && detourRatio > maxDetourRatio) continue;

    candidates.push({ locality, legOneMinutes: legOne.minutes, legTwoMinutes: legTwo.minutes, detourRatio, foundVia: samplingMethod });
  }

  return candidates.sort((a, b) => {
    const totalDiff = a.legOneMinutes + a.legTwoMinutes - (b.legOneMinutes + b.legTwoMinutes);
    if (totalDiff !== 0) return totalDiff;
    return a.detourRatio - b.detourRatio;
  });
}
