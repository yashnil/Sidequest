import type { RoutingProvider, ProviderGapReason } from '@sidequest/compiler';
import { boundTravelMatrix, estimatedScanMatrix, haversineKm, routePairKey, type RouteFeasibility, type ScanPoint, type TravelTimeMatrixData } from '@sidequest/core';

/**
 * EVAL V3 — MEASURE THE PAIRS THAT DECIDE GEOGRAPHY, THEN BOUND THE REST.
 *
 * The scan used to ask the router for every pair at once. Valhalla subdivides
 * that itself; openrouteservice's matrix seam times only the consecutive pairs
 * of the points it is handed, so a live scan of ~40 points measured ~64 of
 * ~1,700 pairs and every other figure — every base-to-place reach, every
 * stop-to-stop hop — was a straight line with a road factor. A trailhead and a
 * lookout either side of a sea cliff were then 20 minutes apart.
 *
 * So the scan now asks in small requests, each a set of bases plus the places
 * nearest them, sized so that every pair of the set fits one provider request
 * (`SCAN_MATRIX_MAX_ELEMENTS`). Every base → place row (and its reverse) is
 * measured first, because those rows bound every stop-to-stop pair from below
 * (`@sidequest/core` `boundTravelMatrix`); neighbouring places share a request,
 * so the hops a day actually makes are usually measured outright.
 *
 * Unknown ≠ false throughout: a declined cell, a timeout or an error leaves the
 * estimate in place, labelled. Only a direct route request that evaluated both
 * resolved endpoints and answered "no route" (`route()` → `not_found`, the
 * `AUTHORITATIVE_NO_ROUTE` rule) marks a pair `disconnected`; a matrix cell
 * never does, because Valhalla's `costmatrix` declines pairs `/route` solves.
 */

/**
 * Pairs one matrix request may hold: Valhalla's documented per-request batch
 * (`providers/valhalla.ts#MAX_MATRIX_PAIRS_PER_REQUEST`) and the hosted
 * openrouteservice plan's routed-pair allowance as this adapter bounds it
 * (`providers/openrouteservice.ts#ORS_MATRIX_MAX_PAIRS`) are both 400; a test
 * keeps the three in step. Twenty points a request, every pair of them.
 */
export const SCAN_MATRIX_MAX_ELEMENTS = 400;
const MAX_POINTS_PER_REQUEST = Math.floor(Math.sqrt(SCAN_MATRIX_MAX_ELEMENTS));
/** At most this many bases share one request, so a request always has room for places. */
const MAX_BASES_PER_REQUEST = 10;
/** A scan never sends more matrix requests than this; the rest stay estimated and bounded, and the count says so. */
export const MAX_SCAN_MATRIX_REQUESTS = 24;
/** Direct requests a scan may spend asking whether an unmeasured base → place pair has a road at all. */
export const MAX_SCAN_ROUTE_CONFIRMATIONS = 6;
/** Extra direct requests for places no matrix cell reached at all, each asked once from its nearest base. */
export const MAX_DARK_COLUMN_CONFIRMATIONS = 6;

export interface ScanMatrixRequest {
  /** Indices into the scan's points. */
  points: number[];
}

/**
 * The requests that measure every base → place pair within the provider's
 * per-request limit: bases in groups of at most ten, places grouped by their
 * nearest base and ordered outward from it, so places that share a request are
 * neighbours.
 */
export function planScanMatrixRequests(points: readonly Pick<ScanPoint, 'kind' | 'coordinates'>[]): ScanMatrixRequest[] {
  const bases = points.map((p, i) => ({ p, i })).filter((x) => x.p.kind === 'base');
  const places = points.map((p, i) => ({ p, i })).filter((x) => x.p.kind !== 'base');
  if (points.length < 2) return [];
  if (bases.length === 0) {
    const requests: ScanMatrixRequest[] = [];
    for (let s = 0; s < places.length; s += MAX_POINTS_PER_REQUEST) requests.push({ points: places.slice(s, s + MAX_POINTS_PER_REQUEST).map((x) => x.i) });
    return requests.filter((r) => r.points.length >= 2);
  }
  const ordered = places
    .map((x) => {
      let nearest = 0;
      let best = Number.POSITIVE_INFINITY;
      bases.forEach((b, bi) => {
        const km = haversineKm(b.p.coordinates, x.p.coordinates);
        if (km < best) {
          best = km;
          nearest = bi;
        }
      });
      return { ...x, nearest, km: best };
    })
    .sort((a, b) => a.nearest - b.nearest || a.km - b.km);
  const baseGroups: number[][] = [];
  for (let s = 0; s < bases.length; s += MAX_BASES_PER_REQUEST) baseGroups.push(bases.slice(s, s + MAX_BASES_PER_REQUEST).map((b) => b.i));
  const requests: ScanMatrixRequest[] = [];
  for (const group of baseGroups) {
    const room = MAX_POINTS_PER_REQUEST - group.length;
    if (ordered.length === 0) {
      if (group.length >= 2) requests.push({ points: [...group] });
      continue;
    }
    for (let s = 0; s < ordered.length; s += room) requests.push({ points: [...group, ...ordered.slice(s, s + room).map((x) => x.i)] });
  }
  return requests;
}

/** A gap reason that says the router could not be asked or could not answer, rather than that it looked and declined. */
function providerGap(reason: ProviderGapReason): boolean {
  return reason !== 'insufficient_evidence' && reason !== 'not_found';
}

export interface ScanMatrixOutcome {
  matrix: TravelTimeMatrixData;
  source: string;
  measuredPairs: number;
  totalPairs: number;
  /** Base → place and place → base pairs, and how many of them a router measured. */
  baseRows: { measured: number; total: number };
  requests: { planned: number; sent: number; failed: number; skipped: number };
  confirmations: { asked: number; found: number; noRoute: number };
  counts: Record<RouteFeasibility, number>;
}

/**
 * Measures the scan's matrix within the provider's limits and returns it with
 * every unmeasured cell bounded and labelled. Never throws: a router that fails
 * leaves the estimate, labelled `provider_unavailable`.
 */
export async function measureScanMatrix(input: { points: readonly ScanPoint[]; mode: 'car' | 'foot'; routing: RoutingProvider | null; deadline: () => boolean }): Promise<ScanMatrixOutcome> {
  const { points, mode, routing, deadline } = input;
  const n = points.length;
  const totalPairs = n * Math.max(0, n - 1);
  const estimate = estimatedScanMatrix(points, mode, routing ? 'plausible_unverified' : 'provider_unavailable');
  const isBase = points.map((p) => p.kind === 'base');
  const baseRowTotal = points.reduce((sum, _, i) => sum + points.reduce((s, __, j) => s + (i !== j && isBase[i] !== isBase[j] ? 1 : 0), 0), 0);
  const requests = routing && n >= 2 ? planScanMatrixRequests(points) : [];
  const minutes = estimate.minutes.map((row) => [...row]);
  const km = estimate.km.map((row) => [...row]);
  const measured = points.map(() => points.map(() => false));
  const gap = points.map(() => points.map((): 'provider_unavailable' | 'plausible_unverified' => (routing ? 'plausible_unverified' : 'provider_unavailable')));
  const disconnected = new Set<string>();
  let sent = 0;
  let failed = 0;
  const take = (i: number, j: number, m: number, k: number | undefined) => {
    minutes[i]![j] = Math.max(1, Math.round(m));
    if (typeof k === 'number' && Number.isFinite(k)) km[i]![j] = Math.round(k * 10) / 10;
    measured[i]![j] = true;
  };

  for (const request of requests.slice(0, MAX_SCAN_MATRIX_REQUESTS)) {
    if (deadline()) break;
    const subset = request.points.map((i) => points[i]!);
    sent += 1;
    try {
      const result = await routing!.matrix({ points: subset.map((p) => ({ id: p.id, lat: p.coordinates.lat, lng: p.coordinates.lng })), mode, maxElements: subset.length * subset.length });
      const at = new Map(result.ids.map((id, x) => [id, x] as const));
      const reasons = new Map((result.failedPairs ?? []).map((f) => [routePairKey(f.from, f.to), f.reason] as const));
      for (const i of request.points) {
        for (const j of request.points) {
          if (i === j || measured[i]![j]) continue;
          const a = at.get(points[i]!.id);
          const b = at.get(points[j]!.id);
          const m = a !== undefined && b !== undefined ? result.minutes[a]?.[b] : undefined;
          if (result.provenance.kind === 'measured' && typeof m === 'number' && Number.isFinite(m) && m > 0) take(i, j, m, a !== undefined && b !== undefined ? result.km[a]?.[b] : undefined);
          else {
            const reason = reasons.get(routePairKey(points[i]!.id, points[j]!.id));
            gap[i]![j] = result.provenance.kind !== 'measured' || (reason !== undefined && providerGap(reason)) ? 'provider_unavailable' : 'plausible_unverified';
          }
        }
      }
    } catch (error) {
      failed += 1;
      for (const i of request.points) for (const j of request.points) if (i !== j && !measured[i]![j]) gap[i]![j] = 'provider_unavailable';
      console.warn('Scan matrix: a request went unanswered; those pairs stay estimated', error instanceof Error ? error.message : error);
    }
  }

  /*
   * A base → place pair still unmeasured after its request is asked directly,
   * a few at most: a direct route either times it (verified) or, having
   * evaluated both ends, says there is no road (disconnected). Anything else —
   * a timeout, an error, a refusal to trust the figure — leaves it as it was.
   */
  let asked = 0;
  let found = 0;
  let noRoute = 0;
  if (routing?.route) {
    const unmeasured: [number, number][] = [];
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (isBase[i] && !isBase[j] && !measured[i]![j] && !measured[j]![i]) unmeasured.push([i, j]);
    /*
     * A place the matrix could not reach at all (its whole column unmeasured —
     * usually a point the router would not snap to a road) leaves every leg into
     * it a straight-line guess with no measured pivot to bound it; across water
     * that is a 50-minute "drive" that takes two hours. One measured cell from
     * its nearest base bounds them all, so those are asked first.
     */
    const dark = points.map((_, j) => !isBase[j] && points.every((__, i) => i === j || (!measured[i]![j] && !measured[j]![i])));
    const nearestBase = (j: number) => points.map((p, i) => ({ i, km: isBase[i] ? haversineKm(p.coordinates, points[j]!.coordinates) : Infinity })).sort((a, b) => a.km - b.km)[0]!.i;
    const first: [number, number][] = points.flatMap((_, j) => (dark[j] && isBase.some(Boolean) ? [[nearestBase(j), j] as [number, number]] : []));
    const firstKeys = new Set(first.map(([i, j]) => `${i}:${j}`));
    const ordered = [...first, ...unmeasured.filter(([i, j]) => !firstKeys.has(`${i}:${j}`))];
    for (const [i, j] of ordered.slice(0, MAX_SCAN_ROUTE_CONFIRMATIONS + Math.min(first.length, MAX_DARK_COLUMN_CONFIRMATIONS))) {
      if (deadline()) break;
      asked += 1;
      try {
        const answer = await routing.route({ from: points[i]!.coordinates, to: points[j]!.coordinates, mode });
        if (answer.found && answer.minutes !== null && answer.minutes > 0) {
          found += 1;
          take(i, j, answer.minutes, answer.km ?? undefined);
          take(j, i, answer.minutes, answer.km ?? undefined);
        } else if (!answer.found && answer.reason === 'not_found') {
          noRoute += 1;
          disconnected.add(routePairKey(points[i]!.id, points[j]!.id));
          disconnected.add(routePairKey(points[j]!.id, points[i]!.id));
        } else if (answer.reason && providerGap(answer.reason)) {
          gap[i]![j] = 'provider_unavailable';
          gap[j]![i] = 'provider_unavailable';
        }
      } catch {
        gap[i]![j] = 'provider_unavailable';
        gap[j]![i] = 'provider_unavailable';
      }
    }
  }

  let measuredPairs = 0;
  let baseRowsMeasured = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j || !measured[i]![j]) continue;
      measuredPairs += 1;
      if (isBase[i] !== isBase[j]) baseRowsMeasured += 1;
    }
  }
  const all = measuredPairs === totalPairs && totalPairs > 0;
  const prior: RouteFeasibility[][] = points.map((_, i) => points.map((__, j) => (i === j || measured[i]![j] ? 'verified' : gap[i]![j]!)));
  const raw: TravelTimeMatrixData = {
    mode,
    ids: estimate.ids,
    minutes,
    km,
    provenance: all
      ? { kind: 'measured', note: `Measured by ${routing!.name}.`, source: routing!.name }
      : measuredPairs > 0
        ? { kind: 'estimated', note: `${measuredPairs} of ${totalPairs} journeys measured by ${routing!.name} (${baseRowsMeasured} of ${baseRowTotal} between a base and a place); the rest estimated from distance and raised to what the measured legs prove.`, source: routing!.name }
        : estimate.provenance,
    feasibility: prior,
  };
  const bounded = boundTravelMatrix({ matrix: raw, disconnected });
  return {
    matrix: bounded.matrix,
    source: measuredPairs > 0 ? routing!.name : 'distance estimates',
    measuredPairs,
    totalPairs,
    baseRows: { measured: baseRowsMeasured, total: baseRowTotal },
    requests: { planned: requests.length, sent, failed, skipped: Math.max(0, requests.length - sent) },
    confirmations: { asked, found, noRoute },
    counts: bounded.counts,
  };
}

/** The outcome when no router is asked at all (fixture scans, a timed-out stage): every pair an estimate, labelled. */
export function estimatedScanOutcome(points: readonly ScanPoint[], mode: 'car' | 'foot'): ScanMatrixOutcome {
  const n = points.length;
  const isBase = points.map((p) => p.kind === 'base');
  const baseRowTotal = points.reduce((sum, _, i) => sum + points.reduce((s, __, j) => s + (i !== j && isBase[i] !== isBase[j] ? 1 : 0), 0), 0);
  const bounded = boundTravelMatrix({ matrix: estimatedScanMatrix(points, mode) });
  return {
    matrix: bounded.matrix,
    source: 'distance estimates',
    measuredPairs: 0,
    totalPairs: n * Math.max(0, n - 1),
    baseRows: { measured: 0, total: baseRowTotal },
    requests: { planned: 0, sent: 0, failed: 0, skipped: 0 },
    confirmations: { asked: 0, found: 0, noRoute: 0 },
    counts: bounded.counts,
  };
}
