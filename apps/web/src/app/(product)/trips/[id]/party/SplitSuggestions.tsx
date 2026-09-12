import Link from 'next/link';
import { splitRequestFor } from '@/components/hub/split-request';

/**
 * V9 §17 — "SUGGEST A SPLIT FOR DAY N", FROM THE PARTY PAGE.
 *
 * Shown only when the party has a recorded difference to split over
 * (`partyFactsFor(tripId).differences`) and the trip is built. Each link
 * opens the itinerary at the day (`#day-N`) carrying the Ask request in the
 * URL (`?ask=`), so Ask Sidequest can open with it pre-filled; the traveller
 * reads and edits the request before sending, and nothing changes until they
 * do. A day that already splits says so and offers a different split.
 */
export interface SplitSuggestionDay {
  dayNumber: number;
  theme: string;
  date: string;
  alreadySplit: boolean;
}

export function splitSuggestionHref(tripId: string, day: SplitSuggestionDay): string {
  return `/trips/${tripId}/itinerary?ask=${encodeURIComponent(splitRequestFor(day.dayNumber))}#day-${day.dayNumber}`;
}

export function SplitSuggestions({ tripId, days }: { tripId: string; days: SplitSuggestionDay[] }) {
  if (days.length === 0) return null;
  return (
    <section className="card mt-8 rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="party-split-heading" data-testid="party-split-suggestions">
      <h2 id="party-split-heading" className="type-section text-ink">
        Split a day
      </h2>
      <p className="mt-1 type-small text-ink-muted">Someone here has a need or a pace the others do not. Ask Sidequest to plan a half for them on any day, with a place and time to meet again.</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {days.map((day) => (
          <li key={day.dayNumber}>
            <Link href={splitSuggestionHref(tripId, day)} className="card lift flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[var(--radius-card)] px-4 py-3" data-testid={`party-split-suggest-${day.dayNumber}`} data-already-split={day.alreadySplit ? 'true' : 'false'}>
              <span className="min-w-0">
                <span className="block type-small font-semibold text-ink">
                  Day {day.dayNumber} · {day.theme}
                </span>
                <span className="type-meta block">{day.alreadySplit ? 'Already splits — suggest a different split' : 'Suggest a split for this day'}</span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-ink-faint">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
