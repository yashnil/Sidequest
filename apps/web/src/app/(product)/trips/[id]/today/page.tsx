import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel, buttonClass } from '@/components/ui';
import { getItinerary, StaleItineraryError } from '@/lib/db/repository';
import { getTripDraft } from '@/lib/db/draft-repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { undoTarget } from '@/lib/refine/version-repository';
import { AskSidequestMount } from '../itinerary/ask-sidequest-mount';
import { TodayScreen } from './TodayScreen';
import { todayViewModel } from './today-view-model';

export const dynamic = 'force-dynamic';

/**
 * V9 §8 — `/trips/[id]/today`.
 *
 * Owner-gated exactly as the itinerary is: a trip made elsewhere renders as a
 * missing one. Render-pure: the same view model as the hub, read on the
 * trip's local clock, and nothing fetched. Outside the trip's dates the page
 * says so with the first day's date and a way back — a 404 would be a lie
 * about a trip that exists. Ask Sidequest is mounted so "Change today" has
 * somewhere to open.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return { title: trip ? `${trip.basics.destinationInput} — Today — Sidequest` : 'Today — Sidequest' };
}

export default async function TodayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();

  let itinerary;
  try {
    itinerary = getItinerary(id);
  } catch (error) {
    if (!(error instanceof StaleItineraryError)) console.error('Stored itinerary failed validation', error);
    itinerary = null;
  }
  if (!itinerary) {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <Panel className="p-6">
          <h1 className="font-display text-2xl text-ink">No plan to read today</h1>
          <p className="mt-3 type-small text-ink-muted">Today reads the finished plan. Build the trip, then come back here on the day.</p>
          <Link href={`/trips/${id}/itinerary`} className={`${buttonClass('primary')} mt-6`} data-testid="today-back">
            Back to trip
          </Link>
        </Panel>
      </div>
    );
  }

  const model = await todayViewModel(trip, itinerary);
  return (
    <>
      <TodayScreen tripId={id} destination={model.destination} today={model.today} firstDate={model.firstDate} lastDate={model.lastDate} dayCount={model.dayCount} timeZone={model.timeZone} state={model.state} directions={model.directions} reservation={model.reservation} changed={model.changed} />
      <AskSidequestMount tripId={id} ready={Boolean(getTripDraft(id))} canUndo={undoTarget(id) !== null} dayCount={model.dayCount} />
    </>
  );
}
