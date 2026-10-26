import { describe, expect, it, vi } from 'vitest';
import type { OverpassElement } from '../providers/overpass';

/*
 * The live dependencies, with the network replaced: Wikidata answers per box,
 * and OpenStreetMap is never needed because Wikidata alone is rich enough.
 */
const asked: { lat: number; lng: number }[] = [];
vi.mock('../providers/wikidata-around', () => ({
  fetchWikidataAround: vi.fn(async (center: { lat: number; lng: number }) => {
    asked.push(center);
    const west = center.lng < -20;
    const elements: OverpassElement[] = Array.from({ length: 30 }, (_, i) => ({
      type: 'node',
      id: (west ? 2000 : 1000) + i,
      lat: center.lat + i * 0.001,
      lon: center.lng,
      tags: { tourism: 'museum', name: `${west ? 'Island' : 'Mainland'} ${i}`, wikidata: `Q${(west ? 2000 : 1000) + i}`, 'source:sidequest': 'wikidata' },
    }));
    return { elements, sitelinks: new Map(elements.map((e) => [e.tags!.wikidata!, west ? 7 : 9])) };
  }),
}));
vi.mock('../providers/open-verification', () => ({ cacheFor: () => ({ read: () => null, write: () => undefined }), TTL: { poi: 1 } }));

describe('liveOpenDataDeps', () => {
  it('answers each box from its own Wikidata request, never the first box’s', async () => {
    const { liveOpenDataDeps, boxAround, NOTABLE_SELECTORS } = await import('./open-data-proposal');
    const deps = liveOpenDataDeps();
    const tourism = NOTABLE_SELECTORS.find((s) => s.key === 'tourism')!;
    const mainland = await deps.fetchGroup(boxAround({ lat: 38.7, lng: -9.1 }, 60), tourism, 1.5);
    const islands = await deps.fetchGroup(boxAround({ lat: 37.8, lng: -25.5 }, 60), tourism, 1.5);
    expect(asked).toHaveLength(2);
    expect(mainland.elements.every((e) => e.tags?.name?.startsWith('Mainland'))).toBe(true);
    expect(islands.elements.every((e) => e.tags?.name?.startsWith('Island'))).toBe(true);
    // Asking the same box again is the memo, not a third request; sitelinks come from whichever box answered.
    await deps.fetchGroup(boxAround({ lat: 37.8, lng: -25.5 }, 60), tourism, 1.5);
    expect(asked).toHaveLength(2);
    const counts = await deps.fetchSitelinks(['Q1000', 'Q2000']);
    expect(counts.get('Q1000')).toBe(9);
    expect(counts.get('Q2000')).toBe(7);
  });
});
