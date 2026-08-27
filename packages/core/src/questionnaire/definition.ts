import type { TransportPriority } from '../schemas/access';
import {
  AVOIDANCES,
  AVOIDANCE_LABELS,
  INTERESTS,
  REGIONAL_EXPANSIONS,
  type Avoidance,
  type BudgetStyle,
  type CrowdTolerance,
  type DailyIntensity,
  type DayStart,
  type DiscoveryMix,
  type Interest,
  type InterestLevels,
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
import { QUESTIONNAIRE_STEP_IDS, type QuestionnaireAnswers } from '../schemas/profile';
import type { RegionQuestionnaireCopy } from '../schemas/region';
import type { TravelerNeed } from '../schemas/trip';

/**
 * Re-exported from the schema, where the list now canonically lives: the
 * answers reference step ids (`decideForMe`), and schemas cannot import from
 * here without a cycle. Same tuple, same name, same type as it always had.
 */
export const QUESTIONNAIRE_STEPS = QUESTIONNAIRE_STEP_IDS;
export type QuestionnaireStepId = (typeof QUESTIONNAIRE_STEPS)[number];

/**
 * Where a step sits in the canonical order — the number the draft position is
 * *stored* as. An index into the visible step list is not storable: the visible
 * list changes length whenever a composer-answered step is dropped, so a saved
 * index of six could mean the region step on one render and the constraints
 * step on the next. The canonical ordinal names the same step in every build
 * that has the step at all.
 */
export function stepOrdinal(id: QuestionnaireStepId): number {
  return QUESTIONNAIRE_STEPS.indexOf(id);
}

/** The stored ordinal back to a step id, clamped rather than trusted. */
export function stepIdForOrdinal(ordinal: number): QuestionnaireStepId {
  const bounded = Math.min(Math.max(0, Math.floor(ordinal)), QUESTIONNAIRE_STEPS.length - 1);
  return QUESTIONNAIRE_STEPS[bounded]!;
}

/**
 * Where to resume in the list of steps actually being shown.
 *
 * Exact match when the saved step is still visible; otherwise the next visible
 * step in canonical order, because a step that vanished between sessions was
 * *answered* (that is why it vanished) and resuming before it would replay
 * ground the traveller has covered. Falls to the last step rather than the
 * first when nothing later survives — the end of a shrunken questionnaire is
 * the review, which is exactly where somebody past the missing step belongs.
 */
export function resumeStepIndex(
  visible: readonly { id: QuestionnaireStepId }[],
  target: QuestionnaireStepId,
): number {
  const exact = visible.findIndex((step) => step.id === target);
  if (exact >= 0) return exact;
  const wanted = stepOrdinal(target);
  const following = visible.findIndex((step) => stepOrdinal(step.id) > wanted);
  return following >= 0 ? following : Math.max(0, visible.length - 1);
}

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
  /**
   * Which interests this destination has earned the right to be graded on.
   *
   * Resolved by `interests/offer.ts` — from the compiled region's own places
   * where one exists, and otherwise from the resolved entity type, which is the
   * path that matters because the questionnaire runs *before* compilation.
   *
   * Absent means nobody has decided, and the whole vocabulary is offered. That
   * is the honest floor rather than a failure: withholding a question because we
   * have not looked yet would be a claim about the destination made out of our
   * own ignorance.
   */
  offeredInterests?: readonly Interest[];
}

/**
 * The interest rows to put on screen, in order.
 *
 * The offer decides what is asked; this decides what is *shown*, and the two
 * differ in exactly one case — an interest the traveller has already graded
 * that the offer no longer includes. That happens for real: a profile answered
 * before the offer existed, a destination changed after intake, an offer
 * recomputed from a fresh compilation. Dropping such a row would hide a stated
 * preference behind a control that no longer exists while it carried on
 * steering the research, so it is appended instead — after the offer, because
 * the offer is what this destination can actually serve.
 *
 * `low` is not an answer. It is what every row starts at, so a `low` grade on an
 * unoffered interest is silence rather than a preference and adds no row.
 */
export function offeredInterestRows(
  context: QuestionnaireContext | undefined,
  interests: InterestLevels,
): Interest[] {
  const offered = context?.offeredInterests;
  if (!offered || offered.length === 0) return [...INTERESTS];
  const stated = INTERESTS.filter(
    (interest) => !offered.includes(interest) && (interests[interest] ?? 'low') !== 'low',
  );
  return [...offered, ...stated];
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
    /*
     * No longer rendered as a question — the wizard derives the tourist-trap
     * warning from the graded crowd control (see `normalizeAnswers`), because
     * crowd preference was being collected on four surfaces for one scoring
     * dimension. The visibility rule itself survives unchanged: the benchmark
     * request adapter reads it to decide whether the field is representable,
     * and its formula together with this rule is exactly the derivation
     * `normalizeAnswers` applies, which keeps adapter output a fixed point.
     */
    case 'avoidTouristTraps':
      return answers.crowdTolerance !== 'dont_mind';
    case 'roadComfort':
    case 'maxDailyTravelMinutes':
      return answers.willDrive;
    // Only a driver gets to opt out of shuttles. Without a car they are not a
    // preference, they are the entire transport plan.
    case 'shuttleUse':
      return answers.willDrive;
    /*
     * "Stay in town" already answers this. It stays visible without a car —
     * the compiler reads the raw figure as its candidate search radius, so the
     * answer is real either way — but the *wording* is the wizard's to fix: it
     * used to say "furthest you would drive" directly under "you are not
     * driving", and now names the mode the traveller actually said they move in.
     */
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
 * What each radius ring means in one-way minutes, for the maths that has to
 * compare a ring against a travel budget. Slightly above the nominal figure so
 * "within ~30 minutes" admits the 32-minute lake rather than excluding it on a
 * technicality the copy never promised.
 */
export const EXPANSION_CEILING_MINUTES: Record<RegionalExpansion, number> = {
  destination_only: 15,
  nearby_30: 35,
  nearby_60: 65,
  nearby_120: 125,
  best_regional: 165,
};

/**
 * Without a car, the walk-out radius: the base town and its nearest stops.
 *
 * A floor rather than a value. It was the whole of a car-free traveller's
 * `effectiveDetourMinutes`, which threw away the two answers they had actually
 * given — the one-way travel slider and the regional ring, both of which the
 * questionnaire puts in front of a non-driver and the second of which is
 * offered out to `carFreeReachMinutes()`. It now sits underneath those answers:
 * a traveller who said nothing keeps exactly this radius, and no answer can
 * take them below it.
 */
export const NO_CAR_DETOUR_MINUTES = 20;

/**
 * Total transport budget for a traveller with no car.
 *
 * They never see the driving question, so there is nothing to add an allowance
 * to. This is what a day of shuttles, buses and walking can realistically hold
 * before it stops being a holiday.
 */
export const NO_CAR_TRANSPORT_MINUTES = 150;

/**
 * How far out a car-free traveller can actually get, one way.
 *
 * The same rule `detourToleranceMinutesFor` in `travel/reach.ts` applies to a
 * ride: half the daily transport budget, floored by the walk-out radius,
 * because a detour is a there-and-back inside a day the traveller said they
 * would accept. Restated here rather than imported because that function takes
 * a built `TravelerProfile` and building one would drag `transform` into this
 * module's import graph backwards; `transform.test.ts` pins the two functions
 * to the same number, so they cannot drift apart silently.
 */
export function carFreeReachMinutes(): number {
  return Math.max(NO_CAR_DETOUR_MINUTES, Math.floor(NO_CAR_TRANSPORT_MINUTES / 2));
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
 * Three tiers of authority, in order:
 *
 * 1. **A driver** gets every ring; the detour slider negotiates the rest.
 * 2. **A region that has authored its car-free reach** is believed outright, in
 *    either direction — the Eastern Sierra's two rings are a fact about one
 *    seasonal trolley, not a default to widen.
 * 3. **Everywhere else** derives the offer from the traveller's own ride
 *    budget, the same figure the review card prints as "up to 75 min by public
 *    transport". The two surfaces used to disagree: this fell back to a
 *    thirty-minute cap for every compiled destination while the card promised
 *    seventy-five, which made Kamakura unreachable by any answer a Tokyo
 *    traveller could give. The offer is a *search radius*, not a promise of
 *    service — whether local transit actually delivers a ring is answered by
 *    research, and where it disappoints, the board says so.
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
  const reach = carFreeReachMinutes();
  return REGIONAL_EXPANSIONS.filter((value) => EXPANSION_CEILING_MINUTES[value] <= reach);
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

/** Every avoidance the vocabulary has, labelled. The review screen reads this
 * to name whatever is *stored* — including values that arrived through free
 * text or older saved answers rather than through the chips below. */
export const AVOIDANCE_OPTIONS: readonly Option<Avoidance>[] = AVOIDANCES.map((value) => ({
  value,
  label: AVOIDANCE_LABELS[value],
  detail: '',
}));

/**
 * The avoidances the constraints step actually offers as chips.
 *
 * The screen above them says "these become hard filters, not gentle nudges",
 * which is a promise, and two members of the vocabulary could not keep it:
 *
 * - `crowds_and_tourist_traps` duplicated the graded crowd control two steps
 *   earlier — the fourth surface collecting one preference — and the scorer
 *   already promotes `avoid_crowds` to the same table row the chip fed. The
 *   graded control is the one that stays; free text can still land the hard
 *   version for somebody who writes "no crowds".
 * - `cold_water` had no consumer anywhere: not the scorer, not the weather
 *   layer, not the planner. A control that promises a hard filter and feeds
 *   nothing is worse than its absence, so it is withheld until something can
 *   honestly read it (the place data carries no swimming-water temperatures
 *   yet). The enum member stays — stored answers and phrases still parse.
 *
 * `consumers.architecture.test.ts` holds this list to the promise: every value
 * offered here must have a consumer outside the questionnaire's own files.
 */
export const OFFERED_AVOIDANCES: readonly Avoidance[] = AVOIDANCES.filter(
  (value) => value !== 'crowds_and_tourist_traps' && value !== 'cold_water',
);

export const OFFERED_AVOIDANCE_OPTIONS: readonly Option<Avoidance>[] = OFFERED_AVOIDANCES.map(
  (value) => ({ value, label: AVOIDANCE_LABELS[value], detail: '' }),
);

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

