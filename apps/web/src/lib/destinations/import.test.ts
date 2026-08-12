import { describe, expect, it } from 'vitest';
import { buildIndex, type RawDivisionRecord } from './import';

/**
 * WHAT THE INDEX IS ALLOWED TO HOLD.
 *
 * "Help me decide" asks the index for regions, counties, islands, national parks
 * and protected areas. The live release — 109,853 entries, Overture 2026-07-22 —
 * supplies 3,919 regions, 38,909 counties, 12,080 cities, 53,542 towns, 1,131
 * districts, 219 countries, 53 dependencies, and **zero** islands, parks or
 * protected areas. One of the three doors on the homepage therefore opens on
 * eight administrative polygons.
 *
 * There are two causes and this file covers the second one. The first is
 * acquisition: the only producer reads Overture's *divisions* theme, whose
 * subtype vocabulary is administrative by construction, and is stated on
 * `RECOMMENDABLE` where the ask is made. The second is that even handed a
 * national park, this importer returned `null` for it and dropped the row
 * without a count — so whoever built the producer would have got a healthy
 * looking entry count and no parks.
 */

function raw(overrides: Partial<RawDivisionRecord> = {}): RawDivisionRecord {
  return {
    sourceId: 'x',
    subtype: 'region',
    primaryName: 'Somewhere',
    aliases: [],
    bbox: { xmin: 9.9, xmax: 10.1, ymin: 39.9, ymax: 40.1 },
    ...overrides,
  };
}

describe('a landscape destination can get into the index', () => {
  /**
   * The shape is pinned by the one Overture base-theme row this repository
   * holds: `{ subtype: 'physical', class: 'peak' }` in `overture.test.ts`. The
   * classes are matched loosely for the reason given at `landscapeFeatureTypeFor`
   * — an unrecognised class is dropped exactly as it is today, so a gap costs
   * nothing, while a wrong guess in a closed list would look like coverage.
   */
  it.each([
    ['physical', 'island', 'island'],
    ['physical', 'archipelago', 'island'],
    ['protected', 'national_park', 'national_park'],
    ['protected', 'nature_reserve', 'protected_area'],
    ['land_use', 'protected_area', 'protected_area'],
  ])('classifies %s/%s as %s', (subtype, featureClass, expected) => {
    const { entries } = buildIndex([
      raw({ sourceId: 'a', subtype, class: featureClass, primaryName: 'Test Feature' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.featureType).toBe(expected);
  });

  it('still classifies the administrative subtypes it always did', () => {
    const { entries } = buildIndex([
      raw({ sourceId: 'a', subtype: 'country', countryCode: 'AA', primaryName: 'Aland' }),
      raw({ sourceId: 'b', subtype: 'county', primaryName: 'Shire' }),
      raw({ sourceId: 'c', subtype: 'locality', population: 400_000, primaryName: 'Big Town' }),
      raw({ sourceId: 'd', subtype: 'locality', population: 900, primaryName: 'Small Town' }),
      raw({ sourceId: 'e', subtype: 'neighborhood', primaryName: 'A Quarter' }),
    ]);
    expect(entries.map((entry) => entry.featureType)).toEqual([
      'country',
      'county',
      'city',
      'town',
      'district',
    ]);
  });
});

/**
 * A SILENT DROP IS HOW A MISSING FEATURE TYPE SURVIVES A PHASE.
 *
 * An operator posting a file gets back an entry count and a malformed-line
 * count, both of which look healthy while an entire kind of place is discarded
 * on the way in. Counting the discards by subtype is the difference between a
 * gap somebody can see in the response and a gap somebody has to query the
 * database to find.
 */
describe('the import reports what it could not classify', () => {
  it('counts unrecognised subtypes rather than dropping them in silence', () => {
    const { entries, unclassified } = buildIndex([
      raw({ sourceId: 'a', subtype: 'region' }),
      raw({ sourceId: 'b', subtype: 'microhood' }),
      raw({ sourceId: 'c', subtype: 'microhood' }),
      raw({ sourceId: 'd', subtype: 'water', class: 'lake' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(unclassified).toEqual({ microhood: 2, water: 1 });
  });

  it('reports nothing when every row landed', () => {
    const { unclassified } = buildIndex([raw({ sourceId: 'a', subtype: 'region' })]);
    expect(unclassified).toEqual({});
  });
});
