'use client';

import { useEffect, useState } from 'react';
import {
  AVAILABILITY_AFTER,
  groupStages,
  observedDurationMs,
  stageLabel,
  summaryVersion,
  type PhaseProgress,
  type RemainingEstimate,
  type StageRecord,
} from '@sidequest/core';
import { Badge, Panel, cx } from './ui';

/**
 * TWENTY-SIX ROWS, GROUPED INTO FIVE THINGS A TRAVELLER CAN READ.
 *
 * The screen this replaces rendered every compilation stage as a flat list, so
 * somebody waiting several minutes for their trip watched "Matching records
 * across sources" and "Working out who to believe" scroll past with no idea
 * which of them mattered, how much was left, or whether anything had gone wrong.
 *
 * Four changes, each answering a specific complaint:
 *
 * - **Five phases**, named for what the traveller is getting rather than for the
 *   module doing it. The stages are still there, behind a disclosure, because an
 *   operator debugging a thin region needs exactly that list.
 * - **Elapsed time per phase**, computed from stage timestamps rather than a
 *   client timer, so a refresh does not restart it and two tabs agree.
 * - **What is already inspectable**, so a wait has a floor of usefulness.
 * - **A remaining range, only once there is something to extrapolate from.**
 *   Never a percentage. Several of these stages take as long as somebody else's
 *   server takes, and a bar moving at a rate nobody can predict is a lie told
 *   with an animation.
 *
 * ## What this screen is allowed to say about time
 *
 * | Shown | Source | When |
 * | --- | --- | --- |
 * | total elapsed | the job's `startedAt` | immediately, from the first paint |
 * | per-phase elapsed | observed stage timestamps | as soon as one stage in the phase has started |
 * | per-stage duration | `observedDurationMs` | once the stage has finished, in the disclosure |
 * | reused work | the `reusing_shared_claims` outcome | once that stage has finished |
 * | remaining range | bucketed history, ≥5 comparable builds | almost never, and that is correct |
 *
 * And what it is never allowed to say: a percentage, a negative duration, a
 * fabricated range, or "roughly 0s–0s to go" — which it did say, in production,
 * for every build, because the only clock it had advanced one millisecond per
 * stage. Every rule above exists because of that one sentence.
 */

/**
 * The smallest a control on this screen may be.
 *
 * WCAG 2.5.5's 44 px. A `<summary>` is a control — it is the only way into the
 * stage list an operator is looking for — and a line of 14 px text is about
 * twenty pixels of target.
 *
 * Padding rather than a flex box: a summary is a `display: list-item`, and
 * making it flex removes the disclosure triangle in every WebKit-derived
 * browser. A 44 px target that no longer looks like a control is not a fix.
 */
const MIN_TARGET_SUMMARY = 'min-h-11 py-3';

const PHASE_TONE: Record<PhaseProgress['status'], 'pine' | 'blue' | 'amber' | 'neutral' | 'clay'> = {
  done: 'pine',
  running: 'blue',
  waiting: 'neutral',
  partial: 'amber',
  failed: 'clay',
};

const PHASE_LABEL: Record<PhaseProgress['status'], string> = {
  done: 'Done',
  running: 'Working',
  waiting: 'Waiting',
  partial: 'Partly done',
  failed: 'Failed',
};

export function CompilationProgress({
  stages,
  failed,
  startedAt,
  estimate,
  reusedSummary,
}: {
  stages: StageRecord[];
  failed: boolean;
  /** When the job began, so the header clock survives a refresh. */
  startedAt?: string;
  /**
   * A remaining range, or nothing.
   *
   * Nothing is the expected value and renders as silence. The estimator refuses
   * without at least five comparable builds in the same bucket — see
   * `estimateRemainingFrom` — and a screen that filled the gap with a guess is
   * exactly what this component is a rewrite of.
   */
  estimate?: RemainingEstimate | null;
  /** What this build did not have to buy, in the reusing stage's own words. */
  reusedSummary?: string;
}) {
  /*
   * One second-resolution clock for the whole panel.
   *
   * A `Date` in state rather than `Date.now()` inline, so every phase renders
   * against the same instant — otherwise two phases computed a millisecond apart
   * can disagree about which second it is, and the numbers flicker.
   */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (failed) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [failed]);

  const phases = groupStages(stages, now);

  /*
   * The identity of the run this panel is describing.
   *
   * Every figure here — the phase counts, the elapsed clock, the estimate, the
   * reuse sentence — is derived from one snapshot, and the stamp says which. It
   * is not defensive decoration: `PlanFlow` used to hold a polled snapshot in
   * state that outlived the props around it, so this panel could describe one
   * run inside a page describing another, and nothing on screen said so.
   */
  const progressVersion = summaryVersion([
    startedAt,
    stages.length,
    ...stages.map((record) => `${record.stage}:${record.status}`),
  ]);

  /*
   * Elapsed from the first paint, and never negative.
   *
   * `startedAt` is the job row's, so a refresh does not restart the clock and
   * two tabs agree. The clamp is not defensive noise: the server stamps the job
   * and the browser reads its own clock, so a machine a few seconds behind the
   * server produces a negative span on the first tick, and `-3s` on a progress
   * screen looks like a much worse bug than it is.
   */
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const totalElapsed = Number.isNaN(startedMs)
    ? null
    : Math.max(0, Math.round((now.getTime() - startedMs) / 1000));

  const inspectable = phases
    .filter((phase) => phase.status === 'done' || phase.status === 'partial')
    .map((phase) => AVAILABILITY_AFTER[phase.phase])
    .filter((entry): entry is string => Boolean(entry));

  return (
    <div className="space-y-4" data-testid="compilation-progress" data-progress-version={progressVersion}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="text-ink-muted" aria-live="polite">
          {failed
            ? 'Stopped.'
            : (phases.find((phase) => phase.status === 'running')?.label ?? 'Getting started…')}
        </span>
        {/*
          Elapsed, and an estimate only when one has been earned.

          There was an estimate once, computed by multiplying this run's median
          stage duration by the number of stages left — from a clock that
          reported one millisecond per stage. It rendered "roughly 0s–0s to go".
          Both halves were wrong: the clock, and the model that treats
          `partitioning_scope` and `retrieving_pages` as the same kind of thing.

          What is here now is history, bucketed by how much ground the build
          covers, whether it is buying or reusing, and whether the run is already
          degraded — and it renders nothing at all until at least five comparable
          builds exist. Nothing is the expected output for a long time.
        */}
        <span className="text-ink-faint" data-testid="progress-elapsed" data-progress-version={progressVersion}>
          {totalElapsed !== null ? formatDuration(totalElapsed) : null}
          {estimate && !failed ? (
            <span data-testid="progress-estimate" data-progress-version={progressVersion}>
              {' · roughly '}
              {formatDuration(estimate.lowSeconds)}–{formatDuration(estimate.highSeconds)} to go,
              from {estimate.runs} similar {estimate.runs === 1 ? 'build' : 'builds'}
            </span>
          ) : null}
        </span>
      </div>

      {/*
        What this build did not have to buy.

        The reusing stage counts it and this repeats its sentence rather than
        composing a second one — two counts of the same thing is two things that
        can disagree, and the one on screen would be the one nobody could trace.
      */}
      {reusedSummary ? (
        <p className="text-sm text-ink-muted" data-testid="progress-reused" data-progress-version={progressVersion}>
          Already held, so nothing was bought for it: {reusedSummary}
        </p>
      ) : null}

      <ol className="space-y-2.5">
        {phases.map((phase) => (
          <li key={phase.phase}>
            <Panel
              className={cx(
                'p-4 transition-colors',
                phase.status === 'running' ? 'border-slate-blue' : '',
                phase.status === 'failed' ? 'border-clay' : '',
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Badge tone={PHASE_TONE[phase.status]}>{PHASE_LABEL[phase.status]}</Badge>
                <span
                  className={cx(
                    'min-w-0 flex-1 font-medium text-ink',
                    phase.status === 'running' ? 'breathing' : '',
                  )}
                >
                  {phase.label}
                </span>
                <span className="shrink-0 text-xs text-ink-faint">
                  {phase.done}/{phase.total}
                  {phase.elapsedSeconds !== undefined && phase.elapsedSeconds > 1
                    ? ` · ${formatDuration(phase.elapsedSeconds)}`
                    : ''}
                </span>
              </div>

              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {phase.status === 'running' && phase.currentWork
                  ? phase.currentWork
                  : (phase.latestOutcome ?? phase.detail)}
              </p>

              {phase.notes.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {phase.notes.map((note) => (
                    <li key={note} className="text-xs leading-relaxed text-amber">
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          </li>
        ))}
      </ol>

      {inspectable.length > 0 ? (
        <Panel className="border-dashed p-4">
          <p className="text-sm font-medium text-ink">Ready to look at already</p>
          <ul className="mt-1.5 space-y-0.5 text-sm text-ink-muted">
            {inspectable.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <StageDisclosure stages={stages} />

      <p className="text-xs leading-relaxed text-ink-faint">
        You can close this page. The build carries on and picks up where it left off when you come
        back — nothing here depends on the browser staying open. There is no percentage on purpose:
        several of these steps take as long as somebody else&rsquo;s server takes.
      </p>
    </div>
  );
}

/**
 * What a stage with no registry entry is called on screen.
 *
 * Unreachable through the typed path — `StageRecord.stage` is the registry's
 * union — and here anyway, because a stored job row is JSON and a row written by
 * a build that knew a stage this build does not is exactly how a raw identifier
 * reaches a screen. It says nothing rather than saying an identifier.
 */
const UNREGISTERED_STAGE = 'A step of the build';

/**
 * EVERY STAGE, WITH THE TIME IT ACTUALLY TOOK.
 *
 * Extracted so it can be rendered in two places, and the second place is the
 * point. A fixture build finishes in about a second, so the progress screen —
 * where this used to live exclusively — is on screen for less time than it takes
 * to read, and the record of what the build did disappeared with it.
 *
 * The brief asks for completed real durations and reused work to be *shown*, not
 * merely measured. A record that only exists while you are waiting for it is not
 * showing anything: the question "why did that take four minutes" is one people
 * ask afterwards.
 */
export function StageDisclosure({ stages }: { stages: StageRecord[] }) {
  return (
    <details data-testid="technical-stages">
        <summary
          className={cx(
            MIN_TARGET_SUMMARY,
            'cursor-pointer text-sm text-ink-muted underline underline-offset-4',
          )}
        >
          Technical details — every stage
        </summary>
        <Panel className="mt-2.5 p-4">
          <ol className="space-y-2">
            {stages.map((stage) => {
              /*
               * The measured duration, or nothing at all.
               *
               * `observedDurationMs` returns null for a stage with no observed
               * pair, for a clock that went backwards over it, and for anything
               * longer than an hour. All three render as an absent figure rather
               * than as `0s` or `-4s`: this list is what an operator reads to
               * find the slow stage, and a fabricated zero in it would send them
               * looking in the wrong place.
               */
              const measured = observedDurationMs(stage);
              return (
                <li key={stage.stage} className="flex items-baseline gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-ink-faint">{stage.status}</span>
                  <span className="min-w-0 flex-1">
                    {/*
                      The registry's label, or an honest placeholder — never the
                      identifier. `stepLabel`'s old fallback was
                      `replaceAll('_', ' ')`, which put `reusing shared claims`
                      in front of a traveller.
                    */}
                    <span className="text-ink">{stageLabel(stage.stage) ?? UNREGISTERED_STAGE}</span>
                    {measured !== null ? (
                      <span className="ml-2 text-xs text-ink-faint">
                        {formatDuration(Math.round(measured / 1000))}
                      </span>
                    ) : null}
                    {stage.outcome ? (
                      <span className="block text-xs text-ink-muted">{stage.outcome}</span>
                    ) : null}
                    {stage.note ? (
                      <span className="block text-xs text-amber">{stage.note}</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>
    </details>
  );
}


function formatDuration(seconds: number): string {
  /*
   * Never negative, whatever the caller did.
   *
   * Every caller clamps already; this is the second line of defence for the one
   * that will not, because a duration rendered as `-1s` is a bug a traveller
   * sees and a clamp is a bug nobody does.
   */
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
