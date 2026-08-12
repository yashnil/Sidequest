import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIMATE_DATASET_VERSION, type ClimateProfile } from '@sidequest/core';
import { getDb } from '../db/client';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';
import { climateFor } from '../destinations/preflight';
import {
  CLIMATE_DERIVATION_VERSION,
  DERIVATION_PROBE_POINTS,
  climateCacheKey,
  derivationProbe,
  fingerprintOf,
  readCachedClimate,
  writeCachedClimate,
} from './cache';
import { daylightHoursByMonth } from './openmeteo';

/**
 * DOES THE DAYLIGHT REPAIR ACTUALLY REACH A TRAVELLER?
 *
 * `climate.test.ts` beside this one already proved the arithmetic: Tokyo's June
 * is 14.5 hours and its December is 9.7. It passed, and it protected nobody,
 * because nothing in the product asked the arithmetic — it asked the cache, and
 * the cache was full of the old answers under a key that could not tell the
 * difference.
 *
 * So these are wiring tests. They go through `climateFor`, which is the function
 * the preflight and the destination recommender actually call, against a real
 * database, and the seeded row is the one the running product was holding on 12
 * August 2026:
 *
 *     climate|35.68|139.76 → 7.8 8.4 8.8 9.2 9.7 10 10 9.5 8.8 8.1 7.6 7.5
 *
 * Tokyo, written on 8 August, live until 7 September. A traveller asking about
 * May would have been told "Only about 9.7 hours of daylight, which shortens
 * every day" in the tradeoff colour, and the ranking behind the panel scored the
 * month on the same number.
 *
 * Every test here fails if the cache key stops carrying the derivation, and
 * that is the point: a unit test of the maths cannot notice a cache.
 */

/** Tokyo, at the precision the destination index publishes. */
const TOKYO = { lat: 35.6768601, lng: 139.7638947 };

/** The exact key the pre-fix code wrote, reproduced character for character. */
const LEGACY_TOKYO_KEY = 'climate|35.68|139.76';

/** Observed, not invented: the daylight column of the row named above. */
const OBSERVED_BROKEN_DAYLIGHT = [7.8, 8.4, 8.8, 9.2, 9.7, 10, 10, 9.5, 8.8, 8.1, 7.6, 7.5];

const NOW = new Date('2026-08-12T09:00:00.000Z');

function profileWithDaylight(daylight: readonly number[]): ClimateProfile {
  return {
    schemaVersion: CLIMATE_DATASET_VERSION,
    coordinates: TOKYO,
    sampleYearFrom: 2006,
    sampleYearTo: 2025,
    months: daylight.map((hours, index) => ({
      month: index + 1,
      temperature: { low: 0.4 + index, high: 8.7 + index },
      precipitationMm: 54.2,
      wetDays: 6,
      snowDays: index < 2 ? 2 : 0,
      daylightHours: hours,
      hotDays: 0,
      freezeDays: index < 2 ? 13.7 : 0,
    })),
    provider: 'Open-Meteo',
    dataset: 'ERA5 reanalysis via the Open-Meteo Historical Weather API',
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
    attributionUrl: 'https://open-meteo.com/',
    retrievedAt: '2026-08-08T06:21:38.550Z',
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-climate-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'climate.db');
  /*
   * The archive is switched off for the whole file.
   *
   * Not for speed — so that a cache *miss* is observable. With the provider on,
   * a miss would go and fetch the right answer and every assertion below would
   * pass whether or not the poisoned row had been refused.
   */
  process.env.SIDEQUEST_CLIMATE_PROVIDER = 'off';
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
  delete process.env.SIDEQUEST_CLIMATE_PROVIDER;
  rmSync(directory, { recursive: true, force: true });
});

describe('the climate cache refuses what an older derivation wrote', () => {
  it('will not serve the row the running product was holding for Tokyo', async () => {
    writeProviderCache(
      LEGACY_TOKYO_KEY,
      'open-meteo-climate',
      profileWithDaylight(OBSERVED_BROKEN_DAYLIGHT),
      30 * 24 * 60 * 60 * 1000,
      NOW,
    );

    const served = await climateFor(TOKYO, NOW);

    expect(served).toBeNull();
    // Specifically: the ten-hour June cannot come back out of the product.
    expect(served?.months[5]?.daylightHours).not.toBe(10);
  });

  it('leaves the refused row alone rather than migrating it', async () => {
    const broken = profileWithDaylight(OBSERVED_BROKEN_DAYLIGHT);
    writeProviderCache(LEGACY_TOKYO_KEY, 'open-meteo-climate', broken, 30 * 24 * 60 * 60 * 1000, NOW);

    await climateFor(TOKYO, NOW);

    /*
     * There is deliberately no upgrade path. The daily records the row was
     * folded from are not in the row, so a profile computed under rules we no
     * longer hold cannot be repaired into one computed under the rules we do —
     * the only honest move is to stop reading it and ask the archive again.
     */
    const still = readProviderCache<ClimateProfile>(LEGACY_TOKYO_KEY, NOW);
    expect(still?.months[5]?.daylightHours).toBe(10);
  });

  it('refuses a row of the current derivation whose shape has drifted', async () => {
    writeProviderCache(
      climateCacheKey(TOKYO),
      'open-meteo-climate',
      { schemaVersion: CLIMATE_DATASET_VERSION, coordinates: TOKYO, months: [{ month: 1 }] },
      30 * 24 * 60 * 60 * 1000,
      NOW,
    );

    /*
     * `readProviderCache` hands back `JSON.parse(...) as T`, which is a promise
     * that the row still matches the type — and a cache row is the one place in
     * the system where that promise was written by an older version of this
     * program. Unvalidated, this reaches a component as `undefined.toFixed(1)`.
     */
    expect(readCachedClimate(TOKYO, NOW)).toBeNull();
    expect(await climateFor(TOKYO, NOW)).toBeNull();
  });
});

describe('the climate cache still works for what this build wrote', () => {
  it('reads back a profile it wrote itself, with the corrected daylight', async () => {
    const corrected = profileWithDaylight(daylightHoursByMonth(TOKYO.lat, TOKYO.lng, 2025));
    writeCachedClimate(TOKYO, corrected, NOW);

    const served = await climateFor(TOKYO, NOW);

    /*
     * A key that were computed differently on the write and the read paths would
     * not be *wrong*, it would be a cache that never hit — every preflight and
     * every shortlist candidate paying for a fresh archive request forever, with
     * nothing on screen to say so.
     */
    expect(served).not.toBeNull();
    expect(Math.abs(served!.months[5]!.daylightHours - 14.5)).toBeLessThan(0.2);
    expect(Math.abs(served!.months[11]!.daylightHours - 9.7)).toBeLessThan(0.2);
  });
});

describe('the key moves when the derivation moves', () => {
  it('carries the derivation fingerprint', () => {
    expect(climateCacheKey(TOKYO)).toContain(CLIMATE_DERIVATION_VERSION);
    expect(climateCacheKey(TOKYO)).not.toBe(LEGACY_TOKYO_KEY);
  });

  it('produces a different key for a different derivation', () => {
    const other = fingerprintOf([{ label: 'daylight:tokyo', values: OBSERVED_BROKEN_DAYLIGHT }]);
    expect(climateCacheKey(TOKYO, other)).not.toBe(climateCacheKey(TOKYO));
  });

  it('watches the daylight column, at the point where the defect showed', () => {
    const probe = derivationProbe();
    const tokyo = probe.find((segment) => segment.label === 'daylight:tokyo');

    /*
     * THE LOAD-BEARING ASSERTION IN THIS FILE.
     *
     * A wrong fingerprint is harmless — it costs a refetch. A fingerprint that
     * stopped watching the day-length maths is the original defect returning
     * with a version number bolted on top of it, and it would look exactly like
     * a passing suite. So the probe is checked for the actual numbers the live
     * derivation produces, not merely for being non-empty.
     */
    expect(tokyo).toBeDefined();
    const point = DERIVATION_PROBE_POINTS[0]!;
    const live = daylightHoursByMonth(point.lat, point.lng, 2025);
    expect(tokyo!.values[5]).toBeCloseTo(live[5]!, 1);
    expect(tokyo!.values[5]).toBeGreaterThan(13);

    // Swap in what the running product had stored, and the fingerprint must move.
    const preFix = probe.map((segment) =>
      segment.label === 'daylight:tokyo'
        ? { label: segment.label, values: OBSERVED_BROKEN_DAYLIGHT }
        : segment,
    );
    expect(fingerprintOf(preFix)).not.toBe(CLIMATE_DERIVATION_VERSION);
  });

  it('watches the aggregation thresholds too, by straddling every one of them', () => {
    const aggregate = derivationProbe().find((segment) => segment.label === 'aggregate');
    expect(aggregate).toBeDefined();

    // Seven values a month: low, high, precipitationMm, wet, snow, hot, freeze.
    const rows: number[][] = [];
    for (let index = 0; index < aggregate!.values.length; index += 7) {
      rows.push(aggregate!.values.slice(index, index + 7));
    }
    expect(rows).toHaveLength(12);

    /*
     * A probe that never crosses a threshold is a guard that has stopped
     * guarding it: change `HOT_DAY_C` from 32 to 35 and the fingerprint would sit
     * still while every cached `hotDays` count went on meaning the old number.
     * Each of these asserts the synthetic series actually exercises one.
     */
    expect(rows.some((row) => row[3]! > 0)).toBe(true); // wet days, past WET_DAY_MM
    expect(rows.some((row) => row[4]! > 0)).toBe(true); // snow days, past SNOW_DAY_CM
    expect(rows.some((row) => row[5]! > 0)).toBe(true); // hot days, past HOT_DAY_C
    expect(rows.some((row) => row[6]! > 0)).toBe(true); // freezing nights, below 0
  });

  it('is stable across calls, so a restart does not orphan the cache', () => {
    expect(fingerprintOf(derivationProbe())).toBe(CLIMATE_DERIVATION_VERSION);
    expect(fingerprintOf(derivationProbe())).toBe(fingerprintOf(derivationProbe()));
  });
});
