import 'server-only';
import {
  assessConfidence,
  DESTINATION_RESOLUTION_VERSION,
  licence,
  normalizeDestinationQuery,
  type ConfidenceSignal,
  type DataLicence,
  type DestinationCandidate,
  type DestinationResolution,
  type Place,
  type WeatherLocation,
} from '@sidequest/core';
import type {
  CompilerProviders,
  ConstraintResearchProvider,
  DestinationResolver,
  DiscoveredCandidate,
  FoodDiscoveryProvider,
  PlaceDiscoveryProvider,
  ProviderGap,
  RegionExpansionProvider,
  RoutingProvider,
  WeatherLocationProvider,
} from '@sidequest/compiler';
import {
  boundsOf,
  classifyNominatim,
  geocode,
  isGeocoderEnabled,
  osmElementId,
  osmElementUrl,
  type NominatimPlace,
} from './nominatim';
import {
  boxAreaDeg2,
  fetchPois,
  isPoiProviderEnabled,
  WAY_QUERY_AREA_LIMIT_DEG2,
  normalizeElement,
  type BoundingBox,
  type NormalizedOsmPlace,
} from './overpass';
import {
  computeMatrix as valhallaMatrix,
  costingFor,
  densify,
  isRoutesProviderEnabled,
} from './valhalla';
import {
  classifyPlaces,
  interpretDestination,
  isResearchModelConfigured,
  proposeExpansion,
  ResearchModel,
  type ModelUsage,
} from './anthropic';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';

/**
 * THE OPEN-LICENSED PROVIDER SET.
 *
 * Nominatim resolves the name, Overpass says what is there, Valhalla says how
 * long it takes to get between things, Anthropic says what kind of thing each
 * one is, and Open-Meteo says what the sky will do. Every durable fact in a
 * compiled region comes from a source whose licence permits us to keep it — and
 * carries the licence with it, because ODbL's attribution obligation is met by
 * rendering data rather than by remembering to write a footer.
 *
 * The division of labour is the same one the architecture has always rested on.
 * OpenStreetMap knows a waterfall exists at a coordinate and cannot say whether
 * it is a five-minute stop or a four-hour walk. A model can judge that and
 * cannot be trusted to know the waterfall is there. Neither is asked to do the
 * other's job, and everything either produces is checked before it becomes a
 * `Place`.
 */

const OSM_LICENCE_PLACES: DataLicence = licence('ODbL-1.0', ['places', 'geography']);
const OSM_LICENCE_ROUTING: DataLicence = licence('ODbL-1.0', ['routing']);
const AUTHORED_LICENCE: DataLicence = licence('sidequest-authored', [
  'descriptions',
  'classification',
  'scoring',
]);

export interface LiveDiagnostics {
  geocoderCalls: number;
  geocoderCacheHits: number;
  poiCalls: number;
  poiCacheHits: number;
  poiElements: number;
  routeCalls: number;
  routePairs: number;
  routeCacheHits: number;
  model: ModelUsage;
  timeZone: string | null;
  attributions: string[];
}

/** How long the discovery stage may spend before it reports what it has. */
const POI_STAGE_BUDGET_MS = 75_000;

/** Cache TTLs, matched to how fast the thing behind them actually changes. */
const TTL = {
  geocode: 30 * 24 * 60 * 60 * 1000,
  poi: 7 * 24 * 60 * 60 * 1000,
  matrix: 14 * 24 * 60 * 60 * 1000,
} as const;

function cacheFor<T>(provider: string, ttlMs: number) {
  return {
    read: (key: string): T | null => readProviderCache<T>(key, new Date()),
    write: (key: string, value: T): void =>
      writeProviderCache(key, provider, value, ttlMs, new Date()),
  };
}

/** A zone, from a source that publishes zones. Never derived from an offset. */
async function resolveTimeZone(lat: number, lng: number): Promise<string | null> {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lng));
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');
    const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { timezone?: string };
    return typeof body.timezone === 'string' && body.timezone.length > 0 ? body.timezone : null;
  } catch {
    return null;
  }
}

/**
 * Whether the geocoder actually returned what was asked for.
 *
 * Asserted unconditionally at first, which is how "inland Alaska" came back as
 * "Inland Lake" carrying an `exact_name_match` signal — three positives, no
 * negatives, high confidence, silently adopted. The name is evidence only when
 * it is actually the name.
 */
function isExactNameMatch(query: string, place: NominatimPlace): boolean {
  const wanted = normalizeDestinationQuery(query);
  const got = normalizeDestinationQuery(place.name ?? place.display_name.split(',')[0] ?? '');
  return wanted === got;
}

function toCandidate(
  place: NominatimPlace,
  query: string,
  onlyResult: boolean,
): DestinationCandidate | null {
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
  /**
   * One geocoder is one geocoder.
   *
   * A model agreeing that a string looks place-like is not a second source
   * finding the same place, and recording it as `multiple_providers_agree` was
   * an overstatement that pushed single-source results to high confidence and
   * skipped the screen where a traveller would have caught them.
   */
  signals.push('single_provider_only');
  void onlyResult;

  const elementId = osmElementId(place);

  return {
    id: elementId ?? `nominatim-${place.place_id ?? `${lat},${lng}`}`,
    displayName: place.name ?? place.display_name.split(',')[0]?.trim() ?? place.display_name,
    qualifiedName: place.display_name,
    entityType,
    breadth,
    center: { lat, lng },
    ...(bounds ? { bounds } : {}),
    ...(countryCode && countryCode.length === 2 ? { countryCode } : {}),
    ...(country ? { countryName: country } : {}),
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
  };
}

export function createOpenProviders(limits: { maxModelCalls: number }): {
  providers: CompilerProviders;
  diagnostics: LiveDiagnostics;
} {
  const model = new ResearchModel({ maxCalls: limits.maxModelCalls });
  const diagnostics: LiveDiagnostics = {
    geocoderCalls: 0,
    geocoderCacheHits: 0,
    poiCalls: 0,
    poiCacheHits: 0,
    poiElements: 0,
    routeCalls: 0,
    routePairs: 0,
    routeCacheHits: 0,
    model: model.usage,
    timeZone: null,
    attributions: [OSM_LICENCE_PLACES.attribution],
  };

  const resolver: DestinationResolver = {
    name: 'nominatim',
    async resolve({ query }) {
      const result = await geocode(query, {
        limit: 5,
        cache: cacheFor<NominatimPlace[]>('nominatim', TTL.geocode),
      });
      diagnostics.geocoderCalls += result.calls;
      if (result.cacheHit) diagnostics.geocoderCacheHits += 1;

      // The model corroborates; it does not resolve. Losing it costs an
      // ambiguity signal, not the answer.
      let interpretation: Awaited<ReturnType<typeof interpretDestination>> | null;
      try {
        interpretation = await interpretDestination(model, query);
      } catch {
        interpretation = null;
      }

      const candidates = result.places
        .map((place) => toCandidate(place, query, result.places.length === 1))
        .filter((candidate): candidate is DestinationCandidate => candidate !== null);

      const ambiguityReasons: DestinationResolution['ambiguityReasons'] = [];
      if (candidates.length === 0) ambiguityReasons.push('no_match');
      if (candidates.length > 1) ambiguityReasons.push('multiple_matching_places');
      if (interpretation && !interpretation.looksLikeAPlace) {
        ambiguityReasons.push('query_is_not_a_place');
      }
      const leading = candidates[0];
      if (leading?.breadth === 'country' || leading?.breadth === 'multi_country') {
        ambiguityReasons.push('administrative_area_needs_subset');
      }
      if (leading && !leading.bounds) ambiguityReasons.push('no_boundary_available');

      if (leading) {
        const zone = await resolveTimeZone(leading.center.lat, leading.center.lng);
        diagnostics.timeZone = zone;
        if (zone) for (const candidate of candidates) candidate.timeZones = [zone];
      }

      const unambiguous =
        candidates.length === 1 && ambiguityReasons.length === 0 ? candidates[0]?.id : undefined;

      return {
        schemaVersion: DESTINATION_RESOLUTION_VERSION,
        query,
        normalizedQuery: normalizeDestinationQuery(query),
        candidates,
        ambiguityReasons,
        ...(unambiguous ? { unambiguousCandidateId: unambiguous } : {}),
        providersConsulted: ['nominatim', 'anthropic'],
        resolvedAt: new Date().toISOString(),
      };
    },
  };

  const expansion: RegionExpansionProvider = {
    name: 'anthropic-expansion',
    async expand({ scope, nights, maxBases, maxSubregions }) {
      const gaps: ProviderGap[] = [];
      let proposal: Awaited<ReturnType<typeof proposeExpansion>>;
      try {
        proposal = await proposeExpansion(model, {
          destination: scope.destinationName,
          nights,
          maxBases,
          maxSubregions,
          carAvailable: scope.transport.carAvailable,
        });
      } catch {
        gaps.push({
          subjectId: scope.destinationCandidateId,
          reason: 'provider_error',
          detail: 'The research model did not answer, so the destination itself is the base.',
        });
        proposal = { subregions: [], bases: [] };
      }

      /**
       * Every proposed base is geocoded before it becomes one.
       *
       * This is what makes letting a model propose safe at all: a town it
       * invented does not resolve, so it never reaches the compiled region. It
       * also means each base gets a real OSM element id, which is what the
       * attribution obligation attaches to.
       */
      const bases: Awaited<ReturnType<RegionExpansionProvider['expand']>>['bases'] = [];
      for (const candidate of proposal.bases.slice(0, maxBases)) {
        try {
          const found = await geocode(`${candidate.name}, ${scope.destinationName}`, {
            limit: 1,
            cache: cacheFor<NominatimPlace[]>('nominatim', TTL.geocode),
          });
          diagnostics.geocoderCalls += found.calls;
          if (found.cacheHit) diagnostics.geocoderCacheHits += 1;

          const first = found.places[0];
          const lat = first ? Number(first.lat) : Number.NaN;
          const lng = first ? Number(first.lon) : Number.NaN;
          if (!first || Number.isNaN(lat) || Number.isNaN(lng)) {
            gaps.push({
              subjectId: candidate.name,
              reason: 'not_found',
              detail: 'A proposed base did not resolve to a real place, so it was dropped.',
            });
            continue;
          }
          bases.push({
            id: osmElementId(first) ?? `base-${candidate.name}`,
            name: first.name ?? candidate.name,
            coordinates: { lat, lng },
            timeZone: diagnostics.timeZone ?? scope.timeZones[0] ?? 'UTC',
            suggestedNights: {
              min: Math.max(1, candidate.suggestedMinNights),
              max: Math.max(1, candidate.suggestedMaxNights),
            },
            transportModes: scope.transport.carAvailable
              ? ['drive', 'walk']
              : ['walk', 'public_bus', 'rail'],
            rationale: candidate.rationale,
            tradeoffs: candidate.tradeoffs,
          });
        } catch {
          gaps.push({
            subjectId: candidate.name,
            reason: 'provider_error',
            detail: 'The geocoder did not answer for a proposed base.',
          });
        }
      }

      if (bases.length === 0) {
        bases.push({
          id: `base-${scope.destinationCandidateId}`,
          name: scope.destinationName,
          coordinates: scope.center,
          timeZone: diagnostics.timeZone ?? scope.timeZones[0] ?? 'UTC',
          suggestedNights: { min: 1, max: Math.max(1, nights) },
          transportModes: scope.transport.carAvailable
            ? ['drive', 'walk']
            : ['walk', 'public_bus', 'rail'],
          rationale: 'The destination itself, which is where the trip is anchored.',
          tradeoffs: [],
        });
      }

      return {
        bases,
        subregions: proposal.subregions.slice(0, maxSubregions).map((subregion, index) => ({
          id: `sub-${index}`,
          name: subregion.name,
          summary: subregion.summary,
          center: scope.center,
          radiusKm: 40,
          suggestedNights: {
            min: Math.max(0, subregion.suggestedMinNights),
            max: Math.max(0, subregion.suggestedMaxNights),
          },
        })),
        gaps,
        calls: model.usage.calls,
      };
    },
  };

  const places: PlaceDiscoveryProvider = {
    name: 'overpass',
    async discover({ scope, queries }) {
      const gaps: ProviderGap[] = [];
      const radiusKm = scope.shape.kind === 'radius' ? scope.shape.radiusKm : 40;

      const box: BoundingBox =
        scope.bounds !== undefined
          ? {
              south: scope.bounds.southWest.lat,
              west: scope.bounds.southWest.lng,
              north: scope.bounds.northEast.lat,
              east: scope.bounds.northEast.lng,
            }
          : {
              south: scope.center.lat - radiusKm / 111,
              north: scope.center.lat + radiusKm / 111,
              west:
                scope.center.lng -
                radiusKm / (111 * Math.max(0.1, Math.cos((scope.center.lat * Math.PI) / 180))),
              east:
                scope.center.lng +
                radiusKm / (111 * Math.max(0.1, Math.cos((scope.center.lat * Math.PI) / 180))),
            };

      const wanted = queries.reduce((total, query) => total + query.limit, 0);

      let normalized: NormalizedOsmPlace[];
      try {
        const result = await fetchPois(box, {
          limit: Math.min(400, Math.max(40, wanted)),
          // One shot per endpoint, and a hard ceiling on the whole stage. A
          // traveller waiting five minutes for a map service to change its mind
          // is worse served than one told the region came back thin.
          retries: 0,
          deadlineMs: Date.now() + POI_STAGE_BUDGET_MS,
          cache: cacheFor('overpass', TTL.poi),
        });
        diagnostics.poiCalls += result.calls;
        if (result.cacheHit) diagnostics.poiCacheHits += 1;
        diagnostics.poiElements += result.elements.length;

        if (boxAreaDeg2(box) > WAY_QUERY_AREA_LIMIT_DEG2) {
          gaps.push({
            subjectId: scope.destinationCandidateId,
            reason: 'insufficient_evidence',
            detail:
              'This area is large enough that we asked the map data for points only, so places mapped as building or park outlines were not returned.',
          });
        }

        if (result.failedGroups.length > 0) {
          gaps.push({
            subjectId: scope.destinationCandidateId,
            reason: 'rate_limited',
            detail: `The map data service refused ${result.failedGroups.length} of ${result.failedGroups.length + 1} searches (${result.failedGroups.join(', ')}), so this region is thinner than it should be.`,
          });
        }

        normalized = result.elements
          .map(normalizeElement)
          .filter((entry): entry is NormalizedOsmPlace => entry !== null);
      } catch (error) {
        gaps.push({
          subjectId: scope.destinationCandidateId,
          reason:
            error instanceof Error && error.message.includes('busy') ? 'rate_limited' : 'provider_error',
          detail: 'The map data service did not answer, so nothing new was discovered.',
        });
        return { candidates: [], gaps, calls: diagnostics.poiCalls, licences: [OSM_LICENCE_PLACES] };
      }

      if (normalized.length === 0) {
        gaps.push({
          subjectId: scope.destinationCandidateId,
          reason: 'not_found',
          detail: 'The map data has nothing named in that area that we plan around.',
        });
        return { candidates: [], gaps, calls: diagnostics.poiCalls, licences: [OSM_LICENCE_PLACES] };
      }

      // Bounded before classification: the model call is the expensive one, and
      // a bbox in a dense city returns far more than a trip can hold.
      const shortlist = normalized.slice(0, Math.min(120, Math.max(20, wanted)));

      let classified: Awaited<ReturnType<typeof classifyPlaces>>;
      try {
        classified = await classifyPlaces(
          model,
          shortlist.map((entry) => ({
            name: entry.name,
            types: [entry.primaryTag, ...Object.keys(entry.planningTags)],
            locality: scope.destinationName,
          })),
        );
      } catch {
        return {
          candidates: [],
          gaps: [
            ...gaps,
            {
              subjectId: scope.destinationCandidateId,
              reason: 'provider_error',
              detail: 'Nothing could be classified, so nothing was kept rather than guessed at.',
            },
          ],
          calls: diagnostics.poiCalls,
          licences: [OSM_LICENCE_PLACES],
        };
      }

      const candidates: DiscoveredCandidate[] = [];
      for (const entry of classified.places) {
        const osm = shortlist[entry.index];
        if (!osm) continue;

        /**
         * Popularity and hidden-gem, from what OSM actually carries.
         *
         * OSM has no rating and no review count, which is a feature here rather
         * than a gap: there is no popularity number to mistake for quality. What
         * it does have is how completely an element is tagged — a place many
         * mappers have cared about carries a website, an operator, opening
         * hours. That is a weak proxy and it is labelled as one; it never
         * outranks the traveller's own stated preferences.
         */
        const tagRichness = Math.min(1, Object.keys(osm.planningTags).length / 5);
        const popularity = Math.min(0.9, 0.25 + tagRichness * 0.5);
        const hiddenGem = Math.max(0.1, 1 - popularity - 0.1);

        const place: Place = {
          id: `osm-${osm.elementId.replace('/', '-')}`,
          regionId: `compiled-${scope.destinationCandidateId}`,
          name: osm.name,
          locality: scope.destinationName,
          shortDescription: entry.shortDescription.slice(0, 280),
          coordinates: osm.coordinates,
          tags: [osm.primaryTag],
          source: {
            name: 'OpenStreetMap',
            kind: 'osm',
            url: osm.url,
            confidence: 0.7,
            lastVerified: new Date().toISOString().slice(0, 10),
            element: {
              elementId: osm.elementId,
              database: 'openstreetmap',
              licenceId: 'ODbL-1.0',
              ...(osm.sourceTimestamp ? { sourceTimestamp: osm.sourceTimestamp } : {}),
              url: osm.url,
            },
          },
          relationship: 'satellite',
          category: entry.category,
          interests: entry.interests.length > 0 ? entry.interests : ['scenic_viewpoints'],
          typicalDurationMinutes: Math.min(600, Math.max(15, entry.typicalDurationMinutes)),
          costLevel: Math.min(3, Math.max(0, entry.costLevel)) as 0 | 1 | 2 | 3,
          physicalIntensity: entry.physicalIntensity,
          crowdLevel: popularity > 0.7 ? 'busy' : 'quiet',
          popularityScore: popularity,
          hiddenGemScore: hiddenGem,
          weather: {
            exposure: entry.exposure,
            precipitation: entry.exposure === 'indoor' ? 'low' : 'high',
            wind: entry.exposure === 'exposed_outdoor' ? 'moderate' : 'low',
            heat: entry.exposure === 'indoor' ? 'low' : 'moderate',
            cold: entry.exposure === 'indoor' ? 'low' : 'moderate',
            visibilityDependent: entry.visibilityDependent,
            poorWeatherBackup: entry.poorWeatherBackup,
            approachDegradesWhenWet: false,
          },
          bestTimeOfDay: 'any',
          seasonalAccess: {
            openMonths:
              entry.openMonths.length > 0
                ? entry.openMonths
                : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            closureRisk: entry.openMonths.length < 12 ? 'seasonal' : 'none',
          },
          access: {
            roadSurface: 'paved',
            mountainRoad: false,
            parkingDifficulty: scope.transport.carAvailable ? 'moderate' : 'hard',
            remoteNoServices: false,
          },
          travelFromBase: { distanceKm: 0, driveMinutes: 0, driveIsScenic: false },
        };

        candidates.push({
          place,
          providerRefs: [
            { provider: 'openstreetmap', externalId: osm.elementId, url: osm.url },
          ],
          facts: [],
          confidenceSignals:
            Object.keys(osm.planningTags).length >= 2
              ? ['multiple_providers_agree']
              : ['single_provider_only'],
        });
      }

      return {
        candidates,
        gaps,
        calls: diagnostics.poiCalls,
        licences: [OSM_LICENCE_PLACES, AUTHORED_LICENCE],
      };
    },
  };

  /**
   * Access from what the map data says, and hours only where OSM publishes them.
   *
   * `opening_hours` is a real OSM tag and one we may keep, but it is a
   * mapper-maintained string in a grammar this slice does not parse — so it is
   * recorded as a gap and every such place gets an `unknown` calendar rather
   * than a guess. Official-source research through the SSRF-safe layer is what
   * closes that, and it is the next slice.
   */
  const constraints: ConstraintResearchProvider = {
    name: 'osm-constraints',
    async research({ places: subjects, scope }) {
      return {
        calendars: [],
        accessRules: subjects.map((subject, index) => ({
          id: `rule-${index}`,
          label: `Access to ${subject.name}`,
          placeIds: [subject.id],
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
          approachMode: scope.transport.carAvailable ? ('drive' as const) : ('walk' as const),
          ...(scope.transport.carAvailable ? {} : { approachMinutes: 10 }),
          privateVehicle: 'allowed' as const,
          serviceRequirement: 'none' as const,
          walkMinutesFromDropOff: 5,
          internalTransfer: { mode: 'walk' as const, minutes: 0 },
          permitRequired: false,
          notes: [],
          provenance: {
            kind: 'estimated' as const,
            sourceName: 'OpenStreetMap, via a routable location',
            confidence: 0.4,
            volatility: 'dynamic' as const,
            recheckNote:
              'We know a routing engine can reach this, not that it is open to the public on your dates. Check before you go.',
          },
        })),
        services: [],
        facts: [],
        gaps: subjects.map((subject) => ({
          subjectId: subject.id,
          reason: 'no_official_source' as const,
          detail: 'Opening hours were not researched against the operator’s own page.',
        })),
        calls: 0,
        pagesFetched: 0,
      };
    },
  };

  const routing: RoutingProvider = {
    name: 'valhalla',
    supportedModes() {
      return ['car', 'foot'];
    },
    async matrix({ points, mode, maxElements }) {
      const outcome = await valhallaMatrix([...points], costingFor(mode), {
        maxPairs: maxElements,
        cache: cacheFor('valhalla', TTL.matrix),
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
        failedPairs: outcome.failedPairs.map((pair) => ({ ...pair, reason: 'not_found' as const })),
        calls: outcome.calls,
        elements: outcome.pairs,
      };
    },
  };

  const weatherLocations: WeatherLocationProvider = {
    name: 'banded-weather-points',
    async plan({ scope, places: subjects, maxLocations }) {
      if (subjects.length === 0 || maxLocations <= 0) {
        return {
          locations: [],
          gaps: [{ subjectId: 'weather', reason: 'not_found', detail: 'Nothing to forecast.' }],
          calls: 0,
        };
      }

      // Banded by latitude, one point per band. A global forecast model resolves
      // to roughly ten kilometres, so a point per stop would imply a precision
      // that does not exist — and every place is claimed exactly once, which the
      // integrity gate insists on.
      const count = Math.max(1, Math.min(maxLocations, Math.ceil(subjects.length / 6)));
      const sorted = [...subjects].sort((a, b) => a.coordinates.lat - b.coordinates.lat);
      const buckets: Place[][] = Array.from({ length: count }, () => []);
      sorted.forEach((place, index) => {
        buckets[Math.min(count - 1, Math.floor((index / sorted.length) * count))]?.push(place);
      });

      /**
       * The zone off the scope, not off this instance's diagnostics.
       *
       * Resolution and compilation are separate requests, so a provider set
       * built for the compile has never called the timezone lookup — reading it
       * from here gave every compiled region `UTC`, which quietly moved sunrise,
       * sunset and every daylight-only visit by the offset. The scope carries the
       * zone that was actually resolved, and it is the durable answer.
       */
      const zone = scope.timeZones[0] ?? diagnostics.timeZone ?? 'UTC';
      const locations: WeatherLocation[] = buckets
        .filter((bucket) => bucket.length > 0)
        .map((bucket, index) => ({
          id: `weather-${index}`,
          label: `Forecast point ${index + 1}`,
          coordinates: {
            lat: bucket.reduce((sum, place) => sum + place.coordinates.lat, 0) / bucket.length,
            lng: bucket.reduce((sum, place) => sum + place.coordinates.lng, 0) / bucket.length,
          },
          elevationMetres: 0,
          timeZone: zone,
          placeIds: bucket.map((place) => place.id),
          limitation:
            'One forecast point standing for a band of this region. Elevation is not modelled here, so a high stop will run colder than this number.',
        }));

      return { locations, gaps: [], calls: 0 };
    },
  };

  const food: FoodDiscoveryProvider = {
    name: 'food-not-live',
    async discover() {
      // Food needs confirmed opening hours to be worth anything — the food layer
      // already refuses to schedule a venue whose hours nobody verified. Until
      // official-source research lands, every meal is time held rather than
      // somewhere named, which is a behaviour the product already explains.
      return {
        venues: [],
        gaps: [
          {
            subjectId: 'food',
            reason: 'no_official_source',
            detail:
              'Food discovery is not live yet, so meals are time held rather than somewhere named.',
          },
        ],
        calls: 0,
      };
    },
  };

  return {
    providers: { resolver, expansion, places, constraints, routing, weatherLocations, food },
    diagnostics,
  };
}

/**
 * Whether the open stack is switched on.
 *
 * All four must be, and each defaults to off. A partially configured stack is
 * refused rather than half-run: a compilation with no routing provider produces
 * a region the planner cannot use, and finding that out three stages in wastes
 * the model calls that came before it.
 */
export function openProvidersEnabled(): boolean {
  return (
    isGeocoderEnabled() &&
    isPoiProviderEnabled() &&
    isRoutesProviderEnabled() &&
    isResearchModelConfigured() &&
    process.env.SIDEQUEST_RESEARCH_PROVIDER?.trim().toLowerCase() === 'anthropic'
  );
}

export function missingProviderSwitches(): string[] {
  const missing: string[] = [];
  if (!isGeocoderEnabled()) missing.push('SIDEQUEST_GEOCODER_PROVIDER=nominatim');
  if (!isPoiProviderEnabled()) missing.push('SIDEQUEST_POI_PROVIDER=overpass');
  if (!isRoutesProviderEnabled()) missing.push('SIDEQUEST_ROUTES_PROVIDER=valhalla');
  if (process.env.SIDEQUEST_RESEARCH_PROVIDER?.trim().toLowerCase() !== 'anthropic') {
    missing.push('SIDEQUEST_RESEARCH_PROVIDER=anthropic');
  }
  return missing;
}
