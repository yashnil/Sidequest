import { ADVISOR_QUESTIONS, advisorQuestionById, type AdvisorQuestion, type TripComposerAnswers } from '@sidequest/core';

/**
 * THE PARTS OF THE INTERVIEW THE BROWSER CAN STILL DECIDE ALONE.
 *
 * Which follow-up would change the list most is the server's to work out — it
 * means ranking the atlas, and the atlas does not leave the server. Two things
 * need no ranking and are decided here:
 *
 * - **The essentials come first, in a fixed order.** The policy asks the first
 *   open essential question before it weighs anything, so the browser can show
 *   that question without waiting — and can keep asking when the server cannot
 *   be reached.
 * - **Only the newest answer's step counts.** Requests are numbered; a slow
 *   reply to an older answer is recognised and dropped.
 *
 * What the screen shows for any combination of the two — the server's step
 * known, in flight or failed — is one pure function, `interviewScreen`, so the
 * degraded paths are tested rather than hoped for.
 */

/** Put to the traveller already — answered or skipped. Mirrors the policy's own bookkeeping. */
function alreadyPut(answers: TripComposerAnswers, id: string): boolean {
  return (answers.discovery?.asked ?? []).includes(id) || answers.skipped.includes(`advisor:${id}`);
}

/** The first essential question still open, in the catalog's order; null once the essentials are settled. */
export function openEssentialQuestion(answers: TripComposerAnswers): AdvisorQuestion | null {
  return ADVISOR_QUESTIONS.find((question) => question.essential && question.applies(answers) && !question.answered(answers) && !alreadyPut(answers, question.id)) ?? null;
}

/** Numbers requests so that only the latest one's reply is used. */
export interface Sequencer {
  /** Take the next ticket; every earlier ticket becomes stale. */
  issue(): number;
  isCurrent(ticket: number): boolean;
}

export function createSequencer(): Sequencer {
  let latest = 0;
  return {
    issue: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (ticket) => ticket === latest,
  };
}

/** Where the server's step for the current answers stands. */
export type StepState<View extends { questionId: string | null; ready: boolean }> = { status: 'pending' } | { status: 'ready'; view: View } | { status: 'failed' };

export interface InterviewScreen {
  /**
   * - `ask`: a question the traveller can answer now.
   * - `settling`: the question just answered, held in place while the next step is in flight.
   * - `opening`: nothing to hold and the step in flight (first load after a request that settled the essentials).
   * - `stalled`: the essentials are settled and the next question is not known and not coming — the step failed, or a build did.
   * - `building`: the shortlist is being put together.
   */
  mode: 'ask' | 'settling' | 'opening' | 'stalled' | 'building';
  question: AdvisorQuestion | null;
  /** The essentials are settled, so a list can be built whether or not the step has answered. */
  ready: boolean;
  /** The server looked and found nothing left worth asking. */
  finished: boolean;
}

export function interviewScreen<View extends { questionId: string | null; ready: boolean }>(input: {
  answers: TripComposerAnswers;
  /** A question the traveller asked to change; it is put whatever the step says. */
  forced: string | null;
  step: StepState<View>;
  /** The id of the question just answered, while its step is in flight. */
  settling: string | null;
  building: boolean;
  buildFailed: boolean;
}): InterviewScreen {
  const view = input.step.status === 'ready' ? input.step.view : null;
  /* Known without the server: the policy asks open essentials first, in this order. */
  const essential = openEssentialQuestion(input.answers);
  const forced = input.forced ? advisorQuestionById(input.forced) : null;
  const chosen = view?.questionId ? advisorQuestionById(view.questionId) : null;
  const live = forced ?? chosen ?? essential;
  const waiting = !live && input.step.status === 'pending';
  /* Nothing to ask yet and the step still in flight: hold the question just answered rather than blank the screen. */
  const held = waiting && input.settling ? advisorQuestionById(input.settling) : null;
  const finished = !live && view !== null && view.ready;
  const ready = view ? view.ready : essential === null;
  const mode: InterviewScreen['mode'] = input.building || (finished && !input.buildFailed) ? 'building' : live ? 'ask' : held ? 'settling' : waiting ? 'opening' : 'stalled';
  return { mode, question: live ?? held, ready, finished };
}
