/**
 * TURNING TYPED TEXT INTO SOMETHING SAFE TO MATCH ON.
 *
 * This runs on every keystroke, on a string somebody else controls, on both
 * sides of the index — so it has three jobs and they are all load-bearing:
 *
 * 1. **Fold away the differences a traveller should not have to reproduce.**
 *    Accents, case, apostrophes, hyphens and script-specific punctuation. Nobody
 *    should have to type `Nukuʻalofa` with the correct ʻokina.
 * 2. **Refuse the characters that are attacks rather than input.** Bidirectional
 *    overrides can make a stored name render as something else entirely; zero
 *    width joiners defeat prefix matching invisibly; control characters have no
 *    business in a place name. These are stripped before anything else looks at
 *    the string, on the way *in* to the index as well as on the way in from a
 *    keyboard.
 * 3. **Bound the work.** Every function here is O(n) in a capped n.
 *
 * What it deliberately does *not* do is transliterate. `Кыргызстан` folds to
 * itself, not to `Kyrgyzstan` — a fold that guessed at romanisation would make
 * two genuinely different names collide, and the aliases held on the entry are
 * the honest way to make both spellings findable.
 */

/**
 * Characters that change how text renders without being text.
 *
 * The bidi set is the one that matters: `U+202E RIGHT-TO-LEFT OVERRIDE` inside a
 * place name makes the rest of the row render backwards, and a name crafted with
 * it can be made to display as an entirely different destination than the one
 * the identity points at.
 */
const INVISIBLE_OR_DIRECTIONAL = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F-\\u009F' + // C0 and C1 controls
    '\\u00AD' + // soft hyphen
    '\\u200B-\\u200F' + // zero-width, LRM, RLM
    '\\u202A-\\u202E' + // embeddings and overrides
    '\\u2060-\\u2064\\u2066-\\u2069' + // word joiner and isolates
    '\\uFEFF' + // byte-order mark
    ']',
  'gu',
);

/** Apostrophe-shaped things, all folded away so `Nuku'alofa` matches `Nukualofa`. */
const APOSTROPHES = new RegExp(
  "['\\u2018\\u2019\\u201B\\u0060\\u00B4\\u02BB\\u02BC\\u02BD\\u02C8]",
  'gu',
);

/** Anything that separates words, folded to a single space. */
const SEPARATORS = new RegExp(
  '[\\s\\-\\u2013\\u2014_/\\\\.,;:()\\[\\]{}\\u00AB\\u00BB"\\u201C\\u201D\\u00B7\\u2022]+',
  'gu',
);

/**
 * The upper bound on any string this module will process.
 *
 * Applied before normalisation rather than after: `String.normalize('NFD')` can
 * expand its input, so capping the output would still have decomposed a
 * megabyte first.
 */
export const MAX_NORMALIZED_INPUT = 200;

/**
 * Strip what should never have been in a name, and cap the length.
 *
 * Runs first, and separately from folding, because it is a *safety* step rather
 * than a matching step: the result is still displayable text.
 */
export function sanitizePlaceText(input: string): string {
  return input.slice(0, MAX_NORMALIZED_INPUT).replace(INVISIBLE_OR_DIRECTIONAL, '').trim();
}

/**
 * The comparable form of a name. Lower-cased, unaccented, punctuation removed,
 * single-spaced.
 *
 * NFD-then-strip-marks rather than a character table: it handles every script
 * with combining marks rather than the handful somebody remembered.
 */
export function foldForMatch(input: string): string {
  return sanitizePlaceText(input)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(APOSTROPHES, '')
    .replace(SEPARATORS, ' ')
    .toLowerCase()
    .trim();
}

/** The folded words of a name, in order, without empties. */
export function foldedTokens(input: string): string[] {
  const folded = foldForMatch(input);
  return folded.length === 0 ? [] : folded.split(' ').filter((token) => token.length > 0);
}

/**
 * Every string an entry should be findable by, folded and deduplicated.
 *
 * Includes whole names *and* their individual words, because "Issyk" should find
 * "Issyk-Kul Region" and a whole-string index cannot do that. Words of one
 * character are dropped: they match everything and rank nothing.
 */
export function searchTermsFor(names: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const name of names) {
    const folded = foldForMatch(name);
    if (folded.length === 0) continue;
    terms.add(folded);
    const tokens = folded.split(' ');
    if (tokens.length > 1) {
      for (const token of tokens) {
        if (token.length >= 2) terms.add(token);
      }
    }
  }
  return [...terms];
}

/**
 * Prefix variants worth querying when an exact prefix found too little.
 *
 * Deliberately tiny: one deletion, one substitution-as-truncation and one
 * transposition of the *first three characters only*. That covers the typo
 * classes that break a prefix query — a doubled letter, a swapped pair, a
 * missing one — without turning a keystroke into a table scan. Anything subtler
 * is caught by edit distance over the rows these prefixes return.
 */
export function fuzzyPrefixes(folded: string): string[] {
  const head = folded.slice(0, 3);
  if (head.length < 2) return [];
  const variants = new Set<string>();

  // A doubled or extra character: drop each of the first three.
  for (let index = 0; index < head.length; index += 1) {
    variants.add(head.slice(0, index) + head.slice(index + 1));
  }
  // A transposition of an adjacent pair.
  for (let index = 0; index + 1 < head.length; index += 1) {
    variants.add(
      head.slice(0, index) + head[index + 1] + head[index] + head.slice(index + 2),
    );
  }
  // A wrong character anywhere in the head: match on the shorter certain part.
  variants.add(head.slice(0, 1));

  variants.delete(head);
  return [...variants].filter((variant) => variant.length >= 1);
}

/**
 * Damerau–Levenshtein distance, capped.
 *
 * Capped rather than complete: the caller only ever asks "is this within two
 * edits", so computing a distance of nineteen is work whose answer is thrown
 * away. Bails out as soon as every cell in a row exceeds the cap.
 */
export function boundedEditDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousPrevious: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (previousPrevious[j - 2] ?? 0) + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > cap) return cap + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? cap + 1;
}

/**
 * Where the query matched inside the original (unfolded) text.
 *
 * Computed against the original rather than the folded form because that is what
 * gets rendered — highlighting offsets from a folded string onto an accented one
 * shifts by one character per stripped mark and lands in the wrong place.
 *
 * Returns an empty array rather than guessing when the two cannot be aligned,
 * which is the honest outcome for a fuzzy match.
 */
export function highlightRange(original: string, query: string): [number, number][] {
  const sanitized = sanitizePlaceText(original);
  const foldedQuery = foldForMatch(query);
  if (foldedQuery.length === 0) return [];

  // Walk the original, folding one character at a time, and record the index at
  // which the folded prefix first reaches the query's length.
  let folded = '';
  let start = -1;
  for (let index = 0; index < sanitized.length; index += 1) {
    const piece = foldForMatch(sanitized[index] ?? '');
    if (piece.length === 0 && folded.length === 0) continue;
    if (folded.length === 0 && piece.length > 0) start = index;
    folded += piece.length > 0 ? piece : ' ';
    const trimmed = folded.trimStart();
    if (trimmed.startsWith(foldedQuery)) return [[Math.max(0, start), index + 1]];
    if (trimmed.length > foldedQuery.length) break;
  }
  return [];
}
