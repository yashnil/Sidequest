import { assertCalendarDate } from '../schemas/calendar';

/**
 * Wall-clock arithmetic against a real IANA zone.
 *
 * These lived in `data/weather.ts` — the Eastern Sierra seed file — because the
 * first thing that needed them was the fixture forecast generator. Nothing about
 * them is region-specific: they are the two operations the domain's
 * minutes-from-local-midnight model needs whenever it has to meet an absolute
 * instant, and a compiled region in any timezone needs them exactly as much.
 */

/**
 * How far ahead any forecast provider is worth asking.
 *
 * A shared default rather than a claim about a particular service: the live
 * adapter re-derives the real horizon from the response it actually got, and
 * this is what the fixture and the tests agree on so a horizon boundary is a
 * property of the test rather than of the afternoon somebody runs it.
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
 * server in Frankfurt deciding at 00:30 that a trip starting "tomorrow" is out
 * of horizon would push a perfectly good forecast into historical patterns for
 * nine hours a day.
 */
export function localDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The offset from UTC in force in `timeZone` on `date`, in minutes. */
export function utcOffsetMinutesOn(date: string, timeZone: string): number {
  // Noon local-ish, so the answer is never taken from the ambiguous hour a
  // daylight-saving transition creates at either end of the day.
  const probe = new Date(`${date}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const part = formatter.formatToParts(probe).find((entry) => entry.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? '');
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Whether a set of zones is really one zone.
 *
 * A compiled region carries every zone its scope spans, and a great many
 * consumers want "the" timezone. Taking `zones[0]` is how a region straddling a
 * boundary silently gets one side's clock applied to both — so the question has
 * to be asked out loud, and answered `null` when the honest answer is "more than
 * one".
 */
export function singleTimeZone(zones: readonly string[]): string | null {
  const distinct = new Set(zones.filter((zone) => zone.length > 0));
  if (distinct.size !== 1) return null;
  return [...distinct][0] ?? null;
}

/**
 * A DESTINATION'S CLOCK, DERIVED, WHEN NOBODY PUBLISHED ONE.
 *
 * `'UTC'` was the fallback everywhere a zone was missing, and it is not a
 * neutral default — it is a claim, and for most of the inhabited world a wrong
 * one by several hours. Every consumer downstream formats opening hours,
 * daylight and forecast day-boundaries with `timeZones[0]`, so a destination
 * nine hours off UTC had its museums opening at midnight and nothing anywhere
 * said the zone had been invented.
 *
 * The longitude is a real measurement we always have, and solar time from it is
 * a **derived deterministic fact** rather than a guess: the returned zone is
 * within half an hour of local solar noon by construction. It is not a
 * political zone — it has no daylight saving and does not know that a country
 * has chosen a neighbour's clock — so callers must record the basis and prefer
 * a published zone whenever one exists.
 *
 * Note the sign. POSIX `Etc/GMT±N` is inverted relative to ISO 8601: UTC+9 is
 * `Etc/GMT-9`. Getting this backwards is an eighteen-hour error, so it is
 * asserted in the tests rather than trusted to a comment.
 */
export function deriveTimeZoneFromLongitude(longitude: number): string {
  if (!Number.isFinite(longitude)) return 'UTC';
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const offsetHours = Math.max(-14, Math.min(14, Math.round(wrapped / 15)));
  if (offsetHours === 0) return 'UTC';
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${Math.abs(offsetHours)}`;
}

/** Where a zone came from. A published zone is worth more than a derived one. */
export const TIME_ZONE_BASES = ['published', 'derived_from_longitude', 'unknown'] as const;
export type TimeZoneBasis = (typeof TIME_ZONE_BASES)[number];

/**
 * The zones to plan in, and how much they are worth.
 *
 * One place that answers "what clock is this destination on", so no consumer
 * has to write `?? 'UTC'` again. Every remaining occurrence of that string in a
 * planning path is a bug this function exists to make unnecessary.
 */
export function resolveTimeZones(input: {
  published: readonly string[];
  center: { lat: number; lng: number };
}): { zones: string[]; basis: TimeZoneBasis } {
  const published = input.published.filter((zone) => zone.trim().length > 0);
  if (published.length > 0) return { zones: [...published], basis: 'published' };
  return {
    zones: [deriveTimeZoneFromLongitude(input.center.lng)],
    basis: 'derived_from_longitude',
  };
}
