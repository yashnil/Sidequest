import { describe, expect, it } from 'vitest';
import { repairJsonObject } from './json-repair';

/**
 * The salvage scanner, tested on both halves of its contract: what it must
 * mend, and — far more important — what it must refuse to touch.
 */

function repaired(source: string): { value: unknown; repairs: string[] } | null {
  const out = repairJsonObject(source, source.indexOf('{'));
  if (!out) return null;
  return { value: JSON.parse(out.text) as unknown, repairs: out.repairs };
}

describe('repairJsonObject mends a closed set of structural slips', () => {
  it('a key that swallowed its delimiter (the Hong Kong failure)', () => {
    const out = repaired('{"days":[{"day":1,"stay":"A"},{"day2,"stay":"B","theme":"t"}]}');
    expect(out?.repairs).toEqual(['key_delimiter']);
    expect(out?.value).toEqual({ days: [{ day: 1, stay: 'A' }, { day: 2, stay: 'B', theme: 't' }] });
  });

  it('the same slip when the next member opens with a quote of its own', () => {
    const out = repaired('{"a":1,"day3,""b":2}');
    expect(out?.repairs).toEqual(['key_delimiter']);
    expect(out?.value).toEqual({ a: 1, day: 3, b: 2 });
  });

  it('a trailing comma before a closer', () => {
    expect(repaired('{"a":1,"b":[1,2,],}')).toEqual({ value: { a: 1, b: [1, 2] }, repairs: ['trailing_comma'] });
  });

  it('a missing comma between members', () => {
    expect(repaired('{"a":1"b":2}')).toEqual({ value: { a: 1, b: 2 }, repairs: ['missing_comma'] });
  });

  it('a missing colon after a key', () => {
    expect(repaired('{"a" 1}')).toEqual({ value: { a: 1 }, repairs: ['missing_colon'] });
  });

  it('a truncated answer keeps every complete member and discards the tail', () => {
    const out = repaired('{"days":[{"day":1,"stay":"Kyoto"},{"day":2,"stay":"Nara"},{"day":3,"stay":"Osa');
    expect(out?.repairs).toContain('truncated_tail');
    expect(out?.value).toEqual({ days: [{ day: 1, stay: 'Kyoto' }, { day: 2, stay: 'Nara' }] });
  });

  it('keeps the complete members of an object the answer stopped inside', () => {
    const out = repaired('{"purpose":"A week of food","archetype":"single_base_urban","routeRat');
    expect(out?.repairs).toContain('truncated_tail');
    expect(out?.value).toEqual({ purpose: 'A week of food', archetype: 'single_base_urban' });
  });

  it('never keeps a value the answer stopped inside — half a place name is a different place', () => {
    const out = repaired('{"stay":"Osa');
    expect(out?.value).toEqual({});
    expect(out?.repairs).toContain('unterminated_string');
  });
});

describe('repairJsonObject refuses rather than guesses', () => {
  it('leaves a valid object byte-identical', () => {
    const source = '{"a": 1, "b": [true, null, -2.5e3], "c": {"d": "x"}}';
    const out = repairJsonObject(source, 0);
    expect(out?.repairs).toEqual([]);
    expect(out?.text).toBe(source);
  });

  it('does not touch a comma or a digit inside prose', () => {
    const source = '{"note":"Open until 22, then closed", "why":"Two stops, day 3"}';
    const out = repairJsonObject(source, 0);
    expect(out?.repairs).toEqual([]);
    expect(JSON.parse(out!.text)).toEqual({ note: 'Open until 22, then closed', why: 'Two stops, day 3' });
  });

  it('does not treat an escaped quote as a terminator', () => {
    const source = '{"note":"He said \\"go\\", then left","n":1}';
    const out = repairJsonObject(source, 0);
    expect(out?.repairs).toEqual([]);
    expect(JSON.parse(out!.text)).toEqual({ note: 'He said "go", then left', n: 1 });
  });

  it('refuses single-quoted JSON rather than rewriting it', () => {
    expect(repairJsonObject("{ 'a': 1 }", 0)).toBeNull();
  });

  it('refuses a mismatched closer', () => {
    expect(repairJsonObject('{"a":[1,2}', 0)).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    expect(repairJsonObject('[1,2,3]', 0)).toBeNull();
    expect(repairJsonObject('nothing', 0)).toBeNull();
  });

  it('stops at the end of the object and ignores what follows', () => {
    const out = repairJsonObject('{"a":1} and then some prose', 0);
    expect(out?.text).toBe('{"a":1}');
    expect(out?.repairs).toEqual([]);
  });
});
