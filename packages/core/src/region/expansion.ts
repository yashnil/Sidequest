import type { Place } from '../schemas/place';
import type { TravelerProfile } from '../schemas/profile';
import type { Region, WorthDetourLabel } from '../schemas/region';
import { assessSeason, type SeasonAssessment } from './season';

export type DetourClass = 'base' | 'in_tolerance' | 'stretch' | 'too_far';

export interface SatelliteAssessment {
  place: Place;
  detourClass: DetourClass;
  driveMinutes: number;
  distanceKm: number;
  /** Round-trip drive time as a share of the traveller's daily travel budget. */
  travelBudgetShare: number;
  season: SeasonAssessment;
}

export interface RegionExpansion {
  region: Region;
  /** One-way minutes from base the traveller will actually accept. */
  radiusMinutes: number;
  base: SatelliteAssessment[];
  satellites: SatelliteAssessment[];
  /** Places the region contains that fall outside the traveller's radius entirely. */
  beyondRadius: SatelliteAssessment[];
}

export interface ExpansionInput {
  region: Region;
  places: Place[];
  profile: TravelerProfile;
  /** Calendar months the trip covers. */
  months: number[];
}

/**
 * Turns "Mammoth Lakes" into a base plus a set of satellites, classified by how
 * far outside the traveller's stated tolerance each one sits. This is the step
 * that makes the product region-aware rather than destination-aware; it is
 * deliberately independent of fit scoring so that "how far" and "how good"
 * stay separable.
 */
export function expandRegion(input: ExpansionInput): RegionExpansion {
  const { region, places, profile, months } = input;
  const radiusMinutes = profile.derived.effectiveDetourMinutes;
  const maxDaily = profile.transport.maxDailyTravelMinutes;

  const assessed = places
    .filter((place) => place.regionId === region.id)
    .map<SatelliteAssessment>((place) => {
      const driveMinutes = place.travelFromBase.driveMinutes;
      return {
        place,
        detourClass: classifyDetour(place, driveMinutes, radiusMinutes, maxDaily),
        driveMinutes,
        distanceKm: place.travelFromBase.distanceKm,
        travelBudgetShare: maxDaily > 0 ? (driveMinutes * 2) / maxDaily : 1,
        season: assessSeason(place, months),
      };
    })
    .sort((a, b) => a.driveMinutes - b.driveMinutes || a.place.id.localeCompare(b.place.id));

  return {
    region,
    radiusMinutes,
    base: assessed.filter((item) => item.detourClass === 'base'),
    satellites: assessed.filter(
      (item) => item.detourClass === 'in_tolerance' || item.detourClass === 'stretch',
    ),
    beyondRadius: assessed.filter((item) => item.detourClass === 'too_far'),
  };
}

function classifyDetour(
  place: Place,
  driveMinutes: number,
  radiusMinutes: number,
  maxDailyTravelMinutes: number,
): DetourClass {
  if (place.relationship === 'base') return 'base';
  // A satellite you cannot drive to and back from within the day's travel budget
  // is out of reach no matter how appealing it is.
  if (driveMinutes * 2 > maxDailyTravelMinutes) return 'too_far';
  if (driveMinutes <= radiusMinutes) return 'in_tolerance';
  if (driveMinutes <= radiusMinutes * 1.5) return 'stretch';
  return 'too_far';
}

/**
 * The worth-the-detour verdict combines distance with fit: a two-hour drive is
 * "worth it" for something you will love and "too far" for something you will
 * not, and saying so is more useful than reporting the distance alone.
 */
export function worthDetourLabel(
  detourClass: DetourClass,
  fitBand: 'top_pick' | 'strong' | 'good' | 'optional' | 'weak' | 'not_workable',
): WorthDetourLabel {
  if (fitBand === 'not_workable') return 'skip_for_your_style';
  if (detourClass === 'base') return fitBand === 'weak' ? 'skip_for_your_style' : 'core_to_trip';

  switch (fitBand) {
    case 'top_pick':
      return detourClass === 'too_far' ? 'worth_it_if_you_like_this' : 'definitely_worth_it';
    case 'strong':
      return detourClass === 'too_far'
        ? 'too_far_for_this_trip'
        : detourClass === 'stretch'
          ? 'worth_it_if_you_like_this'
          : 'definitely_worth_it';
    case 'good':
      return detourClass === 'in_tolerance' ? 'worth_it_if_you_like_this' : 'too_far_for_this_trip';
    case 'optional':
      return detourClass === 'in_tolerance' ? 'only_if_nearby' : 'too_far_for_this_trip';
    case 'weak':
      return 'skip_for_your_style';
  }
}
