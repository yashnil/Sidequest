import { boundedEditDistance, foldForMatch } from '../destinations/normalize';

/**
 * V11 §K — ONE IDENTITY, MANY SPELLINGS.
 *
 * A Kyrgyz lake is written **Сон-Көл** at home, **Song-Köl** on a map drawn to
 * the BGN romanisation, **Song-Kul** on one drawn from the Russian, and
 * **Son-Kul** by half the guesthouses that will actually take the booking. The
 * product met all four: a traveller typed one, the composing model wrote
 * another, the geocoder answered a third and the experience graph tried to match
 * the fourth. `foldForMatch` strips diacritics and punctuation, so it already
 * joined the first two — and it has no way to join `köl` to `kul`, because they
 * differ in a letter rather than in a mark.
 *
 * This file is that missing layer, and it is deliberately **not** a table of
 * place names. Two documented, script-level ideas:
 *
 * 1. **A skeleton.** A name reduced under the equivalences that different
 *    romanisations of one sound actually produce — `k`/`q`/`kh`, `sh`/`š`/`ş`,
 *    `zh`/`j`, `o`/`u` for the front-rounded vowels, doubled letters collapsed,
 *    separators dropped. Every rule is about *writing systems*, so a place
 *    nobody has heard of gets the same treatment as the one in the bug report.
 * 2. **A bounded neighbourhood.** Two names are the same identity when their
 *    folds match, their skeletons match, or their skeletons are one edit apart
 *    on a name long enough for one edit to mean something. That last clause is
 *    what joins `Son-Kul` to `Song-Kul`, which no equivalence class can.
 *
 * ## What this is for, and what it is not for
 *
 * **For:** asking a provider for a place under every spelling it might be filed
 * under; not asking twice for what is one place; matching an experience the plan
 * names to an anchor the geocoder placed; matching a map label to a stop.
 *
 * **Not for:** deciding that two *resolved* places are one. Callers in every one
 * of those situations have coordinates, and coordinates settle it. The
 * documented cost of the neighbourhood rule is that `Karakol` and `Karakul`
 * share a skeleton — a town in Kyrgyzstan and a lake in Tajikistan — and the
 * only reason that is acceptable is that nothing here is allowed to merge them
 * on the strength of a name alone.
 *
 * **The traveller's own label is never overwritten.** `preferred` is what a
 * person typed or what the plan called it, and it is what the product shows.
 * Aliases exist so the machinery finds things; they are not a licence to rename
 * somebody's trip.
 */

export interface NameAliases {
  /** The identity's canonical form, as the authoritative source wrote it. */
  canonical: string;
  /** What the traveller called it. This is what the product shows. */
  preferred: string;
  /** Every folded spelling this identity answers to. Sorted, so a record is stable. */
  aliases: string[];
  /**
   * The spellings as they were actually written, in the order they were given.
   *
   * Separate from `aliases` because the two are for different things: `aliases`
   * is a folded *match* set and is never shown or sent anywhere, while a
   * provider query wants the real string with its accents and its capitals —
   * asking a geocoder for `lake issyk kul` is asking it a worse question than
   * asking for `Lake Issyk Kul`.
   */
  forms: string[];
}

/**
 * The equivalence classes, longest digraph first.
 *
 * Order matters: `sh` has to be consumed before `s` and `h` are considered
 * separately, or `Shymkent` and `Symkent` skeleton differently for no reason.
 */
const DIGRAPHS: readonly [RegExp, string][] = [
  [/sch/g, 'S'],
  [/sh/g, 'S'],
  [/tch/g, 'C'],
  [/ch/g, 'C'],
  [/tsch/g, 'C'],
  [/zh/g, 'Z'],
  [/kh/g, 'K'],
  [/gh/g, 'G'],
  [/ts/g, 'Z'],
  [/ph/g, 'f'],
  [/th/g, 't'],
  [/ck/g, 'K'],
  [/qu/g, 'Kv'],
];

/**
 * Single letters that stand for one sound across romanisations.
 *
 * `o`→`u` is the one that earns this file its existence: a front-rounded vowel
 * written `ö` by one convention is written `u` by another, and the fold turns
 * `ö` into `o`, so the two conventions land one letter apart. `y`→`i` and
 * `j`→`Z` are the same phenomenon in the other two vowel and consonant
 * families.
 */
const LETTERS: Record<string, string> = {
  q: 'K',
  k: 'K',
  c: 'K',
  x: 'Ks',
  j: 'Z',
  y: 'i',
  e: 'i',
  o: 'u',
  w: 'v',
  ä: 'a',
};

/**
 * The comparable core of a name.
 *
 * Folded first (so diacritics, apostrophes and punctuation are already gone),
 * then reduced under the equivalences above, then stripped of separators and of
 * doubled letters. The result is not readable and is never shown.
 */
export function nameSkeleton(value: string): string {
  let out = foldForMatch(value);
  for (const [pattern, replacement] of DIGRAPHS) out = out.replace(pattern, replacement);
  out = out.replace(/[a-zäöü]/g, (character) => LETTERS[character] ?? character);
  out = out.replace(/[^a-zA-Z]/g, '');
  /* A doubled letter is a transliteration choice, never a different sound. */
  out = out.replace(/(.)\1+/g, '$1');
  return out;
}

/** Names long enough for a single edit to be a spelling variant rather than a different word. */
const NEIGHBOUR_FLOOR = 5;

/**
 * Are these two strings the same identity?
 *
 * Three tests, in increasing looseness, and each one is stated so that a caller
 * can reason about what it is trusting.
 */
export function sameIdentity(a: string, b: string): boolean {
  if (foldForMatch(a) === foldForMatch(b)) return true;
  const left = nameSkeleton(a);
  const right = nameSkeleton(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) < NEIGHBOUR_FLOOR) return false;
  return boundedEditDistance(left, right, 1) <= 1;
}

/**
 * Every spelling worth recording for one identity.
 *
 * The raw forms are kept as written (a provider query wants the real string, not
 * a skeleton), and the folded forms are what `matchesAlias` compares. Empty
 * strings are dropped rather than stored, because an empty alias matches
 * everything.
 */
export function aliasesFor(input: { canonical: string; preferred?: string; extra?: readonly string[] }): NameAliases {
  const preferred = (input.preferred ?? input.canonical).trim() || input.canonical;
  const given = [preferred, input.canonical, ...(input.extra ?? [])];
  const aliases = new Set<string>();
  const forms: string[] = [];
  for (const form of given) {
    const trimmed = form.trim();
    const folded = foldForMatch(trimmed);
    if (folded.length === 0) continue;
    if (!forms.some((existing) => foldForMatch(existing) === folded)) forms.push(trimmed);
    aliases.add(folded);
    /* The hyphen-free form, which is how half of these are written and the other half are not. */
    const joined = folded.replace(/\s+/g, '');
    if (joined.length > 0) aliases.add(joined);
  }
  return { canonical: input.canonical, preferred, aliases: [...aliases].sort(), forms };
}

/** Does this candidate spelling name the same thing? */
export function matchesAlias(record: NameAliases, candidate: string): boolean {
  const folded = foldForMatch(candidate);
  if (folded.length === 0) return false;
  if (record.aliases.includes(folded) || record.aliases.includes(folded.replace(/\s+/g, ''))) return true;
  return record.aliases.some((alias) => sameIdentity(alias, folded));
}

/**
 * Two records for one identity, merged.
 *
 * The **left** record's `preferred` wins, always. That is the whole rule: the
 * left-hand record is the one the caller already had — the traveller's own words
 * — and a provider answering with its own spelling must never be able to rename
 * a stop on somebody's plan.
 */
export function mergeAliases(left: NameAliases, right: NameAliases): NameAliases {
  return {
    canonical: left.canonical,
    preferred: left.preferred,
    aliases: [...new Set([...left.aliases, ...right.aliases])].sort(),
    forms: [...left.forms, ...right.forms].filter(
      (form, index, all) => all.findIndex((other) => foldForMatch(other) === foldForMatch(form)) === index,
    ),
  };
}

/**
 * The spellings worth actually sending to a provider, best first.
 *
 * Deduplicated by **identity**, not by string: five spellings of one sound cost
 * one query rather than five, and a genuinely different name — a place's former
 * name, say — still costs its own. Using `sameIdentity` here rather than
 * skeleton equality is the difference between "Song-Köl and Son-Kul are one
 * question" and "they are two", and they are one.
 *
 * The preferred form leads because it is the one a traveller would recognise in
 * a result; the canonical follows because it is the one an authority filed it
 * under. `limit` is a spend cap: a provider is asked a small bounded number of
 * times for one place, never once per alias.
 */
export function queryVariantsFor(record: NameAliases, limit = 3): string[] {
  const out: string[] = [];
  for (const candidate of record.forms) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || nameSkeleton(trimmed).length === 0) continue;
    if (out.some((chosen) => sameIdentity(chosen, trimmed))) continue;
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}
