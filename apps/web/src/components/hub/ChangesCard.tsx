import type { DeltaLine } from '@sidequest/core';
import { cx } from '../ui';

/**
 * V9 §4 — THE DELTA, AS LINES A TRAVELLER READS.
 *
 * "Bases 4 → 3 · Hotel changes 3 → 2 · Signature stops kept 3/3 · Days 4 and 5
 * change." One component for both moments: the proposal (a draft delta, before
 * any provider has run) and the applied result (a measured delta from the
 * structural metrics). Each line carries its label and its tone so a test and
 * a screen reader can tell an improvement from a cost without the colour.
 */
export function ChangesCard({ lines, headline, testId, eyebrow, className }: { lines: readonly DeltaLine[]; headline?: string; testId: string; eyebrow?: string; className?: string }) {
  if (lines.length === 0) return null;
  return (
    <div data-testid={testId} className={cx('rounded-[var(--radius-card)] border border-rule bg-paper px-3.5 py-3', className)}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      {headline ? <p className={cx('type-small font-semibold text-ink', eyebrow && 'mt-1')}>{headline}</p> : null}
      <dl className={cx('grid gap-x-4 gap-y-1.5 sm:grid-cols-2', (eyebrow || headline) && 'mt-2')}>
        {lines.map((line) => (
          <div key={line.label} data-testid="delta-line" data-label={line.label} data-tone={line.tone} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="text-ink-muted">{line.label}</dt>
            <dd className={cx('type-figure text-right', line.tone === 'better' ? 'text-pine' : line.tone === 'worse' ? 'text-amber' : 'text-ink')}>
              {line.before ? (
                <>
                  <span className="text-ink-faint">{line.before}</span>
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only"> to </span>
                </>
              ) : null}
              {line.after}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
