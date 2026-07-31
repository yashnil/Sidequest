import { z } from 'zod';
import { coordinatesSchema, isoDateSchema } from './common';

/**
 * The fields every point of interest has, whatever kind of thing it is.
 *
 * Extracted when food venues arrived. A restaurant and a waterfall genuinely do
 * share an identity, a position and a provenance — and nothing else. Everything
 * that made `Place` a `Place` (physical intensity, hidden-gem score, seasonal
 * access, a weather profile, a drive time from base) is meaningless on a bakery,
 * and everything that makes a bakery a bakery (a price band, a cuisine, a meal
 * period, a dietary claim) has nowhere to live on a `Place`.
 *
 * So this is a base, not a union: two models that share eight fields rather than
 * one model with thirty and half of them null. See `schemas/food.ts` for the
 * argument in full.
 */

/**
 * Where the data came from. Provenance is a first-class field rather than an
 * afterthought: curated seed rows and future API rows must be distinguishable,
 * and confidence has to travel with the record for the honesty of the UI copy.
 */
export const placeSourceSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['curated', 'osm', 'google_places', 'opentripmap', 'wikivoyage', 'official']),
  url: z.string().url().optional(),
  /** 0-1. Curated-and-checked rows sit high; scraped rows will sit lower. */
  confidence: z.number().min(0).max(1),
  lastVerified: isoDateSchema,
});
export type PlaceSource = z.infer<typeof placeSourceSchema>;

/**
 * Spread into `placeSchema` and `foodVenueSchema`. Deliberately a plain object of
 * schemas rather than a `z.object` to extend: both consumers add refinements, and
 * a refined schema cannot be extended.
 */
export const POI_BASE_FIELDS = {
  id: z.string().min(1),
  regionId: z.string().min(1),
  name: z.string().min(1),
  locality: z.string().min(1),
  shortDescription: z.string().min(1).max(280),
  coordinates: coordinatesSchema,
  tags: z.array(z.string().min(1)).default([]),
  source: placeSourceSchema,
} as const;
