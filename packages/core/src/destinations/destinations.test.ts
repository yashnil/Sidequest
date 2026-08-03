import { describe, expect, it } from 'vitest';
import {
  DESTINATION_INDEX_VERSION,
  MAX_NORMALIZED_INPUT,
  boundedEditDistance,
  foldForMatch,
  fuzzyPrefixes,
  highlightRange,
  inMemorySuggestionProvider,
  matchName,
  normalizeSuggestionQuery,
  qualifiedNameFor,
  rankSuggestions,
  sanitizePlaceText,
  searchTermsFor,
  type DestinationIndexEntry,
  type DestinationIndexRelease,
} from '../index';

/**
 * Fixtures chosen to be the cases that actually break a typeahead, not the ones
 * that are easy to assert: two scripts, an ʻokina, a country whose local name
 * shares nothing with its English one, two cities with the same name on
 * different continents, and a name that is a prefix of another name.
 */
function entry(over: Partial<DestinationIndexEntry> & Pick<DestinationIndexEntry, 'id' | 'displayName' | 'featureType' | 'center'>): DestinationIndexEntry {
  return {
    catalog: 'test',
    sourceId: over.id,
    aliases: [],
    hierarchy: [],
    ...over,
  };
}

const KYRGYZSTAN = entry({
  id: 'kg',
  displayName: 'Kyrgyzstan',
  localName: 'Кыргызстан',
  aliases: ['Kirgisistan', 'Киргизия'],
  featureType: 'country',
  countryCode: 'KG',
  center: { lat: 41.5, lng: 74.7 },
  population: 5_543_300,
});

const BISHKEK = entry({
  id: 'bishkek',
  displayName: 'Bishkek',
  localName: 'Бишкек',
  aliases: ['Biskek'],
  featureType: 'city',
  countryCode: 'KG',
  hierarchy: ['Kyrgyzstan', 'Bishkek City'],
  center: { lat: 42.87, lng: 74.6 },
  population: 1_321_900,
  prominence: 92,
});

const ISSYK_KUL = entry({
  id: 'issyk-kul',
  displayName: 'Issyk-Kul Region',
  localName: 'Ысык-Көл облусу',
  featureType: 'region',
  countryCode: 'KG',
  hierarchy: ['Kyrgyzstan'],
  center: { lat: 42.2, lng: 77.5 },
});

const BIRMINGHAM_UK = entry({
  id: 'birmingham-uk',
  displayName: 'Birmingham',
  featureType: 'city',
  countryCode: 'GB',
  hierarchy: ['United Kingdom', 'England'],
  center: { lat: 52.48, lng: -1.9 },
  population: 1_144_900,
  prominence: 80,
});

const BIRMINGHAM_US = entry({
  id: 'birmingham-us',
  displayName: 'Birmingham',
  featureType: 'city',
  countryCode: 'US',
  hierarchy: ['United States', 'Alabama'],
  center: { lat: 33.52, lng: -86.8 },
  population: 200_000,
  prominence: 60,
});

const NUKUALOFA = entry({
  id: 'nukualofa',
  displayName: "Nuku'alofa",
  localName: 'Nukuʻalofa',
  featureType: 'city',
  countryCode: 'TO',
  hierarchy: ['Tonga'],
  center: { lat: -21.13, lng: -175.2 },
  population: 24_500,
});

const BISHOP = entry({
  id: 'bishop',
  displayName: 'Bishop',
  featureType: 'town',
  countryCode: 'US',
  hierarchy: ['United States', 'California'],
  center: { lat: 37.36, lng: -118.4 },
  population: 3_800,
});

const ENTRIES = [KYRGYZSTAN, BISHKEK, ISSYK_KUL, BIRMINGHAM_UK, BIRMINGHAM_US, NUKUALOFA, BISHOP];

const RELEASE: DestinationIndexRelease = {
  schemaVersion: DESTINATION_INDEX_VERSION,
  catalog: 'test',
  releaseId: '2026-07-22.0',
  entryCount: ENTRIES.length,
  builtAt: '2026-08-01T00:00:00.000Z',
};

function suggest(text: string) {
  const normalized = normalizeSuggestionQuery({ text });
  if (!normalized) return null;
  return rankSuggestions(ENTRIES, normalized);
}

describe('folding typed text', () => {
  it('folds case, accents and punctuation but never transliterates', () => {
    expect(foldForMatch('Nukuʻalofa')).toBe('nukualofa');
    expect(foldForMatch("Nuku'alofa")).toBe('nukualofa');
    expect(foldForMatch('Issyk-Kul  Region')).toBe('issyk kul region');
    expect(foldForMatch('Ísland')).toBe('island');
    // A fold that guessed at romanisation would make two different names collide.
    expect(foldForMatch('Кыргызстан')).toBe('кыргызстан');
  });

  it('strips directional and invisible characters before anything reads the text', () => {
    const attack = `Bish\u202Ekek\u200B`;
    expect(sanitizePlaceText(attack)).toBe('Bishkek');
    expect(foldForMatch(attack)).toBe('bishkek');
  });

  it('caps its input before normalising, not after', () => {
    const long = 'é'.repeat(5_000);
    const folded = foldForMatch(long);
    expect(folded.length).toBeLessThanOrEqual(MAX_NORMALIZED_INPUT);
  });

  it('indexes whole names and their words, so a middle word is findable', () => {
    const terms = searchTermsFor(['Issyk-Kul Region']);
    expect(terms).toContain('issyk kul region');
    expect(terms).toContain('issyk');
    expect(terms).toContain('kul');
    expect(terms).toContain('region');
  });

  it('does not index single characters as words', () => {
    expect(searchTermsFor(['A Coruña'])).not.toContain('a');
  });
});

describe('query admission', () => {
  it('refuses a query too short to mean anything', () => {
    expect(normalizeSuggestionQuery({ text: 'b' })).toBeNull();
    expect(normalizeSuggestionQuery({ text: '   ' })).toBeNull();
    // Punctuation-only folds to nothing, which is the same as empty.
    expect(normalizeSuggestionQuery({ text: '-- --' })).toBeNull();
  });

  it('caps the query length', () => {
    const normalized = normalizeSuggestionQuery({ text: 'a'.repeat(500) });
    expect(normalized?.folded.length).toBeLessThanOrEqual(80);
  });
});

describe('ranking', () => {
  it('puts an exact prefix of a well-known place first', () => {
    const results = suggest('Bish');
    expect(results?.[0]?.id).toBe('bishkek');
    expect(results?.map((r) => r.id)).toContain('bishop');
  });

  it('finds a country typed in English when the source name is another script', () => {
    const results = suggest('Kyrgyz');
    expect(results?.[0]?.id).toBe('kg');
    expect(results?.[0]?.displayName).toBe('Kyrgyzstan');
    expect(results?.[0]?.localName).toBe('Кыргызстан');
  });

  it('finds the same country typed in its own script', () => {
    const results = suggest('Кыргыз');
    expect(results?.[0]?.id).toBe('kg');
  });

  it('finds it through an alias in a third language', () => {
    expect(suggest('Киргиз')?.[0]?.id).toBe('kg');
    expect(suggest('Kirgis')?.[0]?.id).toBe('kg');
  });

  it('matches a word in the middle of a name', () => {
    const results = suggest('Issyk');
    expect(results?.[0]?.id).toBe('issyk-kul');
  });

  it('is accent- and apostrophe-insensitive', () => {
    expect(suggest('nukualofa')?.[0]?.id).toBe('nukualofa');
    expect(suggest("Nuku'al")?.[0]?.id).toBe('nukualofa');
  });

  it('tolerates a typo without inventing a match', () => {
    const typo = suggest('Kyrgistan');
    expect(typo?.[0]?.id).toBe('kg');
    expect(typo?.[0]?.matchKind).toBe('fuzzy');

    // Two edits is the ceiling. Something unrelated stays unmatched.
    expect(suggest('Zanzibar')).toEqual([]);
  });

  it('keeps both readings of a shared name and orders them by how well known they are', () => {
    const results = suggest('Birmingham');
    const ids = results?.map((result) => result.id);
    expect(ids).toContain('birmingham-uk');
    expect(ids).toContain('birmingham-us');
    expect(ids?.[0]).toBe('birmingham-uk');
    // Context is what makes them distinguishable on screen.
    expect(qualifiedNameFor(BIRMINGHAM_US)).toBe('Birmingham, Alabama');
  });

  it('is a total order — the same query always gives the same list', () => {
    const first = suggest('Bi')?.map((result) => result.id);
    const second = suggest('Bi')?.map((result) => result.id);
    expect(first).toEqual(second);
  });

  it('scores nothing above one and nothing below zero', () => {
    for (const query of ['Bish', 'Kyrgyzstan', 'Birmingham', 'Issyk-Kul Region']) {
      for (const result of suggest(query) ?? []) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never returns an entry that is not in the index', () => {
    const ids = new Set(ENTRIES.map((e) => e.id));
    for (const query of ['Bis', 'Kyr', 'Bir']) {
      for (const result of suggest(query) ?? []) expect(ids.has(result.id)).toBe(true);
    }
  });
});

describe('match classification', () => {
  it('prefers a whole-name prefix over a word prefix over a substring', () => {
    expect(matchName('Bishkek', 'bish')?.kind).toBe('prefix');
    expect(matchName('Issyk-Kul Region', 'kul')?.kind).toBe('word_prefix');
    expect(matchName('Issyk-Kul Region', 'ul reg')?.kind).toBe('contains');
    expect(matchName('Bishkek', 'zzz')).toBeNull();
  });

  it('will not fuzz a query too short for a typo to be distinguishable', () => {
    // "bis" against "Birmingham" is one edit away, and would be noise.
    expect(matchName('Birmingham', 'bis')).toBeNull();
  });
});

describe('edit distance', () => {
  it('counts a transposition as one edit', () => {
    expect(boundedEditDistance('bishkek', 'bihskek', 2)).toBe(1);
  });

  it('bails out rather than computing a distance nobody asked for', () => {
    expect(boundedEditDistance('a'.repeat(50), 'b'.repeat(50), 2)).toBe(3);
  });

  it('is symmetric on the cases it answers', () => {
    expect(boundedEditDistance('kyrgistan', 'kyrgyzstan', 2)).toBe(
      boundedEditDistance('kyrgyzstan', 'kyrgistan', 2),
    );
  });
});

describe('typo-tolerant prefixes', () => {
  it('produces a small, bounded set', () => {
    const prefixes = fuzzyPrefixes('bish');
    expect(prefixes.length).toBeLessThanOrEqual(7);
    expect(prefixes).not.toContain('bis');
    expect(prefixes).toContain('bs');
    expect(prefixes).toContain('ibs');
  });

  it('gives up rather than guessing on a one-character head', () => {
    expect(fuzzyPrefixes('b')).toEqual([]);
  });
});

describe('highlighting', () => {
  it('reports offsets into the original text, not the folded form', () => {
    expect(highlightRange('Nukuʻalofa', 'nuku')).toEqual([[0, 4]]);
    expect(highlightRange('Issyk-Kul Region', 'Issyk')).toEqual([[0, 5]]);
  });

  it('returns nothing rather than a wrong range when it cannot align', () => {
    expect(highlightRange('Bishkek', 'kek')).toEqual([]);
    expect(highlightRange('Bishkek', '')).toEqual([]);
  });
});

describe('the provider contract', () => {
  const provider = inMemorySuggestionProvider({ entries: ENTRIES, release: RELEASE });

  it('separates "too short" from "nothing found"', async () => {
    expect((await provider.suggest({ text: 'b' })).kind).toBe('too_short');
    expect((await provider.suggest({ text: 'Zanzibar' })).kind).toBe('no_match');
  });

  it('resolves a persisted selection back to its entry', async () => {
    expect((await provider.byId('bishkek'))?.displayName).toBe('Bishkek');
    expect(await provider.byId('nonexistent')).toBeNull();
  });

  it('caps how many rows a dropdown may show', async () => {
    const result = await provider.suggest({ text: 'bi', limit: 100 });
    if (result.kind !== 'suggestions') throw new Error('expected suggestions');
    expect(result.suggestions.length).toBeLessThanOrEqual(8);
  });
});

describe('fame never compensates for a bad match', () => {
  /**
   * The live regression this pair of assertions exists for: "Denali" offered
   * Delhi first, matched through its four-letter Italian alias two edits away,
   * carried over an exact-prefix hit on Denali Borough by sixteen million
   * inhabitants.
   */
  const DELHI = entry({
    id: 'delhi',
    displayName: 'Delhi',
    aliases: ['Deli', 'Дели'],
    featureType: 'city',
    countryCode: 'IN',
    hierarchy: ['India', 'Delhi'],
    center: { lat: 28.6, lng: 77.2 },
    population: 16_787_941,
    prominence: 80,
  });
  const DENALI = entry({
    id: 'denali-borough',
    displayName: 'Denali Borough',
    featureType: 'county',
    countryCode: 'US',
    hierarchy: ['United States', 'Alaska'],
    center: { lat: 63.7, lng: -150 },
  });

  it('ranks an exact prefix on an obscure place above a fuzzy hit on a famous one', () => {
    const normalized = normalizeSuggestionQuery({ text: 'Denali' });
    if (!normalized) throw new Error('expected a query');
    const ranked = rankSuggestions([DELHI, DENALI], normalized);
    expect(ranked[0]?.id).toBe('denali-borough');
    expect(ranked[0]?.matchKind).toBe('prefix');
  });

  it('never credits a name shorter than the query with full coverage', () => {
    /*
     * The bug was not that "Deli" scored *some* coverage — it is four of the six
     * characters typed, and that is a real signal. It was that the ratio came
     * out above one and got clamped, handing it the maximum. Coverage has to
     * stay a ratio, so that being short costs something.
     */
    const short = matchName('Deli', 'denali');
    expect(short?.coverage ?? 1).toBeLessThan(1);
    expect(short?.coverage ?? 1).toBeLessThan(matchName('Deli', 'deli')?.coverage ?? 0);
  });
});
