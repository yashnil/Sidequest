import type { TripComposerAnswers } from '../schemas/composer';
import { emptyAdvisorAnswers } from './answers';
import { rankCatalog, type DestinationSource } from './advise';
import { ADVISOR_QUESTIONS, MAX_FOLLOW_UPS, STOP_BELOW, advisorQuestionAsked, advisorQuestionById, type AdvisorQuestion, type QuestionId } from './questions';
import { selectShortlist } from './select';

/**
 * WHICH QUESTION TO ASK NEXT — THE PART OF THE INTERVIEW THAT RANKS THE WORLD.
 *
 * The questions themselves (`questions.ts`) are data and pure patches on the
 * answers, and they ship to the browser. Choosing among them means re-ranking
 * the destinations once per possible answer, which needs the scorer and the
 * world — so it lives here, runs on the server (`advisorStepAction`), and is
 * kept out of the client bundle by being a separate module.
 */

const COMPARE_DEPTH = 6;

/**
 * How many candidates a *question's value* is measured on. Far fewer than a
 * real shortlist reads: the interview asks "would this answer move the list",
 * dozens of times per step, and the leaders it compares are found well inside
 * the first few hundred.
 */
export const QUESTION_CANDIDATES = 160;

/** The shortlist a set of answers produces, as ordered ids — what a question's value is measured against. */
export function shortlistIds(answers: TripComposerAnswers, catalog: DestinationSource, limit = QUESTION_CANDIDATES): string[] {
  const { profile, ranked } = rankCatalog(answers, catalog, limit);
  const selection = selectShortlist(ranked, profile);
  return [...selection.picks, ...selection.alternates].map((scored) => scored.destination.id).slice(0, COMPARE_DEPTH);
}

/**
 * How different two shortlists are, 0 (same) … 1 (nothing shared). The first
 * three places weigh double: that is what the traveller reads.
 */
export function shortlistDistance(a: readonly string[], b: readonly string[]): number {
  let total = 0;
  let shared = 0;
  for (let index = 0; index < Math.max(a.length, b.length, 1); index += 1) {
    const weight = index < 3 ? 2 : 1;
    total += weight;
    if (a[index] !== undefined && b.includes(a[index]!)) shared += weight;
  }
  if (a.length === 0 && b.length === 0) return 0;
  return 1 - shared / total;
}

export interface QuestionValue {
  id: QuestionId;
  value: number;
}

export interface NextStep {
  question: AdvisorQuestion | null;
  /** True when we can recommend responsibly: the essentials are settled. */
  ready: boolean;
  /** Why the interview stopped, when it did. */
  stopReason: 'essentials_missing' | 'asking' | 'low_value' | 'enough_asked' | 'nothing_left';
  values: QuestionValue[];
  followUpsAsked: number;
  current: string[];
}

export function nextQuestion(answers: TripComposerAnswers, catalog: DestinationSource): NextStep {
  const open = ADVISOR_QUESTIONS.filter((question) => question.applies(answers) && !question.answered(answers) && !advisorQuestionAsked(answers, question.id));
  const essential = open.find((question) => question.essential);
  const current = shortlistIds(answers, catalog);
  const followUpsAsked = (answers.discovery ?? emptyAdvisorAnswers()).asked.filter((id) => !ADVISOR_QUESTIONS.find((question) => question.id === id)?.essential).length;
  if (essential) return { question: essential, ready: false, stopReason: 'essentials_missing', values: [], followUpsAsked, current };

  const values: QuestionValue[] = open.map((question) => {
    const options = question.options(answers);
    const priorTotal = options.reduce((sum, option) => sum + option.prior, 0) || 1;
    let expected = 0;
    for (const option of options) {
      const ids = shortlistIds(option.apply(answers), catalog);
      expected += (option.prior / priorTotal) * shortlistDistance(current, ids);
    }
    return { id: question.id, value: expected / question.effort };
  });
  values.sort((a, b) => b.value - a.value || ADVISOR_QUESTIONS.findIndex((q) => q.id === a.id) - ADVISOR_QUESTIONS.findIndex((q) => q.id === b.id));

  if (values.length === 0) return { question: null, ready: true, stopReason: 'nothing_left', values, followUpsAsked, current };
  if (followUpsAsked >= MAX_FOLLOW_UPS) return { question: null, ready: true, stopReason: 'enough_asked', values, followUpsAsked, current };
  if (values[0]!.value < STOP_BELOW) return { question: null, ready: true, stopReason: 'low_value', values, followUpsAsked, current };
  return { question: advisorQuestionById(values[0]!.id), ready: true, stopReason: 'asking', values, followUpsAsked, current };
}
