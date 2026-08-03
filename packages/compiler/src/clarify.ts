import {
  breadthRank,
  CLARIFICATION_SET_VERSION,
  type ClarificationQuestion,
  type ClarificationSet,
  type DestinationCandidate,
  type DestinationResolution,
  type TravelerProfile,
} from '@sidequest/core';

/**
 * WHICH QUESTIONS GET ASKED, AND WHY IT IS NOT A MODEL'S DECISION.
 *
 * The product's whole promise is that one questionnaire is enough. Every
 * question after it spends a little of that, so each one here has to change the
 * plan — and whether it does is a property of what we know, which a program can
 * evaluate and a model can only guess at.
 *
 * A model may reword these, merge two into one sentence, or translate them. It
 * cannot add one and it cannot drop one. That asymmetry is deliberate: a model
 * that decides "they probably meant the island" has silently answered the exact
 * question this file exists to ask out loud.
 *
 * The second rule is just as load-bearing: **nothing is asked that the profile
 * already answers.** A traveller who has told the questionnaire they will drive
 * does not get asked again, and a rule that ignores the profile is a bug rather
 * than a belt-and-braces.
 */

/** Above this breadth, a destination is bigger than one trip can hold. */
const BROAD_BREADTH_RANK = breadthRank('region');

/** Below this many nights, even a subregion needs a base strategy settled. */
const MULTI_BASE_NIGHT_THRESHOLD = 5;

export interface ClarificationInput {
  resolution: DestinationResolution;
  /** The interpretation the traveller picked, once they have. */
  candidate?: DestinationCandidate;
  profile?: TravelerProfile;
  nights: number;
  /**
   * What the trip composer already established, before any of this ran.
   *
   * The second rule in this file's header — *nothing is asked that is already
   * answered* — used to be enforced against the questionnaire profile alone,
   * which is built *after* compilation. So in practice `!profile` was always
   * true and the car question was effectively unconditional. The composer now
   * asks it up front, and this is what stops it being asked twice.
   */
  known?: {
    /** 'drive' | 'public_transport' | 'mixed' | 'undecided', or absent. */
    transport?: string;
    /**
     * Whether a scope strategy has already been chosen on the preflight.
     *
     * Suppresses **both** the breadth question and the base question, because
     * one strategy answers both. A live run showed the cost of guarding only the
     * second: a traveller who had just chosen "two bases" on the preflight was
     * immediately shown "Kyrgyzstan is bigger than one trip — how do you want to
     * take it on?" and "how many times are you willing to change hotel?", which
     * is the product asking a question it had already been given the answer to.
     */
    scopeStrategy?: boolean;
  };
}

export const QUESTION_IDS = {
  breadthStrategy: 'scope.breadth-strategy',
  baseStrategy: 'scope.base-strategy',
  carAvailable: 'transport.car-available',
  waterOrAir: 'transport.water-or-air-transfers',
  remoteRoads: 'transport.remote-roads',
  gateways: 'scope.gateways',
  notAPlace: 'destination.not-a-place',
} as const;

/**
 * The questions this destination actually needs, in the order they are asked.
 *
 * Pure, and deliberately so: the same inputs give the same questions, which is
 * what lets a stored answer keep matching its question across a re-derivation
 * and what makes the whole flow testable without a provider.
 */
export function deriveClarificationQuestions(input: ClarificationInput): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const { resolution, candidate, profile, nights } = input;

  if (resolution.ambiguityReasons.includes('query_is_not_a_place')) {
    questions.push({
      id: QUESTION_IDS.notAPlace,
      reason: 'query_not_a_place',
      question: 'Where should we start looking?',
      whyItMatters:
        'What you typed reads more like the kind of trip you want than somewhere on a map. Name a town, a region or a country and we will build outwards from it.',
      answerType: 'text',
      options: [],
      required: true,
      source: 'rule',
    });
    // Nothing below can be decided until there is a place, so this is the whole set.
    return questions;
  }

  if (!candidate) return questions;

  const rank = breadthRank(candidate.breadth);

  /**
   * A country is not a trip.
   *
   * Asked whenever the destination is broader than a subregion, regardless of
   * trip length — two weeks in Turkey still needs a shape, and compiling the
   * whole country at equal depth would spend most of the budget on ground
   * nobody will stand on.
   */
  if (!input.known?.scopeStrategy && rank >= BROAD_BREADTH_RANK) {
    questions.push({
      id: QUESTION_IDS.breadthStrategy,
      reason: 'scope_too_broad',
      question: `${candidate.displayName} is bigger than one trip. How do you want to take it on?`,
      whyItMatters:
        'This decides where we look at all. Picking one area means we go deep; a circuit means we go wide and you move hotel.',
      answerType: 'single_choice',
      options: [
        {
          value: 'one_area',
          label: 'One area, done properly',
          detail: 'We pick the part that fits you best and stay there.',
        },
        {
          value: 'circuit',
          label: 'A route across a few areas',
          detail: 'More ground, more packing and unpacking.',
        },
        {
          value: 'name_it',
          label: 'I will name the part I mean',
          detail: 'Tell us the region and we build around that instead.',
        },
      ],
      required: true,
      source: 'rule',
    });
  }

  /**
   * One base or several. Only worth asking when both are genuinely available:
   * a short trip has no room to move, and a `local` destination has nowhere to
   * move to.
   */
  if (
    !input.known?.scopeStrategy &&
    nights >= MULTI_BASE_NIGHT_THRESHOLD &&
    rank >= breadthRank('subregion')
  ) {
    questions.push({
      id: QUESTION_IDS.baseStrategy,
      reason: 'base_strategy_unknown',
      question: 'How many times are you willing to change hotel?',
      whyItMatters:
        'Half the plan turns on this. Staying put means shorter days and more of them within reach; moving opens up ground that is otherwise a four-hour round trip.',
      answerType: 'single_choice',
      options: [
        { value: '0', label: 'Not at all', detail: 'One base for the whole trip.' },
        { value: '1', label: 'Once', detail: 'Two bases, split roughly down the middle.' },
        { value: '2', label: 'Twice', detail: 'Three bases. A circuit rather than a stay.' },
        { value: '3', label: 'As often as it is worth it', detail: 'We optimise for the route.' },
      ],
      required: true,
      source: 'rule',
    });
  }

  /**
   * A car. Asked only when nobody has said — the questionnaire asks this
   * properly, and asking a second time is the thing the product promises not to
   * do.
   */
  const transportKnown =
    profile !== undefined ||
    (input.known?.transport !== undefined && input.known.transport !== 'undecided');
  if (!transportKnown) {
    questions.push({
      id: QUESTION_IDS.carAvailable,
      reason: 'car_availability_unknown',
      question: 'Will you have a car?',
      whyItMatters:
        'It decides which places are even reachable, and in some regions it is the difference between a region and a town.',
      answerType: 'single_choice',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No — public transport, walking and transfers' },
        { value: 'unsure', label: 'Not decided yet', detail: 'We will show you what each buys.' },
      ],
      required: true,
      source: 'rule',
    });
  }

  /**
   * Boats and small planes, asked only where the geography makes them
   * unavoidable. On the mainland this is noise; for an archipelago it is the
   * question that decides whether half the region exists.
   */
  if (candidate.entityType === 'island' || candidate.entityType === 'archipelago') {
    questions.push({
      id: QUESTION_IDS.waterOrAir,
      reason: 'water_or_air_transfer_acceptance_unknown',
      question: 'Are ferries or small planes on the table?',
      whyItMatters:
        'Most of what is worth seeing here is on the other side of water. Ruling out the crossing rules out the places.',
      answerType: 'single_choice',
      options: [
        { value: 'yes', label: 'Both are fine' },
        { value: 'ferry_only', label: 'Ferries, not small planes' },
        { value: 'no', label: 'Neither', detail: 'We will keep to one island.' },
      ],
      required: true,
      source: 'rule',
    });
  }

  /** Rough roads, only where nobody has said and the region is big enough to have them. */
  if (!transportKnown && rank >= BROAD_BREADTH_RANK) {
    questions.push({
      id: QUESTION_IDS.remoteRoads,
      reason: 'remote_road_comfort_unknown',
      question: 'Are unpaved and remote roads acceptable?',
      whyItMatters:
        'Some of the best of a region this size is at the end of a gravel road with no fuel for an hour either side.',
      answerType: 'single_choice',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'Paved roads only' },
      ],
      required: false,
      source: 'rule',
      dependsOn: { questionId: QUESTION_IDS.carAvailable, whenAnswerIn: ['yes', 'unsure'] },
    });
  }

  /** Fixed gateways. Never required — most travellers do not have one yet. */
  if (rank >= BROAD_BREADTH_RANK) {
    questions.push({
      id: QUESTION_IDS.gateways,
      reason: 'gateway_unknown',
      question: 'Are you tied to a particular airport or station?',
      whyItMatters:
        'A fixed way in and out anchors both ends of the route, which changes which areas are worth including.',
      answerType: 'text',
      options: [],
      required: false,
      source: 'rule',
    });
  }

  return questions;
}

/**
 * A question set that keeps answers already given.
 *
 * Re-derivation happens whenever the traveller edits an earlier screen, and an
 * answer whose question survives must survive with it — otherwise going back to
 * change a date silently wipes a clarification three screens later.
 */
export function rebuildClarificationSet(
  input: ClarificationInput,
  previous?: ClarificationSet,
): ClarificationSet {
  const questions = deriveClarificationQuestions(input);
  const live = new Set(questions.map((question) => question.id));
  const answers = (previous?.answers ?? []).filter((answer) => live.has(answer.questionId));
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions, answers };
}
