import { solarEventsFor, twilightFor, TWILIGHT_DEPRESSION_DEGREES, utcOffsetMinutesOn } from '@sidequest/core';

/**
 * THE SKY A STOP IS FOR — SUNRISE, SUNSET AND DARKNESS AT THE REAL HOUR.
 *
 * A blind evaluation of generated trips found a sunset at 16:30 in a southern
 * European city in mid-May (the sun set at about 20:40), stargazing at 18:00 in
 * an alpine July and in a Pacific September (broad daylight), and a sunset at
 * 17:20 in a subarctic late June (the sun barely sets). The cause was one table
 * of fixed floors in the reconciler that said Sidequest "does not have" sunset
 * at that point in the pipeline. It does: the day's base has coordinates, the
 * weather locations carry an IANA zone, and the sun is arithmetic.
 *
 * So a stop whose whole point is the sky is timed to that day's sky:
 *
 * - sunrise: arrive about 25 minutes before the sun clears the horizon;
 * - sunset: start about 50 minutes before sunset, so the visit spans it;
 * - darkness (stargazing, a dark-sky site, the aurora): never before civil dusk
 *   plus an hour, nor before nautical dusk — and when the sun never sinks far
 *   enough that night (a white night), there is no honest hour for it at all.
 *
 * Pure and provider-free. Unknown ≠ false: with no coordinates or no trusted
 * zone this returns `null` and the caller keeps its fixed floors.
 */

export type SkyIntent = 'sunrise' | 'sunset' | 'darkness';

/** Words that mean a stop needs a dark sky, not merely the evening. */
const DARKNESS_WORDS = /\b(stargaz\w*|star[- ]?gazing|night[- ]sky|dark[- ]sky|milky way|astrophotograph\w*|aurora\w*|northern lights|southern lights)\b/i;
const SUNSET_WORDS = /\b(sunset|sundown|dusk)\b/i;
const SUNRISE_WORDS = /\b(sunrise|dawn|daybreak)\b/i;

/**
 * What sky a stop is for. The draft's own `timeOfDay` decides sunrise and
 * sunset; darkness has no time-of-day of its own, so it is read from the name
 * (stated words, never a place name) on a stop that is not pinned to sunrise or
 * sunset. Anything else is not sky-timed and keeps the ordinary floors.
 */
export function skyIntentOf(anchor: { name: string; timeOfDay?: string | undefined }): SkyIntent | null {
  if (anchor.timeOfDay === 'sunrise') return 'sunrise';
  if (anchor.timeOfDay === 'sunset') return 'sunset';
  if (anchor.timeOfDay !== 'morning' && anchor.timeOfDay !== 'midday' && anchor.timeOfDay !== 'afternoon' && DARKNESS_WORDS.test(anchor.name)) return 'darkness';
  return null;
}

/** The same reading for a scheduled item, where only the title survives: name words for all three. Used by the audit. */
export function skyIntentOfTitle(title: string, timeOfDay?: string): SkyIntent | null {
  const stated = skyIntentOf({ name: title, timeOfDay });
  if (stated) return stated;
  if (DARKNESS_WORDS.test(title)) return 'darkness';
  if (SUNSET_WORDS.test(title)) return 'sunset';
  if (SUNRISE_WORDS.test(title)) return 'sunrise';
  return null;
}

export interface DaySky {
  /** Minutes from local midnight; null on a polar day or night. */
  sunriseMinute: number | null;
  sunsetMinute: number | null;
  /** When it is dark enough for stars to be worth the trip, or why it never is that night. */
  darkness: { kind: 'from'; minute: number } | { kind: 'never'; reason: string } | { kind: 'all_night' };
  polar: 'day' | 'night' | null;
}

/** How long before sunrise a sunrise visit begins. */
export const SUNRISE_LEAD_MINUTES = 25;
/** How long before sunset a sunset visit begins, so the visit spans it. */
export const SUNSET_LEAD_MINUTES = 50;
/** After civil dusk, the minutes before a sky is dark enough for stargazing to be honest. */
export const DARKNESS_AFTER_CIVIL_DUSK_MINUTES = 60;
/** Darkness that begins later than this (01:00 the next morning) is not a plannable evening. */
export const LATEST_DARKNESS_START = 25 * 60;

/**
 * A zone Sidequest can trust for this point. The weather location falls back to
 * the literal `UTC` when the destination never resolved a zone; far from
 * Greenwich that fallback would shift every solar hour by the whole offset, so
 * it is treated as unknown rather than as a fact.
 */
export function trustedZone(timeZone: string | undefined, lng: number): string | null {
  if (!timeZone) return null;
  if (/^(Etc\/)?(UTC|GMT|UCT|Zulu|Universal)$/i.test(timeZone) && Math.abs(lng) > 22.5) return null;
  return timeZone;
}

function fmt(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The sky for one date at one point, in the zone's local clock. Null when the inputs cannot honestly produce it. */
export function daySkyFor(point: { lat: number; lng: number } | null, date: string, timeZone: string | undefined): DaySky | null {
  if (!point || (point.lat === 0 && point.lng === 0)) return null;
  const zone = trustedZone(timeZone, point.lng);
  if (!zone) return null;
  let offset: number;
  try {
    offset = utcOffsetMinutesOn(date, zone);
  } catch {
    return null;
  }
  const sun = solarEventsFor(point, date, offset);
  const civil = twilightFor(point, date, offset, TWILIGHT_DEPRESSION_DEGREES.civil);
  const nautical = twilightFor(point, date, offset, TWILIGHT_DEPRESSION_DEGREES.nautical);
  let darkness: DaySky['darkness'];
  if (nautical.kind === 'never_this_light') darkness = { kind: 'all_night' };
  else if (nautical.kind === 'never_this_dark') {
    darkness = { kind: 'never', reason: civil.kind === 'never_this_dark' || sun.kind === 'polar_day' ? 'the sun stays close enough to the horizon all night that the sky never gets dark' : 'the sky stays in twilight all night at this latitude and season, too bright for stars to be worth the trip' };
  } else {
    const fromCivil = civil.kind === 'normal' ? civil.duskMinute + DARKNESS_AFTER_CIVIL_DUSK_MINUTES : nautical.duskMinute;
    const from = Math.max(fromCivil, nautical.duskMinute);
    darkness = from > LATEST_DARKNESS_START ? { kind: 'never', reason: `it does not get dark enough until about ${fmt(from)}, after 01:00` } : { kind: 'from', minute: from };
  }
  return {
    sunriseMinute: sun.kind === 'normal' ? sun.sunriseMinute : null,
    sunsetMinute: sun.kind === 'normal' ? sun.sunsetMinute : null,
    darkness,
    polar: sun.kind === 'polar_day' ? 'day' : sun.kind === 'polar_night' ? 'night' : null,
  };
}

/** Darkness all night (a polar night) still waits for the evening: the floor every darkness stop had before. */
const POLAR_NIGHT_DARKNESS_FLOOR = 18 * 60;

export type SkyTiming =
  | { kind: 'start'; minute: number; event: string }
  | { kind: 'impossible'; reason: string }
  | { kind: 'unknown' };

/** The minute a sky-timed stop should start on this day, or why it cannot honestly happen. */
export function skyStartFor(intent: SkyIntent, sky: DaySky | null): SkyTiming {
  if (!sky) return { kind: 'unknown' };
  if (intent === 'sunrise') return sky.sunriseMinute === null ? { kind: 'unknown' } : { kind: 'start', minute: sky.sunriseMinute - SUNRISE_LEAD_MINUTES, event: `sunrise is at ${fmt(sky.sunriseMinute)}` };
  if (intent === 'sunset') return sky.sunsetMinute === null ? { kind: 'unknown' } : { kind: 'start', minute: sky.sunsetMinute - SUNSET_LEAD_MINUTES, event: `sunset is at ${fmt(sky.sunsetMinute)}` };
  if (sky.darkness.kind === 'never') return { kind: 'impossible', reason: sky.darkness.reason };
  if (sky.darkness.kind === 'all_night') return { kind: 'start', minute: POLAR_NIGHT_DARKNESS_FLOOR, event: 'it is dark all evening' };
  return { kind: 'start', minute: sky.darkness.minute, event: `it is dark enough from about ${fmt(sky.darkness.minute)}` };
}

export { fmt as formatSkyMinute };
