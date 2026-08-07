import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESTINATION_INDEX_VERSION, type DestinationIndexEntry } from '@sidequest/core';
import { getDb } from './client';
import { INDEX_MIGRATIONS } from './schema';
import {
  recommendationUniverse,
  replaceDestinationIndex,
  scanRecommendationUniverse,
  UNIVERSE_SQL,
} from './destination-index-repository';

/**
 * THE CANDIDATE UNIVERSE: WHAT IT COSTS, AND WHETHER IT IS THE SAME LIST TWICE.
 *
 * The read this covers used to be a `ROW_NUMBER()` window over
 * `country_code IS NOT NULL`, which is a range over the leading index column and
 * therefore a scan of the whole index — every matching row's `payload_json`
 * materialised and sorted twice, synchronously, on the click that builds a
 * shortlist. On a 109,853-entry catalogue that is 42,826 rows and 50–210 ms of a
 * blocked event loop.
 *
 * Two properties are asserted here and neither is about speed directly, because
 * a timing assertion in a unit test is a flake with a stopwatch:
 *
 * 1. **The work is bounded by how many countries exist**, not by how many places
 *    do. Adding ten thousand entries to one country must not change what the
 *    read costs.
 * 2. **The same index gives the same list.** `rank` is a coarse pruning key with
 *    heavy ties, so both cuts land inside a tie; the old statement left that
 *    choice to the query planner, which means it was not a function of the
 *    inputs at all.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-destination-index-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'index.db');
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  getDb();
});

afterEach(() => {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const RECOMMENDABLE = ['region', 'county', 'island', 'national_park', 'protected_area'] as const;

/**
 * An index shaped like the real one where it matters: many countries, one of
 * them enormous, and prominence values that collide constantly.
 *
 * The collisions are the point. In the live catalogue every `region` floors at a
 * pruning key of 70, so 447 entries compete for the last 19 seats of a 240-row
 * universe and 165 countries have a tied third seat. A fixture with distinct
 * ranks would make every ordering question disappear and prove nothing.
 */
function syntheticIndex(input: {
  countries: number;
  perCountryPerType: number;
  /** One country given far more entries than the rest, to test the bound. */
  crowdedCountry?: { code: string; entries: number };
}): DestinationIndexEntry[] {
  const entries: DestinationIndexEntry[] = [];
  const push = (countryCode: string, featureType: string, n: number, prominence: number): void => {
    entries.push({
      id: `fixture:${countryCode}-${featureType}-${n}`,
      catalog: 'fixture',
      sourceId: `${countryCode}-${featureType}-${n}`,
      featureType: featureType as DestinationIndexEntry['featureType'],
      displayName: `${countryCode} ${featureType} ${n}`,
      aliases: [],
      countryCode,
      hierarchy: [countryCode],
      center: { lat: (n % 80) - 40, lng: (n % 160) - 80 },
      prominence,
    });
  };

  for (let country = 0; country < input.countries; country += 1) {
    const code = String.fromCharCode(65 + Math.floor(country / 26), 65 + (country % 26));
    for (const featureType of RECOMMENDABLE) {
      for (let n = 0; n < input.perCountryPerType; n += 1) {
        // Deliberately coarse: three distinct prominence values across dozens of
        // entries, so ties are the normal case rather than the exception.
        push(code, featureType, n, 70 + (n % 3) * 5);
      }
    }
  }

  if (input.crowdedCountry) {
    for (let n = 0; n < input.crowdedCountry.entries; n += 1) {
      push(input.crowdedCountry.code, 'county', 10_000 + n, 70 + (n % 3) * 5);
    }
  }

  return entries;
}

function load(entries: readonly DestinationIndexEntry[]): void {
  replaceDestinationIndex({
    entries,
    release: {
      schemaVersion: DESTINATION_INDEX_VERSION,
      catalog: 'fixture',
      releaseId: 'fixture-1',
      entryCount: entries.length,
      builtAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

/**
 * The universe, computed in TypeScript over every row the table holds.
 *
 * The point of comparison, and deliberately not a rewrite of the SQL: it reads
 * the whole table, keeps the top `perCountry` of each country by (rank
 * descending, id ascending) and then the top `limit` of those by the same rule.
 * If the bounded read agrees with this, the bound removed work rather than
 * answers.
 */
function referenceUniverse(perCountry: number, limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT id, country_code, rank FROM destination_index
        WHERE feature_type IN (${RECOMMENDABLE.map(() => '?').join(',')})
          AND country_code IS NOT NULL`,
    )
    .all(...RECOMMENDABLE) as { id: string; country_code: string; rank: number }[];

  const order = (a: { id: string; rank: number }, b: { id: string; rank: number }): number =>
    a.rank !== b.rank ? b.rank - a.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

  const byCountry = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byCountry.get(row.country_code) ?? [];
    bucket.push(row);
    byCountry.set(row.country_code, bucket);
  }

  const seats: typeof rows = [];
  for (const bucket of byCountry.values()) {
    bucket.sort(order);
    seats.push(...bucket.slice(0, perCountry));
  }
  seats.sort(order);
  return seats.slice(0, limit).map((row) => row.id);
}

function idsOf(entries: readonly DestinationIndexEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

function planFor(sql: string, params: unknown[]): string[] {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as [])) as { detail: string }[];
  return rows.map((row) => row.detail);
}

describe('the recommendation universe', () => {
  it('returns exactly the stratified top of the index, tie-break included', () => {
    load(syntheticIndex({ countries: 40, perCountryPerType: 6 }));

    const entries = recommendationUniverse({
      featureTypes: RECOMMENDABLE,
      perCountry: 3,
      limit: 240,
    });

    expect(idsOf(entries)).toEqual(referenceUniverse(3, 240));
    expect(entries.length).toBe(120); // 40 countries × 3 seats, under the ceiling
  });

  it('gives the same list on every call, and the list is a function of the inputs alone', () => {
    load(syntheticIndex({ countries: 40, perCountryPerType: 6 }));

    const first = idsOf(recommendationUniverse({ featureTypes: RECOMMENDABLE, perCountry: 3, limit: 60 }));
    const second = idsOf(recommendationUniverse({ featureTypes: RECOMMENDABLE, perCountry: 3, limit: 60 }));
    expect(second).toEqual(first);

    /*
     * The property the previous implementation did not have.
     *
     * Its ordering among equal pruning keys came from whichever plan the
     * optimiser chose, so creating an index over the same table changed 20 of
     * the 240 rows it returned on the live catalogue. Here the same event must
     * change nothing.
     */
    getDb().exec(
      'CREATE INDEX IF NOT EXISTS tmp_universe_probe ON destination_index(rank DESC, country_code)',
    );
    getDb().exec('ANALYZE');
    const afterIndex = idsOf(
      recommendationUniverse({ featureTypes: RECOMMENDABLE, perCountry: 3, limit: 60 }),
    );
    expect(afterIndex).toEqual(first);
  });

  it('reads a number of rows set by how many countries exist, not how many places do', () => {
    const base = syntheticIndex({ countries: 30, perCountryPerType: 4 });
    load(base);
    const small = scanRecommendationUniverse({
      featureTypes: RECOMMENDABLE,
      perCountry: 3,
      limit: 240,
    });

    // The same thirty countries, one of which now holds five thousand more
    // entries than the others put together.
    load(syntheticIndex({
      countries: 30,
      perCountryPerType: 4,
      crowdedCountry: { code: 'AA', entries: 5_000 },
    }));
    const crowded = scanRecommendationUniverse({
      featureTypes: RECOMMENDABLE,
      perCountry: 3,
      limit: 240,
    });

    const ceiling = crowded.countries * RECOMMENDABLE.length * 3;
    expect(crowded.indexRowsRead).toBeLessThanOrEqual(ceiling);
    expect(crowded.payloadRowsRead).toBeLessThanOrEqual(240);

    // Five thousand extra rows in one country cost the read nothing at all.
    expect(crowded.countries).toBe(small.countries);
    expect(crowded.indexRowsRead).toBe(small.indexRowsRead);

    // And it is genuinely a fraction of the table rather than a smaller scan.
    const total = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM destination_index
            WHERE feature_type IN (${RECOMMENDABLE.map(() => '?').join(',')})
              AND country_code IS NOT NULL`,
        )
        .get(...RECOMMENDABLE) as { n: number }
    ).n;
    expect(total).toBeGreaterThan(5_000);
    expect(crowded.indexRowsRead + crowded.payloadRowsRead).toBeLessThan(total / 5);
  });

  it('enumerates countries and buckets through indexes, never by scanning the table', () => {
    load(syntheticIndex({ countries: 12, perCountryPerType: 4 }));

    const countryPlan = planFor(UNIVERSE_SQL.countries, []).join(' | ');
    expect(countryPlan).toMatch(/SEARCH destination_index USING (COVERING )?INDEX/);
    expect(countryPlan).not.toMatch(/SCAN destination_index/);

    const bucketPlan = planFor(UNIVERSE_SQL.bucket, ['AA', 'region', 3]).join(' | ');
    expect(bucketPlan).toMatch(/SEARCH destination_index USING (COVERING )?INDEX/);
    expect(bucketPlan).not.toMatch(/SCAN destination_index/);

    const payloadPlan = planFor(UNIVERSE_SQL.payload, ['fixture:AA-region-0']).join(' | ');
    expect(payloadPlan).toMatch(/SEARCH destination_index USING (INTEGER PRIMARY KEY|INDEX sqlite_autoindex)/);
  });

  /**
   * The remaining half of the bound, and the one that lives in a file this
   * module does not own.
   *
   * `LIMIT n` only stops an index walk early when the index is already in the
   * order the query asks for. Without `rank` in the index SQLite reads every row
   * of the (country, feature type) range into a temporary b-tree and returns
   * three of them — so the *result* is bounded and the *read* is not, which is
   * the defect in a smaller costume. Measured on the live catalogue: 54 ms with
   * the sort, 21 ms without it.
   *
   * The index therefore belongs in `INDEX_MIGRATIONS`, and this asserts it is
   * there rather than trusting a comment to carry the requirement.
   */
  it('declares the ordered covering index the bucket read is designed against', () => {
    const declared = INDEX_MIGRATIONS.join('\n').replace(/\s+/g, ' ');
    expect(declared).toMatch(
      /CREATE INDEX IF NOT EXISTS \S+ ON destination_index\(country_code, feature_type, rank DESC/i,
    );

    const bucketPlan = planFor(UNIVERSE_SQL.bucket, ['AA', 'region', 3]).join(' | ');
    expect(bucketPlan).not.toMatch(/TEMP B-TREE/);
  });

  it('asks for nothing at all when there is nothing to ask for', () => {
    load(syntheticIndex({ countries: 3, perCountryPerType: 2 }));
    expect(scanRecommendationUniverse({ featureTypes: [], perCountry: 3, limit: 240 }).entries).toEqual([]);
    expect(
      scanRecommendationUniverse({ featureTypes: RECOMMENDABLE, perCountry: 0, limit: 240 }).indexRowsRead,
    ).toBe(0);
    expect(
      scanRecommendationUniverse({ featureTypes: RECOMMENDABLE, perCountry: 3, limit: 0 }).entries,
    ).toEqual([]);
  });
});
