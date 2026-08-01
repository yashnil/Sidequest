import 'server-only';
import {
  buildDiscoveryBoard,
  checkRegionIntegrity,
  tripDates,
  tripMonths,
  validateWeatherDataset,
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
  type WeatherDataset,
} from '@sidequest/core';
import { easternSierraRegionSource } from '@sidequest/core/data';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { getCompiledRegion, getIntent } from './db/compiler-repository';
import { resolveTripWeather, weatherProviderFor } from './weather';

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
   * The one dataset that is genuinely fetched, and the reason resolving a region
   * is asynchronous. Deliberately *not* part of the compiled region: a compiled
   * artifact is cached and reused, and a forecast baked into one is how a
   * September traveller is shown August's weather. The artifact says where to
   * ask; this asks.
   */
  weather: WeatherDataset;
  /**
   * Where the traveller could eat. Null when the data will not validate —
   * unlike a road or a closing time, food is not something a trip depends on, so
   * the honest failure is to plan without it and say so on every meal.
   */
  food: FoodDataset | null;
  matrix: TravelTimeMatrix;
  baseId: string;
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
   * Weather, and the second.
   *
   * Access and hours are matters of record: guessing at them puts somebody at a
   * locked gate, so data that will not validate refuses to plan. Weather is a
   * forecast. A provider that is down produces a dataset of `unavailable` days,
   * the plan is built without weather reasoning, and every surface says so.
   *
   * The locations come off the compiled region. They used to come off a default
   * argument inside the weather module, which meant a second region would have
   * silently been given the Eastern Sierra's forecast points — the single most
   * likely silent-wrong-answer in this whole migration.
   */
  const expectedWeather = {
    regionId: compiled.region.id,
    dates,
    placeIds: compiled.places.map((place) => place.id),
  };
  let weather: WeatherDataset;
  try {
    weather = validateWeatherDataset(
      await resolveTripWeather({
        regionId: compiled.region.id,
        dates,
        locations: compiled.weatherLocations,
      }),
      expectedWeather,
    );
  } catch (error) {
    console.error('Weather data for this trip is unusable', error);
    weather = validateWeatherDataset(
      await weatherProviderFor('off').getWeather({
        regionId: compiled.region.id,
        locations: compiled.weatherLocations,
        dates,
        now: new Date(),
      }),
      expectedWeather,
    );
  }

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
      food,
      matrix: compiled.travelTimes,
      baseId: primaryBase.routingId,
      months,
      dates,
      compiled,
    },
  };
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
    travelerNeeds: trip.basics.travelerNeeds,
  });
}
