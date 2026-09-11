import type { ItineraryDay } from '@sidequest/core';
import { DayFocusLink } from './DayFocus';
import { shortDate } from './plan-format';

/**
 * GETTING TO A DAY ON AN EIGHT-THOUSAND-PIXEL PAGE.
 *
 * The finished plan had no navigation at all: reaching day 3 meant scrolling
 * past two complete days, and checking one thing on day 1 while reading day 4
 * meant scrolling back and then finding your place again. This is the one
 * structure a printed itinerary has that a web page was missing — a contents.
 *
 * Anchors, not JavaScript. `href="#day-3"` works with no client bundle, survives
 * a page that has not hydrated, is a real browser history entry, and lands in the
 * tab order for free. The days carry `scroll-mt` so the sticky chrome and this
 * rail do not cover the heading they just jumped to.
 *
 * V8 — a rail with readable labels: the number as a figure, the theme at 15 px,
 * the date at 13 px, and every chip a 44 px target. Sticky under the hub nav on
 * a phone; a wrapped list on a desktop. Hidden in print, where page numbers do
 * this job.
 */
export function DayRail({ days }: { days: readonly ItineraryDay[] }) {
  return (
    <nav aria-label="Jump to a day" className="sticky top-[calc(var(--chrome-height)+3.25rem)] z-10 -mx-5 mb-5 overflow-x-clip border-b border-rule bg-paper/95 px-5 py-2 backdrop-blur-[2px] print:hidden sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:mb-6 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0" data-testid="day-rail">
      <ol className="no-scrollbar flex gap-2 overflow-x-auto pb-1 lg:flex-wrap">
        {days.map((day) => (
          <li key={day.dayNumber} className="shrink-0">
            <DayFocusLink dayNumber={day.dayNumber} className="card lift pressable inline-flex min-h-11 items-center gap-2.5 rounded-full px-3.5 py-1.5 text-sm leading-tight text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine">
              <span className="sr-only">Day {day.dayNumber} </span>
              <span aria-hidden="true" className="type-figure text-current">{String(day.dayNumber).padStart(2, '0')}</span>
              <span className="max-w-[12rem] truncate">{day.theme.replace(/\.$/, '')}</span>
              <time dateTime={day.date} className="type-figure hidden text-xs font-medium opacity-80 lg:inline">
                {shortDate(day.date)}
              </time>
            </DayFocusLink>
          </li>
        ))}
      </ol>
    </nav>
  );
}
