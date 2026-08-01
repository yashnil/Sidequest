import type { TransportPriority } from '../schemas/access';
import {
  AVOIDANCES,
  AVOIDANCE_LABELS,
  REGIONAL_EXPANSIONS,
  type Avoidance,
  type BudgetStyle,
  type CrowdTolerance,
  type DailyIntensity,
  type DayStart,
  type DiscoveryMix,
  type Pace,
  type RegionalExpansion,
} from '../schemas/common';
import {
  DIETARY_NEED_LABELS,
  DIETARY_NEEDS,
  type BreakfastStyle,
  type DietaryNeed,
  type FoodStyle,
  type SpecialMealAppetite,
} from '../schemas/food';
import type { QuestionnaireAnswers } from '../schemas/profile';
import type { RegionQuestionnaireCopy } from '../schemas/region';
import type { TravelerNeed } from '../schemas/trip';

export const QUESTIONNAIRE_STEPS = [
  'interests',
  'rhythm',
  'budget',
  'food',
  'discovery',
  'transport',
  'region',
  'constraints',
  'review',
] as const;
export type QuestionnaireStepId = (typeof QUESTIONNAIRE_STEPS)[number];

export interface QuestionnaireContext {
  /** Facts captured on the trip basics screen, before the questionnaire starts. */
  travelerNeeds: TravelerNeed[];
  tripDays: number;
  /**
   * Where the trip is, so the questions can say so.
   *
   * The step titles used to name Mammoth Lakes and Highway 395 directly, in a
   * package that is supposed to work anywhere. They now read from the region,
   * and a region with no authored wording gets the generic form rather than
   * another region's landmarks.
   */
  region?: {
    baseName: string;
    copy?: RegionQuestionnaireCopy;
  };
}

export interface StepDefinition {
  id: QuestionnaireStepId;
  title: string;
  intro: string;
}

/** Where the trip is, in a sentence. Falls back to a phrase that names nowhere. */
function proseName(context?: QuestionnaireContext): string {
  return context?.region?.copy?.proseName ?? 'this region';
}

function baseName(context?: QuestionnaireContext): string {
  return context?.region?.baseName ?? 'your base';
}

export const STEP_DEFINITIONS: readonly StepDefinition[] = [
  {
    id: 'interests',
    title: 'What are you actually here for?',
    intro:
      'Not just what you like — how much of it you want. Two hikes across four days is a different trip from one every morning.',
  },
  {
    id: 'rhythm',
    title: 'How should the days feel?',
    intro: 'This sets how much we fit into a day, and how early it starts.',
  },
  {
    id: 'budget',
    title: 'What is the spending style?',
    intro: 'Used for which paid activities make the cut, not to pad a total.',
  },
  {
    id: 'food',
    title: 'How do you want to eat?',
    intro:
      'Meals get placed on the route you are already taking, so this changes where the days go, not just what is on the card.',
  },
  {
    id: 'discovery',
    title: 'Famous or off the track?',
    intro: 'Both exist here. The mix is up to you.',
  },
  {
    id: 'transport',
    title: 'How are you getting around?',
    intro: 'This decides which places are even reachable.',
  },
  {
    id: 'region',
    title: 'How far from your base?',
    intro: 'The best of a region is rarely all in one place.',
    /* Both are rewritten by `stepDefinitions` when the region has said better. */
  },
  {
    id: 'constraints',
    title: 'Anything to steer around?',
    intro: 'We will keep these out of the plan rather than warn you later.',
  },
  {
    id: 'review',
    title: 'Your trip personality',
    intro: 'Here is what we took from that. Change anything that reads wrong.',
  },
] as const;

/**
 * Questions that appear only under certain conditions. Each rule exists because
 * asking anyway would be either meaningless or actively misleading.
 */
export type ConditionalQuestionId =
  | 'dailyIntensity'
  | 'avoidTouristTraps'
  | 'roadComfort'
  | 'maxDailyTravelMinutes'
  | 'shuttleUse'
  | 'detourToleranceMinutes'
  | 'specialMealAppetite'
  | 'dietaryStrict';

export interface AdaptiveInput {
  answers: Pick<
    QuestionnaireAnswers,
    'crowdTolerance' | 'willDrive' | 'regionalExpansion' | 'foodStyle' | 'dietaryNeeds'
  >;
  context: QuestionnaireContext;
}

export function isQuestionVisible(id: ConditionalQuestionId, input: AdaptiveInput): boolean {
  const { answers, context } = input;
  switch (id) {
    // Asking someone with limited mobility how intense they want days to be sets
    // an expectation the scoring will immediately override. Force light instead.
    case 'dailyIntensity':
      return !context.travelerNeeds.includes('mobility_limited');
    // Only meaningful to someone who already said crowds bother them.
    case 'avoidTouristTraps':
      return answers.crowdTolerance !== 'dont_mind';
    case 'roadComfort':
    case 'maxDailyTravelMinutes':
      return answers.willDrive;
    // Only a driver gets to opt out of shuttles. Without a car they are not a
    // preference, they are the entire transport plan.
    case 'shuttleUse':
      return answers.willDrive;
    // "Stay in town" already answers this.
    case 'detourToleranceMinutes':
      return answers.regionalExpansion !== 'destination_only';
    // Somebody eating as cheaply as they can has already said no to this, and
    // asking anyway invites an answer the budget rule will then overrule.
    case 'specialMealAppetite':
      return answers.foodStyle !== 'budget';
    // "Are these strict?" is a question about a list. With nothing in it there
    // is nothing to be strict about.
    case 'dietaryStrict':
      return answers.dietaryNeeds.length > 0;
    default:
      return true;
  }
}

/**
 * Which radii are actually on offer, given whether the traveller is driving.
 *
 * This used to be a constant: a non-driver was capped at thirty minutes,
 * everywhere. That is true of a valley served by one seasonal trolley and
 * plainly false of anywhere with a rail network — offering a Tokyo traveller
 * nothing beyond half an hour because they will not hire a car is the sort of
 * hard-coded local truth this whole pass exists to remove.
 *
 * So the region says. A region that has not said gets the conservative answer,
 * because promising reach the planner cannot deliver is the worse failure.
 */
export function availableRegionalExpansions(
  willDrive: boolean,
  context?: QuestionnaireContext,
): RegionalExpansion[] {
  if (willDrive) return [...REGIONAL_EXPANSIONS];
  const carFree = context?.region?.copy?.carFreeExpansions;
  if (carFree && carFree.length > 0) {
    return REGIONAL_EXPANSIONS.filter((value) => carFree.includes(value));
  }
  return ['destination_only', 'nearby_30'];
}

export interface Option<T extends string> {
  value: T;
  label: string;
  detail: string;
}

export const PACE_OPTIONS: readonly Option<Pace>[] = [
  { value: 'slow', label: 'Slow', detail: 'One anchor a day, room to linger' },
  { value: 'balanced', label: 'Balanced', detail: 'Two or three stops, still time to sit down' },
  { value: 'fast', label: 'Full', detail: 'Cover ground, accept the driving' },
];

export const DAY_START_OPTIONS: readonly Option<DayStart>[] = [
  { value: 'early', label: 'Early', detail: 'Out before the light gets flat' },
  { value: 'normal', label: 'Normal', detail: 'Moving by mid-morning' },
  { value: 'relaxed', label: 'Relaxed', detail: 'Coffee first, no alarms' },
];

export const DAILY_INTENSITY_OPTIONS: readonly Option<DailyIntensity>[] = [
  { value: 'light', label: 'Light', detail: 'Short walks, mostly flat' },
  { value: 'moderate', label: 'Moderate', detail: 'A few miles and some climbing is fine' },
  { value: 'intense', label: 'Intense', detail: 'Long days, real elevation gain' },
];

export const BUDGET_OPTIONS: readonly Option<BudgetStyle>[] = [
  { value: 'budget', label: 'Budget', detail: 'Free trailheads and public land do the work' },
  { value: 'midrange', label: 'Mid-range', detail: 'Park fees and a gondola ticket are fine' },
  { value: 'premium', label: 'Premium', detail: 'Paid experiences whenever they are better' },
  { value: 'luxury', label: 'No ceiling', detail: 'Cost is not a filter' },
];

export const DISCOVERY_MIX_OPTIONS: readonly Option<DiscoveryMix>[] = [
  { value: 'mostly_classics', label: 'The famous ones', detail: 'Do not make me hunt' },
  { value: 'balanced', label: 'A real mix', detail: 'Highlights plus a few finds' },
  { value: 'mostly_hidden', label: 'Mostly hidden gems', detail: 'Trade some polish for quiet' },
  { value: 'deep_cuts', label: 'Deep cuts', detail: 'Send me where the guidebooks stop' },
];

export const CROWD_TOLERANCE_OPTIONS: readonly Option<CrowdTolerance>[] = [
  { value: 'avoid_crowds', label: 'Crowds ruin it', detail: 'Route me around the busy hours' },
  { value: 'mild', label: 'Some is fine', detail: 'Busy is okay if the place earns it' },
  { value: 'dont_mind', label: 'Does not bother me', detail: 'Popular is popular for a reason' },
];

/**
 * Radius options, with the region's own examples where it has written any.
 *
 * The examples used to be hard-coded landmark lists. They are the single most
 * useful thing on this screen — "adds June Lake Loop and Mono Lake" tells a
 * traveller more than "within an hour" ever will — which is exactly why they
 * have to come from the region rather than from the engine.
 */
export function regionalExpansionOptions(
  context?: QuestionnaireContext,
): readonly Option<RegionalExpansion>[] {
  const copy = context?.region?.copy;
  const example = (value: RegionalExpansion, fallback: string): string =>
    copy?.expansionExamples?.[value] ?? fallback;

  return [
    {
      value: 'destination_only',
      label: copy?.destinationOnlyLabel ?? `${baseName(context)} itself`,
      detail: example('destination_only', 'Keep it tight'),
    },
    {
      value: 'nearby_30',
      label: 'Within ~30 minutes',
      detail: example('nearby_30', 'Whatever is on the doorstep'),
    },
    {
      value: 'nearby_60',
      label: 'Within ~1 hour',
      detail: example('nearby_60', 'A comfortable day trip'),
    },
    {
      value: 'nearby_120',
      label: 'Up to ~2 hours',
      detail: example('nearby_120', 'A long day, for something worth it'),
    },
    {
      value: 'best_regional',
      label: `Best of ${proseName(context)}`,
      detail: example('best_regional', 'Go wherever it is worth it'),
    },
  ];
}

/**
 * The steps, with the region's own wording where it has any.
 *
 * `STEP_DEFINITIONS` stays exported and stays generic — it is what a region with
 * no authored copy gets, and what the tests that do not care about wording use.
 */
export function stepDefinitions(context?: QuestionnaireContext): readonly StepDefinition[] {
  const copy = context?.region?.copy;
  return STEP_DEFINITIONS.map((step) => {
    if (step.id === 'region') {
      return {
        ...step,
        title: `How far from ${baseName(context)}?`,
        ...(copy?.regionStepIntro ? { intro: copy.regionStepIntro } : {}),
      };
    }
    if (step.id === 'discovery' && copy?.discoveryIntro) {
      return { ...step, intro: copy.discoveryIntro };
    }
    if (step.id === 'transport' && copy?.transportIntro) {
      return { ...step, intro: copy.transportIntro };
    }
    return { ...step };
  });
}

/**
 * How to choose between two legal ways in. A soft preference: it orders the
 * options the access data supports, and never makes an impossible one possible.
 */
export const TRANSPORT_PRIORITY_OPTIONS: readonly Option<TransportPriority>[] = [
  { value: 'best_value', label: 'Best overall', detail: 'Sensible trade of time, cost and hassle' },
  { value: 'least_stressful', label: 'Least stressful', detail: 'Let someone else drive where you can' },
  { value: 'fastest', label: 'Fastest', detail: 'Fewest minutes in transit, whatever it costs' },
  { value: 'cheapest', label: 'Cheapest', detail: 'Ride rather than pay to park' },
];

export const AVOIDANCE_OPTIONS: readonly Option<Avoidance>[] = AVOIDANCES.map((value) => ({
  value,
  label: AVOIDANCE_LABELS[value],
  detail: '',
}));

export const BREAKFAST_STYLE_OPTIONS: readonly Option<BreakfastStyle>[] = [
  { value: 'skip', label: 'I skip it', detail: 'Do not book me a breakfast' },
  { value: 'coffee_light', label: 'Coffee and something', detail: 'Quick, and on the way out' },
  { value: 'full', label: 'A proper sit-down', detail: 'Worth starting the day later for' },
  { value: 'depends', label: 'Depends on the day', detail: 'Early start, quick. Slow morning, longer' },
];

export const FOOD_STYLE_OPTIONS: readonly Option<FoodStyle>[] = [
  { value: 'budget', label: 'Keep it cheap', detail: 'Bakeries, groceries, taco counters' },
  { value: 'local_casual', label: 'Local and casual', detail: 'Where the town actually eats' },
  { value: 'balanced', label: 'Mostly casual, one good one', detail: 'Spend it where it counts' },
  { value: 'destination', label: 'The meal is the point', detail: 'Happy to plan a day around dinner' },
];

export const SPECIAL_MEAL_OPTIONS: readonly Option<SpecialMealAppetite>[] = [
  { value: 'none', label: 'None', detail: 'No occasion dinners' },
  { value: 'one', label: 'One', detail: 'A single evening worth dressing for' },
  { value: 'a_few', label: 'A few', detail: 'More than one, not every night' },
  { value: 'often', label: 'Most nights', detail: 'This is what the trip is for' },
];

export const DIETARY_NEED_OPTIONS: readonly Option<DietaryNeed>[] = DIETARY_NEEDS.map((value) => ({
  value,
  label: DIETARY_NEED_LABELS[value],
  detail: '',
}));

