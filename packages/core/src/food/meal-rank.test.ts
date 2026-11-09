import { describe, expect, it } from 'vitest';
import { chainTags, genericNameTokens, sameVenue } from './identity';
import { MEAL_RANK_KM, mealAlternativeFor, mealRankAdjustment, readCuisineWishes, venueHoursFit } from './meal-rank';
import type { FoodDataset, FoodVenue } from '../schemas/food';

const provenance = { kind: 'estimated', sourceName: 'test', confidence: 0.3, volatility: 'dynamic', recheckNote: 'Check.' } as const;
const unknownHours: FoodVenue['hours'] = { kind: 'unknown', hoursConfidence: 'unverified', provenance };

function venue(over: Partial<FoodVenue> = {}): FoodVenue {
  return { id: 'v', regionId: 'r', name: 'Venue', locality: 'Town', shortDescription: 'x', coordinates: { lat: 46, lng: 7 }, tags: [], source: { name: 's', kind: 'overture', confidence: 0.5, lastVerified: '2026-11-09' }, serviceType: 'restaurant', mealPeriods: ['lunch', 'dinner'], cuisines: [], priceBand: 'moderate', priceEvidence: 'format_inferred', serviceMinutes: 60, reservation: { requirement: 'unknown' }, takeaway: 'unknown', provisioning: 'none', dietary: [], hours: unknownHours, routingId: 'p', walkMinutesFromRouting: 0, ...over } as FoodVenue;
}

const none = { liked: new Set<string>(), disliked: new Set<string>() };
const rank = (v: FoodVenue, over: Partial<Parameters<typeof mealRankAdjustment>[0]> = {}) => mealRankAdjustment({ venue: v, slot: 'lunch', carFree: true, wishes: none, cuisineUses: new Map(), everydayPriceBand: 'moderate', hoursFit: 'unknown', ...over });

describe('venue identity', () => {
  it('matches the same name in any script, close together, and never an empty fold', () => {
    const at = (name: string, lat = 46) => ({ name, coordinates: { lat, lng: 7 } });
    expect(sameVenue(at('鮨鶴'), at('鮨 鶴'), new Set())).toBe(false); // two tokens vs one: no affirmative evidence
    expect(sameVenue(at('Café Mango'), at('Cafe Mango', 46.0005))).toBe(true);
    expect(sameVenue(at('鮨鶴'), at('丸亀食堂'))).toBe(false);
    expect(sameVenue(at('!!!'), at('???'))).toBe(false);
    expect(sameVenue(at('Casa Pepe'), at('Casa Pepe', 46.01))).toBe(false);
  });
  it('ignores words every venue around shares, counted from the names themselves', () => {
    const names = ['Restaurante Uno', 'Restaurante Dos', 'Restaurante Tres', 'Restaurante Cuatro', 'Mar'];
    const generic = genericNameTokens(names);
    expect(generic.has('restaurante')).toBe(true);
    expect(sameVenue({ name: 'Restaurante Casa Pepe', coordinates: { lat: 46, lng: 7 } }, { name: 'Casa Pepe', coordinates: { lat: 46.001, lng: 7 } }, generic)).toBe(true);
    expect(sameVenue({ name: 'Restaurante Uno', coordinates: { lat: 46, lng: 7 } }, { name: 'Restaurante Dos', coordinates: { lat: 46, lng: 7 } }, generic)).toBe(false);
  });
});

describe('meal ranking terms', () => {
  it('prefers an independent unless the chain is materially closer; never excludes it', () => {
    expect(rank(venue({ tags: chainTags('brand_wikidata') }))).toBe(MEAL_RANK_KM.chain);
    expect(0.2 + rank(venue({ tags: chainTags('brand_wikidata') }))).toBeLessThan(1.5);
  });
  it('absence of evidence costs nothing', () => {
    expect(rank(venue())).toBe(0);
  });
  it('evidence raises a venue, and the discount is capped', () => {
    const v = venue({ cuisines: ['ramen'], tags: ['local-cuisine'] });
    expect(rank(v, { wishes: { liked: new Set(['ramen']), disliked: new Set() }, hoursFit: 'open' })).toBe(-1.5);
  });
  it('scales to a car', () => {
    expect(rank(venue({ tags: ['chain'] }), { carFree: false })).toBeCloseTo(MEAL_RANK_KM.chain * 3);
  });
});

describe('what the traveller said', () => {
  const vocab = ['ramen', 'sushi', 'thai'];
  it('matches only cuisines on offer, and reads a nearby negation', () => {
    const w = readCuisineWishes(['We love ramen. No sushi please, and burgers are fine'], vocab);
    expect([...w.liked]).toEqual(['ramen']);
    expect([...w.disliked]).toEqual(['sushi']);
  });
  it('does not match inside a longer word', () => {
    expect(readCuisineWishes(['Thailand was great'], vocab).liked.size).toBe(0);
  });
});

describe('hours evidence against the meal', () => {
  it('a meal fits only inside one window; no record is unknown, never closed', () => {
    const periods = [{ label: 'Mon to Sat', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], daysOfWeek: [1, 2, 3, 4, 5, 6], windows: [{ openMinute: 720, closeMinute: 870 }, { openMinute: 1080, closeMinute: 1320 }] }];
    const v = { hours: { kind: 'scheduled', hoursConfidence: 'unverified', periods, closedAnnualDates: [], provenance } as FoodVenue['hours'] };
    expect(venueHoursFit(v, '2027-05-10', 13 * 60, 14 * 60)).toBe('open');
    expect(venueHoursFit(v, '2027-05-10', 15 * 60, 16 * 60)).toBe('closed');
    expect(venueHoursFit(v, '2027-05-16', 13 * 60, 14 * 60)).toBe('closed');
    expect(venueHoursFit({ hours: unknownHours }, '2027-05-10', 13 * 60, 14 * 60)).toBe('unknown');
  });
});

describe('a meal with no venue', () => {
  const base = { lat: 46, lng: 7 };
  const far = { lat: 46.5, lng: 7 };
  const shop = venue({ id: 's', name: 'Spar', serviceType: 'grocery', mealPeriods: ['snack'], tags: ['overture:grocery'], coordinates: { lat: 46.002, lng: 7 } });
  const data = (venues: FoodVenue[], mealVenues: number): FoodDataset => ({ version: 1, regionId: 'r', venues, gaps: [], searched: [{ center: far, radiusKm: 1, mealVenues }] });
  const call = (food: FoodDataset, over: Partial<Parameters<typeof mealAlternativeFor>[0]> = {}) => mealAlternativeFor({ slot: 'lunch', food, date: '2027-05-10', dayNumber: 2, origin: far, base, baseName: 'Town', firstStop: far, nearName: 'The Lake', carFree: false, plannedToCarry: false, ...over });

  it('searched and empty: names the shop, says hours are not confirmed, claims nothing about the world', () => {
    const out = call(data([shop], 0))!;
    expect(out.title).toBe('Lunch to carry — buy it at Spar');
    expect(out.food.stopKind).toBe('packed');
    expect(out.food.hoursUnknown).toBe(true);
    expect(out.reason).toMatch(/does not prove there is nothing/);
    expect(out.reason).toMatch(/hours are not confirmed/);
  });
  it('no shop on record: says to bring food, and names nothing', () => {
    const out = call(data([], 0))!;
    expect(out.title).toMatch(/^Bring lunch/);
    expect(out.food.venueName).toBeUndefined();
  });
  it('nobody looked, or the box held food: says so, and does not tell anyone to pack', () => {
    const out = call(data([shop], 4))!;
    expect(out.title).toBe('');
    expect(out.food.stopKind).toBe('unplanned');
  });
  it('a region written before searches were recorded keeps the plan as it was', () => {
    expect(call({ version: 1, regionId: 'r', venues: [shop], gaps: [] })).toBeNull();
  });
  it('a shop the record says is shut that day is not named', () => {
    const shut = { ...shop, hours: { kind: 'scheduled', hoursConfidence: 'unverified', periods: [{ label: 'Sun', months: [1,2,3,4,5,6,7,8,9,10,11,12], daysOfWeek: [0], windows: [{ openMinute: 600, closeMinute: 700 }] }], closedAnnualDates: [], provenance } } as FoodVenue;
    expect(call(data([shut], 0))!.title).toMatch(/^Bring lunch/);
  });
});
