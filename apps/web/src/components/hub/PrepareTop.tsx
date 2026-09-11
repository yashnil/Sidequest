import { cx } from '../ui';

/**
 * EXPERIENCE V2 — THE THREE THINGS THAT MATTER.
 *
 * Prepare used to open on eight stacked sections. It opens on at most three
 * lines now — what would break the trip if it is not done — each a link to
 * the section that holds the detail. Everything else is below, collapsed.
 * Nothing here is a count of warnings.
 */
export interface PrepareTopItem {
  id: string;
  title: string;
  detail?: string;
  href: string;
  tone: 'book' | 'check' | 'decide';
}

const TONE: Record<PrepareTopItem['tone'], { word: string; className: string }> = {
  book: { word: 'Book', className: 'bg-accent text-paper' },
  check: { word: 'Check', className: 'bg-amber text-paper' },
  decide: { word: 'Decide', className: 'bg-clay text-paper' },
};

export function PrepareTop({ items }: { items: readonly PrepareTopItem[] }) {
  if (items.length === 0) {
    return (
      <div className="card border-pine/40 bg-pine-soft/50 p-5" data-testid="prepare-top">
        <p className="type-body text-ink">Nothing on this trip needs arranging right now. The sections below are here when you want them.</p>
      </div>
    );
  }
  return (
    <section aria-labelledby="prepare-top-heading" data-testid="prepare-top">
      <h2 id="prepare-top-heading" className="type-title text-ink">
        {items.length === 1 ? 'The one thing that matters' : `The ${items.length === 2 ? 'two' : 'three'} things that matter`}
      </h2>
      <ol className="mt-4 grid gap-3">
        {items.map((item) => (
          <li key={item.id}>
            <a href={item.href} className="card lift pressable group flex items-start gap-4 px-4 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine" data-testid="prepare-top-item">
              <span className={cx('eyebrow mt-1 inline-flex h-6 shrink-0 items-center rounded-sm px-1.5 !text-paper', TONE[item.tone].className)}>{TONE[item.tone].word}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-lg leading-snug text-ink group-hover:underline group-hover:underline-offset-4">{item.title}</span>
                {item.detail ? <span className="mt-0.5 block type-small text-ink-muted">{item.detail}</span> : null}
              </span>
              <span aria-hidden="true" className="mt-1 text-ink-faint">
                ↓
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
