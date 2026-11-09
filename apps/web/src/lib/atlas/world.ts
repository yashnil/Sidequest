import 'server-only';
import { arrayWorld, destinationCatalog, DESTINATION_CATALOG_VERSION, type Atlas, type DestinationWorld } from '@sidequest/core';
import { atlasFailure, loadAtlas } from '@sidequest/atlas';

/**
 * THE ONE WORLD "HELP ME CHOOSE" RANKS.
 *
 * The global atlas, loaded once per process from the file that ships with the
 * product. If that file is missing or unreadable the advisor does not fail: it
 * falls back to the curated catalog alone, says so in its read-out
 * (`degraded`), and logs why. No request ever downloads anything to build the
 * world.
 */
export interface AdvisorWorld {
  world: DestinationWorld;
  /** The atlas itself, for name resolution and coverage; null when degraded to the curated catalog. */
  atlas: Atlas | null;
  version: string;
  degraded: string | null;
}

let fallback: DestinationWorld | null = null;
let warned = false;

let warming = false;

export function advisorWorld(): AdvisorWorld {
  const loaded = loadAtlas();
  if (loaded) {
    /*
     * The first interview step ranks the world dozens of times and would
     * otherwise also pay for the atlas's lazily built tables. They are built
     * here once, after the current request has been answered.
     */
    if (!warming) {
      warming = true;
      setImmediate(() => {
        try {
          loaded.atlas.warm();
        } catch (error) {
          console.error('Warming the destination atlas failed; its tables will be built on first use instead.', { error });
        }
      });
    }
    return { world: loaded.atlas, atlas: loaded.atlas, version: loaded.atlas.version, degraded: null };
  }
  const reason = atlasFailure() ?? 'atlas unavailable';
  if (!warned) {
    warned = true;
    console.error('The global destination atlas could not be loaded; the advisor is ranking the curated catalog only.', { reason });
  }
  fallback ??= arrayWorld(destinationCatalog(), DESTINATION_CATALOG_VERSION);
  return { world: fallback, atlas: null, version: DESTINATION_CATALOG_VERSION, degraded: reason };
}
