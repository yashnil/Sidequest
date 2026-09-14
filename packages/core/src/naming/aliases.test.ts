import { describe, expect, it } from 'vitest';
import { aliasesFor, matchesAlias, mergeAliases, nameSkeleton, queryVariantsFor, sameIdentity } from './aliases';

/**
 * V11 §K — the four spellings of one lake.
 *
 * Every assertion below is about a *writing system*, never about a place: the
 * same rules that join `Song-Köl` to `Son-Kul` join any two romanisations of the
 * same sounds, which is the only way this can work for somewhere nobody
 * anticipated.
 */
describe('one identity, many spellings', () => {
  const SPELLINGS = ['Song-Köl', 'Song-Kul', 'Son-Kul', 'Song Kol', 'Songköl'];

  it('reads every spelling of the lake as the same identity', () => {
    for (const left of SPELLINGS) {
      for (const right of SPELLINGS) {
        expect(sameIdentity(left, right), `${left} vs ${right}`).toBe(true);
      }
    }
  });

  it('joins the accented and unaccented forms of anything', () => {
    expect(sameIdentity('Þingvellir', 'Thingvellir')).toBe(true);
    expect(sameIdentity('Jökulsárlón', 'Jokulsarlon')).toBe(true);
    expect(sameIdentity('Kraków', 'Krakow')).toBe(true);
  });

  it('joins the transliteration families that differ by a digraph', () => {
    expect(sameIdentity('Shymkent', 'Šymkent')).toBe(true);
    expect(sameIdentity('Zhabagly', 'Jabagly')).toBe(true);
    expect(sameIdentity('Khiva', 'Kiva')).toBe(true);
    expect(sameIdentity('Qyzylorda', 'Kyzylorda')).toBe(true);
  });

  it('does not join two names that are simply different', () => {
    expect(sameIdentity('Bishkek', 'Karakol')).toBe(false);
    expect(sameIdentity('Jasper', 'Banff')).toBe(false);
    expect(sameIdentity('Reykjavík', 'Akureyri')).toBe(false);
    expect(sameIdentity('Osh', 'Oslo')).toBe(false);
  });

  it('will not let a one-edit neighbourhood loose on a short name', () => {
    /*
     * `Ely` and `Eli` would be one edit apart on a skeleton, and on a name that
     * short one edit is a different word. The floor is why `sameIdentity` is
     * usable at all: without it every three-letter name matches its neighbours.
     */
    expect(sameIdentity('Ulm', 'Elm')).toBe(false);
    expect(sameIdentity('Bam', 'Ban')).toBe(false);
  });

  it('is symmetric and reflexive, which a matcher has to be', () => {
    const names = [...SPELLINGS, 'Bishkek', 'Karakol', 'Þingvellir'];
    for (const left of names) {
      expect(sameIdentity(left, left)).toBe(true);
      for (const right of names) expect(sameIdentity(left, right)).toBe(sameIdentity(right, left));
    }
  });

  it('collapses a doubled letter, which is a transliteration choice and not a sound', () => {
    expect(nameSkeleton('Tallinn')).toBe(nameSkeleton('Talin'));
  });
});

describe('the alias record', () => {
  it('keeps what the traveller called it, and answers to the rest', () => {
    const record = aliasesFor({ canonical: 'Song-Köl', preferred: 'Son-Kul', extra: ['Сон-Көл'] });
    expect(record.preferred).toBe('Son-Kul');
    expect(record.canonical).toBe('Song-Köl');
    expect(matchesAlias(record, 'Song-Kul')).toBe(true);
    expect(matchesAlias(record, 'song kol')).toBe(true);
    expect(matchesAlias(record, 'Сон-Көл')).toBe(true);
    expect(matchesAlias(record, 'Karakol')).toBe(false);
  });

  it('never lets a provider rename a traveller’s stop', () => {
    const mine = aliasesFor({ canonical: 'Song-Köl', preferred: 'Son-Kul' });
    const theirs = aliasesFor({ canonical: 'Song-Kul Lake', preferred: 'Song-Kul Lake' });
    const merged = mergeAliases(mine, theirs);
    expect(merged.preferred).toBe('Son-Kul');
    expect(merged.canonical).toBe('Song-Köl');
    expect(matchesAlias(merged, 'Song-Kul Lake')).toBe(true);
  });

  it('never stores an empty alias, because an empty alias matches everything', () => {
    const record = aliasesFor({ canonical: 'Song-Köl', extra: ['', '   ', '—'] });
    expect(record.aliases.every((alias) => alias.length > 0)).toBe(true);
    expect(matchesAlias(record, '')).toBe(false);
  });

  it('asks a provider once per sound, not once per spelling', () => {
    const record = aliasesFor({ canonical: 'Song-Köl', preferred: 'Son-Kul', extra: ['Song Kul', 'Songkol'] });
    const variants = queryVariantsFor(record);
    expect(variants[0]).toBe('Son-Kul');
    /* Every one of those spellings reduces to one skeleton, so one query is enough. */
    expect(variants).toHaveLength(1);
  });

  it('asks again where the name is genuinely a different name', () => {
    /*
     * A former name is not a spelling variant — nothing about the letters joins
     * them — so it costs its own query, which is exactly right: a provider may
     * well have the place filed under only one of the two.
     */
    const record = aliasesFor({ canonical: 'Karakol', preferred: 'Karakol', extra: ['Przhevalsk'] });
    expect(queryVariantsFor(record)).toEqual(['Karakol', 'Przhevalsk']);
  });

  it('reads Issyk-Kul and Ysyk-Köl as one question, because they are one lake', () => {
    const record = aliasesFor({ canonical: 'Issyk-Kul', preferred: 'Ysyk-Köl', extra: ['Lake Issyk Kul'] });
    /* Two, not three: the two spellings of the lake's own name are one question, and "Lake Issyk Kul" is another. */
    expect(queryVariantsFor(record)).toEqual(['Ysyk-Köl', 'Lake Issyk Kul']);
  });
});
