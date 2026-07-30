import {
  INTERESTS,
  type CostLevel,
  type Interest,
  type InterestLevel,
  type PhysicalIntensity,
  type RegionalExpansion,
} from '../schemas/common';
import {
  TRAVELER_PROFILE_VERSION,
  travelerProfileSchema,
  type DerivedProfile,
  type QuestionnaireAnswers,
  type TravelerProfile,
} from '../schemas/profile';
import {
  availableRegionalExpansions,
  isQuestionVisible,
  type QuestionnaireContext,
} from './definition';

export function defaultAnswers(context: QuestionnaireContext): QuestionnaireAnswers {
  const interests = Object.fromEntries(
    INTERESTS.map((interest) => [interest, 'low' as InterestLevel]),
  ) as Record<Interest, InterestLevel>;

  return {
    interests,
    pace: 'balanced',
    dayStart: 'normal',
    dailyIntensity: context.travelerNeeds.includes('mobility_limited') ? 'light' : 'moderate',
    budgetStyle: 'midrange',
    discoveryMix: 'balanced',
    crowdTolerance: 'mild',
    avoidTouristTraps: true,
    willDrive: true,
    comfortableMountainRoads: true,
    comfortableGravelRoads: false,
    maxDailyTravelMinutes: 150,
    regionalExpansion: 'nearby_60',
    detourToleranceMinutes: 60,
    avoidances: context.travelerNeeds.includes('mobility_limited') ? ['strenuous_activity'] : [],
    mobilityLimited: context.travelerNeeds.includes('mobility_limited'),
  };
}

/**
 * Forces every hidden question to the value its hiding rule implies, so a profile
 * can never carry an answer the traveller was not shown. Also clamps choices that
 * a later answer invalidated (picking a two-hour radius, then saying no car).
 */
export function normalizeAnswers(
  answers: QuestionnaireAnswers,
  context: QuestionnaireContext,
): QuestionnaireAnswers {
  const next: QuestionnaireAnswers = { ...answers, avoidances: [...answers.avoidances] };
  const input = { answers: next, context };

  if (!isQuestionVisible('dailyIntensity', input)) {
    next.dailyIntensity = 'light';
  }
  if (!isQuestionVisible('avoidTouristTraps', input)) {
    next.avoidTouristTraps = false;
  }
  if (!isQuestionVisible('roadComfort', input)) {
    next.comfortableMountainRoads = false;
    next.comfortableGravelRoads = false;
  }

  const allowedExpansions = availableRegionalExpansions(next.willDrive);
  if (!allowedExpansions.includes(next.regionalExpansion)) {
    next.regionalExpansion = allowedExpansions[allowedExpansions.length - 1] as RegionalExpansion;
  }
  if (!isQuestionVisible('detourToleranceMinutes', { answers: next, context })) {
    next.detourToleranceMinutes = 0;
  }

  if (context.travelerNeeds.includes('mobility_limited')) {
    next.mobilityLimited = true;
    if (!next.avoidances.includes('strenuous_activity')) {
      next.avoidances.push('strenuous_activity');
    }
  }
  next.avoidances = [...new Set(next.avoidances)].sort();
  return next;
}

const EXPANSION_CEILING_MINUTES: Record<RegionalExpansion, number> = {
  destination_only: 15,
  nearby_30: 35,
  nearby_60: 65,
  nearby_120: 125,
  best_regional: 165,
};

/** Without a car, only the base town and its trolley stops are realistically reachable. */
const NO_CAR_DETOUR_MINUTES = 20;

const SLOTS_BY_PACE = { slow: 2, balanced: 3, fast: 4 } as const;
const HIDDEN_GEM_TARGET = {
  mostly_classics: 0.2,
  balanced: 0.45,
  mostly_hidden: 0.7,
  deep_cuts: 0.85,
} as const;

const INTENSITY_ORDER: PhysicalIntensity[] = ['none', 'easy', 'moderate', 'strenuous'];

function minIntensity(a: PhysicalIntensity, b: PhysicalIntensity): PhysicalIntensity {
  return INTENSITY_ORDER.indexOf(a) <= INTENSITY_ORDER.indexOf(b) ? a : b;
}

export function deriveProfileValues(
  answers: QuestionnaireAnswers,
  context: QuestionnaireContext,
): DerivedProfile {
  let maxPhysicalIntensity: PhysicalIntensity =
    answers.dailyIntensity === 'light'
      ? 'moderate'
      : answers.dailyIntensity === 'moderate'
        ? 'strenuous'
        : 'strenuous';

  if (answers.avoidances.includes('strenuous_activity')) {
    maxPhysicalIntensity = minIntensity(maxPhysicalIntensity, 'moderate');
  }
  if (answers.avoidances.includes('long_hikes')) {
    maxPhysicalIntensity = minIntensity(maxPhysicalIntensity, 'moderate');
  }
  if (answers.mobilityLimited || context.travelerNeeds.includes('mobility_limited')) {
    maxPhysicalIntensity = minIntensity(maxPhysicalIntensity, 'easy');
  }

  let comfortableCostLevel: CostLevel =
    answers.budgetStyle === 'budget' ? 1 : answers.budgetStyle === 'midrange' ? 2 : 3;
  if (answers.avoidances.includes('expensive_activities')) {
    comfortableCostLevel = Math.min(comfortableCostLevel, 1) as CostLevel;
  }

  let slots: number = SLOTS_BY_PACE[answers.pace];
  if (answers.dailyIntensity === 'light') slots -= 0.5;
  if (answers.dailyIntensity === 'intense') slots += 0.5;
  if (context.travelerNeeds.includes('kids_under_12')) slots -= 0.5;
  const activitySlotsPerDay = clamp(slots, 1, 6);

  const days = Math.max(1, context.tripDays);
  const frequencyCaps = Object.fromEntries(
    INTERESTS.map((interest) => [
      interest,
      frequencyCap(answers.interests[interest] ?? 'low', days),
    ]),
  ) as Record<Interest, number>;

  const ceiling = EXPANSION_CEILING_MINUTES[answers.regionalExpansion];
  const halfDayCap = Math.floor(answers.maxDailyTravelMinutes / 2);
  const effectiveDetourMinutes = answers.willDrive
    ? Math.max(
        0,
        Math.min(
          ceiling,
          answers.detourToleranceMinutes > 0 ? answers.detourToleranceMinutes : ceiling,
          halfDayCap,
        ),
      )
    : NO_CAR_DETOUR_MINUTES;

  // What suits them, capped by what they can actually do. Scoring peaks here
  // rather than at the ceiling, so "I can handle a hard day" never turns into
  // "every stop should be the hardest option available".
  const preferredPhysicalIntensity = minIntensity(
    answers.dailyIntensity === 'light'
      ? 'easy'
      : answers.dailyIntensity === 'moderate'
        ? 'moderate'
        : 'strenuous',
    maxPhysicalIntensity,
  );

  return {
    maxPhysicalIntensity,
    preferredPhysicalIntensity,
    comfortableCostLevel,
    activitySlotsPerDay,
    frequencyCaps,
    effectiveDetourMinutes,
    hiddenGemTarget: HIDDEN_GEM_TARGET[answers.discoveryMix],
  };
}

function frequencyCap(level: InterestLevel, days: number): number {
  switch (level) {
    case 'avoid':
      return 0;
    case 'low':
      return 1;
    case 'occasional':
      return 2;
    case 'frequent':
      return Math.max(3, Math.ceil(days * 0.6));
    case 'core':
      return Math.max(4, days);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The single crossing point from questionnaire answers to the canonical profile
 * every downstream module reads. Runtime-validated so a malformed profile can
 * never reach scoring.
 */
export function buildTravelerProfile(
  rawAnswers: QuestionnaireAnswers,
  context: QuestionnaireContext,
): TravelerProfile {
  const answers = normalizeAnswers(rawAnswers, context);
  const profile: TravelerProfile = {
    version: TRAVELER_PROFILE_VERSION,
    interests: answers.interests,
    pace: answers.pace,
    dayStart: answers.dayStart,
    dailyIntensity: answers.dailyIntensity,
    budgetStyle: answers.budgetStyle,
    discoveryMix: answers.discoveryMix,
    crowdTolerance: answers.crowdTolerance,
    avoidTouristTraps: answers.avoidTouristTraps,
    transport: {
      willDrive: answers.willDrive,
      comfortableMountainRoads: answers.comfortableMountainRoads,
      comfortableGravelRoads: answers.comfortableGravelRoads,
      maxDailyTravelMinutes: answers.maxDailyTravelMinutes,
    },
    regionalExpansion: answers.regionalExpansion,
    detourToleranceMinutes: answers.detourToleranceMinutes,
    avoidances: answers.avoidances,
    accessibility: {
      mobilityLimited: answers.mobilityLimited,
      ...(answers.accessibilityNotes ? { notes: answers.accessibilityNotes } : {}),
    },
    derived: deriveProfileValues(answers, context),
  };

  return travelerProfileSchema.parse(profile);
}
