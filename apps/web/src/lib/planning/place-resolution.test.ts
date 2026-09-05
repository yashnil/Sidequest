import { describe, expect, it } from 'vitest';
import { reconcileTripDraft, type ProviderPlaceIdentity } from './reconcile';
import { draftOf, fictionalWorld } from './acceptance/harness';

/**
 * LIVE WORLD V1 — place resolution v2.
 *   persisted identity → board → compiled → places provider → geocoder → unresolved
 */
const PLACES = [
  { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' as const },
  { name: 'Known Fort', lat: 50.05, lng: 10.02 },
  { name: 'Secret Bakery', lat: 50.02, lng: 10.03, known: false },
  { name: 'Far Tower', lat: 50.03, lng: 10.04, known: false },
];

function draft() {
  return draftOf({ bases: [{ id: 'b1', name: 'Base Town', nights: 1 }], days: [{ base: 'b1', anchors: [{ name: 'Known Fort' }, { name: 'Secret Bakery', category: 'food' }, { name: 'Far Tower', category: 'landmark' }] }, { base: 'b1', anchors: [{ name: 'Known Fort' }] }] });
}

describe('LIVE WORLD V1 — resolution order', () => {
  it('a places provider resolves what the geocoder cannot, keeps the model’s name, persists the provider ref, and a weak match falls through', async () => {
    const world = fictionalWorld({ name: 'Resolveland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-02' } });
    const asked: string[] = [];
    const resolvePlaceIdentity = async (input: { name: string; category: string }): Promise<ProviderPlaceIdentity | null> => {
      asked.push(input.name);
      if (input.name === 'Secret Bakery') return { providerRef: 'ChIJ-bakery', provider: 'google-places', name: 'The Secret Bakery Co.', coordinates: { lat: 50.02, lng: 10.03 }, placeClass: 'business_venue', confidence: 'exact', attribution: 'Place data © Google' };
      if (input.name === 'Far Tower') return { providerRef: 'ChIJ-weak', provider: 'google-places', name: 'Far Tower Inn', coordinates: { lat: 50.03, lng: 10.04 }, placeClass: 'business_venue', confidence: 'weak', attribution: 'Place data © Google' };
      return null;
    };
    const result = await reconcileTripDraft({ draft: draft(), context: { ...world.context, resolvePlaceIdentity } });
    const anchors = result.itinerary.package!.anchors;
    const bakery = anchors.find((a) => a.name === 'Secret Bakery')!;
    expect(bakery.verification).toBe('partially_verified');
    expect(bakery.identity?.method).toBe('places');
    expect(bakery.identity?.providerRef).toBe('ChIJ-bakery');
    expect(bakery.identity?.provider).toBe('google-places');
    expect(bakery.placeId).toBe('google-places:ChIJ-bakery');
    // The plan keeps the name the model wrote; the provider's display name is matched, never stored.
    expect(JSON.stringify(result.itinerary)).not.toContain('The Secret Bakery Co.');
    const tower = anchors.find((a) => a.name === 'Far Tower')!;
    expect(tower.verification).toBe('unverified');
    expect(tower.identity).toBeUndefined();
    // The seam sits before the locality geocoder, so every name without board or compiled evidence reaches it — once per anchor, never for the base.
    expect(asked.filter((n) => n === 'Secret Bakery')).toHaveLength(1);
    expect(asked).not.toContain('Base Town');
    expect(result.deviations.some((d) => d.kind === 'anchor_resolved_via_places')).toBe(true);
    expect(anchors).toHaveLength(4);
  });

  it('a persisted identity is reused before any lookup, and the geocoder is never asked for it', async () => {
    const world = fictionalWorld({ name: 'Resolveland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-02' } });
    const persistedIdentities = new Map([['secret bakery', { method: 'places' as const, provider: 'google-places', providerRef: 'ChIJ-bakery', coordinates: { lat: 50.02, lng: 10.03 }, placeClass: 'business_venue' as const, confidence: 'exact' as const, resolvedAt: '2026-09-01T00:00:00.000Z', name: 'Secret Bakery', placeId: 'google-places:ChIJ-bakery' }]]);
    let seamCalls = 0;
    const result = await reconcileTripDraft({ draft: draft(), context: { ...world.context, persistedIdentities, resolvePlaceIdentity: async () => { seamCalls += 1; return null; } } });
    const bakery = result.itinerary.package!.anchors.find((a) => a.name === 'Secret Bakery')!;
    expect(bakery.identity?.method).toBe('persisted');
    expect(bakery.identity?.providerRef).toBe('ChIJ-bakery');
    expect(bakery.verification).toBe('partially_verified');
    // The persisted name never went to the seam; the other three anchors did.
    expect(seamCalls).toBe(3);
  });
});
