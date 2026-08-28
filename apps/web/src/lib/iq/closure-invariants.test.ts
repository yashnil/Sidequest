import { describe, expect, it } from 'vitest';
import {
  autoSelect,
  buildDiscoveryBoard,
  buildTravelerProfile,
  countTripDays,
  defaultAnswers,
  standsAsEstablishedName,
  unavailableWeatherDataset,
  type CompiledRegion,
  type DiscoveryBoard,
  type DiscoverySelection,
  type QuestionnaireAnswers,
  type TravelerProfile,
  type TripBasics,
  type WeatherDataset,
} from '@sidequest/core';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import {
  SYNTHETIC_WORLDS,
  expectWorld,
  packBackedProviders,
  syntheticCandidate,
} from '@sidequest/compiler/testing';
import { foodAreaAt, planTrip, type PlanResult } from '@sidequest/planner';
import { descriptionOf } from '@/components/BoardCopy';

/**
 * THE CLOSURE INVARIANTS, DRIVEN THROUGH THE CHAIN THAT SHIPS.
 *
 * Every property below was a *delivered* defect: something a reviewer read off
 * a finished board or a finished itinerary, not something a unit could have
 * shown. That is why they live here rather than beside the functions they
 * constrain — the repeated lesson of this phase is that a helper can be right
 * while the branch a traveller reaches is untested, and six of the seven
 * mechanisms below were reachable only through the whole chain.
 *
 * So each scenario runs compile → discovery board → auto-pick → plan over
 * pack-backed providers, and asserts on the artifact a person would be looking
 * at. Nothing here constructs a candidate, a venue or an itinerary item.
 *
 * Offline throughout: no provider, no network, no clock, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const MONTHS = [8];
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

async function compileWorld(key: keyof typeof SYNTHETIC_WORLDS): Promise<CompiledRegion> {
  const spec = SYNTHETIC_WORLDS[key]!;
  const result = await compileRegion({
    compilationId: `closure-${spec.id}`,
    scope: deriveScope({
      candidate: syntheticCandidate(spec),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights: DATES.length,
      revision: 1,
    }),
    dates: [...DATES],
    months: MONTHS,
    providers: packBackedProviders(spec),
    now: NOW,
  });
  if (!result.ok) throw new Error(`${String(key)} did not compile: ${result.code}`);
  /* The first line of every scenario, for the reason travel-iq.test.ts records. */
  expectWorld(result.region, key);
  return result.region;
}

function travellerFrom(overrides: Partial<QuestionnaireAnswers> = {}): TravelerProfile {
  const context = { travelerNeeds: [], tripDays: countTripDays(DATES[0]!, DATES[DATES.length - 1]!) };
  return buildTravelerProfile({ ...defaultAnswers(context), ...overrides }, context);
}

function primaryBaseOf(region: CompiledRegion) {
  return region.bases.find((base) => base.id === region.primaryBaseId) ?? region.bases[0]!;
}

function unfetchedWeather(region: CompiledRegion): WeatherDataset {
  return unavailableWeatherDataset({
    regionId: region.region.id,
    locations: region.weatherLocations,
    dates: [...DATES],
    now: NOW,
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

function boardFor(region: CompiledRegion, profile: TravelerProfile): DiscoveryBoard {
  return buildDiscoveryBoard({
    region: region.region,
    places: region.places,
    profile,
    months: MONTHS,
    dates: [...DATES],
    access: region.access,
    hours: region.operatingHours,
    weather: unfetchedWeather(region),
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

function basicsFor(region: CompiledRegion, arrivalTime = '10:00'): TripBasics {
  return {
    mode: 'known_destination',
    destinationInput: region.scope.destinationName,
    regionId: region.region.id,
    startDate: DATES[0]!,
    endDate: DATES[DATES.length - 1]!,
    arrivalTime,
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  };
}

/** The whole journey, assembled the way `plannerInputForTrip` assembles it. */
function planThrough(
  region: CompiledRegion,
  profile: TravelerProfile,
  arrivalTime?: string,
): PlanResult {
  const board = boardFor(region, profile);
  const auto = autoSelect({
    candidates: board.candidates,
    profile,
    tripDays: countTripDays(DATES[0]!, DATES[DATES.length - 1]!),
  });
  const selections: DiscoverySelection[] = auto.selectedIds.map((placeId) => ({
    placeId,
    status: 'included' as const,
    source: 'auto' as const,
    updatedAt: '2026-08-10T00:00:00.000Z',
  }));
  return planTrip({
    tripId: `closure-${region.region.id}`,
    basics: basicsFor(region, arrivalTime),
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
    baseId: primaryBaseOf(region).routingId,
    ...(region.basePortfolio ? { basePortfolio: region.basePortfolio } : {}),
    now: NOW,
    generatedAt: '2026-08-10T09:00:00.000Z',
  });
}

function itineraryOf(plan: PlanResult) {
  if (!plan.ok) throw new Error(`The plan failed: ${plan.code} — ${plan.message}`);
  return plan.itinerary;
}

// ---------------------------------------------------------------------------
// 1 — A walk that only prices an unmeasurable journey is never a distance verdict
// ---------------------------------------------------------------------------

describe('a board whose only measured mode is walking, over ground with scheduled transport', () => {
  /**
   * A proxy walk is never *instructed*. The class may be `too_far` and the leg
   * the planner lays must still not tell somebody to walk for two hours.
   */
  it('never renders a proxy journey as a walking instruction', async () => {
    const region = await compileWorld('transit_city');
    const profile = travellerFrom({ willDrive: false });
    const days = itineraryOf(planThrough(region, profile)).days;

    for (const day of days) {
      for (const item of day.items) {
        if (item.kind !== 'travel' || item.travel?.mode !== 'walk') continue;
        expect(
          item.durationMinutes,
          `day ${day.dayNumber} instructs a ${item.durationMinutes}-minute walk against a stated ${profile.transport.maxAccessWalkMinutes}`,
        ).toBeLessThanOrEqual(profile.transport.maxAccessWalkMinutes * 2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — Feasible is not complete
// ---------------------------------------------------------------------------

describe('a plan holding a fraction of what the traveller asked their days to hold', () => {
  /**
   * Three reviewers found this independently on three delivered trips: 42%,
   * 56% and 58% of the traveller's own paced volume, one of them with a day
   * carrying nothing at all, and every one of them headed "Ready".
   *
   * Every feasibility gate had passed — each stop that got in was reachable,
   * open and laid out — and the verdict was computed from those gates alone.
   * The property is about the whole trip rather than about the stops in it.
   */
  it('reads partly plannable, not ready, while it holds less than the pace asked for', async () => {
    /*
     * The case the completeness clause exists for, and the only one that can
     * prove it: a plan comfortably **above** the "is this a trip at all" floor
     * and **below** what the traveller asked their days to hold. Below the
     * floor the verdict is `insufficient` for a different reason, so a scenario
     * that fell that far would pass with the clause deleted — which is exactly
     * how the first version of this test survived its own mutation.
     *
     * A sparse road region at a fast pace with no free time asked for lands in
     * that band by construction: the region cannot fill a packed traveller's
     * days, and it can fill more than half of them.
     */
    const region = await compileWorld('remote_road');
    const profile = travellerFrom({ pace: 'fast', freeTime: 'packed' });
    const plan = planThrough(region, profile);
    if (!plan.ok) throw new Error(`the plan failed: ${plan.code}`);

    const readiness = plan.readiness!;
    const scheduled = plan.itinerary.days.reduce(
      (sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length,
      0,
    );
    const paced = profile.derived.activitySlotsPerDay * (DATES.length - 2);
    expect(
      scheduled,
      'this scenario must fall short of the traveller’s own paced volume or it asserts nothing',
    ).toBeLessThan(paced);
    expect(
      scheduled,
      'and it must stay above the "not a trip" floor, or the clause under test is not the one deciding',
    ).toBeGreaterThan(paced / 2);

    expect(
      readiness.level,
      `a plan holding ${scheduled} of about ${paced} stops read "${readiness.level}"`,
    ).toBe('partial');
    /*
     * And the sentence says what the shortfall is in the trip's own unit,
     * rather than describing the emptiness as the pacing they asked for.
     */
    expect(readiness.summary).toMatch(/room (?:in them )?for around \d+/);
  });

  /**
   * THE SHAPE A CARVE-OUT ONCE RESCUED, DRIVEN THROUGH `coverageOf` ITSELF.
   *
   * "Every place they picked landed, and every fillable day has something on
   * it" was allowed to mean *complete*. An independent review measured what
   * that licences: `everyDayAnchored` needs one activity a day, and auto-pick
   * scales its target to the region's supply, so `scheduled === selected` is
   * the ordinary case rather than the exception. Together the two clauses
   * waived the volume test **and** the "is this a trip at all" floor — five
   * stops on a six-day metropolitan trip read `ready`, with the spacious
   * sentence telling the traveller the empty afternoons were the pace they had
   * asked for. They had answered `balanced`.
   *
   * Asserted against the coverage function with the delivered shape rather than
   * through a compile, because what has to be pinned is the *rule*: no
   * synthetic world reliably produces "everything picked landed and it is still
   * a third of the paced volume", which is exactly why nothing executed the
   * carve-out and it shipped.
   */
  it('does not call a plan finished because everything picked landed', async () => {
    const { coverageOf } = await import('@sidequest/planner');
    const profile = travellerFrom({ willDrive: false });
    const shape = {
      funnel: {
        considered: 24,
        selected: 5,
        eligible: 5,
        accessFeasible: 5,
        hoursFeasible: 5,
        feasible: 5,
        scheduled: 5,
      },
      unscheduled: [],
      dayCount: 6,
      profile,
      /* Every day the trip can fill has exactly one thing on it. */
      usableDays: 4.6,
      anchorableDays: 5,
      usableDaysWithActivity: 5,
      daysWithActivity: 5,
    };

    const coverage = coverageOf(shape)!;
    expect(coverage.everyDayAnchored, 'the shape must anchor every day or it asserts nothing').toBe(
      true,
    );
    expect(
      coverage.scheduled,
      'and it must be short of the paced volume, or there is nothing to rescue',
    ).toBeLessThan(coverage.expected);

    expect(coverage.incomplete).toBe(true);
    expect(
      coverage.spacious,
      'a plan below its own bar must not be described as the room the traveller asked for',
    ).toBe(false);
  });

  /**
   * The other direction, and it is the one that stops the rule being a blunt
   * instrument: a traveller who asked for room and got a plan that reaches the
   * share their own answer implies has a finished trip.
   */
  it('still reads ready once the plan reaches what the traveller asked for', async () => {
    const { coverageOf } = await import('@sidequest/planner');
    const profile = travellerFrom({ freeTime: 'lots' });
    const paced = profile.derived.activitySlotsPerDay * 6;
    const scheduled = Math.ceil(paced * 0.6);
    const coverage = coverageOf({
      funnel: {
        considered: 24,
        selected: scheduled,
        eligible: scheduled,
        accessFeasible: scheduled,
        hoursFeasible: scheduled,
        feasible: scheduled,
        scheduled,
      },
      unscheduled: [],
      dayCount: 8,
      profile,
      usableDays: 6,
      anchorableDays: 6,
      usableDaysWithActivity: 6,
      daysWithActivity: 6,
    })!;
    expect(coverage.incomplete).toBe(false);
    expect(coverage.spacious).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2b — A day says it is empty only when it is
// ---------------------------------------------------------------------------

describe('the empty-day warning', () => {
  /**
   * "Empty" meant the *activity* count, and meals and the travel to reach them
   * are laid out after the activities are counted. So a delivered arrival
   * evening printed "Nothing is scheduled on this day … the hours are yours" in
   * an amber block immediately beneath a booked drive and a ninety-five-minute
   * named dinner.
   */
  /**
   * A row saying a car was driven nowhere is worse than silence.
   *
   * The traveller can already be standing on the next stop's routing node — a
   * venue snapped there for lunch is the ordinary way — and the matrix answers
   * zero. The layout still emitted the row and, the mode being `drive`, still
   * booked the parking allowance: a delivered day printed "Drive to <the
   * museum>" over fifteen minutes and no distance at all.
   */
  it('books no journey, and no parking, for a hop of nothing', async () => {
    for (const key of ['transit_city', 'remote_road', 'transit_mixed'] as const) {
      const region = await compileWorld(key);
      const days = itineraryOf(planThrough(region, travellerFrom())).days;
      for (const day of days) {
        for (const item of day.items) {
          if (item.kind !== 'travel' || !item.travel) continue;
          if ((item.travel.minutes ?? 0) > 0 || (item.travel.km ?? 0) > 0) continue;
          expect.fail(
            `${key} day ${day.dayNumber}: "${item.title}" books ${item.durationMinutes} min to go nowhere`,
          );
        }
      }
    }
  });

  it('never says the hours are yours over a day that books something', async () => {
    /*
     * The departure day is the shape that reaches it: no activity fits, and a
     * named meal and its walk do. `transit_city` and `rail_corridor` both
     * produce it; naming them rather than sweeping, because the gentler worlds
     * do not and a scenario that only ran those would go quiet.
     */
    for (const key of ['transit_city', 'rail_corridor', 'remote_road', 'transit_mixed'] as const) {
      const region = await compileWorld(key);
      const days = itineraryOf(planThrough(region, travellerFrom(), '16:00')).days;
      for (const day of days) {
        const claimsEmpty = day.warnings.some((warning) =>
          warning.startsWith('Nothing is scheduled on this day'),
        );
        if (!claimsEmpty) continue;
        const booked = day.items.filter(
          (item) =>
            item.kind === 'activity' ||
            item.kind === 'travel' ||
            (item.kind === 'meal' && item.food?.stopKind === 'venue'),
        );
        expect(
          booked.map((item) => item.title),
          `${key} day ${day.dayNumber} says the hours are yours over ${booked.length} booked items`,
        ).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — A held meal names where the traveller actually is
// ---------------------------------------------------------------------------

describe('a meal nobody could name', () => {
  /**
   * A delivered road journey printed "Lunch around <the base's municipality>"
   * at half past twelve for a traveller standing at a reserve sixty kilometres
   * up the coast — with the sentence beneath it admitting that none of our
   * venues "worked from where the day actually is at this hour". The area was a
   * day-level constant read off a node set the base is always in, so the base
   * won the modal vote on every day of every trip.
   */
  it('names the anchor the traveller is standing on, never a place they are not', async () => {
    const region = await compileWorld('remote_road');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;

    let checked = 0;
    for (const day of days) {
      /* Where the traveller is, walked forward exactly as the layout walks it. */
      let at = day.baseName;
      for (const item of day.items) {
        if (item.kind === 'travel' && item.travel) at = item.travel.toName;
        if (item.kind !== 'meal' || item.food?.stopKind !== 'unplanned') continue;
        const area = item.food.areaName;
        if (area === undefined) continue;
        checked += 1;
        expect(
          item.title,
          `day ${day.dayNumber}: a held meal at ${at} is titled "${item.title}"`,
        ).toContain(area);
        expect(
          area === at || at.includes(area) || area.includes(at),
          `day ${day.dayNumber}: a meal laid at ${at} points at ${area}`,
        ).toBe(true);
      }
    }
    expect(checked, 'no held meal carried an area, so nothing was asserted').toBeGreaterThan(0);
  });

  /**
   * THE NAME AND THE COUNT ARE ONE CLAIM AND MUST COME FROM ONE PLACE.
   *
   * The layout tracks where the traveller is with two variables, and they are
   * not written together: the unit loop advances the *name* on arrival at a
   * gateway and leaves the *id* on the previous unit's exit until the unit
   * finishes. A meal laid in between was therefore titled after one place and
   * measured at another — a delivered day printed "3 places we hold within
   * reach of <the museum> serve lunch" where the three had been counted from a
   * square four kilometres away — and a meal laid before the day's first stop
   * ended read `atBase: true`, which turns "near X" into "around X" and quotes
   * the base's own venue count over a stop a hundred kilometres out.
   *
   * The sentence is checkable, so it is checked: recount the venues within
   * reach of the place the title names and require the number in the reason to
   * be that number.
   */
  it('counts the area it names, not the one the layout had last written down', async () => {
    /*
     * `recovery_adversary` at a balanced pace is the shape that reaches the
     * branch: a day with two stops where the second is arrived at inside the
     * lunch window, so the meal is laid on the transfer while the layout's two
     * position witnesses disagree. Named rather than swept, because none of the
     * gentler worlds produces it — which is exactly why the defect shipped.
     */
    for (const [key, pace] of [
      ['recovery_adversary', 'balanced'],
      ['remote_road', 'balanced'],
      ['transit_mixed', 'fast'],
      ['transit_city', 'balanced'],
    ] as const) {
      const region = await compileWorld(key);
      const venues = region.food?.venues ?? [];
      if (venues.length === 0) continue;
      const days = itineraryOf(planThrough(region, travellerFrom({ pace }))).days;

      /* Every routing node in the region, by the name a title would use. */
      const idByName = new Map<string, string>();
      for (const base of region.bases) idByName.set(base.name, base.routingId);
      for (const place of region.places) idByName.set(place.name, place.id);

      let checked = 0;
      for (const day of days) {
        for (const item of day.items) {
          const area = item.food?.areaName;
          if (item.kind !== 'meal' || item.food?.stopKind !== 'unplanned' || area === undefined) {
            continue;
          }
          const claimed = /^(\d+) plac/.exec(item.reason);
          if (!claimed) continue;
          const routingId = idByName.get(area);
          expect(routingId, `${key} day ${day.dayNumber}: "${area}" is not a place in this region`).
            toBeDefined();
          const recounted = foodAreaAt({
            routingId: routingId!,
            name: area,
            atBase: routingId === region.bases[0]?.routingId,
            venues,
            matrix: region.travelTimes,
          }).countBySlot[item.food.slot];
          checked += 1;
          expect(
            Number(claimed[1]),
            `${key} day ${day.dayNumber}: the row claims ${claimed[1]} within reach of ${area}, and ${recounted} are`,
          ).toBe(recounted);
        }
      }
      expect(checked, `${key}/${pace} made no counted claim, so nothing was asserted`).
        toBeGreaterThan(0);
    }
  });

  /**
   * A day whose *named venues* cost it a stop loses the venues, not the food
   * layer. It lost the whole layer: `wantsSlot` reads a plan that is no longer
   * there, so breakfast vanished and lunch and dinner rendered as bare blocks
   * headed "Lunch" and "Dinner" with "Back at base, nothing booked" under them
   * — on a metropolis whose own index held fourteen venues.
   */
  it('never renders a bare meal in a region that has food data', async () => {
    /*
     * `transit_mixed` at a fast pace is the shape that reaches the branch: its
     * days are full enough that the food-bearing layout costs the day something,
     * so the meals yield — which is exactly when the old code said the region
     * had no food data at all and printed "Lunch" and "Dinner" with nothing
     * under them. Named here rather than left to a sweep, because a scenario
     * that only ever ran the easy shape is how this defect survived a suite
     * that already had a bare-meal guard in it.
     */
    for (const [key, pace] of [
      ['transit_mixed', 'fast'],
      ['transit_city', 'balanced'],
      ['remote_road', 'balanced'],
    ] as const) {
      const region = await compileWorld(key);
      if ((region.food?.venues.length ?? 0) === 0) continue;
      const plan = planThrough(region, travellerFrom({ pace }));
      const days = itineraryOf(plan).days;
      let held = 0;
      for (const day of days) {
        for (const item of day.items) {
          if (item.kind !== 'meal' || item.food?.stopKind !== 'unplanned') continue;
          held += 1;
          expect(
            item.food.areaName,
            `${key}/${pace} day ${day.dayNumber} renders a bare "${item.title}"`,
          ).toBeDefined();
        }
      }
      expect(held, `${key}/${pace} held no meal, so nothing was asserted`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5 — A caption asserting established standing is earned, or the group is gone
// ---------------------------------------------------------------------------

describe('the classics heading', () => {
  /**
   * Two delivered metropolitan boards rendered no classics group at all while
   * their principal temple, shrine and palace sat under "Promising — check
   * before you go": the evidence-gap route was tested ahead of every content
   * heading, so cards that had earned the caption were filed away before the
   * earning was checked. Twenty of twenty-four cards on one board.
   */
  it('lets a record whose standing was established keep its content heading', async () => {
    const region = await compileWorld('transit_city');

    /*
     * THE SHAPE REAL PACKS PRODUCE AND NO SYNTHETIC WORLD DOES.
     *
     * The delivered defect needs a record that is **both** independently
     * established and thin on practical evidence: a temple the surrounding
     * ground names in nine of its own records, whose catalogue row carries a
     * short description, few attributes and no opening hours anybody published.
     * That combination is ordinary in a dense metropolis and absent from every
     * fixture world here, which is precisely why the branch shipped untested —
     * so the shape is stated rather than hoped for.
     *
     * Only the *record* is shaped. Everything after it is the production chain:
     * `buildDiscoveryBoard` composes the quality verdict, decides the reason
     * basis and picks the heading, and the assertion is on the heading a
     * traveller would read.
     */
    const [subject, ...rest] = region.places;
    const established = {
      ...subject!,
      popularityScore: 0.74,
      prominenceBasis: 'withheld' as const,
      /*
       * No magnitude: the standing came from statements pointing at the place
       * rather than from a boundary drawn round it, which is the shape a
       * destination's principal temple actually has.
       */
      noticeMagnitude: undefined,
      evidenceRichness: 0.28,
      shortDescription: 'A shrine.',
      tags: subject!.tags.filter((tag) => !tag.startsWith('attr:')),
    };
    const board = buildDiscoveryBoard({
      region: region.region,
      places: [established, ...rest],
      profile: travellerFrom({ willDrive: false }),
      months: MONTHS,
      dates: [...DATES],
      access: region.access,
      /* Nobody published this one's hours, which is what makes it `low_confidence`. */
      hours: {
        ...region.operatingHours,
        calendars: region.operatingHours.calendars.filter(
          (calendar) => calendar.placeId !== subject!.id,
        ),
      },
      weather: unfetchedWeather(region),
      ...(region.evidence ? { evidence: region.evidence } : {}),
      travelerNeeds: [],
      travel: {
        matrix: region.travelTimes,
        ...(region.transitEvidence ? { transit: region.transitEvidence } : {}),
        baseId: primaryBaseOf(region).routingId,
        baseIds: region.bases.map((base) => base.routingId),
      },
    });

    const card = board.candidates.find((candidate) => candidate.place.id === subject!.id)!;
    expect(
      standsAsEstablishedName(card.place),
      'the shaped record must earn the caption or this scenario proves nothing',
    ).toBe(true);
    expect(
      card.quality.reasonBasis,
      'and it must reach the board with an evidence gap, which is the branch under test',
    ).toBe('evidence_gap');
    expect(
      card.group,
      `it earned the established-name caption and was filed under ${card.group}`,
    ).toBe('must_see_classics');

    /* Every other established, reachable card keeps its heading too. */
    for (const candidate of board.candidates) {
      if (!standsAsEstablishedName(candidate.place)) continue;
      if (candidate.detourClass === 'too_far') continue;
      if (candidate.fit.band === 'weak' || candidate.fit.band === 'not_workable') continue;
      if (candidate.quality.outcome === 'closed_or_unavailable') continue;
      if (candidate.quality.outcome === 'redundant') continue;
      expect(candidate.group, candidate.place.name).toBe('must_see_classics');
    }
  });

  /**
   * And the caption is never worn by a record whose only claim to notice is
   * that somebody drew a boundary round it. `WIDELY_NOTED_PROMINENCE` sits one
   * hundredth above the ceiling presence alone can reach, so for an observed
   * read, clearing the bar and passing the magnitude gate were the same event —
   * and one of the two magnitude channels is a designation, which every
   * protected area of any size carries.
   */
  it('refuses the caption to notice that only a surveyed boundary vouched for', () => {
    const sized = {
      popularityScore: 0.75,
      evidenceRichness: 0.5,
      prominenceBasis: 'observed' as const,
      noticeMagnitude: 'designation' as const,
    };
    expect(standsAsEstablishedName(sized)).toBe(false);
    /*
     * And through the other door too. A first version of this rule tested the
     * basis as well, and the same designation bought the caption as a *withheld*
     * standing instead — two coastal nature reserves under "Classics worth your
     * time" on the very next build.
     */
    expect(standsAsEstablishedName({ ...sized, prominenceBasis: 'withheld' })).toBe(false);
    /* The other magnitude is the ground naming its own records after the thing. */
    expect(standsAsEstablishedName({ ...sized, noticeMagnitude: 'ground_namesake' })).toBe(true);
    /* And a standing nothing observed, established by evidence pointing at it, is untouched. */
    expect(
      standsAsEstablishedName({
        popularityScore: 0.74,
        evidenceRichness: 0.29,
        prominenceBasis: 'withheld',
      }),
    ).toBe(true);
  });

  /** A group nobody earns does not render. Famous is not mandatory. */
  it('is absent rather than misleading when no card earns it', async () => {
    const region = await compileWorld('remote_road');
    const board = boardFor(region, travellerFrom());
    const classics = board.groups.find((group) => group.group === 'must_see_classics');
    if (classics === undefined) return;
    for (const candidate of classics.candidates) {
      expect(standsAsEstablishedName(candidate.place)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6 — A card's one description line is about the place
// ---------------------------------------------------------------------------

describe('the sentence under a card heading', () => {
  /**
   * A delivered board printed, in the one line reserved for what a place *is*,
   * a category noun followed by the local name, the managing body, a sentence
   * naming the map data and a measurement: five clauses, none of them about the
   * place, and together long enough to clear the stub filter that exists to
   * catch exactly this.
   */
  it('prints nothing rather than a list of facts about our own record', async () => {
    const region = await compileWorld('transit_city');
    const board = boardFor(region, travellerFrom());
    for (const candidate of board.candidates) {
      /*
       * THE LOUD LINE AS WELL AS THE QUIET ONE.
       *
       * The first repair cleaned `descriptionOf`, which composes the card's
       * small secondary line, and left the card's *headline* argument — built
       * in `scoring/fit.ts` from the same `shortDescription` — printing the
       * identical paragraph. On a delivered board five of twenty-four Tokyo
       * cards and seven of twenty-four Osaka cards led with "…and that is what
       * this delivers: An easy walk. Known locally as X. Run by Y. The map data
       * records a charge to enter." while `descriptionOf` returned null for the
       * very same place. Both surfaces read one implementation now, and both
       * are asserted here.
       */
      for (const reason of candidate.fit.reasons) {
        expect(reason, candidate.place.name).not.toMatch(/Known locally as/);
        expect(reason, candidate.place.name).not.toMatch(/\bRun by\b/);
        expect(reason, candidate.place.name).not.toMatch(/The map data records/);
      }
      const description = descriptionOf(candidate.place);
      if (description === null) continue;
      expect(description).not.toMatch(/Known locally as/);
      expect(description).not.toMatch(/\bRun by\b/);
      expect(description).not.toMatch(/The map data records/);
      /*
       * And a measurement may ride along on a description that earned its
       * place; it may not *be* the description.
       */
      expect(description.replace(/Mapped at roughly [^.]*\.\s*/g, '').trim().length).toBeGreaterThan(
        44,
      );
    }
  });
});

