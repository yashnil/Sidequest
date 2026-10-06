import 'server-only';
import {
  assessConfidence,
  DESTINATION_RESOLUTION_VERSION,
  licence,
  normalizeDestinationQuery,
  resolveDisplayName,
  type ConfidenceSignal,
  type DataLicence,
  type DestinationCandidate,
  type DestinationResolution,
} from '@sidequest/core';
import type { DestinationResolver, RoutingProvider } from '@sidequest/compiler';
import { candidatesFromNominatim } from './names';
import { boundsOf, classifyNominatim, geocode, osmElementId, osmElementUrl, type NominatimPlace } from './nominatim';
import { computeMatrix as valhallaMatrix, computeRoute as valhallaRoute, costingFor, densify } from './valhalla';
import { isTimeZoneResolverEnabled, resolveCivilTimeZones, TIME_ZONE_TTL_MS } from './timezone';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';

/**
 * THE OPEN PROVIDERS THE CANONICAL TRIP NEEDS — WITHOUT THE RESEARCH MODEL.
 *
 * Composition needs nothing but a composer credential. Verification needs a
 * geocoder to put a typed destination on the map and a router to time the
 * legs that matter. Neither of those is the research model, and neither
 * should be reachable only through a factory that constructs one: the plan
 * page used to refuse to look a destination up unless
 * `SIDEQUEST_RESEARCH_PROVIDER=anthropic` was set, and the canonical build
 * could not reach Valhalla without the same switch. Both factories here are
 * pure functions of the adapters they name; `live.ts` (the optional
 * compilation stack) composes them with the model-corroborated extras.
 */

export const OSM_LICENCE_ROUTING: DataLicence = licence('ODbL-1.0', ['routing']);

/** Cache TTLs, matched to how fast the thing behind them actually changes. */
export const TTL = {
  geocode: 30 * 24 * 60 * 60 * 1000,
  poi: 7 * 24 * 60 * 60 * 1000,
  matrix: 14 * 24 * 60 * 60 * 1000,
} as const;

export function cacheFor<T>(provider: string, ttlMs: number) {
  return {
    read: (key: string): T | null => readProviderCache<T>(key, new Date()),
    write: (key: string, value: T): void => writeProviderCache(key, provider, value, ttlMs, new Date()),
  };
}

/** The counters both factories fill in. `LiveDiagnostics` satisfies this structurally. */
export interface VerificationDiagnostics {
  geocoderCalls: number;
  geocoderCacheHits: number;
  routeCalls: number;
  routePairs: number;
  routeCacheHits: number;
  timeZone: string | null;
}

export function emptyVerificationDiagnostics(): VerificationDiagnostics {
  return { geocoderCalls: 0, geocoderCacheHits: 0, routeCalls: 0, routePairs: 0, routeCacheHits: 0, timeZone: null };
}

/**
 * A zone, from a source that publishes zones. Never derived from an offset.
 */
export async function resolveTimeZone(lat: number, lng: number): Promise<string | null> {
  if (!isTimeZoneResolverEnabled()) return null;
  const outcome = await resolveCivilTimeZones([{ id: 'destination', lat, lng }], {
    maxCalls: 1,
    cache: cacheFor<{ timeZone: string }>('open-meteo-timezone', TIME_ZONE_TTL_MS),
  });
  return outcome.answers[0]?.timeZone ?? null;
}

/** Whether the geocoder actually returned what was asked for. The name is evidence only when it is actually the name. */
function isExactNameMatch(query: string, place: NominatimPlace): boolean {
  const wanted = normalizeDestinationQuery(query);
  const got = normalizeDestinationQuery(place.name ?? place.display_name.split(',')[0] ?? '');
  return wanted === got;
}

/**
 * V10 §2 — the published name of the first-level division a row sits in.
 *
 * Nominatim tags it `state` almost everywhere and `province` in a handful of
 * countries; both are the same tier. Read only to *name* a jurisdiction — never
 * to locate anything, and never as the destination.
 */
function firstLevelDivisionName(place: NominatimPlace): string | null {
  return place.address?.['state'] ?? place.address?.['province'] ?? null;
}

export function toCandidate(place: NominatimPlace, query: string): DestinationCandidate | null {
  const lat = Number(place.lat);
  const lng = Number(place.lon);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const { breadth, entityType } = classifyNominatim(place);
  const bounds = boundsOf(place);
  const country = place.address?.country;
  const countryCode = place.address?.country_code?.toUpperCase();

  const signals: ConfidenceSignal[] = [];
  if (isExactNameMatch(query, place)) signals.push('exact_name_match');
  else signals.push('name_match_partial');
  if (country) signals.push('administrative_hierarchy_match');
  if (bounds) signals.push('boundary_available');
  else signals.push('no_boundary_available');
  // One geocoder is one geocoder: a model agreeing a string looks place-like is not a second source.
  signals.push('single_provider_only');

  const elementId = osmElementId(place);

  return {
    id: elementId ?? `nominatim-${place.place_id ?? `${lat},${lng}`}`,
    displayName: resolveDisplayName({
      candidates: candidatesFromNominatim(place),
      fallback: place.display_name.split(',')[0]?.trim() ?? place.display_name,
    }).display,
    qualifiedName: place.display_name,
    entityType,
    breadth,
    center: { lat, lng },
    ...(bounds ? { bounds } : {}),
    ...(countryCode && countryCode.length === 2 ? { countryCode } : {}),
    ...(country ? { countryName: country } : {}),
    ...(place.address?.['ISO3166-2-lvl4'] ? { regionCode: place.address['ISO3166-2-lvl4']! } : {}),
    ...(firstLevelDivisionName(place) ? { regionName: firstLevelDivisionName(place)! } : {}),
    aliases: candidatesFromNominatim(place).map((entry) => entry.value),
    administrativeAreas: Object.entries(place.address ?? {})
      .filter(([key]) => ['country', 'state', 'region', 'county', 'city', 'town'].includes(key))
      .map(([, value]) => value),
    timeZones: [],
    providerRefs: [
      {
        provider: 'openstreetmap',
        externalId: elementId ?? String(place.place_id ?? ''),
        ...(osmElementUrl(place) ? { url: osmElementUrl(place)! } : {}),
      },
    ],
    confidence: assessConfidence(signals),
    /* V8.1 — the row's own class travels with the candidate so the semantic gate can read it. */
    providerClass: {
      ...(place.osm_type === 'node' || place.osm_type === 'way' || place.osm_type === 'relation' ? { osmType: place.osm_type } : {}),
      ...(place.category ? { category: place.category } : {}),
      ...(place.type ? { type: place.type } : {}),
      ...(typeof place.place_rank === 'number' ? { rank: Math.max(0, Math.min(40, Math.round(place.place_rank))) } : {}),
    },
  };
}

function insideBounds(point: { lat: number; lng: number }, bounds: NonNullable<DestinationCandidate['bounds']>): boolean {
  return point.lat >= bounds.southWest.lat && point.lat <= bounds.northEast.lat && point.lng >= bounds.southWest.lng && point.lng <= bounds.northEast.lng;
}

/**
 * V7 §2 — a state-typed leading row that the same answer also carries as a
 * city of the same name inside its box is a city-region. Shared with the
 * recorded resolver so the corpus reads Chongqing the way production does.
 */
export function promoteMunicipalityInPlace(candidates: DestinationCandidate[], query: string): boolean {
  const lead = candidates[0];
  if (!lead || lead.entityType !== 'state_or_province' || !lead.bounds) return false;
  const sibling = candidates.slice(1).find((c) => c.entityType === 'city' && normalizeDestinationQuery(c.displayName) === normalizeDestinationQuery(query) && insideBounds(c.center, lead.bounds!));
  if (!sibling) return false;
  candidates[0] = { ...lead, entityType: 'municipality', note: 'Published both as a first-level division and as a city of the same name inside it.' };
  return true;
}

/**
 * The Nominatim resolver. `corroborate` is the optional model reading the
 * compilation stack adds ("does this string look like a place at all"); the
 * canonical path passes nothing and spends nothing.
 */
export function createOpenResolver(input: {
  diagnostics: VerificationDiagnostics;
  corroborate?: (query: string) => Promise<{ looksLikeAPlace: boolean } | null>;
}): DestinationResolver {
  const { diagnostics } = input;
  return {
    name: 'nominatim',
    async resolve({ query }) {
      const result = await geocode(query, { limit: 5, cache: cacheFor<NominatimPlace[]>('nominatim', TTL.geocode) });
      diagnostics.geocoderCalls += result.calls;
      if (result.cacheHit) diagnostics.geocoderCacheHits += 1;

      let interpretation: { looksLikeAPlace: boolean } | null = null;
      if (input.corroborate) {
        try {
          interpretation = await input.corroborate(query);
        } catch {
          interpretation = null;
        }
      }

      const candidates = result.places
        .map((place) => toCandidate(place, query))
        .filter((candidate): candidate is DestinationCandidate => candidate !== null);

      /*
       * V7 §2 — A STATE-TYPED RECORD THAT IS ALSO A SETTLEMENT IS A CITY-REGION.
       *
       * A direct-administered municipality comes back typed `state` and was read
       * as "a state or province you drive across". The evidence that it is a city
       * is the geocoder's own: asked for settlements only, it returns a populated
       * place of the same name inside the division's box. One extra call, only
       * for a state-typed leading answer, cached like every other.
       */
      const lead = candidates[0];
      /* The same answer often carries the city itself (Chongqing the node inside Chongqing the division): that is the corroboration, with no extra call. */
      if (lead && promoteMunicipalityInPlace(candidates, query)) {
        /* promoted */
      } else if (lead && lead.entityType === 'state_or_province' && lead.bounds) {
        try {
          const settlements = await geocode(query, { limit: 3, featureType: 'settlement', cache: cacheFor<NominatimPlace[]>('nominatim', TTL.geocode) });
          diagnostics.geocoderCalls += settlements.calls;
          if (settlements.cacheHit) diagnostics.geocoderCacheHits += 1;
          const inside = settlements.places.find((place) => {
            const lat = Number(place.lat);
            const lng = Number(place.lon);
            /*
             * V1 — the corroboration has to be a city, not the division again.
             * Asked for settlements, the geocoder answers "Utah" with the Utah
             * state record itself; matching it against its own box promoted a
             * state to a city-region. Chongqing's evidence is a separate row
             * typed city.
             */
            const settlementType = (place.addresstype ?? place.type ?? '').toLowerCase();
            const isSettlement = ['city', 'town', 'municipality'].includes(settlementType) || ['city', 'town'].includes((place.extratags?.place ?? '').toLowerCase());
            return isSettlement && isExactNameMatch(query, place) && lat >= lead.bounds!.southWest.lat && lat <= lead.bounds!.northEast.lat && lng >= lead.bounds!.southWest.lng && lng <= lead.bounds!.northEast.lng;
          });
          if (inside) candidates[0] = { ...lead, entityType: 'municipality', note: 'Published both as a first-level division and as a city of the same name inside it.' };
        } catch {
          /* The division stands as typed; a corroboration that failed is not evidence either way. */
        }
      }

      const ambiguityReasons: DestinationResolution['ambiguityReasons'] = [];
      if (candidates.length === 0) ambiguityReasons.push('no_match');
      if (candidates.length > 1) ambiguityReasons.push('multiple_matching_places');
      if (interpretation && !interpretation.looksLikeAPlace) ambiguityReasons.push('query_is_not_a_place');
      const leading = candidates[0];
      if (leading?.breadth === 'country' || leading?.breadth === 'multi_country') ambiguityReasons.push('administrative_area_needs_subset');
      if (leading && !leading.bounds) ambiguityReasons.push('no_boundary_available');

      if (leading) {
        const zone = await resolveTimeZone(leading.center.lat, leading.center.lng);
        diagnostics.timeZone = zone;
        if (zone) {
          // The leading candidate only: one coordinate was looked up, and a zone is a claim about one place.
          leading.timeZones = [zone];
          leading.timeZoneSource = 'open-meteo';
          leading.timeZoneResolvedAt = new Date().toISOString();
        }
      }

      const unambiguous = candidates.length === 1 && ambiguityReasons.length === 0 ? candidates[0]?.id : undefined;
      return {
        schemaVersion: DESTINATION_RESOLUTION_VERSION,
        query,
        normalizedQuery: normalizeDestinationQuery(query),
        candidates,
        ambiguityReasons,
        ...(unambiguous ? { unambiguousCandidateId: unambiguous } : {}),
        providersConsulted: input.corroborate ? ['nominatim', 'anthropic'] : ['nominatim'],
        resolvedAt: new Date().toISOString(),
      };
    },
  };
}

/** The Valhalla road router: car and foot, matrix and direct route. Transit is measured by the transit seam or not at all. */
export function createOpenRouting(diagnostics: VerificationDiagnostics): RoutingProvider {
  return {
    name: 'valhalla',
    supportedModes() {
      return ['car', 'foot'];
    },
    async matrix({ points, mode, maxElements }) {
      if (mode === 'transit') {
        throw new Error('The road router was asked for a public-transport journey. Transit is measured by the transit provider or reported as unavailable.');
      }
      const outcome = await valhallaMatrix([...points], costingFor(mode), {
        maxPairs: maxElements,
        cache: cacheFor<{ minutes: number; km: number }>('valhalla', TTL.matrix),
      });
      diagnostics.routeCalls += outcome.calls;
      diagnostics.routePairs += outcome.pairs;
      diagnostics.routeCacheHits += outcome.cacheHits;
      const dense = densify(outcome);
      return {
        licences: [OSM_LICENCE_ROUTING],
        ids: dense.ids,
        minutes: dense.minutes,
        km: dense.km,
        provenance: {
          kind: 'measured' as const,
          note: `Measured ${mode === 'car' ? 'driving' : 'walking'} times from a Valhalla routing engine over OpenStreetMap data.`,
          source: 'Valhalla / OpenStreetMap',
        },
        failedPairs: outcome.failedPairs,
        calls: outcome.calls,
        elements: outcome.pairs,
        circuitOpened: outcome.circuitOpened,
        reasonCounts: outcome.reasonCounts,
      };
    },
    async route({ from, to, mode }) {
      if (mode === 'transit') return { found: false, minutes: null, km: null, reason: 'provider_error' };
      const startedAt = performance.now();
      const result = await valhallaRoute({ id: 'from', ...from }, { id: 'to', ...to }, costingFor(mode));
      diagnostics.routeCalls += 1;
      return { ...result, latencyMs: Math.round(performance.now() - startedAt) };
    },
  };
}
