import type { ClimateProfile } from '../schemas/climate';
import type { DestinationIndexEntry } from '../schemas/destination-index';
import { qualifiedNameFor } from '../schemas/destination-index';
import type { TripComposerAnswers } from '../schemas/composer';
import { nightsFrom } from '../schemas/composer';
import type { SupplyAssessment } from '../schemas/supply';
import type { RegionPortfolio } from '../scope/portfolio';
import { durationFits, type DurationGuidance } from '../dates/duration';
import { daylightScore, scoreWindow, windowFeatures } from '../dates/windows';
import { monthNormal } from '../schemas/climate';
import {
  measured,
  unknown,
  RANK_DIMENSIONS,
  RANK_DIMENSION_LABELS,
  RANK_WEIGHTS,
  UNKNOWN_REASON_COPY,
  type Conflict,
  type Exclusion,
  type Measure,
  type RankBand,
  type RankDimension,
  type RankFactor,
  type RankedDestination,
} from '../schemas/shortlist';

/**
 * SCORING A DESTINATION, DETERMINISTICALLY.
 *
 * Pure. No provider, no clock, no network, no model. Everything this needs is
 * passed in, and the web layer is responsible for gathering it — which is the
 * same boundary `runPreflight` already respects, and is what makes a ranking
 * reproducible and testable at all.
 *
 * Three rules the file is built to make unbreakable:
 *
 * 1. **Unknown is removed, not scored.** See `schemas/shortlist.ts`. A dimension
 *    nobody could measure drops out of the denominator and appears in
 *    `unknowns`; it never lands as a zero, because "we could not reach the
 *    climate archive" and "it is forty degrees" are different sentences and only
 *    one of them is about the destination.
 * 2. **Prominence is not a dimension.** Not population, not the catalogue's
 *    cartographic rank, not how many records the index holds. That is the
 *    Denali-versus-Delhi defect at destination scale: fame compensating for not
 *    matching the request. It appears once, as the last tiebreak between two
 *    candidates that already scored identically, where its only job is to make
 *    the order total.
 * 3. **Exclusions are rare and about the trip, not the taste.** Four codes, each
 *    backed by a measured number. Everything else is a tradeoff with a sentence.
 */

/**
 * Everything known about one candidate at ranking time.
 *
 * Every field optional except identity, and the optionality is the whole design:
 * a two-stage pipeline measures climate only for the candidates that survive the
 * cheap pass, so most candidates arrive with `climate: undefined` — which must
 * produce an honest `unknown`, not a bad score.
 */
export interface CandidateEvidence {
  entry: DestinationIndexEntry;
  releaseId: string;
  /**
   * V11 §3 — great-circle km from the traveller's origin, when one was resolved.
   *
   * Distance, never a fare and never a flight time: Sidequest has no airfare
   * source and inventing one would be the exact thing §3 forbids. A band of
   * distance is an honest proxy for "how much of the trip is spent getting
   * there" and is labelled as such wherever it is shown.
   */
  originDistanceKm?: number;
  /** Published entry requirements for this country from the traveller's, when an authority states them. */
  entryRequirement?: { kind: 'none' | 'authorisation' | 'visa_on_arrival' | 'visa_in_advance'; sourceName: string };
  /** How busy this destination is in the months under consideration, 0 (empty) to 1 (peak crush), when sourced. */
  crowdPressure?: number;
  /** Whether beds of the traveller's stated comfort exist here at all, from the index. */
  lodgingComfortAvailable?: readonly ('simple' | 'comfortable' | 'refined')[];
  /** Absent when it was never requested, which is a budget fact and is stated. */
  climate?: ClimateProfile;
  /** Why climate is absent, when the caller knows. */
  climateAbsence?: 'not_requested' | 'no_climate_record' | 'climate_provider_unavailable';
  portfolio?: RegionPortfolio;
  duration?: DurationGuidance;
  supply?: SupplyAssessment;
  /** How many index features the destination held. Zero means no coverage. */
  indexFeatureCount: number;
}

export interface RankInput {
  candidate: CandidateEvidence;
  answers: TripComposerAnswers;
  /** The months the traveller could actually travel in. Empty means any. */
  candidateMonths: readonly number[];
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The months this trip could happen in, from whatever the traveller settled on.
 *
 * Returns an empty list rather than all twelve when nothing has been decided, so
 * the caller can tell "any month" from "they said something and it resolved to
 * every month" — which is a real case near the equator, where the four-season
 * model does not describe anything.
 */
export function monthsFromAnswers(answers: TripComposerAnswers, seasonMonths: readonly number[]): number[] {
  const dates = answers.dates;
  if (dates.mode === 'month' && dates.month) return [dates.month];
  if (dates.mode === 'season') return [...seasonMonths];
  if ((dates.mode === 'exact' || dates.mode === 'flexible') && dates.startDate) {
    const month = Number(dates.startDate.slice(5, 7));
    if (month >= 1 && month <= 12) return [month];
  }
  return [];
}

function climateMeasure(input: RankInput): Measure {
  const { candidate, answers, candidateMonths } = input;
  if (!candidate.climate) return unknown(candidate.climateAbsence ?? 'not_requested');

  const months = candidateMonths.length > 0 ? candidateMonths : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const scores: number[] = [];
  for (const month of months) {
    const normal = monthNormal(candidate.climate, month);
    if (!normal) continue;
    scores.push(scoreWindow(windowFeatures(normal, answers)));
  }
  if (scores.length === 0) return unknown('no_climate_record');

  /*
   * The *best* month they could pick when the dates can still move, and the
   * average when they cannot.
   *
   * Scoring a flexible traveller on the average would penalise a destination
   * with one superb month and eleven poor ones — which is precisely the
   * destination somebody with flexible dates should be shown.
   */
  const flexible = answers.dates.mode !== 'exact' || (answers.dates.flexDays ?? 0) > 0;
  const value = flexible
    ? Math.max(...scores)
    : scores.reduce((total, score) => total + score, 0) / scores.length;

  return measured(
    value,
    `${candidate.climate.sampleYearFrom}–${candidate.climate.sampleYearTo} records for ${
      months.length === 1 ? 'that month' : `${months.length} candidate months`
    }`,
  );
}

function daylightMeasure(input: RankInput): Measure {
  const { candidate, candidateMonths } = input;
  if (!candidate.climate) return unknown(candidate.climateAbsence ?? 'not_requested');
  const months = candidateMonths.length > 0 ? candidateMonths : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const scores: number[] = [];
  for (const month of months) {
    const normal = monthNormal(candidate.climate, month);
    if (normal) scores.push(daylightScore(normal));
  }
  if (scores.length === 0) return unknown('no_climate_record');
  return measured(Math.max(...scores), 'daylight computed for the trip window');
}

function durationMeasure(input: RankInput): Measure {
  const nights = nightsFrom(input.answers);
  if (nights === null) return unknown('traveller_did_not_say');
  const guidance = input.candidate.duration;
  if (!guidance || guidance.kind === 'unavailable') return unknown('no_index_coverage');

  const verdict = durationFits({ nights, guidance });
  if (!verdict.fits) {
    const shortest = guidance.options.reduce((a, b) => (a.minNights < b.minNights ? a : b));
    /*
     * Short, not impossible. A trip that reaches one of several areas is a real
     * trip and a good one — it just is not the trip the region's full extent
     * describes. The score says so; the exclusion below only fires when it is
     * less than half of even the shortest option.
     */
    return measured(clamp01(nights / Math.max(1, shortest.minNights)) * 0.5, 'shorter than this ground supports');
  }

  const reached = verdict.suggestion?.clustersReached ?? 1;
  const most = guidance.options.reduce((a, b) => (a.clustersReached > b.clustersReached ? a : b));
  return measured(
    clamp01(reached / Math.max(1, most.clustersReached)) * 0.4 + 0.6,
    `${nights} nights reaches ${reached} of ${most.clustersReached} areas`,
  );
}

function structureMeasure(input: RankInput): Measure {
  const { candidate, answers } = input;
  const portfolio = candidate.portfolio;
  if (!portfolio || portfolio.gateway === null) return unknown('no_index_coverage');
  const shape = answers.shape;
  if (!shape || shape === 'undecided') return unknown('traveller_did_not_say');

  const wanted = shape === 'one_base' ? 1 : shape === 'two_bases' ? 2 : 3;
  const proposed = Math.max(1, portfolio.basesProposed);
  const gap = Math.abs(proposed - wanted);
  return measured(
    gap === 0 ? 1 : gap === 1 ? 0.7 : gap === 2 ? 0.4 : 0.2,
    `${proposed} base${proposed === 1 ? '' : 's'} against the ${wanted} you asked for`,
  );
}

function supplyMeasure(input: RankInput): Measure {
  const { candidate } = input;
  /*
   * No index coverage is not evidence of an empty region.
   *
   * The same rule the preflight already holds, and for the same reason: the
   * alternative is a deployment with a thin index telling every traveller that
   * half the world is unplannable — a claim about *us*, rendered as a claim
   * about the world.
   */
  if (candidate.indexFeatureCount === 0) return unknown('no_index_coverage');
  const supply = candidate.supply;
  if (!supply) return unknown('not_requested');

  const value =
    supply.level === 'strong'
      ? 1
      : supply.level === 'usable'
        ? 0.72
        : supply.level === 'thin_repairable'
          ? 0.35
          : supply.level === 'insufficient'
            ? 0.1
            : 0;
  if (supply.level === 'infrastructure_failure') return unknown('no_index_coverage');

  /*
   * THE SUMMARY IS ABOUT A TRIP LENGTH, SO IT MAY ONLY BE QUOTED WHEN WE HAVE ONE.
   *
   * `assessSupply` phrases its verdict against the days it was given — "…
   * comfortably enough to build 9 days from" — and this screen is reached before
   * anybody has necessarily said how long they are going for. The shortlist then
   * passes a zero, and `narrate` promoted the resulting sentence to the first
   * bullet of the lead recommendation: "182 mapped places across 8 areas —
   * comfortably enough to build **0 days** from."
   *
   * The counts are true and the clause about days is not, so the clause is
   * dropped rather than the fact. Composed here from the same funnel the
   * assessment was made from, which is the only place that can know the
   * traveller said nothing — `assessSupply` sees a number and has no way to tell
   * "zero days" from "not stated".
   */
  const nights = nightsFrom(input.answers);
  if (nights === null) {
    const { candidates, clusters } = supply.funnel;
    return measured(
      value,
      `${candidates} mapped place${candidates === 1 ? '' : 's'} across ${clusters} area${clusters === 1 ? '' : 's'}`,
    );
  }
  return measured(value, supply.summary);
}

function varietyMeasure(input: RankInput): Measure {
  const portfolio = input.candidate.portfolio;
  if (!portfolio || portfolio.allClusters.length === 0) return unknown('no_index_coverage');
  /*
   * Areas, not categories.
   *
   * At ranking time nothing has been compiled, so there is no role breakdown to
   * read — the honest proxy for "is there more than one kind of day here" is how
   * many distinct areas the ground divides into. It is a weaker signal than the
   * compiled one and it is labelled as an estimate everywhere it is shown.
   */
  const clusters = portfolio.allClusters.length;
  return measured(clamp01((clusters - 1) / 5), `${clusters} distinct area${clusters === 1 ? '' : 's'}`);
}

/**
 * Themes, against the only theme evidence that exists before a compilation.
 *
 * Deliberately thin, and honest about it. The index holds settlements and their
 * administrative type; it does not hold beaches or trailheads. What it *can*
 * support is the city-versus-country axis, which is the single distinction that
 * most changes whether somebody enjoys a destination — and the remaining themes
 * resolve to `unknown` rather than to a number this data cannot justify.
 */
function themeMeasure(input: RankInput): Measure {
  const themes = input.answers.themes;
  if (themes.length === 0) return unknown('traveller_did_not_say');

  const wantsCities = themes.includes('cities');
  const wantsQuiet = themes.includes('quiet');
  const wantsOutdoors = themes.some((theme) => theme === 'outdoors' || theme === 'mountains' || theme === 'water');
  if (!wantsCities && !wantsQuiet && !wantsOutdoors) return unknown('not_sourced');

  const type = input.candidate.entry.featureType;
  const urban = type === 'city' || type === 'district';
  const wild = type === 'national_park' || type === 'protected_area' || type === 'island';

  /*
   * AN ADMINISTRATIVE UNIT IS NOT EVIDENCE ABOUT ITS LANDSCAPE.
   *
   * The paragraph above promises that "the remaining themes resolve to
   * `unknown` rather than to a number this data cannot justify". It did not
   * hold for the remaining *feature types*: a `region` or a `county` is neither
   * urban nor wild by this test, so the function fell through to its `0.5`
   * starting value and returned it as a measurement.
   *
   * That is not a middling fit, it is no reading at all, and it was the worst
   * kind of unmeasured number: measured over the live index, `themeFit` came
   * back `0.50` for **240 of 240** candidates — every one of them a region or a
   * county, because the index holds no parks, islands or protected areas at
   * all. So a twelve-hundredths slice of the weight moved nothing, added the
   * same 0.06 to every score, and — because coverage is measured weight over
   * nominal weight — lifted every candidate's confidence by 0.12 for a
   * dimension nobody had looked at. That is how eight indistinguishable
   * administrative polygons came to be labelled "worth a look".
   *
   * `no_index_coverage` rather than `not_sourced`, deliberately: whether a
   * region has mountains in it is published in plenty of places, just not in
   * ours. The reason copy says so, and the honest sentence is about us.
   */
  if (!urban && !wild) return unknown('no_index_coverage');

  let value = 0.5;
  if (wantsCities && urban) value += 0.35;
  if (wantsCities && wild) value -= 0.2;
  if ((wantsQuiet || wantsOutdoors) && wild) value += 0.35;
  if ((wantsQuiet || wantsOutdoors) && urban) value -= 0.15;

  return measured(clamp01(value), 'from what kind of place this is, which is all the index can say');
}

function transportMeasure(input: RankInput): Measure {
  const transport = input.answers.transport;
  if (!transport || transport === 'undecided') return unknown('traveller_did_not_say');
  const portfolio = input.candidate.portfolio;
  if (!portfolio || portfolio.allClusters.length === 0) return unknown('no_index_coverage');

  if (transport === 'drive' || transport === 'mixed') {
    return measured(1, 'driving reaches everything we found here');
  }

  /*
   * Without a car, a spread-out region is a harder trip.
   *
   * Measured from the ground rather than asserted: the furthest area from the
   * gateway is how far somebody would have to get without driving, and the index
   * knows that distance. It is not a statement about whether a bus exists — we
   * have no such data, and the copy says so.
   */
  const furthest = portfolio.allClusters.reduce(
    (max, cluster) => Math.max(max, cluster.distanceFromGatewayKm),
    0,
  );
  return measured(
    furthest <= 40 ? 1 : furthest <= 90 ? 0.7 : furthest <= 180 ? 0.4 : 0.2,
    `the furthest area we found is about ${Math.round(furthest)} km out`,
  );
}

/*
 * ---------------------------------------------------------------------------
 * V11 §3 — the six the recommender adds
 * ---------------------------------------------------------------------------
 *
 * Every one returns `unknown` rather than a middling number when the evidence
 * is absent, because `unknown` drops the weight out of the denominator and a
 * guess does not. That is the same rule the eight above already follow, and it
 * is what makes `coverage` mean something.
 */

/** How far the traveller will fly, in great-circle kilometres. Distance, never a fare. */
const FLIGHT_TOLERANCE_KM: Record<'short' | 'moderate' | 'long' | 'any', number> = {
  short: 1_500,
  moderate: 5_000,
  long: 12_000,
  any: 20_000,
};

function flightBurdenMeasure(input: RankInput): Measure {
  const km = input.candidate.originDistanceKm;
  if (km === undefined) return unknown('traveller_did_not_say');
  const tolerance = input.answers.flightTolerance ?? 'any';
  const ceiling = FLIGHT_TOLERANCE_KM[tolerance];
  /*
   * A trip well inside the tolerance scores full marks; one at the ceiling
   * scores poorly but is not excluded — that is `beyond_flight_tolerance`'s job,
   * and it only fires past the ceiling. Linear in distance rather than in some
   * modelled hours, because hours would be a fabricated schedule.
   */
  return measured(clamp01(1 - km / ceiling), `about ${Math.round(km / 100) * 100} km from where you are starting, against a ${tolerance} appetite for flying`);
}

function crowdFitMeasure(input: RankInput): Measure {
  const pressure = input.candidate.crowdPressure;
  if (pressure === undefined) return unknown('not_sourced');
  const tolerance = input.answers.crowdTolerance;
  if (!tolerance) return unknown('traveller_did_not_say');
  /* Somebody who is unbothered gets no penalty at all; somebody avoiding crowds gets the inverse. */
  const value = tolerance === 'unbothered' ? 1 : tolerance === 'tolerate' ? clamp01(1 - pressure * 0.5) : clamp01(1 - pressure);
  return measured(value, `${Math.round(pressure * 100)}% of its peak busyness in the months you can go`);
}

function entryFrictionMeasure(input: RankInput): Measure {
  const requirement = input.candidate.entryRequirement;
  /*
   * Absent means no authority publishes it for this pairing, which is a gap in
   * us and never "no visa needed". Only `official_current`-grade sources reach
   * this field; the readiness layer holds the same line.
   */
  if (!requirement) return unknown('not_sourced');
  const value = requirement.kind === 'none' ? 1 : requirement.kind === 'authorisation' ? 0.8 : requirement.kind === 'visa_on_arrival' ? 0.6 : 0.25;
  return measured(value, `${requirement.kind.replace(/_/g, ' ')}, per ${requirement.sourceName}`);
}

function noveltyFitMeasure(input: RankInput): Measure {
  const visited = input.answers.visited ?? [];
  const appetite = input.answers.surpriseAppetite;
  if (visited.length === 0 && !appetite) return unknown('traveller_did_not_say');
  const name = `${input.candidate.entry.displayName} ${input.candidate.entry.countryCode ?? ''}`.toLowerCase();
  /*
   * "Already visited" is matched on the traveller's own words against the
   * destination's own name, and it LOWERS the score rather than excluding —
   * plenty of people go back somewhere on purpose, and §3 says similarity is a
   * soft preference.
   */
  const seen = visited.some((place) => {
    const needle = place.trim().toLowerCase();
    return needle.length > 2 && (name.includes(needle) || needle.includes(input.candidate.entry.displayName.toLowerCase()));
  });
  const base = seen ? 0.2 : 1;
  if (appetite === 'familiar') return measured(seen ? 1 : 0.6, seen ? 'somewhere you already know, which you said you would welcome' : 'new to you');
  if (appetite === 'surprise_me') return measured(seen ? 0.05 : 1, seen ? 'you have already been here' : 'new to you, which is what you asked for');
  return measured(base, seen ? 'you have already been here' : 'new to you');
}

function comfortFitMeasure(input: RankInput): Measure {
  const wanted = input.answers.lodgingComfort;
  const available = input.candidate.lodgingComfortAvailable;
  if (!wanted) return unknown('traveller_did_not_say');
  if (!available || available.length === 0) return unknown('no_index_coverage');
  if (available.includes(wanted)) return measured(1, `${wanted} places to stay exist here`);
  /* Simpler than asked for is a compromise; grander than asked for is not a problem. */
  const RANK = { simple: 0, comfortable: 1, refined: 2 } as const;
  const best = Math.max(...available.map((kind) => RANK[kind]));
  return measured(best > RANK[wanted] ? 0.8 : 0.35, best > RANK[wanted] ? `nothing ${wanted} on record, but grander places exist` : `only simpler places than ${wanted} on record`);
}

function climatePreferenceMeasure(input: RankInput): Measure {
  const wanted = input.answers.climatePreference;
  if (!wanted || wanted === 'any') return unknown('traveller_did_not_say');
  const climate = input.candidate.climate;
  if (!climate) return unknown(input.candidate.climateAbsence ?? 'no_climate_record');
  const months = input.candidateMonths.length > 0 ? input.candidateMonths : [];
  if (months.length === 0) return unknown('traveller_did_not_say');
  const highs = months.map((month) => monthNormal(climate, month)?.temperature.high).filter((value): value is number => typeof value === 'number');
  if (highs.length === 0) return unknown('no_climate_record');
  const mean = highs.reduce((total, value) => total + value, 0) / highs.length;
  /* Bands, not a curve: "warm" is a thing people mean, and 24 °C is the middle of it. */
  const target = wanted === 'warm' ? 26 : wanted === 'mild' ? 18 : 4;
  const value = clamp01(1 - Math.abs(mean - target) / 18);
  return measured(value, `daytime highs average ${Math.round(mean)} °C in the months you can go`);
}

const MEASURERS: Record<RankDimension, (input: RankInput) => Measure> = {
  climateFit: climateMeasure,
  daylightFit: daylightMeasure,
  durationFit: durationMeasure,
  structureFit: structureMeasure,
  supplyFit: supplyMeasure,
  varietyFit: varietyMeasure,
  themeFit: themeMeasure,
  transportFit: transportMeasure,
  flightBurden: flightBurdenMeasure,
  crowdFit: crowdFitMeasure,
  entryFriction: entryFrictionMeasure,
  noveltyFit: noveltyFitMeasure,
  comfortFit: comfortFitMeasure,
  climatePreferenceFit: climatePreferenceMeasure,
};

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * Hard exclusions, all four of them.
 *
 * Each returns at most one, each is backed by a number, and none of them is
 * about taste. A destination excluded here does not appear in the shortlist at
 * all — so the bar is deliberately "this trip cannot happen" rather than "this
 * trip would be worse".
 */
export function exclusionsFor(input: RankInput): Exclusion[] {
  const { candidate, answers, candidateMonths } = input;
  const found: Exclusion[] = [];

  /*
   * A stated limit, against a measured climate. Requires *both*: a traveller who
   * said nothing is not excluded from anywhere, and a destination whose climate
   * we could not read is never excluded — an absent archive must not be able to
   * remove somewhere from the world.
   */
  if (candidate.climate && candidateMonths.length > 0) {
    const avoidsHeat = answers.avoid?.toLowerCase().includes('heat') ?? false;
    const normals = candidateMonths
      .map((month) => monthNormal(candidate.climate!, month))
      .filter((normal): normal is NonNullable<typeof normal> => normal !== undefined);
    if (avoidsHeat && normals.length > 0 && normals.every((normal) => normal.hotDays >= 12)) {
      found.push({
        code: 'climate_conflicts_with_stated_limit',
        message: `Every month you could travel has at least twelve days above 32 °C here, and you asked us to keep the heat out.`,
      });
    }
  }

  if (candidate.indexFeatureCount > 0 && candidate.portfolio && candidate.portfolio.gateway === null) {
    found.push({
      code: 'nowhere_to_stay',
      message: 'We could not find anywhere inside this we could sensibly base you.',
    });
  }

  /*
   * V11 §3 — HARD DISQUALIFIERS, SEPARATED FROM SOFT PREFERENCES.
   *
   * Both of these describe a trip the traveller said they will not take, rather
   * than one they would enjoy less. Both require the traveller to have said so
   * explicitly and the evidence to exist: silence excludes nowhere, and a
   * distance we could not compute excludes nowhere either. `'any'` is a real
   * answer meaning "no limit" and must never disqualify anything.
   */
  const scope = answers.tripScope;
  const origin = answers.originCountry;
  const destinationCountry = candidate.entry.countryCode;
  if (scope && scope !== 'either' && origin && destinationCountry) {
    const domestic = origin.toUpperCase() === destinationCountry.toUpperCase();
    if (scope === 'domestic' && !domestic) {
      found.push({ code: 'outside_stated_trip_scope', message: 'You asked to stay inside your own country, and this is not.' });
    } else if (scope === 'international' && domestic) {
      found.push({ code: 'outside_stated_trip_scope', message: 'You asked to leave the country, and this is inside it.' });
    }
  }

  const tolerance = answers.flightTolerance;
  const distanceKm = candidate.originDistanceKm;
  if (tolerance && tolerance !== 'any' && distanceKm !== undefined) {
    const ceiling = FLIGHT_TOLERANCE_KM[tolerance];
    if (distanceKm > ceiling) {
      found.push({
        code: 'beyond_flight_tolerance',
        message: `About ${Math.round(distanceKm / 100) * 100} km away, and you said you would rather not fly further than a ${tolerance} hop.`,
      });
    }
  }

  const nights = nightsFrom(answers);
  if (nights !== null && candidate.duration && candidate.duration.kind === 'recommended') {
    const shortest = candidate.duration.options.reduce((a, b) => (a.minNights < b.minNights ? a : b));
    if (shortest.minNights > nights * 2) {
      found.push({
        code: 'far_too_short_for_this_ground',
        message: `The least we would build here is ${shortest.minNights} nights, and you have ${nights}.`,
      });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The band, gated by coverage.
 *
 * This gate is what makes "unknown is not zero" visible to a traveller rather
 * than only to the code. A destination we could measure two dimensions of cannot
 * be called a strong match however well those two went, because the honest
 * description of it is that we do not know.
 */
export function bandFor(score: number, coverage: number): RankBand {
  if (coverage < 0.5) return 'thin_evidence';
  if (score >= 78 && coverage >= 0.7) return 'strong_match';
  if (score >= 62) return 'worth_a_look';
  return 'possible';
}

export function rankDestination(input: RankInput): RankedDestination {
  const { candidate } = input;
  const factors: RankFactor[] = [];
  const unknowns: string[] = [];

  let measuredWeight = 0;
  let earned = 0;
  for (const id of RANK_DIMENSIONS) {
    const weight = RANK_WEIGHTS[id];
    const measure = MEASURERS[id](input);
    const contribution = measure.kind === 'measured' ? weight * measure.value : 0;
    if (measure.kind === 'measured') {
      measuredWeight += weight;
      earned += contribution;
    } else {
      unknowns.push(`${RANK_DIMENSION_LABELS[id]} — ${UNKNOWN_REASON_COPY[measure.reason]}`);
    }
    factors.push({ id, label: RANK_DIMENSION_LABELS[id], weight, measure, contribution });
  }

  const nominal = Object.values(RANK_WEIGHTS).reduce((total, weight) => total + weight, 0);
  const coverage = nominal === 0 ? 0 : clamp01(measuredWeight / nominal);
  const score = measuredWeight === 0 ? 0 : Math.round(clamp01(earned / measuredWeight) * 100);

  const { reasons, tradeoffs, conflicts } = narrate(input, factors);

  const best = candidate.duration?.kind === 'recommended'
    ? candidate.duration.options.find((option) => option.recommended) ?? candidate.duration.options[0]
    : undefined;

  return {
    entryId: candidate.entry.id,
    releaseId: candidate.releaseId,
    displayName: candidate.entry.displayName,
    ...(candidate.entry.localName ? { localName: candidate.entry.localName } : {}),
    qualifiedName: qualifiedNameFor(candidate.entry),
    featureType: candidate.entry.featureType,
    center: candidate.entry.center,
    ...(candidate.entry.countryCode ? { countryCode: candidate.entry.countryCode } : {}),
    score,
    coverage,
    band: bandFor(score, coverage),
    factors,
    conflicts,
    unknowns,
    reasons,
    tradeoffs,
    ...(best ? { suggestedNights: best.maxNights, suggestedBases: best.bases } : {}),
  };
}

/**
 * The sentences, generated from the same numbers that produced the score.
 *
 * Written here rather than authored separately for the reason `buildReasons`
 * already gives in the fit scorer: an explanation written by hand drifts from
 * the ranking it claims to explain, and nobody notices until a traveller reads
 * a reason that contradicts the order.
 */
function narrate(
  input: RankInput,
  factors: readonly RankFactor[],
): { reasons: string[]; tradeoffs: string[]; conflicts: Conflict[] } {
  const reasons: string[] = [];
  const tradeoffs: string[] = [];
  const conflicts: Conflict[] = [];
  const by = new Map(factors.map((factor) => [factor.id, factor]));

  const value = (id: RankDimension): number | null => {
    const measure = by.get(id)?.measure;
    return measure && measure.kind === 'measured' ? measure.value : null;
  };
  const basis = (id: RankDimension): string | null => {
    const measure = by.get(id)?.measure;
    return measure && measure.kind === 'measured' ? measure.basis : null;
  };

  const climate = value('climateFit');
  if (climate !== null && climate >= 0.75) {
    reasons.push(`The weather suits this trip at that time of year — ${basis('climateFit')}.`);
  } else if (climate !== null && climate <= 0.45) {
    tradeoffs.push(`The months you can travel are not this place at its best.`);
    if (input.answers.dates.mode === 'exact') {
      conflicts.push({
        code: 'dates_outside_the_best_months',
        message: 'Moving your dates would change this more than anything else would.',
      });
    }
  }

  const duration = value('durationFit');
  if (duration !== null && duration >= 0.85) {
    reasons.push(`Your trip length fits the ground here — ${basis('durationFit')}.`);
  } else if (duration !== null && duration <= 0.5) {
    tradeoffs.push('You would see one part of this rather than the whole of it.');
  }

  const supply = value('supplyFit');
  if (supply !== null && supply >= 0.9) reasons.push(basis('supplyFit') ?? '');
  else if (supply !== null && supply <= 0.4) tradeoffs.push(basis('supplyFit') ?? '');

  const variety = value('varietyFit');
  if (variety !== null && variety >= 0.6) reasons.push(`Several distinct areas — ${basis('varietyFit')}.`);
  else if (variety !== null && variety <= 0.2) {
    conflicts.push({
      code: 'concentrated_in_one_area',
      message: 'Almost everything we found here is in one place, so this is a stay rather than a route.',
    });
  }

  const structure = value('structureFit');
  if (structure !== null && structure <= 0.5) {
    conflicts.push({
      code: 'shape_needs_more_nights',
      message: `${basis('structureFit')} — worth changing one or the other.`,
    });
  }

  const transportMeasureValue = by.get('transportFit')?.measure;
  if (
    transportMeasureValue?.kind === 'measured' &&
    input.answers.transport === 'public_transport' &&
    transportMeasureValue.value <= 0.5
  ) {
    conflicts.push({
      code: 'assumed_no_car',
      message: `${transportMeasureValue.basis}. We have no transit data for this — saying you would drive would change the answer.`,
    });
  }

  return {
    reasons: [...new Set(reasons.filter(Boolean))].slice(0, 3),
    tradeoffs: [...new Set(tradeoffs.filter(Boolean))].slice(0, 3),
    conflicts,
  };
}
