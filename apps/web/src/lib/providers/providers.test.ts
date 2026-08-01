import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  boundsRadiusKm,
  classifyNominatim,
  geocode,
  geocodeCacheKey,
  osmElementId,
  osmElementUrl,
  type NominatimPlace,
} from './nominatim';
import {
  buildQuery,
  clampBoundingBox,
  elementId,
  MAX_BBOX_DEGREES,
  normalizeElement,
  overpassCacheKey,
  type OverpassElement,
} from './overpass';
import { computeMatrix, costingFor, isPlausibleLeg, matrixCacheKey } from './valhalla';

/**
 * Contract tests for the open-licensed provider stack.
 *
 * Entirely offline: every network call is an injected `fetchImpl`. That is not
 * only about speed — a suite that reaches a volunteer-run service on every run
 * is exactly the abuse pattern those services complain about, and a test that
 * fails when somebody else's server is busy is a test nobody trusts.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NEW_YORK: NominatimPlace = {
  place_id: 1,
  osm_type: 'relation',
  osm_id: 175905,
  lat: '40.7127281',
  lon: '-74.0060152',
  display_name: 'New York, United States',
  name: 'New York',
  category: 'boundary',
  addresstype: 'city',
  boundingbox: ['40.4765780', '40.9176300', '-74.2588430', '-73.7002330'],
  address: { city: 'New York', state: 'New York', country: 'United States', country_code: 'us' },
};

describe('nominatim', () => {
  it('parses a result into coordinates, bounds and an OSM element id', async () => {
    const result = await geocode('New York City', {
      fetchImpl: async () => jsonResponse([NEW_YORK]),
    });
    expect(result.places).toHaveLength(1);
    expect(osmElementId(NEW_YORK)).toBe('relation/175905');
    expect(osmElementUrl(NEW_YORK)).toBe('https://www.openstreetmap.org/relation/175905');
    expect(boundsOf(NEW_YORK)?.southWest.lat).toBeCloseTo(40.4766, 3);
  });

  it('classifies from what the geocoder said, not from a guess', () => {
    expect(classifyNominatim(NEW_YORK)).toEqual({ breadth: 'city', entityType: 'city' });
    expect(classifyNominatim({ ...NEW_YORK, addresstype: 'country' }).breadth).toBe('country');
    expect(classifyNominatim({ ...NEW_YORK, addresstype: 'island' }).entityType).toBe('island');
    expect(classifyNominatim({ ...NEW_YORK, addresstype: 'state' }).breadth).toBe('region');
  });

  it('sizes a scope from the published bounding box rather than a constant', () => {
    const radius = boundsRadiusKm(NEW_YORK);
    expect(radius).not.toBeNull();
    // New York's bbox is roughly 50 km across, so the half-span is ~25 km.
    expect(radius!).toBeGreaterThan(15);
    expect(radius!).toBeLessThan(45);
  });

  it('serves a cached result without calling the service again', async () => {
    const store = new Map<string, NominatimPlace[]>();
    const cache = {
      read: (key: string) => store.get(key) ?? null,
      write: (key: string, value: NominatimPlace[]) => void store.set(key, value),
    };
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return jsonResponse([NEW_YORK]);
    };

    await geocode('New York City', { fetchImpl, cache });
    const second = await geocode('New York City', { fetchImpl, cache });
    expect(calls).toBe(1);
    expect(second.cacheHit).toBe(true);
    expect(second.calls).toBe(0);
  });

  it('keys the cache on the endpoint, so a self-hosted answer is never crossed with a public one', () => {
    const key = geocodeCacheKey('bali', 5);
    expect(key).toContain('nominatim');
    expect(key).toContain('bali');
  });

  it('reports a rate limit as its own condition rather than as a failure', async () => {
    await expect(
      geocode('anywhere', { fetchImpl: async () => new Response('', { status: 429 }) }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('refuses a response it cannot parse rather than half-reading it', async () => {
    await expect(
      geocode('anywhere', { fetchImpl: async () => jsonResponse([{ nonsense: true }]) }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('overpass', () => {
  const element: OverpassElement = {
    type: 'node',
    id: 240109189,
    lat: 40.7061,
    lon: -73.9969,
    timestamp: '2026-05-04T10:11:12Z',
    tags: {
      name: 'Brooklyn Bridge',
      historic: 'monument',
      wikipedia: 'en:Brooklyn Bridge',
      'name:fr': 'Pont de Brooklyn',
      opening_hours: '24/7',
      website: 'https://example.invalid/bb',
    },
  };

  it('bounds a query so a country-sized box cannot be asked for', () => {
    const huge = { south: 0, west: 0, north: 40, east: 40 };
    const clamped = clampBoundingBox(huge);
    expect(clamped.north - clamped.south).toBeLessThanOrEqual(MAX_BBOX_DEGREES);
    expect(clamped.east - clamped.west).toBeLessThanOrEqual(MAX_BBOX_DEGREES);
  });

  it('builds a bounded, timed-out, named-only query', () => {
    const query = buildQuery({ south: 40.7, west: -74, north: 40.73, east: -73.99 }, 60);
    expect(query).toContain('[out:json][timeout:25]');
    expect(query).toContain('["name"]');
    expect(query).toContain('out center tags qt 60');
  });

  it('normalizes the minimum fields rather than copying the tag dictionary', () => {
    const normalized = normalizeElement(element);
    expect(normalized).not.toBeNull();
    expect(normalized!.elementId).toBe('node/240109189');
    expect(normalized!.name).toBe('Brooklyn Bridge');
    expect(normalized!.primaryTag).toBe('historic=monument');
    expect(normalized!.sourceTimestamp).toBe('2026-05-04T10:11:12Z');
    expect(normalized!.url).toBe('https://www.openstreetmap.org/node/240109189');

    // The planning tags come through; the rest of the dictionary does not.
    expect(normalized!.planningTags).toHaveProperty('opening_hours');
    expect(normalized!.planningTags).toHaveProperty('website');
    expect(normalized!.planningTags).not.toHaveProperty('wikipedia');
    expect(normalized!.planningTags).not.toHaveProperty('name:fr');
  });

  it('drops an element with no name or no position rather than inventing either', () => {
    expect(normalizeElement({ ...element, tags: { historic: 'monument' } })).toBeNull();
    const { lat: _lat, lon: _lon, ...noPosition } = element;
    expect(normalizeElement(noPosition as OverpassElement)).toBeNull();
  });

  it('drops an element that matched no selector we plan against', () => {
    expect(
      normalizeElement({ ...element, tags: { name: 'A Bench', amenity: 'bench' } }),
    ).toBeNull();
  });

  it('reads the centre of a way, which has no lat/lon of its own', () => {
    const way: OverpassElement = {
      type: 'way',
      id: 27784372,
      center: { lat: 40.78, lon: -73.96 },
      tags: { name: 'Central Park', leisure: 'park' },
    };
    expect(normalizeElement(way)?.coordinates).toEqual({ lat: 40.78, lng: -73.96 });
    expect(elementId(way)).toBe('way/27784372');
  });

  it('keys the cache on the rounded box, so a nudged viewport reuses the answer', () => {
    const a = overpassCacheKey({ south: 40.7001, west: -74.0001, north: 40.73, east: -73.99 }, 60);
    const b = overpassCacheKey({ south: 40.7002, west: -74.0002, north: 40.73, east: -73.99 }, 60);
    expect(a).toBe(b);
  });
});

describe('valhalla', () => {
  const points = [
    { id: 'a', lat: 40.7128, lng: -74.006 },
    { id: 'b', lat: 40.7061, lng: -73.9969 },
  ];

  function matrixResponse(cells: { from_index: number; to_index: number; time: number | null; distance: number | null }[]) {
    return jsonResponse({ sources_to_targets: cells });
  }

  it('maps costing from our mode vocabulary', () => {
    expect(costingFor('car')).toBe('auto');
    expect(costingFor('foot')).toBe('pedestrian');
  });

  it('reads a matrix and zeroes only the diagonal', async () => {
    const outcome = await computeMatrix(points, 'auto', {
      maxPairs: 100,
      fetchImpl: async () =>
        matrixResponse([
          { from_index: 0, to_index: 0, time: 0, distance: 0 },
          { from_index: 0, to_index: 1, time: 181, distance: 1.544 },
          { from_index: 1, to_index: 0, time: 190, distance: 1.6 },
          { from_index: 1, to_index: 1, time: 0, distance: 0 },
        ]),
    });
    expect(outcome.minutes[0]![0]).toBe(0);
    expect(outcome.minutes[0]![1]).toBe(3);
    expect(outcome.failedPairs).toEqual([]);
  });

  it('records a null time as a failed pair rather than as zero', async () => {
    const outcome = await computeMatrix(points, 'auto', {
      maxPairs: 100,
      fetchImpl: async () =>
        matrixResponse([
          { from_index: 0, to_index: 0, time: 0, distance: 0 },
          { from_index: 0, to_index: 1, time: null, distance: null },
          { from_index: 1, to_index: 0, time: 190, distance: 1.6 },
          { from_index: 1, to_index: 1, time: 0, distance: 0 },
        ]),
    });
    expect(outcome.failedPairs).toContainEqual({ from: 'a', to: 'b' });
    expect(Number.isNaN(outcome.minutes[0]![1]!)).toBe(true);
  });

  /**
   * The case a live evaluation actually caught: the public demo returned a
   * 16.5 km pedestrian distance between two points 1.07 km apart, with a
   * duration that reconciled with neither number.
   */
  it('rejects a leg whose distance cannot correspond to the two points', async () => {
    const outcome = await computeMatrix(points, 'pedestrian', {
      maxPairs: 100,
      fetchImpl: async () =>
        matrixResponse([
          { from_index: 0, to_index: 0, time: 0, distance: 0 },
          { from_index: 0, to_index: 1, time: 3508, distance: 16.5 },
          { from_index: 1, to_index: 0, time: 3508, distance: 16.5 },
          { from_index: 1, to_index: 1, time: 0, distance: 0 },
        ]),
    });
    expect(outcome.failedPairs.length).toBeGreaterThan(0);
    expect(Number.isNaN(outcome.minutes[0]![1]!)).toBe(true);
  });

  it('rejects a leg implying an impossible speed for its mode', () => {
    const from = { id: 'a', lat: 40.0, lng: -74.0 };
    const to = { id: 'b', lat: 40.05, lng: -74.0 }; // ~5.5 km apart
    // 5.5 km on foot in four minutes is 82 km/h.
    expect(isPlausibleLeg({ minutes: 4, km: 5.5, from, to, costing: 'pedestrian' })).toBe(false);
    // The same leg by car is unremarkable.
    expect(isPlausibleLeg({ minutes: 6, km: 5.5, from, to, costing: 'auto' })).toBe(true);
  });

  it('does not second-guess a short leg, where snapping noise dominates', () => {
    const from = { id: 'a', lat: 40.0, lng: -74.0 };
    const to = { id: 'b', lat: 40.0009, lng: -74.0 }; // ~100 m
    expect(isPlausibleLeg({ minutes: 3, km: 0.4, from, to, costing: 'pedestrian' })).toBe(true);
  });

  it('reports every pair as failed once the budget is spent, rather than shrinking quietly', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      id: `p${index}`,
      lat: 40 + index * 0.01,
      lng: -74,
    }));
    const outcome = await computeMatrix(many, 'auto', {
      maxPairs: 1,
      fetchImpl: async () => matrixResponse([]),
    });
    expect(outcome.failedPairs.length).toBeGreaterThan(0);
    expect(outcome.pairs).toBeLessThanOrEqual(1);
  });

  it('keys the cache on the endpoint, costing and both point sets', () => {
    const key = matrixCacheKey([points[0]!], [points[1]!], 'auto');
    expect(key).toContain('valhalla');
    expect(key).toContain('auto');
    expect(matrixCacheKey([points[0]!], [points[1]!], 'pedestrian')).not.toBe(key);
  });
});
