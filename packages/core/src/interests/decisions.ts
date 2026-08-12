import type { AccessDataset, TransportMode } from '../schemas/access';
import type { Place } from '../schemas/place';

/**
 * STAGE B — THE QUESTIONS ONLY THIS DESTINATION CAN JUSTIFY ASKING.
 *
 * Section 6.2 splits intake in two: Stage A asks what has to be known before
 * anybody researches anything, and Stage B asks the handful of things that only
 * become worth asking once there *is* destination context. The mechanism has
 * existed since Phase 15 and has never fired, because the only region carrying
 * the copy it reads was the authored fixture — so in practice every compiled
 * destination asked exactly the generic questionnaire.
 *
 * The rule that keeps this from becoming destination trivia: **a question is
 * emitted only when the answer would change a decision the compiler has
 * already measured a reason to make.** Not "this region has ferries, ask about
 * ferries" — "the only modelled way to reach three of these places is a boat,
 * and if you will not take one they come off the board".
 *
 * Every question therefore carries three things: what is being asked, one line
 * saying what it changes, and the measurement that justified asking it at all.
 * A question that cannot produce all three is not emitted.
 *
 * These are data on the compiled region. Rendering them is the questionnaire's
 * job; deciding which are true of a place is this file's.
 */

/**
 * The closed set. Small on purpose — section 6.2's own list, minus the ones
 * this engine has no measurement for and would therefore be guessing at.
 */
export const DECISION_QUESTION_IDS = [
  'rent_a_car',
  'extra_base_move',
  'ferry_leg',
  'long_day_trip',
  'strenuous_walking',
  'early_start',
] as const;
export type DecisionQuestionId = (typeof DECISION_QUESTION_IDS)[number];

/**
 * The answer field each question actually moves.
 *
 * Named rather than implied, because a Stage B question whose answer lands
 * nowhere is the placebo control this contract already caught the questionnaire
 * shipping once. Every id below is a field on `QuestionnaireAnswers`, so the
 * wiring is checkable rather than described.
 */
export const DECISION_ANSWER_FIELDS = [
  'willDrive',
  'regionalExpansion',
  'willUseShuttles',
  'maxDailyTravelMinutes',
  'dailyIntensity',
  'dayStart',
] as const;
export type DecisionAnswerField = (typeof DECISION_ANSWER_FIELDS)[number];

export interface RegionDecisionQuestion {
  id: DecisionQuestionId;
  /** The question, in the traveller's language. */
  prompt: string;
  /** One line on what the answer changes. Section 6.6 asks for exactly one. */
  why: string;
  /** The measurement that justified asking. Always has a number or a name in it. */
  evidence: string;
  /** Which answer this steers. */
  answerField: DecisionAnswerField;
}

/**
 * How much of a region has to be car-only before not driving is a real problem.
 *
 * Half, and at least three places. A single trailhead up a service road is a
 * place to leave out; half the region is a different trip, and that is the
 * threshold at which asking somebody to reconsider a car earns its interruption.
 */
const CAR_ONLY_SHARE = 0.5;
const CAR_ONLY_MINIMUM = 3;

/**
 * Below this, a car-only place is walkable and the question is noise.
 *
 * Twenty minutes of driving is a long walk, not an impossible one, and a region
 * whose furthest car-only stop is inside it does not need a hire car — it needs
 * comfortable shoes.
 */
const CAR_ONLY_MIN_DRIVE_MINUTES = 20;

/** A second base has to buy real distance before an extra hotel move is worth it. */
const BASE_MOVE_MIN_MINUTES = 75;

/** Beyond this, a satellite is a day out rather than an afternoon. */
const DAY_TRIP_MINUTES = 90;

/** Below this significance a strenuous place is not "the best local fit". */
const ANCHOR_SIGNIFICANCE = 0.6;

/** Never more than this many, whatever the region turns up. */
export const MAX_DECISION_QUESTIONS = 3;

const NON_DRIVE_MODES: readonly TransportMode[] = [
  'walk',
  'public_bus',
  'rail',
  'shuttle',
  'ferry',
  'bicycle',
];

/** Modes that will actually get this traveller to this place, from the rules. */
function approachModesFor(access: AccessDataset, placeId: string): TransportMode[] {
  return access.rules
    .filter((rule) => rule.placeIds.includes(placeId))
    .map((rule) => rule.approachMode);
}

export interface DecisionQuestionInput {
  places: readonly Place[];
  access: AccessDataset;
  /** What the trip already assumes. A traveller who has a car is not asked for one. */
  carAvailable: boolean | null;
  /** Bases other than the one they sleep at first, with minutes from it. */
  secondaryBaseMinutes: readonly number[];
}

export function decisionQuestionsFor(input: DecisionQuestionInput): RegionDecisionQuestion[] {
  const { places, access } = input;
  const questions: RegionDecisionQuestion[] = [];
  if (places.length === 0) return questions;

  // --- a car, or not -------------------------------------------------------
  /*
   * A place is car-only when every modelled way in is a drive. No rule at all is
   * *not* car-only: it means nobody classified the approach, and inferring a
   * hire car from our own silence is the kind of confident wrong answer this
   * whole contract is about.
   */
  const carOnly = places.filter((place) => {
    const modes = approachModesFor(access, place.id);
    return modes.length > 0 && modes.every((mode) => !NON_DRIVE_MODES.includes(mode));
  });
  const furthestCarOnly = carOnly.reduce(
    (worst, place) => Math.max(worst, place.travelFromBase.driveMinutes),
    0,
  );
  if (
    input.carAvailable !== true &&
    carOnly.length >= CAR_ONLY_MINIMUM &&
    carOnly.length / places.length >= CAR_ONLY_SHARE &&
    furthestCarOnly >= CAR_ONLY_MIN_DRIVE_MINUTES
  ) {
    questions.push({
      id: 'rent_a_car',
      prompt: 'Would you take a hire car here?',
      why: 'Without one, most of what we found would have to come off the plan.',
      evidence: `${carOnly.length} of the ${places.length} places we found have no way in but a drive, the furthest about ${furthestCarOnly} minutes out.`,
      answerField: 'willDrive',
    });
  }

  // --- one more hotel move -------------------------------------------------
  const furthestBase = input.secondaryBaseMinutes.reduce(
    (worst, minutes) => Math.max(worst, minutes),
    0,
  );
  if (furthestBase >= BASE_MOVE_MIN_MINUTES) {
    questions.push({
      id: 'extra_base_move',
      prompt: 'Would you move hotels once to reach the far side of this region?',
      why: 'Staying put keeps it simple; moving once puts a whole second area inside a normal day.',
      evidence: `The far part of this region is about ${furthestBase} minutes from where you would otherwise sleep.`,
      answerField: 'regionalExpansion',
    });
  }

  // --- a boat --------------------------------------------------------------
  const ferryPlaces = new Set(
    access.rules
      .filter((rule) => rule.approachMode === 'ferry')
      .flatMap((rule) => rule.placeIds)
      .filter((placeId) => places.some((place) => place.id === placeId)),
  );
  if (ferryPlaces.size > 0) {
    questions.push({
      id: 'ferry_leg',
      prompt: 'Are you happy to take a boat?',
      why: 'Some of this only opens up by water, and we will leave it out if you would rather not.',
      evidence: `${ferryPlaces.size} ${ferryPlaces.size === 1 ? 'place is' : 'places are'} reached by ferry.`,
      answerField: 'willUseShuttles',
    });
  }

  // --- a long day out ------------------------------------------------------
  const dayTrips = places.filter(
    (place) =>
      place.relationship === 'satellite' && place.travelFromBase.driveMinutes >= DAY_TRIP_MINUTES,
  );
  if (dayTrips.length > 0) {
    const furthest = dayTrips.reduce(
      (worst, place) => Math.max(worst, place.travelFromBase.driveMinutes),
      0,
    );
    questions.push({
      id: 'long_day_trip',
      prompt: 'Is a whole day out from your base worth it?',
      why: 'It buys the best of what is further out, and costs you a day near where you are staying.',
      evidence: `${dayTrips.length} of the strongest options ${dayTrips.length === 1 ? 'sits' : 'sit'} ${furthest} minutes or so away, one way.`,
      answerField: 'maxDailyTravelMinutes',
    });
  }

  // --- hard walking --------------------------------------------------------
  /*
   * Only when the *good* stuff is strenuous. A region with one hard scramble
   * among forty easy walks does not need to interrupt anybody; a region whose
   * best-evidenced experiences are all uphill does, because the alternative is
   * a board full of things the traveller has already told us they cannot do.
   */
  const strenuousAnchors = places.filter(
    (place) =>
      place.physicalIntensity === 'strenuous' &&
      Math.max(place.experienceSignificance ?? 0, place.popularityScore) >= ANCHOR_SIGNIFICANCE,
  );
  if (strenuousAnchors.length > 0) {
    questions.push({
      id: 'strenuous_walking',
      prompt: 'Are you up for a hard day on your feet?',
      why: 'The strongest things here are the demanding ones, and saying no reshapes what we build around.',
      evidence: `${strenuousAnchors.length} of the best-evidenced places here, ${strenuousAnchors[0]!.name} among them, are strenuous.`,
      answerField: 'dailyIntensity',
    });
  }

  // --- getting up early ----------------------------------------------------
  const sunrise = places.filter((place) => place.bestTimeOfDay === 'sunrise');
  if (sunrise.length > 0) {
    questions.push({
      id: 'early_start',
      prompt: 'Would you get up before dawn for one of these?',
      why: 'One or two things here are worth far more at first light than at any other hour.',
      evidence: `${sunrise[0]!.name} is at its best at sunrise.`,
      answerField: 'dayStart',
    });
  }

  /*
   * Ordered by how much of the trip the answer moves, then truncated. Six
   * questions after a questionnaire is not a follow-up, it is a second
   * questionnaire — and the ones that survive are the ones that change what
   * gets built rather than what time it starts.
   */
  return questions.slice(0, MAX_DECISION_QUESTIONS);
}
