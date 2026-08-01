import { z } from 'zod';
import { coordinatesSchema, httpUrlSchema, isoDateSchema, minuteOfDaySchema } from './common';
import { sourceProvenanceSchema } from './provenance';

/**
 * WHAT THE SKY IS EXPECTED TO DO — as distinct from what anyone will let you do.
 *
 * This is the fourth independent question the planner asks about a day, and it is
 * the weakest of the four. The first three are matters of record:
 *
 *   1. transportation access   — is there a legal way to reach and leave it?
 *   2. operating availability  — is it open when you arrive?
 *   3. daylight                — is there light? (`solarDaySchema`, below)
 *   4. weather                 — *this file*. A prediction, or a pattern.
 *
 * Weather never promotes. A clear forecast cannot open a gate, summon a shuttle,
 * or add an hour to a closing time; it can only choose between days that are
 * already legal, and warn about the one that gets picked. Everything in this file
 * is consumed *after* the first three have already said yes.
 *
 * THE DISTINCTION THE WHOLE FILE TURNS ON
 *
 * Three kinds of knowledge, which must never be rendered in each other's words:
 *
 *   - `forecast`            a model's prediction for one specific date, inside the
 *                           provider's supported horizon. May rank Tuesday against
 *                           Wednesday. Goes stale in hours.
 *   - `historical_pattern`  what this calendar period has actually done, computed
 *                           from observations of past years. May say "afternoon
 *                           storms are common in August". May **never** say next
 *                           August 14th will be clearer than the 15th, because it
 *                           contains no information about either.
 *   - `unavailable`         we did not find out. A first-class answer, for the same
 *                           reason `unknown` is one in `schemas/hours.ts`: a missing
 *                           record that reads as fair weather is how a planner sends
 *                           somebody up an exposed ridge in a thunderstorm and calls
 *                           the day ready.
 *
 * These are per (location, date), not per trip. A trip that starts inside the
 * forecast horizon and ends outside it genuinely holds two kinds of knowledge at
 * once, and flattening that to one label on the whole trip would either invent a
 * forecast for the last day or discard a real one for the first.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Current conditions. A closure, a fire, a smoke event, a road incident, an
 * operator deciding at 06:00 that the lift is not turning. None of those can be
 * inferred from a forecast, and none of them are modelled. A place that is shut
 * today is shut for reasons this file cannot see.
 */

/**
 * 1 — first release. Persisted alongside a plan so a stored itinerary can say
 * which generation of weather reasoning produced its shape, exactly as
 * `OPERATING_HOURS_DATASET_VERSION` does for opening hours.
 */
export const WEATHER_DATASET_VERSION = 1 as const;

/**
 * The normalized sky. Deliberately coarse.
 *
 * Providers speak in WMO codes, of which there are around thirty, distinguishing
 * "slight" from "moderate" drizzle and rime fog from ordinary fog. Those
 * distinctions do not change any decision this planner makes, and carrying them
 * past the adapter would mean every consumer — scoring, copy, badges — learning a
 * meteorological vocabulary to answer "can we walk up there". The adapter
 * collapses the provider's code to one of these; nothing outside the adapter ever
 * sees a raw code.
 */
export const WEATHER_CONDITIONS = [
  'clear',
  'partly_cloudy',
  'overcast',
  'fog',
  'drizzle',
  'rain',
  'snow',
  'thunderstorm',
] as const;
export const weatherConditionSchema = z.enum(WEATHER_CONDITIONS);
export type WeatherCondition = z.infer<typeof weatherConditionSchema>;

export const WEATHER_CONDITION_LABELS: Record<WeatherCondition, string> = {
  clear: 'Clear',
  partly_cloudy: 'Partly cloudy',
  overcast: 'Overcast',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  snow: 'Snow',
  thunderstorm: 'Thunderstorms',
};

/**
 * A point weather is actually fetched for.
 *
 * The reason this type exists at all: on 30 July 2026 the forecast for Mammoth
 * Lakes was 28.5 °C and the forecast for Manzanar, seventy miles down the same
 * highway, was 38.3 °C. Tioga Pass was 21.9 °C. Applying the base town's forecast
 * to the whole region would have been wrong by sixteen degrees at the extremes,
 * and wrong in the direction that matters — it is the low desert stops that
 * become unpleasant and the high passes that get the afternoon storms.
 *
 * The opposite failure is just as real, so it is bounded here too: one request
 * per card would imply that a provider on a ~10 km grid can tell one trailhead
 * from the next lake, which it cannot. A weather location is an explicit, small,
 * named set of points whose differences are large enough to be genuine.
 */
export const weatherLocationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  coordinates: coordinatesSchema,
  /**
   * Metres. Not decoration: it is the whole reason these locations are separate,
   * and it is what a UI needs to explain why two stops on one trip have
   * different weather. Recorded from the provider's own terrain model where the
   * provider resolves one, so it describes the grid point actually sampled
   * rather than a number somebody typed.
   */
  elevationMetres: z.number().int(),
  /** IANA zone. Weather is the only part of the domain that needs one. */
  timeZone: z.string().min(1),
  /** Place ids this location speaks for. Every place must be in exactly one. */
  placeIds: z.array(z.string().min(1)).min(1),
  /** What this point cannot tell you. Shown, not buried. */
  limitation: z.string().min(1),
});
export type WeatherLocation = z.infer<typeof weatherLocationSchema>;

/** Who produced a number, and what has to be said about it on screen. */
export const weatherAttributionSchema = z.object({
  provider: z.string().min(1),
  /** The licence line that must appear wherever the data does. */
  notice: z.string().min(1),
  url: httpUrlSchema,
  /** The model or dataset behind it, when the provider names one. */
  dataset: z.string().min(1).optional(),
});
export type WeatherAttribution = z.infer<typeof weatherAttributionSchema>;

/**
 * One hour of a forecast.
 *
 * Present only when the provider genuinely supplies hourly values for that date,
 * which is what makes time-of-day scheduling defensible. A day whose hours are
 * absent is a day the planner may still place, but may not claim to have timed.
 */
export const hourlyWeatherSchema = z.object({
  /** Start of the hour, minutes from local midnight. Always a multiple of 60. */
  startMinute: minuteOfDaySchema,
  condition: weatherConditionSchema,
  temperatureC: z.number(),
  /** Null where the provider does not model it, never zero as a stand-in. */
  precipitationProbabilityPercent: z.number().min(0).max(100).nullable(),
  precipitationMm: z.number().min(0),
  snowfallCm: z.number().min(0),
  windSpeedKph: z.number().min(0),
  windGustKph: z.number().min(0),
  cloudCoverPercent: z.number().min(0).max(100).nullable(),
  visibilityMetres: z.number().min(0).nullable(),
});
export type HourlyWeather = z.infer<typeof hourlyWeatherSchema>;

/**
 * A prediction for one date at one location.
 *
 * `fetchedAt` and `staleAfterMinutes` are not bookkeeping. A forecast read four
 * days ago and rendered today without saying so is the single most likely way
 * this feature misleads somebody, so freshness travels with the number rather
 * than being reconstructed from when the row happened to be written.
 */
export const forecastDayWeatherSchema = z.object({
  kind: z.literal('forecast'),
  locationId: z.string().min(1),
  date: isoDateSchema,
  condition: weatherConditionSchema,
  temperatureMaxC: z.number(),
  temperatureMinC: z.number(),
  apparentTemperatureMaxC: z.number().optional(),
  apparentTemperatureMinC: z.number().optional(),
  precipitationProbabilityPercent: z.number().min(0).max(100).nullable(),
  precipitationMm: z.number().min(0),
  snowfallCm: z.number().min(0),
  windSpeedMaxKph: z.number().min(0),
  windGustMaxKph: z.number().min(0),
  cloudCoverMeanPercent: z.number().min(0).max(100).nullable(),
  /** Empty when the provider returned no hourly detail for this date. */
  hours: z.array(hourlyWeatherSchema).default([]),
  /** ISO instant the prediction was retrieved. */
  fetchedAt: z.string().datetime(),
  /** Minutes after `fetchedAt` beyond which this must be labelled stale. */
  staleAfterMinutes: z.number().int().min(1),
  attribution: weatherAttributionSchema,
});
export type ForecastDayWeather = z.infer<typeof forecastDayWeatherSchema>;

/** A distribution summarised honestly: a middle and both tails, never one number. */
export const weatherRangeSchema = z
  .object({
    p10: z.number(),
    p50: z.number(),
    p90: z.number(),
  })
  .refine((range) => range.p10 <= range.p50 && range.p50 <= range.p90, {
    message: 'Percentiles must be ordered',
    path: ['p50'],
  });
export type WeatherRange = z.infer<typeof weatherRangeSchema>;

/**
 * What this calendar period has historically done at this location.
 *
 * Every field here describes a *band of the calendar across several years*, and
 * the schema is shaped so that it cannot be mistaken for a prediction: there is
 * no single temperature, only a range; no probability of rain tomorrow, only the
 * share of past days in this band that were wet. `date` is the trip date this
 * record was attached to for convenience of lookup — it is not a claim about that
 * date, and two dates in the same band carry identical values by construction.
 * The planner relies on that: identical values cannot rank one day above another.
 */
export const historicalPatternDayWeatherSchema = z.object({
  kind: z.literal('historical_pattern'),
  locationId: z.string().min(1),
  /** The trip date this pattern was looked up for. Never a prediction about it. */
  date: isoDateSchema,
  /** Calendar band sampled, as `MM-DD` inclusive bounds. */
  bandStart: z.string().regex(/^\d{2}-\d{2}$/),
  bandEnd: z.string().regex(/^\d{2}-\d{2}$/),
  /** Inclusive years sampled. */
  sampleYearFrom: z.number().int().min(1940),
  sampleYearTo: z.number().int().min(1940),
  /** Observation-days behind the numbers. Below a floor, no record is emitted. */
  sampleCount: z.number().int().min(1),
  /** Written down so the aggregation can be argued with rather than trusted. */
  method: z.string().min(1),
  temperatureMaxC: weatherRangeSchema,
  temperatureMinC: weatherRangeSchema,
  /** Share of sampled days with at least `WET_DAY_THRESHOLD_MM` of precipitation. */
  wetDayFrequency: z.number().min(0).max(1),
  /** Share of sampled days with any snowfall. */
  snowDayFrequency: z.number().min(0).max(1),
  windGustKphP90: z.number().min(0),
  computedAt: z.string().datetime(),
  attribution: weatherAttributionSchema,
});
export type HistoricalPatternDayWeather = z.infer<typeof historicalPatternDayWeatherSchema>;

/**
 * Why a date has no weather. Machine-readable so the UI can offer the right
 * recovery and the validator can tell "nobody asked" from "we asked and failed".
 */
export const WEATHER_UNAVAILABLE_REASONS = [
  /** The provider did not answer inside the deadline. */
  'provider_timeout',
  /** The provider answered with an error, or unreachable. */
  'provider_error',
  /** The provider answered with something that did not validate. */
  'invalid_response',
  /** Outside every window the provider serves — too far ahead for a forecast, and
   *  not enough history behind it for a pattern. */
  'outside_supported_range',
  /** Too few observation-days to summarise without inventing confidence. */
  'insufficient_history',
  /** No weather location claims the place. A data defect, surfaced not swallowed. */
  'no_location_mapping',
  /** Weather lookup is switched off in this environment. */
  'not_configured',
] as const;
export const weatherUnavailableReasonSchema = z.enum(WEATHER_UNAVAILABLE_REASONS);
export type WeatherUnavailableReason = z.infer<typeof weatherUnavailableReasonSchema>;

export const unavailableDayWeatherSchema = z.object({
  kind: z.literal('unavailable'),
  locationId: z.string().min(1),
  date: isoDateSchema,
  reason: weatherUnavailableReasonSchema,
  /** One sentence a traveller can read. Never a stack trace or a status code. */
  message: z.string().min(1),
  attemptedProvider: z.string().min(1),
  attemptedAt: z.string().datetime(),
  /** Whether a cached snapshot was looked for before giving up. */
  consideredCache: z.boolean(),
});
export type UnavailableDayWeather = z.infer<typeof unavailableDayWeatherSchema>;

export const dayWeatherSchema = z.discriminatedUnion('kind', [
  forecastDayWeatherSchema,
  historicalPatternDayWeatherSchema,
  unavailableDayWeatherSchema,
]);
export type DayWeather = z.infer<typeof dayWeatherSchema>;

export type WeatherEvidenceKind = DayWeather['kind'];

export const WEATHER_EVIDENCE_LABELS: Record<WeatherEvidenceKind, string> = {
  forecast: 'Forecast',
  historical_pattern: 'Historical pattern',
  unavailable: 'No weather data',
};

/**
 * Sunrise and sunset for a date at a location.
 *
 * Kept in its own type, with its own source field, even though one provider
 * happens to return it alongside the forecast. It is not a prediction — the sun
 * will rise at 05:58 on 30 July at this latitude whatever the models say — and
 * labelling it as forecast evidence would put a freshness warning on an
 * astronomical fact and, worse, make a failed forecast look like it took the
 * daylight with it.
 */
export const solarDaySchema = z.object({
  locationId: z.string().min(1),
  date: isoDateSchema,
  sunriseMinute: minuteOfDaySchema,
  sunsetMinute: minuteOfDaySchema,
  /** Where it was obtained. Never the string "forecast". */
  source: z.string().min(1),
  computedAt: z.string().datetime(),
});
export type SolarDay = z.infer<typeof solarDaySchema>;

/**
 * Everything the planner is told about the sky, for one trip.
 *
 * Coverage is keyed on (location, date) and is mandatory, for the same reason
 * the hours dataset requires a calendar for every place: an absent row is
 * indistinguishable from an unconsidered one, and the honest answers — a
 * forecast, a pattern, or `unavailable` with a reason — are all representable, so
 * silence never has to be.
 */
export const weatherDatasetSchema = z
  .object({
    version: z.literal(WEATHER_DATASET_VERSION),
    regionId: z.string().min(1),
    locations: z.array(weatherLocationSchema).min(1),
    days: z.array(dayWeatherSchema),
    solar: z.array(solarDaySchema).default([]),
    /** When this dataset was assembled, whatever mixture it holds. */
    generatedAt: z.string().datetime(),
    /** The provider asked, whether or not it answered. */
    providerName: z.string().min(1),
  })
  .superRefine((dataset, ctx) => {
    const locationIds = new Set<string>();
    for (const location of dataset.locations) {
      if (locationIds.has(location.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Two weather locations share the id "${location.id}"`,
          path: ['locations'],
        });
      }
      locationIds.add(location.id);
    }

    // A place mapped to two locations means two different forecasts are both
    // "the" weather for one stop, and which one wins would come down to array
    // order. Caught here rather than left to whichever consumer looks first.
    const claimed = new Map<string, string>();
    for (const location of dataset.locations) {
      for (const placeId of location.placeIds) {
        const already = claimed.get(placeId);
        if (already) {
          ctx.addIssue({
            code: 'custom',
            message: `${placeId} is claimed by both "${already}" and "${location.id}"`,
            path: ['locations'],
          });
        }
        claimed.set(placeId, location.id);
      }
    }

    const seen = new Set<string>();
    for (const day of dataset.days) {
      const key = `${day.locationId}|${day.date}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Two weather records for ${day.locationId} on ${day.date}`,
          path: ['days'],
        });
      }
      seen.add(key);
      if (!locationIds.has(day.locationId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Weather for unknown location "${day.locationId}"`,
          path: ['days'],
        });
      }
      if (day.kind === 'historical_pattern' && day.sampleYearTo < day.sampleYearFrom) {
        ctx.addIssue({
          code: 'custom',
          message: 'A historical sample cannot end before it starts',
          path: ['days'],
        });
      }
    }

    const solarSeen = new Set<string>();
    for (const entry of dataset.solar) {
      const key = `${entry.locationId}|${entry.date}`;
      if (solarSeen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Two solar records for ${entry.locationId} on ${entry.date}`,
          path: ['solar'],
        });
      }
      solarSeen.add(key);
      if (entry.sunsetMinute <= entry.sunriseMinute) {
        ctx.addIssue({
          code: 'custom',
          message: `Sunset must fall after sunrise on ${entry.date}`,
          path: ['solar'],
        });
      }
    }
  });
export type WeatherDataset = z.infer<typeof weatherDatasetSchema>;

/**
 * HOW A PLACE REACTS TO WEATHER — the canonical half of the question.
 *
 * Replaces `weatherSensitivity: 'low' | 'moderate' | 'high'` and
 * `worksInBadWeather: boolean`, which between them could not express any of the
 * distinctions this planner actually needs to make:
 *
 *   - The old scalar collapsed four unrelated physical facts. The gondola scored
 *     `high` because it *shuts on wind*; Little Lakes Valley scored `high` because
 *     it is an exposed alpine hike; Tioga scored `high` because it snows; Minaret
 *     Vista scored `high` because a cloudy sunset is worthless. One number, four
 *     meanings, and no way to act on any of them.
 *   - The old boolean conflated "you can still do this in the rain" with "this is
 *     worth choosing instead". Alabama Hills was flagged as a bad-weather option:
 *     a two-and-a-quarter-hour drive to a desert boulder field whose entire point
 *     is the Whitney skyline at first light.
 *   - Neither could say that Manzanar is the *right* answer in an October
 *     rainstorm and a genuinely bad idea in August, which is one place, one
 *     record, and two opposite verdicts on two different axes.
 *   - Neither could separate the activity from the road to it. Wild Willy's is
 *     lovely in falling snow and is reached by a dirt track that turns to mud.
 *
 * Four graded axes, four booleans and one sourced record, each of which changes a
 * decision made somewhere in this codebase. Nothing here is decorative.
 *
 * Note the deliberate asymmetry between the last two fields.
 * `approachDegradesWhenWet` is a boolean because "the road is worse in the wet"
 * is an ordinary observation anybody can make. `dryConditionsRequired` is an
 * object carrying provenance because it is the one thing here that can remove a
 * place from somebody's trip, and a claim with that consequence has to name who
 * made it.
 */
export const WEATHER_SENSITIVITY_LEVELS = ['low', 'moderate', 'high'] as const;
export const weatherSensitivityLevelSchema = z.enum(WEATHER_SENSITIVITY_LEVELS);
export type WeatherSensitivityLevel = z.infer<typeof weatherSensitivityLevelSchema>;

/** How much sky the traveller is under, and how much shelter is within reach. */
export const WEATHER_EXPOSURES = [
  /** Indoors, or with indoors always a few steps away. */
  'indoor',
  /** Part indoors, part out — a village street, a lift cabin and a summit deck. */
  'mixed',
  /** Outdoors, but in trees, in a canyon, or short enough to wait out. */
  'sheltered_outdoor',
  /** Outdoors with nothing between you and the weather for the whole visit. */
  'exposed_outdoor',
] as const;
export const weatherExposureSchema = z.enum(WEATHER_EXPOSURES);
export type WeatherExposure = z.infer<typeof weatherExposureSchema>;

export const placeWeatherProfileSchema = z.object({
  exposure: weatherExposureSchema,
  /** Rain or snow falling on you while you do it. */
  precipitation: weatherSensitivityLevelSchema,
  /** Wind at the place itself — a ridge pull-out, a treeless plateau. */
  wind: weatherSensitivityLevelSchema,
  /** Heat, weighted by shade, water and how long you are out in it. */
  heat: weatherSensitivityLevelSchema,
  /** Cold and snow underfoot, once the road itself is already open. */
  cold: weatherSensitivityLevelSchema,
  /**
   * The view is the product. Cloud, haze or fog does not make it unpleasant, it
   * makes it pointless — and that is a different decision from getting wet.
   */
  visibilityDependent: z.boolean(),
  /**
   * Genuinely worth doing *instead*, when the weather has taken something else.
   * Not "survivable in rain" — the bar is that a traveller sent here on a bad
   * day gets a good afternoon rather than a consolation prize.
   */
  poorWeatherBackup: z.boolean(),
  /**
   * The approach degrades when wet, whatever the place itself is like.
   *
   * A **comfort and difficulty** signal, and nothing stronger. "Degrades" is the
   * honest verb for a washboard road that gets greasy, a sandy forest track that
   * a normal car handles better dry, three miles of unsurfaced approach that is
   * rougher after rain. It makes the drive worse. It does not make the visit
   * impossible, unsafe or illegal, and it must never be read as though it did —
   * every one of the six Eastern Sierra records carrying it is sourced to phrases
   * like "can be rough" and "fine for a normal car when dry", which is a warning,
   * not a closure.
   *
   * Kept separate from the activity's own sensitivity because Wild Willy's is
   * lovely in falling snow and is reached by a dirt track that turns to mud: the
   * copy has to be able to say which of the two is the problem.
   *
   * For the far stronger claim, see `dryConditionsRequired`.
   */
  approachDegradesWhenWet: z.boolean(),
  /**
   * A published statement that this place cannot be visited in wet conditions.
   *
   * The **only** weather fact about a place that may take it off the plan, and
   * the bar is deliberately set where a product should set it: not "the road is
   * worse", not "the forecast looks bad", but an operator or land manager saying
   * in print that wet ground closes it — a gated wash, a clay road the county
   * shuts, a via ferrata the concessionaire will not run in rain.
   *
   * It carries its own provenance rather than being a bare boolean, which means
   * it is *unrepresentable* without naming a source and a date. That is not
   * ceremony: a hard block removes something a traveller asked for, and the
   * refine below refuses anything short of `official` because
   * "somebody wrote this down once" is not enough to do that on.
   *
   * No place in the current Eastern Sierra fixture qualifies. Every candidate
   * was read against its own source and every one of them describes difficulty
   * rather than closure, so the field is exercised by tests through a patched
   * dataset — the same shape the reservation model has lived in since slice 4.
   */
  dryConditionsRequired: z
    .object({
      /** What the operator actually says, in their words where possible. */
      reason: z.string().min(1),
      provenance: sourceProvenanceSchema,
    })
    .refine((value) => value.provenance.kind === 'official', {
      message:
        'A dry-conditions requirement may only rest on an official source: it is the one weather fact that removes a place from a plan',
      path: ['provenance'],
    })
    .optional(),
  /** One sentence, shown when the profile alone would not explain the verdict. */
  note: z.string().min(1).optional(),
});
export type PlaceWeatherProfile = z.infer<typeof placeWeatherProfileSchema>;

/** `${locationId}|${date}` — the key both the dataset and the planner index on. */
export function weatherKey(locationId: string, date: string): string {
  return `${locationId}|${date}`;
}

export function findWeatherLocationForPlace(
  dataset: WeatherDataset,
  placeId: string,
): WeatherLocation | undefined {
  return dataset.locations.find((location) => location.placeIds.includes(placeId));
}

export function findDayWeather(
  dataset: WeatherDataset,
  locationId: string,
  date: string,
): DayWeather | undefined {
  return dataset.days.find((day) => day.locationId === locationId && day.date === date);
}

export function findSolarDay(
  dataset: WeatherDataset,
  locationId: string,
  date: string,
): SolarDay | undefined {
  return dataset.solar.find((entry) => entry.locationId === locationId && entry.date === date);
}

/**
 * Whether a forecast has aged past the window it was issued for.
 *
 * Takes `now` rather than reading the clock, because a stale-data test that has
 * to wait six hours is a test nobody runs, and because the planner may not read
 * a clock at all.
 */
export function isForecastStale(day: ForecastDayWeather, now: Date): boolean {
  const fetched = Date.parse(day.fetchedAt);
  if (Number.isNaN(fetched)) return true;
  return now.getTime() - fetched > day.staleAfterMinutes * 60_000;
}
