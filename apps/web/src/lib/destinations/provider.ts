import 'server-only';
import {
  fuzzyPrefixes,
  normalizeSuggestionQuery,
  rankSuggestions,
  type DestinationSuggestionProvider,
  type DestinationSuggestionResult,
} from '@sidequest/core';
import {
  destinationEntryById,
  destinationIndexRelease,
  entriesByPrefix,
  entriesByPrefixes,
} from '../db/destination-index-repository';

/**
 * The storage-backed suggestion provider.
 *
 * Differs from the in-memory reference implementation in exactly one way: how it
 * *prunes* before ranking. The ranking itself is the same pure function, so an
 * ordering somebody disagrees with is reproducible in a unit test without a
 * database, and a database that returned rows in a different order cannot change
 * what the dropdown says.
 *
 * Nothing in this file makes a network request, and `architecture.test.ts` fails
 * the build if it ever does. That is the whole reason the index exists.
 */

/** Below this many exact-prefix hits, it is worth paying for a typo-tolerant pass. */
const FUZZY_THRESHOLD = 4;

export function localSuggestionProvider(): DestinationSuggestionProvider {
  return {
    name: 'local-index',
    release: () => destinationIndexRelease(),
    async suggest(query): Promise<DestinationSuggestionResult> {
      const release = destinationIndexRelease();
      if (!release) {
        return {
          kind: 'unavailable',
          reason: 'No destination index has been built on this deployment yet.',
        };
      }

      const normalized = normalizeSuggestionQuery(query);
      if (!normalized) return { kind: 'too_short' };

      const exact = entriesByPrefix(normalized.folded);
      /*
       * The fuzzy pass runs on *thin* results, not on none.
       *
       * "Kyrgistan" has an exact prefix hit on nothing, but "Bishkeck" has an
       * exact hit on a village called Bish- something, and waiting for zero
       * before tolerating a typo would serve that village and stop. Four is the
       * point at which a dropdown looks answered.
       */
      const entries =
        exact.length >= FUZZY_THRESHOLD
          ? exact
          : [...exact, ...entriesByPrefixes(fuzzyPrefixes(normalized.folded))];

      const suggestions = rankSuggestions(entries, normalized);
      if (suggestions.length === 0) return { kind: 'no_match', release };
      return { kind: 'suggestions', suggestions, release };
    },
    async byId(entryId) {
      return destinationEntryById(entryId);
    },
  };
}
