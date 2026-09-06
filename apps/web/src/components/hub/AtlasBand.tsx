import type { ReactNode } from 'react';
import { cx } from '../ui';

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
 * Nothing here is decorative motion: the band renders once, server-side, and
 * the route rule is a static drawn line.
 */
export function AtlasBand({
  eyebrow,
  title,
  subline,
  route,
  status,
  actions,
  className,
}: {
  /** "12 – 16 Aug · 5 days · 9 stops" */
  eyebrow: ReactNode;
  title: ReactNode;
  /** One sentence under the name: the trip in the traveller's terms. */
  subline?: ReactNode;
  /** The base sequence, drawn through the band. */
  route?: ReactNode;
  status?: { label: string; tone: 'ready' | 'caution' | 'blocked' | 'neutral'; blurb?: string };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('atlas relative overflow-hidden rounded-[var(--radius-plate)]', className)} data-testid="atlas-band">
      <div className="relative px-5 pb-5 pt-6 sm:px-8 sm:pb-6 sm:pt-8">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <p className="numeral type-small atlas-muted">{eyebrow}</p>
          {status ? (
            <p className="flex items-center gap-2 type-small">
              <span aria-hidden="true" className={cx('inline-block h-2 w-2 rounded-full', status.tone === 'ready' ? 'bg-[var(--color-route-bright)]' : status.tone === 'caution' ? 'bg-amber' : status.tone === 'blocked' ? 'bg-clay' : 'bg-[var(--color-atlas-muted)]')} />
              <span className="text-[var(--color-atlas-ink)]">{status.label}</span>
              {status.blurb ? <span className="hidden atlas-muted sm:inline">· {status.blurb}</span> : null}
            </p>
          ) : null}
        </div>
        <h1 className="display-atlas mt-2 max-w-[18ch] text-[var(--color-atlas-ink)]">{title}</h1>
        {subline ? <p className="mt-3 max-w-2xl type-body atlas-muted">{subline}</p> : null}
        {route ? <div className="mt-5">{route}</div> : null}
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
