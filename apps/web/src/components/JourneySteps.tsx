import { cx } from './ui';

/**
 * WHERE THE TRAVELLER IS IN THE ONE JOURNEY (2026-11).
 *
 * The scan screen said "Step 2 of 3 · Finding places" and the build screen
 * said nothing about steps at all, so "Plan with smart defaults" read as two
 * unrelated loading screens back to back. Both now carry this rail, with the
 * board's own three steps — your answers, places, your trip — and the earlier
 * ones ticked, so the second screen is the next step of the same journey.
 */
export const JOURNEY_STEPS = ['Your answers', 'Places', 'Your trip'] as const;

export function JourneySteps({ current, label, tone = 'night', className }: { current: 0 | 1 | 2; label?: string; tone?: 'night' | 'paper'; className?: string }) {
  const ink = tone === 'night' ? 'text-[var(--color-atlas-ink)]' : 'text-ink';
  const muted = tone === 'night' ? 'text-[var(--color-atlas-muted)]' : 'text-ink-muted';
  return (
    <ol className={cx('sheet-label flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1', className)} aria-label={`Step ${current + 1} of ${JOURNEY_STEPS.length}`} data-testid="journey-steps" data-step={current + 1}>
      {JOURNEY_STEPS.map((step, index) => {
        const done = index < current;
        const now = index === current;
        return (
          <li key={step} className="flex items-center gap-2" aria-current={now ? 'step' : undefined}>
            <span aria-hidden="true" className={cx('grid h-4 w-4 place-items-center rounded-full border text-[9px] leading-none', done ? 'border-[var(--color-flare)] bg-[var(--color-flare)] text-[var(--color-night)]' : now ? 'border-[var(--color-glacier)]' : tone === 'night' ? 'border-white/25' : 'border-ink/25')}>
              {done ? '✓' : null}
            </span>
            <span className={now ? (tone === 'night' ? 'text-[var(--color-glacier)]' : 'text-accent') : done ? ink : muted}>{now && label ? `${step} · ${label}` : step}</span>
            {index < JOURNEY_STEPS.length - 1 ? <span aria-hidden="true" className={cx('mx-0.5', muted)}>—</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
