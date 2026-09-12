import 'server-only';
import { providerUserAgent } from '../net/user-agent';
import { z } from 'zod';
import { requestSignal } from '../net/generation-deadline';

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

/**
 * Re-exported rather than defined, so a caller that only wants to know whether
 * the geocoder is switched on does not pull this client — and its rate limiter,
 * its fetch and its parser — into its import graph. See `providers/switches.ts`.
 */
export { isGeocoderEnabled } from './switches';

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
  /**
   * `name`, `name:en`, `int_name`, `official_name`, … exactly as the record has
   * them. Values only — no key is trusted to be a language tag without checking.
   */
  namedetails: z.record(z.string(), z.string()).optional(),
  /** V7 — `place`, `population`, `wikidata`, `admin_level`… as the record tags them; asked for so a state-typed record can say it is a city. */
  extratags: z.record(z.string(), z.string()).optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  addresstype: z.string().optional(),
  importance: z.number().optional(),
  /** V8.1 — Nominatim's address rank: 30 is a building or business, 16–18 a town, 4–8 a country or first-level division. */
  place_rank: z.number().optional(),
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
  /** V7 — Nominatim's own class filter: `settlement` asks only for populated places, `state` only for first-level divisions. */
  featureType?: 'country' | 'state' | 'city' | 'settlement';
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
  // `v2`: responses now carry `extratags` and `place_rank`; a `v1` entry cached without them must not be served for thirty days.
  return ['nominatim', 'v2', geocoderEndpoint(), String(limit), query.trim().toLowerCase()].join('|');
}

export function geocodeCacheKeyFor(query: string, limit: number, featureType: string | undefined): string {
  return featureType ? `${geocodeCacheKey(query, limit)}|${featureType}` : geocodeCacheKey(query, limit);
}

export async function geocode(query: string, options: GeocodeOptions = {}): Promise<GeocodeResult> {
  const limit = Math.min(10, Math.max(1, options.limit ?? 5));
  const key = geocodeCacheKeyFor(query, limit, options.featureType);

  const cached = options.cache?.read(key);
  if (cached) return { places: cached, calls: 0, cacheHit: true };

  const url = new URL('/search', geocoderEndpoint());
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  /*
   * The multilingual names, which is the whole point of asking.
   *
   * A geocoder's `name` field is the *local* name by design — which is how a
   * compiled trip came to render its base as `Бишкек шаары` for somebody who
   * typed "Kyrgyzstan" in English. `namedetails=1` returns `name:en` and every
   * other tagged variant the record carries, so the display-name resolver has
   * a source-published English name to prefer rather than a transliteration
   * somebody invented.
   */
  url.searchParams.set('namedetails', '1');
  /* V8.1 — the record's own tags (`place`, `natural`, `wikidata`): the evidence a state-typed city or a landscape row is read from. */
  url.searchParams.set('extratags', '1');
  // Asking for the polygon would be the obvious thing and is the wrong thing:
  // a boundary is kilobytes we do not use, on somebody else's bandwidth.
  url.searchParams.set('polygon_geojson', '0');

  await nextSlot();

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: requestSignal(REQUEST_TIMEOUT_MS),
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

export interface ReverseGeocodeOptions {
  /** Nominatim's own address-detail granularity: 10 ≈ city/town, the level a settlement worth sleeping in resolves at. */
  zoom?: number;
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => NominatimPlace | null | undefined;
    write: (key: string, value: NominatimPlace | null) => void;
  };
}

export interface ReverseGeocodeResult {
  /** `null` when Nominatim has nothing at this point (open ocean, an unmapped area) — not an error. */
  place: NominatimPlace | null;
  calls: number;
  cacheHit: boolean;
}

export function reverseGeocodeCacheKey(lat: number, lng: number, zoom: number): string {
  return ['nominatim', 'reverse', 'v1', geocoderEndpoint(), String(zoom), lat.toFixed(4), lng.toFixed(4)].join('|');
}

/**
 * THE OTHER DIRECTION — A COORDINATE IN, THE NEAREST REAL SETTLEMENT OUT.
 *
 * `geocode()` answers "where is this name"; this answers "what is here" —
 * the question a route-corridor search needs, since a plausible overnight
 * locality is not named in advance. Same instance, same rate gate, same
 * usage-policy discipline (`geocoderEndpoint()`, `nextSlot()`, caching,
 * `USER_AGENT`) as `geocode()` — a sibling capability, not a new client.
 *
 * `zoom=10` asks Nominatim to resolve at city/town granularity rather than a
 * street address or a country — the same level `classifyNominatim()`'s
 * `'city'`/`'neighbourhood'` distinction already reads off `/search` results
 * elsewhere in this file.
 */
export async function reverseGeocode(lat: number, lng: number, options: ReverseGeocodeOptions = {}): Promise<ReverseGeocodeResult> {
  const zoom = options.zoom ?? 10;
  const key = reverseGeocodeCacheKey(lat, lng, zoom);

  const cached = options.cache?.read(key);
  if (cached !== undefined && cached !== null) return { place: cached, calls: 0, cacheHit: true };
  if (cached === null) return { place: null, calls: 0, cacheHit: true };

  const url = new URL('/reverse', geocoderEndpoint());
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', String(zoom));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('namedetails', '1');

  await nextSlot();

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: requestSignal(REQUEST_TIMEOUT_MS),
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

  // Nominatim's honest answer for a point with nothing mapped nearby
  // (open ocean, an unmapped area) is `{"error": "Unable to geocode"}`, not
  // a failed request — a real, cacheable "nothing here", not an outage.
  if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
    options.cache?.write(key, null);
    return { place: null, calls: 1, cacheHit: false };
  }

  const result = nominatimPlaceSchema.safeParse(parsed);
  if (!result.success) {
    throw new GeocoderError('malformed_response', 'The geocoder returned a shape we cannot read.');
  }

  options.cache?.write(key, result.data);
  return { place: result.data, calls: 1, cacheHit: false };
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
    | 'natural_region'
    | 'subregion'
    | 'state_or_province'
    | 'municipality'
    | 'country'
    | 'multi_country'
    | 'route_or_corridor'
    | 'unknown';
} {
  const type = (place.addresstype ?? place.type ?? '').toLowerCase();
  const category = (place.category ?? '').toLowerCase();
  const placeTag = (place.extratags?.place ?? '').toLowerCase();

  if (type === 'country') return { breadth: 'country', entityType: 'country' };
  if (type === 'region' && placeTag !== 'city' && placeTag !== 'municipality') {
    return { breadth: 'region', entityType: 'subregion' };
  }
  if (type === 'state' || type === 'province' || type === 'region') {
    /*
     * V7 — A FIRST-LEVEL DIVISION THAT IS A CITY.
     *
     * A direct-administered municipality (Chongqing, Shanghai), a city-state
     * and a prefecture-city all sit at admin level 4 and come back typed
     * `state`. The record's own `place` tag says what it is; when the tag
     * says city or municipality this is a city with a region attached, and
     * "a state or province you drive across" is the wrong reading of it.
     */
    if (placeTag === 'city' || placeTag === 'municipality') return { breadth: 'region', entityType: 'municipality' };
    return { breadth: 'region', entityType: 'state_or_province' };
  }
  if (type === 'county' || type === 'state_district' || type === 'district') {
    return { breadth: 'subregion', entityType: 'subregion' };
  }
  /*
   * V8.1 — WHAT A ROW IS, BEFORE WHERE IT SITS.
   *
   * A business, an office, an airport, a shop or a road came through here as
   * `unknown` at city breadth, which is how "Resorts of the Canadian Rockies"
   * on 17 Avenue SW stood in for the Rockies. The record's own class says it
   * is a thing *in* a place: read that first. A named landscape
   * (`natural=mountain_range`, `desert`, `valley`…) is a region of its own
   * kind, and a `region` row (`place=region`, `boundary=region`) is a region,
   * not a state to drive across.
   */
  if (POINT_CATEGORIES.has(category) || (category === 'place' && POINT_PLACE_TYPES.has(type))) {
    return { breadth: 'local', entityType: 'point_of_interest' };
  }
  if (category === 'highway' || category === 'railway' || category === 'route') {
    return { breadth: 'local', entityType: 'route_or_corridor' };
  }
  if (category === 'natural' || (category === 'place' && NATURAL_PLACE_TYPES.has(type))) {
    return { breadth: NATURAL_LOCAL_TYPES.has(type) ? 'local' : 'subregion', entityType: NATURAL_LOCAL_TYPES.has(type) ? 'point_of_interest' : 'natural_region' };
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
  return { breadth: 'city', entityType: 'unknown' };
}

/** Record classes that are a thing in a place rather than a place: read as a point of interest whatever their address type says. */
const POINT_CATEGORIES = new Set(['shop', 'office', 'amenity', 'tourism', 'aeroway', 'craft', 'building', 'man_made', 'historic', 'emergency', 'healthcare', 'club', 'military', 'power', 'public_transport', 'information', 'sport', 'attraction', 'leisure_point']);
const POINT_PLACE_TYPES = new Set(['house', 'houses', 'farm', 'isolated_dwelling', 'allotments', 'square', 'plot', 'locality']);
/** `place=*` values that name a landscape rather than a settlement. */
const NATURAL_PLACE_TYPES = new Set(['sea', 'ocean', 'archipelago', 'island', 'islet']);
/** Natural features small enough to stand on: a peak, a spring, a cave, a tree. */
const NATURAL_LOCAL_TYPES = new Set(['peak', 'spring', 'cave_entrance', 'tree', 'rock', 'stone', 'saddle', 'hot_spring', 'geyser', 'cliff', 'arch', 'sinkhole', 'volcano', 'hill', 'waterfall', 'bay_point']);

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
