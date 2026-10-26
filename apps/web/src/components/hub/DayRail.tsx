import type { ItineraryDay, TripPackage } from '@sidequest/core';
import { DayFocusLink } from './DayFocus';
import { shortDate } from './plan-format';
import { splitDayTheme } from './hero-stats';

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
 *
 * V11 §6 — THE RAIL SHOWS THE TRIP'S CHAPTERS.
 *
 * Eleven equal chips is a list of days; the same eleven under "ARRIVE ·
 * ALA-KUL TRAVERSE · RECOVERY · SONG-KOL · FINALE" is a trip. The chapters are
 * derived at build time and persisted (`package.chapters`), so this reads one
 * record rather than re-deriving a second opinion. A trip built before V11, or
 * one whose chapters came out as a single run, renders exactly as it did: one
 * chapter is not a structure worth a heading.
 */
function chapterLabel(role: NonNullable<TripPackage['chapters']>[number]['role'], title: string): string {
  switch (role) {
    case 'arrival':
      return 'Arrive';
    case 'finale':
      return 'Finish';
    case 'recovery':
      return `Recover · ${title}`;
    case 'transition':
      return `On the way · ${title}`;
    default:
      return title;
  }
}

/*
 * `overflow-x-clip`: on a phone the chip strip's scrollable width still counted
 * toward the page's (972 px on a 390 px screen), which zoomed the layout out and
 * moved every fixed control. Clip — not hidden — keeps the nav sticky.
 */
const NAV = 'sticky top-[calc(var(--chrome-height)+3.25rem)] z-10 overflow-x-clip -mx-5 mb-6 border-b border-rule bg-paper/95 px-5 py-2 backdrop-blur-[3px] print:hidden sm:-mx-6 sm:px-6 lg:mx-0 lg:rounded-b-[12px] lg:px-1';

/**
 * HUB-4 — ONE COMPACT, STICKY ROW.
 *
 * The rail was a wrapped grid on a desktop, two rows of truncated themes that
 * scrolled away with the first day. It is now one row of chips that stays under
 * the hub nav on every width: the day number as a figure, the day's short
 * title (the lead before " — ", never a name cut mid-word) and the date. The
 * chip for the day in view is marked by `DayFocusLink`, so the row doubles as
 * a "you are here".
 */
function DayChip({ day }: { day: ItineraryDay }) {
  const { title } = splitDayTheme(day.theme);
  return (
    <DayFocusLink
      dayNumber={day.dayNumber}
      className="day-cell pressable group flex min-h-11 items-center gap-2.5 rounded-full border border-rule bg-paper-raised py-1 pr-4 pl-1 text-ink-muted transition-colors hover:border-ink hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
    >
      <span className="sr-only">Day {day.dayNumber} </span>
      <span aria-hidden="true" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper-sunk font-display text-[0.95rem] leading-none text-ink group-aria-[current=true]:bg-flare group-aria-[current=true]:text-night">
        {String(day.dayNumber).padStart(2, '0')}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-[10.5rem] truncate text-[13px] font-medium text-current">{title}</span>
        <time dateTime={day.date} className="coordbar text-[10px] opacity-80">
          {shortDate(day.date)}
        </time>
      </span>
    </DayFocusLink>
  );
}

export function DayRail({ days, chapters }: { days: readonly ItineraryDay[]; chapters?: TripPackage['chapters'] }) {
  const groups = chapters && chapters.length > 1 ? chapters.map((chapter) => ({ chapter, days: days.filter((day) => chapter.dayNumbers.includes(day.dayNumber)) })).filter((group) => group.days.length > 0) : null;
  if (groups) {
    return (
      <nav aria-label="Jump to a day" className={NAV} data-testid="day-rail">
        <ol className="no-scrollbar flex items-center gap-5 overflow-x-auto py-0.5">
          {groups.map(({ chapter, days: chapterDays }) => (
            <li key={chapter.id} className="flex shrink-0 items-center gap-2" data-testid="day-rail-chapter">
              <p className="sheet-label max-w-[7rem] shrink-0 leading-tight text-ink-muted">{chapterLabel(chapter.role, chapter.title)}</p>
              <ol className="flex gap-2">
                {chapterDays.map((day) => (
                  <li key={day.dayNumber} className="shrink-0">
                    <DayChip day={day} />
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </nav>
    );
  }
  return (
    <nav aria-label="Jump to a day" className={NAV} data-testid="day-rail">
      <ol className="no-scrollbar flex gap-2 overflow-x-auto py-0.5">
        {days.map((day) => (
          <li key={day.dayNumber} className="shrink-0">
            <DayChip day={day} />
          </li>
        ))}
      </ol>
    </nav>
  );
}
