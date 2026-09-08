/**
 * DETERMINISTIC SALVAGE OF A NEARLY-VALID JSON OBJECT.
 *
 * MVP V3, P0-1. The real Hong Kong build lost two complete, paid, `end_turn`
 * answers — a full six-night trip in the first one — to a single character-level
 * slip in prompt-enforced JSON, at the same kind of position both times:
 *
 *     … "whyItFits":"…"},{"day2,"stay":"Hong Kong","theme":"Central & Sheung Wan …
 *                          ^^^^^^^  the key swallowed its own `": ` delimiter
 *
 * `"day2,` opens a string that runs to the next quote, so every brace after it is
 * read as string content, the balanced-object scan never returns to depth zero,
 * and the extractor reports "truncated" for a response that was not truncated.
 *
 * Grammar (structured-output) mode is the real fix and is now the primary path —
 * constrained decoding cannot emit this. This module is what stops prompt mode
 * being *fatal* when the provider refuses a grammar.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a tolerant re-serialiser: a left-to-right scanner that knows, at every
 * point, whether it is expecting a key, a colon, a value or a separator, copies
 * the source through unchanged while the source is valid, and applies a **closed
 * set of reversible structural repairs** when it is not. It runs only after a
 * strict parse has already failed.
 *
 * It is **not** a content repair. It never invents a field, never guesses a
 * value, never rewrites prose, and never changes a string a model actually
 * closed. Every repair it can make is one of five named structural slips, each
 * reported by name so the caller can record what was touched:
 *
 *   `key_delimiter`       a key that swallowed its `":` and ran into its value
 *   `missing_colon`       a key followed by its value with no colon
 *   `missing_comma`       two values or two members with no separator
 *   `trailing_comma`      a comma immediately before `}` or `]`
 *   `unterminated_string` a string the answer ended inside
 *   `truncated_tail`      the answer stopped mid-structure; the incomplete tail
 *                         is DISCARDED and the open containers are closed, so a
 *                         truncated draft arrives short and honest rather than
 *                         as a parse failure. A short draft still has to satisfy
 *                         the semantic audit, which is where "day 5 of 7 is
 *                         missing" is reported.
 *
 * Anything else — an unrecognisable token, a mismatched closer, a repair whose
 * result does not parse — is refused. A salvage that cannot be made honestly is
 * still a failure, and the caller says so.
 */

export type JsonRepair =
  | 'key_delimiter'
  | 'missing_colon'
  | 'missing_comma'
  | 'trailing_comma'
  | 'unterminated_string'
  | 'truncated_tail';

export interface JsonRepairResult {
  /** The repaired source text, which the caller parses. */
  text: string;
  /** Which repairs were applied, in first-applied order, each named once. */
  repairs: JsonRepair[];
  /** Index just past the object in the ORIGINAL source, for the caller's bookkeeping. */
  end: number;
}

/**
 * A key that lost its delimiter: `"day2,` — an identifier run, then a number,
 * then the comma that should have separated the *pair* from the next one.
 *
 * Anchored at both ends and deliberately narrow: the identifier may not contain
 * a space, so a piece of prose that happens to end in a digit and a comma
 * ("open until 22,") can never match, because prose is not read at a key
 * position and because a real key in this schema is a single identifier.
 */
const SWALLOWED_DELIMITER = /^([A-Za-z_][A-Za-z0-9_]*?)(-?\d+(?:\.\d+)?)\s*,$/;

type Expect = 'value' | 'value_or_close' | 'key_or_close' | 'colon' | 'after_value';

interface StringRead {
  raw: string;
  content: string;
  terminated: boolean;
}

/**
 * Rewrites the object starting at `start` so that it parses, or returns null.
 *
 * `start` must index the `{` the caller located. The scanner stops as soon as
 * that object closes, so trailing prose after the object costs nothing.
 */
export function repairJsonObject(source: string, start: number): JsonRepairResult | null {
  if (source[start] !== '{') return null;

  const out: string[] = [];
  const repairs: JsonRepair[] = [];
  /** Each open container, with where its opener sits in `out` — so an unfinished one can be dropped whole. */
  const stack: { kind: 'object' | 'array'; at: number }[] = [];
  let i = start;
  let expect: Expect = 'value';

  /*
   * The last point at which the emitted text was a well-formed prefix: just
   * after a container opened, a value completed, or a container closed. A
   * truncated answer rewinds to here, so a half-written member is discarded
   * rather than guessed at.
   */
  let safeLength = 0;
  let safeStack: { kind: 'object' | 'array'; at: number }[] = [];

  const note = (repair: JsonRepair) => {
    if (!repairs.includes(repair)) repairs.push(repair);
  };
  const markSafe = () => {
    safeLength = out.length;
    safeStack = [...stack];
  };
  const isSpace = (ch: string) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
  const skipSpace = () => {
    while (i < source.length && isSpace(source[i]!)) {
      out.push(source[i]!);
      i += 1;
    }
  };
  /** The next non-space character without consuming anything. */
  const peekNonSpace = (from: number): { ch: string | null; at: number } => {
    let j = from;
    while (j < source.length && isSpace(source[j]!)) j += 1;
    return { ch: j < source.length ? source[j]! : null, at: j };
  };
  const readString = (): StringRead => {
    let j = i + 1;
    let content = '';
    let escaped = false;
    while (j < source.length) {
      const ch = source[j]!;
      if (escaped) {
        content += ch;
        escaped = false;
        j += 1;
        continue;
      }
      if (ch === '\\') {
        content += ch;
        escaped = true;
        j += 1;
        continue;
      }
      if (ch === '"') {
        const raw = source.slice(i, j + 1);
        i = j + 1;
        return { raw, content, terminated: true };
      }
      content += ch;
      j += 1;
    }
    const raw = source.slice(i);
    i = source.length;
    return { raw, content, terminated: false };
  };
  const closeTruncatedTail = (): void => {
    note('truncated_tail');
    /*
     * Where to cut. The default is the last complete member. But an unfinished
     * *element of an array* is dropped whole rather than kept half-written: a
     * day object carrying only its number, with no stay, theme or activities,
     * is not a shorter day — it is a day the answer never wrote, and presenting
     * it as one would push a fabricated shape into the normalizer. A member of
     * an object is different: `{"a":1,"b":2,"c":` still knew a and b.
     */
    let rewind = safeLength;
    let depth = safeStack.length;
    while (depth >= 2 && safeStack[depth - 2]!.kind === 'array' && safeStack[depth - 1]!.at < rewind) {
      rewind = safeStack[depth - 1]!.at;
      depth -= 1;
    }
    out.length = rewind;
    // A member or element the answer never finished leaves a dangling separator.
    while (out.length > 0) {
      const tail = out[out.length - 1]!;
      if (tail.trim() === '' || tail === ',') out.pop();
      else break;
    }
    for (let level = depth - 1; level >= 0; level -= 1) {
      out.push(safeStack[level]!.kind === 'object' ? '}' : ']');
    }
    // Every container the safe prefix left open has now been closed by hand.
    stack.length = 0;
  };

  const LITERAL = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;

  for (;;) {
    skipSpace();

    if (i >= source.length) {
      if (stack.length === 0) break;
      closeTruncatedTail();
      break;
    }

    const ch = source[i]!;

    if (expect === 'value' || expect === 'value_or_close') {
      if (expect === 'value_or_close' && ch === ']') {
        out.push(ch);
        i += 1;
        stack.pop();
        markSafe();
        if (stack.length === 0) break;
        expect = 'after_value';
        continue;
      }
      if (ch === '{') {
        stack.push({ kind: 'object', at: out.length });
        out.push(ch);
        i += 1;
        markSafe();
        expect = 'key_or_close';
        continue;
      }
      if (ch === '[') {
        stack.push({ kind: 'array', at: out.length });
        out.push(ch);
        i += 1;
        markSafe();
        expect = 'value_or_close';
        continue;
      }
      if (ch === '"') {
        const read = readString();
        out.push(read.terminated ? read.raw : `${read.raw}"`);
        if (stack.length === 0) return null; // a bare string is not an object
        if (read.terminated) {
          markSafe();
        } else {
          /*
           * A value the answer stopped inside is never kept. Half a sentence
           * reads as a whole one, and half a place name is a different place —
           * so the member is left outside the safe prefix and the truncated
           * tail discards it.
           */
          note('unterminated_string');
        }
        expect = 'after_value';
        continue;
      }
      const literal = LITERAL.exec(source.slice(i));
      if (literal) {
        out.push(literal[0]!);
        i += literal[0]!.length;
        if (stack.length === 0) return null;
        markSafe();
        expect = 'after_value';
        continue;
      }
      return null;
    }

    if (expect === 'key_or_close') {
      if (ch === '}') {
        out.push(ch);
        i += 1;
        stack.pop();
        markSafe();
        if (stack.length === 0) break;
        expect = 'after_value';
        continue;
      }
      if (ch !== '"') return null;
      const read = readString();
      if (!read.terminated) {
        // A key the answer stopped inside: nothing usable follows it.
        closeTruncatedTail();
        break;
      }
      const next = peekNonSpace(i);
      if (next.ch === ':') {
        out.push(read.raw);
        expect = 'colon';
        continue;
      }
      /*
       * The Hong Kong slip. The key ran into its own value and then into the
       * separator, so what was read as one string is really `key`, `value` and
       * a comma. Re-emit the three, and expect the next key.
       */
      const swallowed = SWALLOWED_DELIMITER.exec(read.content);
      if (swallowed && (next.ch === '"' || /[A-Za-z_]/.test(next.ch ?? ''))) {
        /*
         * The quote this scan treated as the string's terminator is really the
         * OPENING quote of the next key — `{"day2,"stay":…` — so it is handed
         * back before the next member is read.
         */
        if (next.ch !== '"') i -= 1;
        out.push(`${JSON.stringify(swallowed[1]!)}:${swallowed[2]!},`);
        note('key_delimiter');
        markSafe();
        expect = 'key_or_close';
        continue;
      }
      if (next.ch !== null) {
        // A key with no colon before its value.
        out.push(`${read.raw}:`);
        note('missing_colon');
        expect = 'value';
        continue;
      }
      closeTruncatedTail();
      break;
    }

    if (expect === 'colon') {
      if (ch === ':') {
        out.push(ch);
        i += 1;
        expect = 'value';
        continue;
      }
      out.push(':');
      note('missing_colon');
      expect = 'value';
      continue;
    }

    // expect === 'after_value'
    const top = stack[stack.length - 1]?.kind;
    if (ch === ',') {
      const next = peekNonSpace(i + 1);
      if ((next.ch === '}' && top === 'object') || (next.ch === ']' && top === 'array')) {
        i += 1;
        note('trailing_comma');
        continue;
      }
      out.push(ch);
      i += 1;
      expect = top === 'object' ? 'key_or_close' : 'value';
      continue;
    }
    if (ch === '}' && top === 'object') {
      out.push(ch);
      i += 1;
      stack.pop();
      markSafe();
      if (stack.length === 0) break;
      expect = 'after_value';
      continue;
    }
    if (ch === ']' && top === 'array') {
      out.push(ch);
      i += 1;
      stack.pop();
      markSafe();
      if (stack.length === 0) break;
      expect = 'after_value';
      continue;
    }
    if (ch === '"' || ch === '{' || ch === '[' || LITERAL.test(source.slice(i))) {
      // Two members or elements with nothing between them.
      out.push(',');
      note('missing_comma');
      expect = top === 'object' ? 'key_or_close' : 'value';
      continue;
    }
    return null;
  }

  if (stack.length > 0) return null;
  return { text: out.join(''), repairs, end: i };
}
