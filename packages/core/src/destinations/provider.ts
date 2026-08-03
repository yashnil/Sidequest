import type {
  DestinationIndexEntry,
  DestinationIndexRelease,
  DestinationSuggestion,
} from '../schemas/destination-index';
import { normalizeSuggestionQuery, rankSuggestions, type SuggestionQuery } from './match';

/**
 * THE SEAM A DESTINATION TYPEAHEAD ARRIVES THROUGH.
 *
 * Narrow on purpose. The contract is "given some typed characters, return rows
 * from an index you already hold" — and the *already hold* is the whole point.
 * A provider that satisfied this interface by calling a public geocoder per
 * keystroke would be violating that service's usage policy, would put a
 * traveller's half-typed text on somebody else's server, and would make the
 * dropdown as slow as the internet. `architecture.test.ts` asserts that no
 * implementation in this repository imports a network client.
 *
 * The other rule: **a provider may not invent an entry.** Everything it returns
 * has to have come from the index, so that selecting a suggestion yields a
 * stable, checkable source identity rather than a name a model produced.
 */
export interface DestinationSuggestionProvider {
  readonly name: string;
  /** Null when the index has never been built. Distinct from "built but empty". */
  release(): DestinationIndexRelease | null;
  suggest(query: SuggestionQuery): Promise<DestinationSuggestionResult>;
  /** Exact lookup for a previously-persisted selection. */
  byId(entryId: string): Promise<DestinationIndexEntry | null>;
}

export type DestinationSuggestionResult =
  | { kind: 'suggestions'; suggestions: DestinationSuggestion[]; release: DestinationIndexRelease }
  /** The query was too short, or empty after sanitisation. Not an error. */
  | { kind: 'too_short' }
  /** The index exists and genuinely has nothing. The user may still submit. */
  | { kind: 'no_match'; release: DestinationIndexRelease }
  /**
   * No index has been built on this deployment.
   *
   * Its own case rather than an empty list, because the two need different
   * sentences: "we have nothing by that name" is about the world, and "nobody
   * has built the index here yet" is about us.
   */
  | { kind: 'unavailable'; reason: string };

/**
 * An in-memory provider over a fixed set of entries.
 *
 * The reference implementation, and the one every test uses. A storage-backed
 * provider differs only in how it *prunes* before ranking — the ranking itself
 * is the same pure function, so a bug in ordering is reproducible without a
 * database.
 */
export function inMemorySuggestionProvider(input: {
  entries: readonly DestinationIndexEntry[];
  release: DestinationIndexRelease;
  name?: string;
}): DestinationSuggestionProvider {
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  return {
    name: input.name ?? 'in-memory',
    release: () => input.release,
    async suggest(query) {
      const normalized = normalizeSuggestionQuery(query);
      if (!normalized) return { kind: 'too_short' };
      const suggestions = rankSuggestions(input.entries, normalized);
      if (suggestions.length === 0) return { kind: 'no_match', release: input.release };
      return { kind: 'suggestions', suggestions, release: input.release };
    },
    async byId(entryId) {
      return byId.get(entryId) ?? null;
    },
  };
}
