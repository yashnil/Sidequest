import { describe, expect, it } from 'vitest';
import {
  autoSelect,
  buildDiscoveryBoard,
  buildTravelerProfile,
  countTripDays,
  defaultAnswers,
  CLARIFICATION_SET_VERSION,
  unavailableWeatherDataset,
  type ClarificationSet,
  type CompiledRegion,
  type DiscoveryBoard,
  type DiscoverySelection,
  type ItineraryDay,
  type ItineraryItem,
  type QuestionnaireAnswers,
  type ScheduledFood,
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
import {
  DEFAULT_PLANNER_CONFIG,
  MAX_TIMES_ONE_VENUE_IS_NAMED,
  planTrip,
  type PlanResult,
} from '@sidequest/planner';

/**
 * THE FOOD PILLAR, OVER THE CHAIN THAT ACTUALLY SHIPS.
 *
 * The defect this suite exists to hold shut, measured on three delivered
 * journeys rather than reasoned about: **thirty-one meals, every one of them
 * time held, every `place_id` null** — on a compile that had discovered
 * twenty-three venues, stored seventeen, put every one of them in the routing
 * matrix and given every one of them meal periods covering lunch and dinner.
 * Breakfast did not appear at all, on any day of any trip, and nothing anywhere
 * reported its absence.
 *
 * The cause was circular rather than missing. Every venue a compilation stores
 * carries `hours: { kind: 'unknown' }`, because almost nobody publishes machine
 * -readable opening times; the scheduler would only name a venue whose hours
 * were *confirmed*; and the stage that would confirm them reports that it could
 * not. So naming needed confirmation, confirmation never came, and the pillar
 * could not name a meal in any destination whose venues are ordinary ones.
 *
 * ## Why the tests are here and why they are shaped like this
 *
 * Under `apps/web` because it is the only workspace that can see both the
 * compiler and the planner, and the seam between them is exactly where this
 * lived — a unit test over a hand-built `FoodDataset` with published hours
 * would have passed throughout.
 *
 * Every scenario runs the real chain: compile → discovery board → auto-pick →
 * plan, over pack-backed providers, so the venues under test are the ones
 * `buildInventory` actually produces from raw source records, unknown hours and
 * all. Nothing here constructs a venue.
 *
 * Three shapes, because the right answer is different in each and a rule that
 * only knows one of them is the rule that shipped:
 *
 *   1. a dense metro whose venues' hours are unverified — the live shape, and
 *      the one that must now name meals;
 *   2. a road region with long legs and three venues in the whole place, where
 *      naming is sometimes right and sometimes is not;
 *   3. a destination with no food evidence at all, where naming would be
 *      irresponsible and the honest refusal has to survive.
 *
 * Nothing below names a destination or a venue: the worlds are shapes, and every
 * expected string is read back off the compiled region.
 *
 * Offline throughout: no provider, no network, no clock, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const MONTHS = [8];
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

async function compileWorld(key: keyof typeof SYNTHETIC_WORLDS): Promise<CompiledRegion> {
  const spec = SYNTHETIC_WORLDS[key]!;
  const scope = deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: emptyClarifications(),
    nights: DATES.length,
    revision: 1,
  });
  const result = await compileRegion({
    compilationId: `food-${spec.id}`,
    scope,
    dates: [...DATES],
    months: MONTHS,
    providers: packBackedProviders(spec),
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(
      `The ${String(key)} world did not compile: ${result.code} — ${result.message}. ` +
        'A food scenario cannot assert anything about a trip that does not exist.',
    );
  }
  /* The first line of every scenario, for the reason travel-iq.test.ts records. */
  expectWorld(result.region, key);
  return result.region;
}

function basicsFor(region: CompiledRegion): TripBasics {
  return {
    mode: 'known_destination',
    destinationInput: region.scope.destinationName,
    regionId: region.region.id,
    startDate: DATES[0]!,
    endDate: DATES[DATES.length - 1]!,
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  };
}

/** The traveller, built the one way the product builds one. */
function travellerFrom(overrides: Partial<QuestionnaireAnswers> = {}): TravelerProfile {
  const context = { travelerNeeds: [], tripDays: countTripDays(DATES[0]!, DATES[DATES.length - 1]!) };
  return buildTravelerProfile({ ...defaultAnswers(context), ...overrides }, context);
}

/** Every day `unavailable`, which is what a trip has before anybody buys a forecast. */
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

function primaryBaseOf(region: CompiledRegion) {
  return region.bases.find((base) => base.id === region.primaryBaseId) ?? region.bases[0]!;
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

/**
 * One traveller's whole journey, from raw source records to a rendered day.
 *
 * The assembly mirrors `plannerInputForTrip` — the single production route from
 * a trip to a `PlannerInput` — because a scenario that hand-built the input
 * would be testing a chain the product does not run.
 */
function planThrough(region: CompiledRegion, profile: TravelerProfile): PlanResult {
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
    tripId: `food-${region.region.id}`,
    basics: basicsFor(region),
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

/** The itinerary, or a failure that names itself rather than a silent skip. */
function itineraryOf(plan: PlanResult) {
  if (!plan.ok) {
    throw new Error(
      `The plan failed: ${plan.code} — ${plan.message}. ` +
        'A food scenario asserts about meals; a trip that does not exist is the finding.',
    );
  }
  return plan.itinerary;
}

interface MealRow {
  day: ItineraryDay;
  item: ItineraryItem;
  food: ScheduledFood;
}

/** Every meal row a traveller would read, in the order they would read them. */
function mealRows(days: readonly ItineraryDay[]): MealRow[] {
  return days.flatMap((day) =>
    day.items
      .filter((item) => item.kind === 'meal' && item.food !== undefined)
      .map((item) => ({ day, item, food: item.food! })),
  );
}

const namedRows = (rows: readonly MealRow[]) => rows.filter((row) => row.food.stopKind === 'venue');
const unnamedRows = (rows: readonly MealRow[]) =>
  rows.filter((row) => row.food.stopKind === 'unplanned');

/**
 * EVERY NAME A MEAL MAY POINT AT, AND WHY THE SET GREW.
 *
 * The rule is unchanged and it is the one that matters: **nothing composed**.
 * An area name has to be a string some record in this region published, so a
 * neighbourhood cannot be invented any more than a restaurant can.
 *
 * What changed is which published strings are legal, and it is a correction
 * rather than a loosening. This held localities and base names only, and the
 * fallback that fed it read a *day-level* modal locality computed over a node
 * set the base is always in — so on a day that went sixty kilometres up the
 * coast the meal still said "around <the base's municipality>", naming a place
 * the traveller was demonstrably not in and doing it with the sentence beneath
 * admitting that none of our venues "worked from where the day actually is at
 * this hour". The area is now resolved at the anchor the traveller is standing
 * on, so a stop's own published name is a legal answer and is the more precise
 * one. Localities in real packs are frequently the region or the country
 * ("Tokyo", "Iceland"), which is exactly why the stop wins where there is one.
 */
function publishedLocalities(region: CompiledRegion): Set<string> {
  return new Set([
    ...region.places.map((place) => place.locality),
    ...region.places.map((place) => place.name),
    ...(region.food?.venues ?? []).map((venue) => venue.locality),
    ...region.bases.map((base) => base.name),
  ]);
}

// ---------------------------------------------------------------------------
// Properties that hold for every shape, asserted against each of the three
// ---------------------------------------------------------------------------

/**
 * Nothing on a meal row may say more than a source did.
 *
 * Run over all three worlds rather than once, because the way to pass a naming
 * test is to invent a venue and the way to pass a fallback test is to invent a
 * neighbourhood, and both would sail through a suite that only checked the
 * shape it was aiming at.
 */
function expectNothingFabricated(region: CompiledRegion, days: readonly ItineraryDay[]): void {
  const venues = new Map((region.food?.venues ?? []).map((venue) => [venue.id, venue]));
  const localities = publishedLocalities(region);

  for (const row of mealRows(days)) {
    const { food } = row;

    if (food.venueId !== undefined) {
      const venue = venues.get(food.venueId);
      expect(venue, `day ${row.day.dayNumber} names a venue this region does not hold`).toBeDefined();
      expect(food.venueName).toBe(venue!.name);
      expect(food.priceBand).toBe(venue!.priceBand);
      expect(food.priceEvidence).toBe(venue!.priceEvidence);
      expect(food.cuisineLabel ?? '').toBe(venue!.cuisines.join(', '));

      /*
       * The whole point of the change, stated as its own guard: a venue whose
       * calendar says `unknown` may be named, and may not acquire an opening
       * window on the way to the timeline. An invented window would be
       * indistinguishable from a published one on the rendered row.
       */
      if (venue!.hours.kind === 'unknown') {
        expect(food.hoursUnknown, `${venue!.name} is named without its doubt`).toBe(true);
        expect(food.hours, `${venue!.name} acquired hours nobody published`).toBeUndefined();
      } else {
        expect(food.hoursUnknown).toBe(false);
      }
    }

    if (food.areaName !== undefined) {
      expect(
        localities.has(food.areaName),
        `day ${row.day.dayNumber} points at an area no record in this region publishes`,
      ).toBe(true);
    }
  }
}

/**
 * A day that asked for breakfast has a breakfast row on it, named or not.
 *
 * The silent drop, stated as a property the timeline can be held to. It is
 * checked against the *day's own window and the product's own breakfast
 * window* rather than against what got scheduled, because reading the slots back
 * off the timeline is precisely how the omission went unreported for three
 * trips: a dropped meal left no trace to count.
 */
function expectNoSilentBreakfast(days: readonly ItineraryDay[], hasFoodData: boolean): void {
  if (!hasFoodData) return;
  for (const day of days) {
    if (day.window.startMinute > DEFAULT_PLANNER_CONFIG.mealWindows.breakfast.latest) continue;
    /* A grocery run before the day starts moves the clock; that is its own case. */
    if (day.items.some((item) => item.food?.stopKind === 'grocery')) continue;
    const breakfast = day.items.filter((item) => item.food?.slot === 'breakfast');
    expect(
      breakfast.length,
      `day ${day.dayNumber} starts inside the breakfast window and says nothing about breakfast`,
    ).toBeGreaterThan(0);
    expect(breakfast[0]!.reason.length).toBeGreaterThan(20);
  }
}

/**
 * No meal is left as a bare hour with a meal's name on it.
 *
 * The outcome §8 asks to eliminate. Where a venue could not be named, the row
 * has to reach the area fallback — which means an area on the food record, the
 * area in the title the traveller reads, and a reason that says what our index
 * actually holds there.
 */
function expectNoBareMeal(days: readonly ItineraryDay[]): void {
  for (const row of unnamedRows(mealRows(days))) {
    expect(
      row.food.areaName,
      `day ${row.day.dayNumber} renders a bare "${row.item.title}"`,
    ).toBeDefined();
    expect(row.item.title).toContain(row.food.areaName!);
    expect(row.item.reason).toContain(row.food.areaName!);
  }
}

// ---------------------------------------------------------------------------
// 1 — A dense metro whose venues' hours are unverified. The live shape.
// ---------------------------------------------------------------------------

describe('a dense metro whose venues publish no hours', () => {
  it('holds the exact shape the live defect was measured on', async () => {
    const region = await compileWorld('transit_city');
    const venues = region.food?.venues ?? [];

    /*
     * Without this the scenario proves nothing: a world whose venues happened to
     * publish hours would name meals under the old rule too, and the test would
     * be green against the code that shipped the defect.
     */
    expect(venues.length).toBeGreaterThan(0);
    for (const venue of venues) {
      expect(venue.hours.kind).toBe('unknown');
      expect(venue.hours.hoursConfidence).toBe('unverified');
    }
    /* And every one of them is in the matrix, as they were on the live compile. */
    for (const venue of venues) {
      expect(region.travelTimes.ids).toContain(venue.routingId);
    }
  });

  it('names at least one meal, which is the whole of the finding', async () => {
    const region = await compileWorld('transit_city');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;

    const named = namedRows(mealRows(days));
    expect(
      named.length,
      'every venue here has unknown hours, and unknown hours must not withhold a name',
    ).toBeGreaterThan(0);
    for (const row of named) {
      expect(row.item.title).toBe(row.food.venueName);
    }
  });

  it('never names one venue past the cap, however thin the supply', async () => {
    /*
     * The companion defect to naming, and the one that only appears once naming
     * works. This world yields a handful of usable doors, and the variety rule
     * was a score penalty — which orders a shortlist and cannot bound one. On
     * the live trip the same cafe took lunch and dinner on three consecutive
     * days, six rows, each individually defensible. Past the cap a venue stops
     * being a candidate and the slot falls to the area suggestion, which the
     * test above holds.
     */
    const region = await compileWorld('transit_city');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;

    const times = new Map<string, number>();
    for (const row of namedRows(mealRows(days))) {
      const name = row.food.venueName ?? row.item.title;
      times.set(name, (times.get(name) ?? 0) + 1);
    }
    expect(times.size, 'no meal was named at all, so this proves nothing').toBeGreaterThan(0);
    for (const [venue, count] of times) {
      expect(count, `${venue} was named ${count} times`).toBeLessThanOrEqual(
        MAX_TIMES_ONE_VENUE_IS_NAMED,
      );
    }
  });

  it('carries the doubt on the row that carries the name', async () => {
    const region = await compileWorld('transit_city');
    const itinerary = itineraryOf(planThrough(region, travellerFrom()));

    const named = namedRows(mealRows(itinerary.days));
    expect(named.length).toBeGreaterThan(0);
    for (const row of named) {
      expect(row.food.hoursUnknown).toBe(true);
      expect(row.item.reason).toMatch(/nobody publishes hours for it/i);
      /* And in the channel the product already uses for an unread opening time. */
      expect(
        itinerary.issues.some(
          (issue) =>
            issue.code === 'food_hours_unverified' &&
            issue.severity === 'warning' &&
            issue.message.includes(row.food.venueName!),
        ),
        `${row.food.venueName} is named with no hours caution anywhere`,
      ).toBe(true);
    }
    /* Naming an unconfirmed venue is never an error. That was the old refusal. */
    expect(itinerary.issues.filter((issue) => issue.severity === 'error').map((i) => i.code)).not.toContain(
      'food_venue_missing_provenance',
    );
  });

  it('never spends the one meal meant to be an event on a door nobody confirmed', async () => {
    const region = await compileWorld('transit_city');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;
    for (const row of mealRows(days)) {
      if (!row.food.isSpecialMeal) continue;
      expect(row.food.hoursUnknown).toBe(false);
    }
  });

  it('gives every meal it cannot name an area, and every early day a breakfast', async () => {
    const region = await compileWorld('transit_city');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;
    expectNoBareMeal(days);
    expectNoSilentBreakfast(days, true);
    expectNothingFabricated(region, days);
  });

  it('says so at the top rather than reporting held time it no longer has', async () => {
    const region = await compileWorld('transit_city');
    const itinerary = itineraryOf(planThrough(region, travellerFrom()));
    const named = namedRows(mealRows(itinerary.days)).length;
    expect(itinerary.foodPlan.headline).toContain(String(named));
    expect(itinerary.foodPlan.headline).not.toMatch(/every meal below is time held/i);
  });
});

// ---------------------------------------------------------------------------
// 2 — A road region: long legs, three venues in the whole place.
// ---------------------------------------------------------------------------

describe('a road region with long legs and almost nowhere to eat', () => {
  it('is the shape it claims to be — sparse supply, driving distances', async () => {
    const region = await compileWorld('remote_road');
    const venues = region.food?.venues ?? [];
    expect(venues.length).toBeGreaterThan(0);
    expect(venues.length).toBeLessThanOrEqual(4);
  });

  it('names where the route genuinely passes a door, and says where it does not', async () => {
    const region = await compileWorld('remote_road');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;
    const rows = mealRows(days);

    /*
     * Both halves, on one trip. A rule that only ever names is the fabrication
     * this suite is guarding against, and a rule that only ever falls back is
     * the defect it was written for — so the finding is that the same plan does
     * each where each is right.
     */
    expect(namedRows(rows).length, 'nothing was named on a region that has venues').toBeGreaterThan(0);
    expect(
      unnamedRows(rows).length,
      'every meal was named on a region with three venues and hours nobody confirmed',
    ).toBeGreaterThan(0);

    expectNoBareMeal(days);
    expectNoSilentBreakfast(days, true);
    expectNothingFabricated(region, days);
  });

  it('counts what our index holds rather than what the neighbourhood has', async () => {
    const region = await compileWorld('remote_road');
    const days = itineraryOf(planThrough(region, travellerFrom())).days;
    const held = (region.food?.venues ?? []).length;

    for (const row of unnamedRows(mealRows(days))) {
      const claimed = row.item.reason.match(/^(\d+) place/);
      if (!claimed) {
        /* The zero case says nothing is held, and names no number at all. */
        expect(row.item.reason).toMatch(/we hold nothing serving/i);
        continue;
      }
      /*
       * A count larger than the region holds would be the same overreach as an
       * invented venue, in a unit that looks harder to check.
       */
      expect(Number(claimed[1])).toBeLessThanOrEqual(held);
      expect(row.item.reason).toMatch(/we hold within reach of/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — A destination with no food evidence at all.
// ---------------------------------------------------------------------------

describe('a destination where we found nothing to eat at all', () => {
  it('is genuinely empty, so the refusal below means something', async () => {
    const region = await compileWorld('weak_data');
    expect(region.food?.venues ?? []).toHaveLength(0);
  });

  it('refuses to name a place, and refuses to invent an area instead', async () => {
    const region = await compileWorld('weak_data');
    const itinerary = itineraryOf(planThrough(region, travellerFrom()));
    const rows = mealRows(itinerary.days);

    expect(rows.length, 'a trip with no food data still holds time for meals').toBeGreaterThan(0);
    expect(namedRows(rows)).toHaveLength(0);
    for (const row of rows) {
      /*
       * The regression this guards: an area fallback that fires on absence would
       * turn "we know nothing about eating here" into a confident neighbourhood,
       * which is a worse claim than the bare hour it replaced.
       */
      expect(row.food.areaName, `day ${row.day.dayNumber} invented somewhere to eat`).toBeUndefined();
      expect(row.item.title).not.toMatch(/ around /);
    }

    expect(itinerary.foodPlan.headline).toMatch(/no food data for this region/i);
    expect(itinerary.issues.map((issue) => issue.code)).toContain('food_data_unavailable');
    expectNothingFabricated(region, itinerary.days);
  });
});
