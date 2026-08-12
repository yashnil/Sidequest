import 'server-only';
import { createHash } from 'node:crypto';
import {
  CLIMATE_DATASET_VERSION,
  climateProfileSchema,
  type ClimateProfile,
} from '@sidequest/core';
import { readProviderCache, writeProviderCache } from '../db/compiler-repository';
import { aggregateNormals, climateWindow, daylightHoursByMonth } from './openmeteo';

/**
 * THE CLIMATE CACHE, KEYED ON THE RULES THAT PRODUCED ITS CONTENTS.
 *
 * A cached climate profile is not a copy of something a provider said. Roughly
 * half of it — every daylight hour, every threshold count, the sample window
 * itself — is *computed here* from the daily records, so the row in the cache is
 * an artifact of this repository's arithmetic as much as of Open-Meteo's data.
 *
 * That is what the old key `climate|35.68|139.76` got wrong, and it is not a
 * theoretical complaint. `daylightHoursByMonth` used to ask `solarEventsFor` for
 * sunrise and sunset with a zero UTC offset and subtract them; nine time zones
 * east of Greenwich the sunrise minute clamped at midnight and the difference
 * read as a short day. The arithmetic was repaired — Tokyo's June is 14.5 hours
 * again, pinned by `climate.test.ts` — and not one traveller saw the repair,
 * because the key said nothing about which arithmetic had filled the row. The
 * running product's own database still held
 *
 *     climate|35.68|139.76  →  June 10.0 h, December 7.5 h, written 8 August
 *
 * with a thirty-day expiry, so Tokyo's date guidance would have gone on quoting
 * ten hours of June daylight until 7 September no matter how correct the code
 * underneath it became.
 *
 * So the key carries a fingerprint of the derivation, and the fingerprint is
 * *computed from the derivation* rather than typed in beside it. A hand-kept
 * version number is a promise that whoever next edits the day-length maths will
 * remember to bump it; this is the same guarantee with nobody's memory in it.
 * When the arithmetic moves, the fingerprint moves, every existing row becomes
 * unreachable, and the next read is a miss that refetches.
 *
 * OLD ROWS ARE REFUSED, NOT MIGRATED. There is deliberately no upgrade path. A
 * profile computed by rules we no longer hold cannot be repaired into one
 * computed by the rules we do hold — the daily records it was folded from are
 * not in the row — so the only honest thing to do with it is to stop reading it
 * and ask again. Refetching costs one request per destination per month.
 */

/** A climate normal computed from twenty years does not move in a month. */
export const CLIMATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The points the daylight derivation is fingerprinted at.
 *
 * Three, chosen because between them they exercise every branch of the day
 * length code rather than because anybody plans trips there:
 *
 *   - Tokyo is where the defect showed. Nine zones east of Greenwich, which is
 *     precisely the condition the old clock-based subtraction could not survive.
 *   - Svalbard is inside the Arctic Circle, so it exercises the polar-day and
 *     polar-night branches, which return 24 and 0 rather than a duration.
 *   - The southern point is below the equator *and* west of Greenwich, so a
 *     change that quietly worked only for one hemisphere or one sign of
 *     longitude cannot slip through with the fingerprint unchanged.
 */
export const DERIVATION_PROBE_POINTS = [
  { label: 'daylight:tokyo', lat: 35.6764, lng: 139.65 },
  { label: 'daylight:svalbard', lat: 78.2, lng: 15.6 },
  { label: 'daylight:southern', lat: -41.5, lng: -172.83 },
] as const;

/** Fixed, so the fingerprint describes the code rather than the calendar. */
const PROBE_YEAR = 2025;

/** Fixed for the same reason: `climateWindow` is a function of `now`. */
const PROBE_NOW = new Date('2026-01-01T00:00:00.000Z');

export interface DerivationSegment {
  readonly label: string;
  readonly values: readonly number[];
}

/**
 * Twenty-four months of synthetic daily records.
 *
 * Not a fixture of any real place — its job is to be pushed through
 * `aggregateNormals` so that the *aggregation* is fingerprinted too, and for
 * that it only has to straddle every threshold the aggregation applies. It does:
 * the highs climb past 32 °C, the lows fall below zero, the precipitation
 * crosses 1 mm and the snowfall crosses 0.1 cm, and every thirteenth high is
 * null so that the skip-do-not-zero rule is exercised as well.
 *
 * Twenty-eight days a month, so the shape owes nothing to month lengths or leap
 * years — a probe that changed value in 2028 would be a fingerprint that
 * invalidated the world's climate cache on a Tuesday.
 */
function probeDaily(): {
  time: string[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_sum: (number | null)[];
  snowfall_sum: (number | null)[];
} {
  const time: string[] = [];
  const temperature_2m_max: (number | null)[] = [];
  const temperature_2m_min: (number | null)[] = [];
  const precipitation_sum: (number | null)[] = [];
  const snowfall_sum: (number | null)[] = [];

  let index = 0;
  for (const year of [2023, 2024]) {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 28; day += 1) {
        time.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        const high = day + month * 2 - 12;
        temperature_2m_max.push(index % 13 === 0 ? null : high);
        temperature_2m_min.push(high - 10);
        precipitation_sum.push((day % 5) * 0.5);
        snowfall_sum.push((day % 7) * 0.05);
        index += 1;
      }
    }
  }
  return { time, temperature_2m_max, temperature_2m_min, precipitation_sum, snowfall_sum };
}

/**
 * Everything about this build that decides what a stored profile contains.
 *
 * Returned as labelled segments rather than one flat array so that a test can
 * assert a particular half is *present* — the failure this whole file exists to
 * prevent is not a wrong fingerprint, it is a fingerprint that stopped watching
 * the thing that changed.
 */
export function derivationProbe(): DerivationSegment[] {
  const window = climateWindow(PROBE_NOW);
  const segments: DerivationSegment[] = [
    { label: 'schema', values: [CLIMATE_DATASET_VERSION] },
    { label: 'window', values: [window.yearFrom, window.yearTo] },
  ];

  for (const point of DERIVATION_PROBE_POINTS) {
    segments.push({
      label: point.label,
      values: daylightHoursByMonth(point.lat, point.lng, PROBE_YEAR).map(round1),
    });
  }

  const aggregated = aggregateNormals({
    daily: probeDaily(),
    // A flat column, so this segment moves for aggregation changes only.
    daylightHours: Array.from({ length: 12 }, () => 12),
  });
  segments.push({
    label: 'aggregate',
    values: aggregated.flatMap((normal) => [
      normal.temperature.low,
      normal.temperature.high,
      normal.precipitationMm,
      normal.wetDays,
      normal.snowDays,
      normal.hotDays,
      normal.freezeDays,
    ]),
  });

  return segments;
}

/**
 * Rounded to a tenth — the precision the traveller is actually shown.
 *
 * `PlanFlow` prints `14.5h daylight` and the tradeoff sentences print one
 * decimal, so a tenth is exactly the line between "the answer on screen changed"
 * and "it did not". It also puts the fingerprint safely clear of the last bits
 * of `Math.acos`, which are not promised to be identical across V8 builds; a
 * fingerprint that drifted between two machines would cost a refetch rather than
 * serve a wrong number, but it would still be a cache that never hit.
 */
function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export function fingerprintOf(segments: readonly DerivationSegment[]): string {
  const text = segments.map((segment) => `${segment.label}=${segment.values.join(',')}`).join(';');
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * What this build's climate arithmetic is, as twelve hex characters.
 *
 * Computed once at module load: the probe is three day-length columns and one
 * fold over 672 synthetic days, which is microseconds, and paying it per cache
 * read would be the only way this could ever matter.
 */
export const CLIMATE_DERIVATION_VERSION = fingerprintOf(derivationProbe());

/**
 * Coordinates rounded to two decimals — about a kilometre — because two bases in
 * the same valley share a climate and paying twice for that would be waste.
 * Rounded rather than exact so the key is stable across a centroid that shifts
 * by metres between index releases.
 *
 * The version segment is first after the prefix so that an operator reading
 * `provider_cache` can see at a glance which rows belong to the running build.
 */
export function climateCacheKey(
  center: { lat: number; lng: number },
  version: string = CLIMATE_DERIVATION_VERSION,
): string {
  return `climate|d${version}|${center.lat.toFixed(2)}|${center.lng.toFixed(2)}`;
}

/**
 * A stored profile, or nothing.
 *
 * Validated rather than cast. `readProviderCache` hands back `JSON.parse(...) as
 * T`, which is a promise the row still matches the type — and a cache row is the
 * one place in the system where that promise is written by an older version of
 * this program. The key already refuses rows from a different *derivation*; this
 * refuses rows from a different *shape*, which is the failure that would
 * otherwise surface as `undefined.toFixed(1)` inside a rendering component.
 *
 * A row that fails validation is left where it is to expire rather than deleted:
 * the next write for this key overwrites it anyway, and a read path that mutates
 * on a bad parse is a read path that can fail while reading.
 */
export function readCachedClimate(
  center: { lat: number; lng: number },
  now: Date,
): ClimateProfile | null {
  const raw = readProviderCache<unknown>(climateCacheKey(center), now);
  if (raw === null) return null;
  const parsed = climateProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function writeCachedClimate(
  center: { lat: number; lng: number },
  profile: ClimateProfile,
  now: Date,
): void {
  writeProviderCache(climateCacheKey(center), 'open-meteo-climate', profile, CLIMATE_TTL_MS, now);
}
