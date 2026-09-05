import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NominatimPlace } from '../providers/nominatim';
import type { OverpassElement } from '../providers/overpass';

/**
 * These test the two production-wiring functions in isolation — the real
 * `geocode()` and `RoutingProvider.matrix()` are mocked/faked, never called
 * live, per this round's "no provider calls" constraint. `planFromSkeletonForTrip`
 * itself (the full trip -> region -> board assembly) needs a real trip,
 * profile and compiled region to exercise meaningfully, which is exactly the
 * live-run integration this round explicitly does not execute — so this file
 * proves the two *wiring* functions are correct and model-free, and leaves
 * the full assembly to the next live validation.
 */

vi.mock('../providers/nominatim', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../providers/nominatim');
  return { ...actual, geocode: vi.fn(), reverseGeocode: vi.fn() };
});

vi.mock('../providers/overpass', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../providers/overpass');
  return { ...actual, fetchSettlements: vi.fn(), isPoiProviderEnabled: vi.fn() };
});

describe('productionGeocodeLocality — real Nominatim, zero model calls', () => {
  it('calls the real geocode() function directly, never through a resolver that corroborates with a model', async () => {
    const source = readFileSync(new URL('./skeleton-orchestrator.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bgeocode\b[^}]*\}\s*from\s*['"]\.\.\/providers\/nominatim['"]/);
    expect(source).not.toMatch(/interpretDestination/);
    expect(source).not.toMatch(/\.resolver\.resolve\(/);
  });

  it('maps a real Nominatim response into GeocodedLocality, using the same osm-element id convention used elsewhere', async () => {
    const { geocode } = await import('../providers/nominatim');
    const { productionGeocodeLocality } = await import('./skeleton-orchestrator');
    const place: NominatimPlace = {
      place_id: 12345,
      osm_type: 'node',
      osm_id: 987654,
      lat: '64.14598',
      lon: '-21.94224',
      display_name: 'Reykjavík, Iceland',
      name: 'Reykjavík',
      namedetails: { 'name:en': 'Reykjavik' },
      addresstype: 'city',
      importance: 0.83,
    };
    vi.mocked(geocode).mockResolvedValue({ places: [place], calls: 1, cacheHit: false });

    const results = await productionGeocodeLocality('Reykjavík, Iceland');
    expect(geocode).toHaveBeenCalledWith('Reykjavík, Iceland', expect.objectContaining({ limit: 5 }));
    expect(results).toEqual([
      { sourceId: 'node/987654', name: 'Reykjavik', lat: 64.14598, lng: -21.94224, entityType: 'city', importance: 0.83 },
    ]);
  });

  it('drops a result with no usable coordinates or identity rather than inventing one', async () => {
    const { geocode } = await import('../providers/nominatim');
    const { productionGeocodeLocality } = await import('./skeleton-orchestrator');
    vi.mocked(geocode).mockResolvedValue({
      places: [
        { lat: 'not-a-number', lon: '-21.9', display_name: 'Bad coordinates' },
        { lat: '64.1', lon: '-21.9', display_name: 'No identity at all' },
      ],
      calls: 1,
      cacheHit: false,
    });
    const results = await productionGeocodeLocality('Somewhere');
    expect(results).toEqual([]);
  });
});

describe('productionRouteMatrix — the real RoutingProvider, bounded to the points asked for', () => {
  it('requests exactly the given points, in the trip’s own travel mode, never the whole region', async () => {
    const { productionRouteMatrix } = await import('./skeleton-orchestrator');
    const matrix = vi.fn().mockResolvedValue({
      ids: ['a', 'b'],
      minutes: [
        [0, 42],
        [42, 0],
      ],
      km: [
        [0, 10],
        [10, 0],
      ],
      provenance: { kind: 'measured' as const, note: 'fixture' },
      failedPairs: [{ from: 'a', to: 'c', reason: 'not_found' }],
      calls: 1,
      elements: 4,
    });
    const routing = { name: 'fixture', supportedModes: () => ['car' as const], matrix };
    const points = [
      { id: 'a', lat: 1, lng: 2 },
      { id: 'b', lat: 3, lng: 4 },
    ];

    const result = await productionRouteMatrix(routing, 'car', points);

    expect(matrix).toHaveBeenCalledWith({ points, mode: 'car', maxElements: 4 });
    expect(result).toEqual({
      ids: ['a', 'b'],
      minutes: [
        [0, 42],
        [42, 0],
      ],
      km: [
        [0, 10],
        [10, 0],
      ],
      // Forwarded, not dropped — the whole point of this round's fix.
      failedPairs: [{ fromId: 'a', toId: 'c', reason: 'not_found' }],
    });
  });

  it('degrades an unrecognized provider gap reason to provider_error rather than losing the pair', async () => {
    const { productionRouteMatrix } = await import('./skeleton-orchestrator');
    const matrix = vi.fn().mockResolvedValue({
      ids: ['a', 'b'],
      minutes: [
        [0, 42],
        [42, 0],
      ],
      km: [
        [0, 10],
        [10, 0],
      ],
      provenance: { kind: 'measured' as const, note: 'fixture' },
      failedPairs: [{ from: 'a', to: 'b', reason: 'no_official_source' }],
      calls: 1,
      elements: 4,
    });
    const routing = { name: 'fixture', supportedModes: () => ['car' as const], matrix };
    const points = [
      { id: 'a', lat: 1, lng: 2 },
      { id: 'b', lat: 3, lng: 4 },
    ];

    const result = await productionRouteMatrix(routing, 'car', points);
    expect(result?.failedPairs).toEqual([{ fromId: 'a', toId: 'b', reason: 'provider_error' }]);
  });

  it('returns null rather than a single-point matrix, and never calls the provider for it', async () => {
    const { productionRouteMatrix } = await import('./skeleton-orchestrator');
    const matrix = vi.fn();
    const routing = { name: 'fixture', supportedModes: () => ['car' as const], matrix };
    const result = await productionRouteMatrix(routing, 'car', [{ id: 'a', lat: 1, lng: 2 }]);
    expect(result).toBeNull();
    expect(matrix).not.toHaveBeenCalled();
  });

  it('returns null for a mode the provider does not support, rather than asking it anyway', async () => {
    const { productionRouteMatrix } = await import('./skeleton-orchestrator');
    const matrix = vi.fn();
    const routing = { name: 'fixture', supportedModes: () => ['car' as const], matrix };
    const points = [
      { id: 'a', lat: 1, lng: 2 },
      { id: 'b', lat: 3, lng: 4 },
    ];
    const result = await productionRouteMatrix(routing, 'foot', points);
    expect(result).toBeNull();
    expect(matrix).not.toHaveBeenCalled();
  });
});

describe('productionFindNearbyLocalities — bounded Overpass settlement search, Nominatim fallback', () => {
  const HOFN_LIKE_POINT = { lat: 64.9, lng: -16.5 };

  // Each test's own `expect(fetchSettlements).not.toHaveBeenCalled()` (and
  // similar) needs a clean mock call history — without this, an earlier
  // test's calls bleed into a later one's assertion.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function settlementElement(overrides: Partial<OverpassElement> = {}): OverpassElement {
    return {
      type: 'node',
      id: 111,
      lat: 64.95,
      lon: -16.4,
      tags: { name: 'Fictional Fjord Town', place: 'town' },
      ...overrides,
    };
  }

  it('searches a bounded box around the point, sized to the given radius — never the whole region', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(true);
    vi.mocked(fetchSettlements).mockResolvedValue({
      elements: [settlementElement()],
      dataTimestamp: null,
      calls: 1,
      cacheHit: false,
      bytes: 0,
      failedGroups: [],
    });

    await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);

    expect(fetchSettlements).toHaveBeenCalledTimes(1);
    const [box] = vi.mocked(fetchSettlements).mock.calls[0]!;
    // A 20 km radius is roughly 0.18 degrees of latitude — comfortably
    // bounded, nowhere near a whole-country box.
    expect(box.north - box.south).toBeGreaterThan(0);
    expect(box.north - box.south).toBeLessThan(1);
    expect(box.east - box.west).toBeGreaterThan(0);
    expect(box.east - box.west).toBeLessThan(1);
  });

  it('maps a real settlement element into a GeocodedLocality, classified the same way a Nominatim city/town is', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(true);
    vi.mocked(fetchSettlements).mockResolvedValue({
      elements: [settlementElement({ tags: { name: 'Fictional Fjord Town', place: 'town' } })],
      dataTimestamp: null,
      calls: 1,
      cacheHit: false,
      bytes: 0,
      failedGroups: [],
    });

    const results = await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);
    expect(results).toEqual([
      { sourceId: 'node/111', name: 'Fictional Fjord Town', lat: 64.95, lng: -16.4, entityType: 'city' },
    ]);
  });

  it('classifies a village/hamlet as a neighbourhood, matching classifyNominatim’s own bucket', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(true);
    vi.mocked(fetchSettlements).mockResolvedValue({
      elements: [settlementElement({ id: 222, tags: { name: 'Fictional Hamlet', place: 'hamlet' } })],
      dataTimestamp: null,
      calls: 1,
      cacheHit: false,
      bytes: 0,
      failedGroups: [],
    });

    const results = await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);
    expect(results[0]!.entityType).toBe('neighbourhood');
  });

  it('caps the number of settlements returned per point, nearest first, even when the search returns more', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(true);
    const many = Array.from({ length: 10 }, (_, i) =>
      settlementElement({ id: i, lat: 64.95 + i * 0.01, lon: -16.4, tags: { name: `Town ${i}`, place: 'village' } }),
    );
    vi.mocked(fetchSettlements).mockResolvedValue({
      elements: many,
      dataTimestamp: null,
      calls: 1,
      cacheHit: false,
      bytes: 0,
      failedGroups: [],
    });

    const results = await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);
    expect(results.length).toBeLessThan(many.length);
    // Nearest first: index 0 is closest to HOFN_LIKE_POINT (64.9, -16.5).
    expect(results[0]!.sourceId).toBe('node/0');
  });

  it('falls back to the exact-point Nominatim reverse geocoder when the map-data provider is switched off', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { reverseGeocode } = await import('../providers/nominatim');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(false);
    const place: NominatimPlace = {
      osm_type: 'relation',
      osm_id: 56165,
      lat: '65.28',
      lon: '-16.98',
      display_name: 'Fictional District',
      name: 'Fictional District',
      addresstype: 'county',
    };
    vi.mocked(reverseGeocode).mockResolvedValue({ place, calls: 1, cacheHit: false });

    const results = await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);
    expect(fetchSettlements).not.toHaveBeenCalled();
    expect(reverseGeocode).toHaveBeenCalledWith(HOFN_LIKE_POINT.lat, HOFN_LIKE_POINT.lng);
    expect(results).toEqual([
      { sourceId: 'relation/56165', name: 'Fictional District', lat: 65.28, lng: -16.98, entityType: 'subregion' },
    ]);
  });

  it('falls back to the exact-point reverse geocoder when the bounded search itself fails, rather than throwing', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { reverseGeocode } = await import('../providers/nominatim');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(true);
    vi.mocked(fetchSettlements).mockRejectedValue(new Error('the map data service is busy'));
    vi.mocked(reverseGeocode).mockResolvedValue({ place: null, calls: 1, cacheHit: false });

    const results = await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);
    expect(results).toEqual([]);
  });

  it('an honest empty result when nothing real is found and the fallback also finds nothing', async () => {
    const { fetchSettlements, isPoiProviderEnabled } = await import('../providers/overpass');
    const { reverseGeocode } = await import('../providers/nominatim');
    const { productionFindNearbyLocalities } = await import('./skeleton-orchestrator');
    vi.mocked(isPoiProviderEnabled).mockReturnValue(true);
    vi.mocked(fetchSettlements).mockResolvedValue({
      elements: [],
      dataTimestamp: null,
      calls: 1,
      cacheHit: false,
      bytes: 0,
      failedGroups: [],
    });
    vi.mocked(reverseGeocode).mockResolvedValue({ place: null, calls: 1, cacheHit: false });

    const results = await productionFindNearbyLocalities(HOFN_LIKE_POINT, 20);
    expect(results).toEqual([]);
  });
});

describe('the production orchestrator never reaches the model', () => {
  it('imports createOpenProviders with a zero call budget, not the module-level uncapped provider set', () => {
    const source = readFileSync(new URL('./skeleton-orchestrator.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/createOpenProviders\(\s*\{\s*maxModelCalls:\s*0\s*\}\s*\)/);
    expect(source).not.toMatch(/from ['"].*compiler\/providers['"]/);
  });
});
