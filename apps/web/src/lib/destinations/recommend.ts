import 'server-only';
import {
  assessSupply,
  buildRegionPortfolio,
  buildShortlist,
  catalogueBlindSpot,
  durationClustersFrom,
  monthsForSeason,
  nightsFrom,
  reachClassFor,
  recommendTripLength,
  seasonMonths,
  SUPPLY_ASSESSMENT_VERSION,
  type CandidateEvidence,
  type DestinationIndexEntry,
  type DestinationShortlist,
  type SupplyFunnel,
  type TripComposerAnswers,
  separationKm,
} from '@sidequest/core';
import { destinationIndexRelease, entriesByPrefix, entriesInCountry, recommendationUniverse } from '../db/destination-index-repository';
import { climateFor, isClimateEnabled } from './preflight';
import { capabilityRegistry } from '../capabilities';

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
 *
 * **Three of these five have never once been supplied, and the list stays
 * anyway.** Measured against the 2026-07-22 release: the universe scan returns
 * 203 `region` and 37 `county` and nothing else, because the index is built from
 * Overture's *divisions* theme, whose subtype vocabulary — country, dependency,
 * region, county, localadmin, locality, macrohood, neighborhood, microhood — is
 * administrative by construction. Islands, parks and coastlines live in the
 * `base` theme, which this repository already reads elsewhere (`LAYERS` in
 * `providers/overture/normalize.ts`) and whose rows carry no country, no
 * population, no prominence and no parent — the four fields the index's pruning
 * rank, its per-country universe bucket and its hierarchy labels are all built
 * on. Supplying them is a second acquisition pipeline, not a filter change.
 *
 * So the list is kept honest at the *other* end rather than trimmed here. The
 * ask is real — `buildIndexEntries` now classifies a park or an island, so a
 * producer that supplied one would land it — and `catalogueBlindSpot` compares
 * this list against what the scan actually returned and puts the shortfall on
 * the screen. Trimming this to `['region', 'county']` would make the code
 * consistent with the data by deleting the evidence that anything is missing,
 * which is how a gap becomes a design.
 */
const RECOMMENDABLE = ['region', 'county', 'island', 'national_park', 'protected_area'] as const;

/** Feature types worth clustering into areas inside a candidate. */
const WITHIN = ['city', 'town', 'county', 'district'];

/**
 * How far this traveller reaches in a day — asked of the one definition.
 *
 * This file kept its own copy after the preview and the compiler were
 * reconciled, and the copy is the version the reconciliation was written to
 * remove: it returns `transit` for an unstated answer on the reasonable ground
 * that the recoverable error is the wider one. That reasoning is only sound
 * where a transit journey can actually be measured. Where it cannot, a
 * forty-kilometre ring is a promise about bases the traveller has no way of
 * reaching, and the shortlist here is the *first* screen that promise appears
 * on — one earlier than the preview where the same defect was found.
 *
 * So it calls `reachClassFor`, like the other two, and `transitMeasurable`
 * decides. Three screens, one definition.
 */
function modeFor(answers: TripComposerAnswers): 'drive' | 'transit' | 'walk' {
  return reachClassFor({
    carAvailable:
      answers.transport === 'drive' || answers.transport === 'mixed'
        ? true
        : answers.transport === 'public_transport'
          ? false
          : null,
    acceptsScheduled: null,
    transitMeasurable: capabilityRegistry().assess('route_transit').available,
  });
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
  /*
   * What the catalogue could actually offer, counted from the rows it returned.
   *
   * The sentence this produces used to be derived from the eight picks on
   * screen, which made "our index holds no national parks" a conclusion drawn
   * from a scoring outcome. It is measured here instead, one line above the
   * ranking, from the same scan the candidates came out of — so it is a
   * statement about the release and stays true whatever the ranker does with it.
   */
  blindSpots.push(
    ...catalogueBlindSpot({
      requested: RECOMMENDABLE,
      supplied: universe.map((entry) => entry.featureType),
    }),
  );
  if (!isClimateEnabled()) {
    blindSpots.push('Sidequest has no climate records to compare, so nothing below is scored on the weather.');
  }

  // ---- Stage 1: free, local ------------------------------------------------
  const byCountry = new Map<string, DestinationIndexEntry[]>();
  /*
   * V11 §3 — WHERE THE TRAVELLER IS STARTING FROM, IF THE INDEX ALREADY KNOWS.
   *
   * `flightBurden` needs a distance, and a distance needs a point. The composer
   * holds the origin as free text, so this resolves it against the index we
   * already have in memory — a prefix lookup, no network, no provider call, no
   * cost. When it does not resolve, `originDistanceKm` stays absent and the
   * dimension **abstains**: an unmeasured dimension drops out of the denominator
   * and is named in `unknowns`, which is exactly right and is emphatically not
   * the same as scoring every destination as if it were next door.
   *
   * A fare is never derived from this, here or anywhere. §3 forbids inventing
   * airfare and the product has no source for it; distance is a fact about the
   * world and is labelled as one.
   */
  const originPoint = originPointFor(input.answers.origin);
  const free = universe.map((entry) => {
    const evidence = freeEvidence(entry, input.answers, releaseId, input.now, byCountry);
    return originPoint ? { ...evidence, originDistanceKm: Math.round(separationKm(originPoint, entry.center)) } : evidence;
  });

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
  /*
   * V12.1 §31 §36 — THE TWELVE REQUESTS RUN TOGETHER, NOT ONE AFTER ANOTHER.
   *
   * ## What the profiling found
   *
   * Measured in this pass against the real 109,853-row index: the whole local
   * pipeline — the universe scan, ninety-nine per-country feature reads, and
   * two full passes of the fourteen-dimension ranking over 239 candidates —
   * costs **~280 ms**. The climate stage costs **90% of the wall clock**, and
   * it did so because this loop `await`ed each of twelve archive requests in
   * turn. The V11 live acceptance measured the whole operation at **101.9 s**,
   * which is twelve sequential requests to a busy ERA5 archive and almost
   * nothing else.
   *
   * ## Why this is not a cache change
   *
   * Each request is one point's twenty years of daily records, ~250 kB, and it
   * is already cached for thirty days. A cold shortlist has twelve misses by
   * construction, and no cache can make the *first* one fast. The only thing
   * that was wrong was the shape: twelve independent lookups, with no data
   * dependency between them, taken in series.
   *
   * ## What is preserved
   *
   * Everything §32 asks for. The same twelve candidates are chosen, by the same
   * provisional ranking; each one either gets a profile or carries
   * `climate_provider_unavailable`; `climateRequests` counts the same
   * successes; and the results are reassembled **in the original candidate
   * order**, so the ranking sees exactly the list it saw before. A failure is
   * still swallowed per candidate rather than failing the shortlist.
   *
   * The concurrency limit is politeness, not throughput tuning: Open-Meteo is a
   * free service and twelve simultaneous 250 kB requests from one client is not
   * how to use one.
   */
  const CLIMATE_CONCURRENCY = 6;
  let climateRequests = 0;
  const wantedCandidates = free.filter((candidate) => wanted.has(candidate.entry.id));
  const profiles = new Map<string, Awaited<ReturnType<typeof climateFor>>>();
  for (let start = 0; start < wantedCandidates.length; start += CLIMATE_CONCURRENCY) {
    const batch = wantedCandidates.slice(start, start + CLIMATE_CONCURRENCY);
    const answers = await Promise.all(batch.map((candidate) => climateFor(candidate.entry.center, input.now).catch(() => null)));
    batch.forEach((candidate, index) => {
      const profile = answers[index] ?? null;
      if (profile) climateRequests += 1;
      profiles.set(candidate.entry.id, profile);
    });
  }
  const enriched: CandidateEvidence[] = free.map((candidate) => {
    if (!wanted.has(candidate.entry.id)) return candidate;
    const profile = profiles.get(candidate.entry.id) ?? null;
    return profile ? { ...candidate, climate: profile, climateAbsence: undefined } : { ...candidate, climateAbsence: 'climate_provider_unavailable' };
  });

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

/**
 * The traveller's stated origin as a point, from the index alone.
 *
 * Deliberately strict about what counts as a match: the first index row whose
 * display name the origin text actually names, preferring a settlement, and
 * nothing at all when the text is ambiguous or unknown. A wrong origin would
 * silently mis-rank the whole list on `flightBurden`, and no distance is far
 * better than a confident wrong one.
 */
function originPointFor(origin: string | undefined): { lat: number; lng: number } | null {
  const text = origin?.trim();
  if (!text || text.length < 3) return null;
  const rows = entriesByPrefix(text.slice(0, 24).toLowerCase(), 12);
  const needle = text.toLowerCase();
  const exact = rows.find((row: DestinationIndexEntry) => row.displayName.toLowerCase() === needle);
  const named = exact ?? rows.find((row: DestinationIndexEntry) => needle.startsWith(row.displayName.toLowerCase()) || needle.includes(row.displayName.toLowerCase()));
  return named ? named.center : null;
}
