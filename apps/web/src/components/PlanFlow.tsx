'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AMBIGUITY_REASON_COPY,
  COMPILATION_STAGE_LABELS,
  COVERAGE_DIMENSION_LABELS,
  COVERAGE_LEVEL_LABELS,
  DESTINATION_ENTITY_TYPE_LABELS,
  type ClarificationQuestion,
  type CoverageReport,
  type DataLicence,
  type DestinationCandidate,
  type GeographicScope,
  type StageRecord,
  WORK_PLAN_DECISION_LABELS,
} from '@sidequest/core';
import { Badge, buttonClass, ErrorNote, Fieldset, FOCUS_RING, OVERLAY_INPUT, Panel, cx } from './ui';
import {
  cancelCompilationAction,
  compilationSnapshotAction,
  confirmScopeAction,
  proposeScopeAction,
  resolveDestinationAction,
  retryCompilationAction,
  saveClarificationAnswersAction,
  selectInterpretationAction,
  startCompilationAction,
  type CompilationSnapshot,
} from '@/app/trips/[id]/plan/actions';

/**
 * The open-world journey, as one screen that knows which step it is on.
 *
 * One component rather than six routes because the step is **derived from what
 * is stored**, not from where the browser happens to be. That makes a refresh
 * free: the server reads the same rows and renders the same step, and there is
 * no URL that can disagree with the database about how far somebody got.
 */

export type PlanStep =
  | 'destination'
  | 'interpretation'
  | 'not_a_place'
  | 'clarification'
  | 'scope'
  | 'compiling'
  | 'ready';

export interface PlanFlowProps {
  tripId: string;
  step: PlanStep;
  destinationQuery: string;
  candidates: DestinationCandidate[];
  ambiguityReasons: string[];
  selectedCandidateId: string | null;
  questions: ClarificationQuestion[];
  answers: { questionId: string; values: string[] }[];
  scope: GeographicScope | null;
  scopeFits: { fits: boolean; reason?: string };
  snapshot: CompilationSnapshot;
  coverage: CoverageReport | null;
  licences: DataLicence[];
  attributions: string[];
  compiledSummary: {
    placeCount: number;
    baseName: string;
    subregionCount: number;
    satelliteCount: number;
    sourceTimestamps: { label: string; url?: string; at?: string }[];
  } | null;
  /**
   * Which snapshot of the world this plan is frozen to.
   *
   * Null for a region compiled before the backbone existed, and for the authored
   * fixture — both of which are honest answers, and neither of which should
   * render a release badge claiming otherwise.
   */
  regionData: {
    releaseId: string;
    catalog: string;
    state: string;
    recordCount: number;
    builtAt: string;
    reused: boolean;
    packId: string;
    contentHash: string;
  } | null;
  /**
   * What this build reused instead of buying again.
   *
   * Null when evidence sharing is off, and that distinction is deliberate: an
   * empty panel would read as "nothing was reused", where the truth is "nothing
   * was shared". Every entry is a decision the compilation made *before* it ran,
   * so this is a record rather than a reconstruction.
   */
  workPlan: { step: string; decision: string; reason: string; items?: number }[] | null;
  providerMessage: string;
  providerReady: boolean;
}

const EYEBROW = 'text-xs uppercase tracking-[0.2em] text-ink-faint';

export function PlanFlow(props: PlanFlowProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);

  // Focus the heading on a step change: this flow changes content without
  // changing URL, so without it a screen-reader user is left where they were.
  useEffect(() => {
    heading.current?.focus();
  }, [props.step]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, fallback: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? fallback);
      else router.refresh();
    });
  }

  /*
   * A div rather than a main: the root layout already provides the one `main`
   * landmark, and nesting a second is invalid HTML that gives assistive
   * technology two competing answers to "where does the content start".
   */
  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <p className={EYEBROW}>Planning</p>
      <h1
        ref={heading}
        tabIndex={-1}
        className="mt-3 font-display text-3xl text-ink outline-none sm:text-4xl"
      >
        {headingFor(props)}
      </h1>

      {props.step === 'destination' ? (
        <DestinationStep {...props} pending={pending} onRun={run} />
      ) : null}
      {props.step === 'interpretation' ? (
        <InterpretationStep {...props} pending={pending} onRun={run} />
      ) : null}
      {props.step === 'not_a_place' ? <NotAPlaceStep {...props} /> : null}
      {props.step === 'clarification' ? (
        <ClarificationStep {...props} pending={pending} onRun={run} />
      ) : null}
      {props.step === 'scope' ? <ScopeStep {...props} pending={pending} onRun={run} /> : null}
      {props.step === 'compiling' ? <CompilingStep {...props} pending={pending} onRun={run} /> : null}
      {props.step === 'ready' ? <ReadyStep {...props} /> : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function headingFor(props: PlanFlowProps): string {
  switch (props.step) {
    case 'destination':
      return `Reading “${props.destinationQuery}”`;
    case 'interpretation':
      return `“${props.destinationQuery}” — which one?`;
    case 'not_a_place':
      return 'Where should we start looking?';
    case 'clarification':
      return props.questions.length === 1 ? 'One thing first' : 'A few things first';
    case 'scope':
      return 'Here is what we are about to do';
    case 'compiling':
      return 'Building your region';
    case 'ready':
      return 'What this trip is built on';
  }
}

type StepProps = PlanFlowProps & {
  pending: boolean;
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>, fallback: string) => void;
};

function DestinationStep({ tripId, destinationQuery, pending, onRun, providerReady, providerMessage }: StepProps) {
  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted">
        We will work out what that means and show you our reading before we spend any time on it.
      </p>

      {!providerReady ? (
        <Panel className="mt-6 border-amber bg-amber-soft p-4 text-sm leading-relaxed text-ink">
          {providerMessage}
        </Panel>
      ) : null}

      <Panel className="mt-6 p-5 sm:p-6">
        <p className="text-sm text-ink-muted">You typed</p>
        <p className="mt-1 font-display text-xl text-ink">{destinationQuery}</p>
        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
          We look this up once, when you press the button — never as you type. The map service we use
          asks that of everyone, and it is a reasonable thing to ask.
        </p>
      </Panel>

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={pending || !providerReady}
          onClick={() => onRun(() => resolveDestinationAction(tripId), 'We could not look that up.')}
        >
          {pending ? 'Reading…' : 'Read this'}
        </button>
      </div>
    </>
  );
}

function InterpretationStep({
  tripId,
  candidates,
  ambiguityReasons,
  pending,
  onRun,
}: StepProps) {
  const [chosen, setChosen] = useState<string>(candidates[0]?.id ?? '');

  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted">
        Names are shared and regions overlap. Pick the reading that matches the trip you have in your
        head.
      </p>

      {ambiguityReasons.length > 0 ? (
        <ul className="mt-4 space-y-1 text-sm text-ink-muted">
          {ambiguityReasons.map((reason) => (
            <li key={reason}>{AMBIGUITY_REASON_COPY[reason as keyof typeof AMBIGUITY_REASON_COPY]}</li>
          ))}
        </ul>
      ) : null}

      <Fieldset legend="Which reading is right?" className="mt-6">
        <div className="grid gap-3 sm:grid-cols-2">
          {candidates.map((candidate) => (
            <label
              key={candidate.id}
              className={cx(
                'relative flex flex-col rounded-[var(--radius-card)] border p-4 text-left',
                FOCUS_RING,
                chosen === candidate.id ? 'border-pine ring-1 ring-pine' : 'border-rule',
              )}
            >
              <input
                type="radio"
                name="interpretation"
                value={candidate.id}
                className={OVERLAY_INPUT}
                checked={chosen === candidate.id}
                onChange={() => setChosen(candidate.id)}
              />
              <span className="font-display text-lg leading-snug text-ink">
                {candidate.displayName}
              </span>
              <span className="mt-1 text-xs text-ink-faint">{candidate.qualifiedName}</span>
              <span className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{DESTINATION_ENTITY_TYPE_LABELS[candidate.entityType]}</Badge>
                <Badge tone={candidate.confidence.level === 'high' ? 'pine' : 'amber'}>
                  {candidate.confidence.level === 'high'
                    ? 'Well corroborated'
                    : candidate.confidence.level === 'medium'
                      ? 'Reasonably sure'
                      : 'Not sure'}
                </Badge>
                {candidate.bounds ? <Badge tone="pine">Has a boundary</Badge> : <Badge tone="amber">No boundary</Badge>}
              </span>
              <span className="mt-3 text-[11px] leading-relaxed text-ink-faint">
                {candidate.confidence.note}
              </span>
              {candidate.providerRefs[0]?.url ? (
                <a
                  href={candidate.providerRefs[0].url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 text-[11px] underline underline-offset-2 text-ink-faint"
                >
                  Source: OpenStreetMap {candidate.providerRefs[0].externalId}
                </a>
              ) : null}
            </label>
          ))}
        </div>
      </Fieldset>

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={pending || chosen === ''}
          onClick={() =>
            onRun(
              () => selectInterpretationAction(tripId, chosen),
              'We could not save that choice.',
            )
          }
        >
          {pending ? 'Saving…' : 'That is the one'}
        </button>
      </div>
    </>
  );
}

function NotAPlaceStep({ destinationQuery }: PlanFlowProps) {
  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted">
        “{destinationQuery}” reads more like the kind of trip you want than somewhere on a map. Name a
        town, a region or a country and we will build outwards from it.
      </p>
      <Panel className="mt-6 border-dashed p-4 text-sm leading-relaxed text-ink-muted">
        We would rather ask than guess. Picking the nearest thing with a similar name is how a trip to
        a region becomes a trip to a lake that happens to share a word with it.
      </Panel>
      <div className="mt-8">
        <a className={buttonClass('primary')} href="/trips/new">
          Start again with a place
        </a>
      </div>
    </>
  );
}

function ClarificationStep({ tripId, questions, answers, pending, onRun }: StepProps) {
  const [given, setGiven] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(answers.map((answer) => [answer.questionId, answer.values])),
  );

  const missing = questions.filter(
    (question) => question.required && (given[question.id]?.length ?? 0) === 0,
  );

  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted">
        These change the answer, so we would rather ask than guess.
      </p>

      <div className="mt-8 space-y-8">
        {questions.map((question) => (
          <Fieldset key={question.id} legend={question.question} hint={question.whyItMatters}>
            <div className="grid gap-2 sm:grid-cols-2">
              {question.options.map((option) => {
                const selected = (given[question.id] ?? []).includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={cx(
                      'relative flex flex-col rounded-lg border p-3.5 text-left',
                      FOCUS_RING,
                      selected ? 'border-pine ring-1 ring-pine' : 'border-rule',
                    )}
                  >
                    <input
                      type="radio"
                      name={question.id}
                      value={option.value}
                      className={OVERLAY_INPUT}
                      checked={selected}
                      onChange={() =>
                        setGiven((current) => ({ ...current, [question.id]: [option.value] }))
                      }
                    />
                    <span className="text-sm font-medium text-ink">{option.label}</span>
                    {option.detail ? (
                      <span className="mt-1 text-xs text-ink-muted">{option.detail}</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {question.answerType === 'text' ? (
              <input
                type="text"
                name={question.id}
                defaultValue={given[question.id]?.[0] ?? ''}
                onChange={(event) =>
                  setGiven((current) => ({ ...current, [question.id]: [event.target.value] }))
                }
                className="mt-2 w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-ink placeholder:text-ink-faint"
              />
            ) : null}
          </Fieldset>
        ))}
      </div>

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-rule pt-6">
        <span className="text-xs text-ink-faint">Saved as you go</span>
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={pending || missing.length > 0}
          onClick={() =>
            onRun(async () => {
              const saved = await saveClarificationAnswersAction(
                tripId,
                Object.entries(given).map(([questionId, values]) => ({ questionId, values })),
              );
              if (!saved.ok) return saved;
              return proposeScopeAction(tripId);
            }, 'We could not save those answers.')
          }
        >
          {pending ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </>
  );
}

function ScopeStep({ tripId, scope, scopeFits, pending, onRun }: StepProps) {
  if (!scope) return null;

  const shape = scope.shape;
  const reach =
    shape.kind === 'radius'
      ? `about ${Math.round(shape.radiusKm)} km out from ${scope.destinationName}`
      : shape.kind === 'bounds'
        ? 'the published boundary of that area'
        : shape.kind === 'corridor'
          ? 'a corridor along the route'
          : `${shape.areas.length} named areas`;

  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted">
        Everything after this costs time and looks things up. Check it first.
      </p>

      <Panel className="mt-6 p-5 sm:p-6">
        <dl className="space-y-4 text-sm">
          <Row label="Region" value={scope.destinationName} />
          <Row label="How far" value={reach} />
          <Row label="Bases" value={scope.maxBaseChanges === 0 ? 'One, for the whole trip' : `Up to ${scope.maxBaseChanges + 1}`} />
          <Row label="Getting around" value={scope.transport.note} />
          <Row label="Time zone" value={scope.timeZones.join(', ')} />
          <Row label="Why this" value={scope.rationale} />
        </dl>
      </Panel>

      <Panel className="mt-4 border-dashed p-4 text-sm leading-relaxed text-ink-muted">
        What we will not do: book anything, price anything, or claim a road is open because it usually
        is. Anything we cannot confirm comes back saying so.
      </Panel>

      {!scopeFits.fits ? (
        <Panel className="mt-4 border-clay p-4 text-sm leading-relaxed text-ink">
          {scopeFits.reason}
        </Panel>
      ) : null}

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-rule pt-6">
        <button
          type="button"
          className={buttonClass('ghost')}
          disabled={pending}
          onClick={() => onRun(() => proposeScopeAction(tripId), 'We could not redo that.')}
        >
          Rework it
        </button>
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={pending || !scopeFits.fits}
          onClick={() =>
            onRun(async () => {
              const confirmed = await confirmScopeAction(tripId);
              if (!confirmed.ok) return confirmed;
              return startCompilationAction(tripId);
            }, 'We could not start that just then.')
          }
        >
          {pending ? 'Starting…' : 'Build the region'}
        </button>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="sm:flex sm:gap-4">
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint sm:w-40 sm:shrink-0">
        {label}
      </dt>
      <dd className="mt-1 min-w-0 text-ink sm:mt-0">{value}</dd>
    </div>
  );
}

const STATE_TONE: Record<StageRecord['status'], 'pine' | 'blue' | 'amber' | 'neutral' | 'clay'> = {
  done: 'pine',
  running: 'blue',
  waiting: 'neutral',
  skipped: 'amber',
  failed: 'clay',
};

const STATE_LABEL: Record<StageRecord['status'], string> = {
  done: 'Done',
  running: 'Working',
  waiting: 'Waiting',
  skipped: 'Skipped',
  failed: 'Failed',
};

function CompilingStep({ tripId, snapshot, pending, onRun }: StepProps) {
  const router = useRouter();
  const [live, setLive] = useState<CompilationSnapshot>(snapshot);

  /**
   * Polling, because the durable state is a row and only the server can read it.
   *
   * It stops the moment the job reaches a terminal state, so a finished
   * compilation is not a background timer nobody turned off.
   */
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    const running = live.state === 'queued' || live.state === 'running';
    // `none` means the scope is confirmed but no job row has appeared yet. That
    // is normally a fraction of a second, so it is polled — but only briefly.
    // An unbounded poll on a job that never starts is a timer nobody turned off,
    // and the honest answer after a few seconds is the "Start building" button.
    const settling = live.state === 'none' && polls < 5;
    if (!running && !settling) return;

    const timer = setInterval(async () => {
      const next = await compilationSnapshotAction(tripId);
      setPolls((count) => count + 1);
      setLive(next);
      if (next.state === 'ready' || next.state === 'partial') router.refresh();
    }, 1200);
    return () => clearInterval(timer);
  }, [tripId, live.state, polls, router]);

  const done = live.stages.filter((stage) => stage.status === 'done').length;
  const failed = live.state === 'failed' || live.state === 'cancelled';
  // Confirmed, but no job row yet: either the start is still in flight, or a
  // process died between the two. Offering to start is honest and idempotent —
  // the unique index means a second press cannot create a second job.
  const notStarted = live.state === 'none';

  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted" aria-live="polite">
        {failed
          ? (live.errorMessage ?? 'That stopped before it finished.')
          : notStarted
            ? 'Ready to start.'
            : `${done} of ${live.stages.length} steps done.`}
      </p>

      <Panel className="mt-6 p-5 sm:p-6">
        <ol className="space-y-3">
          {live.stages.map((stage) => (
            <li key={stage.stage} className="flex items-baseline gap-3">
              <Badge tone={STATE_TONE[stage.status]}>{STATE_LABEL[stage.status]}</Badge>
              <span className="min-w-0 flex-1">
                <span className="text-sm text-ink">{COMPILATION_STAGE_LABELS[stage.stage]}</span>
                {stage.outcome ? (
                  <span className="block text-xs text-ink-muted">{stage.outcome}</span>
                ) : null}
                {stage.note ? (
                  <span className="block text-xs text-amber">{stage.note}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </Panel>

      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
        No percentage here on purpose: several of these take as long as somebody else’s server takes,
        and a bar moving at a rate nobody can predict is a lie told with an animation.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        {notStarted ? (
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={pending}
            onClick={() => onRun(() => startCompilationAction(tripId), 'That did not start.')}
          >
            {pending ? 'Starting…' : 'Start building'}
          </button>
        ) : null}
        {failed && live.retryable ? (
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={pending}
            onClick={() => onRun(() => retryCompilationAction(tripId), 'That did not start.')}
          >
            {pending ? 'Starting…' : 'Try again'}
          </button>
        ) : null}
        {!failed ? (
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={pending}
            onClick={() => onRun(() => cancelCompilationAction(tripId), 'We could not stop that.')}
          >
            Stop
          </button>
        ) : null}
        <a className={buttonClass('secondary')} href={`/trips/${tripId}/plan`}>
          Refresh
        </a>
      </div>
    </>
  );
}

/**
 * Where the region's place data came from, and how old it is.
 *
 * Collapsed, because a normal user page is not a database console — and present,
 * because a plan built on a snapshot that a traveller cannot name is a plan they
 * cannot check. Everything in here is read from the stored artifact, so it is as
 * available offline as the plan itself.
 */
function RegionDataPanel({ data }: { data: NonNullable<PlanFlowProps['regionData']> }) {
  const built = data.builtAt.slice(0, 10);
  return (
    <details className="mt-6" data-testid="region-data">
      <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
        Regional place data — {data.catalog} release {data.releaseId}
      </summary>
      <Panel className="mt-3 p-4">
        <p className="text-sm leading-relaxed text-ink-muted">
          This plan is frozen to a snapshot of the world taken on {built}. Newer data will not change
          it; rebuilding the region is what picks up a newer release, and that produces a new plan
          rather than editing this one.
        </p>
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Release" value={`${data.catalog} ${data.releaseId}`} />
          <Row label="Prepared" value={`${built}${data.reused ? ', already held' : ''}`} />
          <Row label="Records" value={`${data.recordCount} in the regional data`} />
          <Row
            label="Completeness"
            value={
              data.state === 'partial'
                ? 'Some areas could not be read when this was prepared'
                : 'Every area we planned to read was read'
            }
          />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          {data.packId} · {data.contentHash}
        </p>
      </Panel>
    </details>
  );
}

/**
 * WHAT THIS BUILD DID NOT HAVE TO DO.
 *
 * Collapsed and last, because it is an operator's question rather than a
 * traveller's. It is here at all because "why was this one fast" needs an answer
 * that is a record rather than a guess — and because a reuse figure sitting
 * beside the coverage report is the only place somebody would notice if the two
 * ever disagreed.
 *
 * Deliberately shows *operations*, never a confidence. Reuse makes a run cheap
 * and is not allowed to make anything more certain, so nothing in this panel
 * touches a verification state or a coverage level.
 */
function WorkPlanPanel({ entries }: { entries: NonNullable<PlanFlowProps['workPlan']> }) {
  if (entries.length === 0) return null;
  return (
    <details className="mt-4" data-testid="work-plan">
      <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
        What this build reused
      </summary>
      <Panel className="mt-3 p-4">
        <ul className="space-y-2 text-sm">
          {entries.map((entry) => (
            <li key={entry.step}>
              <span className="text-ink">{stepLabel(entry.step)}</span>
              <span className="text-ink-faint"> — {WORK_PLAN_DECISION_LABELS[
                entry.decision as keyof typeof WORK_PLAN_DECISION_LABELS
              ] ?? entry.decision}</span>
              <p className="text-ink-muted">{entry.reason}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </details>
  );
}

/**
 * The traveller-facing name for a work-plan step.
 *
 * Read from the one stage vocabulary rather than a second copy of it: a local
 * map drifts silently, and the way it fails is that a newly-added stage appears
 * to a traveller as a raw identifier — which is exactly how `reusing_shared_claims`
 * first reached this panel.
 */
function stepLabel(step: string): string {
  return (
    COMPILATION_STAGE_LABELS[step as keyof typeof COMPILATION_STAGE_LABELS] ??
    step.replaceAll('_', ' ')
  );
}

function ReadyStep({
  tripId,
  coverage,
  licences,
  attributions,
  compiledSummary,
  snapshot,
  regionData,
  workPlan,
}: PlanFlowProps) {
  if (!coverage || !compiledSummary) return null;
  const weak = coverage.dimensions.filter(
    (entry) => entry.level === 'weak' || entry.level === 'unavailable',
  );

  return (
    <>
      <p className="mt-3 max-w-xl text-ink-muted">
        Everything below is a claim with a source. Where there is no source, we say that instead of
        filling the gap.
      </p>

      {snapshot.state === 'partial' ? (
        <Panel className="mt-6 border-amber bg-amber-soft p-4 text-sm leading-relaxed text-ink">
          This came back incomplete. It is usable, and the gaps are listed below rather than hidden.
        </Panel>
      ) : null}

      <Panel className="mt-6 p-5 sm:p-6">
        <dl className="space-y-4 text-sm">
          <Row label="Base" value={compiledSummary.baseName} />
          <Row label="Places" value={`${compiledSummary.placeCount} kept`} />
          <Row
            label="Nearby"
            value={`${compiledSummary.satelliteCount} side trips across ${compiledSummary.subregionCount || 1} area${compiledSummary.subregionCount === 1 ? '' : 's'}`}
          />
        </dl>
      </Panel>

      <section className="mt-10 border-t border-rule pt-8" aria-labelledby="coverage-heading">
        <h2 id="coverage-heading" className="font-display text-2xl text-ink">
          What this is built on
        </h2>
        <p className="mt-2 text-sm text-ink-muted">{coverage.summary}</p>

        <dl className="mt-6 divide-y divide-rule">
          {coverage.dimensions.map((entry) => (
            <div key={entry.dimension} className="py-3 sm:flex sm:gap-4">
              <dt className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-ink-faint sm:w-44 sm:shrink-0">
                {COVERAGE_DIMENSION_LABELS[entry.dimension]}
              </dt>
              <dd className="mt-1 min-w-0 flex-1 sm:mt-0">
                <Badge
                  tone={
                    entry.level === 'high'
                      ? 'pine'
                      : entry.level === 'usable_with_cautions'
                        ? 'amber'
                        : entry.level === 'not_applicable'
                          ? 'neutral'
                          : 'clay'
                  }
                >
                  {COVERAGE_LEVEL_LABELS[entry.level]}
                </Badge>
                <span className="mt-1 block text-sm text-ink-muted">{entry.detail}</span>
              </dd>
            </div>
          ))}
        </dl>

        {weak.length > 0 ? (
          <Panel className="mt-6 border-dashed p-4">
            <p className="text-sm font-medium text-ink">What we could not do</p>
            <ul className="mt-2 space-y-1 text-sm text-ink-muted">
              {weak.map((entry) => (
                <li key={entry.dimension}>
                  {COVERAGE_DIMENSION_LABELS[entry.dimension]}: {entry.detail}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </section>

      <section className="mt-10 border-t border-rule pt-8" aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="font-display text-2xl text-ink">
          Sources
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-ink-muted">
          {licences.map((entry) => (
            <li key={entry.id}>
              <span className="text-ink">{entry.attribution}</span>
              <span className="text-ink-faint">
                {' '}
                — {entry.name}
                {entry.appliesTo.length > 0 ? ` (${entry.appliesTo.join(', ')})` : ''}
                {entry.shareAlike ? ', share-alike' : ''}
              </span>
              {entry.url ? (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1 underline underline-offset-2"
                >
                  licence
                </a>
              ) : null}
            </li>
          ))}
        </ul>

        {compiledSummary.sourceTimestamps.length > 0 ? (
          <ul className="mt-4 space-y-1 text-[11px] leading-relaxed text-ink-faint">
            {compiledSummary.sourceTimestamps.slice(0, 4).map((entry) => (
              <li key={entry.label}>
                {entry.url ? (
                  <a href={entry.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    {entry.label}
                  </a>
                ) : (
                  entry.label
                )}
                {entry.at ? ` — last edited ${entry.at.slice(0, 10)}` : ''}
              </li>
            ))}
          </ul>
        ) : null}

        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint" data-testid="attribution-line">
          {attributions.join(' · ')}. Conditions change; we have not checked today.
        </p>

        {regionData ? <RegionDataPanel data={regionData} /> : null}
        {workPlan ? <WorkPlanPanel entries={workPlan} /> : null}
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-rule pt-6">
        <a className={buttonClass('primary')} href={`/trips/${tripId}/questionnaire`}>
          Tell us how you travel
        </a>
        <a className={buttonClass('secondary')} href={`/trips/${tripId}/discover`}>
          Skip to the board
        </a>
      </div>
    </>
  );
}
