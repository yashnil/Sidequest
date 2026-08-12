import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DestinationIndexEntry } from '@sidequest/core';
import { coPublicationsOf } from './identity';

/**
 * A DESTINATION PUBLISHED TWICE, AND THE THREE THINGS THAT LOOK LIKE ONE.
 *
 * Every fixture here is a real shape out of the live destination index, because
 * the rule is only worth anything if it survives the catalogue's actual
 * accidents. The numbers in the comments were measured against the index built
 * on this machine.
 */

/** `id` is `<catalog>:<sourceId>` by construction in the index builder. */
function entry(overrides: Partial<DestinationIndexEntry> & { id: string }): DestinationIndexEntry {
  return {
    catalog: 'overture',
    featureType: 'city',
    displayName: overrides.id,
    aliases: [],
    hierarchy: [],
    center: { lat: 0, lng: 0 },
    ...overrides,
    sourceId: overrides.id,
    id: `overture:${overrides.id}`,
  } as DestinationIndexEntry;
}

/** Tokyo, exactly as the index holds it: the same place at two rungs. */
const tokyoLocality = entry({
  id: '798895d4',
  featureType: 'city',
  displayName: 'Tokyo',
  localName: '東京都',
  countryCode: 'JP',
  regionCode: 'JP-13',
  wikidataId: 'Q1490',
  center: { lat: 35.6768589, lng: 139.7638931 },
  population: 13613660,
});

const tokyoRegion = entry({
  id: '689e36ca',
  featureType: 'region',
  displayName: 'Tokyo',
  localName: '東京都',
  countryCode: 'JP',
  regionCode: 'JP-13',
  wikidataId: 'Q1490',
  center: { lat: 34.2255783, lng: 139.2947769 },
  bounds: {
    southWest: { lat: 24.77973747, lng: 139.07306671 },
    northEast: { lat: 35.81820297, lng: 141.31993866 },
  },
});

/** A city that carries its province's ISO code without being that province. */
const kyotoCity = entry({
  id: 'kyoto',
  featureType: 'city',
  displayName: 'Kyoto',
  countryCode: 'JP',
  regionCode: 'JP-26',
  wikidataId: 'Q34600',
  center: { lat: 35.0116, lng: 135.7681 },
});

/** The province Kyoto sits in. A different entity, and the index says so. */
const kyotoPrefecture = entry({
  id: 'ff26e266',
  featureType: 'region',
  displayName: 'Kyoto Prefecture',
  countryCode: 'JP',
  regionCode: 'JP-26',
  wikidataId: 'Q120730',
  center: { lat: 35.24255, lng: 135.4546 },
  bounds: {
    southWest: { lat: 34.73714638, lng: 135.03722382 },
    northEast: { lat: 35.7145977, lng: 136.00360871 },
  },
});

/**
 * Bishkek, as the index holds it: a city that **is** a first-level division.
 *
 * Both rows carry `Q9361`, and `KG-GB` is the city's own ISO 3166-2 code rather
 * than a container's — which is the whole of the case below.
 */
const bishkekRegion = entry({
  id: 'e2ab04df',
  featureType: 'region',
  displayName: 'Bishkek City',
  countryCode: 'KG',
  regionCode: 'KG-GB',
  wikidataId: 'Q9361',
  center: { lat: 42.86217117, lng: 74.6000824 },
  bounds: {
    southWest: { lat: 42.80201149, lng: 74.53577042 },
    northEast: { lat: 42.91798401, lng: 74.64201736 },
  },
});

const bishkekCity = entry({
  id: '85bc7963',
  featureType: 'city',
  displayName: 'Bishkek',
  countryCode: 'KG',
  regionCode: 'KG-GB',
  wikidataId: 'Q9361',
  center: { lat: 42.87614441, lng: 74.60366821 },
  population: 1074075,
});

/**
 * A PROVINCE THAT SHARES ITS CAPITAL'S IDENTITY, WHICH IS NOT THE SAME THING.
 *
 * Kept because the rule has to survive it. Phetchabun Province and the town of
 * Phetchabun both carry `Q240520` in the live index, and they share a name, so
 * the pool finds the pair and `coPublicationsOf` accepts it. Twenty-nine
 * divisions in the index are this shape — provinces across Thailand, Turkey and
 * Vietnam named after their capital. Identity pairs them; only the extents can
 * tell a 170 km province from a town of twenty-four thousand people.
 */
const phetchabunProvince = entry({
  id: 'e661be8b',
  featureType: 'region',
  displayName: 'Phetchabun Province',
  localName: 'จังหวัดเพชรบูรณ์',
  countryCode: 'TH',
  regionCode: 'TH-67',
  wikidataId: 'Q240520',
  center: { lat: 16.32931805, lng: 100.95526886 },
  bounds: {
    southWest: { lat: 15.4469223, lng: 100.78318024 },
    northEast: { lat: 16.99221325, lng: 101.59663391 },
  },
});

const phetchabunTown = entry({
  id: '32b7ce53',
  featureType: 'town',
  displayName: 'Phetchabun',
  localName: 'เพชรบูรณ์',
  countryCode: 'TH',
  regionCode: 'TH-67',
  wikidataId: 'Q240520',
  center: { lat: 16.41802692, lng: 101.1556778 },
  population: 23823,
});

describe('the other publications of the same place', () => {
  it('pairs a metropolis with the first-level division it also is', () => {
    /*
     * The failure this exists for. Of 3,787 records in the stored Tokyo pack,
     * 319 publish a parent chain and **every one names the region**; not one
     * names the locality the index handed the traveller. A scope carrying only
     * the locality can never place a record inside its own destination.
     */
    expect(coPublicationsOf(tokyoLocality, [tokyoRegion]).map((e) => e.sourceId)).toEqual([
      '689e36ca',
    ]);
    /* Symmetric: whichever row was picked, the other one is still the same place. */
    expect(coPublicationsOf(tokyoRegion, [tokyoLocality]).map((e) => e.sourceId)).toEqual([
      '798895d4',
    ]);
  });

  it('refuses a city inside a same-named region that is a different place', () => {
    /**
     * New York City sits inside New York State. Same name, same country, one
     * inside the other, different rungs — every test a name-based union would
     * apply, passed. The catalogue says otherwise: `Q60` against `Q1384`.
     *
     * Getting this wrong is not a cosmetic error. The union feeds
     * `selectedDivisionIds`, so every record in upstate New York would become a
     * high-confidence member of a traveller's five-day city trip.
     */
    const city = entry({
      id: 'a4c73b33',
      featureType: 'city',
      displayName: 'New York',
      countryCode: 'US',
      regionCode: 'US-NY',
      wikidataId: 'Q60',
      center: { lat: 40.7127, lng: -74.0059 },
    });
    const state = entry({
      id: 'af4de2ef',
      featureType: 'region',
      displayName: 'New York',
      countryCode: 'US',
      regionCode: 'US-NY',
      wikidataId: 'Q1384',
      center: { lat: 43.1561, lng: -75.8449 },
      bounds: {
        southWest: { lat: 40.58345795, lng: -79.42172241 },
        northEast: { lat: 44.98665428, lng: -72.15924835 },
      },
    });
    expect(coPublicationsOf(city, [state])).toEqual([]);
  });

  it('refuses siblings a contributor tagged with one knowledge-base id', () => {
    /*
     * The index holds ten rows sharing `Q574593` — a cluster of neighbouring
     * Nigerian settlements — and six Cayman districts sharing `Q5589389`. A
     * shared identifier is a claim; it becomes a *union* only when the rows also
     * sit at different rungs, which siblings never do. `city` and `town` share a
     * rung here precisely so a population threshold cannot fake a hierarchy.
     */
    const warri = entry({
      id: 'eb4c143d',
      featureType: 'city',
      displayName: 'Warri',
      countryCode: 'NG',
      wikidataId: 'Q574593',
      center: { lat: 5.5195, lng: 5.748 },
      population: 120_000,
    });
    const merogun = entry({
      id: '17f3eade',
      featureType: 'town',
      displayName: 'Merogun',
      countryCode: 'NG',
      wikidataId: 'Q574593',
      center: { lat: 5.5115, lng: 5.769 },
      bounds: {
        southWest: { lat: 5.4, lng: 5.6 },
        northEast: { lat: 5.6, lng: 5.9 },
      },
    });
    expect(coPublicationsOf(warri, [merogun])).toEqual([]);
    expect(coPublicationsOf(merogun, [warri])).toEqual([]);
  });

  it('refuses a coarser row that publishes no extent to corroborate with', () => {
    /*
     * The index measures country and region extents from the bounding box of
     * their own indexed children and gives a county none at all. Buenos Aires is
     * published as a city, a region **and** a county; the county can claim
     * nothing about containment, so it is not admitted on a name and an id
     * alone.
     */
    const county = entry({
      ...tokyoRegion,
      id: 'f7f9261a',
      featureType: 'county',
      bounds: undefined,
    });
    expect(coPublicationsOf(tokyoLocality, [county])).toEqual([]);
  });

  it('refuses a same-named place in another country, and another catalogue', () => {
    /*
     * Berlin, New Hampshire is `Q821244`; Berlin, Germany is `Q64`. The country
     * code and the identifier both refuse it, and either alone is enough.
     */
    const elsewhere = entry({ ...tokyoRegion, id: 'other-country', countryCode: 'US' });
    expect(coPublicationsOf(tokyoLocality, [elsewhere])).toEqual([]);

    const otherCatalog = entry({ ...tokyoRegion, id: 'other-catalog', catalog: 'somewhere-else' });
    expect(coPublicationsOf(tokyoLocality, [otherCatalog])).toEqual([]);
  });

  it('claims nothing for a row the catalogue never cross-identified', () => {
    /*
     * No Wikidata id is 19% of the index. Absent evidence produces no union
     * rather than a name match, because a name match is exactly the New York
     * failure above.
     */
    const unlinked = entry({ ...tokyoLocality, wikidataId: undefined });
    expect(coPublicationsOf(unlinked, [tokyoRegion])).toEqual([]);
  });

  it('claims nothing for a destination that is not an administrative division', () => {
    /*
     * A national park or an island is not a rung of anybody's hierarchy, so
     * pairing one with a division would assert a containment nobody published.
     */
    const park = entry({ ...tokyoLocality, featureType: 'national_park' });
    expect(coPublicationsOf(park, [tokyoRegion])).toEqual([]);
  });
});

/**
 * THE QUERY, OVER A REAL INDEX.
 *
 * The rule above is pure; this is the half that has to find the rows to apply it
 * to, and the half that answers for a destination the index never held.
 */
describe('resolving a chosen destination to catalogue identifiers', () => {
  let dir: string;

  function releaseDatabase(): void {
    const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
    holder.sidequestDb?.close();
    delete holder.sidequestDb;
  }

  beforeEach(async () => {
    releaseDatabase();
    dir = mkdtempSync(join(tmpdir(), 'sidequest-identity-'));
    process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
    const index = await import('../db/destination-index-repository');
    const entries = [
      tokyoLocality,
      tokyoRegion,
      kyotoCity,
      kyotoPrefecture,
      bishkekRegion,
      bishkekCity,
      phetchabunProvince,
      phetchabunTown,
    ];
    index.replaceDestinationIndex({
      entries,
      release: {
        schemaVersion: 1,
        catalog: 'overture',
        releaseId: 'test-release',
        entryCount: entries.length,
        builtAt: '2026-08-01T00:00:00.000Z',
      },
    });
  });

  afterEach(() => {
    releaseDatabase();
    delete process.env.SIDEQUEST_DB_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers with the chosen row first and its other publication after', async () => {
    const { destinationDivisionIds } = await import('./identity');
    expect(
      destinationDivisionIds({
        id: 'overture:798895d4',
        countryCode: 'JP',
        regionCode: 'JP-13',
        entityType: 'city',
      }),
    ).toEqual(['798895d4', '689e36ca']);
  });

  it('finds the first-level division a geocoded destination is, by its ISO code', async () => {
    /**
     * A free-text destination is resolved by a geocoder, so it carries an OSM
     * element id and no catalogue row at all. Measured on the second Tokyo pack
     * stored on this machine — compiled from `relation/1543125` — that left
     * 3,033 of 3,787 records with no membership verdict and zero anchors, from
     * a pack that answers completely once the division is known.
     *
     * ISO 3166-2 is the bridge because it is a *code*: unique within a country,
     * published by both catalogues, and immune to the scripts and translations
     * that make a name comparison worthless.
     */
    const { destinationDivisionIds } = await import('./identity');
    expect(
      destinationDivisionIds({
        id: 'relation/1543125',
        countryCode: 'JP',
        regionCode: 'JP-13',
        entityType: 'state_or_province',
      }),
    ).toEqual(['689e36ca', '798895d4']);
  });

  it('refuses to hand a city the identity of the region it sits in', async () => {
    /*
     * Kyoto carries `JP-26` because it is *in* Kyoto Prefecture, not because it
     * is one. Matching a city on its region code would give a traveller who
     * asked for one city every record in the province, which is the same
     * over-admission §12.1 forbids from the other direction.
     */
    const { destinationDivisionIds } = await import('./identity');
    expect(
      destinationDivisionIds({
        id: 'relation/99999',
        countryCode: 'JP',
        regionCode: 'JP-13',
        entityType: 'city',
      }),
    ).toEqual([]);
  });

  it('claims nothing for a destination no catalogue row answers for', async () => {
    const { destinationDivisionIds } = await import('./identity');
    expect(
      destinationDivisionIds({ id: 'relation/1', countryCode: 'FR', entityType: 'city' }),
    ).toEqual([]);
  });

  /**
   * A CITY THAT IS ITS OWN FIRST-LEVEL DIVISION.
   *
   * The rung rule above is right and, taken alone, was too coarse: a free-text
   * "Bishkek" is geocoded as a `city` carrying `KG-GB`, which is *its own* ISO
   * 3166-2 code and not a province's, and it got nothing. The live index holds
   * 129 first-level divisions the catalogue also publishes as a settlement —
   * Buenos Aires, Mexico City, Bogotá, Bamako, Ceuta, Tokyo, Bishkek — so this is
   * a large share of the city trips a traveller would type rather than pick.
   *
   * Every destination below is a real geocoder answer, taken from the cached
   * Nominatim responses on this machine, and the index rows are the real ones.
   */
  describe('a geocoded city that is itself a first-level division', () => {
    /** Nominatim, `bishkek, kyrgyzstan`: `relation/8493930`, addresstype `city`. */
    const bishkek = {
      id: 'relation/8493930',
      countryCode: 'KG',
      regionCode: 'KG-GB',
      entityType: 'city' as const,
      bounds: {
        southWest: { lat: 42.7155529, lng: 74.4548909 },
        northEast: { lat: 43.0125007, lng: 74.7177168 },
      },
    };

    it('adopts the division when the catalogue calls it a settlement and the extents agree', async () => {
      const { destinationDivisionIds } = await import('./identity');
      expect(destinationDivisionIds(bishkek)).toEqual(['e2ab04df', '85bc7963']);
    });

    it('refuses a ward that carries the metropolis code above it', async () => {
      /*
       * Nominatim, `shinjuku, tokyo`: `relation/1758858`, also addresstype
       * `city`, also carrying `JP-13` — because it is *inside* Tokyo. Identity
       * passes here (Tokyo is published at both rungs), so the extents are the
       * only thing standing between a traveller who asked for one ward and a
       * board covering the Ogasawara Islands.
       */
      const { destinationDivisionIds } = await import('./identity');
      expect(
        destinationDivisionIds({
          id: 'relation/1758858',
          countryCode: 'JP',
          regionCode: 'JP-13',
          entityType: 'city',
          bounds: {
            southWest: { lat: 35.6732207, lng: 139.6732748 },
            northEast: { lat: 35.7299039, lng: 139.7451394 },
          },
        }),
      ).toEqual([]);
    });

    it('refuses a town that shares its province name and its province id', async () => {
      /*
       * The case the extent test exists for, and the one identity cannot see:
       * Phetchabun Province and the town of Phetchabun share `Q240520` and a
       * name, so the pool finds the pair and `coPublicationsOf` accepts it.
       * A town-sized published boundary cannot hold a 170 km province, and that
       * is the only thing between a traveller who typed the town and a board
       * covering the province.
       */
      const { destinationDivisionIds } = await import('./identity');
      expect(
        destinationDivisionIds({
          id: 'relation/222222',
          countryCode: 'TH',
          regionCode: 'TH-67',
          entityType: 'city',
          bounds: {
            southWest: { lat: 16.38, lng: 101.12 },
            northEast: { lat: 16.46, lng: 101.2 },
          },
        }),
      ).toEqual([]);
    });

    it('refuses when the geocoder published no boundary to compare', async () => {
      /*
       * No extent, nothing to compare, no claim. A destination whose edges nobody
       * published keeps the identity it had before this rule existed.
       */
      const { destinationDivisionIds } = await import('./identity');
      const { bounds, ...withoutBounds } = bishkek;
      void bounds;
      expect(destinationDivisionIds(withoutBounds)).toEqual([]);
    });

    it('refuses a division the catalogue never publishes as a settlement', async () => {
      /*
       * The identity half, isolated. The published boundary here is wide enough
       * to hold Kyoto Prefecture's whole extent, so the extent test would accept;
       * what refuses is the catalogue, which gives the prefecture `Q120730` and
       * the city `Q34600` and so never pairs them.
       */
      const { destinationDivisionIds } = await import('./identity');
      expect(
        destinationDivisionIds({
          id: 'relation/333333',
          countryCode: 'JP',
          regionCode: 'JP-26',
          entityType: 'city',
          bounds: {
            southWest: { lat: 34.0, lng: 134.0 },
            northEast: { lat: 36.5, lng: 137.0 },
          },
        }),
      ).toEqual([]);
    });
  });
});
