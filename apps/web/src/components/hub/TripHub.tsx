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
  type TravelIntelligence,
  type TravelReadinessProfile,
  type TripPackage,
  buildBookingProgress,
} from '@sidequest/core';
import { Badge, Panel, cx, type BadgeTone } from '../ui';
import { humanDate } from './plan-format';
import { TripConfidence } from './TripConfidence';
import { Glyph } from '../interview/glyphs';
import { BookedItemForm, BookedItemRow, CheckBox, ReadinessProfileForm } from './HubForms';
import { BookingActions } from './BookingActions';
import { isSkipped, skipNote } from './booking-copy';
import { checklistRows } from './checklist-titles';
import { DiscoverButton } from '@/app/(product)/trips/[id]/itinerary/live-controls';
import { FigureRow, RailSection } from './views/ViewHead';

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
export function BookingProgressLine({ intel, nextStatedAbove = false, variant = 'card' }: { intel: TravelIntelligence; /** `strip` — the boxed figure row a view head carries. */ variant?: 'card' | 'strip'; /** V11 §I — true where a "Book next" block on the same page already names it. */ nextStatedAbove?: boolean }) {
  const progress = buildBookingProgress(intel.bookings.items);
  if (progress.critical === 0) return null;
  const share = progress.critical > 0 ? Math.round((progress.arranged / progress.critical) * 100) : 0;
  if (variant === 'strip') {
    return (
      <div data-testid="booking-progress">
        <FigureRow
          figures={[
            {
              label: 'Book first',
              value: (
                <>
                  <span className="type-figure">{progress.arranged}</span> of <span className="type-figure">{progress.critical}</span> arranged
                </>
              ),
            },
            ...progress.groups.map((group) => ({ label: group.title, value: <span className="type-figure">{group.done}/{group.total}</span>, testId: `booking-progress-${group.id}`, attrs: { 'data-done': String(group.done), 'data-total': String(group.total) } })),
          ]}
        />
        <div aria-hidden="true" className="hv-range mt-0" style={{ ['--lo' as string]: '0%', ['--hi' as string]: `${share}%` }}>
          <i className="!bg-pine" />
        </div>
        {progress.nextAction ? (
          nextStatedAbove ? null : (
            <p className="mt-3 type-small text-ink-muted">
              Next: <span className="font-medium text-ink">{progress.nextAction.travelerAction}</span>
            </p>
          )
        ) : (
          <p className="mt-3 type-small text-pine">Everything this trip depends on is arranged.</p>
        )}
      </div>
    );
  }
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
        nextStatedAbove ? null : (
          <p className="mt-3 type-small text-ink-muted">
            Next: <span className="font-medium text-ink">{progress.nextAction.travelerAction}</span>
          </p>
        )
      ) : (
        <p className="mt-3 type-small text-pine">Everything this trip depends on is arranged.</p>
      )}
      {/*
        V11 §3 — A TALLY COUNTS; IT DOES NOT RE-LIST.

        This card used to print every booking need as a tick row, and the
        Book-first section directly beneath it listed the same needs again with
        their dates, their dependency sentences and the three actions that act
        on them. Two renderings of the same two or three rows about two hundred
        pixels apart, and only one of them could be acted on.

        The needs belong to `BookFirstSection`, which owns the actions. What is
        genuinely this card's own is the shape of the whole: how much of what
        could break the trip is settled, and what to do next. So the groups keep
        their counts — a count of a list is not a copy of it — and the rows are
        gone.
      */}
      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5">
        {progress.groups.map((group) => (
          <li key={group.id} className="type-small text-ink-muted" data-testid={`booking-progress-${group.id}`} data-done={group.done} data-total={group.total}>
            {group.title} <span className="type-figure text-ink">{group.done}/{group.total}</span>
          </li>
        ))}
      </ul>
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
  /* The days each base holds, from the days themselves; nothing here is inferred from nights alone. */
  const daysAt = (baseId: string, name: string) => {
    const numbers = itinerary.days.filter((d) => d.baseId === baseId || d.baseName === name).map((d) => d.dayNumber);
    if (numbers.length === 0) return null;
    const first = Math.min(...numbers);
    const last = Math.max(...numbers);
    return first === last ? `Day ${first}` : `Days ${first}–${last}`;
  };
  const churn = lodging.churn;
  return (
    <section className="mt-14" aria-labelledby="stays" data-testid="hub-stays">
      <SectionHeader id="stays" title="Where to stay" blurb={lodging.hotelChangeNote} />
      {churn ? (
        <div className="mt-5" data-testid="hub-stays-churn" data-level={churn.level}>
          <FigureRow
            figures={[
              { label: 'Route', value: churn.level === 'settled' ? 'One base' : churn.level === 'aggressive' ? 'Fast-moving' : 'Steady' },
              { label: 'Bases', value: <span className="type-figure">{churn.baseCount}</span> },
              { label: 'Nights', value: <span className="type-figure">{churn.nights}</span> },
              { label: 'Hotel changes', value: <span className="type-figure">{churn.hotelChanges}</span> },
              { label: 'Nights per base', value: <span className="type-figure">{churn.averageNightsPerBase}</span> },
            ]}
          />
          {/* Said once: the change note above often already carries the simpler route. */}
          {churn.simplerRoute[0] && !lodging.hotelChangeNote.includes(churn.simplerRoute[0]) ? <p className="mt-3 text-sm text-ink">Simpler: {churn.simplerRoute[0]}.</p> : null}
        </div>
      ) : null}
      {/*
        SURVEY ATLAS — THE ROUTE AS A SEQUENCE OF BEDS.

        Each base is a cell whose width is its share of the nights, in the order
        the trip sleeps there, with the nights set as the figure. It is the one
        picture of a stay plan that answers "how long where, in what order" at a
        glance; the rows beneath carry the reasons.
      */}
      {lodging.bases.length > 1 ? (
        <ol className="hv-strip mt-6" aria-label="Where you sleep, in order">
          {lodging.bases.map((base, index) => (
            <li key={base.baseId} style={{ ['--n' as string]: String(Math.max(base.nights, 1)) }}>
              <p className="coordbar text-ink-faint">
                {String(index + 1).padStart(2, '0')}
                <span className="hv-strip-days">{daysAt(base.baseId, base.name) ? ` · ${daysAt(base.baseId, base.name)}` : ''}</span>
              </p>
              <p className="mt-2 flex items-end gap-2">
                <span className="hv-nights">{base.nights}</span>
                <span className="hidden pb-0.5 type-meta sm:inline">{base.nights === 1 ? 'night' : 'nights'}</span>
                <span className="sr-only sm:hidden">{base.nights === 1 ? 'night' : 'nights'} in {base.name}</span>
              </p>
              <p className="mt-2 hidden break-words font-display sm:line-clamp-2 text-base leading-tight text-ink" title={base.name}>
                {base.name}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      <ol className="ruled mt-6 border-t-[1.5px] border-ink" data-testid="where-to-stay">
        {lodging.bases.map((base, index) => (
          <li key={base.baseId} className="hv-base" data-testid="hub-base">
            <span aria-hidden="true" className="hv-specimen">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="min-w-0">
              <p className="coordbar text-ink-faint">{daysAt(base.baseId, base.name) ?? ' '}</p>
              <p className="mt-1 font-display text-2xl leading-tight text-ink">{base.name}</p>
              <p className="mt-1 text-sm text-ink-muted">
                {base.area !== base.name ? `${base.area} · ` : ''}
                {base.styleLabel} · {base.priceTier}
                <span className="sm:hidden">
                  {' '}
                  · <span className="type-figure text-ink">{base.nights}</span> {base.nights === 1 ? 'night' : 'nights'}
                </span>
              </p>
              <p className="measure mt-3 text-sm leading-relaxed text-ink">{base.why}</p>
              {base.booked ? (
                <p className="mt-3 flex flex-wrap items-center gap-2" data-testid="hub-base-booked">
                  <StatusWord status="booked" /> <span className="text-sm text-ink">{base.booked.title}</span>
                </p>
              ) : (
                <p className="mt-3">
                  <span className="hv-status" data-tone="quiet">Not booked yet</span>
                </p>
              )}
              {base.advantages.length + base.tradeoffs.length > 0 ? (
                <div className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                  {base.advantages.length > 0 ? (
                    <ul className="space-y-1 text-sm leading-snug text-ink-muted">
                      {base.advantages.map((a) => (
                        <li key={a} className="flex gap-2">
                          <span aria-hidden="true" className="type-figure text-pine">+</span>
                          <span>{a}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {base.tradeoffs.length > 0 ? (
                    <ul className="space-y-1 text-sm leading-snug text-ink-muted">
                      {base.tradeoffs.map((t) => (
                        <li key={t} className="flex gap-2">
                          <span aria-hidden="true" className="type-figure text-amber">–</span>
                          <span>{t}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {base.alternatives.length > 0 ? <p className="mt-3 type-meta">Also worth a look: {base.alternatives.map((a) => a.name).join(', ')}.</p> : null}
              {tripId ? <DiscoverButton tripId={tripId} kind="stays" near={nearBase(base.baseId, base.name)} label="Find stays near this base" query={`hotel near ${base.area}`} /> : null}
            </div>
            <p className="hidden text-right sm:block">
              <span className="hv-nights block">{base.nights}</span>
              <span className="mt-1 block type-meta">{base.nights === 1 ? 'night' : 'nights'}</span>
            </p>
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
    <div className="mt-10" data-testid="hub-transport">
      {/* The two edges of the trip, side by side: how you arrive and how you leave. */}
      <div className="grid divide-y divide-ink border border-ink sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <TerminalCard title="Arriving" edge={t.terminal.arrival} ok={t.terminal.arrivalRespected} />
        <TerminalCard title="Leaving" edge={t.terminal.departure} ok={t.terminal.departureRespected} />
      </div>
      {major.length > 0 ? (
        <>
          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b-[1.5px] border-ink pb-2">
            <h3 className="type-section text-ink">The transfers that shape the days</h3>
            {/* The legend is the map's own: the line says what kind of figure the minutes are. */}
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 type-meta" aria-hidden="true">
              <span className="inline-flex items-center gap-1.5"><span className="hv-swatch" data-evidence="measured" /> measured</span>
              <span className="inline-flex items-center gap-1.5"><span className="hv-swatch" data-evidence="estimated" /> estimated</span>
              <span className="inline-flex items-center gap-1.5"><span className="hv-swatch" data-evidence="unmeasured" /> not timed</span>
            </p>
          </div>
          <ol className="ruled" data-testid="hub-legs">
            {major.slice(0, 12).map((leg) => {
              /*
               * V8 — every leg says what kind of figure it carries. Measured,
               * estimated from map distance, on the operator's timing, or an
               * allowance because nobody could time it: the same four words the
               * Days view and the map legend use, and the same line.
               */
              const state = legDurationState(leg.durationBasis, leg.unmeasuredReason);
              return (
                <li key={leg.id} className="hv-leg text-sm" data-testid="hub-leg" data-mode={leg.mode} data-basis={leg.durationBasis}>
                  <span className="coordbar text-ink-muted">Day {String(leg.dayNumber).padStart(2, '0')}</span>
                  <span className="min-w-0 text-ink">
                    <span className="font-medium">{leg.originName}</span> <span aria-hidden="true" className="text-ink-faint">→</span>
                    <span className="sr-only"> to </span> <span className="font-medium">{leg.destinationName}</span>
                  </span>
                  <span className="hv-leg-meta">
                    <span className="sheet-label text-ink-muted">{LEG_MODE_LABELS[leg.mode]}</span>
                    <span className="type-figure min-w-[4.5rem] text-right text-base text-ink">{leg.durationMinutes === null ? <span aria-label="no figure">—</span> : `${leg.durationMinutes} min`}</span>
                    <span className="inline-flex items-center gap-2" title={DURATION_BASIS_LABELS[leg.durationBasis]}>
                      <span aria-hidden="true" className="hv-swatch" data-evidence={swatchFor(leg.durationBasis)} />
                      <span className="type-meta !text-ink-muted">
                        {state.word}
                        {leg.trafficState === 'live' ? ' · live traffic' : leg.trafficState === 'typical' ? ' · typical traffic' : ''}
                      </span>
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      {t.options.length > 0 ? (
        <details className="mt-4 border-t border-rule">
          <summary className="min-h-11 cursor-pointer py-2.5 text-sm text-ink-muted hover:text-ink">Compare ways to make the big transfers</summary>
          <ul className="ruled mt-1 text-sm" data-testid="hub-options">
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

/** Which line the map draws for a leg of this basis. */
function swatchFor(basis: string): 'measured' | 'estimated' | 'unmeasured' | 'scheduled' {
  if (basis === 'unmeasured') return 'unmeasured';
  if (basis === 'estimated' || basis === 'geo_estimate') return 'estimated';
  if (basis === 'scheduled') return 'scheduled';
  return 'measured';
}

/** The four words for what a leg's minutes are, shared with the Days view and the map legend. */
function legDurationState(basis: string, unmeasuredReason?: string): { word: string; tone: BadgeTone } {
  if (basis === 'unmeasured') return unmeasuredReason === 'mode_not_road_routable' ? /* V11 §20 — the operator sets these hours; "road-routed" is our plumbing, not their concern. */
    { word: 'the operator sets this time', tone: 'blue' } : { word: 'time set aside — not timed yet', tone: 'amber' };
  if (basis === 'estimated' || basis === 'geo_estimate') return { word: 'estimated', tone: 'blue' };
  if (basis === 'scheduled') return { word: 'timetable', tone: 'pine' };
  if (basis === 'traffic_aware' || basis === 'static' || basis === 'measured') return { word: 'measured', tone: 'pine' };
  return { word: basis.replace(/_/g, ' '), tone: 'neutral' };
}

function TerminalCard({ title, edge, ok }: { title: string; edge: TravelIntelligence['transport']['terminal']['arrival']; ok: boolean }) {
  return (
    <div className={cx('min-w-0 p-5', ok ? 'bg-paper-raised' : 'bg-clay-soft shadow-[inset_3px_0_0_var(--color-clay)]')} data-testid={`hub-terminal-${title.toLowerCase()}`}>
      <p className="sheet-label text-ink-muted">
        {title === 'Arriving' ? 'In' : 'Out'} · {title}
      </p>
      <p className="eyebrow mt-2">{edge.basis === 'booked' ? 'from your booking' : edge.basis === 'stated' ? 'from your trip setup' : edge.basis === 'band' ? 'a band, not a time' : 'time unknown'}</p>
      <p className="mt-1.5 font-display text-lg leading-snug text-ink">{edge.note}</p>
      <dl className="ruled mt-3 text-sm">
        <div className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-ink-muted">{edge.bufferLabel}</dt>
          <dd className="type-figure text-ink">{edge.bufferMinutes} min</dd>
        </div>
        {edge.vehicleLabel ? (
          <div className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="text-ink-muted">{edge.vehicleLabel}</dt>
            <dd className="type-figure text-ink">{edge.vehicleMinutes} min</dd>
          </div>
        ) : null}
        <div className="py-1.5 text-ink-muted">{edge.transferLabel}</div>
      </dl>
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
  const days = f.days.filter((day) => day.meals.some((m) => m.role !== 'skip') || day.provisioning.length > 0);
  const SLOTS = ['breakfast', 'lunch', 'dinner'] as const;
  return (
    <div className="mt-10" data-testid="hub-food">
      {/*
        SURVEY ATLAS — FOOD AS A RHYTHM ACROSS THE DAYS.

        One row a day, one column a meal, so the shape of the eating is visible
        down the page: a filled mark for a meal that is an event, an open one for
        a meal that is fuel, a dotted one where nothing is planned. Snacks and
        provisions sit in the last column, the "find somewhere" action with them.
      */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b-[1.5px] border-ink pb-2">
        <h3 className="type-section text-ink">Across the days</h3>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 type-meta" aria-hidden="true">
          <span className="hv-meal" data-weight="event">worth the trip</span>
          <span className="hv-meal" data-weight="fuel">fuel</span>
          <span className="hv-meal" data-weight="none">not planned</span>
        </p>
      </div>
      <div aria-hidden="true" className="hv-rhythm hv-rhythm-head sheet-label text-ink-faint">
        <span>Day</span>
        {SLOTS.map((slot) => (
          <span key={slot}>{slot}</span>
        ))}
        <span className="hidden md:block">Also</span>
      </div>
      <ol>
        {days.map((day) => {
          const extra = day.meals.filter((m) => m.role !== 'skip' && !(SLOTS as readonly string[]).includes(m.slot));
          const findFood = tripId && day.meals.some((m) => m.venueStatus === 'unresolved');
          const hasExtra = extra.length > 0 || day.provisioning.length > 0 || findFood;
          return (
            <li key={day.dayNumber} className={cx('hv-rhythm hv-rhythm-row', day.remote && 'bg-amber-soft/40')} data-testid="hub-food-day" data-remote={day.remote}>
              <p className="min-w-0">
                <span className="hv-nights block !text-[1.75rem] md:!text-[2.25rem]">{String(day.dayNumber).padStart(2, '0')}</span>
                <span className="sr-only">Day {day.dayNumber}</span>
                {day.remote ? <span className="mt-1 block text-[10.5px] font-medium uppercase tracking-[0.08em] text-amber">remote</span> : null}
                {f.specialOccasionDay === day.dayNumber ? <span className="mt-1 block text-[10.5px] font-medium uppercase tracking-[0.08em] text-accent-strong">special</span> : null}
              </p>
              {SLOTS.map((slot) => {
                const m = day.meals.find((meal) => meal.slot === slot && meal.role !== 'skip');
                const weight = !m ? 'none' : m.role === 'destination_meal' || m.role === 'special_occasion' ? 'event' : 'fuel';
                return (
                  <div key={slot} className="min-w-0">
                    <p className="hv-meal" data-weight={weight}>
                      <span className="min-w-0">
                        <span className="sr-only">{slot}: </span>
                        <span className={cx(m ? 'text-ink' : 'text-ink-faint')}>{m ? MEAL_ROLE_LABELS[m.role] : '—'}</span>
                        {m?.venueName ? <span className="block text-ink-muted">{m.venueName}</span> : null}
                        {m && (m.reservation === 'required' || m.reservation === 'recommended') ? <span className="block text-[10.5px] font-medium uppercase tracking-[0.08em] text-amber">book</span> : null}
                      </span>
                    </p>
                  </div>
                );
              })}
              <div className={cx('hv-rhythm-extra min-w-0 text-sm', !hasExtra && 'hidden md:block')}>
                {extra.map((m) => (
                  <p key={m.slot} className="hv-meal" data-weight="fuel">
                    <span>
                      <span className="capitalize text-ink">{m.slot}</span> · <span className="text-ink-muted">{MEAL_ROLE_LABELS[m.role]}</span>
                      {m.venueName ? <span className="text-ink"> — {m.venueName}</span> : null}
                    </span>
                  </p>
                ))}
                {day.provisioning.length > 0 ? (
                  <ul className="space-y-0.5 text-[0.8125rem] text-ink-muted">
                    {day.provisioning.map((p) => (
                      <li key={p}>• {p}</li>
                    ))}
                  </ul>
                ) : null}
                {findFood ? <DiscoverButton tripId={tripId!} kind="food" near={nearDay(day.dayNumber)} label="Find somewhere for a meal near base" /> : null}
              </div>
            </li>
          );
        })}
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
/** A need's status in words, in a square mono box. */
export function StatusWord({ status, skipped = false }: { status: TravelIntelligence['bookings']['items'][number]['status']; skipped?: boolean }) {
  const tone = status === 'booked' ? 'booked' : status === 'soft_hold' ? 'held' : status === 'not_needed' ? 'quiet' : 'open';
  return (
    <span className="hv-status" data-tone={tone}>
      {status === 'booked' ? 'Booked' : status === 'soft_hold' ? 'Tentative' : status === 'not_needed' ? (skipped ? 'Skipped' : 'Not needed') : 'Need to book'}
    </span>
  );
}

export function BookingRow({ b, members, elevated = false, tripId, resolutions = [], tripStart, tripEnd, testId = 'hub-booking' }: { b: TravelIntelligence['bookings']['items'][number]; members?: readonly TravelIntelligence['bookings']['items'][number][]; elevated?: boolean; tripId?: string; resolutions?: readonly BookingResolution[]; tripStart?: string; tripEnd?: string; testId?: string }) {
  const skipped = isSkipped(b, resolutions);
  const note = skipNote(b, resolutions);
  const terms = [b.bookingWindow, b.onSaleDate ? `On sale ${b.onSaleDate}` : undefined, b.deadline ? `Deadline ${b.deadline}` : undefined, b.cancellation].filter((t): t is string => Boolean(t));
  return (
    <li className="hv-bk text-sm" data-elevated={elevated ? 'true' : 'false'} data-testid={testId} data-kind={b.kind} data-group={b.group ?? ''} data-status={b.status} data-booking-id={b.id}>
      {/* When it is for: the day as a figure, then the date and time the evidence carries. */}
      <p className="hv-bk-when">
        <b>{b.dayNumber ? `Day ${String(b.dayNumber).padStart(2, '0')}` : 'Whole trip'}</b>
        {[b.date ? humanDate(b.date) : undefined, b.timeLabel].filter(Boolean).join(' · ')}
      </p>
      <div className="col-span-2 min-w-0 sm:col-span-1">
      <p className={cx('hv-bk-title font-medium text-ink', members && 'font-display text-lg font-normal')}>{b.title}</p>
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
          <ul className="ruled mt-1 border-t border-rule">
            {members.map((m) => (
              <li key={m.id} className="py-2 text-sm" data-testid="hub-booking" data-kind={m.kind} data-status={m.status} data-booking-id={m.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-ink">{m.title}</span>
                  <span className="flex items-center gap-2">
                    {m.date ? <span className="type-figure text-xs text-ink-muted">{humanDate(m.date)}</span> : null}
                    <StatusWord status={m.status} skipped={isSkipped(m, resolutions)} />
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
      </div>
      <p className="row-start-1 col-start-2 self-start justify-self-end sm:col-start-3">
        <StatusWord status={b.status} skipped={skipped} />
      </p>
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
        <div className="mt-6">
          <BookingProgressLine intel={intel} variant="strip" />
        </div>
        <div className="mt-8 grid gap-y-8">
          {groups.map((name) => {
            const inGroup = [...(name === 'Stays' && group ? [group] : []), ...standalone.filter((b) => BOOKING_GROUP_OF[b.kind] === name)];
            if (inGroup.length === 0) return null;
            return (
              <div key={name} data-testid={`hub-bookings-group-${name.toLowerCase()}`}>
                <h3 className="flex items-baseline justify-between border-b border-ink pb-2 font-display text-lg text-ink">
                  {name} <span className="type-figure text-sm text-ink-muted">{String(inGroup.length).padStart(2, '0')}</span>
                </h3>
                <ul className="ruled">
                  {inGroup.map((b) => (
                    <BookingRow key={b.id} b={b} {...(b.memberIds ? { members } : {})} {...rowProps} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="mt-12 ruled-strong pt-5" data-testid="hub-booked">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="type-section text-ink">What you have booked</h3>
            {tripId ? <BookedItemForm tripId={tripId} startDate={itinerary.startDate} endDate={itinerary.endDate} /> : null}
          </div>
          <p className="mt-1 text-sm text-ink-muted">A booked fact is stronger than anything the plan proposed. Sidequest schedules around it and never moves it.</p>
          {booked.length === 0 ? (
            <p className="mt-3 text-sm text-ink-faint">Nothing yet.</p>
          ) : (
            <ul className="ruled mt-2">
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
    <section className="mt-16" aria-labelledby="book-first" data-testid="hub-book-first">
      <RailSection index="Arrange" title="Book first" headingId="book-first" count={open.length} blurb="What could break this trip if it is not arranged. Priorities come from dependency, fixed times and lead times, not invented scarcity.">
        <div className="pt-5">
          <BookingProgressLine intel={intel} variant="strip" />
        </div>
        {BOOKING_PRIORITIES.map((priority) => {
          const rows = open.filter((b) => b.priority === priority);
          if (rows.length === 0) return null;
          return (
            <div key={priority} className="mt-6" data-testid={`hub-bookings-${priority}`}>
              {priority === 'book_first' ? (
                /*
                  No blurb: the rail beside this already says what Book first
                  means. The other priorities are headed only by their own
                  title, so they keep theirs.
                */
                null
              ) : (
                <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule pb-2">
                  <h3 className="sheet-label text-ink">
                    {BOOKING_PRIORITY_COPY[priority].title} <span className="type-figure text-accent">{rows.length}</span>
                  </h3>
                  <p className="type-meta">{BOOKING_PRIORITY_COPY[priority].blurb}</p>
                </div>
              )}
              <ul className="ruled">
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
            <h3 className="sheet-label text-ink">Verify booking requirement</h3>
            <p className="mt-1 type-meta">The plan is not sure these need booking at all. Check, then book only if they do.</p>
            <ul className="ruled mt-2 text-sm">
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
      </RailSection>
    </section>
  );
}

export function BeforeYouGoSection({ intel, tripId, readinessProfile, checks, bookingsListedAbove = false }: { intel: TravelIntelligence; tripId?: string; readinessProfile: TravelReadinessProfile | null; checks: readonly string[]; /** True where Book first renders on this page with the actions that act on these needs. */ bookingsListedAbove?: boolean }) {
  const r = intel.readiness;
  const checked = new Set(checks);
  const phases = bookingsListedAbove
    ? intel.checklist.phases
        .map((phase) => ({ ...phase, items: phase.items.filter((item) => item.kind !== 'booking') }))
        .filter((phase) => phase.items.length > 0)
    : intel.checklist.phases;
  return (
    <section className="mt-16" aria-labelledby="before-you-go" data-testid="hub-before-you-go">
      <RailSection index="Documents · order" title="Before you go" headingId="before-you-go" quiet blurb={r.international === 'no' ? 'A domestic trip on what you told us. The practical layer still applies.' : r.international === 'yes' ? `An international trip. Sidequest names the questions and where the official answers live; it does not answer them from memory.` : 'Whether this trip crosses a border depends on your citizenship, which Sidequest never guesses.'}>
      {tripId ? (
        <div className="pt-5">
          <ReadinessProfileForm tripId={tripId} current={readinessProfile} drives={intel.destinationContext.drives} />
        </div>
      ) : null}
      {/*
        V11 §2 — THE ENTRIES ARE NOT LISTED AGAIN HERE.

        PRODUCTION UI V1 put the primary readiness entries in a two-column grid
        on this section, tiered primary/more. It was the second of three
        renderings of the same list on one page: the Preflight buckets above,
        this grid, and "In order" below, each carrying the entry's full body.

        Preflight owns the list now (see `PreflightView`), because it is the one
        that knows the traveller's ticks and the entry's state, and it gained
        the two things this grid had that it lacked — the entry's kind and state
        as addressable attributes, and the official links.

        What stays here is what is genuinely this section's own: the profile
        form, which is an input rather than a restatement, and the coverage note,
        which is a statement about the list as a whole rather than about any
        entry in it. The section anchors stay too — they are how the deep links
        in `HubShell` and the print packet find this part of the page.
      */}
      {READINESS_SECTIONS.map((section) => (r.entries.some((e) => READINESS_SECTION_OF[e.kind] === section) ? <span key={section} className="sr-only" data-testid={`hub-readiness-${section}`}>{READINESS_SECTION_LABELS[section]}</span> : null))}
      <p className="mt-4 type-meta">{r.coverageNote}</p>

      {/*
        V6 — this is Book first re-grouped with tick boxes, and the packet
        prints Book first. Kept in full on screen, where ticking things off is
        the point, and behind the appendix on paper, where it was a page and a
        third of the same items.
      */}
      {/*
        V11 §I — ONE NEED ONCE, FOR THE THIRD AND LAST PLACE IT WAS TWICE.

        V11 §3 fixed Preflight-against-Book-first and this component's own
        readiness grid. What it left is the one the comment above this section
        admits to in its own words — "this is Book first re-grouped with tick
        boxes" — rendered on Prepare **directly below Book first**, which carries
        the same needs with the three actions that act on them.

        The booking rows are therefore dropped here when Book first is on the
        same page, exactly as `PreflightView` drops them and for the same reason:
        the rendering that can be *pressed* wins. What stays is what genuinely
        has a sequence and is not a booking — the re-check, the packing, the
        offline copy — which is what gives this section a reason to exist at all.

        A prop rather than an assumption: a component that silently omits data
        because of what it guesses its neighbour is doing is worse than one that
        is told.
      */}
      {phases.length > 0 ? (
        <>
          <h3 className="mt-10 sheet-label text-ink" data-print="appendix">In order</h3>
          <p className="mt-1 type-small text-ink-muted" data-print="appendix">
            {bookingsListedAbove
              ? 'What waits for the week and the day before, once the booking above is done.'
              : 'What to do now, what to book first, and what waits for the month, the week and the day before.'}
          </p>
        </>
      ) : null}
      <div className="mt-4 grid gap-x-10 gap-y-8 md:grid-cols-2" data-testid="hub-checklist" data-print="appendix">
        {phases.map((phase, phaseIndex) => (
          <div key={phase.phase} className="min-w-0" data-testid={`hub-phase-${phase.phase}`}>
            <p className="flex items-baseline justify-between gap-2 border-b border-rule pb-1.5">
              <span className="sheet-label text-ink">{phase.title}</span>
              <span className="type-figure text-xs text-ink-faint">{String(phaseIndex + 1).padStart(2, '0')}</span>
            </p>
            <ul className="ruled mt-1">
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
      </RailSection>
    </section>
  );
}

export function PackSection({ intel, tripId, checks }: { intel: TravelIntelligence; tripId?: string; checks: readonly string[] }) {
  const checked = new Set(checks);
  const p = intel.packing;
  return (
    <section className="mt-16" aria-labelledby="pack" data-testid="hub-pack">
      <RailSection index="Bag" title="Pack" headingId="pack" count={p.items.length} quiet blurb={p.basisNote}>
      <div data-testid="packing-list">
      <div className="hv-pack mt-5 columns-1 gap-8 sm:columns-2 lg:columns-3" data-testid="hub-packing-list">
        {PACKING_CATEGORIES.map((category) => {
          const items = p.items.filter((i) => i.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} className="mb-7 break-inside-avoid">
              <p className="sheet-label flex justify-between border-b border-rule pb-1.5 text-ink">
                {PACKING_CATEGORY_LABELS[category]} <span className="type-figure text-ink-faint">{items.length}</span>
              </p>
              <ul className="ruled mt-1">
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
      </RailSection>
    </section>
  );
}

export function BudgetSection({ intel }: { intel: TravelIntelligence }) {
  const b = intel.budget;
  /* One scale for every range: the largest high figure among the lines. Party lines and per-person lines are labelled, never summed here. */
  const scale = Math.max(1, ...b.lines.map((l) => l.high));
  const pct = (n: number) => `${Math.round((n / scale) * 1000) / 10}%`;
  return (
    <section className="mt-14" aria-labelledby="budget" data-testid="hub-budget">
      <SectionHeader id="budget" title="Budget" blurb={b.precisionNote} />
      <div className="mt-6 grid gap-x-10 gap-y-6 border-t-[1.5px] border-ink pt-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <p className="min-w-0">
          <span className="sheet-label block text-ink-muted">Estimated total</span>
          <span className="mt-3 block font-display text-[clamp(2.25rem,1.6rem+2.4vw,3.5rem)] font-light leading-none tracking-[-0.03em] text-ink [font-variant-numeric:lining-nums_tabular-nums]">
            <span className="type-meta mr-2 align-top font-sans !text-ink-muted">{b.currency}</span>
            {b.total.low.toLocaleString()}–{b.total.high.toLocaleString()}
          </span>
          <span className="mt-2 block text-sm text-ink-muted">for {b.travellers} {b.travellers === 1 ? 'traveller' : 'travellers'} — a range, not a quote</span>
          {b.converted && b.displayCurrency ? (
            <span className="mt-1 block text-sm text-ink-muted" data-testid="hub-budget-local">
              ≈ {b.displayCurrency} {b.converted.low.toLocaleString()}–{b.converted.high.toLocaleString()} in local currency
            </span>
          ) : null}
        </p>
        <div className="min-w-0 self-end">
          {b.envelope ? (
            <p className={cx('text-sm', b.envelope.fit === 'over' ? 'text-clay' : b.envelope.fit === 'tight' ? 'text-amber' : b.envelope.fit === 'unknown' ? 'text-ink-muted' : 'text-pine')} data-testid="hub-budget-envelope">
              {b.envelope.fit === 'unknown'
                ? `Your ${b.envelope.currency ?? b.currency} ${b.envelope.amount.toLocaleString()} ${b.envelope.basis.replace(/_/g, ' ')} is not compared: no exchange rate was available to put it in ${b.currency}.`
                : `Against your ${b.envelope.currency ?? b.currency} ${b.envelope.amount.toLocaleString()} ${b.envelope.basis.replace(/_/g, ' ')}: ${b.envelope.fit}.`}
            </p>
          ) : null}
          {b.costIndex ? (
            <p className="mt-2 type-meta" data-testid="hub-budget-cost-index">{b.costIndex.note}</p>
          ) : null}
        </div>
      </div>
      {/*
        SURVEY ATLAS — A FIGURE TABLE, NEVER A SCORE.

        Each line keeps its own low and high and says whether it is per person or
        for the party; the bar draws that range on one scale shared by every
        line, so the reader sees where the money goes without a pie or a total
        being invented from figures that were never meant to add up.
      */}
      {b.lines.some((l) => l.perPerson) && b.lines.some((l) => !l.perPerson) ? (
        <p className="mt-8 flex flex-wrap items-center justify-end gap-x-5 gap-y-1 type-meta" aria-hidden="true">
          <span className="inline-flex items-center gap-2"><span className="hv-range inline-block w-8" data-basis="party"><i style={{ left: 0, width: '100%' }} /></span> for the party</span>
          <span className="inline-flex items-center gap-2"><span className="hv-range inline-block w-8" data-basis="pp"><i style={{ left: 0, width: '100%' }} /></span> per person</span>
        </p>
      ) : null}
      <dl className="ruled mt-3 border-t border-ink text-sm">
        {b.lines.map((line, index) => (
          <div key={`${line.category}-${index}`} className="hv-budget-row">
            <dt className="font-medium text-ink">{BUDGET_CATEGORY_LABELS[line.category]}</dt>
            <dd className="type-figure text-right text-ink md:col-start-3">
              {line.low.toLocaleString()}–{line.high.toLocaleString()} <span className="block font-sans text-xs font-normal text-ink-muted">{line.perPerson ? 'per person' : 'for the party'}</span>
            </dd>
            <dd aria-hidden="true" className="hv-range" data-basis={line.perPerson ? 'pp' : 'party'} style={{ ['--lo' as string]: pct(line.low), ['--hi' as string]: pct(line.high) }}>
              <i />
            </dd>
            <dd className="col-span-full type-meta">{line.basis}{line.excludes.length > 0 ? ` · excludes ${line.excludes.join(', ').toLowerCase()}` : ''}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-8 grid gap-x-10 gap-y-6 text-sm sm:grid-cols-2">
        <div className="border-t border-ink pt-3">
          <p className="sheet-label text-pine">Save here</p>
          <ul className="ruled mt-2 text-ink-muted">{b.strategy.saveHere.map((x) => <li key={x} className="py-2">{x}</li>)}</ul>
        </div>
        <div className="border-t border-ink pt-3">
          <p className="sheet-label text-accent-strong">Spend here</p>
          <ul className="ruled mt-2 text-ink-muted">{b.strategy.spendHere.map((x) => <li key={x} className="py-2">{x}</li>)}</ul>
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
      <SectionHeader id="verify" title="How solid this plan is" blurb="What Sidequest checked, what to look at again nearer the date, and what it is still working out." />
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
