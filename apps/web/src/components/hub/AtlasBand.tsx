import type { ReactNode } from 'react';
import { cx } from '../ui';
import { fixNumberArticles } from './article';
import { splitDayTheme, type HeroStat } from './hero-stats';
import { humanDate } from './plan-format';

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

/** One day along the foot of the cover. */
export interface CoverDay {
  dayNumber: number;
  theme: string;
  date: string;
  /** Planned stops that day; omitted when unknown. */
  stops?: number;
  intensity?: 'light' | 'moderate' | 'intense';
}

const INTENSITY_DOTS: Record<NonNullable<CoverDay['intensity']>, number> = { light: 1, moderate: 2, intense: 3 };

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
  stage,
  days,
  stats,
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
  /**
   * THE COVER — the whole route on the night atlas, behind everything else.
   * Present only where a vector basemap is configured; without it the band is
   * the drawn masthead below, exactly as before.
   */
  stage?: ReactNode;
  /** The days, as a numbered strip along the foot of the cover. Each one opens that day. */
  days?: readonly CoverDay[];
  /** The trip's shape as glanceable tiles (stage variant only); the facts line steps aside for them. */
  stats?: readonly HeroStat[];
}) {
  if (stage) {
    return (
      <header className={cx('topo relative isolate -mx-5 overflow-hidden bg-night text-bone [--topo-opacity:0.07] sm:-mx-6', className)} data-testid="atlas-band" data-cover="stage">
        {/* The map: a band above the type on a phone, the whole ground on a wide screen. */}
        {/* The contour sheet sits under the map, so the cover is never a black slab while the tiles arrive. */}
        <div className="relative h-[38vh] min-h-[240px] lg:absolute lg:inset-0 lg:h-auto print:hidden">{stage}</div>
        {/*
          The scrim is only as dark as the type needs. It used to hold 82% night
          to a third of the width, which put the cover's left half — and most of
          the map — under near-black. Now it is a soft pool behind the title
          block and the map reads as a map everywhere else.
        */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden bg-[linear-gradient(90deg,rgb(13_26_31/0.86)_0%,rgb(13_26_31/0.55)_26%,rgb(13_26_31/0.12)_46%,rgb(13_26_31/0)_58%)] lg:block" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-40 bg-gradient-to-t from-night/90 via-night/40 to-transparent lg:block" />
        <div className="relative px-5 pt-5 pb-5 sm:px-8 lg:flex lg:min-h-[min(74vh,720px)] lg:max-w-[44rem] lg:flex-col lg:justify-end lg:pt-24 lg:pb-7 xl:px-12">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="coordbar text-bone/75">{eyebrow}</p>
            {status ? (
              <p
                className={cx(
                  'inline-flex items-center gap-2 rounded-full border bg-night/50 px-2.5 py-1 font-mono text-[0.68rem] font-semibold tracking-[0.14em] uppercase backdrop-blur-sm',
                  status.tone === 'ready' ? 'border-[var(--color-glacier)]/50 text-[var(--color-glacier)]' : status.tone === 'caution' ? 'border-[#e6a568]/50 text-[#e6a568]' : status.tone === 'blocked' ? 'border-[#eb9c91]/50 text-[#eb9c91]' : 'border-white/20 text-[var(--color-atlas-muted)]',
                )}
              >
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                <span>{status.label}</span>
              </p>
            ) : null}
          </div>
          <h1 className="display-stage mt-3 max-w-[12ch] text-[clamp(3rem,1.6rem+5.4vw,7rem)] text-bone [text-shadow:0_2px_24px_rgb(13_26_31/0.55)]">
            <span className="mask-rise"><span>{title}</span></span>
          </h1>
          {subline ? <p className="mt-3 max-w-[52ch] text-[15px] leading-relaxed text-bone/80 fade-up [--d:180ms]">{subline}</p> : null}
          {stats && stats.length > 0 ? (
            /*
              THE TRIP AT A GLANCE — days, stops, where you sleep, a typical
              day's travel against the limit, who is going. Tiles, not a
              sentence: the honest long form rides on each tile's title and is
              printed in full on the Trip view's Getting around card.
            */
            <dl className="mt-5 flex flex-wrap gap-2 fade-up [--d:220ms]" data-testid="hero-stats">
              {stats.map((stat) => (
                <div key={stat.id} className={cx('min-w-[5.75rem] flex-1 rounded-[10px] border border-white/12 bg-night/55 px-3 pt-2.5 pb-3 backdrop-blur-md', stat.id === 'travel' && 'min-w-[12rem] flex-[2]')} title={stat.detail} data-testid={`hero-stat-${stat.id}`}>
                  <dt className="font-mono text-[10px] font-semibold tracking-[0.14em] text-bone/60 uppercase">{stat.label}</dt>
                  <dd className="mt-1 truncate font-display text-[1.55rem] leading-none font-light text-bone">{stat.value}</dd>
                  {stat.sub ? <dd className="mt-1.5 truncate text-[12px] leading-tight text-bone/65">{stat.sub}</dd> : null}
                  {stat.gauge !== undefined ? (
                    <dd aria-hidden="true" className="mt-2 h-1 overflow-hidden rounded-full bg-white/12">
                      <span className="block h-full rounded-full bg-[var(--color-glacier)]" style={{ width: `${Math.max(6, Math.round(stat.gauge * 100))}%` }} />
                    </dd>
                  ) : null}
                  {stat.detail ? <dd className="sr-only">{stat.detail}</dd> : null}
                </div>
              ))}
            </dl>
          ) : null}
          {facts && facts.length > 0 ? (
            <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 fade-up [--d:240ms]" data-testid="atlas-facts">
              {facts.map((fact) => (
                <div key={fact.label} className="flex min-w-0 max-w-[46ch] items-baseline gap-2">
                  <dt className="sr-only">{fact.label}</dt>
                  <dd className="type-small text-bone/85">{typeof fact.value === 'string' ? fixNumberArticles(fact.value) : fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {route ? <div className="mt-5">{route}</div> : null}
          {attention ? (
            <div className="mt-4 flex items-start gap-2" data-testid="atlas-attention">
              <span aria-hidden="true" className={cx('mt-[0.45rem] inline-block h-1.5 w-1.5 shrink-0 rounded-full', status?.tone === 'ready' ? 'bg-[var(--color-glacier)]' : status?.tone === 'blocked' ? 'bg-[#eb9c91]' : 'bg-[#e6a568]')} />
              <p className="type-small text-bone/80">{attention.heading}</p>
              {attention.items.length > 0 ? (
                <ul className="mt-2 space-y-1 type-small text-bone">
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
          {actions ? <div className="atlas-actions mt-5 flex flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
        </div>
        {days && days.length > 0 ? (
          /*
            The days, along the foot of the cover: the trip's contents page, as
            cards you can press. Each is a real link to that day (`#day-3` opens
            the Days view on it) and shows the date, the day's own short title,
            the places on a second line and how many stops it holds.
          */
          <nav aria-label="The days" className="relative print:hidden" data-testid="cover-days">
            <ol className="no-scrollbar flex snap-x gap-2 overflow-x-auto px-5 pb-4 sm:px-8 lg:pb-5 xl:px-12">
              {days.map((day) => {
                const { title: dayTitle, places } = splitDayTheme(day.theme);
                return (
                  <li key={day.dayNumber} className="min-w-[12.5rem] flex-1 snap-start">
                    <a
                      href={`#day-${day.dayNumber}`}
                      className="group flex h-full min-h-11 flex-col rounded-[12px] border border-white/12 bg-night/60 px-3.5 pt-3 pb-3 backdrop-blur-md transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:bg-night/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-route-bright)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                    >
                      <span className="sr-only">Day {day.dayNumber}: </span>
                      <span aria-hidden="true" className="flex items-baseline justify-between gap-2">
                        <span className="font-display text-[1.45rem] leading-none font-light text-bone group-hover:text-flare">{String(day.dayNumber).padStart(2, '0')}</span>
                        <time dateTime={day.date} className="font-mono text-[10px] font-semibold tracking-[0.12em] text-bone/60 uppercase">{humanDate(day.date)}</time>
                      </span>
                      <span className={cx('mt-2 text-[14px] font-medium leading-snug text-bone', places ? 'line-clamp-1' : 'line-clamp-2')}>{dayTitle}</span>
                      {places ? <span className="mt-0.5 line-clamp-1 text-[12px] leading-snug text-bone/60">{places}</span> : null}
                      {day.stops !== undefined || day.intensity ? (
                        <span aria-hidden="true" className="mt-auto flex items-center gap-2 pt-2 text-[11px] text-bone/55">
                          {day.stops !== undefined ? <span>{day.stops === 0 ? 'No stops' : `${day.stops} ${day.stops === 1 ? 'stop' : 'stops'}`}</span> : null}
                          {day.intensity ? (
                            <span className="inline-flex items-center gap-0.5" title={`${day.intensity} day`}>
                              {[1, 2, 3].map((n) => (
                                <span key={n} className={cx('inline-block h-1 w-2.5 rounded-full', n <= INTENSITY_DOTS[day.intensity!] ? 'bg-[var(--color-glacier)]' : 'bg-white/15')} />
                              ))}
                              <span className="ml-1 capitalize">{day.intensity}</span>
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}
      </header>
    );
  }
  return (
    <header className={cx('atlas topo relative overflow-hidden rounded-[var(--radius-plate)] [--topo-opacity:0.07]', className)} data-testid="atlas-band">
      {figure ? (
        <div aria-hidden="true" className="atlas-figure pointer-events-none absolute inset-y-0 right-0 hidden w-[46%] lg:block print:hidden">
          {figure}
        </div>
      ) : null}
      {/* V11 §9 — tighter on a phone, where the band was the entire first screen. */}
      <div className="relative px-5 pb-4 pt-5 sm:px-8 sm:pb-6 sm:pt-7">
        <div className={cx('flex flex-wrap items-start justify-between gap-x-8 gap-y-3', Boolean(figure) && 'lg:max-w-[62%]')}>
          <p className="font-mono text-[0.75rem] tracking-[0.04em] atlas-muted">{eyebrow}</p>
          {status ? (
            <p
              className={cx(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.12em]',
                status.tone === 'ready' ? 'border-[var(--color-glacier)]/50 text-[var(--color-glacier)]' : status.tone === 'caution' ? 'border-[#e6a568]/50 text-[#e6a568]' : status.tone === 'blocked' ? 'border-[#eb9c91]/50 text-[#eb9c91]' : 'border-white/20 text-[var(--color-atlas-muted)]',
              )}
            >
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
              <span>{status.label}</span>
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
