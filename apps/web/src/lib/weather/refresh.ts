import 'server-only';
import { weatherCoverageOf, type CompiledRegion } from '@sidequest/core';
import { resolveTripWeather } from './index';
import {
  buildWeatherSnapshot,
  getWeatherSnapshot,
  recordRefreshOutcome,
  saveWeatherSnapshot,
} from './snapshot-repository';

/**
 * FETCHING WEATHER — THE ONLY MODULE ALLOWED TO.
 *
 * The split this file exists to hold:
 *
 * - `snapshot-repository.ts` **reads and writes rows**. It imports no provider,
 *   which is what lets `lib/region.ts` — and therefore four render paths — read
 *   a snapshot without a socket anywhere in the import graph.
 * - This file **buys data**. It imports the provider, and nothing that renders
 *   may import it. The render-purity architecture test is what holds that line.
 *
 * Putting the fetch in the repository would have been one fewer file and would
 * have put Open-Meteo back into `/discover`'s closure through the back door,
 * which is precisely the defect this slice removed.
 */

export interface WeatherFetchTarget {
  tripId: string;
  compiled: CompiledRegion;
  dates: readonly string[];
  scopeKey: string;
}

export type WeatherFetchOutcome =
  | { ok: true; reason: 'fetched' | 'already_fresh' }
  /**
   * The provider answered and had nothing.
   *
   * `ok: true` because nothing went wrong — there is no outage, no retry to
   * schedule and no error to report — and a separate reason because the traveller
   * must not be told the weather was fetched. With the forecast provider switched
   * off, `resolveTripWeather` returns a complete dataset in which every day is
   * `unavailable`; this used to be written down as `succeeded`, and the panel
   * read "Weather: fetched · Fetched recently enough to rely on" over it.
   */
  | { ok: true; reason: 'nothing_available' }
  | { ok: false; reason: 'provider_failed' };

/**
 * Fetch a forecast and persist it, recording the attempt either way.
 *
 * Three properties a render path could never have:
 *
 *   - It is *asked for*. Something explicit called it.
 *   - Its status is persisted, **including a failure**. A refresh that fails and
 *     leaves no trace is a button that appears to do nothing.
 *   - It never mutates the itinerary or the compiled region. A newer forecast
 *     changes what a badge says; it does not silently re-plan somebody's trip
 *     underneath them.
 */
export async function fetchWeatherSnapshot(
  target: WeatherFetchTarget,
): Promise<WeatherFetchOutcome> {
  const requestedAt = new Date();

  /*
   * Marked in progress before the request goes out, so two clicks in quick
   * succession read as one operation running rather than as a button that did
   * nothing. A no-op when there is no snapshot yet: hanging a status off an
   * invented empty row would put coverage in the table that was never fetched.
   */
  recordRefreshOutcome(
    target.tripId,
    target.scopeKey,
    { status: 'in_progress', requestedAt: requestedAt.toISOString() },
    {
      regionId: target.compiled.region.id,
      dates: target.dates,
      locations: target.compiled.weatherLocations,
      now: requestedAt,
      reason: 'provider_error',
      message: 'We are asking now. Nothing here is a claim about the weather yet.',
    },
  );

  try {
    const dataset = await resolveTripWeather({
      regionId: target.compiled.region.id,
      dates: [...target.dates],
      locations: target.compiled.weatherLocations,
      now: requestedAt,
    });

    /*
     * What came back decides what the operation is called.
     *
     * A dataset in which every day is `unavailable` is what a switched-off or
     * out-of-range provider produces, and it is not a success. The status has to
     * be derived from the days rather than from the absence of an exception, or
     * the record says "fetched" about an absence — which is what it did.
     */
    const coverage = weatherCoverageOf(dataset);
    const completedAt = new Date();

    saveWeatherSnapshot(
      buildWeatherSnapshot({
        tripId: target.tripId,
        regionId: target.compiled.region.id,
        scopeKey: target.scopeKey,
        dates: [...target.dates],
        locations: target.compiled.weatherLocations,
        dataset,
        fetchedAt: new Date(),
        /*
         * The provider names no model run, so this is null rather than the
         * provider's own name repeated into a field that means something else.
         * A field populated with the wrong kind of value is worse than an empty
         * one — it looks like provenance.
         */
        model: null,
        refresh: {
          status: coverage === 'none' ? 'returned_nothing' : 'succeeded',
          requestedAt: requestedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          ...(coverage === 'none'
            ? {
                message:
                  'We asked and got nothing usable for your dates. That is a statement about our sources rather than about the weather.',
              }
            : {}),
        },
      }),
    );
    return coverage === 'none'
      ? { ok: true, reason: 'nothing_available' }
      : { ok: true, reason: 'fetched' };
  } catch (error) {
    console.error('Weather fetch failed', error);
    const failedAt = new Date();
    const message = 'The weather source did not answer. What is on screen is unchanged.';
    /*
     * The shape is supplied so that a failure on the *first* attempt persists.
     *
     * This is the path the button exists for — a trip that has never fetched —
     * and it used to be the one path that wrote nothing at all, because
     * `recordRefreshOutcome` returned early when there was no row to update. The
     * row it writes now holds a dataset in which every day states its own
     * absence, so the attempt is recorded without a single number being claimed.
     */
    recordRefreshOutcome(
      target.tripId,
      target.scopeKey,
      {
        status: 'failed',
        requestedAt: requestedAt.toISOString(),
        completedAt: failedAt.toISOString(),
        message,
      },
      {
        regionId: target.compiled.region.id,
        dates: target.dates,
        locations: target.compiled.weatherLocations,
        now: failedAt,
        reason: 'provider_error',
        message,
      },
    );
    return { ok: false, reason: 'provider_failed' };
  }
}

/**
 * FETCH ONCE, BEFORE PLANNING, IF NOBODY HAS.
 *
 * The regression this closes is quiet and expensive. Taking the forecast off the
 * render path is correct; letting *planning* inherit that absence is not. The
 * planner reads weather to place outdoor days, to hold back a daylight-only site
 * and to choose a backup — so a traveller who built a plan without first
 * noticing a "fetch the weather" button would have got a weather-blind
 * itinerary, with nothing on screen saying which of the two had happened.
 *
 * Building a plan is an explicit act. It is allowed to buy data; a page load is
 * not. So the asymmetry is kept where it belongs, and the snapshot is fetched
 * here rather than three layers down.
 *
 * A failure is not fatal: the plan is built weather-blind and every surface says
 * so, which is the behaviour a provider outage already produced.
 */
export async function ensureWeatherForPlanning(
  target: WeatherFetchTarget,
  now: Date,
): Promise<WeatherFetchOutcome> {
  const existing = getWeatherSnapshot(target.tripId, target.scopeKey);
  /*
   * A row that holds nothing is not a reason to skip the fetch.
   *
   * Recording a failed first attempt writes a row — that is the whole of the fix
   * that makes a failed refresh visible — and a row with a `validUntil` on it
   * would otherwise satisfy this check and suppress every retry until it expired.
   * A snapshot only counts as "already fresh" if it actually holds a day.
   */
  if (
    existing &&
    Date.parse(existing.validUntil) > now.getTime() &&
    weatherCoverageOf(existing.dataset) !== 'none'
  ) {
    return { ok: true, reason: 'already_fresh' };
  }
  return fetchWeatherSnapshot(target);
}
