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
import type { QuestionnaireAnswers } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';

export const QUESTIONNAIRE_STEPS = [
  'interests',
  'rhythm',
  'budget',
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
}

export interface StepDefinition {
  id: QuestionnaireStepId;
  title: string;
  intro: string;
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
    id: 'discovery',
    title: 'Famous or off the track?',
    intro: 'The Eastern Sierra has both. The mix is up to you.',
  },
  {
    id: 'transport',
    title: 'How are you getting around?',
    intro: 'Out here this decides which places are even reachable.',
  },
  {
    id: 'region',
    title: 'How far from Mammoth Lakes?',
    intro: 'The best of this region is spread along Highway 395.',
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
  | 'detourToleranceMinutes';

export interface AdaptiveInput {
  answers: Pick<
    QuestionnaireAnswers,
    'crowdTolerance' | 'willDrive' | 'regionalExpansion'
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
    default:
      return true;
  }
}

/**
 * Without a car, the Eastern Sierra beyond the town trolley is not reachable, so
 * offering a two-hour radius would be a promise the planner cannot keep.
 */
export function availableRegionalExpansions(willDrive: boolean): RegionalExpansion[] {
  if (willDrive) return [...REGIONAL_EXPANSIONS];
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

export const REGIONAL_EXPANSION_OPTIONS: readonly Option<RegionalExpansion>[] = [
  { value: 'destination_only', label: 'Town and the Lakes Basin', detail: 'Keep it tight' },
  { value: 'nearby_30', label: 'Within ~30 minutes', detail: 'Convict Lake, Hot Creek, Minaret Vista' },
  { value: 'nearby_60', label: 'Within ~1 hour', detail: 'Adds June Lake Loop and Mono Lake' },
  { value: 'nearby_120', label: 'Up to ~2 hours', detail: 'Adds Bodie, Bishop, Rock Creek' },
  { value: 'best_regional', label: 'Best of the Eastern Sierra', detail: 'Go wherever it is worth it' },
];

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

