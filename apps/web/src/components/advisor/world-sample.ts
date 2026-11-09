import 'server-only';
import { destinationCatalog } from '@sidequest/core';
import { advisorWorld } from '@/lib/atlas/world';
import { worldDotsPath } from './WorldDots';

/**
 * WHAT THE ADVISOR'S MAPS ARE GIVEN: A SAMPLE, AND THE TRUE COUNTS BESIDE IT.
 *
 * The atlas stays on the server. A screen gets a thinned sample of real
 * destination centres, already turned into path data, and the figures a
 * caption needs — how many destinations there are, how many of them the dots
 * show — so no caption has to guess whether it is looking at all of them.
 *
 * When the atlas could not be loaded the advisor ranks the curated catalog
 * alone (`advisorWorld().degraded`); the dots are then every curated
 * destination, and `complete` says so.
 */
export interface AdvisorWorldSample {
  /** Path data for `WorldDots`. */
  dots: string;
  /** How many destination centres the path was drawn from. */
  shown: number;
  /** How many destinations the advisor compares. */
  size: number;
  /** Countries those destinations fall in. */
  countries: number;
  /** True when the dots are every destination rather than a sample. */
  complete: boolean;
}

const SAMPLE_LIMIT = 1800;

let cached: { version: string; sample: AdvisorWorldSample } | null = null;

export function advisorWorldSample(): AdvisorWorldSample {
  const { world, atlas, version } = advisorWorld();
  if (cached?.version === version) return cached.sample;
  let sample: AdvisorWorldSample;
  if (atlas) {
    const points = atlas.samplePoints(SAMPLE_LIMIT);
    sample = { dots: worldDotsPath(points), shown: points.length, size: world.size, countries: atlas.coverage().countries, complete: points.length >= world.size };
  } else {
    const catalog = destinationCatalog();
    sample = {
      dots: worldDotsPath(catalog.map((entry) => entry.center)),
      shown: catalog.length,
      size: world.size,
      countries: new Set(catalog.flatMap((entry) => entry.countries)).size,
      complete: true,
    };
  }
  cached = { version, sample };
  return sample;
}
