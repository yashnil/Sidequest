import 'server-only';
import {
  buildDiscoveryBoard,
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_FOOD,
  EASTERN_SIERRA_HOURS,
  EASTERN_SIERRA_PLACES,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  easternSierraTravelMatrix,
  REGIONS,
  tripDates,
  tripMonths,
  validateAccessDataset,
  validateFoodDataset,
  validateOperatingHoursDataset,
  validateWeatherDataset,
  type AccessDataset,
  type DiscoveryBoard,
  type FoodDataset,
  type OperatingHoursDataset,
  type Place,
  type Region,
  type TravelerProfile,
  type Trip,
  type WeatherDataset,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { resolveTripWeather, weatherProviderFor } from './weather';

/**
 * Everything a region contributes to planning, resolved in one place.
 *
 * Four routes used to import the Eastern Sierra seed data, the access dataset,
 * the base id and the matrix individually and assemble them by hand — four
 * chances to pass a matrix without the matching access data, and four files to
 * touch when a second region lands. This is the seam where a live provider will
 * be awaited instead of a constant being read; nothing above it needs to know
 * which of those is happening.
 */
export interface RegionContext {
  region: Region;
  places: Place[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
  /**
   * The forecast, the seasonal pattern, or an honest record of neither. Unlike
   * the two above this is genuinely fetched, which is why resolving a region
   * became asynchronous — and why every failure path below has to end in a
   * dataset rather than an exception.
   */
  weather: WeatherDataset;
  /**
   * Where the traveller could eat. Curated like access and hours rather than
   * fetched like weather, and validated on every request for the same reason
   * they are: the check costs nothing and it is the boundary a live places
   * provider will have to cross.
   *
   * Null when the data will not validate. Unlike a road or a closing time, food
   * is not something a trip depends on — so the honest failure is to plan
   * without it and say so on every meal, not to refuse to plan at all.
   */
  food: FoodDataset | null;
  matrix: TravelTimeMatrix;
  baseId: string;
  months: number[];
  dates: string[];
}

export type RegionResolution =
  | { ok: true; context: RegionContext }
  | { ok: false; error: string };

export async function resolveTripRegion(trip: Trip): Promise<RegionResolution> {
  const region = REGIONS.find((item) => item.id === trip.basics.regionId);
  if (!region) return { ok: false, error: 'We do not have that region mapped.' };

  const places = EASTERN_SIERRA_PLACES.filter((place) => place.regionId === region.id);

  // Validated even though it is a local constant. The check costs nothing and it
  // is the same boundary a live transit provider will have to cross, so it is
  // better exercised on every request than written once and never run.
  let access: AccessDataset;
  try {
    access = validateAccessDataset(EASTERN_SIERRA_ACCESS, {
      regionId: region.id,
      placeIds: places.map((place) => place.id),
    });
  } catch (error) {
    console.error('Access data for this region is unusable', error);
    return {
      ok: false,
      error:
        'The transport data for this region is not usable, so we will not guess at how you would get around.',
    };
  }

  let hours: OperatingHoursDataset;
  try {
    hours = validateOperatingHoursDataset(EASTERN_SIERRA_HOURS, {
      regionId: region.id,
      placeIds: places.map((place) => place.id),
    });
  } catch (error) {
    console.error('Opening-hours data for this region is unusable', error);
    return {
      ok: false,
      error:
        'The opening-hours data for this region is not usable, so we will not guess at when places are open.',
    };
  }

  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);

  /**
   * Food, and the second place in this function where a failure does not stop
   * the trip.
   *
   * Access and hours are matters of record: guessing at them puts somebody at a
   * locked gate, so a dataset that will not validate refuses to plan. Food is a
   * preference layer. A region with no usable food data still gets a plan, with
   * every meal saying plainly that it is time held rather than somewhere named,
   * and `SIDEQUEST_FOOD_PROVIDER=off` is how that path is exercised without
   * breaking anything.
   */
  let food: FoodDataset | null = null;
  if (process.env.SIDEQUEST_FOOD_PROVIDER !== 'off') {
    try {
      food = validateFoodDataset(EASTERN_SIERRA_FOOD, { regionId: region.id });
    } catch (error) {
      console.error('Food data for this region is unusable', error);
      food = null;
    }
  }

  /**
   * Weather, and the one place in this function where a failure does not stop
   * the trip.
   *
   * Access and hours are matters of record: if they will not validate, the
   * honest thing is to refuse to plan, because guessing at them puts somebody at
   * a locked gate. Weather is a forecast — useful, and not something a trip
   * depends on. So a provider that is down produces a dataset of `unavailable`
   * days, the plan is built without weather reasoning, and every surface says
   * so. `resolveTripWeather` never throws; it degrades in a fixed order and the
   * bottom of that order is "we do not know", never "it is fine".
   */
  const expectedWeather = {
    regionId: region.id,
    dates,
    placeIds: places.map((place) => place.id),
  };
  let weather: WeatherDataset;
  try {
    weather = validateWeatherDataset(
      await resolveTripWeather({ regionId: region.id, dates }),
      expectedWeather,
    );
  } catch (error) {
    // The validator throws, and here that must not reach the page. Every other
    // dataset in this function refuses to plan when it will not validate,
    // because guessing at a road or a closing time puts somebody at a locked
    // gate. Weather is not like that: a trip without it is a slightly less
    // clever trip, and taking the discovery board down because a forecast came
    // back short would be the tail wagging the dog.
    console.error('Weather data for this trip is unusable', error);
    weather = validateWeatherDataset(
      await weatherProviderFor('off').getWeather({
        regionId: region.id,
        locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
        dates,
        now: new Date(),
      }),
      expectedWeather,
    );
  }

  return {
    ok: true,
    context: {
      region,
      places,
      access,
      hours,
      weather,
      food,
      matrix: easternSierraTravelMatrix(),
      baseId: EASTERN_SIERRA_BASE_ID,
      months: tripMonths(trip.basics.startDate, trip.basics.endDate),
      dates,
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
