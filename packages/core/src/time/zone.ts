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
