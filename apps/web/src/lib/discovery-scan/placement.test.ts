import { describe, expect, it, vi } from 'vitest';
import { normalizeScanProposal } from '@sidequest/core';

vi.mock('server-only', () => ({}));
vi.mock('../providers/registry', () => ({ capability: () => ({ configured: false }) }));
vi.mock('../providers/nominatim', () => ({
  geocode: vi.fn(async (query: string) => ({
    places: query.startsWith('전쟁기념관') ? [{ lat: '37.5364', lon: '126.9773', place_rank: 30, address: { country_code: 'kr', city_district: '용산구' } }] : [],
    calls: 1,
    cacheHit: false,
  })),
}));

describe('placement by the local name (live Seoul finding)', () => {
  it('a place the geocoder knows only by its local name is placed by it, and the attempts say so', async () => {
    const normalized = normalizeScanProposal({
      bases: [{ name: 'Jongno', locality: 'Seoul', nightsHint: 4, why: 'Central.' }],
      candidates: [{ name: 'War Memorial of Korea', localName: '전쟁기념관', locality: 'Yongsan', kind: 'museum', tier: 'classic', why: 'History.' }],
    });
    if (!normalized.ok) throw new Error(normalized.reason);
    const { placeScanProposal } = await import('./placement');
    const result = await placeScanProposal({ ...normalized.proposal, bases: [] }, { center: { lat: 37.5665, lng: 126.978 }, maxDistanceKm: 120, countryCode: 'KR', countryName: 'South Korea', placesBudget: 0, deadline: () => false });
    const key = normalized.proposal.candidates[0]!.key;
    expect(result.positions.get(key)).not.toBeNull();
    const diagnostic = result.diagnostics.find((d) => d.key === key)!;
    expect(diagnostic.outcome).toBe('placed');
    expect(diagnostic.attempts.map((a) => `${a.query} → ${a.outcome}`)).toEqual(['War Memorial of Korea, Yongsan, South Korea → no_results', '전쟁기념관, South Korea → placed']);
  });
});
