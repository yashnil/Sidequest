import {
  computeBlocking,
  isFactStale,
  isOfficialAuthority,
  type AccessRule,
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
  type TransportService,
  type WeatherLocation,
} from '@sidequest/core';
import type { BoundaryEvidence } from './backbone/containment';
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
  /** Every routable node, places included. `planner_readiness` counts the places in it. */
  matrix: RoutingMatrixResult;
  /** The network the matrix was measured on. `RoutingMatrixResult` has no mode of its own. */
  matrixMode: 'car' | 'foot';
  facts: readonly SourceFact[];
  gaps: readonly ProviderGap[];
  ledger: BudgetLedger;
  drivingPlanned: boolean;
  /**
   * HOW THE THINGS WE FOUND ARE ACTUALLY REACHED.
   *
   * `transportation` used to be graded `placeCount > 0 ? usable_with_cautions :
   * unavailable` and print "Every place carries an access rule, and a place with
   * no rule was dropped rather than assumed reachable" — a claim about access
   * rules supported by nothing but a count of places. `ferry_or_rail` was worse:
   * it branched on whether the scope's mode list mentioned water or rail, and
   * `deriveScope` puts rail in that list on every single trip, so the row said
   * "Crossings are modelled as services with calendars" for landlocked cities
   * with no service of any kind and its `not_applicable` branch was dead code.
   *
   * Both rows now grade on the modelled ways in themselves: which places a rule
   * covers, who published it, and which crossings carry a timetable.
   *
   * Optional because a caller with no access layer has nothing to report, and an
   * absent dataset must never read as a measured zero — absent means the rows say
   * they do not know, which caps them below `high` rather than inventing a gap.
   */
  access?: {
    /** Every rule that covers at least one of `places`. */
    rules: readonly AccessRule[];
    /** Every modelled service, of any mode. Crossings are filtered out of it here. */
    services: readonly TransportService[];
  };
  /** Whether the traveller will be walking between things. */
  walkingPlanned: boolean;
  /**
   * The measured public-transport journeys, when the compilation bought any.
   *
   * Without this, the transit row reused the road matrix's own sentence —
   * "Measured road times across 15 points" printed under PUBLIC TRANSPORT, to a
   * car-free traveller, two screens before a board header that says how many
   * journeys were checked against timetables. The founder regression, in the
   * evidence table.
   */
  transit?: { requested: number; measured: number } | null;
  /**
   * HOW THE DESTINATION'S EDGE WAS DRAWN, AND WHAT COULD BE PLACED AGAINST IT.
   *
   * `geographic_resolution` blocks the itinerary, and it used to be graded
   * `high` the moment a single place survived — printing "The region resolved to
   * a real boundary and everything below sits inside it." On the Tokyo artifact
   * stored on this machine there is no boundary at all (the scope's edge is a
   * reach circle drawn around a centre, `boundaryEvidence: 'reach_circle'`) and
   * 3,767 of 3,787 records came back `membership_unknown`. A place count cannot
   * support either half of that sentence: it knows nothing about whether an
   * outline exists, and nothing about whether anything was placed inside one.
   * The blocking dimension was asserting the one thing it most needs to prove.
   *
   * Optional because a discovery path with no ground layer has nothing to
   * report, and an absent count must never read as a measured zero. Absent means
   * the dimension says it does not know, which caps it below `high` — it never
   * restores the grade this field was added to remove.
   */
  geography?: {
    boundaryEvidence: BoundaryEvidence;
    /**
     * The placement arithmetic, when something judged membership at all.
     *
     * Three numbers rather than one ratio because they fail differently and a
     * ratio would hide which failure happened. `read` is everything the ground
     * layer handed us; `placed` is the subset any verdict could be reached on,
     * which collapses when there is no division directory to resolve names
     * through; `inside` is the subset placed positively within the destination's
     * own published identity, which collapses on its own when the ground we read
     * belongs to somewhere else.
     */
    placement?: { read: number; placed: number; inside: number };
  };
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

/**
 * THE REASON A ROW GIVES HAS TO AGREE WITH THE GRADE BESIDE IT.
 *
 * Five rows — places, mainstream attractions, hidden gems, weather and official
 * sources — attached `fully_covered` on any non-empty count, whatever level was
 * computed on the line above. `COVERAGE_REASON_COPY` renders that word as
 * "Covered.", so a region with three places printed **Thin — Covered.** and one
 * with a tenth of its places under a forecast printed **Thin — Covered.** too.
 * Two contradictory verdicts on one row is worse than either of them alone: it
 * tells a reader the grade is decorative.
 *
 * Only three reasons can actually contradict a level, and they are the three
 * filtered here. Everything else is a qualifier that survives at any grade — a
 * matrix can be complete *and* derived (`inferred_not_sourced`), a 90 %-covered
 * row can still be `evidence_stale`, and a gap cause like
 * `provider_rate_limited` explains the missing tenth of an otherwise good row.
 */
function agreesWithLevel(reason: CoverageReason, level: CoverageLevel): boolean {
  if (reason === 'fully_covered') return level === 'high';
  if (reason === 'not_relevant_to_region') return level === 'not_applicable';
  if (reason === 'partial_results_returned') return level !== 'high';
  return true;
}

/** What a row says when nothing more specific survived the filter above. */
function defaultReasonFor(level: CoverageLevel): CoverageReason {
  switch (level) {
    case 'high':
      return 'fully_covered';
    case 'not_applicable':
      return 'not_relevant_to_region';
    case 'unavailable':
      return 'no_results_returned';
    default:
      return 'partial_results_returned';
  }
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
    const agreeing = reasons.filter((reason) => agreesWithLevel(reason, level));
    dimensions.push({
      dimension,
      level,
      reasons: agreeing.length > 0 ? agreeing : [defaultReasonFor(level)],
      detail,
      ...(counts ?? {}),
    });
  };

  /**
   * WHERE THIS IS, GRADED ON THE EDGE AND ON WHAT SAT INSIDE IT.
   *
   * Two claims live in this row and each needs its own evidence: that the
   * destination has a real edge, and that the things below sit inside it. A
   * reach circle is a statement about how far a traveller will go, not about
   * where the destination ends, so it can never reach `high` however many places
   * survived. A build that could place almost nothing against the edge cannot
   * reach `high` either, whatever the edge was.
   *
   * Unmeasured stays `usable_with_cautions` rather than falling to `weak`: not
   * knowing how the edge was drawn is not evidence that it is wrong, and a
   * blocking row that goes amber on every path with no ground layer is a warning
   * nobody reads.
   */
  const geography = input.geography;
  const boundaryResolved = geography !== undefined && geography.boundaryEvidence !== 'reach_circle';
  const placement = geography?.placement;
  const placedShare = placement && placement.read > 0 ? placement.placed / placement.read : null;

  const geographicLevel: CoverageLevel =
    placeCount === 0
      ? 'weak'
      : placedShare === null
        ? 'usable_with_cautions'
        : /*
           * Placed, and not one of them inside the destination. The instrument
           * worked and answered "somewhere else" every time, which is a
           * different failure from not being able to answer and is the shape a
           * region compiled off the wrong ground takes.
           */
          placement!.placed > 0 && placement!.inside === 0
          ? 'weak'
          : placedShare >= 0.9 && boundaryResolved
            ? 'high'
            : placedShare >= 0.6
              ? 'usable_with_cautions'
              : 'weak';

  const geographicReasons: CoverageReason[] = [];
  if (!boundaryResolved) geographicReasons.push('no_official_source_found');
  if (placedShare === null) geographicReasons.push('inferred_not_sourced');
  else if (placedShare < 0.9) geographicReasons.push('partial_results_returned');
  if (placeCount === 0) geographicReasons.push('no_results_returned');

  const edgeSentence =
    geography === undefined
      ? 'Nothing on this build recorded how the edge of this destination was drawn.'
      : geography.boundaryEvidence === 'published_boundary'
        ? 'This destination publishes its own outline, and that is the edge we used.'
        : geography.boundaryEvidence === 'measured_extent'
          ? 'We measured how far this destination actually extends and used that as its edge.'
          : 'Nobody publishes an outline for this destination, so its edge here is a travelling distance drawn around a centre point.';

  const placementSentence =
    placeCount === 0
      ? 'We found nothing inside it to plan around.'
      : placement === undefined || placement.read === 0
        ? 'Nothing on this build checked which of the things we found sit inside it.'
        : placement.inside > 0
          ? `Of the ${placement.read} map entries we read here, ${placement.placed} could be placed against it, ${placement.inside} of them inside the destination itself.`
          : `Of the ${placement.read} map entries we read here, ${placement.placed} could be placed against it, and not one of them inside the destination itself.`;

  add(
    'geographic_resolution',
    geographicLevel,
    geographicReasons,
    `${edgeSentence} ${placementSentence}`,
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

  /**
   * WHAT WE FOUND, NOT WHAT EXISTS — AND THE DENOMINATOR THAT PRETENDED OTHERWISE.
   *
   * These two rows were graded `covered / round(placeCount * 0.3)` and
   * `/ round(placeCount * 0.25)`: a share **of our own result set**. So "Good —
   * the well-known ones" meant "three in ten of the things we happened to find
   * score popular on our own scale", which is true of a board made entirely of
   * municipal drainage ponds as long as the scorer likes three of them. That is
   * §4's Tokyo regression class stated as a grade, and it is the one grade that
   * would have said the board was fine while it was full of tiny parks.
   *
   * Nothing in this artifact knows the famous stops of a destination we did not
   * find, so no ratio here can be honest. What can be honest is the count, an
   * absolute threshold on it, and a sentence that refuses the completeness claim
   * outright. `expected`/`covered` are dropped rather than recomputed: a count
   * pair renders as a fraction, and there is no denominator to put under it.
   */
  const mainstream = input.places.filter((place) => place.popularityScore >= 0.6).length;
  add(
    'mainstream_attractions',
    mainstream >= 8 ? 'high' : mainstream >= 3 ? 'usable_with_cautions' : mainstream > 0 ? 'weak' : 'unavailable',
    mainstream > 0 ? [] : ['no_results_returned'],
    mainstream > 0
      ? `${mainstream} of the ${placeCount} places we found are ones a lot of people go to. We can count what we found; we cannot promise it is every famous stop here.`
      : 'Nothing we found here reads as a well-known stop.',
  );

  const gems = input.places.filter((place) => place.hiddenGemScore >= 0.6).length;
  add(
    'hidden_gems',
    gems >= 8 ? 'high' : gems >= 3 ? 'usable_with_cautions' : gems > 0 ? 'weak' : 'unavailable',
    gems > 0 ? [] : ['no_results_returned'],
    gems > 0
      ? `${gems} of the ${placeCount} places we found are quieter alternatives to the busy stops.`
      : 'Nothing we found here reads as a quiet alternative to the busy stops.',
  );

  /**
   * A PLACE WE DID NOT FIND IS NOT A PLACE THAT DOES NOT EXIST.
   *
   * This row printed "Nothing here is landscape." whenever our own sample held
   * no lake, trail or viewpoint — a statement about the destination, made from
   * the absence of a record in our table, on a build that may never have looked.
   * It also graded `high` off a single hit, so one municipal pond among two
   * hundred stops read as good coverage of the outdoors.
   *
   * Graded on the count and worded as what we found, on the same absolute scale
   * `food` and `places` already use.
   */
  const natural = input.places.filter((place) =>
    ['lake', 'viewpoint', 'day_hike', 'easy_walk', 'geothermal', 'hot_spring', 'wildlife_area'].includes(
      place.category,
    ),
  ).length;
  add(
    'natural_features',
    natural >= 6 ? 'high' : natural >= 3 ? 'usable_with_cautions' : natural > 0 ? 'weak' : 'unavailable',
    natural > 0 ? [] : ['no_results_returned'],
    natural > 0
      ? `${natural} of the ${placeCount} places we found are lakes, viewpoints, trails or open ground.`
      : 'We did not find any lakes, viewpoints, trails or open ground here.',
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
  /**
   * `answered` counts facts; `places` counts the places holding them.
   *
   * Both are needed and mixing them is what went wrong: `access_evidence` graded
   * `answered / researched`, dividing a **fact** total summed over every place by
   * a **place** total. Four access facts about one museum out of twenty places
   * came out as a ratio of 0.2 and the same museum with twenty facts came out as
   * 1.0 — "Good — getting in", from one building. The ratio had no unit, could
   * exceed 1, and answered a question nobody asked.
   */
  const stateCounts = (
    path: string,
  ): { answered: number; conflicted: number; stale: number; places: number } => {
    let answered = 0;
    let conflicted = 0;
    let stale = 0;
    let places = 0;
    for (const place of evidencePlaces) {
      let placeAnswered = false;
      for (const fact of place.resolved) {
        if (!fact.factPath.startsWith(path)) continue;
        if (fact.state === 'conflicted') conflicted += 1;
        else if (fact.state === 'stale') stale += 1;
        else if (fact.state !== 'unknown' && fact.state !== 'unavailable') {
          answered += 1;
          placeAnswered = true;
        }
      }
      if (placeAnswered) places += 1;
    }
    return { answered, conflicted, stale, places };
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
    /**
     * A LINK PRINTED IN A MAP RECORD IS NOT A PAGE ANYBODY READ.
     *
     * This row was `officialUrl !== undefined`, graded as a share of researched
     * places and printed as "N of M researched places have an official page
     * behind them" — a sentence a traveller reads as *we went and looked*. It is
     * not what the field means. `officialUrl` is filled in `enrich.ts` from
     * `knownOfficialUrls`, which `compile.ts` builds out of `place.source.url` —
     * the `website` tag that travelled with the map record. And
     * `identity.officialSite` is deliberately absent from `wantedPathsFor`
     * ("answered by a structured source ... never by extraction"), so the fact
     * branch of that same `??` chain is unreachable in production: **every**
     * count this row produced came from a map tag, on a build that may have
     * fetched nothing at all. The grade was `levelFromRatio`, so a pack whose
     * records happen to carry websites reached **Good — How much we know about
     * them** with zero pages retrieved.
     *
     * That is this file's own rule broken on this file's own row: "Every count
     * below is over resolved facts, never over pages fetched" — this one was
     * over neither. It counted a string.
     *
     * So it grades on what came back. A place counts when at least one fact we
     * wanted for it resolved to a state only a retrieved source can produce;
     * `unknown` and `unavailable` are what a question nobody could answer looks
     * like and they are excluded, exactly as `stateCounts` excludes them.
     *
     * The links are still reported, because a traveller can open one and it is
     * worth having — but as what they are. `factId` is the discriminator: a
     * claim minted from a resolved fact carries one and `knownClaim`, which is
     * what a map tag gets, does not.
     */
    const readFromSource = (state: string): boolean =>
      state !== 'unknown' && state !== 'unavailable';
    const answered = evidencePlaces.filter((place) =>
      place.resolved.some((fact) => readFromSource(fact.state)),
    ).length;
    const unreadLinks = evidencePlaces.filter(
      (place) => place.officialUrl !== undefined && place.officialUrlClaim?.factId === undefined,
    ).length;
    const linkSentence =
      unreadLinks > 0
        ? ` ${unreadLinks} carry a website the map data listed for them, which nothing here has opened.`
        : '';
    add(
      'candidate_quality',
      levelFromRatio(answered, Math.max(1, researched)),
      answered > 0 ? ['partial_results_returned'] : ['no_official_source_found'],
      answered > 0
        ? `${answered} of ${researched} places we looked up came back with something a published source states.${linkSentence}`
        : `Nothing we looked up came back with a published statement, so these ${researched} places are only as good as the map data behind them.${linkSentence}`,
      { expected: researched, covered: answered },
    );
  }

  const accessCounts = stateCounts('access.');
  add(
    'access_evidence',
    researched === 0 ? 'weak' : levelFromRatio(accessCounts.places, Math.max(1, researched)),
    evidenceReasons(accessCounts, 'no_official_source_found'),
    accessCounts.places > 0
      ? `${accessCounts.places} of ${researched} researched places have a sourced statement about getting in.`
      : 'Nobody official publishes entry conditions for these that we could read.',
    researched === 0 ? undefined : { expected: researched, covered: accessCounts.places },
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
      ? `${priced} ${priced === 1 ? 'place has' : 'places have'} a published price. A missing price is not a free one.`
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
  /*
   * The matrix has one network, and the sentence names it — a pedestrian matrix
   * is walking times, not road times, and printing the wrong noun here is the
   * same substitution the rest of this phase removes from the board.
   */
  const network = input.matrixMode === 'foot' ? 'walking' : 'road';
  const routingDetail =
    input.matrix.provenance.kind === 'measured'
      ? `Measured ${network} times across ${matrixSize} points${failed > 0 ? `, ${failed} pairs missing` : ''}.`
      : `${input.matrix.provenance.note}${failed > 0 ? ` ${failed} pairs are missing.` : ''}`;

  /**
   * GETTING AROUND, GRADED ON THE RULES RATHER THAN ON A HEADCOUNT.
   *
   * The claim on this row — every place has a way in, and one without a rule was
   * dropped rather than assumed reachable — happens to be true of the compiler
   * (see the drop in `compile.ts`), but it was printed beside a level derived
   * from `placeCount > 0`. A count of places cannot support a claim about access
   * rules, and the row said the same thing whether the rules were read off a
   * national park's own page or modelled from a map tag.
   *
   * So it counts the rules: how many of the places we are planning around a rule
   * actually covers, and how many of those rules came from whoever runs the
   * place. `high` needs the second number, because "we worked out how to get in"
   * and "they published how to get in" are different claims and only one of them
   * is worth a good grade.
   */
  const accessRules = input.access?.rules;
  const ruledPlaceIds = new Set((accessRules ?? []).flatMap((rule) => rule.placeIds));
  const officialRuledPlaceIds = new Set(
    (accessRules ?? [])
      .filter((rule) => rule.provenance.kind === 'official')
      .flatMap((rule) => rule.placeIds),
  );
  const ruled = input.places.filter((place) => ruledPlaceIds.has(place.id)).length;
  const officiallyRuled = input.places.filter((place) => officialRuledPlaceIds.has(place.id)).length;

  const transportReasons: CoverageReason[] = [];
  if (ruled < placeCount) transportReasons.push('partial_results_returned');
  if (officiallyRuled === 0) transportReasons.push('no_official_source_found');
  else if (officiallyRuled < placeCount) transportReasons.push('partial_results_returned');

  add(
    'transportation',
    placeCount === 0
      ? 'unavailable'
      : accessRules === undefined
        ? /*
           * Unmeasured, not empty. Nothing recorded the access layer on this
           * build, which is not evidence that the places are unreachable — it
           * caps the row below `high` and says so, exactly as the geography row
           * does when nothing judged placement.
           */
          'usable_with_cautions'
        : ruled < placeCount
          ? levelFromRatio(ruled, placeCount)
          : officiallyRuled >= placeCount * 0.9
            ? 'high'
            : 'usable_with_cautions',
    accessRules === undefined ? ['inferred_not_sourced'] : transportReasons,
    placeCount === 0
      ? 'There is nothing here to get to.'
      : accessRules === undefined
        ? 'Nothing on this build recorded how these places are reached.'
        : `${ruled} of ${placeCount} places have a recorded way in, ${officiallyRuled} of them published by whoever runs the place.`,
    accessRules === undefined || placeCount === 0
      ? undefined
      : { expected: placeCount, covered: ruled },
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

  /*
   * Public transport is graded on its own evidence — the journeys a timetable
   * provider actually answered — never on the matrix. The matrix cannot hold a
   * transit answer, and its sentence used to be printed here verbatim.
   */
  const transitRequested = input.transit?.requested ?? 0;
  const transitMeasured = input.transit?.measured ?? 0;
  add(
    'transit_routing',
    input.drivingPlanned
      ? 'not_applicable'
      : transitRequested > 0
        ? levelFromRatio(transitMeasured, transitRequested)
        : 'unavailable',
    input.drivingPlanned
      ? ['not_relevant_to_region']
      : transitRequested > 0
        ? ['partial_results_returned']
        : ['no_provider_configured'],
    input.drivingPlanned
      ? 'Planned around a car, so public transport is a fallback rather than the spine.'
      : transitRequested > 0
        ? `${transitMeasured} of ${transitRequested} journeys checked against published timetables.`
        : 'No journey planner was available, so public transport here is unverified.',
  );

  /**
   * CROSSINGS WE ACTUALLY HOLD A TIMETABLE FOR.
   *
   * This row branched on `hasWaterOrRail`, which the compile stage derived from
   * `scope.transport.allowedModes` — and `deriveScope` puts `rail` in that list
   * on every trip it builds, with or without a car. So the `not_applicable`
   * branch was unreachable in production and every landlocked destination on
   * earth was told "Crossings are modelled as services with calendars", a
   * description of our data model standing in for a statement about its
   * contents, on a build holding no service of any kind.
   *
   * The replacement grades on the services themselves. Zero is reported as zero
   * rather than as "no ferries and no passenger rail in this region": we know
   * what we modelled, and we do not know what a coastline publishes that we
   * never asked for.
   */
  const crossings = (input.access?.services ?? []).filter(
    (service) => service.mode === 'ferry' || service.mode === 'rail',
  ).length;
  add(
    'ferry_or_rail',
    input.access === undefined ? 'usable_with_cautions' : crossings > 0 ? 'usable_with_cautions' : 'unavailable',
    input.access === undefined
      ? ['inferred_not_sourced']
      : crossings > 0
        ? ['partial_results_returned']
        : ['no_results_returned'],
    input.access === undefined
      ? 'Nothing on this build recorded which boats or trains run here.'
      : crossings > 0
        ? `${crossings} ferry or train services here run to a published calendar. We do not invent sailings.`
        : 'We hold no ferry or train timetable for this region, so nothing here is planned around one. Check the operator yourself if you need a crossing.',
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

  /**
   * AN EMPTY FACT TABLE IS NOT A REGION WITHOUT CLOSURES.
   *
   * The zero branch printed "Nobody publishes closure or permit information for
   * this region that we could find" — a verdict on every agency in the
   * destination, derived from our own table being empty, and printed identically
   * on a build where the research never ran at all. Those are two different
   * situations and neither of them is knowledge about the region.
   *
   * Separated, so the row says which one happened: nothing read, or read and
   * nothing seasonal in it. Neither is allowed to claim there is nothing to know.
   */
  const temporaryFacts = input.facts.filter((fact) => fact.volatility !== 'stable');
  add(
    'temporary_access',
    temporaryFacts.length > 0 ? 'usable_with_cautions' : input.facts.length === 0 ? 'unavailable' : 'weak',
    temporaryFacts.length > 0
      ? ['evidence_stale']
      : input.facts.length === 0
        ? ['no_results_returned']
        : ['no_official_source_found'],
    temporaryFacts.length > 0
      ? `${temporaryFacts.length} facts here change with the season or the day, and each is flagged for you to recheck.`
      : input.facts.length === 0
        ? 'Nothing here was read from a dated source, so we have nothing on closures or permits either way.'
        : `Nothing in the ${input.facts.length} facts we read mentions a closure or a permit. Treat that as us not finding one, not as there being none.`,
  );

  const officialFacts = input.facts.filter((fact) => isOfficialAuthority(fact.authorityKind)).length;
  add(
    'official_sources',
    levelFromRatio(officialFacts, Math.max(1, input.facts.length)),
    officialFacts > 0 ? ['fully_covered'] : ['no_official_source_found'],
    `${officialFacts} of ${input.facts.length} facts came from the body that actually runs the thing.`,
    { expected: input.facts.length, covered: officialFacts },
  );

  /*
   * NOTHING READ IS NOT THE SAME AS NOTHING STALE.
   *
   * `stale.length === 0` is true of a compilation that established no dated
   * source at all, and this row graded that `high` and printed "Everything here
   * was read within its own freshness window" — a claim about zero facts, on the
   * row a traveller reads to decide how much of this to trust. Same shape as the
   * geography row above: an empty set standing in for a clean bill of health.
   */
  const stale = input.facts.filter((fact) => isFactStale(fact, input.now));
  add(
    'source_freshness',
    input.facts.length === 0
      ? 'unavailable'
      : stale.length === 0
        ? 'high'
        : levelFromRatio(input.facts.length - stale.length, input.facts.length),
    input.facts.length === 0
      ? ['no_results_returned']
      : stale.length === 0
        ? ['fully_covered']
        : ['evidence_stale'],
    input.facts.length === 0
      ? 'Nothing here came from a dated source, so there is nothing to say about how recently it was checked.'
      : stale.length === 0
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
  /**
   * FOUR PLACES WE CAN MEASURE BETWEEN, NOT FOUR PLACES AND TWO NODES.
   *
   * The test was `placeCount >= 4 && matrix.ids.length > 1`, and the two halves
   * counted different populations: `matrix.ids` also holds bases, food venues and
   * gateways, so a build with four places and a matrix containing one place, two
   * hotels and a car park satisfied it. "Enough to lay out days: 4 places with
   * measured travel between them" would then be printed over a set of places
   * three of which had no measurable leg to anything.
   *
   * One population, counted once: places that are in the matrix.
   */
  const matrixIds = new Set(input.matrix.ids);
  const routablePlaces = input.places.filter((place) => matrixIds.has(place.id)).length;
  const plannerReady = routablePlaces >= 4;
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
      ? /*
         * The matrix names its own provenance, and this row prints it.
         *
         * It said "measured travel between them" whatever the matrix actually
         * was — so a trip whose legs were modelled or estimated (the ordinary
         * outcome for a car-free city, see `modelled-walk.ts`) was told its
         * travel had been measured, on the one row that answers whether the
         * trip can be planned. §7 forbids exactly that substitution: measured,
         * derived and estimated are different labels because they are different
         * claims.
         */
        `Enough to lay out days: ${routablePlaces} places with ${input.matrix.provenance.kind} travel between them, ${knownHours} of them with hours we can enforce.`
      : 'Not enough here to lay out a day around.',
  );

  const blocking = computeBlocking(dimensions, { drivingPlanned: input.drivingPlanned });
  const exhausted = input.ledger.exhausted();

  return {
    dimensions,
    blocksItinerary: blocking.blocksItinerary,
    blockingDimensions: blocking.blockingDimensions,
    recheckFactIds: input.facts.filter((fact) => fact.recheckRequired).map((fact) => fact.id),
    summary: summarise(dimensions, blocking.blocksItinerary, exhausted, input.gaps),
  };
}

/**
 * A SOURCE THAT REFUSED IS NOT A SOURCE THAT ANSWERED NOTHING INTERESTING.
 *
 * The summary knew about one way a build could be short of what is out there —
 * the budget — and said so. It knew nothing about the other, which is the one
 * that happens at three in the morning: every provider erroring or rate-limiting
 * while a cached pack supplies the places. Nothing in `weak.length` can see that,
 * because a row whose evidence came out of the cache grades on the cache. So the
 * top line of the build report read "Everything the planner needs is here, with
 * sources." over a compilation on which **nothing external answered at all** —
 * a green instrument during a total outage, which is worse than no instrument.
 *
 * `gaps` was already an input and already carries the reason. Two of its values
 * are a live source failing rather than a live source having no answer, and only
 * those two are counted: `not_found` and `no_official_source` are answers.
 */
function refusedProviderCount(gaps: readonly ProviderGap[]): number {
  return gaps.filter((gap) => gap.reason === 'provider_error' || gap.reason === 'rate_limited')
    .length;
}

function summarise(
  dimensions: readonly CoverageDimensionReport[],
  blocked: boolean,
  exhausted: readonly string[],
  gaps: readonly ProviderGap[],
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
  const refused = refusedProviderCount(gaps);
  const refusalNote =
    refused > 0
      ? ` ${refused} ${refused === 1 ? 'lookup' : 'lookups'} failed or were turned away while we built this, so parts of it are older or thinner than they would otherwise be.`
      : '';
  if (weak.length === 0) {
    /*
     * "with sources" is a claim about where this came from, and it may not be
     * made on a build where the sources refused. The rest of the sentence is
     * still true — the layers really are all above the line — so it is qualified
     * rather than replaced.
     */
    return refused > 0
      ? `Everything the planner needs is here, from what we already held.${refusalNote}${budgetNote}`
      : `Everything the planner needs is here, with sources.${budgetNote}`;
  }
  return `Enough to plan on, with gaps in ${weak.length} ${weak.length === 1 ? 'area' : 'areas'} listed below.${refusalNote}${budgetNote}`;
}
