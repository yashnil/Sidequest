import {
  INTEREST_LABELS,
  INTEREST_LEVEL_LABELS,
  type Interest,
  type InterestLevel,
  type PhysicalIntensity,
} from '../schemas/common';
import type { Place } from '../schemas/place';
import type { TravelerProfile } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';
import type { SatelliteAssessment } from '../region/expansion';
import { describeOpenSeason } from '../region/season';
import type { AccessBlockerCode } from '../access/feasibility';

/**
 * Transparent, deterministic fit scoring.
 *
 * Two design rules hold this together:
 *
 * 1. Feasibility is a gate, not a penalty. A place you cannot reach, cannot
 *    physically do, or that is closed on your dates is not "low scoring" — it is
 *    unavailable, and it says why.
 * 2. Every number that reaches the UI is explainable. Each factor keeps its raw
 *    score, weight and contribution, and the copy shown to the traveller is
 *    generated from those values rather than written separately. That is also
 *    the feature vector a learned ranker would consume later.
 */

export const FIT_FACTORS = [
  'interestMatch',
  'detourFit',
  'intensityFit',
  'hiddenGemAlignment',
  'crowdComfort',
  'seasonFit',
  'budgetFit',
  'logisticsEase',
  'transportFit',
] as const;
export type FitFactorId = (typeof FIT_FACTORS)[number];

const WEIGHTS: Record<FitFactorId, number> = {
  interestMatch: 0.28,
  detourFit: 0.12,
  intensityFit: 0.11,
  hiddenGemAlignment: 0.11,
  crowdComfort: 0.1,
  seasonFit: 0.1,
  budgetFit: 0.08,
  logisticsEase: 0.06,
  transportFit: 0.04,
};

export const FIT_FACTOR_LABELS: Record<FitFactorId, string> = {
  interestMatch: 'Matches your interests',
  detourFit: 'Distance from base',
  intensityFit: 'Effort level',
  hiddenGemAlignment: 'Famous vs. hidden',
  crowdComfort: 'Crowds',
  seasonFit: 'Seasonal access',
  budgetFit: 'Cost',
  logisticsEase: 'Logistics',
  transportFit: 'Getting there',
};

export type FitBand = 'top_pick' | 'strong' | 'good' | 'optional' | 'weak' | 'not_workable';

export const FIT_BAND_LABELS: Record<FitBand, string> = {
  top_pick: 'Top pick for you',
  strong: 'Strong fit',
  good: 'Good fit',
  optional: 'Optional',
  weak: 'Probably skip',
  not_workable: 'Not workable this trip',
};

/** Five-step meter. Deliberately coarse — the underlying score is not that precise. */
export const FIT_BAND_METER: Record<FitBand, number> = {
  top_pick: 5,
  strong: 4,
  good: 3,
  optional: 2,
  weak: 1,
  not_workable: 0,
};

export type BlockerCode =
  | 'needs_car'
  | 'no_way_in'
  | 'service_unavailable'
  | 'mode_declined'
  | 'closed_on_your_dates'
  | 'exceeds_daily_travel'
  | 'avoided_interest'
  | 'rough_road'
  | 'no_services'
  | 'too_strenuous'
  | 'mobility'
  | 'too_expensive';

/**
 * Access blockers speak the language of transport; fit blockers speak the
 * language of the board. This is the one place the two vocabularies meet, so a
 * card can say "there is no way to reach this without your own vehicle" rather
 * than "logistics".
 */
function blockerCodeFor(code: AccessBlockerCode): BlockerCode {
  switch (code) {
    case 'needs_private_vehicle':
      return 'needs_car';
    case 'service_out_of_season':
    case 'service_not_operating':
    case 'private_vehicle_prohibited':
      return 'service_unavailable';
    // Not "the service is unavailable" — the service runs, and the traveller
    // ruled it out. Different fact, different remedy.
    case 'shuttle_declined':
      return 'mode_declined';
    case 'walk_too_long':
      return 'too_strenuous';
    default:
      return 'no_way_in';
  }
}

export interface Blocker {
  code: BlockerCode;
  message: string;
}

export interface FitFactor {
  id: FitFactorId;
  label: string;
  weight: number;
  /** 0-1 raw factor score. */
  score: number;
  /** weight * score — how much this factor added to the total. */
  contribution: number;
}

export interface FitAssessment {
  placeId: string;
  /** 0-100. Never shown as a bare number in the UI; the band is what people see. */
  score: number;
  band: FitBand;
  factors: FitFactor[];
  /** Flat numeric view of the same factors, for logging and future model training. */
  features: Record<FitFactorId, number>;
  blockers: Blocker[];
  reasons: string[];
  cautions: string[];
  /** The interest that drove the match, when there was one. */
  primaryInterest?: Interest;
  /**
   * Every interest this place genuinely satisfies for this traveller. A hike to a
   * viewpoint is both a hike and a viewpoint, and it has to count against both
   * frequency ceilings or "a few hikes" quietly becomes six.
   */
  matchedInterests: Interest[];
}

export interface ScoringContext {
  profile: TravelerProfile;
  travelerNeeds: TravelerNeed[];
}

const LEVEL_WEIGHT: Record<InterestLevel, number> = {
  avoid: 0,
  low: 0.35,
  occasional: 0.6,
  frequent: 0.85,
  core: 1,
};

const INTENSITY_ORDER: PhysicalIntensity[] = ['none', 'easy', 'moderate', 'strenuous'];

export function scorePlace(
  assessment: SatelliteAssessment,
  context: ScoringContext,
): FitAssessment {
  const { place, season, detourClass, driveMinutes } = assessment;
  const { profile, travelerNeeds } = context;
  const derived = profile.derived;

  const blockers: Blocker[] = [];
  const cautions: string[] = [];

  // --- Interest match -----------------------------------------------------
  const levels = place.interests.map((interest) => ({
    interest,
    level: profile.interests[interest] ?? 'low',
  }));
  const ranked = [...levels].sort(
    (a, b) =>
      LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] || a.interest.localeCompare(b.interest),
  );
  const best = ranked[0];
  const bestWeight = best ? LEVEL_WEIGHT[best.level] : 0;
  // The place's own dominant character, filtered through what the traveller
  // wants: the first interest it actually leads with that they care about.
  const primary =
    levels.find(({ level }) => LEVEL_WEIGHT[level] >= 0.6) ??
    (bestWeight > 0 ? best : undefined);
  const matchCount = levels.filter(({ level }) => LEVEL_WEIGHT[level] >= 0.6).length;
  const interestMatch = clamp01(bestWeight * 0.85 + (Math.min(matchCount, 3) / 3) * 0.15);

  if (bestWeight === 0) {
    blockers.push({
      code: 'avoided_interest',
      message: `This is entirely ${place.interests
        .map((interest) => INTEREST_LABELS[interest].toLowerCase())
        .join(' and ')}, which you asked us to skip.`,
    });
  }

  // --- Season -------------------------------------------------------------
  const seasonFit = season.status === 'open' ? 1 : season.status === 'partially_open' ? 0.55 : 0;
  if (season.status === 'closed') {
    blockers.push({
      code: 'closed_on_your_dates',
      message: `${describeOpenSeason(place)} — it will not be reachable on your dates.`,
    });
  } else if (season.status === 'partially_open') {
    cautions.push(
      `Only reachable for part of your trip window. ${season.note ?? describeOpenSeason(place)}`,
    );
  } else if (place.seasonalAccess.closureRisk === 'high' && season.note) {
    cautions.push(season.note);
  }
  // --- Transport ----------------------------------------------------------
  // Whether the traveller can get here at all is not a score, it is a fact, and
  // it comes from the access rules rather than from a guess about this place.
  const access = assessment.access;
  let transportFit = access.status === 'open' ? 1 : access.status === 'partial' ? 0.55 : 0;
  if (access.status === 'blocked') {
    for (const blocker of access.blockers) {
      blockers.push({ code: blockerCodeFor(blocker.code), message: blocker.message });
    }
  } else {
    cautions.push(...access.cautions);
    if (access.requiredModes.includes('shuttle') || access.requiredModes.includes('public_bus')) {
      // Someone else is driving, which is a different day and worth saying.
      transportFit = Math.min(transportFit, 0.9);
    }
  }
  if (assessment.travelBudgetShare > 1) {
    blockers.push({
      code: 'exceeds_daily_travel',
      message: `${driveMinutes * 2} min of driving round trip is past the ${profile.transport.maxDailyDriveMinutes} min at the wheel you said you would accept in a day.`,
    });
  }

  const roughRoad = place.access.roadSurface !== 'paved';
  if (roughRoad) {
    const refuses =
      profile.avoidances.includes('rough_or_gravel_roads') ||
      (place.access.roadSurface === 'unpaved' && !profile.transport.comfortableGravelRoads);
    if (refuses) {
      blockers.push({
        code: 'rough_road',
        message: 'The approach is unpaved, which you said you would rather avoid.',
      });
    } else {
      cautions.push('The last stretch of road is unpaved.');
    }
  }
  if (place.access.mountainRoad && !profile.transport.comfortableMountainRoads) {
    cautions.push('Steep mountain road with drop-offs.');
  }
  if (place.access.remoteNoServices) {
    if (profile.avoidances.includes('remote_areas_without_services')) {
      blockers.push({
        code: 'no_services',
        message: 'No fuel, food or reliable signal out here, which you asked us to avoid.',
      });
    } else {
      cautions.push('No services nearby — bring water and fuel up first.');
    }
  }

  // --- Physical intensity -------------------------------------------------
  // Peaks at the effort they want, falls off in both directions, and falls off
  // much faster above their ceiling than below it.
  const placeIntensity = INTENSITY_ORDER.indexOf(place.physicalIntensity);
  const maxIntensity = INTENSITY_ORDER.indexOf(derived.maxPhysicalIntensity);
  const preferredIntensity = INTENSITY_ORDER.indexOf(derived.preferredPhysicalIntensity);
  const fromPreferred = placeIntensity - preferredIntensity;
  const overCeiling = placeIntensity - maxIntensity;

  let intensityFit: number;
  if (overCeiling > 0) {
    intensityFit = overCeiling === 1 ? 0.3 : 0.1;
  } else if (fromPreferred === 0) {
    intensityFit = 1;
  } else if (fromPreferred < 0) {
    // Easier than they asked for is fine — a viewpoint is not a failure — but a
    // trip of nothing but car parks is not what "intense" meant either.
    intensityFit = fromPreferred === -1 ? 0.9 : 0.75;
  } else {
    intensityFit = 0.8;
  }

  if (profile.accessibility.mobilityLimited && placeIntensity > INTENSITY_ORDER.indexOf('easy')) {
    blockers.push({
      code: 'mobility',
      message: 'The terrain here is beyond what you told us works for your group.',
    });
  } else if (
    profile.avoidances.includes('strenuous_activity') &&
    place.physicalIntensity === 'strenuous'
  ) {
    blockers.push({
      code: 'too_strenuous',
      message: 'A sustained climb, and you asked us to leave strenuous activity out.',
    });
  } else if (
    profile.avoidances.includes('long_hikes') &&
    place.category === 'day_hike' &&
    place.typicalDurationMinutes > 180
  ) {
    blockers.push({
      code: 'too_strenuous',
      message: 'A half-day hike, and you asked us to skip the long ones.',
    });
  }

  if (
    travelerNeeds.includes('altitude_sensitive') &&
    place.physicalIntensity !== 'none' &&
    place.tags.some((tag) => tag === 'alpine' || tag === 'high-trailhead')
  ) {
    cautions.push('Real effort above 10,000 ft — worth saving for later in the trip.');
  }

  // --- Cost ---------------------------------------------------------------
  const costDelta = place.costLevel - derived.comfortableCostLevel;
  const budgetFit = costDelta <= 0 ? 1 : costDelta === 1 ? 0.6 : costDelta === 2 ? 0.25 : 0.1;
  if (profile.avoidances.includes('expensive_activities') && place.costLevel >= 3) {
    blockers.push({
      code: 'too_expensive',
      message: 'One of the pricier tickets in the area, which you asked us to leave out.',
    });
  }

  // --- Crowds -------------------------------------------------------------
  const crowdTolerance = profile.avoidances.includes('crowds_and_tourist_traps')
    ? 'avoid_crowds'
    : profile.crowdTolerance;
  const crowdTable = {
    avoid_crowds: { quiet: 1, moderate: 0.8, busy: 0.35, very_busy: 0.15 },
    mild: { quiet: 1, moderate: 0.9, busy: 0.65, very_busy: 0.45 },
    dont_mind: { quiet: 1, moderate: 1, busy: 0.9, very_busy: 0.85 },
  } as const;
  let crowdComfort: number = crowdTable[crowdTolerance][place.crowdLevel];
  if (profile.avoidTouristTraps && place.popularityScore >= 0.8 && place.hiddenGemScore <= 0.2) {
    crowdComfort = clamp01(crowdComfort - 0.15);
  }

  // --- Famous vs. hidden --------------------------------------------------
  const hiddenGemAlignment = clamp01(1 - Math.abs(place.hiddenGemScore - derived.hiddenGemTarget));

  // --- Detour -------------------------------------------------------------
  const radius = Math.max(derived.effectiveDetourMinutes, 1);
  const ratio = driveMinutes / radius;
  let detourFit =
    detourClass === 'base' ? 1 : ratio <= 0.5 ? 1 : ratio <= 1 ? 0.85 : ratio <= 1.5 ? 0.45 : 0.15;
  if (
    place.travelFromBase.driveIsScenic &&
    LEVEL_WEIGHT[profile.interests.scenic_drives ?? 'low'] >= 0.6
  ) {
    detourFit = clamp01(detourFit + 0.1);
  }
  if (
    profile.avoidances.includes('long_drives') &&
    driveMinutes > derived.effectiveDetourMinutes
  ) {
    detourFit = clamp01(detourFit - 0.2);
  }

  // --- Logistics ----------------------------------------------------------
  let logisticsEase =
    place.access.parkingDifficulty === 'easy'
      ? 1
      : place.access.parkingDifficulty === 'moderate'
        ? 0.75
        : 0.45;
  if (place.access.remoteNoServices) logisticsEase -= 0.15;
  if (roughRoad) logisticsEase -= 0.1;
  if (place.typicalDurationMinutes > 240) logisticsEase -= 0.1;
  if (place.typicalDurationMinutes > 300 && profile.pace === 'slow') logisticsEase -= 0.1;
  logisticsEase = clamp01(logisticsEase);

  if (place.access.parkingDifficulty === 'hard') {
    cautions.push('Parking fills early — go first thing or expect to wait.');
  }

  const features: Record<FitFactorId, number> = {
    interestMatch,
    detourFit,
    intensityFit,
    hiddenGemAlignment,
    crowdComfort,
    seasonFit,
    budgetFit,
    logisticsEase,
    transportFit,
  };

  const factors: FitFactor[] = FIT_FACTORS.map((id) => ({
    id,
    label: FIT_FACTOR_LABELS[id],
    weight: WEIGHTS[id],
    score: features[id],
    contribution: WEIGHTS[id] * features[id],
  }));

  const raw = factors.reduce((total, factor) => total + factor.contribution, 0);
  const score = Math.round(raw * 100);
  const band: FitBand = blockers.length > 0 ? 'not_workable' : bandFor(score);

  return {
    placeId: place.id,
    score,
    band,
    factors,
    features,
    blockers,
    reasons: buildReasons({ place, assessment, context, features, best, band }),
    cautions: dedupe([...cautions, ...(place.logisticsNote ? [place.logisticsNote] : [])]),
    matchedInterests: levels
      .filter(({ level }) => LEVEL_WEIGHT[level] >= 0.6)
      .map(({ interest }) => interest)
      .sort(),
    ...(primary ? { primaryInterest: primary.interest } : {}),
  };
}

/**
 * Thresholds are set so that "Top pick" stays rare enough to mean something. A
 * well-matched traveller in a region that suits them should see a handful, not
 * a board where everything is a top pick.
 */
function bandFor(score: number): FitBand {
  if (score >= 88) return 'top_pick';
  if (score >= 78) return 'strong';
  if (score >= 66) return 'good';
  if (score >= 52) return 'optional';
  return 'weak';
}

interface ReasonInput {
  place: Place;
  assessment: SatelliteAssessment;
  context: ScoringContext;
  features: Record<FitFactorId, number>;
  best: { interest: Interest; level: InterestLevel } | undefined;
  band: FitBand;
}

/**
 * "Why this fits you" is generated from the same numbers that produced the score,
 * so the explanation cannot drift from the ranking. When a place does not fit,
 * this says that plainly instead of manufacturing enthusiasm.
 */
function buildReasons(input: ReasonInput): string[] {
  const { place, assessment, context, features, best, band } = input;
  const { profile } = context;
  const reasons: string[] = [];

  if (band === 'not_workable') return reasons;

  if (best && LEVEL_WEIGHT[best.level] >= 0.6) {
    reasons.push(
      `You marked ${INTEREST_LABELS[best.interest].toLowerCase()} as "${INTEREST_LEVEL_LABELS[
        best.level
      ].toLowerCase()}", and that is what this delivers.`,
    );
  }

  if (features.crowdComfort >= 0.95 && profile.crowdTolerance === 'avoid_crowds') {
    reasons.push('Stays quiet even in season, which matters more to you than a famous name.');
  }

  if (features.hiddenGemAlignment >= 0.8 && place.hiddenGemScore >= 0.6) {
    reasons.push('Well off the standard loop — the kind of find you said you wanted.');
  } else if (
    features.hiddenGemAlignment >= 0.8 &&
    place.popularityScore >= 0.7 &&
    profile.discoveryMix === 'mostly_classics'
  ) {
    reasons.push('One of the names people come here for, and you wanted the highlights.');
  } else if (features.hiddenGemAlignment >= 0.85 && profile.discoveryMix === 'balanced') {
    reasons.push('Sits right in the middle of famous and quiet, which is the mix you asked for.');
  }

  if (assessment.detourClass === 'base') {
    reasons.push('Minutes from where you are staying, so it fits any day.');
  } else if (features.detourFit >= 0.85) {
    reasons.push(
      `${assessment.driveMinutes} min out, inside the ${profile.derived.effectiveDetourMinutes} min detour you were happy with.`,
    );
  }

  if (features.intensityFit >= 1 && place.physicalIntensity !== 'none') {
    reasons.push(`Effort level lines up with the ${profile.dailyIntensity} days you asked for.`);
  }

  if (place.costLevel === 0 && profile.budgetStyle === 'budget') {
    reasons.push('Free, which keeps the trip inside the budget you set.');
  }

  if (place.worksInBadWeather && place.weatherSensitivity === 'low') {
    reasons.push('Holds up even if the weather turns.');
  }

  if (
    place.travelFromBase.driveIsScenic &&
    LEVEL_WEIGHT[profile.interests.scenic_drives ?? 'low'] >= 0.6
  ) {
    reasons.push('The drive there is part of the appeal, and you wanted scenic driving.');
  }

  return dedupe(reasons).slice(0, 3);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
