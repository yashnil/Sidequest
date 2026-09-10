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
import { computeMatrix, computeRoute, costingFor, decodePolyline6, densify, isPlausibleLeg, matrixPairCacheKey } from './valhalla';

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
    /**
     * AND THERE IS NO THIRD CASE — ENFORCED BY THE TYPE, NOT BY AN ASSERTION.
     *
     * `costingFor('transit')` used to answer `'bus'`: Valhalla's road-network
     * vehicle costing, with no timetable behind it, which would have returned a
     * drive under the name of a scheduled journey.
     *
     * A runtime assertion here would be theatre. The function is now
     * `mode === 'car' ? 'auto' : 'pedestrian'`, so `not.toBe('bus')` holds for
     * every possible input and could never fail — and asserting it would in fact
     * *certify* the remaining oddity, which is that passing `'transit'` at
     * runtime yields a pedestrian costing. The real guard is that `'transit'` is
     * gone from the parameter type, so a caller that acquires a transit mode
     * fails to compile; and the matrix seam refuses `'transit'` outright before
     * this is ever reached. Both are checked where they live, not restated here.
     */
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
    expect(outcome.failedPairs).toContainEqual({ from: 'a', to: 'b', reason: 'not_found' });
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

  /**
   * THE POISONED-RECTANGLE CLASS, PINNED OFFLINE.
   *
   * The live failure: a car-free dense-metro compile whose board correctly
   * includes one far-out anchor. The routing API takes rectangles and refuses
   * them whole — a pedestrian request containing one beyond-limit or
   * too-expensive pair dies as a request — and the provider treated each dead
   * request as 400 dead pairs, then counted the deterministic rejections
   * toward the outage breaker, which opened and discarded every block after.
   * The foot matrix came back with fewer than two points; the car retry
   * succeeded; the planner then rightly refused every stop of a driving
   * matrix for a traveller who said they would not drive. Zero plan, from one
   * far seat.
   */
  function rectangleRouter(isPoisoned: (points: { lat: number; lon: number }[]) => boolean) {
    let requests = 0;
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as {
        sources: { lat: number; lon: number }[];
        targets: { lat: number; lon: number }[];
      };
      if (isPoisoned([...body.sources, ...body.targets])) {
        return jsonResponse({ error: 'exceeds max matrix distance' }, 400);
      }
      const cells = body.sources.flatMap((_, row) =>
        body.targets.map((__, col) => ({
          from_index: row,
          to_index: col,
          time: 600,
          distance: 1,
        })),
      );
      return matrixResponse(cells);
    };
    return { fetchImpl, count: () => requests };
  }

  it('degrades a poisoned pedestrian matrix per pair, never wholesale', async () => {
    const near = Array.from({ length: 4 }, (_, index) => ({
      id: `near-${index}`,
      lat: 40.7 + index * 0.002,
      lng: -74.0,
    }));
    const far = { id: 'far-anchor', lat: 40.85, lng: -73.8 };
    const router = rectangleRouter((pts) => pts.some((pt) => Math.abs(pt.lat - far.lat) < 1e-6));

    const outcome = await computeMatrix([...near, far], 'pedestrian', {
      maxPairs: 400,
      fetchImpl: router.fetchImpl,
    });

    /* Every walkable pair survives the far seat. */
    for (let from = 0; from < near.length; from += 1) {
      for (let to = 0; to < near.length; to += 1) {
        if (from === to) continue;
        expect(
          Number.isFinite(outcome.minutes[from]![to]!),
          `walkable pair near-${from} -> near-${to} was discarded with the poisoned rectangle`,
        ).toBe(true);
      }
    }
    /* The far seat's legs stay honestly unmeasured — failed pairs, never zeros. */
    expect(outcome.failedPairs.length).toBeGreaterThan(0);
    for (const pair of outcome.failedPairs) {
      expect([pair.from, pair.to]).toContain('far-anchor');
    }
    /* And the dense core the compiler keeps is the walkable one, minus one seat. */
    const dense = densify(outcome);
    expect(dense.ids).toEqual(near.map((point) => point.id));
    expect(dense.dropped).toEqual(['far-anchor']);
  }, 120_000);

  it('isolates a poisoned point down to its own pairs, past the quadrant depth', async () => {
    /*
     * The residual the quadrant cap left: a rectangle still failing at max
     * depth was abandoned whole, killing up to two dozen innocent pairs — and
     * because the poisoned point sat at the head of the point order on the
     * live build, the abandoned rectangles covered exactly the mutual legs of
     * the board's top seats, which the routable-core peel then removed. With
     * enough points that quadrant halving alone cannot isolate the poison,
     * every innocent pair must still come back measured; only the poisoned
     * point's own legs stay unmeasured.
     */
    const far = { id: 'far-anchor', lat: 40.85, lng: -73.8 };
    const near = Array.from({ length: 6 }, (_, index) => ({
      id: `near-${index}`,
      lat: 40.7 + index * 0.002,
      lng: -74.0,
    }));
    const router = rectangleRouter((pts) => pts.some((pt) => Math.abs(pt.lat - far.lat) < 1e-6));

    /* Far seat first, mirroring the live composed seat order. */
    const outcome = await computeMatrix([far, ...near], 'pedestrian', {
      maxPairs: 400,
      fetchImpl: router.fetchImpl,
    });

    for (let from = 1; from <= near.length; from += 1) {
      for (let to = 1; to <= near.length; to += 1) {
        if (from === to) continue;
        expect(
          Number.isFinite(outcome.minutes[from]![to]!),
          `innocent pair ${outcome.ids[from]} -> ${outcome.ids[to]} died with an abandoned rectangle`,
        ).toBe(true);
      }
    }
    for (const pair of outcome.failedPairs) {
      expect([pair.from, pair.to]).toContain('far-anchor');
    }
    const dense = densify(outcome);
    expect(dense.dropped).toEqual(['far-anchor']);
    expect(dense.ids).toEqual(near.map((point) => point.id));
  }, 240_000);

  it('never lets deterministic rejections open the outage breaker', async () => {
    /*
     * Five straight 4xx rejections — more than the breaker's threshold — then
     * an answering service. A rejection is a fact about the request, not the
     * service's health; counting it opened the breaker mid-subdivision and the
     * rest of the matrix was discarded unasked.
     */
    let calls = 0;
    const trio = Array.from({ length: 3 }, (_, index) => ({
      id: `t${index}`,
      lat: 40.7 + index * 0.002,
      lng: -74.0,
    }));
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      if (calls <= 5) return jsonResponse({ error: 'bad request' }, 400);
      const body = JSON.parse(String(init?.body)) as {
        sources: unknown[];
        targets: unknown[];
      };
      const cells = body.sources.flatMap((_, row) =>
        body.targets.map((__, col) => ({ from_index: row, to_index: col, time: 600, distance: 1 })),
      );
      return matrixResponse(cells);
    };

    const outcome = await computeMatrix(trio, 'pedestrian', { maxPairs: 400, fetchImpl });

    /* The breaker stayed shut: requests continued past the rejections… */
    expect(calls).toBeGreaterThan(5);
    /* …and the pairs behind them were measured rather than discarded. */
    const measured = outcome.minutes
      .flatMap((row, from) => row.map((value, to) => (from === to ? 0 : value)))
      .filter((value) => Number.isFinite(value) && value > 0);
    expect(measured.length).toBeGreaterThan(0);
  }, 120_000);

  it('bounds retries at MAX_ATTEMPTS (2) per rectangle for a request that never answers — never a third attempt at the same rectangle', async () => {
    // A 2-point matrix is a single 2x2 rectangle, so a total failure here
    // subdivides once (into two 1x1 children) before the lowered
    // `CIRCUIT_THRESHOLD` (3) trips and skips the rest — the top-level
    // attempt (2 calls, MAX_ATTEMPTS) plus at most two 1-attempt children
    // before the breaker opens, never a third attempt at any one rectangle.
    let calls = 0;
    const pair = [
      { id: 'x0', lat: 40.7, lng: -74.0 },
      { id: 'x1', lat: 40.702, lng: -74.0 },
    ];
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      throw new Error('network unreachable');
    };
    const outcome = await computeMatrix(pair, 'pedestrian', { maxPairs: 400, fetchImpl });
    expect(calls).toBeLessThanOrEqual(4);
    expect(outcome.circuitOpened).toBe(true);
  }, 15_000);

  it('classifies a rate limit (429) as rate_limited, never mistaken for a positive answer, and never a retry storm', async () => {
    let calls = 0;
    const pair = [
      { id: 'r0', lat: 40.7, lng: -74.0 },
      { id: 'r1', lat: 40.702, lng: -74.0 },
    ];
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return jsonResponse({ error: 'slow down' }, 429);
    };
    const outcome = await computeMatrix(pair, 'pedestrian', { maxPairs: 400, fetchImpl });
    expect(calls).toBeLessThanOrEqual(4);
    expect(outcome.failedPairs).toContainEqual({ from: 'r0', to: 'r1', reason: 'rate_limited' });
  }, 15_000);

  it('classifies a 5xx as provider_error and, unlike a deterministic 4xx, still counts toward the circuit', async () => {
    let calls = 0;
    const trio = Array.from({ length: 3 }, (_, index) => ({
      id: `s${index}`,
      lat: 40.7 + index * 0.002,
      lng: -74.0,
    }));
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return jsonResponse({ error: 'service unavailable' }, 503);
    };
    const outcome = await computeMatrix(trio, 'pedestrian', { maxPairs: 400, fetchImpl });
    expect(outcome.circuitOpened).toBe(true);
    expect(outcome.failedPairs.every((pair) => pair.reason === 'provider_error')).toBe(true);
    /* The breaker stopped it well short of retrying every one of the 6 ordered pairs individually. */
    expect(calls).toBeLessThan(12);
  }, 30_000);

  it('a malformed response (unparseable body) classifies as provider_error rather than crashing the whole matrix', async () => {
    const pair = [
      { id: 'm0', lat: 40.7, lng: -74.0 },
      { id: 'm1', lat: 40.702, lng: -74.0 },
    ];
    const fetchImpl = async (): Promise<Response> => new Response('not json at all', { status: 200 });
    const outcome = await computeMatrix(pair, 'pedestrian', { maxPairs: 400, fetchImpl });
    expect(outcome.failedPairs).toContainEqual({ from: 'm0', to: 'm1', reason: 'provider_error' });
  }, 15_000);

  it('opens the circuit after CIRCUIT_THRESHOLD (3) consecutive non-deterministic failures, exposed on the outcome', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index}`,
      lat: 40.7 + index * 0.01,
      lng: -74.0,
    }));
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: 'service unavailable' }, 503);
    const outcome = await computeMatrix(many, 'pedestrian', { maxPairs: 400, fetchImpl });
    expect(outcome.circuitOpened).toBe(true);
  }, 30_000);

  it(
    'bounds total wall-clock at MAX_TOTAL_MATRIX_MS even when every request is deterministically rejected (so the circuit never opens)',
    async () => {
      // Deterministic 4xx rejections never trip the breaker (see "never lets
      // deterministic rejections open the outage breaker" above) — this is
      // exactly the scenario where only the wall-clock ceiling, not the
      // circuit breaker, can bound the run. Enough points that full pairwise
      // isolation would need dozens of paced single-pair requests if nothing
      // stopped it early.
      const many = Array.from({ length: 8 }, (_, index) => ({
        id: `d${index}`,
        lat: 40.7 + index * 0.002,
        lng: -74.0,
      }));
      const fetchImpl = async (): Promise<Response> => jsonResponse({ error: 'bad request' }, 400);
      const start = Date.now();
      const outcome = await computeMatrix(many, 'pedestrian', { maxPairs: 400, fetchImpl });
      const elapsedMs = Date.now() - start;
      // A generous margin over MAX_TOTAL_MATRIX_MS (60s) — this proves the
      // ceiling actually bounded the run, not that it hit the exact number.
      expect(elapsedMs).toBeLessThan(75_000);
      expect(outcome.circuitOpened).toBe(false);
      // Every pair still ends up honestly unmeasured, never fabricated.
      for (const row of outcome.minutes) for (const value of row) if (value !== 0) expect(Number.isFinite(value)).toBe(false);
    },
    90_000,
  );

  it('keeps the largest routable core instead of dropping everything', () => {
    /**
     * A live Denali build came back with a matrix of zero points out of
     * forty-one. Nothing had failed at the router: one summit nobody can drive
     * to had an unroutable leg to every other point, so under the old
     * all-or-nothing rule every other point failed too and the whole region was
     * reported as having no usable travel times.
     */
    const ids = ['a', 'b', 'c', 'unreachable'];
    const n = ids.length;
    const minutes = ids.map((_, from) =>
      ids.map((__, to) => {
        if (from === to) return 0;
        // The last point can neither be reached nor left.
        if (from === n - 1 || to === n - 1) return Number.NaN;
        return 10;
      }),
    );
    const km = minutes.map((row) => row.map((value) => (Number.isFinite(value) ? 9 : Number.NaN)));

    const dense = densify({ ids, minutes, km, failedPairs: [], reasonCounts: { not_found: 0, provider_error: 0, rate_limited: 0, budget_exhausted: 0, insufficient_evidence: 0, out_of_coverage: 0, unreachable: 0 }, circuitOpened: false, calls: 1, pairs: 16, cacheHits: 0 });
    expect(dense.ids).toEqual(['a', 'b', 'c']);
    expect(dense.dropped).toEqual(['unreachable']);
    // And the surviving submatrix is complete, which is what the planner needs.
    for (const row of dense.minutes) for (const value of row) expect(Number.isFinite(value)).toBe(true);
  });

  it('returns nothing rather than a matrix of one, when nothing connects', () => {
    const ids = ['a', 'b', 'c'];
    const minutes = ids.map((_, from) => ids.map((__, to) => (from === to ? 0 : Number.NaN)));
    const km = minutes.map((row) => row.map(() => Number.NaN));
    const dense = densify({ ids, minutes, km, failedPairs: [], reasonCounts: { not_found: 0, provider_error: 0, rate_limited: 0, budget_exhausted: 0, insufficient_evidence: 0, out_of_coverage: 0, unreachable: 0 }, circuitOpened: false, calls: 1, pairs: 9, cacheHits: 0 });
    expect(dense.ids).toEqual([]);
    expect(dense.dropped.sort()).toEqual(['a', 'b', 'c']);
  });

  it('keys the cache on the endpoint, the costing and the ordered pair', () => {
    const key = matrixPairCacheKey(points[0]!, points[1]!, 'auto');
    expect(key).toContain('valhalla');
    expect(key).toContain('auto');
    expect(matrixPairCacheKey(points[0]!, points[1]!, 'pedestrian')).not.toBe(key);
    // Direction is part of the identity: a one-way street is not symmetric.
    expect(matrixPairCacheKey(points[1]!, points[0]!, 'auto')).not.toBe(key);
  });

  describe('computeRoute — the bounded, single-pair fallback', () => {
    it('measures a real found route', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () =>
          jsonResponse({ trip: { status: 0, status_message: 'Found route between points', summary: { time: 181, length: 1.544 } } }),
      });
      expect(result).toEqual({ found: true, minutes: 3, km: 1.544 });
    });

    it('classifies Valhalla’s own documented "no path could be found" response as an authoritative not_found, not a generic error', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () => jsonResponse({ error_code: 442, error: 'No path could be found for input', status_code: 400 }, 400),
      });
      expect(result).toEqual({ found: false, minutes: null, km: null, reason: 'not_found' });
    });

    it('does not treat every 4xx as authoritative — only Valhalla’s documented no-path code', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () => jsonResponse({ error_code: 154, error: 'Path distance exceeds the max distance limit', status_code: 400 }, 400),
      });
      expect(result).toEqual({ found: false, minutes: null, km: null, reason: 'provider_error' });
    });

    it('reports a rate limit as its own reason, distinct from a generic provider error', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () => new Response('', { status: 429 }),
      });
      expect(result).toEqual({ found: false, minutes: null, km: null, reason: 'rate_limited' });
    });

    it('degrades a network failure to provider_error, never a thrown exception', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      });
      expect(result).toEqual({ found: false, minutes: null, km: null, reason: 'provider_error' });
    });

    it('refuses a response it cannot parse rather than half-reading it', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () => jsonResponse({ nonsense: true }),
      });
      expect(result).toEqual({ found: false, minutes: null, km: null, reason: 'provider_error' });
    });

    it('never retries — one request, one answer, even on a transient-looking failure', async () => {
      let calls = 0;
      await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () => {
          calls += 1;
          throw new Error('transient');
        },
      });
      expect(calls).toBe(1);
    });
  });

  describe('decodePolyline6 / computeRoute geometry — real route shape, decoded once, never a second request', () => {
    /**
     * A minimal, standard polyline encoder (delta + zigzag + base64-ish
     * chunking) used only to build a real, self-consistent input for the
     * decoder under test — round-tripping through it is what proves the
     * decoder reads Valhalla's own precision (`1e6`) correctly, rather than
     * trusting a memorised encoded string.
     */
    function encodeNumber(num: number): string {
      let output = '';
      let n = num;
      while (n >= 0x20) {
        output += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
        n >>= 5;
      }
      output += String.fromCharCode(n + 63);
      return output;
    }
    function encodeSigned(num: number): string {
      const sgn = num < 0 ? ~(num << 1) : num << 1;
      return encodeNumber(sgn);
    }
    function encodePolyline6(pts: { lat: number; lng: number }[]): string {
      let output = '';
      let prevLat = 0;
      let prevLng = 0;
      for (const point of pts) {
        const lat = Math.round(point.lat * 1e6);
        const lng = Math.round(point.lng * 1e6);
        output += encodeSigned(lat - prevLat);
        output += encodeSigned(lng - prevLng);
        prevLat = lat;
        prevLng = lng;
      }
      return output;
    }

    it('decodes a real polyline6 string back to the original coordinates, at Valhalla’s own 1e6 precision', () => {
      const original = [
        { lat: 64.253265, lng: -15.208044 },
        { lat: 64.9, lng: -16.5 },
        { lat: 65.683904, lng: -18.112176 },
      ];
      const encoded = encodePolyline6(original);
      const decoded = decodePolyline6(encoded);
      expect(decoded).toHaveLength(original.length);
      for (let i = 0; i < original.length; i += 1) {
        expect(decoded[i]!.lat).toBeCloseTo(original[i]!.lat, 5);
        expect(decoded[i]!.lng).toBeCloseTo(original[i]!.lng, 5);
      }
    });

    it('an empty string decodes to no points, not a crash', () => {
      expect(decodePolyline6('')).toEqual([]);
    });

    it('computeRoute threads the trip’s real shape through as geometry — no extra request, the same response Valhalla already sent', async () => {
      const shape = encodePolyline6([
        { lat: 40.7128, lng: -74.006 },
        { lat: 40.71, lng: -73.99 },
        { lat: 40.7061, lng: -73.9969 },
      ]);
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () =>
          jsonResponse({
            trip: {
              status: 0,
              status_message: 'Found route between points',
              summary: { time: 181, length: 1.544 },
              legs: [{ shape }],
            },
          }),
      });
      expect(result.found).toBe(true);
      expect(result.geometry).toBeDefined();
      expect(result.geometry).toHaveLength(3);
      expect(result.geometry![0]!.lat).toBeCloseTo(40.7128, 4);
      expect(result.geometry![2]!.lng).toBeCloseTo(-73.9969, 4);
    });

    it('omits geometry entirely when the response has no legs/shape — never a fabricated empty route', async () => {
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () =>
          jsonResponse({ trip: { status: 0, status_message: 'Found route between points', summary: { time: 181, length: 1.544 } } }),
      });
      expect(result.geometry).toBeUndefined();
    });

    it('concatenates geometry across multiple legs, in order, when a route genuinely has more than one', async () => {
      const legOneShape = encodePolyline6([
        { lat: 40.0, lng: -100.0 },
        { lat: 40.1, lng: -99.9 },
      ]);
      const legTwoShape = encodePolyline6([
        { lat: 40.1, lng: -99.9 },
        { lat: 40.2, lng: -99.8 },
      ]);
      const result = await computeRoute(points[0]!, points[1]!, 'auto', {
        fetchImpl: async () =>
          jsonResponse({
            trip: {
              status: 0,
              status_message: 'Found route between points',
              summary: { time: 181, length: 1.544 },
              legs: [{ shape: legOneShape }, { shape: legTwoShape }],
            },
          }),
      });
      expect(result.geometry).toHaveLength(4);
      expect(result.geometry![3]!.lat).toBeCloseTo(40.2, 4);
    });
  });
});
