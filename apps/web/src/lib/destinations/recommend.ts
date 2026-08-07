import 'server-only';
import {
  assessSupply,
  buildRegionPortfolio,
  buildShortlist,
  durationClustersFrom,
  monthsForSeason,
  nightsFrom,
  recommendTripLength,
  seasonMonths,
  SUPPLY_ASSESSMENT_VERSION,
  type CandidateEvidence,
  type DestinationIndexEntry,
  type DestinationShortlist,
  type SupplyFunnel,
  type TripComposerAnswers,
} from '@sidequest/core';
import { destinationIndexRelease, entriesInCountry, recommendationUniverse } from '../db/destination-index-repository';
import { climateFor, isClimateEnabled } from './preflight';

/**
 * "WHERE SHOULD I GO", GATHERED IN TWO STAGES.
 *
 * The ranking is pure and lives in `@sidequest/core`. This file is the half that
 * *fetches*, and it exists because a naive implementation would be ruinous: one
 * climate request per candidate over a worldwide universe is thousands of calls
 * against a free archive, for an answer where all but eight of them are
 * discarded.
 *
 * So:
 *
 * | Stage | Cost | What it measures |
 * | --- | --- | --- |
 * | 1 | free, local | duration, structure, supply, variety, theme, transport |
 * | 2 | one climate request each, for the top few | climate, daylight |
 *
 * Every stage-1 candidate that never reaches stage 2 carries
 * `climateAbsence: 'not_requested'` — **a budget fact, stated as one**, which
 * the ranker turns into an honest `unknown` and a lower `coverage` rather than
 * into a bad score. That distinction is the whole reason the `Measure` union
 * exists, and this is the place it earns its keep.
 */

/**
 * How many candidates reach the climate stage.
 *
 * Twelve, against a shortlist of at most eight. Enough headroom that the climate
 * measurement can genuinely reorder the top of the list rather than merely
 * decorating an order already fixed by the free signals — and small enough that
 * a cold run is a dozen requests rather than a thousand.
 */
const CLIMATE_STAGE = 12;

/** How many candidates any one country may contribute before scoring. */
const PER_COUNTRY = 3;

/** A bound on the work. Not a judgement about how much of the world is worth it. */
const UNIVERSE_LIMIT = 240;

/** How many index features to cluster per candidate. Bounded, like the preflight. */
const FEATURES_PER_CANDIDATE = 120;

/**
 * What kinds of place may be recommended.
 *
 * Regions and counties rather than cities, because the question is "where should
 * I go" rather than "which suburb" — and not countries, because a country is a
 * breadth problem the scope layer already solves rather than a destination. A
 * traveller who wants a whole country types its name; this is for the ones who
 * do not know yet.
 */
const RECOMMENDABLE = ['region', 'county', 'island', 'national_park', 'protected_area'] as const;

/** Feature types worth clustering into areas inside a candidate. */
const WITHIN = ['city', 'town', 'county', 'district'];

function modeFor(answers: TripComposerAnswers): 'drive' | 'transit' | 'walk' {
  if (answers.transport === 'drive' || answers.transport === 'mixed') return 'drive';
  if (answers.transport === 'public_transport') return 'transit';
  // Nobody has said, so nothing is assumed. Transit is the conservative error:
  // a portfolio that grows when they say they will drive, rather than one full
  // of bases they cannot reach.
  return 'transit';
}

function maxBaseChangesFrom(answers: TripComposerAnswers): number | undefined {
  switch (answers.shape) {
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

/**
 * Everything free that can be said about one candidate.
 *
 * Local table reads and arithmetic. No network, no model, no clock beyond the
 * one passed in.
 */
function freeEvidence(
  entry: DestinationIndexEntry,
  answers: TripComposerAnswers,
  releaseId: string,
  now: Date,
  /*
   * One read per country, not one per candidate.
   *
   * The universe takes up to three candidates from each country, so without this
   * the same two-hundred-row query and the same two hundred JSON parses ran three
   * times for every country on the list. Scoped to a single shortlist build and
   * discarded with it — a cache that outlived the request would have to answer
   * for the index being rebuilt underneath it.
   */
  byCountry: Map<string, DestinationIndexEntry[]>,
): CandidateEvidence {
  const inCountry = entry.countryCode
    ? (byCountry.get(entry.countryCode) ??
        (() => {
          const rows = entriesInCountry(entry.countryCode!, WITHIN, FEATURES_PER_CANDIDATE * 4);
          byCountry.set(entry.countryCode!, rows);
          return rows;
        })())
    : [];

  const features = entry.countryCode
    ? inCountry.filter((candidate) => {
        const bounds = entry.bounds;
        if (bounds) {
          return (
            candidate.center.lat >= bounds.southWest.lat &&
            candidate.center.lat <= bounds.northEast.lat &&
            candidate.center.lng >= bounds.southWest.lng &&
            candidate.center.lng <= bounds.northEast.lng
          );
        }
        /*
         * No published extent, so reach out from the centre. One degree either
         * way — roughly 110 km — which is the ground a region-sized destination
         * could plausibly be planned across. The same span the preflight uses,
         * and for the same reason: wider and a region starts absorbing its
         * neighbours.
         */
        return (
          Math.abs(candidate.center.lat - entry.center.lat) <= 1 &&
          Math.abs(candidate.center.lng - entry.center.lng) <= 1
        );
      })
    : [];

  const nights = nightsFrom(answers);
  const mode = modeFor(answers);
  const maxBaseChanges = maxBaseChangesFrom(answers);

  const portfolio = buildRegionPortfolio({
    entries: features.slice(0, FEATURES_PER_CANDIDATE),
    mode,
    nights,
    destinationName: entry.displayName,
    ...(maxBaseChanges === undefined ? {} : { maxBaseChanges }),
  });

  const clusters = durationClustersFrom(portfolio);
  const duration =
    clusters.length > 0
      ? recommendTripLength({
          featureType: entry.featureType,
          destinationName: entry.displayName,
          clusters,
          ...(answers.pace ? { pace: answers.pace } : {}),
          ...(maxBaseChanges === undefined ? {} : { maxBaseChanges }),
          canDrive: mode === 'drive',
          nights,
        })
      : undefined;

  /*
   * The supply verdict, withheld when the index holds nothing.
   *
   * The same rule the preflight states at length: no index coverage is not
   * evidence of an empty region. Here it matters more, not less — a shortlist
   * that scored an unindexed country as empty would recommend only the parts of
   * the world our data happens to be good about, and would look like a judgement
   * rather than a gap.
   */
  const tripDays = nights === null ? 0 : nights + 1;
  const funnel: SupplyFunnel = {
    sourceRecords: features.length,
    candidates: features.length,
    categories: new Set(features.map((candidate) => candidate.featureType)).size,
    clusters: portfolio.allClusters.length,
    anchors: portfolio.allClusters.reduce((total, cluster) => total + cluster.memberCount, 0),
    supportStops: 0,
    baseCandidates: portfolio.gateway ? portfolio.allClusters.length : 0,
    tripDays,
  };
  const supply =
    features.length === 0 ? undefined : assessSupply({ funnel, basis: 'map_records', now });

  return {
    entry,
    releaseId,
    portfolio,
    ...(duration ? { duration } : {}),
    ...(supply ? { supply: { ...supply, schemaVersion: SUPPLY_ASSESSMENT_VERSION } } : {}),
    indexFeatureCount: features.length,
    climateAbsence: 'not_requested',
  };
}

export interface RecommendInput {
  answers: TripComposerAnswers;
  now: Date;
  limit?: number;
}

/**
 * A ranked shortlist, or an empty one that says why.
 *
 * Never throws. A destination index that has not been built produces zero
 * candidates and a blind spot naming that — which is a statement about this
 * deployment, and is not the same sentence as "nowhere suits you".
 */
export async function recommendDestinations(input: RecommendInput): Promise<DestinationShortlist> {
  const started = Date.now();
  const release = destinationIndexRelease();
  const releaseId = release?.releaseId ?? 'unknown';

  const universe = recommendationUniverse({
    featureTypes: RECOMMENDABLE,
    perCountry: PER_COUNTRY,
    limit: UNIVERSE_LIMIT,
  });

  const blindSpots: string[] = [];
  if (universe.length === 0) {
    blindSpots.push(
      release
        ? 'Our place index holds no regions we could rank, so this list is empty because of us rather than because nowhere suits you.'
        : 'This deployment has no destination index built, so there is nothing to rank. That is a gap in us, not a statement about the world.',
    );
  }
  if (!isClimateEnabled()) {
    blindSpots.push('Climate records are switched off in this build, so nothing below is scored on the weather.');
  }

  // ---- Stage 1: free, local ------------------------------------------------
  const byCountry = new Map<string, DestinationIndexEntry[]>();
  const free = universe.map((entry) =>
    freeEvidence(entry, input.answers, releaseId, input.now, byCountry),
  );

  /*
   * Rank once on the free signals alone, purely to choose who is worth a climate
   * request. This ordering is never shown — it exists to spend a budget.
   */
  const provisional = buildShortlist({
    candidates: free,
    answers: input.answers,
    seasonMonths: [],
    climateRequests: 0,
    elapsedMs: 0,
    now: input.now,
    limit: CLIMATE_STAGE,
  });
  const wanted = new Set(provisional.picks.map((pick) => pick.entryId));

  // ---- Stage 2: climate, for the few --------------------------------------
  let climateRequests = 0;
  const enriched: CandidateEvidence[] = [];
  for (const candidate of free) {
    if (!wanted.has(candidate.entry.id)) {
      enriched.push(candidate);
      continue;
    }
    const profile = await climateFor(candidate.entry.center, input.now).catch(() => null);
    if (profile) climateRequests += 1;
    enriched.push(
      profile
        ? { ...candidate, climate: profile, climateAbsence: undefined }
        : { ...candidate, climateAbsence: 'climate_provider_unavailable' },
    );
  }

  /*
   * The hemisphere a season means depends on where the candidate is, so it
   * cannot be resolved once for the whole list. Taken from the first candidate
   * that has a climate profile — a season is a coarse filter and every candidate
   * in a shortlist that far apart will disagree about it anyway, which is
   * exactly why `dates.mode === 'season'` scores the *best* month rather than
   * the average.
   */
  const anchor = enriched.find((candidate) => candidate.climate)?.climate;
  const months =
    input.answers.dates.mode === 'season' && input.answers.dates.season && anchor
      ? seasonMonths(input.answers.dates.season, anchor.coordinates.lat)
      : input.answers.dates.mode === 'season' && input.answers.dates.season
        ? monthsForSeason(input.answers.dates.season, null)
        : [];

  return buildShortlist({
    candidates: enriched,
    answers: input.answers,
    seasonMonths: months,
    climateRequests,
    elapsedMs: Date.now() - started,
    now: input.now,
    ...(input.limit ? { limit: input.limit } : {}),
    blindSpots,
  });
}
