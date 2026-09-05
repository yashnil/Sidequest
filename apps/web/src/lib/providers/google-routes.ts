import { z } from 'zod';
import { decodePolyline, reasonFromStatus, type LatLng } from '@sidequest/core';

/**
 * GOOGLE ROUTES — `computeRoutes`, USED ONLY WHEN THE POLICY SELECTS IT.
 *
 * Contract: https://developers.google.com/maps/documentation/routes/compute_route_directions
 * — `POST https://routes.googleapis.com/directions/v2:computeRoutes` with an
 * `X-Goog-FieldMask`. Sidequest asks for duration, static duration, distance
 * and the encoded polyline, plus transit step details for TRANSIT. Traffic
 * (`routingPreference: TRAFFIC_AWARE`) is requested only with a departure
 * time inside the horizon; the response then carries both `duration` (with
 * traffic) and `staticDuration`, and both are kept.
 */
const ROUTES_BASE = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const REQUEST_TIMEOUT_MS = 12_000;

export type GoogleRouteMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT' | 'TWO_WHEELER';

export const ROUTES_FIELD_MASK = 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.vehicle.type,routes.legs.steps.transitDetails.stopCount';

const responseSchema = z.object({
  routes: z
    .array(
      z.object({
        duration: z.string().optional(),
        staticDuration: z.string().optional(),
        distanceMeters: z.number().optional(),
        polyline: z.object({ encodedPolyline: z.string().optional() }).optional(),
        legs: z
          .array(
            z.object({
              steps: z
                .array(
                  z.object({
                    travelMode: z.string().optional(),
                    staticDuration: z.string().optional(),
                    transitDetails: z.object({ transitLine: z.object({ nameShort: z.string().optional(), vehicle: z.object({ type: z.string().optional() }).optional() }).optional(), stopCount: z.number().optional() }).optional(),
                  }),
                )
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  error: z.object({ code: z.number().optional(), status: z.string().optional(), message: z.string().optional() }).optional(),
});

function seconds(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([\d.]+)s$/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

export interface GoogleRouteResult {
  found: boolean;
  minutes: number | null;
  staticMinutes: number | null;
  km: number | null;
  basis: 'static' | 'traffic_aware' | 'scheduled';
  geometry?: LatLng[];
  encodedPolyline?: string;
  transitSummary?: string;
  transitLegs?: { mode: string; minutes: number; line?: string }[];
  reason?: 'no_route' | 'unsupported' | 'timeout' | 'provider_error' | 'rate_limited' | 'unauthorized' | 'quota' | 'invalid_request' | 'temporarily_unavailable' | 'not_found';
  provider: 'google-routes';
  effectiveDepartAt?: string;
}

export interface RoutesHttp {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  counter?: { calls: number; failures: number };
}

/** Live traffic means something only this close to the departure. */
export const TRAFFIC_HORIZON_HOURS = 48;

export function trafficIsMeaningful(departAt: Date | null, now: Date): boolean {
  if (!departAt) return false;
  const ahead = (departAt.getTime() - now.getTime()) / 3_600_000;
  return ahead >= -1 && ahead <= TRAFFIC_HORIZON_HOURS;
}

export async function computeGoogleRoute(
  input: { from: LatLng; to: LatLng; mode: GoogleRouteMode; departAt?: Date; traffic?: boolean; now?: Date },
  http: RoutesHttp = {},
): Promise<GoogleRouteResult> {
  const apiKey = http.apiKey ?? process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) return { found: false, minutes: null, staticMinutes: null, km: null, basis: 'static', reason: 'unauthorized', provider: 'google-routes' };
  const now = input.now ?? new Date();
  const wantsTraffic = Boolean(input.traffic) && input.mode === 'DRIVE' && trafficIsMeaningful(input.departAt ?? null, now);
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: input.from.lat, longitude: input.from.lng } } },
    destination: { location: { latLng: { latitude: input.to.lat, longitude: input.to.lng } } },
    travelMode: input.mode,
    polylineQuality: 'OVERVIEW',
    polylineEncoding: 'ENCODED_POLYLINE',
    ...(input.mode === 'DRIVE' || input.mode === 'TWO_WHEELER' ? { routingPreference: wantsTraffic ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE' } : {}),
    ...(input.mode === 'TRANSIT' && input.departAt ? { departureTime: input.departAt.toISOString() } : {}),
    ...(wantsTraffic && input.departAt ? { departureTime: input.departAt.toISOString() } : {}),
  };
  const doFetch = http.fetchImpl ?? fetch;
  if (http.counter) http.counter.calls += 1;
  let response: Response;
  try {
    response = await doFetch(ROUTES_BASE, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, 'x-goog-fieldmask': ROUTES_FIELD_MASK } });
  } catch (error) {
    if (http.counter) http.counter.failures += 1;
    return { found: false, minutes: null, staticMinutes: null, km: null, basis: 'static', reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'provider_error', provider: 'google-routes' };
  }
  if (!response.ok) {
    if (http.counter) http.counter.failures += 1;
    return { found: false, minutes: null, staticMinutes: null, km: null, basis: 'static', reason: reasonFromStatus(response.status), provider: 'google-routes' };
  }
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) return { found: false, minutes: null, staticMinutes: null, km: null, basis: 'static', reason: 'provider_error', provider: 'google-routes' };
  const route = parsed.data.routes?.[0];
  /* An empty `routes` array is Google's documented "no route for this mode" — the one honest `no_route`. */
  if (!route) return { found: false, minutes: null, staticMinutes: null, km: null, basis: 'static', reason: 'no_route', provider: 'google-routes' };
  const durationS = seconds(route.duration);
  const staticS = seconds(route.staticDuration) ?? durationS;
  const geometry = route.polyline?.encodedPolyline ? decodePolyline(route.polyline.encodedPolyline) : undefined;
  const steps = route.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
  const transitLegs = input.mode === 'TRANSIT' ? steps.map((s) => ({ mode: s.travelMode === 'TRANSIT' ? (s.transitDetails?.transitLine?.vehicle?.type ?? 'TRANSIT').toLowerCase() : (s.travelMode ?? 'walk').toLowerCase(), minutes: Math.round((seconds(s.staticDuration) ?? 0) / 60), ...(s.transitDetails?.transitLine?.nameShort ? { line: s.transitDetails.transitLine.nameShort } : {}) })) : undefined;
  const transitSummary = transitLegs ? summariseTransit(transitLegs, durationS === null ? null : Math.round(durationS / 60)) : undefined;
  return {
    found: durationS !== null,
    minutes: durationS === null ? null : Math.round(durationS / 60),
    staticMinutes: staticS === null ? null : Math.round(staticS / 60),
    km: route.distanceMeters === undefined ? null : Math.round((route.distanceMeters / 1000) * 10) / 10,
    basis: input.mode === 'TRANSIT' ? 'scheduled' : wantsTraffic ? 'traffic_aware' : 'static',
    ...(geometry ? { geometry, encodedPolyline: route.polyline!.encodedPolyline! } : {}),
    ...(transitSummary ? { transitSummary } : {}),
    ...(transitLegs ? { transitLegs } : {}),
    provider: 'google-routes',
    ...(input.departAt && (wantsTraffic || input.mode === 'TRANSIT') ? { effectiveDepartAt: input.departAt.toISOString() } : {}),
  };
}

/** "24 min by metro + walk" rather than every transfer. */
export function summariseTransit(legs: readonly { mode: string; minutes: number; line?: string }[], totalMinutes: number | null): string {
  const rides = legs.filter((l) => l.mode !== 'walk' && l.mode !== 'walking');
  const modes = [...new Set(rides.map((l) => (l.mode === 'subway' || l.mode === 'metro_rail' ? 'metro' : l.mode === 'heavy_rail' || l.mode === 'rail' || l.mode === 'commuter_train' ? 'train' : l.mode === 'bus' ? 'bus' : l.mode === 'tram' || l.mode === 'light_rail' ? 'tram' : l.mode === 'ferry' ? 'ferry' : l.mode)))];
  const walk = legs.some((l) => l.mode === 'walk' || l.mode === 'walking');
  const head = totalMinutes === null ? '' : `${totalMinutes} min `;
  if (modes.length === 0) return `${head}on foot`.trim();
  return `${head}by ${modes.join(' + ')}${walk ? ' + walk' : ''}${rides.length > 1 ? ` (${rides.length - 1} change${rides.length > 2 ? 's' : ''})` : ''}`.trim();
}
