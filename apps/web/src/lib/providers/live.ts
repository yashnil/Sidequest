import 'server-only';
import { resolveEntityName } from './names';
import {
  assessPlaceStanding,
  standingFields,
  assertFoodRoutingWithinDoorWalk,
  foodDistinctiveness,
  foodNameCounts,
  MODELLED_WALK_KMH,
  snapFoodRouting,
  licence,
  matchesAcquisitionIntent,
  operatingCalendarSchema,
  parseOsmOpeningHours,
  type AdmissionRequirement,
  type DataLicence,
  type FoodVenue,
  type GeographicScope,
  type OperatingCalendar,
  type Place,
  type WeatherLocation,
  type FactPath,
} from '@sidequest/core';
import {
  admitLateCandidate,
  assessRecordEligibility,
  buildInventory,
  buildTripScopeOverlay,
  decisionFor,
  DEFAULT_INVENTORY_LIMITS,
  foodVenueFromRecord,
  type IncludedArea,
  type InventoryResult,
  type TripScopeOverlay,
  type TripIncludedArea,
} from '@sidequest/compiler';
import {
  placeInclusionTag,
  placeRoleTag,
  planningRoleForCategory,
  runtimeTimeZoneDataVersion,
  singleTimeZone,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import type {
  CompilerProviders,
  ConstraintResearchProvider,
  DestinationResolver,
  DiscoveredCandidate,
  DiscoveryResult,
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
  TimeZoneProvider,
  TransitJourney,
  TransitRoutingProvider,
  WeatherLocationProvider,
} from '@sidequest/compiler';
import { assessEntityAgreement } from './entity-agreement';
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
  geocode,
  osmElementId,
  type NominatimPlace,
} from './nominatim';
import {
  boxAreaDeg2,
  fetchFoodPois,
  fetchPois,
  fetchPoisForIntents,
  isPoiProviderEnabled,
  WAY_QUERY_AREA_LIMIT_DEG2,
  normalizeElement,
  type BoundingBox,
  type NormalizedOsmPlace,
  type OverpassResult,
} from './overpass';
import {
  classifyPlaces,
  DEFAULT_MODEL,
  extractPlanningFacts,
  interpretDestination,
  PROMPT_VERSIONS,
  proposeExpansion,
  ResearchModel,
  type ModelUsage,
  type PlanningExtraction,
} from './anthropic';
import {
  isTimeZoneResolverEnabled,
  resolveCivilTimeZones,
  TIME_ZONE_TTL_MS,
} from './timezone';
import { isTransitProviderEnabled } from './switches';
import { cacheFor, createOpenResolver, createOpenRouting, OSM_LICENCE_ROUTING, TTL } from './open-verification';
import { measureTransitJourneys, transitTilesAvailable } from './transit';
import { readProviderCache } from '../db/compiler-repository';

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
  /** Conditional requests the server answered with "nothing changed". */
  pagesRevalidated: number;
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
  timeZoneCalls: number;
  timeZoneCacheHits: number;
  /** Public-transport journeys asked for, measured, and refused. */
  transitCalls: number;
  transitPairsRequested: number;
  transitPairsMeasured: number;
  /**
   * The timezone database this process computed offsets under.
   *
   * Recorded because it is the one input to every daylight and opening-hours
   * calculation that nothing in this repository controls. A runtime lagging the
   * published database is wrong about a rule change that has already happened,
   * and there is no way to detect that from inside the process — so the version
   * travels with the diagnostic instead of being assumed current.
   */
  timeZoneDataVersion: string | null;
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

/**
 * The portfolio, as the set-level arithmetic readiness needs.
 *
 * Derived here rather than in the assessor because this is the only layer that
 * holds the inventory, the pack and the overlay at once — and derived rather
 * than counted downstream because `candidates` has already been narrowed to
 * things to do, so counting it later cannot tell an empty board apart from a
 * board of food.
 */
function portfolioFactsFrom(
  inventory: InventoryResult,
  pack: RegionPack,
  overlay: TripScopeOverlay,
): NonNullable<DiscoveryResult['portfolioFacts']> {
  const pools = inventory.portfolio.pools;
  const kept = (slot: string) =>
    pools.filter((pool) => pool.slot === slot).reduce((sum, pool) => sum + pool.kept, 0);

  /*
   * Which part of the ground each thing to do sits in.
   *
   * Computed from coordinates against the partition's own cells rather than read
   * off the place, because every place in one compiled region carries the same
   * `regionId` — using it would make "things to do in 1 of 12 parts" true of
   * every destination on earth, and a spread check that always fires is a spread
   * check nobody reads.
   */
  const areas = new Map<string, number>();
  for (const candidate of inventory.candidates) {
    const { lat, lng } = candidate.place.coordinates;
    const cell = pack.partition.cells.find(
      (entry) =>
        lat >= entry.bounds.southWest.lat &&
        lat <= entry.bounds.northEast.lat &&
        lng >= entry.bounds.southWest.lng &&
        lng <= entry.bounds.northEast.lng,
    );
    /*
     * A candidate outside every cell is not a part of the destination.
     *
     * Bucketing it under one synthetic key counted it towards
     * `areasWithVisitable`, which is compared against the number of real cells —
     * so the spread check could report "13 of 12 parts". It is left out of the
     * area tally entirely; whether it should be here at all is containment's
     * question, not this one's.
     */
    if (!cell) continue;
    areas.set(cell.id, (areas.get(cell.id) ?? 0) + 1);
  }

  return {
    packRecords: pack.layers.reduce((sum, layer) => sum + layer.records.length, 0),
    anchors: kept('anchor'),
    discoveries: kept('discovery'),
    food: inventory.foodRecords.length,
    support: kept('support'),
    gateways: kept('gateway'),
    anchorDemotions: inventory.portfolio.anchorDemotions,
    membershipUnverified: inventory.portfolio.membershipUnverified,
    categories: new Set(inventory.candidates.map((entry) => entry.place.category)).size,
    /*
     * Cells rather than named subregions, because cells are the only division of
     * the ground that exists at this point and every record carries one. It is a
     * coarse proxy for "part of the destination" and is stated as such: what it
     * detects reliably is the failure it was added for — everything in one cell
     * of many.
     */
    areasWithVisitable: areas.size,
    areasTotal: pack.partition.cells.length,
    largestAreaVisitable: Math.max(0, ...areas.values()),
    sourceCatalogues: new Set(pack.layers.map((layer) => layer.catalog)).size,
    packPartial: pack.state !== 'ready',
    /*
     * Read off the overlay's own verdicts rather than recomputed here. These are
     * the relationships that mean "this agrees with the destination's published
     * identity", as opposed to the ones that mean "we could not tell" or "this is
     * near it".
     */
    insideSelected: overlay.integrity.byRelationship
      .filter((entry) =>
        ['inside_scope', 'inside_selected_division', 'inside_selected_region'].includes(
          entry.relationship,
        ),
      )
      .reduce((sum, entry) => sum + entry.count, 0),
    membershipDecided: overlay.integrity.byRelationship
      .filter((entry) => entry.relationship !== 'membership_unknown')
      .reduce((sum, entry) => sum + entry.count, 0),
    /*
     * Read off the overlay's own count of refusals rather than subtracted from
     * the decided total. A subtraction counts gateways, expansion members and
     * satellites as refusals, and all three are outside because something asked
     * for them.
     */
    refutedElsewhere: overlay.integrity.outOfScope,
    divisionsAvailable: overlay.integrity.divisionsAvailable,
    scopeIdentityUnknown: overlay.integrity.scopeIdentityUnknown,
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

/**
 * The routing node a venue is priced against, or nothing.
 *
 * A food venue shares a node with whatever is nearest that the matrix already
 * has — which is what stops a meal detour being a straight-line guess dressed up
 * as a road time, and what keeps the matrix from growing by one row per
 * restaurant. This used to be all of the rule, and nearest with no ceiling is
 * not a rule at all: the anchors are the bases plus the couple of dozen compiled
 * places, so a venue with nothing near it was still snapped onto whatever was
 * least far and the day printed that node's travel time under the venue's name.
 *
 * `snapFoodRouting` owns both halves now — the nearest node *and* the door-walk
 * distance it has to be inside — so the two food paths below cannot disagree
 * about which venues are routable.
 */
function snapVenue(
  anchors: readonly { id: string; coordinates: { lat: number; lng: number } }[],
  point: { lat: number; lng: number },
): { routingId: string; walkMinutesFromRouting: number } | null {
  return snapFoodRouting({ coordinates: point, anchors, walkKmh: MODELLED_WALK_KMH });
}

/**
 * What a venue with no node in reach costs the traveller, said once.
 *
 * It leaves the routable pool: `FoodVenue.routingId` is required, and rightly —
 * every consumer of a venue prices a leg to it — so a venue we cannot price is
 * not a venue this stage may hand on. The planner already renders the fallback,
 * naming the area rather than a place, which is a smaller claim and a true one.
 */
function unroutableFoodGap(count: number): ProviderGap {
  return {
    subjectId: 'food',
    reason: 'not_found',
    detail: `${count} ${count === 1 ? 'place' : 'places'} to eat sit further from anything this trip routes through than a short walk, so we could not say what reaching them costs and left them out.`,
  };
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
  /**
   * The trip-scope overlay the places stage built, so the food stage judges
   * against the same one. Two overlays in one compilation is two answers to
   * "does this belong", and the food stage's would be the one that had never
   * heard of the regional expansion.
   */
  let packOverlay: TripScopeOverlay | undefined;
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
    pagesRevalidated: 0,
    routeCalls: 0,
    routePairs: 0,
    routeCacheHits: 0,
    wikidataCalls: 0,
    sourceSearches: 0,
    pagesFetched: 0,
    pagesRejected: 0,
    model: model.usage,
    timeZone: null,
    timeZoneCalls: 0,
    timeZoneCacheHits: 0,
    transitCalls: 0,
    transitPairsRequested: 0,
    transitPairsMeasured: 0,
    timeZoneDataVersion: runtimeTimeZoneDataVersion(),
    attributions: [OSM_LICENCE_PLACES.attribution],
  };

  /**
   * ONE ANSWER TO "WHAT CLOCK IS THIS REGION ON", USED EVERYWHERE.
   *
   * Three call sites derived this independently and two of them disagreed about
   * precedence: the expansion read `diagnostics.timeZone ?? scope.timeZones[0]`
   * and the weather stage read `scope.timeZones[0] ?? diagnostics.timeZone` —
   * opposite orders, in one file, against the same question. The weather stage's
   * own comment argued for its order at length; the expansion's contradicted it
   * silently.
   *
   * The scope wins, and the scope is right to: it holds the zone that was
   * actually resolved for *this compilation*, while `diagnostics.timeZone` is
   * whatever this provider instance happened to look up — and resolution and
   * compilation are separate requests, so on a compile it is usually null.
   *
   * `singleTimeZone` rather than `timeZones[0]`, which is the guard this
   * repository wrote for exactly this and then called from nowhere: a region
   * spanning a boundary that gets one side's clock applied to both is how a
   * timetable moves by an hour. When the honest answer is "more than one", the
   * first zone is still used — a base has to be on *some* clock — but the choice
   * is made visibly here rather than by an index nobody reads.
   */
  const regionTimeZone = (scope: GeographicScope): string =>
    singleTimeZone(scope.timeZones) ??
    scope.timeZones[0] ??
    diagnostics.timeZone ??
    'UTC';

  /*
   * The geocoder-backed resolver from `open-verification.ts`, with the model
   * corroborating whether the string looks like a place at all. The model
   * corroborates; it does not resolve. Losing it costs an ambiguity signal.
   */
  const resolver: DestinationResolver = createOpenResolver({
    diagnostics,
    corroborate: (query) => interpretDestination(model, query),
  });

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
      /*
       * THE GATE, ON THE EXPANSION PATH — the second half of CS-10.
       *
       * A proposed base is geocoded by name, and geocoding by name is exactly
       * how a model's plausible-sounding town in the wrong country becomes a
       * real coordinate with a real OSM element id. Every other property of this
       * loop was already careful — an invented town does not resolve, so it
       * never reaches the compiled region — and none of that checks whether the
       * town that *did* resolve is anywhere near the destination.
       *
       * There is no pack here, so the directory is empty and the comparison
       * rests on what the geocoder published about the place: its country, and
       * its first-level division where it gave one. That is enough for the case
       * that matters, and where it is not enough the base survives as
       * `membership_unknown` rather than being deleted on a distance.
       */
      const baseOverlay = buildTripScopeOverlay({ scope, records: [], roleEligible });
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
          /*
           * The base's name, resolved English-first.
           *
           * `first.name` is the geocoder's *local* name by design, and taking
           * it directly is what rendered a compiled trip's base as
           * `Бишкек шаары` on every screen. The resolver prefers a
           * source-published English name — `name:en` from the record, or the
           * destination index's own English resolution for the same
           * coordinate — and keeps the local form beside it.
           */
          const names = resolveEntityName({
            fallback: first.name ?? candidate.name,
            coordinates: { lat, lng },
            ...(scope.countryCode ? { countryCode: scope.countryCode } : {}),
            place: first,
          });

          const baseId = osmElementId(first) ?? `base-${candidate.name}`;
          const decision = admitLateCandidate(baseOverlay, {
            id: baseId,
            coordinates: { lat, lng },
            containment: containmentFromAddress(first),
            planningRole: 'lodging',
            name: names.display,
          });
          if (decision.relationship === 'outside_scope') {
            gaps.push({
              subjectId: candidate.name,
              reason: 'not_found',
              detail:
                'A proposed base resolved to somewhere the sources place outside this trip, so it was dropped.',
            });
            continue;
          }

          bases.push({
            id: baseId,
            name: names.display,
            names,
            coordinates: { lat, lng },
            timeZone: regionTimeZone(scope),
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
          timeZone: regionTimeZone(scope),
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

  /**
   * NORMALISED MAP ELEMENTS, TURNED INTO CANDIDATES THE BOARD CAN HOLD.
   *
   * Extracted so the ordinary fallback sweep and a deficit-directed acquisition
   * share one definition of what a candidate *is*. Two copies of this would
   * drift, and the way they would drift is the dangerous way: an acquisition
   * path with its own gate, its own standing model or its own confidence
   * default is an acquisition path that can admit a record the ordinary one
   * would have refused.
   */
  async function buildOsmCandidates(inputs: {
    normalized: readonly NormalizedOsmPlace[];
    scope: GeographicScope;
    includedAreas?: readonly TripIncludedArea[];
    limit: number;
  }): Promise<{
    candidates: DiscoveredCandidate[];
    gaps: ProviderGap[];
    /** Classification calls spent here, so a caller can charge them. */
    modelCalls: number;
  }> {
    const { normalized, scope, includedAreas, limit } = inputs;
    const modelCallsBefore = model.usage.calls;
      // Bounded before classification: the model call is the expensive one, and
      // a bbox in a dense city returns far more than a trip can hold.
      const shortlist = normalized.slice(0, Math.min(120, Math.max(20, limit)));

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
            {
              subjectId: scope.destinationCandidateId,
              reason: 'provider_error' as const,
              detail: 'Nothing could be classified, so nothing was kept rather than guessed at.',
            },
          ],
          modelCalls: Math.max(0, model.usage.calls - modelCallsBefore),
        };
      }

      /*
       * THE GATE, ON THE FALLBACK PATH — CS-10.
       *
       * This branch used to build candidates straight from a reach box and hand
       * them to the board, so a source family that answered when the primary
       * catalogue did not was the one family nothing checked. A live New York
       * build reached a traveller's board with twenty-three records from another
       * state, and the same shape was reachable here with no pack at all.
       *
       * The fallback carries no administrative geography of its own — the map
       * service publishes tags, not addresses — so almost everything here is
       * honestly `membership_unknown`: shown on a provisional board, labelled,
       * and kept out of a final attraction slot and away from the planner. That
       * is a thinner board than the old behaviour and it is the truthful one.
       */
      const fallbackOverlay = buildTripScopeOverlay({
        scope,
        records: shortlist.map(fallbackRecordFor),
        roleEligible,
        ...(includedAreas ? { includedAreas: includedAreas.map(toIncludedArea) } : {}),
      });
      let refusedByScope = 0;

      const candidates: DiscoveredCandidate[] = [];
      for (const entry of classified.places) {
        const osm = shortlist[entry.index];
        if (!osm) continue;

        const decision = decisionFor(fallbackOverlay, `fallback:${osm.elementId}`);
        if (!decision.eligibility.provisionalBoardEligible) {
          refusedByScope += 1;
          continue;
        }

        /**
         * STANDING, FROM WHAT THE MAP ACTUALLY CARRIES.
         *
         * This branch used to read `popularity = 0.25 + (tagCount / 5) * 0.5`
         * and then `hiddenGem = 1 − popularity` and `crowd = popularity > 0.7`.
         * A tag count is how thoroughly a mapper described something; calling it
         * popularity, its inverse a hidden gem and its threshold a crowd meant
         * three of a card's badges were one number, and the number was somebody
         * else's editing effort. A well-maintained chain café read as famous and
         * busy; an untagged shrine read as an undiscovered find.
         *
         * `assessPlaceStanding` is the same model the compiled path uses, so the
         * two producers cannot drift apart again — which is the state they were
         * found in, with different formulas for the same field.
         *
         * OSM has no rating and no review count, and that stays a feature rather
         * than a gap: there is no popularity number here to mistake for quality,
         * so most of these places carry no prominence at all — and now say so by
         * leaving it absent instead of by scoring low.
         */
        const standing = assessPlaceStanding({
          inKnowledgeBase: osm.planningTags.wikidata !== undefined,
          publishedSites: [osm.planningTags.website, osm.planningTags['contact:website']].filter(
            (url): url is string => url !== undefined,
          ),
          classifyingValues: [osm.primaryTag],
          recordedAttributeCount: Object.keys(osm.planningTags).length,
          // The one crowd signal a tag set carries. A `seasonal` element packs a
          // year of visitors into a short window; it never says how many.
          crowd: { seasonalConcentration: osm.planningTags.seasonal !== undefined },
        });

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
          /*
           * The containment relationship travels as a tag, which is the one
           * channel that survives every artifact boundary a place crosses. A
           * consumer reads why this is here rather than assuming it belongs.
           */
          tags: [
            osm.primaryTag,
            ...Object.keys(osm.planningTags).map((key) => `attr:${key}`),
            placeInclusionTag(decision.relationship),
            /*
             * The part this plays in a trip, stamped like every pack record.
             *
             * Records built here reach the board without ever passing through
             * the inventory's classifier, so they carried no role at all — and
             * every count derived from roles was structurally unable to see
             * them. After an acquisition the funnel reported a breakdown of the
             * three places the pack held beside a total of eleven, because the
             * eight new ones were in neither the anchors nor the discoveries.
             *
             * The rule lives in `@sidequest/core` beside `placeRoleTag` so that
             * this path and the fixture path cannot answer it differently. They
             * did once: the first version of this fix was written into the
             * fixture only, so the test asserted a property of the fake and
             * production shipped the inconsistency untouched.
             */
            placeRoleTag(planningRoleForCategory(entry.category)),
          ],
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
            /*
             * Derived from how much the element carries, where this was the
             * constant `0.7` — a number that claimed somebody had measured our
             * confidence in a record nobody had looked at.
             */
            confidence: standing.sourceConfidence,
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
          /*
           * Popularity, hidden-gem and crowd are reads of the standing above,
           * and the separated scores travel beside them. One spread, so this
           * producer has no fallback of its own to disagree with.
           */
          ...standingFields(standing),
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

      const gaps: ProviderGap[] = [];
      if (refusedByScope > 0) {
        gaps.push({
          subjectId: scope.destinationCandidateId,
          reason: 'not_found',
          detail: `${refusedByScope} ${refusedByScope === 1 ? 'place' : 'places'} the map data returned belong somewhere else, so they were left out.`,
        });
      }
      return {
        candidates,
        gaps,
        modelCalls: Math.max(0, model.usage.calls - modelCallsBefore),
      };
  }

  const places: PlaceDiscoveryProvider = {
    name: 'region-pack',
    async discover({
      scope,
      queries,
      pack,
      includedAreas,
      recovery,
      namedByTraveller,
      acquire,
    }) {
      /**
       * A DEFICIT-DIRECTED SEARCH, BEFORE THE PACK SHORT-CIRCUIT.
       *
       * Placed above the `if (pack)` branch on purpose. A pack is a bounded,
       * release-pinned inventory and that branch correctly refuses to ask a live
       * service the same question again — which is exactly why the previous
       * acquiring repair achieved nothing: it passed queries into a function
       * that returns before reading them, and reported spend for a call nobody
       * made. An acquisition is not the same question, so it is answered before
       * the short-circuit rather than inside it.
       *
       * Three disciplines hold here, and each one is a defect that shipped:
       *
       * 1. **Nothing this returns is written to `packInventory` or
       *    `packOverlay`.** Those are what the food stage and the must-do
       *    resolver read, and a narrow answer replacing them is how a repair
       *    partially undid the free repair before it.
       * 2. **The cache entry is its own.** `fetchPoisForIntents` uses a distinct
       *    `kind` *and* a selector digest, so a targeted read can never land on
       *    the broad sweep's key.
       * 3. **Calls are reported honestly**, so the ledger is not a work of
       *    fiction in either direction.
       */
      if (acquire) {
        if (!isPoiProviderEnabled()) {
          /**
           * NO SECOND SERVICE IS NOT THE SAME AS NOTHING LEFT TO LOOK AT.
           *
           * This used to be the whole answer: no live map service configured, so
           * the deficit-directed look returned a gap and the traveller was told
           * we had found nothing for the very thing they said the trip was for.
           * In the deployment that shipped, that is *every* acquisition, because
           * the live POI service is deliberately off.
           *
           * But a pack has already been fetched, and the broad read of it is
           * lossy on purpose: `maxPerCategory` holds back a dense category so a
           * board is not four hundred plaques, and `maxAreaShare` stops one
           * district standing for a region. Those ceilings are correct for a
           * general-purpose read and wrong for a directed one — when the deficit
           * *is* culture, the twenty-third museum is exactly what was wanted.
           *
           * So a second pass runs over the same pack with the density ceilings
           * lifted for the intents that were asked for. No network, no spend,
           * and additive by construction: only records the broad read did not
           * already return are kept, and neither the cached inventory nor the
           * cached overlay is touched — both are what the food stage and the
           * must-do resolver read, and replacing them with a narrow answer is
           * how an earlier repair undid the repair before it.
           */
          if (!pack) {
            return {
              candidates: [],
              gaps: [
                {
                  subjectId: scope.destinationCandidateId,
                  reason: 'provider_error',
                  detail:
                    'There is no map service switched on that we could ask for the kinds of place this trip is missing.',
                },
              ],
              calls: 0,
            };
          }

          const alreadyHeld = new Set(
            (packInventory?.candidates ?? []).map((candidate) => candidate.place.id),
          );
          const widened = buildInventory({
            pack,
            scope,
            ...(packOverlay ? { overlay: packOverlay } : {}),
            limits: {
              /*
               * Only the two density ceilings move, and only far enough to let a
               * dense category through. Everything that decides whether a record
               * is a *place* at all — containment, role, identity, closure — is
               * untouched, because a directed look must widen the search and
               * never lower the bar.
               */
              maxPerCategory: DEFAULT_INVENTORY_LIMITS.maxPerCategory * 4,
              maxAreaShare: 1,
              maxAttractions: DEFAULT_INVENTORY_LIMITS.maxAttractions * 2,
            },
          });
          const found = widened.candidates.filter(
            (candidate) =>
              !alreadyHeld.has(candidate.place.id) &&
              matchesAcquisitionIntent(candidate.place.category, acquire.intents),
          );
          const candidates = found.slice(0, acquire.maxRecords);
          return {
            candidates,
            gaps:
              candidates.length > 0
                ? []
                : [
                    {
                      subjectId: scope.destinationCandidateId,
                      reason: 'not_found',
                      detail:
                        'We looked through the regional place data a second time for the kinds of place this trip is missing, and there is nothing further in it.',
                    },
                  ],
            // No network was reached, and saying otherwise would make the
            // budget ledger a work of fiction in the expensive direction.
            calls: 0,
            ...(candidates.length > 0 ? { licences: [OSM_LICENCE_PLACES, AUTHORED_LICENCE] } : {}),
          };
        }
        const acquireRadiusKm = scope.shape.kind === 'radius' ? scope.shape.radiusKm : 40;
        const lngDegree = (km: number): number =>
          km / (111 * Math.max(0.1, Math.cos((scope.center.lat * Math.PI) / 180)));
        const acquireBox: BoundingBox =
          scope.bounds !== undefined
            ? {
                south: scope.bounds.southWest.lat,
                west: scope.bounds.southWest.lng,
                north: scope.bounds.northEast.lat,
                east: scope.bounds.northEast.lng,
              }
            : {
                south: scope.center.lat - acquireRadiusKm / 111,
                north: scope.center.lat + acquireRadiusKm / 111,
                west: scope.center.lng - lngDegree(acquireRadiusKm),
                east: scope.center.lng + lngDegree(acquireRadiusKm),
              };

        const targeted = await fetchPoisForIntents(acquireBox, acquire.intents, {
          limit: acquire.maxRecords,
          retries: 0,
          /*
           * AN ABSOLUTE INSTANT, NOT A DURATION.
           *
           * `deadlineMs` is an epoch millisecond and is compared against
           * `Date.now()`. Passing the *budget* here rather than `now + budget`
           * made every selector group fail its deadline check on the first
           * iteration, so the acquisition returned an empty answer without
           * issuing a single request — and reported it as "nothing further came
           * back", which is indistinguishable from the map genuinely holding
           * nothing. A one-token unit error that reproduced, exactly, the defect
           * this whole path was rebuilt to fix.
           */
          deadlineMs: Date.now() + POI_STAGE_BUDGET_MS,
          cache: cacheFor<OverpassResult>('overpass-targeted', TTL.poi),
        });
        diagnostics.poiCalls += targeted.calls;
        diagnostics.poiElements += targeted.elements.length;

        const acquired = targeted.elements
          .map((element) => normalizeElement(element))
          .filter((entry): entry is NormalizedOsmPlace => entry !== null);

        const built = await buildOsmCandidates({
          normalized: acquired,
          scope,
          ...(includedAreas ? { includedAreas } : {}),
          limit: acquire.maxRecords,
        });
        /*
         * A REFUSAL IS AN ANSWER, AND HAS TO BE REPORTED AS ONE.
         *
         * `failedGroups` was discarded, so an acquisition where every selector
         * group was rate-limited or timed out returned `candidates: []` with no
         * gap attached — which the loop then recorded as "nothing further came
         * back". The provider contract on this seam is explicit that a provider
         * may not answer "I don't know" by omission, and a silent empty answer
         * is exactly that.
         */
        const acquireGaps = [...built.gaps];
        if (targeted.failedGroups.length > 0) {
          acquireGaps.push({
            subjectId: scope.destinationCandidateId,
            reason: 'provider_error',
            detail:
              targeted.elements.length === 0
                ? 'The map service refused every one of the searches we made for the kinds of place this trip is missing.'
                : `The map service refused ${targeted.failedGroups.length} of the searches we made, so this second look is incomplete.`,
          });
        }
        return {
          candidates: built.candidates,
          gaps: acquireGaps,
          /*
           * Map calls *and* the classification call, because both were spent.
           *
           * An earlier version returned only the Overpass count on the reasoning
           * that "the model spend is separate" — and then charged it nowhere, so
           * a real Anthropic call inside `buildOsmCandidates` was invisible to
           * every budget and the attempt record asserted `modelCalls: 0`. A
           * counter that omits a spend is worse than no counter.
           */
          calls: targeted.calls,
          modelCalls: built.modelCalls,
          /*
           * Attribution only for data we actually used. Returning the ODbL
           * notice on an empty answer puts an attribution on a compiled region
           * for a source that contributed nothing to it.
           */
          ...(built.candidates.length > 0
            ? { licences: [OSM_LICENCE_PLACES, AUTHORED_LICENCE] }
            : {}),
        };
      }

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
        /*
         * THE GATE, ON THE PACK PATH.
         *
         * The overlay is built here rather than inside `buildInventory` because
         * this is the first place that has both the pack *and* the regional
         * expansion's areas — and those areas are the only thing that can
         * legitimately admit a record outside the destination's boundary.
         * `buildInventory` builds one itself when a caller has nothing to add,
         * so the gate cannot be skipped; passing one only makes it better
         * informed.
         */
        const overlay = (packOverlay = buildTripScopeOverlay({
          scope,
          records: pack.layers.flatMap((layer) => layer.records),
          roleEligible,
          ...(includedAreas ? { includedAreas: includedAreas.map(toIncludedArea) } : {}),
        }));
        const inventory = buildInventory({
          pack,
          scope,
          overlay,
          // Absent on an ordinary build; set only by the recovery loop, and only
          // ever in the widening direction.
          ...(recovery ? { limits: recovery } : {}),
          // A record the traveller named by hand is ranked first among records
          // that already qualified. It cannot get past a gate; see `rank`.
          ...(namedByTraveller ? { prioritizeNames: namedByTraveller } : {}),
        });
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
        /*
         * THE SHORTAGE, SAID OUT LOUD.
         *
         * A board of six that can also say "eighteen more were transport, shops
         * and services" is a different product from a board of six. Without
         * this, an honest board is simply a shorter one and a traveller cannot
         * tell a thin destination from a thin read of a rich one.
         *
         * It is a gap rather than a warning because that is what it is: the
         * ground did not supply enough to plan around, and the coverage report
         * is where this product already says so.
         */
        const supply = inventory.portfolio.supply;
        if (supply.shortfalls.length > 0) {
          gaps.push({
            subjectId: scope.destinationCandidateId,
            reason: 'not_found',
            detail: supply.summary,
          });
        }
        return {
          candidates: inventory.candidates,
          gaps,
          calls: 0,
          licences: [...inventory.licences, AUTHORED_LICENCE],
          /*
           * The two halves of the account, joined here because this is the only
           * layer that holds both. The inventory knows what it set aside; the
           * containment overlay knows what it excluded and why. By the time the
           * artifact is written, both have been collapsed into a list.
           */
          boardSupply: {
            supportKeptSeparately: inventory.portfolio.supply.supply.supporting,
            withheldUnplaceable: overlay.integrity.membershipUnknown,
            removedOutOfScope: overlay.integrity.outOfScope,
            gateways: overlay.integrity.gateways,
            expansionMembers: overlay.integrity.expansionMembers,
            satellites: overlay.integrity.satellites,
          },
          portfolioFacts: portfolioFactsFrom(inventory, pack, overlay),
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

      const built = await buildOsmCandidates({
        normalized,
        scope,
        ...(includedAreas ? { includedAreas } : {}),
        limit: wanted,
      });
      gaps.push(...built.gaps);

      return {
        candidates: built.candidates,
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
          /**
           * Null, not a number.
           *
           * Nothing here knows how long it takes to walk to this place. What we
           * have is a routable location, which is why the provenance below says
           * so. Writing a constant made every car-free plan in the product read
           * "10 min" for every leg of every day, and the day totals, the trip
           * totals and both travel-budget validators were computed from it.
           * The planner reads the walking matrix when there is one and reports
           * an absence when there is not.
           */
          ...(scope.transport.carAvailable ? {} : { approachMinutes: null }),
          privateVehicle: 'allowed' as const,
          serviceRequirement: 'none' as const,
          /** Same reason. There is no drop-off here and no walk from one. */
          walkMinutesFromDropOff: 0,
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

  const routing: RoutingProvider = createOpenRouting(diagnostics);

  /**
   * Public transport, when this build was told it has a router that can answer.
   *
   * `supportsTransit` reads the switch rather than probing, because it is
   * consulted before any pair is chosen — it decides whether a car-free
   * traveller's reach is a walking radius or a transit one, and a network round
   * trip inside that decision would put a socket in a scope derivation. The
   * probing happens per journey, where it can be acted on.
   */
  const transitProvider: TransitRoutingProvider = {
    name: 'valhalla-multimodal',
    supportsTransit() {
      return isTransitProviderEnabled();
    },
    async routes({ pairs, departAt, timeZone, maxPairs, deadlineMs }) {
      /**
       * ONE PRE-FLIGHT, BEFORE ANY PAIR IS BOUGHT.
       *
       * `supportsTransit()` reads a switch, and a switch says what somebody
       * *configured*, not what the instance actually holds. A Valhalla server
       * built without GTFS tiles answers a multimodal request with a walking
       * route or a 170, so a build pointed at one would have widened a car-free
       * traveller's ground to a transit radius, reported no readiness gap, and
       * then failed every journey — the widened ground justified by a
       * measurement that was never going to arrive.
       *
       * `has_transit_tiles` is computed from the same predicate that drives the
       * 170 refusal, so it predicts it reliably. Absent means the instance does
       * not publish verbose status, which is treated as unknown and therefore
       * unavailable: a capability we cannot confirm is not one we claim.
       */
      const tiles = await transitTilesAvailable({});
      if (!tiles) {
        const now = new Date().toISOString();
        return {
          journeys: pairs.slice(0, maxPairs).map((pair) => ({
            fromId: pair.fromId,
            toId: pair.toId,
            status: 'out_of_coverage' as const,
            requestBasis: {
              kind: 'depart_at' as const,
              instant: departAt.toISOString(),
              timeZone,
            },
            source: 'valhalla-multimodal',
            retrievedAt: now,
            detail: 'The journey planner here holds no public-transport timetables.',
          })),
          gaps: [
            {
              subjectId: 'transit',
              reason: 'no_official_source' as const,
              detail:
                'The routing service configured for this build was not prepared with timetable data, so no public-transport journey could be measured.',
            },
          ],
          calls: 0,
        };
      }
      const outcome = await measureTransitJourneys(
        pairs,
        { departAt, timeZone },
        {
          maxPairs,
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
          cache: cacheFor<TransitJourney>('valhalla-transit', TTL.matrix),
        },
      );
      diagnostics.transitCalls += outcome.calls;
      diagnostics.transitPairsRequested += outcome.journeys.length;
      diagnostics.transitPairsMeasured += outcome.journeys.filter(
        (journey) => journey.status === 'measured',
      ).length;
      return {
        journeys: outcome.journeys,
        gaps: outcome.journeys
          .filter((journey) => journey.status === 'provider_error')
          .map((journey) => ({
            subjectId: journey.toId,
            reason: 'provider_error' as const,
            detail: journey.detail,
          })),
        calls: outcome.calls,
        licences: [OSM_LICENCE_ROUTING],
      };
    },
  };

  const timeZoneProvider: TimeZoneProvider = {
    name: 'open-meteo',
    async resolve({ points, maxCalls }) {
      const outcome = await resolveCivilTimeZones(points, {
        maxCalls,
        cache: cacheFor<{ timeZone: string }>('open-meteo-timezone', TIME_ZONE_TTL_MS),
      });
      diagnostics.timeZoneCalls += outcome.calls;
      diagnostics.timeZoneCacheHits += outcome.cacheHits;
      return {
        zones: outcome.answers.map((answer) => ({
          pointId: answer.id,
          timeZone: answer.timeZone,
          detail: answer.detail,
        })),
        /*
         * A point with no zone is a gap rather than an omission. Downstream it
         * keeps whatever zone it arrived with, and the artifact's own basis says
         * how much that is worth — but the reason it could not be improved is
         * recorded here rather than inferred from an absence.
         */
        gaps: outcome.answers
          .filter((answer) => answer.timeZone === null)
          .map((answer) => ({
            subjectId: answer.id,
            reason: 'no_official_source' as const,
            detail: answer.detail,
          })),
        calls: outcome.calls,
        source: 'open-meteo',
        resolvedAt: new Date().toISOString(),
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
      const zone = regionTimeZone(scope);
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
  /**
   * A BOUNDED, TARGETED LOOK FOR SOMEWHERE TO EAT, AROUND WHERE THE TRAVELLER
   * WILL ACTUALLY BE.
   *
   * Extracted from the fallback branch so that it can serve two callers: a
   * region with no pack at all, and — the reason it moved — a region *with* a
   * pack whose food supply came up short. Those used to be exclusive, and the
   * exclusivity is what let a six-day trip stop at three restaurants.
   *
   * Three properties the callers depend on:
   *
   *   1. **Additive.** `exclude` carries the ids the caller already holds, so a
   *      top-up can never return a narrower version of what it is topping up.
   *   2. **Bounded.** One box per base, one call each, a stage deadline, and a
   *      hard ceiling on what comes back.
   *   3. **Honest about calls.** The count it reports is the count it made, so
   *      the budget ledger stays a record rather than an estimate.
   */
  async function acquireFoodNearBases(input: {
    scope: GeographicScope;
    bases: readonly { id: string; coordinates: { lat: number; lng: number } }[];
    /**
     * Every node the matrix will hold, not only the bases a box was drawn
     * around. The box is `FOOD_BOX_DEGREES` — about five kilometres — so a venue
     * at its edge is nowhere near the base at its centre, and the base is not
     * necessarily the nearest node to it either.
     */
    anchors: readonly { id: string; coordinates: { lat: number; lng: number } }[];
    maxVenues: number;
    exclude: ReadonlySet<string>;
  }): Promise<{ venues: FoodVenue[]; gaps: ProviderGap[]; calls: number }> {
    const { scope, bases, anchors, maxVenues } = input;
    const gaps: ProviderGap[] = [];
    const venues: FoodVenue[] = [];
    if (maxVenues <= 0) return { venues, gaps, calls: 0 };

    const seen = new Set<string>();
    const perBase = Math.max(6, Math.ceil(maxVenues / Math.max(1, bases.length)));
    let calls = 0;

    /*
     * THE GATE, ON THE LIVE FOOD PATH.
     *
     * A meal is scheduled at a named venue, so a venue is a candidate the
     * planner consumes — and this path fetches them from a box drawn around each
     * base, which knows nothing about boundaries. A base that is itself only
     * `membership_unknown` would otherwise carry its whole food box with it.
     *
     * The source publishes tags rather than addresses, so most venues here are
     * honestly unplaceable and are admitted as such; what the gate removes is
     * the venue a source puts in a different country, which a box drawn near a
     * border will otherwise return.
     */
    let refusedFood = 0;
    let unroutable = 0;
    const foodOverlay = buildTripScopeOverlay({ scope, records: [], roleEligible });

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
        calls += result.calls;
        if (result.cacheHit) diagnostics.poiCacheHits += 1;

        for (const element of result.elements) {
          if (venues.length >= maxVenues) break;
          const normalized = normalizeElement(element);
          if (!normalized || seen.has(normalized.elementId)) continue;
          /*
           * The base the box was drawn around is not automatically this venue's
           * node. `base.id` was passed unconditionally, so a venue at the far
           * corner of a five-kilometre box was priced against the middle of it
           * and the day quoted the base's own travel time as a walk to the door.
           */
          const snap = snapVenue(anchors, normalized.coordinates);
          if (!snap) {
            unroutable += 1;
            continue;
          }
          const built = toFoodVenue(normalized, scope, snap.routingId);
          if (!built) continue;
          const venue: FoodVenue = {
            ...built,
            walkMinutesFromRouting: snap.walkMinutesFromRouting,
          };
          if (input.exclude.has(venue.id)) continue;
          const decision = admitLateCandidate(foodOverlay, {
            id: `food:${normalized.elementId}`,
            coordinates: normalized.coordinates,
            containment: { divisionIds: [] },
            planningRole: 'food',
            name: normalized.name,
          });
          if (!decision.eligibility.plannerEligible && decision.relationship === 'outside_scope') {
            refusedFood += 1;
            continue;
          }
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

    if (unroutable > 0) gaps.push(unroutableFoodGap(unroutable));

    if (refusedFood > 0) {
      gaps.push({
        subjectId: 'food',
        reason: 'not_found',
        detail: `${refusedFood} ${refusedFood === 1 ? 'place' : 'places'} to eat that the map data returned belong somewhere else, so they were left out.`,
      });
    }

    return { venues, gaps, calls };
  }

  const food: FoodDiscoveryProvider = {
    name: 'region-pack-food',
    async discover({ scope, bases, maxVenues, pack, places: knownPlaces }) {
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
      /**
       * THE CONTRACT, ENFORCED WHERE THE REGION'S FOOD IS ASSEMBLED.
       *
       * Every venue leaving this stage carries a node it is within one door walk
       * of, and a door walk that is the distance to that node. Both food paths
       * below already hold to it by construction; this is the assertion that
       * makes a third path, or a later edit that reaches for a bare nearest
       * anchor again, fail here instead of shipping a measured travel time to
       * somewhere the traveller is not going.
       */
      const checked = (result: { venues: FoodVenue[]; gaps: ProviderGap[]; calls: number }) => {
        assertFoodRoutingWithinDoorWalk({
          venues: result.venues,
          anchors,
          walkKmh: MODELLED_WALK_KMH,
        });
        return result;
      };
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
        /*
         * The same overlay the places path used, or none at all.
         *
         * Falling back to `buildInventory({ pack, scope })` here judged food
         * against a *second* overlay that knew nothing about the regional
         * expansion, so one compilation could hold two different answers to
         * "does this belong". Reusing the cached inventory is the only shape in
         * which both halves of a trip are judged the same way.
         */
        const inventory = packInventory ?? buildInventory({ pack, scope, overlay: packOverlay });
        const venues: FoodVenue[] = [];
        const gaps: ProviderGap[] = [];
        /**
         * EVERY CANDIDATE FIRST, THEN THE CEILING — and the order is the fix.
         *
         * This used to walk `foodRecords` in the inventory's own order and stop
         * at `maxVenues`, so the eighteen venues a trip got were the first
         * eighteen a general-purpose significance ranking happened to surface.
         * A live six-day compilation in a city of extraordinary food came back
         * with three, one of them a Domino's Pizza, because nothing between the
         * pack and the plan could tell an outlet from somewhere people queue
         * for.
         *
         * So the whole pool is built, scored for how particular each venue is to
         * this region — see `foodDistinctiveness`, which reads repetition inside
         * the region rather than a brand list — and only then cut. A franchise
         * counter can still be kept; it can no longer displace a distinctive
         * local kitchen merely by being read off disk first.
         */
        const pool: FoodVenue[] = [];
        let unroutable = 0;
        for (const record of inventory.foodRecords) {
          /*
           * No node within a door walk, no venue. The fallback this replaced —
           * `nearest?.id ?? bases[0]?.id` — had no ceiling at either step, so a
           * record with nothing near it was priced against the least distant
           * anchor or, failing that, against the first base outright.
           */
          const snap = snapVenue(anchors, record.coordinates);
          if (!snap) {
            unroutable += 1;
            continue;
          }
          const built = foodVenueFromRecord({ record, scope, routingId: snap.routingId });
          if (!built) continue;
          /*
           * `foodVenueFromRecord` writes a zero door walk it has no way to know
           * — it is handed a node id and never the distance to it. The real
           * figure is the one thing that makes the leg to this venue honest, so
           * it is applied here, where the distance was measured.
           */
          const venue: FoodVenue = {
            ...built,
            walkMinutesFromRouting: snap.walkMinutesFromRouting,
          };
          /*
           * The open-knowledge identifier, carried onto the venue the same way
           * the attraction side carries it. Without this the distinctiveness
           * signal's evidence channel is inert on every compiled region, which
           * is a signal that reads as absent rather than as negative.
           */
          pool.push(
            record.wikidataId
              ? { ...venue, tags: [...venue.tags, 'attr:wikidata'] }
              : venue,
          );
        }

        const counts = foodNameCounts(pool);
        const ranked = pool
          .map((venue) => ({ venue, quality: foodDistinctiveness(venue, counts) }))
          .sort(
            (a, b) =>
              b.quality.score - a.quality.score || a.venue.name.localeCompare(b.venue.name),
          );
        venues.push(...ranked.slice(0, Math.max(0, maxVenues)).map((entry) => entry.venue));
        if (unroutable > 0) gaps.push(unroutableFoodGap(unroutable));

        /**
         * ---- THE PACK IS A FLOOR, NOT A CEILING --------------------------
         *
         * This branch used to `return` here, which made the pack the *only*
         * source of food whenever one existed. A live six-day trip therefore
         * ended with three venues and no further attempt, because the answer
         * "the pack holds three restaurants" was treated as the answer to "where
         * can this traveller eat".
         *
         * §8.1 says the opposite: if the portfolio is weak, keep researching
         * within bounds. So the live map path below is now a **top-up** rather
         * than an alternative — it runs only for the shortfall, only around the
         * bases the traveller will actually be near, and only when a map service
         * is switched on. When none is, the shortfall is reported honestly and
         * the compiler turns that into a limitation the traveller can act on
         * rather than a silent three-restaurant trip.
         */
        if (venues.length < maxVenues && isPoiProviderEnabled()) {
          const topUp = await acquireFoodNearBases({
            scope,
            bases,
            anchors,
            maxVenues: maxVenues - venues.length,
            exclude: new Set(venues.map((venue) => venue.id)),
          });
          venues.push(...topUp.venues);
          gaps.push(...topUp.gaps);
          if (topUp.venues.length > 0) return checked({ venues, gaps, calls: topUp.calls });
        }

        if (venues.length === 0) {
          gaps.push({
            subjectId: 'food',
            reason: 'not_found',
            detail: 'The place data has nothing to eat recorded inside this region.',
          });
        } else if (venues.length < maxVenues && !isPoiProviderEnabled()) {
          /*
           * The honest half of §8.2. We looked, we found some, and there is no
           * second source configured to look again — so the shortfall is stated
           * as a fact about our sources rather than left to read as the region
           * having nothing else.
           */
          gaps.push({
            subjectId: 'food',
            reason: 'no_official_source',
            detail: `The place data holds ${venues.length} ${venues.length === 1 ? 'place' : 'places'} to eat inside this region, and there is no second map service switched on to look further.`,
          });
        }
        return checked({ venues, gaps, calls: 0 });
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

      const acquired = await acquireFoodNearBases({
        scope,
        bases,
        anchors,
        maxVenues,
        exclude: new Set<string>(),
      });
      if (acquired.venues.length === 0 && acquired.gaps.length === 0) {
        acquired.gaps.push({
          subjectId: 'food',
          reason: 'not_found',
          detail: 'The map data has no named places to eat near any of the bases we chose.',
        });
      }
      return checked({ venues: acquired.venues, gaps: acquired.gaps, calls: acquired.calls });
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
    /**
     * Bumped whenever the query wording or the tier order changes.
     *
     * It is part of the shared discovery cache key, so a remembered "nobody
     * publishes this" from an older phrasing cannot outlive the phrasing that
     * produced it.
     */
    version: PROMPT_VERSIONS.findOfficialSources,
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
      const unchanged: NonNullable<SourceRetrievalResult['unchanged']> = [];
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
            ...(reference.conditional ? { validators: reference.conditional } : {}),
          });

          /**
           * The server says nothing changed.
           *
           * Reported separately from a document, because a 304 has no body and
           * an empty body is not an empty page. The caller holds the content
           * already; what it gains here is a refreshed set of validators and the
           * knowledge that it did not have to transfer anything.
           */
          if (result.notModified) {
            diagnostics.pagesRevalidated += 1;
            unchanged.push({
              url: reference.url,
              subjectId: reference.subjectId,
              validators: {
                ...(result.metadata.etag ? { etag: result.metadata.etag } : {}),
                weakEtag: result.metadata.weakEtag,
                ...(result.metadata.lastModified
                  ? { lastModified: result.metadata.lastModified }
                  : {}),
                ...(result.metadata.cacheControl
                  ? { cacheControl: result.metadata.cacheControl }
                  : {}),
                ...(result.metadata.vary ? { vary: result.metadata.vary } : {}),
              },
              bytesAvoided: 0,
            });
            continue;
          }

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
            validators: {
              ...(result.metadata.etag ? { etag: result.metadata.etag } : {}),
              weakEtag: result.metadata.weakEtag,
              ...(result.metadata.lastModified
                ? { lastModified: result.metadata.lastModified }
                : {}),
              ...(result.metadata.cacheControl
                ? { cacheControl: result.metadata.cacheControl }
                : {}),
              ...(result.metadata.vary ? { vary: result.metadata.vary } : {}),
            },
            truncated: result.truncated,
            redirects: result.redirects,
          });
        } catch (error) {
          diagnostics.pagesRejected += 1;
          const unsafe = error instanceof UnsafeUrlError;
          /**
           * "The site asks us not to" is its own answer.
           *
           * Folding it into "unsafe" told a traveller their museum's page was
           * dangerous when the truth was that we were being polite, and left the
           * store unable to remember not to ask again.
           */
          const robots = unsafe && (error as UnsafeUrlError).code === 'robots_disallowed';
          rejected.push({
            url: reference.url,
            subjectId: reference.subjectId,
            reason: robots ? 'blocked_by_robots' : unsafe ? 'rejected_unsafe_source' : 'provider_error',
            detail: robots
              ? 'That site asks us not to read that page, so we did not.'
              : unsafe
                ? 'That page was not safe to read, so we did not.'
                : 'That page did not answer in time.',
          });
        }
      }

      return { documents, unchanged, rejected, gaps: [], bytes };
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
    promptVersion: PROMPT_VERSIONS.extractFacts,
    schemaVersion: 'planning-extraction/1',
    modelId: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    async extract({ subjects, documents, maxCalls }) {
      const before = { ...model.usage };
      const claims: ExtractedClaim[] = [];
      const gaps: ProviderGap[] = [];
      const subjectIndex = new Map(subjects.map((subject, index) => [subject.id, index]));
      const subjectsById = new Map(subjects.map((subject) => [subject.id, subject]));

      /**
       * ENTITY AGREEMENT, BEFORE ANY FACT IS BORN — the namesake gate.
       *
       * The funnel upstream of this point binds pages to subjects by *name*: a
       * search result whose title contains a distinctive word matches, a
       * `website` tag is trusted outright. On a live artifact that attached a
       * municipal community centre's weekday hours, weekend closures and
       * lunch-ordering rules to a same-named protected headland — promoted to
       * "(Verified)", and obeyed by the planner, which then refused to schedule
       * an outdoor nature reserve on weekends.
       *
       * So every document is judged against its subject before a claim can come
       * out of it — the structured-data path and the model path alike, because
       * the community centre published `openingHoursSpecification` too. A
       * conflicted document produces no claims, is never sent to the model
       * (a page we will not believe is not worth paying to read), and leaves an
       * honest gap: the subject keeps "nobody confirmed its hours", which is
       * true, instead of a namesake's timetable, which is false.
       */
      const conflicted = new Map<number, string>();
      for (const [index, document] of documents.entries()) {
        const subject = subjectsById.get(document.subjectId);
        if (!subject) continue;
        const verdict = assessEntityAgreement({
          subject: { name: subject.name, kind: subject.kind, coordinates: subject.coordinates },
          document: {
            title: document.title,
            text: document.text,
            structuredData: document.structuredData,
          },
        });
        if (verdict.agreement === 'namesake_conflict') {
          conflicted.set(index, verdict.detail);
          gaps.push({
            subjectId: document.subjectId,
            reason: 'insufficient_evidence',
            detail: verdict.detail,
          });
        }
      }

      /**
       * DETERMINISTIC FIRST, AND THE MODEL ONLY FOR WHAT IS LEFT.
       *
       * A `schema.org/openingHoursSpecification` block is the operator stating
       * their hours in machine-readable form: free to read, impossible to
       * misread, and it arrives with a field pointer rather than a quotation.
       *
       * What changed here is the *second* half of that argument. The parser ran
       * first and the model was then asked anyway, on every page over two
       * hundred characters — so a page whose structured data already answered
       * every question we had still cost a model call. Now a document is only
       * sent to the model when something we wanted is still unresolved, and the
       * fact paths that caused the call are recorded.
       */
      const wantedBySubject = new Map<string, ReadonlySet<FactPath>>(
        subjects.map((subject) => [subject.id, new Set(subject.wantedPaths)]),
      );

      const needsModel: { index: number; document: RetrievedDocument }[] = [];
      for (const [index, document] of documents.entries()) {
        /* A namesake's page yields nothing — not hours, not a model call. */
        if (conflicted.has(index)) continue;
        const resolved = new Set<FactPath>();
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
          resolved.add('hours.weekly');
        }

        const wanted = wantedBySubject.get(document.subjectId) ?? new Set<FactPath>();
        const unresolved = [...wanted].filter((path) => !resolved.has(path));
        if (unresolved.length === 0) continue;
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
            // Belt to the queue's braces: a conflicted document was never sent,
            // but a claim indexed against one must still be impossible.
            if (conflicted.has(fact.sourceIndex)) continue;
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
        /**
         * What this call actually cost, measured as a delta rather than read
         * from a running total, so the evidence store can apportion it across
         * the pages the batch covered.
         */
        tokens: {
          input: model.usage.inputTokens - before.inputTokens,
          output: model.usage.outputTokens - before.outputTokens,
          cacheRead: model.usage.cacheReadTokens - before.cacheReadTokens,
          cacheWrite: model.usage.cacheWriteTokens - before.cacheWriteTokens,
        },
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
      /*
       * Both registered against the capability broker, and both present here
       * only when the broker says this build can actually reach them. A
       * capability the doctor reports as available and the product path cannot
       * invoke is the exact divergence the registry exists to prevent, so the
       * same predicate decides both.
       */
      ...(isTimeZoneResolverEnabled() ? { timeZone: timeZoneProvider } : {}),
      ...(isTransitProviderEnabled() ? { transit: transitProvider } : {}),
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
 * Whether the open stack is switched on, and which switches are missing.
 *
 * Both re-exported from `providers/switches.ts` rather than defined here. They
 * read environment variables and nothing else, but *this* module is the live
 * stack — importing it to ask a yes/no question dragged Nominatim, Valhalla,
 * Overture and the research model into the plan page's render graph. Nothing was
 * ever called from there; "nothing is called today" is a fact about the current
 * control flow rather than about the build, and it was one refactor from being
 * false.
 */
export { openProvidersEnabled, missingProviderSwitches } from './switches';

/**
 * THE ROLE HALF OF THE CONJUNCTION, SUPPLIED AT EVERY PRODUCTION CALL SITE.
 *
 * `eligibilityFor(relationship, roleEligible)` is the authoritative rule and it
 * is a **conjunction**: containment answers *where a record is*, the role layer
 * answers *what it may be used for*, and neither may override the other. A
 * caller that builds an overlay without this factor gets the containment half
 * alone, and every decision comes back claiming `roleEligible: true`.
 *
 * That was the state of all three production call sites, and it was not
 * harmless. `buildInventory` re-checks role eligibility itself, so the compiler
 * was unaffected — but the fallback branch admits a record on
 * `provisionalBoardEligible` alone, and a boolean no role has ever narrowed is
 * not a permission. The fallback's own selectors are curated to attraction tags,
 * yet `place_of_worship` is among them and the taxonomy witness-gates it (an
 * evidence-bearing temple admits; an unwitnessed storefront congregation does
 * not), so that shape was reachable there with no role permission consulted.
 *
 * Deliberately the *coarse* predicate — "is this eligible for anything at all" —
 * matching what `buildInventory` passes. A finer answer belongs to the layer
 * that knows which slot is being filled.
 */
function roleEligible(record: SourceRecord): boolean {
  return assessRecordEligibility(record).eligibility.provisionalBoard;
}

/**
 * What a geocoder published about where a resolved place is.
 *
 * Read from the address block it returns when `addressdetails` was asked for,
 * which is the only administrative evidence this path has. Absent fields stay
 * absent: an address a geocoder did not publish is not a disagreement, and
 * treating it as one would delete a legitimate base for a coverage gap.
 */
function containmentFromAddress(place: NominatimPlace): {
  countryCode?: string;
  regionName?: string;
  localityName?: string;
  divisionIds: readonly string[];
} {
  const address = place.address ?? {};
  const country = address.country_code;
  /* The code first, because a code compares against a code. */
  const region = address['ISO3166-2-lvl4'] ?? address.state ?? address.region ?? address.province;
  const locality =
    address.city ??
    address.town ??
    address.village ??
    address.municipality ??
    address.hamlet ??
    address.city_district;
  return {
    ...(country ? { countryCode: country.toUpperCase().slice(0, 2) } : {}),
    ...(region ? { regionName: region } : {}),
    ...(locality ? { localityName: locality } : {}),
    divisionIds: [],
  };
}

/**
 * The discovery seam's area shape, as the containment gate wants it.
 *
 * Two declarations of one idea, and deliberately: the provider interface must
 * not import from the backbone, or every adapter would depend on the compiler's
 * internals to satisfy a signature. The conversion is one function and it lives
 * where the two meet.
 */
function toIncludedArea(area: TripIncludedArea): IncludedArea {
  return {
    id: area.id,
    name: area.name,
    reason: area.reason,
    status: area.status,
    ...(area.center ? { center: area.center } : {}),
    ...(area.radiusKm !== undefined ? { radiusKm: area.radiusKm } : {}),
    ...(area.divisionIds ? { divisionIds: area.divisionIds } : {}),
  };
}

/**
 * A fallback map element, as something the containment gate can judge.
 *
 * The map service publishes tags rather than addresses, so the record it
 * produces genuinely has no administrative geography — and saying so is the
 * point. An empty containment block is what makes the verdict
 * `membership_unknown` rather than a promotion, and the alternative (skipping
 * the gate because there is nothing to judge on) is the defect CS-10 names.
 */
function fallbackRecordFor(entry: NormalizedOsmPlace): SourceRecord {
  return {
    id: `fallback:${entry.elementId}`,
    layerId: 'fallback_places',
    sourceId: entry.elementId,
    name: entry.name,
    alternateNames: [],
    coordinates: entry.coordinates,
    sourceCategory: entry.primaryTag,
    sourceCategoryPath: [],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0', recordId: entry.elementId }],
    cellId: 'fallback',
  };
}
