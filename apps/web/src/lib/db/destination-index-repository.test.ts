import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESTINATION_INDEX_VERSION, type DestinationIndexEntry } from '@sidequest/core';
import { getDb } from './client';
import { INDEX_MIGRATIONS } from './schema';
import {
  destinationEntryById,
  destinationIndexRelease,
  destinationIndexSize,
  entriesByPrefix,
  entriesInCountry,
  replaceDestinationIndex,
} from './destination-index-repository';

/**
 * THE DESTINATION INDEX: WHAT THE TYPED-DESTINATION PATH READS FROM IT.
 *
 * This file used to hold the previous destination ranker's worldwide
 * "candidate universe" scan to its query plan. That scan went with the ranker
 * — the advisor ranks its own atlas and never reads this table — and what is
 * left here is the part every typed destination still depends on: a wholesale
 * replace, a read by id, a country-scoped read in pruning order, and a prefix
 * seek.
 *
 * The fixture keeps its collisions on purpose. In the live catalogue every
 * `region` floors at a pruning key of 70, so "most prominent first" is a claim
 * about ties as much as about order.
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
 * them enormous, and prominence values that collide constantly. A fixture with
 * distinct ranks would make every ordering question disappear and prove nothing.
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

function idsOf(entries: readonly DestinationIndexEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

function planFor(sql: string, params: unknown[]): string[] {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as [])) as { detail: string }[];
  return rows.map((row) => row.detail);
}

describe('the destination index', () => {
  it('is replaced wholesale: the index is the old release or the new one, never a mixture', () => {
    load(syntheticIndex({ countries: 4, perCountryPerType: 2 }));
    expect(destinationIndexSize()).toBe(4 * RECOMMENDABLE.length * 2);
    expect(destinationEntryById('fixture:AD-region-1')?.countryCode).toBe('AD');

    load(syntheticIndex({ countries: 2, perCountryPerType: 1 }));
    expect(destinationIndexSize()).toBe(2 * RECOMMENDABLE.length);
    expect(destinationEntryById('fixture:AD-region-1')).toBeNull();
    expect(destinationIndexRelease()).toMatchObject({ catalog: 'fixture', releaseId: 'fixture-1', entryCount: 10 });
  });

  it('reads an entry back by id exactly as it was written, and answers null for one it does not hold', () => {
    const entries = syntheticIndex({ countries: 3, perCountryPerType: 2 });
    load(entries);
    const wanted = entries.find((entry) => entry.id === 'fixture:AB-island-1')!;
    expect(destinationEntryById(wanted.id)).toEqual(wanted);
    expect(destinationEntryById('fixture:nowhere')).toBeNull();
  });

  it('does not serve a row the current schema cannot read, and does not throw on it', () => {
    load(syntheticIndex({ countries: 2, perCountryPerType: 2 }));
    getDb().prepare('UPDATE destination_index SET payload_json = ? WHERE id = ?').run('{"id":7}', 'fixture:AA-region-0');
    expect(destinationEntryById('fixture:AA-region-0')).toBeNull();
    // One bad entry must not empty the country it sits in.
    expect(idsOf(entriesInCountry('AA', ['region']))).toEqual(['fixture:AA-region-1']);
  });

  it('reads one country, only the feature types asked for, most prominent first, up to the limit', () => {
    load(syntheticIndex({ countries: 6, perCountryPerType: 6, crowdedCountry: { code: 'AB', entries: 900 } }));

    const regions = entriesInCountry('AC', ['region']);
    expect(regions).toHaveLength(6);
    expect(regions.every((entry) => entry.countryCode === 'AC' && entry.featureType === 'region')).toBe(true);
    const ranks = regions.map((entry) => entry.prominence ?? 0);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));

    // A lower-case code is the same country, and an absent one is nobody.
    expect(idsOf(entriesInCountry('ac', ['region'])).sort()).toEqual(idsOf(regions).sort());
    expect(entriesInCountry('ZZ', RECOMMENDABLE)).toEqual([]);
    expect(entriesInCountry('AC', [])).toEqual([]);

    // The bound holds in a country with a thousand entries: the top of it, not all of it.
    const crowded = entriesInCountry('AB', ['county'], 25);
    expect(crowded).toHaveLength(25);
    expect(crowded.every((entry) => (entry.prominence ?? 0) === 80)).toBe(true);
  });

  it('reads a country through an index that is already in pruning order', () => {
    load(syntheticIndex({ countries: 12, perCountryPerType: 4 }));

    const declared = INDEX_MIGRATIONS.join('\n').replace(/\s+/g, ' ');
    expect(declared).toMatch(
      /CREATE INDEX IF NOT EXISTS \S+ ON destination_index\(country_code, feature_type, rank DESC/i,
    );

    const plan = planFor(
      `SELECT payload_json FROM destination_index
        WHERE country_code = ? AND feature_type IN (?)
        ORDER BY rank DESC LIMIT ?`,
      ['AA', 'region', 3],
    ).join(' | ');
    expect(plan).toMatch(/SEARCH destination_index USING INDEX/);
    expect(plan).not.toMatch(/SCAN destination_index/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('finds entries by the start of a name, and nothing for an empty prefix', () => {
    load(syntheticIndex({ countries: 3, perCountryPerType: 2 }));
    const found = entriesByPrefix('ab');
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => entry.countryCode === 'AB')).toBe(true);
    expect(new Set(idsOf(found)).size).toBe(found.length);
    expect(entriesByPrefix('ab', 3)).toHaveLength(3);
    expect(entriesByPrefix('')).toEqual([]);
    expect(entriesByPrefix('zzzz')).toEqual([]);
  });
});
