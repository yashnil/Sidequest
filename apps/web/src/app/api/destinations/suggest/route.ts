import { NextResponse } from 'next/server';
import {
  DESTINATION_FEATURE_TYPE_LABELS,
  MAX_SUGGESTIONS,
  MAX_SUGGESTION_QUERY_LENGTH,
  qualifiedNameFor,
  sanitizePlaceText,
} from '@sidequest/core';
import { localSuggestionProvider } from '@/lib/destinations/provider';

/**
 * THE TYPEAHEAD ENDPOINT.
 *
 * The only route in the product that is called while somebody is still typing,
 * which makes three properties non-negotiable:
 *
 * - **It reads one local table and nothing else.** No geocoder, no model, no
 *   catalogue. A dropdown that made a network call per keystroke would be both
 *   slow and, for the public geocoder, a policy violation.
 * - **It returns only what the index holds.** There is no path through this file
 *   by which a name that is not a stored row can reach a traveller.
 * - **It is bounded before it is parsed.** The query is capped and sanitised
 *   before it is looked at, so an oversized or control-character-laden string
 *   costs a slice rather than a scan.
 *
 * Deliberately *not* cached at the HTTP layer. The answer is a pure function of
 * the query and an index that changes on an explicit refresh, so a client-side
 * cache is the right place for it — and a shared server cache keyed on a query
 * string is an easy way to leak one person's half-typed text into another's
 * response headers.
 */

export const dynamic = 'force-dynamic';

const MAX_URL_QUERY = MAX_SUGGESTION_QUERY_LENGTH * 4;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const raw = (url.searchParams.get('q') ?? '').slice(0, MAX_URL_QUERY);
  const text = sanitizePlaceText(raw);

  const provider = localSuggestionProvider();
  let result;
  try {
    result = await provider.suggest({ text, limit: MAX_SUGGESTIONS });
  } catch (error) {
    console.error('Destination suggestion failed', error);
    return NextResponse.json(
      { kind: 'unavailable', reason: 'The destination index could not be read.' },
      { status: 200 },
    );
  }

  if (result.kind === 'suggestions') {
    /*
     * A view model rather than the stored row.
     *
     * The index carries provider ids, wikidata links and a raw prominence
     * number; a dropdown needs a name, a line of context and a stable id to send
     * back. Shipping the whole row would put source identifiers into a browser
     * for no purpose, and "no raw source ids as primary user language" is an
     * explicit requirement of this surface.
     */
    return NextResponse.json({
      kind: 'suggestions',
      release: result.release.releaseId,
      suggestions: result.suggestions.map((suggestion) => ({
        id: suggestion.id,
        displayName: suggestion.displayName,
        localName: suggestion.localName ?? null,
        qualifiedName: qualifiedNameFor(suggestion),
        typeLabel: DESTINATION_FEATURE_TYPE_LABELS[suggestion.featureType],
        featureType: suggestion.featureType,
        context: suggestion.hierarchy.join(' · '),
        highlight: suggestion.highlight,
        matchedText: suggestion.matchedText,
      })),
    });
  }

  return NextResponse.json(result);
}
