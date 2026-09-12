import {
  ACCESS_STATE_LABELS,
  AUTHORITY_LABELS,
  BOOKING_PRIORITY_COPY,
  BOOKING_PRIORITIES,
  BUDGET_CATEGORY_LABELS,
  CLAIM_STATE_LABELS,
  DURATION_BASIS_LABELS,
  FRESHNESS_LABELS,
  LEG_MODE_LABELS,
  MEAL_ROLE_LABELS,
  PACKING_CATEGORIES,
  PACKING_CATEGORY_LABELS,
  READINESS_SECTION_LABELS,
  READINESS_SECTION_OF,
  READINESS_SECTIONS,
  RECHECK_WINDOW_LABELS,
  type RecheckManifest,
  type TodayView,
  type BookedPlanItem,
  type BookingResolution,
  type Itinerary,
  type ReadinessEntry,
  type TravelIntelligence,
  type TravelReadinessProfile,
  type TripPackage,
  buildBookingProgress,
} from '@sidequest/core';
import { Badge, Panel, cx, type BadgeTone } from '../ui';
import { TripConfidence } from './TripConfidence';
import { Glyph } from '../interview/glyphs';
import { BookedItemForm, BookedItemRow, CheckBox, ReadinessProfileForm } from './HubForms';
import { BookingActions } from './BookingActions';
import { isSkipped, skipNote } from './booking-copy';
import { checklistRows } from './checklist-titles';
import { DiscoverButton } from '@/app/(product)/trips/[id]/itinerary/live-controls';

/**
 * THE TRIP HUB.
 *
 * One page, eleven places to look, in the order a traveller uses them. The
 * plan stays first; preparation follows; engineering provenance sits behind a
 * disclosure at the end. Nothing here counts warnings at the traveller.
 */
export const HUB_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'itinerary', label: 'Itinerary' },
  { id: 'stays', label: 'Stays' },
  { id: 'getting-around', label: 'Getting around' },
  { id: 'food', label: 'Food' },
  { id: 'book-first', label: 'Book first' },
  { id: 'before-you-go', label: 'Before you go' },
  { id: 'pack', label: 'Pack' },
  { id: 'budget', label: 'Budget' },
  { id: 'backups', label: 'Backups' },
  { id: 'verify', label: 'Verify' },
] as const;

export function HubNav({ urgent }: { urgent: number }) {
  return (
    <nav aria-label="Trip hub" className="sticky top-[var(--chrome-height)] z-20 -mx-5 mt-6 border-y border-rule bg-paper/95 px-5 py-2 backdrop-blur-sm print:hidden sm:-mx-8 sm:px-8" data-testid="trip-hub-nav">
      <ol className="flex gap-1 overflow-x-auto">
        {HUB_SECTIONS.map((section) => (
          <li key={section.id} className="shrink-0">
            <a href={`#${section.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium uppercase tracking-[0.1em] text-ink-muted hover:bg-paper-sunk hover:text-ink" data-testid={`hub-link-${section.id}`}>
              {section.label}
              {section.id === 'book-first' && urgent > 0 ? <span className="type-figure rounded-full bg-accent px-1.5 text-xs text-paper">{urgent}</span> : null}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SectionHeader({ id, title, blurb, testId }: { id: string; title: string; blurb: string; testId?: string }) {
  return (
    <div className="pt-2" id={id} {...(testId ? { 'data-testid': testId } : {})}>
      <h2 className="type-title text-ink">{title}</h2>
      <p className="mt-2 max-w-[62ch] type-body text-ink-muted">{blurb}</p>
    </div>
  );
}

const STATE_TONE: Record<ReadinessEntry['state'], BadgeTone> = { confirmed: 'pine', unverified: 'neutral', not_applicable: 'neutral', needs_input: 'amber', problem: 'clay' };
const STATE_WORD: Record<ReadinessEntry['state'], string> = { confirmed: 'Confirmed', unverified: 'Check', not_applicable: 'Not needed', needs_input: 'Tell us', problem: 'Problem' };

/**
 * WHAT NEEDS THE TRAVELLER'S ATTENTION, AT THE TOP, IN A FEW LINES.
 *
 * Blocking readiness problems, terminal violations and required bookings for
 * a trip that is close. Never a count of warnings.
 */
export function HubUrgent({ intel }: { intel: TravelIntelligence }) {
  if (intel.unresolvedCriticals.length === 0) return null;
  return (
    <div className="card mt-6 border-l-4 border-l-clay bg-clay-soft p-5" data-testid="hub-urgent">
      <p className="eyebrow text-clay">Needs your attention</p>
      <ul className="mt-2 space-y-1 text-sm text-ink">
        {intel.unresolvedCriticals.slice(0, 5).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** V6 §27 — "6 of 8 critical items arranged", with the groups and the next thing to do. */
export function BookingProgressLine({ intel }: { intel: TravelIntelligence }) {
  const progress = buildBookingProgress(intel.bookings.items);
  if (progress.critical === 0) return null;
  const share = progress.critical > 0 ? Math.round((progress.arranged / progress.critical) * 100) : 0;
  return (
    /*
     * V8 — BOOK FIRST AS A CHECKLIST CARD.
     *
     * "0 of 1 arranged" was a line of serif over a grey list. It is a card
     * now: the count as a figure, a bar that shows how much of what could
     * break the trip is settled, the next thing to do, and the groups as
     * tick-lists — the same data, given the shape of the thing it is.
     */
    <div className="card p-5" data-testid="booking-progress">
      <p className="eyebrow">Book first</p>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="type-section text-ink">
          <span className="type-figure">{progress.arranged}</span> of <span className="type-figure">{progress.critical}</span> arranged
        </p>
      </div>
      <div aria-hidden="true" className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-paper-sunk">
        <div className="h-full rounded-full bg-pine transition-[width] duration-[var(--motion-page)]" style={{ width: `${share}%` }} />
      </div>
      {progress.nextAction ? (
        <p className="mt-3 type-small text-ink-muted">
          Next: <span className="font-medium text-ink">{progress.nextAction.travelerAction}</span>
        </p>
      ) : (
        <p className="mt-3 type-small text-pine">Everything this trip depends on is arranged.</p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {progress.groups.map((group) => (
          <div key={group.id} data-testid={`booking-progress-${group.id}`}>
            <p className="eyebrow">
              {group.title} · <span className="type-figure">{group.done}/{group.total}</span>
            </p>
            <ul className="mt-1.5 space-y-1">
              {group.items.map((item) => (
                <li key={item.id} className={cx('flex items-start gap-2 text-sm', item.done ? 'text-ink-muted' : 'text-ink')}>
                  <span aria-hidden="true" className={cx('mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border text-[0.6rem] leading-none', item.done ? 'border-pine bg-pine text-paper' : 'border-ink-faint bg-paper')}>
                    {item.done ? '✓' : ''}
                  </span>
                  <span className={item.done ? 'line-through' : ''}>{item.title}</span>
                  <span className="sr-only">{item.done ? 'arranged' : 'not yet arranged'}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StaysSection({ intel, tripId, itinerary, coordinates = {} }: { intel: TravelIntelligence; tripId?: string; itinerary: Itinerary; coordinates?: Record<string, { lat: number; lng: number }> }) {
  const lodging = intel.lodging;
  /* A base's position: its own id, the day that sleeps there, or failing both the first placed stop of that day. Never a guess. */
  const nearBase = (baseId: string, name: string) => {
    const direct = coordinates[baseId];
    if (direct) return direct;
    const day = itinerary.days.find((d) => d.baseId === baseId || d.baseName === name);
    if (!day) return null;
    if (coordinates[day.baseId]) return coordinates[day.baseId]!;
    const stop = day.items.find((i) => i.kind === 'activity' && i.placeId && coordinates[i.placeId]);
    return stop?.placeId ? (coordinates[stop.placeId] ?? null) : null;
  };
  return (
    <section className="mt-14" aria-labelledby="stays" data-testid="hub-stays">
      <SectionHeader id="stays" title="Where to stay" blurb={lodging.hotelChangeNote} />
      {lodging.churn ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-muted" data-testid="hub-stays-churn" data-level={lodging.churn.level}>
          <Badge tone={lodging.churn.level === 'aggressive' ? 'amber' : 'neutral'}>{lodging.churn.level === 'settled' ? 'One base' : lodging.churn.level === 'aggressive' ? 'Fast-moving route' : 'Steady route'}</Badge>
          <span className="numeral">
            {lodging.churn.baseCount} bases · {lodging.churn.nights} nights · {lodging.churn.hotelChanges} hotel changes · {lodging.churn.averageNightsPerBase} nights per base
          </span>
          {lodging.churn.simplerRoute[0] ? <span className="basis-full text-ink">Simpler: {lodging.churn.simplerRoute[0]}.</span> : null}
        </p>
      ) : null}
      {/* A single base is one card, not one card and an equal column of nothing beside it. */}
      <ol className={cx('mt-5 grid gap-4', lodging.bases.length > 1 && 'sm:grid-cols-2')} data-testid="where-to-stay">
        {lodging.bases.map((base, index) => (
          <li key={base.baseId} className="card flex flex-col p-5" data-testid="hub-base">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <span aria-hidden="true" className="type-figure grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-ink text-sm text-paper">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-display text-xl leading-tight text-ink">{base.name}</p>
                  <p className="mt-1 text-sm text-ink-muted">{base.area !== base.name ? `${base.area} · ` : ''}{base.styleLabel} · {base.priceTier}</p>
                </div>
              </div>
              <span className="shrink-0 text-right">
                <span className="type-figure block text-lg leading-none text-ink">{base.nights}</span>
                <span className="type-meta block">{base.nights === 1 ? 'night' : 'nights'}</span>
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink">{base.why}</p>
            {base.booked ? (
              <p className="mt-3" data-testid="hub-base-booked">
                <Badge tone="pine">Booked</Badge> <span className="text-sm text-ink">{base.booked.title}</span>
              </p>
            ) : (
              <p className="mt-3">
                <Badge>Not booked yet</Badge>
              </p>
            )}
            {base.advantages.length > 0 ? (
              <ul className="mt-3 space-y-1 text-sm leading-snug text-ink-muted">
                {base.advantages.map((a) => (
                  <li key={a} className="flex gap-2">
                    <span aria-hidden="true" className="text-pine">+</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {base.tradeoffs.length > 0 ? (
              <ul className="mt-1.5 space-y-1 text-sm leading-snug text-ink-muted">
                {base.tradeoffs.map((t) => (
                  <li key={t} className="flex gap-2">
                    <span aria-hidden="true" className="text-amber">–</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {base.alternatives.length > 0 ? <p className="mt-3 type-meta">Also worth a look: {base.alternatives.map((a) => a.name).join(', ')}.</p> : null}
            {tripId ? <DiscoverButton tripId={tripId} kind="stays" near={nearBase(base.baseId, base.name)} label="Find stays near this base" query={`hotel near ${base.area}`} /> : null}
          </li>
        ))}
      </ol>
      <p className="mt-4 type-meta">{lodging.shortlistBasis}</p>
      {tripId ? (
        <div className="mt-4">
          <BookedItemForm tripId={tripId} startDate={itinerary.startDate} endDate={itinerary.endDate} />
        </div>
      ) : null}
    </section>
  );
}

export function TransportSection({ intel }: { intel: TravelIntelligence }) {
  const t = intel.transport;
  const major = t.legs.filter((l) => l.role !== 'terminal' && (l.role === 'base_move' || (l.km ?? 0) >= 40 || l.durationBasis === 'unmeasured'));
  return (
    <div className="mt-6" data-testid="hub-transport">
      <div className="grid gap-4 sm:grid-cols-2">
        <TerminalCard title="Arriving" edge={t.terminal.arrival} ok={t.terminal.arrivalRespected} />
        <TerminalCard title="Leaving" edge={t.terminal.departure} ok={t.terminal.departureRespected} />
      </div>
      {major.length > 0 ? (
        <>
          <h3 className="mt-8 type-section text-ink">The transfers that shape the days</h3>
          <ol className="card mt-3 divide-y divide-rule" data-testid="hub-legs">
            {major.slice(0, 12).map((leg) => {
              /*
               * V8 — every leg says what kind of figure it carries. Measured,
               * estimated from map distance, on the operator's timing, or an
               * allowance because nobody could time it: the same four words the
               * Days view and the map legend use.
               */
              const state = legDurationState(leg.durationBasis, leg.unmeasuredReason);
              return (
                <li key={leg.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm" data-testid="hub-leg" data-mode={leg.mode} data-basis={leg.durationBasis}>
                  <span className="min-w-0 flex-1 text-ink">
                    <span className="type-figure text-ink-faint">Day {leg.dayNumber} · </span>
                    {leg.originName} → {leg.destinationName}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge>{LEG_MODE_LABELS[leg.mode]}</Badge>
                    <span className="type-figure text-sm text-ink">{leg.durationMinutes === null ? 'not timed' : `${leg.durationMinutes} min`}</span>
                    <Badge tone={state.tone} title={DURATION_BASIS_LABELS[leg.durationBasis]}>
                      {state.word}
                      {leg.trafficState === 'live' ? ' · live traffic' : leg.trafficState === 'typical' ? ' · typical traffic' : ''}
                    </Badge>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      {t.options.length > 0 ? (
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted hover:text-ink">Compare ways to make the big transfers</summary>
          <ul className="mt-2 divide-y divide-rule text-sm" data-testid="hub-options">
            {t.options.map((o) => (
              <li key={`${o.legId}:${o.mode}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
                <span className="text-ink">
                  {o.legLabel} · <span className="font-medium">{LEG_MODE_LABELS[o.mode]}</span>
                  {o.recommended ? <Badge tone="pine">Recommended</Badge> : null}
                </span>
                <span className="text-sm text-ink-muted">
                  cost {o.costBand} · transfers {o.transferBurden} · scenic {o.scenic} · <span className="type-figure">{o.durationMinutes === null ? 'not timed' : `${o.durationMinutes} min`}</span>
                </span>
                <span className="basis-full type-meta">{o.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="mt-4 type-meta">{t.modeNote}</p>
    </div>
  );
}

/** The four words for what a leg's minutes are, shared with the Days view and the map legend. */
function legDurationState(basis: string, unmeasuredReason?: string): { word: string; tone: BadgeTone } {
  if (basis === 'unmeasured') return unmeasuredReason === 'mode_not_road_routable' ? { word: 'operator-timed, not road-routed', tone: 'blue' } : { word: 'allowance — not timed', tone: 'amber' };
  if (basis === 'estimated' || basis === 'geo_estimate') return { word: 'estimated', tone: 'blue' };
  if (basis === 'scheduled') return { word: 'timetable', tone: 'pine' };
  if (basis === 'traffic_aware' || basis === 'static' || basis === 'measured') return { word: 'measured', tone: 'pine' };
  return { word: basis.replace(/_/g, ' '), tone: 'neutral' };
}

function TerminalCard({ title, edge, ok }: { title: string; edge: TravelIntelligence['transport']['terminal']['arrival']; ok: boolean }) {
  return (
    <div className={cx('card p-5', ok ? '' : 'border-clay bg-clay-soft')} data-testid={`hub-terminal-${title.toLowerCase()}`}>
      <p className="eyebrow">{title} · {edge.basis === 'booked' ? 'from your booking' : edge.basis === 'stated' ? 'from your trip setup' : edge.basis === 'band' ? 'a band, not a time' : 'time unknown'}</p>
      <p className="mt-1.5 text-sm text-ink">{edge.note}</p>
      <ul className="mt-2 space-y-0.5 text-sm text-ink-muted">
        <li>{edge.bufferLabel}: {edge.bufferMinutes} min</li>
        {edge.vehicleLabel ? <li>{edge.vehicleLabel}: {edge.vehicleMinutes} min</li> : null}
        <li>{edge.transferLabel}</li>
      </ul>
    </div>
  );
}

export function FoodSection({ intel, tripId, itinerary, coordinates = {} }: { intel: TravelIntelligence; tripId?: string; itinerary?: Itinerary; coordinates?: Record<string, { lat: number; lng: number }> }) {
  const f = intel.food;
  const nearDay = (dayNumber: number) => {
    const day = itinerary?.days.find((d) => d.dayNumber === dayNumber);
    if (!day) return null;
    if (coordinates[day.baseId]) return coordinates[day.baseId]!;
    const stop = day.items.find((i) => i.kind === 'activity' && i.placeId && coordinates[i.placeId]);
    return stop?.placeId ? (coordinates[stop.placeId] ?? null) : null;
  };
  return (
    <div className="mt-6" data-testid="hub-food">
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {f.days.filter((day) => day.meals.some((m) => m.role !== 'skip') || day.provisioning.length > 0).map((day) => (
          <li key={day.dayNumber} className={cx('card p-4', day.remote && 'border-amber bg-amber-soft/40')} data-testid="hub-food-day" data-remote={day.remote}>
            <p className="font-display text-lg text-ink">
              Day {day.dayNumber}
              {day.remote ? <span className="ml-2 font-sans text-xs font-medium text-amber">remote</span> : null}
              {f.specialOccasionDay === day.dayNumber ? <span className="ml-2 font-sans text-xs font-medium text-accent-strong">the special one</span> : null}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {day.meals.filter((m) => m.role !== 'skip').map((m) => (
                <li key={m.slot} className="text-ink-muted">
                  <span className="capitalize text-ink">{m.slot}</span> · {MEAL_ROLE_LABELS[m.role]}
                  {m.venueName ? <span className="text-ink"> — {m.venueName}</span> : null}
                  {m.reservation === 'required' || m.reservation === 'recommended' ? <span className="text-amber"> · book</span> : null}
                </li>
              ))}
            </ul>
            {tripId && day.meals.some((m) => m.venueStatus === 'unresolved') ? <DiscoverButton tripId={tripId} kind="food" near={nearDay(day.dayNumber)} label="Find somewhere for a meal near base" /> : null}
            {day.provisioning.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-sm text-ink-muted">
                {day.provisioning.map((p) => (
                  <li key={p}>• {p}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-4 type-meta">{f.venueDataNote}</p>
    </div>
  );
}

/**
 * PRODUCTION UI V1 — ONE BOOKING DATASET, TWO VIEWS.
 *
 * `view="book-first"` (Prepare) answers "what could break this trip if I do
 * not arrange it": stays as ONE grouped dependency, then the rental car,
 * scarce transport, timed entry, permits, guided days and the one dinner the
 * traveller values. `view="bookings"` (Plan) is the same items grouped by
 * kind with the traveller's own bookings and their statuses. Neither is a
 * second system. "If timed tickets apply" items are things to verify, not
 * yet things to book.
 */
const BOOKING_GROUP_OF: Record<string, 'Transport' | 'Stays' | 'Experiences' | 'Meals'> = {
  flight: 'Transport',
  train: 'Transport',
  ferry: 'Transport',
  rental_vehicle: 'Transport',
  shuttle: 'Transport',
  internal_transfer: 'Transport',
  accommodation: 'Stays',
  park_entry: 'Experiences',
  timed_entry: 'Experiences',
  permit: 'Experiences',
  tour_guide: 'Experiences',
  event: 'Experiences',
  restaurant: 'Meals',
  cruise: 'Experiences',
  programme: 'Experiences',
};

/**
 * V9 §5 — ONE ROW FOR A NEED, EVERYWHERE IT APPEARS.
 *
 * Prepare's Book first, Plan's bookings and the Book view all render this
 * row. With a `tripId` it carries the traveller's actions (Open official
 * source · Mark booked · Add confirmation · Replace · Skip); without one — the
 * shared copy — it is the fact and nothing pressable. A skipped need reads
 * "Not needed" with the traveller's own note, and its Skip becomes Put it back.
 * The window, deadline and cancellation terms the evidence carries render
 * here too; they used to be computed and shown to nobody.
 */
export function BookingRow({ b, members, elevated = false, tripId, resolutions = [], tripStart, tripEnd, testId = 'hub-booking' }: { b: TravelIntelligence['bookings']['items'][number]; members?: readonly TravelIntelligence['bookings']['items'][number][]; elevated?: boolean; tripId?: string; resolutions?: readonly BookingResolution[]; tripStart?: string; tripEnd?: string; testId?: string }) {
  const skipped = isSkipped(b, resolutions);
  const note = skipNote(b, resolutions);
  const terms = [b.bookingWindow, b.onSaleDate ? `On sale ${b.onSaleDate}` : undefined, b.deadline ? `Deadline ${b.deadline}` : undefined, b.cancellation].filter((t): t is string => Boolean(t));
  return (
    <li className={cx('py-3.5 text-sm', elevated && 'pl-3 border-l-2 border-accent')} data-testid={testId} data-kind={b.kind} data-group={b.group ?? ''} data-status={b.status} data-booking-id={b.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className={cx('font-medium text-ink', members && 'font-display text-lg font-normal')}>{b.title}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <Badge tone={b.status === 'booked' ? 'pine' : b.status === 'soft_hold' ? 'blue' : b.status === 'not_needed' ? 'neutral' : 'amber'}>{b.status === 'booked' ? 'Booked' : b.status === 'soft_hold' ? 'Tentative' : b.status === 'not_needed' ? (skipped ? 'Skipped' : 'Not needed') : 'Need to book'}</Badge>
          {b.date ? <span className="type-figure font-medium">{b.date}</span> : null}
          {b.timeLabel ? <span className="type-figure font-medium">{b.timeLabel}</span> : null}
        </span>
      </div>
      <p className="mt-1 text-sm leading-snug text-ink-muted">{b.reason}</p>
      {terms.length > 0 ? <p className="mt-1 type-meta" data-testid="hub-booking-terms">{terms.join(' · ')}</p> : null}
      {skipped && note ? <p className="mt-1 text-sm text-ink-muted">You skipped this: {note}</p> : null}
      {/*
        MVP V3, Stage 48 — the fourth question. What, why and when were all
        answered above; this is what happens if it is gone by the time the
        traveller gets there. Rendered only when the plan actually holds a
        fallback: silence here means Sidequest has none, not that none exists.
      */}
      {b.ifUnavailable ? (
        <p className="mt-1 text-sm leading-snug text-ink-muted" data-testid="hub-booking-fallback">
          <span className="text-clay">If it is gone:</span> {b.ifUnavailable}
        </p>
      ) : null}
      {members && members.length > 0 ? (
        <details className="mt-1.5" data-testid="hub-stays-group">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-accent underline underline-offset-4">View bases</summary>
          <ul className="mt-1 divide-y divide-rule">
            {members.map((m) => (
              <li key={m.id} className="py-2 text-sm" data-testid="hub-booking" data-kind={m.kind} data-status={m.status} data-booking-id={m.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-ink">{m.title}</span>
                  <span className="text-ink-faint">
                    {m.status === 'booked' ? 'Booked' : m.status === 'soft_hold' ? 'Tentative' : m.status === 'not_needed' ? (isSkipped(m, resolutions) ? 'Skipped' : 'Not needed') : 'Need to book'}
                    {m.date ? ` · ${m.date}` : ''}
                  </span>
                </div>
                {tripId ? <BookingActions tripId={tripId} need={m} skipped={isSkipped(m, resolutions)} tripStart={tripStart ?? m.date ?? ''} tripEnd={tripEnd ?? m.date ?? ''} /> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {tripId ? (
        <BookingActions tripId={tripId} need={b} skipped={skipped} tripStart={tripStart ?? b.date ?? ''} tripEnd={tripEnd ?? b.date ?? ''} />
      ) : b.officialSourceUrl ? (
        <a href={b.officialSourceUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-block text-sm text-accent underline underline-offset-4">
          {b.officialSourceName ?? 'Official page'}
        </a>
      ) : null}
    </li>
  );
}

export function BookFirstSection({ intel, tripId, booked, itinerary, honored, conflicts, view = 'book-first', resolutions = [] }: { intel: TravelIntelligence; tripId?: string; booked: readonly BookedPlanItem[]; itinerary: Itinerary; honored: readonly string[]; conflicts: readonly string[]; view?: 'book-first' | 'bookings'; resolutions?: readonly BookingResolution[] }) {
  const rowProps = { ...(tripId ? { tripId } : {}), resolutions, tripStart: itinerary.startDate, tripEnd: itinerary.endDate };
  const items = intel.bookings.items;
  const group = items.find((b) => b.memberIds);
  const members = group ? items.filter((b) => group.memberIds!.includes(b.id)) : [];
  const standalone = items.filter((b) => !b.memberIds && !(b.group === 'stays' && group));
  const open = [...(group && group.status === 'open' ? [group] : []), ...standalone.filter((b) => b.status === 'open')];
  const done = items.filter((b) => b.status !== 'open' && !b.memberIds && !(b.group === 'stays' && group));
  const verifyRequirement = (intel as { bookingPriorities?: string[] }).bookingPriorities ?? itinerary.package?.bookingPriorities.filter((line) => /\bif\b/i.test(line)) ?? [];

  if (view === 'bookings') {
    const groups = ['Transport', 'Stays', 'Experiences', 'Meals'] as const;
    return (
      <section className="mt-14" aria-labelledby="bookings" data-testid="hub-bookings">
        <SectionHeader id="bookings" title="Bookings" blurb="Everything this trip needs arranged, by kind, with what you have already booked. The same list as Book first, in a different order." />
        <BookingProgressLine intel={intel} />
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          {groups.map((name) => {
            const inGroup = [...(name === 'Stays' && group ? [group] : []), ...standalone.filter((b) => BOOKING_GROUP_OF[b.kind] === name)];
            if (inGroup.length === 0) return null;
            return (
              <div key={name} data-testid={`hub-bookings-group-${name.toLowerCase()}`}>
                <h3 className="font-display text-lg text-ink">{name}</h3>
                <ul className="mt-1 divide-y divide-rule">
                  {inGroup.map((b) => (
                    <BookingRow key={b.id} b={b} {...(b.memberIds ? { members } : {})} {...rowProps} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
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
              {booked.map((item) => (tripId ? <BookedItemRow key={item.id} tripId={tripId} item={item} /> : <li key={item.id} className="py-2 text-sm text-ink">{item.title}</li>))}
            </ul>
          )}
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
      </section>
    );
  }

  return (
    <section className="mt-14" aria-labelledby="book-first" data-testid="hub-book-first">
      <SectionHeader id="book-first" title="Book first" blurb="What could break this trip if it is not arranged. Priorities come from dependency, fixed times and lead times, not invented scarcity." />
      <BookingProgressLine intel={intel} />
      {BOOKING_PRIORITIES.map((priority) => {
        const rows = open.filter((b) => b.priority === priority);
        if (rows.length === 0) return null;
        return (
          <div key={priority} className="mt-5" data-testid={`hub-bookings-${priority}`}>
            {priority === 'book_first' ? (
              /*
                No blurb: the section header two lines above already says what
                Book first means, and the two sentences said it twice under one
                heading. The other priorities are headed only by their own
                title, so they keep theirs.
              */
              null
            ) : (
              <>
                <h3 className="type-section text-ink">
                  {BOOKING_PRIORITY_COPY[priority].title} <span className="type-figure text-sm text-accent">{rows.length}</span>
                </h3>
                <p className="mt-0.5 text-sm text-ink-muted">{BOOKING_PRIORITY_COPY[priority].blurb}</p>
              </>
            )}
            <ul className="mt-2 divide-y divide-rule">
              {rows.map((b) => (
                <BookingRow key={b.id} b={b} {...(b.memberIds ? { members } : {})} elevated={priority === 'book_first'} {...rowProps} />
              ))}
            </ul>
          </div>
        );
      })}
      {open.length === 0 ? <p className="mt-4 text-sm text-ink-muted">Nothing left to arrange from what Sidequest can see.</p> : null}
      {verifyRequirement.length > 0 ? (
        <div className="mt-6" data-testid="hub-verify-requirement">
          <h3 className="type-section text-ink">Verify booking requirement</h3>
          <p className="mt-0.5 text-sm text-ink-muted">The plan is not sure these need booking at all. Check, then book only if they do.</p>
          <ul className="mt-2 divide-y divide-rule text-sm">
            {verifyRequirement.map((line) => (
              <li key={line} className="py-2 text-ink-muted">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {done.length > 0 ? <p className="mt-4 type-meta">{done.length} of the things this trip depends on {done.length === 1 ? 'is' : 'are'} already covered by your bookings.</p> : null}
      <p className="mt-3 type-meta">
        Mark a need booked here, or add a confirmation under <a href="#book" className="text-accent underline underline-offset-4">Book</a>; the plan reshapes around it.
      </p>
    </section>
  );
}

export function BeforeYouGoSection({ intel, tripId, readinessProfile, checks }: { intel: TravelIntelligence; tripId?: string; readinessProfile: TravelReadinessProfile | null; checks: readonly string[] }) {
  const r = intel.readiness;
  const checked = new Set(checks);
  return (
    <section className="mt-14" aria-labelledby="before-you-go" data-testid="hub-before-you-go">
      <SectionHeader id="before-you-go" title="Before you go" blurb={r.international === 'no' ? 'A domestic trip on what you told us. The practical layer still applies.' : r.international === 'yes' ? `An international trip. Sidequest names the questions and where the official answers live; it does not answer them from memory.` : 'Whether this trip crosses a border depends on your citizenship, which Sidequest never guesses.'} />
      {tripId ? (
        <div className="mt-4">
          <ReadinessProfileForm tripId={tripId} current={readinessProfile} drives={intel.destinationContext.drives} />
        </div>
      ) : null}
      {/*
        PRODUCTION UI V1 — THE PRIMARY LIST IS 3–7 THINGS FOR THIS TRIP.
        Tiered by the readiness layer: what this traveller on this trip needs
        (documents, driving, money where the currency differs, the emergency
        number, insurance abroad, weather) leads; the generic international
        checklist stays complete behind "More travel checks".
      */}
      {(() => {
        const primary = r.entries.filter((e) => e.state !== 'not_applicable' && (e.tier ?? 'primary') === 'primary');
        const more = r.entries.filter((e) => !primary.includes(e));
        const Entry = ({ e }: { e: ReadinessEntry }) => (
          <li className="rule-top py-3.5" data-testid="hub-readiness-entry" data-kind={e.kind} data-state={e.state} data-tier={e.tier ?? 'primary'}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold text-ink">{e.title}</span>
              <Badge tone={STATE_TONE[e.state]}>{STATE_WORD[e.state]}</Badge>
            </div>
            <p className="mt-1 text-sm leading-snug text-ink-muted">{e.action ? <span className="text-ink">{e.action} </span> : null}{e.summary}</p>
            {e.links.length > 0 ? (
              <p className="mt-1.5 flex flex-wrap gap-x-3 text-sm">
                {e.links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">
                    {l.name}
                  </a>
                ))}
              </p>
            ) : null}
          </li>
        );
        return (
          <>
            <ul className="mt-5 grid gap-x-10 sm:grid-cols-2" data-testid="hub-readiness-primary">
              {primary.map((e) => (
                <Entry key={e.kind} e={e} />
              ))}
            </ul>
            {/* The section anchors the browser tests know, kept as invisible groupings of every entry. */}
            {READINESS_SECTIONS.map((section) => (r.entries.some((e) => READINESS_SECTION_OF[e.kind] === section) ? <span key={section} className="sr-only" data-testid={`hub-readiness-${section}`}>{READINESS_SECTION_LABELS[section]}</span> : null))}
            {more.length > 0 ? (
              <details className="mt-4" data-testid="hub-readiness-more">
                <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted hover:text-ink">More travel checks ({more.length})</summary>
                <ul className="mt-1 grid gap-x-10 sm:grid-cols-2">
                  {more.map((e) => (
                    <Entry key={e.kind} e={e} />
                  ))}
                </ul>
                <p className="mt-3 type-meta">{r.coverageNote}</p>
              </details>
            ) : (
              <p className="mt-3 type-meta">{r.coverageNote}</p>
            )}
          </>
        );
      })()}

      {/*
        V6 — this is Book first re-grouped with tick boxes, and the packet
        prints Book first. Kept in full on screen, where ticking things off is
        the point, and behind the appendix on paper, where it was a page and a
        third of the same items.
      */}
      <h3 className="mt-10 type-section text-ink" data-print="appendix">In order</h3>
      <p className="mt-1 type-small text-ink-muted" data-print="appendix">What to do now, what to book first, and what waits for the month, the week and the day before.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2" data-testid="hub-checklist" data-print="appendix">
        {intel.checklist.phases.map((phase, phaseIndex) => (
          <div key={phase.phase} className="card p-5" data-testid={`hub-phase-${phase.phase}`}>
            <p className="flex items-baseline gap-2">
              <span className="type-figure text-xs text-accent">{String(phaseIndex + 1).padStart(2, '0')}</span>
              <span className="eyebrow text-accent">{phase.title}</span>
            </p>
            <ul className="mt-2 divide-y divide-rule/60">
              {/*
                V8 — a row's title is what the row is about. Five rows headed
                "Set this up before you fly." read as one row five times;
                `checklistRows` gives each its own subject when a phase repeats
                a title, and leaves a unique title exactly as written.
              */}
              {checklistRows(phase.items).map((row) => (
                <li key={row.id}>
                  <CheckBox tripId={tripId} list="checklist" itemId={row.id} checked={checked.has(row.id)} label={row.blocking ? `${row.title} — blocking` : row.title} hint={row.sourceUrl ? `${row.detail} (${row.sourceName})` : row.detail} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {intel.safety.official.length + intel.safety.practical.length > 0 ? (
        <details className="mt-6">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted hover:text-ink">Safety: official sources and practical cautions</summary>
          <div className="mt-2 grid gap-4 sm:grid-cols-2 text-sm" data-testid="hub-safety">
            {(['official', 'practical', 'unknown'] as const).map((bucket) => {
              const list = intel.safety[bucket];
              if (list.length === 0) return null;
              return (
                <div key={bucket}>
                  <p className="eyebrow">{bucket === 'official' ? 'Official' : bucket === 'practical' ? 'Practical' : 'Unknown'}</p>
                  <ul className="mt-1.5 space-y-2 text-sm text-ink-muted">
                    {list.map((e) => (
                      <li key={`${e.title}:${e.detail}`}>
                        <span className="text-ink">{e.title}</span> — {e.detail}
                        {e.sourceUrl ? (
                          <>
                            {' '}
                            <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">
                              {e.sourceName}
                            </a>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function PackSection({ intel, tripId, checks }: { intel: TravelIntelligence; tripId?: string; checks: readonly string[] }) {
  const checked = new Set(checks);
  const p = intel.packing;
  return (
    <section className="mt-14" aria-labelledby="pack" data-testid="hub-pack">
      <SectionHeader id="pack" title="Pack" blurb={p.basisNote} />
      <div data-testid="packing-list">
      <div className="mt-5 columns-1 gap-6 sm:columns-2 lg:columns-3" data-testid="hub-packing-list">
        {PACKING_CATEGORIES.map((category) => {
          const items = p.items.filter((i) => i.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} className="mb-6 break-inside-avoid">
              <p className="eyebrow">{PACKING_CATEGORY_LABELS[category]}</p>
              <ul className="mt-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <CheckBox tripId={tripId} list="packing" itemId={item.id} checked={checked.has(item.id)} label={item.optional ? `${item.label} (optional)` : item.label} hint={item.why} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {p.modelSuggestions.length > 0 ? <p className="mt-2 type-meta">Also suggested for this trip: {p.modelSuggestions.join(', ')}.</p> : null}
      </div>
    </section>
  );
}

export function BudgetSection({ intel }: { intel: TravelIntelligence }) {
  const b = intel.budget;
  return (
    <section className="mt-14" aria-labelledby="budget" data-testid="hub-budget">
      <SectionHeader id="budget" title="Budget" blurb={b.precisionNote} />
      <p className="card mt-5 p-5">
        <span className="eyebrow block">Estimated total</span>
        <span className="type-figure mt-1 block text-[1.75rem] leading-tight text-ink">
          {b.currency} {b.total.low.toLocaleString()}–{b.total.high.toLocaleString()}
        </span>
        <span className="mt-1 block text-sm text-ink-muted">for {b.travellers} {b.travellers === 1 ? 'traveller' : 'travellers'} — a range, not a quote</span>
      </p>
      {b.envelope ? (
        <p className={cx('mt-1 text-sm', b.envelope.fit === 'over' ? 'text-clay' : b.envelope.fit === 'tight' ? 'text-amber' : 'text-pine')} data-testid="hub-budget-envelope">
          Against your {b.currency} {b.envelope.amount.toLocaleString()} {b.envelope.basis.replace(/_/g, ' ')}: {b.envelope.fit}.
        </p>
      ) : null}
      <dl className="mt-4 divide-y divide-rule text-sm">
        {b.lines.map((line) => (
          <div key={line.category} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-3">
            <dt className="font-medium text-ink">{BUDGET_CATEGORY_LABELS[line.category]}</dt>
            <dd className="type-figure text-ink">
              {line.low.toLocaleString()}–{line.high.toLocaleString()} <span className="font-sans text-xs font-normal text-ink-muted">{line.perPerson ? 'per person' : 'for the party'}</span>
            </dd>
            <dd className="basis-full type-meta">{line.basis}{line.excludes.length > 0 ? ` · excludes ${line.excludes.join(', ').toLowerCase()}` : ''}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 text-sm">
        <div className="card p-4">
          <p className="eyebrow text-pine">Save here</p>
          <ul className="mt-1.5 space-y-1 text-ink-muted">{b.strategy.saveHere.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
        <div className="card p-4">
          <p className="eyebrow text-accent-strong">Spend here</p>
          <ul className="mt-1.5 space-y-1 text-ink-muted">{b.strategy.spendHere.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      </div>
      {b.booked.length > 0 ? (
        <p className="mt-4 text-sm text-ink" data-testid="hub-budget-booked">
          Booked so far: {b.booked.map((x) => `${x.title} ${x.currency} ${x.amount.toLocaleString()}`).join(' · ')}
        </p>
      ) : null}
      <p className="mt-4 type-meta">{b.conversionNote}</p>
    </section>
  );
}

export function BackupsSection({ intel }: { intel: TravelIntelligence }) {
  return (
    <div className="mt-6" data-testid="hub-backups">
      <ol className="grid gap-3 sm:grid-cols-2">
        {intel.backups.map((day) => (
          <li key={day.dayNumber} className="card p-4 text-sm" data-testid="hub-backup-day">
            <p className="font-display text-lg leading-snug text-ink">
              <span className="type-figure font-sans text-xs text-ink-faint">Day {day.dayNumber} · </span>
              {day.planA}
            </p>
            {day.fallback ? (
              <p className="mt-2 text-sm text-ink-muted">
                <span className="font-medium text-ink">If {day.fallback.trigger.toLowerCase()}:</span> {day.fallback.name}
                {day.fallback.verified ? '' : ' (proposed, not verified)'}
              </p>
            ) : (
              <p className="mt-2 type-meta">No fallback on record; the flex stops below are the slack.</p>
            )}
            {day.flexItems.length > 0 ? <p className="mt-1.5 text-sm text-ink-muted">Can move or go: {day.flexItems.join(', ')}</p> : null}
            {day.triggers.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5 type-meta">
                {day.triggers.slice(0, 3).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : null}
            {day.decisionPoint ? <p className="mt-2 text-sm font-medium text-accent-strong">{day.decisionPoint}</p> : null}
          </li>
        ))}
      </ol>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm" data-testid="hub-regret" data-print="appendix">
        {(
          [
            ['Don’t miss', intel.regret.dontMiss],
            ['Safe to skip', intel.regret.safeToSkip],
            ['Book early', intel.regret.bookEarly],
            ['Keep flexible', intel.regret.keepFlexible],
            ['Verify before leaving', intel.regret.verifyBeforeLeaving],
          ] as const
        ).map(([title, list]) =>
          list.length === 0 ? null : (
            <div key={title}>
              <p className="eyebrow">{title}</p>
              <ul className="mt-1.5 space-y-1.5">
                {list.map((entry, index) => (
                  <li key={`${entry.name}:${index}`} className="font-medium text-ink">
                    {entry.name}
                    <span className="block text-sm font-normal text-ink-muted">{entry.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

const CLAIM_TONE: Record<string, BadgeTone> = { confirmed: 'pine', unverified: 'neutral', contradicted: 'clay', stale: 'amber', not_applicable: 'neutral', needs_input: 'amber' };

export function VerifySection({ intel, manifest, pkg }: { intel: TravelIntelligence; manifest?: RecheckManifest | null; pkg?: TripPackage | undefined }) {
  const recheck = new Set(intel.freshness.recheckBeforeDeparture);
  const material = intel.sourceRegistry.filter((c) => c.state !== 'not_applicable' && (c.state !== 'confirmed' || recheck.has(c.id)) && c.kind !== 'place_identity' && c.kind !== 'routing_duration');
  const access = intel.access.filter((a) => a.verifyBeforeTravel);
  return (
    <section className="mt-14" aria-labelledby="verify" data-testid="hub-verify">
      <SectionHeader id="verify" title="Trip confidence" blurb="What Sidequest could check, what to look at again nearer the date, and what is still uncertain." />
      {/*
        * PRODUCTION LOCK V5 §27 — ONE CONFIDENCE, ONE SET OF NUMBERS.
        *
        * This used to read `pkg={intel.verification ? undefined : undefined}` —
        * a ternary with the same value on both arms, so the package never
        * reached the component and this block counted places it could not see.
        * A live Hong Kong packet printed both blocks: "Places checked 0 / 13"
        * from the itinerary's own render, and "Places checked 0 / 0" from this
        * one, fifteen lines apart and contradicting each other.
        *
        * The package is now passed in from the same source the other render
        * uses, so both derive from one thing and agree by construction.
        */}
      <div className="mt-4">
        <TripConfidence pkg={pkg} intel={intel} compact />
      </div>
      {manifest && manifest.items.length > 0 ? (
        <>
          <h3 className="mt-5 font-display text-lg text-ink">When to look again</h3>
          <p className="mt-1 text-sm text-ink-muted">{manifest.note}</p>
          <ul className="mt-2 divide-y divide-rule text-sm" data-testid="hub-recheck">
            {manifest.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-state={item.state} data-window={item.window}>
                <span className="text-ink">
                  <Badge tone={item.state === 'due' ? 'amber' : item.state === 'past' ? 'neutral' : 'blue'}>{RECHECK_WINDOW_LABELS[item.window]}</Badge>
                  <span className="ml-2">{item.title}</span>
                </span>
                <span className="text-sm text-ink-muted">{item.automatable ? 'Sidequest can re-read this' : 'Read the official source yourself'}</span>
                <span className="basis-full type-meta">{item.why}</span>
                {item.sourceUrl ? (
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" className="basis-full text-sm text-accent underline underline-offset-4">
                    Official source
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {access.length > 0 ? (
        <>
          <h3 className="mt-5 font-display text-lg text-ink">Places to check before you rely on them</h3>
          <ul className="mt-2 divide-y divide-rule text-sm" data-testid="hub-access">
            {access.slice(0, 12).map((a) => (
              <li key={a.itemId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-state={a.state}>
                <span className="text-ink">
                  <span className="text-ink-faint">Day {a.dayNumber} · </span>
                  {a.title}
                </span>
                <span className="text-sm text-ink-muted">{ACCESS_STATE_LABELS[a.state]}</span>
                {a.attribution ? (
                  <span className="basis-full type-meta" data-testid="hub-access-attribution">
                    {a.note} {a.attribution}{a.checkedAt ? ` · read ${a.checkedAt.slice(0, 10)}` : ''}
                  </span>
                ) : null}
                {a.sourceUrl ? (
                  <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener" className="basis-full text-sm text-accent underline underline-offset-4">
                    {a.sourceName ?? 'Source'}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <details className="mt-6" data-testid="hub-sources" data-print="appendix">
        <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted hover:text-ink">Every fact behind this plan, with its source and how fresh it is ({intel.sourceRegistry.length})</summary>
        <p className="mt-1 type-meta">{intel.freshness.note}</p>
        <ul className="mt-2 divide-y divide-rule text-xs">
          {[...material, ...intel.sourceRegistry.filter((c) => !material.includes(c) && c.state !== 'not_applicable')].slice(0, 120).map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5" data-testid="hub-claim" data-kind={c.kind} data-authority={c.authority} data-state={c.state}>
              <span className="min-w-0 text-ink">{c.claim}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={CLAIM_TONE[c.state] ?? 'neutral'}>{CLAIM_STATE_LABELS[c.state]}</Badge>
                <span className="text-ink-faint">{AUTHORITY_LABELS[c.authority]} · {c.sourceName}</span>
                <span className="text-ink-faint" title={FRESHNESS_LABELS[c.freshness]}>{recheck.has(c.id) ? 'recheck before departure' : 'stable'}</span>
                {c.checkedAt ? <span className="numeral text-ink-faint">{c.checkedAt.slice(0, 10)}</span> : null}
              </span>
              {c.sourceUrl ? (
                <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="basis-full text-accent underline underline-offset-4">
                  {c.sourceUrl}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export function CritiquePanel({ intel }: { intel: TravelIntelligence }) {
  const c = intel.critique;
  if (!c) return null;
  return (
    <Panel className="card mt-8 p-5" as="section" testId="hub-critique">
      <p className="eyebrow text-accent">Your plan, checked</p>
      <h2 className="mt-1 type-section text-ink">{c.headline}</h2>
      <ul className="mt-4 divide-y divide-rule">
        {c.findings.map((f) => (
          <li key={`${f.topic}:${f.title}`} className="py-2.5 text-sm" data-testid="hub-critique-finding" data-severity={f.severity} data-topic={f.topic}>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className={cx('h-2 w-2 shrink-0 rounded-full', f.severity === 'concern' ? 'bg-clay' : f.severity === 'note' ? 'bg-amber' : 'bg-pine')} aria-hidden="true" />
              <span className="text-ink">{f.title}</span>
              <span className="sr-only">{f.severity}</span>
            </p>
            <p className="mt-0.5 pl-4 text-sm leading-snug text-ink-muted">{f.detail}</p>
            {f.suggestion ? <p className="mt-0.5 pl-4 text-sm text-accent-strong">{f.suggestion}</p> : null}
          </li>
        ))}
      </ul>
      {c.userPlaces.length > 0 ? (
        <div className="mt-4 text-sm" data-testid="hub-critique-places">
          <p className="eyebrow">Your places</p>
          <ul className="mt-1 space-y-1">
            {c.userPlaces.map((p, index) => (
              <li key={`${p.name}:${index}`} className="text-ink" data-outcome={p.outcome}>
                <Badge tone={p.outcome === 'kept' ? 'pine' : p.outcome === 'moved' ? 'blue' : 'clay'}>{p.outcome.replace('_', ' ')}</Badge> {p.name}
                <span className="block text-sm text-ink-muted">{p.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {(c.move.length > 0 || c.cut.length > 0 || c.keep.length > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3 text-sm">
          {(
            [
              ['Move', c.move],
              ['Cut', c.cut],
              ['Keep', c.keep],
            ] as const
          ).map(([title, list]) =>
            list.length === 0 ? null : (
              <div key={title}>
                <p className="eyebrow">{title}</p>
                <ul className="mt-1 space-y-0.5 text-sm text-ink-muted">
                  {list.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      )}
    </Panel>
  );
}

export { Glyph as HubGlyph };

/**
 * LIVE WORLD V1 — TODAY.
 *
 * Shown only while the trip is under way: what is happening now, what is
 * next, the next leg and what kind of figure its duration is, today's
 * bookings, the day's weather, the critical warnings and the fallback.
 * Nothing here is fetched; it is the persisted plan read at this instant.
 */
export function TodaySection({ today, minuteLabel, tripId }: { today: TodayView; minuteLabel: (minute: number) => string; tripId?: string }) {
  if (!today.active) return null;
  return (
    <section className="card-raised mt-6 border-pine bg-pine-soft/40 p-5" aria-labelledby="today" data-testid="hub-today">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="eyebrow text-pine">Today · day {today.dayNumber}{today.baseName ? ` · based in ${today.baseName}` : ''}</p>
          <h2 id="today" className="mt-1 font-display text-2xl text-ink">
            {today.theme ?? 'Today'}
          </h2>
        </div>
        {/* V9 §8 — the phone-first Today page: big targets, no planner chrome. Owner only. */}
        {tripId ? (
          <a href={`/trips/${tripId}/today`} className="pressable inline-flex min-h-11 shrink-0 items-center rounded-full bg-pine px-4 text-sm font-semibold text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine" data-testid="hub-today-open">
            Open Today
          </a>
        ) : null}
      </div>
      {/* V9 §8 — when to leave for the next thing, with the basis named; never invented from an untimed leg. */}
      {today.leaveBy ? (
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-sm text-ink" data-testid="today-leave-by" data-basis={today.leaveBy.basis}>
          <span className="eyebrow">Leave by</span>
          <span className="type-figure text-lg">{today.leaveBy.time}</span>
          <span className="type-meta">{today.leaveBy.basisNote}</span>
        </p>
      ) : null}
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="eyebrow">Now</dt>
          <dd className="text-ink" data-testid="today-now">{today.current ? `${today.current.title} · until ${minuteLabel(today.current.endMinute)}` : 'Nothing scheduled right now.'}</dd>
        </div>
        <div>
          <dt className="eyebrow">Next</dt>
          <dd className="text-ink" data-testid="today-next">{today.next ? `${today.next.title} · ${minuteLabel(today.next.startMinute)}` : 'Nothing more today.'}</dd>
        </div>
        {today.nextTransport ? (
          <div>
            <dt className="eyebrow">Next leg</dt>
            <dd className="text-ink" data-testid="today-leg">
              {today.nextTransport.title} · {today.nextTransport.minutes !== null ? `${today.nextTransport.minutes} min` : 'not measured'} <span className="text-ink-faint">({today.nextTransport.basis.replace(/_/g, ' ')})</span>
            </dd>
          </div>
        ) : null}
        {today.weather ? (
          <div>
            <dt className="eyebrow">Weather</dt>
            <dd className="text-ink">{today.weather.summary}{today.weather.cautions.length > 0 ? ` — ${today.weather.cautions.join('; ')}` : ''}</dd>
          </div>
        ) : null}
      </dl>
      {today.bookedToday.length > 0 ? (
        <p className="mt-3 text-sm text-ink" data-testid="today-booked">
          Booked today: {today.bookedToday.map((b) => `${b.title}${b.startTime ? ` at ${b.startTime}` : ''}${b.location ? ` (${b.location})` : ''}`).join(' · ')}
        </p>
      ) : null}
      {today.criticalWarnings.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-clay" data-testid="today-warnings">
          {today.criticalWarnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {today.fallback ? <p className="mt-3 text-sm text-ink-muted">If today goes wrong: {today.fallback}</p> : null}
      {today.flexAlternatives.length > 0 ? <p className="mt-1 type-meta">Flexible: {today.flexAlternatives.join(' · ')}</p> : null}
      <ol className="mt-4 flex flex-wrap gap-2 text-sm" data-testid="today-stops">
        {today.stops.map((stop) => (
          <li key={stop.id} className={cx('rounded-full border px-2.5 py-1', stop.done ? 'border-rule text-ink-faint line-through' : 'border-pine text-ink')}>
            {minuteLabel(stop.startMinute)} {stop.title}
          </li>
        ))}
      </ol>
    </section>
  );
}
