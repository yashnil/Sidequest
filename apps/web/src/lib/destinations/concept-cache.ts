import 'server-only';
import { destinationConceptSchema, destinationResolutionSchema } from '@sidequest/core';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';
import { CACHE_TTL_MS } from '../providers/cache-policy';
import type { CachedConcept, ConceptCache } from './intent-resolution';
import { z } from 'zod';

/**
 * V10 §15 — THE CANONICAL DESTINATION CONCEPT, CACHED FOR THIRTY DAYS.
 *
 * Where a phrase is is a fact about the phrase. Resolving one costs up to nine
 * geocoder round trips and, for a region-like phrase, one bounded interpreter
 * call — and the founder's setup screen spent all of that in the foreground with
 * nothing recording it. The concept is therefore cached at the coordinate TTL,
 * so the second traveller who types the same words waits for nothing.
 *
 * The resolver decides what is worth caching (a low-confidence answer, or one
 * whose centre is only a country stand-in, is not — caching that would freeze the
 * exact failure V10 exists to fix); this only stores and reads. A stored concept
 * that no longer parses under the current schema is ignored rather than trusted.
 */
/** Both halves of a cached answer: what the phrase is, and the resolution the same pass produced. */
const cachedConceptSchema = z.object({ concept: destinationConceptSchema, resolution: destinationResolutionSchema });

export function destinationConceptCache(now: () => Date = () => new Date()): ConceptCache {
  return {
    read(key: string): CachedConcept | null {
      const raw = readProviderCache<unknown>(key, now());
      if (raw === null) return null;
      const parsed = cachedConceptSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    write(key: string, value: CachedConcept): void {
      writeProviderCache(key, 'destination-concept', value, CACHE_TTL_MS.coordinates, now());
    },
  };
}
