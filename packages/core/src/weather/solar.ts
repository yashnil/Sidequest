import { assertCalendarDate } from '../schemas/calendar';
import type { Coordinates } from '../schemas/common';
import type { SolarDay, WeatherLocation } from '../schemas/weather';

/**
 * SUNRISE AND SUNSET — computed, not fetched, and deliberately not weather.
 *
 * Two places in the Eastern Sierra are officially signed for daylight use only:
 * the Manzanar tour route and the Mammoth Lakes Basin. Until now Sidequest
 * recorded that fact and then said, on every surface, that it had no way to work
 * out how much light the traveller's dates gave them. This closes that.
 *
 * It is computed locally rather than read off the forecast provider for one
 * reason that matters: **the sun is not a prediction.** It will clear the horizon
 * at 05:58 on 30 July at this latitude whether or not anybody's model is
 * reachable, so a daylight constraint must not evaporate because a weather
 * request timed out. Fetching it alongside the forecast would tie an
 * astronomical certainty to a network call, and would invite a UI that stamps a
 * freshness warning on it.
 *
 * The algorithm is NOAA's, in the form published for the General Solar Position
 * Calculator, using the standard 90.833° zenith for apparent sunrise — which
 * folds in atmospheric refraction and the sun's radius. It is accurate to about
 * a minute at these latitudes, which is far finer than any scheduling decision
 * made from it. Elevation is not corrected for: the extra minute or two of light
 * from standing 900 m up is inside the error of the surrounding plan.
 *
 * Output is in the domain's time model — minutes from *local* midnight — so the
 * caller supplies the offset from UTC rather than a zone name. Resolving an IANA
 * zone to an offset needs a date and a rules database; the one caller that has
 * both does it once, at the boundary, and passes a number.
 */

const DEGREES = Math.PI / 180;

/** Apparent sunrise/sunset: 90° plus refraction and the solar radius. */
const ZENITH_DEGREES = 90.833;

export type SolarEvents =
  | { kind: 'normal'; sunriseMinute: number; sunsetMinute: number }
  /** Above the Arctic or Antarctic circle in the right season. Not the Sierra. */
  | { kind: 'polar_day' }
  | { kind: 'polar_night' };

/** Days since 1899-12-30, the epoch NOAA's spreadsheet uses. */
function serialDay(date: string): number {
  const parsed = assertCalendarDate(date);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((parsed.getTime() - epoch) / 86_400_000);
}

/**
 * Sunrise and sunset for one date at one point.
 *
 * `utcOffsetMinutes` is the offset in force *on that date* (so −420 for Pacific
 * Daylight Time, −480 for Pacific Standard Time). Getting it wrong shifts every
 * daylight decision by an hour, which is why the boundary resolves it from a
 * real zone database rather than this file guessing.
 */
export function solarEventsFor(
  coordinates: Coordinates,
  date: string,
  utcOffsetMinutes: number,
): SolarEvents {
  // NOAA's calculation is anchored at local solar noon, so it needs the local
  // date expressed as a fraction of a day past the epoch.
  const julianDay = serialDay(date) + 2_415_018.5 - utcOffsetMinutes / 1440;
  const julianCentury = (julianDay - 2_451_545) / 36_525;

  const geomMeanLongSun =
    (280.46646 + julianCentury * (36_000.76983 + julianCentury * 0.0003032)) % 360;
  const geomMeanAnomSun = 357.52911 + julianCentury * (35_999.05029 - 0.0001537 * julianCentury);
  const eccentEarthOrbit =
    0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);

  const sunEqOfCtr =
    Math.sin(geomMeanAnomSun * DEGREES) *
      (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
    Math.sin(2 * geomMeanAnomSun * DEGREES) * (0.019993 - 0.000101 * julianCentury) +
    Math.sin(3 * geomMeanAnomSun * DEGREES) * 0.000289;

  const sunTrueLong = geomMeanLongSun + sunEqOfCtr;
  const sunAppLong =
    sunTrueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * julianCentury) * DEGREES);

  const meanObliqEcliptic =
    23 +
    (26 +
      (21.448 -
        julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813))) /
        60) /
      60;
  const obliqCorr =
    meanObliqEcliptic + 0.00256 * Math.cos((125.04 - 1934.136 * julianCentury) * DEGREES);

  const sunDeclin =
    Math.asin(Math.sin(obliqCorr * DEGREES) * Math.sin(sunAppLong * DEGREES)) / DEGREES;

  const varY = Math.tan((obliqCorr / 2) * DEGREES) ** 2;
  const equationOfTime =
    4 *
    (varY * Math.sin(2 * geomMeanLongSun * DEGREES) -
      2 * eccentEarthOrbit * Math.sin(geomMeanAnomSun * DEGREES) +
      4 *
        eccentEarthOrbit *
        varY *
        Math.sin(geomMeanAnomSun * DEGREES) *
        Math.cos(2 * geomMeanLongSun * DEGREES) -
      0.5 * varY * varY * Math.sin(4 * geomMeanLongSun * DEGREES) -
      1.25 * eccentEarthOrbit * eccentEarthOrbit * Math.sin(2 * geomMeanAnomSun * DEGREES)) /
    DEGREES;

  const latRad = coordinates.lat * DEGREES;
  const declRad = sunDeclin * DEGREES;
  const cosHourAngle =
    Math.cos(ZENITH_DEGREES * DEGREES) / (Math.cos(latRad) * Math.cos(declRad)) -
    Math.tan(latRad) * Math.tan(declRad);

  // Outside ±1 the sun never crosses the horizon that day. Representing both
  // ends explicitly rather than clamping keeps a caller from scheduling a
  // "daylight" activity through an Arctic winter.
  if (cosHourAngle > 1) return { kind: 'polar_night' };
  if (cosHourAngle < -1) return { kind: 'polar_day' };

  const hourAngle = Math.acos(cosHourAngle) / DEGREES;
  const solarNoonMinutes = 720 - 4 * coordinates.lng - equationOfTime + utcOffsetMinutes;

  const sunriseMinute = Math.round(solarNoonMinutes - hourAngle * 4);
  const sunsetMinute = Math.round(solarNoonMinutes + hourAngle * 4);

  return {
    kind: 'normal',
    sunriseMinute: Math.max(0, Math.min(1440, sunriseMinute)),
    sunsetMinute: Math.max(0, Math.min(1440, sunsetMinute)),
  };
}

/**
 * Solar records for every location across every trip date.
 *
 * `computedAt` is passed in rather than read from the clock so the whole dataset
 * stays reproducible; `source` names the algorithm rather than a provider,
 * because there is no provider to name.
 */
export function buildSolarDays(input: {
  locations: readonly WeatherLocation[];
  dates: readonly string[];
  utcOffsetMinutesFor: (location: WeatherLocation, date: string) => number;
  computedAt: string;
}): SolarDay[] {
  const days: SolarDay[] = [];
  for (const location of input.locations) {
    for (const date of input.dates) {
      const events = solarEventsFor(
        location.coordinates,
        date,
        input.utcOffsetMinutesFor(location, date),
      );
      if (events.kind !== 'normal') continue;
      days.push({
        locationId: location.id,
        date,
        sunriseMinute: events.sunriseMinute,
        sunsetMinute: events.sunsetMinute,
        source: SOLAR_SOURCE,
        computedAt: input.computedAt,
      });
    }
  }
  return days;
}

export const SOLAR_SOURCE = 'NOAA solar position algorithm, computed locally';

/**
 * How much of the light either side of the horizon a plan may use.
 *
 * Civil twilight gives roughly half an hour of usable light at these latitudes,
 * and a signed "sunrise to sunset" site is not patrolled to the minute. But an
 * itinerary that walks somebody back to a car park in the dark has failed them,
 * so the buffer runs the safe way: a daylight-only visit must *finish* this many
 * minutes before sunset, and may not *start* before sunrise.
 *
 * Central and named so it cannot be re-decided differently in three files.
 */
export const DAYLIGHT_END_BUFFER_MINUTES = 30;
