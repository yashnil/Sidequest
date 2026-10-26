'use client';

import { motion, useReducedMotion } from 'motion/react';
import { cx, FOCUS_RING } from '../ui';
import { PORTRAIT_S, timing } from './choreography';

/**
 * PROGRESS AS A PATH OF STAGES, NOT A COUNT.
 *
 * The interview is adaptive, so "Question 8 of 14" is a promise it cannot
 * keep. Five stages can be kept: the trip itself, then what you love, your
 * rhythm, logistics, ready.
 *
 * MVP V3 — the first stage is `trip`, and it starts on the very first screen a
 * traveller sees. Setting up a trip and being interviewed about it are one
 * continuous conversation now, so they share one path.
 *
 * V8 — drawn as a continuous rail: five segments that fill as the interview
 * proceeds, the current stage named at a readable size above them, and the
 * live segment carried between stages by a `layout` animation so advancing
 * reads as movement along one line rather than as one pill replacing another.
 * `data-testid="stage-path"` and the "N answered · M decided" note inside it
 * are read by the browser suite (`build-lifecycle.spec.ts`).
 */
export const STAGES = ['trip', 'love', 'rhythm', 'logistics', 'ready'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  trip: 'The trip',
  love: 'What you love',
  rhythm: 'Your rhythm',
  logistics: 'Logistics',
  ready: 'Ready',
};

const RHYTHM_IDS = new Set(['day_shape', 'day_start', 'effort', 'iconic_crowds', 'famous_vs_hidden', 'hike_appetite', 'walking_tolerance', 'free_time', 'late_nights', 'weather_avoidances']);

export function stageOf(questionId: string | null): Stage {
  if (questionId === null) return 'trip';
  if (questionId === 'review') return 'ready';
  if (questionId === 'priorities' || questionId === 'priority_roles' || questionId.startsWith('priority_role:')) return 'love';
  if (RHYTHM_IDS.has(questionId)) return 'rhythm';
  return 'logistics';
}

export type StageSegment = { stage: Stage; label: string; state: 'done' | 'now' | 'ahead' };

/** The rail as data: which segments are filled, which is live, which are still ahead. */
export function stageSegments(current: Stage): StageSegment[] {
  const index = STAGES.indexOf(current);
  return STAGES.map((stage, i) => ({ stage, label: STAGE_LABELS[stage], state: i < index ? 'done' : i === index ? 'now' : 'ahead' }));
}

export function StagePath({ current, note, onJump }: { current: Stage; note?: string; onJump?: (stage: Stage) => void }) {
  const reduced = useReducedMotion();
  const segments = stageSegments(current);
  const index = STAGES.indexOf(current);
  return (
    <nav aria-label="Interview progress" className="min-w-0" data-testid="stage-path">
      {/*
        Survey Atlas — a pager in the sheet's margin rather than a progress bar:
        "02 / 05 · What you love" at the left, the running note at the right,
        five hairline segments under them. A finished stage is still a way back.
      */}
      <div className="flex items-baseline justify-between gap-x-4">
        <p className="sheet-label min-w-0 text-ink">
          <span className="text-accent">{String(index + 1).padStart(2, '0')}</span>
          <span className="text-ink-faint"> / {String(STAGES.length).padStart(2, '0')}</span>
          <span className="text-ink-muted"> · </span>
          {STAGE_LABELS[current]}
          <span className="sr-only">, stage {index + 1} of {STAGES.length}</span>
        </p>
        {/* Not `.sheet-label`: its uppercase would change the note's rendered text, which the browser suite reads ("13 answered"). */}
        {note ? <span className="min-w-0 truncate font-mono text-[11px] tracking-[0.08em] text-ink-muted">{note}</span> : null}
      </div>
      <ol className="mt-2 grid grid-cols-5 gap-1" role="list">
        {segments.map(({ stage, label, state }) => {
          const clickable = state === 'done' && onJump !== undefined;
          const track = (
            <span className="ob-pager-seg relative block w-full overflow-hidden" data-state={state === 'now' ? 'ahead' : state} aria-hidden="true">
              {state === 'now' ? <motion.span layoutId="stage-path-live" transition={timing(PORTRAIT_S, reduced)} className="absolute inset-0 bg-flare" /> : null}
            </span>
          );
          const name = <span className={cx('coordbar mt-1.5 block truncate text-[9.5px]', state === 'now' ? 'text-ink' : state === 'done' ? 'text-ink-muted' : 'text-ink-faint', 'max-lg:sr-only')}>{label}</span>;
          return (
            <li key={stage} className="min-w-0">
              {clickable ? (
                <button type="button" onClick={() => onJump(stage)} className={cx('pressable flex min-h-11 w-full flex-col justify-start pt-2 text-left hover:text-accent-strong', FOCUS_RING)} data-testid={`stage-jump-${stage}`}>
                  {/* Not the word "Back": the interview already has a Back button, and two controls answering to one name is ambiguous. */}
                  <span className="sr-only">Go to </span>
                  {track}
                  {name}
                </button>
              ) : (
                <span className="block pt-2" aria-current={state === 'now' ? 'step' : undefined}>
                  {track}
                  {name}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
