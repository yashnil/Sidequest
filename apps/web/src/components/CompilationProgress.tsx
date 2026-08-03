'use client';

import { useEffect, useState } from 'react';
import {
  AVAILABILITY_AFTER,
  COMPILATION_STAGE_LABELS,
  estimateRemaining,
  groupStages,
  type PhaseProgress,
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
 */

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
}: {
  stages: StageRecord[];
  failed: boolean;
  /** When the job began, so the header clock survives a refresh. */
  startedAt?: string;
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
  const remaining = failed ? null : estimateRemaining(phases, now);
  const totalElapsed = startedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(startedAt)) / 1000)) : null;

  const inspectable = phases
    .filter((phase) => phase.status === 'done' || phase.status === 'partial')
    .map((phase) => AVAILABILITY_AFTER[phase.phase])
    .filter((entry): entry is string => Boolean(entry));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="text-ink-muted" aria-live="polite">
          {failed
            ? 'Stopped.'
            : (phases.find((phase) => phase.status === 'running')?.label ?? 'Getting started…')}
        </span>
        <span className="text-ink-faint">
          {totalElapsed !== null ? formatDuration(totalElapsed) : null}
          {remaining
            ? ` · roughly ${formatDuration(remaining.lowSeconds)}–${formatDuration(remaining.highSeconds)} to go`
            : null}
        </span>
      </div>

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

      <details data-testid="technical-stages">
        <summary className="cursor-pointer text-sm text-ink-muted underline underline-offset-4">
          Technical details — every stage
        </summary>
        <Panel className="mt-2.5 p-4">
          <ol className="space-y-2">
            {stages.map((stage) => (
              <li key={stage.stage} className="flex items-baseline gap-3 text-sm">
                <span className="w-16 shrink-0 text-xs text-ink-faint">{stage.status}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{COMPILATION_STAGE_LABELS[stage.stage]}</span>
                  {stage.outcome ? (
                    <span className="block text-xs text-ink-muted">{stage.outcome}</span>
                  ) : null}
                  {stage.note ? <span className="block text-xs text-amber">{stage.note}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </details>

      <p className="text-xs leading-relaxed text-ink-faint">
        You can close this page. The build carries on and picks up where it left off when you come
        back — nothing here depends on the browser staying open. There is no percentage on purpose:
        several of these steps take as long as somebody else&rsquo;s server takes.
      </p>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
