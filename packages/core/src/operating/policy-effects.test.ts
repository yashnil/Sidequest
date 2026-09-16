import { describe, expect, it } from 'vitest';
import { OPERATING_TYPES, policyFor } from './model';
import { costDriversFor, densityExpectation, foodExpectation, hotelChangeThresholds, lodgingExpectation } from './policy-effects';

/**
 * V12.1 §38–§43 — the policy has to change something a deterministic check
 * actually does. These are the differences, asserted family by family.
 */

describe('§39 — how full a day should be', () => {
  it('does not read a resort week’s empty afternoon as missing content', () => {
    const resort = densityExpectation(policyFor('resort_stay'));
    expect(resort.freeTimeIsWanted).toBe(true);
    expect(resort.minAnchors).toBe(0);
  });

  it('lets one stage fill a trekking day', () => {
    const trek = densityExpectation(policyFor('multi_day_trek'));
    expect(trek.maxAnchors).toBeLessThanOrEqual(2);
    /* The check that would otherwise call the hardest day of the trip empty. */
    expect(trek.minAnchors).toBeLessThanOrEqual(1);
  });

  it('expects a city day to hold two or three substantial things', () => {
    const city = densityExpectation(policyFor('urban_culture'));
    expect(city.minAnchors).toBeGreaterThanOrEqual(2);
    expect(city.maxAnchors).toBeGreaterThanOrEqual(3);
    expect(city.freeTimeIsWanted).toBe(false);
  });

  it('counts the road itself as part of a driving day', () => {
    const road = densityExpectation(policyFor('self_drive_road_trip'));
    expect(road.minAnchors).toBe(1);
    expect(road.note).toMatch(/road is part of the day/i);
  });

  it('lets two blocks be a full day on a wildlife trip', () => {
    const safari = densityExpectation(policyFor('guided_wildlife'));
    expect(safari.minAnchors).toBeLessThanOrEqual(2);
  });

  it('gives every family a coherent band', () => {
    for (const type of OPERATING_TYPES) {
      const expectation = densityExpectation(policyFor(type));
      expect(expectation.maxAnchors, type).toBeGreaterThanOrEqual(expectation.minAnchors);
      expect(expectation.note.length, type).toBeGreaterThan(0);
    }
  });
});

describe('§40 — what a hotel change costs', () => {
  it('is far stricter on a resort week than on a backpacking route', () => {
    const resort = hotelChangeThresholds(policyFor('resort_stay'));
    const backpacking = hotelChangeThresholds(policyFor('overland_backpacking'));
    expect(resort.strong).toBeLessThan(backpacking.strong);
    expect(backpacking.strong).toBeGreaterThan(0.35);
  });

  it('puts a road trip near where the old fixed threshold was', () => {
    /* The bands were a road trip's all along; the change is that they are no longer everybody's. */
    const road = hotelChangeThresholds(policyFor('self_drive_road_trip'));
    expect(road.strong).toBeGreaterThan(0.25);
    expect(road.strong).toBeLessThan(0.4);
  });

  it('never inverts its own bands', () => {
    for (const type of OPERATING_TYPES) {
      const bands = hotelChangeThresholds(policyFor(type));
      expect(bands.adequate, type).toBeGreaterThan(bands.strong);
      expect(bands.strong, type).toBeGreaterThan(0);
      expect(bands.adequate, type).toBeLessThanOrEqual(1);
    }
  });

  it('says a trek’s camp moves are not hotel changes at all', () => {
    /* `hotelChangeCost: 0.05` — the loosest band there is, because the nights come with the route. */
    expect(hotelChangeThresholds(policyFor('multi_day_trek')).strong).toBeGreaterThan(0.4);
  });
});

describe('§41 — food', () => {
  it('makes meals anchors on a food trip and fuel on a cultural one', () => {
    expect(foodExpectation(policyFor('urban_food_nightlife')).mealsAreAnchors).toBe(true);
    expect(foodExpectation(policyFor('urban_culture')).mealsAreAnchors).toBe(false);
  });

  it('knows when somebody else is feeding the traveller', () => {
    expect(foodExpectation(policyFor('multi_day_trek')).cateredByOperator).toBe(true);
    expect(foodExpectation(policyFor('guided_wildlife')).cateredByOperator).toBe(true);
    expect(foodExpectation(policyFor('resort_stay')).cateredByOperator).toBe(true);
  });

  it('asks for supplies rather than tables where services are thin', () => {
    expect(foodExpectation(policyFor('self_drive_road_trip')).selfSupplied).toBe(true);
    expect(foodExpectation(policyFor('remote_overland')).selfSupplied).toBe(true);
  });

  it('never both caters and self-supplies', () => {
    for (const type of OPERATING_TYPES) {
      const food = foodExpectation(policyFor(type));
      expect(food.cateredByOperator && food.selfSupplied, type).toBe(false);
    }
  });
});

describe('§42 — lodging', () => {
  it('names what actually decides where to sleep', () => {
    expect(lodgingExpectation(policyFor('urban_culture')).decidedBy).toBe('neighbourhood');
    expect(lodgingExpectation(policyFor('overland_backpacking')).decidedBy).toBe('price and company');
    expect(lodgingExpectation(policyFor('resort_stay')).decidedBy).toBe('the property itself');
    expect(lodgingExpectation(policyFor('guided_wildlife')).decidedBy).toBe('access');
  });

  it('knows a trek’s nights are not the traveller’s to book', () => {
    expect(lodgingExpectation(policyFor('multi_day_trek')).bookedBy).toBe('operator');
    expect(lodgingExpectation(policyFor('urban_culture')).bookedBy).toBe('traveler');
  });
});

describe('§43 — what actually costs money', () => {
  it('leads with the right thing for each family', () => {
    expect(costDriversFor('resort_stay')[0]?.key).toBe('property');
    expect(costDriversFor('multi_day_trek')[0]?.key).toBe('operator');
    expect(costDriversFor('overland_backpacking')[0]?.key).toBe('intercity_transport');
    expect(costDriversFor('guided_wildlife')[0]?.key).toBe('lodge');
    expect(costDriversFor('island_hopping').map((driver) => driver.key)).toContain('crossings');
    expect(costDriversFor('rail_journey').map((driver) => driver.key)).toContain('rail');
  });

  it('describes a whole budget for every family, heaviest first', () => {
    for (const type of OPERATING_TYPES) {
      const drivers = costDriversFor(type);
      expect(drivers.length, type).toBeGreaterThanOrEqual(3);
      const total = drivers.reduce((sum, driver) => sum + driver.share, 0);
      expect(total, `${type} shares sum to ${total}`).toBeCloseTo(1, 2);
      expect(drivers[0]!.share, type).toBeGreaterThanOrEqual(drivers[drivers.length - 1]!.share);
      for (const driver of drivers) expect(driver.label.length, `${type}/${driver.key}`).toBeGreaterThan(0);
    }
  });

  it('never quotes a price', () => {
    for (const type of OPERATING_TYPES) {
      for (const driver of costDriversFor(type)) {
        expect(driver.label).not.toMatch(/[$€£¥]|\d/);
      }
    }
  });
});
