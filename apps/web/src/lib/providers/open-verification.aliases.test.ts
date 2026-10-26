import { describe, expect, it, vi } from 'vitest';

vi.mock('../net/user-agent', () => ({ providerUserAgent: () => 'test' }));

/*
 * Production pass — the names a typed word may match. The recorded shape of the
 * Paris row Nominatim returned for "Bali" on 2026-10-25: among its hundred
 * `name:xx` tags is a romanisation of its Chinese name that reads "Bali".
 */
const PARIS = {
  place_id: 1,
  osm_type: 'relation',
  osm_id: 71525,
  lat: '48.85',
  lon: '2.35',
  display_name: 'Paris, Île-de-France, France',
  name: 'Paris',
  category: 'boundary',
  type: 'administrative',
  addresstype: 'city',
  importance: 0.88,
  place_rank: 12,
  boundingbox: ['48.81', '48.90', '2.22', '2.47'],
  address: { city: 'Paris', country: 'France', country_code: 'fr' },
  namedetails: { name: 'Paris', 'name:en': 'Paris', 'name:zh-Latn-pinyin': 'Bali', 'name:ru': 'Париж', int_name: 'Paris', alt_name: 'Lutetia' },
};

describe('toCandidate aliases', () => {
  it('keeps the own, English and untagged names, and drops other languages', async () => {
    const { toCandidate } = await import('./open-verification');
    const candidate = toCandidate(PARIS as never, 'Bali')!;
    expect(candidate.aliases).toEqual(expect.arrayContaining(['Paris', 'Lutetia']));
    expect(candidate.aliases).not.toContain('Bali');
    expect(candidate.aliases).not.toContain('Париж');
  });
});
