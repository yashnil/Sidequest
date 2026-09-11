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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0">
          <span className="type-small font-semibold text-ink">{STAGE_LABELS[current]}</span>
          <span className="type-meta ml-2">
            stage {index + 1} of {STAGES.length}
          </span>
        </p>
        {/*
          The trip so far, as context rather than as a sixth stage. Seen on the
          live Kyrgyzstan run reading as one orphan word at the end of the path;
          on the other side of the line, quieter, it reads as what it is.
        */}
        {note ? <span className="numeral type-meta min-w-0 truncate">{note}</span> : null}
      </div>
      <ol className="mt-2 grid grid-cols-5 gap-1.5" role="list">
        {segments.map(({ stage, label, state }) => {
          /*
           * MVP V3, Stage 40 — a finished stage is a way back.
           *
           * Only a *finished* one: a stage the traveller has not reached is not
           * a place they can go, and rendering it as a control that refuses is
           * worse than rendering it as what it is. The label is a real button
           * with a real accessible name, so this works from the keyboard.
           */
          const clickable = state === 'done' && onJump !== undefined;
          const track = (
            <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-rule" aria-hidden="true">
              {state === 'done' ? <span className="absolute inset-0 rounded-full bg-ink" /> : null}
              {state === 'now' ? (
                <motion.span layoutId="stage-path-live" transition={timing(PORTRAIT_S, reduced)} className="absolute inset-0 rounded-full bg-accent" />
              ) : null}
            </span>
          );
          const name = (
            <span className={cx('mt-1.5 block truncate text-xs leading-snug', state === 'now' ? 'font-semibold text-ink' : state === 'done' ? 'text-ink-muted' : 'text-ink-faint', 'max-lg:sr-only')}>
              {label}
            </span>
          );
          return (
            <li key={stage} className="min-w-0">
              {clickable ? (
                <button type="button" onClick={() => onJump(stage)} className={cx('pressable block min-h-11 w-full rounded-[var(--radius-control)] pt-2 text-left hover:text-accent-strong', FOCUS_RING)} data-testid={`stage-jump-${stage}`}>
                  {/* Not the word "Back": the interview already has a Back button, and two controls answering to one name is ambiguous for a screen-reader user reading a control list. */}
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
