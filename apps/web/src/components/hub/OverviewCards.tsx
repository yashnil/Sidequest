import type { ReactNode } from 'react';
import { TRANSPORT_MODE_LABELS, type TransportStrategy } from '@sidequest/core';
import { Badge, cx, type BadgeTone } from '../ui';
import type { BaseSequenceStop } from './BaseSequence';

/**
 * V8 — THE OVERVIEW IS AN ARGUMENT MADE WITH OBJECTS.
 *
 * The overview used to be a headline, three list rows, one line about where
 * you sleep and a sentence about the dates — then forty per cent of the screen
 * empty. Each thing the argument needs is a card now: where you sleep (one
 * card per base, with its nights), the dates and the kind of weather
 * knowledge behind them, the transport reality, and the cautions that would
 * change a decision. Nothing here is new information; it is the same facts,
 * given a shape a reader can scan and a column that was going unused.
 */
export function OverviewCard({ eyebrow, title, children, testId, className, tone = 'plain' }: { eyebrow?: string; title: ReactNode; children: ReactNode; testId?: string; className?: string; tone?: 'plain' | 'caution' }) {
  return (
    <section className={cx('card p-5', tone === 'caution' && 'border-amber/50', className)} {...(testId ? { 'data-testid': testId } : {})}>
      {eyebrow ? <p className={cx('eyebrow', tone === 'caution' && 'text-amber')}>{eyebrow}</p> : null}
      <h2 className={cx('type-section text-ink', eyebrow && 'mt-1')}>{title}</h2>
      {children}
    </section>
  );
}

/** Where you sleep, as cards: one per base, each a link into the first day spent there. */
export function BaseCards({ bases }: { bases: readonly BaseSequenceStop[] }) {
  if (bases.length === 0) return null;
  return (
    <ol className={cx('grid gap-3', bases.length > 1 && 'sm:grid-cols-2')} aria-label="Where you sleep, in order" data-testid="base-cards">
      {bases.map((base, index) => (
        <li key={base.id} className="min-w-0">
          <a href={base.firstDay ? `#day-${base.firstDay}` : '#days'} className="card lift pressable flex min-h-[4.5rem] items-center gap-4 px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine" data-testid="base-card">
            <span aria-hidden="true" className="type-figure grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-ink text-sm text-paper">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-xl leading-tight text-ink">{base.name}</span>
              {base.insertedBySidequest ? <span className="mt-0.5 block type-meta">Added for your driving limit</span> : null}
            </span>
            <span className="shrink-0 text-right">
              <span className="type-figure block text-lg leading-none text-ink">{base.nights}</span>
              <span className="type-meta block">{base.nights === 1 ? 'night' : 'nights'}</span>
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The dates, who decided them, why, and the kind of weather knowledge behind the plan. One card. */
export function TimingCard({ dateLabel, decidedBy, rationale, seasonLine }: { dateLabel: string; decidedBy: 'traveller' | 'sidequest' | null; rationale: string | null; seasonLine: string | null }) {
  if (!decidedBy && !rationale && !seasonLine) return null;
  return (
    <OverviewCard eyebrow="When" title={<span className="type-figure text-[1.25rem]">{dateLabel}</span>} testId="timing-overview">
      {decidedBy ? (
        <p className="mt-2 type-small text-ink" data-testid="timing-owner">
          {decidedBy === 'traveller' ? `You chose ${dateLabel}.` : `Sidequest chose ${dateLabel}.`}
        </p>
      ) : null}
      {rationale ? (
        <p className="mt-2 type-small text-ink-muted" data-testid="timing-rationale">
          {rationale}
        </p>
      ) : null}
      {seasonLine ? <p className="mt-3 flex items-start gap-2 type-meta"><span aria-hidden="true">☼</span>{seasonLine}</p> : null}
    </OverviewCard>
  );
}

/**
 * Two scales that run in opposite directions. High stress is a caution; high
 * convenience is the best outcome there is, and sharing one map painted it amber.
 */
export const STRESS_TONE: Record<TransportStrategy['stress'], BadgeTone> = { low: 'pine', moderate: 'blue', high: 'amber' };
export const CONVENIENCE_TONE: Record<TransportStrategy['convenience'], BadgeTone> = { low: 'amber', moderate: 'blue', high: 'pine' };
export const STRESS_LABELS: Record<TransportStrategy['stress'], string> = { low: 'Easy-going days', moderate: 'Some long legs', high: 'Demanding days' };
export const CONVENIENCE_LABELS: Record<TransportStrategy['convenience'], string> = { low: 'Hands-on logistics', moderate: 'Some legwork', high: 'Easy logistics' };

/** The transport reality: the headline, the mode and the two words that say how the days feel. */
export function TransportCard({ strategy }: { strategy: TransportStrategy }) {
  return (
    <OverviewCard eyebrow="Getting around" title={TRANSPORT_MODE_LABELS[strategy.primaryMode]} testId="transport-overview">
      <p className="mt-2 type-small text-ink-muted">{strategy.headline}</p>
      <p className="mt-3 flex flex-wrap gap-1.5">
        {strategy.secondaryMode ? <Badge tone="blue">plus {TRANSPORT_MODE_LABELS[strategy.secondaryMode].toLowerCase()}</Badge> : null}
        <Badge tone={STRESS_TONE[strategy.stress]}>{STRESS_LABELS[strategy.stress]}</Badge>
        <Badge tone={CONVENIENCE_TONE[strategy.convenience]}>{CONVENIENCE_LABELS[strategy.convenience]}</Badge>
      </p>
      <a href="#getting-around" className="mt-3 inline-block type-small text-accent-strong underline underline-offset-4">
        The transport plan
      </a>
    </OverviewCard>
  );
}

/** Only what would change a decision: the feasibility report's blockers and dependencies. Cautions live on Prepare. */
export function CautionsCard({ items }: { items: readonly { severity: 'blocker' | 'dependency' | 'caution'; dayNumber?: number; detail: string }[] }) {
  const major = items.filter((item) => item.severity !== 'caution');
  if (major.length === 0) return null;
  return (
    <OverviewCard eyebrow={major.length === 1 ? 'One thing to settle' : `${major.length} things to settle`} title="Before you commit" testId="overview-cautions" tone="caution">
      <ul className="mt-3 space-y-2.5">
        {major.slice(0, 4).map((item, index) => (
          <li key={`${item.detail}-${index}`} className="flex items-start gap-3 type-small text-ink">
            <Badge tone={item.severity === 'blocker' ? 'clay' : 'amber'}>{item.severity === 'blocker' ? 'Settle' : 'Decide'}</Badge>
            <span className="min-w-0">
              {item.dayNumber ? <span className="type-figure text-ink-faint">Day {item.dayNumber} · </span> : null}
              {item.detail.charAt(0).toUpperCase() + item.detail.slice(1)}
            </span>
          </li>
        ))}
      </ul>
      <a href="#prepare" className="mt-3 inline-block type-small text-accent-strong underline underline-offset-4">
        Everything to check
      </a>
    </OverviewCard>
  );
}
