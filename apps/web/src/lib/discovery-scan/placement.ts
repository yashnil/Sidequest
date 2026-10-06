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

/** Why one placement attempt did or did not produce a point. Typed, so a thin scan explains itself without a rerun. */
export type PlacementOutcome = 'placed' | 'no_results' | 'country_mismatch' | 'outside_envelope' | 'provider_failure' | 'not_attempted_deadline' | 'not_attempted_budget';

export interface PlacementAttempt {
  provider: 'google-places' | 'nominatim';
  /** The query as sent (the model's proposed name, its locality and the country — never traveller free text beyond a must-do place name). */
  query: string;
  outcome: PlacementOutcome;
}

export interface PlacementDiagnostic {
  key: string;
  name: string;
  locality: string;
  category: string;
  isBase: boolean;
  outcome: PlacementOutcome;
  attempts: PlacementAttempt[];
}

export interface PlacementResult {
  positions: Map<string, ResolvedPosition | null>;
  providers: string[];
  placesCalls: number;
  geocoderCalls: number;
  /** One per proposed item, in proposal order. */
  diagnostics: PlacementDiagnostic[];
}

function googlePlacesUsable(env: Record<string, string | undefined> = process.env): boolean {
  const cap = capability('places.identity', env);
  if (!cap?.configured || cap.provider !== 'google-places') return false;
  return !cap.fixture || Boolean(env.SIDEQUEST_PLACES_FIXTURE);
}

function countryOf(place: NominatimPlace): string | undefined {
  return place.address?.country_code?.toUpperCase();
}

function judge(place: NominatimPlace, options: PlacementOptions): { point: { lat: number; lng: number } } | { refused: 'country_mismatch' | 'outside_envelope' | 'no_results' } {
  const point = { lat: Number(place.lat), lng: Number(place.lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return { refused: 'no_results' };
  if (options.countryCode && countryOf(place) && countryOf(place) !== options.countryCode.toUpperCase()) return { refused: 'country_mismatch' };
  if (haversineKm(options.center, point) > options.maxDistanceKm) return { refused: 'outside_envelope' };
  return { point };
}

/** The first acceptable row, or why there was none: no rows at all, or the first refusal among the rows that came back. */
async function geocodeFirst(query: string, options: PlacementOptions): Promise<{ point: { lat: number; lng: number }; place: NominatimPlace } | { outcome: PlacementOutcome }> {
  const result = await geocode(query, { limit: 5 });
  let refusal: PlacementOutcome = 'no_results';
  for (const place of result.places) {
    const verdict = judge(place, options);
    if ('point' in verdict) return { point: verdict.point, place };
    if (refusal === 'no_results') refusal = verdict.refused;
  }
  return { outcome: refusal };
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

  const items: { key: string; name: string; localName?: string; locality: string; category: string; areaLike: boolean }[] = [
    ...proposal.bases.map((b) => ({ key: b.key, name: b.name, locality: b.locality, category: 'locality', areaLike: true })),
    ...proposal.candidates.map((c) => ({ key: c.key, name: c.name, ...(c.localName ? { localName: c.localName } : {}), locality: c.locality, category: SCAN_KIND_PROFILES[c.kind].category, areaLike: SCAN_KIND_PROFILES[c.kind].hours === 'open_ground' })),
  ];
  let attempted = 0;
  let placed = 0;
  const diagnosticByKey = new Map<string, PlacementDiagnostic>();

  // Places first, a few at a time; the geocoder is rate-limited inside its own client, so it runs one at a time.
  await boundedAll(items, usePlaces ? 6 : 1, options.deadline, async (item) => {
    let position: ResolvedPosition | null = null;
    const isBase = item.category === 'locality';
    const attempts: PlacementAttempt[] = [];
    if (usePlaces && http && !isBase && placesCalls >= options.placesBudget) attempts.push({ provider: 'google-places', query: `${item.name}, ${item.locality}`, outcome: 'not_attempted_budget' });
    if (usePlaces && http && !isBase && placesCalls < options.placesBudget) {
      placesCalls += 1;
      const query = `${item.name}, ${item.locality}`;
      try {
        const found = await resolveIdentity({ name: item.name, locality: item.locality, near: options.center, radiusKm, maxDistanceKm: options.maxDistanceKm }, http);
        const far = found ? haversineKm(options.center, found.coordinates) > options.maxDistanceKm : false;
        const wrongCountry = found ? Boolean(options.countryCode && found.countryCode && found.countryCode.toUpperCase() !== options.countryCode.toUpperCase()) : false;
        attempts.push({ provider: 'google-places', query, outcome: !found ? 'no_results' : far ? 'outside_envelope' : wrongCountry ? 'country_mismatch' : 'placed' });
        if (found && !far && !wrongCountry) {
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
        attempts.push({ provider: 'google-places', query, outcome: 'provider_failure' });
      }
    }
    if (!position) {
      const query = `${item.name}, ${item.locality}${country}`;
      try {
        geocoderCalls += 1;
        const hit = await geocodeFirst(query, options);
        attempts.push({ provider: 'nominatim', query, outcome: 'point' in hit ? 'placed' : hit.outcome });
        if ('point' in hit) {
          const locality = localityFrom(hit.place);
          position = { coordinates: hit.point, method: 'geocoder', provider: 'nominatim', approximate: (hit.place.place_rank ?? 30) < 16 && !isBase, ...(locality ? { locality } : {}) };
          providers.add('nominatim');
        }
      } catch {
        /* absence */
        attempts.push({ provider: 'nominatim', query, outcome: 'provider_failure' });
      }
    }
    /*
     * Private alpha — the name as it is written locally. A live Seoul scan
     * placed 16 of 27: the open geocoder had no English name for the War
     * Memorial of Korea or Changdeokgung, and found both by their Korean names.
     */
    if (!position && item.localName) {
      const query = `${item.localName}${country}`;
      try {
        geocoderCalls += 1;
        const hit = await geocodeFirst(query, options);
        attempts.push({ provider: 'nominatim', query, outcome: 'point' in hit ? 'placed' : hit.outcome });
        if ('point' in hit) {
          const locality = localityFrom(hit.place);
          position = { coordinates: hit.point, method: 'geocoder', provider: 'nominatim', approximate: (hit.place.place_rank ?? 30) < 16 && !isBase, ...(locality ? { locality } : {}) };
          providers.add('nominatim');
        }
      } catch {
        attempts.push({ provider: 'nominatim', query, outcome: 'provider_failure' });
      }
    }
    if (!position && (item.areaLike || isBase) && item.locality && item.locality.toLowerCase() !== item.name.toLowerCase()) {
      const query = `${item.locality}${country}`;
      try {
        geocoderCalls += 1;
        const hit = await geocodeFirst(query, options);
        attempts.push({ provider: 'nominatim', query, outcome: 'point' in hit ? 'placed' : hit.outcome });
        if ('point' in hit) {
          position = { coordinates: hit.point, method: 'locality', provider: 'nominatim', approximate: true, locality: item.locality };
          providers.add('nominatim');
        }
      } catch {
        /* absence */
        attempts.push({ provider: 'nominatim', query, outcome: 'provider_failure' });
      }
    }
    attempted += 1;
    if (position) placed += 1;
    positions.set(item.key, position);
    /* The item's outcome is the most informative refusal: a wrong country or a far match says more than "nothing came back". */
    const refusals = attempts.map((a) => a.outcome).filter((o) => o !== 'placed');
    const outcome: PlacementOutcome = position ? 'placed' : (['country_mismatch', 'outside_envelope', 'provider_failure', 'no_results', 'not_attempted_budget'] as const).find((o) => refusals.includes(o)) ?? 'no_results';
    diagnosticByKey.set(item.key, { key: item.key, name: item.name, locality: item.locality, category: item.category, isBase, outcome, attempts });
    options.onProgress?.(placed, attempted);
    return position;
  });
  for (const item of items) if (!positions.has(item.key)) positions.set(item.key, null);
  /* Items the placement deadline never reached are named as such, not as places nobody could find. */
  const diagnostics = items.map((item) => diagnosticByKey.get(item.key) ?? { key: item.key, name: item.name, locality: item.locality, category: item.category, isBase: item.category === 'locality', outcome: 'not_attempted_deadline' as const, attempts: [] });
  return { positions, providers: [...providers], placesCalls, geocoderCalls, diagnostics };
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
  return { positions, providers: ['fixture-geocoder'], placesCalls: 0, geocoderCalls: 0, diagnostics: [] };
}
