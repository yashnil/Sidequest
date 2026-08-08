'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AMBIGUITY_REASON_COPY,
  COVERAGE_DIMENSION_LABELS,
  COVERAGE_LEVEL_LABELS,
  DESTINATION_ENTITY_TYPE_LABELS,
  SUPPLY_ACTION_LABELS,
  SUPPLY_LEVEL_LABELS,
  classifyObservedSpan,
  confidenceExplanation,
  stageLabel,
  summaryVersion,
  type ClarificationQuestion,
  type CoverageReport,
  type DataLicence,
  type DestinationCandidate,
  type GeographicScope,
  type DisplayName,
  type RoutingDiagnostics,
  type StageRecord,
  type StoredBasePortfolio,
  type TripPreflight,
  WORK_PLAN_DECISION_LABELS,
} from '@sidequest/core';
import {
  Badge,
  buttonClass,
  Choice,
  ChoiceGroup,
  ErrorNote,
  Fieldset,
  FOCUS_RING,
  OVERLAY_INPUT,
  EvidenceBadge,
  PageHeading,
  Panel,
  PlaceName,
  cx,
} from './ui';
import { CompilationProgress, StageDisclosure } from './CompilationProgress';
import { ScopePreview } from './ScopePreview';
import {
  adoptDateWindowAction,
  adoptTripLengthAction,
  applyStrategyAction,
  cancelCompilationAction,
  ensurePreflightAction,
  compilationSnapshotAction,
  confirmScopeAction,
  proposeScopeAction,
  resolveDestinationAction,
  retryCompilationAction,
  saveClarificationAnswersAction,
  selectInterpretationAction,
  startCompilationAction,
  type CompilationSnapshot,
} from '@/app/(product)/trips/[id]/plan/actions';

/**
 * The open-world journey, as one screen that knows which step it is on.
 *
 * One component rather than six routes because the step is **derived from what
 * is stored**, not from where the browser happens to be. That makes a refresh
 * free: the server reads the same rows and renders the same step, and there is
 * no URL that can disagree with the database about how far somebody got.
 *
 * WHAT PHASE 11 CHANGED, AND WHY.
 *
 * The journey used to be: submit → a screen saying "Reading Kyrgyzstan" with a
 * button on it → a screen headed "Kyrgyzstan — which one?" showing one card →
 * "That is the one" → questions → scope → four minutes of build log → "there is
 * not enough here to plan on". Four clicks and two screens before anything was
 * decided, and the one screen that mattered came last.
 *
 * Now: a destination picked from the index arrives already identified and lands
 * straight on **preflight**, which is free, takes seconds, and shows the region,
 * the areas, the dates and whether there is enough here — *before* anything is
 * bought. Interpretation appears only when there genuinely is a choice to make.
 */

/**
 * The smallest a control on this screen may be.
 *
 * WCAG 2.5.5's 44 px. The two inline "adopt this instead" controls — moving the
 * dates, changing the length — were bare underlined text about sixteen pixels
 * tall, sitting inside a card of other text. They are the only way to act on
 * what those panels recommend, which makes them the least appropriate controls
 * in the product to have been the smallest.
 */
const MIN_TARGET = 'min-h-11';

export type PlanStep =
  | 'destination'
  | 'interpretation'
  | 'not_a_place'
  | 'preflight'
  | 'clarification'
  | 'scope'
  | 'compiling'
  | 'ready';

export interface PlanFlowProps {
  tripId: string;
  step: PlanStep;
  destinationQuery: string;
  /** The name to lead with: the selected index row, or the typed string. */
  destinationName: string;
  candidates: DestinationCandidate[];
  ambiguityReasons: string[];
  selectedCandidateId: string | null;
  preflight: TripPreflight | null;
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
    /** Resolved English-first name for the base, when the artifact carries one. */
    baseNames?: DisplayName;
    subregionCount: number;
    satelliteCount: number;
    sourceTimestamps: { label: string; url?: string; at?: string }[];
  } | null;
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
  /** How the trip is structured across bases. Null for a single-base region. */
  basePortfolio: StoredBasePortfolio | null;
  /** What routing cost, for the technical panel. Never mixed into coverage. */
  routingDiagnostics: RoutingDiagnostics | null;
  workPlan: { step: string; decision: string; reason: string; items?: number }[] | null;
  providerMessage: string;
  providerReady: boolean;
}

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

  const wide = props.step === 'preflight' || props.step === 'ready' || props.step === 'compiling';

  /*
   * A div rather than a main: the root layout already provides the one `main`
   * landmark, and nesting a second is invalid HTML that gives assistive
   * technology two competing answers to "where does the content start".
   */
  return (
    <div
      className={cx(
        'mx-auto px-5 py-10 sm:px-8 sm:py-14',
        wide ? 'max-w-6xl' : 'max-w-3xl',
      )}
    >
      <PageHeading eyebrow="Planning" title={headingFor(props)} headingRef={heading} />

      <div className="mt-8">
        {props.step === 'destination' ? <DestinationStep {...props} pending={pending} onRun={run} /> : null}
        {props.step === 'interpretation' ? (
          <InterpretationStep {...props} pending={pending} onRun={run} />
        ) : null}
        {props.step === 'not_a_place' ? <NotAPlaceStep {...props} /> : null}
        {props.step === 'preflight' ? <PreflightStep {...props} pending={pending} onRun={run} /> : null}
        {props.step === 'clarification' ? (
          <ClarificationStep {...props} pending={pending} onRun={run} />
        ) : null}
        {props.step === 'scope' ? <ScopeStep {...props} pending={pending} onRun={run} /> : null}
        {props.step === 'compiling' ? <CompilingStep {...props} pending={pending} onRun={run} /> : null}
        {props.step === 'ready' ? <ReadyStep {...props} /> : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function headingFor(props: PlanFlowProps): string {
  switch (props.step) {
    case 'destination':
      return `Looking up “${props.destinationQuery}”`;
    case 'interpretation':
      return `More than one place is called “${props.destinationQuery}”`;
    case 'not_a_place':
      return 'Where should we start looking?';
    case 'preflight':
      return `${props.destinationName}, as we read it`;
    case 'clarification':
      return props.questions.length === 1 ? 'One thing first' : 'A few things first';
    case 'scope':
      return 'Here is what we are about to do';
    case 'compiling':
      return `Building ${props.destinationName}`;
    case 'ready':
      return 'What this trip is built on';
  }
}

type StepProps = PlanFlowProps & {
  pending: boolean;
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>, fallback: string) => void;
};

/**
 * The lookup, which is now a state rather than a screen with a button on it.
 *
 * Reached only when the traveller typed something the index did not hold. The
 * request fires once on mount rather than on a click: there is no decision to
 * make here, and a button whose only possible answer is "yes, do the thing I
 * already asked for" is a click that exists because the code needed one.
 *
 * Still exactly one request. The geocoder's policy forbids autocomplete, and
 * this is not autocomplete — it is one explicit lookup of one submitted string.
 */
function DestinationStep({
  tripId,
  destinationQuery,
  pending,
  onRun,
  providerReady,
  providerMessage,
}: StepProps) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !providerReady) return;
    fired.current = true;
    onRun(() => resolveDestinationAction(tripId), 'We could not look that up.');
  }, [tripId, providerReady, onRun]);

  if (!providerReady) {
    return (
      <>
        <Panel className="border-amber bg-amber-soft p-4 text-sm leading-relaxed text-ink">
          {providerMessage}
        </Panel>
        <p className="mt-4 text-sm text-ink-muted">
          You typed <strong className="font-medium text-ink">{destinationQuery}</strong>.
        </p>
      </>
    );
  }

  return (
    <Panel className="p-6">
      <p className={cx('text-ink-muted', pending && 'breathing')} aria-live="polite">
        Working out what <strong className="font-medium text-ink">{destinationQuery}</strong> means.
        One lookup, and then we will show you our reading.
      </p>
    </Panel>
  );
}

/**
 * The disambiguation screen — which now only appears when there is a genuine
 * choice between places, never because a destination happens to be large.
 */
function InterpretationStep({ tripId, candidates, ambiguityReasons, pending, onRun }: StepProps) {
  const [chosen, setChosen] = useState<string>(candidates[0]?.id ?? '');

  return (
    <>
      <p className="measure text-ink-muted">
        These are far enough apart that picking the wrong one would build a trip on the wrong
        continent. Which did you mean?
      </p>

      {/*
        Only the reasons we have a sentence for. An unmapped code rendered an
        empty bullet, which reads as a claim somebody forgot to finish.
      */}
      {ambiguityReasons.some((reason) => ambiguityCopy(reason)) ? (
        <ul className="mt-4 space-y-1 text-sm text-ink-muted">
          {ambiguityReasons
            .map((reason) => [reason, ambiguityCopy(reason)] as const)
            .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
            .map(([reason, copy]) => (
              <li key={reason}>{copy}</li>
            ))}
        </ul>
      ) : null}

      <Fieldset legend="Which one?" className="mt-6">
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
              <span className="mt-0.5 text-sm text-ink-muted">{candidate.qualifiedName}</span>
              <span className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{DESTINATION_ENTITY_TYPE_LABELS[candidate.entityType]}</Badge>
                {candidate.bounds ? null : <Badge tone="amber">Edges not published</Badge>}
              </span>
              {/*
                The reason leads; the label follows.

                A bare "Not sure" badge told a traveller we were uncertain and
                gave them nothing to do with that. What they can act on is *why*.
              */}
              <span className="mt-3 text-xs leading-relaxed text-ink-muted">
                {confidenceExplanation(candidate)}
              </span>
              {candidate.providerRefs[0]?.url ? (
                <a
                  href={candidate.providerRefs[0].url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 text-[11px] text-ink-faint underline underline-offset-2"
                >
                  Source: OpenStreetMap {candidate.providerRefs[0].externalId}
                </a>
              ) : null}
            </label>
          ))}
        </div>
      </Fieldset>

      <div className="mt-8">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={pending || chosen === ''}
          onClick={() =>
            onRun(() => selectInterpretationAction(tripId, chosen), 'We could not save that choice.')
          }
        >
          {pending ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </>
  );
}

/** The sentence for an ambiguity code, or nothing. Never the code. */
function ambiguityCopy(reason: string): string | null {
  return (AMBIGUITY_REASON_COPY as Record<string, string | undefined>)[reason] ?? null;
}

function NotAPlaceStep({ destinationQuery }: PlanFlowProps) {
  return (
    <>
      <p className="measure text-ink-muted">
        “{destinationQuery}” reads more like the kind of trip you want than somewhere on a map. Name
        a town, a region or a country and we will build outwards from it.
      </p>
      <Panel className="mt-6 border-dashed p-4 text-sm leading-relaxed text-ink-muted">
        We would rather ask than guess. Picking the nearest thing with a similar name is how a trip
        to a region becomes a trip to a lake that happens to share a word with it.
      </Panel>
      <div className="mt-8">
        <a className={buttonClass('primary')} href="/trips/new">
          Start again with a place
        </a>
      </div>
    </>
  );
}

/**
 * THE NEW SCREEN, AND THE POINT OF THE WHOLE PHASE.
 *
 * Free, fast, and before anything is bought. It answers the four questions a
 * traveller actually has at this moment — *did it understand where I mean, how
 * much of it can I do, when should I go, is there anything there* — using the
 * local index and one cached climate lookup.
 *
 * Nothing on this screen is evidence, and the copy says so wherever a number
 * could be mistaken for one.
 */
function PreflightStep({ tripId, preflight, destinationName, pending, onRun }: StepProps) {
  const [strategy, setStrategy] = useState<string>('');
  const requested = useRef(false);

  /*
   * Computed on mount rather than during render.
   *
   * The preflight makes one climate request and several local queries. Doing
   * that inside a server component would be hidden I/O on a page render — the
   * exact thing the architecture tests forbid — and doing it in the action that
   * created the trip would put a network round trip in front of the redirect.
   * Once, on arrival, with a visible state while it runs.
   */
  useEffect(() => {
    if (preflight || requested.current) return;
    requested.current = true;
    onRun(() => ensurePreflightAction(tripId), 'We could not read that region.');
  }, [tripId, preflight, onRun]);

  if (!preflight) {
    return (
      <Panel className="p-6">
        <p className="text-ink-muted breathing" aria-live="polite">
          Reading the region…
        </p>
      </Panel>
    );
  }

  const { portfolio, strategies, dates, duration, supply } = preflight;
  const blocked = supply?.level === 'insufficient' || supply?.level === 'infrastructure_failure';

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12">
      <div className="space-y-8">
        {supply ? <SupplyPanel supply={supply} /> : null}

        {!portfolio && !supply ? (
          <Panel className="border-dashed p-5" testId="no-index-coverage">
            <p className="text-ink">
              We have no local place index for {destinationName}, so there is nothing to show you
              yet at this stage.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              That is a gap in what this deployment holds, not a statement about the destination.
              The region build reads the map data directly and will tell you what is actually there.
            </p>
          </Panel>
        ) : null}

        {strategies.length > 0 && !blocked ? (
          <section aria-labelledby="strategy-heading">
            <h2 id="strategy-heading" className="font-display text-2xl text-ink">
              How would you like to take on {destinationName}?
            </h2>
            <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
              This decides where we look at all. Every option below is one the areas we found can
              actually support — the ones your dates cannot afford are shown with the reason rather
              than hidden.
            </p>

            <ChoiceGroup legend="Pick a shape" columns={2} className="mt-5">
              {strategies.map((option) => (
                <Choice
                  key={option.id}
                  name="strategy"
                  value={option.id}
                  checked={strategy === option.id}
                  disabled={!option.available}
                  onChange={() => setStrategy(option.id)}
                  label={option.label}
                  detail={
                    option.available
                      ? option.covers.length > 0
                        ? `${option.detail} — ${option.covers.join(', ')}`
                        : option.detail
                      : option.unavailableReason
                  }
                />
              ))}
            </ChoiceGroup>
          </section>
        ) : null}

        {duration && duration.kind === 'recommended' ? (
          <section aria-labelledby="duration-heading">
            <h2 id="duration-heading" className="font-display text-xl text-ink">
              How long it wants to be
            </h2>
            <p className="mt-1.5 text-sm text-ink-muted">{duration.basis}</p>
            <ul className="mt-3 divide-y divide-rule">
              {duration.options.map((option) => (
                <li key={option.label} className="flex flex-wrap gap-x-4 gap-y-1 py-3">
                  <span className="w-24 shrink-0 font-medium text-ink">
                    {option.minNights}–{option.maxNights} nights
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="text-ink">{option.label}</span>
                    {/*
                      The badge says what is actually true of the marked option:
                      it is the one that fits the nights the traveller has. It
                      used to read "best value for the ground", which was both a
                      stronger claim and — because the metric behind it was
                      degenerate — always on the shortest option.
                    */}
                    {option.recommended ? (
                      <Badge tone="pine">
                        <span className="ml-0.5">Fits your dates</span>
                      </Badge>
                    ) : null}
                    <span className="mt-0.5 block text-ink-muted">{option.covers}</span>
                    <span className="mt-0.5 block text-ink-faint">{option.tradeoff}</span>
                    {!option.recommended ? (
                      <button
                        type="button"
                        className={cx(
                          'mt-1 inline-flex items-center text-xs text-pine underline underline-offset-2 disabled:opacity-50',
                          MIN_TARGET,
                        )}
                        disabled={pending}
                        onClick={() =>
                          onRun(
                            () => adoptTripLengthAction(tripId, option.maxNights),
                            'We could not change the length.',
                          )
                        }
                      >
                        Make it {option.maxNights} nights
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : duration?.kind === 'unavailable' ? (
          <p className="text-sm text-ink-muted">{duration.note}</p>
        ) : null}

        {dates ? <DatesPanel dates={dates} tripId={tripId} pending={pending} onRun={onRun} /> : null}
      </div>

      <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        {portfolio && portfolio.route.length > 0 ? (
          <Panel className="p-5">
            <p className="eyebrow">The region</p>
            <div className="mt-3">
              <ScopePreview portfolio={portfolio} title={destinationName} />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-muted">{portfolio.rationale}</p>
            <dl className="mt-4 space-y-2.5 border-t border-rule pt-4 text-sm">
              <Row
                label="Bases"
                value={`${portfolio.basesProposed}${portfolio.gateway ? `, starting at ${portfolio.gateway.name}` : ''}`}
              />
              <Row
                label="Moving"
                value={`about ${portfolio.transferDays} day${portfolio.transferDays === 1 ? '' : 's'} in transfers (estimated)`}
              />
              <Row
                label="Getting around"
                value={
                  portfolio.mode === 'drive'
                    ? 'Planned around a car'
                    : portfolio.mode === 'transit'
                      ? 'Public transport and transfers'
                      : 'On foot'
                }
              />
            </dl>
            {portfolio.excluded.length > 0 ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
                  {portfolio.excluded.length} area
                  {portfolio.excluded.length === 1 ? '' : 's'} left out
                </summary>
                <ul className="mt-2 space-y-2 text-sm">
                  {portfolio.excluded.slice(0, 6).map((entry) => (
                    <li key={entry.cluster.id}>
                      <span className="text-ink">{entry.cluster.name}</span>
                      <span className="block text-xs leading-relaxed text-ink-muted">
                        {entry.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Panel>
        ) : null}

        <Panel className="border-dashed p-4">
          <p className="text-xs leading-relaxed text-ink-muted">
            Everything on this screen is free and took{' '}
            {preflight.elapsedMs < 1000
              ? `${Math.max(1, Math.round(preflight.elapsedMs))}ms`
              : `${(preflight.elapsedMs / 1000).toFixed(1)}s`}
            .
            Distances are straight lines over an assumed speed, areas are groupings of map records,
            and nothing here has been checked against an official source yet. That happens next, and
            it is the part that takes minutes.
          </p>
        </Panel>
      </aside>

      <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-6 lg:col-span-2">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={pending || blocked || (strategies.length > 0 && strategy === '')}
          /*
           * Applies the strategy and stops.
           *
           * It used to chain straight into `proposeScopeAction`, which refuses
           * while any required clarification is outstanding — so on a country
           * with an unanswered question the traveller got an error on a screen
           * they had just completed correctly, and no way forward. The step
           * chooser knows where to send them; this only has to record the
           * answer.
           */
          onClick={() =>
            onRun(() => applyStrategyAction(tripId, strategy), 'We could not save that.')
          }
        >
          {pending ? 'Working…' : 'Go and research this'}
        </button>
        <a className={buttonClass('ghost')} href="/trips/new">
          Change the trip
        </a>
      </div>
    </div>
  );
}

function SupplyPanel({ supply }: { supply: NonNullable<TripPreflight['supply']> }) {
  const tone =
    supply.level === 'strong' || supply.level === 'usable'
      ? 'pine'
      : supply.level === 'thin_repairable'
        ? 'amber'
        : 'clay';

  return (
    <Panel
      className={cx(
        'p-5',
        supply.level === 'insufficient' || supply.level === 'infrastructure_failure'
          ? 'border-clay'
          : supply.level === 'thin_repairable'
            ? 'border-amber'
            : '',
      )}
      testId="supply-panel"
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <Badge tone={tone}>{SUPPLY_LEVEL_LABELS[supply.level]}</Badge>
        <p className="min-w-0 flex-1 text-ink">{supply.summary}</p>
      </div>

      {supply.shortfalls.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-ink-muted">
          {supply.shortfalls.map((shortfall) => (
            <li key={shortfall}>{shortfall}</li>
          ))}
        </ul>
      ) : null}

      {supply.actions.length > 0 ? (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="text-sm font-medium text-ink">What would help</p>
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {supply.actions.map((action) => (
              <li key={action}>
                <Badge>{SUPPLY_ACTION_LABELS[action]}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Changing any of these keeps every answer you have already given.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

function DatesPanel({
  dates,
  tripId,
  pending,
  onRun,
}: {
  dates: NonNullable<TripPreflight['dates']>;
  tripId: string;
  pending: boolean;
  onRun: StepProps['onRun'];
}) {
  if (dates.kind === 'unavailable') {
    return (
      <section aria-labelledby="dates-heading">
        <h2 id="dates-heading" className="font-display text-xl text-ink">
          When to go
        </h2>
        <p className="mt-1.5 text-sm text-ink-muted">{dates.note}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="dates-heading" data-testid="date-guidance">
      <h2 id="dates-heading" className="font-display text-xl text-ink">
        When this place is at its best
      </h2>
      <p className="mt-1.5 text-sm text-ink-muted">
        From {dates.sampleYearTo - dates.sampleYearFrom + 1} years of records ({dates.sampleYearFrom}
        –{dates.sampleYearTo}). <strong className="font-medium text-ink">Not a forecast.</strong>
      </p>

      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {dates.windows.map((window) => (
          <li key={window.label}>
            <Panel className="h-full p-4">
              <p className="font-display text-lg text-ink">{window.label}</p>
              <p className="mt-1 text-xs text-ink-faint">
                {Math.round(window.climate.temperature.low)}–
                {Math.round(window.climate.temperature.high)}°C ·{' '}
                {window.climate.daylightHours.toFixed(1)}h daylight
              </p>
              {window.reasons.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs leading-relaxed text-ink-muted">
                  {window.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              {window.tradeoffs.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs leading-relaxed text-amber">
                  {window.tradeoffs.map((tradeoff) => (
                    <li key={tradeoff}>{tradeoff}</li>
                  ))}
                </ul>
              ) : null}
              {/*
                A recommendation the traveller cannot act on is advice. This is
                what turns "August is strongest here" into a trip in August —
                keeping the trip's length and moving only the dates.
              */}
              <button
                type="button"
                className={cx(
                  'mt-2 inline-flex items-center text-xs text-pine underline underline-offset-2 disabled:opacity-50',
                  MIN_TARGET,
                )}
                disabled={pending}
                onClick={() =>
                  onRun(
                    () => adoptDateWindowAction(tripId, window.month, window.year),
                    'We could not move the dates.',
                  )
                }
              >
                Move my trip to {window.label}
              </button>
            </Panel>
          </li>
        ))}
      </ul>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
          What this does not tell you
        </summary>
        <ul className="mt-2 space-y-1 text-sm text-ink-muted">
          {(dates.windows[0]?.unknowns ?? []).map((unknown) => (
            <li key={unknown}>{unknown}</li>
          ))}
        </ul>
      </details>

      <p className="mt-3 text-[11px] text-ink-faint">{dates.attribution}</p>
    </section>
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
      <p className="measure text-ink-muted">
        These change the answer, so we would rather ask than guess.
      </p>

      <div className="mt-8 space-y-8">
        {questions.map((question) => (
          <Fieldset key={question.id} legend={question.question} hint={question.whyItMatters}>
            <div className="grid gap-2 sm:grid-cols-2">
              {question.options.map((option) => (
                <Choice
                  key={option.value}
                  name={question.id}
                  value={option.value}
                  checked={(given[question.id] ?? []).includes(option.value)}
                  onChange={() =>
                    setGiven((current) => ({ ...current, [question.id]: [option.value] }))
                  }
                  label={option.label}
                  {...(option.detail ? { detail: option.detail } : {})}
                />
              ))}
            </div>
            {question.answerType === 'text' ? (
              <input
                type="text"
                name={question.id}
                defaultValue={given[question.id]?.[0] ?? ''}
                onChange={(event) =>
                  setGiven((current) => ({ ...current, [question.id]: [event.target.value] }))
                }
                className="mt-2 w-full rounded-lg border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint"
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
      <p className="measure text-ink-muted">
        Everything after this costs time and looks things up. Check it first.
      </p>

      <Panel className="mt-6 p-5 sm:p-6">
        <dl className="space-y-4 text-sm">
          <Row label="Region" value={scope.destinationName} />
          <Row label="How far" value={reach} />
          <Row
            label="Bases"
            value={
              scope.maxBaseChanges === 0 ? 'One, for the whole trip' : `Up to ${scope.maxBaseChanges + 1}`
            }
          />
          <Row label="Getting around" value={scope.transport.note} />
          <Row label="Time zone" value={scope.timeZones.join(', ')} />
          <Row label="Why this" value={scope.rationale} />
        </dl>
      </Panel>

      <Panel className="mt-4 border-dashed p-4 text-sm leading-relaxed text-ink-muted">
        What we will not do: book anything, price anything, or claim a road is open because it
        usually is. Anything we cannot confirm comes back saying so.
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

/**
 * A definition row whose value is a node rather than a string.
 *
 * Needed the moment a name became two names — a display form and a native one
 * in its own `lang` — because a string cannot carry the second.
 */
function RowNode({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-4">
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint sm:w-40 sm:shrink-0">
        {label}
      </dt>
      <dd className="mt-1 min-w-0 text-ink sm:mt-0">{value}</dd>
    </div>
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

function CompilingStep({ tripId, snapshot, pending, onRun }: StepProps) {
  const router = useRouter();

  /*
   * THE POLLED SNAPSHOT CANNOT OUTLIVE THE SERVER'S.
   *
   * `useState(snapshot)` seeds once, so once the poll had written anything into
   * `live` the props were ignored for the rest of the component's life. A
   * `router.refresh()` — which this component triggers itself the moment a build
   * lands — then re-rendered the whole screen around a progress summary
   * describing the run before it, on a retry, and the stage list, the phase
   * clock and the "ready to look at" link all came from the stale one.
   *
   * Keyed on the server snapshot's own identity: when the props describe a
   * different job or a different state, they win. Between refreshes the poll is
   * the fresher of the two and keeps the screen moving.
   */
  const serverKey = summaryVersion([
    snapshot.state,
    snapshot.startedAt,
    snapshot.compiledRegionId,
    snapshot.provisionalBoardId,
    snapshot.stages.length,
  ]);
  const [adopted, setAdopted] = useState<{ key: string; value: CompilationSnapshot }>({
    key: serverKey,
    value: snapshot,
  });
  if (adopted.key !== serverKey) setAdopted({ key: serverKey, value: snapshot });
  const live = adopted.key === serverKey ? adopted.value : snapshot;

  /*
   * A functional update, so a poll keeps whichever key is current when it lands
   * rather than the one its interval closed over. A timer created before a
   * refresh would otherwise stamp every later result with a key the render has
   * already moved past, and each one would be discarded on arrival — a progress
   * screen that silently stops progressing.
   */
  const setLive = (next: CompilationSnapshot) =>
    setAdopted((current) => ({ key: current.key, value: next }));

  const [polls, setPolls] = useState(0);

  useEffect(() => {
    const running = live.state === 'queued' || live.state === 'running';
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

  const failed = live.state === 'failed' || live.state === 'cancelled';
  const notStarted = live.state === 'none';

  return (
    <div className="max-w-3xl">
      {failed ? (
        <Panel className="mb-5 border-clay p-4 text-sm leading-relaxed text-ink">
          {live.errorMessage ?? 'That stopped before it finished.'}
        </Panel>
      ) : null}

      <CompilationProgress
        stages={live.stages}
        failed={failed}
        {...(live.startedAt ? { startedAt: live.startedAt } : {})}
        estimate={live.estimate ?? null}
        {...(live.reusedSummary ? { reusedSummary: live.reusedSummary } : {})}
      />

      {/*
        THE PROMISE, KEPT.

        `AVAILABILITY_AFTER.finding` has said "a provisional board — nothing on
        it is verified yet" since Phase 11, and there was nothing behind it. This
        is the affordance.

        Triggered on the stored board rather than on phase completion, and it
        stays that way now that the phases are in order.

        The reason it had to be that way: `researching_official_constraints` and
        `discovering_food` were mapped to *verifying* while executing before
        `enriching_priority_candidates`, which was mapped to *finding*, so phase
        completion happened after the cut and out of order and keying the link
        off it showed the link late. That is fixed in `STAGE_REGISTRY` — the
        finding→verifying boundary is now exactly the cut. The board id is still
        the better trigger, because the board is a thing that either exists in
        the database or does not, and a phase boundary is an inference about it.
      */}
      {live.provisionalBoardId && !failed ? (
        <Panel className="mt-6 border-provisional p-5">
          <div className="flex flex-wrap items-center gap-3">
            <EvidenceBadge state="provisional">Ready to look at</EvidenceBadge>
          </div>
          <p className="measure mt-3 text-sm leading-relaxed text-ink">
            We have found the places. Nothing is verified yet — no opening times, no
            costs, and no travel times, because nothing has been routed. You can start
            marking what interests you, and we will check those first.
          </p>
          <a
            className={cx(buttonClass('primary'), 'mt-4')}
            href={`/trips/${tripId}/provisional`}
          >
            See what we found
          </a>
        </Panel>
      ) : null}

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
        {failed ? (
          <a className={buttonClass('secondary')} href="/trips/new">
            Change the trip
          </a>
        ) : (
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={pending}
            onClick={() => onRun(() => cancelCompilationAction(tripId), 'We could not stop that.')}
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

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
              {/*
                A phrase somebody wrote, or nothing — never the identifier.

                The fallback here was `entry.decision`, which is a stored string
                from whichever build wrote the row: an unmapped value rendered as
                `reused_shared_pack`, underscores and all, inside a sentence.
                That is the same mechanism `stageLabel` exists to refuse, one
                line below, and it survived here because the map is keyed by hand
                and the fallback looked defensive.
              */}
              {decisionLabel(entry.decision) ? (
                <span className="text-ink-faint"> — {decisionLabel(entry.decision)}</span>
              ) : null}
              <p className="text-ink-muted">{entry.reason}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </details>
  );
}

/**
 * THE TRIP'S SHAPE, AS THE PLANNER WILL ACTUALLY BUILD IT.
 *
 * Not display metadata. Every row here is the contract the planner is held to:
 * these dates belong to this base, this move costs this many measured minutes,
 * and this area was left out for this reason. The previous slice showed four
 * proposed bases that nothing downstream read.
 */
function BasePortfolioPanel({ portfolio }: { portfolio: StoredBasePortfolio }) {
  const unreachable = portfolio.excluded.filter((entry) => entry.unreachable);
  const notFitting = portfolio.excluded.filter((entry) => !entry.unreachable);

  return (
    <section className="mt-8" aria-labelledby="portfolio-heading" data-testid="base-portfolio">
      <h2 id="portfolio-heading" className="font-display text-2xl text-ink">
        How the trip is split
      </h2>
      <p className="mt-2 text-sm text-ink-muted">{portfolio.rationale}</p>

      <ol className="mt-4 divide-y divide-rule">
        {portfolio.bases.map((base) => (
          <li key={base.baseId} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
            <span className="w-6 shrink-0 text-xs text-ink-faint">{base.order + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-ink">
                <PlaceName entity={{ name: base.baseName }} />
              </span>
              <span className="mt-0.5 block text-sm text-ink-muted">
                {base.nights} night{base.nights === 1 ? '' : 's'} · {base.fromDate} → {base.toDate}
              </span>
              {base.order > 0 ? (
                <span className="mt-0.5 block text-sm text-ink-faint">
                  {Math.round(base.transferMinutesFromPrevious)} minutes from the last base
                  {base.transferIsWholeDay ? ' — a travel day rather than a morning' : ''}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-3 text-sm text-ink-muted">
        About {portfolio.transferDays} day{portfolio.transferDays === 1 ? '' : 's'} of the trip is
        spent moving between them. That time is planned as a transfer, not taken out of your daily
        driving limit.
      </p>

      {unreachable.length > 0 ? (
        <Panel className="mt-4 border-amber p-4">
          <p className="text-sm font-medium text-ink">
            {unreachable.length} area{unreachable.length === 1 ? '' : 's'} we could not connect
          </p>
          <ul className="mt-1.5 space-y-1 text-sm text-ink-muted">
            {unreachable.map((entry) => (
              <li key={entry.clusterId}>
                {entry.name} — {entry.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            The rest of the trip is unaffected. Trying again may help if the routing service was
            briefly unavailable.
          </p>
        </Panel>
      ) : null}

      {notFitting.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
            {notFitting.length} area{notFitting.length === 1 ? '' : 's'} left out
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-ink-muted">
            {notFitting.map((entry) => (
              <li key={entry.clusterId}>
                {entry.name} — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * What routing cost, for whoever is paying for it.
 *
 * Deliberately behind a disclosure and deliberately *not* in coverage: how many
 * pairs were bought says nothing about how good a region is, and mixing the two
 * is how a cheap build starts looking like a confident one.
 */
function RoutingPanel({ diagnostics }: { diagnostics: RoutingDiagnostics }) {
  const saved = diagnostics.flatPairs - diagnostics.plannedPairs;
  return (
    <details className="mt-4" data-testid="routing-diagnostics">
      <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
        How travel times were measured
      </summary>
      <Panel className="mt-3 p-4">
        <dl className="space-y-3 text-sm">
          <Row label="Areas" value={`${diagnostics.clusters}`} />
          <Row
            label="Legs measured"
            value={`${diagnostics.requestedPairs} across ${diagnostics.providerCalls} request${diagnostics.providerCalls === 1 ? '' : 's'}`}
          />
          <Row
            label="Skipped"
            value={
              saved > 0
                ? `${saved} pairs between areas nothing would ever read`
                : 'Nothing — every pair was worth measuring'
            }
          />
          {diagnostics.composedPairs > 0 ? (
            <Row
              label="Between areas"
              value={`${diagnostics.composedPairs} legs measured through the base you sleep in`}
            />
          ) : null}
        </dl>
        {diagnostics.reductions.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs leading-relaxed text-ink-muted">
            {diagnostics.reductions.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </details>
  );
}

/**
 * A work-plan step's name, in the traveller's words or not at all.
 *
 * This was `COMPILATION_STAGE_LABELS[step] ?? step.replaceAll('_', ' ')`, and
 * the fallback is the defect: a work-plan step is a free-form string, the label
 * map was a second hand-keyed copy of the stage vocabulary, and anything the
 * copy had missed was rendered as its own identifier with the underscores taken
 * out. `reusing shared claims` reached a traveller that way — lowercase, no
 * article, not a sentence anybody wrote.
 *
 * `stageLabel` answers from the one registry and answers `null` rather than
 * guessing, so the fallback here is a phrase somebody chose on purpose.
 */
function stepLabel(step: string): string {
  return stageLabel(step) ?? 'Another step of this build';
}

/**
 * What a work-plan decision is called, or nothing.
 *
 * `null` rather than the raw value, for the reason `stageLabel` returns null:
 * a stored decision string that the label map has not got is an identifier, and
 * an identifier rendered inside a sentence is the defect, not the fallback.
 */
function decisionLabel(decision: string): string | null {
  return (WORK_PLAN_DECISION_LABELS as Record<string, string | undefined>)[decision] ?? null;
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
  basePortfolio,
  routingDiagnostics,
}: PlanFlowProps) {
  if (!coverage || !compiledSummary) return null;
  const weak = coverage.dimensions.filter(
    (entry) => entry.level === 'weak' || entry.level === 'unavailable',
  );
  const buildDuration = classifyObservedSpan(observedSpanMs(snapshot.stages));

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div>
        <p className="measure text-ink-muted">
          Everything below is a claim with a source. Where there is no source, we say that instead of
          filling the gap.
        </p>

        {snapshot.state === 'partial' ? (
          <Panel className="mt-6 border-amber bg-amber-soft p-4 text-sm leading-relaxed text-ink">
            This came back incomplete. It is usable, and the gaps are listed below rather than
            hidden.
          </Panel>
        ) : null}

        <Panel className="mt-6 p-5 sm:p-6">
          <dl className="space-y-4 text-sm">
            <RowNode
              label="Base"
              value={
                <PlaceName
                  entity={{
                    name: compiledSummary.baseName,
                    ...(compiledSummary.baseNames ? { names: compiledSummary.baseNames } : {}),
                  }}
                />
              }
            />
            <Row label="Places" value={`${compiledSummary.placeCount} kept`} />
            <Row
              label="Nearby"
              value={`${compiledSummary.satelliteCount} side trips across ${compiledSummary.subregionCount || 1} area${compiledSummary.subregionCount === 1 ? '' : 's'}`}
            />
          </dl>
        </Panel>

        {basePortfolio && basePortfolio.bases.length > 1 ? (
          <BasePortfolioPanel portfolio={basePortfolio} />
        ) : null}

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

        <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-rule pt-6">
          <a className={buttonClass('primary')} href={`/trips/${tripId}/questionnaire`}>
            Tell us how you travel
          </a>
          <a className={buttonClass('secondary')} href={`/trips/${tripId}/discover`}>
            Skip to the board
          </a>
        </div>
      </div>

      <aside aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="font-display text-xl text-ink">
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
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
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
        {routingDiagnostics ? <RoutingPanel diagnostics={routingDiagnostics} /> : null}
        {workPlan ? <WorkPlanPanel entries={workPlan} /> : null}

        {/*
          WHAT THE BUILD ACTUALLY DID, AFTER IT IS OVER.

          The progress screen carried this and then took it away with it. A
          fixture build finishes in about a second and a real one in minutes, and
          in both cases the question "why did that take as long as it did" is one
          people ask *afterwards* — so a record that only exists while you are
          waiting for it is not a record.

          Real measured durations, from the job row's observed clock. Stages with
          no observed pair show no figure rather than showing zero.
        */}
        {snapshot.stages.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-ink">How this build went</h3>
            {/*
              THE WORD DOING THE DAMAGE WAS `MEASURED`.

              Two figures reached this line that were not durations. A job
              reclaimed hours after it stopped rendered "312m in total,
              measured", which reads as a pipeline five hours slow; a synthetic
              build that really took 800 ms rendered "0s in total, measured",
              which is the same family of sentence as "roughly 0s–0s to go".
              `classifyObservedSpan` states both bounds, and above the ceiling
              this says what the timestamps are rather than pretending they are a
              measurement.
            */}
            {buildDuration.kind === 'measured' ? (
              <p className="mt-1 text-xs text-ink-faint" data-testid="build-duration">
                {formatBuildDuration(buildDuration.ms)} in total, measured.
              </p>
            ) : buildDuration.kind === 'under_a_second' ? (
              <p className="mt-1 text-xs text-ink-faint" data-testid="build-duration">
                Under a second in total, measured.
              </p>
            ) : buildDuration.kind === 'not_a_measurement' ? (
              <p className="mt-1 text-xs text-ink-faint" data-testid="build-span-implausible">
                The first and last stamps on this build are further apart than a build runs
                for, so they are a record of when it happened rather than of how long it took.
                No total here.
              </p>
            ) : null}
            <div className="mt-2">
              <StageDisclosure stages={snapshot.stages} />
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/**
 * The whole build, end to end, from the observed clock.
 *
 * Earliest observed start to latest observed finish rather than a sum of stage
 * durations: the sum omits everything between stages, and a figure that is
 * reliably smaller than the wait somebody sat through is worse than no figure.
 *
 * Null when no stage carries an observed pair — a job row written before the
 * two-clock split has only the injected clock, and reading that as a duration is
 * the exact defect this replaced.
 *
 * Plausibility is **not** decided here. This returns the span; whether the span
 * may be presented as a measurement is `classifyObservedSpan`'s answer, stated
 * once in `schemas/progress.ts` where the ceiling and the floor are written
 * down, rather than as a threshold buried in a component.
 */
function observedSpanMs(stages: StageRecord[]): number | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const stage of stages) {
    const started = stage.observedStartedAt ? Date.parse(stage.observedStartedAt) : Number.NaN;
    const finished = stage.observedFinishedAt ? Date.parse(stage.observedFinishedAt) : Number.NaN;
    if (!Number.isNaN(started)) starts.push(started);
    if (!Number.isNaN(finished)) ends.push(finished);
  }
  if (starts.length === 0 || ends.length === 0) return null;
  const span = Math.max(...ends) - Math.min(...starts);
  return span >= 0 ? span : null;
}

function formatBuildDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
