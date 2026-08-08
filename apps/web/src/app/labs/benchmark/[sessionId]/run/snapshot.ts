import 'server-only';
import { blindPanels } from '@/lib/benchmark/blind';
import { getBenchmarkSession, getRuns, listQuestions } from '@/lib/db/benchmark-repository';
import { poolQuestions, type RunSnapshot } from '@/components/benchmark/neutral-dto';

/**
 * THE ONE READ THE PROGRESS SCREEN AND ITS POLL BOTH GO THROUGH.
 *
 * Its own module rather than an export from `actions.ts`, and the reason is a
 * rule this repository enforces with a test: a page may *reference* a server
 * action and may not *invoke* one while producing a response. The first render
 * and every poll after it have to agree about what a snapshot is, so the shared
 * part is a plain function that both the page and the action call.
 *
 * What comes back is the neutral projection and nothing else. No run row, no
 * plan, no timing per arm, no per-arm state, no `askedBy`. Everything on this
 * screen is serialised into the page payload on its way to the browser, so "the
 * component does not render it" is not a defence.
 */
export function buildRunSnapshot(sessionId: string, now: Date): RunSnapshot | null {
  const presentation = blindPanels(sessionId);
  if (presentation === null) return null;

  const session = getBenchmarkSession(sessionId);
  const runs = getRuns(sessionId);
  /*
   * One clock for the comparison rather than one per arm.
   *
   * Both runs are started by the same press, so the earliest start is the start.
   * Two clocks would say which arm was quicker on every refresh, which is the
   * single loudest thing this screen could accidentally announce — and the
   * review is gated on both being finished precisely so that ordering never
   * reaches the rating form.
   */
  const startedAt = runs
    .map((run) => Date.parse(run.startedAt))
    .filter((stamp) => Number.isFinite(stamp))
    .sort((left, right) => left - right)[0];

  /*
   * Collapsed to one of three words before it crosses the boundary.
   *
   * `presentation.panels` knows which arm has stopped and which has not, and
   * that pair is the loudest thing this screen could carry: the reviewer who
   * watches one column reach "Finished" first has learned the mapping's ordering
   * before ever reaching the form the ordering was hidden from. Narrowing it
   * here rather than in the component is the difference between a value nobody
   * renders and a value nobody holds — the first still travels in the payload.
   */
  const anyStarted = runs.length > 0;

  /*
   * TWO FACTS, NOT ONE, AND THEY ARE NOT THE SAME FACT.
   *
   * `awaitingAnswers` is the *only* state in which the second press does
   * anything: the action refuses from anywhere else. It used to be a union of
   * `awaiting_answers` and `preparing`, which put an enabled "build both plans"
   * button on screen for the whole world-purchase window — minutes, on a real
   * destination — and pressing it did nothing at all. No error, no change, no
   * feedback beyond one round-trip of reduced opacity. The live pilot script hit
   * it deterministically: it polled for the control, clicked the first one it
   * saw, and then waited out its whole deadline for a review that was never
   * going to arrive.
   *
   * So the control's render condition and the action's precondition are now the
   * same predicate, and the *badge* keeps the pooled wording — the reviewer is
   * told the comparison has not started planning either way, which is true in
   * both states and says nothing about either arm.
   */
  const preparing = session?.state === 'preparing';
  const awaitingAnswers = session?.state === 'awaiting_answers';

  return {
    pooledState:
      preparing || awaitingAnswers
        ? 'asking'
        : !anyStarted
          ? 'not_started'
          : presentation.bothTerminal
            ? 'finished'
            : 'working',
    bothTerminal: presentation.bothTerminal,
    anyStarted,
    preparing,
    awaitingAnswers,
    elapsedSeconds:
      startedAt === undefined ? null : Math.max(0, Math.floor((now.getTime() - startedAt) / 1000)),
    questions: poolQuestions(listQuestions(sessionId)),
  };
}
