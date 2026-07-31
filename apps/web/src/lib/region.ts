import {
  buildDiscoveryBoard,
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_HOURS,
  EASTERN_SIERRA_PLACES,
  easternSierraTravelMatrix,
  REGIONS,
  tripDates,
  tripMonths,
  validateAccessDataset,
  validateOperatingHoursDataset,
  type AccessDataset,
  type DiscoveryBoard,
  type OperatingHoursDataset,
  type Place,
  type Region,
  type TravelerProfile,
  type Trip,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';

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
  matrix: TravelTimeMatrix;
  baseId: string;
  months: number[];
  dates: string[];
}

export type RegionResolution =
  | { ok: true; context: RegionContext }
  | { ok: false; error: string };

export function resolveTripRegion(trip: Trip): RegionResolution {
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

  return {
    ok: true,
    context: {
      region,
      places,
      access,
      hours,
      matrix: easternSierraTravelMatrix(),
      baseId: EASTERN_SIERRA_BASE_ID,
      months: tripMonths(trip.basics.startDate, trip.basics.endDate),
      dates: tripDates(trip.basics.startDate, trip.basics.endDate),
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
    travelerNeeds: trip.basics.travelerNeeds,
  });
}
