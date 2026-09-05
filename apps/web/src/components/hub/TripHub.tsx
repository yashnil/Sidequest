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
  type Itinerary,
  type ReadinessEntry,
  type TravelIntelligence,
  type TravelReadinessProfile,
} from '@sidequest/core';
import { Badge, Panel, cx, type BadgeTone } from '../ui';
import { Glyph } from '../interview/glyphs';
import { BookedItemForm, BookedItemRow, CheckBox, ReadinessProfileForm } from './HubForms';
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
              {section.id === 'book-first' && urgent > 0 ? <span className="numeral rounded-full bg-accent px-1.5 text-[10px] text-paper">{urgent}</span> : null}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SectionHeader({ id, title, blurb, testId }: { id: string; title: string; blurb: string; testId?: string }) {
  return (
    <div className="border-t-2 border-ink pt-5" id={id} {...(testId ? { 'data-testid': testId } : {})}>
      <h2 className="display-md text-ink">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">{blurb}</p>
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
    <div className="mt-6 rounded-[var(--radius-card)] border-l-4 border-clay bg-clay-soft p-4" data-testid="hub-urgent">
      <p className="label text-clay">Needs your attention</p>
      <ul className="mt-2 space-y-1 text-sm text-ink">
        {intel.unresolvedCriticals.slice(0, 5).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function OverviewSection({ intel }: { intel: TravelIntelligence }) {
  const ctx = intel.destinationContext;
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="hub-overview">
      <Fact label="Route" value={intel.lodging.bases.map((b) => b.name).join(' → ') || ctx.name} />
      <Fact label="Getting around" value={intel.transport.modeNote.split('.')[0]!.replace(/^This plan moves by /, '') || intel.transport.primaryMode} />
      <Fact label="Budget" value={`${intel.budget.currency} ${intel.budget.total.low.toLocaleString()}–${intel.budget.total.high.toLocaleString()} for the party`} />
      <Fact label="Trip in" value={ctx.daysUntilTrip > 0 ? `${ctx.daysUntilTrip} days` : ctx.daysUntilTrip === 0 ? 'Today' : 'Past'} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4">
      <p className="label text-ink-faint">{label}</p>
      <p className="mt-1 text-sm text-ink">{value}</p>
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
      <ol className="mt-5 grid gap-4 sm:grid-cols-2">
        {lodging.bases.map((base, index) => (
          <li key={base.baseId} className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4" data-testid="hub-base">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-display text-xl text-ink">
                <span className="numeral mr-2 text-sm text-accent">{String(index + 1).padStart(2, '0')}</span>
                {base.name}
              </p>
              <span className="numeral text-sm text-ink-muted">{base.nights} {base.nights === 1 ? 'night' : 'nights'}</span>
            </div>
            <p className="mt-1 text-sm text-ink-muted">{base.area !== base.name ? `${base.area} · ` : ''}{base.styleLabel} · {base.priceTier}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink">{base.why}</p>
            {base.booked ? (
              <p className="mt-2 text-sm text-accent-strong" data-testid="hub-base-booked">
                Booked: {base.booked.title}
              </p>
            ) : null}
            {base.advantages.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-xs leading-snug text-ink-muted">
                {base.advantages.map((a) => (
                  <li key={a}>+ {a}</li>
                ))}
              </ul>
            ) : null}
            {base.tradeoffs.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs leading-snug text-ink-muted">
                {base.tradeoffs.map((t) => (
                  <li key={t}>– {t}</li>
                ))}
              </ul>
            ) : null}
            {base.alternatives.length > 0 ? <p className="mt-2 text-xs text-ink-faint">Also worth a look: {base.alternatives.map((a) => a.name).join(', ')}.</p> : null}
            {tripId ? <DiscoverButton tripId={tripId} kind="stays" near={nearBase(base.baseId, base.name)} label="Find stays near this base" query={`hotel near ${base.area}`} /> : null}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">{lodging.shortlistBasis}</p>
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
          <h3 className="mt-6 font-display text-lg text-ink">The transfers that shape the days</h3>
          <ol className="mt-2 divide-y divide-rule" data-testid="hub-legs">
            {major.slice(0, 12).map((leg) => (
              <li key={leg.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm" data-testid="hub-leg" data-mode={leg.mode} data-basis={leg.durationBasis}>
                <span className="min-w-0 text-ink">
                  <span className="text-ink-faint">Day {leg.dayNumber} · </span>
                  {leg.originName} → {leg.destinationName}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge>{LEG_MODE_LABELS[leg.mode]}</Badge>
                  <span className="numeral text-xs text-ink-muted">{leg.durationMinutes === null ? 'not timed' : `${leg.durationMinutes} min`}</span>
                  <span className="text-xs text-ink-faint" title={DURATION_BASIS_LABELS[leg.durationBasis]}>
                    {leg.durationBasis === 'unmeasured' ? (leg.unmeasuredReason === 'mode_not_road_routable' ? 'plausible, not road-routed' : 'unmeasured') : leg.durationBasis.replace(/_/g, ' ')}
                    {leg.trafficState === 'live' ? ' · live traffic' : leg.trafficState === 'typical' ? ' · typical traffic' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {t.options.length > 0 ? (
        <details className="mt-4">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted hover:text-ink">Compare ways to make the big transfers</summary>
          <ul className="mt-2 divide-y divide-rule text-sm" data-testid="hub-options">
            {t.options.map((o) => (
              <li key={`${o.legId}:${o.mode}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span className="text-ink">
                  {o.legLabel} · <span className="font-medium">{LEG_MODE_LABELS[o.mode]}</span>
                  {o.recommended ? <Badge tone="pine">Recommended</Badge> : null}
                </span>
                <span className="text-xs text-ink-muted">
                  cost {o.costBand} · transfers {o.transferBurden} · scenic {o.scenic} · {o.durationMinutes === null ? 'not timed' : `${o.durationMinutes} min`}
                </span>
                <span className="basis-full text-xs text-ink-faint">{o.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">{t.modeNote}</p>
    </div>
  );
}

function TerminalCard({ title, edge, ok }: { title: string; edge: TravelIntelligence['transport']['terminal']['arrival']; ok: boolean }) {
  return (
    <div className={cx('rounded-[var(--radius-card)] border p-4', ok ? 'border-rule bg-paper-raised' : 'border-clay bg-clay-soft')} data-testid={`hub-terminal-${title.toLowerCase()}`}>
      <p className="label text-ink-faint">{title} · {edge.basis === 'booked' ? 'from your booking' : edge.basis === 'stated' ? 'from your trip setup' : edge.basis === 'band' ? 'a band, not a time' : 'time unknown'}</p>
      <p className="mt-1 text-sm text-ink">{edge.note}</p>
      <ul className="mt-2 space-y-0.5 text-xs text-ink-muted">
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
        {f.days.map((day) => (
          <li key={day.dayNumber} className={cx('rounded-[var(--radius-card)] border p-3', day.remote ? 'border-amber bg-amber-soft/40' : 'border-rule bg-paper-raised')} data-testid="hub-food-day" data-remote={day.remote}>
            <p className="font-display text-base text-ink">
              Day {day.dayNumber}
              {day.remote ? <span className="ml-2 font-sans text-xs text-amber">remote</span> : null}
              {f.specialOccasionDay === day.dayNumber ? <span className="ml-2 font-sans text-xs text-accent-strong">the special one</span> : null}
            </p>
            <ul className="mt-2 space-y-1 text-xs">
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
              <ul className="mt-2 space-y-0.5 text-xs text-ink-muted">
                {day.provisioning.map((p) => (
                  <li key={p}>• {p}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">{f.venueDataNote}</p>
    </div>
  );
}

export function BookFirstSection({ intel, tripId, booked, itinerary, honored, conflicts }: { intel: TravelIntelligence; tripId?: string; booked: readonly BookedPlanItem[]; itinerary: Itinerary; honored: readonly string[]; conflicts: readonly string[] }) {
  const open = intel.bookings.items.filter((b) => b.status === 'open');
  const done = intel.bookings.items.filter((b) => b.status !== 'open');
  return (
    <section className="mt-14" aria-labelledby="book-first" data-testid="hub-book-first">
      <SectionHeader id="book-first" title="Book first" blurb="What this trip depends on somebody arranging, in the order it matters. Priorities come from dependency, fixed times and lead times, not invented scarcity." />
      {BOOKING_PRIORITIES.map((priority) => {
        const items = open.filter((b) => b.priority === priority);
        if (items.length === 0) return null;
        return (
          <div key={priority} className="mt-5" data-testid={`hub-bookings-${priority}`}>
            <h3 className="font-display text-lg text-ink">
              {BOOKING_PRIORITY_COPY[priority].title} <span className="numeral text-sm text-accent">{items.length}</span>
            </h3>
            <p className="text-xs text-ink-muted">{BOOKING_PRIORITY_COPY[priority].blurb}</p>
            <ul className="mt-2 divide-y divide-rule">
              {items.map((b) => (
                <li key={b.id} className="py-2.5 text-sm" data-testid="hub-booking" data-kind={b.kind}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-ink">{b.title}</span>
                    <span className="text-xs text-ink-faint">
                      {b.date ?? ''}
                      {b.timeLabel ? ` · ${b.timeLabel}` : ''}
                      {b.necessity === 'required' ? ' · required' : b.necessity === 'strongly_recommended' ? ' · recommended' : ''}
                    </span>
                  </div>
                  <p className="text-xs leading-snug text-ink-muted">{b.reason}</p>
                  {b.officialSourceUrl ? (
                    <a href={b.officialSourceUrl} target="_blank" rel="noreferrer noopener" className="text-xs text-accent underline underline-offset-4">
                      {b.officialSourceName ?? 'Official page'}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {open.length === 0 ? <p className="mt-4 text-sm text-ink-muted">Nothing left to arrange from what Sidequest can see.</p> : null}

      <div className="mt-8 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4" data-testid="hub-booked">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="font-display text-lg text-ink">What you have booked</h3>
          {tripId ? <BookedItemForm tripId={tripId} startDate={itinerary.startDate} endDate={itinerary.endDate} /> : null}
        </div>
        <p className="mt-1 text-xs text-ink-muted">A booked fact is stronger than anything the plan proposed. Sidequest schedules around it and never moves it.</p>
        {booked.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">Nothing yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-rule">
            {booked.map((item) => (tripId ? <BookedItemRow key={item.id} tripId={tripId} item={item} /> : <li key={item.id} className="py-2 text-sm text-ink">{item.title}</li>))}
          </ul>
        )}
        {honored.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs text-pine" data-testid="hub-booked-honored">
            {honored.map((h) => (
              <li key={h}>✓ {h}</li>
            ))}
          </ul>
        ) : null}
        {conflicts.length > 0 ? (
          <ul className="mt-3 space-y-1 rounded-[var(--radius-card)] bg-clay-soft p-3 text-xs text-ink" data-testid="hub-booked-conflicts">
            {conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}
        {done.length > 0 ? <p className="mt-3 text-xs text-ink-faint">{done.length} of the things this trip depends on {done.length === 1 ? 'is' : 'are'} already covered by your bookings.</p> : null}
      </div>
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
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        {READINESS_SECTIONS.map((section) => {
          const entries = r.entries.filter((e) => READINESS_SECTION_OF[e.kind] === section);
          if (entries.length === 0) return null;
          return (
            <div key={section} data-testid={`hub-readiness-${section}`}>
              <h3 className="font-display text-lg text-ink">{READINESS_SECTION_LABELS[section]}</h3>
              <ul className="mt-2 divide-y divide-rule">
                {entries.map((e) => (
                  <li key={e.kind} className="py-2.5" data-testid="hub-readiness-entry" data-kind={e.kind} data-state={e.state}>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium text-ink">{e.title}</span>
                      <Badge tone={STATE_TONE[e.state]}>{STATE_WORD[e.state]}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs leading-snug text-ink-muted">{e.summary}</p>
                    {e.links.length > 0 ? (
                      <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                        {e.links.map((l) => (
                          <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">
                            {l.name}
                          </a>
                        ))}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">{r.coverageNote}</p>

      <h3 className="mt-8 font-display text-lg text-ink">In order</h3>
      <div className="mt-2 grid gap-5 md:grid-cols-2" data-testid="hub-checklist">
        {intel.checklist.phases.map((phase) => (
          <div key={phase.phase} className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4" data-testid={`hub-phase-${phase.phase}`}>
            <p className="label text-accent">{phase.title}</p>
            <ul className="mt-2">
              {phase.items.map((item) => (
                <li key={item.id}>
                  <CheckBox tripId={tripId} list="checklist" itemId={item.id} checked={checked.has(item.id)} label={item.blocking ? `${item.title} — blocking` : item.title} hint={item.sourceUrl ? `${item.why} (${item.sourceName})` : item.why} />
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
                  <p className="label text-ink-faint">{bucket === 'official' ? 'Official' : bucket === 'practical' ? 'Practical' : 'Unknown'}</p>
                  <ul className="mt-1 space-y-1.5 text-xs text-ink-muted">
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
      <div className="mt-5 columns-1 gap-6 sm:columns-2 lg:columns-3" data-testid="hub-packing-list">
        {PACKING_CATEGORIES.map((category) => {
          const items = p.items.filter((i) => i.category === category);
          if (items.length === 0) return null;
          return (
            <div key={category} className="mb-6 break-inside-avoid">
              <p className="label text-ink-faint">{PACKING_CATEGORY_LABELS[category]}</p>
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
      {p.modelSuggestions.length > 0 ? <p className="mt-2 text-xs text-ink-faint">Also suggested for this trip: {p.modelSuggestions.join(', ')}.</p> : null}
    </section>
  );
}

export function BudgetSection({ intel }: { intel: TravelIntelligence }) {
  const b = intel.budget;
  return (
    <section className="mt-14" aria-labelledby="budget" data-testid="hub-budget">
      <SectionHeader id="budget" title="Budget" blurb={b.precisionNote} />
      <p className="mt-4 font-display text-2xl text-ink">
        {b.currency} {b.total.low.toLocaleString()}–{b.total.high.toLocaleString()} <span className="font-sans text-sm text-ink-muted">for {b.travellers} {b.travellers === 1 ? 'traveller' : 'travellers'}, estimated</span>
      </p>
      {b.envelope ? (
        <p className={cx('mt-1 text-sm', b.envelope.fit === 'over' ? 'text-clay' : b.envelope.fit === 'tight' ? 'text-amber' : 'text-pine')} data-testid="hub-budget-envelope">
          Against your {b.currency} {b.envelope.amount.toLocaleString()} {b.envelope.basis.replace(/_/g, ' ')}: {b.envelope.fit}.
        </p>
      ) : null}
      <dl className="mt-4 divide-y divide-rule text-sm">
        {b.lines.map((line) => (
          <div key={line.category} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
            <dt className="text-ink">{BUDGET_CATEGORY_LABELS[line.category]}</dt>
            <dd className="numeral text-ink">
              {line.low.toLocaleString()}–{line.high.toLocaleString()} <span className="text-xs text-ink-faint">{line.perPerson ? 'per person' : 'for the party'}</span>
            </dd>
            <dd className="basis-full text-xs text-ink-faint">{line.basis}{line.excludes.length > 0 ? ` · excludes ${line.excludes.join(', ').toLowerCase()}` : ''}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 text-sm">
        <div>
          <p className="label text-ink-faint">Save here</p>
          <ul className="mt-1 space-y-0.5 text-ink-muted">{b.strategy.saveHere.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
        <div>
          <p className="label text-ink-faint">Spend here</p>
          <ul className="mt-1 space-y-0.5 text-ink-muted">{b.strategy.spendHere.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      </div>
      {b.booked.length > 0 ? (
        <p className="mt-4 text-sm text-ink" data-testid="hub-budget-booked">
          Booked so far: {b.booked.map((x) => `${x.title} ${x.currency} ${x.amount.toLocaleString()}`).join(' · ')}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-faint">{b.conversionNote}</p>
    </section>
  );
}

export function BackupsSection({ intel }: { intel: TravelIntelligence }) {
  return (
    <div className="mt-6" data-testid="hub-backups">
      <ol className="grid gap-3 sm:grid-cols-2">
        {intel.backups.map((day) => (
          <li key={day.dayNumber} className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-3 text-sm" data-testid="hub-backup-day">
            <p className="font-display text-base text-ink">Day {day.dayNumber} · {day.planA}</p>
            {day.fallback ? (
              <p className="mt-1 text-xs text-ink-muted">
                <span className="text-ink">If {day.fallback.trigger.toLowerCase()}:</span> {day.fallback.name}
                {day.fallback.verified ? '' : ' (proposed, not verified)'}
              </p>
            ) : (
              <p className="mt-1 text-xs text-ink-faint">No fallback on record; the flex stops below are the slack.</p>
            )}
            {day.flexItems.length > 0 ? <p className="mt-1 text-xs text-ink-muted">Can move or go: {day.flexItems.join(', ')}</p> : null}
            {day.triggers.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-faint">
                {day.triggers.slice(0, 3).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : null}
            {day.decisionPoint ? <p className="mt-1 text-xs text-accent-strong">{day.decisionPoint}</p> : null}
          </li>
        ))}
      </ol>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm" data-testid="hub-regret">
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
              <p className="label text-ink-faint">{title}</p>
              <ul className="mt-1 space-y-1">
                {list.map((entry, index) => (
                  <li key={`${entry.name}:${index}`} className="text-ink">
                    {entry.name}
                    <span className="block text-xs text-ink-muted">{entry.why}</span>
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

export function VerifySection({ intel, manifest }: { intel: TravelIntelligence; manifest?: RecheckManifest | null }) {
  const recheck = new Set(intel.freshness.recheckBeforeDeparture);
  const material = intel.sourceRegistry.filter((c) => c.state !== 'not_applicable' && (c.state !== 'confirmed' || recheck.has(c.id)) && c.kind !== 'place_identity' && c.kind !== 'routing_duration');
  const access = intel.access.filter((a) => a.verifyBeforeTravel);
  return (
    <section className="mt-14" aria-labelledby="verify" data-testid="hub-verify">
      <SectionHeader id="verify" title="Verify" blurb={intel.freshness.note} />
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
                <span className="text-xs text-ink-muted">{item.automatable ? 'Sidequest can re-read this' : 'Read the official source yourself'}</span>
                <span className="basis-full text-xs text-ink-faint">{item.why}</span>
                {item.sourceUrl ? (
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" className="basis-full text-xs text-accent underline underline-offset-4">
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
                <span className="text-xs text-ink-muted">{ACCESS_STATE_LABELS[a.state]}</span>
                {a.attribution ? (
                  <span className="basis-full text-xs text-ink-faint" data-testid="hub-access-attribution">
                    {a.note} {a.attribution}{a.checkedAt ? ` · read ${a.checkedAt.slice(0, 10)}` : ''}
                  </span>
                ) : null}
                {a.sourceUrl ? (
                  <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener" className="basis-full text-xs text-accent underline underline-offset-4">
                    {a.sourceName ?? 'Source'}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <details className="mt-6" data-testid="hub-sources">
        <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted hover:text-ink">Every fact behind this plan, with its source and how fresh it is ({intel.sourceRegistry.length})</summary>
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
    <Panel className="mt-8 p-5" as="section" testId="hub-critique">
      <p className="label text-accent">Your plan, checked</p>
      <h2 className="mt-1 font-display text-2xl text-ink">{c.headline}</h2>
      <ul className="mt-4 divide-y divide-rule">
        {c.findings.map((f) => (
          <li key={`${f.topic}:${f.title}`} className="py-2.5 text-sm" data-testid="hub-critique-finding" data-severity={f.severity} data-topic={f.topic}>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className={cx('h-2 w-2 shrink-0 rounded-full', f.severity === 'concern' ? 'bg-clay' : f.severity === 'note' ? 'bg-amber' : 'bg-pine')} aria-hidden="true" />
              <span className="text-ink">{f.title}</span>
              <span className="sr-only">{f.severity}</span>
            </p>
            <p className="mt-0.5 pl-4 text-xs leading-snug text-ink-muted">{f.detail}</p>
            {f.suggestion ? <p className="mt-0.5 pl-4 text-xs text-accent-strong">{f.suggestion}</p> : null}
          </li>
        ))}
      </ul>
      {c.userPlaces.length > 0 ? (
        <div className="mt-4 text-sm" data-testid="hub-critique-places">
          <p className="label text-ink-faint">Your places</p>
          <ul className="mt-1 space-y-1">
            {c.userPlaces.map((p, index) => (
              <li key={`${p.name}:${index}`} className="text-ink" data-outcome={p.outcome}>
                <Badge tone={p.outcome === 'kept' ? 'pine' : p.outcome === 'moved' ? 'blue' : 'clay'}>{p.outcome.replace('_', ' ')}</Badge> {p.name}
                <span className="block text-xs text-ink-muted">{p.detail}</span>
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
                <p className="label text-ink-faint">{title}</p>
                <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
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
export function TodaySection({ today, minuteLabel }: { today: TodayView; minuteLabel: (minute: number) => string }) {
  if (!today.active) return null;
  return (
    <section className="mt-6 rounded-[var(--radius-card)] border border-pine bg-pine-soft/40 p-5" aria-labelledby="today" data-testid="hub-today">
      <p className="label text-pine">Today · day {today.dayNumber}{today.baseName ? ` · based in ${today.baseName}` : ''}</p>
      <h2 id="today" className="mt-1 font-display text-2xl text-ink">
        {today.theme ?? 'Today'}
      </h2>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">Now</dt>
          <dd className="text-ink" data-testid="today-now">{today.current ? `${today.current.title} · until ${minuteLabel(today.current.endMinute)}` : 'Nothing scheduled right now.'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">Next</dt>
          <dd className="text-ink" data-testid="today-next">{today.next ? `${today.next.title} · ${minuteLabel(today.next.startMinute)}` : 'Nothing more today.'}</dd>
        </div>
        {today.nextTransport ? (
          <div>
            <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">Next leg</dt>
            <dd className="text-ink" data-testid="today-leg">
              {today.nextTransport.title} · {today.nextTransport.minutes !== null ? `${today.nextTransport.minutes} min` : 'not measured'} <span className="text-ink-faint">({today.nextTransport.basis.replace(/_/g, ' ')})</span>
            </dd>
          </div>
        ) : null}
        {today.weather ? (
          <div>
            <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">Weather</dt>
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
      {today.flexAlternatives.length > 0 ? <p className="mt-1 text-xs text-ink-faint">Flexible: {today.flexAlternatives.join(' · ')}</p> : null}
      <ol className="mt-4 flex flex-wrap gap-2 text-xs" data-testid="today-stops">
        {today.stops.map((stop) => (
          <li key={stop.id} className={cx('rounded-full border px-2.5 py-1', stop.done ? 'border-rule text-ink-faint line-through' : 'border-pine text-ink')}>
            {minuteLabel(stop.startMinute)} {stop.title}
          </li>
        ))}
      </ol>
    </section>
  );
}
