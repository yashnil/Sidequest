import { describe, expect, it } from 'vitest';
import { countryBelongs } from './placement';

/*
 * Audit pass — the live Tour du Mont Blanc proposed the whole circuit, and
 * placement refused every stage in Switzerland and Italy as `country_mismatch`
 * because the trip was gated to one country. A destination whose concept spans
 * several countries accepts all of them; a single-country trip is unchanged.
 */
describe('a destination across several countries places its far side', () => {
  it('a trail across three borders accepts each of its countries', () => {
    const options = { countryCode: 'FR', countryCodes: ['FR', 'IT', 'CH'] };
    expect(countryBelongs('IT', options)).toBe(true);
    expect(countryBelongs('ch', options)).toBe(true);
    expect(countryBelongs('FR', options)).toBe(true);
    expect(countryBelongs('AT', options)).toBe(false);
  });

  it('a single-country trip still refuses a row from elsewhere; a row with no country is never wrong', () => {
    expect(countryBelongs('IT', { countryCode: 'FR' })).toBe(false);
    expect(countryBelongs(undefined, { countryCode: 'FR' })).toBe(true);
    expect(countryBelongs('IT', {})).toBe(true);
  });
});
