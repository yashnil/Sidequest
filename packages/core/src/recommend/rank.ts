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

const MEASURERS: Record<RankDimension, (input: RankInput) => Measure> = {
  climateFit: climateMeasure,
  daylightFit: daylightMeasure,
  durationFit: durationMeasure,
  structureFit: structureMeasure,
  supplyFit: supplyMeasure,
  varietyFit: varietyMeasure,
  themeFit: themeMeasure,
  transportFit: transportMeasure,
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
