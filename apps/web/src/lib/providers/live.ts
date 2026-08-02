import 'server-only';
import {
  assessConfidence,
  DESTINATION_RESOLUTION_VERSION,
  licence,
  normalizeDestinationQuery,
  operatingCalendarSchema,
  parseOsmOpeningHours,
  type AdmissionRequirement,
  type ConfidenceSignal,
  type DataLicence,
  type DestinationCandidate,
  type DestinationResolution,
  type FoodVenue,
  type GeographicScope,
  type OperatingCalendar,
  type Place,
  type WeatherLocation,
} from '@sidequest/core';
import { buildInventory, foodVenueFromRecord, type InventoryResult } from '@sidequest/compiler';
import type { SourceRecord } from '@sidequest/core';
import type {
  CompilerProviders,
  ConstraintResearchProvider,
  DestinationResolver,
  DiscoveredCandidate,
  ExtractedClaim,
  FactExtractionProvider,
  FoodDiscoveryProvider,
  PlaceDiscoveryProvider,
  ProviderGap,
  RegionExpansionProvider,
  RetrievedDocument,
  RoutingProvider,
  SourceDiscoveryProvider,
  SourceReference,
  SourceRetrievalProvider,
  SourceRetrievalResult,
  WeatherLocationProvider,
} from '@sidequest/compiler';
import {
  extractReadableText,
  fetchIfAllowed,
  UnsafeUrlError,
} from '../net/safe-fetch';
import {
  classifyAuthority,
  extractJsonLd,
  hashText,
  hoursFromJsonLd,
  publishedAtFrom,
  stripBoilerplate,
} from '../net/structured';
import { fetchWikidataFacts } from './wikidata';
import { isPlaceBackboneEnabled } from './overture/catalog';
import { createCachedPackProvider } from './overture/cached';
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
  fetchFoodPois,
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
  DEFAULT_MODEL,
  extractPlanningFacts,
  interpretDestination,
  isResearchModelConfigured,
  PROMPT_VERSIONS,
  proposeExpansion,
  ResearchModel,
  type ModelUsage,
  type PlanningExtraction,
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
  /** Free structured lookups. Every one of these is a search not bought. */
  wikidataCalls: number;
  /** Billed searches. The most expensive counter in a compilation. */
  sourceSearches: number;
  pagesFetched: number;
  pagesRejected: number;
  model: ModelUsage;
  timeZone: string | null;
  attributions: string[];
}

/**
 * How long the discovery stage may spend before it reports what it has.
 *
 * Raised from 75s after a live evaluation: six selector groups over a metro-sized
 * boundary legitimately took 120 seconds against the public instance, so the old
 * budget was cutting off groups that were about to answer and reporting the
 * region as thin. This is the ceiling on a traveller's wait, not a guess at how
 * long the service should take.
 */
const POI_STAGE_BUDGET_MS = 150_000;

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

/**
 * Last week's answer, read only when this week's cannot be had.
 *
 * Separate from `cacheFor` so it is impossible to reach by accident: an expired
 * entry served as fresh is the failure this whole phase exists to prevent, and
 * the only caller passes it as an explicit last resort and labels what it gets.
 */
function staleCacheFor<T>() {
  return {
    read: (key: string): T | null =>
      readProviderCache<T>(key, new Date(), { allowExpired: true }),
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

/**
 * The routing node a venue is priced against.
 *
 * A food venue shares a node with whatever is nearest that the matrix already
 * has — which is what stops a meal detour being a straight-line guess dressed up
 * as a road time, and what keeps the matrix from growing by one row per
 * restaurant. Nearest rather than first: a two-base trip would otherwise price
 * every restaurant against the first base, including the ones across a fjord
 * from it.
 */
function nearestAnchor(
  anchors: readonly { id: string; coordinates: { lat: number; lng: number } }[],
  point: { lat: number; lng: number },
): { id: string } | undefined {
  let best: { id: string } | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const dLat = anchor.coordinates.lat - point.lat;
    const dLng = (anchor.coordinates.lng - point.lng) * Math.cos((point.lat * Math.PI) / 180);
    const distance = dLat * dLat + dLng * dLng;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = anchor;
    }
  }
  return best;
}

/** Roughly 5 km at the equator: small enough that `way` geometry is affordable. */
const FOOD_BOX_DEGREES = 0.045;
const FOOD_STAGE_BUDGET_MS = 45_000;

const NO_ADMISSION: AdmissionRequirement = {
  reservationRequired: false,
  timedEntry: false,
  permitRequired: false,
  walkInAllowed: true,
  capacityLimited: false,
};

export function createOpenProviders(limits: { maxModelCalls: number }): {
  providers: CompilerProviders;
  diagnostics: LiveDiagnostics;
} {
  const model = new ResearchModel({ maxCalls: limits.maxModelCalls });
  /**
   * The map element behind each compiled record, kept for the length of one
   * compilation.
   *
   * `Place` deliberately does not carry OSM's tag dictionary — mirroring it
   * would make our database a redistribution of theirs. But the tags that make
   * research cheap (`opening_hours`, `website`, `wikidata`) are needed by later
   * stages, so they are held here, in memory, and never persisted.
   */
  const osmByPlaceId = new Map<string, NormalizedOsmPlace>();
  const osmByVenueId = new Map<string, NormalizedOsmPlace>();

  /**
   * The inventory the discovery stage built, held so the food stage reads the
   * same one rather than recomputing it from the same pack a stage later.
   */
  let packInventory: InventoryResult | null = null;
  /** The pack's records by id, for the research funnel's website candidates. */
  const packRecords = new Map<string, SourceRecord>();

  const websiteTagFor = (subjectId: string): string | undefined => {
    /**
     * The pack first, then the fallback path's own tags.
     *
     * This is the counter the whole research funnel is judged on: a website the
     * source already published is a search we do not buy. The pack carries far
     * more of them than the fallback did, because the geographic layers publish
     * a selected tag subset and the place catalogue publishes a websites array.
     */
    const fromPack = packRecords.get(subjectId)?.websiteCandidates[0];
    const tags = (osmByPlaceId.get(subjectId) ?? osmByVenueId.get(subjectId))?.planningTags;
    const raw = fromPack ?? tags?.website ?? tags?.['contact:website'];
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
      if (url.username || url.password) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  };
  const diagnostics: LiveDiagnostics = {
    geocoderCalls: 0,
    geocoderCacheHits: 0,
    poiCalls: 0,
    poiCacheHits: 0,
    poiElements: 0,
    routeCalls: 0,
    routePairs: 0,
    routeCacheHits: 0,
    wikidataCalls: 0,
    sourceSearches: 0,
    pagesFetched: 0,
    pagesRejected: 0,
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
    name: 'region-pack',
    async discover({ scope, queries, pack }) {
      /**
       * A pack is the answer, and asking anything else would be worse.
       *
       * The inventory is already bounded, release-pinned, normalised, linked and
       * classified from the source's own taxonomy — so there is no query to
       * issue, no model call to make and no shared query service to be refused
       * by. This is the branch that removes public Overpass from the default
       * path, and it is also where a compilation stopped paying a model to name
       * the kind of thing every record already declares.
       */
      if (pack) {
        /**
         * The traveller is deliberately not consulted here.
         *
         * A pack and the inventory over it are traveller-independent geography,
         * which is exactly what lets two people going to the same city share
         * one. Fit is applied downstream, where the board scores every candidate
         * against this traveller — narrowing the inventory by profile first
         * would bake one person's preferences into a cache everybody reads.
         */
        const inventory = buildInventory({ pack, scope });
        packInventory = inventory;
        for (const layer of pack.layers) {
          for (const record of layer.records) packRecords.set(record.id, record);
        }
        const gaps: ProviderGap[] = [];
        for (const layer of pack.layers) {
          if (layer.records.length === 0 && layer.note) {
            gaps.push({
              subjectId: layer.id,
              reason: 'not_found',
              detail: `${layer.id}: ${layer.note}`,
            });
          }
        }
        if (inventory.diagnostics.heldBackByCategoryCap > 0) {
          gaps.push({
            subjectId: scope.destinationCandidateId,
            reason: 'budget_exhausted',
            detail: `${inventory.diagnostics.heldBackByCategoryCap} more records of kinds this trip already has enough of were left out.`,
          });
        }
        return {
          candidates: inventory.candidates,
          gaps,
          calls: 0,
          licences: [...inventory.licences, AUTHORED_LICENCE],
        };
      }

      if (!isPoiProviderEnabled()) {
        return {
          candidates: [],
          gaps: [
            {
              subjectId: scope.destinationCandidateId,
              reason: 'provider_error',
              detail:
                'No regional place data could be prepared for this area, and no fallback map service is switched on.',
            },
          ],
          calls: 0,
          licences: [OSM_LICENCE_PLACES],
        };
      }

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
          staleCache: staleCacheFor(),
        });
        diagnostics.poiCalls += result.calls;
        if (result.cacheHit) diagnostics.poiCacheHits += 1;
        diagnostics.poiElements += result.elements.length;

        /**
         * A stale extract is usable and is never presented as current.
         *
         * The alternative when every endpoint refuses is to report an empty
         * region, which is a claim about the world rather than about a busy
         * volunteer service — so last week's map is served, and said so.
         */
        if (result.stale) {
          gaps.push({
            subjectId: scope.destinationCandidateId,
            reason: 'rate_limited',
            detail:
              'Every map data service refused, so this region was built from a copy we already had. It may be out of date.',
          });
        }

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

        const placeId = `osm-${osm.elementId.replace('/', '-')}`;
        osmByPlaceId.set(placeId, osm);
        const operatorSite = websiteTagFor(placeId);

        const place: Place = {
          id: placeId,
          regionId: `compiled-${scope.destinationCandidateId}`,
          name: osm.name,
          locality: scope.destinationName,
          shortDescription: entry.shortDescription.slice(0, 280),
          coordinates: osm.coordinates,
          /**
           * The classifying tag, plus the *names* of the attributes the map data
           * recorded. Names, never values: a place with a website, posted hours
           * and a Wikidata entry is a place somebody maintains, and that is a
           * quality signal — while a table of somebody else's tag values would
           * be a redistribution of their database.
           */
          tags: [osm.primaryTag, ...Object.keys(osm.planningTags).map((key) => `attr:${key}`)],
          source: {
            name: 'OpenStreetMap',
            kind: 'osm',
            /**
             * The operator's own domain where the map data carries one, and the
             * map element otherwise. This is what lets the research funnel skip
             * a billable search: a `website` tag is the answer the search would
             * have been buying.
             */
            url: operatorSite ?? osm.url,
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
   * Access from what the map data says, and hours wherever a mapper wrote them.
   *
   * `opening_hours` is a real OSM tag under a licence that lets us keep it, and
   * the slice that shipped before this one threw every value away because the
   * grammar was unparsed. It is now read by a conservative subset parser that
   * refuses anything it does not fully model — so a value it understands becomes
   * a real calendar, and a value it does not becomes an honest `unknown` rather
   * than a half-understood schedule.
   *
   * This costs nothing, needs no network call, and closes a large part of the
   * "zero verified hours" gap before a single search is billed.
   */
  const constraints: ConstraintResearchProvider = {
    name: 'osm-constraints',
    async research({ places: subjects, scope }) {
      const calendars: OperatingCalendar[] = [];
      const hourGaps: ProviderGap[] = [];

      for (const subject of subjects) {
        const osm = osmByPlaceId.get(subject.id);
        const raw = osm?.planningTags.opening_hours;
        if (!raw) continue;
        const parsed = parseOsmOpeningHours(raw);
        if (!parsed) {
          hourGaps.push({
            subjectId: subject.id,
            reason: 'insufficient_evidence',
            detail:
              'The map data records opening hours in a form we will not partly interpret, so they are left unknown.',
          });
          continue;
        }
        const provenance = {
          kind: 'estimated' as const,
          sourceName: 'OpenStreetMap contributors',
          ...(osm ? { sourceUrl: osm.url } : {}),
          /**
           * `estimated`, not `official`, and the distinction is load-bearing: a
           * mapper transcribing a sign is a volunteer's reading of an operator's
           * word, and the schema reserves `official` for the operator itself.
           */
          confidence: 0.55,
          volatility: 'dynamic' as const,
          recheckNote:
            'These hours come from community map data rather than from the operator. Worth confirming before a day depends on them.',
        };
        const candidate =
          parsed.kind === 'always_open'
            ? {
                kind: 'always_open' as const,
                placeId: subject.id,
                admission: NO_ADMISSION,
                daylightOnly: false,
                note: parsed.closedNote ?? 'Open around the clock, according to the map data.',
                provenance,
              }
            : {
                kind: 'scheduled' as const,
                placeId: subject.id,
                admission: NO_ADMISSION,
                daylightOnly: false,
                note: parsed.closedNote ?? 'Hours as recorded in the map data.',
                periods: parsed.periods,
                closedAnnualDates: [],
                provenance,
              };
        const validated = operatingCalendarSchema.safeParse(candidate);
        if (validated.success) calendars.push(validated.data);
      }

      return {
        calendars,
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
        gaps: [
          ...hourGaps,
          ...subjects
            .filter((subject) => !calendars.some((calendar) => calendar.placeId === subject.id))
            .map((subject) => ({
              subjectId: subject.id,
              reason: 'no_official_source' as const,
              detail: 'The map data records no opening hours for this one.',
            })),
        ],
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

  /**
   * SOMEWHERE TO EAT, FROM THE SAME MAP DATA.
   *
   * Discovered around the bases rather than across the whole scope: a meal is
   * only useful where the traveller already is, and sweeping a region for
   * restaurants returns thousands of records of which none are near the route.
   *
   * Every venue lands with `unknown` hours unless the map data or the research
   * funnel confirmed them — and the food planner refuses to schedule an
   * unknown-hours venue, which is correct. What this stage does is give the
   * funnel something to research; what turns a name into a meal is the page.
   */
  const food: FoodDiscoveryProvider = {
    name: 'region-pack-food',
    async discover({ scope, bases, maxVenues, pack, places: knownPlaces }) {
      /**
       * Food out of the same pack the attractions came from.
       *
       * One read rather than two, and the venues arrive with the same
       * provenance, the same release pin and the same licence rows. Hours still
       * start unknown and the food planner still refuses to schedule an
       * unconfirmed kitchen — the backbone changed where venues come from, not
       * what we are willing to claim about them.
       */
      if (pack) {
        const inventory = packInventory ?? buildInventory({ pack, scope });
        const venues: FoodVenue[] = [];
        const gaps: ProviderGap[] = [];
        /**
         * A venue is priced at the nearest thing already in the matrix.
         *
         * Bases *and* places, not just bases: a café beside a trailhead is a
         * lunch stop on the way up, and pricing it against a hotel eleven
         * kilometres away turns a two-minute detour into a day's worth of
         * driving. Reusing an existing node also keeps the matrix the same size,
         * which is the expensive part.
         */
        const anchors = [
          ...bases.map((base) => ({ id: base.id, coordinates: base.coordinates })),
          ...knownPlaces.map((place) => ({ id: place.id, coordinates: place.coordinates })),
        ];
        for (const record of inventory.foodRecords) {
          if (venues.length >= maxVenues) break;
          const nearest = nearestAnchor(anchors, record.coordinates);
          const venue = foodVenueFromRecord({
            record,
            scope,
            routingId: nearest?.id ?? bases[0]?.id ?? scope.destinationCandidateId,
          });
          if (venue) venues.push(venue);
        }
        if (venues.length === 0) {
          gaps.push({
            subjectId: 'food',
            reason: 'not_found',
            detail: 'The place data has nothing to eat recorded inside this region.',
          });
        }
        return { venues, gaps, calls: 0 };
      }

      if (!isPoiProviderEnabled()) {
        return {
          venues: [],
          gaps: [
            {
              subjectId: 'food',
              reason: 'provider_error',
              detail: 'No regional place data was prepared, so no food venues could be found.',
            },
          ],
          calls: 0,
        };
      }

      if (maxVenues <= 0) {
        return {
          venues: [],
          gaps: [{ subjectId: 'food', reason: 'budget_exhausted', detail: 'No food budget left.' }],
          calls: 0,
        };
      }

      const gaps: ProviderGap[] = [];
      const venues: FoodVenue[] = [];
      const seen = new Set<string>();
      const perBase = Math.max(6, Math.ceil(maxVenues / Math.max(1, bases.length)));

      for (const base of bases) {
        if (venues.length >= maxVenues) break;
        // A small box per base: dense enough for `way` geometry to be affordable,
        // which is what lets a restaurant mapped as a building outline be found.
        const box: BoundingBox = {
          south: base.coordinates.lat - FOOD_BOX_DEGREES,
          north: base.coordinates.lat + FOOD_BOX_DEGREES,
          west: base.coordinates.lng - FOOD_BOX_DEGREES,
          east: base.coordinates.lng + FOOD_BOX_DEGREES,
        };
        try {
          const result = await fetchFoodPois(box, {
            limit: perBase * 3,
            retries: 0,
            deadlineMs: Date.now() + FOOD_STAGE_BUDGET_MS,
            cache: cacheFor('overpass-food', TTL.poi),
          });
          diagnostics.poiCalls += result.calls;
          if (result.cacheHit) diagnostics.poiCacheHits += 1;

          for (const element of result.elements) {
            if (venues.length >= maxVenues) break;
            const normalized = normalizeElement(element);
            if (!normalized || seen.has(normalized.elementId)) continue;
            const venue = toFoodVenue(normalized, scope, base.id);
            if (!venue) continue;
            seen.add(normalized.elementId);
            osmByVenueId.set(venue.id, normalized);
            venues.push(venue);
          }
        } catch {
          gaps.push({
            subjectId: base.id,
            reason: 'rate_limited',
            detail: 'The map data service did not answer for food near one of the bases.',
          });
        }
      }

      if (venues.length === 0 && gaps.length === 0) {
        gaps.push({
          subjectId: 'food',
          reason: 'not_found',
          detail: 'The map data has no named places to eat near any of the bases we chose.',
        });
      }
      return { venues, gaps, calls: diagnostics.poiCalls };
    },
  };

  /**
   * WHERE TO LOOK, IN THE CHEAPEST ORDER THAT WORKS.
   *
   * Structured sources first and free: an OSM `website` tag, then a Wikidata
   * P856 claim reached through the element's `wikidata` tag. Only the subjects
   * neither answered for reach the search layer, which is billed per query.
   *
   * The model never writes a URL. It writes queries; the search provider returns
   * result blocks; `ResearchModel.search` reads the URLs out of those blocks and
   * discards the prose. Every URL is then fetched by us, through the SSRF-safe
   * layer, under our own limits.
   */
  const sourceDiscovery: SourceDiscoveryProvider = {
    name: 'wikidata+search',
    async discover({ subjects, maxSearches, maxReferencesPerSubject }) {
      const gaps: ProviderGap[] = [];
      const references: SourceReference[] = [];
      const stillMissing: (typeof subjects)[number][] = [];

      // --- free tier 1: the map data's own website tag -----------------------
      const needsWikidata: { subjectId: string; entityId: string }[] = [];
      for (const subject of subjects) {
        const direct = subject.knownOfficialUrl ?? websiteTagFor(subject.id);
        if (direct) {
          references.push({
            subjectId: subject.id,
            url: direct,
            expectedAuthority: 'operator',
            discoveredVia: 'osm_tag',
          });
          continue;
        }
        const entityId = (osmByPlaceId.get(subject.id) ?? osmByVenueId.get(subject.id))
          ?.planningTags.wikidata;
        if (entityId) needsWikidata.push({ subjectId: subject.id, entityId });
        else stillMissing.push(subject);
      }

      // --- free tier 2: Wikidata P856 ---------------------------------------
      if (needsWikidata.length > 0) {
        const lookup = await fetchWikidataFacts(
          needsWikidata.map((entry) => entry.entityId),
          { cache: cacheFor('wikidata', TTL.geocode) },
        );
        diagnostics.wikidataCalls += lookup.calls;
        for (const entry of needsWikidata) {
          const facts = lookup.facts.get(entry.entityId);
          if (facts?.officialWebsite) {
            references.push({
              subjectId: entry.subjectId,
              url: facts.officialWebsite,
              expectedAuthority: 'operator',
              discoveredVia: 'wikidata',
            });
          } else {
            const subject = subjects.find((candidate) => candidate.id === entry.subjectId);
            if (subject) stillMissing.push(subject);
          }
        }
      }

      // --- paid tier: one batched search turn -------------------------------
      let searches = 0;
      if (stillMissing.length > 0 && maxSearches > 0) {
        /**
         * One turn for a batch, not one turn per subject.
         *
         * A search costs ten dollars per thousand and a shortlist is thirty
         * candidates; a per-candidate loop is the shape that turns a broad
         * destination into a bill. The batch is capped by name count as well as
         * by `max_uses`, so a long shortlist cannot smuggle a long turn through.
         */
        const batch = stillMissing.slice(0, Math.min(12, maxSearches * 2));
        try {
          const outcome = await model.search({
            promptVersion: PROMPT_VERSIONS.findOfficialSources,
            instruction:
              'You find the official pages for places a trip planner already knows exist. ' +
              'Search for the page run by the operator, the managing agency or the local ' +
              'government — the one that publishes opening hours, tickets and closures. ' +
              'Prefer the site of the thing itself over any guide, aggregator or listing. ' +
              'Do not summarise what you find and do not answer the question yourself; the ' +
              'search results are what matters, not your reply.',
            task:
              `Find the official visitor page for each of these, in ${batch[0]?.locality ?? 'the destination'}:\n` +
              batch.map((subject) => `- ${subject.name}`).join('\n'),
            maxSearches,
          });
          searches = Math.min(maxSearches, Math.max(1, outcome.searches));
          diagnostics.sourceSearches += searches;

          const perSubject = new Map<string, number>();
          for (const result of outcome.results) {
            /**
             * A search result is matched to a subject by name overlap, and an
             * unmatched result is discarded rather than attached to whoever came
             * first. A page about the wrong place, cited confidently, is worse
             * than no page at all.
             */
            const subject = batch.find((candidate) =>
              matchesSubject(result.url, result.title, candidate.name),
            );
            if (!subject) continue;
            const used = perSubject.get(subject.id) ?? 0;
            if (used >= maxReferencesPerSubject) continue;
            perSubject.set(subject.id, used + 1);
            references.push({
              subjectId: subject.id,
              url: result.url,
              ...(result.title ? { title: result.title } : {}),
              expectedAuthority: 'operator',
              discoveredVia: 'search',
              ...(result.pageAge ? { pageAge: result.pageAge } : {}),
            });
          }
        } catch {
          gaps.push({
            subjectId: 'source-discovery',
            reason: 'provider_error',
            detail: 'The search provider did not answer, so some places were left unresearched.',
          });
        }
      }

      const unresolved = subjects.filter(
        (subject) => !references.some((reference) => reference.subjectId === subject.id),
      );
      for (const subject of unresolved) {
        gaps.push({
          subjectId: subject.id,
          reason: 'no_official_source',
          detail: 'We could not find a page published by whoever runs this.',
        });
      }

      return { references, gaps, calls: model.usage.calls, searches };
    },
  };

  const retrieval: SourceRetrievalProvider = {
    name: 'safe-fetch',
    async retrieve({ references, maxPages, maxBytes, deadlineMs }) {
      const documents: RetrievedDocument[] = [];
      const rejected: SourceRetrievalResult['rejected'] = [];
      let bytes = 0;

      for (const reference of references.slice(0, maxPages)) {
        if (Date.now() > deadlineMs || bytes >= maxBytes) {
          rejected.push({
            url: reference.url,
            subjectId: reference.subjectId,
            reason: 'budget_exhausted',
            detail: 'We ran out of reading time for this trip before reaching this page.',
          });
          continue;
        }
        try {
          const result = await fetchIfAllowed(reference.url, {
            maxBytes: 1_500_000,
            timeoutMs: 8_000,
            maxRedirects: 3,
          });
          bytes += result.body.length;
          diagnostics.pagesFetched += 1;

          const structuredData = extractJsonLd(result.body);
          const text = stripBoilerplate(extractReadableText(result.body, 24_000)).slice(0, 18_000);
          const subjectName =
            references.find((entry) => entry.subjectId === reference.subjectId)?.title ??
            reference.subjectId;
          const classified = classifyAuthority({
            url: result.finalUrl,
            subjectName,
            discoveredVia: reference.discoveredVia,
            expected: reference.expectedAuthority,
          });

          documents.push({
            subjectId: reference.subjectId,
            url: result.finalUrl,
            ...(reference.title ? { title: reference.title } : {}),
            text,
            structuredData,
            contentHash: hashText(text),
            contentBytes: result.body.length,
            retrievedAt: new Date().toISOString(),
            ...(publishedAtFrom(result.body, structuredData)
              ? { publishedAt: publishedAtFrom(result.body, structuredData)! }
              : {}),
            robotsAllowed: result.robotsAllowed,
            authority: classified.authority,
            publisher: classified.publisher,
            domain: classified.domain,
          });
        } catch (error) {
          diagnostics.pagesRejected += 1;
          const unsafe = error instanceof UnsafeUrlError;
          rejected.push({
            url: reference.url,
            subjectId: reference.subjectId,
            reason: unsafe ? 'rejected_unsafe_source' : 'provider_error',
            detail: unsafe
              ? 'That page was not safe to read, so we did not.'
              : 'That page did not answer in time.',
          });
        }
      }

      return { documents, rejected, gaps: [], bytes };
    },
  };

  /**
   * STRUCTURED DATA FIRST, THE MODEL FOR THE REST.
   *
   * A `schema.org` `openingHoursSpecification` is the operator stating their
   * hours in machine-readable form. Reading it is free, cannot be misread, and
   * produces a claim with a field pointer instead of a quotation — so it is
   * taken before a model is asked anything, and the model is only asked about
   * the pages that had none.
   */
  const extraction: FactExtractionProvider = {
    name: 'jsonld+anthropic',
    async extract({ subjects, documents, maxCalls }) {
      const claims: ExtractedClaim[] = [];
      const gaps: ProviderGap[] = [];
      const subjectIndex = new Map(subjects.map((subject, index) => [subject.id, index]));

      const needsModel: { index: number; document: RetrievedDocument }[] = [];
      for (const [index, document] of documents.entries()) {
        const hours = hoursFromJsonLd(document.structuredData);
        if (hours) {
          claims.push({
            subjectId: document.subjectId,
            documentIndex: index,
            factPath: 'hours.weekly',
            statement: 'Opening hours as published in the page’s own structured data.',
            evidenceField: 'schema.org/openingHoursSpecification',
            derivation: 'directly_stated',
            payload: hours,
          });
        }
        if (document.text.length > 200) needsModel.push({ index, document });
      }

      if (needsModel.length > 0 && maxCalls > 0) {
        try {
          const extracted = await extractPlanningFacts(model, {
            subjects: subjects.map((subject, index) => ({
              index,
              name: subject.name,
              wants: [...subject.wantedPaths],
            })),
            pages: needsModel.map((entry) => ({
              index: entry.index,
              subjectIndex: subjectIndex.get(entry.document.subjectId) ?? -1,
              title: entry.document.title ?? entry.document.domain,
              text: entry.document.text,
            })),
          });

          for (const fact of extracted.facts) {
            const document = documents[fact.sourceIndex];
            const subject = subjects[fact.subjectIndex];
            // A fact whose page and subject disagree is a mis-attribution, and
            // mis-attributed evidence is worse than missing evidence.
            if (!document || !subject || document.subjectId !== subject.id) continue;
            claims.push({
              subjectId: subject.id,
              documentIndex: fact.sourceIndex,
              factPath: fact.factPath,
              statement: fact.statement,
              evidenceExcerpt: fact.evidenceExcerpt,
              derivation: fact.derivation,
              ...(payloadFor(fact) !== undefined ? { payload: payloadFor(fact) } : {}),
            });
          }
        } catch {
          gaps.push({
            subjectId: 'extraction',
            reason: 'provider_error',
            detail: 'The pages were fetched but could not be read into facts.',
          });
        }
      }

      return {
        claims,
        unanswered: [],
        gaps,
        calls: needsModel.length > 0 && maxCalls > 0 ? 1 : 0,
        promptVersion: PROMPT_VERSIONS.extractFacts,
        schemaVersion: 'planning-extraction/1',
        modelId: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
      };
    },
  };

  return {
    providers: {
      resolver,
      ...(isPlaceBackboneEnabled() ? { regionPack: createCachedPackProvider() } : {}),
      expansion,
      places,
      constraints,
      routing,
      weatherLocations,
      food,
      sourceDiscovery,
      retrieval,
      extraction,
    },
    diagnostics,
  };
}

/**
 * A MAPPED EATERY, NORMALISED — AND HONEST ABOUT WHAT IT DOES NOT KNOW.
 *
 * Three fields carry almost all the risk here, and all three default to the
 * cautious answer:
 *
 * - **hours** start `unknown`, which the food planner refuses to schedule. A
 *   restaurant whose hours nobody confirmed is a fifty-fifty chance of a locked
 *   door at dinnertime, and the product would rather hold the time than name a
 *   place it cannot stand behind.
 * - **price** is `format_inferred` from the kind of venue, never a band anybody
 *   published, and the label says so.
 * - **dietary** claims come only from explicit `diet:*` tags, and land at
 *   `menu_lists_options` — never `venue_states_support`, which the schema
 *   reserves for the venue's own page and which is the only level a traveller
 *   with an allergy should ever act on.
 */
function toFoodVenue(
  osm: NormalizedOsmPlace,
  scope: GeographicScope,
  routingId: string,
): FoodVenue | null {
  const [key = '', value = ''] = osm.primaryTag.split('=');
  const serviceType = FOOD_SERVICE_BY_TAG[`${key}=${value}`];
  if (!serviceType) return null;

  /**
   * A shop nobody has confirmed the hours of is not a provisioning stop.
   *
   * The food schema refuses a provisioning venue without confirmed hours *and*
   * refuses a groceries meal period without provisioning, so an unconfirmed
   * grocery is unrepresentable — which is the schema being right: a packed lunch
   * nobody could buy strands the whole of the next day. This branch used to
   * build one anyway and hand the compiler a food dataset its own integrity gate
   * rejected.
   */
  if (serviceType === 'grocery' || serviceType === 'market') return null;

  const dietary: FoodVenue['dietary'] = [];
  for (const [tag, need] of DIET_TAGS) {
    const tagged = osm.planningTags[tag];
    if (tagged === 'yes' || tagged === 'only') {
      dietary.push({
        need,
        evidence: 'menu_lists_options',
        note: 'Community map data records this as available. Confirm with the venue if it matters.',
      });
    }
  }

  const website = osm.planningTags.website ?? osm.planningTags['contact:website'];
  let bookingUrl: string | undefined;
  if (website) {
    try {
      const url = new URL(website);
      if (url.protocol === 'https:' || url.protocol === 'http:') bookingUrl = url.toString();
    } catch {
      bookingUrl = undefined;
    }
  }

  return {
    id: `food-${osm.elementId.replace('/', '-')}`,
    regionId: `compiled-${scope.destinationCandidateId}`,
    name: osm.name,
    locality: scope.destinationName,
    shortDescription: `${FOOD_SERVICE_WORDS[serviceType]} recorded in the map data for ${scope.destinationName}.`,
    coordinates: osm.coordinates,
    tags: [osm.primaryTag],
    source: {
      name: 'OpenStreetMap',
      kind: 'osm',
      url: bookingUrl ?? osm.url,
      confidence: 0.6,
      lastVerified: new Date().toISOString().slice(0, 10),
      element: {
        elementId: osm.elementId,
        database: 'openstreetmap',
        licenceId: 'ODbL-1.0',
        ...(osm.sourceTimestamp ? { sourceTimestamp: osm.sourceTimestamp } : {}),
        url: osm.url,
      },
    },
    serviceType,
    mealPeriods: FOOD_MEAL_PERIODS[serviceType],
    cuisines: osm.planningTags.cuisine ? [osm.planningTags.cuisine.split(';')[0]!] : [],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: FOOD_SERVICE_MINUTES[serviceType],
    reservation: { requirement: 'unknown' },
    takeaway: osm.planningTags.takeaway === 'yes' ? 'confirmed' : 'unknown',
    /**
     * Provisioning is downgraded to `none` while hours are unknown.
     *
     * The food schema refuses a provisioning stop with unconfirmed hours, and it
     * is right to: a packed lunch nobody could buy strands the whole of the next
     * day. If research confirms the hours, the venue is rebuilt with its
     * provisioning intact.
     */
    provisioning: 'none',
    dietary,
    hours: {
      kind: 'unknown',
      hoursConfidence: 'unverified',
      note: 'Nobody publishes hours for this that we could read.',
      provenance: {
        kind: 'estimated',
        sourceName: 'OpenStreetMap contributors',
        confidence: 0.3,
        volatility: 'dynamic',
        recheckNote: 'We have no confirmed hours for this. Check before you go.',
      },
    },
    routingId,
    walkMinutesFromRouting: 0,
  };
}

const FOOD_SERVICE_BY_TAG: Record<string, FoodVenue['serviceType'] | undefined> = {
  'amenity=restaurant': 'restaurant',
  'amenity=cafe': 'cafe',
  'amenity=fast_food': 'takeaway',
  'amenity=food_court': 'food_hall',
  'amenity=pub': 'restaurant',
  'amenity=bar': 'restaurant',
  'amenity=marketplace': 'market',
  'shop=bakery': 'bakery',
  'shop=supermarket': 'grocery',
  'shop=convenience': 'grocery',
  'shop=greengrocer': 'grocery',
  'shop=deli': 'grocery',
  'shop=butcher': 'grocery',
};

const FOOD_SERVICE_WORDS: Record<FoodVenue['serviceType'], string> = {
  restaurant: 'A restaurant',
  cafe: 'A café',
  bakery: 'A bakery',
  market: 'A market',
  grocery: 'A food shop',
  food_hall: 'A food hall',
  takeaway: 'A takeaway',
};

const FOOD_MEAL_PERIODS: Record<FoodVenue['serviceType'], FoodVenue['mealPeriods']> = {
  restaurant: ['lunch', 'dinner'],
  cafe: ['breakfast', 'lunch', 'coffee'],
  bakery: ['breakfast', 'coffee'],
  market: ['lunch', 'groceries'],
  grocery: ['groceries'],
  food_hall: ['lunch', 'dinner'],
  takeaway: ['lunch', 'dinner'],
};

const FOOD_SERVICE_MINUTES: Record<FoodVenue['serviceType'], number> = {
  restaurant: 75,
  cafe: 30,
  bakery: 15,
  market: 40,
  grocery: 20,
  food_hall: 45,
  takeaway: 20,
};

const DIET_TAGS: readonly [string, FoodVenue['dietary'][number]['need']][] = [
  ['diet:vegetarian', 'vegetarian'],
  ['diet:vegan', 'vegan'],
  ['diet:gluten_free', 'gluten_free'],
  ['diet:halal', 'halal'],
];

/** The typed half of an extracted fact, or nothing. */
function payloadFor(fact: PlanningExtraction['facts'][number]): unknown {
  if (fact.hours) return { periods: fact.hours.periods, closedAnnualDates: [] };
  if (fact.closure) return fact.closure;
  if (fact.booking) return fact.booking;
  if (fact.cost) return fact.cost;
  if (fact.safety) return fact.safety;
  if (fact.durationMinutes !== undefined) return { minutes: fact.durationMinutes };
  return undefined;
}

/**
 * Whether a search result is plausibly about the subject we asked for.
 *
 * Generic and deliberately strict: a distinctive word from the name has to
 * appear in the host or the title. A batched search turn returns results for
 * every subject in the batch mixed together, and attaching them by position
 * would cite one museum's hours against another's.
 */
function matchesSubject(url: string, title: string | undefined, name: string): boolean {
  const words = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
  if (words.length === 0) return false;
  const haystack = `${url} ${title ?? ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return words.some((word) => haystack.includes(word));
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
    /**
     * The place backbone, or the fallback map service. Not neither.
     *
     * `SIDEQUEST_POI_PROVIDER` used to be required. It is now the *fallback*:
     * a shared, best-effort query service that two of four live destinations
     * could not be served by. A build with the backbone on and Overpass off is
     * the intended production shape, and a build with neither cannot discover
     * anything, so it is refused up front rather than three stages in.
     */
    (isPlaceBackboneEnabled() || isPoiProviderEnabled()) &&
    isRoutesProviderEnabled() &&
    isResearchModelConfigured() &&
    process.env.SIDEQUEST_RESEARCH_PROVIDER?.trim().toLowerCase() === 'anthropic'
  );
}

export function missingProviderSwitches(): string[] {
  const missing: string[] = [];
  if (!isGeocoderEnabled()) missing.push('SIDEQUEST_GEOCODER_PROVIDER=nominatim');
  if (!isPlaceBackboneEnabled() && !isPoiProviderEnabled()) {
    missing.push('SIDEQUEST_PLACE_BACKBONE=overture');
  }
  if (!isRoutesProviderEnabled()) missing.push('SIDEQUEST_ROUTES_PROVIDER=valhalla');
  if (process.env.SIDEQUEST_RESEARCH_PROVIDER?.trim().toLowerCase() !== 'anthropic') {
    missing.push('SIDEQUEST_RESEARCH_PROVIDER=anthropic');
  }
  return missing;
}
