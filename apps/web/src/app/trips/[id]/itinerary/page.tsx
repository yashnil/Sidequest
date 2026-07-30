import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ItineraryView } from '@/components/ItineraryView';
import { Panel, buttonClass } from '@/components/ui';
import { formatDateRange } from '@/lib/format';
import { getItinerary, getTrip } from '@/lib/db/repository';

export const dynamic = 'force-dynamic';

export default async function ItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) notFound();

  // A stored plan that no longer parses is a real possibility across schema
  // changes. Fail into a recoverable screen rather than a stack trace.
  let itinerary;
  try {
    itinerary = getItinerary(id);
  } catch (error) {
    console.error('Stored itinerary failed validation', error);
    return (
      <Recovery
        tripId={id}
        title="That saved plan is no longer readable"
        body="The stored itinerary does not match the current format, so we will not show you something we cannot trust. Rebuilding it from your board takes a moment and keeps all your selections."
      />
    );
  }

  if (!itinerary) {
    return (
      <Recovery
        tripId={id}
        title="No trip built yet"
        body="You have not built this trip yet. Head back to the board, confirm what you want, and press Build my trip."
      />
    );
  }

  return (
    <ItineraryView
      itinerary={itinerary}
      tripId={id}
      dateLabel={formatDateRange(trip.basics.startDate, trip.basics.endDate)}
    />
  );
}

function Recovery({ tripId, title, body }: { tripId: string; title: string; body: string }) {
  return (
    <div className="mx-auto max-w-xl px-5 py-20 sm:px-8">
      <Panel className="p-8">
        <h1 className="font-display text-2xl text-ink">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{body}</p>
        <Link href={`/trips/${tripId}/discover`} className={`${buttonClass('primary')} mt-6`}>
          Back to the Discovery Board
        </Link>
      </Panel>
    </div>
  );
}
