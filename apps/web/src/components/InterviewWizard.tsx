'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  DESTINATION_TRAIT_LABELS,
  INTERVIEW_MODULE_LABELS,
  answerQuestion,
  applySmartDefaults,
  assessSufficiency,
  buildTravelerProfile,
  decideQuestion,
  describeAnswer,
  interviewAnalytics,
  markAsked,
  markCarried,
  planInterview,
  questionnaireContextOf,
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
  type SmartDefault,
} from '@sidequest/core';
import { Badge, ErrorNote, FOCUS_RING, buttonClass, cx } from './ui';
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
  OPTION_GLYPHS,
  OptionCards,
  RangeMapChoice,
  RhythmChoice,
  RoleMeter, RoleMatrix,
  SpectrumChoice,
  TransportChoice,
  WritingSpace,
} from './interview/patterns';
import { mapLayersFor, SketchFigure, TripProfileList, TripSketchPanel, TripSketchSheet, sketchFor } from './interview/TripSketch';
import { DestinationMap, type DestinationGeometry } from './interview/DestinationMap';
import { GenerationOverlay } from './interview/GenerationOverlay';
import type { MapBasemap } from './map-adapter';
import { StagePath, stageOf } from './interview/StagePath';
import {
  completeAndBuildAction,
  completeQuestionnaireAction,
  exploreExperiencesAction,
  saveDraftAction,
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
  researchAvailable,
  fixtureMode = false,
  geometry = null,
  tiles = null,
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
  researchAvailable: boolean;
  fixtureMode?: boolean;
}) {
  const now = useMemo(() => new Date(), []);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>(() => {
    const screened = withScreening(initialAnswers, context.destination);
    return markCarried(screened, context, planInterview({ ctx: context, answers: screened }), now);
  });
  const [position, setPosition] = useState<string>(initialAnswers.interview?.position ?? UNDERSTANDING_POSITION);
  const [error, setError] = useState<string | null>(null);
  /** COMPOSITION RELIABILITY — a build that failed keeps the answers and waits for an explicit Retry; nothing retries on its own. */
  const [buildFailure, setBuildFailure] = useState<{ answers: QuestionnaireAnswers; message: string } | null>(null);
  const [call, setCall] = useState<{ id: string; label: string; value: string; decision: SmartDefault } | null>(null);
  const [pending, startTransition] = useTransition();
  const [panelOpen, setPanelOpen] = useState(position === UNDERSTANDING_POSITION);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const mode: InterviewMode = answers.interview?.mode ?? 'normal';
  const plan = useMemo(() => planInterview({ ctx: context, answers, mode }), [context, answers, mode]);
  const shown = plan.shown;
  const current: PlannedQuestion | null =
    position === UNDERSTANDING_POSITION || position === REVIEW_POSITION ? null : (plan.questions.find((q) => q.id === position) ?? null);
  const shownIndex = current ? shown.indexOf(current.id) : -1;
  const qContext = questionnaireContextOf(context, region);

  function go(target: string, toSave: QuestionnaireAnswers = answers) {
    setError(null);
    const saved = withPosition(toSave, target);
    startTransition(async () => {
      const result = await saveDraftAction(tripId, saved);
      if (!result.ok) {
        setError(result.error ?? 'We could not save your progress.');
        return;
      }
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

  function answer(value: unknown) {
    if (!current) return;
    const next = answerQuestion({ answers, ctx: context, question: current.definition, value, now: new Date(), ...(region ? { region } : {}) });
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
    go(previousBefore(current ? current.id : position === REVIEW_POSITION ? (shown[shown.length - 1] ?? null) : null));
  }

  function jumpTo(id: string) {
    const target = plan.questions.find((q) => q.id === id);
    if (!target) return;
    const next = target.tier === 'fine_tune' && mode !== 'deep' ? withMode(answers, 'deep') : answers;
    setCall(null);
    go(id, markAsked(next, id));
  }

  function personalizeMore() {
    const next = withMode(answers, 'deep');
    const deepPlan = planInterview({ ctx: context, answers: next, mode: 'deep' });
    const firstOpen = deepPlan.shown.find((id) => deepPlan.questions.find((q) => q.id === id)?.status === 'open');
    setCall(null);
    go(firstOpen ?? REVIEW_POSITION, next);
  }

  /** One Build = one composition. A failure shows the retry panel; the traveller decides whether to spend another call. */
  const [building, setBuilding] = useState(false);
  function build(next: QuestionnaireAnswers) {
    setError(null);
    setBuildFailure(null);
    setBuilding(true);
    startTransition(async () => {
      const result = await completeAndBuildAction(tripId, withPosition(next, REVIEW_POSITION));
      if (!result.ok) {
        setBuilding(false);
        setBuildFailure({ answers: next, message: result.error ?? 'Sidequest could not finish this draft. Your answers are saved.' });
      }
      // On success the action redirects to the itinerary; the overlay stays until the new page paints.
    });
  }

  function planWithDefaults() {
    const { answers: next } = applySmartDefaults({ answers, ctx: context, now: new Date(), ...(region ? { region } : {}) });
    build(next);
  }

  function finish(destination: CompletionDestination) {
    if (destination === 'build') {
      build(answers);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result =
        destination === 'research'
            ? await exploreExperiencesAction(tripId, withPosition(answers, REVIEW_POSITION))
            : await completeQuestionnaireAction(tripId, withPosition(answers, REVIEW_POSITION), destination);
      if (!result.ok) setError(result.error ?? 'We could not save your profile.');
    });
  }

  /** "Explore experiences first" from the understanding screen: research runs while the traveller answers. */
  function exploreFirst() {
    setError(null);
    startTransition(async () => {
      const result = await exploreExperiencesAction(tripId, withPosition(answers, position));
      if (!result.ok) setError(result.error ?? 'We could not start exploring just now.');
    });
  }

  const hasMoved = useRef(false);
  useEffect(() => {
    if (!hasMoved.current) {
      hasMoved.current = true;
      return;
    }
    window.scrollTo({ top: 0, left: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [position]);

  const analytics = useMemo(() => interviewAnalytics(context, answers, plan), [context, answers, plan]);
  const stage = stageOf(position === UNDERSTANDING_POSITION ? null : position);
  const inInterview = current !== null;

  return (
    <div className="mx-auto max-w-7xl px-5 pb-16 sm:px-8" data-testid="interview" data-position={position} data-mode={mode}>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-6">
        <p className="label text-ink-faint">Your trip preferences</p>
        {fixtureMode ? (
          <span className="inline-flex items-center gap-2 rounded-md border border-dashed border-amber bg-amber-soft px-2.5 py-1 text-xs text-amber" data-testid="fixture-planning-badge">
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
        <UnderstandingScreen context={context} answers={answers} headingRef={headingRef} questionCount={shown.length} pending={pending} onStart={start} onDefaults={planWithDefaults} geometry={geometry} tiles={tiles} {...(researchAvailable && !boardAvailable ? { onExplore: exploreFirst } : {})} />
      ) : null}

      {inInterview || position === REVIEW_POSITION ? (
        <div className={cx('mt-6 grid gap-8 lg:gap-12', position === REVIEW_POSITION ? '' : 'lg:grid-cols-[minmax(0,1fr)_21rem]')}>
          <div className="min-w-0">
            {current ? (
              <QuestionScreen
                key={current.id}
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
                onAnswer={answer}
                onDecide={decide}
                onSkip={skip}
                onBack={back}
              />
            ) : null}
            {position === REVIEW_POSITION ? (
              <ReviewScreen
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
                researchAvailable={researchAvailable}
                pending={pending}
                analytics={analytics}
                onJump={jumpTo}
                onBack={back}
                onPersonalize={personalizeMore}
                onFinish={finish}
                onUpdate={(patch) => setAnswers((curr) => withPosition({ ...curr, ...patch }, REVIEW_POSITION))}
              />
            ) : null}
            {current ? (
              <div className="mt-8 lg:hidden">
                <TripSketchSheet ctx={context} answers={answers} geometry={geometry} tiles={tiles} />
              </div>
            ) : null}
          </div>
          {current ? (
            <div className="hidden lg:block">
              <div className="sticky top-[calc(var(--chrome-height)+1.5rem)]">
                <TripSketchPanel ctx={context} answers={answers} geometry={geometry} tiles={tiles} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {building && !buildFailure ? <GenerationOverlay destination={context.destination.name} geometry={geometry} tiles={tiles} /> : null}
      {buildFailure ? (
        <section className="mt-8 rounded-[var(--radius-panel)] border border-rule bg-paper-raised p-6" data-testid="build-failure" role="alert" aria-live="polite">
          <h2 className="font-display text-xl text-ink">Sidequest couldn&rsquo;t finish this draft.</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">Your answers are saved. Retrying starts one fresh draft from them.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" className={buttonClass('primary')} onClick={() => build(buildFailure.answers)} disabled={pending} data-testid="retry-draft">
              {pending ? 'Drafting…' : 'Retry draft'}
            </button>
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
              Back to preferences
            </button>
          </div>
        </section>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
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
  const sketch = sketchFor(context, answers);
  const stamps = d.understanding.slice(1);
  return (
    <section className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-center" data-testid="interview-understanding">
      <div className="enter min-w-0">
        <p className="label text-accent">{[d.scaleLabel ?? 'Your destination', `${d.nights} ${d.nights === 1 ? 'night' : 'nights'}`].join(' · ')}</p>
        <h1 ref={headingRef} tabIndex={-1} className="display-hero mt-3 text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-4 focus:outline-dashed">
          {d.name}
        </h1>
        {stamps.length > 0 ? (
          <ul className="mt-5 flex flex-wrap gap-2" aria-label="What Sidequest read about this destination">
            {stamps.map((line) => (
              <li key={line} className="rounded-full border border-ink/30 px-3 py-1 text-xs text-ink">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-7 max-w-xl font-display text-xl leading-snug text-ink sm:text-2xl" data-testid="interview-assumption">
          {d.assumption ? d.assumption.sentence : `We have not researched ${d.name} yet, so we will ask the questions that matter most for any trip and check the rest once the research runs.`}
        </p>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-muted">
          {questionCount} short {questionCount === 1 ? 'question' : 'questions'}, about a minute. Every one redraws the sketch; hand any of them to us.
        </p>
        {d.traits.length > 0 ? (
          <details className="mt-3 text-sm text-ink-muted">
            <summary className={cx('inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4', FOCUS_RING)}>Why we think so</summary>
            <ul className="mt-2 space-y-1">
              {d.traits.map((trait) => (
                <li key={trait}>
                  <span className="font-medium text-ink">{DESTINATION_TRAIT_LABELS[trait]}</span> — {d.basis[trait]}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onStart} disabled={pending} className={buttonClass('primary', 'lg')} data-testid="interview-start">
            {pending ? 'Saving…' : 'Start the interview'}
          </button>
          <button type="button" onClick={onDefaults} disabled={pending} className={buttonClass('secondary', 'lg')} data-testid="interview-smart-defaults">
            <Glyph id="compass" className="h-4 w-4" />
            Plan with smart defaults
          </button>
        </div>
        {onExplore ? (
          <p className="mt-4 text-sm text-ink-muted">
            Prefer to see what is there first?{' '}
            <button type="button" onClick={onExplore} disabled={pending} className={cx('text-accent underline underline-offset-4', FOCUS_RING)} data-testid="interview-explore">
              Explore experiences first
            </button>
            {' '}— Sidequest researches the area while you answer, and you choose from a board before building.
          </p>
        ) : null}
      </div>
      <div className="enter-slow min-w-0">
        {geometry ? <DestinationMap geometry={geometry} tiles={tiles} shape={sketch.bases > 1 ? 'moving' : 'stay_put'} rangeKm={sketch.rangeKm} {...mapLayersFor(sketch, answers)} /> : <SketchFigure sketch={sketch} />}
        <p className="mt-2 text-xs text-ink-faint">{geometry ? 'The map takes shape as you answer.' : 'The sketch redraws as you answer.'}</p>
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
  onAnswer,
  onDecide,
  onSkip,
  onBack,
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
  onAnswer: (value: unknown) => void;
  onDecide: () => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const def = question.definition;
  const resolved = question.status !== 'open';
  const seededInterests = def.kind === 'interests' ? (def.read(answers) as Interest[]) : [];
  const [draft, setDraft] = useState<unknown>(() => (resolved || def.kind === 'interest_roles' ? def.read(answers) : def.kind === 'interests' && seededInterests.length > 0 ? seededInterests : initialDraft(def)));
  const [touched, setTouched] = useState(resolved || seededInterests.length > 0 || EMPTY_IS_AN_ANSWER.has(def.kind));
  const options = def.options?.(context, answers) ?? [];
  const canContinue = touched && draftIsUsable(def, draft);
  const decidedReason = question.status === 'decided' ? answers.provenance[def.id]?.reason : undefined;

  return (
    <div className="enter" data-testid={`interview-question-${def.id}`} data-module={def.module} data-tier={question.tier}>
      <StagePath current={stage} note={`Question ${Math.min(index + 1, Math.max(1, total))}`} />

      {call && call.id !== def.id ? (
        <div className="slide-down mt-5 flex flex-wrap items-start gap-3 rounded-[var(--radius-card)] border border-accent/40 bg-accent-soft p-4" data-testid="interview-call">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-paper" aria-hidden="true">
            <Glyph id="compass" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="label text-accent-strong">Sidequest's call</p>
            <p className="mt-1 text-sm text-ink">
              <span className="font-medium">{call.label}:</span> {call.value}
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{call.decision.reason}</p>
          </div>
          <button type="button" onClick={() => onCallChange(call.id)} className={cx('text-sm text-accent-strong underline underline-offset-4', FOCUS_RING)} data-testid="interview-call-change">
            Change
          </button>
        </div>
      ) : null}

      <p className="mt-6 text-xs text-ink-faint">
        {question.tier === 'destination' ? 'Because of where you are going' : INTERVIEW_MODULE_LABELS[def.module]}
      </p>
      {/* The question is the page's one level-one heading: every state of the interview has exactly one. EXPERIENCE V2 — a title, not a poster. */}
      <h1 ref={headingRef} tabIndex={-1} className="type-title mt-1.5 max-w-[28ch] text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-4 focus:outline-dashed">
        {def.prompt(context, answers)}
      </h1>
      <p className="mt-2 max-w-[62ch] type-body text-ink-muted">{def.why(context)}</p>
      {question.tier === 'destination' ? (
        <p className="sr-only" data-testid="interview-branch-reason">
          Asked {question.reason}.
        </p>
      ) : null}

      {decidedReason ? (
        <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-accent/40 bg-accent-soft p-4 text-sm text-ink" data-testid="interview-decided-note">
          <Glyph id="compass" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            <span className="font-medium">Sidequest decided:</span> {decidedReason}
          </span>
        </div>
      ) : null}

      <div className="mt-6">
        <QuestionControl
          question={def}
          options={options}
          context={context}
          answers={answers}
          value={draft}
          onChange={(value) => {
            setTouched(true);
            setDraft(value);
          }}
        />
      </div>

      <div className="sticky bottom-0 z-10 -mx-5 mt-8 border-t border-rule bg-paper/95 px-5 py-4 backdrop-blur-sm sm:static sm:mx-0 sm:mt-10 sm:border-t sm:bg-transparent sm:px-0 sm:pt-6 sm:backdrop-blur-none">
        {/*
          Two rows on a phone, one on anything wider. The two real actions —
          hand it to Sidequest, or continue — share the bottom row edge to
          edge; the two quiet ones sit above them. Four buttons wrapping into
          four rows was a bar as tall as the question.
        */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between gap-2 sm:justify-start">
            <button type="button" onClick={onBack} disabled={pending} className={buttonClass('ghost')}>
              ← Back
            </button>
            {def.optional ? (
              <button type="button" onClick={onSkip} disabled={pending} className={buttonClass('ghost')} data-testid="interview-no-preference">
                No preference
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onDecide} disabled={pending} className={cx(buttonClass('secondary'), 'flex-1 sm:flex-none')} data-testid="interview-decide" title="Sidequest chooses, tells you what it chose, and you can change it">
              <Glyph id="compass" className="h-4 w-4" />
              Decide for me
            </button>
            <button type="button" onClick={() => onAnswer(draft)} disabled={pending || !canContinue} className={cx(buttonClass('primary'), 'flex-1 sm:flex-none')} data-testid="interview-continue">
              {pending ? 'Saving…' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function initialDraft(def: QuestionDefinition): unknown {
  switch (def.kind) {
    case 'interests':
    case 'multi':
      return [];
    case 'dietary':
      return { needs: [], strict: false };
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
const SCENARIO_LETTERED = new Set(['iconic_crowds', 'food_tradeoff', 'base_moves', 'coverage_strategy', 'convenience_spend']);
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
}: {
  question: QuestionDefinition;
  options: InterviewOption[];
  context: InterviewContext;
  answers: QuestionnaireAnswers;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = question.id;
  if (question.kind === 'interests') return <InterestGrid context={context} offered={options} value={(value as Interest[]) ?? []} onChange={onChange} />;
  if (question.kind === 'interest_roles') return <RoleMatrix name={id} options={options} value={(value as Record<string, string>) ?? {}} onChange={onChange} interests={Object.keys((question.read(answers) ?? {}) as Record<string, string>) as Interest[]} />;
  if (id.startsWith('priority_role:')) return <RoleMeter name={id} options={options} value={value as string | undefined} onChange={onChange} interest={id.slice('priority_role:'.length) as Interest} />;
  if (id === 'transport_mode') return <TransportChoice name={id} options={options} value={value as string | undefined} onChange={onChange} />;
  if (id === 'day_shape') return <RhythmChoice name={id} options={options} value={value as string | undefined} onChange={onChange} />;
  if (SPECTRUM.has(id)) return <SpectrumChoice name={id} options={options} value={value as string | undefined} onChange={onChange} />;
  if (RANGE.has(id)) return <RangeMapChoice name={id} options={options} value={value as string | undefined} onChange={onChange} baseName={context.destination.name} />;
  switch (question.kind) {
    case 'single':
    case 'scenario':
      return <OptionCards name={id} options={options} value={value as string | undefined} onChange={onChange} glyphs={OPTION_GLYPHS[id]} lettered={question.kind === 'scenario' || SCENARIO_LETTERED.has(id)} columns={options.length >= 4 ? 2 : options.length === 3 ? 3 : 2} />;
    case 'multi':
      return <ChipGroup name={id} options={options} value={(value as string[]) ?? []} onChange={onChange} />;
    case 'dietary':
      return <DietaryControl options={options} value={(value as { needs: string[]; strict: boolean }) ?? { needs: [], strict: false }} onChange={onChange} />;
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
  context,
  qContext,
  answers,
  plan,
  headingRef,
  durationAdvice,
  unresolved,
  boardAvailable,
  researchAvailable,
  pending,
  analytics,
  onJump,
  onBack,
  onPersonalize,
  onFinish,
  onUpdate,
  geometry = null,
  tiles = null,
}: {
  context: InterviewContext;
  qContext: QuestionnaireContext;
  answers: QuestionnaireAnswers;
  plan: InterviewPlan;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  durationAdvice: string | null;
  unresolved: InterpretationSet['unresolved'];
  boardAvailable: boolean;
  researchAvailable: boolean;
  pending: boolean;
  analytics: ReturnType<typeof interviewAnalytics>;
  onJump: (id: string) => void;
  onBack: () => void;
  onPersonalize: () => void;
  onFinish: (destination: CompletionDestination) => void;
  onUpdate: (patch: Partial<QuestionnaireAnswers>) => void;
  geometry?: DestinationGeometry | null;
  tiles?: MapBasemap | null;
}) {
  const [rangeKept, setRangeKept] = useState(false);
  const ledger = useMemo(() => reviewLedger(context, answers, plan), [context, answers, plan]);
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
  const synthesis = synthesisLines(answers, sketch);

  return (
    <div className="enter" data-testid="interview-review">
      <StagePath current="ready" note={`${analytics.answered} answered · ${analytics.decided} decided by Sidequest`} />
      {/* EXPERIENCE V2 — the review is a reveal: the place, one sentence, a handful of statements, the map. */}
      <p className="mt-6 text-xs text-ink-faint">Sidequest understands</p>
      <h1 ref={headingRef} tabIndex={-1} className="display-xl mt-1.5 text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-4 focus:outline-dashed">
        {context.destination.name}, your way
      </h1>
      {profile ? (
        <p className="mt-3 max-w-[60ch] type-body text-ink-muted" data-testid="interview-sentence">
          {sentenceFor(context, answers, sketch)}
        </p>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <ul className="divide-y divide-rule border-y border-rule" aria-label="How you travel, in short" data-testid="review-synthesis">
          {synthesis.map((line, i) => (
            <li key={line.text} className="rise flex items-baseline gap-3 py-3" style={{ transitionDelay: `${i * 40}ms` }}>
              <span aria-hidden="true" className={cx('mt-2 h-2 w-2 shrink-0 self-start rounded-full', line.assumed ? 'border border-ink-faint bg-paper' : 'bg-accent')} />
              <span className="font-display text-2xl leading-snug text-ink">
                {line.text}
                {line.assumed ? <span className="sr-only"> (Sidequest’s read)</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <div>
          {geometry ? <DestinationMap geometry={geometry} tiles={tiles} shape={sketch.bases > 1 ? 'moving' : 'stay_put'} rangeKm={sketch.rangeKm} {...mapLayersFor(sketch, answers)} /> : <SketchFigure sketch={sketch} />}
          <div className="mt-3">
            <TripProfileList sketch={sketch} />
          </div>
        </div>
      </div>

      {durationAdvice ? <p className="mt-6 rounded-[var(--radius-card)] border border-dashed border-rule bg-paper-sunk p-4 text-sm leading-relaxed text-ink-muted">You asked for a steer on trip length: {durationAdvice}</p> : null}

      {sufficiency.kind === 'one_question' ? (
        <div className="mt-6 rounded-[var(--radius-card)] border-l-4 border-accent bg-accent-soft p-5" data-testid="critical-unknown">
          <h3 className="font-display text-lg text-ink">One answer would change this trip</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            {sufficiency.unknown.question.definition.prompt(context, answers).replace(/[:?]$/, '')} — Sidequest can decide it, but it shapes {sufficiency.unknown.question.definition.impacts.slice(0, 2).map((impact) => impact.replace(/_/g, ' ')).join(' and ')}.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className={buttonClass('secondary')} onClick={() => onJump(sufficiency.unknown.id)} data-testid="critical-unknown-answer">
              Answer it
            </button>
            <span className="text-sm text-ink-faint">Or build now and Sidequest decides.</span>
          </div>
        </div>
      ) : null}

      {reconcile && !rangeKept ? (
        <div className="mt-6 rounded-[var(--radius-card)] border-l-4 border-amber bg-amber-soft p-5" data-testid="mobility-reconciliation">
          <h3 className="font-display text-lg text-ink">Two of your answers pull against each other</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
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

      <section className="mt-10 rule-top pt-5" data-testid="review-hard">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3 className="flex items-center gap-2 font-display text-xl text-ink">
            <Glyph id="lock" className="h-4 w-4 text-clay" />
            Hard rules
          </h3>
          {ledger.hard.length === 0 ? (
            <p className="text-sm text-ink-muted">None — everything here is a preference.</p>
          ) : (
            <ul className="flex flex-wrap gap-2 text-sm text-ink">
              {ledger.hard.map((entry) => (
                <li key={entry.label} className="rounded-full border border-clay/40 bg-clay-soft px-3 py-1" title={entry.detail}>
                  {entry.label}
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => onJump('hard_constraints')} className={cx('text-sm text-accent underline underline-offset-4', FOCUS_RING)}>
            Change the hard rules
          </button>
        </div>
      </section>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <LedgerColumn title="You told us" blurb="Your own answers. These bind the plan." entries={ledger.told} testId="review-told" onJump={onJump} empty="Nothing answered yet — everything is Sidequest's read." />
        <LedgerColumn title="Sidequest's read" blurb="Defaults we chose, with the reason. Change any of them." entries={ledger.assumed} testId="review-assumed" onJump={onJump} empty="Nothing assumed — you answered everything." assumed />
      </div>

      {unresolved.length > 0 ? (
        <section className="mt-10 rounded-[var(--radius-card)] border border-dashed border-rule p-5">
          <h3 className="font-display text-lg text-ink">In your own words</h3>
          <p className="mt-1 text-sm text-ink-muted">Saved with your trip exactly as you wrote it. We could not turn these into settings, so they have not steered anything above.</p>
          <ul className="mt-3 space-y-1.5 font-display text-base italic text-ink-muted">
            {unresolved.map((entry) => (
              <li key={`${entry.field ?? 'mustDo'}-${entry.span[0]}-${entry.quote}`}>“{entry.quote}”</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="sticky bottom-0 z-10 -mx-5 mt-12 border-t border-rule bg-paper/95 px-5 py-4 backdrop-blur-sm sm:static sm:mx-0 sm:border-t sm:bg-transparent sm:px-0 sm:pt-6 sm:backdrop-blur-none">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
            {/* ONE PRIMARY ACTION. Building the trip is what the interview is for; the board is an optional detour. */}
            {boardAvailable ? (
              <button type="button" onClick={() => onFinish('board')} disabled={pending} className={cx(buttonClass('secondary'), 'flex-1 sm:flex-none')} data-testid="interview-build-board">
                {pending ? 'Opening your board…' : 'Open the Discovery Board'}
              </button>
            ) : researchAvailable ? (
              <button type="button" onClick={() => onFinish('research')} disabled={pending} className={cx(buttonClass('secondary'), 'flex-1 sm:flex-none')} data-testid="interview-research-first">
                Explore experiences first
              </button>
            ) : null}
            <button type="button" onClick={() => onFinish('build')} disabled={pending} className={cx(buttonClass('primary', 'lg'), 'flex-1 sm:flex-none')} data-testid="interview-build-trip">
              {pending ? 'Composing your trip…' : 'Build my trip →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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
                <dt className="label text-ink-faint">{entry.label}</dt>
                <button type="button" onClick={() => onJump(entry.questionId)} className={cx('shrink-0 text-xs text-accent underline underline-offset-4', FOCUS_RING)} data-testid={`review-change-${entry.questionId}`}>
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

/** The trip in a handful of qualitative lines, in the order a traveller would say them. */
function synthesisLines(answers: QuestionnaireAnswers, sketch: ReturnType<typeof sketchFor>): { text: string; assumed: boolean }[] {
  const lines = [...sketch.lines];
  const has = (prefix: string) => lines.some((line) => line.text.startsWith(prefix));
  if (!has('Crowds') && !has('Quiet') && !has('Famous')) {
    lines.push({ text: answers.iconicCrowdStrategy === 'see_it_anyway' ? 'Crowds are fine' : answers.iconicCrowdStrategy === 'quieter_alternative' ? 'Quiet over famous' : 'Famous places at quiet hours', assumed: answers.provenance.iconic_crowds?.source !== 'explicit' });
  }
  // Only what is settled is synthesised; an open question is not a line about the trip.
  const movement = [!sketch.transport.open ? sketch.transport.label : null, !sketch.rangeOpen ? sketch.rangeLabel.toLowerCase() : null].filter(Boolean);
  if (movement.length > 0) lines.push({ text: movement.join(', '), assumed: sketch.transport.assumed && (sketch.rangeOpen || sketch.rangeAssumed) });
  if (!sketch.shapeOpen) lines.push({ text: sketch.shapeLabel, assumed: sketch.shapeAssumed });
  if (answers.provenance.budget?.source === 'explicit') {
    lines.push({ text: answers.budgetStyle === 'budget' ? 'Keeping it cheap' : answers.budgetStyle === 'luxury' ? 'Cost is not a filter' : answers.budgetStyle === 'premium' ? 'Paid experiences welcome' : 'Spend where it matters', assumed: false });
  }
  return lines.slice(0, 7);
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
