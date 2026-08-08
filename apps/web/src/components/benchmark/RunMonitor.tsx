'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { BusyFormSubmit } from '@/components/BusyFormSubmit';
import { Badge, Panel, buttonClass, cx } from '@/components/ui';
import { LABS_COPY } from './copy';
import type { NeutralQuestion, RunSnapshot } from './neutral-dto';

/**
 * PROGRESS, WITHOUT SAYING WHICH IS AHEAD.
 *
 * Three things on this screen could give the game away and all three are handled
 * here rather than by being careful with wording.
 *
 * **There is one state, not two.** A badge per panel, repainted every second and
 * a half, told the reviewer which arm finished first on every single session —
 * and they then went straight to a rating form that is gated on both being
 * finished for exactly that reason. Pooling it to "one of two finished" would
 * have kept the tell and lost the honesty, so the snapshot carries one of three
 * words and the per-arm states never leave the server.
 *
 * **There is one clock, not two.** Both arms start on the same press, so a
 * single elapsed figure is everything a shared clock can honestly say. A per-arm
 * timer would announce the faster system on every session, and no amount of
 * neutral phrasing around it would help. There is no estimate at all, for the
 * sharper version of the same reason: an estimate that existed for one column
 * and not the other would be a tell that looked like a helpful detail.
 *
 * **The questions are one list.** Both systems' follow-ups are pooled, ordered
 * by sequence and then by a hash, and the answer goes to both. Which system
 * asked is persisted and never rendered.
 *
 * The polling shape is the one the compilation screen uses, including the key
 * guard, and for the reason that cost that screen a bug: seeding state from a
 * prop once means the props are ignored for the rest of the component's life, so
 * a `router.refresh()` re-renders the page around a snapshot from before it.
 */
export function RunMonitor({
  sessionId,
  initial,
  refresh,
  start,
  plan,
  answer,
}: {
  sessionId: string;
  initial: RunSnapshot;
  refresh: (sessionId: string) => Promise<RunSnapshot | null>;
  start: () => Promise<void>;
  plan: () => Promise<void>;
  answer: (sessionId: string, handle: string, values: string[]) => Promise<{ ok: boolean }>;
}) {
  const router = useRouter();

  const serverKey = keyOf(initial);
  const [adopted, setAdopted] = useState({ key: serverKey, value: initial });
  if (adopted.key !== serverKey) setAdopted({ key: serverKey, value: initial });
  const live = adopted.key === serverKey ? adopted.value : initial;

  useEffect(() => {
    if (live.bothTerminal || !live.anyStarted) return;
    const timer = setInterval(async () => {
      /*
       * A hidden tab asks nothing.
       *
       * The question round is explicitly a place a comparison may sit overnight,
       * and a poll that kept firing every second and a half through all of it
       * would issue tens of thousands of server actions to repaint a screen
       * nobody is looking at. The next paint after the tab is shown again is the
       * one that matters.
       */
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const next = await refresh(sessionId);
      if (next === null) return;
      /*
       * A functional update, so a poll in flight when the props changed keeps
       * whichever key is current when it lands rather than the one its interval
       * closed over — otherwise every later result is discarded on arrival and
       * the screen silently stops moving.
       */
      setAdopted((current) => ({ key: current.key, value: next }));
      if (next.bothTerminal) router.refresh();
    }, 1_500);
    return () => clearInterval(timer);
  }, [sessionId, live.bothTerminal, live.anyStarted, refresh, router]);

  return (
    <div className="grid gap-6">
      <Panel className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/*
            One polite live region, carrying the pooled sentence and nothing
            else.

            Everything on this screen changes under a poll and nothing announced
            itself, so a screen-reader user parked here was never told the
            comparison had finished. It carries the *pooled* state deliberately:
            a per-arm announcement would hand them the arrival order, which is
            the one thing this screen exists not to say.
          */}
          <p data-testid="panel-states" role="status" aria-live="polite">
            <Badge tone="neutral">{LABS_COPY.pooledStates[live.pooledState]}</Badge>
          </p>
          <Elapsed
            /*
             * Keyed on the server's own figure, so a new poll result remounts
             * the clock rather than the clock reaching back to correct itself.
             * Resetting local state from an effect is the version React warns
             * about: it renders once with the stale count and again with the
             * fresh one, on a component that ticks every second.
             */
            key={live.elapsedSeconds ?? 'none'}
            seconds={live.elapsedSeconds}
            running={!live.bothTerminal && live.anyStarted}
          />
        </div>

        {live.anyStarted ? (
          <p className="mt-3 text-sm text-ink-muted">
            {live.preparing
              ? LABS_COPY.preparingNote
              : live.awaitingAnswers
                ? LABS_COPY.askingNote
                : LABS_COPY.startedNote}
          </p>
        ) : (
          <form action={start} className="mt-4">
            <BusyFormSubmit
              idleLabel={LABS_COPY.startBoth}
              busyLabel={LABS_COPY.startBoth}
              variant="primary"
              testId="start-both"
            />
          </form>
        )}

        <div className="mt-4">
          {live.bothTerminal ? (
            <Link
              href={`/labs/benchmark/${sessionId}/review`}
              className={buttonClass('primary')}
              data-testid="to-review"
            >
              {LABS_COPY.goToReview}
            </Link>
          ) : (
            <p className="text-sm text-ink-muted" data-testid="not-yet-reviewable">
              {NEUTRAL_COPY.notYetReviewable}
            </p>
          )}
        </div>
      </Panel>

      <Panel className="p-4 sm:p-5">
        <h2 className="text-sm font-medium text-ink">{LABS_COPY.questionsHeading}</h2>
        <p className="measure mt-1 text-sm leading-relaxed text-ink-muted">
          {LABS_COPY.questionsLede}
        </p>

        {live.questions.length === 0 ? (
          <p className="mt-4 text-sm text-ink-muted">{LABS_COPY.questionsNone}</p>
        ) : (
          <ul className="mt-4 grid gap-4" data-testid="pooled-questions">
            {live.questions.map((question) => (
              <li key={question.handle}>
                <PooledQuestion
                  sessionId={sessionId}
                  question={question}
                  answer={answer}
                  open={live.awaitingAnswers}
                  onAnswered={() => router.refresh()}
                />
              </li>
            ))}
          </ul>
        )}

        {/*
          THE SECOND PRESS, AND WHY IT IS THE TRAVELLER'S TO MAKE.

          Nothing plans until this is pressed, and it is enabled whether or not
          anything was answered. An unanswered question is a legitimate outcome
          and is recorded as one; a screen that insisted on every answer would
          turn a measurement of how much people are willing to tell a planner
          into a form they had to complete.
        */}
        {live.awaitingAnswers ? (
          <form action={plan} className="mt-5 border-t border-rule pt-4">
            <p className="measure text-sm leading-relaxed text-ink-muted">
              {LABS_COPY.planBothHint}
            </p>
            <div className="mt-3">
              <BusyFormSubmit
                idleLabel={LABS_COPY.planBoth}
                busyLabel={LABS_COPY.planBoth}
                variant="primary"
                testId="plan-both"
              />
            </div>
          </form>
        ) : null}
      </Panel>
    </div>
  );
}

/**
 * The shared clock.
 *
 * Seeded from a figure the server computed at render, so the first client paint
 * matches the markup it hydrated and the ticking afterwards is the browser's
 * own. Computing "now" on both sides independently is how a hydration mismatch
 * gets introduced into a screen nobody looks at twice.
 */
function Elapsed({ seconds, running }: { seconds: number | null; running: boolean }) {
  // Seeded once, at mount. The parent's `key` is what makes a fresh server
  // figure a fresh mount, so there is nothing here to synchronise afterwards.
  const [shown, setShown] = useState(seconds);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => setShown((current) => (current === null ? null : current + 1)),
      1_000,
    );
    return () => clearInterval(timer);
  }, [running]);

  if (shown === null) return null;
  const minutes = Math.floor(shown / 60);
  const rest = shown % 60;
  return (
    <p className="text-sm text-ink-muted">
      <span className="text-ink-faint">{LABS_COPY.elapsedLabel}: </span>
      <span className="tabular-nums text-ink" data-testid="elapsed">
        {minutes}:{String(rest).padStart(2, '0')}
      </span>
    </p>
  );
}

/**
 * ONE QUESTION, NAMED BY ITSELF.
 *
 * Three things were wrong with the first version and all three are the same
 * mistake: the question was a paragraph beside the control rather than part of
 * it.
 *
 * **Every control had the same accessible name.** The label wrapped "Your
 * answer" and nothing else, so a screen-reader user tabbing a list of six
 * questions heard "Your answer, edit" six times and "Save this answer, button"
 * six times, with nothing to tell them apart. The review form was built
 * carefully to avoid exactly this — its ratings announce "Plan A — Pacing: 5 of
 * 7" rather than "5" — and this screen did not follow it.
 *
 * **Saving destroyed focus.** The branch flipped, the button was unmounted, and
 * focus fell to `body`; the next Tab restarted at the skip link. The answered
 * state now keeps a focusable element in the same place and announces itself.
 *
 * **A refusal was invisible.** The action's result was awaited and discarded, so
 * an answer refused for being too long, for not being one of the offered
 * choices, or for arriving after the plans were asked for looked exactly like an
 * answer that had been saved — and the text stayed in the box while nothing was
 * stored.
 */
function PooledQuestion({
  sessionId,
  question,
  answer,
  onAnswered,
  open,
}: {
  sessionId: string;
  question: NeutralQuestion;
  answer: (sessionId: string, handle: string, values: string[]) => Promise<{ ok: boolean }>;
  onAnswered: () => void;
  /** Whether the round is still taking answers. Refusals are silent otherwise. */
  open: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState('');
  const [refused, setRefused] = useState(false);
  const hintId = `${question.handle}-why`;
  const askId = `${question.handle}-ask`;
  const labelId = `${question.handle}-label`;
  const errorId = `${question.handle}-error`;

  const describedBy = [hintId, refused ? errorId : null].filter(Boolean).join(' ');

  return (
    <Panel className="bg-paper-sunk p-3">
      <p id={askId} className="text-sm font-medium text-ink">
        {question.text}
      </p>
      <p id={hintId} className="measure mt-1 text-xs leading-relaxed text-ink-muted">
        <span className="text-ink-faint">{LABS_COPY.questionWhy}: </span>
        {question.whyItMatters}
      </p>

      {question.answered ? (
        /*
         * Focusable, and in the same place the button was.
         *
         * `tabIndex={-1}` rather than a disabled button: there is nothing left to
         * press, and a control that looks pressable and is not is its own small
         * lie. What matters is that focus has somewhere to land after the swap.
         */
        <p
          tabIndex={-1}
          role="status"
          className="mt-2 text-xs text-ink-faint outline-none"
        >
          {LABS_COPY.answerSaved}
        </p>
      ) : !open ? (
        <p className="mt-2 text-xs text-ink-faint">{LABS_COPY.answersClosed}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label id={labelId} className="min-w-0 flex-1 text-xs text-ink-faint">
            {LABS_COPY.answerLabel}
            {question.options.length > 0 ? (
              <select
                // The question first, then "Your answer" — so the control is
                // announced as the question it belongs to rather than as one of
                // six identical boxes.
                aria-labelledby={`${askId} ${labelId}`}
                aria-describedby={describedBy}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setRefused(false);
                }}
                className="mt-1 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
              >
                <option value="">{NEUTRAL_COPY.notStated}</option>
                {question.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-labelledby={`${askId} ${labelId}`}
                aria-describedby={describedBy}
                // The server refuses anything longer, silently. Mirrored here so
                // the refusal is a limit somebody can see rather than one they
                // discover by losing what they typed.
                maxLength={MAX_ANSWER_LENGTH}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setRefused(false);
                }}
                className="mt-1 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
              />
            )}
          </label>
          <button
            type="button"
            aria-labelledby={`${askId} ${question.handle}-save`}
            disabled={pending || value.trim().length === 0}
            className={cx(buttonClass('secondary', 'sm'), 'motion-reduce:transition-none')}
            onClick={() =>
              startTransition(async () => {
                const result = await answer(sessionId, question.handle, [value.trim()]);
                if (!result.ok) {
                  setRefused(true);
                  return;
                }
                setRefused(false);
                onAnswered();
              })
            }
          >
            <span id={`${question.handle}-save`}>{LABS_COPY.answerSubmit}</span>
          </button>
        </div>
      )}

      {refused ? (
        <p id={errorId} role="alert" className="mt-2 text-xs text-amber">
          {LABS_COPY.answerRefused}
        </p>
      ) : null}
    </Panel>
  );
}

/** The server's own bound on one answer, mirrored so the refusal is visible. */
const MAX_ANSWER_LENGTH = 500;

/**
 * What makes one snapshot a different snapshot.
 *
 * Deliberately excludes the elapsed seconds, which change every time anybody
 * looks: including them would make every server render a new key and throw away
 * whatever the poll had learned since.
 */
function keyOf(snapshot: RunSnapshot): string {
  return [
    snapshot.pooledState,
    snapshot.bothTerminal,
    snapshot.anyStarted,
    snapshot.awaitingAnswers,
    snapshot.questions.length,
    snapshot.questions.filter((question) => question.answered).length,
  ].join('|');
}
