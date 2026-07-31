import {
  INTERESTS,
  type CostLevel,
  type Interest,
  type InterestLevel,
  type PhysicalIntensity,
  type RegionalExpansion,
} from '../schemas/common';
import type { FoodPreferences, FoodStyle, PriceBand } from '../schemas/food';
import {
  questionnaireAnswersSchema,
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
    willUseShuttles: true,
    maxAccessWalkMinutes: 25,
    transportPriority: 'best_value',
    regionalExpansion: 'nearby_60',
    detourToleranceMinutes: 60,
    avoidances: context.travelerNeeds.includes('mobility_limited') ? ['strenuous_activity'] : [],
    mobilityLimited: context.travelerNeeds.includes('mobility_limited'),
    breakfastStyle: 'coffee_light',
    foodStyle: 'balanced',
    specialMealAppetite: 'one',
    willPackLunch: true,
    dietaryNeeds: [],
    dietaryStrict: false,
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
  // Someone without a car is only reachable by shuttle, bus and foot. Letting a
  // stale "no shuttles" answer survive would leave them with an empty board and
  // no explanation for it.
  if (!isQuestionVisible('shuttleUse', input)) {
    next.willUseShuttles = true;
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
  next.dietaryNeeds = [...new Set(next.dietaryNeeds)].sort();
  // "These are strict" is a statement about a list. With nothing in the list it
  // is a stray boolean that would make every meal carry a verification note
  // about needs nobody has.
  if (next.dietaryNeeds.length === 0) next.dietaryStrict = false;
  if (!isQuestionVisible('specialMealAppetite', { answers: next, context })) {
    next.specialMealAppetite = 'none';
  }

  next.avoidances = [...new Set(next.avoidances)].sort();
  return next;
}

/**
 * How many meals across a trip may be an event.
 *
 * The rule the whole budget layer rests on, and it is deliberately blunt:
 * appetite sets the pace, trip length sets the ceiling, and a four-day trip
 * gets one special meal even from somebody who eats out constantly at home,
 * because four special meals in four days is not a holiday, it is a tasting
 * tour. `often` is the only setting that scales roughly with the trip.
 */
export function specialMealBudget(
  appetite: QuestionnaireAnswers['specialMealAppetite'],
  days: number,
): number {
  const trip = Math.max(1, days);
  switch (appetite) {
    case 'none':
      return 0;
    case 'one':
      return 1;
    case 'a_few':
      return Math.min(3, Math.max(1, Math.floor(trip / 3)));
    case 'often':
      return Math.min(6, Math.max(2, Math.floor(trip / 2)));
  }
}

/**
 * The band an ordinary meal should stay at or below.
 *
 * Read off the food style rather than the budget style, because they are
 * different questions: somebody happy to pay for a gondola ticket every day may
 * still want tacos every night, and somebody on a tight overall budget may be
 * saving it precisely for one dinner. The special-meal quota above is what lets
 * that second person have theirs without this ceiling stopping it.
 */
const EVERYDAY_BAND: Record<FoodStyle, PriceBand> = {
  budget: 'budget',
  local_casual: 'moderate',
  balanced: 'moderate',
  destination: 'upscale',
};

export function deriveFoodPreferences(
  answers: QuestionnaireAnswers,
  context: QuestionnaireContext,
): FoodPreferences {
  return {
    breakfastStyle: answers.breakfastStyle,
    style: answers.foodStyle,
    specialMealAppetite: answers.specialMealAppetite,
    willPackLunch: answers.willPackLunch,
    dietaryNeeds: [...answers.dietaryNeeds],
    dietaryStrict: answers.dietaryStrict,
    specialMealBudget: specialMealBudget(answers.specialMealAppetite, context.tripDays),
    everydayPriceBand: EVERYDAY_BAND[answers.foodStyle],
    // `depends` deliberately reads as yes. Somebody who said "it depends on the
    // day" has asked to be given the choice, and a named cafe they can walk past
    // is a choice; an empty morning is not.
    wantsBreakfastVenue: answers.breakfastStyle !== 'skip',
  };
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

/**
 * How much riding and walking a day may hold on top of the driving budget.
 *
 * Not a preference the traveller stated — nobody has an opinion about this until
 * they are made to have one — so it is a stated default rather than a hidden
 * question. Ninety minutes covers a shuttle in, a shuttle out and the walk at
 * each end, which is what an access day actually costs.
 */
export const ACCESS_TRAVEL_ALLOWANCE_MINUTES = 90;

/**
 * Total transport budget for a traveller with no car.
 *
 * They never see the driving question, so there is nothing to add an allowance
 * to. This is what a day of shuttles, buses and walking can realistically hold
 * before it stops being a holiday.
 */
export const NO_CAR_TRANSPORT_MINUTES = 150;

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

/**
 * The traveller's transportation position, in the shape the planner reads.
 *
 * The questionnaire keeps asking one question about driving because that is the
 * question a person can answer. Splitting it into a driving cap and a total
 * transportation cap happens here, once, where it is testable.
 */
export function transportPreferencesFrom(
  answers: QuestionnaireAnswers,
): TravelerProfile['transport'] {
  const maxDailyDriveMinutes = answers.willDrive ? answers.maxDailyTravelMinutes : 0;
  const maxDailyTransportMinutes = answers.willDrive
    ? Math.min(600, maxDailyDriveMinutes + ACCESS_TRAVEL_ALLOWANCE_MINUTES)
    : NO_CAR_TRANSPORT_MINUTES;

  return {
    willDrive: answers.willDrive,
    comfortableMountainRoads: answers.comfortableMountainRoads,
    comfortableGravelRoads: answers.comfortableGravelRoads,
    maxDailyDriveMinutes,
    maxDailyTransportMinutes,
    willUseShuttles: answers.willUseShuttles,
    maxAccessWalkMinutes: answers.maxAccessWalkMinutes,
    priority: answers.transportPriority,
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
    transport: transportPreferencesFrom(answers),
    food: deriveFoodPreferences(answers, context),
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

/**
 * Brings a stored profile up to the current version.
 *
 * Rather than hand-mapping v1's transport block onto v2's — which would be a
 * second, subtly different copy of `transportPreferencesFrom` waiting to drift —
 * this rebuilds the profile from the answers that produced it. The answers are
 * the durable artefact; the profile is derived, and deriving it again is exactly
 * what a migration should do.
 *
 * Returns null when the stored value is not a recognisable profile at all, so
 * the caller can fail into a recoverable state instead of planning on a guess.
 */
export function migrateTravelerProfile(
  answers: QuestionnaireAnswers | null,
  context: QuestionnaireContext,
): TravelerProfile | null {
  if (!answers) return null;
  const rebuilt = questionnaireAnswersSchema.safeParse(answers);
  if (!rebuilt.success) return null;
  return buildTravelerProfile(rebuilt.data, context);
}
