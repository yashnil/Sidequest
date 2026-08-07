import 'server-only';
import {
  buildDiscoveryBoard,
  checkRegionIntegrity,
  tripDates,
  tripMonths,
  unavailableWeatherDataset,
  validateWeatherDataset,
  weatherAvailability,
  isSnapshotRenderable,
  type AccessDataset,
  type CompiledRegion,
  type DiscoveryBoard,
  type FoodDataset,
  type OperatingHoursDataset,
  type Place,
  type Region,
  type RegionRequest,
  type RegionSource,
  type TravelerProfile,
  type Trip,
  type WeatherAvailability,
  type WeatherDataset,
} from '@sidequest/core';
import { easternSierraRegionSource } from '@sidequest/core/data';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { getCompiledRegion, getIntent } from './db/compiler-repository';
import { getWeatherSnapshot, weatherScopeKey } from './weather/snapshot-repository';

/**
 * The region id a dynamically compiled trip carries.
 *
 * A sentinel rather than a real region, because at trip-creation time there is
 * no region yet — there is a string somebody typed. Everything that resolves a
 * region checks the compiled artifact first, and `trips.region_id` only records
 * which door the trip came through.
 */
export const DYNAMIC_REGION_ID = 'dynamic';

/**
 * Everything a region contributes to planning, resolved in one place.
 *
 * The shape has not changed. What changed is underneath it: the datasets no
 * longer come from eight imported constants but from a `RegionSource`, which is
 * the same door the dynamic compiler comes through. Nothing above this line can
 * tell an authored region from a compiled one, which is exactly the property
 * that makes a second destination a configuration change rather than a rewrite.
 */
export interface RegionContext {
  region: Region;
  places: Place[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
  /**
   * The forecast, the seasonal pattern, or an honest record of neither.
   *
   * Deliberately *not* part of the compiled region: a compiled artifact is
   * cached and reused, and a forecast baked into one is how a September
   * traveller is shown August's weather. The artifact says where to ask.
   *
   * And this no longer asks. It reads the persisted snapshot, and when there is
   * no usable one it builds a dataset of `unavailable` days. Resolving a region
   * used to call `resolveTripWeather` here, which meant every render of
   * `/discover`, `/itinerary`, `/plan` and `/questionnaire` made an outbound
   * forecast request — a refresh spent money, a slow provider became a slow
   * page, and the numbers under a stored plan moved without anybody asking.
   */
  weather: WeatherDataset;
  /**
   * Whether that dataset came from a snapshot, and how old it is.
   *
   * Carried beside the data rather than derived from it, because "we have not
   * fetched this" and "we fetched it and the provider had nothing" are
   * different sentences and both produce `unavailable` days. A surface that
   * could not tell them apart would offer a refresh button for a provider
   * outage and no button at all for the case a button would actually fix.
   */
  weatherAvailability: WeatherAvailability;
  /** The fingerprint a refresh operation must use to write back. */
  weatherScopeKey: string;
  /**
   * Where the traveller could eat. Null when the data will not validate —
   * unlike a road or a closing time, food is not something a trip depends on, so
   * the honest failure is to plan without it and say so on every meal.
   */
  food: FoodDataset | null;
  matrix: TravelTimeMatrix;
  baseId: string;
  /**
   * The multi-base structure, when the artifact carries one.
   *
   * Read from the artifact rather than re-derived, which is what keeps a stored
   * plan explicable: the bases and dates the planner used are the ones the
   * region was routed against, frozen at compile time like everything else.
   */
  basePortfolio: CompiledRegion['basePortfolio'];
  months: number[];
  dates: string[];
  /** The artifact this context was built from, for provenance and coverage. */
  compiled: CompiledRegion;
}

export type RegionResolution =
  | { ok: true; context: RegionContext }
  | { ok: false; error: string };

/**
 * Every region source, in the order they are asked.
 *
 * The authored fixture answers for the one region it holds. Everything else
 * comes from the database — the compiler writes an artifact, and this reads it.
 *
 * There is deliberately **no source here that calls a provider**. Rendering a
 * page must never compile: that is the rule that stops a refresh spending money
 * and stops a plan changing underneath somebody who only pressed reload.
 */
const REGION_SOURCES: readonly RegionSource[] = [easternSierraRegionSource];

function sourceFor(request: RegionRequest): RegionSource | undefined {
  return REGION_SOURCES.find((source) => source.supports(request));
}

/** The artifact this trip has adopted, if it has one. */
export function compiledRegionFor(tripId: string): CompiledRegion | null {
  const intent = getIntent(tripId);
  if (!intent?.selectedCompiledRegionId) return null;
  try {
    return getCompiledRegion(intent.selectedCompiledRegionId);
  } catch (error) {
    // A stored artifact that will not parse is the itinerary case, not the cache
    // case: the caller offers a rebuild rather than silently compiling again.
    console.error('Stored compiled region will not parse', error);
    return null;
  }
}

export async function resolveTripRegion(trip: Trip): Promise<RegionResolution> {
  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
  const months = tripMonths(trip.basics.startDate, trip.basics.endDate);
  const request: RegionRequest = { regionId: trip.basics.regionId, dates, months };

  let compiled: CompiledRegion;

  const stored = compiledRegionFor(trip.id);
  if (stored) {
    compiled = stored;
  } else {
    const source = sourceFor(request);
    if (!source) {
      return {
        ok: false,
        error:
          trip.basics.regionId === DYNAMIC_REGION_ID
            ? 'This trip has not been built yet.'
            : 'We have not built that region yet.',
      };
    }
    try {
      const result = await source.getCompiledRegion(request);
      if (!result.ok) return { ok: false, error: result.message };
      compiled = result.region;
    } catch (error) {
      console.error('Region source failed', error);
      return {
        ok: false,
        error: 'We could not assemble that region just now. Nothing was lost — try again.',
      };
    }
  }

  /**
   * The integrity gate, and the reason it is here rather than in a test.
   *
   * Five of these checks used to be unit tests over the seed data, which is the
   * right place for them while a person writes the data. A compiler writes it at
   * request time. The sharpest of them is the matrix: a place with no row throws
   * at the moment a day is laid out, and in the previous version of this file
   * `easternSierraTravelMatrix()` was called outside every `try` — so that throw
   * went straight to a 500 rather than to a sentence.
   */
  const issues = checkRegionIntegrity(compiled);
  if (issues.length > 0) {
    console.error(
      'Compiled region failed its integrity checks',
      issues.map((issue) => `${issue.code}: ${issue.subjectIds.join(', ')}`),
    );
    return {
      ok: false,
      error:
        'The data we hold for this region does not hang together, so we will not plan against it.',
    };
  }

  /**
   * Food, and the first of two places where a failure does not stop the trip.
   *
   * `SIDEQUEST_FOOD_PROVIDER=off` is how the no-food path is exercised without
   * breaking anything. A region with no usable food data still gets a plan, with
   * every meal saying plainly that it is time held rather than somewhere named.
   */
  const food = process.env.SIDEQUEST_FOOD_PROVIDER === 'off' ? null : (compiled.food ?? null);

  /**
   * Weather, and the second — read, never fetched.
   *
   * Access and hours are matters of record: guessing at them puts somebody at a
   * locked gate, so data that will not validate refuses to plan. Weather is a
   * forecast. An absent snapshot produces a dataset of `unavailable` days, the
   * plan is built without weather reasoning, and every surface says so.
   *
   * What used to be here was an `await resolveTripWeather(...)`, and it is the
   * reason this whole slice exists. Four routes resolve a region during render;
   * all four therefore asked a forecast provider on every page load, including
   * every browser-test navigation and every press of the back button. The
   * request is now an explicit operation — `refreshWeatherAction` — and this
   * reads what that operation wrote.
   *
   * An **expired** snapshot is treated as absent rather than shown with a
   * caveat. A forecast past its window is not a weaker version of the same
   * claim; it is a claim about a window that has closed. And nothing here
   * refetches it: a render that repaired its own staleness would be the original
   * defect wearing a different name.
   *
   * The locations come off the compiled region. They used to come off a default
   * argument inside the weather module, which meant a second region would have
   * silently been given the Eastern Sierra's forecast points — the single most
   * likely silent-wrong-answer in this whole migration.
   */
  const { weather, availability, scopeKey } = storedWeatherFor(trip.id, compiled, dates);

  /**
   * Non-null by the integrity gate above, which fails a region whose primary
   * base is not one of its bases. Read out here rather than inline so that a
   * future change to that gate breaks loudly instead of handing the planner an
   * empty routing id — which reads as a missing matrix row two stages later.
   */
  const primaryBase = compiled.bases.find((base) => base.id === compiled.primaryBaseId);
  if (!primaryBase) {
    console.error('Compiled region has no primary base', compiled.primaryBaseId);
    return { ok: false, error: 'We could not work out where this trip would be based.' };
  }

  return {
    ok: true,
    context: {
      region: compiled.region,
      places: compiled.places,
      access: compiled.access,
      hours: compiled.operatingHours,
      weather,
      weatherAvailability: availability,
      weatherScopeKey: scopeKey,
      food,
      matrix: compiled.travelTimes,
      baseId: primaryBase.routingId,
      basePortfolio: compiled.basePortfolio,
      months,
      dates,
      compiled,
    },
  };
}

/**
 * THE STORED WEATHER FOR ONE TRIP, READ AND NEVER FETCHED.
 *
 * Lifted out of `resolveTripRegion` for a reason that is a real cost rather than
 * a tidiness preference. Building an itinerary must buy a forecast first — a plan
 * is an explicit act and is allowed to spend, where a render is not — and the
 * only way to see what that purchase wrote used to be to run the *entire* region
 * resolution a second time: re-read the compiled artifact, re-validate the access
 * dataset, re-derive the base portfolio, all to pick up one row that changed.
 *
 * This is the part that changed. Everything else in a resolved context is a fact
 * about a frozen artifact and cannot have moved in the intervening milliseconds.
 */
function storedWeatherFor(
  tripId: string,
  compiled: CompiledRegion,
  dates: readonly string[],
): { weather: WeatherDataset; availability: WeatherAvailability; scopeKey: string } {
  const expectedWeather = {
    regionId: compiled.region.id,
    dates: [...dates],
    placeIds: compiled.places.map((place) => place.id),
  };
  const scopeKey = weatherScopeKey({
    regionId: compiled.region.id,
    dates,
    locations: compiled.weatherLocations,
  });
  const availability = weatherAvailability(getWeatherSnapshot(tripId, scopeKey), new Date());

  const unfetched = (): WeatherDataset =>
    unavailableWeatherDataset({
      regionId: compiled.region.id,
      locations: compiled.weatherLocations,
      dates,
      now: new Date(),
      reason: 'not_configured',
      message:
        availability.kind === 'present'
          ? 'The weather we had for these dates has passed the window it was good for. Fetch it again to see it.'
          : 'We have not fetched the weather for this trip yet.',
    });

  if (availability.kind === 'present' && isSnapshotRenderable(availability.state)) {
    try {
      return {
        weather: validateWeatherDataset(availability.snapshot.dataset, expectedWeather),
        availability,
        scopeKey,
      };
    } catch (error) {
      /*
       * A stored snapshot that does not cover this trip's places or dates. It
       * can happen across a recompilation that changed the place set without
       * changing the scope key's date span. Falling back to "not fetched" is the
       * only honest reading — the alternative is rendering a forecast for a set
       * of points that no longer describes the trip.
       */
      console.error('Stored weather snapshot does not match this trip', error);
    }
  }
  return {
    weather: validateWeatherDataset(unfetched(), expectedWeather),
    availability,
    scopeKey,
  };
}

/**
 * The same context with its weather re-read, and nothing else touched.
 *
 * The one thing an explicit fetch changes. Callers that buy a forecast and then
 * need to plan against it use this instead of resolving the region twice — which
 * is what `buildItineraryAction` was doing, at the cost of a full second pass
 * over the artifact on every plan build.
 */
export function withRefreshedWeather(
  tripId: string,
  context: RegionContext,
): RegionContext {
  const { weather, availability, scopeKey } = storedWeatherFor(
    tripId,
    context.compiled,
    context.dates,
  );
  return { ...context, weather, weatherAvailability: availability, weatherScopeKey: scopeKey };
}

/** The Discovery Board for a trip, from a resolved region context. */
export function boardFor(
  trip: Trip,
  profile: TravelerProfile,
  context: RegionContext,
): DiscoveryBoard {
  return buildDiscoveryBoard({
    region: context.region,
    places: context.places,
    profile,
    months: context.months,
    dates: context.dates,
    access: context.access,
    hours: context.hours,
    weather: context.weather,
    // The artifact's own evidence, so the board is exactly as confident as the
    // compilation was. A region compiled before this layer existed carries none,
    // and every card then reads "we did not look" rather than "nothing to know".
    ...(context.compiled.evidence ? { evidence: context.compiled.evidence } : {}),
    travelerNeeds: trip.basics.travelerNeeds,
  });
}
