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
  interviewAnswerFields,
  questionnaireAnswersSchema,
  TRAVELER_PROFILE_VERSION,
  travelerProfileSchema,
  type DerivedProfile,
  type QuestionnaireAnswers,
  type TravelerProfile,
} from '../schemas/profile';
import type { HardConstraint } from '../schemas/interview';
import { z } from 'zod';
import {
  availableRegionalExpansions,
  carFreeReachMinutes,
  EXPANSION_CEILING_MINUTES,
  isQuestionVisible,
  NO_CAR_DETOUR_MINUTES,
  NO_CAR_TRANSPORT_MINUTES,
  QUESTIONNAIRE_STEPS,
  type QuestionnaireContext,
} from './definition';

/*
 * The car-free constants and the ring ceilings moved to `definition.ts`, where
 * `carFreeReachMinutes` needs them without importing this module backwards.
 * `@sidequest/core`'s surface is unchanged — the index star-exports definition —
 * and re-exporting them here as well would make the two star exports ambiguous,
 * which ESM resolves by silently dropping the symbol from the barrel.
 */

/**
 * The v2 interview fields at their silent values — what a traveller who was
 * never asked looks like. Spread into every hand-built answer set so the
 * literal keeps compiling as the interview grows, and so "silence" is defined
 * in exactly one place (the schema's own defaults).
 */
export function interviewDefaults(): Pick<
  QuestionnaireAnswers,
  keyof ReturnType<typeof interviewAnswerFields>
> {
  return z.object(interviewAnswerFields()).parse({});
}

export function defaultAnswers(context: QuestionnaireContext): QuestionnaireAnswers {
  const interests = Object.fromEntries(
    INTERESTS.map((interest) => [interest, 'low' as InterestLevel]),
  ) as Record<Interest, InterestLevel>;

  return {
    interests,
    /*
     * Empty, and that is a statement rather than a placeholder: nothing has been
     * interpreted for a traveller who has not written anything, which is a
     * different thing from a traveller with no preferences.
     */
    preferenceSignals: [],
    pace: 'balanced',
    freeTime: 'balanced',
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
    /*
     * Nobody has handed us a step yet. Distinct from accepting a default: the
     * values above are what silence looks like, and this list is what "you
     * decide" looks like, and downstream may treat only the second as licence.
     */
    decideForMe: [],
    ...interviewDefaults(),
  };
}

/**
 * HARD CONSTRAINTS LAND ON THE FIELDS EVERY CONSUMER ALREADY READS.
 *
 * A typed hard constraint is the traveller's strongest statement, and the
 * planner, the scorer and the composition prompt read the legacy fields —
 * `willDrive`, `maxDailyTravelMinutes`, `avoidances`, `dayStart` — so the
 * constraint is written onto those here, once, rather than every consumer
 * learning a second vocabulary. The typed list survives on the profile
 * (`profile.hard`) so a consumer that *can* tell hard from soft still can.
 */
export function applyHardConstraints(answers: QuestionnaireAnswers): QuestionnaireAnswers {
  const next: QuestionnaireAnswers = {
    ...answers,
    avoidances: [...answers.avoidances],
    mustInclude: [...answers.mustInclude],
    mustAvoid: [...answers.mustAvoid],
  };
  const avoid = (value: QuestionnaireAnswers['avoidances'][number]) => {
    if (!next.avoidances.includes(value)) next.avoidances.push(value);
  };
  for (const constraint of answers.hardConstraints) {
    switch (constraint.code) {
      case 'cannot_drive':
        next.willDrive = false;
        break;
      case 'max_daily_drive_minutes':
        if (constraint.value !== undefined) {
          next.maxDailyTravelMinutes = Math.max(30, Math.min(480, constraint.value));
          if (constraint.value <= 120) avoid('long_drives');
        }
        break;
      case 'max_walking_minutes':
        if (constraint.value !== undefined) {
          next.walkingTolerance = constraint.value <= 90 ? 'little' : constraint.value <= 200 ? 'moderate' : 'lots';
          next.maxAccessWalkMinutes = Math.min(next.maxAccessWalkMinutes, Math.max(0, Math.floor(constraint.value / 3)));
        }
        break;
      case 'no_boats':
        next.boatsAndFerries = 'cannot';
        break;
      case 'no_small_aircraft':
        next.internalFlights = 'cannot';
        break;
      case 'no_strenuous_hiking':
        avoid('strenuous_activity');
        avoid('long_hikes');
        if (next.hikeAppetite === 'half_day' || next.hikeAppetite === 'full_day') next.hikeAppetite = 'short';
        break;
      case 'wheelchair_accessible':
        next.mobilityLimited = true;
        next.stairsAndHills = 'cannot';
        break;
      case 'no_stairs':
        next.stairsAndHills = 'cannot';
        break;
      case 'dietary_absolute':
        if (next.dietaryNeeds.length > 0) next.dietaryStrict = true;
        break;
      case 'no_early_starts':
        next.dayStart = 'relaxed';
        avoid('early_mornings');
        break;
      case 'no_late_nights':
        next.lateNights = 'no';
        break;
      case 'no_remote_areas':
        next.remoteComfort = 'cannot';
        avoid('remote_areas_without_services');
        break;
      case 'no_high_altitude':
        next.altitudeComfort = 'avoid_high';
        avoid('high_altitude_exertion');
        break;
      case 'no_hotel_changes':
        next.baseMoveTolerance = 'stay_put';
        break;
      case 'must_include':
        if (constraint.text && !next.mustInclude.includes(constraint.text)) next.mustInclude.push(constraint.text);
        break;
      case 'must_avoid':
        if (constraint.text && !next.mustAvoid.includes(constraint.text)) next.mustAvoid.push(constraint.text);
        break;
      case 'must_be_back_by':
        // Read straight from the typed list by the profile builder; nothing legacy carries an hour.
        break;
    }
  }
  /*
   * A "cannot" tolerance is a hard constraint by definition, whichever screen
   * it was said on; the typed list is completed so `profile.hard` is the one
   * place that lists everything hard.
   */
  const implied: HardConstraint[] = [];
  if (next.boatsAndFerries === 'cannot') implied.push({ code: 'no_boats' });
  if (next.internalFlights === 'cannot') implied.push({ code: 'no_small_aircraft' });
  if (next.remoteComfort === 'cannot') implied.push({ code: 'no_remote_areas' });
  if (next.stairsAndHills === 'cannot') implied.push({ code: 'no_stairs' });
  if (next.altitudeComfort === 'avoid_high') implied.push({ code: 'no_high_altitude' });
  const seen = new Set(next.hardConstraints.map((c) => `${c.code}:${c.value ?? ''}:${c.text ?? ''}`));
  next.hardConstraints = [
    ...next.hardConstraints,
    ...implied.filter((c) => !seen.has(`${c.code}::`)),
  ];
  if (next.hikeAppetite === 'none') {
    next.interests = { ...next.interests, hiking: 'avoid' };
  } else if (next.hikeAppetite === 'short') {
    avoid('long_hikes');
  }
  next.mustInclude = [...new Set(next.mustInclude.map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  next.mustAvoid = [...new Set(next.mustAvoid.map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  return next;
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
  const next: QuestionnaireAnswers = applyHardConstraints(
    questionnaireAnswersSchema.parse({ ...answers, avoidances: [...answers.avoidances] }),
  );
  const input = { answers: next, context };

  if (!isQuestionVisible('dailyIntensity', input)) {
    next.dailyIntensity = 'light';
  }
  /*
   * The tourist-trap warning is derived, not asked. It was a fourth surface
   * collecting the one crowd preference — composer, graded control, a toggle,
   * and an avoidance chip — and the graded control is now the only collection
   * point. The derivation is the statement the traveller actually made: the
   * warning fires for somebody who said crowds ruin it, or who hard-ruled
   * crowds out in their own words, and not for "some is fine" — a shrug is not
   * a request to police fame. This is also, deliberately, the same formula the
   * benchmark request adapter writes, so its answers stay a fixed point of this
   * function.
   */
  next.avoidTouristTraps =
    next.crowdTolerance === 'avoid_crowds' ||
    (next.crowdTolerance !== 'dont_mind' && next.avoidances.includes('crowds_and_tourist_traps'));
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

  const allowedExpansions = availableRegionalExpansions(next.willDrive, context);
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

  /*
   * "Early mornings" as a hard filter lands on the day-start window — the one
   * field the planner actually reads for when a day begins. The avoidance was
   * offered as a hard filter and consumed by nothing, which made it a placebo;
   * the free-text path (`SOFT_REFUSAL` in `intent/apply.ts`) already maps a
   * dislike of early starts onto `dayStart: 'relaxed'`, and a checked hard
   * filter cannot honestly do less than a typed soft dislike.
   */
  if (next.avoidances.includes('early_mornings')) {
    next.dayStart = 'relaxed';
  }

  /*
   * Steps the traveller handed to us stop being handed over the moment they
   * are not: the wizard removes a step id when its answers are edited, and
   * this keeps the list canonical — deduplicated, in step order — so that two
   * saves of the same state are byte-identical.
   */
  if (next.decideForMe !== undefined) {
    const handed = new Set(next.decideForMe);
    next.decideForMe = QUESTIONNAIRE_STEPS.filter((step) => handed.has(step));
  }
  next.dietaryNeeds = [...new Set(next.dietaryNeeds)].sort();
  /*
   * "These are strict" is a statement about a REQUIREMENT — and a requirement is
   * a ticked need *or* a sentence the traveller wrote.
   *
   * PRODUCTION LOCK V5 §4. This used to clear the flag whenever the tick-list
   * was empty, which silently disagreed with the two places that own the
   * question: the interview catalog sets strictness from `needs.length > 0 ||
   * notes.length > 0` (`interview/catalog.ts`), and `interview/dietary.test.ts`
   * asserts in as many words that free text alone may be a requirement. So
   * somebody whose whole diet is "Severe peanut allergy — cross-contamination
   * matters", with nothing tickable, had their "I cannot" quietly downgraded to
   * "I would rather" one function after stating it.
   *
   * With neither a need nor a note it is still a stray boolean, and still
   * cleared: that is the case the original comment was about.
   */
  if (next.dietaryNeeds.length === 0 && (next.dietaryNotes ?? '').trim().length === 0) next.dietaryStrict = false;
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
    ...(answers.dietaryNotes ? { dietaryNotes: answers.dietaryNotes } : {}),
    specialMealBudget: specialMealBudget(answers.specialMealAppetite, context.tripDays),
    everydayPriceBand: EVERYDAY_BAND[answers.foodStyle],
    // `depends` deliberately reads as yes. Somebody who said "it depends on the
    // day" has asked to be given the choice, and a named cafe they can walk past
    // is a choice; an empty morning is not.
    wantsBreakfastVenue: answers.breakfastStyle !== 'skip',
  };
}

/**
 * How much riding and walking a day may hold on top of the driving budget.
 *
 * Not a preference the traveller stated — nobody has an opinion about this until
 * they are made to have one — so it is a stated default rather than a hidden
 * question. Ninety minutes covers a shuttle in, a shuttle out and the walk at
 * each end, which is what an access day actually costs.
 */
export const ACCESS_TRAVEL_ALLOWANCE_MINUTES = 90;

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
  /*
   * Hard effort at altitude caps effort the same way the other two do. The
   * place data does not carry elevations, so "strenuous, but only when high"
   * is not a distinction anything downstream can honour yet — and an avoidance
   * that was offered as a hard filter and read by nothing was a placebo. The
   * intensity ceiling is the blunt-but-real consumer this vocabulary has.
   */
  if (answers.avoidances.includes('high_altitude_exertion')) {
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
  const stated = answers.detourToleranceMinutes > 0 ? answers.detourToleranceMinutes : ceiling;
  /*
   * ONE ANSWER, TWO CAPS, AND THE ANSWER SURVIVES EITHER WAY.
   *
   * A traveller with no car answered "furthest you would travel one way for one
   * stop" on the same 15–180 slider a driver sees, and answered the ring
   * question on an offer that already reaches `carFreeReachMinutes()`. Both
   * answers were then discarded and replaced by the constant below, so the
   * questionnaire and this function contradicted each other on the same screen:
   * the region step offered an hour out by public transport and the profile
   * recorded twenty minutes. Every radius derived from this — the board's detour
   * class, the fit score's detour term, the pre-selection, the planner's walking
   * bound — then held a car-free trip to a walk-out radius nobody chose.
   *
   * So the shape is the driver's shape, with the one cap that differs: a ride is
   * bounded by half the car-free transport budget rather than by half a day at
   * the wheel, because a detour is a there-and-back. `NO_CAR_DETOUR_MINUTES` is
   * the floor and not the value — an untouched slider on a stay-in-town ring
   * still yields today's walk-out radius, and nothing can push it below that.
   */
  const effectiveDetourMinutes = answers.willDrive
    ? Math.max(0, Math.min(ceiling, stated, halfDayCap))
    : Math.max(NO_CAR_DETOUR_MINUTES, Math.min(ceiling, stated, carFreeReachMinutes()));

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
    freeTime: answers.freeTime,
    budgetStyle: answers.budgetStyle,
    discoveryMix: answers.discoveryMix,
    crowdTolerance: answers.crowdTolerance,
    avoidTouristTraps: answers.avoidTouristTraps,
    transport: transportPreferencesFrom(answers),
    food: deriveFoodPreferences(answers, context),
    regionalExpansion: answers.regionalExpansion,
    detourToleranceMinutes: answers.detourToleranceMinutes,
    avoidances: answers.avoidances,
    /*
     * Copied, never re-derived. The taxonomy was applied once, at confirmation,
     * against the traveller's own characters; deriving it a second time here
     * from the flattened answers would lose exactly the resolution the vector
     * exists to preserve.
     */
    preferenceSignals: answers.preferenceSignals ?? [],
    accessibility: {
      mobilityLimited: answers.mobilityLimited,
      ...(answers.accessibilityNotes ? { notes: answers.accessibilityNotes } : {}),
    },
    interview: interviewBlockFrom(answers),
    hard: [...answers.hardConstraints],
    provenance: { ...answers.provenance },
    ...(answers.preferenceNotes && Object.keys(answers.preferenceNotes).length > 0 ? { preferenceNotes: { ...answers.preferenceNotes } } : {}),
    derived: deriveProfileValues(answers, context),
  };

  return travelerProfileSchema.parse(profile);
}

/**
 * The interview dimensions, copied onto the profile after normalisation.
 *
 * `mustBeBackByMinute` and `maxWalkingMinutesPerDay` are the two hard values
 * nothing legacy can carry, so they are read off the typed list here and
 * nowhere else.
 */
export function interviewBlockFrom(answers: QuestionnaireAnswers): TravelerProfile['interview'] {
  const backBy = answers.hardConstraints.find((c) => c.code === 'must_be_back_by' && c.value !== undefined);
  const walking = answers.hardConstraints.find((c) => c.code === 'max_walking_minutes' && c.value !== undefined);
  return {
    baseMoveTolerance: answers.baseMoveTolerance,
    iconicCrowdStrategy: answers.iconicCrowdStrategy,
    convenienceSpend: answers.convenienceSpend,
    lodgingStyle: answers.lodgingStyle,
    rusticLodgingOk: answers.rusticLodgingOk,
    ...(answers.budgetEnvelope ? { budgetEnvelope: answers.budgetEnvelope } : {}),
    guideWillingness: answers.guideWillingness,
    privateTransfers: answers.privateTransfers,
    boatsAndFerries: answers.boatsAndFerries,
    internalFlights: answers.internalFlights,
    remoteComfort: answers.remoteComfort,
    altitudeComfort: answers.altitudeComfort,
    hikeAppetite: answers.hikeAppetite,
    walkingTolerance: answers.walkingTolerance,
    stairsAndHills: answers.stairsAndHills,
    lateNights: answers.lateNights,
    dayTripAppetite: answers.dayTripAppetite,
    scopeStrategy: answers.scopeStrategy,
    everyoneEveryDay: answers.everyoneEveryDay,
    ...(answers.groupNotes ? { groupNotes: answers.groupNotes } : {}),
    mustInclude: [...answers.mustInclude],
    mustAvoid: [...answers.mustAvoid],
    ...(backBy?.value !== undefined ? { mustBeBackByMinute: backBy.value } : {}),
    ...(walking?.value !== undefined ? { maxWalkingMinutesPerDay: walking.value } : {}),
  };
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
