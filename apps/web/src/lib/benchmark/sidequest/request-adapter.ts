import {
  FIELD_TIERS,
  type BenchmarkFieldPath,
  type BenchmarkInterest,
  type BenchmarkTripRequest,
  type FieldTier,
} from '@sidequest/bench';
import {
  countTripDays,
  isQuestionVisible,
  normalizeAnswers,
  type Avoidance,
  type DietaryNeed,
  type Interest,
  type InterestLevel,
  type QuestionnaireAnswers,
  type QuestionnaireContext,
  type TravelerNeed,
} from '@sidequest/core';

import type { ComposerInput } from '../../../app/(product)/trips/new/actions';

/**
 * THE SHARED REQUEST, IN SIDEQUEST'S OWN WORDS.
 *
 * One traveller, described once, handed to two systems. This file is the whole
 * of what the deterministic pipeline is allowed to hear, and its only job is to
 * translate — never to help. Three properties are enforced rather than intended.
 *
 * **It is total.** Every path in `FIELD_TIERS` comes back with a verdict. A
 * field that has nowhere to land in Sidequest says so out loud; the alternative
 * is a benchmark where an answer evaporates at the boundary and the result is
 * attributed to the planner rather than to the adapter that dropped it.
 *
 * **It states nothing the traveller did not.** `buildTravelerProfile` derives
 * `frequencyCaps`, `effectiveDetourMinutes`, `maxDailyTransportMinutes` and the
 * rest from the answers below. Supplying any of them here would hand the
 * pipeline a model the request deliberately withholds from both systems.
 *
 * **It never falls through to a default on a contested word.** Four vocabulary
 * collisions live in this repository and each one is a silent-wrong-answer
 * waiting to happen, because in every case the wrong enum member also parses:
 *
 *   | concept | shared request | Sidequest profile | Sidequest composer |
 *   | --- | --- | --- | --- |
 *   | crowds | `avoid_crowds`/`mild`/`dont_mind` | the same three | `avoid`/`tolerate`/`unbothered` |
 *   | pace | `slow`/`balanced`/`fast` | `slow`/`balanced`/`fast` | `slow`/`balanced`/`packed` |
 *   | budget | `midrange` | `midrange` | `mid_range` |
 *   | transport | five-member preference | a `willDrive` boolean | four-member intent |
 *
 * A fifth, `CROWD_LEVELS`, looks like a crowd vocabulary and is a property of a
 * *place* rather than of a traveller; it is named here so nobody maps onto it by
 * accident. Every one of these is a literal table below, and a test walks each
 * table exhaustively.
 *
 * ---
 *
 * THE SUPPRESSION TRAP.
 *
 * `normalizeAnswers` overwrites eight answers whose question the traveller was
 * never shown — road comfort without a car, tourist-trap avoidance from somebody
 * who does not mind crowds, an intensity from somebody with limited mobility.
 * That rule is right, and it is invisible: an adapter that wrote a value into one
 * of those fields would watch it disappear on the way to the profile with
 * nothing on any screen saying so.
 *
 * So this adapter applies the same visibility rules itself, using
 * `isQuestionVisible` rather than a second copy of them, and reports the field as
 * `not_representable` when the question is hidden. `suppressedFields` then diffs
 * the result against `normalizeAnswers` and marks any row that still moved. For a
 * coherent request that diff is empty — and if it is ever not, the parity report
 * shows it rather than swallowing it.
 */

export const PARITY_VERDICTS = ['binding', 'advisory', 'not_representable'] as const;

/**
 * What became of one field of the shared request.
 *
 * - `binding` — it reached a value the planner reads when it builds a day.
 * - `advisory` — it is stored where a person could read it back, and nothing in
 *   the deterministic pipeline consults it.
 * - `not_representable` — Sidequest has no field for it, and it stopped here.
 */
export type ParityVerdict = (typeof PARITY_VERDICTS)[number];

export interface ParityEntry {
  path: BenchmarkFieldPath;
  tier: FieldTier;
  verdict: ParityVerdict;
  /** The Sidequest field this landed in, or null when nothing carried it. */
  mappedTo: string | null;
  /**
   * Set when `normalizeAnswers` changed a value this adapter wrote.
   *
   * Always false for a coherent request. It exists because the alternative to
   * reporting a silent overwrite is not noticing one.
   */
  suppressed?: boolean;
  /** What was lost, or which of several targets took it. Never boilerplate. */
  note?: string;
}

export interface QuestionnaireMapping {
  answers: QuestionnaireAnswers;
  parity: ParityEntry[];
}

/* ------------------------------------------------------------------ *
 * Vocabulary tables
 * ------------------------------------------------------------------ */

/**
 * Pace. Two enumerations, differing in exactly one member, and the odd one out
 * is the member most likely to be chosen by a traveller who wants a lot.
 */
const COMPOSER_PACE: Record<BenchmarkTripRequest['rhythm']['pace'], 'slow' | 'balanced' | 'packed'> =
  { slow: 'slow', balanced: 'balanced', fast: 'packed' };

const PROFILE_PACE: Record<BenchmarkTripRequest['rhythm']['pace'], QuestionnaireAnswers['pace']> = {
  slow: 'slow',
  balanced: 'balanced',
  fast: 'fast',
};

/** Crowds, in the two traveller-facing vocabularies. Never `CROWD_LEVELS`. */
const PROFILE_CROWD: Record<
  BenchmarkTripRequest['taste']['crowdTolerance'],
  QuestionnaireAnswers['crowdTolerance']
> = { avoid_crowds: 'avoid_crowds', mild: 'mild', dont_mind: 'dont_mind' };

const COMPOSER_CROWD: Record<
  BenchmarkTripRequest['taste']['crowdTolerance'],
  'avoid' | 'tolerate' | 'unbothered'
> = { avoid_crowds: 'avoid', mild: 'tolerate', dont_mind: 'unbothered' };

/** Budget. The same four bands, spelled two ways. */
const PROFILE_BUDGET: Record<
  BenchmarkTripRequest['practicalities']['budget'],
  QuestionnaireAnswers['budgetStyle']
> = { budget: 'budget', midrange: 'midrange', premium: 'premium', luxury: 'luxury' };

const COMPOSER_BUDGET: Record<
  BenchmarkTripRequest['practicalities']['budget'],
  'budget' | 'mid_range' | 'premium' | 'luxury'
> = { budget: 'budget', midrange: 'mid_range', premium: 'premium', luxury: 'luxury' };

/**
 * Transport. The shared request states a *preference* over five options; the
 * composer states an *intent* over four; the questionnaire states one boolean.
 *
 * `guided_or_transfers` is the member with no counterpart anywhere: somebody
 * being driven is not driving, and Sidequest's nearest true statement is that
 * they are not at the wheel. Mapping it to `mixed` because both words sound
 * accommodating would put a hire car in a plan for somebody who asked for a
 * driver.
 */
const COMPOSER_TRANSPORT: Record<
  BenchmarkTripRequest['movement']['preference'],
  'drive' | 'public_transport' | 'mixed' | 'undecided'
> = {
  drive: 'drive',
  public_transport: 'public_transport',
  mixed: 'mixed',
  guided_or_transfers: 'public_transport',
  no_preference: 'undecided',
};

/**
 * How the request's twenty-eight interests land on Sidequest's twelve.
 *
 * `null` is a real entry and there are ten of them. The board cannot rank a
 * nightclub, a ski lift or a theme park, because no rung of `Interest` describes
 * one — so a traveller whose trip is built around any of those is asking for
 * something this pipeline structurally cannot offer, and the parity report says
 * so by name rather than leaving a quiet zero.
 *
 * `beaches_and_swimming → lakes_and_rivers` is the one stretch, and it is
 * deliberate: the rung means water you get into, the alternative was to drop the
 * strongest stated interest of every coastal case, and dropping it silently
 * would have been worse than mapping it visibly.
 */
const INTEREST_MAP: Record<BenchmarkInterest, Interest | null> = {
  hiking: 'hiking',
  easy_nature_walks: 'easy_nature_walks',
  scenic_viewpoints: 'scenic_viewpoints',
  lakes_and_rivers: 'lakes_and_rivers',
  beaches_and_swimming: 'lakes_and_rivers',
  scenic_drives: 'scenic_drives',
  wildlife: 'wildlife',
  geology_and_geothermal: 'geology_and_geothermal',
  hot_springs: 'hot_springs',
  history_and_culture: 'history_and_culture',
  museums_and_galleries: 'history_and_culture',
  architecture: 'history_and_culture',
  food_and_towns: 'food_and_towns',
  markets_and_street_food: 'food_and_towns',
  fine_dining: 'food_and_towns',
  cafes: 'food_and_towns',
  local_neighbourhoods: 'food_and_towns',
  photography_golden_hour: 'photography_golden_hour',
  stargazing: 'stargazing',
  nightlife: null,
  shopping: null,
  festivals_and_events: null,
  wellness_and_spa: null,
  boats_and_ferries: null,
  trains: null,
  winter_sports: null,
  diving_and_snorkelling: null,
  theme_parks: null,
};

/**
 * Hard avoidances. Twelve of the sixteen have a rung; four do not.
 *
 * `rough_or_unpaved_roads → rough_or_gravel_roads` is the second spelling
 * collision in this file and the one that would have failed silently, because
 * both strings are plausible names for the same road.
 */
const AVOIDANCE_MAP: Record<
  BenchmarkTripRequest['taste']['hardAvoidances'][number],
  Avoidance | null
> = {
  crowds_and_tourist_traps: 'crowds_and_tourist_traps',
  long_hikes: 'long_hikes',
  strenuous_activity: 'strenuous_activity',
  long_drives: 'long_drives',
  rough_or_unpaved_roads: 'rough_or_gravel_roads',
  high_altitude_exertion: 'high_altitude_exertion',
  early_mornings: 'early_mornings',
  remote_areas_without_services: 'remote_areas_without_services',
  expensive_activities: 'expensive_activities',
  cold_water: 'cold_water',
  extreme_heat: 'extreme_heat',
  extreme_cold: 'extreme_cold',
  boats_and_ferries: null,
  nightlife: null,
  heights_and_exposure: null,
  small_aircraft: null,
};

/** Dietary needs. The two lists happen to coincide; the table asserts it. */
const DIETARY_MAP: Record<BenchmarkTripRequest['party']['dietary'][number], DietaryNeed> = {
  vegetarian: 'vegetarian',
  vegan: 'vegan',
  gluten_free: 'gluten_free',
  dairy_free: 'dairy_free',
  nut_allergy: 'nut_allergy',
  halal: 'halal',
  kosher: 'kosher',
};

/**
 * How much the traveller cares about food, as the two questions Sidequest asks.
 *
 * `foodStyle` decides the price ceiling every ordinary meal is held to and
 * `specialMealAppetite` decides how many evenings may be an event, so a single
 * importance answer has to reach both or the food planner hears half of it.
 */
const FOOD_STYLE: Record<
  BenchmarkTripRequest['taste']['foodImportance'],
  QuestionnaireAnswers['foodStyle']
> = { not_at_all: 'budget', a_little: 'local_casual', matters: 'balanced', central: 'destination' };

const SPECIAL_MEALS: Record<
  BenchmarkTripRequest['taste']['foodImportance'],
  QuestionnaireAnswers['specialMealAppetite']
> = { not_at_all: 'none', a_little: 'none', matters: 'one', central: 'a_few' };

const DAY_START: Record<
  BenchmarkTripRequest['rhythm']['earlyMornings'],
  QuestionnaireAnswers['dayStart']
> = { happily: 'early', sometimes: 'normal', never: 'relaxed' };

const INTEREST_ORDER: readonly InterestLevel[] = ['avoid', 'low', 'occasional', 'frequent', 'core'];

/* ------------------------------------------------------------------ *
 * Party
 * ------------------------------------------------------------------ */

/**
 * The four group facts Sidequest plans differently for.
 *
 * `kids_under_12` is the only judgement here. The request states ages and
 * Sidequest asks for a tick, so a party with children and no ages given is
 * ticked — the alternative reading, that unstated ages mean teenagers, would
 * plan a family trip as an adult one on the strength of a field nobody filled
 * in.
 */
export function toTravelerNeeds(request: BenchmarkTripRequest): TravelerNeed[] {
  const needs = new Set<TravelerNeed>();
  const { party } = request;

  if (party.children > 0 && (party.childAges.length === 0 || party.childAges.some((age) => age < 12))) {
    needs.add('kids_under_12');
  }
  if (party.seniorsInGroup) needs.add('seniors_in_group');
  if (party.mobility.includes('altitude_sensitive')) needs.add('altitude_sensitive');
  // Four of the six mobility constraints collapse onto one tick. That is lossy
  // and it is the whole of what Sidequest models: a wheelchair user and somebody
  // with low stamina both get the intensity ceiling, and neither gets a step-free
  // route, because no such data exists to plan against.
  if (party.mobility.some((entry) => entry !== 'none' && entry !== 'altitude_sensitive')) {
    needs.add('mobility_limited');
  }
  return [...needs].sort();
}

/** The context both `normalizeAnswers` and `buildTravelerProfile` are given. */
export function toQuestionnaireContext(request: BenchmarkTripRequest): QuestionnaireContext {
  const { startDate, endDate } = materialisedDates(request);
  return {
    travelerNeeds: toTravelerNeeds(request),
    tripDays:
      startDate && endDate ? countTripDays(startDate, endDate) : request.dates.nights + 1,
  };
}

/* ------------------------------------------------------------------ *
 * The composer
 * ------------------------------------------------------------------ */

/**
 * The shared request as the trip-creation form would have been filled in.
 *
 * Returns `ComposerInput` rather than a hand-built `TripComposerAnswers` and
 * `TripBasics`, and that is the point: `createTripFromComposer` is the only
 * thing in the product that mints those two, and it does so together — the
 * composer keeps `dates.mode` while the trip row gets two materialised dates, so
 * that nothing downstream can present a placeholder as a decision. An adapter
 * that assembled the pair itself would be a second copy of that rule, free to
 * drift, and the benchmark would slowly stop measuring the product.
 */
export function toComposerAnswers(request: BenchmarkTripRequest): ComposerInput {
  const { dateMode, startDate, endDate } = materialisedDates(request);

  return {
    destinationText: request.destination.text,
    /*
     * Null, always. The index id the composer accepts names a row in
     * Sidequest's own pinned catalogue release; the request's `identity.id`
     * names a row in the benchmark's shared inventory. Passing one for the other
     * would be read back as "no such entry" and silently drop the destination,
     * so the typed text goes through the resolver exactly as a traveller's would.
     */
    destinationEntryId: null,
    dateMode,
    startDate,
    endDate,
    flexDays: Math.min(14, request.dates.flexDays),
    month: request.dates.month ?? monthOf(startDate) ?? 1,
    // Never read: no shared request can state a season, and `dateMode` is never
    // `season`. Present because the input schema requires a value.
    season: 'summer',
    wantsDateRecommendation: false,
    wantsLengthRecommendation: false,
    nights: request.dates.nights,
    arrivalPrecision: request.arrival.precision,
    departurePrecision: request.departure.precision,
    adults: request.party.adults,
    children: request.party.children,
    travelerNeeds: toTravelerNeeds(request),
    shape: shapeFor(request.movement.desiredBaseCount),
    pace: COMPOSER_PACE[request.rhythm.pace],
    transport: COMPOSER_TRANSPORT[request.movement.preference],
    budget: COMPOSER_BUDGET[request.practicalities.budget],
    themes: [],
    crowdTolerance: COMPOSER_CROWD[request.taste.crowdTolerance],
    outdoorIntensity: OUTDOOR_INTENSITY[request.rhythm.activityIntensity],
    foodImportance: COMPOSER_FOOD_IMPORTANCE[request.taste.foodImportance],
    freeTime: request.rhythm.freeTime,
    mustDo: request.taste.mustDo.join('. ').slice(0, 600),
    avoid: request.taste.dislikes.join('. ').slice(0, 600),
    origin: request.origin.slice(0, 120),
  };
}

const OUTDOOR_INTENSITY: Record<
  BenchmarkTripRequest['rhythm']['activityIntensity'],
  'gentle' | 'moderate' | 'strenuous'
> = { light: 'gentle', moderate: 'moderate', intense: 'strenuous' };

const COMPOSER_FOOD_IMPORTANCE: Record<
  BenchmarkTripRequest['taste']['foodImportance'],
  'fuel' | 'matters' | 'central'
> = { not_at_all: 'fuel', a_little: 'fuel', matters: 'matters', central: 'central' };

function shapeFor(desiredBaseCount: number): 'one_base' | 'two_bases' | 'circuit' {
  if (desiredBaseCount <= 1) return 'one_base';
  if (desiredBaseCount === 2) return 'two_bases';
  return 'circuit';
}

/** The scope strategy the preflight would have been answered with. */
export function toScopeStrategyId(request: BenchmarkTripRequest): string {
  const shape = shapeFor(request.movement.desiredBaseCount);
  if (shape === 'one_base') return 'one_area';
  return shape === 'two_bases' ? 'two_bases' : 'circuit';
}

/**
 * The clarification answers the request already contains.
 *
 * Deliberately partial. `scope.gateways` asks about a fixed airport, which the
 * request has no field for, and `destination.not-a-place` asks the traveller to
 * try again — neither can be answered from what was stated, so neither is, and a
 * run that stalls on a required one stalls honestly.
 */
export function toClarificationAnswers(
  request: BenchmarkTripRequest,
): { questionId: string; values: string[] }[] {
  const carAvailable = drivesOwnCar(request);
  const ferries =
    request.movement.willUseShuttlesAndFerries &&
    !request.taste.hardAvoidances.includes('boats_and_ferries');

  return [
    { questionId: 'transport.car-available', values: [carAvailable ? 'yes' : 'no'] },
    {
      questionId: 'transport.remote-roads',
      values: [request.movement.comfortableUnpavedRoads ? 'yes' : 'no'],
    },
    // `ferry_only` is unreachable from this request and that is correct: nothing
    // in it distinguishes a ferry from a light aircraft, and inventing the
    // distinction would answer a question the traveller was never asked.
    { questionId: 'transport.water-or-air-transfers', values: [ferries ? 'yes' : 'no'] },
  ];
}

/* ------------------------------------------------------------------ *
 * The questionnaire
 * ------------------------------------------------------------------ */

export function toQuestionnaireAnswers(
  request: BenchmarkTripRequest,
  /**
   * Answers from the other arm's follow-up round that no request field carries.
   *
   * Applied over the translated draft rather than merged into the request,
   * because they are not things the traveller stated in the shared request —
   * they are things they said afterwards, in answer to a question, and the
   * parity report says so by name.
   */
  overrides: { willPackLunch?: boolean } = {},
): QuestionnaireMapping {
  const context = toQuestionnaireContext(request);
  const mobilityLimited = context.travelerNeeds.includes('mobility_limited');
  const willDrive = drivesOwnCar(request);
  const { taste, movement, rhythm, party } = request;

  const interests = mapInterests(request);
  const avoidances = mapAvoidances(request, mobilityLimited);
  const dietaryNeeds = [...new Set(party.dietary.map((need) => DIETARY_MAP[need]))].sort();

  /*
   * A draft, built before the visibility rules are consulted, because
   * `isQuestionVisible` reads five of these answers to decide what the traveller
   * would have been shown. Asking it about a half-built object is how the two
   * halves of this function would disagree.
   */
  const draft: QuestionnaireAnswers = {
    interests,
    preferenceSignals: [],
    pace: PROFILE_PACE[rhythm.pace],
    dayStart: DAY_START[rhythm.earlyMornings],
    dailyIntensity: mobilityLimited ? 'light' : rhythm.activityIntensity,
    budgetStyle: PROFILE_BUDGET[request.practicalities.budget],
    discoveryMix: taste.discoveryMix,
    crowdTolerance: PROFILE_CROWD[taste.crowdTolerance],
    avoidTouristTraps: false,
    willDrive,
    comfortableMountainRoads: false,
    comfortableGravelRoads: false,
    maxDailyTravelMinutes: clamp(
      willDrive ? movement.maxDailyDriveMinutes : movement.maxDailyTravelMinutes,
      30,
      480,
    ),
    willUseShuttles: true,
    maxAccessWalkMinutes: clamp(movement.maxAccessWalkMinutes, 0, 120),
    transportPriority: 'best_value',
    /*
     * How far out of town to look, and nothing in the shared request says.
     *
     * So this is Sidequest's own answer rather than a translation of anybody's,
     * and no parity row claims otherwise. The one adjustment is the car-free
     * ceiling: `availableRegionalExpansions` clamps a driver's radius down for a
     * traveller without a car, and writing the wider value only to watch it
     * clamped would be a suppression this file exists to prevent.
     */
    regionalExpansion: willDrive ? 'nearby_60' : 'nearby_30',
    detourToleranceMinutes: 60,
    avoidances,
    mobilityLimited,
    ...(party.mobilityNotes ? { accessibilityNotes: party.mobilityNotes.slice(0, 500) } : {}),
    breakfastStyle: 'coffee_light',
    foodStyle: FOOD_STYLE[taste.foodImportance],
    specialMealAppetite: SPECIAL_MEALS[taste.foodImportance],
    willPackLunch: overrides.willPackLunch ?? true,
    dietaryNeeds,
    dietaryStrict: dietaryNeeds.length > 0 && party.dietaryStrict,
  };

  const visible = (id: Parameters<typeof isQuestionVisible>[0]): boolean =>
    isQuestionVisible(id, { answers: draft, context });

  const roadComfortVisible = visible('roadComfort');
  const shuttleVisible = visible('shuttleUse');
  const touristTrapsVisible = visible('avoidTouristTraps');
  const intensityVisible = visible('dailyIntensity');
  const specialMealVisible = visible('specialMealAppetite');

  const answers: QuestionnaireAnswers = {
    ...draft,
    comfortableMountainRoads: roadComfortVisible && movement.comfortableMountainRoads,
    comfortableGravelRoads: roadComfortVisible && movement.comfortableUnpavedRoads,
    /*
     * Two stated fields, one control, and a conjunction rather than a
     * last-writer-wins. Somebody who will not take a shuttle and somebody who
     * avoids public transport both want the same thing from a plan, and letting
     * either alone decide would drop the other's answer.
     */
    willUseShuttles: shuttleVisible
      ? movement.willUseShuttlesAndFerries && movement.publicTransit !== 'avoid'
      : true,
    /*
     * Read off the two things the traveller did say, rather than left at
     * Sidequest's default of `true`. "Crowds ruin it" is a statement about
     * tourist traps; "some is fine" without a hard avoidance is not.
     */
    avoidTouristTraps:
      touristTrapsVisible &&
      (taste.crowdTolerance === 'avoid_crowds' ||
        taste.hardAvoidances.includes('crowds_and_tourist_traps')),
    dailyIntensity: intensityVisible ? rhythm.activityIntensity : 'light',
    specialMealAppetite: specialMealVisible ? SPECIAL_MEALS[taste.foodImportance] : 'none',
  };

  const parity = buildParity(request, {
    answers,
    willDrive,
    roadComfortVisible,
    shuttleVisible,
    touristTrapsVisible,
    intensityVisible,
  });

  for (const field of suppressedFields(answers, context)) {
    for (const entry of parity) {
      if (entry.mappedTo?.includes(`questionnaire.${field}`)) entry.suppressed = true;
    }
  }

  return { answers, parity };
}

/**
 * Which answers `normalizeAnswers` changed.
 *
 * A shallow diff over the scalar fields plus a set comparison over the two
 * arrays, which is exactly the shape of what normalisation does. Returned as
 * field names rather than a boolean so the parity report can name the loss.
 */
export function suppressedFields(
  answers: QuestionnaireAnswers,
  context: QuestionnaireContext,
): string[] {
  const normalised = normalizeAnswers(answers, context);
  const changed: string[] = [];

  const scalars: (keyof QuestionnaireAnswers)[] = [
    'dailyIntensity',
    'avoidTouristTraps',
    'comfortableMountainRoads',
    'comfortableGravelRoads',
    'willUseShuttles',
    'regionalExpansion',
    'detourToleranceMinutes',
    'specialMealAppetite',
    'mobilityLimited',
    'dietaryStrict',
  ];
  for (const field of scalars) {
    if (answers[field] !== normalised[field]) changed.push(field);
  }
  if (!sameSet(answers.avoidances, normalised.avoidances)) changed.push('avoidances');
  if (!sameSet(answers.dietaryNeeds, normalised.dietaryNeeds)) changed.push('dietaryNeeds');
  return changed;
}

/* ------------------------------------------------------------------ *
 * The parity report
 * ------------------------------------------------------------------ */

interface ParityContext {
  answers: QuestionnaireAnswers;
  willDrive: boolean;
  roadComfortVisible: boolean;
  shuttleVisible: boolean;
  touristTrapsVisible: boolean;
  intensityVisible: boolean;
}

function buildParity(request: BenchmarkTripRequest, context: ParityContext): ParityEntry[] {
  const rows = new Map<BenchmarkFieldPath, Omit<ParityEntry, 'path' | 'tier'>>();
  const say = (
    path: BenchmarkFieldPath,
    verdict: ParityVerdict,
    mappedTo: string | null,
    note?: string,
  ): void => {
    rows.set(path, { verdict, mappedTo, ...(note ? { note } : {}) });
  };

  const { movement, taste, conditions, party, dates } = request;
  const { dateMode } = materialisedDates(request);

  // --- Destination ------------------------------------------------------
  say(
    'destination.mode',
    request.destination.mode === 'known' ? 'binding' : 'not_representable',
    request.destination.mode === 'known' ? 'composer.mode' : null,
    request.destination.mode === 'undecided'
      ? 'Sidequest has a `help_me_decide` mode and the trip-creation door does not offer it; an undecided destination is created as a known one against whatever text was typed.'
      : undefined,
  );
  say('destination.text', 'binding', 'composer.destinationQuery, trip.basics.destinationInput');
  say(
    'destination.identity',
    'not_representable',
    null,
    'The resolved identity belongs to the shared inventory. Sidequest mints its own through the resolver, and there is no door that accepts a foreign one — forcing it would bypass the resolution step under test.',
  );

  // --- Dates ------------------------------------------------------------
  say(
    'dates.mode',
    'binding',
    'composer.dates.mode',
    dateMode === dates.mode
      ? undefined
      : `Stated as ${dates.mode} without two dates, which the composer cannot store; carried as ${dateMode}.`,
  );
  say('dates.startDate', 'binding', 'composer.dates.startDate, trip.basics.startDate');
  say('dates.endDate', 'binding', 'composer.dates.endDate, trip.basics.endDate');
  say('dates.flexDays', 'advisory', 'composer.dates.flexDays');
  say('dates.month', dates.month === null ? 'not_representable' : 'binding', dates.month === null ? null : 'composer.dates.month');
  say(
    'dates.year',
    'not_representable',
    null,
    'The composer derives the year from the dates it materialises and offers no field for one, so a month stated for a particular year is planned in whichever year that month falls next.',
  );
  say('dates.nights', 'binding', 'composer.duration.nights');

  // --- Edges ------------------------------------------------------------
  const edgeNote =
    'The trip-creation door carries a precision band and no clock time, so an exact arrival is planned from the band default rather than from the stated minute.';
  say(
    'arrival',
    'binding',
    'composer.arrival.precision, trip.basics.arrivalTime',
    request.arrival.precision === 'exact' ? edgeNote : undefined,
  );
  say(
    'departure',
    'binding',
    'composer.departure.precision, trip.basics.departureTime',
    request.departure.precision === 'exact' ? edgeNote : undefined,
  );
  say('origin', 'advisory', 'composer.origin');

  // --- Party ------------------------------------------------------------
  say('party.adults', 'binding', 'trip.basics.adults');
  say('party.children', 'binding', 'trip.basics.children');
  say(
    'party.childAges',
    party.children > 0 ? 'binding' : 'not_representable',
    party.children > 0 ? 'trip.basics.travelerNeeds[kids_under_12]' : null,
    'Sidequest asks for one tick rather than ages; every age under twelve produces the same answer.',
  );
  say('party.seniorsInGroup', 'binding', 'trip.basics.travelerNeeds[seniors_in_group]');
  say(
    'party.mobility',
    party.mobility.length === 0 ? 'not_representable' : 'binding',
    party.mobility.length === 0
      ? null
      : 'trip.basics.travelerNeeds[mobility_limited], questionnaire.mobilityLimited',
    'Four of the six constraints collapse onto one tick, which caps intensity and nothing else; no step-free routing exists to plan against.',
  );
  say('party.mobilityNotes', party.mobilityNotes ? 'advisory' : 'not_representable', party.mobilityNotes ? 'questionnaire.accessibilityNotes' : null);
  say('party.dietary', 'binding', 'questionnaire.dietaryNeeds');
  say('party.dietaryStrict', 'binding', 'questionnaire.dietaryStrict');

  // --- Movement ---------------------------------------------------------
  say('movement.preference', 'binding', 'composer.transport, questionnaire.willDrive');
  say(
    'movement.publicTransit',
    context.shuttleVisible ? 'binding' : 'not_representable',
    context.shuttleVisible ? 'questionnaire.willUseShuttles' : null,
    context.shuttleVisible
      ? undefined
      : 'Sidequest offers a traveller without a car no way to decline shuttles and buses, because without one they are the entire transport plan rather than a preference.',
  );
  say('movement.carAvailable', 'binding', 'questionnaire.willDrive');
  say(
    'movement.comfortableMountainRoads',
    context.roadComfortVisible ? 'binding' : 'not_representable',
    context.roadComfortVisible ? 'questionnaire.comfortableMountainRoads' : null,
    context.roadComfortVisible ? undefined : 'Road comfort is not asked of a traveller who is not driving.',
  );
  say(
    'movement.comfortableUnpavedRoads',
    context.roadComfortVisible ? 'binding' : 'not_representable',
    context.roadComfortVisible ? 'questionnaire.comfortableGravelRoads' : null,
    context.roadComfortVisible ? undefined : 'Road comfort is not asked of a traveller who is not driving.',
  );
  say(
    'movement.willUseShuttlesAndFerries',
    context.shuttleVisible ? 'binding' : 'not_representable',
    context.shuttleVisible ? 'questionnaire.willUseShuttles' : null,
    'Ferries and shuttles share one control; the clarification answer about water crossings carries the rest.',
  );
  say(
    'movement.maxDailyDriveMinutes',
    context.willDrive ? 'binding' : 'not_representable',
    context.willDrive ? 'questionnaire.maxDailyTravelMinutes' : null,
    context.willDrive && movement.maxDailyDriveMinutes > 480
      ? 'Clamped to the eight-hour ceiling the questionnaire accepts.'
      : undefined,
  );
  say(
    'movement.maxDailyTravelMinutes',
    context.willDrive ? 'not_representable' : 'advisory',
    context.willDrive ? null : 'questionnaire.maxDailyTravelMinutes',
    context.willDrive
      ? 'Sidequest derives its total transport budget from the driving cap plus a fixed access allowance, so a separately stated total has nowhere to land.'
      : 'Stored, and not read: a traveller without a car is given a fixed car-free transport budget.',
  );
  say('movement.maxAccessWalkMinutes', 'binding', 'questionnaire.maxAccessWalkMinutes');
  say('movement.desiredBaseCount', 'binding', 'composer.shape, scope strategy');
  say('movement.maxBaseChanges', 'binding', 'clarification[scope.base-strategy] via the scope strategy');

  // --- Rhythm -----------------------------------------------------------
  say('rhythm.pace', 'binding', 'composer.pace, questionnaire.pace');
  say(
    'rhythm.activityIntensity',
    context.intensityVisible ? 'binding' : 'advisory',
    context.intensityVisible
      ? 'composer.outdoorIntensity, questionnaire.dailyIntensity'
      : 'composer.outdoorIntensity',
    context.intensityVisible
      ? undefined
      : 'It reaches the composer and stops there: a party with limited mobility is not asked how hard it wants the days to be, because the intensity ceiling has already answered for them.',
  );
  say('rhythm.freeTime', 'advisory', 'composer.freeTime');
  say('rhythm.earlyMornings', 'binding', 'questionnaire.dayStart, questionnaire.avoidances[early_mornings]');

  // --- Taste ------------------------------------------------------------
  const droppedInterests = (Object.keys(INTEREST_MAP) as BenchmarkInterest[]).filter(
    (interest) =>
      INTEREST_MAP[interest] === null &&
      (taste.interests[interest] ?? 'low') !== 'low' &&
      (taste.interests[interest] ?? 'low') !== 'avoid',
  );
  say(
    'taste.interests',
    'binding',
    'questionnaire.interests',
    droppedInterests.length > 0
      ? `No rung of Sidequest's interest vocabulary describes: ${droppedInterests.join(', ')}.`
      : undefined,
  );
  say('taste.crowdTolerance', 'binding', 'composer.crowdTolerance, questionnaire.crowdTolerance');
  say('taste.discoveryMix', 'binding', 'questionnaire.discoveryMix');
  say(
    'taste.foodImportance',
    'binding',
    'composer.foodImportance, questionnaire.foodStyle, questionnaire.specialMealAppetite',
    'Tiered as stated-to-both, and Sidequest does act on it: it sets the everyday price band and the special-meal quota.',
  );
  say('taste.nightlifeImportance', 'advisory', 'composer.nightlife');
  say(
    'taste.indoorOutdoorBalance',
    'not_representable',
    null,
    'Sidequest reads indoor and outdoor off each place rather than as a stated balance, so there is no field to carry one.',
  );
  say(
    'taste.mustDo',
    taste.mustDo.length === 0 ? 'not_representable' : 'binding',
    taste.mustDo.length === 0 ? null : 'composer.mustDo, confirmed interpretation chips',
  );
  say(
    'taste.dislikes',
    taste.dislikes.length === 0 ? 'not_representable' : 'binding',
    taste.dislikes.length === 0 ? null : 'composer.avoid, confirmed interpretation chips',
  );
  const droppedAvoidances = taste.hardAvoidances.filter((entry) => AVOIDANCE_MAP[entry] === null);
  say(
    'taste.hardAvoidances',
    'binding',
    'questionnaire.avoidances',
    droppedAvoidances.length > 0
      ? `No avoidance rung exists for: ${droppedAvoidances.join(', ')}.`
      : undefined,
  );

  // --- Conditions -------------------------------------------------------
  say(
    'conditions.climate',
    'not_representable',
    null,
    'A destination is already chosen by the time Sidequest reads anything, so a climate preference has nothing to select between.',
  );
  say(
    'conditions.heat',
    conditions.heat === 'cannot' ? 'binding' : 'not_representable',
    conditions.heat === 'cannot' ? 'questionnaire.avoidances[extreme_heat]' : null,
    conditions.heat === 'prefer_not'
      ? 'Sidequest models heat as a hard avoidance or not at all; a preference that is not a refusal has no weaker rung.'
      : undefined,
  );
  say(
    'conditions.cold',
    conditions.cold === 'cannot' ? 'binding' : 'not_representable',
    conditions.cold === 'cannot' ? 'questionnaire.avoidances[extreme_cold]' : null,
    conditions.cold === 'prefer_not'
      ? 'Sidequest models cold as a hard avoidance or not at all; a preference that is not a refusal has no weaker rung.'
      : undefined,
  );
  say('conditions.rain', 'not_representable', null, 'Rain steers which day a place lands on, from the forecast, and is not a stated tolerance anywhere.');
  say('conditions.snow', 'not_representable', null, 'Snow steers which day a place lands on, from the forecast, and is not a stated tolerance anywhere.');

  // --- Practicalities ---------------------------------------------------
  say('practicalities.budget', 'binding', 'composer.budget, questionnaire.budgetStyle');
  say(
    'practicalities.accommodation',
    'not_representable',
    null,
    'Sidequest recommends areas rather than places to sleep and holds no lodging inventory, so a stated preference has nothing to act on.',
  );
  say('practicalities.reservations', 'not_representable', null, 'Bookings are reported as tasks the traveller must do; nothing chooses between places on willingness to book.');
  say('practicalities.guidedTours', 'not_representable', null, 'No candidate carries a guided-tour attribute, so there is nothing to prefer or avoid.');

  // --- Free text --------------------------------------------------------
  say(
    'freeText',
    'not_representable',
    null,
    'Sidequest has two text boxes and both are questions: what you must do, and what you would rather avoid. General prose posted into either would be recorded as a preference the traveller never stated.',
  );

  const report: ParityEntry[] = [];
  for (const path of Object.keys(FIELD_TIERS) as BenchmarkFieldPath[]) {
    const row = rows.get(path);
    if (!row) {
      // Unreachable while the loop above covers the table, and asserted by test.
      // Present so that a field added to `FIELD_TIERS` produces a visible gap
      // rather than a shorter report nobody counts.
      report.push({ path, tier: FIELD_TIERS[path], verdict: 'not_representable', mappedTo: null });
      continue;
    }
    report.push({ path, tier: FIELD_TIERS[path], ...row });
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Whether this traveller is at the wheel.
 *
 * Both the stated preference and the stated availability have to agree, because
 * they answer different questions: somebody with a car who asked for trains is
 * not driving, and somebody who would happily drive but has no car cannot.
 */
function drivesOwnCar(request: BenchmarkTripRequest): boolean {
  if (!request.movement.carAvailable) return false;
  switch (request.movement.preference) {
    case 'drive':
      return true;
    case 'public_transport':
    case 'guided_or_transfers':
      return false;
    case 'mixed':
    case 'no_preference':
      return true;
  }
}

function mapInterests(request: BenchmarkTripRequest): Record<Interest, InterestLevel> {
  const levels = {} as Record<Interest, InterestLevel>;
  for (const target of Object.values(INTEREST_MAP)) {
    if (target) levels[target] = 'low';
  }

  /*
   * Several request interests share one rung, so the strongest wins.
   *
   * Not the last, and not an average. Somebody who wants street food constantly
   * and avoids white tablecloths has told us they want `food_and_towns` often;
   * reading their dislike of one restaurant category as a dislike of eating out
   * would plan the wrong trip.
   */
  for (const [interest, target] of Object.entries(INTEREST_MAP) as [BenchmarkInterest, Interest | null][]) {
    if (!target) continue;
    const stated = request.taste.interests[interest] ?? 'low';
    const current = levels[target] ?? 'low';
    if (INTEREST_ORDER.indexOf(stated) > INTEREST_ORDER.indexOf(current)) levels[target] = stated;
  }
  return levels;
}

function mapAvoidances(request: BenchmarkTripRequest, mobilityLimited: boolean): Avoidance[] {
  const avoidances = new Set<Avoidance>();
  for (const entry of request.taste.hardAvoidances) {
    const mapped = AVOIDANCE_MAP[entry];
    if (mapped) avoidances.add(mapped);
  }
  if (request.conditions.heat === 'cannot') avoidances.add('extreme_heat');
  if (request.conditions.cold === 'cannot') avoidances.add('extreme_cold');
  if (request.rhythm.earlyMornings === 'never') avoidances.add('early_mornings');
  // Written here rather than left to normalisation, so the diff stays empty and
  // this stops being one of the places a value can silently change.
  if (mobilityLimited) avoidances.add('strenuous_activity');
  return [...avoidances].sort();
}

/**
 * The dates the composer will actually receive.
 *
 * A `flexible` or `exact` request that carries no dates cannot be stored as one
 * — the composer writes the two strings straight onto the answers, and an empty
 * string is not a date. Falling back to the month it stated, or to undecided, is
 * the mapping that keeps the trip creatable; the parity report names it when it
 * happens.
 */
function materialisedDates(request: BenchmarkTripRequest): {
  dateMode: ComposerInput['dateMode'];
  startDate: string;
  endDate: string;
} {
  const { mode, startDate, endDate, month } = request.dates;
  if ((mode === 'exact' || mode === 'flexible') && startDate && endDate) {
    return { dateMode: mode, startDate, endDate };
  }
  return {
    dateMode: month === null ? 'undecided' : 'month',
    startDate: startDate ?? '',
    endDate: endDate ?? '',
  };
}

function monthOf(date: string): number | null {
  const month = Number(date.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((entry) => seen.has(entry));
}
