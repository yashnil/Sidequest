import { describe, expect, it, vi } from 'vitest';

/*
 * V1 — a first-level division whose "settlement" answer is only itself stays a
 * division. Recorded shape (2026-10-06): asked for settlements named "Utah", the
 * geocoder returns the Utah state record, which used to promote the state to a
 * city-region because it matched its own box.
 */
const STATE = {
  place_id: 10,
  osm_type: 'relation',
  osm_id: 161993,
  lat: '39.42',
  lon: '-111.71',
  display_name: 'Testland, United States',
  name: 'Testland',
  category: 'boundary',
  type: 'administrative',
  addresstype: 'state',
  importance: 0.8,
  place_rank: 8,
  boundingbox: ['36.99', '42.00', '-114.05', '-109.04'],
  address: { state: 'Testland', country: 'United States', country_code: 'us' },
  extratags: { admin_level: '4', linked_place: 'state' },
};

vi.mock('./nominatim', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, geocode: vi.fn(async () => ({ places: [STATE], calls: 1, cacheHit: false })) };
});
vi.mock('../net/user-agent', () => ({ providerUserAgent: () => 'test' }));

describe('a division whose settlement answer is itself', () => {
  it('stays a state or province', async () => {
    const { createOpenResolver } = await import('./open-verification');
    const diagnostics = { geocoderCalls: 0, geocoderCacheHits: 0 } as unknown as Parameters<typeof createOpenResolver>[0]['diagnostics'];
    const result = await createOpenResolver({ diagnostics }).resolve({ query: 'Testland' } as never);
    expect(result.candidates[0]?.entityType).toBe('state_or_province');
  });
});
