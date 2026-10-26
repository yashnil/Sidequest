'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  DESTINATION_TRAIT_LABELS,
  FUNCTIONAL_NEED_LABELS,
  INTERVIEW_MODULE_LABELS,
  answerQuestion,
  chipLabel,
  classifyPreferences,
  applySmartDefaults,
  assessSufficiency,
  buildTravelerProfile,
  decideQuestion,
  describeAnswer,
  interviewAnalytics,
  markAsked,
  markCarried,
  planInterview,
  questionElaborates,
  questionnaireContextOf,
  reviewShapers,
  type ReviewLedger,
  reviewLedger,
  skipQuestion,
  withMode,
  withPosition,
  withScreening,
  type HardConstraint,
  type Interest,
  type InterviewContext,
  type InterviewMode,
  type InterviewOption,
  type InterviewPlan,
  type InterpretationSet,
  type PlannedQuestion,
  type QuestionDefinition,
  type QuestionnaireAnswers,
  type QuestionnaireContext,
  type ReviewEntry,
  type ReviewGlanceGroup,
  type SmartDefault,
  materialConflicts,
} from '@sidequest/core';
import { Badge, ErrorNote, FOCUS_RING, buttonClass, cx } from './ui';

/** V7 §5 — one reading of a note, as the chip the traveller saw. */
type NoteReading = { id: string; kind: string; value: string; label: string; strength: string; accepted: boolean };
import { InterpretationPanel } from './InterpretationPanel';
import { formatMinutes, mobilityReconciliation } from '@/lib/interview/reconciliation';
import { Glyph } from './interview/glyphs';
import {
  BudgetAxis,
  ChipGroup,
  DietaryControl,
  HardLimitsControl,
  InterestGrid,
  NamesSpace,
  OptionCards,
  RangeMapChoice,
  RhythmChoice,
  RoleMeter, RoleMatrix,
  SpectrumChoice,
  TransportChoice,
  WritingSpace,
} from './interview/patterns';
import { partyLine, sketchFor } from './interview/TripSketch';
import { ContextPlate } from './interview/ContextPlate';
import { QUESTION_S, QUESTION_VARIANTS, timing, type Direction } from './interview/choreography';
import { isHardLine, reviewFacts, understandingChips } from './interview/review-brief';
import type { DestinationGeometry } from './interview/DestinationMap';
import { GenerationScreen } from './interview/GenerationScreen';
import { ReviewTimingCard } from './interview/ReviewTimingCard';
import { callAction, newBuildKey } from './client-action';
import type { BuildRunView } from '@/lib/planning/build-run-view';
import type { TimingWindowView } from '@/app/(product)/trips/new/timing-actions';
import type { MapBasemap } from './map-adapter';
import { StagePath, stageOf } from './interview/StagePath';
import { ACCENT_WAITING, QuestionNumeral } from './setup/StepHeading';
import {
  completeQuestionnaireAction,
  exploreExperiencesAction,
  saveDraftAction,
  startBuildAction,
  type CompletionDestination,
} from '@/app/(product)/trips/[id]/questionnaire/actions';

/**
 * THE INTERVIEW, AS AN ATLAS PLATE.
 *
 * Left: one decision at a time, presented in the pattern its cognitive task
 * deserves (see `interview/patterns.tsx`). Right, on a wide screen: the
 * living trip sketch, redrawn from the answers as they land; on a phone, the
 * same sketch as a sheet under the question. Progress is a path of five
 * stages, not a count. "Decide for me" hands a question to Sidequest and the
 * next screen opens with Sidequest's call — the answer and the reason — with
 * a Change control beside it.
 */

export const REVIEW_POSITION = 'review';
export const UNDERSTANDING_POSITION = 'understanding';

export function InterviewWizard({
  tripId,
  context,
  region,
  initialAnswers,
  interpretation,
  durationAdvice = null,
  boardAvailable,
  scanUnavailable = null,
  researchDoor = false,
  fixtureMode = false,
  geometry = null,
  tiles = null,
  timingOpen = false,
  revision = null,
  activeBuild = null,
  acceptedWindow = null,
  buildUnavailable = null,
}: {
  tripId: string;
  context: InterviewContext;
  /** PRODUCTION UI V1 — the resolved destination's position and extent, for the real map in the rail. */
  geometry?: DestinationGeometry | null;
  tiles?: MapBasemap | null;
  region?: QuestionnaireContext['region'];
  initialAnswers: QuestionnaireAnswers;
  interpretation?: { set: InterpretationSet; mustDo: string; avoid: string };
  durationAdvice?: string | null;
  boardAvailable: boolean;
  /**
   * V1 convergence — set when no Discovery scan can run on this deployment
   * right now, so "Find places for my trip" is disabled with this sentence
   * beside it rather than failing after the press.
   */
  scanUnavailable?: { heading: string; message: string } | null;
  /** V1 convergence — the old research path's link, shown only when the page was opened with `?research=1`. */
  researchDoor?: boolean;
  fixtureMode?: boolean;
  /** V7 §7 — true while the traveller has asked Sidequest to choose the dates and has not accepted a window. */
  timingOpen?: boolean;
  /** V8 — the stored answers' revision at render; every save presents it and receives the next. */
  revision?: string | null;
  /** V8 — a run that is live, failed or lost on this trip, so the review can point at it instead of starting another. */
  activeBuild?: BuildRunView | null;
  /** V8 — the window the traveller accepted, read from the row, so a reload shows the dates they chose. */
  acceptedWindow?: TimingWindowView | null;
  /**
   * V1 convergence — set when `buildPreflight` says no build can run on this
   * deployment right now (no composer, a refused fixture switch, a rejected key,
   * the day's allowance spent). The Build button is disabled with this sentence
   * beside it, so nobody finishes the interview to discover it at the end.
   */
  buildUnavailable?: { heading: string; message: string } | null;
}) {
  const router = useRouter();
  const now = useMemo(() => new Date(), []);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(() => {
    const screened = withScreening(initialAnswers, context.destination);
    return markCarried(screened, context, planInterview({ ctx: context, answers: screened }), now);
  });
  const [position, setPosition] = useState<string>(initialAnswers.interview?.position ?? UNDERSTANDING_POSITION);
  const [error, setError] = useState<string | null>(null);
  /** COMPOSITION RELIABILITY — a build that failed keeps the answers and waits for an explicit Retry; nothing retries on its own. */
  const [buildFailure, setBuildFailure] = useState<{ answers: QuestionnaireAnswers; message: string; heading?: string; retryable: boolean } | null>(null);
  const [call, setCall] = useState<{ id: string; label: string; value: string; decision: SmartDefault } | null>(null);
  const [pending, startTransition] = useTransition();
  const [panelOpen, setPanelOpen] = useState(position === UNDERSTANDING_POSITION);
  /* V8 — which way the next question enters. Back is the only move that goes left. */
  const [direction, setDirection] = useState<Direction>('forward');
  const reduced = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /*
   * V8 — the revision this client holds. Every save presents it; a save that
   * comes back `stale` means the stored answers moved on without this page
   * (another tab, or a page rendered before they were given), and the only
   * honest move is to reload rather than overwrite.
   */
  const revisionRef = useRef<string | null>(revision);
  const [stale, setStale] = useState(false);

  const mode: InterviewMode = answers.interview?.mode ?? 'normal';
  const plan = useMemo(() => planInterview({ ctx: context, answers, mode }), [context, answers, mode]);
  /*
   * MVP V3, Stage 17 — recomputed with the plan, after every answer, because
   * one answer can resolve a critical dimension and make the rest optional.
   */
  const enoughToBuild = useMemo(() => assessSufficiency(plan).kind === 'sufficient', [plan]);
  const shown = plan.shown;
  const current: PlannedQuestion | null =
    position === UNDERSTANDING_POSITION || position === REVIEW_POSITION ? null : (plan.questions.find((q) => q.id === position) ?? null);
  const shownIndex = current ? shown.indexOf(current.id) : -1;
  const qContext = questionnaireContextOf(context, region);

  function go(target: string, toSave: QuestionnaireAnswers = answers, towards: Direction = 'forward') {
    setError(null);
    setDirection(towards);
    const saved = withPosition(toSave, target);
    startTransition(async () => {
      const outcome = await callAction(() => saveDraftAction(tripId, saved, undefined, revisionRef.current));
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      const result = outcome.value;
      if (!result.ok) {
        if (result.stale) setStale(true);
        setError(result.error ?? 'We could not save your progress.');
        return;
      }
      if (result.revision !== undefined) revisionRef.current = result.revision;
      setAnswers(saved);
      setPosition(target);
      setPanelOpen(false);
    });
  }

  function nextAfter(id: string | null, fromAnswers: QuestionnaireAnswers): string {
    const nextPlan = planInterview({ ctx: context, answers: fromAnswers, mode: fromAnswers.interview?.mode ?? mode });
    const list = nextPlan.shown;
    if (id === null) return list[0] ?? REVIEW_POSITION;
    const index = list.indexOf(id);
    if (index < 0) return list.find((entry) => nextPlan.questions.find((q) => q.id === entry)?.status === 'open') ?? REVIEW_POSITION;
    return list[index + 1] ?? REVIEW_POSITION;
  }

  function previousBefore(id: string | null): string {
    if (id === null) return UNDERSTANDING_POSITION;
    const index = shown.indexOf(id);
    if (index <= 0) return UNDERSTANDING_POSITION;
    return shown[index - 1] ?? UNDERSTANDING_POSITION;
  }

  function start() {
    const first = withMode(markAsked(answers, shown[0] ?? ''), mode === 'fast' ? 'normal' : mode);
    setCall(null);
    go(nextAfter(null, first), first);
  }

  function answer(value: unknown, note?: string, readings?: NoteReading[]) {
    if (!current) return;
    const next = answerQuestion({ answers, ctx: context, question: current.definition, value, now: new Date(), ...(note ? { note } : {}), ...(note && readings ? { readings } : {}), ...(region ? { region } : {}) });
    setCall(null);
    go(nextAfter(current.id, next), next);
  }

  function decide() {
    if (!current) return;
    const { answers: next, decision } = decideQuestion({ answers, ctx: context, question: current.definition, now: new Date(), ...(region ? { region } : {}) });
    setCall({ id: current.id, label: current.definition.prompt(context, next).replace(/[:?]$/, ''), value: describeAnswer(current.definition, context, next), decision });
    go(nextAfter(current.id, next), next);
  }

  function skip() {
    if (!current) return;
    const next = skipQuestion({ answers, ctx: context, question: current.definition, now: new Date(), ...(region ? { region } : {}) });
    setCall(null);
    go(nextAfter(current.id, next), next);
  }

  function back() {
    setCall(null);
    go(previousBefore(current ? current.id : position === REVIEW_POSITION ? (shown[shown.length - 1] ?? null) : null), answers, 'back');
  }

  function jumpTo(id: string) {
    const target = plan.questions.find((q) => q.id === id);
    if (!target) return;
    const next = target.tier === 'fine_tune' && mode !== 'deep' ? withMode(answers, 'deep') : answers;
    setCall(null);
    /* A jump to something already answered reads as going back to it. */
    const towards: Direction = current && shown.indexOf(id) < shown.indexOf(current.id) ? 'back' : position === REVIEW_POSITION ? 'back' : 'forward';
    go(id, markAsked(next, id), towards);
  }

  /**
   * MVP V3, Stage 40 — back to a finished stage.
   *
   * The first question of that stage in the *current* plan, so a traveller who
   * changed an answer that unlocked new questions lands somewhere that exists
   * rather than on a remembered id.
   */
  function jumpToStage(target: ReturnType<typeof stageOf>) {
    const first = shown.find((id) => stageOf(id) === target);
    if (first) jumpTo(first);
    else if (target === 'trip') go(UNDERSTANDING_POSITION);
  }

  function personalizeMore() {
    const next = withMode(answers, 'deep');
    const deepPlan = planInterview({ ctx: context, answers: next, mode: 'deep' });
    const firstOpen = deepPlan.shown.find((id) => deepPlan.questions.find((q) => q.id === id)?.status === 'open');
    setCall(null);
    go(firstOpen ?? REVIEW_POSITION, next);
  }

  /**
   * V8 — ONE PRESS, ONE DURABLE RUN.
   *
   * The press is acknowledged on the spot (the generation screen appears as an
   * overlay before any request returns), the run is recorded on the server
   * under a key minted for this press, and the route moves to
   * `/trips/[id]/build`, which is rendered from that run. A request that dies
   * on the wire is not an exception: the client asks the progress route
   * whether its press landed and follows the run if it did. The same key is
   * reused by a retry of this press, so nothing can compose twice.
   */
  const [building, setBuilding] = useState(false);
  const buildKeyRef = useRef<string | null>(null);
  function build(next: QuestionnaireAnswers) {
    setError(null);
    setBuildFailure(null);
    if (buildUnavailable) {
      /* The preflight already said no: say it again here rather than start a run that cannot succeed. */
      setBuildFailure({ answers: next, message: buildUnavailable.message, heading: buildUnavailable.heading, retryable: false });
      return;
    }
    setBuilding(true);
    buildKeyRef.current ??= newBuildKey();
    const key = buildKeyRef.current;
    const answersToBuild = withPosition(next, REVIEW_POSITION);
    startTransition(async () => {
      const outcome = await callAction(() => startBuildAction(tripId, answersToBuild, key, revisionRef.current));
      if (outcome.ok) {
        const result = outcome.value;
        if (result.ok) {
          if (result.revision !== undefined) revisionRef.current = result.revision;
          router.push(`/trips/${tripId}/build`);
          return;
        }
        setBuilding(false);
        if (result.stale) setStale(true);
        setBuildFailure({ answers: next, message: result.error, ...(result.failure ? { heading: result.failure.heading } : {}), retryable: result.failure?.retryable ?? true });
        return;
      }
      /* The request died on the wire. Did the press land? The run row is the answer, not the request. */
      const landed = await fetch(`/api/trips/${encodeURIComponent(tripId)}/progress`, { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<{ buildKey: string | null; state: string }>) : null))
        .catch(() => null);
      if (landed && landed.buildKey === key) {
        router.push(`/trips/${tripId}/build`);
        return;
      }
      setBuilding(false);
      setBuildFailure({ answers: next, message: outcome.message, retryable: true });
    });
  }

  /**
   * V1 CONVERGENCE — "PLAN WITH SMART DEFAULTS" IS SCAN → PICKS → BUILD.
   *
   * A trip that already has a board builds from it straight away (the planner
   * needs no model call). A trip without one starts the Discovery scan flagged
   * to build the moment the board is ready, and lands on `/discover`, which
   * shows the scan and then follows the build. Only where no scan can run does
   * the press fall back to the model-composed build.
   */
  function planWithDefaults() {
    const { answers: next } = applySmartDefaults({ answers, ctx: context, now: new Date(), ...(region ? { region } : {}) });
    if (boardAvailable || scanUnavailable) {
      build(next);
      return;
    }
    complete(next, 'scan_and_build');
  }

  function finish(destination: CompletionDestination) {
    if (destination === 'build') {
      build(answers);
      return;
    }
    complete(answers, destination);
  }

  /** The old research path, behind `?research=1` only: research runs while the traveller answers. */
  function exploreFirst() {
    setError(null);
    startTransition(async () => {
      const outcome = await callAction(() => exploreExperiencesAction(tripId, withPosition(answers, position)));
      if (!outcome.ok) setError(outcome.message);
      else if (!outcome.value.ok) setError(outcome.value.error ?? 'We could not start exploring just now.');
    });
  }

  /** Save the profile and move on: to the board, or to the scan that will make one. */
  function complete(toSave: QuestionnaireAnswers, destination: Exclude<CompletionDestination, 'build'>) {
    setError(null);
    startTransition(async () => {
      const outcome = await callAction(() => completeQuestionnaireAction(tripId, withPosition(toSave, REVIEW_POSITION), destination));
      if (!outcome.ok) setError(outcome.message);
      else if (!outcome.value.ok) setError(outcome.value.error ?? 'We could not save your profile.');
    });
  }

  /*
   * Focus follows the question only when the position actually changed. A
   * "has this run before" flag was true on React's development replay of the
   * first effect, which focused the review heading on arrival and drew an
   * outline round it for every visitor.
   */
  const shownPosition = useRef<typeof position | null>(null);
  useEffect(() => {
    if (shownPosition.current === null || shownPosition.current === position) {
      shownPosition.current = position;
      return;
    }
    shownPosition.current = position;
    window.scrollTo({ top: 0, left: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [position]);

  const analytics = useMemo(() => interviewAnalytics(context, answers, plan), [context, answers, plan]);
  const stage = stageOf(position === UNDERSTANDING_POSITION ? null : position);
  const inInterview = current !== null;

  /*
   * SURVEY ATLAS — THE MAP ANSWERS WHILE THE TRAVELLER IS STILL CHOOSING.
   *
   * The plate beside the question is drawn from the answers as they would
   * stand with the option on screen applied: the ring grows as the reach scale
   * moves, the lines change dash as the transport rows do. Nothing is saved
   * until Continue — this is `answerQuestion`, a pure function, run for the
   * picture only.
   */
  const [preview, setPreview] = useState<{ id: string; value: unknown } | null>(null);
  const plateAnswers = useMemo(() => {
    if (!current || !preview || preview.id !== current.id) return answers;
    try {
      return answerQuestion({ answers, ctx: context, question: current.definition, value: preview.value, now: new Date(), ...(region ? { region } : {}) });
    } catch {
      return answers;
    }
  }, [answers, current, preview, context, region]);
  const plateAnswerText = useMemo(() => {
    if (!current) return null;
    const considered = (preview !== null && preview.id === current.id) || current.status !== 'open';
    if (!considered) return null;
    try {
      return describeAnswer(current.definition, context, plateAnswers);
    } catch {
      return null;
    }
  }, [current, preview, context, plateAnswers]);

  return (
    <div className="survey min-h-[calc(100dvh-var(--chrome-height))]" data-testid="interview" data-position={position} data-mode={mode}>
      <div className="mx-auto max-w-7xl px-5 pb-16 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3 pt-5">
          <p className="sheet-label text-ink-muted">
            Trip survey <span className="text-ink-faint">·</span> {context.destination.name}
          </p>
          {fixtureMode ? (
            <span className="sheet-label inline-flex items-center gap-2 border border-dashed border-amber/60 px-2.5 py-1 text-amber" data-testid="fixture-planning-badge">
              Fixture planning data — not the live model
            </span>
          ) : null}
        </div>

        {interpretation ? (
          <div className="mt-4">
            <InterpretationPanel tripId={tripId} interpretation={interpretation.set} mustDo={interpretation.mustDo} avoid={interpretation.avoid} collapsed={!panelOpen} onExpand={() => setPanelOpen(true)} />
          </div>
        ) : null}

        {position === UNDERSTANDING_POSITION ? (
          <UnderstandingScreen context={context} answers={answers} headingRef={headingRef} questionCount={shown.length} pending={pending} onStart={start} onDefaults={planWithDefaults} geometry={geometry} tiles={tiles} {...(researchDoor ? { onExplore: exploreFirst } : {})} />
        ) : null}

        {inInterview ? (
          /*
           * One question at a time, with the map that answers beside it. On a
           * phone the plate is a slim band above the question (same element,
           * reordered), the controls run full width, and the action bar sits
           * at the bottom under the thumb.
           */
          <div className="mt-4 grid gap-6 lg:mt-6 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-14">
            <div className="relative order-2 min-w-0 lg:order-1">
              {/*
                V8 — one question replaces another with a directional slide; the
                outgoing one goes at once. ≤ 260 ms; nothing under reduced motion.
              */}
              <AnimatePresence initial={false} mode="wait" custom={direction}>
                {current ? (
                  <motion.div key={current.id} custom={direction} variants={QUESTION_VARIANTS} initial="initial" animate="animate" exit="exit" transition={timing(QUESTION_S, reduced)} className="min-w-0">
                    <QuestionScreen
                      question={current}
                      index={shownIndex}
                      total={shown.length}
                      stage={stage}
                      context={context}
                      answers={answers}
                      headingRef={headingRef}
                      pending={pending}
                      call={call}
                      onCallChange={(id) => jumpTo(id)}
                      onJumpStage={jumpToStage}
                      onAnswer={answer}
                      onDecide={decide}
                      onSkip={skip}
                      onBack={back}
                      enough={enoughToBuild}
                      onEnough={planWithDefaults}
                      onDraft={(value) => setPreview({ id: current.id, value })}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
            <div className="order-1 min-w-0 lg:order-2">
              <div className="lg:sticky lg:top-[calc(var(--chrome-height)+1.25rem)]">
                <ContextPlate ctx={context} answers={plateAnswers} geometry={geometry} tiles={tiles} questionId={current?.id ?? null} answerText={plateAnswerText} />
              </div>
            </div>
          </div>
        ) : null}

        {position === REVIEW_POSITION ? (
          <ReviewScreen
            tripId={tripId}
            geometry={geometry}
            tiles={tiles}
            context={context}
            qContext={qContext}
            answers={answers}
            plan={plan}
            headingRef={headingRef}
            durationAdvice={durationAdvice}
            unresolved={interpretation?.set.unresolved ?? []}
            boardAvailable={boardAvailable}
            scanUnavailable={scanUnavailable}
            pending={pending}
            analytics={analytics}
            onJump={jumpTo}
            onBack={back}
            onPersonalize={personalizeMore}
            onFinish={finish}
            onUpdate={(patch) => setAnswers((curr) => withPosition({ ...curr, ...patch }, REVIEW_POSITION))}
            timingOpen={timingOpen}
            activeBuild={activeBuild}
            acceptedWindow={acceptedWindow}
            buildUnavailable={buildUnavailable}
          />
        ) : null}

        {building && !buildFailure ? <GenerationScreen tripId={tripId} destination={context.destination.name} geometry={geometry} tiles={tiles} variant="overlay" /> : null}
        {stale ? (
          <section className="mt-8 border-t-[1.5px] border-l-[3px] border-amber bg-amber-soft p-5" data-testid="answers-stale" role="alert">
            <h2 className="font-display text-xl text-ink">These answers are behind the saved ones.</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink">{error}</p>
            <div className="mt-4">
              <button type="button" className={buttonClass('primary')} onClick={() => router.refresh()} data-testid="answers-reload">
                Reload my answers
              </button>
            </div>
          </section>
        ) : null}
        {buildFailure && !stale ? (
          <section className="mt-8 border-t-[1.5px] border-ink bg-paper-raised p-6" data-testid="build-failure" role="alert" aria-live="polite">
            <h2 className="font-display text-xl text-ink">{buildFailure.heading ?? 'Sidequest couldn’t start this build.'}</h2>
            {/* MVP V3, Stage 25 — say what actually happened: the server's reason, then that nothing was lost. */}
            <p className="mt-2 text-sm leading-relaxed text-ink" data-testid="build-failure-reason">{buildFailure.message}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              {buildFailure.retryable ? 'Your trip profile is saved. Nothing was composed, so trying again costs nothing you have not already chosen to spend.' : 'Your trip profile is saved. Nothing was composed.'}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              {buildFailure.retryable ? (
                <button type="button" className={buttonClass('primary')} onClick={() => build(buildFailure.answers)} disabled={pending} data-testid="retry-draft">
                  {pending ? 'Starting…' : 'Try build again'}
                </button>
              ) : null}
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => {
                  setBuildFailure(null);
                  go(REVIEW_POSITION, buildFailure.answers);
                }}
                disabled={pending}
                data-testid="back-to-preferences"
              >
                Return to review
              </button>
            </div>
          </section>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Understanding
// ---------------------------------------------------------------------------

function UnderstandingScreen({
  context,
  answers,
  headingRef,
  questionCount,
  pending,
  onStart,
  onDefaults,
  onExplore,
  geometry = null,
  tiles = null,
}: {
  context: InterviewContext;
  answers: QuestionnaireAnswers;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  questionCount: number;
  pending: boolean;
  onStart: () => void;
  onDefaults: () => void;
  onExplore?: () => void;
  geometry?: DestinationGeometry | null;
  tiles?: MapBasemap | null;
}) {
  const d = context.destination;
  /* V8 — short facts only; the assumption is set once, as the sentence below, never also as a chip. */
  const stamps = understandingChips(d.understanding.slice(1), d.assumption?.sentence);
  return (
    <section className="mt-4 grid gap-6 lg:mt-6 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-14" data-testid="interview-understanding">
      <div className="order-2 min-w-0 lg:order-1 lg:pt-10">
        <p className="sheet-label text-accent">{[d.scaleLabel ?? 'Your destination', `${d.nights} ${d.nights === 1 ? 'night' : 'nights'}`].join(' · ')}</p>
        <h1 ref={headingRef} tabIndex={-1} className="display-stage mt-4 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
          <span className="mask-rise pb-[0.12em]">
            <span>{d.name}</span>
          </span>
        </h1>
        {stamps.length > 0 ? (
          <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1" aria-label="What Sidequest read about this destination">
            {stamps.map((line) => (
              <li key={line} className="sheet-label flex items-center gap-2 text-ink">
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 bg-ink" />
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="fade-up mt-8 max-w-[34ch] border-t-[1.5px] border-ink pt-5 font-display text-2xl leading-snug text-ink sm:text-[1.75rem]" style={{ '--d': '180ms' } as React.CSSProperties} data-testid="interview-assumption">
          {/*
            QUALITY V1 — research is optional, so it is never an excuse: when no
            destination reading exists, nothing has been assumed.
          */}
          {d.assumption
            ? d.assumption.sentence
            : `Sidequest has assumed nothing about ${d.name} yet — your answers are what will shape this trip.`}
        </p>
        <p className="sheet-label mt-4 text-ink-muted">
          {String(questionCount).padStart(2, '0')} {questionCount === 1 ? 'question' : 'questions'} · about a minute · hand any of them to Sidequest
        </p>
        {d.traits.length > 0 ? (
          <details className="mt-2 text-sm text-ink-muted">
            <summary className={cx('inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4', FOCUS_RING)}>Why we think so</summary>
            <ul className="ruled mt-1 border-t border-ink/15">
              {d.traits.map((trait) => (
                <li key={trait} className="py-1.5">
                  <span className="font-medium text-ink">{DESTINATION_TRAIT_LABELS[trait]}</span> — {d.basis[trait]}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onStart} disabled={pending} className={buttonClass('accent', 'lg')} data-testid="interview-start">
            {pending ? 'Saving…' : 'Start the interview'}
            <span aria-hidden="true">→</span>
          </button>
          <button type="button" onClick={onDefaults} disabled={pending} className={buttonClass('secondary', 'lg')} data-testid="interview-smart-defaults">
            <Glyph id="compass" className="h-4 w-4" />
            Plan with smart defaults
          </button>
        </div>
        {onExplore ? (
          <p className="mt-4 text-sm text-ink-muted">
            <button type="button" onClick={onExplore} disabled={pending} className={cx('text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-explore">
              Explore experiences first
            </button>
            {' '}— Sidequest researches the area while you answer, and you choose from a board before building.
          </p>
        ) : null}
      </div>
      <div className="order-1 min-w-0 lg:order-2">
        <ContextPlate ctx={context} answers={answers} geometry={geometry} tiles={tiles} notes={false} size="portrait" />
        <p className="coordbar mt-2 hidden text-ink-muted lg:block">The map redraws as you answer</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

function QuestionScreen({
  question,
  index,
  total,
  stage,
  context,
  answers,
  headingRef,
  pending,
  call,
  onCallChange,
  onJumpStage,
  onAnswer,
  onDecide,
  onSkip,
  onBack,
  enough,
  onEnough,
  onDraft,
}: {
  question: PlannedQuestion;
  index: number;
  total: number;
  stage: ReturnType<typeof stageOf>;
  context: InterviewContext;
  answers: QuestionnaireAnswers;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  pending: boolean;
  call: { id: string; label: string; value: string; decision: SmartDefault } | null;
  onCallChange: (id: string) => void;
  /** MVP V3 — a finished stage on the path is a way back to its first question. */
  onJumpStage: (stage: ReturnType<typeof stageOf>) => void;
  onAnswer: (value: unknown, note?: string, readings?: NoteReading[]) => void;
  onDecide: () => void;
  onSkip: () => void;
  onBack: () => void;
  /**
   * MVP V3, Stages 17 and 22 — WHETHER ANYTHING STILL OPEN DECIDES THIS TRIP.
   *
   * True once no critical dimension is unresolved. The interview stops being a
   * queue to walk to the end of at that moment, which is the whole difference
   * between an interview that ends on *sufficiency* and one that ends on a
   * question count.
   */
  enough: boolean;
  /** Answer everything still open the way Sidequest would, and go to the review. */
  onEnough: () => void;
  /** The answer being considered, so the map beside the question can draw it before it is saved. */
  onDraft: (value: unknown) => void;
}) {
  const def = question.definition;
  const resolved = question.status !== 'open';
  const seededInterests = def.kind === 'interests' ? (def.read(answers) as Interest[]) : [];
  const [draft, setDraft] = useState<unknown>(() => (resolved || def.kind === 'interest_roles' ? def.read(answers) : def.kind === 'interests' && seededInterests.length > 0 ? seededInterests : initialDraft(def)));
  const [touched, setTouched] = useState(resolved || seededInterests.length > 0 || EMPTY_IS_AN_ANSWER.has(def.kind));
  /* MVP V3 — "Something else": the traveller's own line beside the option they chose. */
  const [note, setNote] = useState<string>(() => answers.preferenceNotes?.[def.id] ?? '');
  const [noteOpen, setNoteOpen] = useState(() => Boolean(answers.preferenceNotes?.[def.id]));
  /*
   * V7 §5 — "SIDEQUEST READ THIS AS…", BESIDE THE NOTE.
   *
   * The composer's deterministic phrase table (no model call, no network) reads
   * the sentence as it is typed; each reading is a chip the traveller can switch
   * off, and a switched-off chip stays off when they come back. The note itself
   * is never rewritten — only the readings travel with it.
   */
  const [rejected, setRejected] = useState<Set<string>>(() => new Set((answers.noteReadings?.[def.id] ?? []).filter((r) => !r.accepted).map((r) => r.id)));
  const readings = useMemo<NoteReading[]>(() => {
    if (note.trim().length < 3) return [];
    try {
      const set = classifyPreferences({ mustDo: note });
      return set.chips
        .filter((chip) => chipLabel(chip.target).length > 0)
        .slice(0, 8)
        .map((chip) => ({ id: chip.id, kind: chip.target.kind, value: String(chip.target.value), label: chipLabel(chip.target), strength: chip.strength, accepted: !rejected.has(chip.id) }));
    } catch {
      return [];
    }
  }, [note, rejected]);
  const options = def.options?.(context, answers) ?? [];
  const canContinue = touched && draftIsUsable(def, draft);
  const decidedReason = question.status === 'decided' ? answers.provenance[def.id]?.reason : undefined;
  /*
   * "Sidequest recommends" — shown only when the destination itself is the
   * reason. A `smart_default` is Sidequest's fallback for everybody and gets no
   * badge; a `destination_prior` is a read of this place, and saying so is the
   * difference between a recommendation and a pre-ticked box.
   */
  const recommendation = useMemo(() => {
    try {
      const suggested = def.smartDefault(context, answers);
      return suggested.source === 'destination_prior' && typeof suggested.value === 'string' ? { value: suggested.value, reason: suggested.reason } : null;
    } catch {
      return null;
    }
  }, [def, context, answers]);

  /*
   * V8 — the one-line "why" is inline where it is an instruction (what to pick,
   * how the ticks are read) and behind a "Why we're asking" disclosure where it
   * is a rationale. Both come from `def.why(context)`; nothing is invented.
   */
  const whyInline = WHY_INLINE.has(def.kind);
  const why = def.why(context);

  const number = String(Math.min(index + 1, Math.max(1, total))).padStart(2, '0');
  return (
    <div data-testid={`interview-question-${def.id}`} data-module={def.module} data-tier={question.tier}>
      <StagePath current={stage} note={`Question ${Math.min(index + 1, Math.max(1, total))}`} onJump={onJumpStage} />

      {/*
        V8 — "Sidequest's call" after a "Decide for me": one ruled line above the
        next question, the label, the value, the reason, and Change beside it.
      */}
      {call && call.id !== def.id ? (
        <div className="slide-down mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 border-flare py-1 pl-3" data-testid="interview-call">
          <span className="sheet-label text-accent">Sidequest’s call</span>
          <span className="min-w-0 text-sm text-ink" title={call.decision.reason}>
            <span className="font-medium">{call.label}:</span> {call.value}
          </span>
          <span className="type-meta max-w-[48ch]">{call.decision.reason}</span>
          <button type="button" onClick={() => onCallChange(call.id)} className={cx('inline-flex min-h-11 items-center text-sm text-accent-strong underline underline-offset-4', FOCUS_RING)} data-testid="interview-call-change">
            Change
          </button>
        </div>
      ) : null}

      {/* The question: a giant light numeral, the module in the margin, one display sentence. */}
      <div className="relative mt-6 pt-[clamp(1.5rem,0.6rem+3vw,3.5rem)] lg:mt-8">
        <QuestionNumeral value={number} />
        <div className="relative">
          <p className="sheet-label inline-flex items-center gap-2 text-accent">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
            {question.tier === 'destination' ? 'Because of where you are going' : INTERVIEW_MODULE_LABELS[def.module]}</p>
          {/* The question is the page's one level-one heading: every state of the interview has exactly one. */}
          <h1 ref={headingRef} tabIndex={-1} className="ob-headline mt-3 max-w-[19ch] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
            <span className="mask-rise pb-[0.14em]">
              <span>{def.prompt(context, answers)}</span>
            </span>
          </h1>
        </div>
      </div>
      {whyInline ? <p className="mt-3 max-w-[54ch] text-base leading-relaxed text-ink-muted">{why}</p> : null}
      {question.tier === 'destination' ? (
        <p className="sr-only" data-testid="interview-branch-reason">
          Asked {question.reason}.
        </p>
      ) : null}

      {decidedReason ? (
        <p className="mt-4 flex max-w-[62ch] items-start gap-2 border-l-2 border-ink/30 pl-3 type-small text-ink-muted" data-testid="interview-decided-note">
          <span>
            <span className="font-medium text-ink">Sidequest decided:</span> {decidedReason}
          </span>
        </p>
      ) : null}

      <div className="fade-up mt-8" style={{ '--d': '120ms' } as React.CSSProperties}>
        <QuestionControl
          question={def}
          options={options}
          context={context}
          answers={answers}
          value={draft}
          onChange={(value) => {
            setTouched(true);
            setDraft(value);
            onDraft(value);
          }}
          recommended={recommendation?.value ?? null}
          recommendedReason={recommendation?.reason}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-1">
        {questionElaborates(def.id) && !noteOpen ? (
          <button type="button" onClick={() => setNoteOpen(true)} className={cx('inline-flex min-h-11 items-center gap-2 text-sm text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-note-open">
            <Glyph id="pen" className="h-4 w-4" />
            Something else? Tell us in your words
          </button>
        ) : null}
        {!whyInline ? (
          <details className="group text-sm text-ink-muted">
            <summary className={cx('inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 underline underline-offset-4 [&::-webkit-details-marker]:hidden', FOCUS_RING)} data-testid="interview-why">
              Why we're asking
              <span aria-hidden="true" className="transition-transform duration-[var(--motion-fast)] group-open:rotate-180">
                ⌄
              </span>
            </summary>
            <p className="max-w-[62ch] type-body pb-2 text-ink-muted">{why}</p>
          </details>
        ) : null}
      </div>

      {questionElaborates(def.id) && noteOpen ? (
        <div className="slide-down mt-3 max-w-2xl">
          <label htmlFor={`note-${def.id}`} className="sheet-label block text-ink-muted">
            In your own words
          </label>
          <textarea id={`note-${def.id}`} rows={2} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Anything the options above do not quite say" className="ob-lines mt-2" data-testid="interview-note" />
          <p className="type-meta mt-1.5">Kept exactly as you write it and read alongside your answer.</p>
          {readings.length > 0 ? (
            <div className="mt-3" data-testid="interview-note-readings">
              <p className="type-small text-ink-muted">Sidequest read this as — switch off anything that is wrong:</p>
              <ul className="mt-1.5 flex flex-wrap gap-2">
                {readings.map((reading) => (
                  <li key={reading.id}>
                    <button
                      type="button"
                      aria-pressed={reading.accepted}
                      onClick={() =>
                        setRejected((previous) => {
                          const next = new Set(previous);
                          if (next.has(reading.id)) next.delete(reading.id);
                          else next.add(reading.id);
                          return next;
                        })
                      }
                      className={cx('ob-tag', FOCUS_RING, reading.accepted ? '' : 'text-ink-faint line-through')}
                      data-on={reading.accepted ? 'true' : 'false'}
                      data-testid="interview-note-reading"
                      data-accepted={reading.accepted ? 'true' : 'false'}
                    >
                      <span aria-hidden="true" className="ob-tag-box" />
                      {reading.label}
                      <span className="text-xs font-normal opacity-80">{reading.strength.replace(/_/g, ' ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : note.trim().length >= 3 ? (
            <p className="type-meta mt-2" data-testid="interview-note-readings-none">Nothing in this matched a preference Sidequest can set. It still travels with your answer, word for word.</p>
          ) : null}
        </div>
      ) : null}

      {/*
        The action bar: sticky at every width and the last thing in the column,
        so nothing is ever pinned under it. On a phone it is the thumb's row —
        the two real actions edge to edge, the quiet ones above them.
      */}
      <div className="sticky bottom-0 z-20 -mx-5 mt-10 border-t-[1.5px] border-ink bg-paper/95 px-5 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:-mx-8 sm:px-8 lg:mx-0 lg:mt-12 lg:px-0 lg:pt-3">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <button type="button" onClick={onBack} disabled={pending} className={cx(buttonClass('ghost'), 'whitespace-nowrap px-3')}>
              ← Back
            </button>
            {def.optional ? (
              <button type="button" onClick={onSkip} disabled={pending} className={cx(buttonClass('ghost'), 'whitespace-nowrap px-3')} data-testid="interview-no-preference">
                No preference
              </button>
            ) : null}
            {/* Once nothing critical is open, carrying on is a choice, not a requirement. */}
            {enough ? (
              <button type="button" onClick={onEnough} disabled={pending} className={cx(buttonClass('ghost'), 'whitespace-nowrap px-3')} data-testid="interview-enough">
                Enough — plan it
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onDecide} disabled={pending} className={cx(buttonClass('secondary'), 'flex-1 whitespace-nowrap sm:flex-none')} data-testid="interview-decide" title="Sidequest chooses, tells you what it chose, and you can change it">
              <Glyph id="compass" className="h-4 w-4 max-sm:hidden" />
              Decide for me
            </button>
            <button type="button" onClick={() => onAnswer(draft, note, readings)} disabled={pending || !canContinue} className={cx(buttonClass('accent'), ACCENT_WAITING, 'flex-[1.3] whitespace-nowrap sm:flex-none sm:px-6')} data-testid="interview-continue">
              {pending ? 'Saving…' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Kinds whose "why" is an instruction for the control below it, and so belongs inline rather than behind a disclosure. */
const WHY_INLINE = new Set<QuestionDefinition['kind']>(['interests', 'interest_roles', 'hard_constraints', 'dietary', 'names', 'text']);

function initialDraft(def: QuestionDefinition): unknown {
  switch (def.kind) {
    case 'interests':
    case 'multi':
      return [];
    case 'dietary':
      return { needs: [], strict: false, notes: '' };
    case 'hard_constraints':
      return { constraints: [], notes: '', notesAreHard: false };
    case 'budget':
      return { style: undefined, envelope: null };
    case 'names':
      return { include: [], avoid: [] };
    case 'text':
      return '';
    default:
      return undefined;
  }
}

function draftIsUsable(def: QuestionDefinition, draft: unknown): boolean {
  switch (def.kind) {
    case 'interests':
      return Array.isArray(draft) && draft.length > 0;
    case 'budget':
      return Boolean((draft as { style?: string } | undefined)?.style);
    case 'single':
    case 'scenario':
      return draft !== undefined && draft !== null;
    default:
      return true;
  }
}

/** Kinds where an untouched control is a real answer ("nothing"), so Continue is never withheld. */
const EMPTY_IS_AN_ANSWER = new Set<QuestionDefinition['kind']>(['hard_constraints', 'multi', 'dietary', 'names', 'text', 'interest_roles']);
const SPECTRUM = new Set(['effort', 'walking_tolerance', 'hike_appetite']);
const RANGE = new Set(['scenic_reach', 'day_trips']);

/** The pattern for a question, from what it asks — never from where the trip is. */
function QuestionControl({
  question,
  options,
  context,
  answers,
  value,
  onChange,
  recommended = null,
  recommendedReason,
}: {
  question: QuestionDefinition;
  options: InterviewOption[];
  context: InterviewContext;
  answers: QuestionnaireAnswers;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The option Sidequest recommends because of where the trip is going, if any. */
  recommended?: string | null;
  /** The screening's sentence about why, attached to the recommended card. */
  recommendedReason?: string | undefined;
}) {
  const id = question.id;
  if (question.kind === 'interests') return <InterestGrid context={context} offered={options} value={(value as Interest[]) ?? []} onChange={onChange} />;
  if (question.kind === 'interest_roles') return <RoleMatrix name={id} options={options} value={(value as Record<string, string>) ?? {}} onChange={onChange} interests={Object.keys((question.read(answers) ?? {}) as Record<string, string>) as Interest[]} />;
  if (id.startsWith('priority_role:')) return <RoleMeter name={id} options={options} value={value as string | undefined} onChange={onChange} interest={id.slice('priority_role:'.length) as Interest} />;
  if (id === 'transport_mode') return <TransportChoice name={id} options={options} value={value as string | undefined} onChange={onChange} recommended={recommended} recommendedReason={recommendedReason} />;
  if (id === 'day_shape') return <RhythmChoice name={id} options={options} value={value as string | undefined} onChange={onChange} />;
  if (SPECTRUM.has(id)) return <SpectrumChoice name={id} options={options} value={value as string | undefined} onChange={onChange} />;
  if (RANGE.has(id)) return <RangeMapChoice name={id} options={options} value={value as string | undefined} onChange={onChange} baseName={context.destination.name} />;
  switch (question.kind) {
    case 'single':
    case 'scenario':
      return <OptionCards name={id} options={options} value={value as string | undefined} onChange={onChange} recommended={recommended} recommendedReason={recommendedReason} />;
    case 'multi':
      return <ChipGroup name={id} options={options} value={(value as string[]) ?? []} onChange={onChange} />;
    case 'dietary':
      return <DietaryControl options={options} value={(value as { needs: string[]; strict: boolean; notes?: string }) ?? { needs: [], strict: false, notes: '' }} onChange={onChange} />;
    case 'hard_constraints':
      return <HardLimitsControl context={context} answers={answers} value={(value as { constraints: HardConstraint[]; notes: string; notesAreHard: boolean }) ?? { constraints: [], notes: '', notesAreHard: false }} onChange={onChange} />;
    case 'budget':
      return <BudgetAxis options={options} value={(value as { style?: string; envelope: { amount?: number; basis?: string; currency?: string } | null }) ?? { style: undefined, envelope: null }} onChange={onChange} />;
    case 'names':
      return <NamesSpace value={(value as { include: string[]; avoid: string[] }) ?? { include: [], avoid: [] }} onChange={onChange} />;
    case 'text':
      return <WritingSpace id={id} value={(value as string) ?? ''} onChange={onChange} placeholder="Who tires first, who has a veto, what has to be back by when…" />;
    default:
      return <OptionCards name={id} options={options} value={value as string | undefined} onChange={onChange} />;
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function ReviewScreen({
  tripId,
  context,
  qContext,
  answers,
  plan,
  headingRef,
  durationAdvice,
  unresolved,
  boardAvailable,
  scanUnavailable = null,
  pending,
  analytics,
  onJump,
  onBack,
  onPersonalize,
  onFinish,
  onUpdate,
  geometry = null,
  tiles = null,
  timingOpen = false,
  activeBuild = null,
  acceptedWindow = null,
  buildUnavailable = null,
}: {
  tripId: string;
  context: InterviewContext;
  qContext: QuestionnaireContext;
  answers: QuestionnaireAnswers;
  plan: InterviewPlan;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  durationAdvice: string | null;
  unresolved: InterpretationSet['unresolved'];
  boardAvailable: boolean;
  scanUnavailable?: { heading: string; message: string } | null;
  pending: boolean;
  analytics: ReturnType<typeof interviewAnalytics>;
  onJump: (id: string) => void;
  onBack: () => void;
  onPersonalize: () => void;
  onFinish: (destination: CompletionDestination) => void;
  onUpdate: (patch: Partial<QuestionnaireAnswers>) => void;
  geometry?: DestinationGeometry | null;
  tiles?: MapBasemap | null;
  timingOpen?: boolean;
  activeBuild?: BuildRunView | null;
  acceptedWindow?: TimingWindowView | null;
  buildUnavailable?: { heading: string; message: string } | null;
}) {
  const [rangeKept, setRangeKept] = useState(false);
  /* V7 §7 — once a window is accepted here the question is closed for this session too; the row already carries the lock. */
  const [timingAccepted, setTimingAccepted] = useState(false);
  const [dismissedConflicts, setDismissedConflicts] = useState<string[]>([]);
  const conflicts = useMemo(
    () => materialConflicts(answers, { destinationTraits: context.destination.traits, partyNeeds: context.traveller.party?.needs ?? [] }).filter((c) => c.id !== 'drive_ceiling_vs_detour_range'),
    [answers, context],
  );
  const ledger = useMemo(() => reviewLedger(context, answers, plan), [context, answers, plan]);
  /*
   * V11 §H — the groups the traveller actually answered, and a count of the ones
   * Sidequest decided for them. See `reviewShapers`.
   */
  const shapers = useMemo(() => reviewShapers(ledger), [ledger]);
  const glance: ReviewGlanceGroup[] = shapers.groups;
  const sketch = useMemo(() => sketchFor(context, answers), [context, answers]);
  const profile = useMemo(() => {
    try {
      return buildTravelerProfile(answers, qContext);
    } catch {
      return null;
    }
  }, [answers, qContext]);
  // Only when the traveller actually said one of the two things: two of Sidequest's own defaults disagreeing is Sidequest's problem to settle quietly, not a question for them.
  const reconcile = answers.provenance.daily_driving?.source === 'explicit' || answers.provenance.scenic_reach?.source === 'explicit' ? mobilityReconciliation(answers) : null;
  const remainingFineTune = plan.questions.filter((q) => q.tier === 'fine_tune' && !q.hidden && q.status === 'open').length;
  const sufficiency = useMemo(() => assessSufficiency(plan), [plan]);

  /* V8 — the facts strip on the portrait band, read from the context and the row; nothing derived from a place name. */
  const facts = useMemo(
    () =>
      reviewFacts({
        nights: context.destination.nights,
        tripDays: context.destination.tripDays,
        adults: context.traveller.adults,
        children: context.traveller.children,
        acceptedWindow: acceptedWindow ?? null,
        timingOpen: timingOpen && !timingAccepted,
        shapeLabel: sketch.shapeLabel,
        shapeOpen: sketch.shapeOpen,
        shapeAssumed: sketch.shapeAssumed,
        pace: ledgerValue(ledger, 'day_shape'),
        priorities: ledgerValue(ledger, 'priorities'),
      }),
    [context, acceptedWindow, timingOpen, timingAccepted, sketch, ledger],
  );
  const party = context.traveller.party;
  const showTiming = timingOpen || timingAccepted || Boolean(acceptedWindow);
  /*
   * V1 CONVERGENCE — THE BOARD IS THE NEXT STEP, NOT A DETOUR.
   *
   * With a board: open it (primary), or build straight from Sidequest's picks
   * (secondary). Without one: find places for the trip (primary — the
   * Discovery scan, then the board), and, only where a composer can write a
   * trip with no board, a plainly labelled way to skip it. The note under the
   * bar is about whichever action is primary here.
   */
  const buildingNow = activeBuild?.state === 'running';
  const unavailableNote = boardAvailable ? buildUnavailable : scanUnavailable;
  const primary = buildingNow ? (
    <Link href={`/trips/${tripId}/build`} className={cx(buttonClass('accent', 'lg'), 'flex-1 sm:flex-none')} data-testid="interview-open-build">
      Open the build →
    </Link>
  ) : boardAvailable ? (
    <button type="button" onClick={() => onFinish('board')} disabled={pending} className={cx(buttonClass('accent', 'lg'), 'flex-1 sm:flex-none')} data-testid="interview-build-board">
      {pending ? 'Opening your board…' : 'Open the Discovery Board'}
    </button>
  ) : (
    <button type="button" onClick={() => onFinish('scan')} disabled={pending || Boolean(scanUnavailable)} aria-describedby={scanUnavailable ? 'build-unavailable-note' : undefined} className={cx(buttonClass('accent', 'lg'), 'flex-[1.4] whitespace-nowrap sm:flex-none')} data-testid="interview-find-places">
      {pending ? 'Starting the search…' : 'Find places for my trip →'}
    </button>
  );
  const secondary = buildingNow ? null : boardAvailable ? (
    <button type="button" onClick={() => onFinish('build')} disabled={pending || Boolean(buildUnavailable)} aria-describedby={buildUnavailable ? 'build-unavailable-note' : undefined} className={cx(buttonClass('secondary'), 'flex-1 sm:flex-none')} data-testid="interview-build-trip">
      {pending ? 'Starting your build…' : 'Build my trip'}
    </button>
  ) : !buildUnavailable ? (
    <button type="button" onClick={() => onFinish('build')} disabled={pending} className={cx(buttonClass('secondary'), 'flex-1 sm:flex-none')} data-testid="interview-build-trip">
      {pending ? 'Starting your build…' : (
        <>
          <span className="sm:hidden">Build now</span>
          <span className="max-sm:hidden">Skip the board and build now</span>
        </>
      )}
    </button>
  ) : null;

  const notice = 'mt-6 border-l-[3px] py-4 pr-4 pl-5';
  return (
    <div data-testid="interview-review">
      <div className="pt-1">
        <StagePath current="ready" note={`${analytics.answered} answered · ${analytics.decided} decided by Sidequest`} />
      </div>

      {/*
        THE PORTRAIT BAND — Survey Atlas. The place as a display line, one
        sentence about the traveller, the figures as boxed stats sharing their
        borders, and the plate (the same map the questions drew) beside it.
      */}
      <section className="mt-6 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:gap-14" aria-labelledby="review-heading">
        <div className="order-2 min-w-0 lg:order-1">
          <p className="sheet-label text-accent">Sidequest understands</p>
          <h1 id="review-heading" ref={headingRef} tabIndex={-1} className="ob-headline mt-3 text-[clamp(2.6rem,1.4rem+3.4vw,4.75rem)] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
            <span className="mask-rise pb-[0.14em]">
              <span>
                {context.destination.name}, <em className="font-light italic">your way</em>
              </span>
            </span>
          </h1>
          {profile ? (
            <p className="fade-up mt-5 max-w-[46ch] font-display text-xl leading-snug text-ink" style={{ '--d': '160ms' } as React.CSSProperties} data-testid="interview-sentence">
              {sentenceFor(context, answers, sketch)}
            </p>
          ) : null}
          <dl className="mt-7 grid grid-cols-2 pt-px pl-px sm:grid-cols-3" data-testid="review-facts">
            {facts.map((fact) => (
              <div key={fact.id} className="label-box -mt-px -ml-px min-w-0">
                <dt>{fact.label}</dt>
                <dd className={cx('text-lg', fact.figure ? 'type-figure' : '', fact.assumed ? 'text-ink-muted italic' : 'text-ink')}>
                  {fact.value}
                  {fact.assumed ? <span className="sr-only"> (Sidequest’s read)</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="order-1 min-w-0 lg:order-2">
          <ContextPlate ctx={context} answers={answers} geometry={geometry} tiles={tiles} notes={false} size="portrait" />
        </div>
      </section>

      {/*
        MVP V3, Stage 39 — ONE rendering of each fact. The glance is the review,
        set as a ruled register: the topic in the margin, what it says, Edit at
        the right. The party, the hard rules and the timing are rows in the same
        register, not cards floating under it.
      */}
      <section className="mt-14" data-testid="review-glance" aria-labelledby="review-glance-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="review-glance-heading" className="sheet-label text-ink">
            What will shape the route
          </h2>
          <p className="type-small text-ink-muted">Everything else you told us is in the full list below.</p>
        </div>
        <div className="ob-rows mt-3">
          {glance.map((group, index) => (
            <article key={group.id} className="grid min-w-0 gap-x-8 gap-y-2 py-5 md:grid-cols-[13rem_minmax(0,1fr)_auto]" data-testid={`glance-${group.id}`}>
              <h3 className="flex items-baseline gap-3 font-display text-xl leading-tight text-ink">
                <span aria-hidden="true" className="sheet-label text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                {group.title}
              </h3>
              <ul className="min-w-0 space-y-1.5">
                {group.lines.map((line) => {
                  const rule = isHardLine(line.text, ledger.hard);
                  return (
                    <li key={line.text} className={cx('flex gap-2.5 type-body', line.assumed ? 'text-ink-muted' : 'text-ink')}>
                      <span aria-hidden="true" className={cx('mt-2 inline-block h-2 w-2 shrink-0', line.assumed ? 'border border-ink/50' : 'bg-flare')} />
                      <span className="min-w-0">
                        {line.text}
                        {rule ? (
                          <span className="ml-2 align-middle">
                            <Badge tone="clay">Rule</Badge>
                          </span>
                        ) : line.assumed ? (
                          <span className="sr-only"> (Sidequest’s read)</span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <button type="button" onClick={() => onJump(group.editQuestionId)} className={cx('inline-flex min-h-11 shrink-0 items-center self-start text-sm text-accent underline underline-offset-4', FOCUS_RING)} data-testid={`glance-edit-${group.id}`}>
                Edit
                <span className="sr-only"> {group.title.toLowerCase()}</span>
              </button>
            </article>
          ))}

          {/* V6 §3 — people, not counts: the door to describing each person is on the review. */}
          <article className="grid min-w-0 gap-x-8 gap-y-2 py-5 md:grid-cols-[13rem_minmax(0,1fr)_auto]" data-testid="review-party">
            <h3 className="flex items-baseline gap-3 font-display text-xl leading-tight text-ink">
              <span aria-hidden="true" className="sheet-label text-ink-faint">{String(glance.length + 1).padStart(2, '0')}</span>
              Party
            </h3>
            <div className="min-w-0">
              <p className="type-figure type-body text-ink">{partyLine(context.traveller)}</p>
              {party ? (
                <p className="type-small mt-1 text-ink-muted">
                  {party.members} {party.members === 1 ? 'person' : 'people'} described
                  {party.needs.length > 0 ? ` · ${party.needs.map((need) => FUNCTIONAL_NEED_LABELS[need as keyof typeof FUNCTIONAL_NEED_LABELS] ?? need.replace(/_/g, ' ')).join(', ')}` : ''}
                </p>
              ) : (
                <p className="type-small mt-1 text-ink-muted">A diet, a knee, an early riser — describe each person and the plan is built for all of them.</p>
              )}
            </div>
            <a href={`/trips/${tripId}/party`} className={cx(buttonClass('secondary', 'sm'), 'self-start')} data-testid="review-party-link">
              {party ? 'Change who is going' : 'Describe each person'}
            </a>
          </article>

          {/*
            THE THINGS THE PLAN MAY NOT BREAK — the one row that is a promise
            rather than a reading, so it carries the clay rule.
          */}
          <article className="relative grid min-w-0 gap-x-8 gap-y-2 py-5 md:grid-cols-[13rem_minmax(0,1fr)_auto]" data-testid="review-hard">
            <span aria-hidden="true" className="absolute top-0 left-0 h-[3px] w-24 bg-clay" />
            <h3 className="flex items-center gap-2 font-display text-xl leading-tight text-ink">
              <Glyph id="lock" className="h-5 w-5 text-clay" />
              Hard rules
            </h3>
            {ledger.hard.length === 0 ? (
              <p className="type-small text-ink-muted">None — everything here is a preference.</p>
            ) : (
              <ul className="flex min-w-0 flex-wrap gap-2 text-sm text-ink">
                {ledger.hard.map((entry) => (
                  <li key={entry.label} className="border border-clay/50 px-3 py-1.5 text-clay" title={entry.detail}>
                    {entry.label}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={() => onJump('hard_constraints')} className={cx('inline-flex min-h-11 items-center self-start text-sm text-accent underline underline-offset-4', FOCUS_RING)}>
              Change the hard rules
            </button>
          </article>

          {showTiming ? (
            <div className="py-5">
              <ReviewTimingCard tripId={tripId} initialAccepted={acceptedWindow} onAccepted={() => setTimingAccepted(true)} />
            </div>
          ) : null}
        </div>

        {/* V11 §H — what Sidequest decided, as one line; every one is in the ledger below with its reason. */}
        {shapers.decidedForYou.length > 0 ? (
          <p className="mt-4 type-small text-ink-muted" data-testid="review-decided-for-you">
            Sidequest also decided {shapers.decidedForYou.length}{' '}
            {shapers.decidedForYou.length === 1 ? 'topic' : 'topics'} you did not answer at all —{' '}
            {shapers.decidedForYou.map((title) => title.toLowerCase()).join(', ')}. Every one is in the list below, with
            the reason.
          </p>
        ) : null}
      </section>

      {durationAdvice ? (
        <p className={cx(notice, 'border-ink/30 type-small text-ink-muted')}>
          <span className="font-medium text-ink">How long this deserves.</span> {durationAdvice}
        </p>
      ) : null}

      {sufficiency.kind === 'one_question' ? (
        <div className={cx(notice, 'border-flare bg-paper-raised')} data-testid="critical-unknown">
          <h3 className="font-display text-lg text-ink">One answer would change this trip</h3>
          <p className="mt-1.5 type-small text-ink-muted">
            {sufficiency.unknown.question.definition.prompt(context, answers).replace(/[:?]$/, '')} — Sidequest can decide it, but it shapes {sufficiency.unknown.question.definition.impacts.slice(0, 2).map((impact) => impact.replace(/_/g, ' ')).join(' and ')}.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className={buttonClass('secondary')} onClick={() => onJump(sufficiency.unknown.id)} data-testid="critical-unknown-answer">
              Answer it
            </button>
            <span className="type-small text-ink-faint">Or build now and Sidequest decides.</span>
          </div>
        </div>
      ) : null}

      {/* V6 §8 — the contradiction engine: only material conflicts with no safe reading interrupt, each with real resolutions. */}
      {conflicts.filter((c) => !dismissedConflicts.includes(c.id)).map((conflict) => (
        <div key={conflict.id} className={cx(notice, 'border-amber bg-amber-soft')} data-testid={`conflict-${conflict.id}`}>
          <h3 className="font-display text-lg text-ink">These two answers pull in different directions</h3>
          <p className="mt-1.5 type-small text-ink-muted">
            “{conflict.sides[0]}” and “{conflict.sides[1]}”.{conflict.moreRecent !== null ? ` You said the ${conflict.moreRecent === 0 ? 'first' : 'second'} more recently.` : ''} Which should the trip follow?
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {conflict.resolutions.map((resolution) => (
              <button key={resolution.id} type="button" className={buttonClass('secondary')} onClick={() => onUpdate(resolution.patch)} data-testid={`conflict-resolve-${resolution.id}`}>
                {resolution.label}
              </button>
            ))}
            <button type="button" className={buttonClass('ghost')} onClick={() => setDismissedConflicts((d) => [...d, conflict.id])}>
              Leave it to Sidequest
            </button>
          </div>
        </div>
      ))}

      {reconcile && !rangeKept ? (
        <div className={cx(notice, 'border-amber bg-amber-soft')} data-testid="mobility-reconciliation">
          <h3 className="font-display text-lg text-ink">Two of your answers pull against each other</h3>
          <p className="mt-1.5 type-small text-ink-muted">
            You said up to {formatMinutes(reconcile.wheelMinutes)} at the wheel in a day, but nothing further than about {formatMinutes(reconcile.rangeMinutes)} from base. As things stand the shorter answer wins. Which did you mean?
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className={buttonClass('secondary')} onClick={() => onUpdate({ detourToleranceMinutes: reconcile.widenedDetourMinutes, regionalExpansion: reconcile.widenedExpansion })}>
              Widen my range to {formatMinutes(reconcile.widenedDetourMinutes)}
            </button>
            <button type="button" className={buttonClass('ghost')} onClick={() => setRangeKept(true)}>
              Keep it within {formatMinutes(reconcile.rangeMinutes)}
            </button>
          </div>
        </div>
      ) : null}

      {/* V8 — a run already on this trip is shown from the row, so the review can never start a second one by accident. */}
      {activeBuild && activeBuild.state !== 'none' && activeBuild.state !== 'succeeded' ? (
        <section className={cx(notice, 'mt-8', activeBuild.state === 'running' ? 'border-pine bg-pine-soft' : 'border-amber bg-amber-soft')} data-testid="review-active-build" data-state={activeBuild.state}>
          <h3 className="font-display text-lg text-ink">{activeBuild.state === 'running' ? 'Sidequest is building this trip now.' : activeBuild.state === 'lost' ? 'The last build was lost part-way.' : 'The last build didn’t finish.'}</h3>
          <p className="mt-1.5 type-small text-ink-muted">
            {activeBuild.state === 'running'
              ? 'It carries on whether or not this page is open. Open the build to watch it, or wait here — nothing you answered is at risk.'
              : 'Your trip profile is saved. Open the build to see what happened and try it again from the profile — nothing here needs answering again.'}
          </p>
          <div className="mt-4">
            <Link href={`/trips/${tripId}/build`} className={buttonClass(activeBuild.state === 'running' ? 'primary' : 'secondary')} data-testid="review-open-build">
              {activeBuild.state === 'running' ? 'Open the build' : 'See what happened'}
            </Link>
          </div>
        </section>
      ) : null}

      <details className="mt-10 border-t-[1.5px] border-ink pt-3" data-testid="review-ledger">
        <summary className={cx('inline-flex min-h-11 cursor-pointer items-center text-sm text-ink-muted underline underline-offset-4', FOCUS_RING)}>
          Every answer, and where it came from ({ledger.told.length} yours · {ledger.assumed.length} ours)
        </summary>
        <div className="mt-5 grid gap-8 lg:grid-cols-2">
          <LedgerColumn title="You told us" blurb="Your own answers. These bind the plan." entries={ledger.told} testId="review-told" onJump={onJump} empty="Nothing answered yet — everything is Sidequest's read." />
          <LedgerColumn title="Sidequest's read" blurb="Defaults we chose, with the reason. Change any of them." entries={ledger.assumed} testId="review-assumed" onJump={onJump} empty="Nothing assumed — you answered everything." assumed />
        </div>
      </details>

      {unresolved.length > 0 ? (
        <section className="mt-10 border-t border-dashed border-ink/40 pt-5">
          <h3 className="sheet-label text-ink">In your own words</h3>
          <p className="mt-1 type-small text-ink-muted">Kept exactly as you wrote it. These are not settings, so they have not steered anything above.</p>
          <ul className="mt-3 space-y-1.5 font-display text-xl italic text-ink-muted">
            {unresolved.map((entry) => (
              <li key={`${entry.field ?? 'mustDo'}-${entry.span[0]}-${entry.quote}`}>“{entry.quote}”</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        V8 — THE BUILD BAR IS STICKY AT EVERY WIDTH: pinned to the bottom while
        the review is taller than the viewport, in flow at the end. The one
        flare action on the screen.
      */}
      <div className="sticky bottom-0 z-20 -mx-5 mt-12 border-t-[1.5px] border-ink bg-paper/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:-mx-8 sm:px-8" data-testid="review-build-bar">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <button type="button" onClick={onBack} disabled={pending} className={buttonClass('ghost')}>
              ← Back
            </button>
            {remainingFineTune > 0 ? (
              <button type="button" onClick={onPersonalize} disabled={pending} className={buttonClass('ghost')} data-testid="interview-personalize">
                Personalize it more ({remainingFineTune})
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {/* ONE PRIMARY ACTION: the board (or the search that makes one); building directly is the secondary path. */}
            {secondary}
            {primary}
          </div>
        </div>
        {unavailableNote ? (
          /* V1 convergence — the honest state of the primary action, beside it rather than after pressing it. */
          <p id="build-unavailable-note" className="mx-auto mt-2 max-w-7xl type-small text-ink" role="status" data-testid="build-unavailable">
            <strong className="font-semibold">{unavailableNote.heading}</strong> {unavailableNote.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One ledger entry as the band wants it: its rendered value and who decided it.
 *
 * Null when the interview never asked, which the band reads as "do not state a
 * fact nobody has".
 */
function ledgerValue(ledger: ReviewLedger, questionId: string): { value: string; assumed: boolean } | null {
  const entry = [...ledger.told, ...ledger.assumed].find((candidate) => candidate.questionId === questionId);
  return entry ? { value: entry.value, assumed: entry.source !== 'explicit' } : null;
}

function LedgerColumn({ title, blurb, entries, testId, onJump, empty, assumed = false }: { title: string; blurb: string; entries: ReviewEntry[]; testId: string; onJump: (id: string) => void; empty: string; assumed?: boolean }) {
  return (
    <section className="min-w-0" data-testid={testId}>
      <h3 className="font-display text-xl text-ink">{title}</h3>
      <p className="mt-1 text-sm text-ink-muted">{blurb}</p>
      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">{empty}</p>
      ) : (
        <dl className="mt-4 divide-y divide-rule">
          {entries.map((entry) => (
            <div key={entry.questionId} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="label">{entry.label}</dt>
                <button type="button" onClick={() => onJump(entry.questionId)} className={cx('inline-flex min-h-9 shrink-0 items-center text-xs text-accent underline underline-offset-4', FOCUS_RING)} data-testid={`review-change-${entry.questionId}`}>
                  Change
                  <span className="sr-only"> {entry.label.toLowerCase()}</span>
                </button>
              </div>
              <dd className="mt-0.5 text-sm text-ink">
                {entry.value}
                {entry.strength === 'hard' ? (
                  <span className="ml-2 align-middle">
                    <Badge tone="clay">Hard</Badge>
                  </span>
                ) : null}
                {assumed ? (
                  <span className="ml-2 align-middle">
                    <Badge>{entry.source === 'existing_profile' ? 'from your trip setup' : entry.source === 'destination_prior' ? 'from the destination' : 'assumed'}</Badge>
                  </span>
                ) : null}
                {assumed && entry.reason ? <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{entry.reason}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}


function sentenceFor(context: InterviewContext, answers: QuestionnaireAnswers, sketch: ReturnType<typeof sketchFor>): string {
  const lead = sketch.lines[0]?.text.toLowerCase() ?? 'an open-ended trip';
  const pace = answers.pace === 'slow' ? 'slow' : answers.pace === 'fast' ? 'full' : 'balanced';
  const settledParts = [!sketch.transport.open ? sketch.transport.label.toLowerCase() : 'how you get around still open', !sketch.shapeOpen ? sketch.shapeLabel.toLowerCase() : null].filter(Boolean).join(', ');
  return `${capitalize(lead)}. ${capitalize(pace)} days, ${settledParts} — over ${context.destination.tripDays} ${context.destination.tripDays === 1 ? 'day' : 'days'} in ${context.destination.proseName}.`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
