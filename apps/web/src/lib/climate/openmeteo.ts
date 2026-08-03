import 'server-only';
import { z } from 'zod';
import {
  CLIMATE_DATASET_VERSION,
  climateProfileSchema,
  solarEventsFor,
  type ClimateNormal,
  type ClimateProfile,
  type ClimateResult,
  type ClimateUnavailableReason,
} from '@sidequest/core';

/**
 * MONTHLY CLIMATE NORMALS, COMPUTED FROM REANALYSIS RATHER THAN LOOKED UP.
 *
 * PROVIDER: the Open-Meteo Historical Weather API (`archive-api.open-meteo.com`),
 * ERA5 reanalysis, re-checked against the provider's published documentation on
 * 2 August 2026. The same endpoint the weather adapter already uses for its
 * historical patterns, and for the same licensing reason: CC-BY 4.0, attribution
 * carried with the numbers.
 *
 * WHY THIS IS NOT THE WEATHER ADAPTER.
 *
 * It answers a different question, over a different span, with a different
 * shape, and — critically — it must be impossible to confuse the two. The
 * weather adapter answers "what will it be like on the fourteenth" for a bounded
 * set of trip dates. This answers "what does July do here" for choosing dates
 * that do not exist yet. A `ClimateNormal` has a `month` and no date field, so
 * there is nowhere for a calendar date to be written; and `CLIMATE_EVIDENCE_NOTE`
 * travels with every rendering.
 *
 * THE COST, AND WHY IT IS AFFORDABLE.
 *
 * One request per destination, covering twenty years of daily records for one
 * point, aggregated locally into twelve rows and cached. Not one request per
 * month and not one per year: the archive endpoint takes an arbitrary date range
 * and returns daily values, so the whole profile is a single call of a few
 * hundred kilobytes.
 *
 * FREE-TIER TERMS. Non-commercial use, under 10,000 calls a day. A commercial
 * deployment moves to `customer-archive-api.open-meteo.com` with a key, which is
 * this file's `BASE` constant and one query parameter — deliberately the only
 * two things that would have to move.
 */

const BASE = 'https://archive-api.open-meteo.com/v1/archive';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How many years of record a normal is computed from.
 *
 * Twenty. Long enough that one freak summer cannot move a monthly mean by much,
 * and short enough that the answer describes the climate somebody is travelling
 * into rather than a thirty-year window whose early end is now historical. The
 * number is a judgement, so the profile carries the years it used and the UI
 * shows them.
 */
export const NORMAL_YEARS = 20;

/**
 * ERA5 lags real time by about five days.
 *
 * Asking for a range that runs to today returns trailing nulls rather than an
 * error, and a naive aggregation would read them as zero rainfall. The window
 * ends at the last complete calendar year for exactly this reason: whole years
 * only, no partial one to skew a month.
 */
const ARCHIVE_LAG_DAYS = 7;

export const WET_DAY_MM = 1;
export const SNOW_DAY_CM = 0.1;
export const HOT_DAY_C = 32;

export const CLIMATE_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';
export const CLIMATE_ATTRIBUTION_URL = 'https://open-meteo.com/';
export const CLIMATE_DATASET_NAME = 'ERA5 reanalysis via the Open-Meteo Historical Weather API';

const numberArray = z.array(z.number().nullable());

const archiveSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: numberArray,
    temperature_2m_min: numberArray,
    precipitation_sum: numberArray,
    snowfall_sum: numberArray,
  }),
});

const errorSchema = z.object({ error: z.literal(true), reason: z.string() });

export class ClimateProviderError extends Error {
  readonly reason: ClimateUnavailableReason;
  constructor(reason: ClimateUnavailableReason, message: string) {
    super(message);
    this.name = 'ClimateProviderError';
    this.reason = reason;
  }
}

/**
 * The seam the composer reads climate through.
 *
 * Deliberately narrow — one point, twelve rows — because everything above it is
 * choosing dates rather than planning days, and a wider interface would invite
 * somebody to ask it a dated question.
 */
export interface ClimateProvider {
  readonly name: string;
  getProfile(input: { lat: number; lng: number; now: Date }): Promise<ClimateResult>;
}

export function climateWindow(now: Date): { from: string; to: string; yearFrom: number; yearTo: number } {
  const lagged = new Date(now.getTime() - ARCHIVE_LAG_DAYS * 86_400_000);
  const yearTo = lagged.getUTCFullYear() - 1;
  const yearFrom = yearTo - NORMAL_YEARS + 1;
  return { from: `${yearFrom}-01-01`, to: `${yearTo}-12-31`, yearFrom, yearTo };
}

/**
 * Daylight hours on the fifteenth of each month, computed locally.
 *
 * Never fetched. Sunrise and sunset are a solved astronomical calculation the
 * codebase already performs for the planner, and spending a network request on
 * something a function can answer exactly would be worse in every dimension.
 * The fifteenth because it is the month's midpoint to within a day, and because
 * a mean over the month would smooth away the very thing a traveller is choosing
 * between at the solstices.
 */
export function daylightHoursByMonth(lat: number, lng: number, year: number): number[] {
  const hours: number[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-15`;
    const events = solarEventsFor({ lat, lng }, date, 0);
    if (events.kind === 'normal') {
      hours.push(Math.max(0, Math.min(24, (events.sunsetMinute - events.sunriseMinute) / 60)));
    } else {
      /*
       * Polar day and polar night are real answers, not failures.
       *
       * Above the Arctic Circle "how much daylight is there in December" has the
       * answer zero, and it is the single most decision-relevant fact about
       * going there in December. Collapsing it to a missing value would delete
       * the reason not to go.
       */
      hours.push(events.kind === 'polar_day' ? 24 : 0);
    }
  }
  return hours;
}

/**
 * Fold twenty years of daily records into twelve monthly rows.
 *
 * Pure and exported so the aggregation — which is where a units mistake or a
 * null-as-zero bug would hide — is tested against fixtures rather than against
 * a live service.
 *
 * Nulls are **skipped, never zeroed**. ERA5 has gaps, and a gap read as zero
 * rainfall is how a product tells somebody it never rains somewhere it does.
 */
export function aggregateNormals(input: {
  daily: z.infer<typeof archiveSchema>['daily'];
  daylightHours: readonly number[];
}): ClimateNormal[] {
  interface Bucket {
    highs: number[];
    lows: number[];
    precipitation: number[];
    snow: number[];
    years: Set<number>;
  }
  const buckets = new Map<number, Bucket>();
  for (let month = 1; month <= 12; month += 1) {
    buckets.set(month, { highs: [], lows: [], precipitation: [], snow: [], years: new Set() });
  }

  const { time, temperature_2m_max, temperature_2m_min, precipitation_sum, snowfall_sum } = input.daily;
  for (let index = 0; index < time.length; index += 1) {
    const date = time[index];
    if (typeof date !== 'string' || date.length < 7) continue;
    const month = Number(date.slice(5, 7));
    const year = Number(date.slice(0, 4));
    const bucket = buckets.get(month);
    if (!bucket) continue;
    bucket.years.add(year);

    const high = temperature_2m_max[index];
    const low = temperature_2m_min[index];
    const rain = precipitation_sum[index];
    const snow = snowfall_sum[index];
    if (typeof high === 'number') bucket.highs.push(high);
    if (typeof low === 'number') bucket.lows.push(low);
    if (typeof rain === 'number') bucket.precipitation.push(rain);
    if (typeof snow === 'number') bucket.snow.push(snow);
  }

  const normals: ClimateNormal[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const bucket = buckets.get(month)!;
    const years = Math.max(1, bucket.years.size);
    const mean = (values: number[]) =>
      values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

    normals.push({
      month,
      temperature: {
        low: round1(mean(bucket.lows)),
        high: round1(mean(bucket.highs)),
      },
      // Per *month*, so the total across the sample is divided by the years in it.
      precipitationMm: round1(bucket.precipitation.reduce((a, b) => a + b, 0) / years),
      wetDays: round1(bucket.precipitation.filter((value) => value >= WET_DAY_MM).length / years),
      snowDays: round1(bucket.snow.filter((value) => value >= SNOW_DAY_CM).length / years),
      daylightHours: round1(input.daylightHours[month - 1] ?? 12),
      hotDays: round1(bucket.highs.filter((value) => value >= HOT_DAY_C).length / years),
      freezeDays: round1(bucket.lows.filter((value) => value < 0).length / years),
    });
  }
  return normals;
}

function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Sidequest/0.1 (travel planner; contact via repository)' },
      cache: 'no-store',
    });
    const body: unknown = await response.json();
    const asError = errorSchema.safeParse(body);
    if (asError.success) {
      throw new ClimateProviderError(
        response.status === 400 ? 'no_data_for_location' : 'provider_unavailable',
        asError.data.reason,
      );
    }
    if (response.status === 429) {
      throw new ClimateProviderError('provider_rate_limited', 'The climate service asked us to slow down.');
    }
    if (!response.ok) {
      throw new ClimateProviderError('provider_unavailable', `Climate service returned ${response.status}.`);
    }
    return body;
  } catch (error) {
    if (error instanceof ClimateProviderError) throw error;
    throw new ClimateProviderError('provider_unavailable', 'The climate service could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

export function openMeteoClimateProvider(): ClimateProvider {
  return {
    name: 'open-meteo-archive',
    async getProfile({ lat, lng, now }) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { kind: 'unavailable', reason: 'no_data_for_location' };
      }

      const window = climateWindow(now);
      const url = new URL(BASE);
      url.searchParams.set('latitude', lat.toFixed(4));
      url.searchParams.set('longitude', lng.toFixed(4));
      url.searchParams.set('start_date', window.from);
      url.searchParams.set('end_date', window.to);
      url.searchParams.set(
        'daily',
        'temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum',
      );
      url.searchParams.set('timezone', 'UTC');

      try {
        const parsed = archiveSchema.safeParse(await getJson(url.toString()));
        if (!parsed.success) return { kind: 'unavailable', reason: 'response_malformed' };

        const months = aggregateNormals({
          daily: parsed.data.daily,
          daylightHours: daylightHoursByMonth(lat, lng, window.yearTo),
        });

        const profile: ClimateProfile = {
          schemaVersion: CLIMATE_DATASET_VERSION,
          coordinates: { lat, lng },
          sampleYearFrom: window.yearFrom,
          sampleYearTo: window.yearTo,
          months,
          provider: 'Open-Meteo',
          dataset: CLIMATE_DATASET_NAME,
          attribution: CLIMATE_ATTRIBUTION,
          attributionUrl: CLIMATE_ATTRIBUTION_URL,
          retrievedAt: now.toISOString(),
        };

        const validated = climateProfileSchema.safeParse(profile);
        if (!validated.success) return { kind: 'unavailable', reason: 'response_malformed' };
        return { kind: 'profile', profile: validated.data };
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: error instanceof ClimateProviderError ? error.reason : 'provider_unavailable',
        };
      }
    },
  };
}

/**
 * A provider that answers nothing, for builds with no network egress.
 *
 * Its own implementation rather than a null check at the call site, because the
 * difference between "no climate source configured" and "the source did not
 * answer" is a different sentence on screen and a different operator action.
 */
export function unavailableClimateProvider(): ClimateProvider {
  return {
    name: 'none',
    async getProfile() {
      return { kind: 'unavailable', reason: 'not_configured' };
    },
  };
}
