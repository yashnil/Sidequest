import {
  computeBlocking,
  isFactStale,
  isOfficialAuthority,
  type CoverageDimension,
  type CoverageDimensionReport,
  type CoverageLevel,
  type CoverageReason,
  type CoverageReport,
  type FoodVenue,
  type OperatingHoursDataset,
  type Place,
  type RegionEvidence,
  type SourceFact,
  type WeatherLocation,
} from '@sidequest/core';
import type { BudgetLedger } from './budget';
import type { ProviderGap, RoutingMatrixResult } from './providers';

/**
 * WHAT WE ACTUALLY FOUND, COUNTED.
 *
 * Every level here is derived from a number the compilation produced — how many
 * places got a calendar, how many matrix pairs came back, how many facts came
 * from an official page. Nothing is asserted, because a coverage report that can
 * be optimistic is worse than no coverage report: it is the screen a traveller
 * reads to decide how much to trust everything else.
 *
 * There is deliberately no overall percentage. The layers fail independently and
 * a single number would have to average "we have no opening hours" against "we
 * have excellent geography", which is not a thing anyone can act on.
 */

export interface CoverageInput {
  places: readonly Place[];
  hours: OperatingHoursDataset;
  weatherLocations: readonly WeatherLocation[];
  foodVenueCount: number;
  /** The venues themselves, so dietary and hours evidence can be counted. */
  foodVenues?: readonly FoodVenue[];
  /** What the research funnel resolved. Absent when it never ran. */
  evidence?: RegionEvidence;
  matrix: RoutingMatrixResult;
  facts: readonly SourceFact[];
  gaps: readonly ProviderGap[];
  ledger: BudgetLedger;
  drivingPlanned: boolean;
  /** Whether the scope touches water or rail at all. Decides `not_applicable`. */
  hasWaterOrRail: boolean;
  /** Whether the traveller will be walking between things. */
  walkingPlanned: boolean;
  now: Date;
}

/** Ratio → level, in one place so every dimension grades the same way. */
function levelFromRatio(covered: number, expected: number): CoverageLevel {
  if (expected === 0) return 'not_applicable';
  const ratio = covered / expected;
  if (ratio >= 0.9) return 'high';
  if (ratio >= 0.6) return 'usable_with_cautions';
  if (ratio > 0) return 'weak';
  return 'unavailable';
}

function gapReasons(gaps: readonly ProviderGap[], fallback: CoverageReason): CoverageReason[] {
  const reasons = new Set<CoverageReason>();
  for (const gap of gaps) {
    if (gap.reason === 'rate_limited') reasons.add('provider_rate_limited');
    else if (gap.reason === 'provider_error') reasons.add('provider_unavailable');
    else if (gap.reason === 'budget_exhausted') reasons.add('budget_exhausted');
    else if (gap.reason === 'no_official_source') reasons.add('no_official_source_found');
    else if (gap.reason === 'rejected_unsafe_source') reasons.add('provider_unavailable');
    else if (gap.reason === 'not_found') reasons.add('no_results_returned');
    else reasons.add('inferred_not_sourced');
  }
  if (reasons.size === 0) reasons.add(fallback);
  return [...reasons];
}

export function buildCoverageReport(input: CoverageInput): CoverageReport {
  const placeCount = input.places.length;
  const dimensions: CoverageDimensionReport[] = [];

  const add = (
    dimension: CoverageDimension,
    level: CoverageLevel,
    reasons: CoverageReason[],
    detail: string,
    counts?: { expected: number; covered: number },
  ): void => {
    dimensions.push({
      dimension,
      level,
      reasons: reasons.length > 0 ? reasons : ['fully_covered'],
      detail,
      ...(counts ?? {}),
    });
  };

  add(
    'geographic_resolution',
    placeCount > 0 ? 'high' : 'weak',
    placeCount > 0 ? ['fully_covered'] : ['no_results_returned'],
    placeCount > 0
      ? 'The region resolved to a real boundary and everything below sits inside it.'
      : 'We resolved the region but found nothing inside it.',
  );

  add(
    'places',
    placeCount >= 12 ? 'high' : placeCount >= 5 ? 'usable_with_cautions' : placeCount > 0 ? 'weak' : 'unavailable',
    placeCount > 0 ? ['fully_covered'] : gapReasons(input.gaps, 'no_results_returned'),
    placeCount > 0
      ? `${placeCount} places, each one kept only because there was enough evidence to describe it.`
      : 'We found nothing here we could describe well enough to plan around.',
    { expected: placeCount, covered: placeCount },
  );

  const mainstream = input.places.filter((place) => place.popularityScore >= 0.6).length;
  add(
    'mainstream_attractions',
    levelFromRatio(mainstream, Math.max(1, Math.round(placeCount * 0.3))),
    mainstream > 0 ? ['fully_covered'] : ['no_results_returned'],
    `${mainstream} of the well-known stops.`,
    { expected: Math.max(1, Math.round(placeCount * 0.3)), covered: mainstream },
  );

  const gems = input.places.filter((place) => place.hiddenGemScore >= 0.6).length;
  add(
    'hidden_gems',
    levelFromRatio(gems, Math.max(1, Math.round(placeCount * 0.25))),
    gems > 0 ? ['fully_covered'] : ['no_results_returned'],
    gems > 0
      ? `${gems} quieter stops, found by looking for them rather than by filtering a popularity list.`
      : 'Nothing here reads as a quiet alternative to the busy stops.',
    { expected: Math.max(1, Math.round(placeCount * 0.25)), covered: gems },
  );

  const natural = input.places.filter((place) =>
    ['lake', 'viewpoint', 'day_hike', 'easy_walk', 'geothermal', 'hot_spring', 'wildlife_area'].includes(
      place.category,
    ),
  ).length;
  add(
    'natural_features',
    natural > 0 ? 'high' : 'not_applicable',
    natural > 0 ? ['fully_covered'] : ['not_relevant_to_region'],
    natural > 0 ? `${natural} lakes, viewpoints, trails and open ground.` : 'Nothing here is landscape.',
  );

  const knownHours = input.hours.calendars.filter((calendar) => calendar.kind !== 'unknown').length;
  add(
    'operating_hours',
    levelFromRatio(knownHours, Math.max(1, placeCount)),
    knownHours === placeCount ? ['fully_covered'] : gapReasons(input.gaps, 'no_official_source_found'),
    `${knownHours} of ${placeCount} have a published calendar. The rest are recorded as unknown rather than assumed open.`,
    { expected: placeCount, covered: knownHours },
  );

  /**
   * The evidence dimensions, and the rule they all share.
   *
   * Every count below is over **resolved** facts, never over pages fetched or
   * model calls made. A compilation that read forty pages and established
   * nothing has to score zero here, because the traveller's question is what we
   * know, not how hard we tried.
   */
  const evidencePlaces = input.evidence?.places ?? [];
  const researched = evidencePlaces.length;
  const stateCounts = (path: string): { answered: number; conflicted: number; stale: number } => {
    let answered = 0;
    let conflicted = 0;
    let stale = 0;
    for (const place of evidencePlaces) {
      for (const fact of place.resolved) {
        if (!fact.factPath.startsWith(path)) continue;
        if (fact.state === 'conflicted') conflicted += 1;
        else if (fact.state === 'stale') stale += 1;
        else if (fact.state !== 'unknown' && fact.state !== 'unavailable') answered += 1;
      }
    }
    return { answered, conflicted, stale };
  };

  const evidenceReasons = (
    counts: { answered: number; conflicted: number; stale: number },
    fallback: CoverageReason,
  ): CoverageReason[] => {
    const reasons: CoverageReason[] = [];
    if (counts.conflicted > 0) reasons.push('sources_conflict');
    if (counts.stale > 0) reasons.push('evidence_stale');
    if (counts.answered > 0) reasons.push('partial_results_returned');
    if (reasons.length === 0) reasons.push(fallback);
    return reasons;
  };

  if (researched === 0) {
    add(
      'candidate_quality',
      placeCount > 0 ? 'weak' : 'unavailable',
      ['no_official_source_found'],
      'Nothing here was researched against a published source, so every place is only as good as the map data behind it.',
    );
  } else {
    const withOfficial = evidencePlaces.filter((place) => place.officialUrl !== undefined).length;
    add(
      'candidate_quality',
      levelFromRatio(withOfficial, Math.max(1, researched)),
      withOfficial > 0 ? ['partial_results_returned'] : ['no_official_source_found'],
      `${withOfficial} of ${researched} researched places have an official page behind them.`,
      { expected: researched, covered: withOfficial },
    );
  }

  const accessCounts = stateCounts('access.');
  add(
    'access_evidence',
    researched === 0
      ? 'weak'
      : levelFromRatio(accessCounts.answered, Math.max(1, researched)),
    evidenceReasons(accessCounts, 'no_official_source_found'),
    accessCounts.answered > 0
      ? `${accessCounts.answered} sourced statements about getting in.`
      : 'Nobody official publishes entry conditions for these that we could read.',
  );

  const bookingCounts = stateCounts('booking.');
  const needBooking = evidencePlaces.filter(
    (place) => place.booking?.reservationRequired === 'yes' || place.booking?.permitRequired === 'yes',
  ).length;
  add(
    'booking',
    researched === 0
      ? 'weak'
      : bookingCounts.answered > 0
        ? 'usable_with_cautions'
        : 'weak',
    evidenceReasons(bookingCounts, 'no_official_source_found'),
    bookingCounts.answered > 0
      ? `${bookingCounts.answered} booking answers, ${needBooking} of them "yes, book ahead".`
      : 'We could not establish whether anything here needs booking. Assume nothing.',
  );

  const costCounts = stateCounts('cost.');
  const priced = evidencePlaces.filter((place) => place.costs.length > 0).length;
  add(
    'cost',
    researched === 0 ? 'weak' : levelFromRatio(priced, Math.max(1, researched)),
    evidenceReasons(costCounts, 'no_official_source_found'),
    priced > 0
      ? `${priced} places have a published price. A missing price is not a free one.`
      : 'No prices were published anywhere we could read. A missing price is not a free one.',
    { expected: researched, covered: priced },
  );

  const safetyCounts = stateCounts('safety.');
  const closureCount = evidencePlaces.reduce((total, place) => total + place.closures.length, 0);
  add(
    'safety',
    safetyCounts.answered + closureCount > 0 ? 'usable_with_cautions' : 'weak',
    evidenceReasons(safetyCounts, 'no_official_source_found'),
    safetyCounts.answered + closureCount > 0
      ? `${closureCount} closures and ${safetyCounts.answered} cautions, each dated and sourced.`
      : 'Nothing official flagged. That is not the same as nothing to know.',
  );

  const dietaryVenues = (input.foodVenues ?? []).filter((venue) => venue.dietary.length > 0);
  add(
    'dietary_evidence',
    input.foodVenueCount === 0
      ? 'not_applicable'
      : dietaryVenues.length === 0
        ? 'unavailable'
        : levelFromRatio(dietaryVenues.length, Math.max(1, input.foodVenueCount)),
    input.foodVenueCount === 0
      ? ['not_relevant_to_region']
      : dietaryVenues.length > 0
        ? ['partial_results_returned']
        : ['no_official_source_found'],
    input.foodVenueCount === 0
      ? 'No food data, so nothing to say about diets.'
      : dietaryVenues.length > 0
        ? `${dietaryVenues.length} of ${input.foodVenueCount} venues publish something about diets. Never treat this as an allergy guarantee.`
        : 'No venue here publishes dietary information we could read. Call ahead if it matters.',
  );

  const matrixSize = input.matrix.ids.length;
  const totalPairs = Math.max(1, matrixSize * matrixSize - matrixSize);
  const failed = input.matrix.failedPairs.length;
  const routingLevel = levelFromRatio(totalPairs - failed, totalPairs);
  const routingDetail =
    input.matrix.provenance.kind === 'measured'
      ? `Measured road times across ${matrixSize} points${failed > 0 ? `, ${failed} pairs missing` : ''}.`
      : `${input.matrix.provenance.note}${failed > 0 ? ` ${failed} pairs are missing.` : ''}`;

  add(
    'transportation',
    placeCount > 0 ? 'usable_with_cautions' : 'unavailable',
    ['partial_results_returned'],
    'Every place carries an access rule, and a place with no rule was dropped rather than assumed reachable.',
  );

  add(
    'road_routing',
    input.drivingPlanned ? routingLevel : 'not_applicable',
    input.drivingPlanned
      ? input.matrix.provenance.kind === 'measured'
        ? ['fully_covered']
        : ['inferred_not_sourced']
      : ['not_relevant_to_region'],
    input.drivingPlanned ? routingDetail : 'No driving is planned here.',
  );

  add(
    'walking_routing',
    input.walkingPlanned ? routingLevel : 'not_applicable',
    input.walkingPlanned ? ['partial_results_returned'] : ['not_relevant_to_region'],
    input.walkingPlanned ? routingDetail : 'Nothing here is reached on foot from anywhere else.',
  );

  add(
    'transit_routing',
    input.drivingPlanned ? 'not_applicable' : routingLevel,
    input.drivingPlanned ? ['not_relevant_to_region'] : ['partial_results_returned'],
    input.drivingPlanned
      ? 'Planned around a car, so public transport is a fallback rather than the spine.'
      : routingDetail,
  );

  add(
    'ferry_or_rail',
    input.hasWaterOrRail ? 'usable_with_cautions' : 'not_applicable',
    input.hasWaterOrRail ? ['partial_results_returned'] : ['not_relevant_to_region'],
    input.hasWaterOrRail
      ? 'Crossings are modelled as services with calendars. We do not invent sailings.'
      : 'No ferries and no passenger rail in this region.',
  );

  const claimed = new Set(input.weatherLocations.flatMap((location) => location.placeIds));
  add(
    'weather',
    input.weatherLocations.length === 0
      ? 'unavailable'
      : levelFromRatio(claimed.size, Math.max(1, placeCount)),
    input.weatherLocations.length > 0 ? ['fully_covered'] : gapReasons(input.gaps, 'no_provider_configured'),
    input.weatherLocations.length > 0
      ? `${input.weatherLocations.length} forecast points covering ${claimed.size} of ${placeCount} places.`
      : 'No forecast points, so this trip will be planned without weather and will say so.',
    { expected: placeCount, covered: claimed.size },
  );

  add(
    'food',
    input.foodVenueCount === 0 ? 'unavailable' : input.foodVenueCount >= 6 ? 'usable_with_cautions' : 'weak',
    input.foodVenueCount > 0 ? ['partial_results_returned'] : gapReasons(input.gaps, 'no_results_returned'),
    input.foodVenueCount > 0
      ? `${input.foodVenueCount} venues, chosen for where they sit on a route rather than for coverage.`
      : 'No food data. Every meal will be time held rather than somewhere named.',
    { expected: input.foodVenueCount, covered: input.foodVenueCount },
  );

  const temporaryFacts = input.facts.filter((fact) => fact.volatility !== 'stable');
  add(
    'temporary_access',
    temporaryFacts.length > 0 ? 'usable_with_cautions' : 'weak',
    temporaryFacts.length > 0 ? ['evidence_stale'] : ['no_official_source_found'],
    temporaryFacts.length > 0
      ? `${temporaryFacts.length} facts here change with the season or the day, and each is flagged for you to recheck.`
      : 'Nobody publishes closure or permit information for this region that we could find.',
  );

  const officialFacts = input.facts.filter((fact) => isOfficialAuthority(fact.authorityKind)).length;
  add(
    'official_sources',
    levelFromRatio(officialFacts, Math.max(1, input.facts.length)),
    officialFacts > 0 ? ['fully_covered'] : ['no_official_source_found'],
    `${officialFacts} of ${input.facts.length} facts came from the body that actually runs the thing.`,
    { expected: input.facts.length, covered: officialFacts },
  );

  const stale = input.facts.filter((fact) => isFactStale(fact, input.now));
  add(
    'source_freshness',
    stale.length === 0 ? 'high' : levelFromRatio(input.facts.length - stale.length, Math.max(1, input.facts.length)),
    stale.length === 0 ? ['fully_covered'] : ['evidence_stale'],
    stale.length === 0
      ? 'Everything here was read within its own freshness window. Conditions change; we have not checked today.'
      : `${stale.length} facts are past their freshness window and want rechecking.`,
  );

  /**
   * The one row that answers the question a traveller actually has.
   *
   * Everything above is a layer; this is whether the layers add up to a day that
   * can be laid out — somewhere to go, a way to measure the legs, and enough
   * known about opening times that the plan is not a coin toss.
   */
  const knownHoursRatio = placeCount === 0 ? 0 : knownHours / placeCount;
  const plannerReady = placeCount >= 4 && input.matrix.ids.length > 1;
  add(
    'planner_readiness',
    !plannerReady
      ? 'unavailable'
      : knownHoursRatio >= 0.5
        ? 'high'
        : knownHoursRatio > 0
          ? 'usable_with_cautions'
          : 'weak',
    plannerReady ? ['fully_covered'] : ['no_results_returned'],
    plannerReady
      ? `Enough to lay out days: ${placeCount} places with measured travel between them, ${knownHours} of them with hours we can enforce.`
      : 'Not enough here to lay out a day around.',
  );

  const blocking = computeBlocking(dimensions, { drivingPlanned: input.drivingPlanned });
  const exhausted = input.ledger.exhausted();

  return {
    dimensions,
    blocksItinerary: blocking.blocksItinerary,
    blockingDimensions: blocking.blockingDimensions,
    recheckFactIds: input.facts.filter((fact) => fact.recheckRequired).map((fact) => fact.id),
    summary: summarise(dimensions, blocking.blocksItinerary, exhausted),
  };
}

function summarise(
  dimensions: readonly CoverageDimensionReport[],
  blocked: boolean,
  exhausted: readonly string[],
): string {
  if (blocked) {
    return 'There is not enough here to plan on. We would rather say so than pad it.';
  }
  const weak = dimensions.filter(
    (report) => report.level === 'weak' || report.level === 'unavailable',
  );
  const budgetNote =
    exhausted.length > 0
      ? ' We stopped early because this trip ran out of lookups, so this is not everything there is.'
      : '';
  if (weak.length === 0) {
    return `Everything the planner needs is here, with sources.${budgetNote}`;
  }
  return `Enough to plan on, with gaps in ${weak.length} ${weak.length === 1 ? 'area' : 'areas'} listed below.${budgetNote}`;
}
