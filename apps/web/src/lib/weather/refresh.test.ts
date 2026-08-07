import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { weatherAvailability, weatherCoverageOf, weatherPanelCopy } from '@sidequest/core';

/**
 * A REFRESH THAT FAILS LEAVES A TRACE, AND ONE THAT RETURNS NOTHING SAYS SO.
 *
 * Two defects, both of which put a sentence on screen that the data underneath it
 * contradicted.
 *
 * **The first attempt persisted nothing.** `recordRefreshOutcome` returned early
 * when there was no snapshot to update — which is exactly the state the "Fetch
 * the weather" button exists for. So a traveller on a trip that had never
 * fetched, hitting an outage, got a byte-identical page: no way to tell an outage
 * from a click that did not register, and nothing in the database saying anybody
 * had tried.
 *
 * **A fetch with every provider off recorded `succeeded`.** `resolveTripWeather`
 * does not throw when the provider is disabled; it returns a complete dataset in
 * which every day is `kind: 'unavailable'`. No exception, therefore `succeeded`,
 * therefore "Weather: fetched · Fetched recently enough to rely on" above a
 * dataset containing no weather at all.
 *
 * These tests run against a real temporary SQLite file rather than a mock,
 * because both defects were in the interaction between the write path and the
 * read path, and a mocked repository is precisely the thing that cannot show
 * that.
 */

let dir: string;

/**
 * The driver caches its handle on `globalThis` so Next's dev server does not leak
 * a file handle per reload. `vi.resetModules()` does not clear that, so each test
 * would otherwise reuse the previous test's database file — which is how three of
 * these first failed on a unique-constraint violation rather than on anything
 * they were about.
 */
function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-weather-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const LOCATIONS = [
  {
    id: 'point-a',
    label: 'Valley floor',
    coordinates: { lat: 37.6, lng: -118.9 },
    elevationMetres: 2400,
    timeZone: 'UTC',
    placeIds: ['place-a'],
    limitation: 'One point speaks for the whole valley.',
  },
];
const DATES = ['2026-08-12', '2026-08-13'];
const NOW = new Date('2026-08-03T00:00:00.000Z');

async function repository() {
  const { getDb } = await import('../db/client');
  const db = getDb();
  db.prepare(
    `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
                        arrival_time, departure_time, adults, children, status,
                        created_at, updated_at)
     VALUES ('trip-1','known','somewhere','region-1','2026-08-12','2026-08-13',
             '10:00','18:00',2,0,'draft',?,?)`,
  ).run(NOW.toISOString(), NOW.toISOString());
  return import('./snapshot-repository');
}

describe('recording a refresh outcome', () => {
  it('persists a failure on the very first attempt, when there is no row to update', async () => {
    const repo = await repository();

    repo.recordRefreshOutcome(
      'trip-1',
      'scope-1',
      {
        status: 'failed',
        requestedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        message: 'The weather source did not answer.',
      },
      {
        regionId: 'region-1',
        dates: DATES,
        locations: LOCATIONS,
        now: NOW,
        reason: 'provider_error',
        message: 'The weather source did not answer.',
      },
    );

    const stored = repo.getWeatherSnapshot('trip-1', 'scope-1');
    expect(stored).not.toBeNull();
    expect(stored!.refresh.status).toBe('failed');
    expect(stored!.refresh.message).toBe('The weather source did not answer.');
  });

  /**
   * The half the old early return was right about, kept as a property rather than
   * as a comment: recording an attempt must not become a claim about the weather.
   */
  it('claims no coverage while doing so', async () => {
    const repo = await repository();
    repo.recordRefreshOutcome(
      'trip-1',
      'scope-1',
      { status: 'failed', requestedAt: NOW.toISOString(), message: 'Outage.' },
      {
        regionId: 'region-1',
        dates: DATES,
        locations: LOCATIONS,
        now: NOW,
        reason: 'provider_error',
        message: 'Outage.',
      },
    );

    const stored = repo.getWeatherSnapshot('trip-1', 'scope-1')!;
    expect(weatherCoverageOf(stored.dataset)).toBe('none');
    for (const day of stored.dataset.days) expect(day.kind).toBe('unavailable');
    expect(JSON.stringify(stored.dataset)).not.toMatch(/"kind":"forecast"/);
  });

  it('still does nothing when the caller cannot say what was asked about', async () => {
    const repo = await repository();
    repo.recordRefreshOutcome('trip-1', 'scope-1', { status: 'failed' });
    expect(repo.getWeatherSnapshot('trip-1', 'scope-1')).toBeNull();
  });

  it('updates an existing row rather than replacing its dataset', async () => {
    const repo = await repository();
    repo.recordRefreshOutcome(
      'trip-1',
      'scope-1',
      { status: 'failed', message: 'First outage.' },
      {
        regionId: 'region-1',
        dates: DATES,
        locations: LOCATIONS,
        now: NOW,
        reason: 'provider_error',
        message: 'First outage.',
      },
    );
    const first = repo.getWeatherSnapshot('trip-1', 'scope-1')!;

    repo.recordRefreshOutcome('trip-1', 'scope-1', { status: 'failed', message: 'Second outage.' });
    const second = repo.getWeatherSnapshot('trip-1', 'scope-1')!;

    expect(second.refresh.message).toBe('Second outage.');
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.dataset).toEqual(first.dataset);
  });
});

describe('what a stored snapshot is allowed to say it holds', () => {
  const datasetWith = (kinds: ('forecast' | 'unavailable')[]) => ({
    version: 1 as const,
    regionId: 'region-1',
    locations: LOCATIONS,
    days: kinds.map((kind, index) =>
      kind === 'unavailable'
        ? {
            kind: 'unavailable' as const,
            locationId: 'point-a',
            date: DATES[index % DATES.length]!,
            reason: 'not_configured' as const,
            message: 'Nothing fetched.',
            attemptedProvider: 'off',
            attemptedAt: NOW.toISOString(),
            consideredCache: false,
          }
        : {
            kind: 'forecast' as const,
            locationId: 'point-a',
            date: DATES[index % DATES.length]!,
            highC: 20,
            lowC: 8,
            precipitationMm: 0,
            precipitationChance: 0.1,
            windKph: 5,
            summary: 'Clear',
            attribution: { provider: 'test', url: 'https://example.invalid', notice: 'Test data' },
            observedAt: NOW.toISOString(),
          },
    ),
    solar: [],
    generatedAt: NOW.toISOString(),
    providerName: 'test',
  });

  it('reads a dataset of nothing as no coverage', () => {
    expect(weatherCoverageOf(datasetWith(['unavailable', 'unavailable']) as never)).toBe('none');
  });

  it('separates partial coverage from complete', () => {
    expect(weatherCoverageOf(datasetWith(['forecast', 'unavailable']) as never)).toBe('partial');
    expect(weatherCoverageOf(datasetWith(['forecast', 'forecast']) as never)).toBe('complete');
  });
});

describe('the sentence the panel puts on screen', () => {
  const snapshotWith = (
    coverage: 'none' | 'complete',
    refreshStatus: 'succeeded' | 'failed' | 'returned_nothing',
  ) =>
    ({
      schemaVersion: 1,
      tripId: 'trip-1',
      regionId: 'region-1',
      scopeKey: 'scope-1',
      provider: 'test',
      model: null,
      fetchedAt: NOW.toISOString(),
      staleAfter: new Date(NOW.getTime() + 3_600_000).toISOString(),
      validUntil: new Date(NOW.getTime() + 7_200_000).toISOString(),
      horizon: 'forecast',
      dates: DATES,
      locations: LOCATIONS,
      attribution: [],
      operationVersion: 1,
      refresh: { status: refreshStatus },
      dataset: {
        version: 1,
        regionId: 'region-1',
        locations: LOCATIONS,
        days:
          coverage === 'none'
            ? DATES.map((date) => ({
                kind: 'unavailable',
                locationId: 'point-a',
                date,
                reason: 'not_configured',
                message: 'Nothing fetched.',
                attemptedProvider: 'off',
                attemptedAt: NOW.toISOString(),
                consideredCache: false,
              }))
            : DATES.map((date) => ({
                kind: 'forecast',
                locationId: 'point-a',
                date,
                highC: 20,
                lowC: 8,
                precipitationMm: 0,
                precipitationChance: 0.1,
                windKph: 5,
                summary: 'Clear',
                attribution: {
                  provider: 'test',
                  url: 'https://example.invalid',
                  notice: 'Test data',
                },
                observedAt: NOW.toISOString(),
              })),
        solar: [],
        generatedAt: NOW.toISOString(),
        providerName: 'test',
      },
    }) as never;

  /** The exact defect: a fresh row full of absences headlined "fetched". */
  it('never says "fetched" over a dataset that holds nothing', () => {
    const copy = weatherPanelCopy(
      weatherAvailability(snapshotWith('none', 'returned_nothing'), NOW),
    );
    expect(copy.heading).not.toMatch(/fetched$/i);
    expect(copy.heading).toBe('Weather: nothing came back');
    expect(copy.body).not.toMatch(/rely on/);
    expect(copy.showNumbers).toBe(false);
  });

  it('reports a failed attempt above whatever is still stored', () => {
    const copy = weatherPanelCopy(weatherAvailability(snapshotWith('none', 'failed'), NOW));
    expect(copy.heading).toBe('Weather: the last fetch failed');
    expect(copy.showNumbers).toBe(false);
  });

  it('says "fetched" only when something actually was', () => {
    const copy = weatherPanelCopy(weatherAvailability(snapshotWith('complete', 'succeeded'), NOW));
    expect(copy.heading).toBe('Weather: fetched');
    expect(copy.showNumbers).toBe(true);
  });

  it('states an absence when there is no row at all', () => {
    const copy = weatherPanelCopy(weatherAvailability(null, NOW));
    expect(copy.heading).toBe('Weather: not fetched');
    expect(copy.showNumbers).toBe(false);
  });
});
