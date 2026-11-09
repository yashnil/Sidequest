import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPERIENCES, WORLD_REGIONS, DESTINATION_KINDS, destinationCatalog, DESTINATION_CATALOG_VERSION } from '../../core/src/advisor/catalog/index';
import { PRICE_LEVELS, PRICE_LEVEL_SOURCE } from '../../core/src/intelligence/reference/price-levels';

/**
 * Hands the curated catalog and the reference tables the atlas build needs to
 * the plain-Node build stages, which cannot import TypeScript.
 *
 *     npx vitest run --config vitest.harness.config.ts packages/atlas/build/dump-curated.harness.ts
 *
 * The curated entries are the labels the experience estimator is fitted to and
 * checked against, and they are merged into the atlas as its editorial rows.
 */
describe('atlas build input', () => {
  it('writes the curated catalog and reference vocabularies', () => {
    const cache = process.env.ATLAS_CACHE ?? '.atlas-cache';
    mkdirSync(`${cache}/work`, { recursive: true });
    const catalog = destinationCatalog();
    writeFileSync(
      `${cache}/work/curated.json`,
      JSON.stringify({
        version: DESTINATION_CATALOG_VERSION,
        experiences: EXPERIENCES,
        worldRegions: WORLD_REGIONS,
        kinds: DESTINATION_KINDS,
        priceLevels: PRICE_LEVELS,
        priceLevelSource: PRICE_LEVEL_SOURCE,
        entries: catalog,
      }),
    );
    expect(catalog.length).toBeGreaterThan(200);
  });
});
