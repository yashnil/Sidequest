import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ItineraryView } from '@/components/ItineraryView';
import { resolveMapBasemap } from '@/components/map-adapter';
import { Panel } from '@/components/ui';
import { renderInstant } from '@/lib/clock';
import { formatDateRange } from '@/lib/format';
import { getItinerary, StaleItineraryError, tripForShareToken } from '@/lib/db/repository';
import { itineraryViewModel } from '@/app/(product)/trips/[id]/itinerary/view-model';

export const dynamic = 'force-dynamic';

/**
 * THE SHARED COPY OF A FINISHED PLAN — TOKEN IN, DOCUMENT OUT, NOTHING ELSE.
 *
 * This route holds the whole of the share model, so its refusals are the
 * feature:
 *
 * - **The token is the only key.** `tripForShareToken` answers to exact token
 *   match and nothing else — a trip id pasted into this URL resolves to
 *   nothing, so ids stay unenumerable and unshared trips stay unreadable.
 * - **An invalid token is a plain 404.** The root not-found says "nothing
 *   here" and names no trip, so a probe learns nothing — not even whether it
 *   was close.
 * - **No cookie is read and none is set.** The reader needs no session, and a
 *   page that is about to show someone else's plan should not be minting
 *   identities for whoever opens it.
 * - **The owner's key never reaches the document.** `ItineraryView` without a
 *   `tripId` renders no edit menus, no board or questionnaire links, no
 *   calendar export and no share control — the id is simply not in the bytes,
 *   which is a stronger statement than hiding buttons. Print keeps working;
 *   paper is the point of a finished plan.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const trip = tripForShareToken(token);
  return {
    title: trip
      ? `${trip.basics.destinationInput} — A shared trip — Sidequest`
      : 'A shared trip — Sidequest',
  };
}

export default async function SharedTripPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const trip = tripForShareToken(token);
  if (!trip) notFound();

  /*
   * A link can outlive what it points at: the plan may be rebuilt under a
   * newer schema, or not built yet at all. The reader gets a sentence rather
   * than a wall — and no controls, because none of the ways to fix it are
   * theirs to press.
   */
  let itinerary;
  try {
    itinerary = getItinerary(trip.id);
  } catch (error) {
    if (!(error instanceof StaleItineraryError)) {
      console.error('Shared itinerary failed validation', error);
    }
    itinerary = null;
  }

  if (!itinerary) {
    return (
      <div className="mx-auto max-w-xl px-5 py-20 sm:px-8">
        <Panel className="p-8">
          <h1 className="font-display text-2xl text-ink">This plan is not ready to read</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            The link works, but the trip behind it has no finished plan right now. Ask whoever
            sent it to open their trip and build it again — this page will show it the moment it
            exists.
          </p>
        </Panel>
      </div>
    );
  }

  const model = await itineraryViewModel(trip, itinerary);

  return (
    <ItineraryView
      tiles={resolveMapBasemap(process.env)}
      {...model}
      itinerary={model.appliedItinerary}
      dateLabel={formatDateRange(trip.basics.startDate, trip.basics.endDate)}
      // Read once, on the server, so every day on the page judges the same
      // forecast against the same instant. See `lib/clock`.
      renderedAt={renderInstant()}
    />
  );
}
