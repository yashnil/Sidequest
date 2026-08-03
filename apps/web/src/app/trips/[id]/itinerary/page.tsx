import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ItineraryView } from '@/components/ItineraryView';
import { renderInstant } from '@/lib/clock';
import { Panel, buttonClass } from '@/components/ui';
import { formatDateRange } from '@/lib/format';
import { getItinerary, getTrip, StaleItineraryError } from '@/lib/db/repository';
import {
  buildPreparation,
  findOperatingCalendar,
  type DisplayName,
  type PreparationItem,
} from '@sidequest/core';
import { resolveTripRegion } from '@/lib/region';

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
          body="Some of what it was built on has changed since — which opening hours we check, whether the weather and the daylight were worked out at all, whether the meals name anywhere or are simply gaps in the day, or how a place is described — so parts of it could now be out of date, and we will not show you that as though it were current. Head back to the board and press Rebuild; every choice you made is still there."
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

  /**
   * The preparation list, derived on the server from the plan that is on screen.
   *
   * Resolving the region again is cheap — it reads the stored artifact — and it
   * is what ties a checklist to the exact evidence the plan was built from
   * rather than to whatever the region looks like today. A region that will not
   * resolve simply produces no checklist, which is the honest outcome and never
   * a reason to withhold the itinerary.
   */
  let preparation: PreparationItem[] = [];
  /*
   * The base's resolved name, read from the compiled region rather than stored
   * on the itinerary. A stored plan is immutable; migrating one to change how a
   * heading reads would be rewriting somebody's trip to fix a presentation bug.
   * An old region with no resolved name leaves this undefined and the view falls
   * back to the itinerary's own `baseName`, exactly as before.
   */
  let baseNames: DisplayName | undefined;
  try {
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      baseNames = resolved.context.compiled.bases.find(
        (base) => base.id === itinerary.baseId,
      )?.names;
      const scheduled = new Set<string>();
      const namesById = new Map<string, string>();
      const unverifiedHours: string[] = [];

      for (const place of resolved.context.places) namesById.set(place.id, place.name);
      for (const venue of resolved.context.food?.venues ?? []) namesById.set(venue.id, venue.name);

      for (const day of itinerary.days) {
        for (const item of day.items) {
          if (item.placeId) scheduled.add(item.placeId);
          if (item.food?.venueId) scheduled.add(item.food.venueId);
        }
      }
      for (const subjectId of scheduled) {
        const calendar = findOperatingCalendar(resolved.context.hours, subjectId);
        if (calendar?.kind === 'unknown') unverifiedHours.push(subjectId);
      }

      preparation = buildPreparation({
        evidence: resolved.context.compiled.evidence,
        scheduledSubjectIds: [...scheduled],
        namesById,
        unverifiedHoursSubjectIds: unverifiedHours,
      });
    }
  } catch (error) {
    console.error('Preparation list could not be derived', error);
  }

  return (
    <ItineraryView
      itinerary={itinerary}
      preparation={preparation}
      tripId={id}
      /*
       * The base's resolved name, read from the compiled region rather than
       * stored on the itinerary. A stored plan is immutable; migrating one to
       * change how a heading reads would be rewriting somebody's trip to fix a
       * presentation bug. An old region with no resolved name falls back to the
       * itinerary's own `baseName`, exactly as before.
       */
      {...(baseNames ? { baseNames } : {})}
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
