import { describe, expect, it, vi } from 'vitest';

/**
 * V7 §2 — A DIVISION THAT IS ALSO A CITY OF THE SAME NAME IS A CITY-REGION.
 *
 * The live Chongqing resolution of 2026-09-11 came back with the
 * direct-administered municipality typed `state` first and the city node of the
 * same name second, inside the division's box. The first compile read the
 * trip as "a state or province you drive"; the evidence that it is a city was
 * already in the same answer. No extra call is needed for that case.
 */
const CHONGQING_DIVISION = {
  place_id: 1,
  osm_type: 'relation',
  osm_id: 913069,
  lat: '30.05518',
  lon: '107.8748712',
  display_name: '重庆市, 中国',
  name: 'Chongqing',
  class: 'boundary',
  type: 'administrative',
  addresstype: 'state',
  importance: 0.7,
  boundingbox: ['28.161744', '32.2036631', '105.2868306', '110.1944429'],
  address: { state: '重庆市', country: '中国', country_code: 'cn' },
  extratags: { admin_level: '4' },
};
const CHONGQING_CITY = {
  place_id: 2,
  osm_type: 'node',
  osm_id: 734098547,
  lat: '29.5656729',
  lon: '106.5479189',
  display_name: '重庆市, 渝中区, 重庆市, 400014, 中国',
  name: 'Chongqing',
  class: 'place',
  type: 'city',
  addresstype: 'city',
  importance: 0.6,
  boundingbox: ['29.4056729', '29.7256729', '106.3879189', '106.7079189'],
  address: { city: '重庆市', state: '重庆市', country: '中国', country_code: 'cn' },
};

vi.mock('./nominatim', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    geocode: vi.fn(async (_query: string, options?: { featureType?: string }) => ({ places: options?.featureType === 'settlement' ? [] : [CHONGQING_DIVISION, CHONGQING_CITY], calls: 1, cacheHit: false })),
  };
});
vi.mock('../net/user-agent', () => ({ providerUserAgent: () => 'test' }));

describe('the open resolver and a division that is also a city', () => {
  it('reads Chongqing as a municipality from the city record in the same answer, with no extra call', async () => {
    const { createOpenResolver } = await import('./open-verification');
    const diagnostics = { geocoderCalls: 0, geocoderCacheHits: 0 } as unknown as Parameters<typeof createOpenResolver>[0]['diagnostics'];
    const resolver = createOpenResolver({ diagnostics });
    const result = await resolver.resolve({ query: 'Chongqing' } as never);
    expect(result.candidates[0]?.entityType).toBe('municipality');
    expect(result.candidates[0]?.note).toMatch(/city of the same name inside it/);
    expect(diagnostics.geocoderCalls).toBe(1);
  });
});
