import {
  weatherDatasetSchema,
  weatherKey,
  type WeatherDataset,
  type WeatherLocation,
} from '../schemas/weather';

/**
 * The seam a real weather source arrives through.
 *
 * Unlike access and hours, this one has a live implementation from day one, and
 * that changes what the boundary is for. Access and hours cross it to prove a
 * local constant still validates; weather crosses it carrying numbers fetched
 * over the network seconds ago, from a service that can time out, rate-limit,
 * change its response shape, or answer with `null` where a number is expected.
 * Everything below is written on the assumption that it will, eventually, do all
 * four.
 *
 * The rule the hours provider states applies here twice over: **a provider may
 * never answer "I don't know" by omission.** A date with no record is
 * indistinguishable from a date nobody asked about, and a planner that reads a
 * missing forecast as fair weather is worse than one with no weather at all —
 * because it will confidently place an exposed ridge walk in a thunderstorm and
 * report the day as ready. Silence comes back as `kind: 'unavailable'` with a
 * reason, or it is a defect.
 */
export interface WeatherProvider {
  readonly name: string;
  getWeather(input: {
    regionId: string;
    /** The points to fetch for. Never one point for a whole region. */
    locations: readonly WeatherLocation[];
    /** Trip dates as `YYYY-MM-DD`, local to the region. */
    dates: readonly string[];
    /**
     * "Now", injected. The provider needs it to decide which dates fall inside
     * the forecast horizon and which fall back to a historical pattern, and a
     * test that cannot control that boundary cannot test the boundary.
     */
    now: Date;
  }): Promise<WeatherDataset>;
}

export const WEATHER_DATA_ERROR_CODES = [
  'invalid_dataset',
  'unknown_region',
  'incomplete_coverage',
  'unmapped_places',
] as const;
export type WeatherDataErrorCode = (typeof WEATHER_DATA_ERROR_CODES)[number];

export class WeatherDataError extends Error {
  readonly code: WeatherDataErrorCode;

  constructor(code: WeatherDataErrorCode, message: string) {
    super(message);
    this.name = 'WeatherDataError';
    this.code = code;
  }
}

/**
 * The boundary check. Every dataset crosses it, fixture and live alike.
 *
 * Coverage is mandatory on both axes and for a different reason on each:
 *
 * - **Every (location, date) must have a record**, because the alternative is a
 *   planner that silently treats an unfetched Tuesday as unremarkable and ranks
 *   it above a Wednesday it does have a forecast for.
 * - **Every place must be claimed by exactly one location**, because a place
 *   mapped to none would fall through to whatever default the first consumer
 *   happened to pick, and a place mapped to two would have its weather decided
 *   by array order. Both are caught here rather than at the point of use.
 */
export function validateWeatherDataset(
  dataset: unknown,
  expected: { regionId: string; dates: readonly string[]; placeIds: readonly string[] },
): WeatherDataset {
  const parsed = weatherDatasetSchema.safeParse(dataset);
  if (!parsed.success) {
    throw new WeatherDataError(
      'invalid_dataset',
      `The weather data did not validate: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'} — ${issue.message}`)
        .join('; ')}`,
    );
  }

  if (parsed.data.regionId !== expected.regionId) {
    throw new WeatherDataError(
      'unknown_region',
      `Weather data for "${parsed.data.regionId}" cannot be used for "${expected.regionId}".`,
    );
  }

  const unmapped = placesWithoutWeatherLocation(parsed.data, expected.placeIds);
  if (unmapped.length > 0) {
    throw new WeatherDataError(
      'unmapped_places',
      `No weather location covers ${unmapped.join(', ')}. We will not fall back to the base town's forecast for a stop three thousand feet above or below it.`,
    );
  }

  const missing = missingWeatherKeys(parsed.data, expected.dates);
  if (missing.length > 0) {
    throw new WeatherDataError(
      'incomplete_coverage',
      `No weather record covers ${missing.join(', ')}. A date with nothing against it is not a fine day.`,
    );
  }

  return parsed.data;
}

export function placesWithoutWeatherLocation(
  dataset: WeatherDataset,
  placeIds: readonly string[],
): string[] {
  const claimed = new Set(dataset.locations.flatMap((location) => location.placeIds));
  return [...placeIds].filter((placeId) => !claimed.has(placeId)).sort();
}

export function missingWeatherKeys(
  dataset: WeatherDataset,
  dates: readonly string[],
): string[] {
  const present = new Set(dataset.days.map((day) => weatherKey(day.locationId, day.date)));
  const missing: string[] = [];
  for (const location of dataset.locations) {
    for (const date of dates) {
      if (!present.has(weatherKey(location.id, date))) missing.push(`${location.label} on ${date}`);
    }
  }
  return missing.sort();
}
