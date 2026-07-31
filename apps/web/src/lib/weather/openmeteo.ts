import 'server-only';
import {
  buildSolarDays,
  FORECAST_STALE_AFTER_MINUTES,
  localDateIn,
  utcOffsetMinutesOn,
  WEATHER_DATASET_VERSION,
  weatherDatasetSchema,
  type DayWeather,
  type ForecastDayWeather,
  type HistoricalPatternDayWeather,
  type HourlyWeather,
  type WeatherAttribution,
  type WeatherCondition,
  type WeatherLocation,
  type WeatherProvider,
  type WeatherUnavailableReason,
} from '@sidequest/core';
import { z } from 'zod';

/**
 * THE LIVE WEATHER ADAPTER.
 *
 * The only file in Sidequest that talks to the outside world over HTTP, and the
 * only one that may. `packages/planner` is a pure function by contract and
 * `packages/core` holds no I/O, so everything network-shaped is quarantined
 * here behind `server-only` — the same fence `lib/db` sits behind.
 *
 * PROVIDER: Open-Meteo, checked against its own documentation and its live
 * endpoints on 30 July 2026.
 *
 * - Forecast: `https://api.open-meteo.com/v1/forecast`. `forecast_days=16`
 *   returned 2026-07-30 through 2026-08-14 — today plus fifteen. That is the
 *   horizon, verified rather than assumed.
 * - History: `https://archive-api.open-meteo.com/v1/archive`, ERA5 reanalysis
 *   back to 1940. It refuses future dates outright (its stated range ended at
 *   tomorrow), which makes leakage from the future structurally impossible
 *   rather than merely guarded against.
 * - Licence: CC-BY 4.0. The attribution travels with every value in
 *   `WeatherAttribution` and is rendered wherever the numbers are.
 * - Free tier: non-commercial, under 10,000 calls a day, 5,000 an hour, 600 a
 *   minute. No key, and none is invented here. A commercial deployment moves to
 *   the `customer-` host with a key, which is a change to `BASE` and a header —
 *   deliberately the only two things that would need to move.
 *
 * TWO SHAPES OF RESPONSE, AND THE TRAP IN THEM
 *
 * A single coordinate returns a JSON object; comma-separated coordinates return
 * a JSON *array*, one entry per location, in request order. Handling only the
 * first would silently give every zone the first zone's weather, which is the
 * exact failure this whole slice exists to prevent — so both are normalised at
 * the boundary and the array length is checked against what was asked for.
 *
 * THE OTHER TRAP: `precipitation_probability` on the archive endpoint returns an
 * array of `null` with a unit of `"undefined"` rather than an error. ERA5 has no
 * such variable. A naive adapter would read those nulls as zero and report that
 * it has never rained in August. It is not requested from the archive at all,
 * and the historical record has no probability field to put it in.
 */

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';

export const OPEN_METEO_ATTRIBUTION: WeatherAttribution = {
  provider: 'Open-Meteo',
  notice: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  url: 'https://open-meteo.com/',
};

const FORECAST_ATTRIBUTION: WeatherAttribution = {
  ...OPEN_METEO_ATTRIBUTION,
  dataset: 'Open-Meteo best-match forecast',
};

const ARCHIVE_ATTRIBUTION: WeatherAttribution = {
  ...OPEN_METEO_ATTRIBUTION,
  dataset: 'ERA5 reanalysis via the Open-Meteo Historical Weather API',
};

/** Hard deadline on any single request. A slow forecast must not hang a build. */
export const REQUEST_TIMEOUT_MS = 8_000;

/**
 * How many past years a historical pattern is computed from.
 *
 * Ten. Enough that a single freak August does not dominate — with the ±5 day
 * band that is 110 observation-days per point — and recent enough that the
 * answer describes the climate somebody is travelling into rather than the one
 * their parents did. Written down here because the number is a judgement and
 * the record carries it so the traveller can see it.
 */
export const HISTORY_YEARS = 10;

/** Days either side of the trip date that count as "this time of year". */
export const HISTORY_BAND_DAYS = 5;

/** Below this many observation-days, no pattern is emitted. */
export const MIN_HISTORY_SAMPLE = 40;

/** mm in a day at or above which the day counts as wet. */
export const WET_DAY_THRESHOLD_MM = 1;

/** Archive requests in flight at once. See `fetchHistoricalPatterns`. */
export const ARCHIVE_CONCURRENCY = 3;

// --- Provider response schemas ---------------------------------------------
// Validated before anything reaches the planner. A partial or reshaped response
// fails here rather than becoming a plausible-looking plan.

const numberArray = z.array(z.number().nullable());

const forecastResponseSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  elevation: z.number().nullable().optional(),
  timezone: z.string(),
  utc_offset_seconds: z.number(),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: numberArray,
    temperature_2m_max: numberArray,
    temperature_2m_min: numberArray,
    apparent_temperature_max: numberArray.optional(),
    apparent_temperature_min: numberArray.optional(),
    precipitation_sum: numberArray,
    precipitation_probability_max: numberArray.optional(),
    snowfall_sum: numberArray,
    wind_speed_10m_max: numberArray,
    wind_gusts_10m_max: numberArray,
    cloud_cover_mean: numberArray.optional(),
  }),
  hourly: z
    .object({
      time: z.array(z.string()),
      temperature_2m: numberArray,
      precipitation: numberArray,
      precipitation_probability: numberArray.optional(),
      snowfall: numberArray,
      weather_code: numberArray,
      wind_speed_10m: numberArray,
      wind_gusts_10m: numberArray,
      cloud_cover: numberArray.optional(),
      visibility: numberArray.optional(),
    })
    .optional(),
});

const archiveResponseSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: numberArray,
    temperature_2m_min: numberArray,
    precipitation_sum: numberArray,
    snowfall_sum: numberArray,
    wind_gusts_10m_max: numberArray,
  }),
});

const errorResponseSchema = z.object({ error: z.literal(true), reason: z.string() });

export class WeatherProviderError extends Error {
  readonly reason: WeatherUnavailableReason;

  constructor(reason: WeatherUnavailableReason, message: string) {
    super(message);
    this.name = 'WeatherProviderError';
    this.reason = reason;
  }
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Sidequest/0.1 (travel planner; contact via repository)' },
      // Sidequest caches deliberately, in SQLite, with rules that differ by
      // evidence kind. Letting the fetch layer cache as well would make
      // freshness two people's job and therefore nobody's.
      cache: 'no-store',
    });
    const body: unknown = await response.json();
    const asError = errorResponseSchema.safeParse(body);
    if (asError.success) {
      throw new WeatherProviderError(
        response.status === 400 ? 'outside_supported_range' : 'provider_error',
        asError.data.reason,
      );
    }
    if (!response.ok) {
      throw new WeatherProviderError('provider_error', `Weather provider returned ${response.status}.`);
    }
    return body;
  } catch (error) {
    if (error instanceof WeatherProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new WeatherProviderError('provider_timeout', 'The weather service did not answer in time.');
    }
    throw new WeatherProviderError(
      'provider_error',
      error instanceof Error ? error.message : 'The weather service could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** One entry per requested location, in request order. */
function asPerLocation(body: unknown, expected: number): unknown[] {
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== expected) {
    throw new WeatherProviderError(
      'invalid_response',
      `Asked for ${expected} locations and got ${list.length} back.`,
    );
  }
  return list;
}

/**
 * WMO code to the vocabulary the rest of Sidequest speaks.
 *
 * The provider distinguishes slight from moderate drizzle and rime fog from
 * ordinary fog. Neither changes a decision here, and carrying thirty codes past
 * this function would mean every consumer learning a meteorological vocabulary
 * to answer "can we walk up there".
 */
function conditionFor(code: number | null): WeatherCondition {
  if (code === null) return 'overcast';
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly_cloudy';
  if (code === 3) return 'overcast';
  if (code <= 48) return 'fog';
  if (code <= 57) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain';
  if (code <= 86) return 'snow';
  return 'thunderstorm';
}

function num(values: readonly (number | null)[] | undefined, index: number): number | null {
  const value = values?.[index];
  return value === undefined || value === null ? null : value;
}

function required(
  values: readonly (number | null)[] | undefined,
  index: number,
  field: string,
): number {
  const value = num(values, index);
  if (value === null) {
    throw new WeatherProviderError('invalid_response', `Missing ${field} in the weather response.`);
  }
  return value;
}

/**
 * Twenty-four hours, or none at all.
 *
 * The `?? 0` this used to end each line with was the single most dangerous thing
 * in the adapter. A short or trailing-null `precipitation` array would have read
 * as **0 mm** for the last hours of the day, and `preferByHourlyWeather` would
 * then have cheerfully ordered the exposed stop into a thunderstorm it scored as
 * costless — the exact "a missing record that reads as fair weather" failure the
 * schema header names. A missing temperature was the same bug pointing the other
 * way: 0 °C, and a cold penalty on an August afternoon.
 *
 * So a null in any field the planner actually reasons on discards the whole
 * day's hourly evidence. That is not a degradation: day-level assignment still
 * works, and "we have no hour-by-hour detail for Thursday" is a true statement
 * the rest of the system already knows how to handle.
 */
function buildHours(
  hourly: z.infer<typeof forecastResponseSchema>['hourly'],
  date: string,
  locationLabel: string,
): HourlyWeather[] {
  if (!hourly) return [];
  for (const [field, values] of Object.entries(hourly)) {
    if (field === 'time') continue;
    if (Array.isArray(values) && values.length !== hourly.time.length) {
      throw new WeatherProviderError(
        'invalid_response',
        `The hourly forecast for ${locationLabel} returned ${values.length} values of ${field} for ${hourly.time.length} hours.`,
      );
    }
  }

  const hours: HourlyWeather[] = [];
  for (const [index, stamp] of hourly.time.entries()) {
    if (!stamp.startsWith(`${date}T`)) continue;
    const [, clock] = stamp.split('T');
    const [hh, mm] = (clock ?? '00:00').split(':');

    const temperature = num(hourly.temperature_2m, index);
    const precipitation = num(hourly.precipitation, index);
    const snowfall = num(hourly.snowfall, index);
    const wind = num(hourly.wind_speed_10m, index);
    const gust = num(hourly.wind_gusts_10m, index);
    if (
      temperature === null ||
      precipitation === null ||
      snowfall === null ||
      wind === null ||
      gust === null
    ) {
      return [];
    }

    hours.push({
      startMinute: Number(hh) * 60 + Number(mm ?? 0),
      condition: conditionFor(num(hourly.weather_code, index)),
      temperatureC: temperature,
      // Genuinely optional: the provider models these only for some variables
      // and horizons, and `null` here is honest rather than missing. The
      // suitability rules treat null as "no information", never as zero.
      precipitationProbabilityPercent: num(hourly.precipitation_probability, index),
      precipitationMm: precipitation,
      snowfallCm: snowfall,
      windSpeedKph: wind,
      windGustKph: gust,
      cloudCoverPercent: num(hourly.cloud_cover, index),
      visibilityMetres: num(hourly.visibility, index),
    });
  }
  return hours.sort((a, b) => a.startMinute - b.startMinute);
}

async function fetchForecast(
  locations: readonly WeatherLocation[],
  dates: readonly string[],
  fetchedAt: string,
): Promise<ForecastDayWeather[]> {
  const params = new URLSearchParams({
    latitude: locations.map((location) => location.coordinates.lat).join(','),
    longitude: locations.map((location) => location.coordinates.lng).join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'apparent_temperature_max',
      'apparent_temperature_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'snowfall_sum',
      'wind_speed_10m_max',
      'wind_gusts_10m_max',
      'cloud_cover_mean',
    ].join(','),
    hourly: [
      'temperature_2m',
      'precipitation',
      'precipitation_probability',
      'snowfall',
      'weather_code',
      'wind_speed_10m',
      'wind_gusts_10m',
      'cloud_cover',
      'visibility',
    ].join(','),
    timezone: locations[0]?.timeZone ?? 'UTC',
    forecast_days: '16',
  });

  const body = await getJson(`${FORECAST_BASE}?${params.toString()}`);
  const entries = asPerLocation(body, locations.length);
  const wanted = new Set(dates);
  const days: ForecastDayWeather[] = [];

  for (const [index, entry] of entries.entries()) {
    const location = locations[index]!;
    const parsed = forecastResponseSchema.safeParse(entry);
    if (!parsed.success) {
      throw new WeatherProviderError(
        'invalid_response',
        `The forecast for ${location.label} did not validate: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    const daily = parsed.data.daily;
    // Every array the provider returns must be the same length as `time`, or a
    // value would silently be read against the wrong date.
    for (const [field, values] of Object.entries(daily)) {
      if (field === 'time') continue;
      if (Array.isArray(values) && values.length !== daily.time.length) {
        throw new WeatherProviderError(
          'invalid_response',
          `The forecast for ${location.label} returned ${values.length} values of ${field} for ${daily.time.length} days.`,
        );
      }
    }

    for (const [dayIndex, date] of daily.time.entries()) {
      if (!wanted.has(date)) continue;
      days.push({
        kind: 'forecast',
        locationId: location.id,
        date,
        condition: conditionFor(num(daily.weather_code, dayIndex)),
        temperatureMaxC: required(daily.temperature_2m_max, dayIndex, 'temperature_2m_max'),
        temperatureMinC: required(daily.temperature_2m_min, dayIndex, 'temperature_2m_min'),
        ...(num(daily.apparent_temperature_max, dayIndex) !== null
          ? { apparentTemperatureMaxC: num(daily.apparent_temperature_max, dayIndex)! }
          : {}),
        ...(num(daily.apparent_temperature_min, dayIndex) !== null
          ? { apparentTemperatureMinC: num(daily.apparent_temperature_min, dayIndex)! }
          : {}),
        precipitationProbabilityPercent: num(daily.precipitation_probability_max, dayIndex),
        precipitationMm: num(daily.precipitation_sum, dayIndex) ?? 0,
        snowfallCm: num(daily.snowfall_sum, dayIndex) ?? 0,
        windSpeedMaxKph: num(daily.wind_speed_10m_max, dayIndex) ?? 0,
        windGustMaxKph: num(daily.wind_gusts_10m_max, dayIndex) ?? 0,
        cloudCoverMeanPercent: num(daily.cloud_cover_mean, dayIndex),
        hours: buildHours(parsed.data.hourly, date, location.label),
        fetchedAt,
        staleAfterMinutes: FORECAST_STALE_AFTER_MINUTES,
        attribution: FORECAST_ATTRIBUTION,
      });
    }
  }
  return days;
}

/**
 * A historical pattern, computed rather than looked up.
 *
 * The method, in full, because "historical average" without one is not a claim
 * anybody can check:
 *
 *   1. Take the ten calendar years before the current one. Never the current
 *      year — a partial year would weight whichever months have happened.
 *   2. For each, take the ±5 calendar days around the trip date. That is 110
 *      observation-days per weather point.
 *   3. Report the 10th, 50th and 90th percentiles of daily maximum and minimum
 *      temperature, the share of days with at least 1 mm of precipitation, the
 *      share with any snow, and the 90th percentile of gusts.
 *   4. Below 40 observation-days, emit nothing and say so. A percentile over a
 *      handful of days is a number with no information in it.
 *
 * Every date inside one band gets identical values, by construction. That is
 * what makes the record safe to hand to a planner: it cannot rank Tuesday above
 * Wednesday because it holds nothing that distinguishes them.
 */
async function fetchHistoricalPatterns(
  locations: readonly WeatherLocation[],
  dates: readonly string[],
  now: Date,
  computedAt: string,
): Promise<HistoricalPatternDayWeather[]> {
  const currentYear = Number(localDateIn(now, locations[0]?.timeZone ?? 'UTC').slice(0, 4));
  const years = Array.from({ length: HISTORY_YEARS }, (_, index) => currentYear - 1 - index).sort();

  /**
   * Overlapping bands merged into contiguous spans, one request per year each.
   *
   * The first version keyed a band on its own `MM-DD` bounds, on the theory that
   * nearby trip dates would share one. They do not: 1 August spans 27 July–6
   * August and 2 August spans 28 July–7 August, so a fortnight's trip issued
   * fourteen distinct bands — a hundred and forty archive requests for one page.
   * Merging first means a fortnight is one span and ten requests, and each trip
   * date reads its own ±5 window out of the result.
   */
  const spans = mergeBands(dates, HISTORY_BAND_DAYS);

  const results: HistoricalPatternDayWeather[] = [];

  for (const band of spans) {
    const samples = new Map<
      string,
      { max: number[]; min: number[]; precip: number[]; snow: number[]; gust: number[] }
    >();
    for (const location of locations) {
      samples.set(location.id, { max: [], min: [], precip: [], snow: [], gust: [] });
    }

    /**
     * Ten years, three at a time.
     *
     * Sequential was the first version and it was measurably wrong: the first
     * render of a far-future trip blocked for twenty-three seconds. Fully
     * parallel would be ten sockets at once against a free, rate-limited public
     * endpoint for one page load, which is not a neighbourly thing to do at
     * scale. Three keeps the wait under ten seconds and stays two orders of
     * magnitude inside the published per-minute limit — and the answer is
     * cached for a month afterwards either way.
     *
     * Order is restored below by keying on the location rather than by arrival,
     * so the aggregate is identical however the requests interleave.
     */
    const fetchYear = async (year: number) => {
      /**
       * Offsets applied *after* the year is stamped, not before.
       *
       * Restamping pre-shifted bounds is wrong across New Year: a trip date of
       * 2 January has a band running 28 December to 7 January, and stamping one
       * year on both produced `start_date=2017-12-28&end_date=2017-01-07`, which
       * the provider rejects — so every New Year trip lost its history entirely.
       */
      const anchorStart = shiftDate(withYear(band.anchorStart, year), -HISTORY_BAND_DAYS);
      const anchorEnd = shiftDate(withYear(band.anchorEnd, year), HISTORY_BAND_DAYS);
      const params = new URLSearchParams({
        latitude: locations.map((location) => location.coordinates.lat).join(','),
        longitude: locations.map((location) => location.coordinates.lng).join(','),
        start_date: anchorStart,
        end_date: anchorEnd,
        daily: [
          'temperature_2m_max',
          'temperature_2m_min',
          'precipitation_sum',
          'snowfall_sum',
          'wind_gusts_10m_max',
        ].join(','),
        timezone: locations[0]?.timeZone ?? 'UTC',
      });
      const body = await getJson(`${ARCHIVE_BASE}?${params.toString()}`);
      const entries = asPerLocation(body, locations.length);
      for (const [index, entry] of entries.entries()) {
        const location = locations[index]!;
        const parsed = archiveResponseSchema.safeParse(entry);
        if (!parsed.success) {
          throw new WeatherProviderError(
            'invalid_response',
            `Historical data for ${location.label} did not validate.`,
          );
        }
        const bucket = samples.get(location.id)!;
        const daily = parsed.data.daily;
        for (let i = 0; i < daily.time.length; i += 1) {
          const max = num(daily.temperature_2m_max, i);
          const min = num(daily.temperature_2m_min, i);
          if (max === null || min === null) continue;
          bucket.max.push(max);
          bucket.min.push(min);
          bucket.precip.push(num(daily.precipitation_sum, i) ?? 0);
          bucket.snow.push(num(daily.snowfall_sum, i) ?? 0);
          bucket.gust.push(num(daily.wind_gusts_10m_max, i) ?? 0);
        }
      }
    };

    for (let index = 0; index < years.length; index += ARCHIVE_CONCURRENCY) {
      await Promise.all(years.slice(index, index + ARCHIVE_CONCURRENCY).map(fetchYear));
    }

    for (const location of locations) {
      const bucket = samples.get(location.id)!;
      if (bucket.max.length < MIN_HISTORY_SAMPLE) continue;
      for (const date of band.dates) {
        results.push({
          kind: 'historical_pattern',
          locationId: location.id,
          date,
          bandStart: shiftDate(date, -HISTORY_BAND_DAYS).slice(5),
          bandEnd: shiftDate(date, HISTORY_BAND_DAYS).slice(5),
          sampleYearFrom: years[0]!,
          sampleYearTo: years[years.length - 1]!,
          sampleCount: bucket.max.length,
          method: `ERA5 daily values for ±${HISTORY_BAND_DAYS} days around this date across ${years[0]}–${years[years.length - 1]}; percentiles by linear interpolation; a day counts as wet at ${WET_DAY_THRESHOLD_MM} mm or more.`,
          temperatureMaxC: {
            p10: percentile(bucket.max, 10),
            p50: percentile(bucket.max, 50),
            p90: percentile(bucket.max, 90),
          },
          temperatureMinC: {
            p10: percentile(bucket.min, 10),
            p50: percentile(bucket.min, 50),
            p90: percentile(bucket.min, 90),
          },
          wetDayFrequency:
            bucket.precip.filter((value) => value >= WET_DAY_THRESHOLD_MM).length /
            bucket.precip.length,
          snowDayFrequency: bucket.snow.filter((value) => value > 0).length / bucket.snow.length,
          windGustKphP90: percentile(bucket.gust, 90),
          computedAt,
          attribution: ARCHIVE_ATTRIBUTION,
        });
      }
    }
  }

  return results;
}

/**
 * Trip dates collapsed into the fewest contiguous spans that cover every band.
 *
 * `anchorStart` / `anchorEnd` are trip dates, not band edges: the caller
 * re-applies the ±band offset after stamping the sample year, which is what
 * makes the arithmetic correct across a year boundary.
 */
export function mergeBands(
  dates: readonly string[],
  bandDays: number,
): { anchorStart: string; anchorEnd: string; dates: string[] }[] {
  const sorted = [...new Set(dates)].sort();
  const spans: { anchorStart: string; anchorEnd: string; dates: string[] }[] = [];
  for (const date of sorted) {
    const current = spans[spans.length - 1];
    // Bands touch when the gap between trip dates is within twice the window.
    const gapDays = current
      ? Math.round(
          (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${current.anchorEnd}T00:00:00Z`)) /
            86_400_000,
        )
      : Infinity;
    if (current && gapDays <= bandDays * 2) {
      current.anchorEnd = date;
      current.dates.push(date);
    } else {
      spans.push({ anchorStart: date, anchorEnd: date, dates: [date] });
    }
  }
  return spans;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = ((sorted.length - 1) * p) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value =
    lower === upper
      ? sorted[lower]!
      : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  return Math.round(value * 10) / 10;
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function withYear(date: string, year: number): string {
  return `${year}-${date.slice(5)}`;
}

/**
 * The provider itself.
 *
 * Failure never propagates as an exception past this boundary: every date the
 * adapter could not answer for comes back as an `unavailable` record naming the
 * reason. A caller that has to choose between "the whole build failed" and "the
 * weather is fine" will pick wrong eventually, so it is never offered that
 * choice.
 */
export function openMeteoWeatherProvider(): WeatherProvider {
  return {
    name: 'Open-Meteo',
    async getWeather({ regionId, locations, dates, now }) {
      const generatedAt = now.toISOString();
      const timeZone = locations[0]?.timeZone ?? 'UTC';
      const today = localDateIn(now, timeZone);
      const horizonEnd = shiftDate(today, 15);

      const forecastDates = dates.filter((date) => date >= today && date <= horizonEnd);
      const patternDates = dates.filter((date) => !forecastDates.includes(date));

      const days: DayWeather[] = [];

      if (forecastDates.length > 0) {
        try {
          days.push(...(await fetchForecast(locations, forecastDates, generatedAt)));
        } catch (error) {
          days.push(...unavailableFor(locations, forecastDates, error, generatedAt));
        }
      }

      if (patternDates.length > 0) {
        try {
          days.push(
            ...(await fetchHistoricalPatterns(locations, patternDates, now, generatedAt)),
          );
        } catch (error) {
          days.push(...unavailableFor(locations, patternDates, error, generatedAt));
        }
      }

      // Anything the provider simply did not return — a date it skipped, a
      // location it dropped — becomes an explicit gap rather than an absence.
      const present = new Set(days.map((day) => `${day.locationId}|${day.date}`));
      for (const location of locations) {
        for (const date of dates) {
          if (present.has(`${location.id}|${date}`)) continue;
          days.push({
            kind: 'unavailable',
            locationId: location.id,
            date,
            reason: 'outside_supported_range',
            message: 'The weather service holds nothing for this date.',
            attemptedProvider: 'Open-Meteo',
            attemptedAt: generatedAt,
            consideredCache: false,
          });
        }
      }

      return weatherDatasetSchema.parse({
        version: WEATHER_DATASET_VERSION,
        regionId,
        locations: [...locations],
        days,
        // Computed locally and always present, because the sun is not a
        // prediction and must not go missing because a forecast did.
        solar: buildSolarDays({
          locations,
          dates,
          utcOffsetMinutesFor: (location, date) => utcOffsetMinutesOn(date, location.timeZone),
          computedAt: generatedAt,
        }),
        generatedAt,
        providerName: 'Open-Meteo',
      });
    },
  };
}

function unavailableFor(
  locations: readonly WeatherLocation[],
  dates: readonly string[],
  error: unknown,
  attemptedAt: string,
): DayWeather[] {
  const reason: WeatherUnavailableReason =
    error instanceof WeatherProviderError ? error.reason : 'provider_error';
  const message =
    error instanceof WeatherProviderError
      ? error.message
      : 'The weather service could not be reached.';
  return locations.flatMap((location) =>
    dates.map(
      (date): DayWeather => ({
        kind: 'unavailable',
        locationId: location.id,
        date,
        reason,
        // Provider prose can be technical; it is kept because it is the only
        // thing that distinguishes one outage from another in a log, and it is
        // paired with a plain sentence at every point it reaches a screen.
        message,
        attemptedProvider: 'Open-Meteo',
        attemptedAt,
        consideredCache: true,
      }),
    ),
  );
}
