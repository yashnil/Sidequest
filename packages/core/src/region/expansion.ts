import {
  assessPlaceAccess,
  capabilityFromProfile,
  type PlaceAccessAssessment,
} from '../access/feasibility';
import { assessOperatingHours, type OperatingAssessment } from '../hours/availability';
import type { AccessDataset } from '../schemas/access';
import { findOperatingCalendar, type OperatingHoursDataset } from '../schemas/hours';
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
  /** Round-trip drive time as a share of the traveller's daily driving budget. */
  travelBudgetShare: number;
  season: SeasonAssessment;
  /** Whether this traveller can legally reach it, date by date. */
  access: PlaceAccessAssessment;
  /**
   * Whether it will let anyone in when they arrive, date by date. Kept beside
   * `access` rather than merged into it: reachable and open fail independently,
   * and a card that says only "this will not work" has said nothing useful.
   */
  operating: OperatingAssessment;
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
  /**
   * Every date of the trip. Months are enough to say "the road is shut in
   * February"; only dates can say "the shuttle does not run on a Tuesday".
   */
  dates: string[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
}

/**
 * Turns "Mammoth Lakes" into a base plus a set of satellites, classified by how
 * far outside the traveller's stated tolerance each one sits. This is the step
 * that makes the product region-aware rather than destination-aware; it is
 * deliberately independent of fit scoring so that "how far" and "how good"
 * stay separable.
 */
export function expandRegion(input: ExpansionInput): RegionExpansion {
  const { region, places, profile, months, dates, access, hours } = input;
  const radiusMinutes = profile.derived.effectiveDetourMinutes;
  const maxDaily = profile.transport.maxDailyDriveMinutes;
  const capability = capabilityFromProfile(profile);

  const assessed = places
    .filter((place) => place.regionId === region.id)
    .map<SatelliteAssessment>((place) => {
      const driveMinutes = place.travelFromBase.driveMinutes;
      const placeAccess = assessPlaceAccess({
        placeId: place.id,
        dataset: access,
        dates,
        capability,
      });
      return {
        place,
        detourClass: classifyDetour(place, driveMinutes, radiusMinutes, maxDaily, placeAccess),
        driveMinutes,
        distanceKm: place.travelFromBase.distanceKm,
        // A driving budget only constrains a journey the traveller drives. Being
        // carried there on a shuttle does not spend it.
        travelBudgetShare:
          maxDaily > 0 && placeAccess.requiredModes.includes('drive')
            ? (driveMinutes * 2) / maxDaily
            : 0,
        season: assessSeason(place, months),
        access: placeAccess,
        operating: assessOperatingHours({
          calendar: findOperatingCalendar(hours, place.id) ?? unknownCalendarFor(place.id),
          dates,
        }),
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

/**
 * The provider boundary refuses a dataset that leaves a place out, so this is
 * unreachable through the normal path. It exists because the safe way to be
 * wrong is to say "we do not know", never to say "open whenever you like".
 */
function unknownCalendarFor(placeId: string) {
  return {
    kind: 'unknown' as const,
    placeId,
    admission: {
      reservationRequired: false,
      timedEntry: false,
      permitRequired: false,
      walkInAllowed: true,
      capacityLimited: false,
    },
    daylightOnly: false,
    note: 'We hold no opening-hours record for this place.',
    provenance: {
      kind: 'estimated' as const,
      sourceName: 'No source',
      confidence: 0,
      volatility: 'dynamic' as const,
      recheckNote: 'No opening-hours record exists for this place.',
    },
  };
}

function classifyDetour(
  place: Place,
  driveMinutes: number,
  radiusMinutes: number,
  maxDailyDriveMinutes: number,
  access: PlaceAccessAssessment,
): DetourClass {
  if (place.relationship === 'base') return 'base';
  // A satellite you cannot drive to and back from within the day's driving
  // budget is out of reach no matter how appealing it is — unless the traveller
  // is not the one driving, in which case the budget does not apply.
  const drivesThere = access.requiredModes.includes('drive');
  if (drivesThere && driveMinutes * 2 > maxDailyDriveMinutes) return 'too_far';
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
