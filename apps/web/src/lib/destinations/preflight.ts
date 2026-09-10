import 'server-only';
import {
  ANCHORS_PER_DAY,
  SUPPLY_ASSESSMENT_VERSION,
  TRIP_PREFLIGHT_VERSION,
  assessSupply,
  buildRegionPortfolio,
  durationClustersFrom,
  monthsForSeason,
  nightsFrom,
  reachClassFor,
  recommendDateWindows,
  recommendTripLength,
  scopeStrategiesFor,
  type ClimateProfile,
  type ClimateUnavailableReason,
  type DestinationIndexEntry,
  type SelectedDestination,
  type SupplyFunnel,
  type TripComposerAnswers,
  type TripPreflight,
} from '@sidequest/core';
import { capabilityRegistry } from '../capabilities';
import { entriesInCountry } from '../db/destination-index-repository';
import { readCachedClimate, writeCachedClimate } from '../climate/cache';
import { openMeteoClimateProvider, unavailableClimateProvider } from '../climate/openmeteo';

/**
 * THE FAST ANSWER.
 *
 * Runs before the traveller commits to anything and before a single paid call.
 * It reads the destination index (local), asks one climate question (cached for
 * a month, because a twenty-year normal does not move), and returns a region
 * portfolio, date guidance, duration guidance and a supply verdict.
 *
 * The budget is seconds, and it is met by construction rather than by
 * optimisation: everything except the climate request is a local table read and
 * arithmetic.
 *
 * **What this is not.** It is not a compilation, and nothing it produces may
 * become a planner constraint. The clusters are groupings of index records, not
 * researched places; the distances are straight lines; the climate is normals.
 * Every one of those is marked as such in the schema so that a later stage
 * cannot quietly promote an estimate into evidence.
 */

/** How many index features to cluster. A bound on the work, not a judgement. */
const MAX_FEATURES = 400;

/**
 * Re-exported from the import-free switch module.
 *
 * A page that only wants to say "climate guidance is switched off in this build"
 * must not import this module to find out — doing so pulled the Open-Meteo
 * client into both decide pages' render graph. See `providers/switches.ts`.
 */
import { isClimateEnabled } from '../providers/switches';
import { fixtureClimateProvider } from '../climate/fixture';
export { isClimateEnabled };

function climateProvider() {
  if (!isClimateEnabled()) return unavailableClimateProvider();
  /* V6 — a deterministic climate so the browser suite can press "Use this timing". */
  if (process.env.SIDEQUEST_CLIMATE_PROVIDER?.trim().toLowerCase() === 'fixture') return fixtureClimateProvider();
  return openMeteoClimateProvider();
}

/**
 * A climate profile for a point, cached.
 *
 * The key, the lifetime and the refusal of rows this build did not compute all
 * live in `climate/cache.ts`, beside the arithmetic they describe. They used to
 * live here, as a coordinate-only key with an unchecked cast, and the cost of
 * that was that repairing the daylight column changed nothing a traveller saw:
 * the corrected code kept reading rows the broken code had written.
 */
export async function climateFor(
  center: { lat: number; lng: number },
  now: Date,
): Promise<ClimateProfile | null> {
  return (await climateWithReason(center, now)).profile;
}

/**
 * The same lookup, with the reason it failed.
 *
 * STAGING PARITY §10. The reason was typed all along and thrown away here, so a
 * traveller was told the window would be chosen later and nobody — operator or
 * caller — could tell a busy archive from an absent one. `climateFor` keeps its
 * shape for the dozen callers that only want the profile.
 */
export async function climateWithReason(
  center: { lat: number; lng: number },
  now: Date,
): Promise<{ profile: ClimateProfile | null; reason: ClimateUnavailableReason | null }> {
  const cached = readCachedClimate(center, now);
  if (cached) return { profile: cached, reason: null };

  const provider = climateProvider();
  const result = await provider.getProfile({ lat: center.lat, lng: center.lng, now }).catch(() => ({ kind: 'unavailable' as const, reason: 'provider_unavailable' as const }));
  if (result.kind !== 'profile') {
    /* The reason class only: no coordinate, because where somebody is going is theirs. */
    console.warn('A climate lookup did not answer', { provider: provider.name, reason: result.reason });
    return { profile: null, reason: result.reason };
  }

  writeCachedClimate(center, result.profile, now);
  return { profile: result.profile, reason: null };
}

/**
 * The index features inside a destination.
 *
 * Country-scoped for a country, and bounds-scoped for anything smaller. Both
 * come from the index rather than from a geocoder, which is what makes this
 * step free.
 */
export function featuresWithin(destination: SelectedDestination): DestinationIndexEntry[] {
  const wanted = ['city', 'town', 'county', 'region', 'district'];
  if (!destination.countryCode) return [];

  const inCountry = entriesInCountry(destination.countryCode, wanted, MAX_FEATURES * 3);
  if (destination.featureType === 'country' || destination.featureType === 'dependency') {
    return inCountry.slice(0, MAX_FEATURES);
  }

  const bounds = destination.bounds;
  if (bounds) {
    return inCountry
      .filter(
        (entry) =>
          entry.center.lat >= bounds.southWest.lat &&
          entry.center.lat <= bounds.northEast.lat &&
          entry.center.lng >= bounds.southWest.lng &&
          entry.center.lng <= bounds.northEast.lng,
      )
      .slice(0, MAX_FEATURES);
  }

  /*
   * No published extent, so reach out from the centre instead.
   *
   * One degree of latitude either way — roughly 110 km — which is the ground a
   * city-or-smaller destination could plausibly be planned across. Wider than
   * this and a "city" starts absorbing the next one along, which is how a
   * portfolio comes to propose a base two hours outside the destination.
   */
  const span = 1;
  return inCountry
    .filter(
      (entry) =>
        Math.abs(entry.center.lat - destination.center.lat) <= span &&
        Math.abs(entry.center.lng - destination.center.lng) <= span,
    )
    .slice(0, MAX_FEATURES);
}

/**
 * How far this traveller reaches in a day — asked of the one definition.
 *
 * This used to decide independently, and it disagreed with the compiler for the
 * commonest traveller of all: the one who has not said. Silence read as
 * `transit` here and as `walk` there, so a preview ring labelled "40 km — a day
 * out and back" sat beside a build described as "about 12 km out". See
 * `reachClassFor` for why the answer now also depends on whether a transit
 * journey can be measured at all.
 */
function modeFor(answers: TripComposerAnswers | null): 'drive' | 'transit' | 'walk' {
  const transport = answers?.transport;
  return reachClassFor({
    carAvailable: transport === 'drive' || transport === 'mixed' ? true : transport === 'public_transport' ? false : null,
    acceptsScheduled: null,
    transitMeasurable: capabilityRegistry().assess('route_transit').available,
  });
}

function maxBaseChangesFrom(answers: TripComposerAnswers | null): number | undefined {
  switch (answers?.shape) {
    case 'one_base':
      return 0;
    case 'two_bases':
      return 1;
    case 'circuit':
      return 3;
    default:
      return undefined;
  }
}

export interface PreflightInput {
  destination: SelectedDestination;
  answers: TripComposerAnswers | null;
  now: Date;
}

/**
 * Everything the composer can say about a destination without spending anything.
 *
 * Never throws. Each half degrades on its own: no climate means no date
 * guidance and a portfolio that still works; no index features means no
 * portfolio and date guidance that still works. A preflight that failed
 * wholesale because one provider was down would be the opposite of the point.
 */
export async function runPreflight(input: PreflightInput): Promise<TripPreflight> {
  const started = Date.now();
  const { destination, answers, now } = input;

  const features = featuresWithin(destination);
  const nights = answers ? nightsFrom(answers) : null;
  const mode = modeFor(answers);

  const portfolio = buildRegionPortfolio({
    entries: features,
    mode,
    nights,
    destinationName: destination.displayName,
    ...(maxBaseChangesFrom(answers) === undefined ? {} : { maxBaseChanges: maxBaseChangesFrom(answers)! }),
  });

  const strategies =
    portfolio.allClusters.length > 0
      ? scopeStrategiesFor({ portfolio, nights, destinationName: destination.displayName })
      : [];

  const clusters = durationClustersFrom(portfolio);
  const duration =
    clusters.length > 0
      ? recommendTripLength({
          featureType: destination.featureType,
          destinationName: destination.displayName,
          clusters,
          ...(answers?.pace ? { pace: answers.pace } : {}),
          ...(maxBaseChangesFrom(answers) === undefined
            ? {}
            : { maxBaseChanges: maxBaseChangesFrom(answers)! }),
          canDrive: mode === 'drive',
          nights,
        })
      : null;

  const profile = await climateFor(destination.center, now).catch(() => null);
  const onlyMonths = seasonalMonths(answers, profile);
  const dates = recommendDateWindows({
    profile,
    nights,
    ...(answers ? { answers } : {}),
    ...(onlyMonths.length > 0 ? { onlyMonths } : {}),
    year: answers?.dates.year ?? now.getUTCFullYear(),
    now,
  });

  /*
   * A supply verdict from the index alone.
   *
   * Deliberately coarse — the index knows about settlements, not attractions —
   * so it can only catch the *severe* cases: a destination with nowhere to
   * sleep, or one whose entire extent holds three villages. The real verdict
   * comes after the region pack, from the compiler, using the same scoring.
   * Catching the severe cases here is still worth it: they are the ones that
   * would otherwise cost minutes to discover.
   */
  const tripDays = nights === null ? 0 : nights + 1;
  const funnel: SupplyFunnel = {
    sourceRecords: features.length,
    candidates: features.length,
    categories: new Set(features.map((entry) => entry.featureType)).size,
    clusters: portfolio.allClusters.length,
    anchors: portfolio.allClusters.reduce((total, cluster) => total + cluster.memberCount, 0),
    supportStops: 0,
    baseCandidates: portfolio.gateway ? portfolio.allClusters.length : 0,
    tripDays,
  };
  /*
   * NO INDEX COVERAGE IS NOT EVIDENCE OF AN EMPTY REGION.
   *
   * The verdict is withheld entirely when the index returned nothing, and that
   * is not a nicety — the alternative is a deployment with an unbuilt index
   * telling every traveller their destination is unplannable, which is a claim
   * about *us* rendered as a claim about *the world*. It is also exactly what
   * would happen in a test environment, where the failure would look like a
   * product decision rather than a missing build step.
   *
   * Silence here costs one panel. The compiler's own supply gate still runs
   * against the region pack, on real records, and that is the verdict that
   * decides whether anything is bought.
   */
  const supply = features.length === 0 ? null : assessSupply({ funnel, basis: 'map_records', now });

  return {
    schemaVersion: TRIP_PREFLIGHT_VERSION,
    destinationKey: destination.entryId,
    portfolio: portfolio.gateway === null ? null : {
      gateway: portfolio.gateway,
      route: portfolio.route,
      baseReasons: portfolio.baseReasons,
      satellites: portfolio.satellites,
      excluded: portfolio.excluded,
      basesProposed: portfolio.basesProposed,
      transferDays: portfolio.transferDays,
      mode: portfolio.mode,
      /*
       * The reach the structure actually implies, carried onto the trip so the
       * compilation can use the same number rather than deriving a second one.
       * This is the whole of the fix for a preview and a build describing
       * different-sized trips.
       */
      reachRadiusKm: portfolio.reachRadiusKm,
      rationale: portfolio.rationale,
      estimated: true,
    },
    strategies,
    dates,
    duration,
    supply: supply ? { ...supply, schemaVersion: SUPPLY_ASSESSMENT_VERSION } : null,
    builtAt: now.toISOString(),
    elapsedMs: Date.now() - started,
  };
}

function seasonalMonths(
  answers: TripComposerAnswers | null,
  profile: ClimateProfile | null,
): number[] {
  if (!answers) return [];
  if (answers.dates.mode === 'month' && answers.dates.month) return [answers.dates.month];
  if (answers.dates.mode === 'season' && answers.dates.season) {
    return monthsForSeason(answers.dates.season, profile);
  }
  return [];
}

/** Exported so the supply thresholds are visible where the funnel is built. */
export { ANCHORS_PER_DAY };
