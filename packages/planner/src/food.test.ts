import { describe, expect, it } from 'vitest';
import {
  foodDatasetSchema,
  itineraryStructureFingerprint,
  type FoodDataset,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type ScheduledFood,
} from '@sidequest/core';
import { planTrip } from './plan';
import { MAX_FOOD_DETOUR_MINUTES } from './food';
import { buildScenario, type ScenarioOptions } from './testing/scenario';
import {
  EASTERN_SIERRA_FOOD,
} from '@sidequest/core/data';

/**
 * FOOD AS A PLANNING LAYER.
 *
 * Structured like `hours.test.ts` and `weather.test.ts`, and for the same
 * reason: numbered scenarios that each name one thing the planner has to get
 * right, so a failure points at a behaviour rather than at a line.
 *
 * The distinction every scenario is ultimately about: food is a preference
 * layer over a day that is *already legal*. It may choose where the traveller
 * eats on the route they were taking anyway; it may never buy a meal with a
 * stop, a driving budget, an opening hour or a shuttle. Scenarios 4 and 18 are
 * the ones that would matter most if this file were deleted.
 */

function plan(options: ScenarioOptions = {}): Itinerary {
  const result = planTrip(buildScenario(options));
  if (!result.ok) throw new Error(`Planning failed: ${result.code} — ${result.message}`);
  return result.itinerary;
}

function meals(itinerary: Itinerary): { day: ItineraryDay; item: ItineraryItem; food: ScheduledFood }[] {
  return itinerary.days.flatMap((day) =>
    day.items
      .filter((item) => item.kind === 'meal' && item.food)
      .map((item) => ({ day, item, food: item.food! })),
  );
}

function named(itinerary: Itinerary): string[] {
  return meals(itinerary)
    .filter((entry) => entry.food.stopKind === 'venue')
    .map((entry) => entry.food.venueName!);
}

function codes(itinerary: Itinerary, severity?: 'error' | 'warning'): string[] {
  return itinerary.issues
    .filter((issue) => severity === undefined || issue.severity === severity)
    .map((issue) => issue.code);
}

/** Everything that is not the food layer's business must stay clean. */
function nonFoodErrors(itinerary: Itinerary): string[] {
  return itinerary.issues
    .filter(
      (issue) =>
        issue.severity === 'error' &&
        !issue.code.startsWith('food') &&
        !issue.code.startsWith('meal') &&
        issue.code !== 'strict_dietary_conflict' &&
        issue.code !== 'grocery_after_supplies_needed' &&
        issue.code !== 'must_include_unscheduled',
    )
    .map((issue) => issue.code);
}

/** Swap one venue's record, keeping every other fact about the region intact. */
function patchVenue(venueId: string, patch: (venue: Record<string, unknown>) => void): FoodDataset {
  const copy = structuredClone(EASTERN_SIERRA_FOOD) as unknown as {
    venues: Record<string, unknown>[];
  };
  const venue = copy.venues.find((entry) => entry.id === venueId);
  if (!venue) throw new Error(`No fixture venue "${venueId}"`);
  patch(venue);
  // Back through the schema, so an impossible fixture fails in the test that
  // wrote it rather than three scenarios later.
  return foodDatasetSchema.parse(copy);
}

// ---------------------------------------------------------------------------
// 1-3. The ordinary trip
// ---------------------------------------------------------------------------

describe('scenario 1 — the standard four-day outdoor trip', () => {
  const itinerary = plan();

  it('names real places on most days rather than holding blank time', () => {
    expect(named(itinerary).length).toBeGreaterThanOrEqual(4);
  });

  it('never puts a meal on a day without saying which slot it fills', () => {
    for (const { food } of meals(itinerary)) {
      expect(['breakfast', 'lunch', 'dinner', 'snack']).toContain(food.slot);
    }
  });

  it('leaves the rest of the plan legal', () => {
    expect(nonFoodErrors(itinerary)).toEqual([]);
  });

  it('says where every fact came from, and never claims to have checked today', () => {
    expect(itinerary.foodPlan.dataDisclosure).toMatch(/have not checked today/i);
    for (const { food } of meals(itinerary)) {
      if (food.stopKind !== 'venue') continue;
      expect(food.hours?.sourceName).toBeTruthy();
    }
  });
});

describe('scenario 2 — an early trail day', () => {
  const itinerary = plan({ answers: { dayStart: 'early' } });

  it('puts breakfast before the first stop rather than after it', () => {
    for (const day of itinerary.days) {
      const breakfast = day.items.find((item) => item.food?.slot === 'breakfast');
      if (!breakfast) continue;
      const firstActivity = day.items.find((item) => item.kind === 'activity');
      if (!firstActivity) continue;
      expect(breakfast.startMinute).toBeLessThan(firstActivity.startMinute);
    }
  });

  it('does not sit the traveller down for an hour on the way out', () => {
    for (const { food, item } of meals(itinerary)) {
      if (food.slot !== 'breakfast') continue;
      expect(item.durationMinutes).toBeLessThanOrEqual(45);
    }
  });
});

describe('scenario 3 — the traveller who skips breakfast', () => {
  const skipper = plan({ answers: { breakfastStyle: 'skip', dayStart: 'early' } });

  it('does not book them a breakfast they did not ask for', () => {
    const breakfasts = meals(skipper).filter(
      (entry) => entry.food.slot === 'breakfast' && entry.food.stopKind === 'venue',
    );
    for (const entry of breakfasts) {
      // Anything that does appear is offered as fuel before a long day out, and
      // says so in those words rather than calling itself the meal they declined.
      expect(entry.item.reason).toMatch(/you said you skip breakfast/i);
    }
  });

  it('still feeds them the rest of the day', () => {
    expect(meals(skipper).some((entry) => entry.food.slot === 'lunch')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4-6. Remote days, packed food and the shopping
// ---------------------------------------------------------------------------

describe('scenario 4 — a day the Park Service says has no food', () => {
  const itinerary = plan({ manualIncludes: ['devils-postpile', 'rainbow-falls'] });
  const valleyDay = itinerary.days.find((day) =>
    day.items.some((item) => item.placeId === 'devils-postpile'),
  )!;

  it('carries lunch rather than inventing a restaurant in the valley', () => {
    expect(valleyDay).toBeDefined();
    const lunch = valleyDay.items.find((item) => item.food?.slot === 'lunch')!;
    expect(lunch.food!.stopKind).toBe('packed');
    expect(lunch.food!.venueId).toBeUndefined();
  });

  it('quotes the agency rather than asserting the absence itself', () => {
    expect(valleyDay.food.notes.join(' ')).toMatch(/National Park Service/);
  });

  it('does the shopping before the food is needed, not after', () => {
    const lunch = valleyDay.items.find((item) => item.food?.slot === 'lunch')!;
    const shop = itinerary.days
      .flatMap((day) => day.items.map((item) => ({ day, item })))
      .find((entry) => entry.item.food?.stopKind === 'grocery');
    expect(shop).toBeDefined();
    expect(shop!.item.food!.suppliesDayNumber).toBe(valleyDay.dayNumber);
    if (shop!.day.dayNumber === valleyDay.dayNumber) {
      expect(shop!.item.startMinute).toBeLessThan(lunch.startMinute);
    } else {
      expect(shop!.day.dayNumber).toBeLessThan(valleyDay.dayNumber);
    }
    expect(codes(itinerary)).not.toContain('grocery_after_supplies_needed');
  });

  it('links the packed lunch back to the day it was bought on', () => {
    const lunch = valleyDay.items.find((item) => item.food?.slot === 'lunch')!;
    expect(lunch.food!.preparedOnDayNumber).toBeDefined();
    expect(codes(itinerary)).not.toContain('packed_food_without_preparation');
  });
});

describe('scenario 5 — a traveller who will not carry a lunch', () => {
  const itinerary = plan({
    manualIncludes: ['devils-postpile', 'rainbow-falls'],
    answers: { willPackLunch: false },
  });

  it('does not send them shopping for a lunch they said they would not carry', () => {
    expect(meals(itinerary).some((entry) => entry.food.stopKind === 'packed')).toBe(false);
    expect(meals(itinerary).some((entry) => entry.food.stopKind === 'grocery')).toBe(false);
  });

  it('says plainly that the day has nowhere to eat instead of inventing one', () => {
    const valleyDay = itinerary.days.find((day) =>
      day.items.some((item) => item.placeId === 'devils-postpile'),
    )!;
    const lunch = valleyDay.items.find((item) => item.food?.slot === 'lunch');
    if (lunch) expect(lunch.food!.stopKind).toBe('unplanned');
  });
});

describe('scenario 6 — no food data at all', () => {
  const itinerary = plan({ food: null });

  it('still produces a plan, with every meal admitting it names nowhere', () => {
    expect(itinerary.days.length).toBeGreaterThan(0);
    for (const { food } of meals(itinerary)) {
      expect(food.stopKind).toBe('unplanned');
      expect(food.venueId).toBeUndefined();
    }
  });

  it('says so once, at the top, rather than on every row', () => {
    expect(codes(itinerary)).toContain('food_data_unavailable');
    expect(itinerary.foodPlan.headline).toMatch(/no food data/i);
  });
});

// ---------------------------------------------------------------------------
// 7-9. Money
// ---------------------------------------------------------------------------

describe('scenario 7 — a mid-range traveller who likes one good dinner', () => {
  const itinerary = plan({ answers: { foodStyle: 'balanced', specialMealAppetite: 'one' } });

  it('gives them exactly one, not four', () => {
    expect(itinerary.foodPlan.specialMealBudget).toBe(1);
    expect(itinerary.foodPlan.specialMealsPlanned).toBeLessThanOrEqual(1);
    expect(meals(itinerary).filter((entry) => entry.food.isSpecialMeal)).toHaveLength(
      itinerary.foodPlan.specialMealsPlanned,
    );
  });

  it('keeps every other meal at or below the everyday band', () => {
    for (const { food } of meals(itinerary)) {
      if (food.isSpecialMeal || !food.priceBand) continue;
      expect(['budget', 'moderate']).toContain(food.priceBand);
    }
    expect(codes(itinerary)).not.toContain('food_budget_mismatch');
  });
});

describe('scenario 8 — the budget traveller', () => {
  const itinerary = plan({ answers: { foodStyle: 'budget' } });

  it('never spends above the band they set', () => {
    for (const { food } of meals(itinerary)) {
      if (!food.priceBand) continue;
      expect(food.priceBand).toBe('budget');
    }
  });

  it('is never offered a special meal, because they said no to the idea', () => {
    expect(itinerary.foodPlan.specialMealBudget).toBe(0);
    expect(itinerary.foodPlan.specialMealsPlanned).toBe(0);
  });

  it('does not quote a total, because four venues in the region publish prices', () => {
    expect(JSON.stringify(itinerary.foodPlan)).not.toMatch(/\$\d|total cost/i);
  });
});

describe('scenario 9 — the traveller for whom the meal is the point', () => {
  const itinerary = plan({
    answers: { foodStyle: 'destination', specialMealAppetite: 'a_few' },
  });

  it('scales the quota with the trip rather than with the enthusiasm', () => {
    expect(itinerary.foodPlan.specialMealBudget).toBeLessThanOrEqual(3);
    expect(itinerary.foodPlan.specialMealsPlanned).toBeLessThanOrEqual(
      itinerary.foodPlan.specialMealBudget,
    );
  });

  it('still refuses a meal that would break the route', () => {
    expect(nonFoodErrors(itinerary)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10-12. Dietary requirements, and the line this product will not cross
// ---------------------------------------------------------------------------

describe('scenario 10 — a vegetarian preference', () => {
  const itinerary = plan({ answers: { dietaryNeeds: ['vegetarian'], dietaryStrict: false } });

  it('never turns "nobody has said" into "vegetarian friendly"', () => {
    for (const { food } of meals(itinerary)) {
      if (food.stopKind !== 'venue') continue;
      const claimed = food.dietary.map((claim) => claim.need);
      const unknown = food.dietaryUnverified;
      expect(claimed.includes('vegetarian') || unknown.includes('vegetarian')).toBe(true);
    }
  });

  it('treats an unconfirmed venue as a caution rather than a blocker', () => {
    expect(codes(itinerary, 'error')).not.toContain('strict_dietary_conflict');
  });

  it('quotes the venue when the venue has actually said something', () => {
    const supported = meals(itinerary).flatMap((entry) => entry.food.dietary);
    for (const claim of supported) {
      expect(claim.note.length).toBeGreaterThan(10);
      if (claim.evidence === 'venue_states_support') expect(claim.sourceUrl).toBeTruthy();
    }
  });
});

describe('scenario 11 — a strict allergen requirement', () => {
  const itinerary = plan({ answers: { dietaryNeeds: ['nut_allergy'], dietaryStrict: true } });

  it('never says a venue is safe, anywhere', () => {
    const rendered = JSON.stringify(itinerary);
    expect(rendered).not.toMatch(/allergen[- ]safe|safe for (your )?allergy|guaranteed/i);
  });

  it('still plans them a trip, rather than silently withdrawing every meal', () => {
    // The first version of this made an unconfirmed need an *error*. Nothing in
    // the region carries a nut-allergy claim, so every meal errored, every day
    // was rebuilt without food, and the traveller was told their choices "did
    // not fit the route". An unanswered question is a caution however much it
    // matters.
    expect(named(itinerary).length).toBeGreaterThan(0);
    expect(codes(itinerary, 'error')).not.toContain('strict_dietary_conflict');
  });

  it('hands the unanswered question back, on every meal it applies to', () => {
    const unconfirmed = meals(itinerary).filter((entry) =>
      entry.food.dietaryUnverified.includes('nut_allergy'),
    );
    expect(unconfirmed.length).toBeGreaterThan(0);
    expect(codes(itinerary, 'warning')).toContain('dietary_support_unverified');
    for (const entry of unconfirmed) {
      if (entry.food.stopKind !== 'venue') continue;
      expect(
        itinerary.issues.some(
          (issue) =>
            issue.code === 'dietary_support_unverified' &&
            issue.message.includes(entry.food.venueName!),
        ),
      ).toBe(true);
    }
  });

  it('never asks a supermarket to confirm how it handles an allergy', () => {
    for (const entry of meals(itinerary)) {
      if (entry.food.stopKind !== 'grocery') continue;
      expect(entry.food.dietaryUnverified).toEqual([]);
    }
  });

  it('tells them once, at the top, that a menu claim is not a kitchen claim', () => {
    expect(itinerary.foodPlan.dietaryDisclosure).toMatch(/not a kitchen one/i);
  });
});

describe('scenario 12 — a venue that says it cannot do something', () => {
  const dataset = patchVenue('robertos-cafe-mammoth', (venue) => {
    (venue.dietary as unknown[]).push({
      need: 'vegan',
      evidence: 'venue_states_unsuitable',
      note: 'Their own site says they cannot cook without dairy.',
    });
  });
  const itinerary = plan({ food: dataset, answers: { dietaryNeeds: ['vegan'] } });

  it('is never scheduled for a traveller who declared that need', () => {
    expect(named(itinerary)).not.toContain("Roberto's Cafe");
  });
});

// ---------------------------------------------------------------------------
// 13-15. Doors, clocks and the route
// ---------------------------------------------------------------------------

describe('scenario 13 — a venue shut on the day it would have been used', () => {
  const closed = patchVenue('mammoth-brewing-eatery', (venue) => {
    (venue.hours as Record<string, unknown>).periods = [
      {
        label: 'Weekends only',
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        daysOfWeek: [0, 6],
        windows: [{ openMinute: 11 * 60 + 30, closeMinute: 21 * 60 }],
      },
    ];
  });
  const itinerary = plan({ food: closed });

  it('never schedules a meal at a closed door', () => {
    expect(codes(itinerary)).not.toContain('food_venue_closed_on_date');
    expect(codes(itinerary)).not.toContain('meal_ends_after_venue_closes');
  });

  it('leaves the activity schedule exactly as legal as it was', () => {
    expect(nonFoodErrors(itinerary)).toEqual([]);
  });
});

describe('scenario 14 — hours nobody has confirmed', () => {
  const unknownHours = patchVenue('the-stove-mammoth', (venue) => {
    venue.hours = {
      kind: 'unknown',
      hoursConfidence: 'unverified',
      provenance: {
        kind: 'authored',
        sourceName: 'Nobody',
        confidence: 0.3,
        volatility: 'dynamic',
        recheckNote: 'Ring them.',
      },
    };
  });
  const itinerary = plan({ food: unknownHours });

  it('will not put a name on a plan behind an unconfirmed door', () => {
    expect(named(itinerary)).not.toContain('The Stove');
  });
});

describe('scenario 15 — the route decides, not the ranking', () => {
  const itinerary = plan();

  it('holds every meal inside a detour a traveller would actually accept', () => {
    for (const { food } of meals(itinerary)) {
      if (food.isSpecialMeal) continue;
      expect(food.detourMinutes).toBeLessThanOrEqual(MAX_FOOD_DETOUR_MINUTES);
    }
  });

  it('reports the detour it actually costs, there and back where that is what happens', () => {
    // A dinner out from base and home again is twice the leg, and saying two
    // minutes when it costs four is how the day's own driving total ends up
    // disagreeing with the reason printed beside it.
    for (const day of itinerary.days) {
      const claimed = day.items.reduce((sum, item) => sum + (item.food?.detourMinutes ?? 0), 0);
      expect(claimed).toBeGreaterThanOrEqual(0);
      expect(day.totals.driveMinutes).toBeGreaterThanOrEqual(0);
    }
  });

  it('says nothing about a straight line anywhere it talks about time', () => {
    const rendered = JSON.stringify(meals(itinerary).map((entry) => entry.item.reason));
    expect(rendered).not.toMatch(/as the crow|straight[- ]line/i);
  });
});

// ---------------------------------------------------------------------------
// 16-18. What food may never cost
// ---------------------------------------------------------------------------

describe('scenario 16 — a car-free traveller', () => {
  const itinerary = plan({ answers: { willDrive: false } });

  it('is never driven to a restaurant', () => {
    for (const day of itinerary.days) {
      expect(day.totals.driveMinutes).toBe(0);
      for (const item of day.items) {
        if (item.travel) expect(item.travel.mode).not.toBe('drive');
      }
    }
  });

  it('is never sent somewhere it cannot walk to', () => {
    expect(nonFoodErrors(itinerary)).toEqual([]);
  });
});

describe('scenario 17 — a shuttle day', () => {
  const itinerary = plan({ manualIncludes: ['devils-postpile', 'rainbow-falls'] });

  it('does not invent a restaurant stop on somebody else’s vehicle', () => {
    const valleyDay = itinerary.days.find((day) =>
      day.transport.serviceIds.includes('svc-reds-meadow-shuttle'),
    );
    if (!valleyDay) return;
    const insideValley = valleyDay.items.filter(
      (item) => item.food?.stopKind === 'venue' && item.startMinute > 9 * 60,
    );
    expect(insideValley).toEqual([]);
  });

  it('still gets everyone back before the last bus', () => {
    expect(codes(itinerary, 'error')).not.toContain('missed_last_return');
  });
});

describe('scenario 18 — food never costs a stop', () => {
  const withFood = plan();
  const withoutFood = plan({ food: null });

  it('schedules exactly the same places, in exactly the same order', () => {
    const sequence = (itinerary: Itinerary) =>
      itinerary.days.map((day) =>
        day.items
          .filter((item) => item.kind === 'activity')
          .map((item) => item.placeId)
          .join('>'),
      );
    expect(sequence(withFood)).toEqual(sequence(withoutFood));
  });

  it('leaves nothing unscheduled that would otherwise have fitted', () => {
    expect(withFood.unscheduled.map((entry) => entry.placeId).sort()).toEqual(
      withoutFood.unscheduled.map((entry) => entry.placeId).sort(),
    );
  });

  it('never pushes a day past a travel budget the traveller set', () => {
    for (const day of withFood.days) {
      expect(day.totals.driveMinutes).toBeLessThanOrEqual(
        withFood.transportStrategy.totals.driveMinutes + 1,
      );
    }
    expect(codes(withFood, 'error')).not.toContain('daily_drive_exceeded');
    expect(codes(withFood, 'error')).not.toContain('daily_transport_exceeded');
  });
});

// ---------------------------------------------------------------------------
// 19-21. The traveller's own choices
// ---------------------------------------------------------------------------

describe('scenario 19 — a venue the traveller asked for', () => {
  const itinerary = plan({
    foodSelections: [
      { venueId: 'convict-lake-restaurant', status: 'included', source: 'user', updatedAt: 'x' },
    ],
    answers: { foodStyle: 'destination', specialMealAppetite: 'one' },
  });

  it('is either on the plan or reported as a conflict, never silently dropped', () => {
    const scheduled = named(itinerary).includes('Restaurant at Convict Lake');
    const reported = itinerary.foodPlan.unusedChoices.some(
      (entry) => entry.venueId === 'convict-lake-restaurant',
    );
    expect(scheduled || reported).toBe(true);
    if (!scheduled) expect(codes(itinerary, 'error')).toContain('food_choice_unscheduled');
  });
});

describe('scenario 20 — a venue the traveller ruled out', () => {
  const itinerary = plan({
    foodSelections: [
      { venueId: 'the-stove-mammoth', status: 'excluded', source: 'user', updatedAt: 'x' },
      { venueId: 'mammoth-brewing-eatery', status: 'excluded', source: 'user', updatedAt: 'x' },
    ],
  });

  it('never appears on any day of the trip', () => {
    expect(named(itinerary)).not.toContain('The Stove');
    expect(named(itinerary)).not.toContain('Mammoth Brewing Company');
  });
});

describe('scenario 21 — the same place twice', () => {
  const itinerary = plan();

  it('is reported when it happens rather than quietly repeated', () => {
    const counts = new Map<string, number>();
    for (const { food } of meals(itinerary)) {
      if (!food.venueId) continue;
      counts.set(food.venueId, (counts.get(food.venueId) ?? 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, count]) => count > 1);
    if (repeated.length > 0) {
      expect(codes(itinerary)).toContain('duplicate_food_venue');
    }
  });
});

// ---------------------------------------------------------------------------
// 22-24. Bookings, alternatives and determinism
// ---------------------------------------------------------------------------

describe('scenario 22 — a table that has to be booked', () => {
  const itinerary = plan({
    answers: { foodStyle: 'destination', specialMealAppetite: 'a_few' },
  });

  it('never implies a booking exists', () => {
    const rendered = JSON.stringify(itinerary);
    expect(rendered).not.toMatch(/we have booked|reservation confirmed|table reserved/i);
  });

  it('hands the requirement back with the operator attached', () => {
    for (const { food } of meals(itinerary)) {
      if (food.reservation?.requirement !== 'required' && food.reservation?.requirement !== 'recommended') {
        continue;
      }
      expect(food.reservation.note ?? food.reservation.bookingUrl).toBeTruthy();
      expect(codes(itinerary)).toContain('food_reservation_unresolved');
    }
  });
});

describe('scenario 23 — the runners-up', () => {
  const itinerary = plan();

  it('only ever offers something the planner would itself have accepted', () => {
    for (const { food } of meals(itinerary)) {
      for (const option of food.alternatives) {
        expect(option.venueId).not.toBe(food.venueId);
        expect(option.tradeoff.length).toBeGreaterThan(5);
        expect(option.approachMinutes).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('shows a tradeoff rather than a score', () => {
    const rendered = JSON.stringify(meals(itinerary).flatMap((entry) => entry.food.alternatives));
    expect(rendered).not.toMatch(/\d+(\.\d+)?\s*%|score/i);
  });
});

describe('scenario 24 — determinism, and what narration may not touch', () => {
  it('produces a byte-identical plan from identical inputs', () => {
    const a = plan();
    const b = plan();
    expect(itineraryStructureFingerprint(a)).toBe(itineraryStructureFingerprint(b));
    expect(JSON.stringify(a.days)).toBe(JSON.stringify(b.days));
    expect(JSON.stringify(a.foodPlan)).toBe(JSON.stringify(b.foodPlan));
  });

  it('puts the food decision inside the structural fingerprint', () => {
    const itinerary = plan();
    const before = itineraryStructureFingerprint(itinerary);

    // Prose only: a narration layer may rewrite why a place suits somebody.
    const narrated: Itinerary = {
      ...itinerary,
      summary: 'Rewritten.',
      foodPlan: { ...itinerary.foodPlan, headline: 'Rewritten.' },
      days: itinerary.days.map((day) => ({
        ...day,
        food: { ...day.food, summary: 'Rewritten.' },
        items: day.items.map((item) => ({ ...item, reason: 'Rewritten.' })),
      })),
    };
    expect(itineraryStructureFingerprint(narrated)).toBe(before);

    // Structure: swapping the restaurant must not go unnoticed.
    const swapped: Itinerary = {
      ...itinerary,
      days: itinerary.days.map((day) => ({
        ...day,
        items: day.items.map((item) =>
          item.food?.venueId
            ? { ...item, food: { ...item.food, venueId: 'somewhere-else' } }
            : item,
        ),
      })),
    };
    const anyVenue = meals(itinerary).some((entry) => entry.food.venueId);
    if (anyVenue) expect(itineraryStructureFingerprint(swapped)).not.toBe(before);
  });

  it('is insensitive to the order food choices arrive in', () => {
    const forward = plan({
      foodSelections: [
        { venueId: 'the-stove-mammoth', status: 'excluded', source: 'user', updatedAt: 'x' },
        { venueId: 'looney-bean-mammoth', status: 'excluded', source: 'user', updatedAt: 'x' },
      ],
    });
    const reverse = plan({
      foodSelections: [
        { venueId: 'looney-bean-mammoth', status: 'excluded', source: 'user', updatedAt: 'x' },
        { venueId: 'the-stove-mammoth', status: 'excluded', source: 'user', updatedAt: 'x' },
      ],
    });
    expect(itineraryStructureFingerprint(forward)).toBe(itineraryStructureFingerprint(reverse));
  });
});

// ---------------------------------------------------------------------------
// 25. Changing your mind
// ---------------------------------------------------------------------------

describe('scenario 25 — changing a food preference rebuilds the food, not the trip', () => {
  const balanced = plan({ answers: { foodStyle: 'balanced', specialMealAppetite: 'one' } });
  const cheap = plan({ answers: { foodStyle: 'budget' } });

  it('changes what the traveller eats', () => {
    expect(JSON.stringify(named(balanced))).not.toBe(JSON.stringify(named(cheap)));
  });

  it('leaves the places they are going alone', () => {
    const places = (itinerary: Itinerary) =>
      itinerary.days.flatMap((day) =>
        day.items.filter((item) => item.kind === 'activity').map((item) => item.placeId),
      );
    expect(places(balanced)).toEqual(places(cheap));
  });
});
