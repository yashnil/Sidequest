import {
  INTERPRETATION_VERSION,
  LEXICON_VERSION,
  type ChipTarget,
  type InterpretationSet,
  type InterpretedChip,
  type PreferenceStrength,
  type SuggestedQuestion,
} from '../schemas/interpretation';
import {
  EMPHATIC_AFFIRMING_MARKERS,
  EMPHATIC_REFUSING_MARKERS,
  LEXICON_FUNCTION_WORDS,
  LEXICON_LOCALE,
  NEGATORS,
  NON_LEXICON_FUNCTION_WORDS,
  PHRASES,
  SAFETY_ADJACENT,
  SOFT_MARKERS,
  STRONG_MARKERS,
  TENTATIVE_MARKERS,
} from './phrases';

/**
 * READING WHAT SOMEBODY WROTE, DETERMINISTICALLY.
 *
 * Pure, offline, free and total. It runs before any model would, and on ordinary
 * traveller sentences it resolves the lot — which is the point: the same
 * argument the source-category taxonomy makes, that a controlled vocabulary does
 * not need a model to be read.
 *
 * The pipeline is four passes over the traveller's own characters:
 *
 * 1. **Segment** on sentence and clause boundaries, keeping offsets.
 * 2. **Polarity** per clause, from a closed list of negators. Per *clause*, not
 *    per sentence: "hiking and hot springs but no crowds" is three preferences
 *    and one of them is negative.
 * 3. **Strength** from a closed list of markers. Absence of a strong marker can
 *    never produce `must_have` or `hard_avoid` — the phrasing has to be there.
 * 4. **Look up** each clause against the phrase table, longest match first.
 *
 * Everything that matches nothing is returned as unresolved, quoted. Everything
 * that sounds like a safety, dietary or accessibility constraint becomes a
 * *question* and never a chip, whatever its polarity or strength.
 *
 * It is English-only, and `lexiconLocale` says so on every result rather than
 * letting "we do not read your language" look like "you wrote nothing".
 */

/** Where a clause sits in the original string. Offsets index the stored text. */
interface Clause {
  text: string;
  start: number;
  end: number;
}

/**
 * Split on sentence and clause boundaries, keeping offsets into the original.
 *
 * `but`, `though` and `however` are boundaries as well as punctuation, because
 * they are where polarity most often flips mid-sentence — and a parser that read
 * "hiking but no crowds" as one clause would give both halves the same sign.
 */
export function segment(text: string): Clause[] {
  const clauses: Clause[] = [];
  const pattern = /[.;\n!?]+|,\s*(?=but\b|though\b|however\b)|\s+(?:but|though|however)\s+/gi;

  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const end = match.index ?? 0;
    push(text.slice(cursor, end), cursor);
    cursor = end + match[0].length;
  }
  push(text.slice(cursor), cursor);
  return clauses;

  function push(slice: string, offset: number): void {
    const leading = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed.length === 0) return;
    clauses.push({ text: trimmed, start: offset + leading, end: offset + leading + trimmed.length });
  }
}

function folded(value: string): string {
  return value
    .toLowerCase()
    /*
     * Bidirectional and zero-width controls are stripped before anything reads
     * this. A right-to-left override inside a preference is not a preference; it
     * is an attempt to make a chip render as something other than what matched.
     */
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '')
    .replace(/\s+/g, ' ');
}

export function polarityOf(clause: string): 'positive' | 'negative' {
  const text = folded(clause);
  return NEGATORS.some((negator) => text.includes(negator)) ? 'negative' : 'positive';
}

/** Word-boundary match, so `love` does not fire on `lovely`. */
function hasMarker(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'u').test(text);
  });
}

/**
 * How firmly it was meant, on the seven-member taxonomy.
 *
 * The rule that matters, and it is the same rule it always was: **absence of a
 * marker never yields `must_have` or `hard_avoid`.** A bare mention is an
 * ordinary preference or an ordinary dislike, and the whole gap between "we're
 * not big museum people" and "no museums" is a phrase the traveller either wrote
 * or did not.
 *
 * The ladder is read in order of how specific the phrasing is, weakest first,
 * so that a clause carrying two markers is read at the more tentative of them —
 * "we'd love a spa if it works out" is conditional, whatever else is in it.
 * Over-reading firmness is the failure that costs a traveller a day; under-
 * reading it costs a suggestion.
 */
export function strengthOf(clause: string, polarity: 'positive' | 'negative'): PreferenceStrength {
  const text = folded(clause);
  if (hasMarker(text, TENTATIVE_MARKERS)) {
    return polarity === 'negative' ? 'dislike' : 'low_preference';
  }
  if (SOFT_MARKERS.some((marker) => text.includes(marker))) {
    return polarity === 'negative' ? 'dislike' : 'preference';
  }
  /*
   * Each direction reads only its own emphatic list. See the note on
   * `EMPHATIC_REFUSING_MARKERS` for why one shared list cannot work.
   */
  if (polarity === 'negative' && hasMarker(text, EMPHATIC_REFUSING_MARKERS)) {
    return 'strong_dislike';
  }
  if (polarity === 'positive' && hasMarker(text, EMPHATIC_AFFIRMING_MARKERS)) {
    return 'strong_preference';
  }
  const strong = STRONG_MARKERS.some((marker) => text.includes(marker));
  if (polarity === 'negative') {
    /*
     * An explicit exclusion marker is itself strong. "No crowds" and "never
     * again with the crowds" are both refusals; "not big on crowds" is not, and
     * the softer branches above have already taken it.
     *
     * The marker has to be in the traveller's own characters. It is not
     * synthesised from which box they typed in — see `classifyPreferences`.
     */
    const explicit = /\b(no|never|avoid|skip|cannot|can’t|can't|without|nothing)\b/.test(text);
    return strong || explicit ? 'hard_avoid' : 'dislike';
  }
  return strong ? 'must_have' : 'preference';
}

/**
 * WHETHER THIS IS PLAUSIBLY THE LANGUAGE THE LEXICON COVERS.
 *
 * Returns false only when we have a reason, never on a hunch, because the cost
 * of the two mistakes is not symmetric: telling somebody writing English that we
 * do not read English is worse than saying nothing about a French sentence.
 *
 * Signal one is the script, which is a fact about characters. Signal two is
 * lexical and is vetoed by any English function word at all, so a clause has to
 * be entirely free of English and contain another language's grammar before it
 * is called out. See `NON_LEXICON_FUNCTION_WORDS` for why the list is short.
 */
export function isLexiconLocale(text: string): boolean {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return true;
  const latin = letters.filter((character) => /\p{Script=Latin}/u.test(character)).length;
  if (latin / letters.length < 0.6) return false;

  const words = folded(text).split(/[^\p{L}’']+/u).filter(Boolean);
  if (words.some((word) => LEXICON_FUNCTION_WORDS.includes(word))) return true;
  return !words.some((word) => NON_LEXICON_FUNCTION_WORDS.includes(word));
}

/**
 * Stable across re-runs, and across *sources*.
 *
 * Exported because the bounded model fallback mints ids with the same function
 * rather than its own scheme. That matters for one reason: if the phrase table
 * later learns the idiom a model read for us, the deterministic chip lands on
 * the same id — so a chip somebody already rejected stays rejected instead of
 * being resurrected under a new identity by an unrelated improvement.
 */
export function chipIdFor(field: string, target: ChipTarget, start: number): string {
  return `chip:${field}:${target.kind}:${target.value}:${start}`;
}

/**
 * A capitalised run that is not at the start of a clause.
 *
 * Flagged so the screen can say "we noted this and did not look it up", which is
 * the only honest thing to do with a proper noun at composer time: there is no
 * geocoder on this path, so a name resolved here would have nothing downstream
 * to check it against.
 */
function looksLikeAName(clause: string): boolean {
  const words = clause.split(/\s+/).slice(1);
  return words.some((word) => /^[A-Z][\p{L}’'-]{2,}$/u.test(word));
}

export interface ClassifyInput {
  mustDo?: string;
  avoid?: string;
}

export function classifyPreferences(input: ClassifyInput): InterpretationSet {
  const chips: InterpretedChip[] = [];
  const unresolved: InterpretationSet['unresolved'] = [];
  const questions = new Map<string, SuggestedQuestion>();

  for (const field of ['mustDo', 'avoid'] as const) {
    const text = input[field];
    if (!text || text.trim().length === 0) continue;

    for (const clause of segment(text)) {
      const lowered = folded(clause.text);

      /*
       * Safety-adjacent text short-circuits everything.
       *
       * Checked before the phrase table, so a sentence that contains both a
       * preference and an allergy produces the question rather than a
       * confident-looking food chip beside it.
       */
      const safety = SAFETY_ADJACENT.find(([phrase]) => lowered.includes(phrase));
      if (safety) {
        const topic = safety[1];
        if (!questions.has(topic)) {
          questions.set(topic, { topic, quote: clause.text.slice(0, 200) });
        }
        continue;
      }

      /*
       * The `avoid` box sets the *direction* and nothing else.
       *
       * Somebody writing "crowds" under "anything you would rather not do" has
       * expressed a dislike, not an interest — and reading it as a positive is
       * the single most likely way this parser could produce the opposite of
       * what was meant.
       *
       * What it does **not** do any more is synthesise a refusal marker. This
       * used to read `strengthOf('no ' + clause.text, …)`, which put the word
       * "no" into the traveller's sentence and then read it back out as an
       * explicit refusal — so every single entry in the avoid box became
       * `hard_avoid`, a hard blocker, from a box whose own heading is "anything
       * you would rather not do". That is the exact thing this module's own
       * stated rule forbids: absence of a marker may never yield `hard_avoid`.
       * "Early starts" is now a dislike and "no early starts" is a refusal,
       * which is the difference the traveller actually typed.
       */
      const polarity = field === 'avoid' ? 'negative' : polarityOf(clause.text);
      const strength = strengthOf(clause.text, polarity);

      let matched = false;
      const claimed: [number, number][] = [];
      for (const [phrase, target] of PHRASES) {
        const at = lowered.indexOf(phrase);
        if (at === -1) continue;
        // Longest-first ordering means an earlier, longer phrase wins the span.
        if (claimed.some(([from, to]) => at < to && at + phrase.length > from)) continue;
        claimed.push([at, at + phrase.length]);

        const resolved = resolveTarget(target, polarity);
        if (!resolved) continue;

        const id = chipIdFor(field, resolved, clause.start);
        if (chips.some((chip) => chip.id === id)) continue;
        chips.push({
          id,
          field,
          span: [clause.start, clause.end],
          quote: clause.text.slice(0, 200),
          strength,
          target: resolved,
          source: 'deterministic',
          status: 'proposed',
        });
        matched = true;
      }

      if (!matched) {
        /*
         * Why we could not read it, when we can say why.
         *
         * "We have no setting that means this" is the wrong sentence for a
         * sentence written in a language we do not read: it tells somebody their
         * preference does not exist, when the truth is that our reader is
         * English-only. Absent means only that the phrase table did not match,
         * which is a different and much smaller claim.
         */
        const outsideLocale = !isLexiconLocale(clause.text);
        unresolved.push({
          span: [clause.start, clause.end],
          quote: clause.text.slice(0, 200),
          looksLikeAName: looksLikeAName(clause.text),
          ...(outsideLocale ? { clarificationReason: 'outside_the_locale_we_read' as const } : {}),
          /*
           * Which box it came from, carried so the bounded fallback can put a
           * chip back in the right one. Without it, "no early starts" typed in
           * the avoid box and the same words typed in the must-do box would be
           * indistinguishable by the time anything read them back — and the
           * avoid box is negative by default, which is the whole reason the
           * distinction is load-bearing.
           */
          field,
        });
      }
    }
  }

  return {
    schemaVersion: INTERPRETATION_VERSION,
    lexiconVersion: LEXICON_VERSION,
    lexiconLocale: LEXICON_LOCALE,
    chips: chips.slice(0, 24),
    unresolved: unresolved.slice(0, 24),
    suggestedQuestions: [...questions.values()].slice(0, 4),
  };
}

/**
 * What a negated interest, or a negated avoidance, actually means.
 *
 * An avoidance is already a negative statement, so "no crowds" is the avoidance
 * itself rather than its opposite — and a *positive* mention of an avoidance
 * ("we love a crowd") has no representation in the vocabulary at all, so it
 * resolves to nothing rather than to a made-up inverse. Returning null here is
 * why that sentence lands in `unresolved` and is shown as unread.
 */
function resolveTarget(target: ChipTarget, polarity: 'positive' | 'negative'): ChipTarget | null {
  if (target.kind === 'avoidance') return polarity === 'negative' ? target : null;
  return target;
}
