import Link from 'next/link';
import { cx } from './ui';

/**
 * WHERE THE TRAVELLER IS, IN ONE STRIP.
 *
 * This replaces the fixed `EASTERN SIERRA` label that sat in the global header
 * of a product that plans trips anywhere. The distinction that matters: that
 * label was a *claim about the product*, and this is a *record of the trip* —
 * every field comes from a persisted row, and when there is no trip there is no
 * strip.
 *
 * Nothing here is derived at render time from anything expensive. If a value is
 * not in the database it is simply absent, because a header that had to
 * calculate something would make every page slower for a line of context.
 */

export interface TripContext {
  tripId: string;
  /** What the traveller is going to, as they would say it. */
  destination: string;
  /** Their dates, or how flexible they are. Never invented. */
  when?: string;
  /** Nights, when the dates settle it. */
  nights?: number;
  /** Which step of the flow they are on. */
  stage: string;
}

const STAGE_TONE: Record<string, string> = {
  Planning: 'text-slate-blue',
  Building: 'text-slate-blue',
  /*
   * A stopped build is not a stage of progress and must not be coloured like
   * one. Unmapped stages already fall back to the faint ink, which is right for
   * anything a caller invents; this is stated because it is the one that would
   * otherwise be read as "still going".
   */
  Stopped: 'text-amber',
  Researched: 'text-pine',
  Board: 'text-pine',
  Itinerary: 'text-pine',
};

export function TripContextBar({ context }: { context: TripContext }) {
  const parts = [
    context.when,
    context.nights !== undefined ? `${context.nights} night${context.nights === 1 ? '' : 's'}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return (
    /*
     * EXPERIENCE V2 — the strip reads as part of the shell: same ground as the
     * header, sticky beneath it, the destination as the one strong word and the
     * dates beside it. Orientation without a second headline.
     */
    <div
      className="sticky top-[var(--chrome-height)] z-20 flex min-w-0 items-center gap-3 border-b border-rule bg-paper/95 px-5 py-1.5 text-sm backdrop-blur-[2px] sm:px-6"
      data-testid="trip-context"
    >
      <Link href={`/trips/${context.tripId}/plan`} className="min-w-0 truncate font-display text-base text-ink hover:text-pine">
        {context.destination}
      </Link>
      {parts.length > 0 ? <span className="hidden shrink-0 text-ink-faint sm:inline">{parts.join(' · ')}</span> : null}
      <span className="flex-1" />
      <span className={cx('shrink-0 text-[11px] font-medium uppercase tracking-[0.14em]', STAGE_TONE[context.stage] ?? 'text-ink-faint')}>{context.stage}</span>
    </div>
  );
}
