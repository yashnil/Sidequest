import 'server-only';
import {
  buildFixtureWeather,
  buildSolarDays,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  isInsideForecastHorizon,
  utcOffsetMinutesOn,
  weatherDatasetSchema,
  type WeatherDataset,
  type WeatherLocation,
  type WeatherProvider,
} from '@sidequest/core';
import { getDb } from '../db/client';
import { openMeteoWeatherProvider } from './openmeteo';

/**
 * WHICH WEATHER SOURCE RUNS, AND WHAT IS REMEMBERED OF IT.
 *
 * Two jobs, kept in one file because they are one decision. The provider is
 * chosen from the environment; the cache exists so that choosing a live one does
 * not mean a forecast request per render.
 *
 * `SIDEQUEST_WEATHER_PROVIDER`:
 *   - `openmeteo` (default) — the live adapter.
 *   - `fixture`             — the deterministic offline generator. This is what
 *                             the end-to-end suite runs on, so a browser test
 *                             asserts against weather it chose rather than
 *                             against whatever the sky was doing that morning.
 *   - `off`                 — no weather at all. Every day comes back
 *                             `unavailable`, which is the honest way to see what
 *                             the product looks like when the source is down.
 */
export type WeatherProviderChoice = 'openmeteo' | 'fixture' | 'off';

export function weatherProviderChoice(): WeatherProviderChoice {
  const configured = process.env.SIDEQUEST_WEATHER_PROVIDER?.trim().toLowerCase();
  if (configured === 'fixture' || configured === 'off' || configured === 'openmeteo') {
    return configured;
  }
  return 'openmeteo';
}

export function weatherProviderFor(choice: WeatherProviderChoice): WeatherProvider {
  if (choice === 'openmeteo') return openMeteoWeatherProvider();
  if (choice === 'fixture') {
    return {
      name: 'Sidequest offline fixture',
      async getWeather({ regionId, locations, dates, now }) {
        return buildFixtureWeather({ regionId, locations, dates, now });
      },
    };
  }
  return {
    name: 'disabled',
    async getWeather({ regionId, locations, dates, now }) {
      const generatedAt = now.toISOString();
      // Solar is still computed. The sun is not a prediction and it does not
      // come from the provider, so switching the provider off must not take the
      // daylight with it — a daylight-only site still has to be scheduled
      // inside the light whether or not anyone knows what the sky is doing.
      return weatherDatasetSchema.parse({
        version: 1,
        regionId,
        locations,
        days: locations.flatMap((location) =>
          dates.map((date) => ({
            kind: 'unavailable' as const,
            locationId: location.id,
            date,
            reason: 'not_configured' as const,
            message: 'Weather lookup is switched off in this environment.',
            attemptedProvider: 'disabled',
            attemptedAt: generatedAt,
            consideredCache: false,
          })),
        ),
        solar: buildSolarDays({
          locations,
          dates,
          utcOffsetMinutesFor: (location, date) => utcOffsetMinutesOn(date, location.timeZone),
          computedAt: generatedAt,
        }),
        generatedAt,
        providerName: 'disabled',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * How long a cached dataset may be served.
 *
 * Two clocks, because the two kinds of evidence age at wildly different rates.
 * A forecast is one model run old within hours; ten years of ERA5 for the second
 * week of August will say the same thing next month as it does today. Using one
 * number for both would either hammer the archive endpoint or serve yesterday's
 * forecast as if it were this morning's.
 *
 * Note this is the *cache* clock, not the *staleness* clock. A forecast served
 * from cache inside this window is still marked stale by `isForecastStale` once
 * it passes its own `staleAfterMinutes`, and the UI says so. The difference
 * matters: this decides whether to spend a request, that decides what to tell
 * the traveller.
 */
export const FORECAST_CACHE_MINUTES = 60;
export const HISTORY_CACHE_MINUTES = 60 * 24 * 30;

/**
 * The cache key.
 *
 * Everything that would change the answer is in it: which provider, which
 * schema generation, which points, which dates, and — through `bucket` — which
 * hour the forecast was asked for, so a key can never outlive its own freshness
 * rule. Leaving the schema version out is how a cache poisons a deploy: the
 * shape changes, the old JSON still parses far enough to be dangerous, and every
 * user gets last week's structure until somebody notices.
 */
export function weatherCacheKey(input: {
  provider: string;
  regionId: string;
  locations: readonly WeatherLocation[];
  dates: readonly string[];
  now: Date;
}): string {
  const points = input.locations
    .map((location) => `${location.id}@${location.coordinates.lat},${location.coordinates.lng}`)
    .sort()
    .join(';');
  const span = `${input.dates[0] ?? '-'}..${input.dates[input.dates.length - 1] ?? '-'}`;
  /**
   * The bucket is what actually expires the entry, so it has to follow the kind
   * of evidence the dates will produce.
   *
   * A trip inside the forecast horizon gets an hourly bucket, because a forecast
   * an hour old is worth replacing. A trip wholly beyond it gets a monthly one,
   * because ten years of ERA5 for the second week of September will not have
   * changed by tomorrow — and an hourly bucket meant ten archive requests every
   * hour for the same unchanged answer.
   */
  const zone = input.locations[0]?.timeZone ?? 'UTC';
  const insideHorizon = input.dates.every((date) =>
    isInsideForecastHorizon(date, input.now, zone),
  );
  const window = insideHorizon ? FORECAST_CACHE_MINUTES : HISTORY_CACHE_MINUTES;
  const bucket = Math.floor(input.now.getTime() / (window * 60_000));
  return [
    'v1',
    WEATHER_SCHEMA_GENERATION,
    input.provider,
    input.regionId,
    span,
    input.dates.length,
    points,
    bucket,
  ].join('|');
}

/**
 * Bumped whenever the stored shape changes. Distinct from the dataset version
 * in core: that one travels with a plan, this one only invalidates a cache.
 */
const WEATHER_SCHEMA_GENERATION = 1;

interface CacheRow {
  payload_json: string;
  stored_at: string;
}

function readCache(key: string): WeatherDataset | null {
  try {
    const row = getDb()
      .prepare('SELECT payload_json, stored_at FROM weather_cache WHERE cache_key = ?')
      .get(key) as CacheRow | undefined;
    if (!row) return null;
    // Parsed rather than cast, so a corrupt or outdated row fails into a refetch
    // instead of into the planner.
    return weatherDatasetSchema.parse(JSON.parse(row.payload_json));
  } catch {
    // A cache is an optimisation. It is never allowed to be the reason a page
    // does not render, so a bad row is dropped and the request goes out again.
    try {
      getDb().prepare('DELETE FROM weather_cache WHERE cache_key = ?').run(key);
    } catch {
      // Nothing useful to do; the read path already degrades correctly.
    }
    return null;
  }
}

function writeCache(key: string, dataset: WeatherDataset): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO weather_cache (cache_key, payload_json, stored_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, stored_at = excluded.stored_at`,
    ).run(key, JSON.stringify(dataset), new Date().toISOString());
    // Bounded, so a long-lived database does not accumulate a forecast per hour
    // per trip for ever. Two hundred rows is far more than any single session
    // needs and small enough to stay invisible.
    db.prepare(
      `DELETE FROM weather_cache WHERE cache_key NOT IN (
         SELECT cache_key FROM weather_cache ORDER BY stored_at DESC LIMIT 200
       )`,
    ).run();
  } catch (error) {
    console.error('Could not cache weather', error);
  }
}

export interface ResolveWeatherOptions {
  regionId: string;
  dates: readonly string[];
  now?: Date;
  locations?: readonly WeatherLocation[];
}

/**
 * The weather for a trip, from cache where possible and the provider otherwise.
 *
 * The fallback order, and it is deliberate:
 *
 *   1. a cached dataset inside its cache window;
 *   2. failing that, a fresh fetch;
 *   3. failing *that*, any cached dataset at all — served with its own
 *      freshness metadata intact, so the UI marks it stale rather than passing
 *      off last night's forecast as this morning's;
 *   4. failing everything, a dataset of `unavailable` days.
 *
 * What it never does is invent a fair day. There is no step in which missing
 * weather becomes good weather, which is the single most important property of
 * this function.
 */
export async function resolveTripWeather(
  options: ResolveWeatherOptions,
): Promise<WeatherDataset> {
  const now = options.now ?? new Date();
  const locations = options.locations ?? EASTERN_SIERRA_WEATHER_LOCATIONS;
  const zone = locations[0]?.timeZone ?? 'UTC';

  /**
   * A trip that straddles the horizon is resolved — and cached — in two halves.
   *
   * The two kinds of evidence age at wildly different rates, and one cache entry
   * has to pick one clock. Picking the hourly one refetches ten years of ERA5
   * every hour for an answer that will not change this month; picking the
   * monthly one serves a four-week-old forecast as if it were this morning's.
   * Both are wrong, so neither is chosen: the forecast dates and the historical
   * dates get their own key, their own bucket, and their own request, and the
   * results are merged.
   */
  const forecastDates = options.dates.filter((date) =>
    isInsideForecastHorizon(date, now, zone),
  );
  const patternDates = options.dates.filter((date) => !forecastDates.includes(date));
  if (forecastDates.length > 0 && patternDates.length > 0) {
    const [forecast, patterns] = await Promise.all([
      resolveTripWeather({ ...options, now, locations, dates: forecastDates }),
      resolveTripWeather({ ...options, now, locations, dates: patternDates }),
    ]);
    return mergeDatasets(forecast, patterns);
  }

  const choice = weatherProviderChoice();
  const provider = weatherProviderFor(choice);
  const key = weatherCacheKey({
    provider: provider.name,
    regionId: options.regionId,
    locations,
    dates: options.dates,
    now,
  });

  const cached = readCache(key);
  if (cached) return cached;

  try {
    const dataset = await provider.getWeather({
      regionId: options.regionId,
      locations,
      dates: options.dates,
      now,
    });
    writeCache(key, dataset);
    return dataset;
  } catch (error) {
    console.error('Weather provider failed', error);
    const stale = readAnyCached(key);
    if (stale) return stale;
    return weatherProviderFor('off').getWeather({
      regionId: options.regionId,
      locations,
      dates: options.dates,
      now,
    });
  }
}

/**
 * The newest cached dataset for *these* dates, whatever its age. Step 3 above.
 *
 * Matched on everything in the key except the trailing freshness bucket, which
 * is the only part that is allowed to be stale. Matching on the region alone —
 * the first version — meant a September trip could be served an August trip's
 * forecast, or a live deployment could be served rows a `fixture` run had left
 * behind, and neither would be visible anywhere on the page.
 */
function readAnyCached(key: string): WeatherDataset | null {
  const prefix = key.slice(0, key.lastIndexOf('|') + 1);
  try {
    const row = getDb()
      .prepare(
        `SELECT payload_json, stored_at FROM weather_cache
         WHERE cache_key LIKE ? ESCAPE '\\' ORDER BY stored_at DESC LIMIT 1`,
      )
      .get(`${escapeLike(prefix)}%`) as CacheRow | undefined;
    if (!row) return null;
    return weatherDatasetSchema.parse(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
}

/**
 * Two halves of one trip, back into one dataset.
 *
 * Locations are identical by construction — both halves were resolved for the
 * same list — so only the per-date rows and the solar records need joining. The
 * earlier `generatedAt` wins, because a caller asking "when was this assembled"
 * deserves the age of the oldest thing in it rather than the newest.
 */
function mergeDatasets(forecast: WeatherDataset, patterns: WeatherDataset): WeatherDataset {
  const solarSeen = new Set<string>();
  const solar = [...forecast.solar, ...patterns.solar].filter((entry) => {
    const key = `${entry.locationId}|${entry.date}`;
    if (solarSeen.has(key)) return false;
    solarSeen.add(key);
    return true;
  });

  return weatherDatasetSchema.parse({
    ...forecast,
    days: [...forecast.days, ...patterns.days],
    solar,
    generatedAt:
      forecast.generatedAt <= patterns.generatedAt
        ? forecast.generatedAt
        : patterns.generatedAt,
  });
}

/** Coordinates contain no wildcards today; escaping keeps that from mattering. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
