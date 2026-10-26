'use client';

import { placementNote } from './placement-note';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ARRIVAL_PRECISIONS,
  ARRIVAL_PRECISION_LABELS,
  TRAVELER_NEEDS,
  TRAVELER_NEED_LABELS,
  type TripComposerAnswers,
} from '@sidequest/core';
import { DestinationCanvas } from '../DestinationCanvas';
import type { DestinationGeometry } from '../interview/DestinationMap';
import type { MapBasemap } from '../map-adapter';
import { DestinationField, type DestinationSuggestionView } from './DestinationField';
import { TimingStep } from './TimingStep';
import { StagePath } from '../interview/StagePath';
import { onRadioGroupKeys, rovingTabIndex } from './radio-keys';
import { ACCENT_WAITING, StepHeading } from './StepHeading';
import { QUESTION_S, QUESTION_VARIANTS, timing, type Direction } from '../interview/choreography';
import { ErrorNote, FOCUS_RING, buttonClass, cx } from '../ui';
import { scopeWords } from './destination-prefill';
import { createTripFromComposer, updateTripFromComposer, type ComposerResult } from '@/app/(product)/trips/new/actions';
import { placeDestinationAction } from '@/app/(product)/trips/new/place-actions';
import type { SetupDraft, SetupStepId } from './setup-draft';
import { SETUP_STEPS, SETUP_STEP_LABELS, describeParty, initialDraft, isStepAnswered, nextStep, previousStep, payloadFor, stepIsRelevant, summaryOf, advanceDraft } from './setup-draft';

/**
 * ONE QUESTION AT A TIME, FROM THE FIRST SCREEN.
 *
 * MVP V3, Stages 4 and 45. What this replaces: a single page carrying a
 * destination field, two date inputs, a flexibility radio group, a month select,
 * a season group, two checkboxes, a nights field, two head counts, a needs
 * checklist, two time selects and two textareas — and then, on the *next*
 * screen, an interview that started by asking what the trip was for. Two
 * questionnaires with a form in between.
 *
 * There is one interview now. These five screens are its first stage, they share
 * its progress path (`StagePath`), and each of them asks exactly one thing:
 *
 *   where · when · how many nights · who · anything already fixed
 *
 * ## The rules the screens are built to
 *
 * **The destination is free text and always was.** Nothing here requires a row
 * from the index; suggestions are an optional convenience under the field. See
 * `DestinationField`.
 *
 * **Timing is an intent, not two dates.** "Tell me when it is best" and "I am
 * free between these dates" are first-class answers that need no date from the
 * traveller at all — Sidequest answers them from climate records and says what
 * it does not know. See `TimingStep`.
 *
 * **Nights, not "how long".** A trip is measured in beds; days are derived and
 * shown beside them.
 *
 * **Nothing is asked before it changes something.** Check-in and check-out
 * times are not settings; they are asked only if the traveller says a flight is
 * already booked, and are otherwise an estimate that says it is one.
 *
 * **Back always works, including the browser's.** Each step is a history entry
 * (`?step=`), the draft is kept in session storage as it is typed, and no answer
 * is lost by refreshing, reloading or navigating away and returning.
 */

export function SetupFlow({
  defaults,
  editing,
  intent = 'new',
  tiles = null,
  initialStep,
  initialDestination = null,
}: {
  defaults: { startDate: string; endDate: string };
  editing?: { tripId: string; answers: TripComposerAnswers };
  intent?: 'new' | 'has_plan';
  tiles?: MapBasemap | null;
  initialStep?: SetupStepId;
  /** V8 — `?destination=` from the home page's example prompts: the field starts with these words and they are placed like typed ones. */
  initialDestination?: string | null;
}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<SetupDraft>(() => {
    const base = initialDraft(defaults, editing?.answers);
    return initialDestination && !editing ? { ...base, destinationText: initialDestination } : base;
  });
  const [step, setStep] = useState<SetupStepId>(initialStep ?? 'where');
  /* V8 — which way the next screen enters: forward on Continue, back on Back and on the browser's own Back. */
  const [direction, setDirection] = useState<Direction>('forward');
  const stepRef = useRef<SetupStepId>(initialStep ?? 'where');
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  const directionTo = useCallback((next: SetupStepId): Direction => (SETUP_STEPS.indexOf(next) < SETUP_STEPS.indexOf(stepRef.current) ? 'back' : 'forward'), []);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement | null>(null);
  const storageKey = editing ? `sidequest:setup:${editing.tripId}` : 'sidequest:setup:new';

  /*
   * Restore anything typed before a refresh — once, on mount.
   *
   * `set-state-in-effect` is suppressed here rather than worked around, because
   * this is the case the rule cannot express: the source of truth is the
   * browser's own session storage, which the server render cannot see and which
   * therefore *must* arrive after the first commit. Deferring it to a microtask
   * or a transition to satisfy the linter would change nothing except how
   * honest the code looks. It runs at most once and reads no React state.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || editing) return;
    restored.current = true;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDraft((current) => {
          const restored = { ...current, ...(JSON.parse(saved) as Partial<SetupDraft>) };
          /* Somebody who arrived with a destination in the address bar meant that one, not the one they typed last week. */
          return initialDestination && restored.destinationText.trim() !== initialDestination
            ? { ...restored, destinationText: initialDestination, destinationEntryId: null, destinationCenter: null, destinationBounds: null, destinationFeatureType: null, destinationSemanticType: null, destinationScale: null, destinationExtentSource: null, destinationGateways: [] }
            : restored;
        });
      }
    } catch {
      /* a private window with storage refused is not an error worth showing */
    }
  }, [editing, storageKey, initialDestination]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      /* see above */
    }
  }, [draft, storageKey]);

  /*
   * The step lives in the address bar, so the browser's own Back is the Back
   * button. The *initial* step comes from the server (`?step=` is read in the
   * page), so nothing has to be synced on mount — only later history moves.
   */
  useEffect(() => {
    const apply = () => {
      const raw = new URLSearchParams(window.location.search).get('step');
      const next = raw && (SETUP_STEPS as readonly string[]).includes(raw) ? (raw as SetupStepId) : 'where';
      setDirection(directionTo(next));
      setStep(next);
    };
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [directionTo]);

  const goTo = useCallback(
    (next: SetupStepId, mode: 'push' | 'replace' = 'push') => {
      setError(null);
      setDirection(directionTo(next));
      setStep(next);
      const url = `${window.location.pathname}?step=${next}`;
      if (mode === 'push') window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
      window.scrollTo({ top: 0 });
    },
    [directionTo],
  );

  /*
   * Focus moves to the new question's heading — but only when the step
   * actually changed, never on the first paint.
   *
   * Somebody arriving at /trips/new did not navigate here from inside the
   * flow, so there is nothing to announce and nothing to take them to; the
   * browser treats a programmatic focus with no preceding interaction as
   * keyboard focus, which drew a dashed outline around "Where are you
   * thinking?" for every visitor. Between steps the move is the whole point:
   * it is what tells a screen-reader user the question changed.
   */
  const focusedStep = useRef<SetupStepId | null>(null);
  useEffect(() => {
    if (focusedStep.current !== null && focusedStep.current !== step) {
      heading.current?.focus({ preventScroll: true });
    }
    focusedStep.current = step;
  }, [step]);

  const patch = useCallback((next: Partial<SetupDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const geometry: DestinationGeometry | null = draft.destinationCenter
    ? {
        name: draft.destinationText.trim() || 'Your destination',
        center: draft.destinationCenter,
        bounds: draft.destinationBounds ?? null,
        ...(draft.destinationFeatureType ? { featureType: draft.destinationFeatureType } : {}),
        /* V8.1 — how wide to frame when nobody published an extent, and how the extent was arrived at. */
        ...(draft.destinationScale ? { scale: draft.destinationScale } : {}),
        ...(draft.destinationExtentSource ? { extentSource: draft.destinationExtentSource } : {}),
        ...(draft.destinationGateways.length > 0 ? { gateways: draft.destinationGateways } : {}),
      }
    : null;

  /*
   * PLACING WHAT THEY TYPED — ONCE, WHEN THEY MOVE ON (§1, §4).
   *
   * Only a picked suggestion used to carry a coordinate, so on a deployment with
   * no destination index nothing typed was ever placed: the canvas showed the
   * empty world and the seasons screen said the destination could not be placed.
   * Both were statements about a missing local table, made as if they were facts
   * about the world.
   *
   * The lookup runs when the traveller leaves the "where" step and not before —
   * never per keystroke, because the geocoder's policy forbids autocomplete and
   * because a person changing their mind mid-word has not asked anything yet. It
   * is fire-and-forget: the next screen is not waiting for it, and if the answer
   * arrives late the map and the timing recommendation pick it up when it does
   * (`TimingStep` keys its recommendation on the centre).
   */
  const [placing, setPlacing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  /**
   * V10 §15 — what the canvas says when it will not draw.
   *
   * A destination whose only centre is its country's published point is not
   * located, and framing it drew eastern Canada for a mountain region. The server
   * says `reason: 'locating'` for exactly that case, and the caption then names
   * the kind of thing it is still looking for instead of pretending.
   */
  const [locating, setLocating] = useState<string | null>(null);
  /* V1 convergence — the reason a lookup placed nothing, when the failure was ours (`placement-note.ts`). */
  const [unplacedNote, setUnplacedNote] = useState<string | null>(null);
  const placedFor = useRef<string | null>(null);

  const place = useCallback((text: string) => {
    const query = text.trim();
    if (query.length < 2 || placedFor.current === query) return;
    placedFor.current = query;
    setPlacing(true);
    setUnplacedNote(null);
    void placeDestinationAction({ text: query })
      .then((result) => {
        if (placedFor.current !== query) return;
        setLocating(!result.placed && result.reason === 'locating' && result.locating ? result.locating.kindLabel : null);
        setUnplacedNote(result.placed ? null : placementNote(result.reason));
        if (result.placed) {
          const placed = result.placed;
          setDraft((current) =>
            current.destinationText.trim() !== query
              ? current
              : {
                  ...current,
                  destinationCenter: placed.center,
                  destinationBounds: placed.bounds ?? null,
                  destinationFeatureType: placed.featureType ?? null,
                  destinationSemanticType: placed.semanticType ?? null,
                  destinationScale: placed.scale ?? null,
                  destinationExtentSource: placed.extentSource ?? null,
                  destinationGateways: placed.gateways ?? [],
                },
          );
        }
      })
      .catch(() => {
        /* Not placed is not an error the traveller has to act on; the canvas says so quietly. */
        if (placedFor.current === query) setUnplacedNote(placementNote('request_failed'));
      })
      .finally(() => {
        if (placedFor.current !== query) return;
        setPlacing(false);
        setAttempted(true);
      });
  }, []);

  /*
   * V8 — a destination that arrived in the address bar is placed on arrival,
   * once, the same way a typed one is placed when the traveller moves on. The
   * screen is not waiting for it; the canvas says "Placing this on the map…"
   * and then frames it, or keeps the name if nothing could.
   */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !initialDestination || editing) return;
    prefilled.current = true;
    place(initialDestination);
  }, [initialDestination, editing, place]);

  const summary = useMemo(() => summaryOf(draft), [draft]);
  /* Steps that still count for this trip and have no line in the summary yet — "How long" disappears once two dates answer it. */
  const ahead = useMemo(() => {
    const shown = new Set(summary.lines.map((line) => line.label));
    const lineFor: Record<SetupStepId, string> = { where: 'Where', when: 'When', nights: 'Length', who: 'Who', fixed: 'Anything fixed' };
    return SETUP_STEPS.filter((id) => stepIsRelevant(id, draft) && !shown.has(lineFor[id]) && !(id === 'fixed' && draft.answered.includes('fixed')));
  }, [summary, draft]);
  /* The semantic reading names the kind of thing first; the row's own class is the fallback. */
  const scope = scopeWords(draft.destinationSemanticType) ?? scopeWords(draft.destinationFeatureType);

  function submit(source: SetupDraft = draft) {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const payload = payloadFor(source);
      const result: ComposerResult = editing ? await updateTripFromComposer(editing.tripId, payload) : await createTripFromComposer(payload);
      if (!result.ok) {
        setError(result.error ?? null);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* nothing to clean up */
      }
      router.push(result.href);
    });
  }

  /*
   * V6 — THE DRAFT THIS HANDLER ADVANCES IS THE ONE THAT INCLUDES THE PRESS.
   *
   * "Use this timing" used to call `onChange({ pick })` and then
   * `onContinue()` in the same handler. `advance` read `draft` from its
   * closure — the render before the pick — built `answeredDraft` from it and
   * called `setDraft(answeredDraft)`, a whole-object replacement that landed
   * after the functional pick update and overwrote it. The accepted window
   * never reached the payload; the trip was created with a placeholder month;
   * the composition was told nobody had chosen; and a traveller who pressed
   * June got October. Two production trips, both real.
   *
   * So a step may hand its final answer to `advance` directly, and `advance`
   * folds it in through the functional setter it should always have used.
   * `draftRef` is the render-fresh draft for the same reason.
   */
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  function advance(extra?: Partial<SetupDraft>) {
    const current = { ...draftRef.current, ...(extra ?? {}) };
    /* Leaving "where" with typed text nobody has placed yet: ask, and keep going. */
    if (step === 'where' && current.destinationCenter === null) place(current.destinationText);
    // Answering is what makes a step count, so the summary can never show a default.
    const answeredDraft = advanceDraft(current, step);
    setDraft((previous) => ({ ...previous, ...(extra ?? {}), answered: answeredDraft.answered }));
    const next = nextStep(step, answeredDraft);
    if (next === null) {
      submit(answeredDraft);
      return;
    }
    goTo(next);
  }

  const canContinue = isStepAnswered(step, draft);
  const back = previousStep(step, draft);

  return (
    <div className="survey min-h-[calc(100dvh-var(--chrome-height))]">
      <div className="mx-auto w-full max-w-7xl px-5 pb-36 sm:px-8 lg:pb-16" data-testid="setup-flow" data-step={step}>
        <div className="pt-5">
          <StagePath current="trip" note={summary.short} />
        </div>

        <div className="mt-6 grid gap-8 lg:mt-8 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-14">
          <div
            className="relative order-1 min-w-0 lg:order-1"
            onKeyDown={(event) => {
              /*
               * Enter moves on from any step, the way it does from the
               * destination field — but never from a control that owns Enter
               * itself (a button presses, a textarea breaks a line).
               */
              if (event.key !== 'Enter' || event.defaultPrevented || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
              const target = event.target as HTMLElement;
              if (['BUTTON', 'TEXTAREA', 'SELECT', 'A'].includes(target.tagName)) return;
              if (!isStepAnswered(step, draftRef.current) || pending) return;
              event.preventDefault();
              advance();
            }}
          >
            {/*
              V8 — one question replaces another with a directional slide: forward
              enters from the right, back from the left. ≤ 260 ms; nothing under
              reduced motion.
            */}
            <AnimatePresence initial={false} mode="wait" custom={direction}>
              <motion.div key={step} custom={direction} variants={QUESTION_VARIANTS} initial="initial" animate="animate" exit="exit" transition={timing(QUESTION_S, reduced)} className="min-w-0">
                {step === 'where' ? (
                  <WhereStep
                    intent={intent}
                    draft={draft}
                    headingRef={heading}
                    error={fieldErrors.destination}
                    onChange={patch}
                    onSubmit={advance}
                    onSettle={place}
                  />
                ) : null}

                {step === 'when' ? (
                  <TimingStep
                    draft={draft}
                    headingRef={heading}
                    onChange={patch}
                    onContinue={advance}
                  />
                ) : null}

                {step === 'nights' ? <NightsStep draft={draft} headingRef={heading} onChange={patch} onSubmit={advance} /> : null}
                {step === 'who' ? <WhoStep draft={draft} headingRef={heading} onChange={patch} /> : null}
                {step === 'fixed' ? <FixedStep draft={draft} headingRef={heading} onChange={patch} hasPlan={intent === 'has_plan'} /> : null}
              </motion.div>
            </AnimatePresence>

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <div className="mt-12 hidden items-center justify-between gap-4 border-t-[1.5px] border-ink pt-4 lg:flex">
              <div className="flex items-center gap-3">
                {back ? (
                  <button type="button" onClick={() => goTo(back, 'push')} className={buttonClass('ghost')} data-testid="setup-back">
                    ← Back
                  </button>
                ) : null}
                {step === 'fixed' ? <span className="type-small text-ink-faint">Optional — most trips have nothing here.</span> : null}
              </div>
              <div className="flex items-center gap-4">
                {canContinue && !pending && step !== 'fixed' ? (
                  <span className="hidden font-mono text-[11px] tracking-[0.06em] text-ink-faint xl:inline" aria-hidden="true">
                    or press <kbd className="rounded-[3px] border border-ink/25 bg-paper-raised px-1.5 py-0.5 text-ink-muted">Enter ↵</kbd>
                  </span>
                ) : null}
                <button type="button" onClick={() => advance()} disabled={!canContinue || pending} className={cx(buttonClass('accent', 'lg'), ACCENT_WAITING)} data-testid="setup-continue">
                  {pending ? 'Saving…' : nextStep(step, draft) === null ? 'Start the interview →' : 'Continue →'}
                </button>
              </div>
            </div>
          </div>

          {/* On a phone the question comes first and the map follows it, so the field and its examples are above the fold. */}
          <aside className="order-2 min-w-0 lg:order-2">
            <div className="lg:sticky lg:top-[calc(var(--chrome-height)+1.25rem)]">
              <DestinationCanvas geometry={geometry} tiles={tiles} destinationText={draft.destinationText} placing={placing} attempted={attempted} locating={locating} unplacedNote={unplacedNote} scope={scope} />
              {/*
                V8 — THE TRIP PORTRAIT: only the facts the traveller has actually
                given, as ruled rows, each settling into place as it is answered.
              */}
              <div className="mt-4 hidden lg:block">
                <div className="flex items-baseline justify-between gap-3 pb-2">
                  <p className="sheet-label text-ink">Your trip so far</p>
                  <p className="font-mono text-[11px] tracking-[0.06em] text-ink-faint">{ahead.length === 0 ? 'All set' : `${ahead.length} ${ahead.length === 1 ? 'question' : 'questions'} to go`}</p>
                </div>
              {summary.lines.length > 0 ? (
                <dl className="ruled border-t-[1.5px] border-ink" data-testid="setup-summary" aria-label="Your trip so far">
                  <AnimatePresence initial={false}>
                    {summary.lines.map((line) => (
                      <motion.div key={line.label} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={timing(QUESTION_S, reduced)} className="flex items-baseline justify-between gap-3 py-2.5">
                        <dt className="sheet-label text-ink-muted">{line.label}</dt>
                        <dd className={cx('min-w-0 text-right font-display text-lg', /\d/.test(line.value) ? 'type-figure' : '', line.assumed ? 'text-ink-muted italic' : 'text-ink')}>{line.value}</dd>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </dl>
              ) : null}
              {/*
                What is still to come, as the same ruled rows in their empty state:
                a sense of how short this is, and the right-hand column stops
                being a small map above a lot of nothing.
              */}
              {ahead.length > 0 ? (
                <ol className={cx('ruled', summary.lines.length > 0 ? 'border-t border-ink/15' : 'border-t-[1.5px] border-ink')} aria-label="Still to come" data-testid="setup-ahead">
                  {ahead.map((id) => (
                    <li key={id} className={cx('flex items-baseline justify-between gap-3 py-2.5', id === step ? 'text-ink' : 'text-ink-faint')}>
                      <span className="sheet-label">{SETUP_STEP_LABELS[id]}</span>
                      <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.06em]">
                        {id === step ? (
                          <>
                            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-flare" />
                            Answering now
                          </>
                        ) : (
                          <span aria-hidden="true" className="inline-block h-px w-10 bg-current opacity-50" />
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
              <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                {step === 'fixed' ? 'Next: a short interview about how you like to travel. Every question can be handed to Sidequest.' : 'About a minute. Nothing is booked or charged — you can change any answer later.'}
              </p>
              </div>
            </div>
          </aside>
        </div>

        {/* Phones: the one action, always under the thumb. */}
        <div className="fixed inset-x-0 bottom-0 z-20 border-t-[1.5px] border-ink bg-paper/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm lg:hidden">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            {back ? (
              <button type="button" onClick={() => goTo(back, 'push')} className={cx(buttonClass('secondary'), 'w-11 shrink-0 px-0')} aria-label="Back">
                ←
              </button>
            ) : null}
            <span className="sheet-label min-w-0 flex-1 truncate text-ink-muted">{summary.short}</span>
            <button type="button" onClick={() => advance()} disabled={!canContinue || pending} className={cx(buttonClass('accent'), ACCENT_WAITING, 'shrink-0 px-6')} data-testid="setup-continue">
              {pending ? 'Saving…' : nextStep(step, draft) === null ? 'Start' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

/**
 * Starting points for somebody facing an empty field — one of each *kind* of
 * answer the field accepts. They are words, not records: pressing one types it,
 * and nothing downstream knows it came from a chip.
 */
const DESTINATION_EXAMPLES = [
  { kind: 'City', text: 'Lisbon' },
  { kind: 'Country', text: 'Japan' },
  { kind: 'Region', text: 'The Dolomites' },
  { kind: 'Island', text: 'Iceland' },
  { kind: 'Road trip', text: 'Scottish Highlands' },
  { kind: 'Park', text: 'Yosemite' },
] as const;

function WhereStep({
  intent,
  draft,
  headingRef,
  error,
  onChange,
  onSubmit,
  onSettle,
}: {
  intent: 'new' | 'has_plan';
  draft: SetupDraft;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  error?: string;
  onChange: (patch: Partial<SetupDraft>) => void;
  onSubmit: () => void;
  /** The traveller has stopped typing and left the field: place what they wrote, once. */
  onSettle: (text: string) => void;
}) {
  const typed = draft.destinationText.trim();
  const showExamples = typed.length === 0 || DESTINATION_EXAMPLES.some((example) => example.text === typed);
  return (
    <div>
      <StepHeading number={1} kicker={intent === 'has_plan' ? 'A plan you already have' : 'New trip · where'} headingRef={headingRef}>
        {intent === 'has_plan' ? 'Where is the plan taking you?' : 'Where are you thinking?'}
      </StepHeading>
      <div className="mt-8 max-w-2xl">
        <DestinationField
          value={draft.destinationText}
          selectedId={draft.destinationEntryId}
          onTextChange={(text) => onChange({ destinationText: text, destinationEntryId: null, destinationCenter: null, destinationBounds: null, destinationFeatureType: null, destinationSemanticType: null, destinationScale: null, destinationExtentSource: null, destinationGateways: [] })}
          onSelect={(suggestion: DestinationSuggestionView) =>
            onChange({
              destinationText: suggestion.displayName,
              destinationEntryId: suggestion.id,
              destinationCenter: suggestion.center ?? null,
              destinationBounds: suggestion.bounds ?? null,
              destinationFeatureType: suggestion.featureType,
              destinationSemanticType: null,
              destinationScale: null,
              destinationExtentSource: suggestion.bounds ? 'published' : null,
              destinationGateways: [],
            })
          }
          onSubmit={onSubmit}
          onSettle={onSettle}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
      {/*
        Examples, not instructions. They widen what somebody thinks they are
        allowed to type — a country and a borderless region are both fine — and
        a press fills the field exactly as typing would: the words are placed
        the same way, by the same lookup, when the traveller moves on. They step
        aside once the field holds something of the traveller's own.
      */}
      {showExamples ? (
        <div className="mt-8 max-w-2xl" data-testid="destination-examples">
          <p className="text-sm text-ink-muted">A city, a whole country, a region with no borders — or try one of these:</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {DESTINATION_EXAMPLES.map((example, index) => {
              const on = typed === example.text;
              return (
                <li key={example.text} className="fade-up" style={{ '--d': `${80 + index * 45}ms` } as React.CSSProperties}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ destinationText: example.text, destinationEntryId: null, destinationCenter: null, destinationBounds: null, destinationFeatureType: null, destinationSemanticType: null, destinationScale: null, destinationExtentSource: null, destinationGateways: [] });
                      onSettle(example.text);
                    }}
                    aria-pressed={on}
                    className={cx(
                      'pressable group inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm transition-[background-color,border-color,color] duration-[var(--motion-fast)]',
                      on ? 'border-ink bg-ink text-paper' : 'border-ink/20 bg-paper-raised/70 text-ink hover:border-ink/50 hover:bg-paper-raised',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine',
                    )}
                    data-testid={`destination-example-${index}`}
                  >
                    <span aria-hidden="true" className={cx('font-mono text-[10px] tracking-[0.08em] uppercase', on ? 'text-flare' : 'text-ink-faint group-hover:text-accent')}>
                      {example.kind}
                    </span>
                    {example.text}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

const NIGHT_CHIPS = [2, 3, 4, 5, 6, 7, 10, 14];

function NightsStep({
  draft,
  headingRef,
  onChange,
  onSubmit,
}: {
  draft: SetupDraft;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onChange: (patch: Partial<SetupDraft>) => void;
  onSubmit: () => void;
}) {
  const nights = draft.nights;
  return (
    <div>
      <StepHeading number={3} kicker="The trip · how long" headingRef={headingRef}>
        How many nights do you have?
      </StepHeading>

      {/* Survey Atlas — the nights as one scale of figures sharing their borders; the chosen one set in ink. */}
      <div className="ob-grid mt-8 grid-cols-4 sm:grid-cols-8" role="group" aria-label="Nights">
        {NIGHT_CHIPS.map((value) => {
          const on = nights === value;
          return (
            <button key={value} type="button" aria-pressed={on} onClick={() => onChange({ nights: value, wantsLengthHelp: false })} className={cx('ob-cell min-h-20 items-center text-center', FOCUS_RING)} data-on={on ? 'true' : 'false'} data-testid={`nights-${value}`}>
              <span className="ob-cell-big type-figure">{value}</span>
              <span className="coordbar text-[9.5px] opacity-70">{value === 1 ? 'night' : 'nights'}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-3">
        <label className="flex items-end gap-3">
          <span className="sheet-label pb-3 text-ink-muted">Another number</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Nights"
            value={nights === null ? '' : String(nights)}
            onChange={(event) => {
              const digits = event.target.value.replace(/[^0-9]/g, '').slice(0, 2);
              onChange({ nights: digits === '' ? null : Math.max(1, Math.min(30, Number(digits))), wantsLengthHelp: false });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && nights !== null) onSubmit();
            }}
            className="ob-underline type-figure w-20 text-center"
          />
        </label>
        {nights !== null ? (
          <p className="coordbar pb-3 text-ink-muted" data-testid="nights-derived">
            {nights} {nights === 1 ? 'night' : 'nights'} · {nights + 1} days on the ground
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onChange({ wantsLengthHelp: !draft.wantsLengthHelp })}
        aria-pressed={draft.wantsLengthHelp}
        className={cx('ob-tag mt-8', FOCUS_RING)}
        data-on={draft.wantsLengthHelp ? 'true' : 'false'}
        data-testid="nights-recommend"
      >
        <span aria-hidden="true" className="ob-tag-box" />
        I am not sure — tell me how long this deserves
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

const PARTY_SHAPES = [
  { value: 'solo', label: 'Just me', adults: 1, children: 0 },
  { value: 'couple', label: 'Two of us', adults: 2, children: 0 },
  { value: 'friends', label: 'A group of friends', adults: 4, children: 0 },
  { value: 'family', label: 'Family with children', adults: 2, children: 2 },
  { value: 'other', label: 'Something else', adults: 2, children: 0 },
] as const;

function WhoStep({ draft, headingRef, onChange }: { draft: SetupDraft; headingRef: React.RefObject<HTMLHeadingElement | null>; onChange: (patch: Partial<SetupDraft>) => void }) {
  const shape = draft.partyShape;
  return (
    <div>
      <StepHeading number={4} kicker="The trip · who" headingRef={headingRef}>
        Who is going?
      </StepHeading>

      <div className="ob-rows mt-8" role="radiogroup" aria-label="Who is going" onKeyDown={onRadioGroupKeys}>
        {PARTY_SHAPES.map((option, index) => {
          const on = shape === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={rovingTabIndex(on, index, Boolean(shape))}
              onClick={() => onChange({ partyShape: option.value, adults: option.adults, children: option.children })}
              className="ob-row w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
              data-on={on ? 'true' : 'false'}
              data-testid={`party-${option.value}`}
            >
              <span aria-hidden="true" className="ob-letter">
                {String.fromCharCode(65 + index)}
              </span>
              <span className="ob-row-label">{option.label}</span>
              <span className="ob-row-why type-figure">{option.value === 'other' ? 'set the counts' : `${option.adults} ${option.adults === 1 ? 'adult' : 'adults'}${option.children ? ` · ${option.children} children` : ''}`}</span>
            </button>
          );
        })}
      </div>

      {shape ? (
        <div className="rise mt-8 flex flex-wrap items-end gap-8">
          <Counter label="Adults" min={1} value={draft.adults} onChange={(adults) => onChange({ adults })} />
          <Counter label="Children" min={0} value={draft.children} onChange={(children) => onChange({ children })} />
          <p className="coordbar pb-3 text-ink-muted">{describeParty(draft)}</p>
        </div>
      ) : null}

      {shape ? (
        <fieldset className="rise mt-8 border-t border-ink/20 pt-3">
          <legend className="sheet-label float-left mb-3 w-full text-ink-muted">Anything that changes what a day can hold?</legend>
          <div className="clear-both flex flex-wrap gap-2">
            {TRAVELER_NEEDS.map((need) => {
              const on = draft.travelerNeeds.includes(need);
              return (
                <label key={need} className="ob-tag" data-on={on ? 'true' : 'false'}>
                  <span aria-hidden="true" className="ob-tag-box" />
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onChange({ travelerNeeds: on ? draft.travelerNeeds.filter((entry) => entry !== need) : [...draft.travelerNeeds, need] })}
                    className="sr-only"
                  />
                  {TRAVELER_NEED_LABELS[need]}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function Counter({ label, min, value, onChange }: { label: string; min: number; value: number; onChange: (value: number) => void }) {
  const clamp = (next: number) => Math.max(min, Math.min(12, next));
  return (
    <div>
      <p className="sheet-label text-ink-muted">{label}</p>
      <div className="mt-1.5 flex items-stretch border-[1.5px] border-ink">
        <button type="button" aria-label={`One fewer ${label.toLowerCase().replace(/s$/, '')}`} disabled={value <= min} onClick={() => onChange(clamp(value - 1))} className={cx('flex h-12 w-12 items-center justify-center text-xl text-ink hover:bg-ink/5 disabled:opacity-35', FOCUS_RING)}>
          −
        </button>
        <span className="ob-cell-big type-figure flex w-14 items-center justify-center border-x border-ink/35 text-ink" aria-live="polite" data-testid={`count-${label.toLowerCase()}`}>
          {value}
        </span>
        <button type="button" aria-label={`One more ${label.toLowerCase().replace(/s$/, '')}`} disabled={value >= 12} onClick={() => onChange(clamp(value + 1))} className={cx('flex h-12 w-12 items-center justify-center text-xl text-ink hover:bg-ink/5 disabled:opacity-35', FOCUS_RING)}>
          +
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anything already fixed
// ---------------------------------------------------------------------------

function FixedStep({ draft, headingRef, onChange, hasPlan }: { draft: SetupDraft; headingRef: React.RefObject<HTMLHeadingElement | null>; onChange: (patch: Partial<SetupDraft>) => void; hasPlan: boolean }) {
  return (
    <div>
      <StepHeading number={5} kicker="The trip · anything fixed" headingRef={headingRef}>
        Anything already booked or fixed?
      </StepHeading>
      <p className="mt-3 max-w-[52ch] text-base text-ink-muted">Only what the plan has to work around. How you like to travel comes next.</p>

      <div className="mt-8 max-w-2xl space-y-8">
        {/*
          V1 — "I already have a plan": the plan itself, in the traveller's order.
          Its places become their own must-dos, and the board checks the plan as
          written before anything is built.
        */}
        {hasPlan || draft.existingPlan ? (
          <div>
            <label htmlFor="setup-existing-plan" className="sheet-label block text-ink-muted">
              Your plan, one day per line
            </label>
            <textarea
              id="setup-existing-plan"
              data-testid="setup-existing-plan"
              rows={5}
              maxLength={2000}
              value={draft.existingPlan}
              onChange={(event) => onChange({ existingPlan: event.target.value })}
              placeholder={'Day 1: the old town, the castle, a market for lunch\nDay 2: a day trip to the lakes'}
              className="ob-lines mt-2"
            />
            <p className="mt-1.5 type-small text-ink-faint">We check it against real travel times, your pace and the forecast, and keep every place you name.</p>
          </div>
        ) : null}
        <div>
          <label htmlFor="setup-fixed" className="sheet-label block text-ink-muted">
            Booked, fixed, or would regret missing
          </label>
          <textarea id="setup-fixed" rows={3} maxLength={600} value={draft.mustDo} onChange={(event) => onChange({ mustDo: event.target.value })} placeholder="A hotel you have booked, a tour on a set day, one place you must see." className="ob-lines mt-2" />
        </div>
        <div>
          <label htmlFor="setup-avoid" className="sheet-label block text-ink-muted">
            Anything you would rather not do
          </label>
          <textarea id="setup-avoid" rows={2} maxLength={600} value={draft.avoid} onChange={(event) => onChange({ avoid: event.target.value })} className="ob-lines mt-2" />
        </div>

        {/*
          MVP V3, Stage 9 — arrival and departure are not settings. Asked only by
          somebody who says a flight is booked; for everyone else the plan uses
          an estimate and says so.
        */}
        <div className="border-y border-ink/20">
          <button type="button" onClick={() => onChange({ knowsFlightTimes: !draft.knowsFlightTimes })} aria-expanded={draft.knowsFlightTimes} className={cx('flex min-h-14 w-full items-center justify-between gap-3 text-left', FOCUS_RING)} data-testid="setup-flight-times">
            <span className="font-display text-lg text-ink">I know when I land and when I leave</span>
            <span aria-hidden="true" className="font-mono text-lg text-ink-muted">
              {draft.knowsFlightTimes ? '−' : '+'}
            </span>
          </button>
          {draft.knowsFlightTimes ? (
            <div className="slide-down grid gap-5 pb-4 sm:grid-cols-2">
              <label className="block">
                <span className="sheet-label text-ink-muted">Landing</span>
                <select value={draft.arrival} onChange={(event) => onChange({ arrival: event.target.value as SetupDraft['arrival'] })} className="ob-underline mt-1 text-lg">
                  {ARRIVAL_PRECISIONS.map((precision) => (
                    <option key={precision} value={precision}>
                      {ARRIVAL_PRECISION_LABELS[precision]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="sheet-label text-ink-muted">Leaving</span>
                <select value={draft.departure} onChange={(event) => onChange({ departure: event.target.value as SetupDraft['departure'] })} className="ob-underline mt-1 text-lg">
                  {ARRIVAL_PRECISIONS.map((precision) => (
                    <option key={precision} value={precision}>
                      {ARRIVAL_PRECISION_LABELS[precision]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <p className="pb-3 type-small text-ink-faint">Otherwise we plan an afternoon arrival and a morning departure, and label both as estimates.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export { stepIsRelevant };
