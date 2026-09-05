import { z } from 'zod';
import { ProviderFailure, placeClassFor, reasonFromStatus, type PlaceClass } from '@sidequest/core';

/**
 * GOOGLE PLACES (NEW), IN FOUR LOOKUP LEVELS.
 *
 * Contract: https://developers.google.com/maps/documentation/places/web-service
 * — `POST places:searchText` and `GET places/{id}`, both with an
 * `X-Goog-FieldMask`. Billing follows the mask, so each level asks for exactly
 * the fields Sidequest uses and nothing more:
 *
 *   IDENTITY      id, displayName, location, types, primaryType, addressComponents, formattedAddress
 *   OPERATIONAL   + businessStatus, regularOpeningHours, websiteUri, priceLevel, googleMapsUri
 *   MEDIA         + photos (name, dimensions, authorAttributions) — never fetched by default
 *   DISCOVERY     a bounded text search for lodging or food near a point
 *
 * Nothing here is cached beyond what Google's terms allow: place ids and
 * coordinates may be kept; opening hours are re-read within their TTL.
 */
const PLACES_BASE = 'https://places.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 12_000;

export const PLACES_FIELD_MASKS = {
  identity: 'places.id,places.displayName,places.location,places.types,places.primaryType,places.formattedAddress,places.addressComponents',
  operational: 'id,displayName,location,types,primaryType,formattedAddress,businessStatus,regularOpeningHours,websiteUri,priceLevel,googleMapsUri',
  media: 'id,photos',
  discovery: 'places.id,places.displayName,places.location,places.types,places.primaryType,places.formattedAddress,places.priceLevel,places.rating,places.userRatingCount,places.businessStatus,places.googleMapsUri,places.websiteUri',
} as const;

const latLng = z.object({ latitude: z.number(), longitude: z.number() });
const placeSchema = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string(), languageCode: z.string().optional() }).optional(),
  formattedAddress: z.string().optional(),
  location: latLng.optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  addressComponents: z.array(z.object({ longText: z.string().optional(), shortText: z.string().optional(), types: z.array(z.string()) })).optional(),
  businessStatus: z.enum(['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY']).optional(),
  regularOpeningHours: z
    .object({
      periods: z.array(z.object({ open: z.object({ day: z.number(), hour: z.number(), minute: z.number() }).optional(), close: z.object({ day: z.number(), hour: z.number(), minute: z.number() }).optional() })).optional(),
      weekdayDescriptions: z.array(z.string()).optional(),
    })
    .optional(),
  websiteUri: z.string().optional(),
  googleMapsUri: z.string().optional(),
  priceLevel: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  photos: z.array(z.object({ name: z.string(), widthPx: z.number().optional(), heightPx: z.number().optional(), authorAttributions: z.array(z.object({ displayName: z.string().optional(), uri: z.string().optional(), photoUri: z.string().optional() })).optional() })).optional(),
});
export type GooglePlaceRecord = z.infer<typeof placeSchema>;
const searchResponseSchema = z.object({ places: z.array(placeSchema).optional() });

export interface PlacesHttp {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  counter?: { calls: number; failures: number };
}

function key(http: PlacesHttp): string {
  const k = http.apiKey ?? process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!k) throw new ProviderFailure('unauthorized', 'google-places', 'No Google credentials are configured.');
  return k;
}

async function call<T>(http: PlacesHttp, url: string, init: RequestInit & { fieldMask: string }): Promise<T> {
  const doFetch = http.fetchImpl ?? fetch;
  if (http.counter) http.counter.calls += 1;
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'content-type': 'application/json', 'x-goog-api-key': key(http), 'x-goog-fieldmask': init.fieldMask } });
  } catch (error) {
    if (http.counter) http.counter.failures += 1;
    throw new ProviderFailure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'provider_error', 'google-places');
  }
  if (!response.ok) {
    if (http.counter) http.counter.failures += 1;
    // Never log the body: it echoes the query, which may carry a traveller's own words.
    throw new ProviderFailure(reasonFromStatus(response.status), 'google-places', `Google Places answered ${response.status}.`, response.status);
  }
  return (await response.json()) as T;
}

export interface ResolvedPlaceIdentity {
  providerRef: string;
  provider: 'google-places';
  name: string;
  coordinates: { lat: number; lng: number };
  locality?: string;
  region?: string;
  countryCode?: string;
  placeClass: PlaceClass;
  types: string[];
  /** How sure the match is, from name agreement and distance to the expected area. */
  confidence: 'exact' | 'probable' | 'weak';
  attribution: string;
  distanceKm?: number;
}

export const GOOGLE_ATTRIBUTION = 'Place data © Google';

function normalise(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function component(place: GooglePlaceRecord, type: string, short = false): string | undefined {
  const c = place.addressComponents?.find((x) => x.types.includes(type));
  return short ? c?.shortText : c?.longText;
}

/**
 * IDENTITY LEVEL. One bounded text search, biased to the destination, scored
 * by name agreement, distance and category. A Starbucks in the wrong city is
 * not a match: anything outside `maxDistanceKm` or with a name that does not
 * agree is `weak`, and the caller keeps the model anchor unverified.
 */
export async function resolveIdentity(input: { name: string; locality?: string; category?: string; near: { lat: number; lng: number }; radiusKm: number; maxDistanceKm?: number }, http: PlacesHttp = {}): Promise<ResolvedPlaceIdentity | null> {
  const body = {
    textQuery: input.locality ? `${input.name}, ${input.locality}` : input.name,
    pageSize: 5,
    locationBias: { circle: { center: { latitude: input.near.lat, longitude: input.near.lng }, radius: Math.min(50_000, Math.max(1, Math.round(input.radiusKm * 1000))) } },
  };
  const raw = await call<unknown>(http, `${PLACES_BASE}/places:searchText`, { method: 'POST', body: JSON.stringify(body), fieldMask: PLACES_FIELD_MASKS.identity });
  const parsed = searchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderFailure('provider_error', 'google-places', 'Unexpected response shape.');
  const wanted = normalise(input.name);
  const maxKm = input.maxDistanceKm ?? Math.max(input.radiusKm * 2, 40);
  const scored = (parsed.data.places ?? [])
    .filter((p) => p.location && p.displayName)
    .map((p) => {
      const got = normalise(p.displayName!.text);
      const nameScore = got === wanted ? 3 : got.includes(wanted) || wanted.includes(got) ? 2 : got.split(' ').filter((w) => wanted.split(' ').includes(w)).length >= 2 ? 1 : 0;
      const distanceKm = haversineKm(input.near, { lat: p.location!.latitude, lng: p.location!.longitude });
      const localityOk = !input.locality || normalise(p.formattedAddress ?? '').includes(normalise(input.locality)) || normalise(component(p, 'locality') ?? '').includes(normalise(input.locality));
      return { p, nameScore, distanceKm, localityOk, score: nameScore * 10 - (distanceKm > maxKm ? 100 : distanceKm / 10) + (localityOk ? 5 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.nameScore === 0 || best.distanceKm > maxKm) return null;
  const place = best.p;
  return {
    providerRef: place.id,
    provider: 'google-places',
    name: place.displayName!.text,
    coordinates: { lat: place.location!.latitude, lng: place.location!.longitude },
    ...(component(place, 'locality') ? { locality: component(place, 'locality') } : {}),
    ...(component(place, 'administrative_area_level_1') ? { region: component(place, 'administrative_area_level_1') } : {}),
    ...(component(place, 'country', true) ? { countryCode: component(place, 'country', true) } : {}),
    placeClass: placeClassFor(input.category, { googleTypes: place.types ?? [] }),
    types: place.types ?? [],
    confidence: best.nameScore === 3 && best.localityOk ? 'exact' : best.nameScore >= 2 ? 'probable' : 'weak',
    attribution: GOOGLE_ATTRIBUTION,
    distanceKm: Math.round(best.distanceKm * 10) / 10,
  };
}

export interface OperationalFacts {
  providerRef: string;
  businessStatus?: 'operational' | 'closed_temporarily' | 'closed_permanently';
  /** Google's regular weekly hours, as minutes per weekday (0 = Sunday), open→close. */
  weeklyHours?: { day: number; openMinute: number; closeMinute: number }[];
  weekdayDescriptions?: string[];
  website?: string;
  mapsUri?: string;
  priceLevel?: 'free' | 'inexpensive' | 'moderate' | 'expensive' | 'very_expensive';
  checkedAt: string;
  attribution: string;
}

/** OPERATIONAL LEVEL. Only for business venues and controlled sites — the caller gates by place class. */
export async function operationalFacts(providerRef: string, http: PlacesHttp = {}, now: Date = new Date()): Promise<OperationalFacts | null> {
  const raw = await call<unknown>(http, `${PLACES_BASE}/places/${encodeURIComponent(providerRef)}`, { method: 'GET', fieldMask: PLACES_FIELD_MASKS.operational });
  const parsed = placeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const weeklyHours = (p.regularOpeningHours?.periods ?? [])
    .filter((period) => period.open && period.close)
    .map((period) => ({ day: period.open!.day, openMinute: period.open!.hour * 60 + period.open!.minute, closeMinute: period.close!.hour * 60 + period.close!.minute }));
  const priceLevel = p.priceLevel ? ({ PRICE_LEVEL_FREE: 'free', PRICE_LEVEL_INEXPENSIVE: 'inexpensive', PRICE_LEVEL_MODERATE: 'moderate', PRICE_LEVEL_EXPENSIVE: 'expensive', PRICE_LEVEL_VERY_EXPENSIVE: 'very_expensive' } as const)[p.priceLevel as 'PRICE_LEVEL_FREE'] : undefined;
  return {
    providerRef: p.id,
    ...(p.businessStatus ? { businessStatus: p.businessStatus === 'OPERATIONAL' ? 'operational' : p.businessStatus === 'CLOSED_TEMPORARILY' ? 'closed_temporarily' : 'closed_permanently' } : {}),
    ...(weeklyHours.length > 0 ? { weeklyHours } : {}),
    ...(p.regularOpeningHours?.weekdayDescriptions ? { weekdayDescriptions: p.regularOpeningHours.weekdayDescriptions } : {}),
    ...(p.websiteUri ? { website: p.websiteUri } : {}),
    ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
    ...(priceLevel ? { priceLevel } : {}),
    checkedAt: now.toISOString(),
    attribution: GOOGLE_ATTRIBUTION,
  };
}

export interface MediaFacts {
  providerRef: string;
  photos: { name: string; widthPx?: number; heightPx?: number; attribution: string; attributionUri?: string }[];
}

/** MEDIA LEVEL. Never called during a build; a page asks for it lazily for what is on screen. */
export async function mediaFacts(providerRef: string, http: PlacesHttp = {}): Promise<MediaFacts | null> {
  const raw = await call<unknown>(http, `${PLACES_BASE}/places/${encodeURIComponent(providerRef)}`, { method: 'GET', fieldMask: PLACES_FIELD_MASKS.media });
  const parsed = placeSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    providerRef: parsed.data.id,
    photos: (parsed.data.photos ?? []).slice(0, 3).map((photo) => ({ name: photo.name, ...(photo.widthPx ? { widthPx: photo.widthPx } : {}), ...(photo.heightPx ? { heightPx: photo.heightPx } : {}), attribution: photo.authorAttributions?.[0]?.displayName ?? 'Google user', ...(photo.authorAttributions?.[0]?.uri ? { attributionUri: photo.authorAttributions[0].uri } : {}) })),
  };
}

export interface DiscoveredProperty {
  providerRef: string;
  name: string;
  coordinates: { lat: number; lng: number };
  address?: string;
  priceLevel?: OperationalFacts['priceLevel'];
  rating?: number;
  ratingCount?: number;
  businessStatus?: OperationalFacts['businessStatus'];
  mapsUri?: string;
  website?: string;
  types: string[];
  distanceKm: number;
  attribution: string;
}

/**
 * DISCOVERY LEVEL. One text search for lodging or food near a point, capped
 * at a handful of results. Never a price or a room: Google Places is not an
 * inventory provider, and nothing here claims to be.
 */
export async function discoverNearby(input: { kind: 'lodging' | 'food'; near: { lat: number; lng: number }; radiusKm: number; query?: string; includedType?: string; maxResults?: number; openNow?: boolean }, http: PlacesHttp = {}): Promise<DiscoveredProperty[]> {
  const body: Record<string, unknown> = {
    textQuery: input.query ?? (input.kind === 'lodging' ? 'hotel' : 'restaurant'),
    pageSize: Math.min(10, Math.max(1, input.maxResults ?? (input.kind === 'lodging' ? 3 : 5))),
    includedType: input.includedType ?? (input.kind === 'lodging' ? 'lodging' : 'restaurant'),
    locationBias: { circle: { center: { latitude: input.near.lat, longitude: input.near.lng }, radius: Math.min(50_000, Math.max(1, Math.round(input.radiusKm * 1000))) } },
    ...(input.openNow ? { openNow: true } : {}),
  };
  const raw = await call<unknown>(http, `${PLACES_BASE}/places:searchText`, { method: 'POST', body: JSON.stringify(body), fieldMask: PLACES_FIELD_MASKS.discovery });
  const parsed = searchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProviderFailure('provider_error', 'google-places', 'Unexpected response shape.');
  return (parsed.data.places ?? [])
    .filter((p) => p.location && p.displayName)
    .map((p) => ({
      providerRef: p.id,
      name: p.displayName!.text,
      coordinates: { lat: p.location!.latitude, lng: p.location!.longitude },
      ...(p.formattedAddress ? { address: p.formattedAddress } : {}),
      ...(p.priceLevel ? { priceLevel: ({ PRICE_LEVEL_FREE: 'free', PRICE_LEVEL_INEXPENSIVE: 'inexpensive', PRICE_LEVEL_MODERATE: 'moderate', PRICE_LEVEL_EXPENSIVE: 'expensive', PRICE_LEVEL_VERY_EXPENSIVE: 'very_expensive' } as const)[p.priceLevel as 'PRICE_LEVEL_FREE'] } : {}),
      ...(p.rating !== undefined ? { rating: p.rating } : {}),
      ...(p.userRatingCount !== undefined ? { ratingCount: p.userRatingCount } : {}),
      ...(p.businessStatus ? { businessStatus: p.businessStatus === 'OPERATIONAL' ? ('operational' as const) : p.businessStatus === 'CLOSED_TEMPORARILY' ? ('closed_temporarily' as const) : ('closed_permanently' as const) } : {}),
      ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
      ...(p.websiteUri ? { website: p.websiteUri } : {}),
      types: p.types ?? [],
      distanceKm: Math.round(haversineKm(input.near, { lat: p.location!.latitude, lng: p.location!.longitude }) * 10) / 10,
      attribution: GOOGLE_ATTRIBUTION,
    }))
    .filter((p) => p.businessStatus !== 'closed_permanently')
    .slice(0, input.maxResults ?? (input.kind === 'lodging' ? 3 : 5));
}
