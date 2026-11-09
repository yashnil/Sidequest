import { describe, expect, it } from 'vitest';

import {
  cosineTop,
  decodeEmbeddingTable,
  decodeInt8Matrix,
  embedQuery,
  wordpiece,
  type EmbeddingTable,
  type RawEmbeddingTable,
} from './embed';
import parity from './fixtures/embed-parity.json';

/**
 * The fixture is a real slice of the shipped table, written by
 * `packages/atlas/build/07-embeddings.py --fixture`: every token the greedy
 * matcher selects for the queries below, the vectors Python computes from those
 * rows, and a few dozen real document rows with the ranking Python gets.
 */
interface ParityFixture extends RawEmbeddingTable {
  queries: { text: string; tokens: string[]; ids: number[]; vector: number[] | null }[];
  docs: { rows: number; names: string[]; vectors: string };
  rankings: { query: number; k: number; top: { row: number; score: number }[] }[];
}

const fixture = parity as ParityFixture;
const table = decodeEmbeddingTable(fixture);
const docs = decodeInt8Matrix(fixture.docs.vectors, fixture.docs.rows, fixture.dim);

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return dot / Math.sqrt(aa * bb);
}

function tokensOf(text: string): string[] {
  return wordpiece(text, table).map((id) => fixture.tokens[id] ?? '?');
}

function query(startsWith: string): ParityFixture['queries'][number] {
  const found = fixture.queries.find((entry) => entry.text.startsWith(startsWith));
  if (!found) throw new Error(`no fixture query starts with ${startsWith}`);
  return found;
}

describe('decodeEmbeddingTable', () => {
  it('decodes the table the build wrote', () => {
    expect(table.dim).toBe(96);
    expect(table.tokens.size).toBe(fixture.tokens.length);
    expect(table.vectors).toBeInstanceOf(Int8Array);
    expect(table.vectors.length).toBe(fixture.tokens.length * 96);
    expect(table.centre.length).toBe(96);
    expect(table.scale).toBeGreaterThan(0);
    expect(table.lowercase).toBe(true);
    expect(table.stripAccents).toBe(true);
    expect(table.continuingPrefix).toBe('##');
    expect(table.maxCharsPerWord).toBe(100);
    // Signed bytes, not unsigned: a table of only non-negative values was decoded wrongly.
    expect(table.vectors.some((value) => value < 0)).toBe(true);
    expect(table.centre.some((value) => value !== 0 && Math.abs(value) < 1)).toBe(true);
  });

  it('refuses a table whose parts do not agree', () => {
    expect(() => decodeEmbeddingTable({ ...fixture, tokens: fixture.tokens.slice(1) })).toThrow(/expected/);
    expect(() => decodeEmbeddingTable({ ...fixture, centre: fixture.centre.slice(0, 8) })).toThrow(/centre/);
    expect(() => decodeInt8Matrix(fixture.docs.vectors, fixture.docs.rows + 1, fixture.dim)).toThrow(/expected/);
  });

  it('never lets the unknown marker be matched', () => {
    const withUnknown = decodeEmbeddingTable({ ...fixture, tokens: ['[UNK]', ...fixture.tokens.slice(1) ] });
    expect(withUnknown.tokens.has('[UNK]')).toBe(false);
  });
});

describe('wordpiece — parity with the Python tokeniser', () => {
  it('has enough queries to mean something', () => {
    expect(fixture.queries.length).toBeGreaterThanOrEqual(12);
    expect(fixture.queries.filter((entry) => entry.vector !== null).length).toBeGreaterThanOrEqual(12);
  });

  it.each(fixture.queries.map((entry) => [entry.text.slice(0, 60), entry] as const))('%s', (_label, entry) => {
    expect(wordpiece(entry.text, table)).toEqual(entry.ids);
    expect(tokensOf(entry.text)).toEqual(entry.tokens);
  });

  it('strips accents before it looks a word up', () => {
    expect(tokensOf('São Tomé')).toEqual(['sao', 'tome']);
    expect(tokensOf('cafés')).toEqual(tokensOf('CAFES'));
    expect(tokensOf('naïve coöperative façade')).toEqual(['naive', 'cooperative', 'facade']);
  });

  it('keeps letters that are not an accented form of another letter', () => {
    expect(query('Þingvellir').tokens).toContain('##ø');
    expect(tokensOf('Æ')).toEqual(['æ']);
  });

  it('makes every punctuation character its own piece', () => {
    expect(tokensOf('Hike/trek (multi-day!)')).toEqual(['hike', '/', 'trek', '(', 'multi', '-', 'day', '!', ')']);
    expect(tokensOf('wine-tasting…')).toEqual(['wine', '-', 'tasting', '…']);
    expect(tokensOf('can’t')).toEqual(['can', '’', 't']);
  });

  it('drops a word it cannot spell — all of it, not just the unknown character', () => {
    expect(tokensOf('volcano\u{1F30B}trek and black sand beaches')).toEqual(['and', 'black', 'sand', 'beaches']);
    expect(tokensOf('\u{1F30B}\u{1F30B} \u{1F3D4}')).toEqual([]);
  });

  it('breaks a long compound into pieces and refuses a word over the limit', () => {
    const compound = tokensOf('Donaudampfschifffahrtsgesellschaftskapitän');
    expect(compound.length).toBeGreaterThan(10);
    expect(compound[0]).toBe('dona');
    expect(compound.slice(1).every((piece) => piece.startsWith('##'))).toBe(true);
    expect(compound.map((piece) => piece.replace(/^##/, '')).join('')).toBe('donaudampfschifffahrtsgesellschaftskapitan');

    expect(tokensOf(`${'a'.repeat(100)}`).length).toBeGreaterThan(0);
    expect(tokensOf(`${'a'.repeat(101)} beaches`)).toEqual(['beaches']);
  });

  it('ignores case, runs of whitespace and invisible characters', () => {
    expect(tokensOf('  REMOTE   Monasteries\tand HIGH passes\n')).toEqual(tokensOf('remote monasteries and high passes'));
    expect(tokensOf('soft­hyphen')).toEqual(tokensOf('softhyphen'));
    expect(tokensOf('zero​width')).toEqual(tokensOf('zerowidth'));
    expect(tokensOf('non breaking　space')).toEqual(['non', 'breaking', 'space']);
  });

  it('sets ideographs apart, so the words around them survive', () => {
    expect(tokensOf('東京temples')).toEqual(['temples']);
  });

  it('lower-cases one character at a time', () => {
    expect(tokensOf('İSTANBUL')).toEqual(['istanbul']);
  });
});

describe('embedQuery — parity with the Python vectors', () => {
  it.each(fixture.queries.map((entry) => [entry.text.slice(0, 60), entry] as const))('%s', (_label, entry) => {
    const vector = embedQuery(entry.text, table);
    if (entry.vector === null) {
      expect(vector).toBeNull();
      return;
    }
    expect(vector).not.toBeNull();
    if (!vector) return;
    expect(vector.length).toBe(96);
    expect(1 - cosine(vector, entry.vector)).toBeLessThan(1e-3);
    // Far tighter than the brief asks: the two are the same arithmetic.
    for (let j = 0; j < 96; j += 1) expect(Math.abs((vector[j] ?? 0) - (entry.vector[j] ?? 0))).toBeLessThan(1e-5);
    expect(Math.abs(cosine(vector, vector) - 1)).toBeLessThan(1e-6);
    let squares = 0;
    for (const value of vector) squares += value * value;
    expect(Math.abs(squares - 1)).toBeLessThan(1e-5);
  });

  it('is null when no word is known', () => {
    expect(embedQuery('', table)).toBeNull();
    expect(embedQuery('   \n', table)).toBeNull();
    expect(embedQuery('\u{1F30B}', table)).toBeNull();
  });

  it('does not depend on what the unknown words were', () => {
    const a = embedQuery('volcano\u{1F30B}trek and black sand beaches', table);
    const b = embedQuery('and black sand beaches', table);
    expect(a && b && Array.from(a)).toEqual(b && Array.from(b));
  });

  it('is an average: order and repetition of the whole text do not move it', () => {
    const once = embedQuery('wild horses and steppe', table);
    const twice = embedQuery('steppe and horses wild steppe and horses wild', table);
    expect(once && twice && 1 - cosine(once, twice)).toBeLessThan(1e-6);
  });

  it('takes the centre off the mean, not off a normalised mean', () => {
    // The shipped map is unit(mean × scale − centre). Rebuild it by hand from the table.
    const ids = wordpiece('wild horses and steppe', table);
    const byHand = new Float64Array(96);
    for (const id of ids) for (let j = 0; j < 96; j += 1) byHand[j] = (byHand[j] ?? 0) + (table.vectors[id * 96 + j] ?? 0);
    for (let j = 0; j < 96; j += 1) byHand[j] = ((byHand[j] ?? 0) / ids.length) * table.scale - (table.centre[j] ?? 0);
    const vector = embedQuery('wild horses and steppe', table);
    expect(vector && 1 - cosine(vector, byHand)).toBeLessThan(1e-9);
  });
});

describe('cosineTop', () => {
  it.each(fixture.rankings.map((ranking) => [fixture.queries[ranking.query]?.text.slice(0, 60) ?? '', ranking] as const))(
    'ranks the real document rows as Python does: %s',
    (_label, ranking) => {
      const vector = embedQuery(fixture.queries[ranking.query]?.text ?? '', table);
      expect(vector).not.toBeNull();
      if (!vector) return;
      const top = cosineTop(vector, docs, 96, ranking.k);
      expect(top.map((hit) => hit.row)).toEqual(ranking.top.map((hit) => hit.row));
      top.forEach((hit, i) => expect(Math.abs(hit.score - (ranking.top[i]?.score ?? 0))).toBeLessThan(1e-4));
    },
  );

  it('finds the places a traveller would expect in the slice', () => {
    const tea = embedQuery('tea plantations, misty hills and train rides', table);
    expect(tea).not.toBeNull();
    if (!tea) return;
    const names = cosineTop(tea, docs, 96, 4).map((hit) => fixture.docs.names[hit.row]);
    expect(names).toContain('Darjeeling');
    expect(names).toContain('Ella');
  });

  it('returns scores in descending order, at most k of them, and all rows when k is larger', () => {
    const vector = embedQuery('wild horses and steppe', table);
    if (!vector) throw new Error('expected a vector');
    const three = cosineTop(vector, docs, 96, 3);
    expect(three).toHaveLength(3);
    const all = cosineTop(vector, docs, 96, 10_000);
    expect(all).toHaveLength(fixture.docs.rows);
    for (let i = 1; i < all.length; i += 1) expect(all[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(all[i]?.score ?? 0);
    expect(all.slice(0, 3)).toEqual(three);
    expect(new Set(all.map((hit) => hit.row)).size).toBe(fixture.docs.rows);
    for (const hit of all) expect(Math.abs(hit.score)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('honours the filter without changing the order of what is left', () => {
    const vector = embedQuery('fjords I can kayak in with few cruise ships', table);
    if (!vector) throw new Error('expected a vector');
    const all = cosineTop(vector, docs, 96, fixture.docs.rows);
    const even = cosineTop(vector, docs, 96, 5, (row) => row % 2 === 0);
    expect(even).toEqual(all.filter((hit) => hit.row % 2 === 0).slice(0, 5));
    expect(cosineTop(vector, docs, 96, 5, () => false)).toEqual([]);
  });

  it('is a true cosine: the scale of a row does not matter, an empty row is never returned, ties keep row order', () => {
    const small = new Int8Array([
      10, 0, 0, // row 0 — along the query
      0, 0, 0, // row 1 — a document with no text
      100, 0, 0, // row 2 — the same direction, ten times longer
      0, 50, 0, // row 3 — orthogonal
      -7, 0, 0, // row 4 — opposite
      3, 4, 0, // row 5 — cos 0.6
    ]);
    const top = cosineTop(new Float32Array([2, 0, 0]), small, 3, 10);
    expect(top.map((hit) => hit.row)).toEqual([0, 2, 5, 3, 4]);
    expect(top.map((hit) => Number(hit.score.toFixed(6)))).toEqual([1, 1, 0.6, 0, -1]);
    expect(cosineTop(new Float32Array([2, 0, 0]), small, 3, 1)).toEqual([{ row: 0, score: 1 }]);
    expect(cosineTop(new Float32Array([2, 0, 0]), small, 3, 2).map((hit) => hit.row)).toEqual([0, 2]);
  });

  it('answers nothing rather than something wrong for a degenerate call', () => {
    const vector = embedQuery('wild horses and steppe', table);
    if (!vector) throw new Error('expected a vector');
    expect(cosineTop(vector, docs, 96, 0)).toEqual([]);
    expect(cosineTop(new Float32Array(96), docs, 96, 5)).toEqual([]);
    expect(cosineTop(new Float32Array(64), docs, 96, 5)).toEqual([]);
    expect(cosineTop(vector, new Int8Array(0), 96, 5)).toEqual([]);
  });
});

describe('the table is self-contained', () => {
  it('embeds with nothing but the decoded table', () => {
    const copy: EmbeddingTable = { ...table, tokens: new Map(table.tokens) };
    const a = embedQuery('remote monasteries and high passes', copy);
    const b = embedQuery('remote monasteries and high passes', table);
    expect(a && b && Array.from(a)).toEqual(b && Array.from(b));
  });
});
