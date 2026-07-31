import type { PlaceAccessAssessment } from '../access/feasibility';
import type { OperatingAssessment } from '../hours/availability';
import type { AccessDataset } from '../schemas/access';
import type { OperatingHoursDataset } from '../schemas/hours';
import type { BoardGroup } from '../schemas/discovery';
import { BOARD_GROUPS } from '../schemas/discovery';
import type { Place } from '../schemas/place';
import type { TravelerProfile } from '../schemas/profile';
import type { Region, WorthDetourLabel } from '../schemas/region';
import type { TravelerNeed } from '../schemas/trip';
import {
  expandRegion,
  worthDetourLabel,
  type DetourClass,
  type RegionExpansion,
} from '../region/expansion';
import type { SeasonAssessment } from '../region/season';
import { scorePlace, type FitAssessment } from '../scoring/fit';

export interface DiscoveryCandidate {
  place: Place;
  fit: FitAssessment;
  detourClass: DetourClass;
  driveMinutes: number;
  distanceKm: number;
  season: SeasonAssessment;
  /** Date-aware transport feasibility, shown on the card and read by the planner. */
  access: PlaceAccessAssessment;
  /** Date-aware opening hours. A separate question from whether you can get there. */
  operating: OperatingAssessment;
  worthDetour: WorthDetourLabel;
  group: BoardGroup;
}

export interface DiscoveryBoard {
  expansion: RegionExpansion;
  candidates: DiscoveryCandidate[];
  groups: { group: BoardGroup; candidates: DiscoveryCandidate[] }[];
}

export interface BuildBoardInput {
  region: Region;
  places: Place[];
  profile: TravelerProfile;
  months: number[];
  dates: string[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
  travelerNeeds: TravelerNeed[];
}

export function buildDiscoveryBoard(input: BuildBoardInput): DiscoveryBoard {
  const { region, places, profile, months, dates, access, hours, travelerNeeds } = input;
  const expansion = expandRegion({ region, places, profile, months, dates, access, hours });

  const assessments = [...expansion.base, ...expansion.satellites, ...expansion.beyondRadius];

  const candidates: DiscoveryCandidate[] = assessments
    .map((assessment) => {
      const fit = scorePlace(assessment, { profile, travelerNeeds });
      return {
        place: assessment.place,
        fit,
        detourClass: assessment.detourClass,
        driveMinutes: assessment.driveMinutes,
        distanceKm: assessment.distanceKm,
        season: assessment.season,
        access: assessment.access,
        operating: assessment.operating,
        worthDetour: worthDetourLabel(assessment.detourClass, fit.band),
        group: groupFor(assessment.place, fit.band),
      };
    })
    // Anything you cannot actually do sorts below everything you can, however
    // well it scored on paper. Then highest fit first, with id as a stable
    // tiebreak so the board never reshuffles between renders.
    .sort(
      (a, b) =>
        Number(a.fit.band === 'not_workable') - Number(b.fit.band === 'not_workable') ||
        b.fit.score - a.fit.score ||
        a.place.id.localeCompare(b.place.id),
    );

  const groups = BOARD_GROUPS.map((group) => ({
    group,
    candidates: candidates.filter((candidate) => candidate.group === group),
  })).filter((entry) => entry.candidates.length > 0);

  return { expansion, candidates, groups };
}

/**
 * Each candidate lands in exactly one group. The order of these checks is the
 * priority: a weak fit is called out as such no matter how famous it is, and a
 * genuine hidden gem is never buried under the classics.
 */
function groupFor(place: Place, band: FitAssessment['band']): BoardGroup {
  if (band === 'not_workable' || band === 'weak') return 'weak_fit';
  if (place.hiddenGemScore >= 0.6) return 'hidden_gems';
  if (place.popularityScore >= 0.7) return 'must_see_classics';
  if (place.category === 'scenic_drive' || place.category === 'viewpoint') return 'scenic_detours';
  if (
    place.worksInBadWeather &&
    (place.physicalIntensity === 'none' || place.physicalIntensity === 'easy')
  ) {
    return 'low_effort_backups';
  }
  return 'nearby_side_quests';
}
