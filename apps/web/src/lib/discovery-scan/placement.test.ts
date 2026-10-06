import { describe, expect, it, vi } from 'vitest';
import { normalizeScanProposal } from '@sidequest/core';

vi.mock('server-only', () => ({}));
vi.mock('../providers/registry', () => ({ capability: () => ({ configured: false }) }));
vi.mock('../providers/nominatim', () => ({
  geocode: vi.fn(async (query: string) => ({
    places: query === 'Passo Giau, Italy' ? [{ lat: '46.4830', lon: '12.0540', place_rank: 30, address: { country_code: 'it', village: 'San Vito di Cadore' } }] : query === 'Far Away Lake, Italy' ? [{ lat: '40.0', lon: '15.0', place_rank: 30, address: { country_code: 'it' } }] : query.startsWith('전쟁기념관') ? [{ lat: '37.5364', lon: '126.9773', place_rank: 30, address: { country_code: 'kr', city_district: '용산구' } }] : [],
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
    expect(diagnostic.attempts.map((a) => `${a.query} → ${a.outcome}`)).toEqual(['War Memorial of Korea, Yongsan, South Korea → no_results', 'War Memorial of Korea, South Korea → no_results', '전쟁기념관, South Korea → placed']);
  });
});

describe('placement by the name alone (live Dolomites finding)', () => {
  it('a place whose proposed locality misleads the geocoder is placed by its name in the country, still within reach', async () => {
    const normalized = normalizeScanProposal({
      bases: [{ name: 'Cortina', locality: 'Cortina d\'Ampezzo', nightsHint: 4, why: 'Central.' }],
      candidates: [
        { name: 'Passo Giau', locality: 'Colle Santa Lucia', kind: 'viewpoint', tier: 'classic', why: 'Views.' },
        { name: 'Far Away Lake', locality: 'Nowhere', kind: 'lake_or_river', tier: 'classic', why: 'Too far.' },
      ],
    });
    if (!normalized.ok) throw new Error(normalized.reason);
    const { placeScanProposal } = await import('./placement');
    const result = await placeScanProposal({ ...normalized.proposal, bases: [] }, { center: { lat: 46.54, lng: 12.14 }, maxDistanceKm: 120, countryCode: 'IT', countryName: 'Italy', placesBudget: 0, deadline: () => false });
    const [giau, far] = normalized.proposal.candidates;
    expect(result.positions.get(giau!.key)).not.toBeNull();
    // The name-only answer is still gated by distance: 700 km away is refused, never adopted.
    expect(result.positions.get(far!.key)).toBeNull();
    expect(result.diagnostics.find((d) => d.key === far!.key)?.outcome).toBe('outside_envelope');
  });
});
