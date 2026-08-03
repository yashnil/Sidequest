import {
  MAX_SUGGESTIONS,
  MAX_SUGGESTION_QUERY_LENGTH,
  MIN_SUGGESTION_QUERY_LENGTH,
  type DestinationFeatureType,
  type DestinationIndexEntry,
  type DestinationSuggestion,
} from '../schemas/destination-index';
import { boundedEditDistance, foldForMatch, highlightRange, sanitizePlaceText } from './normalize';

/**
 * RANKING A DROPDOWN, DETERMINISTICALLY.
 *
 * The whole function is pure and traveller-independent, and both properties are
 * deliberate. Pure, because a suggestion list has to be identical for the same
 * query and the same index — a dropdown that reorders between keystrokes is
 * unusable. Traveller-independent, because the index is shared: a ranking that
 * knew who was typing could not be cached, and a cache that held one person's
 * preferences would hand them to the next.
 *
 * What decides the order, in descending weight:
 *
 * 1. **How the query matched.** A whole-name prefix beats a word prefix beats a
 *    substring beats an edit-tolerant match. This is what makes "Bish" produce
 *    Bishkek rather than a village whose name contains those letters.
 * 2. **How much of the name the query covered.** "Kyrgyz" against "Kyrgyzstan"
 *    is a stronger signal than "K" against it.
 * 3. **How well known the place is**, from the catalogue's own prominence and
 *    population — never from our own opinion, and never from a model.
 * 4. **Feature type**, mildly: a country is a more likely intent than a county
 *    that happens to share a prefix.
 *
 * Ties break on entry id so the order is total and testable.
 */

export type MatchKind = DestinationSuggestion['matchKind'];

const MATCH_KIND_WEIGHT: Record<MatchKind, number> = {
  prefix: 1,
  word_prefix: 0.82,
  contains: 0.58,
  fuzzy: 0.4,
};

/**
 * A gentle nudge, never a decision.
 *
 * Small enough that a strong prefix match on a town always outranks a weak one
 * on a country. Its whole job is breaking the tie between two equally-matching
 * names at different scales, where the broader one is the likelier intent.
 */
const FEATURE_TYPE_BONUS: Record<DestinationFeatureType, number> = {
  country: 0.1,
  dependency: 0.07,
  region: 0.06,
  city: 0.06,
  national_park: 0.05,
  island: 0.04,
  town: 0.03,
  county: 0.02,
  protected_area: 0.02,
  district: 0,
  landmark: 0,
  other: 0,
};

/** Two edits at most, and only for queries long enough for that to mean anything. */
const MAX_EDITS = 2;
const MIN_FUZZY_QUERY = 4;

export interface SuggestionQuery {
  text: string;
  limit?: number;
}

export interface NormalizedSuggestionQuery {
  /** The sanitized text, as typed. Used for highlighting. */
  raw: string;
  /** The folded form. The only thing compared against. */
  folded: string;
  limit: number;
}

/**
 * Whether this is worth answering at all.
 *
 * Returns null rather than throwing for the two ordinary cases — too short, or
 * nothing left after sanitisation — because "keep typing" is a normal state of a
 * text box, not an error.
 */
export function normalizeSuggestionQuery(query: SuggestionQuery): NormalizedSuggestionQuery | null {
  const raw = sanitizePlaceText(query.text).slice(0, MAX_SUGGESTION_QUERY_LENGTH);
  const folded = foldForMatch(raw);
  if (folded.length < MIN_SUGGESTION_QUERY_LENGTH) return null;
  const limit = Math.max(1, Math.min(query.limit ?? MAX_SUGGESTIONS, MAX_SUGGESTIONS));
  return { raw, folded, limit };
}

interface NameMatch {
  kind: MatchKind;
  /** 0–1: how much of the matched name the query accounts for. */
  coverage: number;
  text: string;
}

/**
 * The best way this one name can be said to match, or null.
 *
 * "Best" is ordered by kind first: a name that both starts with the query and
 * contains it later is a prefix match, not a contains match.
 */
export function matchName(name: string, folded: string): NameMatch | null {
  const candidate = foldForMatch(name);
  if (candidate.length === 0) return null;

  if (candidate.startsWith(folded)) {
    return { kind: 'prefix', coverage: folded.length / candidate.length, text: name };
  }

  const words = candidate.split(' ');
  if (words.length > 1) {
    for (const word of words) {
      if (word.startsWith(folded)) {
        return { kind: 'word_prefix', coverage: folded.length / candidate.length, text: name };
      }
    }
  }

  if (candidate.includes(folded)) {
    return { kind: 'contains', coverage: folded.length / candidate.length, text: name };
  }

  if (folded.length >= MIN_FUZZY_QUERY) {
    /*
     * Compared against the *head* of the candidate rather than the whole of it.
     *
     * A traveller typing "Kyrgistan" has typed a whole name badly; a traveller
     * typing "Kyrg" has typed part of one well. Measuring edits against the full
     * candidate would score the first as eight edits from "Kyrgyz Republic" and
     * throw it away. Truncating to the query's length measures the thing the
     * query was actually trying to be.
     */
    const head = candidate.slice(0, folded.length + MAX_EDITS);
    const distance = boundedEditDistance(folded, head, MAX_EDITS);
    if (distance <= MAX_EDITS) {
      const closeness = 1 - distance / (folded.length + 1);
      /*
       * A *symmetric* length ratio, not `query / candidate`.
       *
       * The asymmetric form gave a ratio above one whenever the query was longer
       * than the name it matched, and clamping that to one handed a four-letter
       * alias full coverage credit for a six-letter query. Live, that made
       * "Denali" offer Delhi first — matched through its Italian alias "Deli",
       * two edits away, and carried over an exact-prefix match on Denali Borough
       * by sixteen million inhabitants. A name shorter than the query is a worse
       * match, and the ratio has to say so.
       */
      const ratio =
        Math.min(folded.length, candidate.length) / Math.max(folded.length, candidate.length);
      return { kind: 'fuzzy', coverage: ratio * closeness, text: name };
    }
  }

  return null;
}

/** Every name an entry may be found by, display first so ties prefer it. */
export function namesOf(entry: DestinationIndexEntry): string[] {
  const names = [entry.displayName];
  if (entry.localName && entry.localName !== entry.displayName) names.push(entry.localName);
  for (const alias of entry.aliases) if (!names.includes(alias)) names.push(alias);
  return names;
}

/**
 * The catalogue's own view of how well known a place is, folded to 0–1.
 *
 * Population is log-scaled because the difference between a village and a town
 * matters far more to a dropdown than the difference between two megacities, and
 * a linear term would let Tokyo outrank an exact-name match anywhere else.
 */
export function prominenceOf(entry: DestinationIndexEntry): number {
  const fromProminence =
    typeof entry.prominence === 'number' ? Math.min(1, Math.max(0, entry.prominence / 100)) : 0;
  const population = entry.population ?? 0;
  const fromPopulation = population > 0 ? Math.min(1, Math.log10(population) / 7.5) : 0;
  return Math.max(fromProminence, fromPopulation);
}

export function scoreEntry(
  entry: DestinationIndexEntry,
  folded: string,
): { score: number; match: NameMatch } | null {
  let best: NameMatch | null = null;
  for (const name of namesOf(entry)) {
    const match = matchName(name, folded);
    if (!match) continue;
    if (
      !best ||
      MATCH_KIND_WEIGHT[match.kind] > MATCH_KIND_WEIGHT[best.kind] ||
      (MATCH_KIND_WEIGHT[match.kind] === MATCH_KIND_WEIGHT[best.kind] && match.coverage > best.coverage)
    ) {
      best = match;
    }
  }
  if (!best) return null;

  const kind = MATCH_KIND_WEIGHT[best.kind];
  const coverage = Math.min(1, Math.max(0, best.coverage));
  const known = prominenceOf(entry);
  const type = FEATURE_TYPE_BONUS[entry.featureType];

  /*
   * A weighted sum rather than a lexicographic sort, because a very well known
   * place matching on a word prefix genuinely should beat an obscure one
   * matching on a whole-name prefix — "York" ought to offer New York — and a
   * strict ordering by kind can never express that.
   *
   * **Fame is scaled by how well the query actually matched.** Without the
   * `kind` factor on the prominence term, being famous compensates for not
   * matching: a megacity two edits away outranks an exact-prefix hit on
   * somewhere small, which is how "Denali" came to offer Delhi. Prominence is
   * evidence about a place, never about whether it is the place somebody typed.
   */
  const score = 0.55 * kind + 0.2 * coverage + 0.2 * known * kind + type;
  return { score: Math.min(1, Math.max(0, score)), match: best };
}

/**
 * Rank a bounded set of candidate entries.
 *
 * The caller is responsible for the bound — the storage layer prunes by prefix
 * before anything reaches here — because scoring every place on earth per
 * keystroke is exactly the thing a local index exists to avoid.
 */
export function rankSuggestions(
  entries: readonly DestinationIndexEntry[],
  query: NormalizedSuggestionQuery,
): DestinationSuggestion[] {
  const scored: DestinationSuggestion[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const result = scoreEntry(entry, query.folded);
    if (!result) continue;
    scored.push({
      ...entry,
      score: result.score,
      matchedText: result.match.text,
      matchKind: result.match.kind,
      highlight: highlightRange(result.match.text, query.raw),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, query.limit);
}
