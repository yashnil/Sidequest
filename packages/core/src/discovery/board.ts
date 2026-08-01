import type { PlaceAccessAssessment } from '../access/feasibility';
import type { OperatingAssessment } from '../hours/availability';
import type { AccessDataset } from '../schemas/access';
import type { OperatingHoursDataset } from '../schemas/hours';
import type { WeatherDataset } from '../schemas/weather';
import { assessPlaceWeather, type PlaceWeatherAssessment } from '../weather/board';
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
import { assessCandidateQuality, type CandidateOutcome, type QualityAssessment } from '../quality/candidate';
import { evidenceFor, type PlaceEvidence, type RegionEvidence } from '../schemas/evidence';

export interface DiscoveryCandidate {
  place: Place;
  fit: FitAssessment;
  /**
   * What official sources said about this one, where anything was researched.
   *
   * Optional and frequently absent, which is the honest state for a region
   * compiled before the research funnel existed or for a candidate the funnel
   * could not afford. A card reads the absence as "we did not look", never as
   * "there is nothing to know".
   */
  evidence?: PlaceEvidence;
  /** Evidence-driven quality, and the sentence that explains the verdict. */
  quality: QualityAssessment;
  detourClass: DetourClass;
  driveMinutes: number;
  distanceKm: number;
  season: SeasonAssessment;
  /** Date-aware transport feasibility, shown on the card and read by the planner. */
  access: PlaceAccessAssessment;
  /** Date-aware opening hours. A separate question from whether you can get there. */
  operating: OperatingAssessment;
  /**
   * What the weather over the trip's dates says about this place — a forecast
   * where there is one, the seasonal pattern where there is not, and plainly
   * nothing where neither could be had.
   */
  weather: PlaceWeatherAssessment;
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
  /**
   * Optional, and the omission is meaningful rather than lazy: a board built
   * without it says nothing about weather anywhere, which is the honest result
   * when no forecast could be reached.
   */
  weather?: WeatherDataset;
  /** Resolved official evidence, where the region carries any. */
  evidence?: RegionEvidence;
  travelerNeeds: TravelerNeed[];
}

export function buildDiscoveryBoard(input: BuildBoardInput): DiscoveryBoard {
  const { region, places, profile, months, dates, access, hours, weather, evidence, travelerNeeds } =
    input;
  const expansion = expandRegion({ region, places, profile, months, dates, access, hours });

  const assessments = [...expansion.base, ...expansion.satellites, ...expansion.beyondRadius];

  /**
   * Category saturation is counted over the whole board rather than per group,
   * so the tenth viewpoint is demoted whichever section it would have landed in.
   */
  const categoryCounts = new Map<string, number>();

  const candidates: DiscoveryCandidate[] = assessments
    .map((assessment) => {
      const fit = scorePlace(assessment, { profile, travelerNeeds });
      const placeEvidence = evidenceFor(evidence, assessment.place.id);
      const seen = categoryCounts.get(assessment.place.category) ?? 0;
      categoryCounts.set(assessment.place.category, seen + 1);
      const quality = assessCandidateQuality({
        place: assessment.place,
        ...(placeEvidence ? { evidence: placeEvidence } : {}),
        fitScore: fit.score,
        detourMinutes: assessment.driveMinutes,
        categoryCount: seen,
        supersededByParent: placeEvidence?.parentSubjectId !== undefined,
        duplicate: false,
        usableOnTripDates:
          assessment.season.status !== 'closed' && assessment.operating.status !== 'closed_throughout',
        openingUncertain: assessment.operating.badges.includes('hours_unknown'),
        detourToleranceMinutes: profile.detourToleranceMinutes,
      });
      return {
        place: assessment.place,
        fit,
        ...(placeEvidence ? { evidence: placeEvidence } : {}),
        quality,
        detourClass: assessment.detourClass,
        driveMinutes: assessment.driveMinutes,
        distanceKm: assessment.distanceKm,
        season: assessment.season,
        access: assessment.access,
        operating: assessment.operating,
        weather: assessPlaceWeather({
          place: assessment.place,
          dataset: weather,
          dates,
          avoidances: profile.avoidances,
          daylightOnly: assessment.operating.daylightOnly,
        }),
        worthDetour: worthDetourLabel(assessment.detourClass, fit.band),
        group: groupFor(assessment.place, fit.band, quality.outcome),
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
function groupFor(
  place: Place,
  band: FitAssessment['band'],
  outcome: CandidateOutcome,
): BoardGroup {
  if (band === 'not_workable' || band === 'weak') return 'weak_fit';
  /**
   * Evidence outcomes that override the fit-based grouping, and only these two.
   *
   * Everything else the quality layer decides is already expressible as fit or
   * as a badge; these two are not, because they are statements about *our*
   * knowledge rather than about the place, and a traveller acts on them
   * differently.
   */
  if (outcome === 'insufficient_evidence' || outcome === 'not_worth_detour') return 'weak_fit';
  if (outcome === 'low_confidence') return 'needs_verification';
  if (place.hiddenGemScore >= 0.6) return 'hidden_gems';
  if (place.popularityScore >= 0.7) return 'must_see_classics';
  if (place.category === 'scenic_drive' || place.category === 'viewpoint') return 'scenic_detours';
  if (
    place.weather.poorWeatherBackup &&
    (place.physicalIntensity === 'none' || place.physicalIntensity === 'easy')
  ) {
    return 'low_effort_backups';
  }
  return 'nearby_side_quests';
}
