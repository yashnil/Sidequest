import { cx } from '../ui';

/**
 * EXPERIENCE V2 — THE BASE SEQUENCE AS A ROUTE.
 *
 * Where you sleep, in order, drawn as the route it is: a node per base with
 * its nights, the drawn line between them. One base is one node and says so.
 * Every node is a link to the first day spent there, so the sequence drives
 * the Days view and its map. On the atlas band it draws in atlas ink; on paper
 * it draws in ink and the route teal.
 */
export interface BaseSequenceStop {
  id: string;
  name: string;
  nights: number;
  /** The first day that sleeps here, for the link into Days. */
  firstDay: number | null;
  insertedBySidequest?: boolean;
}

export function BaseSequence({ bases, variant = 'paper', className, testId = 'base-sequence' }: { bases: readonly BaseSequenceStop[]; variant?: 'paper' | 'atlas'; className?: string; testId?: string }) {
  if (bases.length === 0) return null;
  const onAtlas = variant === 'atlas';
  const node = onAtlas ? 'bg-[var(--color-atlas-ink)] border-[var(--color-atlas)]' : 'bg-ink border-paper';
  const text = onAtlas ? 'text-[var(--color-atlas-ink)]' : 'text-ink';
  const meta = onAtlas ? 'atlas-muted' : 'text-ink-faint';
  const line = onAtlas ? 'bg-[var(--color-route-bright)]/70' : 'bg-[var(--color-route)]';
  return (
    <ol className={cx('flex flex-wrap items-stretch gap-y-3', className)} aria-label="Where you sleep, in order" data-testid={testId}>
      {bases.map((base, index) => (
        <li key={base.id} className="flex min-w-0 items-center">
          <a
            href={base.firstDay ? `#day-${base.firstDay}` : '#days'}
            className={cx('pressable group flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-3 pl-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2', onAtlas ? 'hover:bg-white/10 focus-visible:outline-[var(--color-route-bright)]' : 'hover:bg-paper-sunk focus-visible:outline-pine')}
            data-testid="base-sequence-stop"
          >
            <span aria-hidden="true" className={cx('type-figure grid h-7 w-7 shrink-0 place-items-center rounded-sm border-2 text-xs', node, onAtlas ? 'text-[var(--color-atlas)]' : 'text-paper')}>
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className={cx('block truncate font-display text-lg leading-tight', text)}>{base.name}</span>
              <span className={cx('type-figure block text-xs font-medium leading-tight', meta)}>
                {base.nights} {base.nights === 1 ? 'night' : 'nights'}
                {base.insertedBySidequest ? ' · added for your driving limit' : ''}
              </span>
            </span>
          </a>
          {index < bases.length - 1 ? <span aria-hidden="true" className={cx('mx-1 h-0.5 w-6 shrink-0 rounded-full sm:w-10', line)} /> : null}
        </li>
      ))}
    </ol>
  );
}
