import { cx } from '../ui';

/**
 * PROGRESS AS A PATH OF STAGES, NOT A COUNT.
 *
 * The interview is adaptive, so "Question 8 of 14" is a promise it cannot
 * keep. Five stages can be kept: basics are done on arrival, then what you
 * love, your rhythm, logistics, ready. The current stage is filled in ochre;
 * the count is a quiet secondary note for anybody who wants it.
 */
export const STAGES = ['basics', 'love', 'rhythm', 'logistics', 'ready'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  basics: 'Basics',
  love: 'What you love',
  rhythm: 'Your rhythm',
  logistics: 'Logistics',
  ready: 'Ready',
};

const RHYTHM_IDS = new Set(['day_shape', 'day_start', 'effort', 'iconic_crowds', 'famous_vs_hidden', 'hike_appetite', 'walking_tolerance', 'free_time', 'late_nights', 'weather_avoidances']);

export function stageOf(questionId: string | null): Stage {
  if (questionId === null) return 'basics';
  if (questionId === 'review') return 'ready';
  if (questionId === 'priorities' || questionId.startsWith('priority_role:')) return 'love';
  if (RHYTHM_IDS.has(questionId)) return 'rhythm';
  return 'logistics';
}

export function StagePath({ current, note }: { current: Stage; note?: string }) {
  const index = STAGES.indexOf(current);
  return (
    <nav aria-label="Interview progress" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <ol className="flex items-center gap-1.5" role="list">
        {STAGES.map((stage, i) => {
          const done = i < index;
          const now = i === index;
          return (
            <li key={stage} className="flex items-center gap-1.5">
              {/*
                On a phone the four stages that are not current collapse to
                dots — five spelled-out pills wrap to three lines at 390px and
                the path stops reading as a path. The label stays in the DOM
                for assistive technology.
              */}
              <span
                className={cx(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-full border text-[11px] font-medium uppercase tracking-[0.12em] transition-colors duration-[var(--motion-base)]',
                  now ? 'border-accent bg-accent px-2.5 py-1 text-paper' : done ? 'border-ink text-ink max-sm:bg-ink sm:px-2.5 sm:py-1' : 'border-rule text-ink-faint sm:px-2.5 sm:py-1',
                  !now && 'max-sm:h-2.5 max-sm:w-2.5',
                )}
                aria-current={now ? 'step' : undefined}
              >
                {done ? (
                  <span aria-hidden="true" className="text-[10px] max-sm:hidden">
                    ✓
                  </span>
                ) : null}
                <span className={now ? '' : 'max-sm:sr-only'}>{STAGE_LABELS[stage]}</span>
              </span>
              {i < STAGES.length - 1 ? <span aria-hidden="true" className={cx('h-px w-3 max-sm:w-1.5', i < index ? 'bg-ink' : 'bg-rule')} /> : null}
            </li>
          );
        })}
      </ol>
      {note ? <span className="numeral text-xs text-ink-faint">{note}</span> : null}
    </nav>
  );
}
