import type { BookedPlanItem, BookingItem, BookingResolution, Itinerary, TravelIntelligence, TripLedger } from '@sidequest/core';
import type { BookedAffectedScope } from '@/lib/intelligence/booked-reconcile';
import type { BookingImport } from '@/lib/db/execution-repository';
import { BookedItemForm, BookedItemRow } from './HubForms';
import { buildBookingProgress } from '@sidequest/core';
import { BookingProgressLine, BookingRow } from './TripHub';
import { ImportCenter } from './ImportCenter';
import { LedgerCard } from './LedgerCard';
import { PRIORITY_GROUPS, isSkipped } from './booking-copy';
import { RailSection, ViewHead } from './views/ViewHead';

/** What each priority means for *when*, in the rail's margin. Words from the group's own blurb, never a date Sidequest does not have. */
const RAIL_WHEN: Record<BookingItem['priority'], string> = {
  book_first: 'before anything else',
  book_soon: 'soon',
  can_wait: 'close to the day',
  keep_flexible: 'on the day',
};

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

  const openRows = PRIORITY_GROUPS.map((g) => ({ copy: g, rows: rowsFor(g.priority) })).filter((g) => g.rows.length > 0);
  let rail = 0;
  const nextIndex = () => String(++rail).padStart(2, '0');

  return (
    <section className="mx-auto max-w-6xl" aria-labelledby="book-heading" data-testid="hub-book">
      <ViewHead sheet="Sheet B · What to arrange, in the order to arrange it" title="Book" titleId="book-heading" lede="What to arrange, in order, what you already have, and where the money stands.">
        <div className="mt-6">
          <BookingProgressLine intel={intel} nextStatedAbove={next !== null} variant="strip" />
        </div>
      </ViewHead>

      {/*
        V11 §I — BOOK NEXT: ONE THING, AND WHY IT IS THAT ONE.

        The item is the progress model's next action — the same thing the first
        rail below opens on — named once here, acted on below. It carries the
        flare rule because it is the one thing that moves the trip forward.
      */}
      {next ? (
        <div className="mt-8 grid gap-x-8 gap-y-2 border-l-[3px] border-l-flare bg-paper-raised py-5 pl-5 pr-5 md:grid-cols-[13rem_minmax(0,1fr)]" data-testid="book-next">
          <p className="sheet-label pt-1 text-ink-muted">Book next</p>
          <div className="min-w-0">
            <p className="font-display text-2xl leading-tight text-ink">{next.travelerAction}</p>
            <p className="measure mt-2 type-small text-ink-muted">{next.why}</p>
          </div>
        </div>
      ) : null}

      <div className="mt-12">
        {openRows.map(({ copy: groupCopy, rows }) => (
          <RailSection key={groupCopy.priority} index={`${nextIndex()} · ${RAIL_WHEN[groupCopy.priority]}`} title={groupCopy.title} count={rows.length} blurb={groupCopy.blurb} testId={`book-group-${groupCopy.priority}`} quiet={groupCopy.priority === 'can_wait' || groupCopy.priority === 'keep_flexible'}>
            <ul className="ruled">
              {rows.map((b) => (
                <BookingRow key={b.id} b={b} {...(b.memberIds ? { members } : {})} elevated={groupCopy.priority === 'book_first'} {...rowProps} />
              ))}
            </ul>
          </RailSection>
        ))}
        {openCount === 0 ? <p className="text-sm text-pine" data-testid="book-all-settled">Nothing left to arrange from what Sidequest can see.</p> : null}
        {settled.length > 0 && openCount > 0 ? <p className="mb-8 type-meta md:pl-[16.5rem]">{settled.length} of the things this trip depends on {settled.length === 1 ? 'is' : 'are'} already covered by your bookings.</p> : null}

        {skippedRows.length > 0 ? (
          <details className="mb-10 md:pl-[16.5rem]" data-testid="book-skipped">
            <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted">
              {skippedRows.length} {skippedRows.length === 1 ? 'thing' : 'things'} you skipped
            </summary>
            <ul className="ruled mt-1">
              {skippedRows.map((b) => (
                <BookingRow key={b.id} b={b} {...rowProps} />
              ))}
            </ul>
          </details>
        ) : null}

        <RailSection index={`${nextIndex()} · in hand`} title="What you have booked" count={booked.length} blurb="A booked fact is stronger than anything the plan proposed. Sidequest schedules around it and never moves it." quiet testId="hub-booked" aside={tripId ? <div className="mt-4"><BookedItemForm tripId={tripId} startDate={itinerary.startDate} endDate={itinerary.endDate} /></div> : null}>
          {booked.length === 0 ? (
            <p className="py-4 text-sm text-ink-faint">Nothing yet.</p>
          ) : (
            <ul className="ruled">
              {booked.map((item) =>
                tripId ? (
                  <BookedItemRow key={item.id} tripId={tripId} item={item} />
                ) : (
                  <li key={item.id} className="flex items-start gap-2.5 py-3 text-sm text-ink" data-testid="booked-item">
                    {/* V9.1 §10 — a booked fact looks booked on the shared copy too: a filled pine mark and the word. */}
                    <span aria-hidden="true" className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center bg-pine text-xs leading-none text-paper">
                      ✓
                    </span>
                    <span className="min-w-0">
                      <span className="mr-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-pine">Booked</span>
                      {item.title}
                      {item.date ? <span className="type-figure text-ink-muted"> · {item.date}</span> : null}
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
            <ul className="mt-3 space-y-1 border-l-2 border-clay bg-clay-soft p-3 text-sm text-ink" data-testid="hub-booked-conflicts">
              {conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {tripId ? <ImportCenter tripId={tripId} tripStart={itinerary.startDate} tripEnd={itinerary.endDate} pendingImports={pendingImports} bases={bases} /> : null}
        </RailSection>
        {tripId ? <LedgerCard ledger={ledger} index={`${nextIndex()} · money`} /> : null}
      </div>
    </section>
  );
}
