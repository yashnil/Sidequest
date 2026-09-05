import 'server-only';
import {
  buildQueries,
  deriveScope,
  type CompilerProviders,
  type DiscoveryQuery,
} from '@sidequest/compiler';
import {
  CLARIFICATION_SET_VERSION,
  type ClarificationSet,
  type DestinationCandidate,
  type GeographicScope,
  type Place,
  type TravelerProfile,
} from '@sidequest/core';
import type { RegionPack } from '@sidequest/core';
import type { BenchmarkTripRequest } from '@sidequest/bench';
import { resolveTripWeather } from '../weather';
import type {
  PacketAccess,
  PacketDaylight,
  PacketDestination,
  PacketFood,
  PacketGap,
  PacketHours,
  PacketSeasonal,
  PacketWeather,
} from '../benchmark/baseline/packet-types';
import type {
  GatherCounters,
  GatherResult,
} from '../benchmark/baseline/gather';
import type {
  RawBaseCandidate,
  RawDay,
  RawPlace,
  RawRouteLeg,
} from '../benchmark/baseline/packet';

/**
 * PHASE 17 CORRECTION — CANDIDATE RESOLUTION AND ENRICHMENT THROUGH THE
 * PRODUCTION BACKBONE, NOT THE PHASE 13 BENCHMARK'S OVERPASS-ONLY PATH.
 *
 * `../benchmark/baseline/gather.ts` (`gatherPacketInputs`) issues raw,
 * uncached Overpass requests directly — a Phase 13 benchmark-fairness
 * constraint ("the baseline may not reuse Sidequest's own candidate engine"),
 * carried over into production by accident when Phase 17 first reused that
 * arm's composer. It has no cache, so every hybrid build re-fetches from
 * scratch, and it depends entirely on the public Overpass mirrors — which
 * this environment's shared access to is exhausted (confirmed: the broad POI
 * sweep fails on every attempt while the identically-shaped food sweep
 * succeeds once, and a *different*, small, dense destination — New York —
 * returns zero places of any kind through the same path).
 *
 * This module replaces that acquisition step with the same provider seams
 * `compileRegion` itself calls (`CompilerProviders`, built by
 * `compilerProviders()` in `lib/compiler/providers.ts`): `resolver` for
 * identity, `regionPack` for the cached, release-pinned Overture inventory,
 * `places` for enriched candidates, `food`, `routing`, `expansion`. This
 * environment already holds a **cached, ready Overture pack for Iceland**
 * (7,734 records, built during a prior compilation, not expired) — reusing it
 * is instant and touches no network.
 *
 * What this deliberately does NOT reuse: `constraints`/`sourceDiscovery`/
 * `retrieval`/`extraction` — the compiler's hours/access *research* funnel.
 * That funnel can itself spend model calls researching a single place's
 * opening hours, which would blow the "one composition call, one repair"
 * budget this phase is required to hold, and is not what "candidate
 * resolution and enrichment" asks for. Hours stay `unknown` where the pack
 * itself carries none — exactly the "unknown, never invented" contract the
 * research-packet schema and the composer's honesty rules already enforce.
 *
 * The output shape is unchanged: `PacketInputs`, the same interface
 * `gatherPacketInputs` returns, so `buildResearchPacket`,
 * `runPreliminaryScan`, `generateBaselinePlan`, `repairBaselinePlan` and
 * `runNeutralValidation` are untouched by this correction.
 */

export interface ProductionGatherInput {
  request: BenchmarkTripRequest;
  candidate: DestinationCandidate;
  dates: readonly string[];
  now: Date;
  profile?: TravelerProfile | null;
  nights: number;
  composerTransport?: string;
  composerShape?: 'one_base' | 'two_bases' | 'circuit' | 'undecided';
  providers: CompilerProviders;
}

const MAX_PLACES = 140;
/**
 * Lowered from 40. A full matrix over 40 points is 1,560 ordered pairs, and a
 * live Iceland run measured this single call at 73-91 seconds — close enough
 * to its own timeout to fail intermittently. 30 points is 870 pairs: still
 * several times more than the packet's twelve clusters need for one
 * intra-cluster pair each, and materially faster against the same routing
 * service. Latency, not coverage, is what this number now trades against.
 */
const MAX_ROUTE_POINTS = 30;
const MAX_FOOD_VENUES = 45;
const MAX_SUBREGIONS = 8;
const MAX_BASES = 10;
/** Ceiling on one region-pack acquisition. See the note beside its call site. */
const PACK_ACQUISITION_BUDGET_MS = 5 * 60_000;
/**
 * Ceiling on every OTHER single provider call in this module.
 *
 * The pack read is the one call expected to be legitimately slow on a cold
 * cache, and it alone gets the wider budget above. Every other seam
 * (`places`, `food`, `routing`, `expansion`) is expected to answer from the
 * pack it was just handed or from a bounded live fallback — and a run that
 * measured 29.5 minutes end to end with no single provider logging a failure
 * proved that "each call eventually returns" is not the same guarantee as
 * "the whole acquisition stays bounded". This is what turns an unbounded
 * stack of individually-slow calls into the fail-fast/no-cascade contract:
 * a call past this budget is abandoned and recorded as a gap, not awaited.
 */
const STAGE_BUDGET_MS = 90_000;

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${STAGE_BUDGET_MS}ms`)), STAGE_BUDGET_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Wall time for every acquisition stage, so latency is measured, not guessed. */
export type GatherStageTimingsMs = Record<string, number>;

function stageLog(timings: GatherStageTimingsMs, label: string, startedMs: number): void {
  const elapsed = Math.round(performance.now() - startedMs);
  timings[label] = elapsed;
  console.warn(`[hybrid-gather] ${label}: ${elapsed}ms`);
}

export async function gatherProductionPacketInputs(
  input: ProductionGatherInput,
): Promise<GatherResult & { scope: GeographicScope; stageTimingsMs: GatherStageTimingsMs }> {
  const counters: GatherCounters = {
    providerCalls: 0,
    routeCalls: 0,
    routePairs: 0,
    weatherCalls: 0,
  };
  const gaps: PacketGap[] = [];
  const unknowns: string[] = [];
  const timings: GatherStageTimingsMs = {};
  const { providers } = input;

  const emptyClarifications: ClarificationSet = {
    schemaVersion: CLARIFICATION_SET_VERSION,
    questions: [],
    answers: [],
  };

  const scope = deriveScope({
    candidate: input.candidate,
    clarifications: emptyClarifications,
    ...(input.profile ? { profile: input.profile } : {}),
    nights: input.nights,
    revision: 1,
    ...(input.composerTransport ? { composerTransport: input.composerTransport } : {}),
    ...(input.composerShape ? { composerShape: input.composerShape } : {}),
  });

  const destination: PacketDestination = {
    entityId: input.candidate.id,
    displayName: input.candidate.displayName,
    countryCode: input.candidate.countryCode ?? null,
    latitude: scope.center.lat,
    longitude: scope.center.lng,
    radiusKm: scope.shape.kind === 'radius' ? scope.shape.radiusKm : null,
    scale: input.candidate.breadth,
  };

  /*
   * TWO INDEPENDENT BRANCHES, STARTED NOW AND JOINED AT THE END.
   *
   * `expansion` (base candidates) and `weather` need only the scope and the
   * destination — neither reads a place the acquisition chain below has to
   * discover first. A first live run paid for them serially anyway: 21
   * seconds of expansion added, in full, on top of a routing call already
   * near its own timeout, for no reason but that the code happened to await
   * them in order. Starting both here and awaiting them beside the chain's
   * own result is what actually removes that wait rather than merely
   * shortening it.
   */
  const expansionPromise = acquireExpansion(input, providers, scope, destination, counters, gaps, timings);
  const weatherPromise = acquireWeather(input, destination, counters, gaps, timings);

  // ---------------------------------------------------------------- pack
  let regionPack: RegionPack | null = null;
  if (providers.regionPack) {
    const stageStartedMs = performance.now();
    try {
      /*
       * Bounded even on a cold cache. A cache hit answers immediately; a
       * miss triggers a real Overture read, which is legitimately slow the
       * first time for new ground — but "slow once" and "hangs" are
       * different failures, and this is what keeps a single acquisition
       * step from becoming the multi-minute cascade the runtime-economics
       * requirement rules out.
       */
      const outcome = await providers.regionPack.getPack({
        scope,
        now: input.now,
        deadlineMs: Date.now() + PACK_ACQUISITION_BUDGET_MS,
      });
      stageLog(timings, 'region pack', stageStartedMs);
      if (outcome.kind !== 'unavailable') {
        regionPack = outcome.pack;
        counters.providerCalls += 1;
      } else {
        gaps.push({
          kind: 'provider_unavailable',
          subject: 'region pack',
          detail: `The place backbone could not prepare a pack for this area: ${outcome.message}`,
        });
      }
    } catch (error) {
      stageLog(timings, 'region pack (failed/timed out)', stageStartedMs);
      gaps.push({
        kind: 'provider_unavailable',
        subject: 'region pack',
        detail: 'The place backbone did not answer, so candidates come only from a live fallback, if any.',
      });
      console.error('Region pack acquisition failed', error);
    }
  }

  // -------------------------------------------------------------- places
  const queries: DiscoveryQuery[] = buildQueries(scope, input.profile ?? undefined, MAX_PLACES);
  let discoveredPlaces: Place[] = [];
  {
    const stageStartedMs = performance.now();
    try {
      const discovery = await withTimeout(
        'place discovery',
        providers.places.discover({
          scope,
          queries,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(regionPack ? { pack: regionPack } : {}),
        }),
      );
      stageLog(timings, 'places', stageStartedMs);
      counters.providerCalls += discovery.calls;
      discoveredPlaces = discovery.candidates.map((candidate) => candidate.place);
      for (const gap of discovery.gaps) {
        gaps.push({
          kind: 'provider_unavailable',
          subject: 'places',
          detail: gap.detail,
        });
      }
    } catch (error) {
      stageLog(timings, 'places (failed/timed out)', stageStartedMs);
      gaps.push({
        kind: 'provider_unavailable',
        subject: 'places',
        detail: 'The place backbone did not answer, so no attractions could be listed.',
      });
      console.error('Place discovery failed', error);
    }
  }

  if (discoveredPlaces.length === 0) {
    unknowns.push(
      'No attractions or points of interest could be retrieved for this destination from the configured place backbone.',
    );
  }

  const places: RawPlace[] = discoveredPlaces.slice(0, MAX_PLACES).map((place) => toRawPlace(place, input.dates));

  // ---------------------------------------------------------------- food
  {
    const stageStartedMs = performance.now();
    try {
      const foodResult = await withTimeout(
        'food discovery',
        providers.food.discover({
          scope,
          places: discoveredPlaces,
          bases: [{ id: destination.entityId, coordinates: scope.center }],
          maxVenues: MAX_FOOD_VENUES,
          ...(regionPack ? { pack: regionPack } : {}),
        }),
      );
      stageLog(timings, 'food', stageStartedMs);
      counters.providerCalls += foodResult.calls;
      for (const venue of foodResult.venues) {
        places.push(toRawFoodPlace(venue));
      }
    } catch (error) {
      stageLog(timings, 'food (failed/timed out)', stageStartedMs);
      gaps.push({
        kind: 'provider_unavailable',
        subject: 'food venues',
        detail: 'The food backbone did not answer, so no eating places could be listed.',
      });
      console.error('Food discovery failed', error);
    }
  }

  // ------------------------------------------------------------------ routes
  const routeLegs: RawRouteLeg[] = [];
  const sampled = samplePoints(places, MAX_ROUTE_POINTS);
  if (sampled.length >= 2) {
    const stageStartedMs = performance.now();
    try {
      const drive = input.request.movement.carAvailable;
      const packetMode: RawRouteLeg['mode'] = drive ? 'drive' : 'walk';
      const result = await withTimeout(
        'routing matrix',
        providers.routing.matrix({
          points: sampled.map((place) => ({ id: place.entityId, lat: place.latitude, lng: place.longitude })),
          mode: drive ? 'car' : 'foot',
          maxElements: sampled.length * sampled.length,
        }),
      );
      stageLog(timings, 'routing', stageStartedMs);
      counters.routeCalls += result.calls;
      counters.routePairs += result.elements;
      for (let i = 0; i < result.ids.length; i += 1) {
        for (let j = 0; j < result.ids.length; j += 1) {
          if (i === j) continue;
          const minutes = result.minutes[i]?.[j];
          const km = result.km[i]?.[j];
          if (minutes === undefined || minutes === null || km === undefined || km === null) continue;
          routeLegs.push({
            fromEntityId: result.ids[i]!,
            toEntityId: result.ids[j]!,
            minutes: Math.round(minutes),
            km,
            mode: packetMode,
          });
        }
      }
    } catch (error) {
      stageLog(timings, 'routing (failed/timed out)', stageStartedMs);
      gaps.push({
        kind: 'provider_unavailable',
        subject: 'routes',
        detail: 'The routing service did not answer, so travel times between places are unmeasured.',
      });
      console.error('Routing matrix failed', error);
    }
  }

  const [baseCandidates, days] = await Promise.all([expansionPromise, weatherPromise]);

  return {
    scope,
    counters,
    stageTimingsMs: timings,
    inputs: {
      destination,
      days,
      places,
      baseCandidates,
      routeLegs,
      gaps: [
        ...gaps,
        {
          kind: 'not_requested',
          subject: 'region width',
          detail: `Scope: ${scope.shape.kind} around ${destination.displayName}, breadth ${input.candidate.breadth}.`,
        },
      ],
      unknowns,
    },
  };
}

// ------------------------------------------------------------ base candidates
async function acquireExpansion(
  input: ProductionGatherInput,
  providers: CompilerProviders,
  scope: GeographicScope,
  destination: PacketDestination,
  counters: GatherCounters,
  gaps: PacketGap[],
  timings: GatherStageTimingsMs,
): Promise<RawBaseCandidate[]> {
  let baseCandidates: RawBaseCandidate[] = [];
  const stageStartedMs = performance.now();
  try {
    const expansion = await withTimeout(
      'region expansion',
      providers.expansion.expand({
        scope,
        ...(input.profile ? { profile: input.profile } : {}),
        nights: input.nights,
        maxSubregions: MAX_SUBREGIONS,
        maxBases: MAX_BASES,
      }),
    );
    stageLog(timings, 'expansion', stageStartedMs);
    counters.providerCalls += expansion.calls;
    baseCandidates = expansion.bases.map((base) => ({
      entityId: base.id,
      name: base.name,
      latitude: base.coordinates.lat,
      longitude: base.coordinates.lng,
      basis: base.rationale,
    }));
  } catch (error) {
    stageLog(timings, 'expansion (failed/timed out)', stageStartedMs);
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'base candidates',
      detail: 'The regional expansion service did not answer, so no alternative bases were offered.',
    });
    console.error('Region expansion failed', error);
  }
  if (baseCandidates.length === 0) {
    baseCandidates = [
      {
        entityId: destination.entityId,
        name: destination.displayName,
        latitude: destination.latitude,
        longitude: destination.longitude,
        basis: 'The destination itself; no alternative bases were established.',
      },
    ];
  }
  return baseCandidates;
}

// ----------------------------------------------------------------- weather
async function acquireWeather(
  input: ProductionGatherInput,
  destination: PacketDestination,
  counters: GatherCounters,
  gaps: PacketGap[],
  timings: GatherStageTimingsMs,
): Promise<RawDay[]> {
  const days: RawDay[] = [];
  const stageStartedMs = performance.now();
  try {
    const dataset = await withTimeout(
      'weather',
      resolveTripWeather({
        regionId: `hybrid:${input.candidate.id}`,
        dates: [...input.dates],
        now: input.now,
        locations: [
          {
            id: 'destination',
            label: destination.displayName,
            coordinates: { lat: destination.latitude, lng: destination.longitude },
            elevationMetres: 0,
            timeZone: 'UTC',
            placeIds: ['destination'],
            limitation: 'One point speaks for the whole region in this arm.',
          },
        ],
      }),
    );
    stageLog(timings, 'weather', stageStartedMs);
    counters.weatherCalls += 1;
    const byDate = new Map(dataset.days.map((day) => [day.date as string, day]));
    for (const date of input.dates) {
      const day = byDate.get(date);
      days.push({
        dayNumber: input.dates.indexOf(date) + 1,
        date,
        daylight: { state: 'unknown' } satisfies PacketDaylight,
        weather: day ? translateWeatherDay(day) : { state: 'unknown' },
        weatherSource: null,
      });
    }
  } catch (error) {
    stageLog(timings, 'weather (failed/timed out)', stageStartedMs);
    gaps.push({
      kind: 'provider_unavailable',
      subject: 'weather',
      detail: 'The weather service did not answer, so no conditions are stated for any date.',
    });
    console.error('Weather resolution failed', error);
    for (const date of input.dates) {
      days.push({
        dayNumber: input.dates.indexOf(date) + 1,
        date,
        daylight: { state: 'unknown' },
        weather: { state: 'unknown' },
        weatherSource: null,
      });
    }
  }
  return days;
}

function samplePoints(places: readonly RawPlace[], limit: number): RawPlace[] {
  if (places.length <= limit) return [...places];
  const step = places.length / limit;
  const sampled: RawPlace[] = [];
  for (let i = 0; i < limit; i += 1) {
    const place = places[Math.floor(i * step)];
    if (place) sampled.push(place);
  }
  return sampled;
}

function toRawPlace(place: Place, dates: readonly string[]): RawPlace {
  const entityId = place.source.element?.elementId ?? place.id;
  return {
    entityId,
    name: place.name,
    latitude: place.coordinates.lat,
    longitude: place.coordinates.lng,
    kind: place.category,
    tags: place.tags,
    typicalDurationMinutes: place.typicalDurationMinutes,
    daylightOnly: null,
    hours: { state: 'unknown' } satisfies PacketHours,
    seasonal: seasonalFor(place, dates),
    access: {
      requiresCar: place.access.roadSurface === 'unpaved' ? true : null,
      unpavedApproach: place.access.roadSurface === 'unpaved',
      remoteNoServices: place.access.remoteNoServices,
      strenuous: place.physicalIntensity === 'strenuous',
      wheelchair: 'unknown',
      feeStated: null,
    } satisfies PacketAccess,
    food: null,
    source: {
      host: place.source.url ? hostOf(place.source.url) : place.source.name,
      title: place.name,
      url: place.source.url ?? null,
      // `lastVerified` is a calendar date (`isoDateSchema`, "YYYY-MM-DD"), not
      // an instant — the neutral packet's `retrievedAt` needs a full ISO
      // datetime or nothing. Passing the date string through unconverted
      // failed `benchmarkPlanSchema`'s own datetime format on every source,
      // which is worse than the honest `null` this arm has no true instant
      // to report anyway.
      retrievedAt: null,
    },
    // `experienceSignificance` is the combined kind-and-evidence read
    // (`quality/significance.ts`); `popularityScore` alone is the fallback
    // where that combined figure was never computed. Neither is destination-
    // specific — both are produced by the same generic scoring the place
    // backbone already runs for every destination.
    significance: place.experienceSignificance ?? place.popularityScore ?? null,
  };
}

function seasonalFor(place: Place, dates: readonly string[]): PacketSeasonal {
  const months = new Set(dates.map((date) => Number(date.slice(5, 7))));
  const openInAny = [...months].some((month) => place.seasonalAccess.openMonths.includes(month));
  if (place.seasonalAccess.openMonths.length >= 12) return { state: 'open_in_season' };
  return openInAny
    ? { state: 'open_in_season' }
    : { state: 'closed_in_season', note: place.seasonalAccess.note ?? 'Not open in these months.' };
}

function toRawFoodPlace(venue: {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
  tags: readonly string[];
  mealPeriods: readonly string[];
  dietary: readonly { need: string }[];
  source: { name: string; url?: string; lastVerified: string };
}): RawPlace {
  const entityId = venue.id;
  const servesSlots = venue.mealPeriods
    .map((period) => (period === 'breakfast' || period === 'lunch' || period === 'dinner' || period === 'snack'
      ? period
      : null))
    .filter((slot): slot is 'breakfast' | 'lunch' | 'dinner' | 'snack' => slot !== null);
  return {
    entityId,
    name: venue.name,
    latitude: venue.coordinates.lat,
    longitude: venue.coordinates.lng,
    kind: 'food',
    tags: venue.tags,
    typicalDurationMinutes: null,
    daylightOnly: null,
    hours: { state: 'unknown' },
    seasonal: { state: 'unknown' },
    access: {
      requiresCar: null,
      unpavedApproach: null,
      remoteNoServices: null,
      strenuous: null,
      wheelchair: 'unknown',
      feeStated: null,
    },
    food: {
      servesSlots,
      dietaryTags: venue.dietary.map((entry) => entry.need),
      cuisine: null,
      cannotAccommodate: [],
    } satisfies PacketFood,
    source: {
      host: venue.source.url ? hostOf(venue.source.url) : venue.source.name,
      title: venue.name,
      url: venue.source.url ?? null,
      // See the matching note in `toRawPlace`: `lastVerified` is a date, not
      // an instant, and the neutral schema wants a full datetime or nothing.
      retrievedAt: null,
    },
    // Food venues carry no significance read in this pass — the signal
    // exists on `Place`, and a venue here is a `FoodVenue`, a different
    // record. `null` is the honest "not scored", same as everywhere else.
    significance: null,
  };
}

function translateWeatherDay(day: unknown): PacketWeather {
  const record = day as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'forecast' && kind !== 'pattern' && kind !== 'history') return { state: 'unknown' };
  const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  return {
    state: kind === 'forecast' ? 'forecast' : 'climate',
    summary: typeof record.summary === 'string' ? record.summary : '',
    highCelsius: number(record.temperatureMaxC ?? record.highCelsius),
    lowCelsius: number(record.temperatureMinC ?? record.lowCelsius),
    precipitationChance: number(record.precipitationProbabilityPercent ?? record.precipitationChance),
    sourceIndex: null,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
