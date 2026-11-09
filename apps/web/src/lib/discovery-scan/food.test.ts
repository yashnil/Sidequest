import { describe, expect, it } from 'vitest';
import {
  assembleScanRegion,
  checkRegionIntegrity,
  estimatedScanMatrix,
  foodDatasetSchema,
  haversineKm,
  normalizeScanProposal,
  planScanPoints,
  type ScanPoint,
} from '@sidequest/core';
import type { OverpassElement, OverpassResult } from '../providers/overpass';
import { chainKey, fetchOvertureFood, markChainsFromBox, markRepeatedNamesAsChains, overtureFoodRow, type OvertureFoodRow } from '../providers/overture-food';
import { MAX_FOOD_BOXES, MAX_FOOD_VENUES, THIN_BOX_VENUES, fixtureScanFood, foodBoxAround, groundScanFood, planFoodBoxes, type GroundScanFoodInput } from './food';
import { fixtureScanProposal } from './fixture';
import { fixturePlacement } from './placement';

/**
 * THE SCAN'S FOOD STEP, WITH A MOCKED OVERPASS.
 *
 * Venues are kept only within a door walk of a scan point (so their routing id
 * is a matrix row), the request count and venue count are bounded, duplicates
 * collapse, diet tags travel in both directions, and a refusing service leaves
 * the region with no food data rather than failing anything.
 */

const BASE: ScanPoint = { id: 'scan-base-town', kind: 'base', key: 'b1', name: 'Town', coordinates: { lat: 46, lng: 7 } };
const PLACE: ScanPoint = { id: 'scan-place-falls', kind: 'place', key: 'c1', name: 'Falls', coordinates: { lat: 46.1, lng: 7.1 } };

function input(overrides: Partial<GroundScanFoodInput> = {}): GroundScanFoodInput {
  return {
    regionId: 'scan-test',
    destinationName: 'Test Valley',
    points: [BASE, PLACE],
    foodAreas: [],
    center: BASE.coordinates,
    maxDistanceKm: 200,
    today: '2026-10-06',
    ...overrides,
  };
}

let nextId = 1;
function node(lat: number, lng: number, tags: Record<string, string>): OverpassElement {
  return { type: 'node', id: nextId++, lat, lon: lng, tags };
}

function answer(elements: OverpassElement[]): OverpassResult {
  return { elements, dataTimestamp: null, calls: 1, cacheHit: false, bytes: 100, failedGroups: [] };
}

const noCache = { read: () => null, write: () => undefined };

describe('food boxes', () => {
  it('puts the bases first, skips food areas no point is near, merges near-duplicate centres, and never exceeds the cap', () => {
    const places: ScanPoint[] = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, kind: 'place', key: `c${i}`, name: `P${i}`, coordinates: { lat: 46 + i * 0.03, lng: 7 } }));
    const boxes = planFoodBoxes({
      points: [BASE, { ...BASE, id: 'b-near', name: 'Near', coordinates: { lat: 46.001, lng: 7.001 } }, ...places],
      foodAreas: [{ name: 'Far food street', coordinates: { lat: 48, lng: 9 } }],
    });
    expect(boxes[0]!.kind).toBe('base');
    expect(boxes.filter((b) => b.kind === 'base')).toHaveLength(1); // the second base is 140 m away: one box
    expect(boxes.some((b) => b.kind === 'food_area')).toBe(false);
    expect(boxes.length).toBe(MAX_FOOD_BOXES);
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(haversineKm(a.center, b.center)).toBeGreaterThanOrEqual(1.2);
  });

  it('draws a box of about a kilometre and a half', () => {
    const box = foodBoxAround({ lat: 46, lng: 7 });
    expect(haversineKm({ lat: box.south, lng: 7 }, { lat: box.north, lng: 7 })).toBeCloseTo(1.5, 1);
    expect(haversineKm({ lat: 46, lng: box.west }, { lat: 46, lng: box.east })).toBeCloseTo(1.5, 1);
  });
});

describe('grounding meals in OSM venues', () => {
  it('snaps each venue to the nearest scan point within a door walk, and only then', async () => {
    const result = await groundScanFood(input(), {
      cache: noCache,
      overture: null,
      geocodeArea: null,
      fetchMeals: async (box) => {
        const lat = (box.north + box.south) / 2;
        const lng = (box.east + box.west) / 2;
        return answer([
          node(lat + 0.003, lng, { amenity: 'restaurant', name: `Kitchen ${lat.toFixed(1)}`, cuisine: 'regional;pizza', 'diet:vegetarian': 'yes' }),
          node(lat - 0.003, lng, { amenity: 'cafe', name: `Café ${lat.toFixed(1)}`, 'diet:vegetarian': 'no' }),
          node(lat, lng + 0.002, { amenity: 'bar', name: 'Just a bar' }),
          node(lat + 0.04, lng, { amenity: 'restaurant', name: 'Four km out' }),
          node(lat, lng, { amenity: 'restaurant' }), // no name: not a venue anyone can find
        ]);
      },
    });
    expect(result.status).toBe('grounded');
    expect(result.source).toBe('openstreetmap');
    const venues = result.dataset!.venues;
    expect(foodDatasetSchema.parse(result.dataset)).toBeTruthy();
    expect(venues.map((v) => v.name).sort()).toEqual(['Café 46.0', 'Café 46.1', 'Kitchen 46.0', 'Kitchen 46.1']);
    expect(result.unroutable).toBe(2);
    const kitchen = venues.find((v) => v.name === 'Kitchen 46.1')!;
    expect(kitchen.routingId).toBe(PLACE.id);
    expect(kitchen.walkMinutesFromRouting).toBeGreaterThan(0);
    expect(kitchen.source.kind).toBe('osm');
    expect(kitchen.source.element?.licenceId).toBe('ODbL-1.0');
    expect(kitchen.hours.kind).toBe('unknown');
    expect(kitchen.priceEvidence).toBe('format_inferred');
    expect(kitchen.cuisines).toEqual(['regional']);
    expect(kitchen.dietary).toEqual([expect.objectContaining({ need: 'vegetarian', evidence: 'menu_lists_options' })]);
    const cafe = venues.find((v) => v.name === 'Café 46.0')!;
    expect(cafe.routingId).toBe(BASE.id);
    expect(cafe.priceBand).toBe('budget');
    expect(cafe.dietary).toEqual([expect.objectContaining({ need: 'vegetarian', evidence: 'venue_states_unsuitable' })]);
  });

  it('collapses the same venue mapped twice and the same element returned by two boxes', async () => {
    const shared = node(46.0005, 7.0005, { amenity: 'restaurant', name: 'The One' });
    const result = await groundScanFood(input({ points: [BASE, { ...PLACE, coordinates: { lat: 46.012, lng: 7 } }] }), {
      cache: noCache,
      overture: null,
      geocodeArea: null,
      fetchMeals: async () => answer([shared, { ...shared, type: 'way', id: shared.id, lat: 46.0006, lon: 7.0006 }, node(46.0004, 7.0004, { amenity: 'restaurant', name: 'The One' })]),
    });
    expect(result.dataset!.venues).toHaveLength(1);
  });

  it('asks sequentially, for at most eight boxes, and keeps at most sixty venues', async () => {
    const places: ScanPoint[] = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, kind: 'place', key: `c${i}`, name: `P${i}`, coordinates: { lat: 46 + i * 0.05, lng: 7 } }));
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const result = await groundScanFood(input({ points: [BASE, ...places] }), {
      cache: noCache,
      overture: null,
      geocodeArea: null,
      fetchMeals: async (box) => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        const lat = (box.north + box.south) / 2;
        return answer(Array.from({ length: 30 }, (_, k) => node(lat + (k - 15) * 0.0003, 7, { amenity: 'restaurant', name: `R${lat.toFixed(2)}-${k}` })));
      },
    });
    expect(maxInFlight).toBe(1);
    expect(calls).toBeLessThanOrEqual(MAX_FOOD_BOXES);
    expect(result.dataset!.venues.length).toBeLessThanOrEqual(MAX_FOOD_VENUES);
    expect(result.dataset!.venues.length).toBeGreaterThan(40);
  });

  it('a refusing service leaves the region with no food data, and stops asking after two refusals in a row', async () => {
    let calls = 0;
    const result = await groundScanFood(input({ points: [BASE, PLACE, { ...PLACE, id: 'p3', coordinates: { lat: 46.3, lng: 7.3 } }] }), {
      cache: noCache,
      overture: null,
      geocodeArea: null,
      fetchMeals: async () => {
        calls += 1;
        throw new Error('The map data service is busy.');
      },
    });
    expect(calls).toBe(2);
    expect(result.dataset).toBeNull();
    expect(result.status).toBe('unavailable');
    expect(result.detail).toMatch(/described rather than named/);
  });

  it('boxes a geocoded food area beside a scan point, and refuses one in another country', async () => {
    const seen: { lat: number; lng: number }[] = [];
    await groundScanFood(
      input({
        countryCode: 'CH',
        foodAreas: [
          { name: 'Old Market', locality: 'Town', specialty: '', why: '' },
          { name: 'Elsewhere Street', locality: 'Abroad', specialty: '', why: '' },
        ],
      }),
      {
        cache: noCache,
        overture: null,
        geocodeArea: async (query) => (query.startsWith('Old Market') ? { lat: 46.115, lng: 7.1, countryCode: 'CH' } : { lat: 46.1, lng: 7.085, countryCode: 'FR' }),
        fetchMeals: async (box) => {
          seen.push({ lat: (box.north + box.south) / 2, lng: (box.east + box.west) / 2 });
          return answer([]);
        },
      },
    );
    expect(seen.some((c) => Math.abs(c.lat - 46.115) < 1e-6 && Math.abs(c.lng - 7.1) < 1e-6)).toBe(true);
    expect(seen.some((c) => Math.abs(c.lng - 7.085) < 1e-6)).toBe(false);
  });
});

function orow(id: string, lat: number, lng: number, over: Partial<OvertureFoodRow> = {}): OvertureFoodRow {
  return { id, name: `Venue ${id}`, coordinates: { lat, lng }, serviceType: 'restaurant', confidence: 0.9, chain: false, licenceId: 'CDLA-Permissive-2.0', ...over };
}

describe('grounding meals in Overture venues first', () => {
  it('reads every box from Overture at once and never asks Overpass when the boxes are full', async () => {
    let overpassCalls = 0;
    let overtureBoxes = 0;
    const result = await groundScanFood(input(), {
      cache: noCache,
      geocodeArea: null,
      overture: async (boxes) => {
        overtureBoxes = boxes.length;
        return boxes.map((box) => {
          const lat = (box.north + box.south) / 2;
          const lng = (box.east + box.west) / 2;
          return {
            rows: Array.from({ length: 10 }, (_, k) => orow(`${lat.toFixed(1)}-${k}`, lat + (k - 5) * 0.0005, lng, { serviceType: k % 3 === 2 ? 'cafe' : 'restaurant', ...(k === 0 ? { cuisine: 'ramen', website: 'https://example.org/menu' } : {}) })),
            bytes: 3_000_000,
            ms: 1500,
            cacheHit: false,
          };
        });
      },
      fetchMeals: async () => {
        overpassCalls += 1;
        return answer([]);
      },
    });
    expect(overtureBoxes).toBe(2);
    expect(overpassCalls).toBe(0);
    expect(result.status).toBe('grounded');
    expect(result.source).toBe('overture');
    expect(foodDatasetSchema.parse(result.dataset)).toBeTruthy();
    const venues = result.dataset!.venues;
    expect(venues.length).toBe(20); // every row of both boxes: each box may hold up to MAX_FOOD_VENUES / boxes
    const ramen = venues.find((v) => v.cuisines.includes('ramen'))!;
    expect(ramen.source.kind).toBe('overture');
    expect(ramen.source.element?.licenceId).toBe('CDLA-Permissive-2.0');
    expect(ramen.source.url).toBe('https://example.org/menu');
    expect(ramen.hours.kind).toBe('unknown');
    expect(ramen.dietary).toEqual([]);
    // Meals and coffee are interleaved rather than all one kind.
    expect(venues.filter((v) => v.serviceType === 'cafe').length).toBeGreaterThan(0);
    expect(result.detail).toMatch(/from Overture Maps/);
  });

  it('asks Overpass only for a box Overture left thin, and collapses a venue both sources know', async () => {
    const asked: number[] = [];
    const result = await groundScanFood(input(), {
      cache: noCache,
      geocodeArea: null,
      overture: async (boxes) =>
        boxes.map((box) => {
          const lat = (box.north + box.south) / 2;
          // The place box (46.1) is thin: one venue.
          const count = lat > 46.05 ? 1 : 10;
          return { rows: Array.from({ length: count }, (_, k) => orow(`${lat.toFixed(1)}-${k}`, lat + k * 0.0005, (box.east + box.west) / 2, { name: k === 0 && count === 1 ? 'Shared Kitchen' : `Venue ${lat.toFixed(1)}-${k}` })), bytes: 1, ms: 1, cacheHit: false };
        }),
      fetchMeals: async (box) => {
        const lat = (box.north + box.south) / 2;
        asked.push(lat);
        return answer([node(lat + 0.0001, 7.1, { amenity: 'restaurant', name: 'Shared Kitchen' }), node(lat - 0.002, 7.1, { amenity: 'cafe', name: 'Only On OSM' })]);
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeCloseTo(46.1, 3);
    expect(THIN_BOX_VENUES).toBeGreaterThan(1);
    expect(result.source).toBe('overture+openstreetmap');
    const names = result.dataset!.venues.map((v) => v.name);
    expect(names.filter((n) => n === 'Shared Kitchen')).toHaveLength(1);
    expect(names).toContain('Only On OSM');
    expect(result.detail).toMatch(/Overture Maps and OpenStreetMap/);
  });

  it('a box Overture could not read falls to Overpass; both failing leaves no food data, said so', async () => {
    let overpassCalls = 0;
    const result = await groundScanFood(input(), {
      cache: noCache,
      geocodeArea: null,
      overture: async (boxes) => boxes.map(() => null),
      fetchMeals: async () => {
        overpassCalls += 1;
        throw new Error('busy');
      },
    });
    expect(overpassCalls).toBe(2);
    expect(result.dataset).toBeNull();
    expect(result.status).toBe('unavailable');
    expect(result.detail).toMatch(/described rather than named/);
  });

  // Changed in the food pass: the owner asked that chains not be excluded categorically. They are kept, ranked last, a couple per box, and tagged.
  it('ranks independents first and keeps a couple of chains, tagged, for the meal step to weigh', async () => {
    const result = await groundScanFood(input({ points: [BASE] }), {
      cache: noCache,
      geocodeArea: null,
      overpass: false,
      overture: async (boxes) => [
        {
          rows: [
            ...Array.from({ length: 4 }, (_, k) => orow(`chain-${k}`, 46 + k * 0.0003, 7, { name: `Burger Chain ${k}`, chain: true, confidence: 0.99 })),
            ...Array.from({ length: 4 }, (_, k) => orow(`local-${k}`, 46 - k * 0.0003, 7, { name: `Local ${k}`, confidence: 0.8 })),
          ],
          bytes: 1,
          ms: 1,
          cacheHit: false,
        },
        ...boxes.slice(1).map(() => null),
      ],
    });
    const venues = result.dataset!.venues;
    expect(venues.slice(0, 4).every((v) => v.name.startsWith('Local'))).toBe(true);
    const chains = venues.filter((v) => v.name.startsWith('Burger'));
    expect(chains).toHaveLength(2);
    expect(chains.every((v) => v.tags.includes('chain'))).toBe(true);
  });

  it('does not treat two different non-Latin names beside each other as one venue', async () => {
    const result = await groundScanFood(input({ points: [BASE] }), { cache: noCache, geocodeArea: null, overpass: false, overture: async () => [{ rows: [orow('a', 46, 7, { name: '鮨鶴' }), orow('b', 46.0002, 7, { name: '丸亀食堂' })], bytes: 1, ms: 1, cacheHit: false }] });
    expect(result.dataset!.venues).toHaveLength(2);
  });

  it('merges what OSM knows onto the Overture record of the same venue, and credits OSM', async () => {
    const result = await groundScanFood(input({ points: [BASE] }), {
      cache: noCache,
      geocodeArea: null,
      overture: async () => [{ rows: [orow('a', 46, 7, { name: 'Casa Pepe' })], bytes: 1, ms: 1, cacheHit: false }],
      fetchMeals: async () => answer([node(46.0001, 7, { amenity: 'restaurant', name: 'Casa Pepe', opening_hours: 'Mo-Sa 12:00-22:00; Su off', 'diet:vegan': 'yes' })]),
    });
    const [venue] = result.dataset!.venues;
    expect(result.dataset!.venues).toHaveLength(1);
    expect(venue!.hours.kind).toBe('scheduled');
    expect(venue!.dietary.map((c) => c.need)).toEqual(['vegan']);
    expect(result.source).toBe('overture+openstreetmap');
  });

  it('records which boxes answered and how many places to eat each held; a failed box is absent, not empty', async () => {
    const result = await groundScanFood(input(), { cache: noCache, geocodeArea: null, overpass: false, overture: async (boxes) => [{ rows: [orow('a', boxes[0]!.south + 0.006, 7), orow('g', boxes[0]!.south + 0.007, 7, { serviceType: 'grocery', shop: 'grocery' })], bytes: 1, ms: 1, cacheHit: false }, null] });
    expect(result.dataset!.searched).toEqual([expect.objectContaining({ mealVenues: 1 })]);
    expect(result.dataset!.venues.find((v) => v.serviceType === 'grocery')!.mealPeriods).toEqual(['snack']);
  });
});

describe('chains Overture did not label, and the reader itself', () => {
  it('strips branch words and brackets to find what stays the same across branches', () => {
    expect(chainKey('丸亀製麺 浅草rox店')).toBe(chainKey('丸亀製麺'));
    expect(chainKey('デニーズ 上野谷中店')).toBe('デニーズ');
    expect(chainKey('Bistro Roven (Shinjuku)')).toBe('bistro roven');
    expect(chainKey('Casa Pepe')).toBe('casa pepe');
  });
  it('marks a name repeated three times across boxes, or twice in one, as a chain — and nothing else', () => {
    const r = (name: string): OvertureFoodRow => orow(name, 0, 0, { name });
    const marked = markRepeatedNamesAsChains([
      [r('Saizeriya'), r('すき家'), r('すき家'), r('Casa Pepe')],
      [r('Saizeriya'), r('Other Place')],
      [r('Saizeriya 新宿店')],
    ]);
    expect(marked[0]!.map((x) => x.chain)).toEqual([true, true, true, false]);
    expect(marked[1]!.map((x) => x.chain)).toEqual([true, false]);
    expect(marked[2]![0]!.chain).toBe(true);
  });
  it('refuses a job advert listed as a restaurant', () => {
    expect(overtureFoodRow({ id: 'j', names: { primary: 'Вакансии "Империя Пиццы"' }, confidence: 0.9, basic_category: 'restaurant', bbox: { xmin: 74.5, xmax: 74.5, ymin: 42.8, ymax: 42.8 } })).toBeNull();
    expect(overtureFoodRow({ id: 'k', names: { primary: '"Барашек"' }, confidence: 0.9, basic_category: 'restaurant', bbox: { xmin: 74.5, xmax: 74.5, ymin: 42.8, ymax: 42.8 } })!.name).toBe('Барашек');
  });
  it('reads boxes a few at a time, caches only non-empty answers, and treats a failed box as an absence', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const written: string[] = [];
    const box = (lat: number) => ({ south: lat, north: lat + 0.01, west: 7, east: 7.01 });
    const results = await fetchOvertureFood([box(1), box(2), box(3), box(4), box(5), box(6)], { deadlineMs: Date.now() + 10_000 }, {
      cache: { read: (key) => (key.includes('6.0000') ? [orow('cached', 6, 7)] : null), write: (key) => written.push(key) },
      readBox: async (b) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (b.south === 3) throw new Error('reset');
        return { rows: b.south === 4 ? [] : [orow(`r${b.south}`, b.south, 7)], bytes: 10 };
      },
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(results[2]).toBeNull();
    expect(results[3]!.rows).toEqual([]);
    expect(results[5]!.cacheHit).toBe(true);
    expect(written).toHaveLength(3); // boxes 1, 2, 5 — never the empty box 4, never the failed box 3
  });
});

describe('what Overture files under the wrong heading (live Kyoto finding)', () => {
  const at = { bbox: { xmin: 135.75, xmax: 135.75, ymin: 34.98, ymax: 34.98 } };
  it('a donut, ice-cream or candy shop is not a meal, and a bakery stays a bakery', () => {
    expect(overtureFoodRow({ id: 'd', names: { primary: 'Mister Donut' }, confidence: 0.9, basic_category: 'casual_eatery', taxonomy: { primary: 'donut_shop', hierarchy: ['food_and_drink', 'casual_eatery', 'dessert_shop', 'donut_shop'] }, ...at })).toBeNull();
    expect(overtureFoodRow({ id: 'i', names: { primary: 'Gelato Uno' }, confidence: 0.9, basic_category: 'casual_eatery', taxonomy: { primary: 'ice_cream_shop' }, ...at })).toBeNull();
    expect(overtureFoodRow({ id: 'b', names: { primary: 'Pain Ichi' }, confidence: 0.9, basic_category: 'casual_eatery', taxonomy: { primary: 'bakery' }, ...at })!.serviceType).toBe('bakery');
  });
  it('an unbranded "restaurant" is a chain when its box holds the same name with a brand, glued branch suffix or not', () => {
    const r = (name: string): OvertureFoodRow => orow(name, 0, 0, { name });
    const marked = markChainsFromBox([r('ファミリーマート 近鉄京都駅店'), r('丸亀製麺吉祥院店'), r('Casa Pepe')], new Set([chainKey('ファミリーマート'), chainKey('丸亀製麺')]), new Map());
    expect(marked.map((x) => x.chain)).toEqual([true, true, false]);
  });
});

describe('an Overture place row as a food venue', () => {
  const base = { id: 'x1', names: { primary: 'Casa Pepe' }, confidence: 0.92, operating_status: 'open', basic_category: 'restaurant', taxonomy: { primary: 'spanish_restaurant' }, brand: null, websites: ['https://casapepe.example'], sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', update_time: '2026-10-12T00:00:00.000Z' }, { dataset: 'Overture', license: 'CDLA-Permissive-2.0', update_time: '2026-10-15T00:00:00Z' }], bbox: { xmin: -16.55, xmax: -16.55, ymin: 28.41, ymax: 28.41 } };
  it('keeps an open, confident restaurant with its cuisine, website and the source record\'s own date', () => {
    expect(overtureFoodRow(base)).toEqual({ id: 'x1', name: 'Casa Pepe', coordinates: { lat: 28.41, lng: -16.55 }, serviceType: 'restaurant', cuisine: 'spanish', confidence: 0.92, chain: false, website: 'https://casapepe.example/', licenceId: 'CDLA-Permissive-2.0', sourceTimestamp: '2026-10-12T00:00:00.000Z' });
  });
  it('refuses what it cannot stand behind: closed, unsure, a bar, a shop, nameless', () => {
    expect(overtureFoodRow({ ...base, operating_status: 'permanently_closed' })).toBeNull();
    expect(overtureFoodRow({ ...base, operating_status: 'temporarily_closed' })).toBeNull();
    expect(overtureFoodRow({ ...base, confidence: 0.55 })).toBeNull();
    expect(overtureFoodRow({ ...base, basic_category: 'bar' })).toBeNull();
    expect(overtureFoodRow({ ...base, basic_category: 'food_and_beverage_store' })).toBeNull();
    expect(overtureFoodRow({ ...base, names: { primary: '' } })).toBeNull();
  });
  it('maps cafés, coffee and fast food, marks a branded row a chain, and carries a Foursquare licence through', () => {
    expect(overtureFoodRow({ ...base, basic_category: 'coffee_shop', taxonomy: { primary: 'coffee_shop' } })).toMatchObject({ serviceType: 'cafe' });
    expect(overtureFoodRow({ ...base, basic_category: 'fast_food_restaurant', taxonomy: { primary: 'fast_food_restaurant' } })).toMatchObject({ serviceType: 'takeaway' });
    expect(overtureFoodRow({ ...base, basic_category: 'fast_food_restaurant', taxonomy: { primary: 'fast_food_restaurant' } })!.cuisine).toBeUndefined();
    expect(overtureFoodRow({ ...base, brand: { names: { primary: 'Starbucks' }, wikidata: 'Q37158' } })!.chain).toBe(true);
    expect(overtureFoodRow({ ...base, sources: [{ dataset: 'foursquare', license: 'Apache-2.0' }] })!.licenceId).toBe('Apache-2.0');
  });
  it('believes a brand with a Wikidata item or a branch of the brand, not a bare brand on an unrelated venue', () => {
    expect(overtureFoodRow({ ...base, brand: { names: { primary: 'The Crown, Walney' } } })!.chain).toBe(false);
    expect(overtureFoodRow({ ...base, brand: { names: { primary: 'Casa Pepe' } } })!.chain).toBe(false);
    expect(overtureFoodRow({ ...base, names: { primary: 'Casa Pepe Centro' }, brand: { names: { primary: 'Casa Pepe' } } })).toMatchObject({ chain: true, chainEvidence: 'brand_name' });
  });
  it('keeps pubs, food shops, stated diets and the town on the address; refuses a liquor store', () => {
    expect(overtureFoodRow({ ...base, basic_category: 'bar', taxonomy: { primary: 'pub' } })).toMatchObject({ serviceType: 'restaurant', pub: true });
    expect(overtureFoodRow({ ...base, basic_category: 'bar', taxonomy: { primary: 'cocktail_bar' } })).toBeNull();
    expect(overtureFoodRow({ ...base, basic_category: 'food_and_beverage_store', taxonomy: { primary: 'grocery_store' } })).toMatchObject({ serviceType: 'grocery', shop: 'grocery' });
    expect(overtureFoodRow({ ...base, basic_category: 'convenience_store', taxonomy: { primary: 'convenience_store' } })).toMatchObject({ shop: 'convenience' });
    expect(overtureFoodRow({ ...base, basic_category: 'food_and_beverage_store', taxonomy: { primary: 'liquor_store' } })).toBeNull();
    expect(overtureFoodRow({ ...base, taxonomy: { primary: 'vegan_restaurant' } })!.dietary).toEqual(['vegan', 'vegetarian']);
    expect(overtureFoodRow({ ...base, addresses: [{ locality: 'KESWICK' }] })!.locality).toBe('Keswick');
  });
});

describe('fixture food and assembly', () => {
  it('a fixture scan gets a synthetic, valid dataset whose every venue is a matrix row the region keeps', () => {
    const proposal = normalizeScanProposal(fixtureScanProposal('Testmouth', 'Testmouth', 6));
    if (!proposal.ok) throw new Error(proposal.reason);
    const center = { lat: 50, lng: -4 };
    const placement = fixturePlacement(proposal.proposal, center);
    const plan = planScanPoints(proposal.proposal, placement.positions);
    const regionId = 'scan-fixture';
    const food = fixtureScanFood({ regionId, destinationName: 'Testmouth', points: plan.points, today: '2026-10-06' });
    expect(food.dataset!.venues.length).toBeGreaterThanOrEqual(8);
    expect(food.dataset!.venues.every((v) => v.name.includes('(fixture)'))).toBe(true);
    const dates = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17'];
    const { region } = assembleScanRegion({
      regionId,
      destinationName: 'Testmouth',
      entityType: 'city',
      breadth: 'city',
      center,
      timeZone: 'Europe/London',
      dates,
      carAvailable: true,
      maxBaseChanges: 1,
      proposal: proposal.proposal,
      positions: placement.positions,
      plan,
      matrix: estimatedScanMatrix(plan.points, 'car'),
      createdAt: '2026-10-06T00:00:00.000Z',
      providers: { proposal: 'fixture', placement: ['fixture'], routing: 'distance estimates' },
      food: { dataset: food.dataset, status: food.status, source: food.source, detail: food.detail },
    });
    expect(region.food?.venues.length).toBe(food.dataset!.venues.length);
    expect(checkRegionIntegrity(region)).toEqual([]);
    expect(region.coverage.dimensions.find((d) => d.dimension === 'food')).toMatchObject({ level: 'usable_with_cautions', covered: food.dataset!.venues.length });
    // A synthetic dataset is not OSM data: no ODbL claim for it.
    expect(region.licences.map((l) => l.id)).not.toContain('ODbL-1.0');
  });

  it('OSM food carries the ODbL licence; a venue priced against a point the matrix lacks is dropped, not fatal', () => {
    const proposal = normalizeScanProposal(fixtureScanProposal('Testmouth', 'Testmouth', 4));
    if (!proposal.ok) throw new Error(proposal.reason);
    const placement = fixturePlacement(proposal.proposal, { lat: 50, lng: -4 });
    const plan = planScanPoints(proposal.proposal, placement.positions);
    const food = fixtureScanFood({ regionId: 'scan-osm', destinationName: 'Testmouth', points: plan.points, today: '2026-10-06' });
    const venues = food.dataset!.venues.map((v, i) => (i === 0 ? { ...v, routingId: 'not-a-row' } : v));
    const { region } = assembleScanRegion({
      regionId: 'scan-osm',
      destinationName: 'Testmouth',
      entityType: 'city',
      breadth: 'city',
      center: { lat: 50, lng: -4 },
      timeZone: 'Europe/London',
      dates: ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'],
      carAvailable: true,
      maxBaseChanges: 0,
      proposal: proposal.proposal,
      positions: placement.positions,
      plan,
      matrix: estimatedScanMatrix(plan.points, 'car'),
      createdAt: '2026-10-06T00:00:00.000Z',
      providers: { proposal: 'fixture', placement: ['fixture'], routing: 'distance estimates' },
      food: { dataset: { ...food.dataset!, venues }, status: 'grounded', source: 'openstreetmap', detail: 'Some venues.' },
    });
    expect(region.food!.venues).toHaveLength(venues.length - 1);
    expect(region.licences.find((l) => l.id === 'ODbL-1.0')?.appliesTo).toEqual(['food']);
  });
});

describe('local places over chains', () => {
  it('recognises a branded chain by its OSM brand tags', async () => {
    const { isChain } = await import('./food');
    expect(isChain({ tags: { brand: "Wendy's", amenity: 'fast_food' } })).toBe(true);
    expect(isChain({ tags: { 'brand:wikidata': 'Q550258' } })).toBe(true);
    expect(isChain({ tags: { amenity: 'restaurant', name: 'Joe’s Diner' } })).toBe(false);
    expect(isChain({})).toBe(false);
  });
});
