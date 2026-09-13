import 'server-only';
import { z } from 'zod';
import type { RoutingProvider, RouteConfirmationResult, RoutingMatrixResult, ProviderGapReason } from '@sidequest/compiler';
import { USER_AGENT } from './nominatim';
import { requestSignal } from '../net/generation-deadline';

/**
 * OPENROUTESERVICE — THE OPTIONAL GLOBAL ROAD ROUTER.
 *
 * Local Valhalla stays the backbone, but its tiles cover what somebody built
 * (Iceland, here). A product that plans anywhere needs a durable global
 * fallback, and openrouteservice (HeiGIT, OpenStreetMap data) is that: drive,
 * walk and cycling, direct legs with distance, duration and geometry.
 *
 * Hosted base: `https://api.heigit.org/openrouteservice/v2/…`. The older
 * `api.openrouteservice.org` host was deprecated on 2026-04-28 and is not used.
 * Auth is the plain `Authorization: <api key>` header the service documents.
 *
 * ## V10 §6 — one request for the whole day, and a cache behind it
 *
 * Until V10 the `matrix()` seam timed consecutive pairs **one direct request at a
 * time**. That is correct and it does not finish: a Canadian Rockies trip needs
 * ~38 legs, each request has a 12-second ceiling, and the verification remainder
 * is a fraction of a minute — which is how a self-drive trip shipped with 0 of 38
 * legs measured while a perfectly healthy router sat behind it.
 *
 * So the seam now asks openrouteservice's own `/matrix/{profile}` endpoint for
 * the pairs a day actually drives, in **one** request (`metrics=duration,distance`,
 * `sources`/`destinations` bounded well inside the hosted plan's routed-pair
 * allowance), and falls back to the direct endpoint only for what the matrix
 * declined. Answers are cached for the `static_route` TTL against rounded
 * coordinates, so a rebuild of the same trip measures nothing twice.
 *
 * **A declined matrix cell is an absence, never a verdict** (V9.1's
 * `.claude-private/V9.1-ROUTING-CONTRADICTION.md`): Valhalla's `costmatrix`
 * returns a null time for pairs its own `/route` solves, and reading that as
 * positive evidence removed a 56-minute drive from a real trip as unreachable.
 * ORS behaves the same way, so a `null` here is `insufficient_evidence` and the
 * direct endpoint is asked instead. Only the direct endpoint's documented 2009
 * ever means "no route".
 *
 * Never mandatory: absent key ⇒ the capability is off and nothing here is called.
 *
 * Error vocabulary (documented ORS codes): 2009 "Route could not be found"
 * is the one positive "no route" answer ⇒ `not_found`; 2010 "could not find
 * routable point" ⇒ `insufficient_evidence` (a snapping problem, not a fact
 * about the road network); 429 ⇒ `rate_limited`; everything else ⇒
 * `provider_error`. Nothing here falls back to straight-line distance.
 */
export const ORS_BASE = 'https://api.heigit.org/openrouteservice/v2';
export const ORS_KEY_ENV = 'OPENROUTESERVICE_API_KEY';
export const ORS_NO_ROUTE_CODE = 2009;
export const ORS_NO_ROUTABLE_POINT_CODE = 2010;
const REQUEST_TIMEOUT_MS = 12_000;

export type OrsProfile = 'driving-car' | 'foot-walking' | 'cycling-regular';

export function orsProfileFor(mode: 'car' | 'foot' | 'transit' | 'bicycle'): OrsProfile | null {
  switch (mode) {
    case 'car':
      return 'driving-car';
    case 'foot':
      return 'foot-walking';
    case 'bicycle':
      return 'cycling-regular';
    default:
      return null;
  }
}

export interface OrsHttp {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  counter?: { calls: number; failures: number };
  /**
   * V10 §6 — a durable static-route cache, injected rather than constructed here
   * so this adapter never reaches for a database. A hit costs nothing and a
   * rebuild of the same trip measures nothing twice.
   */
  cache?: { read(key: string): { minutes: number; km: number } | null; write(key: string, value: { minutes: number; km: number }): void };
}

/**
 * A cache key for one road leg: the two endpoints rounded to about eleven metres,
 * and the profile. Rounded because a coordinate that moved by a metre is the same
 * leg, and unrounded keys would never hit.
 */
export function routeCacheKey(from: { lat: number; lng: number }, to: { lat: number; lng: number }, profile: OrsProfile): string {
  const r = (n: number) => n.toFixed(4);
  const a = `${r(from.lat)},${r(from.lng)}`;
  const b = `${r(to.lat)},${r(to.lng)}`;
  /* Symmetric: the reverse leg carries the same figure, so it shares the key. */
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `ors|${profile}|${lo}|${hi}`;
}

const orsResponseSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z.object({ summary: z.object({ distance: z.number(), duration: z.number() }) }),
        geometry: z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number(), z.number()]).rest(z.number())) }),
      }),
    )
    .min(1),
});

const orsErrorSchema = z.object({ error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional() });

/**
 * V10 §6 — the matrix response. `durations` and `distances` are arrays of
 * arrays; a cell may be `null`, which means the service declined that pair and
 * says **nothing** about whether a road exists.
 */
const orsMatrixSchema = z.object({
  durations: z.array(z.array(z.number().nullable())).optional(),
  distances: z.array(z.array(z.number().nullable())).optional(),
});

/** Routed pairs a single hosted matrix request may ask for. Well inside the plan's allowance. */
export const ORS_MATRIX_MAX_PAIRS = 400;

/**
 * One matrix request for a set of points. Returns `null` when the request itself
 * failed, so the caller falls through to direct legs rather than treating a
 * failure as an absence of roads.
 */
export async function computeOrsMatrix(
  input: { points: readonly { lat: number; lng: number }[]; profile: OrsProfile },
  http: OrsHttp = {},
): Promise<{ durations: (number | null)[][]; distances: (number | null)[][] } | null> {
  const apiKey = http.apiKey ?? process.env[ORS_KEY_ENV];
  if (!apiKey) return null;
  const fetchImpl = http.fetchImpl ?? fetch;
  const body = JSON.stringify({
    locations: input.points.map((p) => [p.lng, p.lat]),
    metrics: ['duration', 'distance'],
    units: 'km',
  });
  try {
    const response = await fetchImpl(`${ORS_BASE}/matrix/${input.profile}`, {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body,
      signal: requestSignal(REQUEST_TIMEOUT_MS),
    });
    if (http.counter) http.counter.calls += 1;
    if (!response.ok) {
      if (http.counter) http.counter.failures += 1;
      return null;
    }
    const parsed = orsMatrixSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.durations) return null;
    const durations = parsed.data.durations;
    const distances = parsed.data.distances ?? durations.map((row) => row.map(() => null));
    return { durations, distances };
  } catch {
    if (http.counter) http.counter.failures += 1;
    return null;
  }
}

export interface OrsRouteResult {
  found: boolean;
  minutes: number | null;
  km: number | null;
  geometry?: readonly { lat: number; lng: number }[];
  reason?: ProviderGapReason;
  provider: 'openrouteservice';
}

/** One direct leg. Never throws: every failure is a `found: false` with its reason. */
export async function computeOrsRoute(input: { from: { lat: number; lng: number }; to: { lat: number; lng: number }; profile: OrsProfile }, http: OrsHttp = {}): Promise<OrsRouteResult> {
  const apiKey = http.apiKey ?? process.env[ORS_KEY_ENV];
  if (!apiKey) return { found: false, minutes: null, km: null, reason: 'provider_error', provider: 'openrouteservice' };
  const doFetch = http.fetchImpl ?? fetch;
  if (http.counter) http.counter.calls += 1;
  let response: Response;
  try {
    response = await doFetch(`${ORS_BASE}/directions/${input.profile}/geojson`, {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json', accept: 'application/geo+json, application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ coordinates: [[input.from.lng, input.from.lat], [input.to.lng, input.to.lat]], instructions: false, geometry_simplify: true }),
      signal: requestSignal(REQUEST_TIMEOUT_MS),
    });
  } catch {
    if (http.counter) http.counter.failures += 1;
    return { found: false, minutes: null, km: null, reason: 'provider_error', provider: 'openrouteservice' };
  }
  if (response.status === 429) {
    if (http.counter) http.counter.failures += 1;
    return { found: false, minutes: null, km: null, reason: 'rate_limited', provider: 'openrouteservice' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (http.counter) http.counter.failures += 1;
    return { found: false, minutes: null, km: null, reason: 'provider_error', provider: 'openrouteservice' };
  }
  if (!response.ok) {
    if (http.counter) http.counter.failures += 1;
    const parsed = orsErrorSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error?.code : undefined;
    return { found: false, minutes: null, km: null, reason: code === ORS_NO_ROUTE_CODE ? 'not_found' : code === ORS_NO_ROUTABLE_POINT_CODE ? 'insufficient_evidence' : 'provider_error', provider: 'openrouteservice' };
  }
  const parsed = orsResponseSchema.safeParse(body);
  if (!parsed.success) {
    if (http.counter) http.counter.failures += 1;
    return { found: false, minutes: null, km: null, reason: 'provider_error', provider: 'openrouteservice' };
  }
  const feature = parsed.data.features[0]!;
  const minutes = Math.max(1, Math.round(feature.properties.summary.duration / 60));
  const km = Math.round((feature.properties.summary.distance / 1000) * 10) / 10;
  const geometry = feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  return { found: true, minutes, km, geometry, provider: 'openrouteservice' };
}

/**
 * The compiler's `RoutingProvider` face over direct legs. `matrix()` times the
 * consecutive pairs of the points it is given (the order a day is walked or
 * driven) plus the closing pair back to the first point; every other cell is
 * reported as `insufficient_evidence` — not asked, not "no route". Bounded by
 * `maxElements` requests.
 */
export function createOrsRouting(diagnostics: { routeCalls: number; routePairs: number }, http: OrsHttp = {}): RoutingProvider {
  return {
    name: 'openrouteservice',
    supportedModes() {
      return ['car', 'foot'];
    },
    async matrix({ points, mode, maxElements }) {
      const profile = orsProfileFor(mode);
      const ids = points.map((p) => p.id);
      const n = points.length;
      const minutes = points.map(() => points.map(() => Number.NaN));
      const km = points.map(() => points.map(() => Number.NaN));
      const failedPairs: RoutingMatrixResult['failedPairs'] = [];
      const reasonCounts: Partial<Record<ProviderGapReason, number>> = {};
      const fail = (from: string, to: string, reason: ProviderGapReason) => {
        failedPairs.push({ from, to, reason });
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      };
      for (let i = 0; i < n; i += 1) {
        minutes[i]![i] = 0;
        km[i]![i] = 0;
      }
      if (!profile) {
        for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j) fail(ids[i]!, ids[j]!, 'provider_error');
        return { ids, minutes, km, provenance: { kind: 'measured', note: 'openrouteservice cannot time this mode.' }, failedPairs, calls: 0, elements: 0, reasonCounts };
      }
      const wanted: [number, number][] = [];
      for (let i = 0; i + 1 < n; i += 1) wanted.push([i, i + 1]);
      if (n > 2) wanted.push([n - 1, 0]);
      let calls = 0;
      const outstanding: [number, number][] = [];
      const take = (i: number, j: number, foundMinutes: number, foundKm: number) => {
        minutes[i]![j] = foundMinutes;
        km[i]![j] = foundKm;
        /* A road is not one-way at this scale; the reverse cell carries the same figure so the return leg reads the same. */
        minutes[j]![i] = foundMinutes;
        km[j]![i] = foundKm;
      };

      /* Every pair the cache already holds costs nothing. */
      for (const [i, j] of wanted) {
        const cached = http.cache?.read(routeCacheKey(points[i]!, points[j]!, profile));
        if (cached) take(i, j, cached.minutes, cached.km);
        else outstanding.push([i, j]);
      }

      /*
       * V10 §6 — one matrix request for everything still outstanding. A declined
       * cell falls through to the direct endpoint; it is never read as "no road".
       */
      if (outstanding.length > 1 && n * n <= ORS_MATRIX_MAX_PAIRS && calls < maxElements) {
        const grid = await computeOrsMatrix({ points, profile }, http);
        calls += 1;
        diagnostics.routeCalls += 1;
        if (grid) {
          const remaining: [number, number][] = [];
          for (const [i, j] of outstanding) {
            const seconds = grid.durations[i]?.[j] ?? null;
            const distanceKm = grid.distances[i]?.[j] ?? null;
            if (seconds === null || !Number.isFinite(seconds) || distanceKm === null || !Number.isFinite(distanceKm)) {
              remaining.push([i, j]);
              continue;
            }
            const foundMinutes = Math.round(seconds / 60);
            const foundKm = Math.round(distanceKm * 10) / 10;
            take(i, j, foundMinutes, foundKm);
            diagnostics.routePairs += 1;
            http.cache?.write(routeCacheKey(points[i]!, points[j]!, profile), { minutes: foundMinutes, km: foundKm });
          }
          outstanding.length = 0;
          outstanding.push(...remaining);
        }
      }

      /* Whatever is left, one direct request each, inside the element budget. */
      for (const [i, j] of outstanding) {
        if (calls >= maxElements) {
          fail(ids[i]!, ids[j]!, 'budget_exhausted');
          continue;
        }
        const result = await computeOrsRoute({ from: points[i]!, to: points[j]!, profile }, http);
        calls += 1;
        diagnostics.routeCalls += 1;
        diagnostics.routePairs += 1;
        if (result.found && result.minutes !== null && result.km !== null) {
          take(i, j, result.minutes, result.km);
          http.cache?.write(routeCacheKey(points[i]!, points[j]!, profile), { minutes: result.minutes, km: result.km });
        } else {
          fail(ids[i]!, ids[j]!, result.reason ?? 'provider_error');
        }
      }
      const asked = new Set(wanted.flatMap(([i, j]) => [`${i}:${j}`, `${j}:${i}`]));
      for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j && !asked.has(`${i}:${j}`)) fail(ids[i]!, ids[j]!, 'insufficient_evidence');
      return {
        ids,
        minutes,
        km,
        provenance: { kind: 'measured', note: `Measured ${mode === 'car' ? 'driving' : 'walking'} times for the day's own legs from openrouteservice over OpenStreetMap data.`, source: 'openrouteservice / OpenStreetMap' },
        failedPairs,
        calls,
        elements: wanted.length,
        reasonCounts,
      };
    },
    async route({ from, to, mode }): Promise<RouteConfirmationResult> {
      const profile = orsProfileFor(mode);
      if (!profile) return { found: false, minutes: null, km: null, reason: 'provider_error' };
      const startedAt = performance.now();
      const result = await computeOrsRoute({ from, to, profile }, http);
      diagnostics.routeCalls += 1;
      return { found: result.found, minutes: result.minutes, km: result.km, ...(result.reason ? { reason: result.reason } : {}), ...(result.geometry ? { geometry: result.geometry } : {}), latencyMs: Math.round(performance.now() - startedAt) };
    },
  };
}
