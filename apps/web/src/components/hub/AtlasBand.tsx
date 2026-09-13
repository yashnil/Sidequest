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
      {/* V11 §9 — tighter on a phone, where the band was the entire first screen. */}
      <div className="relative px-5 pb-4 pt-5 sm:px-8 sm:pb-6 sm:pt-7">
        <div className={cx('flex flex-wrap items-start justify-between gap-x-8 gap-y-3', Boolean(figure) && 'lg:max-w-[62%]')}>
          <p className="numeral type-small atlas-muted">{eyebrow}</p>
          {status ? (
            <p className="flex items-center gap-2 type-small">
              <span aria-hidden="true" className={cx('inline-block h-2 w-2 rounded-full', status.tone === 'ready' ? 'bg-[var(--color-route-bright)]' : status.tone === 'caution' ? 'bg-amber' : status.tone === 'blocked' ? 'bg-clay' : 'bg-[var(--color-atlas-muted)]')} />
              <span className="text-[var(--color-atlas-ink)]">{status.label}</span>
            </p>
          ) : null}
        </div>
        <h1 className={cx('display-atlas mt-1.5 max-w-[18ch] text-[var(--color-atlas-ink)]', Boolean(figure) && 'lg:max-w-[13ch]')}>{title}</h1>
        {/*
          V11 §9 — the subline is supporting text, so it is set as supporting
          text. It was `type-body` above a `type-small` facts line, which made
          the route sentence the second-loudest thing in the band and ran to
          three lines on a phone. The title carries the weight in a masthead;
          this says where the trip sleeps and how it moves.
        */}
        {subline ? <p className={cx('mt-2 max-w-2xl type-small atlas-muted', Boolean(figure) && 'lg:max-w-[46ch]')}>{subline}</p> : null}
        {/*
          V11 §9 — THE FACTS ARE A LINE, NOT A GRID.

          Each fact used to be a stacked label-over-value pair in a wrapping
          `dl`, which costs about forty-four vertical pixels to say "2
          travellers". The label is still there for assistive technology, where
          it is genuinely useful; it is simply no longer set as a heading above
          its own value in a masthead whose whole problem was height.
        */}
        {facts && facts.length > 0 ? (
          <dl className={cx('mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1', Boolean(figure) && 'lg:max-w-[58%]')} data-testid="atlas-facts">
            {facts.map((fact) => (
              <div key={fact.label} className="flex min-w-0 max-w-[46ch] items-baseline gap-2">
                <dt className="sr-only">{fact.label}</dt>
                {/* A fact that is a sentence gets the article a figure takes — "An 8-day", never "A 8-day". */}
                <dd className="type-small text-[var(--color-atlas-ink)]">{typeof fact.value === 'string' ? fixNumberArticles(fact.value) : fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {route ? <div className="mt-4">{route}</div> : null}
        {/*
          V11 §9 — the band states the trip's condition in a sentence and stops.
          The items are optional and, on the hub, are no longer passed: the
          verdict's own blurb says what state the plan is in, the Prepare tab
          carries the count as a badge, and the full list is on Prepare where it
          can be acted on. A masthead is not a place to read a list.
        */}
        {attention ? (
          /*
            V11 §8 §9 — A BOX INSIDE A BAND IS A BOX TOO MANY.

            The verdict sat in a bordered, tinted, padded card inside a band that
            is already one distinct surface: a nested box, and about twenty
            vertical pixels of chrome, to hold one sentence. The band's own
            ground separates it from the page; a rule above the sentence is
            enough to separate it from the title.
          */
          <div className={cx('mt-4 border-t border-white/12 pt-3', Boolean(figure) && 'lg:max-w-[58%]')} data-testid="atlas-attention">
            {/*
              A sentence, in sentence case. The verdict's blurb is prose —
              "The plan works. A few things are worth reading before you
              commit." — and setting prose in letter-spaced capitals is how a
              band ends up shouting a paragraph at somebody.
            */}
            <p className="type-small text-[var(--color-atlas-muted)]">{attention.heading}</p>
            {attention.items.length > 0 ? (
              <ul className="mt-2 space-y-1 type-small text-[var(--color-atlas-ink)]">
                {attention.items.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden="true" className="text-[var(--color-route-bright)]">—</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {actions ? <div className="atlas-actions mt-4 flex flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
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
