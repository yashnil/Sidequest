import 'server-only';
import { haversineKm, type ResolvedPosition, type ScanProposal, SCAN_KIND_PROFILES } from '@sidequest/core';
import { geocode, type NominatimPlace } from '../providers/nominatim';
import { boundedAll } from '../providers/cost-budget';
import { resolveIdentity } from '../providers/google-places';
import { placesHttpFor } from '../planning/place-identity';
import { capability } from '../providers/registry';

/**
 * V1 CONVERGENCE — WHERE EACH PROPOSED PLACE ACTUALLY IS.
 *
 * The model names places; it never supplies a coordinate. Each name is asked
 * of a real provider, in order of how specific its answer is:
 *
 * 1. a places provider (Google Places, when configured): a venue identity with
 *    a place id we may keep and a coordinate we may cache for thirty days;
 * 2. the geocoder (Nominatim): the name with its locality and country;
 * 3. the locality alone — kept only for area-like things, and marked
 *    approximate (`planScanPoints` drops it for anything point-like).
 *
 * Every answer is gated by distance from the destination and, where known, by
 * country, so a same-named place on another continent never stands in. A
 * proposal nobody could place stays unplaced and is reported — never given a
 * guessed point.
 */

export interface PlacementOptions {
  center: { lat: number; lng: number };
  /** How far from the destination centre a match may be before it is refused. */
  maxDistanceKm: number;
  countryCode?: string;
  countryName?: string;
  /** Places-provider lookups allowed this scan. */
  placesBudget: number;
  deadline: () => boolean;
  onProgress?: (placed: number, attempted: number) => void;
}

export interface PlacementResult {
  positions: Map<string, ResolvedPosition | null>;
  providers: string[];
  placesCalls: number;
  geocoderCalls: number;
}

function googlePlacesUsable(env: Record<string, string | undefined> = process.env): boolean {
  const cap = capability('places.identity', env);
  if (!cap?.configured || cap.provider !== 'google-places') return false;
  return !cap.fixture || Boolean(env.SIDEQUEST_PLACES_FIXTURE);
}

function countryOf(place: NominatimPlace): string | undefined {
  return place.address?.country_code?.toUpperCase();
}

function acceptable(place: NominatimPlace, options: PlacementOptions): { lat: number; lng: number } | null {
  const point = { lat: Number(place.lat), lng: Number(place.lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (options.countryCode && countryOf(place) && countryOf(place) !== options.countryCode.toUpperCase()) return null;
  if (haversineKm(options.center, point) > options.maxDistanceKm) return null;
  return point;
}

async function geocodeFirst(query: string, options: PlacementOptions): Promise<{ point: { lat: number; lng: number }; place: NominatimPlace } | null> {
  const result = await geocode(query, { limit: 5 });
  for (const place of result.places) {
    const point = acceptable(place, options);
    if (point) return { point, place };
  }
  return null;
}

function localityFrom(place: NominatimPlace): string | undefined {
  const a = place.address ?? {};
  return a.city ?? a.town ?? a.village ?? a.suburb ?? a.municipality ?? a.county ?? undefined;
}

export async function placeScanProposal(proposal: ScanProposal, options: PlacementOptions): Promise<PlacementResult> {
  const positions = new Map<string, ResolvedPosition | null>();
  const usePlaces = googlePlacesUsable();
  const http = usePlaces ? placesHttpFor() : null;
  let placesCalls = 0;
  let geocoderCalls = 0;
  const providers = new Set<string>();
  const country = options.countryName ? `, ${options.countryName}` : '';
  const radiusKm = Math.min(50, Math.max(10, options.maxDistanceKm / 4));

  const items: { key: string; name: string; locality: string; category: string; areaLike: boolean }[] = [
    ...proposal.bases.map((b) => ({ key: b.key, name: b.name, locality: b.locality, category: 'locality', areaLike: true })),
    ...proposal.candidates.map((c) => ({ key: c.key, name: c.name, locality: c.locality, category: SCAN_KIND_PROFILES[c.kind].category, areaLike: SCAN_KIND_PROFILES[c.kind].hours === 'open_ground' })),
  ];
  let attempted = 0;
  let placed = 0;

  // Places first, a few at a time; the geocoder is rate-limited inside its own client, so it runs one at a time.
  await boundedAll(items, usePlaces ? 6 : 1, options.deadline, async (item) => {
    let position: ResolvedPosition | null = null;
    const isBase = item.category === 'locality';
    if (usePlaces && http && !isBase && placesCalls < options.placesBudget) {
      placesCalls += 1;
      try {
        const found = await resolveIdentity({ name: item.name, locality: item.locality, near: options.center, radiusKm, maxDistanceKm: options.maxDistanceKm }, http);
        if (found && haversineKm(options.center, found.coordinates) <= options.maxDistanceKm && (!options.countryCode || !found.countryCode || found.countryCode.toUpperCase() === options.countryCode.toUpperCase())) {
          position = {
            coordinates: found.coordinates,
            method: 'places',
            provider: 'google-places',
            providerRef: found.providerRef,
            approximate: false,
            // Google's own locality is not stored (Maps Content); the proposal's locality stands.
          };
          providers.add('google-places');
        }
      } catch {
        /* a provider failure is an absence, never a verdict */
      }
    }
    if (!position) {
      try {
        geocoderCalls += 1;
        const hit = await geocodeFirst(`${item.name}, ${item.locality}${country}`, options);
        if (hit) {
          const locality = localityFrom(hit.place);
          position = { coordinates: hit.point, method: 'geocoder', provider: 'nominatim', approximate: (hit.place.place_rank ?? 30) < 16 && !isBase, ...(locality ? { locality } : {}) };
          providers.add('nominatim');
        }
      } catch {
        /* absence */
      }
    }
    if (!position && (item.areaLike || isBase) && item.locality && item.locality.toLowerCase() !== item.name.toLowerCase()) {
      try {
        geocoderCalls += 1;
        const hit = await geocodeFirst(`${item.locality}${country}`, options);
        if (hit) {
          position = { coordinates: hit.point, method: 'locality', provider: 'nominatim', approximate: true, locality: item.locality };
          providers.add('nominatim');
        }
      } catch {
        /* absence */
      }
    }
    attempted += 1;
    if (position) placed += 1;
    positions.set(item.key, position);
    options.onProgress?.(placed, attempted);
    return position;
  });
  for (const item of items) if (!positions.has(item.key)) positions.set(item.key, null);
  return { positions, providers: [...providers], placesCalls, geocoderCalls };
}

/**
 * The fixture placement: deterministic positions around the destination centre,
 * reached only under the fixture compiler switch (tests and the browser suite),
 * so the whole scan runs with no network. Bases spread along a line; each
 * candidate sits near the base its locality names, or the first base.
 */
export function fixturePlacement(proposal: ScanProposal, center: { lat: number; lng: number }): PlacementResult {
  const positions = new Map<string, ResolvedPosition | null>();
  const baseAt = new Map<string, { lat: number; lng: number }>();
  proposal.bases.forEach((base, i) => {
    const point = { lat: center.lat + i * 0.35, lng: center.lng + i * 0.35 };
    baseAt.set(base.locality.toLowerCase(), point);
    baseAt.set(base.name.toLowerCase(), point);
    positions.set(base.key, { coordinates: point, method: 'geocoder', provider: 'fixture-geocoder', approximate: false });
  });
  const first = proposal.bases[0] ? baseAt.get(proposal.bases[0].name.toLowerCase())! : center;
  proposal.candidates.forEach((candidate, i) => {
    const anchor = baseAt.get(candidate.locality.toLowerCase()) ?? first;
    const angle = (i * 137.5 * Math.PI) / 180;
    const r = 0.01 + (i % 5) * 0.012;
    positions.set(candidate.key, { coordinates: { lat: anchor.lat + r * Math.cos(angle), lng: anchor.lng + r * Math.sin(angle) }, method: 'geocoder', provider: 'fixture-geocoder', approximate: false });
  });
  return { positions, providers: ['fixture-geocoder'], placesCalls: 0, geocoderCalls: 0 };
}
