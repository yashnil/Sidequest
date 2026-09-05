import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ItineraryView } from '@/components/ItineraryView';
import { EnvironmentPill } from '@/components/EnvironmentPill';
import { OfflineSnapshot } from '@/components/OfflineSnapshot';
import { resolveMapTileSource } from '@/components/map-adapter';
import { renderInstant } from '@/lib/clock';
import { isFixtureComposer } from '@/lib/providers/switches';
import { Panel, buttonClass } from '@/components/ui';
import { formatDateRange } from '@/lib/format';
import {
  getItinerary,
  getItineraryLocks,
  getSelections,
  getStaleItineraryDisplay,
  StaleItineraryError,
} from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { StaleItineraryView } from './StaleItineraryView';
import { itineraryViewModel } from './view-model';

export const dynamic = 'force-dynamic';

/**
 * Which trip this plan is for. See the discover route for why. Owner-gated like
 * the page, so a foreign tab cannot learn the destination from its own title.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return {
    title: trip
      ? `${trip.basics.destinationInput} — Your trip — Sidequest`
      : 'Your trip — Sidequest',
  };
}

export default async function ItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  /*
   * The owner's trip or nothing. A trip made in a different browser renders
   * exactly as a missing one: the read-only copy at /share/<token> is the one
   * unauthenticated view of a plan, and the address-bar URL must not be a
   * second, editable one. See `lib/net/trip-access`.
   */
  const trip = await ownedTrip(id);
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
  /**
   * A stale plan renders read-only rather than as a wall.
   *
   * The version gate still protects every *claim* this build makes — the
   * read-only view shows the saved days under a dated banner and asserts
   * nothing about weather, transport or validity — and it still protects every
   * write: a rebuild goes through the current schema as always. What it no
   * longer does is confiscate a trip the traveller already has. The previous
   * copy here was a paragraph of engineering changelog about opening-hours
   * checks and daylight computation; nobody planning a holiday needs it, and
   * it stood between them and their own itinerary.
   */
  let itinerary;
  try {
    itinerary = getItinerary(id);
  } catch (error) {
    if (error instanceof StaleItineraryError) {
      const display = getStaleItineraryDisplay(id);
      if (display && display.days.length > 0) {
        const includedCount = getSelections(id).filter(
          (selection) => selection.status !== 'excluded',
        ).length;
        return (
          <StaleItineraryView
            display={display}
            tripId={id}
            includedCount={includedCount}
            dateLabel={formatDateRange(trip.basics.startDate, trip.basics.endDate)}
          />
        );
      }
      return (
        <Recovery
          tripId={id}
          title="This plan was built by an earlier version of Sidequest"
          body="We could not recover enough of it to show you, so it needs one rebuild. Every choice you made on the board is kept — head back and press Rebuild."
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

  /*
   * Everything below the stored plan itself — the preparation list, the
   * photographs, the per-stop reasons, the ODbL notice — is derived in
   * `view-model.ts`, which the shared read-only copy at /share/<token> calls
   * too. One derivation, two pages, no drift.
   */
  const model = await itineraryViewModel(trip, itinerary);
  /*
   * DEV ONLY: when the composer is the offline fixture, say so on the page a
   * founder evaluates, so fixture output is never mistaken for the live model.
   * Never rendered in a production build.
   */
  const fixtureMode = process.env.NODE_ENV !== 'production' && isFixtureComposer();

  return (
    <>
      <EnvironmentPill />
      {fixtureMode ? (
        <p className="mx-auto max-w-4xl px-5 pt-4 sm:px-8">
          <span className="inline-flex items-center gap-2 rounded-md border border-dashed border-amber bg-amber-soft px-2.5 py-1 text-xs text-amber" data-testid="fixture-planning-badge">
            Fixture planning data — this plan was composed from a saved fixture, not the live model.
          </span>
        </p>
      ) : null}
    <ItineraryView
      tiles={resolveMapTileSource(process.env)}
      tripId={id}
      {...model}
      itinerary={model.appliedItinerary}
      lockedPlaceIds={getItineraryLocks(id).map((lock) => lock.placeId)}
      dateLabel={formatDateRange(trip.basics.startDate, trip.basics.endDate)}
      // Read once, on the server, so every day on the page judges the same
      // forecast against the same instant. See `lib/clock` for why this is a
      // function rather than an inline clock read.
      renderedAt={renderInstant()}
    />
    <p className="mx-auto max-w-4xl px-5 pb-8 sm:px-8">
      <OfflineSnapshot path={`/trips/${id}/itinerary`} />
    </p>
    </>
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
