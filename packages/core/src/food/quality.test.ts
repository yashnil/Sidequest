import { describe, expect, it } from 'vitest';
import { foodVenueSchema, type FoodVenue } from '../schemas/food';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import { foodBoardFor } from './board';
import {
  foodDistinctiveness,
  foodNameCounts,
  mealCharacterOf,
} from './quality';

const AUGUST = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const CONTEXT = { travelerNeeds: [], tripDays: 4 };

/**
 * A venue exactly as a compiled region produces one.
 *
 * Every field here is the compiler's default, and that is the whole point: a
 * `moderate` band inferred from the format, `format_inferred` evidence, unknown
 * hours, no local speciality, no provisioning. Nothing that reads a compiled
 * venue could previously tell one of these from another — which is how a live
 * six-day trip in a city of extraordinary food ended up recommending a
 * franchise pizza counter and showing the traveller no food cards at all.
 */
function compiledVenue(overrides: Partial<FoodVenue> & { id: string; name: string }): FoodVenue {
  return foodVenueSchema.parse({
    regionId: 'compiled-r',
    locality: 'Somewhere',
    shortDescription: 'A restaurant recorded in the place data for Somewhere.',
    coordinates: { lat: 35.6, lng: 139.7 },
    tags: ['places=restaurant'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'dinner'],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 75,
    reservation: { requirement: 'unknown' },
    hours: {
      kind: 'unknown',
      hoursConfidence: 'unverified',
      provenance: {
        kind: 'estimated',
        sourceName: 'Place data',
        confidence: 0.5,
        volatility: 'dynamic',
        recheckNote: 'Check before you go.',
      },
    },
    source: {
      name: 'Place data',
      kind: 'osm',
      confidence: 0.6,
      lastVerified: '2026-01-01',
    },
    routingId: 'base-1',
    ...overrides,
  });
}

/** Four outlets of one name plus two one-offs — a region, in miniature. */
const CHAIN_AND_LOCALS: FoodVenue[] = [
  compiledVenue({ id: 'v1', name: 'Pizza Express' }),
  compiledVenue({ id: 'v2', name: 'Pizza Express' }),
  compiledVenue({ id: 'v3', name: 'Pizza Express' }),
  compiledVenue({ id: 'v4', name: 'Pizza Express' }),
  compiledVenue({ id: 'v5', name: 'Tsukumo Ramen', cuisines: ['ramen'] }),
  compiledVenue({ id: 'v6', name: 'Kanda Yabu Soba', tags: ['places=restaurant', 'attr:wikidata'] }),
];

describe('an outlet does not tie a place people go to', () => {
  it('reads repetition inside the region as what it is', () => {
    const counts = foodNameCounts(CHAIN_AND_LOCALS);
    const chain = foodDistinctiveness(CHAIN_AND_LOCALS[0]!, counts);
    const local = foodDistinctiveness(CHAIN_AND_LOCALS[4]!, counts);

    expect(chain.chainOutlet).toBe(true);
    expect(chain.outletsHere).toBe(4);
    expect(local.chainOutlet).toBe(false);
    /*
     * The regression: before this, every field these two differ on was
     * identical, so a ranking over compiled venues was a coin toss and a live
     * trip lost it.
     */
    expect(local.score).toBeGreaterThan(chain.score);
  });

  it('does not need a brand list to do it', () => {
    /*
     * Nothing in the signal knows a country, a language or a company. Rename
     * every venue and the ordering is unchanged, which is what stops this
     * becoming "chains I have heard of are chains".
     */
    const renamed = CHAIN_AND_LOCALS.map((venue, index) => ({
      ...venue,
      name: index < 4 ? 'Fjölnir Grill' : `Local ${index}`,
    }));
    const counts = foodNameCounts(renamed);
    expect(foodDistinctiveness(renamed[0]!, counts).chainOutlet).toBe(true);
    expect(foodDistinctiveness(renamed[4]!, counts).chainOutlet).toBe(false);
  });

  it('treats an open-knowledge entry as evidence somebody thought it mattered', () => {
    const counts = foodNameCounts(CHAIN_AND_LOCALS);
    expect(foodDistinctiveness(CHAIN_AND_LOCALS[5]!, counts).score).toBeGreaterThan(
      foodDistinctiveness(CHAIN_AND_LOCALS[4]!, counts).score,
    );
  });

  it('never leaves the 0–1 range whatever it is handed', () => {
    const counts = new Map([[ 'x', 40 ]]);
    const extreme = compiledVenue({ id: 'vx', name: 'x', serviceType: 'takeaway' });
    const quality = foodDistinctiveness(extreme, counts);
    expect(quality.score).toBeGreaterThanOrEqual(0);
    expect(quality.score).toBeLessThanOrEqual(1);
  });
});

describe('a compiled region finally has something to put on the food board', () => {
  const foodLover = buildTravelerProfile(
    { ...defaultAnswers(CONTEXT), foodStyle: 'destination', specialMealAppetite: 'one' },
    CONTEXT,
  );

  it('shows the traveller cards where it used to show none', () => {
    /*
     * The verbatim defect. Every rule the board had read a field only an
     * *authored* region ever filled in — a price band above everyday, a local
     * speciality, a provisioning flag — so a compiled dataset scored zero on
     * all of them and the food board was empty while the planner quietly went
     * ahead and picked the meals.
     */
    const entries = foodBoardFor({
      dataset: { version: 1, regionId: 'compiled-r', venues: CHAIN_AND_LOCALS, gaps: [] },
      profile: foodLover,
      dates: AUGUST,
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.why.length > 0)).toBe(true);
  });

  it('does not put a franchise outlet in front of somebody', () => {
    const entries = foodBoardFor({
      dataset: { version: 1, regionId: 'compiled-r', venues: CHAIN_AND_LOCALS, gaps: [] },
      profile: foodLover,
      dates: AUGUST,
    });
    expect(entries.map((entry) => entry.name)).not.toContain('Pizza Express');
  });

  it('leaves somebody who is eating to keep going alone', () => {
    /*
     * A board that lists every restaurant is a form. Only a traveller for whom
     * the meals are part of the point gets asked about ordinary ones.
     */
    const refueller = buildTravelerProfile(
      { ...defaultAnswers(CONTEXT), foodStyle: 'budget', specialMealAppetite: 'none' },
      CONTEXT,
    );
    const entries = foodBoardFor({
      dataset: {
        version: 1,
        regionId: 'compiled-r',
        venues: CHAIN_AND_LOCALS.filter((venue) => venue.name !== 'Pizza Express'),
        gaps: [],
      },
      profile: refueller,
      dates: AUGUST,
    });
    expect(entries).toEqual([]);
  });

  it('offers a market as a thing to do, whoever is asking', () => {
    const market = compiledVenue({
      id: 'vm',
      name: 'Nishiki Market',
      serviceType: 'market',
      mealPeriods: ['lunch', 'groceries'],
      provisioning: 'packed_meals',
      hours: {
        kind: 'scheduled',
        hoursConfidence: 'closing_time_estimated',
        periods: [
          {
            label: 'Daily',
            months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            windows: [{ openMinute: 600, closeMinute: 1080 }],
          },
        ],
        closedAnnualDates: [],
        provenance: {
          kind: 'estimated',
          sourceName: 'Place data',
          confidence: 0.5,
          volatility: 'dynamic',
          recheckNote: 'Check before you go.',
        },
      },
    });
    const entries = foodBoardFor({
      dataset: { version: 1, regionId: 'compiled-r', venues: [market], gaps: [] },
      profile: buildTravelerProfile(defaultAnswers(CONTEXT), CONTEXT),
      dates: AUGUST,
    });
    expect(entries.map((entry) => entry.name)).toContain('Nishiki Market');
  });
});

describe('the seven kinds of food stop §15 asks us to tell apart', () => {
  const everyday = 'moderate' as const;

  it('calls supplies supplies, whatever slot they fill', () => {
    expect(
      mealCharacterOf({
        slot: 'lunch',
        stopKind: 'grocery',
        routeContext: 'at_base',
        isSpecialMeal: false,
        hasLocalSpecialty: false,
        everydayPriceBand: everyday,
      }),
    ).toBe('grocery_snack');
  });

  it('never calls the one occasion an ordinary meal', () => {
    expect(
      mealCharacterOf({
        slot: 'dinner',
        stopKind: 'venue',
        routeContext: 'at_base',
        isSpecialMeal: true,
        priceBand: 'upscale',
        hasLocalSpecialty: false,
        everydayPriceBand: everyday,
      }),
    ).toBe('special_occasion');
  });

  it('separates a stop worth going for from a stop on the way', () => {
    /*
     * The distinction that earns its keep. A plan that cannot make it writes
     * "Lunch" over both a sit-down that is the point of the afternoon and a
     * fifteen-minute bakery on the way to a trailhead, and the traveller has no
     * way to know which one they may skip.
     */
    expect(
      mealCharacterOf({
        slot: 'lunch',
        stopKind: 'venue',
        routeContext: 'on_route',
        isSpecialMeal: false,
        serviceType: 'bakery',
        priceBand: 'budget',
        hasLocalSpecialty: false,
        everydayPriceBand: everyday,
      }),
    ).toBe('quick_fuel');

    expect(
      mealCharacterOf({
        slot: 'dinner',
        stopKind: 'venue',
        routeContext: 'off_route',
        isSpecialMeal: false,
        serviceType: 'restaurant',
        priceBand: 'moderate',
        hasLocalSpecialty: false,
        everydayPriceBand: everyday,
      }),
    ).toBe('destination_meal');

    expect(
      mealCharacterOf({
        slot: 'dinner',
        stopKind: 'venue',
        routeContext: 'on_route',
        isSpecialMeal: false,
        serviceType: 'restaurant',
        priceBand: 'moderate',
        hasLocalSpecialty: false,
        everydayPriceBand: everyday,
      }),
    ).toBe('route_convenient');
  });

  it('lets a local speciality outrank the geometry', () => {
    expect(
      mealCharacterOf({
        slot: 'lunch',
        stopKind: 'venue',
        routeContext: 'on_route',
        isSpecialMeal: false,
        serviceType: 'restaurant',
        priceBand: 'budget',
        hasLocalSpecialty: true,
        everydayPriceBand: everyday,
      }),
    ).toBe('local_speciality');
  });

  it('calls breakfast breakfast', () => {
    expect(
      mealCharacterOf({
        slot: 'breakfast',
        stopKind: 'venue',
        routeContext: 'at_base',
        isSpecialMeal: false,
        serviceType: 'cafe',
        hasLocalSpecialty: false,
        everydayPriceBand: everyday,
      }),
    ).toBe('breakfast_coffee');
  });
});
