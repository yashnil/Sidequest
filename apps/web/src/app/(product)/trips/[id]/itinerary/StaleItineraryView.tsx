import Link from 'next/link';
import { formatMinuteOfDay } from '@sidequest/core';
import { Panel, buttonClass } from '@/components/ui';
import { BuildTripButton } from '@/components/BuildTripButton';
import type { StaleItineraryDisplay } from '@/lib/db/repository';

/**
 * A PLAN FROM AN EARLIER BUILD, SHOWN INSTEAD OF WITHHELD.
 *
 * Every stored itinerary used to hit a wall here after a schema bump: a page of
 * engineering changelog — "which opening hours we check, whether the weather
 * and the daylight were worked out at all" — and no trip. The traveller's days
 * and times were sitting in the database the whole while.
 *
 * So: the plan renders, read-only, under one dated banner that says what is
 * true — an earlier version built it, a rebuild refreshes it, the choices are
 * kept. What deliberately does *not* render is anything this build would have
 * to stand behind: no weather claims, no transport totals, no validation
 * badges, no export. Those are exactly the facts a version bump exists to
 * retract, and the current-version view is the only place they belong.
 */
export function StaleItineraryView({
  display,
  tripId,
  includedCount,
  dateLabel,
}: {
  display: StaleItineraryDisplay;
  tripId: string;
  /** How many board picks a rebuild would plan from, for the rebuild control. */
  includedCount: number;
  dateLabel: string;
}) {
  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="border-b border-rule pb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Your trip</p>
        <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-5xl">
          {display.baseName}
        </h1>
        <p className="mt-3 text-ink-muted">
          {dateLabel} · {display.days.length} {display.days.length === 1 ? 'day' : 'days'} · based
          in {display.baseName}
        </p>
      </header>

      <Panel className="mt-8 border-amber bg-amber-soft p-5" testId="stale-itinerary-banner">
        <h2 className="font-display text-lg text-ink">
          Built by an earlier version of Sidequest
          {display.savedAt ? ` on ${humanDate(display.savedAt)}` : ''}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          The plan below is shown as it was saved — some details may have changed since, so treat
          it as a record rather than a promise. Rebuild to refresh it; every choice you made on
          the board is kept.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <BuildTripButton tripId={tripId} hasItinerary includedCount={includedCount} />
          <Link href={`/trips/${tripId}/discover`} className={buttonClass('secondary', 'sm')}>
            Back to the board
          </Link>
        </div>
      </Panel>

      {display.summary ? <p className="mt-6 text-sm text-ink-muted">{display.summary}</p> : null}

      <ol className="mt-10 space-y-10" data-testid="stale-itinerary-days">
        {display.days.map((day) => (
          <li key={day.dayNumber}>
            <h3 className="font-display text-xl text-ink">
              Day {day.dayNumber}
              {day.date ? <span className="ml-2 text-sm text-ink-muted">{humanDate(day.date)}</span> : null}
            </h3>
            {day.theme ? <p className="mt-1 text-sm text-ink-muted">{day.theme}</p> : null}
            <ul className="mt-4 space-y-2">
              {day.items.length === 0 ? (
                <li className="text-sm text-ink-faint">Nothing was recorded for this day.</li>
              ) : (
                day.items.map((item, index) => (
                  <li key={index} className="flex gap-3 text-sm">
                    <span className="w-24 shrink-0 tabular-nums text-ink-faint">
                      {item.startMinute !== null ? formatMinuteOfDay(item.startMinute) : '—'}
                      {item.endMinute !== null ? `–${formatMinuteOfDay(item.endMinute)}` : ''}
                    </span>
                    <span>
                      <span className="text-ink">{item.title}</span>
                      {item.note ? (
                        <span className="block text-ink-muted">{item.note}</span>
                      ) : null}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** "Tue 12 Aug 2026" — never a bare ISO string on a traveller's screen. */
function humanDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    weekday: value.length === 10 ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
