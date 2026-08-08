'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { PRODUCING_SYSTEMS } from '@sidequest/bench';
import {
  answerQuestion,
  getBenchmarkSession,
  listQuestions,
  reclaimStalledSession,
  startRun,
} from '@/lib/db/benchmark-repository';
import { prepareBenchmarkSession, runBenchmarkSession } from '@/lib/benchmark/orchestrate';
import { questionHandle, type RunSnapshot } from '@/components/benchmark/neutral-dto';
import { buildRunSnapshot } from './snapshot';

/**
 * THE FOUR OPERATIONS THE PROGRESS SCREEN OFFERS.
 *
 * One of them reads and three of them write, and keeping the reading one
 * honestly read-only is what makes a poll safe: this screen refreshes itself
 * every second and a half, and a snapshot that quietly advanced a lifecycle
 * column would mean leaving the tab open changed the experiment.
 *
 * The two writes that move the comparison forward are separate presses because
 * there is a person between them. The first buys the world both arms plan
 * against and derives the questions that purchase's own gaps produced; the
 * second says the answers are in and asks for the plans. Collapsing them, which
 * is what this file used to do, meant the questions were produced and discarded
 * in the same breath.
 */

/** Read-only. Called on a timer, so it must stay that way. */
export async function runSnapshotAction(sessionId: string): Promise<RunSnapshot | null> {
  return buildRunSnapshot(sessionId, new Date());
}

/**
 * THE FIRST PRESS: BUY THE WORLD AND ASK.
 *
 * One press for both arms is the whole design. Two buttons, or one that started
 * the second when the first finished, would make the comparison a sequence
 * rather than a pair and would put an arbitrary head start on whichever went
 * first. That property is unchanged by the split into two presses: neither of
 * them starts one arm, and the second starts both.
 *
 * The work runs in `after()` rather than inside the response, because buying a
 * region's places, routes, hours and forecast takes minutes and a server action
 * that blocked for that long would hold a request open and give the reviewer a
 * spinner with nothing behind it. The progress screen polls a read-only snapshot
 * instead, which is the pattern the rest of this application already uses for
 * its own long build.
 *
 * The claim lives in `prepareBenchmarkSession`, not here. It advances the session
 * from `created` in one compare-and-set and returns what already exists if it
 * loses, so a double-pressed button, a second tab and a retried post all reach
 * one comparison. This action used to advance the state and create the run rows
 * itself, and call neither planner — which meant the button worked, the screen
 * polled, both panels sat at `pending` for ever, and the only thing that ever
 * ran the arms was a unit test.
 */
export async function startBothRunsAction(sessionId: string): Promise<void> {
  /*
   * A claim whose holder stopped breathing is returned before anything is read.
   *
   * `preparing` and `running` are entered by a compare-and-set and left only by
   * the invocation that entered them — inside `after()`, which Next makes no
   * promise about across a restart. Without this, a hot reload during the world
   * purchase left a session nothing could move, after it had already been paid
   * for. Here rather than in the snapshot because the snapshot is on a poll and
   * has to stay honestly read-only; pressing the button again is what somebody
   * does when a screen has stopped moving, and now it works.
   */
  reclaimStalledSession(sessionId, new Date());

  const session = getBenchmarkSession(sessionId);
  if (!session) return;
  if (session.state !== 'created') return;

  /*
   * The two run rows are created here, synchronously, before the response.
   *
   * Deferring them along with everything else looked tidier and broke the
   * screen: the revalidate below re-rendered a session with no runs, so the
   * progress component saw nothing started, and its polling guard — which exists
   * to stop an idle tab polling forever — declined to start. The reviewer was
   * left on a page that would never move.
   *
   * `startRun` adopts an existing row rather than erroring, so the orchestrator's
   * own calls a moment later are no-ops. The session state is deliberately *not*
   * advanced here: that transition is the orchestrator's claim, and moving it
   * would hand every caller a session already past the state its compare-and-set
   * requires, so the work would be skipped and both arms reported as failed.
   */
  const now = new Date();
  for (const system of PRODUCING_SYSTEMS) {
    startRun({ sessionId, arm: system, now });
  }

  after(async () => {
    try {
      await prepareBenchmarkSession(sessionId);
    } catch (error) {
      // The harness falling over must not take the process with it. The name
      // only — a provider error object carries the outbound request, headers
      // included.
      console.error('A benchmark question round stopped unexpectedly', {
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  });

  revalidatePath(`/labs/benchmark/${sessionId}/run`);
}

/**
 * THE SECOND PRESS: PLAN BOTH, WITH WHATEVER WAS ANSWERED.
 *
 * A separate press rather than a timer, because the thing it closes is a
 * decision only the traveller can make — whether they are finished answering.
 * Nothing waits on it: a comparison left here overnight is a comparison that has
 * spent its provider budget and no model tokens, which is the cheap direction to
 * be stuck in.
 *
 * Answering is optional and unanswered is a real state. The questions that went
 * unanswered are recorded as unanswered, the generation prompt is given the ones
 * that were answered and nothing else, and a plan built with no answers is a
 * poorer plan honestly produced rather than a plan built from guesses.
 */
export async function planBothRunsAction(sessionId: string): Promise<void> {
  // See `startBothRunsAction`: a stalled claim is released before it is read.
  reclaimStalledSession(sessionId, new Date());

  const session = getBenchmarkSession(sessionId);
  if (!session) return;
  if (session.state !== 'awaiting_answers') return;

  after(async () => {
    try {
      await runBenchmarkSession(sessionId);
    } catch (error) {
      // Both arms already record their own failures; this catches the harness
      // falling over, which must not take the process with it.
      console.error('A benchmark session stopped unexpectedly', {
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  });

  revalidatePath(`/labs/benchmark/${sessionId}/run`);
}

export interface AnswerResult {
  ok: boolean;
}

/**
 * Record one answer, and make it available to the system that did not ask.
 *
 * The transfer is the point of the ledger. A follow-up question is free
 * information, and a benchmark in which one system got to ask three clarifying
 * questions and keep the answers to itself would be measuring who asked first
 * rather than who planned better. So the answer is recorded against the question
 * that prompted it and stamped with the other arm's name, and the pair of
 * columns is what makes the symmetry checkable afterwards rather than assumed.
 *
 * The handle is resolved by scanning rather than by decoding, because the handle
 * is a one-way hash — the stored id is a string the asking system chose and may
 * name itself, so it never reaches the browser to be sent back.
 *
 * Nothing here checks the session's state or the size of the answer. Both refusals
 * live in the repository's `WHERE` clause and its bounds, which is where they hold
 * against a direct POST as well as against this screen: `elapsed_ms` is a reported
 * metric, so an answer accepted after the review locked would change a number that
 * has already been published, and an unbounded answer would write a row that no
 * later read can parse — quietly removing the question from the pooled list and
 * from the counts.
 */
export async function answerPooledQuestionAction(
  sessionId: string,
  handle: string,
  values: string[],
): Promise<AnswerResult> {
  /*
   * `filter`, not `find`.
   *
   * The handle is a hash, and `find` takes the first match — so two colliding ids
   * in one session would route the traveller's answer to the wrong question and
   * record it under the wrong reason. Vanishingly unlikely at ten questions and
   * silent when it happens, which is the combination worth refusing outright.
   */
  const matches = listQuestions(sessionId).filter(
    (candidate) => questionHandle(candidate.questionId) === handle,
  );
  const question = matches.length === 1 ? matches[0] : undefined;
  if (!question) return { ok: false };

  /*
   * A choice has to be one of the choices.
   *
   * The repository bounds the *length* of an answer and nothing bounds its
   * content, so a direct POST could put a paragraph of prose where a
   * single-choice question offered three words. That paragraph is traveller-
   * controlled text on its way to a model, and while it now travels in the
   * untrusted turn rather than the instruction one, a closed question whose
   * answer is not from its own list is a bad record regardless of where it ends
   * up. Free-text questions are exempt because for them the field *is* the list.
   */
  if (question.answerType !== 'text' && question.options.length > 0) {
    const allowed = new Set(question.options.map((option) => option.value));
    if (!values.every((value) => allowed.has(value))) return { ok: false };
  }

  const now = new Date();
  const presentedAt = Date.parse(question.presentedAt);
  const elapsedMs = Number.isFinite(presentedAt)
    ? Math.max(0, now.getTime() - presentedAt)
    : 0;
  const other = PRODUCING_SYSTEMS.find((system) => system !== question.askedBy) ?? null;

  const saved = answerQuestion({
    sessionId,
    questionId: question.questionId,
    values,
    answeredFrom: 'traveller',
    elapsedMs,
    transferredTo: other,
    now,
  });
  revalidatePath(`/labs/benchmark/${sessionId}/run`);
  return { ok: saved };
}
