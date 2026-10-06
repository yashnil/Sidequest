import { describe, expect, it } from 'vitest';
import { buildBudgetIntelligence, priceLevelFor, type BudgetInput, type FxRate } from './budget';
import { PRICE_LEVELS, PRICE_LEVEL_SOURCE } from './reference/price-levels';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import type { TravelerProfile } from '../schemas/profile';

/**
 * V1 CONVERGENCE §20.9 — A BUDGET THAT KNOWS WHERE IT IS AND WHAT CURRENCY IT IS IN.
 *
 * Before: one set of US-calibrated bands everywhere (a night in Zurich cost what
 * a night in Hanoi cost), and a euro envelope turned dollar figures into "EUR"
 * by changing the label.
 */
function profileWith(patch: { specialMealBudget?: number; envelope?: { amount: number; currency: string; basis: 'per_person_per_day' | 'per_person_trip' | 'group_trip' } } = {}): TravelerProfile {
  const base = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 7 }), { travelerNeeds: [], tripDays: 7 });
  return {
    ...base,
    food: { ...base.food, ...(patch.specialMealBudget !== undefined ? { specialMealBudget: patch.specialMealBudget } : {}) },
    interview: { ...base.interview, ...(patch.envelope ? { budgetEnvelope: patch.envelope } : { budgetEnvelope: undefined }) },
  };
}

function input(overrides: Partial<BudgetInput> & { days?: number; primaryMode?: string; driveKm?: number } = {}): BudgetInput {
  const { days = 7, primaryMode = 'rail', driveKm = 0, ...rest } = overrides;
  return {
    itinerary: {
      days: Array.from({ length: days }, (_, index) => ({ dayNumber: index + 1, items: [], weather: {} })),
      transportStrategy: { primaryMode, totals: { driveKm } },
    },
    pkg: { episodes: [], bases: [], anchors: [] },
    profile: profileWith(),
    travellers: 2,
    party: { adults: 2, children: 0 },
    international: 'yes',
    permitCount: 0,
    guideDays: 0,
    legs: [],
    booked: [],
    ...rest,
  } as unknown as BudgetInput;
}

const line = (b: ReturnType<typeof buildBudgetIntelligence>, category: string) => b.lines.find((l) => l.category === category);

describe('the destination price level comes from the sourced table', () => {
  it('carries its source, indicator and dates', () => {
    expect(PRICE_LEVEL_SOURCE.url).toMatch(/^https:\/\/api\.worldbank\.org\//);
    expect(PRICE_LEVEL_SOURCE.indicators.consumption).toContain('PA.NUS.PRVT.PP');
    expect(PRICE_LEVEL_SOURCE.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(PRICE_LEVELS).length).toBe(PRICE_LEVEL_SOURCE.countries);
    expect(PRICE_LEVELS.US?.c).toBe(1);
  });

  it('returns nothing for a country with no published level, never 1.0', () => {
    expect(priceLevelFor('TW')).toBeNull();
    expect(priceLevelFor(undefined)).toBeNull();
    expect(priceLevelFor('ch')?.level).toBe(PRICE_LEVELS.CH!.c);
  });
});

describe('Zurich and Hanoi are not the same price', () => {
  const zurich = buildBudgetIntelligence(input({ countryCode: 'CH' }));
  const hanoi = buildBudgetIntelligence(input({ countryCode: 'VN' }));
  const expected = PRICE_LEVELS.CH!.c! / PRICE_LEVELS.VN!.c!;

  it('the data itself puts Switzerland well over twice Vietnam', () => {
    expect(expected).toBeGreaterThan(2);
  });

  it('scales lodging and food by the ratio of the two published levels', () => {
    for (const category of ['lodging', 'food']) {
      const ratio = line(zurich, category)!.high / line(hanoi, category)!.high;
      expect(ratio).toBeGreaterThan(2);
      expect(ratio).toBeCloseTo(expected, 1);
    }
    expect(zurich.breakdown!.lodging.high).toBeGreaterThan(2 * hanoi.breakdown!.lodging.high);
  });

  it('does not scale what the local basket does not price (insurance)', () => {
    expect(line(zurich, 'insurance')!.high).toBe(line(hanoi, 'insurance')!.high);
  });

  it('names the level, the year and the source', () => {
    expect(zurich.costIndex?.applied).toBe(true);
    expect(zurich.costIndex?.level).toBe(PRICE_LEVELS.CH!.c);
    expect(zurich.costIndex?.note).toMatch(/World Bank household consumption price level/);
    expect(zurich.costIndex?.note).toMatch(/car hire and fuel/);
    expect(zurich.precisionNote).toMatch(/published price level/);
  });
});

describe('a destination with no index says the bands are not adjusted', () => {
  it('for an unpublished country', () => {
    const b = buildBudgetIntelligence(input({ countryCode: 'TW' }));
    expect(b.costIndex?.applied).toBe(false);
    expect(b.costIndex?.note).toMatch(/Not adjusted for destination prices/);
    expect(b.precisionNote).toMatch(/not adjusted for destination prices/);
  });
  it('for an unknown country', () => {
    const b = buildBudgetIntelligence(input({}));
    expect(b.costIndex?.applied).toBe(false);
    expect(b.costIndex?.note).toMatch(/destination country is not known/);
  });
});

describe('currency: converted with a real rate, never relabelled', () => {
  const euroEnvelope = { amount: 3000, currency: 'EUR', basis: 'per_person_trip' as const };

  it('a non-USD envelope with no rate keeps the figures in USD and says so', () => {
    const usd = buildBudgetIntelligence(input({ countryCode: 'FR' }));
    const b = buildBudgetIntelligence(input({ countryCode: 'FR', profile: profileWith({ envelope: euroEnvelope }) }));
    expect(b.currency).toBe('USD');
    expect(b.lines.every((l) => l.currency === 'USD')).toBe(true);
    expect(b.total).toEqual(usd.total);
    expect(b.conversionNote).toMatch(/US dollars/);
    expect(b.conversionNote).toMatch(/nothing was converted/);
    expect(b.converted).toBeUndefined();
    /* A euro budget is never measured against dollar figures. */
    expect(b.envelope?.fit).toBe('unknown');
    expect(b.envelope?.currency).toBe('EUR');
  });

  it('with a fixture rate the conversion is applied numerically', () => {
    const rate: FxRate = { base: 'USD', quote: 'EUR', rate: 0.92, asOf: '2026-09-01', source: 'fixture' };
    const usd = buildBudgetIntelligence(input({ countryCode: 'FR' }));
    const b = buildBudgetIntelligence(input({ countryCode: 'FR', profile: profileWith({ envelope: euroEnvelope }), rates: [rate] }));
    expect(b.currency).toBe('EUR');
    expect(b.appliedRate).toEqual(rate);
    expect(b.currencyBasis).toBe('traveller_envelope');
    const usdFood = line(usd, 'food')!;
    const eurFood = line(b, 'food')!;
    expect(eurFood.currency).toBe('EUR');
    expect(Math.abs(eurFood.high - usdFood.high * 0.92)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.total.high - usd.total.high * 0.92)).toBeLessThanOrEqual(b.lines.length * 2);
    expect(b.envelope?.fit).not.toBe('unknown');
    expect(b.conversionNote).toMatch(/converted to EUR at the fixture reference rate of 2026-09-01/);
  });

  it('accepts the inverse rate, and never chains through a third currency', () => {
    const inverse: FxRate = { base: 'EUR', quote: 'USD', rate: 1.25, asOf: '2026-09-01', source: 'fixture' };
    const b = buildBudgetIntelligence(input({ profile: profileWith({ envelope: euroEnvelope }), rates: [inverse] }));
    expect(b.currency).toBe('EUR');
    expect(b.appliedRate?.rate).toBeCloseTo(0.8, 6);
    const cross: FxRate = { base: 'GBP', quote: 'EUR', rate: 1.17, asOf: '2026-09-01', source: 'fixture' };
    expect(buildBudgetIntelligence(input({ profile: profileWith({ envelope: euroEnvelope }), rates: [cross] })).currency).toBe('USD');
  });

  it('shows the destination currency as a second view only through a USD rate', () => {
    const jpy: FxRate = { base: 'USD', quote: 'JPY', rate: 149, asOf: '2026-09-01', source: 'fixture' };
    const withRate = buildBudgetIntelligence(input({ countryCode: 'JP', rates: [jpy] }));
    expect(withRate.currency).toBe('USD');
    expect(withRate.displayCurrency).toBe('JPY');
    expect(withRate.converted!.high).toBe(Math.round(withRate.total.high * 149));
    const without = buildBudgetIntelligence(input({ countryCode: 'VN' }));
    expect(without.converted).toBeUndefined();
    expect(without.conversionNote).toMatch(/No VND reference rate was available/);
  });
});

describe('the party, the nights and the way they eat and move scale the budget', () => {
  it('more travellers and more days raise the total', () => {
    const small = buildBudgetIntelligence(input({ countryCode: 'PT' }));
    const bigger = buildBudgetIntelligence(input({ countryCode: 'PT', travellers: 4, party: { adults: 4, children: 0 } }));
    const longer = buildBudgetIntelligence(input({ countryCode: 'PT', days: 14 }));
    expect(bigger.total.high).toBeGreaterThan(small.total.high);
    expect(longer.total.high).toBeGreaterThan(small.total.high);
    /* Four adults need two rooms; two adults one. */
    expect(Math.abs(line(bigger, 'lodging')!.high - 2 * line(small, 'lodging')!.high)).toBeLessThanOrEqual(1);
    expect(line(longer, 'lodging')!.high).toBeGreaterThan(2 * line(small, 'lodging')!.high);
  });

  it('a child shares a room and is banded below an adult for food', () => {
    const adults = buildBudgetIntelligence(input({ countryCode: 'PT', travellers: 3, party: { adults: 3, children: 0 } }));
    const family = buildBudgetIntelligence(input({ countryCode: 'PT', travellers: 3, party: { adults: 2, children: 1 } }));
    expect(line(family, 'lodging')!.high).toBeLessThan(line(adults, 'lodging')!.high);
    expect(family.breakdown!.food.low).toBeLessThan(adults.breakdown!.food.low);
    expect(Math.abs(family.breakdown!.food.high - adults.breakdown!.food.high)).toBeLessThanOrEqual(1);
  });

  it('a premium-dining preference adds only its special meals, not every night', () => {
    const none = buildBudgetIntelligence(input({ countryCode: 'US', profile: profileWith({ specialMealBudget: 0 }) }));
    const two = buildBudgetIntelligence(input({ countryCode: 'US', profile: profileWith({ specialMealBudget: 2 }) }));
    const longNone = buildBudgetIntelligence(input({ countryCode: 'US', days: 14, profile: profileWith({ specialMealBudget: 0 }) }));
    const longTwo = buildBudgetIntelligence(input({ countryCode: 'US', days: 14, profile: profileWith({ specialMealBudget: 2 }) }));
    const extra = line(two, 'food')!.high - line(none, 'food')!.high;
    expect(extra).toBeGreaterThan(0);
    /* The same two meals cost the same on a trip twice as long: the premium is per meal, not per night. */
    expect(Math.abs(line(longTwo, 'food')!.high - line(longNone, 'food')!.high - extra)).toBeLessThanOrEqual(1);
    expect(line(two, 'food')!.basis).toMatch(/2 meals worth booking/);
  });

  it('self-drive adds rental and fuel; transit-first adds transit and no car', () => {
    const drive = buildBudgetIntelligence(input({ countryCode: 'IS', primaryMode: 'drive', driveKm: 900, selfDrives: true }));
    const transit = buildBudgetIntelligence(input({ countryCode: 'IS', primaryMode: 'rail' }));
    expect(line(drive, 'car_fuel_tolls_parking')).toBeDefined();
    expect(line(drive, 'car_fuel_tolls_parking')!.includes).toContain('Fuel');
    expect(line(transit, 'car_fuel_tolls_parking')).toBeUndefined();
    expect(line(transit, 'local_transport')).toBeDefined();
  });

  it('the structured buckets sum to the total', () => {
    const b = buildBudgetIntelligence(input({ countryCode: 'IS', primaryMode: 'drive', driveKm: 900, selfDrives: true, permitCount: 2 }));
    const { total, ...buckets } = b.breakdown!;
    const sum = Object.values(buckets).reduce((n, x) => n + x.high, 0);
    expect(sum).toBe(total.high);
    expect(total.high).toBe(b.total.high);
    expect(b.breakdown!.passesTickets.high).toBeGreaterThan(0);
  });
});
