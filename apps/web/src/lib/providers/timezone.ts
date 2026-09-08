import 'server-only';
import { z } from 'zod';
import { isCivilTimeZone } from '@sidequest/core';
import { requestSignal } from '../net/generation-deadline';

/**
 * THE CIVIL TIME ZONE OF A POINT ON THE MAP.
 *
 * The thing this replaces was a longitude derivation: divide by fifteen, round,
 * and call the result a timezone. That is a *solar* answer — right to within
 * half an hour of local noon by construction, and blind to daylight saving, to
 * India's half hour, to Nepal's forty-five minutes, and to every country that
 * has adopted a neighbour's clock. A museum's opening time formatted against it
 * is off by an hour for half the year across most of the inhabited world, and
 * nothing anywhere said the zone had been invented.
 *
 * PROVIDER: Open-Meteo's `timezone=auto`, which resolves a coordinate to an IANA
 * identifier and returns it on the response envelope.
 *
 * It is the right source here for reasons that are about terms rather than about
 * data quality. Open-Meteo is CC BY 4.0 — the answer is **ours to keep**, which
 * a compiled region that lives for weeks absolutely requires. The one obvious
 * alternative, Google's Time Zone API, is unusable for this product: the
 * repository's own re-checked terms note records that `timeZone` and
 * `utcOffsetMinutes` may not be persisted at all, and a zone we may not store is
 * a zone we would have to re-buy on every render.
 *
 * It is also already here. Open-Meteo is the configured weather and climate
 * provider, keyless and free, so this adds no credential, no vendor and no new
 * failure mode to a deployment — which is why it is registered against the
 * capability registry as a real provider rather than as an aspiration.
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * It will not answer from an offset. A fixed-offset identifier (`Etc/GMT+7`,
 * a bare `UTC`) is not a civil zone, and accepting one from a provider would
 * quietly reintroduce the very approximation this exists to retire — so a reply
 * that is not a regional identifier is rejected and reported as unresolved. The
 * caller then labels its fallback `degraded` and says so on screen.
 */

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 8_000;

/** Thirty days. A zone identifier changes when a legislature changes it. */
export const TIME_ZONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Coordinate precision the cache key rounds to.
 *
 * Three decimal places, roughly a hundred metres. Two was the first choice, on
 * the reasoning that a kilometre is "far finer than any zone boundary" — and
 * that is not true of the boundaries that matter: the Nevada/Utah line, the
 * Rhine at Basel, and several Indiana county lines all run through ground where
 * a kilometre cell straddles two clocks. Since points in the same cell are
 * deduplicated to one lookup, a cell spanning a boundary hands the second point
 * the first point's zone — the one thing this adapter promises never to do.
 *
 * Rounding at all is still what makes the cache hit: `38.7169` and `38.71691`
 * are the same question, and two bases in one town still share an answer at a
 * hundred metres only when they are genuinely a hundred metres apart, which is
 * the honest version of that saving.
 */
const KEY_PRECISION = 3;

export function timeZoneCacheKey(point: { lat: number; lng: number }): string {
  return [
    'timezone',
    'open-meteo',
    'v1',
    point.lat.toFixed(KEY_PRECISION),
    point.lng.toFixed(KEY_PRECISION),
  ].join('|');
}

/** Re-exported from the import-free switch module. See `providers/switches.ts`. */
export { isTimeZoneResolverEnabled } from './switches';

const envelopeSchema = z.object({
  timezone: z.string().min(1).optional(),
  /** Present when `timezone=auto` resolved; echoed for the diagnostic only. */
  timezone_abbreviation: z.string().optional(),
  utc_offset_seconds: z.number().optional(),
});

export interface TimeZoneAnswer {
  id: string;
  lat: number;
  lng: number;
  /** An IANA *civil* identifier, or null when none could be established. */
  timeZone: string | null;
  /** Why not, when not. Shown in diagnostics, never as a plan fact. */
  detail: string;
  cached: boolean;
}

export interface TimeZoneLookupOptions {
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => { timeZone: string } | null;
    write: (key: string, value: { timeZone: string }) => void;
  };
  /** Hard ceiling on network calls for this batch. Cached points are free. */
  maxCalls: number;
}

export interface TimeZoneLookupOutcome {
  answers: TimeZoneAnswer[];
  calls: number;
  cacheHits: number;
}

/**
 * Resolve a batch of points, cache first.
 *
 * Points are deduplicated by rounded coordinate before anything is requested, so
 * a destination and the base sitting in the middle of it cost one call between
 * them. The budget is spent in request order and a point beyond it comes back
 * unresolved with a reason — never silently, and never with a neighbour's zone.
 */
export async function resolveCivilTimeZones(
  points: readonly { id: string; lat: number; lng: number }[],
  options: TimeZoneLookupOptions,
): Promise<TimeZoneLookupOutcome> {
  const answers: TimeZoneAnswer[] = [];
  const byKey = new Map<string, string | null>();
  let calls = 0;
  let cacheHits = 0;

  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      answers.push({
        ...point,
        timeZone: null,
        detail: 'This point has no usable coordinates.',
        cached: false,
      });
      continue;
    }

    const key = timeZoneCacheKey(point);
    if (byKey.has(key)) {
      const known = byKey.get(key) ?? null;
      answers.push({
        ...point,
        timeZone: known,
        detail: known ? 'Resolved for a point already looked up in this batch.' : 'Unresolved.',
        cached: true,
      });
      continue;
    }

    const stored = options.cache?.read(key);
    if (stored && isCivilTimeZone(stored.timeZone)) {
      byKey.set(key, stored.timeZone);
      cacheHits += 1;
      answers.push({
        ...point,
        timeZone: stored.timeZone,
        detail: 'Resolved earlier and still current.',
        cached: true,
      });
      continue;
    }

    if (calls >= options.maxCalls) {
      answers.push({
        ...point,
        timeZone: null,
        detail: 'We stopped looking up time zones for this trip before reaching this point.',
        cached: false,
      });
      continue;
    }

    calls += 1;
    const looked = await lookupOne(point, options.fetchImpl ?? fetch);
    byKey.set(key, looked.timeZone);
    if (looked.timeZone) options.cache?.write(key, { timeZone: looked.timeZone });
    answers.push({ ...point, ...looked, cached: false });
  }

  return { answers, calls, cacheHits };
}

async function lookupOne(
  point: { lat: number; lng: number },
  doFetch: typeof fetch,
): Promise<{ timeZone: string | null; detail: string }> {
  const url = new URL(FORECAST_BASE);
  url.searchParams.set('latitude', String(point.lat));
  url.searchParams.set('longitude', String(point.lng));
  url.searchParams.set('timezone', 'auto');
  /*
   * One day, and no variables.
   *
   * The zone travels on the response envelope rather than in the data, so
   * asking for nothing hourly is the smallest request that still carries an
   * answer. `forecast_days=1` is required because the endpoint refuses zero.
   */
  url.searchParams.set('forecast_days', '1');

  let response: Response;
  try {
    response = await doFetch(url, { signal: requestSignal(REQUEST_TIMEOUT_MS) });
  } catch {
    return { timeZone: null, detail: 'The time-zone service did not answer.' };
  }
  if (!response.ok) {
    return { timeZone: null, detail: 'The time-zone service refused the request.' };
  }

  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(await response.json());
  } catch {
    return { timeZone: null, detail: 'The time-zone service returned a shape we cannot read.' };
  }

  const zone = parsed.timezone?.trim() ?? '';
  if (zone.length === 0) {
    return { timeZone: null, detail: 'The service knows this point and publishes no zone for it.' };
  }
  /*
   * A FIXED OFFSET IS NOT AN ANSWER TO THIS QUESTION.
   *
   * Open-Meteo answers `GMT` for points at sea and for a handful of places its
   * boundary set does not cover. Accepting that would put a zone with no
   * daylight saving on a trip and label it authoritative — which is the exact
   * substitution the longitude derivation was demoted for. Rejected here, once,
   * rather than checked by every consumer.
   */
  if (!isCivilTimeZone(zone)) {
    return {
      timeZone: null,
      detail: 'The service could only offer a fixed offset here, not a real local time zone.',
    };
  }
  return { timeZone: zone, detail: 'Resolved from a source that publishes civil time zones.' };
}
