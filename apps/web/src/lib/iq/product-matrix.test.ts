import { describe, expect, it } from 'vitest';
import {
  autoSelect,
  buildDiscoveryBoard,
  buildTravelerProfile,
  countTripDays,
  defaultAnswers,
  CLARIFICATION_SET_VERSION,
  interestOfferFromRegion,
  isVisitableRole,
  planningRoleOfPlace,
  unavailableWeatherDataset,
  type ClarificationSet,
  type CompiledRegion,
  type DiscoveryBoard,
  type DiscoverySelection,
  type Interest,
  type ItineraryDay,
  type QuestionnaireAnswers,
  type TravelerProfile,
  type TripBasics,
  type SourceRecord,
  type WeatherDataset,
  geographicScopeSchema,
} from '@sidequest/core';
import { assemblePack, buildInventory, compileRegion, deriveScope, partitionScope } from '@sidequest/compiler';
import {
  SYNTHETIC_WORLDS,
  expectWorld,
  packBackedProviders,
  syntheticCandidate,
  type FakeResearchOptions,
} from '@sidequest/compiler/testing';
import { planTrip, type PlanResult } from '@sidequest/planner';

/**
 * THE §29 END-TO-END PRODUCT EVALUATION MATRIX.
 *
 * Section 29's opening line is the whole reason this file exists: *do not judge
 * global quality from one destination*. Everything else in the suite proves a
 * mechanism — a journey can be measured, a name can be resolved, a deficit can
 * be repaired. This proves that seven **fundamentally different trip shapes**
 * each come out the other end as a trip somebody could take, and it proves it
 * by running the real chain rather than by inspecting an artifact:
 *
 *   compile → discovery board → auto-pick → plan
 *
 * Every scenario runs all four stages. That is deliberate and it is the part
 * that costs: a scenario that stopped at the compiled region would pass while
 * the planner refused every stop, and a scenario that started from a hand-built
 * board would pass while acquisition returned nothing. The failures §29 is
 * looking for — a car-free traveller quietly driven, a board of map noise, a
 * plan of empty days — all live in the seams between the stages.
 *
 * ## What may and may not be asserted here
 *
 * §29 closes with a rule that constrains this file more than any other: **no
 * destination-specific production behaviour may be added to pass these tests**.
 * So nothing below names a real place, and every world is a *shape* — a dense
 * transit metropolis, a road region with satellites, an archipelago — carried by
 * the synthetic worlds the compiler's own testing module already publishes.
 *
 * The second rule is inherited from the Travel IQ suite beside this one, which
 * was rewritten once for exactly this: an assertion that is arithmetic about the
 * fixture generator is not a test. `categories.size >= 3` over a generator that
 * assigns categories round-robin holds for every world by construction and
 * cannot be falsified by any change to the product. Where a property below
 * looks like it could be satisfied by the fixture alone, it is stated against a
 * *contrast* instead — two profiles over one region, or the scheduled order
 * against the orders that were available — so that only the product's own
 * behaviour can produce the result.
 *
 * Offline throughout: no provider, no network, no clock, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const MONTHS = [8];

/** Four nights, which is long enough to have a middle day and short enough to be quick. */
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

interface CompileOptions {
  composerTransport?: string;
  transitMeasurable?: boolean;
  nights?: number;
  dates?: readonly string[];
  /**
   * How much of this destination the *research* layer can find a source for.
   *
   * Separate from the world's shape because it is a different kind of thinness.
   * A `SyntheticWorldSpec` describes the ground — how many places are there, how
   * far apart, whether a road can be measured — and `packBackedProviders` takes
   * this second argument to describe how much of that ground anybody has
   * written down. Left unset, the fake funnel finds an official page for 60% of
   * subjects, which is the right default for six of the seven shapes and flatly
   * wrong for the seventh. See `WEAK_DATA`.
   */
  research?: FakeResearchOptions;
  /**
   * An extent the destination's own source published, where a scenario needs one.
   *
   * `syntheticCandidate` publishes none, which is the truthful default — the
   * live destination index carries a centre and no polygon for every city, town,
   * county, island and park in it. §29 D needs the other case as well, because
   * the multi-part guard in `deriveShape` lives inside the branch a published
   * extent selects, and a fixture that can never take that branch leaves the
   * guard covered by nothing.
   */
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } };
}

/**
 * Compile a world through the **pack-backed** provider set, always.
 *
 * `fakeProviders` hands the compiler finished `Place`s, which skips the entire
 * backbone — partitioning, extraction, taxonomy, linking, significance,
 * retention, the inventory. Half of what §29 asks these scenarios to prove
 * ("no low-value map-feature domination", "useful names and descriptions",
 * "weak data degrades honestly") is decided in exactly that stretch, so a matrix
 * built on finished places would be certifying the fixture's own list.
 */
async function compileWorld(
  key: keyof typeof SYNTHETIC_WORLDS,
  options: CompileOptions = {},
): Promise<CompiledRegion> {
  const spec = SYNTHETIC_WORLDS[key]!;
  const dates = options.dates ?? DATES;
  const candidate = syntheticCandidate(spec);
  const scope = deriveScope({
    candidate: options.bounds ? { ...candidate, bounds: options.bounds } : candidate,
    clarifications: emptyClarifications(),
    nights: options.nights ?? dates.length,
    revision: 1,
    ...(options.composerTransport ? { composerTransport: options.composerTransport } : {}),
    ...(options.transitMeasurable === undefined
      ? {}
      : { transitMeasurable: options.transitMeasurable }),
  });
  const result = await compileRegion({
    compilationId: `matrix-${spec.id}`,
    scope,
    dates: [...dates],
    months: MONTHS,
    providers: packBackedProviders(spec, options.research ?? {}),
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(
      `The ${String(key)} world did not compile: ${result.code} — ${result.message}. ` +
        'A §29 scenario cannot assert anything about a region that does not exist.',
    );
  }
  /* The first line of every scenario, for the reason travel-iq.test.ts records. */
  expectWorld(result.region, key);
  return result.region;
}

/**
 * The traveller, built the way the product builds one.
 *
 * `buildTravelerProfile` is the only supported route from answers to a profile —
 * it derives the frequency caps, the intensity ceiling, the slot count and the
 * hidden-gem target — so a scenario that hand-wrote a `TravelerProfile` literal
 * would be testing the scorer against a profile the questionnaire cannot
 * produce. Overrides are applied to the *answers*, never to the derived block.
 */
function travellerFrom(
  overrides: Partial<QuestionnaireAnswers>,
  dates: readonly string[] = DATES,
): TravelerProfile {
  const context = {
    travelerNeeds: [],
    tripDays: countTripDays(dates[0]!, dates[dates.length - 1]!),
  };
  const answers: QuestionnaireAnswers = { ...defaultAnswers(context), ...overrides };
  return buildTravelerProfile(answers, context);
}

/** Interests graded one at a time, so a scenario states only what it means to. */
function interests(
  levels: Partial<Record<Interest, 'avoid' | 'low' | 'occasional' | 'frequent' | 'core'>>,
): Partial<QuestionnaireAnswers> {
  return { interests: levels };
}

function basicsFor(region: CompiledRegion, dates: readonly string[] = DATES): TripBasics {
  return {
    mode: 'known_destination',
    destinationInput: region.scope.destinationName,
    regionId: region.region.id,
    startDate: dates[0]!,
    endDate: dates[dates.length - 1]!,
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  };
}

/**
 * The weather a trip has before anybody fetches any.
 *
 * Every day `unavailable`, with a reason — which is what the product hands the
 * planner for a region whose forecast has not been retrieved. Used rather than a
 * synthetic forecast because a dataset full of honest absences is the one shape
 * that cannot quietly decide which day a place lands on, and none of these
 * scenarios is about the forecast.
 */
function unfetchedWeather(region: CompiledRegion, dates: readonly string[]): WeatherDataset {
  return unavailableWeatherDataset({
    regionId: region.region.id,
    locations: region.weatherLocations,
    dates: [...dates],
    now: NOW,
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

function primaryBaseOf(region: CompiledRegion) {
  return region.bases.find((base) => base.id === region.primaryBaseId) ?? region.bases[0]!;
}

/** The board, built from exactly what the planner is given below. */
function boardFor(
  region: CompiledRegion,
  profile: TravelerProfile,
  dates: readonly string[] = DATES,
): DiscoveryBoard {
  return buildDiscoveryBoard({
    region: region.region,
    places: region.places,
    profile,
    months: MONTHS,
    dates: [...dates],
    access: region.access,
    hours: region.operatingHours,
    weather: unfetchedWeather(region, dates),
    ...(region.evidence ? { evidence: region.evidence } : {}),
    travelerNeeds: [],
    travel: {
      matrix: region.travelTimes,
      ...(region.transitEvidence ? { transit: region.transitEvidence } : {}),
      baseId: primaryBaseOf(region).routingId,
      baseIds: region.bases.map((base) => base.routingId),
    },
  });
}

interface Journey {
  board: DiscoveryBoard;
  auto: ReturnType<typeof autoSelect>;
  plan: PlanResult;
}

/**
 * One traveller's whole journey through the product, from places to a plan.
 *
 * Board, auto-pick and plan are returned together because every §29 property is
 * a statement about the *relationship* between them — what the board offered,
 * what auto-pick took, and what survived into a day.
 */
function journeyThrough(
  region: CompiledRegion,
  profile: TravelerProfile,
  dates: readonly string[] = DATES,
): Journey {
  const board = boardFor(region, profile, dates);
  const tripDays = countTripDays(dates[0]!, dates[dates.length - 1]!);
  const auto = autoSelect({ candidates: board.candidates, profile, tripDays });
  const selections: DiscoverySelection[] = auto.selectedIds.map((placeId) => ({
    placeId,
    status: 'included' as const,
    source: 'auto' as const,
    updatedAt: '2026-08-10T00:00:00.000Z',
  }));
  const plan = planTrip({
    tripId: `matrix-${region.region.id}`,
    basics: basicsFor(region, dates),
    profile,
    region: region.region,
    candidates: board.candidates,
    selections,
    matrix: region.travelTimes,
    ...(region.transitEvidence ? { transit: region.transitEvidence } : {}),
    access: region.access,
    hours: region.operatingHours,
    weather: unfetchedWeather(region, dates),
    ...(region.food ? { food: region.food } : {}),
    baseId: primaryBaseOf(region).routingId,
    ...(region.basePortfolio ? { basePortfolio: region.basePortfolio } : {}),
    now: NOW,
    generatedAt: '2026-08-10T09:00:00.000Z',
  });
  return { board, auto, plan };
}

/** The itinerary, or a failure that names itself rather than a silent skip. */
function itineraryOf(journey: Journey) {
  if (!journey.plan.ok) {
    throw new Error(
      `The plan failed: ${journey.plan.code} — ${journey.plan.message}. ` +
        'A §29 scenario asserts about a trip; a trip that does not exist is the finding.',
    );
  }
  return journey.plan.itinerary;
}

function travelLegs(days: readonly ItineraryDay[]) {
  return days.flatMap((day) =>
    day.items.filter((item) => item.kind === 'travel' && item.travel).map((item) => item.travel!),
  );
}

function scheduledPlaceIds(days: readonly ItineraryDay[]): string[] {
  return days.flatMap((day) =>
    day.items.filter((item) => item.kind === 'activity' && item.placeId).map((item) => item.placeId!),
  );
}

// ---------------------------------------------------------------------------
// The seven shapes actually reach a plan
// ---------------------------------------------------------------------------

/**
 * Before any property: each of §29's seven classes produces a trip at all.
 *
 * A separate, deliberately blunt scenario because the alternative is seven rich
 * assertions that all fail with the same message when compilation breaks, and
 * because "this shape does not plan" is the single most important thing this
 * file can report.
 */
describe('§29 — every trip shape reaches a plan', () => {
  const shapes: {
    label: string;
    world: keyof typeof SYNTHETIC_WORLDS;
    options?: CompileOptions;
    answers: Partial<QuestionnaireAnswers>;
  }[] = [
    {
      label: 'A — dense transit metropolis, car-free',
      world: 'transit_metro',
      options: { composerTransport: 'public_transport', transitMeasurable: true },
      answers: { willDrive: false, ...interests({ history_and_culture: 'core' }) },
    },
    {
      label: 'B — dense familiar city, walking and transit',
      world: 'transit_mixed',
      options: { composerTransport: 'public_transport', transitMeasurable: true },
      answers: { willDrive: false, ...interests({ food_and_towns: 'core' }) },
    },
    {
      label: 'C — road and outdoor region',
      world: 'remote_road',
      options: { composerTransport: 'drive' },
      answers: { willDrive: true, ...interests({ hiking: 'core' }) },
    },
    {
      label: 'D — island with separate components',
      world: 'ferry_island',
      options: { composerTransport: 'drive' },
      answers: { willDrive: true, ...interests({ scenic_viewpoints: 'core' }) },
    },
    {
      label: 'E — broad region needing more than one base',
      world: 'broad_country',
      options: { composerTransport: 'drive' },
      answers: { willDrive: true, ...interests({ history_and_culture: 'core' }) },
    },
    {
      label: 'F — a destination almost nobody has catalogued',
      world: 'weak_data',
      /*
       * Spelled out rather than referring to `WEAK_DATA`, for the same reason
       * the row above spells out `composerTransport` rather than referring to
       * `ROAD`: this table is built while the file is still being read, and both
       * constants live beside the sections that own them. It must stay the same
       * destination as the one §29 F asserts about — see `WEAK_DATA` for why
       * nobody publishing a page is what "almost nobody has catalogued" means.
       */
      options: { composerTransport: 'drive', research: { officialSourceCoverage: 0 } },
      answers: { willDrive: true, ...interests({ easy_nature_walks: 'core' }) },
    },
    {
      label: 'G — adversarial preferences',
      world: 'transit_metro',
      options: { composerTransport: 'public_transport', transitMeasurable: true },
      answers: {
        willDrive: false,
        dayStart: 'relaxed',
        crowdTolerance: 'avoid_crowds',
        avoidTouristTraps: true,
        avoidances: ['crowds_and_tourist_traps', 'early_mornings'],
        ...interests({ architecture_and_landmarks: 'core', food_and_towns: 'frequent' }),
      },
    },
  ];

  for (const shape of shapes) {
    it(`${shape.label} produces days with something on them`, async () => {
      const region = await compileWorld(shape.world, shape.options);
      const journey = journeyThrough(region, travellerFrom(shape.answers));
      const itinerary = itineraryOf(journey);
      expect(itinerary.days.length).toBeGreaterThan(0);
      /*
       * Days with nothing on them are the failure this catches, and it is not
       * hypothetical: a live compilation once returned five empty days as a
       * finished itinerary because every stop was further out than the
       * traveller's own limit and nothing said so.
       */
      expect(scheduledPlaceIds(itinerary.days).length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// A — Dense transit metropolis, car-free traveller
// ---------------------------------------------------------------------------

/** The metropolis, and a traveller with no car who came for one thing. */
const METRO: CompileOptions = { composerTransport: 'public_transport', transitMeasurable: true };

function metroTraveller(extra: Partial<QuestionnaireAnswers> = {}): TravelerProfile {
  return travellerFrom({
    willDrive: false,
    ...interests({ history_and_culture: 'core' }),
    ...extra,
  });
}

describe('§29 A — a dense transit metropolis, car-free', () => {
  it('offers no interest its own places cannot match', async () => {
    const region = await compileWorld('transit_metro', METRO);
    /**
     * THE PROMISE THE QUESTIONNAIRE MAKES, AND WHETHER THE BOARD CAN KEEP IT.
     *
     * `interestOfferFromRegion` decides which rows a traveller is asked to
     * grade, and `offer.ts` states the rule in its own words: "a region that
     * cannot serve an interest does not offer it as a graded row… a `core`
     * answer on it steers acquisition towards material that is not there".
     *
     * The scorer answers a *different* question from a *different* table.
     * `scorePlace` reads `place.interests`, which the taxonomy stamps; the offer
     * reads `INTEREST_EVIDENCE`, which maps categories and keywords. When the
     * two disagree, a traveller grades an interest `core`, every place that
     * should satisfy it is scored as though they had said `low`, and the
     * frequency allowance for the thing they care most about is never spent.
     *
     * So the invariant is stated on the pair rather than on either side: an
     * interest that reaches the intake screen has to be one at least one place
     * carries, or the row is a question whose answer changes nothing.
     */
    const offer = interestOfferFromRegion({
      places: region.places,
      foodVenueCount: region.food?.venues.length ?? 0,
    });
    expect(offer.basis).toBe('region_evidence');
    const carried = new Set(region.places.flatMap((place) => place.interests));
    /*
     * Food is the one documented exception, and `interestOfferFromRegion` says
     * why: a region's restaurants live in a separate dataset from its places, so
     * `food_and_towns` is legitimately offered on evidence no `Place` carries.
     */
    const unserveable = offer.interests.filter(
      (interest) => interest !== 'food_and_towns' && !carried.has(interest),
    );
    expect(
      unserveable,
      `the intake would ask this traveller to grade ${unserveable.join(', ')}, and no place in ` +
        'the region carries any of them — a core answer on one of these rows matches nothing',
    ).toEqual([]);
  });

  it('does not let a raw map feature outrank an established kind on tagging alone', () => {
    /**
     * THE §8.3 INVERSION, AND WHY IT NEEDS ITS OWN APPARATUS.
     *
     * §29 A's "no low-value OSM domination" is the live failure where a metro
     * board filled with named slopes and pocket parks while its museums and
     * temples lost their seats — because the ordering counted *recorded
     * attributes*, and geographic layers tag micro-features richly while place
     * catalogues tag monuments sparsely.
     *
     * The synthetic pack cannot express it: every record it emits is a decent
     * kind (a museum, a lake, a historic site) carrying similar evidence, so no
     * compiled region in this file holds the pair the failure is made of. So
     * this one scenario builds the pair out of raw source records and runs the
     * real inventory over them — the same path a pack build takes, from the
     * same entry point, with nothing hand-placed downstream.
     *
     * The pair is deliberately **both unevidenced**. That is what isolates the
     * claim: with no knowledge base, no second catalogue and no authority on
     * either side, the only thing left to separate them is *what kind of thing
     * they are*, which is precisely the factor §8.3 says must survive. A model
     * that dropped the kind would score them identically and this line would
     * read 0.3 against 0.3.
     */
    const scope = geographicScopeSchema.parse({
      schemaVersion: 1,
      revision: 1,
      destinationCandidateId: 'relation/matrix',
      destinationName: 'Matrixville',
      destinationEntityType: 'city',
      breadth: 'city',
      center: { lat: 40.7, lng: -74 },
      bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
      timeZones: ['UTC'],
      shape: {
        kind: 'bounds',
        bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
      },
      includedAreas: [],
      excludedAreas: [],
      gateways: [],
      transport: {
        primaryMode: 'walk',
        allowedModes: ['walk'],
        carAvailable: false,
        acceptsWaterOrAirTransfers: false,
        basis: 'default',
        note: 'A matrix scope.',
      },
      maxBaseChanges: 0,
      nights: 4,
      rationale: 'A §29 scope.',
      confidence: { level: 'high', signals: [], note: 'Test.' },
      decidedBy: [],
      confirmedByUser: true,
    });

    const base = {
      alternateNames: [] as string[],
      websiteCandidates: [] as string[],
      containment: { countryCode: 'AA', localityName: 'Matrixville', divisionIds: [] },
      cellId: 'g-0-0',
    };
    /* Nothing establishes this museum. It is a museum, and that is all it has. */
    const bareMuseum: SourceRecord = {
      ...base,
      id: 'places:bare-museum',
      layerId: 'places',
      sourceId: 'bare-museum',
      name: 'City Museum',
      coordinates: { lat: 40.705, lng: -74.005 },
      sourceCategory: 'museum',
      sourceCategoryPath: ['arts_and_entertainment', 'museum'],
      planningRole: 'attraction',
      attributes: {},
      sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    };
    /* Nothing establishes this rise either — but a mapper filled it in. */
    const richlyTaggedSlope: SourceRecord = {
      ...base,
      id: 'land:tagged-slope',
      layerId: 'land',
      sourceId: 'tagged-slope',
      name: 'North Rise',
      coordinates: { lat: 40.71, lng: -74.01 },
      sourceCategory: 'hill',
      sourceCategoryPath: [],
      planningRole: 'outdoor',
      attributes: { surface: 'paved', lit: 'yes', incline: 'up', ele: '140', width: '3' },
      sources: [{ dataset: 'land', licenceId: 'ODbL-1.0' }],
    };

    const records = [bareMuseum, richlyTaggedSlope];
    const inventory = buildInventory({
      pack: assemblePack({
        id: 'matrix-pack',
        scope,
        releases: [{ catalog: 'matrix', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
        partition: partitionScope(scope),
        layers: [
          {
            id: 'places',
            kind: 'primary_places',
            catalog: 'matrix',
            datasetPath: 'places/place',
            licenceId: 'CDLA-Permissive-2.0',
            records: [bareMuseum],
            featuresRead: records.length,
            featuresRetained: 1,
            failedCellIds: [],
          },
          {
            id: 'land',
            kind: 'supplemental_geography',
            catalog: 'matrix',
            datasetPath: 'base/land',
            licenceId: 'ODbL-1.0',
            records: [richlyTaggedSlope],
            featuresRead: records.length,
            featuresRetained: 1,
            failedCellIds: [],
          },
        ],
        diagnostics: {
          filesInspected: 1,
          rowGroupsInspected: 1,
          rowGroupsRead: 1,
          bytesTransferred: 1,
          durationMs: 1,
          budgetsExhausted: [],
          layerTimings: [],
        },
        now: NOW,
      }),
      scope,
    });

    const museum = inventory.candidates.find((c) => c.place.name === 'City Museum');
    const slope = inventory.candidates.find((c) => c.place.name === 'North Rise');
    expect(museum, 'the museum did not survive the inventory at all').toBeDefined();
    expect(slope, 'the slope did not survive, so there is nothing to outrank').toBeDefined();

    /* Neither side is established, which is what makes the kind the only variable. */
    for (const candidate of [museum!, slope!]) {
      expect(candidate.place.globalProminence).toBeUndefined();
      expect(candidate.place.localSignificance).toBeUndefined();
    }
    /* And the slope is the better-described record, which is the trap. */
    expect(slope!.place.evidenceRichness ?? 0).toBeGreaterThan(
      museum!.place.evidenceRichness ?? 0,
    );

    expect(
      museum!.place.experienceSignificance,
      'a museum nobody has written about scores no higher than a well-tagged slope, so ' +
        'metadata volume is deciding the board again',
    ).toBeGreaterThan(slope!.place.experienceSignificance ?? 1);
  });

  it('keeps map noise and dead records off the board entirely', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, metroTraveller());
    /*
     * The pack carries, on purpose, four records a live evaluation actually
     * produced — a cash machine filed under a pedestrian container, an
     * insurance office, a nightclub, a neighbourhood congregation — and one
     * museum that closed. §29's "no low-value OSM domination" is the claim that
     * none of them reaches a traveller, and it is checked at both ends: the
     * compiled place list and the finished board.
     */
    for (const place of region.places) {
      expect(place.id, 'a refused record reached the compiled region').not.toMatch(
        /-(noise-\d+|closed)$/,
      );
    }
    for (const candidate of journey.board.candidates) {
      expect(candidate.place.id, 'a refused record reached the board').not.toMatch(
        /-(noise-\d+|closed)$/,
      );
      /*
       * And every card holds a role a traveller can act on. An airport, a
       * driver-for-hire and two tour operators once shared a board with the
       * museums; a card whose role is unknown is the shape that let them.
       */
      const role = planningRoleOfPlace(candidate.place);
      expect(role, `${candidate.place.name} has no planning role`).toBeDefined();
      expect(isVisitableRole(role!), `${candidate.place.name} is not somewhere you go`).toBe(true);
    }
    expect(journey.board.integrity.everyCardHasEligibleRole).toBe(true);
  });

  it('discovers both what is established and what fits this traveller', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, metroTraveller());

    /*
     * The famous half: something here has standing that was *established*
     * rather than assumed — a knowledge base, a second catalogue, an authority.
     */
    const established = journey.board.candidates.filter(
      (candidate) =>
        candidate.place.globalProminence !== undefined ||
        candidate.place.localSignificance !== undefined,
    );
    expect(established.length).toBeGreaterThan(0);

    /*
     * The personalised half, and it is a claim about the *sentence* rather than
     * about the score. A board that ranks by fit and then explains itself in
     * generic prose has personalised nothing a traveller can see, which is the
     * §9.2 failure. The leading card has to name the thing they said they came
     * for.
     */
    const leader = journey.board.candidates[0]!;
    expect(leader.fit.reasons.length).toBeGreaterThan(0);
    expect(
      leader.fit.reasons.some((reason) => /history/i.test(reason)),
      `the top card explains itself as ${JSON.stringify(leader.fit.reasons)}, which says ` +
        'nothing about what this traveller asked for',
    ).toBe(true);

    /*
     * And the two halves are not the same set. A board where "established" and
     * "fits you" pick out identical candidates has one variable wearing two
     * names, which is the exact defect `quality/significance.ts` was written to
     * undo.
     */
    const personalised = new Set(
      journey.board.candidates
        .filter((candidate) => candidate.fit.primaryInterest === 'history_and_culture')
        .map((candidate) => candidate.place.id),
    );
    const establishedIds = new Set(established.map((candidate) => candidate.place.id));
    expect(personalised.size).toBeGreaterThan(0);
    expect(
      [...personalised].some((id) => !establishedIds.has(id)) ||
        [...establishedIds].some((id) => !personalised.has(id)),
    ).toBe(true);
  });

  it('gets around on public transport and never quietly drives', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, metroTraveller());
    const itinerary = itineraryOf(journey);

    expect(itinerary.transportStrategy.primaryMode).not.toBe('drive');
    const legs = travelLegs(itinerary.days);
    expect(legs.length).toBeGreaterThan(0);

    const journeys = new Map(
      (region.transitEvidence?.journeys ?? []).map((entry) => [
        `${entry.fromId} ${entry.toId}`,
        entry,
      ]),
    );
    let measuredRides = 0;
    for (const leg of legs) {
      /* The one thing a car-free trip may never contain. */
      expect(leg.mode, `a car-free trip scheduled a drive to ${leg.toName}`).not.toBe('drive');
      if (leg.minutes === null || leg.role === 'wait') continue;
      if (leg.mode === 'rail' || leg.mode === 'public_bus' || leg.mode === 'ferry') {
        measuredRides += 1;
        /*
         * A ride quotes the journey somebody measured for *that ordered pair*.
         * A substitution — a road duration relabelled, another pair's number
         * reused — matches no journey here and fails on this line.
         */
        const measured = journeys.get(`${leg.fromId} ${leg.toId}`);
        expect(measured, `a ${leg.mode} leg to ${leg.toName} quotes nothing anybody measured`)
          .toBeDefined();
        expect(leg.minutes).toBe(measured!.minutes);
        expect(leg.km, 'a ride puts no kilometres on a car').toBeNull();
      }
    }
    expect(measuredRides, 'nothing rode anything, so no transit was proved').toBeGreaterThan(0);
  });

  it('reaches past the nearest few stops rather than circling the base', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, metroTraveller());
    const itinerary = itineraryOf(journey);

    const byId = new Map(journey.board.candidates.map((candidate) => [candidate.place.id, candidate]));
    const scheduled = scheduledPlaceIds(itinerary.days);
    expect(scheduled.length).toBeGreaterThan(1);

    /**
     * NEIGHBOURHOOD SPREAD, AS AN ANTI-DEGENERACY CLAIM.
     *
     * Stated against the alternative rather than as a distance threshold,
     * because a threshold is a fact about the fixture's geometry and this has to
     * be a fact about the planner. The degenerate trip — the one a scorer that
     * only reads travel cost produces — is the *k* nearest stops to the base,
     * every day, for the whole trip. So the claim is that the scheduled set is
     * not that set.
     */
    const nearestFirst = journey.board.candidates
      .filter((candidate) => candidate.travelMinutesFromBase !== null)
      .sort((a, b) => a.travelMinutesFromBase! - b.travelMinutesFromBase!)
      .slice(0, scheduled.length)
      .map((candidate) => candidate.place.id);
    expect(
      scheduled.some((id) => !nearestFirst.includes(id)),
      'the trip is exactly the closest stops to the base, in order — which is a travel-cost ' +
        'ranking, not a plan',
    ).toBe(true);

    /* And every scheduled stop resolved a journey rather than being guessed at. */
    for (const id of scheduled) {
      expect(byId.get(id)?.travelMinutesFromBase, `${id} was scheduled with no measured journey`)
        .not.toBeNull();
    }
  });

  it('spreads the picks across kinds instead of nine of one thing', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, metroTraveller());
    const counts = journey.auto.stats.byCategory;
    const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
    expect(total).toBeGreaterThan(2);
    /**
     * The traveller graded exactly one interest, which is what makes this
     * falsifiable. A picker that ordered by fit and stopped would return the
     * members of that one interest's categories until it ran out; the variety
     * constraint is the only thing that widens it, so removing the constraint
     * shows up here as a single category holding the board.
     */
    const largest = Math.max(...Object.values(counts).map((count) => count ?? 0));
    expect(largest / total).toBeLessThanOrEqual(0.5);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(3);
  });

  it('writes a name and a description a traveller can use', async () => {
    const region = await compileWorld('transit_metro', METRO);
    expect(region.places.length).toBeGreaterThan(0);
    for (const place of region.places) {
      /* Never an identifier, never a coordinate, never an empty string. */
      expect(place.name.trim().length).toBeGreaterThan(2);
      expect(place.name, `${place.id} is showing its own id`).not.toContain(place.id);
      expect(place.name).not.toMatch(/^-?\d+(\.\d+)?[,\s]/);
      /* A description says what it is *and where*, which is the minimum useful form. */
      expect(place.shortDescription).toMatch(/\.$/);
      expect(
        place.shortDescription,
        `${place.name} is described without saying where it is`,
      ).toContain(' in ');
    }
    /**
     * AND THE DESCRIPTION GROWS WITH THE EVIDENCE.
     *
     * §8.7 bans the category-only description — "A lake." — and the ban is only
     * meaningful if something distinguishes a record we know things about from
     * one we do not. `inventory.ts#describe` appends a sentence per established
     * fact: a conferred designation, an operator, an elevation, a local name, a
     * recorded charge. A build that stopped at the first sentence would produce
     * a board where every card says the same thing in a different noun, and
     * every assertion above would still pass.
     */
    const withFacts = region.places.filter(
      (place) => place.shortDescription.split('. ').length > 1,
    );
    expect(
      withFacts.length,
      'every description in this region stops at its category and locality, so nothing a source ' +
        'recorded about any of these places reached the card',
    ).toBeGreaterThan(0);
  });

  it('never leaves a meal as a silent gap in the day', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, metroTraveller({ ...interests({ history_and_culture: 'core', food_and_towns: 'frequent' }) }));
    const itinerary = itineraryOf(journey);
    const venues = new Set((region.food?.venues ?? []).map((venue) => venue.id));

    for (const day of itinerary.days) {
      const meals = day.items.filter((item) => item.kind === 'meal');
      expect(meals.length, `day ${day.dayNumber} has no eating in it at all`).toBeGreaterThan(0);
      for (const meal of meals) {
        /*
         * Either a venue somebody compiled, or a plain statement of why there is
         * none. What is forbidden is the third thing — a block of time with a
         * meal's name on it and no account of itself — which is what every meal
         * on a version-5 plan was.
         */
        expect(meal.food, `${meal.title} on day ${day.dayNumber} is a bare gap`).toBeDefined();
        expect(meal.reason.trim().length).toBeGreaterThan(10);
        if (meal.food?.venueId !== undefined) {
          expect(
            venues.has(meal.food.venueId),
            `${meal.title} names a venue that is not in this region's food data`,
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B — Dense familiar city: walking and transit, famous by preference
// ---------------------------------------------------------------------------

/** The city where the two networks disagree: a short hop walks, a long one rides. */
const CITY: CompileOptions = { composerTransport: 'public_transport', transitMeasurable: true };

describe('§29 B — a dense familiar city', () => {
  it('walks what is walkable and rides what is not, each on its own network', async () => {
    const region = await compileWorld('transit_mixed', CITY);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: false, ...interests({ food_and_towns: 'core' }) }),
    );
    const itinerary = itineraryOf(journey);
    const legs = travelLegs(itinerary.days).filter(
      (leg) => leg.minutes !== null && leg.role !== 'wait',
    );

    const walks = legs.filter((leg) => leg.mode === 'walk');
    const rides = legs.filter((leg) => leg.mode === 'rail' || leg.mode === 'public_bus');
    expect(walks.length, 'nothing was walked in a dense city').toBeGreaterThan(0);
    expect(rides.length, 'nothing was ridden in a dense city').toBeGreaterThan(0);

    /*
     * Each answered from the network that measured it. The walk has to be that
     * pair's pedestrian cell; a walk carrying the matrix's road duration is the
     * substitution the whole transport-truth layer exists to prevent.
     */
    for (const walk of walks) {
      const from = region.travelTimes.ids.indexOf(walk.fromId);
      const to = region.travelTimes.ids.indexOf(walk.toId);
      if (from < 0 || to < 0) continue;
      expect(
        walk.minutes,
        `a walk from ${walk.fromName} to ${walk.toName} is not that pair's walk`,
      ).toBe(Math.round(region.travelTimes.minutes[from]![to]!));
    }
  });

  it('deprioritises the most established place when the traveller asks it to', async () => {
    const region = await compileWorld('transit_mixed', CITY);
    /**
     * ONE REGION, ONE SET OF DATES, TWO PEOPLE.
     *
     * §29 B asks for proof that "famous sights can be deprioritised by
     * preference", and a single board cannot show that: whatever order it comes
     * out in is consistent with the ranking being fixed. So the same compiled
     * region is scored twice, and the only thing that differs is what the
     * traveller said — the classics appetite, the crowd tolerance, the
     * tourist-trap position.
     *
     * If the ranking ignored preference the two boards would be identical and
     * both assertions below would fail together, which is the point.
     */
    const shared = interests({ history_and_culture: 'core' });
    const classicsFirst = travellerFrom({
      willDrive: false,
      discoveryMix: 'mostly_classics',
      crowdTolerance: 'dont_mind',
      avoidTouristTraps: false,
      ...shared,
    });
    const offTheBeatenTrack = travellerFrom({
      willDrive: false,
      discoveryMix: 'mostly_hidden',
      crowdTolerance: 'avoid_crowds',
      avoidTouristTraps: true,
      avoidances: ['crowds_and_tourist_traps'],
      ...shared,
    });

    const forClassics = boardFor(region, classicsFirst);
    const forHidden = boardFor(region, offTheBeatenTrack);

    /*
     * Selected on `globalProminence` — what the wider world actually published
     * — rather than on `popularityScore`. The legacy read is lossy in a way that
     * matters exactly here: since the withheld-prominence repair it answers with
     * what the *region's own* authorities, designations and ground established
     * whenever the world's notice was never observed, so sorting on it picked a
     * locally-established, globally-unnoticed reserve and called it "the most
     * established place". That record is a hidden gem by the model's own
     * reckoning, so the hidden-seeking traveller rates it *higher* — a true
     * outcome under a false premise, which is a fixture defect rather than a
     * ranking one. The contrast this test is about is fame, and fame is the
     * field named for it.
     */
    const noted = region.places.filter((place) => place.globalProminence !== undefined);
    expect(
      noted.length,
      'nothing in this region carries observed prominence, so the contrast has no subject',
    ).toBeGreaterThan(0);
    const mostEstablished = [...noted].sort(
      (a, b) => b.globalProminence! - a.globalProminence! || a.id.localeCompare(b.id),
    )[0]!;
    expect(
      mostEstablished.popularityScore,
      'nothing in this region is established enough for the contrast to mean anything',
    ).toBeGreaterThan(0.2);

    const scoreIn = (board: DiscoveryBoard) =>
      board.candidates.find((candidate) => candidate.place.id === mostEstablished.id)!.fit.score;
    const rankIn = (board: DiscoveryBoard) =>
      board.candidates.findIndex((candidate) => candidate.place.id === mostEstablished.id);

    expect(
      scoreIn(forHidden),
      `${mostEstablished.name} scores the same for somebody who wants the famous things and ` +
        'somebody who wants to avoid them',
    ).toBeLessThan(scoreIn(forClassics));
    expect(rankIn(forHidden)).toBeGreaterThan(rankIn(forClassics));
  });

  it('orders a day better than the orders it could have chosen instead', async () => {
    const region = await compileWorld('transit_mixed', CITY);
    /*
     * A fast-paced, high-intensity traveller, deliberately. The balanced
     * profile's qualifying day used to hold its third stop on a 69-minute
     * mid-day walk — three times the traveller's own stated walking answer,
     * which the planner now enforces per leg — so the honest balanced plan is
     * out-and-back pairs with nothing to order. The ordering property needs a
     * day that *legally* holds three stops, and a traveller who packs their
     * days gets one: every walk on it sits inside the stated answer, the long
     * hops ride the metro, and the guard below still fails the test if no
     * such day materialises.
     */
    const journey = journeyThrough(
      region,
      travellerFrom({
        willDrive: false,
        pace: 'fast',
        dailyIntensity: 'intense',
        ...interests({ food_and_towns: 'core' }),
      }),
    );
    const itinerary = itineraryOf(journey);

    /**
     * ROUTE EFFICIENCY, AGAINST THE ALTERNATIVES RATHER THAN AGAINST A NUMBER.
     *
     * A threshold on daily travel minutes is a fact about the fixture's
     * geometry. What is a fact about the *planner* is that the order it chose
     * costs less than the orders it did not: the scheduled sequence is compared
     * with the mean over every permutation of the same stops, on the same
     * matrix, from the same base. A planner that ordered stops arbitrarily
     * lands on the mean; one that optimises beats it.
     *
     * Days with fewer than three stops are skipped — there is nothing to order
     * — and the test fails if no day qualifies, because a vacuous pass here
     * would certify route optimisation nobody exercised.
     */
    const index = new Map(region.travelTimes.ids.map((id, position) => [id, position]));
    const minutesBetween = (from: string, to: string): number | null => {
      const a = index.get(from);
      const b = index.get(to);
      if (a === undefined || b === undefined) return null;
      return region.travelTimes.minutes[a]?.[b] ?? null;
    };
    const costOf = (baseId: string, order: readonly string[]): number | null => {
      let total = 0;
      let previous = baseId;
      for (const stop of order) {
        const leg = minutesBetween(previous, stop);
        if (leg === null) return null;
        total += leg;
        previous = stop;
      }
      return total;
    };

    const permutations = (values: readonly string[]): string[][] =>
      values.length <= 1
        ? [[...values]]
        : values.flatMap((value, position) =>
            permutations([...values.slice(0, position), ...values.slice(position + 1)]).map(
              (rest) => [value, ...rest],
            ),
          );

    const baseId = primaryBaseOf(region).routingId;
    let daysChecked = 0;
    for (const day of itinerary.days) {
      const stops = day.items
        .filter((item) => item.kind === 'activity' && item.placeId)
        .map((item) => item.placeId!);
      if (stops.length < 3) continue;
      const chosen = costOf(baseId, stops);
      if (chosen === null) continue;
      const alternatives = permutations(stops)
        .map((order) => costOf(baseId, order))
        .filter((cost): cost is number => cost !== null);
      const mean = alternatives.reduce((sum, cost) => sum + cost, 0) / alternatives.length;
      daysChecked += 1;
      expect(
        chosen,
        `day ${day.dayNumber} was ordered at ${chosen} min against a ${mean.toFixed(1)} min ` +
          'average over every other order of the same stops',
      ).toBeLessThanOrEqual(mean);
    }
    expect(daysChecked, 'no day held enough stops to have an order at all').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C — Road and outdoor region
// ---------------------------------------------------------------------------

const ROAD: CompileOptions = { composerTransport: 'drive' };

describe('§29 C — a road and outdoor region', () => {
  it('keeps a base and reaches satellites from it, on the road', async () => {
    const region = await compileWorld('remote_road', ROAD);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);

    expect(region.bases.length).toBeGreaterThan(0);
    const satellites = region.places.filter((place) => place.relationship === 'satellite');
    expect(satellites.length).toBeGreaterThan(0);
    const scheduled = new Set(scheduledPlaceIds(itinerary.days));
    expect(
      satellites.some((place) => scheduled.has(place.id)),
      'the plan never left the base, so the satellites were decoration',
    ).toBe(true);

    expect(itinerary.transportStrategy.primaryMode).toBe('drive');
    const legs = travelLegs(itinerary.days).filter(
      (leg) => leg.minutes !== null && leg.role !== 'wait',
    );
    expect(legs.length).toBeGreaterThan(0);
    const drives = legs.filter((leg) => leg.mode === 'drive');
    expect(drives.length).toBeGreaterThan(0);
    for (const drive of drives) {
      /* A drive puts kilometres on a vehicle; a leg with none is not a drive. */
      expect(drive.km, `a drive to ${drive.toName} covered no distance`).not.toBeNull();
    }
  });

  it('schedules the hike for somebody who wants one, and not for somebody who does not', async () => {
    const region = await compileWorld('remote_road', ROAD);
    /**
     * The interest contrast, on one region. A hike appearing in a plan proves
     * nothing on its own — the region is full of them — so the claim is the
     * difference: grade hiking `core` and one is scheduled; grade it `avoid`
     * and none is, while the rest of the trip survives.
     */
    const walker = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const nonWalker = journeyThrough(
      region,
      travellerFrom({
        willDrive: true,
        ...interests({ hiking: 'avoid', scenic_viewpoints: 'occasional' }),
        avoidances: ['long_hikes'],
      }),
    );

    const hikesIn = (journey: Journey) => {
      const itinerary = itineraryOf(journey);
      const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c.place]));
      return scheduledPlaceIds(itinerary.days).filter(
        (id) => byId.get(id)?.category === 'day_hike',
      );
    };

    expect(hikesIn(walker).length, 'a traveller who came to hike was given no hike').toBeGreaterThan(0);
    expect(
      hikesIn(nonWalker),
      'a traveller who said no hiking was sent hiking anyway',
    ).toEqual([]);
    /* And the rest of their trip is still a trip. */
    expect(scheduledPlaceIds(itineraryOf(nonWalker).days).length).toBeGreaterThan(0);
  });

  it('never schedules a stop the date, the season or the access rules forbid', async () => {
    const region = await compileWorld('remote_road', ROAD);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);
    const byId = new Map(journey.board.candidates.map((candidate) => [candidate.place.id, candidate]));

    let checked = 0;
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'activity' || !item.placeId) continue;
        const candidate = byId.get(item.placeId);
        if (!candidate) continue;
        checked += 1;
        /*
         * Both gates, because they answer different questions and a plan has to
         * pass both: whether the traveller can legally get in, and whether the
         * time of year lets them.
         */
        expect(
          candidate.fit.blockers.map((blocker) => blocker.code),
          `${candidate.place.name} was scheduled with a blocker on it`,
        ).toEqual([]);
        expect(
          candidate.season.status,
          `${candidate.place.name} is shut in the month this trip happens`,
        ).not.toBe('closed');
        expect(
          candidate.season.openTripMonths.length,
          `${candidate.place.name} is open in none of this trip's months`,
        ).toBeGreaterThan(0);
      }
    }
    expect(checked, 'nothing was scheduled, so nothing was checked').toBeGreaterThan(0);
  });

  it('keeps a day inside its own hours and never assumes weather it does not have', async () => {
    const region = await compileWorld('remote_road', ROAD);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);

    /*
     * Every scheduled minute sits inside the window the day was built with. A
     * plan that overruns its own window has scheduled an outdoor stop into the
     * dark and told the traveller nothing, which is the shape §29 C's
     * weather/daylight bullet is about.
     */
    let items = 0;
    for (const day of itinerary.days) {
      for (const item of day.items) {
        items += 1;
        expect(
          item.startMinute,
          `${item.title} starts before day ${day.dayNumber} does`,
        ).toBeGreaterThanOrEqual(day.window.startMinute);
        expect(
          item.endMinute,
          `${item.title} runs past the end of day ${day.dayNumber}`,
        ).toBeLessThanOrEqual(day.window.endMinute);
        /*
         * And a window a place carries in its own right is obeyed rather than
         * printed. Absent means daylight did not bear on the visit, which is a
         * legitimate answer for an indoor stop and not one to invent.
         */
        if (item.daylight) {
          expect(item.startMinute).toBeGreaterThanOrEqual(item.daylight.sunriseMinute);
          expect(item.endMinute).toBeLessThanOrEqual(item.daylight.sunsetMinute);
        }
      }
    }
    expect(items).toBeGreaterThan(0);

    /**
     * THE FORECAST WE DID NOT GET IS SAID OUT LOUD.
     *
     * This trip is planned against a dataset in which every day is
     * `unavailable` — which is the product's real state before anybody fetches
     * a forecast. The failure to guard against is the plan proceeding as though
     * the weather were fine: a day placed against no forecast has to arrive
     * with an issue saying so, or "we checked" and "we could not check" render
     * identically.
     */
    const declared = itinerary.issues.filter((issue) => issue.code === 'weather_unavailable');
    expect(
      declared.length,
      'the trip was planned against no forecast at all and never said so',
    ).toBeGreaterThan(0);
  });

  it('tells a detour worth taking from one that is not, and stays inside the trip', async () => {
    const region = await compileWorld('remote_road', ROAD);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);

    const labels = new Set(journey.board.candidates.map((candidate) => candidate.worthDetour));
    /*
     * A classifier that returns one label for everything has classified
     * nothing, and that is the failure mode: "worth the detour" printed on
     * every card is decoration.
     */
    expect(labels.size, 'every place carries the same detour verdict').toBeGreaterThan(1);

    const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c]));
    const scheduled = scheduledPlaceIds(itinerary.days).map((id) => byId.get(id)!);
    expect(scheduled.length).toBeGreaterThan(0);

    /* Nothing past the trip's own reach is scheduled at all. */
    for (const candidate of scheduled) {
      expect(
        candidate.detourClass,
        `${candidate.place.name} is further out than this trip reaches and was scheduled anyway`,
      ).not.toBe('too_far');
    }
    /**
     * And exactly the documented allowance is spent: auto-pick's fifth
     * constraint is "allow at most one stop beyond the stated detour
     * tolerance", and it announces the one it took. More than one would mean
     * the allowance stopped binding.
     */
    const beyondTolerance = scheduled.filter((candidate) => candidate.detourClass === 'stretch');
    expect(beyondTolerance.length).toBeLessThanOrEqual(1);
  });

  it('does not print “too far for this trip” on a stop it then schedules', async () => {
    const region = await compileWorld('remote_road', ROAD);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);
    const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c]));

    /**
     * THE BOARD AND THE PLAN HAVE TO AGREE ABOUT THE SAME PLACE.
     *
     * `worthDetourLabel` is the one label on a card that is supposed to be
     * about *distance*, and it is decided by the fit band: an identical
     * `stretch` journey reads "worth it if you like this" for a `strong` fit
     * and "too far for this trip" for a `good` one. Auto-pick, meanwhile, is
     * documented to accept exactly one stop beyond the tolerance and says so in
     * its notes — "one pick sits past your usual detour limit because it earned
     * the extra journey".
     *
     * So the two surfaces can contradict each other on the same place: the
     * itinerary explains why it included it, and its card tells the traveller
     * not to go. Neither sentence is wrong on its own, which is what makes this
     * a labelling defect rather than a planning one.
     */
    const contradicted = scheduledPlaceIds(itinerary.days)
      .map((id) => byId.get(id)!)
      .filter((candidate) => candidate.worthDetour === 'too_far_for_this_trip');
    expect(
      contradicted.map((candidate) => `${candidate.place.name} (${candidate.detourClass})`),
      'these stops are on the itinerary and their cards say they are too far to visit',
    ).toEqual([]);
  });

  it('feeds an outdoor day or says plainly that it cannot', async () => {
    const region = await compileWorld('remote_road', ROAD);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ hiking: 'core', food_and_towns: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);

    for (const day of itinerary.days) {
      const meals = day.items.filter((item) => item.kind === 'meal');
      expect(meals.length, `day ${day.dayNumber} has no eating in it`).toBeGreaterThan(0);
      expect(day.food.summary.trim().length).toBeGreaterThan(10);
    }
    /**
     * And a carried lunch is *declared*, not assumed.
     *
     * A plan that quietly schedules a packed lunch has told the traveller to
     * bring food it never mentioned they would need. The planner raises
     * `packed_food_without_preparation` for exactly that, so a day that packs
     * has to be a day the plan warned about.
     */
    const packedDays = new Set(itinerary.foodPlan.packedDayNumbers);
    if (packedDays.size > 0) {
      const warned = itinerary.issues.filter(
        (issue) => issue.code === 'packed_food_without_preparation',
      );
      expect(
        warned.length,
        `${packedDays.size} day(s) rely on food the traveller has to bring, and nothing says so`,
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// D — Island / multi-component geography
// ---------------------------------------------------------------------------

/**
 * How much ground a compiled scope covers, as one comparable value.
 *
 * A shape is a box or a circle and the two are not comparable as they stand,
 * which is how the claim below came to be made about a field that cannot carry
 * it. Both reduce to a span in kilometres, and that is the thing a traveller's
 * transport must not be able to move.
 */
function groundSpanKm(scope: CompiledRegion['scope']): number {
  const shape = scope.shape;
  if (shape.kind === 'radius') return shape.radiusKm * 2;
  /*
   * The two shapes `deriveShape` cannot produce, kept honest rather than cast
   * away: a corridor is as wide as it says, and a set of areas is the widest
   * area in it. Neither reaches §29 D today, and a silent `as` here is how a
   * helper starts returning a number about the wrong thing.
   */
  if (shape.kind === 'corridor') return shape.corridorWidthKm;
  if (shape.kind === 'areas') {
    return Math.max(0, ...shape.areas.map((area) => area.radiusKm * 2));
  }
  const latKm = (shape.bounds.northEast.lat - shape.bounds.southWest.lat) * 111;
  const lngKm =
    (shape.bounds.northEast.lng - shape.bounds.southWest.lng) *
    111 *
    Math.cos((scope.center.lat * Math.PI) / 180);
  return Math.max(latKm, lngKm);
}

describe('§29 D — an island with separate components', () => {
  it('does not let the way the traveller gets around redefine the destination', async () => {
    /**
     * THE FAILURE THIS ENCODES.
     *
     * Not driving selects the walking reach, the walking reach caps at twelve
     * kilometres, and twelve kilometres around the centroid of an archipelago
     * is one island. The destination was silently redefined to the part the
     * traveller could walk across — and nothing said so, because the
     * *artifact* was internally consistent.
     *
     * WHY THIS ASSERTS ON THE GROUND AND NOT ON THE PLACE SET.
     *
     * It asserted on the place set, and a reviewer showed the assertion was true
     * by fixture construction and could not fail. `syntheticPack` builds its
     * records from the world spec and computes the scope's bounds only to
     * discard them (`void bounds`), and it stamps every record with the same
     * `containment.divisionIds`, so every place is administratively inside the
     * destination however wide or narrow the compiled ground is. Two
     * compilations of one world therefore return the same fourteen places
     * whether the scope is a hundred and forty kilometres across or twelve — the
     * assertion held over the version of `deriveShape` that had the defect in
     * it, and over every version that could ever have it.
     *
     * The ground is the thing that actually moved, so the ground is what is
     * asserted. Both readings are kept: the *shape*, which is what the compiler
     * spends its budget on, and the *breadth*, which is what the destination is
     * called. Neither may move because somebody said they have no car.
     */
    const driving = await compileWorld('ferry_island', { composerTransport: 'drive' });
    const carFree = await compileWorld('ferry_island', { composerTransport: 'public_transport' });

    expect(carFree.scope.breadth).toBe(SYNTHETIC_WORLDS.ferry_island!.breadth);
    expect(carFree.scope.breadth).toBe(driving.scope.breadth);
    expect(
      groundSpanKm(carFree.scope),
      'a car-free traveller was compiled a smaller archipelago than a driver',
    ).toBe(groundSpanKm(driving.scope));

    /*
     * And the traveller's own reach really did differ, or the contrast above is
     * two runs of the same trip. This is the control: without it, a change that
     * ignored `composerTransport` entirely would pass the assertion.
     */
    expect(carFree.scope.transport.carAvailable).toBe(false);
    expect(driving.scope.transport.carAvailable).toBe(true);
    expect(carFree.scope.reachRadiusKm).toBeLessThan(driving.scope.reachRadiusKm!);
  });

  it('holds the same rule when the archipelago publishes its own edges', async () => {
    /**
     * The case the multi-part guard was written for, which until now no fixture
     * could reach: `syntheticCandidate` publishes no bounds, and the guard lives
     * inside the branch that needs them. So it never executed here, and the
     * behaviour it protects was covered by nothing.
     *
     * Measured against the live destination index, the boundless case above is
     * the ordinary one — 38,909 of 38,909 counties and every island, park and
     * protected area in it carry a centre and no polygon — and this is the
     * exception. Both have to hold, and they are one rule: a container is not
     * clipped to what the traveller can cross.
     */
    const edges = {
      southWest: { lat: SYNTHETIC_WORLDS.ferry_island!.center.lat - 0.6, lng: SYNTHETIC_WORLDS.ferry_island!.center.lng - 0.6 },
      northEast: { lat: SYNTHETIC_WORLDS.ferry_island!.center.lat + 0.6, lng: SYNTHETIC_WORLDS.ferry_island!.center.lng + 0.6 },
    };
    const driving = await compileWorld('ferry_island', { composerTransport: 'drive', bounds: edges });
    const carFree = await compileWorld('ferry_island', {
      composerTransport: 'public_transport',
      bounds: edges,
    });

    expect(carFree.scope.boundaryEvidence).toBe('measured_extent');
    expect(carFree.scope.shape).toEqual(driving.scope.shape);
    /* Unclipped: the published extent is the whole destination, both ways. */
    expect(carFree.scope.shape).toEqual({ kind: 'bounds', bounds: edges });
  });

  it('says where its border came from rather than presenting a circle as one', async () => {
    const region = await compileWorld('ferry_island', { composerTransport: 'public_transport' });
    /*
     * Where no polygon was published, the scope records that its outline is a
     * reach circle. An artifact that carried a circle under the name of a
     * boundary would be fake precision about the one thing a traveller cannot
     * check.
     */
    expect(region.scope.boundaryEvidence).toBe('reach_circle');
  });

  it('keeps the far components on the board instead of clipping to the nearest', async () => {
    const region = await compileWorld('ferry_island', { composerTransport: 'drive' });
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ scenic_viewpoints: 'core' }) }),
    );
    /**
     * Discoverability is separate from schedulability, and this is the half
     * that must not be quietly trimmed: a component too far to visit on this
     * trip still has to be *visible*, with an honest verdict on it, or the
     * traveller cannot tell "we looked and it is far" from "there is nothing
     * over there".
     */
    const classes = new Set(journey.board.candidates.map((candidate) => candidate.detourClass));
    expect(
      classes.size,
      'every candidate sits in the same distance band, so nothing beyond the base survived',
    ).toBeGreaterThan(1);
    const distant = journey.board.candidates.filter(
      (candidate) => candidate.detourClass === 'too_far' || candidate.detourClass === 'stretch',
    );
    expect(distant.length).toBeGreaterThan(0);
    for (const candidate of distant) {
      /* Present, and carrying a verdict rather than a blank. */
      expect(candidate.worthDetour.length).toBeGreaterThan(0);
    }
  });

  it('leaves thin evidence unknown rather than filling it in', async () => {
    const region = await compileWorld('ferry_island', { composerTransport: 'drive' });
    const unknown = region.operatingHours.calendars.filter(
      (calendar) => calendar.kind === 'unknown',
    );
    /*
     * Half this world's places publish no hours. What matters is not that the
     * gap exists but that it stays a gap: an unknown calendar may never carry a
     * confidence a consumer could read as established, and it may never be
     * presented as "open all hours".
     */
    for (const calendar of unknown) {
      expect(calendar.provenance.confidence).toBeLessThan(0.5);
      expect(calendar.kind).not.toBe('always_open');
    }
    expect(region.diagnostics.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// E — Broad regional trip, where a base has to be chosen
// ---------------------------------------------------------------------------

const LONG_DATES = [
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
  '2026-08-15',
  '2026-08-16',
  '2026-08-17',
  '2026-08-18',
  '2026-08-19',
];

describe('§29 E — a broad region over a longer trip', () => {
  it('accounts for every night it proposes, and says why', async () => {
    const region = await compileWorld('broad_country', { composerTransport: 'drive', dates: LONG_DATES });
    const portfolio = region.basePortfolio;
    expect(portfolio, 'a region with no base portfolio cannot explain where anybody sleeps')
      .toBeDefined();
    expect(portfolio!.bases.length).toBeGreaterThan(0);
    expect(portfolio!.rationale.trim().length).toBeGreaterThan(10);

    /*
     * The nights add up to the trip. A portfolio that proposes bases for five
     * of eight nights has left three unaccounted for, and nothing downstream
     * would notice: the days are built from the dates, not from this.
     */
    const nights = portfolio!.bases.reduce((sum, base) => sum + base.nights, 0);
    expect(nights).toBe(LONG_DATES.length - 1);

    for (const base of portfolio!.bases) {
      expect(base.baseName.trim().length).toBeGreaterThan(0);
      expect(base.nights).toBeGreaterThan(0);
    }
    /* And a base that was considered and dropped says why it was dropped. */
    for (const excluded of portfolio!.excluded) {
      expect(excluded.reason.trim().length).toBeGreaterThan(5);
    }
  });

  it('honours the hotel-move tolerance the trip was scoped with', async () => {
    const region = await compileWorld('broad_country', { composerTransport: 'drive', dates: LONG_DATES });
    const portfolio = region.basePortfolio!;
    /*
     * `maxBaseChanges` is how many times the traveller will pack. One base is
     * zero changes, so the ceiling on bases is one more than the ceiling on
     * changes — and a portfolio that exceeded it would be making a decision the
     * traveller already refused.
     */
    expect(portfolio.bases.length).toBeLessThanOrEqual(region.scope.maxBaseChanges + 1);
    /* A transfer day exists only where there is something to transfer between. */
    if (portfolio.bases.length <= 1) expect(portfolio.transferDays).toBe(0);
    else expect(portfolio.transferDays).toBeGreaterThan(0);
  });

  it('sleeps only where the portfolio said it would', async () => {
    const region = await compileWorld('broad_country', { composerTransport: 'drive', dates: LONG_DATES });
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ history_and_culture: 'core' }) }, LONG_DATES),
      LONG_DATES,
    );
    const itinerary = itineraryOf(journey);
    const proposed = new Set(region.basePortfolio!.bases.map((base) => base.baseId));
    for (const day of itinerary.days) {
      expect(
        proposed.has(day.baseId),
        `day ${day.dayNumber} is based somewhere the portfolio never proposed`,
      ).toBe(true);
    }
  });

  it('never shows a day with nothing on it and no explanation', async () => {
    const region = await compileWorld('broad_country', { composerTransport: 'drive', dates: LONG_DATES });
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ history_and_culture: 'core' }) }, LONG_DATES),
      LONG_DATES,
    );
    const itinerary = itineraryOf(journey);
    /**
     * The failure this guards is a real one: a live compilation returned five
     * empty days as a finished itinerary because every stop was further out
     * than the traveller's own limit, and nothing on the page said so. An empty
     * day is a legitimate outcome — it is a rest day, or a day the region could
     * not fill — and it is only a defect when it arrives silently.
     */
    for (const day of itinerary.days) {
      const stops = day.items.filter((item) => item.kind === 'activity');
      if (stops.length > 0) continue;
      expect(
        day.warnings.join(' ').trim().length,
        `day ${day.dayNumber} is blank and says nothing about why`,
      ).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// F — A destination almost nobody has catalogued
// ---------------------------------------------------------------------------

/**
 * WHAT MAKES THIS SHAPE THE WEAK ONE, AND WHY THE WORLD ALONE DID NOT.
 *
 * `weak_data` is a nine-place valley that declares `hoursCoverage: 0.05` — five
 * per cent of its places have an opening-hours record — and every §29 F property
 * below is about what the product does with the other ninety-five. But the world
 * spec only reaches the *constraints* provider, and a compiled calendar has two
 * possible authors: an operator's own page, resolved by the research funnel, and
 * the constraints research the spec governs. Sourced calendars take precedence,
 * by design and correctly. So the fake funnel's 60% default was quietly
 * publishing an official 0.9-confidence calendar for the whole surviving region,
 * and the world's declared thinness never reached the assertions at all.
 *
 * That went unnoticed while one record happened to escape the funnel. It stopped
 * escaping when the significance witness was narrowed this cycle — a government
 * URL now attests who *operates* a place rather than that it matters, so the one
 * supplemental record filed under the bare `historic_site` node with nothing but
 * a `.gov` address behind it is refused, as its live New York counterparts (11
 * public-housing developments) now are. The refusal is right. What it exposed is
 * that a single accidental survivor was carrying two release requirements.
 *
 * So the thinness is stated here instead, where it is legible: **nobody has
 * published a page about anything in this valley**. That is what a
 * barely-catalogued destination *is*, it is the same shape `enrichment.test.ts`
 * gives this world, and it costs nothing to the other six. The properties below
 * now bite on half the region rather than on one lucky record.
 */
const WEAK_DATA: CompileOptions = { ...ROAD, research: { officialSourceCoverage: 0 } };

describe('§29 F — a weak-data destination', () => {
  it('still produces something a traveller can use', async () => {
    const region = await compileWorld('weak_data', WEAK_DATA);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ easy_nature_walks: 'core', scenic_viewpoints: 'occasional' }) }),
    );
    const itinerary = itineraryOf(journey);
    /*
     * The point of §29 F is that thin evidence must degrade into a *partial
     * result*, not into a refusal. A region with four places should still open
     * a board and still lay out days.
     */
    expect(journey.board.candidates.length).toBeGreaterThan(0);
    expect(itinerary.days.length).toBeGreaterThan(0);
    expect(scheduledPlaceIds(itinerary.days).length).toBeGreaterThan(0);
  });

  it('does not manufacture the precision it does not have', async () => {
    const region = await compileWorld('weak_data', WEAK_DATA);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ easy_nature_walks: 'core' }) }),
    );

    const unknownHours = region.operatingHours.calendars.filter(
      (calendar) => calendar.kind === 'unknown',
    );
    expect(unknownHours.length, 'a barely-catalogued region published every opening time')
      .toBeGreaterThan(0);
    for (const calendar of unknownHours) {
      expect(calendar.provenance.confidence).toBeLessThan(0.5);
    }

    /**
     * And the fit label does not overclaim on the strength of a match against
     * nothing. Twenty-four cards once read "Strong fit" while every trust panel
     * under them said "0 of 6 checked"; the band cap is what stops that, and it
     * is only observable where significance is genuinely absent.
     */
    for (const candidate of journey.board.candidates) {
      if (!candidate.fit.evidenceLimited) continue;
      expect(
        ['top_pick', 'strong'],
        `${candidate.place.name} is labelled ${candidate.fit.band} with nothing establishing it`,
      ).not.toContain(candidate.fit.band);
    }
  });

  it('separates “we could not check this” from “this is fine”', async () => {
    const region = await compileWorld('weak_data', WEAK_DATA);
    const journey = journeyThrough(
      region,
      travellerFrom({ willDrive: true, ...interests({ easy_nature_walks: 'core' }) }),
    );
    /*
     * `needs_verification` is its own group rather than a badge, because the
     * decision it asks for is different from every other group's: everywhere
     * else the question is "do you want this?", here it is "would you make a
     * phone call for this?". Mixing them teaches people to ignore the flag.
     */
    const needsVerification = journey.board.groups.find(
      (group) => group.group === 'needs_verification',
    );
    expect(
      needsVerification?.candidates.length,
      'nothing in a region with almost no opening hours needed checking',
    ).toBeGreaterThan(0);
    for (const candidate of needsVerification!.candidates) {
      expect(
        `${candidate.fit.cautions.join(' ')} ${candidate.quality.reason}`.trim().length,
        `${candidate.place.name} is flagged for verification without saying what to verify`,
      ).toBeGreaterThan(10);
    }
  });

  it('tells the traveller what it could not establish, rather than dropping it silently', async () => {
    const region = await compileWorld('weak_data', WEAK_DATA);
    expect(region.diagnostics.warnings.length).toBeGreaterThan(0);
    for (const warning of region.diagnostics.warnings) {
      expect(warning.trim().length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// G — Adversarial preferences that pull against each other
// ---------------------------------------------------------------------------

/**
 * §29's own example, written out: loves famous landmarks, hates crowds, no car,
 * moderate budget, one strenuous day at most, wants food, late mornings.
 *
 * Every pair here is in tension. Famous landmarks are where the crowds are. No
 * car narrows the ground while "famous" widens it. A moderate budget and a
 * appetite for eating out compete for the same money. Late mornings shorten
 * every day that the rest of the list wants to fill.
 *
 * The requirement is not that each preference is applied — that is easy and
 * produces an empty trip. It is that the composition **resolves** them.
 */
function adversarialAnswers(overrides: Partial<QuestionnaireAnswers> = {}): Partial<QuestionnaireAnswers> {
  return {
    willDrive: false,
    dayStart: 'relaxed',
    dailyIntensity: 'moderate',
    budgetStyle: 'midrange',
    crowdTolerance: 'avoid_crowds',
    avoidTouristTraps: true,
    avoidances: ['crowds_and_tourist_traps', 'early_mornings'],
    ...interests({
      history_and_culture: 'core',
      food_and_towns: 'frequent',
      hiking: 'occasional',
    }),
    ...overrides,
  };
}

describe('§29 G — preferences that pull against each other', () => {
  it('lets the stronger answer win when two answers disagree about mornings', async () => {
    const region = await compileWorld('transit_metro', METRO);
    /**
     * TWO ANSWERS THAT CONTRADICT EACH OTHER, AND WHICH ONE THE TRIP OBEYS.
     *
     * §29 G is about composition, and this is the cleanest case of it in the
     * questionnaire: a traveller can pick "early start" on one screen and
     * "avoid early mornings" on another. A system that applied each answer
     * where it was read would produce an early trip with a note apologising for
     * it. The avoidance is the stronger statement — it is what somebody says
     * when the default is wrong for them — so it has to win.
     *
     * And the ladder still has to work when nothing contradicts it, or "the
     * avoidance won" would be indistinguishable from "the day-start answer is
     * ignored". Both halves are asserted, which is what makes either mean
     * something.
     */
    const startsFor = (
      dayStart: 'early' | 'normal' | 'relaxed',
      avoidances: QuestionnaireAnswers['avoidances'],
    ) => {
      const journey = journeyThrough(
        region,
        travellerFrom({ ...adversarialAnswers(), dayStart, avoidances }),
      );
      /* The arrival day is fixed by the arrival time, so the middle days decide. */
      return itineraryOf(journey).days.slice(1).map((day) => day.window.startMinute);
    };

    const noAvoidance: QuestionnaireAnswers['avoidances'] = ['crowds_and_tourist_traps'];
    const early = startsFor('early', noAvoidance);
    const relaxed = startsFor('relaxed', noAvoidance);
    expect(early.length).toBeGreaterThan(0);
    for (let index = 0; index < early.length; index += 1) {
      expect(
        early[index]!,
        'asking for an early start and a relaxed one produced the same morning',
      ).toBeLessThan(relaxed[index]!);
    }

    const earlyButAvoided = startsFor('early', ['crowds_and_tourist_traps', 'early_mornings']);
    for (let index = 0; index < earlyButAvoided.length; index += 1) {
      expect(
        earlyButAvoided[index]!,
        'a traveller who said "no early mornings" was still given one because another screen ' +
          'said "early start"',
      ).toBe(relaxed[index]!);
    }
  });

  it('does not delete what they love to satisfy what they hate', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, travellerFrom(adversarialAnswers()));
    const itinerary = itineraryOf(journey);
    const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c]));

    /**
     * THE COMPOSITION CLAIM, AND WHY IT IS STATED THIS WAY.
     *
     * A scorer that applies each preference mechanically has an obvious
     * behaviour here: crowd aversion multiplies down everything established,
     * "avoid tourist traps" multiplies it down again, and the traveller who
     * came for landmarks is handed a trip with no landmarks in it — every rule
     * obeyed, the trip ruined. That is the failure §29 G exists to catch.
     *
     * So the claim is that the *thing they graded highest still arrives*. Not
     * that it dominates, and not that the crowd preference was ignored — the
     * next assertion covers that — but that a trip built for somebody who
     * loves X contains X.
     */
    const scheduled = scheduledPlaceIds(itinerary.days).map((id) => byId.get(id)!);
    expect(scheduled.length).toBeGreaterThan(0);
    const forTheirCoreInterest = scheduled.filter(
      (candidate) =>
        candidate.fit.primaryInterest === 'history_and_culture' ||
        candidate.fit.matchedInterests.includes('history_and_culture'),
    );
    expect(
      forTheirCoreInterest.length,
      'a traveller who built the trip around history got a trip with no history in it — ' +
        'every preference was applied and none of them was resolved',
    ).toBeGreaterThan(0);
  });

  it('explains every stop it decided to keep', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const journey = journeyThrough(region, travellerFrom(adversarialAnswers()));
    const itinerary = itineraryOf(journey);
    /**
     * A composition that resolves competing preferences owes the traveller an
     * account of what it resolved. This is the observable half: every stop that
     * survived the tension carries the sentence explaining why it did, and so
     * does its card.
     *
     * Deliberately not a search for particular words — copy is a rendering
     * decision, and asserting a phrase would freeze the wording rather than the
     * behaviour.
     */
    const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c]));
    let checked = 0;
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'activity') continue;
        checked += 1;
        expect(item.reason.trim().length, `${item.title} is on the plan with no reason`)
          .toBeGreaterThan(5);
        const candidate = item.placeId ? byId.get(item.placeId) : undefined;
        if (!candidate) continue;
        expect(
          candidate.fit.reasons.length,
          `${candidate.place.name} is on the plan and its card explains nothing`,
        ).toBeGreaterThan(0);
      }
    }
    expect(checked, 'nothing was scheduled, so nothing was explained').toBeGreaterThan(0);
  });

  it('keeps effort inside the ceiling and the hard days rare', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const profile = travellerFrom(adversarialAnswers());
    const journey = journeyThrough(region, profile);
    const itinerary = itineraryOf(journey);
    const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c.place]));

    const order = ['none', 'easy', 'moderate', 'strenuous'];
    const ceiling = order.indexOf(profile.derived.maxPhysicalIntensity);
    for (const id of scheduledPlaceIds(itinerary.days)) {
      const intensity = byId.get(id)?.physicalIntensity;
      if (!intensity) continue;
      expect(
        order.indexOf(intensity),
        `${byId.get(id)?.name} is harder than this traveller's ceiling`,
      ).toBeLessThanOrEqual(ceiling);
    }
    /*
     * "One strenuous day maximum" as the plan can express it: at most one day
     * is graded `intense`. The grading is derived from what is actually
     * scheduled, so this binds the composition rather than the labels.
     */
    const intense = itinerary.days.filter((day) => day.intensity === 'intense');
    expect(intense.length).toBeLessThanOrEqual(1);
  });

  it('respects both budgets a car-free traveller has', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const profile = travellerFrom(adversarialAnswers());
    const journey = journeyThrough(region, profile);
    const itinerary = itineraryOf(journey);

    /* No driving at all, and no driving minutes charged for. */
    expect(profile.transport.maxDailyDriveMinutes).toBe(0);
    expect(journey.auto.stats.totalDriveMinutesOneWay).toBe(0);
    for (const leg of travelLegs(itinerary.days)) {
      expect(leg.mode, 'a car-free traveller was scheduled a drive').not.toBe('drive');
    }
    /*
     * And the transport budget is a real one rather than a number nobody reads:
     * a car-free traveller still has a ceiling on how long they will be in
     * transit, and the day totals have to sit inside it.
     */
    for (const day of itinerary.days) {
      const travelling =
        day.totals.driveMinutes + day.totals.transitMinutes + day.totals.walkMinutes;
      expect(
        travelling,
        `day ${day.dayNumber} spends ${travelling} min in transit against a ` +
          `${profile.transport.maxDailyTransportMinutes} min ceiling`,
      ).toBeLessThanOrEqual(profile.transport.maxDailyTransportMinutes);
    }
  });

  it('feeds them every day, in the style their budget affords', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const profile = travellerFrom(adversarialAnswers());
    const journey = journeyThrough(region, profile);
    const itinerary = itineraryOf(journey);

    for (const day of itinerary.days) {
      expect(
        day.items.filter((item) => item.kind === 'meal').length,
        `day ${day.dayNumber} has no eating in it`,
      ).toBeGreaterThan(0);
    }
    /**
     * The frequency half of §10: a mid-range traveller who likes eating out
     * does not get a special meal every night. The plan holds a budget for
     * them and cannot exceed it — which is the difference between reading the
     * preference and obeying the money.
     */
    expect(itinerary.foodPlan.specialMealsPlanned).toBeLessThanOrEqual(
      itinerary.foodPlan.specialMealBudget,
    );
  });

  it('never spends more of an interest than the traveller allowed', async () => {
    const region = await compileWorld('transit_metro', METRO);
    const profile = travellerFrom(adversarialAnswers());
    const journey = journeyThrough(region, profile);
    const itinerary = itineraryOf(journey);
    const byId = new Map(journey.board.candidates.map((c) => [c.place.id, c]));

    /**
     * The allowance binds the *plan*, not only the board. A traveller who said
     * "hiking, occasionally" and got four hikes has had their answer read and
     * discarded — and this is where that shows, because auto-pick and the
     * planner enforce it separately.
     */
    const spent = new Map<Interest, number>();
    for (const id of scheduledPlaceIds(itinerary.days)) {
      for (const interest of byId.get(id)?.fit.matchedInterests ?? []) {
        spent.set(interest, (spent.get(interest) ?? 0) + 1);
      }
    }
    expect(spent.size, 'nothing scheduled matched any interest at all').toBeGreaterThan(0);
    for (const [interest, count] of spent) {
      const cap = profile.derived.frequencyCaps[interest];
      if (cap === undefined) continue;
      expect(count, `${interest} was scheduled ${count} times against a cap of ${cap}`)
        .toBeLessThanOrEqual(cap);
    }
  });
});
