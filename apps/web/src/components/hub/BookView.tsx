import type { BookedPlanItem, BookingItem, BookingResolution, Itinerary, TravelIntelligence, TripLedger } from '@sidequest/core';
import type { BookedAffectedScope } from '@/lib/intelligence/booked-reconcile';
import type { BookingImport } from '@/lib/db/execution-repository';
import { BookedItemForm, BookedItemRow } from './HubForms';
import { buildBookingProgress } from '@sidequest/core';
import { BookingProgressLine, BookingRow } from './TripHub';
import { ImportCenter } from './ImportCenter';
import { LedgerCard } from './LedgerCard';
import { PRIORITY_GROUPS, isSkipped } from './booking-copy';

/**
 * V9 §5/§6/§16 — THE BOOK VIEW.
 *
 * One hub view: the needs with their actions (Open official source · Mark
 * booked · Add confirmation · Replace · Skip), grouped Book first / Book soon /
 * Can wait / Keep flexible; what is booked, with the confirmation behind a
 * disclosure the owner alone sees and paper never carries; the import centre;
 * the ledger. `tripId` is absent on the shared copy, where every control,
 * every reference and every import is left out — the copy is the plan's
 * needs and the titles of what is booked, nothing else.
 */
export interface BookViewProps {
  tripId?: string;
  intel: TravelIntelligence;
  booked: readonly BookedPlanItem[];
  itinerary: Itinerary;
  honored: readonly string[];
  conflicts: readonly string[];
  resolutions: readonly BookingResolution[];
  ledger: TripLedger;
  affected: BookedAffectedScope;
  pendingImports: readonly BookingImport[];
}

export function BookView(props: BookViewProps) {
  const { tripId, intel, booked, itinerary, honored, conflicts, resolutions, ledger, affected, pendingImports } = props;
  const items = intel.bookings.items;
  const group = items.find((b) => b.memberIds);
  const members = group ? items.filter((b) => group.memberIds!.includes(b.id)) : [];
  const standalone = items.filter((b) => !b.memberIds && !(b.group === 'stays' && group));
  const skippedRows = [...members, ...standalone].filter((b) => isSkipped(b, resolutions));
  const rowsFor = (priority: BookingItem['priority']): BookingItem[] => {
    const rows = [...(group && group.priority === priority && group.status === 'open' ? [group] : []), ...standalone.filter((b) => b.priority === priority && b.status === 'open' && !isSkipped(b, resolutions))];
    return rows;
  };
  const settled = [...members, ...standalone].filter((b) => b.status === 'booked' || b.status === 'soft_hold');
  const openCount = PRIORITY_GROUPS.reduce((n, g) => n + rowsFor(g.priority).length, 0);
  const rowProps = { ...(tripId ? { tripId } : {}), resolutions, tripStart: itinerary.startDate, tripEnd: itinerary.endDate, testId: 'booking-row' };

  /*
   * V11 §I — ONE DEFINITION OF "NEXT", AND IT IS NOT THIS FILE'S.
   *
   * The first version of this block chose the next thing itself, by walking the
   * priority groups in order. `buildBookingProgress` already chooses one — more
   * carefully, because it drops the stays *summary* row that stands for several
   * beds and counts the beds instead. The two disagreed on screen: the headline
   * said "Stays: 1 base, 4 nights" and the progress card two hundred pixels
   * below said "Next: book the car". Two next actions is worse than none.
   *
   * So there is one, it is the progress model's, and the progress card stops
   * restating it while this block is on screen.
   */
  const progress = buildBookingProgress(items);
  const next = progress.nextAction;
  const bases = (itinerary.package?.bases ?? []).map((b) => ({ id: b.id, name: b.name }));

  return (
    <section className="mx-auto max-w-5xl pt-6" aria-labelledby="book-heading" data-testid="hub-book">
      <h2 id="book-heading" className="type-title text-ink">
        Book
      </h2>
      <p className="mt-1 text-sm text-ink-muted">What this trip depends on somebody arranging, what you have arranged, and where the money stands. Priorities come from dependency, fixed times and lead times, never invented scarcity.</p>

      {/*
        V11 §I — BOOK NEXT: ONE THING, AND WHY IT IS THAT ONE.

        The page opened on a progress card — a count, a bar and four group
        tallies — above four grouped lists. All of it true, and none of it an
        answer to the question somebody opens this page with, which is "what do I
        do now". §I asks for one item and its reason, first.

        The item is not chosen here: it is the first row of the first non-empty
        priority group, which is the order `PRIORITY_GROUPS` already imposes and
        the same order the lists below render in. So the thing named here and the
        first thing in the list below are the same thing by construction — and it
        is named once, in this block, because the list below is where it is
        *acted on*. A count of a list is not a copy of it.
      */}
      {next ? (
        <div className="mt-5 rounded-[var(--radius-panel)] border-l-4 border-l-accent bg-accent-soft p-5" data-testid="book-next">
          <p className="eyebrow text-accent-strong">Book next</p>
          <p className="mt-1.5 font-display text-2xl leading-tight text-ink">{next.travelerAction}</p>
          <p className="measure mt-2 type-small text-ink-muted">{next.why}</p>
        </div>
      ) : null}

      <div className="mt-5">
        <BookingProgressLine intel={intel} nextStatedAbove={next !== null} />
      </div>

      {PRIORITY_GROUPS.map((groupCopy) => {
        const rows = rowsFor(groupCopy.priority);
        if (rows.length === 0) return null;
        return (
          <div key={groupCopy.priority} className="mt-8" data-testid={`book-group-${groupCopy.priority}`}>
            <h3 className="type-section text-ink">
              {groupCopy.title} <span className="type-figure text-sm text-accent">{rows.length}</span>
            </h3>
            <p className="mt-0.5 text-sm text-ink-muted">{groupCopy.blurb}</p>
            <ul className="mt-2 divide-y divide-rule">
              {rows.map((b) => (
                <BookingRow key={b.id} b={b} {...(b.memberIds ? { members } : {})} elevated={groupCopy.priority === 'book_first'} {...rowProps} />
              ))}
            </ul>
          </div>
        );
      })}
      {openCount === 0 ? <p className="mt-6 text-sm text-pine" data-testid="book-all-settled">Nothing left to arrange from what Sidequest can see.</p> : null}
      {settled.length > 0 && openCount > 0 ? <p className="mt-4 type-meta">{settled.length} of the things this trip depends on {settled.length === 1 ? 'is' : 'are'} already covered by your bookings.</p> : null}

      {skippedRows.length > 0 ? (
        <details className="mt-6" data-testid="book-skipped">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted">
            {skippedRows.length} {skippedRows.length === 1 ? 'thing' : 'things'} you skipped
          </summary>
          <ul className="mt-1 divide-y divide-rule">
            {skippedRows.map((b) => (
              <BookingRow key={b.id} b={b} {...rowProps} />
            ))}
          </ul>
        </details>
      ) : null}

      <div className="card mt-8 p-5" data-testid="hub-booked">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="type-section text-ink">What you have booked</h3>
          {tripId ? <BookedItemForm tripId={tripId} startDate={itinerary.startDate} endDate={itinerary.endDate} /> : null}
        </div>
        <p className="mt-1 text-sm text-ink-muted">A booked fact is stronger than anything the plan proposed. Sidequest schedules around it and never moves it.</p>
        {booked.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">Nothing yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-rule">
            {booked.map((item) =>
              tripId ? (
                <BookedItemRow key={item.id} tripId={tripId} item={item} />
              ) : (
                <li key={item.id} className="flex items-start gap-2.5 py-2 text-sm text-ink" data-testid="booked-item">
                  {/* V9.1 §10 — a booked fact looks booked on the shared copy too: a filled pine mark and the word. */}
                  <span aria-hidden="true" className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-pine text-xs leading-none text-paper">
                    ✓
                  </span>
                  <span className="min-w-0">
                    <span className="mr-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-pine">Booked</span>
                    {item.title}
                    {item.date ? <span className="text-ink-muted"> · {item.date}</span> : null}
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        {affected.dayNumbers.length > 0 ? (
          <p className="mt-3 text-sm text-ink" data-testid="booked-affected">
            <span className="font-medium">What your bookings changed: </span>
            {affected.summary}
          </p>
        ) : booked.some((b) => b.status === 'booked') ? (
          <p className="mt-3 text-sm text-ink-muted" data-testid="booked-affected">
            Your bookings sit inside the plan as it was; no day changed.
          </p>
        ) : null}
        {honored.length > 0 ? (
          <ul className="mt-3 space-y-1 text-sm text-pine" data-testid="hub-booked-honored">
            {honored.map((h) => (
              <li key={h}>✓ {h}</li>
            ))}
          </ul>
        ) : null}
        {conflicts.length > 0 ? (
          <ul className="mt-3 space-y-1 rounded-[var(--radius-card)] bg-clay-soft p-3 text-sm text-ink" data-testid="hub-booked-conflicts">
            {conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {tripId ? <ImportCenter tripId={tripId} tripStart={itinerary.startDate} tripEnd={itinerary.endDate} pendingImports={pendingImports} bases={bases} /> : null}
      {tripId ? <LedgerCard ledger={ledger} /> : null}
    </section>
  );
}
