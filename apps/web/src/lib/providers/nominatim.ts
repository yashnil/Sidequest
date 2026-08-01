import 'server-only';
import { providerUserAgent } from '../net/user-agent';
import { z } from 'zod';

/**
 * NOMINATIM — DESTINATION RESOLUTION.
 *
 * The public instance is a volunteer service with a usage policy that this file
 * treats as a hard contract rather than a suggestion:
 *
 * - **At most one request per second**, serialised across the whole process by
 *   the gate below. Not "we try not to exceed"; a queue that physically cannot.
 * - **No autocomplete.** The policy names it under unacceptable use, so there is
 *   no per-keystroke path here at all — resolution happens once, when a person
 *   presses a button.
 * - **An identifying User-Agent**, because a stock library agent is explicitly
 *   rejected.
 * - **Results are cached**, which the policy requires and which also means a
 *   traveller who goes back a screen costs nothing.
 *
 * `SIDEQUEST_GEOCODER_URL` keeps the endpoint configurable, so moving to a
 * hosted or self-managed geocoder is an environment change rather than a code
 * change. The public instance is for low-volume, user-triggered submissions in
 * development — not a production architecture.
 */

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org';
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_RESPONSE_BYTES = 512_000;

export const USER_AGENT =
  process.env.SIDEQUEST_FETCH_USER_AGENT?.trim() ||
  providerUserAgent('open-world trip planner');

export class GeocoderError extends Error {
  readonly code: 'not_configured' | 'rate_limited' | 'request_failed' | 'malformed_response';

  constructor(code: GeocoderError['code'], message: string) {
    super(message);
    this.name = 'GeocoderError';
    this.code = code;
  }
}

export function geocoderEndpoint(): string {
  return (process.env.SIDEQUEST_GEOCODER_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

export function isGeocoderEnabled(): boolean {
  return process.env.SIDEQUEST_GEOCODER_PROVIDER?.trim().toLowerCase() === 'nominatim';
}

/**
 * One request per second, enforced by a promise chain rather than by a timer.
 *
 * Every call links onto the tail of the previous one, so concurrency collapses
 * to a queue no matter how many compilations are running. A counter-and-sleep
 * approach lets two callers read the same timestamp and both proceed.
 */
let gate: Promise<void> = Promise.resolve();

function nextSlot(): Promise<void> {
  const wait = gate.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, MIN_INTERVAL_MS)),
  );
  gate = wait.catch(() => undefined);
  return wait;
}

const nominatimPlaceSchema = z.object({
  place_id: z.number().optional(),
  osm_type: z.string().optional(),
  osm_id: z.number().optional(),
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  addresstype: z.string().optional(),
  importance: z.number().optional(),
  boundingbox: z.array(z.string()).length(4).optional(),
  address: z.record(z.string(), z.string()).optional(),
});
export type NominatimPlace = z.infer<typeof nominatimPlaceSchema>;

export interface GeocodeResult {
  places: NominatimPlace[];
  calls: number;
  cacheHit: boolean;
}

export interface GeocodeOptions {
  limit?: number;
  /** Injected so a contract test can drive the parser without a network. */
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => NominatimPlace[] | null;
    write: (key: string, value: NominatimPlace[]) => void;
  };
}

export function geocodeCacheKey(query: string, limit: number): string {
  // The endpoint is in the key: a result from the public instance must never be
  // served to a run pointed at a self-hosted one, or the reverse.
  return ['nominatim', 'v1', geocoderEndpoint(), String(limit), query.trim().toLowerCase()].join('|');
}

export async function geocode(query: string, options: GeocodeOptions = {}): Promise<GeocodeResult> {
  const limit = Math.min(10, Math.max(1, options.limit ?? 5));
  const key = geocodeCacheKey(query, limit);

  const cached = options.cache?.read(key);
  if (cached) return { places: cached, calls: 0, cacheHit: true };

  const url = new URL('/search', geocoderEndpoint());
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  // Asking for the polygon would be the obvious thing and is the wrong thing:
  // a boundary is kilobytes we do not use, on somebody else's bandwidth.
  url.searchParams.set('polygon_geojson', '0');

  await nextSlot();

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GeocoderError('request_failed', 'The geocoder did not answer.');
  }

  if (response.status === 429) {
    throw new GeocoderError('rate_limited', 'The geocoder asked us to slow down.');
  }
  if (!response.ok) {
    throw new GeocoderError('request_failed', 'The geocoder did not answer.');
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new GeocoderError('malformed_response', 'The geocoder returned more than we will read.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeocoderError('malformed_response', 'The geocoder returned something unreadable.');
  }

  const places = z.array(nominatimPlaceSchema).safeParse(parsed);
  if (!places.success) {
    throw new GeocoderError('malformed_response', 'The geocoder returned a shape we cannot read.');
  }

  options.cache?.write(key, places.data);
  return { places: places.data, calls: 1, cacheHit: false };
}

/** `way/27784372`, the form OSM itself uses. */
export function osmElementId(place: NominatimPlace): string | null {
  if (!place.osm_type || place.osm_id === undefined) return null;
  const kind = place.osm_type === 'relation' ? 'relation' : place.osm_type === 'way' ? 'way' : 'node';
  return `${kind}/${place.osm_id}`;
}

export function osmElementUrl(place: NominatimPlace): string | null {
  const id = osmElementId(place);
  return id ? `https://www.openstreetmap.org/${id}` : null;
}

/**
 * Nominatim's `addresstype`/`category` mapped onto our breadth vocabulary.
 *
 * Read off what the geocoder actually said rather than asked of a model: a
 * geocoder's own classification is evidence, and a model's is inference. The
 * model is only consulted where this returns `unknown`.
 */
export function classifyNominatim(place: NominatimPlace): {
  breadth: 'local' | 'city' | 'subregion' | 'region' | 'country' | 'multi_country';
  entityType:
    | 'point_of_interest'
    | 'neighbourhood'
    | 'city'
    | 'metro_area'
    | 'island'
    | 'archipelago'
    | 'protected_area'
    | 'subregion'
    | 'state_or_province'
    | 'country'
    | 'multi_country'
    | 'route_or_corridor'
    | 'unknown';
} {
  const type = (place.addresstype ?? place.type ?? '').toLowerCase();
  const category = (place.category ?? '').toLowerCase();

  if (type === 'country') return { breadth: 'country', entityType: 'country' };
  if (type === 'state' || type === 'province' || type === 'region') {
    return { breadth: 'region', entityType: 'state_or_province' };
  }
  if (type === 'county' || type === 'state_district' || type === 'district') {
    return { breadth: 'subregion', entityType: 'subregion' };
  }
  if (type === 'island' || type === 'islet') return { breadth: 'subregion', entityType: 'island' };
  if (type === 'archipelago') return { breadth: 'subregion', entityType: 'archipelago' };
  if (type === 'city' || type === 'town' || type === 'municipality') {
    return { breadth: 'city', entityType: 'city' };
  }
  if (type === 'village' || type === 'hamlet' || type === 'suburb' || type === 'neighbourhood') {
    return { breadth: 'local', entityType: 'neighbourhood' };
  }
  if (category === 'boundary' && type === 'protected_area') {
    return { breadth: 'subregion', entityType: 'protected_area' };
  }
  if (category === 'leisure' || category === 'boundary') {
    return { breadth: 'subregion', entityType: 'protected_area' };
  }
  if (category === 'natural') return { breadth: 'subregion', entityType: 'protected_area' };
  return { breadth: 'city', entityType: 'unknown' };
}

export function boundsOf(place: NominatimPlace):
  | { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } }
  | null {
  if (!place.boundingbox) return null;
  const [south, north, west, east] = place.boundingbox.map(Number);
  if ([south, north, west, east].some((value) => value === undefined || Number.isNaN(value))) {
    return null;
  }
  return {
    southWest: { lat: south as number, lng: west as number },
    northEast: { lat: north as number, lng: east as number },
  };
}

/** How far the bounding box reaches, in km. Used to size a scope honestly. */
export function boundsRadiusKm(place: NominatimPlace): number | null {
  const bounds = boundsOf(place);
  if (!bounds) return null;
  const latSpanKm = (bounds.northEast.lat - bounds.southWest.lat) * 111;
  const midLat = ((bounds.northEast.lat + bounds.southWest.lat) / 2) * (Math.PI / 180);
  const lngSpanKm = (bounds.northEast.lng - bounds.southWest.lng) * 111 * Math.cos(midLat);
  return Math.max(1, Math.round(Math.max(latSpanKm, lngSpanKm) / 2));
}
