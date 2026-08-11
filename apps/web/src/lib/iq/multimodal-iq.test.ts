import { describe, expect, it } from 'vitest';
import {
  autoSelect,
  buildDiscoveryBoard,
  buildTravelerProfile,
  countTripDays,
  defaultAnswers,
  CLARIFICATION_SET_VERSION,
  type ClarificationSet,
  type CompiledRegion,
  type DiscoverySelection,
  type ItineraryDay,
  type QuestionnaireAnswers,
  type TravelerProfile,
  type TripBasics,
  type WeatherDataset,
  isVisitableRole,
  planningRoleOfPlace,
  roleCanAnchor,
  unavailableWeatherDataset,
} from '@sidequest/core';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import {
  SYNTHETIC_WORLDS,
  expectWorld,
  packBackedProviders,
  syntheticCandidate,
} from '@sidequest/compiler/testing';
import { planTrip } from '@sidequest/planner';

/**
 * MULTIMODAL ITINERARY TRUTH, END TO END.
 *
 * The Travel IQ suite beside this one proves a transit journey can be
 * *measured*. This one proves the measurement reaches the traveller's day — that
 * the mode on the itinerary is the mode the evidence supports, that the minutes
 * on the itinerary are that pair's minutes, and that the day's totals are the
 * sum of the legs it actually contains.
 *
 * It runs the whole chain in one process, which is the only place that can be
 * done: provider evidence → normalised journeys → compiled artifact → discovery
 * board → planner → schedule → day totals → validator. A test that stopped at
 * the artifact is the exact gap this pass was opened to close, because the
 * artifact was already right and the itinerary was not.
 *
 * The world is `transit_mixed`, built so the two networks disagree: walking
 * scales at nine minutes a step and the metro at two, so a short hop is quicker
 * on foot and a long one is quicker underground. Any implementation that answers
 * a whole day from one network gets one of the two badly wrong, and says so
 * here.
 *
 * Offline throughout. No provider, no network, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
const MONTHS = [8];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

async function compileWorld(
  key: keyof typeof SYNTHETIC_WORLDS,
  options: {
    composerTransport?: string;
    transitMeasurable?: boolean;
    /** Overrides applied to the world, for a scenario that varies one property. */
    world?: Partial<(typeof SYNTHETIC_WORLDS)[string]>;
    /** Longer trips get more bases; the base structure is derived, not declared. */
    nights?: number;
    dates?: readonly string[];
  } = {},
): Promise<CompiledRegion> {
  const spec = { ...SYNTHETIC_WORLDS[key]!, ...options.world };
  const scope = deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: emptyClarifications(),
    nights: options.nights ?? DATES.length,
    revision: 1,
    ...(options.composerTransport ? { composerTransport: options.composerTransport } : {}),
    ...(options.transitMeasurable === undefined
      ? {}
      : { transitMeasurable: options.transitMeasurable }),
  });
  const result = await compileRegion({
    compilationId: `mm-${spec.id}`,
    scope,
    dates: [...(options.dates ?? DATES)],
    months: MONTHS,
    providers: packBackedProviders(spec),
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(
      `The ${String(key)} world did not compile: ${result.code} — ${result.message}. ` +
        'A multimodal scenario cannot assert anything about a region that does not exist.',
    );
  }
  expectWorld(result.region, key);
  return result.region;
}

const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Two Rivers',
  regionId: 'compiled-transit-mixed',
  startDate: DATES[0]!,
  endDate: DATES[DATES.length - 1]!,
  arrivalTime: '10:00',
  departureTime: '18:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

/**
 * A traveller with no car and a stated limit on how far they will walk.
 *
 * Both halves matter. Without the first, the road network is a legitimate answer
 * and nothing here is a test. Without the second, every pair is "close enough to
 * walk" and the day never has a reason to board anything.
 */
function carFreeProfile(overrides: Partial<TravelerProfile['transport']> = {}): TravelerProfile {
  const context = {
    travelerNeeds: [],
    tripDays: countTripDays(BASICS.startDate, BASICS.endDate),
  };
  const answers: QuestionnaireAnswers = {
    ...defaultAnswers(context),
    willDrive: false,
    pace: 'balanced',
    dayStart: 'normal',
  };
  const profile = buildTravelerProfile(answers, context);
  return {
    ...profile,
    transport: {
      ...profile.transport,
      willDrive: false,
      maxDailyDriveMinutes: 0,
      maxAccessWalkMinutes: 20,
      ...overrides,
    },
  };
}

/**
 * The weather a trip has before anybody fetches any.
 *
 * Exactly what the product hands the planner on a region whose forecast has not
 * been retrieved — every day `unavailable`, with a reason. Used here rather than
 * a synthetic forecast because weather is not what these scenarios are about,
 * and a dataset full of honest absences is the one shape that cannot
 * accidentally decide which day a place lands on.
 */
function unfetchedWeather(region: CompiledRegion): WeatherDataset {
  return unavailableWeatherDataset({
    regionId: region.region.id,
    locations: region.weatherLocations,
    dates: DATES,
    now: NOW,
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

function planRegion(region: CompiledRegion, profile: TravelerProfile) {
  const board = buildDiscoveryBoard({
    region: region.region,
    places: region.places,
    profile,
    months: MONTHS,
    dates: DATES,
    access: region.access,
    hours: region.operatingHours,
    weather: unfetchedWeather(region),
    ...(region.evidence ? { evidence: region.evidence } : {}),
    travelerNeeds: [],
  });
  const auto = autoSelect({
    candidates: board.candidates,
    profile,
    tripDays: countTripDays(BASICS.startDate, BASICS.endDate),
  });
  const selections: DiscoverySelection[] = auto.selectedIds.map((placeId) => ({
    placeId,
    status: 'included' as const,
    source: 'auto' as const,
    updatedAt: '2026-08-10T00:00:00.000Z',
  }));
  const primary = region.bases.find((base) => base.id === region.primaryBaseId) ?? region.bases[0]!;

  return planTrip({
    tripId: 'multimodal-fixture',
    basics: BASICS,
    profile,
    region: region.region,
    candidates: board.candidates,
    selections,
    matrix: region.travelTimes,
    ...(region.transitEvidence ? { transit: region.transitEvidence } : {}),
    access: region.access,
    hours: region.operatingHours,
    weather: unfetchedWeather(region),
    ...(region.food ? { food: region.food } : {}),
    baseId: primary.routingId,
    ...(region.basePortfolio ? { basePortfolio: region.basePortfolio } : {}),
    now: NOW,
    generatedAt: '2026-08-10T09:00:00.000Z',
  });
}

/** Every travel leg on every day, with the day it belongs to. */
function legsOf(days: readonly ItineraryDay[]) {
  return days.flatMap((day) =>
    day.items
      .filter((item) => item.kind === 'travel' && item.travel)
      .map((item) => ({ day, travel: item.travel! })),
  );
}

// ---------------------------------------------------------------------------
// A — Transit metropolis: a day that no single network can answer
// ---------------------------------------------------------------------------

describe('IQ: a day that needs more than one mode', () => {
  it('puts more than one travel mode on a single day, each measured for its own pair', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const result = planRegion(region, carFreeProfile());
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const days = result.itinerary.days;
    const legs = legsOf(days);
    expect(legs.length).toBeGreaterThan(0);

    const journeys = new Map(
      (region.transitEvidence?.journeys ?? []).map((journey) => [
        `${journey.fromId} ${journey.toId}`,
        journey,
      ]),
    );

    /**
     * The claim, checked leg by leg: every scheduled duration is the number
     * measured for *that ordered pair* in *that mode*.
     *
     * This is the assertion a substitution cannot survive. Splice a road
     * duration in and it matches no journey and no pedestrian cell. Reuse
     * another pair's number and it matches the wrong row. Relabel a train as a
     * drive and the mode no longer agrees with where the number came from.
     */
    let rides = 0;
    let walks = 0;
    for (const { travel } of legs) {
      if (travel.minutes === null) {
        expect(travel.provenance).toBe('unmeasured');
        expect(travel.unmeasuredReason).toBeDefined();
        continue;
      }
      if (travel.role === 'wait') continue;

      if (travel.mode === 'rail' || travel.mode === 'public_bus' || travel.mode === 'ferry') {
        rides += 1;
        const journey = journeys.get(`${travel.fromId} ${travel.toId}`);
        expect(
          journey,
          `a ${travel.mode} leg from ${travel.fromName} to ${travel.toName} quotes a journey nobody measured`,
        ).toBeDefined();
        expect(journey!.status).toBe('measured');
        expect(travel.minutes).toBe(journey!.minutes);
        expect(travel.provenance).toBe('official');
        /* A ride puts no kilometres on a car. */
        expect(travel.km).toBeNull();
      }

      if (travel.mode === 'walk') {
        walks += 1;
        const from = region.travelTimes.ids.indexOf(travel.fromId);
        const to = region.travelTimes.ids.indexOf(travel.toId);
        if (from >= 0 && to >= 0) {
          expect(
            travel.minutes,
            `a walk from ${travel.fromName} to ${travel.toName} is not that pair's walk`,
          ).toBe(Math.round(region.travelTimes.minutes[from]![to]!));
        }
      }

      /* The one thing a car-free trip may never contain. */
      expect(travel.mode).not.toBe('drive');
    }

    expect(rides, 'no day rode anything, so nothing multimodal was proved').toBeGreaterThan(0);
    expect(walks, 'no day walked anywhere, so nothing multimodal was proved').toBeGreaterThan(0);

    /* And at least one day holds both, which is the mixed-mode claim itself. */
    const mixed = days.filter((day) => {
      const modes = new Set(
        day.items
          .filter((item) => item.kind === 'travel' && item.travel && item.travel.minutes !== null)
          .map((item) => item.travel!.mode),
      );
      return modes.has('walk') && (modes.has('rail') || modes.has('public_bus'));
    });
    expect(mixed.length, 'no single day mixed walking with a measured ride').toBeGreaterThan(0);
  });

  it('adds up a mixed day from the legs it actually contains', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const result = planRegion(region, carFreeProfile());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.itinerary.days.length).toBeGreaterThan(0);
    for (const day of result.itinerary.days) {
      const measured = day.items
        .filter((item) => item.kind === 'travel' && item.travel && item.travel.minutes !== null)
        .map((item) => item.travel!);

      const expected = { drive: 0, transit: 0, walk: 0, wait: 0 };
      for (const travel of measured) {
        const bucket =
          travel.mode === 'drive'
            ? 'drive'
            : travel.role === 'wait'
              ? 'wait'
              : travel.mode === 'walk'
                ? 'walk'
                : 'transit';
        expected[bucket] += travel.minutes!;
      }

      expect(day.totals.driveMinutes, `day ${day.dayNumber} driving`).toBe(expected.drive);
      expect(day.totals.transitMinutes, `day ${day.dayNumber} riding`).toBe(expected.transit);
      expect(day.totals.walkMinutes, `day ${day.dayNumber} walking`).toBe(expected.walk);
      expect(day.totals.waitMinutes, `day ${day.dayNumber} waiting`).toBe(expected.wait);
      expect(day.totals.travelMinutes).toBe(
        expected.drive + expected.transit + expected.walk + expected.wait,
      );

      /* Riding is never charged to the driving budget, which is the cap that refuses. */
      expect(day.totals.driveMinutes).toBe(0);

      /* Road distance stays on the road. Nothing here drives, so nothing is on it. */
      expect(day.totals.travelKm).toBe(0);

      /* A leg nobody could time contributes to no total, and is counted beside them. */
      const unmeasured = day.items.filter(
        (item) => item.kind === 'travel' && item.travel && item.travel.minutes === null,
      ).length;
      expect(day.totals.unmeasuredLegCount).toBe(unmeasured);
    }
  });

  it('passes its own validator, which re-derives the split from the timeline', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const result = planRegion(region, carFreeProfile());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /**
     * The validation the product itself performed, read off the plan.
     *
     * Re-running the validator here with a hand-built input would be checking a
     * second assembly of the same facts. This is the one the traveller's plan
     * was actually judged by — and `inconsistent_transport_totals` is the code
     * that fires when the layout and the validator classify a leg differently,
     * which is precisely the divergence a mixed-mode day would expose.
     */
    const errors = result.itinerary.issues.filter(
      (issue) => issue.severity === 'error',
    );
    expect(
      errors.map((issue) => `${issue.code}: ${issue.message}`),
      'a mixed-mode day did not survive the validator',
    ).toEqual([]);
    expect(result.itinerary.issues.map((issue) => issue.code)).not.toContain(
      'inconsistent_transport_totals',
    );
  });

  it('keeps the local clock the journeys were asked about', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const zone = SYNTHETIC_WORLDS.transit_mixed!.timeZone;
    const asked = region.transitEvidence?.journeys ?? [];
    expect(asked.length, 'nothing was asked, so the loop below asserts nothing').toBeGreaterThan(0);
    for (const journey of asked) {
      expect(journey.requestBasis.timeZone).toBe(zone);
      expect(journey.requestBasis.kind).toBe('depart_at');
    }
    expect(region.bases.every((base) => base.timeZone === zone)).toBe(true);
  });

  /**
   * The return direction, bought rather than assumed.
   *
   * The stage used to ask base → place and nothing else, so a day could be
   * measured on the way out and had nothing at all for the way home. Answering
   * the return with the outbound number is reusing one journey's duration for
   * another, so the pairs are now asked in both directions — and this is what
   * says so.
   */
  it('measures the way home as its own journey', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const journeys = region.transitEvidence?.journeys ?? [];
    expect(journeys.length).toBeGreaterThan(0);

    const keys = new Set(journeys.map((journey) => `${journey.fromId} ${journey.toId}`));
    const roundTrips = journeys.filter((journey) => keys.has(`${journey.toId} ${journey.fromId}`));
    expect(roundTrips.length, 'no pair was measured in both directions').toBeGreaterThan(0);
  });


  /**
   * THE TIERS BELOW THE ROUND TRIPS, WHICH A NAIVE BUDGET DROPS FIRST.
   *
   * The stage buys two pairs per plannable place and that list is unbounded, so
   * concatenating the base-to-base and connector tiers after it and truncating
   * once at the end starves them entirely on any region with more places than
   * half the budget. Those are the pairs that make a day multimodal in the
   * middle rather than only at its ends — and the tier that decides whether a
   * multi-base trip is possible at all.
   *
   * Twenty-six places puts `roundTrips` at fifty-two against a budget of
   * forty-eight, so the tiers below survive only if room is reserved for them.
   */
  it('still buys connector pairs when the round trips alone would exhaust the budget', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
      world: { placeCount: 34 },
    });

    const journeys = region.transitEvidence?.journeys ?? [];
    expect(journeys.length).toBeGreaterThan(0);
    expect(
      region.places.length * 2,
      'this world is no longer big enough to crowd the budget, so the test proves nothing',
    ).toBeGreaterThanOrEqual(journeys.length);

    const baseIds = new Set(region.bases.map((base) => base.routingId));
    const connectors = journeys.filter(
      (journey) => !baseIds.has(journey.fromId) && !baseIds.has(journey.toId),
    );
    expect(
      connectors.length,
      'every pair bought touches a base, so no within-day transition was measured',
    ).toBeGreaterThan(0);
  });

  it('leaves a pair with no service unknown rather than answering it another way', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const refused = (region.transitEvidence?.journeys ?? []).filter(
      (journey) => journey.status === 'no_route',
    );
    expect(refused.length, 'the world publishes a no-service pair and nothing recorded it').toBeGreaterThan(0);
    for (const journey of refused) {
      /* A journey that does not run carries no duration. Never a zero. */
      expect(journey.minutes).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// B — Dense city: the short hop stays on foot
// ---------------------------------------------------------------------------

describe('IQ: a dense city does not put you on a train to go two streets', () => {
  it('walks what is walkable and rides what is not', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const profile = carFreeProfile();
    const result = planRegion(region, profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tolerance = profile.transport.maxAccessWalkMinutes;
    const walked = legsOf(result.itinerary.days);
    expect(walked.length).toBeGreaterThan(0);
    for (const { travel } of walked) {
      if (travel.minutes === null || travel.role === 'wait') continue;
      const from = region.travelTimes.ids.indexOf(travel.fromId);
      const to = region.travelTimes.ids.indexOf(travel.toId);
      if (from < 0 || to < 0) continue;
      const onFoot = Math.round(region.travelTimes.minutes[from]![to]!);

      if (travel.mode === 'rail' || travel.mode === 'public_bus') {
        /*
         * Nothing was boarded that could comfortably have been walked. This is
         * the failure a "transit city means transit" rule produces, and it is as
         * wrong as answering a long ride with a walk.
         */
        expect(
          onFoot,
          `boarded a ${travel.mode} for a ${onFoot} min walk, inside a ${tolerance} min tolerance`,
        ).toBeGreaterThan(tolerance);
        /* And the ride is genuinely the quicker of the two. */
        expect(travel.minutes!).toBeLessThanOrEqual(onFoot);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// C — Road and satellite: nothing above regressed a driving trip
// ---------------------------------------------------------------------------

describe('IQ: a driving region is untouched by any of this', () => {
  it('still drives, still measures on the road, and buys no timetables', async () => {
    const region = await compileWorld('remote_road', { composerTransport: 'drive' });
    /*
     * A trip planned around a car buys nothing from a journey planner. Which of
     * the "nothing bought" reasons applies depends on whether the scope settled
     * that a car is available or merely did not rule one out, and both are
     * honest — what matters here is that no journey was bought and none is used.
     */
    expect(['not_needed', 'unsupported']).toContain(region.transitEvidence?.absence);
    expect(region.transitEvidence?.journeys ?? []).toEqual([]);
    expect(region.travelTimes.mode).toBe('car');

    const context = { travelerNeeds: [], tripDays: countTripDays(BASICS.startDate, BASICS.endDate) };
    const profile = buildTravelerProfile(
      { ...defaultAnswers(context), willDrive: true },
      context,
    );
    const basics: TripBasics = { ...BASICS, destinationInput: 'Long Road Country', regionId: region.region.id };
    const board = buildDiscoveryBoard({
      region: region.region,
      places: region.places,
      profile,
      months: MONTHS,
      dates: DATES,
      access: region.access,
      hours: region.operatingHours,
      weather: unfetchedWeather(region),
      ...(region.evidence ? { evidence: region.evidence } : {}),
      travelerNeeds: [],
    });
    const auto = autoSelect({ candidates: board.candidates, profile, tripDays: context.tripDays });
    const primary = region.bases.find((base) => base.id === region.primaryBaseId) ?? region.bases[0]!;
    const result = planTrip({
      tripId: 'road-fixture',
      basics,
      profile,
      region: region.region,
      candidates: board.candidates,
      selections: auto.selectedIds.map((placeId) => ({
        placeId,
        status: 'included' as const,
        source: 'auto' as const,
        updatedAt: '2026-08-10T00:00:00.000Z',
      })),
      matrix: region.travelTimes,
      ...(region.transitEvidence ? { transit: region.transitEvidence } : {}),
      access: region.access,
      hours: region.operatingHours,
      weather: unfetchedWeather(region),
      ...(region.food ? { food: region.food } : {}),
      baseId: primary.routingId,
      ...(region.basePortfolio ? { basePortfolio: region.basePortfolio } : {}),
      now: NOW,
      generatedAt: '2026-08-10T09:00:00.000Z',
    });
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const legs = legsOf(result.itinerary.days);
    const drives = legs.filter(({ travel }) => travel.mode === 'drive');
    expect(drives.length, 'a road region produced no driving').toBeGreaterThan(0);
    for (const { travel } of drives) {
      const from = region.travelTimes.ids.indexOf(travel.fromId);
      const to = region.travelTimes.ids.indexOf(travel.toId);
      if (from >= 0 && to >= 0 && travel.minutes !== null) {
        expect(travel.minutes).toBe(Math.round(region.travelTimes.minutes[from]![to]!));
      }
    }
    /* Driving minutes reach the driving total, and the road distance the road one. */
    const driving = result.itinerary.days.reduce((sum, day) => sum + day.totals.driveMinutes, 0);
    expect(driving).toBeGreaterThan(0);
    /*
     * And the kilometres arrive. `travelKm` had exactly one writer and no
     * assertion against a generated plan that a driving trip puts anything in
     * it, so deleting the line would have rendered "Road distance: 0 km" on
     * every road trip with the suite green.
     */
    const roadKm = result.itinerary.days.reduce((sum, day) => sum + day.totals.travelKm, 0);
    expect(roadKm).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D — Recovery adversary: one artifact, one truth
// ---------------------------------------------------------------------------

describe('IQ: what recovery found is what the artifact counts', () => {
  /**
   * The gap this closes, stated plainly.
   *
   * `portfolioFacts` is captured in the discovery stage. `visitable` is taken
   * after routing, hundreds of lines and one recovery loop later. So a
   * compilation that went back and bought eight more places reported eleven
   * things to do beside a breakdown that still described three — and nothing
   * caught it, because the only assertion in the suite compared
   * `funnel.visitable` against `places.length`, which is an identity.
   */
  async function recoverySubject(reserve?: Record<string, number>) {
    const spec = {
      ...SYNTHETIC_WORLDS.recovery_adversary!,
      ...(reserve === undefined ? {} : { acquirable: reserve }),
    };
    const scope = deriveScope({
      candidate: syntheticCandidate(spec),
      clarifications: emptyClarifications(),
      nights: DATES.length,
      revision: 1,
    });
    const result = await compileRegion({
      compilationId: 'mm-recovery',
      scope,
      dates: DATES,
      months: MONTHS,
      providers: packBackedProviders(spec),
      now: NOW,
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expectWorld(result.region, 'recovery_adversary');
    return result.region;
  }

  it('starts deficient, so the repair has something to repair', async () => {
    const before = await recoverySubject({});
    expect(before.places.length).toBe(3);
    expect(before.researchReadiness?.funnel.visitable).toBe(3);
  });

  it('counts the board it ends with, not the one it started from', async () => {
    const before = await recoverySubject({});
    const after = await recoverySubject();

    /* The acquisition genuinely added records; without this the rest is vacuous. */
    expect(after.places.length).toBeGreaterThan(before.places.length);

    const funnel = after.researchReadiness!.funnel;
    expect(funnel.visitable).toBe(after.places.length);

    /**
     * The assertion the old shape could not make.
     *
     * Every role in the breakdown is counted off the same places `visitable`
     * counts, so the parts cannot describe a smaller world than the total. Before
     * the recount, `anchors + discoveries` summed to the pre-recovery three while
     * `visitable` said eleven.
     */
    expect(funnel.anchors + funnel.discoveries + funnel.support + funnel.gateways).toBe(
      funnel.visitable,
    );

    /*
     * And the assignment, not only the partition. The sum above holds for *any*
     * bucketing that puts each place in exactly one bucket — including one that
     * dropped every anchor into discoveries — so on its own it pins nothing
     * about which places can hold a day.
     */
    const roles = after.places.map((place) => planningRoleOfPlace(place));
    expect(funnel.anchors).toBe(
      roles.filter((role) => role !== undefined && roleCanAnchor(role)).length,
    );
    expect(funnel.anchors).toBeGreaterThan(0);
    expect(funnel.discoveries).toBe(
      roles.filter(
        (role) => role !== undefined && isVisitableRole(role) && !roleCanAnchor(role),
      ).length,
    );

    /*
     * Geographic spread, recounted over the same places. It feeds a readiness
     * dimension and no funnel field, so nothing else here would notice it
     * silently reverting to the pre-recovery number.
     */
    const spread = after.researchReadiness!.dimensions.find(
      (dimension) => dimension.dimension === 'geographic_spread',
    );
    const beforeSpread = before.researchReadiness!.dimensions.find(
      (dimension) => dimension.dimension === 'geographic_spread',
    );
    expect(spread?.observed).toBeGreaterThanOrEqual(beforeSpread?.observed ?? 0);
    expect(spread?.observed).toBeLessThanOrEqual(after.places.length);

    /* Kinds of thing, recounted over the same places. */
    expect(
      after.researchReadiness!.dimensions.find(
        (dimension) => dimension.dimension === 'category_diversity',
      )?.observed,
    ).toBe(new Set(after.places.map((place) => place.category)).size);
  });

  it('gives every acquired place a part to play, or it cannot be counted at all', async () => {
    const after = await recoverySubject();
    /*
     * The precondition the recount depends on. An acquired record used to reach
     * the board with no role tag, so no count derived from roles could see it —
     * and a recount over roles would have silently dropped it.
     */
    const unclassified = after.places.filter((place) => planningRoleOfPlace(place) === undefined);
    expect(
      unclassified.map((place) => place.name),
      'a place on the board carries no planning role, so the funnel cannot count it',
    ).toEqual([]);
  });

  it('gives the same answer twice', async () => {
    const first = await recoverySubject();
    const second = await recoverySubject();
    expect(second.places.length).toBe(first.places.length);
    expect(second.researchReadiness!.funnel).toEqual(first.researchReadiness!.funnel);
  });
});

// ---------------------------------------------------------------------------
// F — Pre-scheduler reach: nothing is ruled out before the scheduler can reach it
// ---------------------------------------------------------------------------

describe('IQ: a stop is not ruled out before the scheduler can reach it', () => {
  /**
   * The gap this closes.
   *
   * Every pre-scheduler reach test read `place.travelFromBase.driveMinutes`,
   * which the compiler fills from whatever mode the single matrix measured. On a
   * car-free trip that is a *walking* figure under a name that says driving — so
   * `boundsFor` pushed a metro-reachable stop's earliest arrival most of an hour
   * into the day, and the round-trip refusal compared that walk against
   * `maxDailyDriveMinutes`, which is zero for a traveller with no car.
   */
  it('bounds arrival by the mode that would actually make the journey', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const result = planRegion(region, carFreeProfile());
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const base = region.bases.find((entry) => entry.id === region.primaryBaseId) ?? region.bases[0]!;
    const ids = region.travelTimes.ids;
    const baseRow = ids.indexOf(base.routingId);
    const journeys = new Map(
      (region.transitEvidence?.journeys ?? [])
        .filter((journey) => journey.status === 'measured')
        .map((journey) => [`${journey.fromId} ${journey.toId}`, journey.minutes!]),
    );

    /*
     * Every scheduled place whose measured journey from base beats the walk.
     * These are exactly the stops the old bound would have pushed out, and their
     * presence on the plan is the proof that it no longer does.
     */
    const scheduled = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'activity' && item.placeId).map((item) => item.placeId!),
    );
    const reachedByTransit = scheduled.filter((placeId) => {
      const ride = journeys.get(`${base.routingId} ${placeId}`);
      const column = ids.indexOf(placeId);
      if (ride === undefined || baseRow < 0 || column < 0) return false;
      return ride < Math.round(region.travelTimes.minutes[baseRow]![column]!);
    });

    expect(
      reachedByTransit.length,
      'no scheduled stop is quicker by its measured journey than on foot, so this proves nothing',
    ).toBeGreaterThan(0);
  });

  it('never charges a car-free traveller for driving they cannot do', async () => {
    const region = await compileWorld('transit_mixed', {
      composerTransport: 'public_transport',
      transitMeasurable: true,
    });
    const profile = carFreeProfile();
    const result = planRegion(region, profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(profile.transport.maxDailyDriveMinutes).toBe(0);
    /*
     * The refusal copy used to read "N minutes of driving, and you said 0 was
     * your limit" to somebody with no car, about a walk — and the reason code
     * behind it drove the whole remedy ranking.
     */
    for (const entry of result.itinerary.unscheduled) {
      expect(entry.reason).not.toMatch(/of driving/);
      expect(entry.suggestedRemedy ?? '').not.toMatch(/daily driving limit/);
    }
  });
});
