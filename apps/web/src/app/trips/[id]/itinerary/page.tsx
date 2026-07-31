import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ItineraryView } from '@/components/ItineraryView';
import { renderInstant } from '@/lib/clock';
import { Panel, buttonClass } from '@/components/ui';
import { formatDateRange } from '@/lib/format';
import { getItinerary, getTrip, StaleItineraryError } from '@/lib/db/repository';

export const dynamic = 'force-dynamic';

export default async function ItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) notFound();

  /**
   * A stored plan that no longer parses is a real possibility across schema
   * changes, and the two ways it happens deserve different sentences.
   *
   * A plan from an older version is not damaged — it was built against facts
   * or checks that have since changed, so it may state something that is no
   * longer true. Nothing re-validates a stored plan on the way out, so showing
   * it would put that on screen with the confidence of a fresh one. Rebuilding
   * is routine and keeps every selection. Anything else that fails to parse is
   * genuine corruption, and saying so plainly is better than implying a version
   * bump.
   */
  let itinerary;
  try {
    itinerary = getItinerary(id);
  } catch (error) {
    if (error instanceof StaleItineraryError) {
      return (
        <Recovery
          tripId={id}
          title="This plan is from an earlier version of Sidequest"
          body="Some of what it was built on has changed since — which opening hours we check, whether the weather and the daylight were worked out at all, or how a place is described — so parts of it could now be out of date, and we will not show you that as though it were current. Head back to the board and press Rebuild; every choice you made is still there."
        />
      );
    }
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
      // Read once, on the server, so every day on the page judges the same
      // forecast against the same instant. See `lib/clock` for why this is a
      // function rather than an inline clock read.
      renderedAt={renderInstant()}
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
