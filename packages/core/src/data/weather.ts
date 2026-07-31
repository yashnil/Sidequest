import { assertCalendarDate } from '../schemas/calendar';
import {
  WEATHER_DATASET_VERSION,
  weatherDatasetSchema,
  type DayWeather,
  type ForecastDayWeather,
  type HourlyWeather,
  type WeatherAttribution,
  type WeatherCondition,
  type WeatherDataset,
  type WeatherLocation,
} from '../schemas/weather';
import { buildSolarDays } from '../weather/solar';

/**
 * THE SEVEN POINTS THE EASTERN SIERRA IS FORECAST AT.
 *
 * On 30 July 2026 the forecast maximum for Mammoth Lakes was 28.5 °C. Seventy
 * miles down the same highway at Manzanar it was 38.3 °C, and eighteen miles
 * west over Tioga Pass it was 21.9 °C. One number for the region would have been
 * wrong by sixteen degrees at the extremes — and wrong in exactly the direction
 * that ruins a plan, because it is the valley floor that becomes dangerous in
 * August and the passes that collect the afternoon storms.
 *
 * The opposite mistake is bounded here too. A forecast provider resolves to a
 * grid of roughly ten kilometres; asking it separately about each trailhead
 * would imply it can tell one lake from the next, which it cannot. Seven points,
 * each of which the provider's own terrain model puts at a materially different
 * elevation, is as fine as this data honestly goes.
 *
 * Elevations are not authored. Each is the elevation Open-Meteo's Copernicus
 * GLO-90 terrain model reports for the grid point it actually samples, read on
 * 30 July 2026 — so the number describes the forecast rather than the summit.
 * Where that differs from the signed elevation of a place inside the zone, the
 * zone's `limitation` says so.
 */
export const EASTERN_SIERRA_TIME_ZONE = 'America/Los_Angeles';

export const EASTERN_SIERRA_WEATHER_LOCATIONS: WeatherLocation[] = [
  {
    id: 'mammoth-corridor',
    label: 'Mammoth Lakes & the 395 corridor',
    coordinates: { lat: 37.6485, lng: -118.9721 },
    elevationMetres: 2408,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: [
      'the-village-at-mammoth',
      'earthquake-fault',
      'convict-lake',
      'hot-creek-geologic-site',
      'wild-willys-hot-spring',
      'mcgee-creek-canyon',
      'sherwin-lakes-trail',
      'minaret-vista',
      'inyo-craters',
      'june-lake-loop',
      'obsidian-dome',
    ],
    limitation:
      'One point at 7,900 ft standing for the whole 7,000–8,000 ft band between June Lake and McGee Creek. Minaret Vista is signed 1,300 ft higher than this and runs colder and windier than the number here.',
  },
  {
    id: 'mammoth-alpine',
    label: 'Mammoth high country',
    coordinates: { lat: 37.6308, lng: -119.0326 },
    elevationMetres: 3356,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: ['panorama-gondola', 'mammoth-lakes-basin', 'little-lakes-valley'],
    limitation:
      'Taken at the 11,000 ft gondola summit, which is the coldest and windiest thing in the zone. The Lakes Basin at 9,000 ft runs several degrees warmer than this.',
  },
  {
    id: 'reds-meadow',
    label: 'Reds Meadow Valley',
    coordinates: { lat: 37.6255, lng: -119.0854 },
    elevationMetres: 2310,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: ['devils-postpile', 'rainbow-falls'],
    limitation:
      'A valley floor reached over a 9,000 ft rim. Cold air pools here overnight, and the road over the rim can be in different weather from the forecast below it.',
  },
  {
    id: 'mono-basin',
    label: 'Mono Basin',
    coordinates: { lat: 37.9375, lng: -119.0264 },
    elevationMetres: 1957,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: ['mono-lake-south-tufa'],
    limitation:
      'The lake shore itself, 1,500 ft below Mammoth and in its rain shadow. Nothing shelters it from wind off the water.',
  },
  {
    id: 'bodie-plateau',
    label: 'Bodie plateau',
    coordinates: { lat: 38.2126, lng: -119.0129 },
    elevationMetres: 2557,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: ['bodie-state-historic-park'],
    limitation:
      'A treeless 8,400 ft plateau, 2,000 ft above Mono Lake and half an hour further north. It is its own point because it is consistently the coldest and windiest place a traveller from Mammoth will stand.',
  },
  {
    id: 'tioga-tuolumne',
    label: 'Tioga Pass & Tuolumne Meadows',
    coordinates: { lat: 37.8776, lng: -119.3572 },
    elevationMetres: 2616,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: ['tioga-pass-tuolumne'],
    limitation:
      'The far side of the Sierra crest, where Pacific weather arrives first. Conditions here routinely differ from anywhere east of the pass on the same day.',
  },
  {
    id: 'owens-valley',
    label: 'Owens Valley floor',
    coordinates: { lat: 36.7286, lng: -118.1544 },
    elevationMetres: 1183,
    timeZone: EASTERN_SIERRA_TIME_ZONE,
    placeIds: [
      'bishop-town',
      'manzanar-historic-site',
      'manzanar-visitor-center',
      'alabama-hills',
    ],
    limitation:
      'One point at Manzanar standing for 55 miles of valley floor. Bishop at the northern end sits 250 ft higher and runs a degree or two cooler than this; Lone Pine at the southern end runs a degree warmer.',
  },
];

// ---------------------------------------------------------------------------
// The offline fixture provider
// ---------------------------------------------------------------------------

/**
 * A weather provider that never touches the network.
 *
 * This exists for tests and for end-to-end runs, and it is labelled as a fixture
 * everywhere it surfaces — the attribution says so in the words a traveller
 * would read, so there is no configuration mistake that ends with invented
 * numbers rendered as a forecast.
 *
 * It is table-driven rather than random. The condition for a date is its
 * day-of-year modulo the length of `CYCLE`, so every date has one stable answer
 * that a test can compute in its head, and the four-step cycle walks from clear
 * to stormy — which is exactly the gradient a day-assignment test needs in order
 * to prove that the exposed hike moved.
 *
 * Temperature is a single documented formula: a regional annual cycle taken at
 * sea level, less a fixed lapse rate to the zone's own elevation. That is not a
 * climate model and does not pretend to be one; it is the smallest thing that
 * makes the valley floor hot in August and the summit cold in October, which is
 * the property the tests are about.
 */
const CYCLE = [
  { condition: 'clear', cloud: 8, precipMm: 0, precipChance: 3, windKph: 11, gustKph: 20 },
  { condition: 'partly_cloudy', cloud: 42, precipMm: 0, precipChance: 12, windKph: 19, gustKph: 38 },
  { condition: 'rain', cloud: 84, precipMm: 7.4, precipChance: 76, windKph: 26, gustKph: 49 },
  {
    condition: 'thunderstorm',
    cloud: 92,
    precipMm: 13.1,
    precipChance: 88,
    windKph: 34,
    gustKph: 68,
  },
] as const satisfies readonly {
  condition: WeatherCondition;
  cloud: number;
  precipMm: number;
  precipChance: number;
  windKph: number;
  gustKph: number;
}[];

export const FIXTURE_ATTRIBUTION: WeatherAttribution = {
  provider: 'Sidequest offline fixture',
  notice: 'Fixture weather. Not a forecast, and not observed data — for testing only.',
  url: 'https://example.invalid/sidequest-weather-fixture',
  dataset: 'Deterministic four-day cycle over a lapse-rate temperature model',
};

/** °C per kilometre of ascent. The textbook environmental lapse rate. */
const LAPSE_C_PER_KM = 6.5;

/** Sea-level daily maximum for the region, by month. A fixture constant. */
const SEA_LEVEL_MAX_C = [14, 16, 19, 23, 28, 34, 39, 38, 34, 27, 19, 14];
/** How far the daily minimum falls below the maximum, by month. */
const DIURNAL_RANGE_C = [12, 13, 14, 15, 16, 17, 17, 17, 16, 15, 13, 12];

function dayOfYear(date: string): number {
  const parsed = assertCalendarDate(date);
  const start = Date.UTC(parsed.getUTCFullYear(), 0, 1);
  return Math.round((parsed.getTime() - start) / 86_400_000) + 1;
}

function cycleFor(date: string): (typeof CYCLE)[number] {
  return CYCLE[dayOfYear(date) % CYCLE.length]!;
}

function temperaturesFor(location: WeatherLocation, date: string) {
  const month = assertCalendarDate(date).getUTCMonth();
  const drop = (location.elevationMetres / 1000) * LAPSE_C_PER_KM;
  const max = Math.round((SEA_LEVEL_MAX_C[month]! - drop) * 10) / 10;
  const min = Math.round((max - DIURNAL_RANGE_C[month]!) * 10) / 10;
  return { max, min };
}

/**
 * Twenty-four hours built from the day.
 *
 * Precipitation is weighted to the afternoon rather than spread evenly, because
 * that is both what the Sierra actually does in summer and the thing that makes
 * time-of-day scheduling worth testing: a morning start genuinely avoids the
 * storm, and a fixture that drizzled uniformly could never demonstrate it.
 */
function hoursFor(location: WeatherLocation, date: string): HourlyWeather[] {
  const cycle = cycleFor(date);
  const { max, min } = temperaturesFor(location, date);
  const hours: HourlyWeather[] = [];

  for (let hour = 0; hour < 24; hour += 1) {
    // Coldest just before dawn, warmest mid-afternoon.
    const phase = Math.cos(((hour - 15) / 24) * 2 * Math.PI);
    const temperature = Math.round(((min + max) / 2 + ((max - min) / 2) * phase) * 10) / 10;
    // Convection builds after midday and dies back after sunset.
    const convective = hour >= 12 && hour <= 19 ? 1 : hour >= 9 && hour < 12 ? 0.25 : 0.05;
    const snowing = temperature <= 0 && cycle.precipMm > 0;
    const precipitationMm = Math.round(cycle.precipMm * convective * 100) / 100;
    hours.push({
      startMinute: hour * 60,
      condition:
        precipitationMm > 0.2
          ? snowing
            ? 'snow'
            : cycle.condition
          : cycle.condition === 'rain' || cycle.condition === 'thunderstorm'
            ? 'overcast'
            : cycle.condition,
      temperatureC: temperature,
      precipitationProbabilityPercent: Math.round(cycle.precipChance * convective),
      precipitationMm: snowing ? 0 : precipitationMm,
      snowfallCm: snowing ? Math.round(precipitationMm * 0.7 * 10) / 10 : 0,
      windSpeedKph: cycle.windKph,
      windGustKph: Math.round(cycle.gustKph * (0.7 + 0.3 * convective)),
      cloudCoverPercent: cycle.cloud,
      visibilityMetres: precipitationMm > 0.2 ? 6000 : 90_000,
    });
  }
  return hours;
}

function forecastFor(
  location: WeatherLocation,
  date: string,
  fetchedAt: string,
): ForecastDayWeather {
  const cycle = cycleFor(date);
  const { max, min } = temperaturesFor(location, date);
  const hours = hoursFor(location, date);
  const snowfallCm = Math.round(hours.reduce((sum, hour) => sum + hour.snowfallCm, 0) * 10) / 10;
  const precipitationMm =
    Math.round(hours.reduce((sum, hour) => sum + hour.precipitationMm, 0) * 10) / 10;

  return {
    kind: 'forecast',
    locationId: location.id,
    date,
    condition: snowfallCm > 0 ? 'snow' : cycle.condition,
    temperatureMaxC: max,
    temperatureMinC: min,
    precipitationProbabilityPercent: cycle.precipChance,
    precipitationMm,
    snowfallCm,
    windSpeedMaxKph: cycle.windKph,
    windGustMaxKph: cycle.gustKph,
    cloudCoverMeanPercent: cycle.cloud,
    hours,
    fetchedAt,
    staleAfterMinutes: FORECAST_STALE_AFTER_MINUTES,
    attribution: FIXTURE_ATTRIBUTION,
  };
}

/**
 * How long a daily forecast stays presentable before the UI must call it stale.
 *
 * Six hours. Providers refresh global models roughly four times a day, so
 * anything older than that is at best one run behind, and a traveller reading a
 * precipitation figure deserves to know it predates the most recent update.
 * Central so the live adapter and the fixture cannot drift apart.
 */
export const FORECAST_STALE_AFTER_MINUTES = 6 * 60;

/**
 * How far ahead a date-specific prediction is honest.
 *
 * Sixteen days is what Open-Meteo serves, verified against the live endpoint on
 * 30 July 2026 (`forecast_days=16` returned 2026-07-30 through 2026-08-14 —
 * today plus fifteen). Beyond it the honest answer is a historical pattern, and
 * a "forecast" for day seventeen would be a fabrication however plausible it
 * looked. The live adapter re-derives this from the response rather than
 * trusting the constant; the constant is what the fixture and the tests share.
 */
export const FORECAST_HORIZON_DAYS = 16;

export function isInsideForecastHorizon(date: string, now: Date, timeZone: string): boolean {
  const today = localDateIn(now, timeZone);
  const days = Math.round(
    (assertCalendarDate(date).getTime() - assertCalendarDate(today).getTime()) / 86_400_000,
  );
  return days >= 0 && days < FORECAST_HORIZON_DAYS;
}

/**
 * The calendar date it is *right now* in a given zone.
 *
 * The domain's whole time model is wall-clock-where-you-are-standing, and the
 * forecast horizon is measured from the traveller's today, not the server's. A
 * server in Frankfurt deciding at 00:30 that a Mammoth trip starting "tomorrow"
 * is out of horizon would push a perfectly good forecast into historical
 * patterns for nine hours a day.
 */
export function localDateIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts;
}

/** The offset from UTC in force in `timeZone` on `date`, in minutes. */
export function utcOffsetMinutesOn(date: string, timeZone: string): number {
  // Noon local-ish, so the answer is never taken from the ambiguous hour a
  // daylight-saving transition creates at either end of the day.
  const probe = new Date(`${date}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });
  const part = formatter
    .formatToParts(probe)
    .find((entry) => entry.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? '');
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export interface FixtureWeatherOptions {
  /**
   * Dates the fixture should answer `unavailable` for, so the failure path is
   * exercised by a test rather than only by an outage.
   */
  unavailableDates?: readonly string[];
  /** Overrides the fetch timestamp, so staleness is testable without waiting. */
  fetchedAt?: string;
}

export function buildFixtureWeather(input: {
  regionId: string;
  locations: readonly WeatherLocation[];
  dates: readonly string[];
  now: Date;
  options?: FixtureWeatherOptions;
}): WeatherDataset {
  const generatedAt = input.now.toISOString();
  const fetchedAt = input.options?.fetchedAt ?? generatedAt;
  const unavailable = new Set(input.options?.unavailableDates ?? []);
  const days: DayWeather[] = [];

  for (const location of input.locations) {
    for (const date of input.dates) {
      if (unavailable.has(date)) {
        days.push({
          kind: 'unavailable',
          locationId: location.id,
          date,
          reason: 'provider_error',
          message: 'The weather service did not answer for this date.',
          attemptedProvider: FIXTURE_PROVIDER_NAME,
          attemptedAt: generatedAt,
          consideredCache: true,
        });
        continue;
      }
      if (isInsideForecastHorizon(date, input.now, location.timeZone)) {
        days.push(forecastFor(location, date, fetchedAt));
        continue;
      }
      days.push(historicalFixtureFor(location, date, generatedAt));
    }
  }

  return weatherDatasetSchema.parse({
    version: WEATHER_DATASET_VERSION,
    regionId: input.regionId,
    locations: input.locations,
    days,
    solar: buildSolarDays({
      locations: input.locations,
      dates: input.dates,
      utcOffsetMinutesFor: (location, date) => utcOffsetMinutesOn(date, location.timeZone),
      computedAt: generatedAt,
    }),
    generatedAt,
    providerName: FIXTURE_PROVIDER_NAME,
  });
}

export const FIXTURE_PROVIDER_NAME = 'Sidequest offline fixture';

/**
 * A historical pattern for a date beyond the horizon.
 *
 * Every value here is identical for every date in the same calendar band, which
 * is not a shortcut — it is the property that makes the record safe. A planner
 * handed two of these cannot rank one day above the other, because there is
 * nothing to rank on, and that is precisely the claim a set of averages is
 * entitled to make.
 */
function historicalFixtureFor(
  location: WeatherLocation,
  date: string,
  computedAt: string,
): DayWeather {
  const month = assertCalendarDate(date).getUTCMonth();
  const drop = (location.elevationMetres / 1000) * LAPSE_C_PER_KM;
  const median = Math.round((SEA_LEVEL_MAX_C[month]! - drop) * 10) / 10;
  const spread = 4;
  const monthDay = date.slice(5);

  return {
    kind: 'historical_pattern',
    locationId: location.id,
    date,
    bandStart: shiftMonthDay(monthDay, -5),
    bandEnd: shiftMonthDay(monthDay, 5),
    sampleYearFrom: 2016,
    sampleYearTo: 2025,
    sampleCount: 110,
    method:
      'Fixture: a lapse-rate temperature model over a fixed ±5 day band. Not observed data.',
    temperatureMaxC: {
      p10: Math.round((median - spread) * 10) / 10,
      p50: median,
      p90: Math.round((median + spread) * 10) / 10,
    },
    temperatureMinC: {
      p10: Math.round((median - DIURNAL_RANGE_C[month]! - spread) * 10) / 10,
      p50: Math.round((median - DIURNAL_RANGE_C[month]!) * 10) / 10,
      p90: Math.round((median - DIURNAL_RANGE_C[month]! + spread) * 10) / 10,
    },
    wetDayFrequency: month >= 5 && month <= 8 ? 0.12 : 0.28,
    snowDayFrequency: median < 4 ? 0.35 : 0,
    windGustKphP90: 55,
    computedAt,
    attribution: FIXTURE_ATTRIBUTION,
  };
}

/** `MM-DD` shifted by whole days inside a fixed non-leap reference year. */
function shiftMonthDay(monthDay: string, days: number): string {
  const reference = new Date(Date.UTC(2001, 0, 1));
  const [month, day] = monthDay.split('-').map(Number);
  reference.setUTCMonth((month ?? 1) - 1, (day ?? 1) + days);
  return `${String(reference.getUTCMonth() + 1).padStart(2, '0')}-${String(
    reference.getUTCDate(),
  ).padStart(2, '0')}`;
}
