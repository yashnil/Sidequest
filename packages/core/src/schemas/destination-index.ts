import { z } from 'zod';
import { coordinatesSchema } from './common';
import { geoBoundsSchema } from './geography';
import type { destinationEntityTypeSchema, scopeBreadthSchema } from './geography';

/**
 * THE DESTINATION SEARCH INDEX.
 *
 * What a worldwide product needs before a traveller has typed anything useful:
 * a bounded, versioned list of places somebody might mean, with a stable
 * identity, held locally, queried without touching anybody's public service.
 *
 * Three rules the whole file exists to enforce:
 *
 * 1. **The index is built, never inferred.** Entries come from a place
 *    catalogue's own records under a pinned release. A model may not add one, a
 *    geocoder may not add one at query time, and an entry that is not in the
 *    index is honestly reported as absent rather than invented.
 * 2. **Identity outlives the release.** `id` is derived from the catalogue's own
 *    stable feature id, not from the release it was read in, so refreshing to a
 *    newer release updates a row rather than orphaning every trip that names it.
 * 3. **Nothing traveller-specific is ever stored here.** The index is shared by
 *    everybody, exactly like the evidence store, and for the same reason: a
 *    ranking that depended on who was typing could not be cached, and a cache
 *    that held one traveller's preferences would serve them to the next.
 */

/**
 * What kind of thing a suggestion is, in traveller language.
 *
 * Deliberately coarser than a gazetteer's own taxonomy. Overture distinguishes
 * `localadmin` from `locality`; a traveller reading a dropdown does not, and a
 * label they cannot interpret is worse than none.
 */
export const DESTINATION_FEATURE_TYPES = [
  'country',
  'dependency',
  'region',
  'county',
  'city',
  'town',
  'district',
  'island',
  'national_park',
  'protected_area',
  'landmark',
  'other',
] as const;
export const destinationFeatureTypeSchema = z.enum(DESTINATION_FEATURE_TYPES);
export type DestinationFeatureType = z.infer<typeof destinationFeatureTypeSchema>;

export const DESTINATION_FEATURE_TYPE_LABELS: Record<DestinationFeatureType, string> = {
  country: 'Country',
  dependency: 'Territory',
  region: 'Region',
  county: 'County',
  city: 'City',
  town: 'Town',
  district: 'District',
  island: 'Island',
  national_park: 'National park',
  protected_area: 'Protected area',
  landmark: 'Landmark',
  other: 'Place',
};

/** How much ground a feature type covers. Drives scope, never display. */
export const FEATURE_TYPE_BREADTH: Record<DestinationFeatureType, z.infer<typeof scopeBreadthSchema>> = {
  country: 'country',
  dependency: 'country',
  region: 'region',
  county: 'subregion',
  city: 'city',
  town: 'city',
  district: 'local',
  island: 'subregion',
  national_park: 'subregion',
  protected_area: 'subregion',
  landmark: 'local',
  other: 'city',
};

/** How a feature type maps onto the resolution vocabulary the scope layer reads. */
export const FEATURE_TYPE_ENTITY: Record<
  DestinationFeatureType,
  z.infer<typeof destinationEntityTypeSchema>
> = {
  country: 'country',
  dependency: 'country',
  region: 'state_or_province',
  county: 'subregion',
  city: 'city',
  town: 'city',
  district: 'neighbourhood',
  island: 'island',
  national_park: 'protected_area',
  protected_area: 'protected_area',
  landmark: 'unknown',
  other: 'unknown',
};

export const DESTINATION_INDEX_VERSION = 1 as const;

export const destinationIndexEntrySchema = z.object({
  /** `${catalog}:${sourceId}`. Stable across releases by construction. */
  id: z.string().min(1),
  catalog: z.string().min(1),
  sourceId: z.string().min(1),
  featureType: destinationFeatureTypeSchema,
  /**
   * What leads on screen, English where the source publishes one.
   *
   * The screenshot journey showed the cost of not having this field: a card
   * headed `Кыргыз Республикасы` for somebody who typed "Kyrgyzstan". A name in
   * a script the traveller cannot read is not a confirmation of anything.
   */
  displayName: z.string().min(1),
  /** The local form, when it differs from `displayName`. Shown secondarily. */
  localName: z.string().min(1).optional(),
  /** Other names this may be typed as. Bounded at build time. */
  aliases: z.array(z.string().min(1)).default([]),
  countryCode: z.string().length(2).optional(),
  /** ISO 3166-2, e.g. `KG-GB`. Resolved to a name at query time. */
  regionCode: z.string().min(1).optional(),
  /** Coarse to fine, resolved names: `["Kyrgyzstan", "Issyk-Kul Region"]`. */
  hierarchy: z.array(z.string().min(1)).default([]),
  center: coordinatesSchema,
  /**
   * Present only when it was measured, never assumed.
   *
   * Division records are points; an extent is computed from the bounding box of
   * a feature's own indexed children, which is a real measurement from source
   * coordinates rather than a circle drawn around a centroid.
   */
  bounds: geoBoundsSchema.optional(),
  population: z.number().int().nonnegative().optional(),
  /**
   * The catalogue's cartographic prominence, higher meaning "label this sooner".
   *
   * Carried rather than recomputed because it is somebody else's measurement of
   * how well-known a place is, and inventing our own would be exactly the kind
   * of unsourced ranking this codebase refuses elsewhere.
   */
  prominence: z.number().optional(),
  wikidataId: z.string().regex(/^Q\d+$/).optional(),
});
export type DestinationIndexEntry = z.infer<typeof destinationIndexEntrySchema>;

/** One row of the dropdown. */
export const destinationSuggestionSchema = destinationIndexEntrySchema.extend({
  /** 0–1, deterministic. Shown as ordering, never as a number. */
  score: z.number().min(0).max(1),
  /** `[start, end)` character ranges of `matchedText` that the query matched. */
  highlight: z.array(z.tuple([z.number().int(), z.number().int()])).default([]),
  /** Which of the entry's names produced the match, for honest highlighting. */
  matchedText: z.string().min(1),
  /** Whether the match was exact-prefix or required edit tolerance. */
  matchKind: z.enum(['prefix', 'word_prefix', 'contains', 'fuzzy']),
});
export type DestinationSuggestion = z.infer<typeof destinationSuggestionSchema>;

/** What the index was built from, so a stale index can be named as one. */
export const destinationIndexReleaseSchema = z.object({
  schemaVersion: z.literal(DESTINATION_INDEX_VERSION),
  catalog: z.string().min(1),
  releaseId: z.string().min(1),
  entryCount: z.number().int().nonnegative(),
  builtAt: z.string().min(1),
});
export type DestinationIndexRelease = z.infer<typeof destinationIndexReleaseSchema>;

/**
 * A destination the traveller picked from the index.
 *
 * Persisted on the trip. Its presence is what lets the composer skip resolution
 * and interpretation entirely: there is nothing to interpret about a row the
 * traveller pointed at.
 */
export const selectedDestinationSchema = z.object({
  entryId: z.string().min(1),
  catalog: z.string().min(1),
  sourceId: z.string().min(1),
  /** The release the suggestion was read from. A record, not a constraint. */
  releaseId: z.string().min(1),
  displayName: z.string().min(1),
  localName: z.string().min(1).optional(),
  qualifiedName: z.string().min(1),
  featureType: destinationFeatureTypeSchema,
  center: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),
  countryCode: z.string().length(2).optional(),
  hierarchy: z.array(z.string().min(1)).default([]),
  selectedAt: z.string().min(1),
});
export type SelectedDestination = z.infer<typeof selectedDestinationSchema>;

/**
 * The longest query the suggestion layer will consider.
 *
 * A cap rather than a truncation: a 400-character "destination" is not a typo,
 * and answering it at all would make the index a free text-search endpoint for
 * anybody who found the URL.
 */
export const MAX_SUGGESTION_QUERY_LENGTH = 80;
/** Below this, every index in the world matches and the answer is noise. */
export const MIN_SUGGESTION_QUERY_LENGTH = 2;
/** How many rows the dropdown may show. */
export const MAX_SUGGESTIONS = 8;

export function qualifiedNameFor(entry: DestinationIndexEntry): string {
  const context = entry.hierarchy.filter((part) => part !== entry.displayName);
  return context.length > 0 ? `${entry.displayName}, ${context[context.length - 1]}` : entry.displayName;
}
