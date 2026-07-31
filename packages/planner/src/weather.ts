import {
  DAYLIGHT_END_BUFFER_MINUTES,
  evaluateWeather,
  findDayWeather,
  findSolarDay,
  findWeatherLocationForPlace,
  intersectMinuteIntervals,
  type Avoidance,
  type DayWeather,
  type MinuteInterval,
  type Place,
  type SolarDay,
  type PlaceWeatherProfile,
  type WeatherAssessment,
  type WeatherDataset,
  type WeatherLocation,
} from '@sidequest/core';

/**
 * WHERE WEATHER MEETS A TRAVELLER'S DAY.
 *
 * The counterpart to `hours.ts`, and deliberately weaker than it. Opening hours
 * answer a question of fact — the gate is locked at 16:30 — so that layer
 * decides legality. This one answers a question about a model's opinion of
 * Thursday, so it decides preference, and the one place it is allowed to be
 * hard is daylight, which is not weather at all.
 *
 * The whole file is a pure function of data handed in. Nothing here fetches
 * anything; `plan.ts` stays a pure function and stays reproducible.
 */

export interface PlaceDayWeather {
  placeId: string;
  date: string;
  locationId: string;
  locationLabel: string;
  /** What this point cannot speak for. Carried so the UI can say it. */
  locationLimitation: string;
  assessment: WeatherAssessment;
  evidence: DayWeather;
  solar: SolarDay | undefined;
  /** The place's own canonical profile, carried so consumers need not re-look it up. */
  profile: PlaceWeatherProfile;
}

export function weatherKeyFor(placeId: string, date: string): string {
  return `${placeId}|${date}`;
}

export interface ResolveWeatherInput {
  places: readonly { place: Place; durationMinutes: number; daylightOnly: boolean }[];
  dates: readonly string[];
  dataset: WeatherDataset;
  avoidances: readonly Avoidance[];
}

/**
 * Every place against every date, computed once.
 *
 * Eager for the same reason the hours map is: day assignment has to know that
 * Tuesday is the clear day *before* it decides which cluster Tuesday gets.
 * Discovering it during layout means the exposed ridge is already on Thursday
 * and the only remaining move is to drop it.
 */
export function resolveWeather(input: ResolveWeatherInput): Map<string, PlaceDayWeather> {
  const resolved = new Map<string, PlaceDayWeather>();
  const locationCache = new Map<string, WeatherLocation | undefined>();

  for (const entry of input.places) {
    const placeId = entry.place.id;
    if (!locationCache.has(placeId)) {
      locationCache.set(placeId, findWeatherLocationForPlace(input.dataset, placeId));
    }
    const location = locationCache.get(placeId);

    for (const date of input.dates) {
      if (!location) {
        // A place no zone claims. The dataset boundary rejects this, so reaching
        // here means somebody bypassed it — say so rather than substituting the
        // nearest forecast, which is how a stop three thousand feet up gets the
        // valley's temperature.
        resolved.set(weatherKeyFor(placeId, date), unmapped(placeId, date));
        continue;
      }
      const evidence =
        findDayWeather(input.dataset, location.id, date) ?? missing(location.id, date);
      const solar = findSolarDay(input.dataset, location.id, date);

      resolved.set(weatherKeyFor(placeId, date), {
        placeId,
        date,
        locationId: location.id,
        locationLabel: location.label,
        locationLimitation: location.limitation,
        evidence,
        solar,
        profile: entry.place.weather,
        assessment: evaluateWeather({
          profile: entry.place.weather,
          day: evidence,
          solar,
          daylightOnly: entry.daylightOnly,
          durationMinutes: entry.durationMinutes,
          avoidances: input.avoidances,
        }),
      });
    }
  }

  return resolved;
}

function unmapped(placeId: string, date: string): PlaceDayWeather {
  const evidence: DayWeather = {
    kind: 'unavailable',
    locationId: 'unmapped',
    date,
    reason: 'no_location_mapping',
    message: 'No weather point covers this place, so its weather has not been checked.',
    attemptedProvider: 'none',
    attemptedAt: '1970-01-01T00:00:00.000Z',
    consideredCache: false,
  };
  return {
    placeId,
    date,
    locationId: 'unmapped',
    locationLabel: 'Unmapped',
    locationLimitation: 'No weather point covers this place.',
    evidence,
    solar: undefined,
    profile: UNKNOWN_PROFILE,
    assessment: evaluateWeather({ profile: UNKNOWN_PROFILE, day: evidence }),
  };
}

/**
 * Stand-in for a place no weather zone claims.
 *
 * Deliberately pessimistic on every axis and never a backup: a place we cannot
 * locate is a place we know nothing about, and the safe way to be wrong is to
 * decline to recommend it rather than to assume it copes.
 */
const UNKNOWN_PROFILE: PlaceWeatherProfile = {
  exposure: 'exposed_outdoor',
  precipitation: 'moderate',
  wind: 'moderate',
  heat: 'moderate',
  cold: 'moderate',
  visibilityDependent: false,
  poorWeatherBackup: false,
  approachDegradesWhenWet: false,
};

function missing(locationId: string, date: string): DayWeather {
  return {
    kind: 'unavailable',
    locationId,
    date,
    reason: 'provider_error',
    message: 'No weather record was returned for this date.',
    attemptedProvider: 'none',
    attemptedAt: '1970-01-01T00:00:00.000Z',
    consideredCache: false,
  };
}

/**
 * The daylight window, when one applies.
 *
 * Returns null when the place is not daylight-limited, or when there is no solar
 * record — and the distinction matters enormously. A missing sunrise must widen
 * nothing and narrow nothing; "we did not work out the light" is not "there is
 * plenty". The caller keeps its existing bounds in that case and the plan says
 * the light was not checked, which is exactly what it said before this slice.
 *
 * The end buffer runs the safe way: a signed sunrise-to-sunset site must be
 * *finished* before the light goes, not merely started.
 */
export function daylightBounds(
  weather: PlaceDayWeather | undefined,
  daylightOnly: boolean,
): MinuteInterval | null {
  if (!daylightOnly || !weather?.solar) return null;
  return {
    startMinute: weather.solar.sunriseMinute,
    endMinute: Math.max(
      weather.solar.sunriseMinute,
      weather.solar.sunsetMinute - DAYLIGHT_END_BUFFER_MINUTES,
    ),
  };
}

/**
 * Narrows a legality window by daylight, through the domain's one intersection.
 *
 * Rolling a `Math.max` here instead is how three stages end up disagreeing about
 * whether an endpoint counts, which is the reason `time/interval.ts` exists.
 */
export function narrowByDaylight(
  bounds: MinuteInterval,
  weather: PlaceDayWeather | undefined,
  daylightOnly: boolean,
): MinuteInterval | null {
  const daylight = daylightBounds(weather, daylightOnly);
  if (!daylight) return bounds;
  return intersectMinuteIntervals(bounds, daylight);
}

/**
 * How much a set of places wants a given date, as a number in 0–1.
 *
 * Only forecast evidence contributes. A day with nothing but historical patterns
 * returns null, and the caller then leaves the assignment exactly as geography
 * made it — because the alternative is ranking Tuesday above Wednesday on the
 * strength of numbers that are, by construction, identical for both.
 *
 * The mean rather than the worst case: a cluster is a whole day's worth of
 * stops, and letting one visibility-dependent viewpoint drag the whole group
 * across the week is how a plan trades four sensible stops for one good photo.
 */
export function weatherPreference(
  placeIds: readonly string[],
  date: string,
  resolved: ReadonlyMap<string, PlaceDayWeather>,
): number | null {
  const scores: number[] = [];
  for (const placeId of placeIds) {
    const entry = resolved.get(weatherKeyFor(placeId, date));
    if (!entry || !entry.assessment.rankable) continue;
    scores.push(entry.assessment.score);
  }
  if (scores.length === 0) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/**
 * Places whose weather is worth mentioning on a day.
 *
 * Only `poor` and `incompatible`, and only when the evidence can actually
 * support the claim. Badging every stop on a clear Tuesday teaches people to
 * stop reading the badges, which is the failure the opening-hours slice went to
 * some trouble to avoid.
 */
export function isWeatherWorthFlagging(entry: PlaceDayWeather | undefined): boolean {
  if (!entry) return false;
  return entry.assessment.suitability === 'poor' || entry.assessment.suitability === 'incompatible';
}
