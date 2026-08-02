import 'server-only';
import {
  packScopeHash,
  packMatchesRelease,
  type GeographicScope,
} from '@sidequest/core';
import type { RegionPackOutcome, RegionPackProvider } from '@sidequest/compiler';
import { scopeBounds } from '@sidequest/compiler';
import {
  findRegionPack,
  findStaleRegionPack,
  saveRegionPack,
} from '../../db/pack-repository';
import { readProviderCache, writeProviderCache } from '../../db/compiler-repository';
import { CatalogError, CATALOG_NAME, latestRelease } from './catalog';
import { createOverturePackProvider, type PackProviderOptions } from './pack';

/**
 * THE PACK PROVIDER THE APPLICATION ACTUALLY USES.
 *
 * Everything expensive about the backbone happens once per piece of ground, and
 * this is where that is enforced. The order is the honest one from the research
 * note, and each step produces a *different* answer rather than a fallback that
 * looks like the real thing:
 *
 * 1. a stored pack for this ground and this release → reuse, say nothing;
 * 2. build one, store it, use it;
 * 3. a stored pack from an older release → use it, **labelled stale**;
 * 4. nothing → unavailable, with the reason.
 *
 * `forceRefresh` skips step 1 only. It never skips storing, and it never mutates
 * the pack it replaces — a refresh writes a new row, so a plan built last week
 * can still be explained.
 *
 * Nothing here runs on a page render. A compiled region carries everything it
 * needs; this is reached only when something is being compiled.
 */

/** How long a resolved release pin is reused. Releases arrive about monthly. */
const RELEASE_TTL_MS = 24 * 60 * 60 * 1000;

export function createCachedPackProvider(
  options: PackProviderOptions = {},
): RegionPackProvider {
  const inner = createOverturePackProvider({
    ...options,
    fetchOptions: {
      ...options.fetchOptions,
      cache: options.fetchOptions?.cache ?? {
        read: (key) => readProviderCache<unknown>(key, new Date()),
        write: (key, value, ttlMs) =>
          writeProviderCache(key, 'overture-catalog', value, ttlMs, new Date()),
      },
    },
  });

  return {
    name: 'overture-pack-cached',
    async getPack(input): Promise<RegionPackOutcome> {
      const scopeHash = hashFor(input.scope);

      /**
       * The release is resolved before the store is consulted, not after.
       *
       * A stored pack is only a *hit* if it was built from the release we would
       * build from now — otherwise reusing it silently pins the product to
       * whatever release happened to be current the first time anybody looked
       * at this city.
       */
      let releaseId: string | undefined;
      let releaseError: string | undefined;
      try {
        const release = await latestRelease({
          cache: {
            read: (key) => readProviderCache<unknown>(key, new Date()),
            write: (key, value) =>
              writeProviderCache(key, 'overture-catalog', value, RELEASE_TTL_MS, new Date()),
          },
        });
        releaseId = release.releaseId;
      } catch (error) {
        releaseError =
          error instanceof CatalogError
            ? error.message
            : 'We could not reach the place data catalogue.';
      }

      if (!input.forceRefresh && releaseId) {
        const stored = findRegionPack({ scopeHash, catalog: CATALOG_NAME, releaseId });
        if (stored && packMatchesRelease(stored, CATALOG_NAME, releaseId)) {
          input.onProgress?.({
            state: stored.state,
            detail: 'regional place data already held',
          });
          return stored.state === 'partial'
            ? {
                kind: 'partial',
                pack: stored,
                reason:
                  stored.failure?.detail ?? 'Some areas were not read when this data was prepared.',
              }
            : { kind: 'ready', pack: stored, source: 'cache' };
        }
      }

      if (releaseId) {
        const built = await inner.getPack(input);
        if (built.kind === 'ready' || built.kind === 'partial') {
          const stored = saveRegionPack(built.pack);
          return built.kind === 'ready'
            ? { kind: 'ready', pack: stored, source: 'built' }
            : { kind: 'partial', pack: stored, reason: built.reason };
        }
        // Fall through to the stale path: a build that failed is exactly when
        // last month's data is worth more than an empty region.
        releaseError = built.kind === 'unavailable' ? built.message : releaseError;
      }

      const stale = findStaleRegionPack(scopeHash);
      if (stale) {
        const staleRelease = stale.releases[0]?.releaseId ?? 'an earlier release';
        return {
          kind: 'stale',
          pack: stale,
          reason: `Built from ${staleRelease} because the current place data could not be read. ${releaseError ?? ''}`.trim(),
        };
      }

      return {
        kind: 'unavailable',
        code: 'provider_unavailable',
        message: releaseError ?? 'We could not prepare place data for that area.',
      };
    },
  };
}

export function hashFor(scope: GeographicScope): string {
  return packScopeHash({
    destinationCandidateId: scope.destinationCandidateId,
    bounds: scopeBounds(scope),
  });
}
