import { shortDate } from '../plan-format';
import type { ReactNode } from 'react';
import { TRANSPORT_MODE_LABELS, buildBookingProgress, type BookedPlanItem, type BookingResolution, type Itinerary, type TravelIntelligence } from '@sidequest/core';
import { PlanSubnav } from '../PlanSubnav';
import { BookFirstSection, BudgetSection, FoodSection, StaysSection, TransportSection } from '../TripHub';
import { ViewHead } from './ViewHead';
import { formatMoney } from '../booking-copy';

/**
 * PLAN — THE TRIP'S DECISIONS, IN THE ORDER THEY ARE MADE.
 *
 * Where you sleep, how you move between those places, what you eat across the
 * days, what it costs, and what has to be arranged. The section index is the
 * view's figure table: each tab carries the one figure that section is about
 * (nights and bases, the main mode and how many legs shape the days, the days
 * with meals, the estimated range, how much is arranged), so the index reads as
 * a summary before anything is pressed.
 *
 * The figures are derived from the same intelligence the panels render; a
 * section with nothing behind it shows no figure rather than a zero.
 */
export interface PlanViewProps {
  intel: TravelIntelligence | null;
  tripId?: string;
  itinerary: Itinerary;
  coordinates: Record<string, { lat: number; lng: number }>;
  booked: readonly BookedPlanItem[];
  honored: readonly string[];
  conflicts: readonly string[];
  resolutions: readonly BookingResolution[];
  bookSoonCount: number;
  /** The pre-intelligence lodging areas, rendered by the itinerary itself. */
  legacyStays?: ReactNode;
  /** The trip's transport position (`TransportPlan`), rendered by the itinerary. */
  transportPlan: ReactNode;
  /** The eating panel (`FoodPlanPanel`), rendered by the itinerary. */
  foodPlan: ReactNode;
}

export function planSummaries(intel: TravelIntelligence | null, itinerary: Itinerary): Partial<Record<'stays' | 'transport' | 'food' | 'budget' | 'bookings', string>> {
  const out: Partial<Record<'stays' | 'transport' | 'food' | 'budget' | 'bookings', string>> = {};
  const nights = intel ? intel.lodging.bases.reduce((n, b) => n + b.nights, 0) : 0;
  const bases = intel?.lodging.bases.length ?? 0;
  if (bases > 0) out.stays = `${nights} ${nights === 1 ? 'night' : 'nights'} · ${bases} ${bases === 1 ? 'base' : 'bases'}`;
  const legs = intel ? intel.transport.legs.filter((l) => l.role !== 'terminal').length : 0;
  out.transport = `${TRANSPORT_MODE_LABELS[itinerary.transportStrategy.primaryMode]}${legs > 0 ? ` · ${legs} ${legs === 1 ? 'leg' : 'legs'}` : ''}`;
  const foodDays = intel ? intel.food.days.filter((d) => d.meals.some((m) => m.role !== 'skip')).length : 0;
  if (foodDays > 0) out.food = `${foodDays} ${foodDays === 1 ? 'day' : 'days'} of meals`;
  if (intel && intel.budget.total.high > 0) out.budget = `${formatMoney(intel.budget.total.low, intel.budget.currency)}–${formatMoney(intel.budget.total.high, intel.budget.currency)}`;
  if (intel) {
    const progress = buildBookingProgress(intel.bookings.items);
    if (progress.critical > 0) out.bookings = `${progress.arranged} of ${progress.critical} arranged`;
  }
  return out;
}

export function PlanView({ intel, tripId, itinerary, coordinates, booked, honored, conflicts, resolutions, bookSoonCount, legacyStays, transportPlan, foodPlan }: PlanViewProps) {
  const days = itinerary.days.length;
  return (
    <div className="mx-auto max-w-6xl">
      <ViewHead sheet={`Sheet P · ${days} ${days === 1 ? 'day' : 'days'} · ${shortDate(itinerary.startDate)} → ${shortDate(itinerary.endDate)}`} title="Plan" lede="Where you sleep, how you get around, what you eat and what it costs." />
      <div className="mt-8">
        <PlanSubnav
          initial="stays"
          summaries={planSummaries(intel, itinerary)}
          badges={{ ...(bookSoonCount > 0 ? { bookings: bookSoonCount } : {}) }}
          panels={{
            stays: (
              <div className="[&>section:first-child]:mt-10">
                {intel ? <StaysSection intel={intel} {...(tripId ? { tripId } : {})} itinerary={itinerary} coordinates={coordinates} /> : null}
                {legacyStays}
              </div>
            ),
            transport: (
              <section className="mt-10 scroll-mt-[calc(var(--chrome-height)+4.5rem)]" id="getting-around" data-testid="hub-getting-around">
                {transportPlan}
                {intel ? <TransportSection intel={intel} /> : null}
              </section>
            ),
            food: (
              <section className="mt-10 scroll-mt-[calc(var(--chrome-height)+4.5rem)]" id="food" data-testid="hub-food-section">
                {foodPlan}
                {intel ? <FoodSection intel={intel} {...(tripId ? { tripId } : {})} itinerary={itinerary} coordinates={coordinates} /> : null}
              </section>
            ),
            budget: intel ? <BudgetSection intel={intel} /> : <p className="mt-10 type-small text-ink-muted">No budget was estimated for this plan.</p>,
            bookings: intel ? (
              <div>
                {/* V9 — arranging the trip lives on Book; this panel keeps the by-kind reading and points there. */}
                <p className="mt-10 type-small text-ink-muted">
                  Everything to arrange, with what is booked and what it cost, is on{' '}
                  <a href="#book" className="text-accent-strong underline underline-offset-4" data-testid="plan-bookings-to-book">
                    Book
                  </a>
                  .
                </p>
                <BookFirstSection intel={intel} {...(tripId ? { tripId } : {})} booked={booked} itinerary={itinerary} honored={honored} conflicts={conflicts} resolutions={resolutions} view="bookings" />
              </div>
            ) : (
              <p className="mt-10 type-small text-ink-muted">Nothing to book was identified for this plan.</p>
            ),
          }}
        />
      </div>
    </div>
  );
}
