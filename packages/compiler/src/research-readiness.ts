import {
  RESEARCH_READINESS_VERSION,
  researchLevelFor,
  type DestinationResearchReadiness,
  type GeographicScope,
  type ResearchDimension,
  type ResearchDimensionReport,
  type ResearchDimensionState,
  type ResearchFunnel,
  type ResearchReadinessLevel,
  type ResearchRepair,
  type ResearchRepairAttempt,
  type TravelerProfile,
} from '@sidequest/core';

/**
 * DECIDING WHETHER A RESEARCH PACKET IS A FAIR PICTURE OF A DESTINATION.
 *
 * Pure. No clock, no I/O, no randomness — the same inputs produce the same
 * report byte for byte, which is what lets the artifact carry it and the
 * determinism test stay meaningful.
 *
 * The hardest thing here is not the arithmetic, it is refusing to write a
 * universal quota. "Twelve attractions" is a fine expectation for a capital and
 * a nonsense one for an island of six thousand people, and a rule that calls the
 * island broken has not measured the island — it has measured its own
 * assumptions. So every threshold below is derived from two things the caller
 * supplies: how long the trip is, and what kind of destination this is. Both
 * travel on the report, so the arithmetic can be argued with.
 */

export interface ReadinessInput {
  scope: GeographicScope;
  profile?: TravelerProfile;
  tripDays: number;
  funnel: ResearchFunnel;
  /** Distinct place categories among the visitable set. */
  categories: number;
  /** Areas of the destination holding at least one visitable candidate. */
  areasWithVisitable: number;
  /** Areas the ground was partitioned into. The denominator for spread. */
  areasTotal: number;
  /** Visitable candidates in the single densest area, for concentration. */
  largestAreaVisitable: number;
  /** Distinct source catalogues that contributed a kept record. */
  sourceCatalogues: number;
  /** Visitable candidates whose opening hours are known. */
  hoursKnown: number;
  /** Measured legs, and the pairs a plan would need. Absent when no matrix ran. */
  routing?: { measuredPairs: number; requiredPairs: number };
  /** Transport modes this trip needs that no configured provider can measure. */
  unroutableModes: readonly string[];
  /** Bases and satellites the expansion produced. */
  bases: number;
  satellites: number;
  /** Traveller interests with at least one matching visitable candidate, and the total asked for. */
  interestsCovered?: { matched: number; asked: number };
  /**
   * What became of the things the traveller named by hand.
   *
   * Counts rather than the resolutions themselves, so this function stays a pure
   * arithmetic over numbers a test can write down. `accounted` deliberately
   * includes a request the traveller withdrew or settled: the contract is that
   * nothing is *silently* lost, not that every request is granted.
   *
   * `retriable` is the compiler's own answer to "would looking again plausibly
   * help?", and it is the caller's to give because only the caller knows whether
   * there is ground left to look at. Absent means nobody asked for anything.
   */
  mustDo?: {
    asked: number;
    accounted: number;
    /** Outstanding requests that are waiting on the traveller, not on us. */
    needsTraveller: number;
    retriable: boolean;
  };
  /**
   * Repairs this build has already tried and which did not help.
   *
   * Filtered out of `repairs`, which is what makes the level truthful after the
   * loop has run: `recoverable` says "we are going back for more", and once the
   * only repair that addressed the deficit has been spent, that sentence is no
   * longer true. Empty on the first reading, by construction.
   */
  exhaustedRepairs?: readonly ResearchRepair[];
  /** Whether the compiled ground still covers the destination's published extent. */
  destinationCoverage?: number;
  /** Whether the resolved identity and the ground agree. Absent when unmeasurable. */
  identityAgrees?: boolean;
  /** Whether the pack we read was itself incomplete. */
  packPartial: boolean;
}

/**
 * How many things to do a trip of this length wants.
 *
 * Two per day is the working figure the supply layer already uses, and it is a
 * floor rather than a target: a traveller wants to choose, so a board with
 * exactly enough is a board with no choices in it.
 */
const VISITABLE_PER_DAY = 2;

/** Below this share of what a trip wants, a board cannot honestly be called ready. */
const SUPPLY_PARTIAL_SHARE = 0.6;

/**
 * A destination is expected to have well-known places in proportion to how
 * built-up it is. A city with no anchors at all has been mis-read; a rural
 * subregion with none is simply rural.
 */
const ANCHORS_EXPECTED_BY_BREADTH: Record<string, number> = {
  local: 1,
  city: 3,
  subregion: 2,
  region: 3,
  country: 4,
  multi_country: 5,
};

function report(
  dimension: ResearchDimension,
  state: ResearchDimensionState,
  detail: string,
  required: boolean,
  observed?: number,
  expected?: number,
): ResearchDimensionReport {
  return {
    dimension,
    state,
    detail,
    required,
    ...(observed === undefined ? {} : { observed }),
    ...(expected === undefined ? {} : { expected }),
  };
}

/** Three-way from a ratio, so every dimension grades the same way. */
function grade(observed: number, expected: number, partialShare = SUPPLY_PARTIAL_SHARE): ResearchDimensionState {
  if (expected <= 0) return 'not_applicable';
  if (observed >= expected) return 'met';
  return observed >= expected * partialShare ? 'partial' : 'unmet';
}

export function assessResearchReadiness(input: ReadinessInput): DestinationResearchReadiness {
  const { funnel, scope } = input;
  const dimensions: ResearchDimensionReport[] = [];

  // --- Identity and extent -------------------------------------------------

  dimensions.push(
    input.identityAgrees === undefined
      ? report('identity_agreement', 'unmeasured', 'We could not check the ground against the place you named.', true)
      : input.identityAgrees
        ? report('identity_agreement', 'met', 'The places we found are in the destination you asked for.', true)
        : report(
            'identity_agreement',
            'unmet',
            'What we found does not look like the place you asked for.',
            true,
          ),
  );

  dimensions.push(
    input.destinationCoverage === undefined
      ? report('destination_coverage', 'unmeasured', 'This destination publishes no boundary to compare against.', true)
      : report(
          'destination_coverage',
          grade(input.destinationCoverage, 1, 0.5),
          `We covered ${Math.round(input.destinationCoverage * 100)}% of the area this destination officially spans.`,
          true,
          input.destinationCoverage,
          1,
        ),
  );

  // --- Supply --------------------------------------------------------------

  const wanted = Math.max(2, input.tripDays * VISITABLE_PER_DAY);
  dimensions.push(
    report(
      'experience_supply',
      grade(funnel.visitable, wanted),
      `${funnel.visitable} things to do for ${input.tripDays} ${input.tripDays === 1 ? 'day' : 'days'}.`,
      true,
      funnel.visitable,
      wanted,
    ),
  );

  /**
   * The dimension that would have caught the forty-five restaurants.
   *
   * Not "are there enough attractions" — there were none, and the supply figure
   * alone would have said so. This asks the sharper question: **is the thing we
   * are calling a destination actually made of places to eat?** A packet whose
   * food and support outnumber its things to do has not found a quiet place; it
   * has found the wrong kind of place, or the wrong part of the right one.
   */
  const supportish = funnel.food + funnel.support;
  dimensions.push(
    funnel.visitable === 0 && supportish > 0
      ? report(
          'support_balance',
          'unmet',
          `Everything we found here is somewhere to eat or a practical stop — ${supportish} of them — and nothing is a thing to do.`,
          true,
          0,
          supportish,
        )
      : supportish > funnel.visitable * 2 && funnel.visitable < wanted
        ? report(
            'support_balance',
            'unmet',
            `${supportish} places to eat and practical stops against ${funnel.visitable} things to do.`,
            true,
            funnel.visitable,
            supportish,
          )
        : report(
            'support_balance',
            'met',
            `${funnel.visitable} things to do alongside ${supportish} places to eat and practical stops.`,
            true,
            funnel.visitable,
            supportish,
          ),
  );

  const anchorsExpected = Math.min(
    ANCHORS_EXPECTED_BY_BREADTH[scope.breadth] ?? 2,
    Math.max(1, input.tripDays),
  );
  dimensions.push(
    report(
      'anchor_coverage',
      grade(funnel.anchors, anchorsExpected),
      funnel.anchorDemotions > 0
        ? `${funnel.anchors} places we can build a day around; ${funnel.anchorDemotions} more we found but could not place precisely enough.`
        : `${funnel.anchors} places we can build a day around.`,
      false,
      funnel.anchors,
      anchorsExpected,
    ),
  );

  dimensions.push(
    report(
      'role_diversity',
      funnel.visitable === 0 ? 'unmet' : funnel.anchors > 0 && funnel.discoveries > 0 ? 'met' : 'partial',
      `${funnel.anchors} to build days around and ${funnel.discoveries} smaller finds.`,
      false,
      funnel.anchors + funnel.discoveries,
    ),
  );

  const categoriesExpected = Math.min(3, Math.max(1, Math.floor(funnel.visitable / 2)));
  dimensions.push(
    report(
      'category_diversity',
      grade(input.categories, categoriesExpected),
      `${input.categories} different kinds of thing to do.`,
      true,
      input.categories,
      categoriesExpected,
    ),
  );

  dimensions.push(
    input.interestsCovered === undefined
      ? report('interest_coverage', 'unmeasured', 'We have not been told what you are looking for yet.', false)
      : input.interestsCovered.asked === 0
        ? report('interest_coverage', 'not_applicable', 'You did not single anything out.', false)
        : report(
            'interest_coverage',
            grade(input.interestsCovered.matched, input.interestsCovered.asked, 0.5),
            `${input.interestsCovered.matched} of the ${input.interestsCovered.asked} things you said you were after are represented.`,
            false,
            input.interestsCovered.matched,
            input.interestsCovered.asked,
          ),
  );

  dimensions.push(
    report(
      'hidden_gem_coverage',
      funnel.discoveries > 0 ? 'met' : funnel.visitable > 0 ? 'partial' : 'unmet',
      `${funnel.discoveries} quieter finds.`,
      false,
      funnel.discoveries,
    ),
  );

  /**
   * WHAT YOU ASKED FOR BY NAME.
   *
   * The dimension that read `not_applicable` on every trip in the product for a
   * whole phase, because nothing supplied its input. It is `required` — a packet
   * with forty good generic attractions and no account of the one thing the
   * traveller said they came for is not ready — but it is in
   * `NON_WITHHOLDING_DIMENSIONS`, so failing it never withholds the board. The
   * rest of what we found is still true.
   *
   * `met` requires every request to be *accounted for*, not granted: a request
   * the traveller withdrew, or settled by picking one of several matches, is an
   * answer. There is no partial grade, deliberately. "Two of your three" is not
   * a state anybody can act on; the panel lists each request with its own
   * status, which is the actionable form of the same information.
   */
  const outstandingMustDo =
    input.mustDo === undefined ? 0 : Math.max(0, input.mustDo.asked - input.mustDo.accounted);
  dimensions.push(
    input.mustDo === undefined || input.mustDo.asked === 0
      ? report('must_do_coverage', 'not_applicable', 'You did not name anything specific.', false)
      : outstandingMustDo === 0
        ? report(
            'must_do_coverage',
            'met',
            `All ${input.mustDo.asked} ${input.mustDo.asked === 1 ? 'thing' : 'things'} you named ${input.mustDo.asked === 1 ? 'is' : 'are'} accounted for.`,
            true,
            input.mustDo.accounted,
            input.mustDo.asked,
          )
        : report(
            'must_do_coverage',
            'unmet',
            input.mustDo.needsTraveller > 0
              ? `${outstandingMustDo} of the ${input.mustDo.asked} things you named ${outstandingMustDo === 1 ? 'is' : 'are'} still open, and ${input.mustDo.needsTraveller === 1 ? 'one needs' : `${input.mustDo.needsTraveller} need`} you to pick which you meant.`
              : `${outstandingMustDo} of the ${input.mustDo.asked} things you named ${outstandingMustDo === 1 ? 'is' : 'are'} still unaccounted for.`,
            true,
            input.mustDo.accounted,
            input.mustDo.asked,
          ),
  );

  // --- Shape and geography -------------------------------------------------

  const spreadExpected = Math.min(input.areasTotal, Math.max(1, Math.ceil(input.tripDays / 2)));
  dimensions.push(
    input.areasTotal === 0
      ? report('geographic_spread', 'unmeasured', 'The ground was not divided into areas.', false)
      : report(
          'geographic_spread',
          grade(input.areasWithVisitable, spreadExpected),
          input.areasWithVisitable <= 1 && input.areasTotal > 1
            ? `Everything we found sits in one corner of the area, out of ${input.areasTotal}.`
            : `Things to do in ${input.areasWithVisitable} of ${input.areasTotal} parts of the area.`,
          // Concentration is only a *required* failure when a multi-part ground
          // came back as a single pocket, which is the shape of the metro defect.
          input.areasTotal > 2 && input.areasWithVisitable <= 1,
          input.areasWithVisitable,
          spreadExpected,
        ),
  );

  const needsBases = scope.maxBaseChanges > 0 || input.satellites > 0;
  dimensions.push(
    !needsBases
      ? report('base_satellite_coverage', 'not_applicable', 'This trip stays in one place.', false)
      : report(
          'base_satellite_coverage',
          input.bases > 0 ? 'met' : 'unmet',
          `${input.bases} places to stay and ${input.satellites} trips out from them.`,
          false,
          input.bases,
        ),
  );

  // --- Logistics -----------------------------------------------------------

  dimensions.push(
    input.unroutableModes.length > 0
      ? report(
          'transport_routeability',
          'unmet',
          `This trip needs ${input.unroutableModes.join(' or ')}, and we have no way to measure those journeys here.`,
          true,
        )
      : input.routing === undefined
        ? report('transport_routeability', 'unmeasured', 'No journeys were measured.', true)
        : report(
            'transport_routeability',
            grade(input.routing.measuredPairs, Math.max(1, input.routing.requiredPairs), 0.5),
            `${input.routing.measuredPairs} journeys measured between the places we found.`,
            true,
            input.routing.measuredPairs,
            input.routing.requiredPairs,
          ),
  );

  dimensions.push(
    funnel.visitable === 0
      ? report('hours_evidence', 'unmeasured', 'Nothing to check hours for.', false)
      : report(
          'hours_evidence',
          grade(input.hoursKnown, funnel.visitable, 0.34),
          `We know the opening times for ${input.hoursKnown} of ${funnel.visitable}.`,
          false,
          input.hoursKnown,
          funnel.visitable,
        ),
  );

  dimensions.push(
    report(
      'source_confidence',
      input.sourceCatalogues === 0
        ? 'unmeasured'
        : funnel.visitable > 0 && funnel.membershipUnverified >= funnel.visitable
          ? 'partial'
          : 'met',
      funnel.membershipUnverified > 0
        ? `${input.sourceCatalogues} ${input.sourceCatalogues === 1 ? 'source' : 'sources'}; ${funnel.membershipUnverified} places we could not pin to an official area.`
        : `${input.sourceCatalogues} ${input.sourceCatalogues === 1 ? 'source' : 'sources'}.`,
      false,
      input.sourceCatalogues,
    ),
  );

  // --- The level -----------------------------------------------------------

  const binding = dimensions
    .filter((entry) => entry.required && entry.state === 'unmet')
    .map((entry) => entry.dimension);

  const repairs = repairsFor(binding, input);
  const level = researchLevelFor(binding, repairs, dimensions);

  return {
    schemaVersion: RESEARCH_READINESS_VERSION,
    level,
    funnel,
    dimensions,
    binding,
    repairs,
    repairsAttempted: [],
    summary: summarise(level, binding, dimensions, funnel),
  };
}

/**
 * Which bounded repair addresses which deficit.
 *
 * Ordered by cost, cheapest first, so a loop that can only afford one attempt
 * spends it on the cheapest thing that might work. A deficit with no repair
 * produces none — which is exactly how `recoverable` and `thin` are told apart.
 */
export function repairsFor(
  binding: readonly ResearchDimension[],
  input: ReadinessInput,
): ResearchRepair[] {
  const repairs: ResearchRepair[] = [];
  const has = (dimension: ResearchDimension) => binding.includes(dimension);

  /*
   * A stale pack is only worth re-buying if re-buying it could plausibly fix
   * what is actually wrong.
   *
   * This was unconditional on `packPartial`, so any incomplete pack pushed a
   * repair — which meant a trip blocked on a transport mode no provider can
   * measure was reported as `recoverable`, because the level rule asks only
   * whether *some* repair exists. The guard three lines below, which deliberately
   * withholds `gateway_discovery` for exactly that case, was being routed around
   * by this line.
   */
  const supplyIsBinding = binding.some((dimension) =>
    ['experience_supply', 'support_balance', 'category_diversity', 'geographic_spread', 'destination_coverage'].includes(
      dimension,
    ),
  );
  if (input.packPartial && supplyIsBinding) repairs.push('refresh_stale_pack');
  if (has('identity_agreement')) repairs.push('reresolve_identity');
  if (has('geographic_spread')) repairs.push('reread_underserved_areas');
  if (has('support_balance') || has('experience_supply') || has('category_diversity')) {
    /*
     * FREE FIRST, THEN PAID — AND THE ORDER IS THE SAFETY ARGUMENT.
     *
     * Both address the same deficits and the loop takes the first it has not
     * attempted, so the ordering here is what guarantees a compilation never
     * pays for a search until re-selecting from records already bought has been
     * tried and has not helped. Reversing these two lines would spend money on
     * every thin board, including the many where the ground was fine and a
     * ceiling was the problem.
     */
    repairs.push('category_targeted_query');
    repairs.push('category_targeted_acquisition');
  }
  if (has('transport_routeability') && input.unroutableModes.length === 0) {
    // A missing gateway is findable. A missing *mode* is not, and asking a place
    // source for one would be looking for something no provider can supply.
    repairs.push('gateway_discovery');
  }
  /*
   * A named place we could not find, where there is still ground to look at.
   *
   * `retriable` is false when the outstanding requests are ones no second look
   * could settle — an ambiguity only the traveller can resolve, a record the
   * containment layer placed elsewhere, a place that is shut on these dates.
   * Offering a repair for those would be a button that re-runs a search whose
   * answer is already known, which is worse than no button.
   */
  if (has('must_do_coverage') && input.mustDo?.retriable) repairs.push('targeted_subject_query');

  /*
   * A repair this build already spent is not a repair.
   *
   * Without this filter the level stays `recoverable` — "we are going back for
   * more" — after the loop has been back and returned empty-handed. That is the
   * one sentence on the panel a traveller cannot check, so it has to be the one
   * that is true.
   */
  const exhausted = new Set(input.exhaustedRepairs ?? []);
  return [...new Set(repairs)].filter((repair) => !exhausted.has(repair));
}

function summarise(
  level: ResearchReadinessLevel,
  binding: readonly ResearchDimension[],
  dimensions: readonly ResearchDimensionReport[],
  funnel: ResearchFunnel,
): string {
  if (level === 'ready') {
    return `${funnel.visitable} things to do, spread across the area, with enough detail to plan real days.`;
  }
  const first = dimensions.find((entry) => entry.dimension === binding[0]);
  if (first) return first.detail;
  const soft = dimensions.find((entry) => entry.state === 'unmet' || entry.state === 'partial');
  return soft?.detail ?? `${funnel.visitable} things to do.`;
}

/**
 * The report after a repair ran, with the attempt recorded on it.
 *
 * A separate function rather than a mutation so the before-and-after are two
 * values a test can compare, and so an attempt can never be recorded without a
 * recomputed reading beside it.
 */
export function withRepairAttempt(
  next: DestinationResearchReadiness,
  attempt: ResearchRepairAttempt,
  previous: DestinationResearchReadiness,
): DestinationResearchReadiness {
  return {
    ...next,
    repairsAttempted: [...previous.repairsAttempted, attempt],
  };
}


/**
 * Transport modes this trip needs that nothing configured can measure.
 *
 * The honest answer to "does Sidequest know how to get you across this city by
 * train?" is currently no: there is no transit provider, and the routing
 * provider says so itself through `supportedModes()`. What this function
 * prevents is the substitution that made a metro look planned — a pedestrian
 * matrix over a dense city measures walking, and walking reachability is not
 * evidence about a rail network. The two were being conflated silently; here the
 * gap becomes a named readiness deficit instead.
 *
 * Asked of the provider rather than hard-coded, so the day a transit router is
 * configured this returns an empty list and nothing else has to change.
 */
/** The reach at which a walking trip is self-sufficient. Mirrors the compiler's own. */
const WALKABLE_REACH_KM = 12;

export function unmeasurableModesFor(
  scope: GeographicScope,
  providers: {
    routing?: { supportedModes(): readonly string[] };
    /**
     * The transit seam, asked separately because it *is* separate.
     *
     * A road router's `supportedModes()` can never honestly include transit —
     * that was the whole finding behind splitting the two — so the day a transit
     * provider is configured, this is the only thing that changes and the answer
     * changes with it. Asked here rather than hard-coded so the readiness layer
     * has no opinion about which deployments have one.
     */
    transit?: { supportsTransit(): boolean };
  },
): string[] {
  const supported = new Set(providers.routing?.supportedModes() ?? []);
  if (providers.transit?.supportsTransit()) supported.add('transit');
  /** What each planning mode would need the router to be able to measure. */
  const NEEDS: Record<string, string> = {
    drive: 'car',
    walk: 'foot',
    rideshare: 'car',
    private_transfer: 'car',
    rail: 'transit',
    public_bus: 'transit',
    shuttle: 'transit',
    ferry: 'ferry',
  };

  /*
   * Only the modes this trip actually *depends* on.
   *
   * `allowedModes` is a permission list — for a car-free traveller it is
   * `['walk','public_bus','rail','shuttle','rideshare','ferry']`, meaning "any of
   * these would be acceptable", not "this trip needs all of these". Reading it as
   * a dependency list made every car-free trip report five unmeasurable modes,
   * which made `transport_routeability` unmet, which made the trip `blocked`.
   * A city break on foot is not a blocked trip.
   *
   * A trip depends on a scheduled mode only when its own ground is bigger than
   * the way it can move: a walker whose reach covers the scope walks, and one
   * whose reach does not needs something that runs to a timetable. That is a
   * fact about this trip rather than about what the traveller would tolerate.
   */
  /*
   * Absent reach reads as walkable, not as needing a train.
   *
   * `reachRadiusKm` is optional on the scope and is genuinely missing on some
   * paths. Treating its absence as "this trip depends on a scheduled mode" made
   * every car-free trip in the fixture suite report `blocked` — a verdict about
   * our own missing field, delivered to a traveller as a statement about their
   * destination. The contract's own rule applies: unknown is not a failure. A
   * genuine transport gap still surfaces through the routeability ratio, which
   * measures what was actually connected.
   */
  const walkerCanCoverIt =
    scope.reachRadiusKm === undefined || scope.reachRadiusKm >= WALKABLE_REACH_KM;
  const leansOn = scope.transport.carAvailable
    ? ['drive']
    : walkerCanCoverIt
      ? ['walk']
      : scope.transport.allowedModes.filter((mode) => mode !== 'walk' && mode !== 'rideshare');

  const missing = new Set<string>();
  for (const mode of leansOn) {
    const need = NEEDS[mode];
    if (need && !supported.has(need)) missing.add(mode);
  }

  /*
   * A car-free traveller whose only remaining mode is walking is not missing a
   * provider — they are simply walking, and the routeability dimension measures
   * that directly. Reporting "walk" here would turn every city break into a
   * transport gap.
   */
  missing.delete('walk');
  return [...missing].sort();
}


/**
 * What a repair should actually change, derived from the deficit it addresses.
 *
 * Returns `null` for a repair this pass cannot execute — which is not a gap so
 * much as the honest edge of what re-selection can do. `reresolve_identity`
 * needs the resolution stage, `gateway_discovery` needs a station query and
 * `refresh_stale_pack` needs to buy ground again; all three are provider work
 * and none of them belongs inside a loop whose whole safety argument is that it
 * spends nothing.
 *
 * The two that *are* executable are the two that matter most for the failure
 * this pass exists to fix: a board can be food-dominated or pooled in one corner
 * because of how the inventory selected from the pack, not because the pack was
 * empty. Those are repairable for free, and repairing them is strictly a matter
 * of widening a ceiling — never of lowering a bar.
 */
export function recoveryAdjustment(
  repair: ResearchRepair,
  attempt: number,
): { maxPerCategory?: number; maxAttractions?: number; maxAreaShare?: number } | null {
  /** Multiplicative and bounded: two passes can at most double, never unbound. */
  const step = attempt + 1;
  switch (repair) {
    case 'category_targeted_query':
      /*
       * A board short on things to do, or on variety, when the ground was read
       * under a per-category ceiling. Raising it lets the eleven museums through
       * that four hundred plaques were crowding out.
       */
      return { maxPerCategory: 22 + 14 * step, maxAttractions: 140 + 60 * step };
    case 'reread_underserved_areas':
      /*
       * A board pooled in one corner of a ground divided into many. Lowering the
       * share any one area may hold forces the selection outward — over records
       * already bought, so it costs nothing and can only redistribute.
       */
      return { maxAreaShare: Math.max(0.2, 0.45 - 0.1 * step) };
    default:
      return null;
  }
}

/**
 * WHAT A REPAIR *IS* — RESELECT OR ACQUIRE.
 *
 * `recoveryAdjustment` answers "how should selection change", which was the only
 * question the loop could ask while every repair was free. Section 7 requires
 * recovery to be able to acquire new evidence, and that is a different kind of
 * action with a different safety argument: it costs money, it can fail for
 * reasons that have nothing to do with the deficit, and it has to be charged to
 * a budget.
 *
 * A discriminated union rather than a nullable adjustment, so a caller cannot
 * treat a paid action as a free one by forgetting to check.
 */
export type RecoveryAction =
  | {
      kind: 'reselect';
      adjustment: { maxPerCategory?: number; maxAttractions?: number; maxAreaShare?: number };
    }
  | {
      kind: 'acquire';
      /** Categories to go looking for, chosen from what the board is short of. */
      intents: string[];
      /** Hard ceiling on this attempt. Charged to the compilation's own ledger. */
      maxQueries: number;
      maxPerQuery: number;
    };

/**
 * The action a repair implies, or `null` where this pass cannot execute it.
 *
 * **One repair now returns an `acquire` action, and the spending argument was
 * re-made deliberately to get there.** A previous version of it shipped and was
 * removed after review proved it non-functional: it passed queries into a
 * provider that short-circuits on the region pack before reading them, so it
 * returned the identical inventory, reported zero provider calls, booked ledger
 * spend for work nobody did, and overwrote a broad cached inventory with a
 * narrower one. Three things are different now, and all three had to be:
 *
 * 1. **It runs above the cut.** The supply loop moved ahead of deduplication,
 *    so an acquired record flows through classification, quality, research,
 *    hours and routing like any other candidate. Previously it arrived after the
 *    matrix had been bought and could not have been scheduled.
 * 2. **It uses a seam a provider cannot mistake for an ordinary call** — an
 *    explicit `acquire` field rather than `queries`, which the pack path
 *    genuinely never reads.
 * 3. **It is ranked after the free repair for the same deficits**, so nothing is
 *    ever bought until re-selection has been tried and has not helped.
 *
 * `intents` comes from the caller rather than from the repair id, because the
 * whole claim is that the query is derived from the *deficit*. A repair that
 * always asked for the same categories would be a rerun with a budget attached.
 *
 * `reresolve_identity`, `gateway_discovery` and `refresh_stale_pack` remain
 * unexecutable: each needs a stage the recovery loop does not own — resolution,
 * a station query, buying ground again — and wiring them from inside the loop
 * would mean re-entering the pipeline halfway through. `repairsFor` still names
 * all of them, so a traveller-facing surface can say what *would* help.
 */
export function recoveryActionFor(
  repair: ResearchRepair,
  attempt: number,
  context: {
    /** Kinds of thing the board is short of, derived from the deficit. */
    shortIntents?: readonly string[];
  } = {},
): RecoveryAction | null {
  if (repair === 'category_targeted_acquisition') {
    const intents = [...new Set(context.shortIntents ?? [])].filter(
      (intent) => intent.trim().length > 0,
    );
    /*
     * No deficit-derived intents, no acquisition. A query for "things" is the
     * rerun this repair exists not to be, and paying for one would be the
     * previous attempt with better plumbing.
     */
    if (intents.length === 0) return null;
    return {
      kind: 'acquire',
      intents: intents.slice(0, 3),
      maxQueries: 2,
      maxPerQuery: 40,
    };
  }
  const adjustment = recoveryAdjustment(repair, attempt);
  if (adjustment) return { kind: 'reselect', adjustment };
  return null;
}

/**
 * WHICH REPAIRS BELONG ABOVE THE CUT.
 *
 * The supply loop runs before deduplication, where what it finds can still
 * become a card on the board. `targeted_subject_query` cannot run there — it
 * needs the search space of what survived admission and why, which does not
 * exist until routing has run — so it is deliberately excluded and handled
 * later under its own stage.
 *
 * A set rather than a condition at the call site, so the two loops cannot
 * silently start overlapping.
 */
export const SUPPLY_REPAIRS: readonly ResearchRepair[] = [
  'category_targeted_query',
  'category_targeted_acquisition',
  'reread_underserved_areas',
];

/** Ceilings on the loop, exported so a test can assert them rather than infer them. */
export const MAX_RECOVERY_PASSES = 2;
