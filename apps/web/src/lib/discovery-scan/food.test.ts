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
import { MAX_FOOD_BOXES, MAX_FOOD_VENUES, fixtureScanFood, foodBoxAround, groundScanFood, planFoodBoxes, type GroundScanFoodInput } from './food';
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
