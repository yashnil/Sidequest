import { cx } from '../ui';

/**
 * PROGRESS AS A PATH OF STAGES, NOT A COUNT.
 *
 * The interview is adaptive, so "Question 8 of 14" is a promise it cannot
 * keep. Five stages can be kept: basics are done on arrival, then what you
 * love, your rhythm, logistics, ready.
 *
 * EXPERIENCE V2 — drawn as a route: a thin line with a mark per stage, the
 * current one filled in the route colour and named, the others as points with
 * their names small beside them on a desktop and hidden on a phone (kept for
 * assistive technology). No pills, no aeroplane.
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
  if (questionId === 'priorities' || questionId === 'priority_roles' || questionId.startsWith('priority_role:')) return 'love';
  if (RHYTHM_IDS.has(questionId)) return 'rhythm';
  return 'logistics';
}

export function StagePath({ current, note }: { current: Stage; note?: string }) {
  const index = STAGES.indexOf(current);
  return (
    <nav aria-label="Interview progress" className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="stage-path">
      <ol className="flex items-center" role="list">
        {STAGES.map((stage, i) => {
          const done = i < index;
          const now = i === index;
          return (
            <li key={stage} className="flex items-center">
              <span className={cx('flex items-center gap-1.5', now && 'rounded-full bg-ink px-2.5 py-0.5')} aria-current={now ? 'step' : undefined}>
                <span
                  aria-hidden="true"
                  className={cx(
                    'inline-block shrink-0 rounded-full transition-colors duration-[var(--motion-base)]',
                    now ? 'h-1.5 w-1.5 bg-[var(--color-route-bright)]' : done ? 'h-2 w-2 bg-ink' : 'h-2 w-2 border border-ink-faint bg-paper',
                  )}
                />
                <span className={cx('whitespace-nowrap text-[11px] font-medium tracking-wide', now ? 'text-paper' : done ? 'text-ink max-lg:sr-only' : 'text-ink-faint max-lg:sr-only')}>{STAGE_LABELS[stage]}</span>
              </span>
              {i < STAGES.length - 1 ? <span aria-hidden="true" className={cx('mx-1.5 h-px w-4 sm:w-7', i < index ? 'bg-ink' : 'bg-rule')} /> : null}
            </li>
          );
        })}
      </ol>
      {note ? <span className="numeral text-xs text-ink-faint">{note}</span> : null}
    </nav>
  );
}
