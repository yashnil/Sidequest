import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { QuickPlanButton } from '@/components/QuickPlanButton';
import { buttonClass } from '@/components/ui';
import { hasItinerary } from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return { title: trip ? `${trip.basics.destinationInput} — Quick plan — Sidequest` : 'Quick plan — Sidequest' };
}

/**
 * THE FIRST PLAN, BEFORE THE QUESTIONNAIRE OR THE DISCOVERY BOARD.
 *
 * "Plan me a trip. Plan what you think is right for me" produces a complete
 * itinerary from destination, dates and travellers alone — through the same
 * canonical generation path as "Build my trip", not a separate pipeline —
 * and lands on the same itinerary page. The questionnaire and the Discovery
 * Board remain available as optional tuning afterwards.
 */
export default async function QuickPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();
  const planned = hasItinerary(id);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <p className="text-xs uppercase tracking-[0.12em] text-ink-faint">Quick plan</p>
      <h1 className="font-display text-2xl text-ink">{trip.basics.destinationInput}</h1>
      <p className="mt-2 measure text-sm leading-relaxed text-ink-muted">
        A complete first trip, composed in one pass from what you have told us so far, then checked
        against measured routes and whatever else we can verify. The questionnaire and the Discovery
        Board are still there if you want to tune it afterwards.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <QuickPlanButton tripId={id} hasPlan={planned} />
        {planned ? (
          <Link href={`/trips/${id}/itinerary`} className={buttonClass('secondary')}>
            Open your trip
          </Link>
        ) : null}
      </div>
    </div>
  );
}
