import type { ReactNode } from 'react';
import { cx } from '../../ui';

/**
 * THE HEAD OF A READING VIEW.
 *
 * A sheet label in the margin (what this sheet is about, in mono), the view's
 * name set large and light, one sentence, and — when the view has them — its
 * figures in boxed cells that share their borders. The figures are the view's
 * own counts read from the same data the rows below render; nothing here is a
 * score.
 */
export interface ViewFigure {
  label: string;
  value: ReactNode;
  href?: string;
  testId?: string;
  /** Extra data attributes a spec addresses the cell by. */
  attrs?: Record<string, string>;
}

export function ViewHead({ sheet, title, titleId, lede, figures = [], children, className }: { sheet: string; title: ReactNode; titleId?: string; lede?: ReactNode; figures?: readonly ViewFigure[]; children?: ReactNode; className?: string }) {
  return (
    <header className={cx('hv-head', className)}>
      <p className="sheet-label text-ink-muted fade-up">{sheet}</p>
      <h2 id={titleId} className="hv-title mt-3">
        <span className="mask-rise">
          <span>{title}</span>
        </span>
      </h2>
      {lede ? <p className="hv-lede fade-up" style={{ ['--d' as string]: '120ms' }}>{lede}</p> : null}
      {figures.length > 0 ? <FigureRow figures={figures} className="mt-6" /> : null}
      {children}
    </header>
  );
}

export function FigureRow({ figures, className }: { figures: readonly ViewFigure[]; className?: string }) {
  return (
    <dl className={cx('hv-figs fade-up', className)} style={{ ['--hv-cols' as string]: String(Math.min(figures.length, 5)), ['--d' as string]: '180ms' }}>
      {figures.map((figure) => {
        const body = (
          <>
            <dt>{figure.label}</dt>
            <dd>{figure.value}</dd>
          </>
        );
        return figure.href ? (
          <a key={figure.label} href={figure.href} className="label-box block" {...(figure.testId ? { 'data-testid': figure.testId } : {})} {...figure.attrs}>
            {body}
          </a>
        ) : (
          <div key={figure.label} className="label-box" {...(figure.testId ? { 'data-testid': figure.testId } : {})} {...figure.attrs}>
            {body}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A RAIL SECTION: a sticky margin label (an order number, a title, a count and
 * one line) beside an ink thread that carries the rows. Used wherever the rows
 * have an order a traveller reads down — booking deadlines, readiness.
 */
export function RailSection({ index, title, count, blurb, quiet = false, children, testId, headingLevel = 3, headingId, aside, attrs }: { index: string; title: string; count?: number; blurb?: ReactNode; quiet?: boolean; children: ReactNode; testId?: string; headingLevel?: 2 | 3; headingId?: string; aside?: ReactNode; attrs?: Record<string, string> }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="hv-tl" data-tone={quiet ? 'quiet' : 'strong'} {...(testId ? { 'data-testid': testId } : {})} {...attrs}>
      <div className="hv-tl-rail pt-3 md:pt-0">
        <p className="sheet-label text-ink-muted">{index}</p>
        <div className="mt-2 flex items-end justify-between gap-3 md:block">
          <Heading id={headingId} className="type-section scroll-mt-[calc(var(--chrome-height)+4.5rem)] text-ink">
            {title}
          </Heading>
          {count !== undefined ? <p className="hv-tl-count md:mt-3">{String(count).padStart(2, '0')}</p> : null}
        </div>
        {blurb ? <p className="mt-2 type-meta">{blurb}</p> : null}
        {aside}
      </div>
      <div className="hv-tl-body">{children}</div>
    </div>
  );
}
