import { describe, expect, it } from 'vitest';
import { resolveDisplayName } from '@sidequest/core';
import { candidatesFromNominatim } from './names';

/**
 * READING NAMES OUT OF A GEOCODER RECORD.
 *
 * The adapter half. `namedetails=1` is what makes any of this possible — without
 * it the record has one `name` field and it is the local one, which is exactly
 * how a base came to be headed in a script the traveller had not typed in.
 */

describe('candidates from an OSM record', () => {
  it('marks the untagged name primary and reads every tagged variant', () => {
    const candidates = candidatesFromNominatim({
      name: 'Бишкек шаары',
      namedetails: {
        name: 'Бишкек шаары',
        'name:en': 'Bishkek',
        'name:ru': 'Бишкек',
        'name:de': 'Bischkek',
      },
    });

    const english = candidates.find((candidate) => candidate.language === 'en');
    expect(english?.value).toBe('Bishkek');
    expect(candidates.find((candidate) => candidate.primary)?.value).toBe('Бишкек шаары');
    expect(candidates).toHaveLength(4);

    const resolved = resolveDisplayName({ candidates, fallback: 'x' });
    expect(resolved.display).toBe('Bishkek');
    expect(resolved.local).toBe('Бишкек шаары');
  });

  it('offers int_name and official_name without asserting a language for them', () => {
    const candidates = candidatesFromNominatim({
      namedetails: { name: 'Kööpenhamina', int_name: 'Copenhagen', official_name: 'Københavns Kommune' },
    });
    for (const candidate of candidates.filter((entry) => entry.value !== 'Kööpenhamina')) {
      expect(candidate.language).toBeUndefined();
    }
  });

  it('ignores a malformed name tag rather than reading it as English', () => {
    /* `name:` with nothing after the colon appears in user-edited OSM data. */
    const candidates = candidatesFromNominatim({ namedetails: { 'name:': 'Nonsense' } });
    expect(candidates.some((candidate) => candidate.value === 'Nonsense')).toBe(false);
  });

  it('falls back to the plain name when the record has no details at all', () => {
    const candidates = candidatesFromNominatim({ name: 'Somewhere' });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.primary).toBe(true);
    expect(resolveDisplayName({ candidates, fallback: 'x' }).display).toBe('Somewhere');
  });

  it('returns nothing rather than throwing on an empty record', () => {
    expect(candidatesFromNominatim({})).toEqual([]);
    expect(resolveDisplayName({ candidates: [], fallback: 'Fallback' }).display).toBe('Fallback');
  });

  it('never leads with a variant positively tagged as a third language', () => {
    /*
     * The share-page shape: a record whose only tagged name is a Vietnamese
     * translation. A tag naming another language is a positive statement that
     * this is not the interface's name for the place, so it may not lead —
     * the caller's fallback does.
     */
    const resolved = resolveDisplayName({
      candidates: candidatesFromNominatim({
        namedetails: { 'name:vi': 'Hoàng cung Aohama' },
      }),
      fallback: 'Aohama Palace',
    });
    expect(resolved.display).toBe('Aohama Palace');
  });

  it('lets the local primary lead as itself over a third-language tag', () => {
    const resolved = resolveDisplayName({
      candidates: candidatesFromNominatim({
        namedetails: { name: '青浜宮殿', 'name:vi': 'Hoàng cung Aohama' },
      }),
      fallback: 'x',
    });
    expect(resolved.display).toBe('青浜宮殿');
  });

  it('refuses an untagged alias the classifier reads as another language', () => {
    /* Untagged names may lead — unless the refusal net can read them. */
    const resolved = resolveDisplayName({
      candidates: candidatesFromNominatim({
        namedetails: { alt_name: 'Jardin de Aohama' },
      }),
      fallback: 'Aohama Garden',
    });
    expect(resolved.display).toBe('Aohama Garden');
  });

  it('splits a semicolon-joined tag and selects among the parts', () => {
    const resolved = resolveDisplayName({
      candidates: candidatesFromNominatim({
        namedetails: { name: '青浜園', 'name:en': 'Aohama Garden;Aohama Gardens' },
      }),
      fallback: 'x',
    });
    expect(resolved.display).toBe('Aohama Garden');
    expect(resolved.local).toBe('青浜園');
  });

  it('sanitises a hostile alias before it can reach a heading', () => {
    const resolved = resolveDisplayName({
      candidates: candidatesFromNominatim({
        namedetails: { name: 'Town', 'name:en': 'Saf‮e​Name' },
      }),
      fallback: 'x',
    });
    expect(resolved.display).toBe('SafeName');
  });
});
