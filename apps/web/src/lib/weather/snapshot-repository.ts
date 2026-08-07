import 'server-only';
import {
  WEATHER_OPERATION_VERSION,
  WEATHER_SNAPSHOT_VERSION,
  horizonOf,
  snapshotWindow,
  unavailableWeatherDataset,
  weatherSnapshotSchema,
  type WeatherDataset,
  type WeatherLocation,
  type WeatherRefresh,
  type WeatherSnapshot,
} from '@sidequest/core';
import { getDb } from '../db/client';

/**
 * THE STORED WEATHER, AND THE ONLY DOOR A RENDER PATH GOES THROUGH.
 *
 * Every function here is a database read or a database write. Nothing in this
 * file can reach a provider, and that is the property the render-purity
 * architecture test asserts: `lib/region.ts` imports *this*, and this imports
 * only `@sidequest/core` and the local driver. The module that chooses and runs
 * the live forecast provider — `lib/weather/index.ts` — is reachable from the
 * refresh server action and from nowhere on a render path.
 *
 * The split is the whole design. Before it, resolving a region during render
 * called `resolveTripWeather`, so a page load was an outbound request. The table
 * is `weather_snapshots`, one row per (trip, scope), replaced by a refresh and
 * never written by a render.
 */

/**
 * The fingerprint of the question that was asked.
 *
 * Region, dates and the exact points, in a stable order. A snapshot whose key
 * does not match the current request is a snapshot for a *different question*,
 * and serving it would mean a traveller who moved their dates by a month being
 * shown the forecast for the month they left behind — with a timestamp on it
 * saying it was fetched an hour ago, which is true and completely misleading.
 *
 * The coordinates are in the key rather than only the location ids, because a
 * recompiled region can keep an id and move the point it refers to.
 */
export function weatherScopeKey(input: {
  regionId: string;
  dates: readonly string[];
  locations: readonly WeatherLocation[];
}): string {
  const points = input.locations
    .map((location) => `${location.id}@${location.coordinates.lat},${location.coordinates.lng}`)
    .sort()
    .join(';');
  const span = `${input.dates[0] ?? '-'}..${input.dates[input.dates.length - 1] ?? '-'}`;
  return [
    'v1',
    WEATHER_SNAPSHOT_VERSION,
    input.regionId,
    span,
    input.dates.length,
    points,
  ].join('|');
}

interface SnapshotRow {
  payload_json: string;
}

/**
 * The snapshot for this exact question, or null.
 *
 * A row that will not parse is treated as absent and deleted, the same policy
 * the provisional board follows: a snapshot is a convenience, and losing one
 * costs a badge rather than a plan. What it must never do is fall back to a row
 * for a *different* scope — that is the silent-wrong-answer case above.
 */
export function getWeatherSnapshot(tripId: string, scopeKey: string): WeatherSnapshot | null {
  let row: SnapshotRow | undefined;
  try {
    row = getDb()
      .prepare<[string, string], SnapshotRow>(
        'SELECT payload_json FROM weather_snapshots WHERE trip_id = ? AND scope_key = ?',
      )
      .get(tripId, scopeKey);
  } catch (error) {
    console.error('Could not read the weather snapshot', error);
    return null;
  }
  if (!row) return null;

  const parsed = weatherSnapshotSchema.safeParse(safeJson(row.payload_json));
  if (parsed.success) return parsed.data;

  try {
    getDb()
      .prepare('DELETE FROM weather_snapshots WHERE trip_id = ? AND scope_key = ?')
      .run(tripId, scopeKey);
  } catch {
    // Nothing useful to do. The read path already degrades to "not fetched".
  }
  return null;
}

/** Every snapshot this trip holds, newest first. For diagnostics, not for render. */
export function listWeatherSnapshots(tripId: string): WeatherSnapshot[] {
  try {
    const rows = getDb()
      .prepare<[string], SnapshotRow>(
        'SELECT payload_json FROM weather_snapshots WHERE trip_id = ? ORDER BY fetched_at DESC',
      )
      .all(tripId);
    const out: WeatherSnapshot[] = [];
    for (const row of rows) {
      const parsed = weatherSnapshotSchema.safeParse(safeJson(row.payload_json));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  } catch (error) {
    console.error('Could not list weather snapshots', error);
    return [];
  }
}

export interface SnapshotWriteInput {
  tripId: string;
  regionId: string;
  scopeKey: string;
  dates: readonly string[];
  locations: readonly WeatherLocation[];
  dataset: WeatherDataset;
  fetchedAt: Date;
  refresh: WeatherRefresh;
  /** The model run or dataset the provider named. Null rather than guessed. */
  model?: string | null;
}

/**
 * Builds the snapshot record. Pure: it decides windows and provenance and writes
 * nothing, so the shape can be tested without a database.
 *
 * The freshness window follows what the dataset *turned out* to hold rather than
 * what was requested. A trip that asked for a forecast and got ten years of
 * reanalysis because it is eleven months out should not be re-fetched hourly for
 * an answer that will not change this month.
 */
export function buildWeatherSnapshot(input: SnapshotWriteInput): WeatherSnapshot {
  const horizon = horizonOf(input.dataset);
  const window = snapshotWindow(horizon, input.fetchedAt);

  /*
   * Attribution is lifted off the days themselves rather than off the provider
   * name, because the obligation attaches to the numbers. A dataset that mixes a
   * forecast and an archive carries two notices, and a snapshot that recorded
   * only "whoever we asked" would render one of them.
   */
  const attribution = new Map<string, WeatherSnapshot['attribution'][number]>();
  for (const day of input.dataset.days) {
    if (day.kind === 'unavailable') continue;
    attribution.set(`${day.attribution.provider}|${day.attribution.url}`, day.attribution);
  }

  return weatherSnapshotSchema.parse({
    schemaVersion: WEATHER_SNAPSHOT_VERSION,
    tripId: input.tripId,
    regionId: input.regionId,
    scopeKey: input.scopeKey,
    provider: input.dataset.providerName,
    model: input.model ?? null,
    fetchedAt: input.fetchedAt.toISOString(),
    staleAfter: window.staleAfter,
    validUntil: window.validUntil,
    horizon,
    dates: [...input.dates],
    locations: [...input.locations],
    attribution: [...attribution.values()],
    operationVersion: WEATHER_OPERATION_VERSION,
    refresh: input.refresh,
    dataset: input.dataset,
  });
}

/**
 * Replaces the row for this (trip, scope).
 *
 * One row per question rather than a history, because a history of forecasts is
 * a research artifact and this is a badge on a page. The trip's other scopes are
 * left alone: a traveller who moved their dates and moved them back should get
 * their snapshot again rather than a fresh bill.
 */
export function saveWeatherSnapshot(snapshot: WeatherSnapshot): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO weather_snapshots
           (trip_id, scope_key, schema_version, status, provider, fetched_at, valid_until, payload_json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(trip_id, scope_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           status         = excluded.status,
           provider       = excluded.provider,
           fetched_at     = excluded.fetched_at,
           valid_until    = excluded.valid_until,
           payload_json   = excluded.payload_json`,
      )
      .run(
        snapshot.tripId,
        snapshot.scopeKey,
        snapshot.schemaVersion,
        snapshot.refresh.status,
        snapshot.provider,
        snapshot.fetchedAt,
        snapshot.validUntil,
        JSON.stringify(snapshot),
      );
  } catch (error) {
    // A snapshot that will not store is not a reason to fail the operation that
    // produced it: the traveller has their weather for this render either way,
    // and the next page load falls back to "not fetched" rather than to an
    // error page.
    console.error('Could not store the weather snapshot', error);
  }
}

/**
 * Records that a refresh was attempted and how it went.
 *
 * **The first attempt is the one that matters, and it used to be the one that
 * persisted nothing.** This function returned early when no snapshot existed —
 * which is exactly the state the button exists for. A traveller who pressed
 * "Fetch the weather" on a trip that had never fetched, and hit an outage, got
 * an identical page and no way to tell an outage from a dead click. The comment
 * defending it said that inventing an empty snapshot would claim coverage that
 * was never fetched, and that reasoning is right about the *danger* and wrong
 * about the *remedy*.
 *
 * The remedy is a row whose dataset says, day by day, that nothing is known.
 * `unavailableWeatherDataset` produces exactly that: every day `kind:
 * 'unavailable'` with a reason and the provider that was attempted, and
 * `weatherCoverageOf` reads it back as `none`. So the row records the attempt
 * without claiming a single number — which is the distinction the old early
 * return could not express, because it had only "a row" and "no row".
 *
 * `shape` is required to write one. A caller that cannot say which region, dates
 * and points were asked about has not attempted a fetch in any meaningful sense,
 * and gets the old behaviour: update an existing row, or do nothing.
 */
export function recordRefreshOutcome(
  tripId: string,
  scopeKey: string,
  refresh: WeatherRefresh,
  shape?: {
    regionId: string;
    dates: readonly string[];
    locations: readonly WeatherLocation[];
    now: Date;
    reason: 'not_configured' | 'provider_error' | 'outside_supported_range';
    message: string;
  },
): void {
  const existing = getWeatherSnapshot(tripId, scopeKey);
  if (existing) {
    saveWeatherSnapshot({ ...existing, refresh });
    return;
  }
  if (!shape) return;
  if (shape.dates.length === 0 || shape.locations.length === 0) return;

  saveWeatherSnapshot(
    buildWeatherSnapshot({
      tripId,
      regionId: shape.regionId,
      scopeKey,
      dates: shape.dates,
      locations: shape.locations,
      dataset: unavailableWeatherDataset({
        regionId: shape.regionId,
        locations: shape.locations,
        dates: shape.dates,
        now: shape.now,
        reason: shape.reason,
        message: shape.message,
      }),
      fetchedAt: shape.now,
      model: null,
      refresh,
    }),
  );
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
