'use client';

import { useCallback, useEffect, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  FORCED_CHOICE_OPTIONS,
  FORCED_CHOICE_QUESTIONS,
  MAX_CORRECTION_ROUNDS,
  PRIMARY_FORCED_CHOICE,
  RATING_DIMENSIONS,
  type ForcedChoiceOption,
  type PlanLabel,
} from '@sidequest/bench';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import {
  ErrorNote,
  FOCUS_RING,
  FieldLabel,
  OVERLAY_INPUT,
  Panel,
  buttonClass,
  cx,
} from '@/components/ui';
import { LABS_COPY } from './copy';
import { NeutralPlanView } from './NeutralPlanView';
import type { NeutralPanel, ReviewDraft } from './neutral-dto';

/**
 * THE RATING INSTRUMENT.
 *
 * Fifteen dimensions per plan, six forced choices, one required sentence, one
 * correction box that addresses both, and one lock. Everything the reviewer
 * touches lives in this component so that there is exactly one place where the
 * shape of a half-finished review is decided, and so the draft that is written
 * every second or so is the same object the lock is built from.
 *
 * Three decisions here are about the experiment rather than about the interface.
 *
 * **The two columns are drawn by one component with one set of props.** No
 * branch anywhere below asks which panel it is rendering. The only thing that
 * differs is the label, and the label was drawn once and stored.
 *
 * **Below 1280 the panels stack behind a switcher rather than shrinking.** Two
 * plans squeezed into 500 pixels each is not a comparison anybody can make, and
 * a reviewer who cannot read the second plan properly rates the first one.
 *
 * **The lock is an inline dialog, not a browser one.** `window.confirm` cannot
 * be styled, cannot be reached by a screen reader in any useful way, and — the
 * reason that matters here — cannot say *what* is about to become irreversible.
 * It is an `alertdialog` with a real heading, a visible focus ring, Escape to
 * back out and a Tab cycle that stays inside it, and focus goes back to the
 * control that opened it however it closes. An inline panel that merely *looked*
 * like a dialog left a keyboard reviewer tabbing through the form behind it,
 * with the irreversible button still one Enter away.
 *
 * ---
 *
 * Two things the form measures rather than assumes. Every control that exists
 * once per panel — legend, option name, checkbox — carries the panel's label in
 * its accessible name, because at 1280 and above both sets are in the tree at
 * once and fifteen scales named identically twice over is not a form anybody can
 * fill in by ear. And the time each panel is actually attended to is
 * accumulated, so the review carries the covariate that keeps a first-position
 * effect separable from the system.
 */

/** Long enough to coalesce typing; short enough that nothing is a save behind. */
const DRAFT_WRITE_MS = 800;
/** And a further pause before the live region says anything at all. */
const DRAFT_SETTLE_MS = 1_600;

/**
 * The four forced-choice options, with the two identities in the order the
 * panels are drawn in.
 *
 * `FORCED_CHOICE_OPTIONS` is a fixed A, B, tie, cannot-judge, which is the right
 * order to *store* them in and the wrong one to offer them in: the display order
 * is a coin toss, so on half of all sessions the first button named the plan on
 * the right. Tie and cannot-judge are not identities and keep their place at the
 * end, where their meaning does not depend on which panel is where.
 */
function choiceOptionsInDisplayOrder(
  panels: readonly NeutralPanel[],
): readonly ForcedChoiceOption[] {
  const shown = panels.map((panel) => panel.label);
  const isIdentity = (option: ForcedChoiceOption): option is PlanLabel =>
    option === 'A' || option === 'B';
  const identities = FORCED_CHOICE_OPTIONS.filter(isIdentity).sort(
    (left, right) => shown.indexOf(left) - shown.indexOf(right),
  );
  return [...identities, ...FORCED_CHOICE_OPTIONS.filter((option) => !isIdentity(option))];
}

export function ReviewSurface({
  sessionId,
  panels,
  initialDraft,
  locked,
  correctionRoundsUsed,
  saveDraft,
  lock,
  requestCorrection,
}: {
  sessionId: string;
  panels: readonly NeutralPanel[];
  initialDraft: ReviewDraft;
  locked: boolean;
  correctionRoundsUsed: number;
  saveDraft: (sessionId: string, draft: unknown) => Promise<{ ok: boolean }>;
  lock: (sessionId: string, draft: unknown) => Promise<{ kind: 'locked' | 'incomplete' | 'refused' }>;
  requestCorrection: (
    sessionId: string,
    instruction: string,
  ) => Promise<{ kind: 'sent' | 'limit_reached' | 'unavailable'; roundsUsed: number }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ReviewDraft>(initialDraft);
  const [announcement, setAnnouncement] = useState('');
  const firstLabel = panels[0]?.label ?? 'A';
  const [shown, setShown] = useState<PlanLabel>(firstLabel);
  const [confirming, setConfirming] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [locking, startLocking] = useTransition();
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const confirmDialog = useRef<HTMLDivElement>(null);
  const lockTrigger = useRef<HTMLButtonElement>(null);
  const lockErrorNote = useRef<HTMLDivElement>(null);
  const returnFocusToTrigger = useRef(false);

  /*
   * How long each panel was in front of the reviewer.
   *
   * `panelTimeMs` has been in the review schema since it was written, so that a
   * first-position effect stays estimable, and nothing ever wrote to it — which
   * made the covariate missing on every real review and left position and system
   * confounded in exactly the analysis it exists to rescue. Attention is tracked
   * rather than visibility: below 1280 only one panel is on screen and the
   * switcher says which, and at 1280 and above both are, so the panel last
   * touched or focused is the one being read. Neither figure is a stopwatch on
   * either system — both panels are already in front of the same person — so
   * measuring it costs the blinding nothing.
   */
  /** `since: null` is a stopped clock. Reading `Date.now()` at render is not. */
  const attended = useRef<{ label: PlanLabel; since: number | null }>({
    label: firstLabel,
    since: null,
  });
  const dwell = useRef<Record<string, number>>({ ...initialDraft.panelTimeMs });

  /** Closes the open stretch and opens one for `label`. Same label is a read. */
  const attend = useCallback((label: PlanLabel, running = true) => {
    const current = attended.current;
    if (current.since !== null) {
      dwell.current[current.label] =
        (dwell.current[current.label] ?? 0) + (Date.now() - current.since);
    }
    attended.current = { label, since: running ? Date.now() : null };
  }, []);

  /*
   * The clock starts on mount rather than at render, and stops when the tab
   * does: a review left open overnight is not four hundred minutes of reading,
   * and a figure that said it was would be worse than no figure at all.
   */
  useEffect(() => {
    attend(attended.current.label);
    const onVisibility = () =>
      attend(attended.current.label, document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      attend(attended.current.label, false);
    };
  }, [attend]);

  /**
   * The draft with the panel clock stopped and folded in.
   *
   * Read at the lock rather than kept in state: a figure that moved on every
   * glance would rewrite the draft row several times a minute and put a render
   * behind each one. The open stretch is closed first, or the panel the reviewer
   * was on when they pressed the button contributes nothing at all.
   */
  const withPanelTime = useCallback(
    (current: ReviewDraft): ReviewDraft => {
      attend(attended.current.label);
      const panelTimeMs: Record<string, number> = {};
      for (const [label, value] of Object.entries(dwell.current)) {
        panelTimeMs[label] = Math.max(0, Math.round(value));
      }
      return { ...current, panelTimeMs };
    },
    [attend],
  );

  /*
   * The draft is saved on a delay rather than on every keystroke.
   *
   * A fifteen-dimension form takes a while to fill in and losing it to an
   * accidental reload is the failure this exists to prevent — but writing on
   * every character would put a row-rewrite behind every key. Eight hundred
   * milliseconds is long enough to coalesce typing and short enough that
   * nothing meaningful is ever more than one save behind.
   *
   * The *announcement* is on a much longer leash than the write, and that is the
   * point of the second timer rather than an accident of it. A live region that
   * said "Saving…" and then "Saved" eight hundred milliseconds after every
   * keystroke talked over a screen-reader user in the middle of the one written
   * answer this form requires — twice per pause, for as long as they took to
   * write it. Only the settled state is worth saying, and only once the typing
   * has genuinely stopped. A save that did not land says nothing rather than
   * claiming something untrue.
   */
  useEffect(() => {
    if (locked) return;
    let cancelled = false;
    let settle: ReturnType<typeof setTimeout> | undefined;

    const write = setTimeout(async () => {
      /*
       * Emptied first, so the next settled state is a change the live region
       * announces rather than a repeat it swallows — and emptied inside the
       * timer rather than in the effect body, because clearing on every
       * keystroke is the cascade this whole arrangement exists to stop.
       */
      setAnnouncement('');
      /*
       * The panel clock rides along with every write, so a reload does not
       * restart it from zero: the accumulated figure is seeded back out of the
       * stored draft on the next mount.
       */
      const result = await saveDraft(sessionId, withPanelTime(draft));
      if (cancelled || !result.ok) return;
      settle = setTimeout(() => setAnnouncement(LABS_COPY.draftSaved), DRAFT_SETTLE_MS);
    }, DRAFT_WRITE_MS);

    return () => {
      cancelled = true;
      clearTimeout(write);
      if (settle !== undefined) clearTimeout(settle);
    };
  }, [draft, locked, saveDraft, sessionId, withPanelTime]);

  useEffect(() => {
    if (confirming) {
      confirmHeading.current?.focus();
      return;
    }
    if (returnFocusToTrigger.current) {
      returnFocusToTrigger.current = false;
      lockTrigger.current?.focus();
    }
  }, [confirming]);

  /*
   * A refusal takes the confirmation away, and with it whatever had focus. Left
   * alone, focus falls to the body and a keyboard reviewer is told nothing and
   * put nowhere; the note explaining what happened is the right place to land.
   */
  useEffect(() => {
    if (lockError !== null) lockErrorNote.current?.focus();
  }, [lockError]);

  const cancelConfirm = useCallback(() => {
    returnFocusToTrigger.current = true;
    setConfirming(false);
  }, []);

  /*
   * Escape backs out, and Tab stays inside.
   *
   * Without the cycle the reviewer tabs straight past an open confirmation into
   * the form it is covering, which reads as though the dialog had gone away
   * while an irreversible button is still one Enter behind them.
   */
  const onDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancelConfirm();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(confirmDialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === confirmHeading.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [cancelConfirm],
  );

  const complete = isComplete(draft, panels);
  const optionOrder = choiceOptionsInDisplayOrder(panels);

  return (
    <div className="grid gap-8">
      {/*
        The refusal lives here rather than beside the lock control, and that is
        not a layout preference.

        Locking revalidates the page, so a second tab that loses the race gets
        fresh props saying the review is locked — which removes the whole lock
        panel, and with it the message explaining what just happened. The
        reviewer would have pressed a button and seen the form quietly go
        read-only. Kept outside that branch, the refusal survives the refresh
        that caused it.
      */}
      {lockError ? (
        <div
          data-testid="lock-error"
          ref={lockErrorNote}
          tabIndex={-1}
          className="rounded-lg focus:outline focus:outline-2 focus:outline-clay focus:outline-offset-2"
        >
          <ErrorNote>{lockError}</ErrorNote>
        </div>
      ) : null}

      {locked ? (
        <Panel className="border-pine p-4">
          <p className="text-sm text-ink">{NEUTRAL_COPY.lockedNotice}</p>
        </Panel>
      ) : (
        <Panel className="p-4">
          <p className="text-sm text-ink-muted">{NEUTRAL_COPY.preRevealNotice}</p>
          <div className="mt-3 max-w-xs">
            <FieldLabel htmlFor="reviewer">{LABS_COPY.reviewerLabel}</FieldLabel>
            <input
              id="reviewer"
              value={draft.reviewer}
              onChange={(event) => setDraft({ ...draft, reviewer: event.target.value })}
              className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
            />
          </div>
        </Panel>
      )}

      {/*
        The switcher only exists below the width where both fit.

        Rendered as `xl:hidden` rather than conditionally, so the markup is the
        same at every width and the hidden column's radios stay in the form.
      */}
      <div
        role="group"
        aria-label={NEUTRAL_COPY.suiteName}
        className="sticky top-0 z-20 -mx-3 flex gap-2 border-b border-rule bg-paper px-3 py-2 sm:-mx-8 sm:px-8 xl:hidden"
      >
        {panels.map((panel) => (
          <button
            key={panel.label}
            type="button"
            aria-pressed={shown === panel.label}
            onClick={() => {
              attend(panel.label);
              setShown(panel.label);
            }}
            data-testid={`switch-${panel.label}`}
            className={cx(
              'min-h-11 flex-1 rounded-lg border px-3 text-sm font-medium transition-colors motion-reduce:transition-none',
              shown === panel.label
                ? 'border-pine bg-pine-soft text-pine'
                : 'border-rule bg-paper-raised text-ink',
            )}
          >
            {LABS_COPY.switchTo} {NEUTRAL_COPY.planLabel(panel.label)}
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {panels.map((panel) => (
          <section
            key={panel.label}
            aria-labelledby={`panel-${panel.label}-heading`}
            data-testid={`panel-${panel.label}`}
            /*
             * At 1280 and above both panels are on screen, so "visible" stops
             * being the same thing as "being read". Whichever one was last
             * touched or focused is the one the reviewer is on.
             */
            onPointerDownCapture={() => attend(panel.label)}
            onFocusCapture={() => attend(panel.label)}
            className={cx('min-w-0', shown === panel.label ? '' : 'hidden xl:block')}
          >
            <Panel className="p-3 sm:p-5">
              <h2
                id={`panel-${panel.label}-heading`}
                className="font-display text-2xl text-ink"
              >
                {NEUTRAL_COPY.planLabel(panel.label)}
              </h2>
              <div className="mt-4">
                <NeutralPlanView panel={panel} />
              </div>
            </Panel>

            <Panel className="mt-4 p-3 sm:p-5">
              <h3 className="text-sm font-medium text-ink">
                {LABS_COPY.ratingsHeading} — {NEUTRAL_COPY.planLabel(panel.label)}
              </h3>
              <p className="mt-1 text-xs text-ink-muted">{LABS_COPY.ratingScaleHint}</p>

              {/* `min-h-11` on the label: the checkbox itself is 20px, and the
                  label is what a finger lands on.

                  The label carries the panel it belongs to, said out loud and
                  not shown, because two checkboxes reading "I cannot rate this
                  one" are two identical controls in the same tree and "this one"
                  resolves to nothing at all when the sentence is heard rather
                  than seen. */}
              <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={draft.notRateable[panel.label] !== undefined}
                  onChange={(event) =>
                    setDraft(withRateability(draft, panel.label, event.target.checked))
                  }
                  className="h-5 w-5"
                />
                {LABS_COPY.cannotRateLabel}
                <span className="sr-only">{` — ${NEUTRAL_COPY.planLabel(panel.label)}`}</span>
              </label>

              {draft.notRateable[panel.label] !== undefined ? (
                <div className="mt-3">
                  <FieldLabel htmlFor={`not-rateable-${panel.label}`}>
                    {LABS_COPY.cannotRateReason}
                    <span className="sr-only">{` — ${NEUTRAL_COPY.planLabel(panel.label)}`}</span>
                  </FieldLabel>
                  <textarea
                    id={`not-rateable-${panel.label}`}
                    rows={2}
                    disabled={locked}
                    value={draft.notRateable[panel.label] ?? ''}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        notRateable: { ...draft.notRateable, [panel.label]: event.target.value },
                      })
                    }
                    className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
                  />
                </div>
              ) : (
                <div className="mt-4 grid gap-5">
                  {RATING_DIMENSIONS.map((dimension) => (
                    <RatingRow
                      key={dimension.id}
                      label={panel.label}
                      dimensionId={dimension.id}
                      question={dimension.question}
                      low={dimension.low}
                      high={dimension.high}
                      disabled={locked}
                      value={draft.scores[panel.label]?.[dimension.id] ?? null}
                      onSelect={(score) => setDraft(withScore(draft, panel.label, dimension.id, score))}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </section>
        ))}
      </div>

      <Panel className="p-3 sm:p-5">
        <h2 className="font-display text-2xl text-ink">{LABS_COPY.choicesHeading}</h2>
        <div className="mt-4 grid gap-6">
          {FORCED_CHOICE_QUESTIONS.map((question) => (
            <div key={question.id} className="min-w-0">
              <fieldset className="min-w-0">
                <legend className="text-sm text-ink">{question.question}</legend>
                {/*
                  The two identities run in the order the panels do.

                  The options used to be a fixed A, B while the panels rendered
                  in whichever order the display draw produced, so on half of all
                  sessions the left-hand plan was B and the left-hand button said
                  A. That is a mis-click waiting to happen on the primary metric,
                  and worse, a mis-click that correlates with the display draw —
                  which is the one thing the second draw exists to keep separable.
                  Tie and cannot-judge stay last, because they are not identities.
                */}
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {optionOrder.map((option) => (
                    <label
                      key={option}
                      className={cx(
                        'relative flex min-h-11 items-center justify-center rounded-lg border px-2 text-center text-sm transition-colors motion-reduce:transition-none',
                        FOCUS_RING,
                        draft.choices[question.id] === option
                          ? 'border-pine bg-pine-soft text-pine'
                          : 'border-rule bg-paper-raised text-ink',
                      )}
                    >
                      <input
                        type="radio"
                        name={`choice-${question.id}`}
                        value={option}
                        disabled={locked}
                        checked={draft.choices[question.id] === option}
                        onChange={() => setDraft(withChoice(draft, question.id, option))}
                        className={OVERLAY_INPUT}
                      />
                      {LABS_COPY.choiceOptions[option]}
                    </label>
                  ))}
                </div>
              </fieldset>

              {question.id === PRIMARY_FORCED_CHOICE ? (
                <div className="mt-3">
                  <FieldLabel htmlFor="explanation">{LABS_COPY.explanationLabel}</FieldLabel>
                  <p id="explanation-hint" className="mt-1 text-xs text-ink-muted">
                    {LABS_COPY.explanationHint}
                  </p>
                  <textarea
                    id="explanation"
                    rows={3}
                    disabled={locked}
                    aria-describedby="explanation-hint"
                    value={draft.explanation}
                    onChange={(event) => setDraft({ ...draft, explanation: event.target.value })}
                    className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
                  />
                  {draft.explanation.trim().length > 0 && draft.explanation.trim().length < 20 ? (
                    <ErrorNote>{LABS_COPY.explanationTooShort}</ErrorNote>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Panel>

      <CorrectionPanel
        sessionId={sessionId}
        locked={locked}
        roundsUsed={correctionRoundsUsed}
        requestCorrection={requestCorrection}
        onSent={() => router.refresh()}
      />

      {locked ? null : (
        <Panel className="p-3 sm:p-5">
          <h2 className="font-display text-2xl text-ink">{LABS_COPY.lockHeading}</h2>
          <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">{LABS_COPY.lockLede}</p>

          {complete ? null : <ErrorNote>{LABS_COPY.lockIncomplete}</ErrorNote>}

          {confirming ? (
            <Panel className="mt-4 border-pine p-4">
              <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="lock-confirm-heading"
                aria-describedby="lock-confirm-body"
                data-testid="lock-confirm-panel"
                ref={confirmDialog}
                onKeyDown={onDialogKeyDown}
              >
                {/*
                  A real heading, with a real focus ring on it.

                  It used to be a paragraph carrying `outline-none`, which took
                  the only visible indicator off the element focus had just been
                  moved to — so a sighted keyboard reviewer was told nothing and
                  could see nothing, on the one control in this form that cannot
                  be undone.
                */}
                <h3
                  id="lock-confirm-heading"
                  ref={confirmHeading}
                  tabIndex={-1}
                  /*
                    `focus:` rather than `focus-visible:`, and that distinction
                    is the whole fix. Focus arrives here programmatically after a
                    mouse press, so the browser's focus-visible heuristic says no
                    — and the reviewer, who did not ask for a dialog they cannot
                    see the edges of, gets an unmarked element holding focus in
                    front of an irreversible button.
                  */
                  className="rounded-sm text-sm font-medium text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2"
                >
                  {LABS_COPY.lockConfirmHeading}
                </h3>
                <p id="lock-confirm-body" className="measure mt-1 text-sm text-ink-muted">
                  {LABS_COPY.lockConfirmBody}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="lock-confirm"
                    disabled={locking}
                    className={cx(buttonClass('primary'), 'motion-reduce:transition-none')}
                    onClick={() =>
                      startLocking(async () => {
                        const result = await lock(sessionId, withPanelTime(draft));
                        if (result.kind === 'locked') {
                          router.push(`/labs/benchmark/${sessionId}/results`);
                          return;
                        }
                        setConfirming(false);
                        setLockError(
                          result.kind === 'incomplete'
                            ? LABS_COPY.lockIncomplete
                            : LABS_COPY.lockRefused,
                        );
                      })
                    }
                  >
                    {locking ? LABS_COPY.locking : LABS_COPY.lockConfirm}
                  </button>
                  <button
                    type="button"
                    data-testid="lock-cancel"
                    className={cx(buttonClass('secondary'), 'motion-reduce:transition-none')}
                    onClick={cancelConfirm}
                  >
                    {LABS_COPY.lockCancel}
                  </button>
                </div>
              </div>
            </Panel>
          ) : (
            <button
              type="button"
              data-testid="lock-open"
              ref={lockTrigger}
              disabled={!complete}
              className={cx(buttonClass('primary'), 'mt-4 motion-reduce:transition-none')}
              onClick={() => setConfirming(true)}
            >
              {LABS_COPY.lockButton}
            </button>
          )}
        </Panel>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One seven-point row
 * ------------------------------------------------------------------ */

const SCORES = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Native radios in a fieldset, so arrow keys, grouping and announcement are the
 * browser's rather than ours.
 *
 * The visible digit is `aria-hidden` and the accessible name is a full sentence,
 * because "5" read out on its own says nothing about which of fifteen scales it
 * belongs to — and a reviewer moving through this form with a screen reader hits
 * two hundred and ten of these.
 *
 * The sentence names the panel as well as the scale, and that half is not
 * decoration. At 1280 and above both panels are in the accessibility tree at the
 * same time, so without it the form offers thirty legends and two hundred and
 * ten options in fifteen identical pairs, and the only thing distinguishing one
 * "Pacing: 5 of 7" from the other is a position on screen that a screen-reader
 * user does not have. The panel label is the sole difference the blinding
 * permits, so it is the one that has to carry the distinction.
 *
 * Seven equal columns rather than a flex row, because at 390 pixels a flex row
 * either wraps into a shape that no longer reads as a scale or overflows the
 * document. A grid divides whatever width there is and each cell keeps its
 * 44-pixel height regardless.
 */
function RatingRow({
  label,
  dimensionId,
  question,
  low,
  high,
  value,
  disabled,
  onSelect,
}: {
  label: PlanLabel;
  dimensionId: string;
  question: string;
  low: string;
  high: string;
  value: number | null;
  disabled: boolean;
  onSelect: (score: number) => void;
}) {
  const name = `rating-${label}-${dimensionId}`;
  const hintId = `${name}-hint`;
  const panelName = NEUTRAL_COPY.planLabel(label);
  return (
    <fieldset className="min-w-0" data-testid={`rating-${label}-${dimensionId}`}>
      <legend className="text-sm leading-snug text-ink">
        {question}
        <span className="sr-only">{` — ${panelName}`}</span>
      </legend>
      <p id={hintId} className="mt-1 flex justify-between gap-2 text-xs text-ink-faint">
        <span>{low}</span>
        <span>{high}</span>
      </p>
      <div className="mt-1.5 grid grid-cols-7 gap-1">
        {SCORES.map((score) => (
          <label
            key={score}
            className={cx(
              'relative flex min-h-11 min-w-0 items-center justify-center rounded-lg border text-sm transition-colors motion-reduce:transition-none',
              FOCUS_RING,
              value === score
                ? 'border-pine bg-pine-soft font-medium text-pine'
                : 'border-rule bg-paper-raised text-ink',
            )}
          >
            <input
              type="radio"
              name={name}
              value={score}
              disabled={disabled}
              checked={value === score}
              onChange={() => onSelect(score)}
              aria-describedby={hintId}
              className={OVERLAY_INPUT}
            />
            <span aria-hidden="true">{score}</span>
            <span className="sr-only">{`${panelName} — ${humanise(dimensionId)}: ${score} of 7`}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ *
 * One instruction, both plans
 * ------------------------------------------------------------------ */

function CorrectionPanel({
  sessionId,
  locked,
  roundsUsed,
  requestCorrection,
  onSent,
}: {
  sessionId: string;
  locked: boolean;
  roundsUsed: number;
  requestCorrection: (
    sessionId: string,
    instruction: string,
  ) => Promise<{ kind: 'sent' | 'limit_reached' | 'unavailable'; roundsUsed: number }>;
  onSent: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  return (
    <Panel className="p-3 sm:p-5">
      <h2 className="font-display text-2xl text-ink">{LABS_COPY.correctionHeading}</h2>
      <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
        {LABS_COPY.correctionLede}
      </p>
      {/*
        THE ONE ROUND COUNTER FOR THE COMPARISON.

        The plan body used to carry a per-panel "2 / 3" beside each column, which
        labels the two panels for the rest of the sitting the moment one arm
        produces a revised plan and the other does not. Rounds are claimed for
        both arms by the same press, so a single figure is everything a shared
        counter can honestly say — and it belongs beside the box that asks for a
        change rather than on either plan.
      */}
      <p className="mt-2 text-xs text-ink-faint" data-testid="correction-rounds">
        {LABS_COPY.correctionRoundsUsed}: {roundsUsed} / {MAX_CORRECTION_ROUNDS}
      </p>

      <div className="mt-3">
        <FieldLabel htmlFor="correction">{LABS_COPY.correctionLabel}</FieldLabel>
        <textarea
          id="correction"
          rows={3}
          disabled={locked}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
        />
      </div>

      <button
        type="button"
        data-testid="correction-send"
        disabled={locked || pending || instruction.trim().length === 0}
        className={cx(buttonClass('secondary'), 'mt-3 motion-reduce:transition-none')}
        onClick={() =>
          startTransition(async () => {
            const result = await requestCorrection(sessionId, instruction.trim());
            setNote(
              result.kind === 'sent'
                ? `${LABS_COPY.correctionSent} ${LABS_COPY.correctionNoResult}`
                : result.kind === 'limit_reached'
                  ? LABS_COPY.correctionLimitReached
                  : LABS_COPY.correctionUnavailable,
            );
            if (result.kind === 'sent') {
              setInstruction('');
              onSent();
            }
          })
        }
      >
        {LABS_COPY.correctionSubmit}
      </button>

      <p role="status" aria-live="polite" data-testid="correction-note" className="mt-2 text-sm text-ink-muted">
        {note}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Draft arithmetic
 * ------------------------------------------------------------------ */

function withScore(
  draft: ReviewDraft,
  label: PlanLabel,
  dimensionId: string,
  score: number,
): ReviewDraft {
  return {
    ...draft,
    scores: {
      ...draft.scores,
      [label]: { ...(draft.scores[label] ?? {}), [dimensionId]: score },
    },
  };
}

function withChoice(draft: ReviewDraft, id: string, option: ForcedChoiceOption): ReviewDraft {
  return { ...draft, choices: { ...draft.choices, [id]: option } };
}


function withRateability(draft: ReviewDraft, label: PlanLabel, cannot: boolean): ReviewDraft {
  const notRateable = { ...draft.notRateable };
  if (cannot) notRateable[label] = notRateable[label] ?? '';
  else delete notRateable[label];
  return { ...draft, notRateable };
}

/**
 * Whether the lock control may be offered.
 *
 * A convenience, not a guarantee: the same completeness is decided again on the
 * server, because a disabled button is walked past by a second tab and by a
 * direct call. What this stops is somebody filling in fourteen of fifteen scales
 * and being told so only after pressing an irreversible button.
 */
function isComplete(draft: ReviewDraft, panels: readonly NeutralPanel[]): boolean {
  if (draft.reviewer.trim().length === 0) return false;
  if (draft.explanation.trim().length < 20) return false;
  if (FORCED_CHOICE_QUESTIONS.some((question) => draft.choices[question.id] === undefined)) {
    return false;
  }
  return panels.every((panel) => {
    const reason = draft.notRateable[panel.label];
    if (reason !== undefined) return reason.trim().length > 0;
    const scores = draft.scores[panel.label] ?? {};
    return RATING_DIMENSIONS.every((dimension) => scores[dimension.id] !== undefined);
  });
}

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
