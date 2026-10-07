import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { resolveIdentity } from './google-places';

const response = (places: unknown[]) => (async () => new Response(JSON.stringify({ places }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('a Google answer with an untyped address component (live Dolomites finding)', () => {
  it('is still read: one component without types no longer throws the whole lookup away', async () => {
    const fetchImpl = response([
      { id: 'a', displayName: { text: 'Grey Ridge' }, location: { latitude: 46.6, longitude: 12.3 }, types: ['natural_feature'], addressComponents: [{ longText: 'Somewhere' }, { longText: 'IT', shortText: 'IT', types: ['country'] }] },
    ]);
    const hit = await resolveIdentity({ name: 'Grey Ridge', near: { lat: 46.55, lng: 12.2 }, radiusKm: 50 }, { fetchImpl, apiKey: 'test' });
    expect(hit?.providerRef).toBe('a');
  });

  it('can match a different name from the one searched for: an access query matched against the place it serves', async () => {
    const fetchImpl = response([{ id: 'lift', displayName: { text: 'Funivia Greyridge' }, location: { latitude: 46.58, longitude: 12.28 }, types: ['point_of_interest'] }]);
    expect(await resolveIdentity({ name: 'Greyridge cable car', near: { lat: 46.55, lng: 12.2 }, radiusKm: 50 }, { fetchImpl, apiKey: 'test' })).toBeNull();
    expect((await resolveIdentity({ name: 'Greyridge cable car', matchName: 'Greyridge', near: { lat: 46.55, lng: 12.2 }, radiusKm: 50 }, { fetchImpl, apiKey: 'test' }))?.providerRef).toBe('lift');
  });
});
