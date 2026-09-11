import type { ReactNode } from 'react';
import { cx } from '../ui';
import { fixNumberArticles } from './article';

/**
 * EXPERIENCE V2 — THE ATLAS BAND.
 *
 * The one aesthetic risk of the redesign, documented in
 * `.claude-private/SIDEQUEST-EXPERIENCE-V2.md`: every trip opens on a deep
 * cartographic ground with the destination's name set large in the display
 * serif, the dates and the shape of the trip in small sans beside it, the
 * route drawn through the band as a structural rule, and the actions in one
 * quiet row. Paper stays below; the band is where the trip is a place.
 *
 * V6 — the band answers the five questions a finished trip is opened for:
 * where, when, who, what kind of trip, and what still needs attention. The
 * photograph (when one of this trip's own places has a licensed one) is the
 * band's ground rather than a card below it; `facts` carries who and what kind
 * of trip; `attention` carries the feasibility report's verdict and the first
 * two things worth reading. Nothing is decorative motion: the band renders once,
 * server-side, and the route rule is a static drawn line.
 */
export interface AtlasFact {
  label: string;
  value: ReactNode;
}

export function AtlasBand({
  eyebrow,
  title,
  subline,
  route,
  status,
  actions,
  facts,
  attention,
  figure,
  className,
}: {
  /** "12 – 16 Aug · 5 days · 9 stops" */
  eyebrow: ReactNode;
  title: ReactNode;
  /** One sentence under the name: the trip in the traveller's terms. */
  subline?: ReactNode;
  /** The base sequence, drawn through the band. */
  route?: ReactNode;
  status?: { label: string; tone: 'ready' | 'caution' | 'blocked' | 'neutral' };
  actions?: ReactNode;
  /** Who is going, and what kind of trip this is. Two or three, never a dashboard. */
  facts?: readonly AtlasFact[];
  /** The feasibility verdict's own items — what to read before committing. */
  attention?: { heading: string; items: readonly string[] };
  /** A photograph of somewhere on this trip, used as the band's ground. */
  figure?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('atlas relative overflow-hidden rounded-[var(--radius-plate)]', className)} data-testid="atlas-band">
      {figure ? (
        <div aria-hidden="true" className="atlas-figure pointer-events-none absolute inset-y-0 right-0 hidden w-[46%] lg:block print:hidden">
          {figure}
        </div>
      ) : null}
      <div className="relative px-5 pb-5 pt-6 sm:px-8 sm:pb-6 sm:pt-8">
        <div className={cx('flex flex-wrap items-start justify-between gap-x-8 gap-y-3', Boolean(figure) && 'lg:max-w-[62%]')}>
          <p className="numeral type-small atlas-muted">{eyebrow}</p>
          {status ? (
            <p className="flex items-center gap-2 type-small">
              <span aria-hidden="true" className={cx('inline-block h-2 w-2 rounded-full', status.tone === 'ready' ? 'bg-[var(--color-route-bright)]' : status.tone === 'caution' ? 'bg-amber' : status.tone === 'blocked' ? 'bg-clay' : 'bg-[var(--color-atlas-muted)]')} />
              <span className="text-[var(--color-atlas-ink)]">{status.label}</span>
            </p>
          ) : null}
        </div>
        <h1 className={cx('display-atlas mt-2 max-w-[18ch] text-[var(--color-atlas-ink)]', Boolean(figure) && 'lg:max-w-[13ch]')}>{title}</h1>
        {subline ? <p className={cx('mt-3 max-w-2xl type-body atlas-muted', Boolean(figure) && 'lg:max-w-[46ch]')}>{subline}</p> : null}
        {facts && facts.length > 0 ? (
          <dl className={cx('mt-5 flex flex-wrap gap-x-10 gap-y-4', Boolean(figure) && 'lg:max-w-[58%]')} data-testid="atlas-facts">
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0 max-w-[34ch]">
                <dt className="label text-[var(--color-atlas-muted)]">{fact.label}</dt>
                {/* A fact that is a sentence gets the article a figure takes — "An 8-day", never "A 8-day". */}
                <dd className="mt-1 type-small text-[var(--color-atlas-ink)]">{typeof fact.value === 'string' ? fixNumberArticles(fact.value) : fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {route ? <div className="mt-5">{route}</div> : null}
        {attention && attention.items.length > 0 ? (
          <div className={cx('mt-5 rounded-[var(--radius-card)] border border-white/15 bg-white/[0.06] px-4 py-3', Boolean(figure) && 'lg:max-w-[58%]')} data-testid="atlas-attention">
            {/*
              A sentence, in sentence case. The verdict's blurb is prose —
              "The plan works. A few things are worth reading before you
              commit." — and setting prose in letter-spaced capitals is how a
              band ends up shouting a paragraph at somebody.
            */}
            <p className="type-small text-[var(--color-atlas-muted)]">{attention.heading}</p>
            <ul className="mt-2 space-y-1 type-small text-[var(--color-atlas-ink)]">
              {attention.items.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden="true" className="text-[var(--color-route-bright)]">—</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {actions ? <div className="atlas-actions mt-5 flex flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Button classes for controls that sit on the atlas ground. */
export function atlasButtonClass(kind: 'primary' | 'ghost' = 'ghost'): string {
  return cx(
    'pressable inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-route-bright)]',
    kind === 'primary' ? 'bg-[var(--color-atlas-ink)] text-[var(--color-atlas)] hover:bg-white' : 'border border-white/20 text-[var(--color-atlas-ink)] hover:border-white/40 hover:bg-white/10',
  );
}
