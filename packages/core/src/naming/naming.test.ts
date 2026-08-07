import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  candidatesFromIndexEntry,
  displayNameOf,
  isEnglish,
  localNameOf,
  resolveDisplayName,
  sameName,
  type NameCandidate,
} from '../index';

/**
 * WHAT A PLACE IS CALLED, RESOLVED ONCE.
 *
 * The live regression: a compiled trip rendered its base as `Бишкек шаары` on
 * every screen, for a traveller who typed "Kyrgyzstan" in English and picked an
 * English row out of the destination index. The index resolved English-first;
 * the regional-expansion layer took whatever `name` a geocoder returned, and a
 * geocoder's `name` is the local name by design.
 *
 * The fixtures below are shapes, not places. Cyrillic and Japanese appear
 * because a resolver that only ever saw Latin script would pass every test and
 * fail the first real destination — not because either is special-cased.
 */

function candidate(
  value: string,
  over: Partial<NameCandidate> = {},
): NameCandidate {
  return { value, source: 'test', ...over };
}

describe('English leads when a credible English name exists', () => {
  it('prefers the English name and keeps the local one beside it', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('Бишкек шаары', { primary: true, language: 'ky' }),
        candidate('Bishkek', { language: 'en' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Bishkek');
    expect(resolved.displayLanguage).toBe('en');
    expect(resolved.local).toBe('Бишкек шаары');
    expect(resolved.localLanguage).toBe('ky');
  });

  it('preserves the source’s own canonical name for provenance', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('大阪市', { primary: true, language: 'ja' }),
        candidate('Osaka', { language: 'en' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Osaka');
    // A fact traced back to the record still matches the record.
    expect(resolved.canonical).toBe('大阪市');
  });

  it('accepts any variety of English', () => {
    for (const tag of ['en', 'en-GB', 'en-US', 'EN', 'en_AU']) {
      expect(isEnglish(tag), tag).toBe(true);
    }
    for (const tag of ['eng', 'enm', 'fr', 'ky', undefined]) {
      expect(isEnglish(tag), String(tag)).toBe(false);
    }
  });
});

describe('only a local-script name available', () => {
  it('shows it rather than nothing, and does not pretend it is English', () => {
    const resolved = resolveDisplayName({
      candidates: [candidate('Каракол', { primary: true, language: 'ky' })],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Каракол');
    expect(resolved.displayLanguage).toBe('ky');
    /*
     * No `local`: it is already what leads, and printing the same name twice
     * reads as a bug rather than as thoroughness.
     */
    expect(resolved.local).toBeUndefined();
  });

  it('never returns an empty heading, whatever it is given', () => {
    for (const candidates of [
      [],
      [candidate('   ')],
      [candidate('​​')],
    ]) {
      const resolved = resolveDisplayName({ candidates, fallback: 'Fallback Town' });
      expect(resolved.display.length).toBeGreaterThan(0);
    }
    // Even the fallback being unusable has an answer.
    expect(resolveDisplayName({ candidates: [], fallback: '  ' }).display.length).toBeGreaterThan(0);
  });
});

describe('multilingual aliases', () => {
  it('uses a source alias without ever translating one', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('日本', { primary: true, language: 'ja' }),
        candidate('Japan', { language: 'en', source: 'wikidata' }),
        candidate('Japon', { language: 'fr', source: 'wikidata' }),
        candidate('日本国', { language: 'ja', source: 'overture' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Japan');
    expect(resolved.local).toBe('日本');
    // Provenance survives resolution.
    expect(resolved.sources).toContain('wikidata');
    expect(resolved.sources).toContain('overture');
  });

  it('ignores a non-English alias when choosing what leads', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('Kirgisistan', { language: 'de' }),
        candidate('Киргизия', { language: 'ru' }),
        candidate('Kyrgyzstan', { language: 'en' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Kyrgyzstan');
  });
});

describe('conflicting English aliases', () => {
  it('prefers the one a source marked primary', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('City of Osh', { language: 'en', source: 'a' }),
        candidate('Osh', { language: 'en', source: 'b', primary: true }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Osh');
  });

  it('otherwise prefers the name the most sources agree on', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('City of Osh', { language: 'en', source: 'a' }),
        candidate('Osh', { language: 'en', source: 'b' }),
        candidate('Osh', { language: 'en', source: 'c' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Osh');
  });

  it('falls back to the shorter form, then to a total order', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('Greater Someplace', { language: 'en', source: 'a' }),
        candidate('Someplace', { language: 'en', source: 'b' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe('Someplace');

    // Same length, different names: deterministic rather than input-ordered.
    const forwards = resolveDisplayName({
      candidates: [candidate('Alpha', { language: 'en' }), candidate('Bravo', { language: 'en' })],
      fallback: 'x',
    });
    const backwards = resolveDisplayName({
      candidates: [candidate('Bravo', { language: 'en' }), candidate('Alpha', { language: 'en' })],
      fallback: 'x',
    });
    expect(forwards.display).toBe(backwards.display);
  });
});

describe('an official English name that matches the local name', () => {
  it('shows it once, not twice', () => {
    /*
     * Most of the anglophone world, and plenty outside it. Rendering
     * "Reykjavik (Reykjavik)" reads as a bug, so the local name is dropped when
     * it is the same name.
     */
    const resolved = resolveDisplayName({
      candidates: [
        candidate('Nukuʻalofa', { primary: true, language: 'to' }),
        candidate("Nuku'alofa", { language: 'en' }),
      ],
      fallback: 'somewhere',
    });
    expect(resolved.display).toBe("Nuku'alofa");
    // Folded comparison, so an okina is not a second name.
    expect(resolved.local).toBeUndefined();
    expect(sameName('Nukuʻalofa', "Nuku'alofa")).toBe(true);
  });

  it('drops a local name that only differs by accent or punctuation', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('Málaga', { primary: true, language: 'es' }),
        candidate('Malaga', { language: 'en' }),
      ],
      fallback: 'x',
    });
    expect(resolved.local).toBeUndefined();
  });
});

describe('old artifacts keep rendering as they did', () => {
  it('reads a bare name when there is no resolved structure', () => {
    const legacy = { name: 'Бишкек шаары' };
    expect(displayNameOf(legacy)).toBe(legacy.name);
    expect(localNameOf(legacy)).toBeUndefined();
  });

  it('prefers the resolved structure when a new artifact carries one', () => {
    const modern = {
      name: 'Бишкек шаары',
      names: resolveDisplayName({
        candidates: [
          candidate('Бишкек шаары', { primary: true, language: 'ky' }),
          candidate('Bishkek', { language: 'en' }),
        ],
        fallback: 'x',
      }),
    };
    expect(displayNameOf(modern)).toBe('Bishkek');
    expect(localNameOf(modern)).toBe('Бишкек шаары');
  });

  it('never shows the local name twice through the render helpers', () => {
    const same = {
      name: 'Reykjavik',
      names: {
        schemaVersion: 1 as const,
        display: 'Reykjavik',
        local: 'Reykjavík',
        canonical: 'Reykjavík',
        sources: ['test'],
      },
    };
    expect(displayNameOf(same)).toBe('Reykjavik');
    expect(localNameOf(same)).toBeUndefined();
  });
});

describe('an alias is untrusted input', () => {
  it('strips bidirectional overrides and zero-width characters', () => {
    /*
     * A right-to-left override inside a name makes the rest of a heading render
     * backwards, and a crafted alias can be made to display as a different place
     * entirely. Sanitised before anything reads it, on the way in.
     */
    const attack = 'Bish‮kek​';
    const resolved = resolveDisplayName({
      candidates: [candidate(attack, { language: 'en' })],
      fallback: 'x',
    });
    expect(resolved.display).toBe('Bishkek');
    expect(resolved.display).not.toContain('‮');
    expect(resolved.display).not.toContain('​');
  });

  it('strips control characters from every field it emits', () => {
    const resolved = resolveDisplayName({
      candidates: [
        candidate('Local\u0000Name', { primary: true, language: 'ky' }),
        candidate('English\u0007Name', { language: 'en' }),
      ],
      fallback: 'x',
    });
    for (const value of [resolved.display, resolved.local ?? '', resolved.canonical]) {
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1f]/.test(value), value).toBe(false);
    }
  });

  it('caps an absurdly long alias rather than rendering it', () => {
    const resolved = resolveDisplayName({
      candidates: [candidate('a'.repeat(5_000), { language: 'en' })],
      fallback: 'x',
    });
    expect(resolved.display.length).toBeLessThanOrEqual(200);
  });
});

describe('building candidates from the destination index', () => {
  it('inherits the index’s English-first resolution', () => {
    const resolved = resolveDisplayName({
      candidates: candidatesFromIndexEntry({
        displayName: 'Kyrgyzstan',
        localName: 'Кыргызстан',
        aliases: ['Kirgisistan'],
        catalog: 'overture',
      }),
      fallback: 'x',
    });
    expect(resolved.display).toBe('Kyrgyzstan');
    expect(resolved.local).toBe('Кыргызстан');
    expect(resolved.sources).toContain('overture');
  });

  it('does not assert English for an entry with no distinct local name', () => {
    /*
     * The index's `displayName` is the local name when the catalogue published
     * no English one. Tagging that `en` would be claiming a language nobody
     * told us — and would make a later English alias lose to it.
     */
    const candidates = candidatesFromIndexEntry({ displayName: 'Singapore', catalog: 'overture' });
    expect(candidates[0]?.language).toBeUndefined();
  });
});

describe('no model ever produces a place name', () => {
  /*
   * The rule that keeps every name in this product real. A translated place name
   * is a place that does not exist, and the failure is silent — a plausible
   * English rendering of a town nobody calls that, on a heading, in a PDF, in a
   * search somebody makes when they are lost.
   *
   * A lint rather than a proof, and honest about that: what it catches is
   * somebody reaching for a model because it was the convenient way to get an
   * English name.
   */
  const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
  const FILES = [
    'packages/core/src/naming/display-name.ts',
    'apps/web/src/lib/providers/names.ts',
  ];

  it.each(FILES)('%s reaches no model and no translation service', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of [
      /anthropic/i,
      /openai/i,
      /\btranslate\b/i,
      /translation/i,
      /\bfetch\s*\(/,
      /https?:\/\//,
    ]) {
      expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
    }
  });

  it('the resolver names no language, country or script specifically', () => {
    const source = readFileSync(
      join(ROOT, 'packages/core/src/naming/display-name.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const word of ['kyrgyz', 'bishkek', 'cyrillic', 'russian', 'japan', 'iceland']) {
      expect(source.toLowerCase().includes(word), `names ${word}`).toBe(false);
    }
    /*
     * `en` is the one language tag the resolver knows, and it knows it because
     * the product is written in English — not because English is special. It
     * appears exactly once, in `isEnglish`.
     */
    expect((source.match(/'en'/g) ?? []).length).toBeLessThanOrEqual(2);
  });
});
