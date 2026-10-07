import 'server-only';
import { ACCESS_AMBIGUITY_KM, ACCESS_RADIUS_KM, MAX_ACCESS_QUERIES, MAX_ACCESS_RECOVERIES, accessEvidence, accessRecoveryQueries, accessStemOf, haversineKm, routeAnswerIsAreaLevel, worthAccessRecovery, type ResolvedPosition, type ScanProposal, SCAN_KIND_PROFILES } from '@sidequest/core';
import { matchNamedMustDos } from './match';
import type { AccessKind } from '@sidequest/core';
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
  /** The places the traveller named themselves; an area-only match among them is always worth an access-point search. */
  namedByTraveller?: readonly string[];
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

/** Private alpha — what a bounded access-point search did for an area-only candidate. */
export interface AccessRecoveryDiagnostic {
  /** What placement had before the search: an area-level point, or nothing. */
  originalOutcome: 'approximate_only' | PlacementOutcome;
  attempted: boolean;
  queries: PlacementAttempt[];
  outcome: 'recovered_access_point' | 'no_access_point' | 'ambiguous_access_point' | 'provider_failure';
  accessPoint?: { kind: string; provider: string; coordinates: { lat: number; lng: number } };
}

export interface PlacementDiagnostic {
  key: string;
  name: string;
  locality: string;
  category: string;
  isBase: boolean;
  outcome: PlacementOutcome;
  attempts: PlacementAttempt[];
  recovery?: AccessRecoveryDiagnostic;
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

  const named = new Set(matchNamedMustDos(options.namedByTraveller ?? [], proposal.candidates.map((c) => ({ id: c.key, name: c.name }))));
  const items: { key: string; name: string; localName?: string; locality: string; category: string; areaLike: boolean; kind?: string; recoverable?: boolean }[] = [
    ...proposal.bases.map((b) => ({ key: b.key, name: b.name, locality: b.locality, category: 'locality', areaLike: true })),
    ...proposal.candidates.map((c) => ({ key: c.key, name: c.name, ...(c.localName ? { localName: c.localName } : {}), locality: c.locality, category: SCAN_KIND_PROFILES[c.kind].category, areaLike: SCAN_KIND_PROFILES[c.kind].hours === 'open_ground', kind: c.kind, recoverable: worthAccessRecovery({ kind: c.kind, tier: c.tier, namedByTraveller: named.has(c.key) }) })),
  ];
  let recoveries = 0;
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
            /* A route answered by an area (a hiking area, a natural feature, a park) is not a point to route to. */
            approximate: Boolean(item.kind && routeAnswerIsAreaLevel({ kind: item.kind, googleTypes: found.types })),
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
          position = { coordinates: hit.point, method: 'geocoder', provider: 'nominatim', approximate: ((hit.place.place_rank ?? 30) < 16 && !isBase) || Boolean(item.kind && routeAnswerIsAreaLevel({ kind: item.kind, osmClass: hit.place.category, osmType: hit.place.type })), ...(locality ? { locality } : {}) };
          providers.add('nominatim');
        }
      } catch {
        /* absence */
        attempts.push({ provider: 'nominatim', query, outcome: 'provider_failure' });
      }
    }
    /*
     * Private alpha — the name without the locality. A live Dolomites scan
     * placed 11 of 30: the model's locality for a pass or a lake is often the
     * neighbouring comune, and the open geocoder then finds nothing, while the
     * name alone (still gated by country and distance) finds the place. Only
     * after "nothing came back" — a refusal (wrong country, too far) is an
     * answer, not a miss, and is never retried.
     */
    if (!position && !isBase && item.locality && attempts.length > 0 && attempts[attempts.length - 1]!.outcome === 'no_results') {
      const query = `${item.name}${country}`;
      try {
        geocoderCalls += 1;
        const hit = await geocodeFirst(query, options);
        attempts.push({ provider: 'nominatim', query, outcome: 'point' in hit ? 'placed' : hit.outcome });
        if ('point' in hit) {
          const locality = localityFrom(hit.place);
          position = { coordinates: hit.point, method: 'geocoder', provider: 'nominatim', approximate: (hit.place.place_rank ?? 30) < 16 || Boolean(item.kind && routeAnswerIsAreaLevel({ kind: item.kind, osmClass: hit.place.category, osmType: hit.place.type })), ...(locality ? { locality } : {}) };
          providers.add('nominatim');
        }
      } catch {
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
          position = { coordinates: hit.point, method: 'geocoder', provider: 'nominatim', approximate: ((hit.place.place_rank ?? 30) < 16 && !isBase) || Boolean(item.kind && routeAnswerIsAreaLevel({ kind: item.kind, osmClass: hit.place.category, osmType: hit.place.type })), ...(locality ? { locality } : {}) };
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
    /*
     * Private alpha — an important route or area found only as an area (or not
     * at all) gets a bounded search for where it is started. See
     * `@sidequest/core` scan/access-point.ts for what counts as an access point.
     */
    let recovery: AccessRecoveryDiagnostic | undefined;
    if (item.recoverable && item.kind && (!position || position.approximate) && recoveries < MAX_ACCESS_RECOVERIES && !options.deadline()) {
      recoveries += 1;
      /* Only the activity's own area anchors the search; a town or region centroid from the locality fallback is not where the activity is. */
      const searched = await recoverAccessPoint({ name: item.name, kind: item.kind, footprint: position && position.method !== 'locality' ? position.coordinates : null, options, country, http: usePlaces ? http : null });
      placesCalls += searched.placesCalls;
      geocoderCalls += searched.geocoderCalls;
      recovery = { originalOutcome: position ? 'approximate_only' : 'no_results', attempted: true, queries: searched.queries, outcome: searched.outcome, ...(searched.found ? { accessPoint: { kind: searched.found.kind, provider: searched.found.provider, coordinates: searched.found.coordinates } } : {}) };
      if (searched.found) {
        const found = searched.found;
        position = {
          coordinates: found.coordinates,
          method: found.provider === 'google-places' ? 'places' : 'geocoder',
          provider: found.provider,
          ...(found.providerRef ? { providerRef: found.providerRef } : {}),
          approximate: false,
          accessPoint: { kind: found.kind, provider: found.provider, query: found.query, ...(found.name ? { name: found.name } : {}), ...(position && position.method !== 'locality' ? { footprint: position.coordinates } : {}) },
        };
        providers.add(found.provider);
      } else if (position) {
        position = { ...position, accessPointUnverified: true };
      }
    }
    attempted += 1;
    if (position) placed += 1;
    positions.set(item.key, position);
    /* The item's outcome is the most informative refusal: a wrong country or a far match says more than "nothing came back". */
    const refusals = attempts.map((a) => a.outcome).filter((o) => o !== 'placed');
    const outcome: PlacementOutcome = position ? 'placed' : (['country_mismatch', 'outside_envelope', 'provider_failure', 'no_results', 'not_attempted_budget'] as const).find((o) => refusals.includes(o)) ?? 'no_results';
    diagnosticByKey.set(item.key, { key: item.key, name: item.name, locality: item.locality, category: item.category, isBase, outcome, attempts, ...(recovery ? { recovery } : {}) });
    options.onProgress?.(placed, attempted);
    return position;
  });
  for (const item of items) if (!positions.has(item.key)) positions.set(item.key, null);
  /* Items the placement deadline never reached are named as such, not as places nobody could find. */
  const diagnostics = items.map((item) => diagnosticByKey.get(item.key) ?? { key: item.key, name: item.name, locality: item.locality, category: item.category, isBase: item.category === 'locality', outcome: 'not_attempted_deadline' as const, attempts: [] });
  return { positions, providers: [...providers], placesCalls, geocoderCalls, diagnostics };
}

interface RecoveredAccess {
  coordinates: { lat: number; lng: number };
  kind: AccessKind;
  provider: 'google-places' | 'nominatim';
  providerRef?: string;
  query: string;
  /** Only an open-data name; a Google display name is matched, never stored. */
  name?: string;
}

/**
 * At most MAX_ACCESS_QUERIES queries, Google Places first when it is usable,
 * otherwise the geocoder. An answer is taken only with access evidence, in the
 * right country, near the area the activity placed at (or within the
 * destination's reach when nothing placed), and unambiguous.
 */
async function recoverAccessPoint(input: {
  name: string;
  kind: string;
  footprint: { lat: number; lng: number } | null;
  options: PlacementOptions;
  country: string;
  http: ReturnType<typeof placesHttpFor> | null;
}): Promise<{ found: RecoveredAccess | null; outcome: AccessRecoveryDiagnostic['outcome']; queries: PlacementAttempt[]; placesCalls: number; geocoderCalls: number }> {
  const stem = accessStemOf(input.name);
  const anchor = input.footprint ?? input.options.center;
  const radiusKm = input.footprint ? ACCESS_RADIUS_KM : input.options.maxDistanceKm;
  const queries: PlacementAttempt[] = [];
  let placesCalls = 0;
  let geocoderCalls = 0;
  let sawAmbiguity = false;
  let sawFailure = false;
  const near = (point: { lat: number; lng: number }) => haversineKm(anchor, point) <= radiusKm && haversineKm(input.options.center, point) <= input.options.maxDistanceKm;
  const countryOk = (code: string | undefined) => !input.options.countryCode || !code || code.toUpperCase() === input.options.countryCode.toUpperCase();
  for (const query of accessRecoveryQueries(input.name, input.kind).slice(0, MAX_ACCESS_QUERIES)) {
    if (input.http) {
      placesCalls += 1;
      try {
        const hit = await resolveIdentity({ name: query, matchName: stem, near: anchor, radiusKm: Math.min(50, radiusKm), maxDistanceKm: radiusKm }, input.http);
        const kind = hit ? accessEvidence({ stem, resultName: hit.name, googleTypes: hit.types }) : null;
        if (hit && kind && countryOk(hit.countryCode) && near(hit.coordinates)) {
          queries.push({ provider: 'google-places', query, outcome: 'placed' });
          return { found: { coordinates: hit.coordinates, kind, provider: 'google-places', providerRef: hit.providerRef, query }, outcome: 'recovered_access_point', queries, placesCalls, geocoderCalls };
        }
        queries.push({ provider: 'google-places', query, outcome: hit ? (near(hit.coordinates) ? 'no_results' : 'outside_envelope') : 'no_results' });
      } catch {
        sawFailure = true;
        queries.push({ provider: 'google-places', query, outcome: 'provider_failure' });
      }
      continue;
    }
    geocoderCalls += 1;
    try {
      const result = await geocode(`${query}${input.country}`, { limit: 5 });
      const accepted = result.places
        .map((place) => ({ place, point: { lat: Number(place.lat), lng: Number(place.lon) }, kind: accessEvidence({ stem, resultName: place.name ?? place.display_name?.split(',')[0], osmClass: place.category, osmType: place.type }) }))
        .filter((row) => row.kind && Number.isFinite(row.point.lat) && Number.isFinite(row.point.lng) && countryOk(countryOf(row.place)) && near(row.point));
      if (accepted.length === 0) {
        queries.push({ provider: 'nominatim', query: `${query}${input.country}`, outcome: 'no_results' });
        continue;
      }
      const spread = accepted.some((row) => haversineKm(row.point, accepted[0]!.point) > ACCESS_AMBIGUITY_KM);
      if (spread) {
        sawAmbiguity = true;
        queries.push({ provider: 'nominatim', query: `${query}${input.country}`, outcome: 'no_results' });
        continue;
      }
      const best = accepted[0]!;
      queries.push({ provider: 'nominatim', query: `${query}${input.country}`, outcome: 'placed' });
      const name = best.place.name ?? best.place.display_name?.split(',')[0]?.trim();
      return { found: { coordinates: best.point, kind: best.kind!, provider: 'nominatim', query, ...(name ? { name } : {}) }, outcome: 'recovered_access_point', queries, placesCalls, geocoderCalls };
    } catch {
      sawFailure = true;
      queries.push({ provider: 'nominatim', query: `${query}${input.country}`, outcome: 'provider_failure' });
    }
  }
  return { found: null, outcome: sawAmbiguity ? 'ambiguous_access_point' : sawFailure && queries.every((q) => q.outcome === 'provider_failure') ? 'provider_failure' : 'no_access_point', queries, placesCalls, geocoderCalls };
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
