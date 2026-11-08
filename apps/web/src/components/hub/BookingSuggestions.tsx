import { cx } from '../ui';
import type { SuggestedBooking } from './booking-links';

/**
 * 2026-11 — BOOK BEFORE YOU GO.
 *
 * The first thing on Bookings: every stay, the car or the transfers, and the
 * tickets the plan depends on — each a row with the dates and party already
 * filled into the links. A link is a search on a booking site or the
 * operator's own page; Sidequest never shows a price or availability it has
 * not seen, and says so once, quietly, under the list.
 */
const KIND_GLYPH: Record<SuggestedBooking['kind'], string> = {
  stay: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  car: 'M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16M4 16h16v3H4zM7 19v1.5M17 19v1.5',
  transfer: 'M4 8h13l-3-3M20 16H7l3 3',
  ticket: 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM14 7v10',
};

const KIND_WORD: Record<SuggestedBooking['kind'], string> = { stay: 'Stay', car: 'Car', transfer: 'Transfer', ticket: 'Tickets' };

export function BookingSuggestions({ items }: { items: readonly SuggestedBooking[] }) {
  if (items.length === 0) return null;
  const open = items.filter((item) => item.status === 'open').length;
  return (
    <section className="mt-10" aria-labelledby="book-before-heading" data-testid="booking-suggestions">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="book-before-heading" className="font-display text-[1.75rem] leading-tight font-light text-ink">
          Book before you go
        </h2>
        <p className="type-small text-ink-muted">{open === 0 ? 'Everything here is booked.' : `${open} of ${items.length} still to book`}</p>
      </div>
      <ol className="mt-5 grid gap-3 md:grid-cols-2">
        {items.map((item, index) => (
          <li
            key={item.id}
            className={cx('card lift fade-up flex min-w-0 flex-col p-5', item.status === 'booked' && 'opacity-75')}
            style={{ ['--d' as string]: `${Math.min(index, 8) * 50}ms` }}
            data-testid="booking-suggestion"
            data-kind={item.kind}
            data-status={item.status}
          >
            <div className="flex items-start gap-3.5">
              <span aria-hidden="true" className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-full', item.status === 'booked' ? 'bg-pine text-paper' : 'bg-paper-sunk text-ink')}>
                {item.status === 'booked' ? (
                  <span className="text-sm">✓</span>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d={KIND_GLYPH[item.kind]} />
                  </svg>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="sheet-label text-ink-faint">{item.status === 'booked' ? 'Booked' : KIND_WORD[item.kind]}</p>
                <p className="mt-0.5 font-display text-lg leading-snug text-ink">{item.title}</p>
                <p className="mt-1 type-small text-ink-muted">{item.detail}</p>
                {item.why ? <p className="mt-1.5 line-clamp-2 type-small text-ink-faint">{item.why}</p> : null}
              </div>
            </div>
            {item.status === 'open' ? (
              <div className="mt-4 flex flex-wrap gap-2 pl-[3.375rem]">
                {item.links.map((link, linkIndex) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className={cx(
                      'pressable inline-flex min-h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine',
                      linkIndex === 0 ? 'bg-ink text-paper hover:bg-ink/85' : 'border border-rule text-ink hover:border-ink-faint',
                    )}
                    data-testid="booking-link"
                  >
                    {link.official ? (
                      <span className={cx('rounded-full px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase', linkIndex === 0 ? 'bg-paper/20 text-paper' : 'bg-pine-soft text-pine-strong')} data-testid="booking-link-official">
                        Official
                      </span>
                    ) : null}
                    {link.label}
                    <span aria-hidden="true" className="text-xs opacity-70">↗</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-3 type-meta text-ink-faint">Searches open with your dates and party filled in; &ldquo;Official&rdquo; marks the operator&rsquo;s own page. Sidequest hasn&rsquo;t checked prices or availability &mdash; the site you book on has the real ones. Mark things booked below so the plan works around them.</p>
    </section>
  );
}
