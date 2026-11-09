'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  answerAdvisorQuestion,
  profileChips,
  skipAdvisorQuestion,
  type FocusKey,
  type QuestionId,
  type TripComposerAnswers,
} from '@sidequest/core';
import { advisorStepAction, buildAdvisorShortlistAction, saveAdvisorAnswersAction, type AdvisorStepView } from '@/app/(product)/decide/advisor-actions';
import { buttonClass, cx, ErrorNote } from '@/components/ui';
import { Glyph, type GlyphId } from '@/components/interview/glyphs';
import { formatCount } from './advisor-copy';
import { createSequencer, interviewScreen, type StepState } from './interview-step';
import { WorldDots } from './WorldDots';

/**
 * THE DESTINATION INTERVIEW: THE QUESTIONS HERE, THE RANKING ON THE SERVER.
 *
 * The questions and their options are pure patches on the answers and live in
 * the browser. Which question to ask next is not: it is the one expected to
 * move the list most, which means ranking the atlas, and the atlas — tens of
 * thousands of destinations — never leaves the server. So each committed
 * answer is one `advisorStepAction` call that returns the next question and
 * who is leading.
 *
 * Three rules for the gap that opens:
 *
 * - **Only the newest answer's step is used.** Requests are numbered and a
 *   late reply to an older answer is dropped.
 * - **Nothing jumps while a step is in flight.** The question just answered
 *   stays where it is, marked with what was picked, until the next one is
 *   known. The two essentials need no round trip at all — the policy asks them
 *   first in a fixed order, so the browser already knows which is next.
 * - **A step that fails is said to have failed.** The essentials are still
 *   asked, "Show me places now" still works, and the panel stops claiming to
 *   know who is leading.
 *
 * Every answer is saved as it is given; the server re-ranks from the stored
 * answers when the shortlist is built.
 */

const FOCUS_GLYPHS: Record<FocusKey, GlyphId> = {
  mountains: 'altitude',
  hiking: 'hike',
  wildlife: 'wildlife',
  lakes: 'lake',
  beaches: 'beach',
  rainforest: 'tent',
  road_trips: 'drive',
  desert: 'sunrise',
  volcanoes: 'geology',
  snow: 'stars',
  culture_food: 'food',
  cities: 'neighbourhood',
  rail: 'transit',
};

const HEADING = 'font-display text-[clamp(2rem,1.4rem+2.2vw,3.25rem)] leading-[1.02] font-[340] tracking-[-0.025em] text-balance text-ink focus:outline-none';

function impactWords(value: number): string {
  if (value >= 0.5) return 'Your answer could reshape most of the list.';
  if (value >= 0.3) return 'Your answer could swap several places.';
  return 'Your answer could change a place or two.';
}

export function AdvisorInterview({
  sessionId,
  initial,
  understood,
  startAt,
  dots,
  worldSize,
  sampleComplete,
}: {
  sessionId: string;
  initial: TripComposerAnswers;
  /** Chips read from what they typed, shown once at the top. */
  understood: string[];
  /** Re-ask one question (from "change" on the shortlist). */
  startAt?: QuestionId | null;
  /** Path data for the map: a server-thinned sample of real destination centres. */
  dots: string;
  /** How many destinations the advisor compares, known before the first step answers. */
  worldSize: number;
  /** True when the dots are every destination rather than a sample. */
  sampleComplete: boolean;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState(initial);
  const [forced, setForced] = useState<QuestionId | null>(startAt ?? null);
  const [error, setError] = useState<string | null>(null);
  /* Questions put on this screen — not the ones the typed request already settled. */
  const [shown, setShown] = useState(1);
  const [step, setStep] = useState<StepState<AdvisorStepView>>({ status: 'pending' });
  /* The last step that answered: the panel keeps showing it, marked as updating, while the next is in flight. */
  const [lastView, setLastView] = useState<AdvisorStepView | null>(null);
  /* The question just answered and what was picked, held on screen until the next step is known. */
  const [settling, setSettling] = useState<{ id: QuestionId; picked: readonly string[] } | null>(null);
  const [buildFailed, setBuildFailed] = useState(false);
  const [building, startBuilding] = useTransition();
  const built = useRef(false);
  const [sequencer] = useState(createSequencer);
  const heading = useRef<HTMLHeadingElement>(null);
  const answered = useRef(false);

  /** Ask the server for the step after `from`. A reply is used only if no later answer has been given since. */
  const askStep = (from: TripComposerAnswers) => {
    const ticket = sequencer.issue();
    advisorStepAction(from).then(
      (view) => {
        if (!sequencer.isCurrent(ticket)) return;
        setSettling(null);
        if (!view.ok) {
          setStep({ status: 'failed' });
          return;
        }
        setStep({ status: 'ready', view });
        setLastView(view);
      },
      () => {
        if (!sequencer.isCurrent(ticket)) return;
        setSettling(null);
        setStep({ status: 'failed' });
      },
    );
  };

  useEffect(() => {
    askStep(initial);
    /* Leaving the screen makes any reply still in flight stale. */
    return () => {
      sequencer.issue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Saves run one after another. Two quick taps fired as independent requests
   * can land out of order, and the older answer would then overwrite the newer
   * one on the server while the screen showed the newer.
   */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const save = (next: TripComposerAnswers) => {
    const queued = saving.current.then(() => saveAdvisorAnswersAction(sessionId, next));
    saving.current = queued.catch(() => undefined);
    return queued;
  };

  const commit = (next: TripComposerAnswers, from: { id: QuestionId; picked: readonly string[] }) => {
    answered.current = true;
    setAnswers(next);
    setShown((count) => count + 1);
    setForced(null);
    setError(null);
    setBuildFailed(false);
    setSettling(from);
    setStep({ status: 'pending' });
    /* The save goes first: an answer is kept before anything is worked out from it. */
    save(next).then(
      (result) => {
        if (!result.ok) setError(result.error ?? 'We could not save that answer.');
      },
      () => setError('We could not save that answer.'),
    );
    askStep(next);
  };

  const build = (from: TripComposerAnswers) => {
    if (built.current) return;
    built.current = true;
    setBuildFailed(false);
    setError(null);
    startBuilding(async () => {
      const fail = (message: string) => {
        built.current = false;
        setBuildFailed(true);
        setError(message);
      };
      try {
        const saved = await save(from);
        if (!saved.ok) return fail(saved.error ?? 'We could not save your answers.');
        const result = await buildAdvisorShortlistAction(sessionId);
        if (!result.ok) return fail(result.error ?? 'We could not build the list.');
      } catch {
        return fail('We could not build the list just then. Nothing was lost — try again.');
      }
      /* Back to the plain URL: from `?edit=1` a refresh would reopen the interview and build again. */
      router.replace(`/decide/${sessionId}`);
      router.refresh();
    });
  };

  const view = step.status === 'ready' ? step.view : null;
  const { mode, question, ready, finished } = useMemo(
    () => interviewScreen({ answers, forced, step, settling: settling?.id ?? null, building, buildFailed }),
    [answers, forced, step, settling, building, buildFailed],
  );

  const value = mode === 'ask' && question && view ? view.values.find((entry) => entry.id === question.id)?.value : undefined;
  const chips = useMemo(() => profileChips(answers), [answers]);
  const asked = answers.discovery?.asked.length ?? 0;

  /* The interview decided it has enough: build without asking for another press. */
  useEffect(() => {
    if (finished && !building && !buildFailed && !built.current) build(answers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  /*
   * After an answer the control that was pressed is gone. Put focus on the new
   * question so a keyboard does not restart from the top of the page — but only
   * when focus really was lost, and never on first load.
   */
  const liveId = mode === 'ask' ? (question?.id ?? null) : null;
  useEffect(() => {
    if (!answered.current || liveId === null) return;
    answered.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) heading.current?.focus({ preventScroll: true });
  }, [liveId]);

  const panel = step.status === 'failed' ? null : (view ?? lastView);
  const leaders = panel?.ready ? panel.leaders.slice(0, 6) : [];
  const size = formatCount(panel?.worldSize || worldSize);
  const updating = step.status === 'pending' && leaders.length > 0;
  const dotsNote = sampleComplete ? 'Each dot is a real destination centre.' : 'Dots are a sample of real destination centres.';
  const pickedNow = mode === 'settling' ? (settling?.picked ?? []) : [];

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-14">
      <section aria-live="polite" aria-labelledby="advisor-question" className="min-h-[20rem] min-w-0">
        {understood.length > 0 && asked <= 2 ? (
          <div className="mb-8">
            <p className="sheet-label text-ink-muted">What we took from that</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {understood.map((label) => (
                <li key={label} className="rounded-full bg-paper-sunk px-3 py-1 text-sm text-ink">
                  {label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {(mode === 'ask' || mode === 'settling') && question ? (
          <div key={question.id} className="fade-up" data-testid={`advisor-question-${question.id}`} aria-busy={mode === 'settling'}>
            <p className="sheet-label inline-flex items-center gap-2 text-accent">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
              {question.essential ? 'To start' : `Question ${mode === 'settling' ? Math.max(1, shown - 1) : shown}`}
            </p>
            <h2 ref={heading} tabIndex={-1} id="advisor-question" className={cx('mt-3 max-w-[24ch]', HEADING)}>
              {question.prompt}
            </h2>
            <p className="measure mt-3 type-body text-ink-muted">{question.why}</p>
            {value !== undefined && !question.essential ? <p className="type-meta mt-2 text-ink-faint">{impactWords(value)}</p> : null}

            {question.select === 'many' ? (
              <FocusPicker
                prompt={question.prompt}
                options={question.options(answers).map((option) => ({ id: option.id, label: option.label }))}
                initial={answers.discovery?.focus ?? []}
                disabled={mode === 'settling'}
                onDone={(picked) => commit(answerAdvisorQuestion(answers, 'focus', picked), { id: 'focus', picked })}
              />
            ) : (
              <div role="radiogroup" aria-labelledby="advisor-question" className="mt-8 grid gap-2 sm:grid-cols-2">
                {question.options(answers).map((option) => {
                  const inert = mode === 'settling';
                  const picked = pickedNow.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      aria-disabled={inert}
                      onClick={() => {
                        if (!inert) commit(answerAdvisorQuestion(answers, question.id, [option.id]), { id: question.id, picked: [option.id] });
                      }}
                      className={cx(
                        'group flex min-h-16 items-center justify-between gap-4 rounded-[var(--radius-card)] border px-4 py-3.5 text-left transition-[border-color,transform,background-color,opacity] duration-[var(--motion-fast)] focus-visible:ring-2 focus-visible:ring-flare focus-visible:outline-none',
                        picked ? 'border-ink bg-paper-sunk' : 'border-ink/15 bg-paper-raised',
                        inert ? cx('cursor-default', !picked && 'opacity-50') : 'hover:-translate-y-0.5 hover:border-ink',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block text-base font-medium text-ink">{option.label}</span>
                        {option.hint ? <span className="mt-0.5 block text-sm text-ink-muted">{option.hint}</span> : null}
                      </span>
                      <span aria-hidden="true" className={cx('transition-transform', picked ? 'text-ink' : 'text-ink-faint', !inert && 'group-hover:translate-x-0.5 group-hover:text-ink')}>
                        {picked ? '✓' : '→'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-ink/10 pt-5">
              {mode === 'settling' ? (
                <p role="status" className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-muted">
                  <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-flare" />
                  Finding the question that would change your list most…
                </p>
              ) : !question.essential ? (
                <button
                  type="button"
                  onClick={() => commit(skipAdvisorQuestion(answers, question.id), { id: question.id, picked: [] })}
                  className="min-h-11 text-sm text-ink-muted underline underline-offset-4 hover:text-ink"
                >
                  Skip this one
                </button>
              ) : null}
              {ready ? (
                <button type="button" onClick={() => build(answers)} className={buttonClass('secondary', 'md')}>
                  Show me places now
                </button>
              ) : (
                <span className="type-small text-ink-faint">Two quick ones and we can start showing places.</span>
              )}
            </div>
          </div>
        ) : mode === 'opening' ? (
          <div role="status" data-testid="advisor-opening">
            <p className="sheet-label inline-flex items-center gap-2 text-accent">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-flare" />
              Reading what you said
            </p>
            <h2 id="advisor-question" className={cx('mt-3 max-w-[24ch]', HEADING)}>
              Working out what to ask {shown === 1 ? 'first' : 'next'}…
            </h2>
            <p className="measure mt-3 type-body text-ink-muted">We only ask what would change the list, so the question depends on what you have already told us.</p>
            <div className="mt-8 border-t border-ink/10 pt-5">
              <button type="button" onClick={() => build(answers)} className={buttonClass('secondary', 'md')}>
                Show me places now
              </button>
            </div>
          </div>
        ) : mode === 'stalled' ? (
          <div data-testid="advisor-stalled">
            <p className="sheet-label text-accent">Enough to go on</p>
            <h2 ref={heading} tabIndex={-1} id="advisor-question" className={cx('mt-3 max-w-[24ch]', HEADING)}>
              We can show you places from what you’ve said.
            </h2>
            <p className="measure mt-3 type-body text-ink-muted">
              {buildFailed ? 'The list did not come together just then. Your answers are unchanged.' : 'We couldn’t work out the next question just then, so we have stopped asking.'}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-ink/10 pt-5">
              <button type="button" onClick={() => build(answers)} className={buttonClass('accent', 'lg')}>
                Show me places now
              </button>
              {!buildFailed ? (
                <button
                  type="button"
                  onClick={() => {
                    setStep({ status: 'pending' });
                    askStep(answers);
                  }}
                  className="min-h-11 text-sm text-ink-muted underline underline-offset-4 hover:text-ink"
                >
                  Try for another question
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="fade-up" role="status">
            <p className="sheet-label text-accent">Enough to go on</p>
            <h2 id="advisor-question" className={cx('mt-3', HEADING)}>
              Comparing {size} destinations against what you said…
            </h2>
            <p className="measure mt-3 type-body text-ink-muted">
              {view?.stopReason === 'low_value'
                ? 'Another question would barely change the list, so we stopped asking.'
                : 'Narrowing the world to the places that fit, reading those closely, and choosing three that differ from each other.'}
            </p>
            <div className="mt-6 h-1 w-full max-w-md overflow-hidden rounded-full bg-paper-sunk" aria-hidden="true">
              <div className="h-full w-1/3 animate-[advisor-sweep_1.4s_ease-in-out_infinite] rounded-full bg-flare" />
            </div>
          </div>
        )}

        {error ? (
          <div className="mt-6">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
      </section>

      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start" aria-label="Your shortlist taking shape">
        <div className="survey-night rounded-[var(--radius-card)] p-4 text-bone">
          <p className="sheet-label text-bone/70">{leaders.length > 0 ? (updating ? 'Leaning towards · updating' : 'Leaning towards') : 'The world we compare'}</p>
          <WorldDots
            dots={dots}
            highlighted={leaders}
            tone="night"
            className="mt-3 h-auto w-full"
            label={
              leaders.length > 0
                ? `World map marking the ${leaders.length} destinations currently leading: ${leaders.map((entry) => entry.name).join(', ')}. The faint dots are ${sampleComplete ? 'the' : 'a sample of the'} ${size} destinations we compare.`
                : `World map of ${sampleComplete ? 'the' : 'a sample of the'} ${size} destinations we compare`
            }
          />
          {leaders.length > 0 ? (
            <ol aria-busy={updating} className={cx('mt-3 space-y-1.5 transition-opacity duration-[var(--motion-fast)]', updating && 'opacity-60')}>
              {leaders.map((entry, index) => (
                <li key={entry.id} className="flex items-baseline gap-2 text-sm">
                  <span className="shrink-0 font-mono text-[0.7rem] text-flare">{index + 1}</span>
                  <span className="min-w-0 truncate text-bone">{entry.name}</span>
                  <span className="ml-auto max-w-[45%] min-w-0 truncate text-right text-[0.75rem] text-bone/55">{entry.context}</span>
                </li>
              ))}
            </ol>
          ) : step.status === 'failed' ? (
            <p className="mt-3 text-sm text-bone/70">We can’t show which places are leading just now. What you tell us still counts towards your list.</p>
          ) : (
            <p className="mt-3 text-sm text-bone/70">
              {size} destinations on every continent.{' '}
              {!ready
                ? 'Tell us what the trip is about and when, and the leaders light up.'
                : step.status === 'pending'
                  ? 'Working out which are leading…'
                  : 'None is clearly leading yet.'}
            </p>
          )}
          <p className="mt-3 border-t border-bone/10 pt-2 text-[0.72rem] text-bone/50">
            {leaders.length > 0 ? 'Provisional — it changes as you answer. ' : ''}
            {dotsNote}
          </p>
        </div>

        {chips.length > 0 ? (
          <div className="mt-5">
            <p className="sheet-label text-ink-muted">What we know so far</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <li key={`${chip.question}-${chip.label}`} className="max-w-full">
                  <button
                    type="button"
                    onClick={() => setForced(chip.question)}
                    className="min-h-9 max-w-full rounded-full border border-ink/15 px-3 py-1 text-left text-sm text-ink hover:border-ink"
                    aria-label={`Change: ${chip.label}`}
                  >
                    {chip.label}
                    {chip.assumed ? <span className="ml-1.5 text-[0.7rem] text-ink-faint">assumed</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/** The one multi-select: its own state, seeded once from the stored answers, remounted per question. */
function FocusPicker({
  prompt,
  options,
  initial,
  disabled,
  onDone,
}: {
  prompt: string;
  options: { id: string; label: string }[];
  initial: readonly string[];
  /** True while the answer just given is being worked from: the picks stay visible and cannot change. */
  disabled: boolean;
  onDone: (picked: string[]) => void;
}) {
  const [picked, setPicked] = useState<string[]>([...initial]);
  return (
    <fieldset className="mt-8" disabled={disabled}>
      <legend className="sr-only">{prompt} Choose any that apply.</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const on = picked.includes(option.id);
          return (
            <label
              key={option.id}
              className={cx(
                'relative flex min-h-[5.5rem] flex-col justify-between gap-3 rounded-[var(--radius-card)] border p-3.5 transition-[border-color,background-color,transform,opacity] duration-[var(--motion-fast)] focus-within:ring-2 focus-within:ring-flare',
                on ? 'border-ink bg-ink text-bone' : 'border-ink/15 bg-paper-raised text-ink',
                disabled ? cx(!on && 'opacity-50') : cx('cursor-pointer', !on && 'hover:-translate-y-0.5 hover:border-ink/50'),
              )}
            >
              <input
                type="checkbox"
                className={cx('absolute inset-0 m-0 h-full w-full appearance-none opacity-0', !disabled && 'cursor-pointer')}
                checked={on}
                onChange={() => setPicked((current) => (on ? current.filter((id) => id !== option.id) : [...current, option.id]))}
              />
              <Glyph id={FOCUS_GLYPHS[option.id as FocusKey] ?? 'compass'} className={cx('h-6 w-6', on ? 'text-flare' : 'text-ink-muted')} />
              <span className="text-[0.95rem] leading-tight font-medium">{option.label}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button type="button" disabled={picked.length === 0 || disabled} onClick={() => onDone(picked)} className={buttonClass('accent', 'lg')}>
          {picked.length === 0 ? 'Pick at least one' : `Continue with ${picked.length}`}
        </button>
        <span className="type-small text-ink-muted">Choose everything that appeals — we’ll ask what leads next.</span>
      </div>
    </fieldset>
  );
}
