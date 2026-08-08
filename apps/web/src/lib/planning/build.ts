import 'server-only';
import { planTrip } from '@sidequest/planner';
import {
  getFoodSelections,
  getProfile,
  getSelections,
  getTrip,
  saveItinerary,
  saveReadiness,
} from '@/lib/db/repository';
import { boardFor, resolveTripRegion, withRefreshedWeather } from '@/lib/region';
import { ensureWeatherForPlanning } from '@/lib/weather/refresh';

import type { PlannerReadiness } from '@sidequest/core';

/**
 * BUILDING THE PLAN — THE WHOLE OF IT, AND THE ONLY COPY.
 *
 * This was the body of `buildItineraryAction`. It moved here unchanged so that
 * there is exactly one sequence that turns a trip into an itinerary, and so that
 * a second caller cannot drift from it.
 *
 * The second caller is the Phase 13 benchmark adapter. The alternative was for it
 * to call the server action and catch the `NEXT_REDIRECT` the action throws on
 * success — which works, and which would have meant the benchmark measured a
 * code path held together by an exception. Worse, the tempting repair for that is
 * to reassemble the same seven calls in the adapter, and *that* is the version
 * where Sidequest's benchmark result slowly stops being Sidequest's production
 * result because somebody fixed a bug in one of the two copies.
 *
 * So: this function plans and persists. The server action wrapping it adds only
 * `revalidatePath` and `redirect`, which are the two things a benchmark harness
 * must not do and a browser must.
 *
 * Nothing about the ordering here is incidental — see the comments inline, which
 * came with the code.
 */

export interface BuildResult {
  ok: boolean;
  error?: string;
  /**
   * Why nothing could be planned, as data rather than a sentence.
   *
   * Present only when the planner ran in full and placed nothing. Crossing the
   * server-action boundary as a typed object rather than a string is what makes
   * it machine-readable: the board renders counts, blockers and remedies from
   * it, and a test can assert on the numbers instead of on copy.
   */
  readiness?: PlannerReadiness;
}

export async function buildItinerary(tripId: string): Promise<BuildResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const profile = getProfile(tripId);
  if (!profile) {
    return { ok: false, error: 'Finish the questionnaire first — we need your profile to plan around.' };
  }

  /*
   * The forecast, bought here, because building a plan is an explicit act.
   *
   * Taking the fetch off the *render* path was the point of the change that
   * preceded this; letting *planning* inherit that absence would have been a
   * quiet and expensive regression. The planner reads weather to place outdoor
   * days, to hold back a daylight-only site and to choose a backup, so a
   * traveller who pressed "build my trip" without first noticing a fetch button
   * would have received a weather-blind itinerary with nothing on screen saying
   * which of the two had happened.
   *
   * Before `resolveTripRegion`, so that the region it resolves reads the
   * snapshot this just wrote. A failure is not fatal — the plan is built
   * weather-blind and every surface says so, which is exactly what a provider
   * outage already produced.
   */
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  await ensureWeatherForPlanning(
    {
      tripId,
      compiled: resolved.context.compiled,
      dates: resolved.context.dates,
      scopeKey: resolved.context.weatherScopeKey,
    },
    new Date(),
  );

  /*
   * One resolution, then one re-read of the row the fetch above wrote.
   *
   * This used to be two full calls to `resolveTripRegion` — the second only to
   * pick up a weather snapshot that the first could not have seen. Everything
   * else a resolved context holds comes off a frozen artifact and cannot have
   * moved in between, so re-reading all of it was a whole second pass over the
   * compiled region on the click that builds a plan.
   */
  const context = withRefreshedWeather(tripId, resolved.context);

  const selections = getSelections(tripId);
  if (selections.filter((entry) => entry.status !== 'excluded').length === 0) {
    return {
      ok: false,
      error: 'Nothing is marked to include yet. Pick a few places, or use auto-pick, then try again.',
    };
  }

  try {
    const board = boardFor(trip, profile, context);

    const result = planTrip({
      tripId,
      basics: trip.basics,
      profile,
      region: context.region,
      candidates: board.candidates,
      selections,
      matrix: context.matrix,
      access: context.access,
      hours: context.hours,
      weather: context.weather,
      // Optional on purpose: a region with no usable food data still gets a
      // plan, and the difference between "we have none" and "we have none that
      // fitted" is what the meal rows then say.
      ...(context.food ? { food: context.food } : {}),
      foodSelections: getFoodSelections(tripId),
      // Without this the staleness check is unreachable in production: it is
      // gated on `now` precisely so a test does not have to wait six hours, and
      // omitting it here meant a forecast served from cache could be planned
      // against and validated as fresh.
      now: new Date(),
      baseId: context.baseId,
      ...(context.basePortfolio ? { basePortfolio: context.basePortfolio } : {}),
    });

    if (!result.ok) {
      /**
       * A plan with nothing in it is never saved.
       *
       * `saveItinerary` is below this branch and stays below it: the itinerary
       * page reads the database, so persisting an empty plan is what would put
       * five blank days in front of a traveller.
       *
       * The *readiness* is saved, though, and that is the point of persisting it
       * separately: the explanation for a refusal has to survive the refresh that
       * loses this action's return value, or a traveller who reloads is left
       * with a board and no idea why the button did nothing.
       */
      if (result.readiness) saveReadiness(tripId, result.readiness, new Date());
      return {
        ok: false,
        error: planFailureCopy(result.code, result.message),
        ...(result.readiness ? { readiness: result.readiness } : {}),
      };
    }

    saveItinerary(result.itinerary);
    saveReadiness(tripId, result.readiness, new Date());
  } catch (error) {
    console.error('Failed to build itinerary', error);
    return {
      ok: false,
      error: 'We built a plan but could not save it. Nothing was lost — try again.',
    };
  }

  return { ok: true };
}

function planFailureCopy(code: string, message: string): string {
  switch (code) {
    case 'no_candidates':
      return 'Nothing on your board can be planned yet. Include a few places and try again.';
    case 'matrix_unusable':
      return `We do not have usable travel times for this region, so we will not guess at a plan. ${message}`;
    case 'no_usable_days':
      return 'Those dates do not contain a usable day. Check your arrival and departure times.';
    case 'planner_coverage_insufficient':
      return message;
    default:
      return message;
  }
}
