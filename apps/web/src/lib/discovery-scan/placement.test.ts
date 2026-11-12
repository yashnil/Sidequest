import { describe, expect, it, vi } from 'vitest';
import { normalizeScanProposal } from '@sidequest/core';

vi.mock('server-only', () => ({}));
vi.mock('../providers/registry', () => ({ capability: () => ({ configured: false }) }));
vi.mock('../providers/nominatim', () => ({
  geocode: vi.fn(async (query: string) => ({
    places: query === 'Akureyri, Akureyri, Iceland' ? [{ name: 'Akureyri (Hof)', category: 'amenity', type: 'charging_station', lat: '65.684', lon: '-18.086', place_rank: 30, address: { country_code: 'is' } }]
      : query === 'Akureyri, Iceland' || query === 'Egilsstaðir, Iceland' ? [{ name: query.split(',')[0], category: 'place', type: 'town', lat: query.startsWith('A') ? '65.683' : '65.262', lon: query.startsWith('A') ? '-18.112' : '-14.403', place_rank: 16, address: { country_code: 'is', town: query.split(',')[0] } }]
      : query === 'Passo Giau, Italy' ? [{ lat: '46.4830', lon: '12.0540', place_rank: 30, address: { country_code: 'it', village: 'San Vito di Cadore' } }] : query === 'Far Away Lake, Italy' ? [{ lat: '40.0', lon: '15.0', place_rank: 30, address: { country_code: 'it' } }] : query.startsWith('전쟁기념관') ? [{ lat: '37.5364', lon: '126.9773', place_rank: 30, address: { country_code: 'kr', city_district: '용산구' } }] : [],
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

describe('a place to sleep named as its own locality (staging Iceland finding)', () => {
  it('is asked for as "town, country", and a region locality that finds nothing falls back to the same', async () => {
    const normalized = normalizeScanProposal({
      bases: [
        { name: 'Akureyri', locality: 'Akureyri', nightsHint: 2, why: 'North.' },
        { name: 'Egilsstaðir', locality: 'Austurland', nightsHint: 2, why: 'East.' },
      ],
      candidates: [{ name: 'Goðafoss', locality: 'Þingeyjarsveit', kind: 'viewpoint', tier: 'classic', why: 'Falls.' }],
    });
    if (!normalized.ok) throw new Error(normalized.reason);
    const { placeScanProposal } = await import('./placement');
    const result = await placeScanProposal({ ...normalized.proposal, candidates: [] }, { center: { lat: 64.9, lng: -18.5 }, maxDistanceKm: 500, countryCode: 'IS', countryName: 'Iceland', placesBudget: 0, deadline: () => false });
    const [akureyri, egilsstadir] = normalized.proposal.bases;
    const a = result.diagnostics.find((d) => d.key === akureyri!.key)!;
    expect(a.outcome).toBe('placed');
    expect(a.attempts[0]!.query).toBe('Akureyri, Iceland');
    expect(result.positions.get(akureyri!.key)?.approximate).toBe(false);
    const e = result.diagnostics.find((d) => d.key === egilsstadir!.key)!;
    expect(e.outcome).toBe('placed');
    expect(e.attempts.map((x) => x.query)).toEqual(['Egilsstaðir, Austurland, Iceland', 'Egilsstaðir, Iceland']);
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

describe('the wrong kind of answer (live Tanzania scan)', () => {
  it('a lodge or camp never stands for an experience whose name it does not carry; a lodge terrace keeps its lodge', async () => {
    const { answerIsWrongKind } = await import('./placement');
    /* Recorded: "Ngorongoro Highlands, Tanzania" answered with a motel 500 km south. */
    expect(answerIsWrongKind({ lookupName: 'Ngorongoro Highlands', resultName: 'Ngorongoro Lodge', osmCategory: 'tourism', osmType: 'motel' })).toBe(true);
    expect(answerIsWrongKind({ lookupName: 'Ngorongoro Serena viewpoint lodge terrace', resultName: 'Ngorongoro Serena Safari Lodge', googleTypes: ['lodging'] })).toBe(false);
    expect(answerIsWrongKind({ lookupName: 'Crater rim', resultName: 'Rim Safaris Ltd', googleTypes: ['travel_agency', 'point_of_interest'] })).toBe(true);
    expect(answerIsWrongKind({ lookupName: 'Snake Park', resultName: 'Snake Park', googleTypes: ['travel_agency', 'tourist_attraction'] })).toBe(false);
    expect(answerIsWrongKind({ lookupName: 'Olmoti Crater', resultName: 'Olmoti Crater', osmCategory: 'natural', osmType: 'caldera' })).toBe(false);
  });

  it('reads what kind of thing answered: a town, an area, or a point', async () => {
    const { answerScaleOfRow, answerScaleOfTypes } = await import('./placement');
    expect(answerScaleOfRow({ category: 'boundary', type: 'administrative' })).toBe('settlement');
    expect(answerScaleOfRow({ category: 'place', type: 'town' })).toBe('settlement');
    expect(answerScaleOfRow({ category: 'boundary', type: 'national_park' })).toBe('area');
    expect(answerScaleOfRow({ category: 'leisure', type: 'nature_reserve' })).toBe('area');
    expect(answerScaleOfRow({ category: 'tourism', type: 'camp_site' })).toBe('point');
    expect(answerScaleOfTypes(['national_park', 'point_of_interest'])).toBe('area');
    expect(answerScaleOfTypes(['locality', 'political'])).toBe('settlement');
  });
});
