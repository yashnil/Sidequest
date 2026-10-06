import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ItineraryView } from '@/components/ItineraryView';
import { EnvironmentPill } from '@/components/EnvironmentPill';
import { OfflineSnapshot } from '@/components/OfflineSnapshot';
import { resolveMapBasemap } from '@/components/map-adapter';
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
import { compiledRegionFor, DYNAMIC_REGION_ID } from '@/lib/region';
import { StaleItineraryView } from './StaleItineraryView';
import { AskSidequestMount } from './ask-sidequest-mount';
import { getTripDraft } from '@/lib/db/draft-repository';
import { undoTarget } from '@/lib/refine/version-repository';
import { itineraryViewModel } from './view-model';
import { RecoveryBuildButton } from './RecoveryBuildButton';
import { buildPreflight } from '@/lib/planning/build-preflight';
import { callerKey } from '@/lib/net/caller';
import { listBookedItems } from '@/lib/db/intelligence-repository';
import { regenerationCopy, regenerationPreview } from './regenerate-summary';

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
  // Whether a Discovery Board exists to go back to; without one, recovery is an explicit build from the saved answers.
  const boardAvailable = trip.basics.regionId !== DYNAMIC_REGION_ID || compiledRegionFor(id) !== null;

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
          (selection) => selection.status === 'included' || selection.status === 'maybe',
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
          boardAvailable={boardAvailable}
          title="This plan was built by an earlier version of Sidequest"
          body="We could not recover enough of it to show you, so it needs one rebuild. Every choice you made on the board is kept — head back and press Rebuild."
        />
      );
    }
    console.error('Stored itinerary failed validation', error);
    return (
      <Recovery
        tripId={id}
        boardAvailable={boardAvailable}
        title="That saved plan is no longer readable"
        body="The stored itinerary does not match the current format, so we will not show you something we cannot trust. Rebuilding it from your board takes a moment and keeps all your selections."
      />
    );
  }

  if (!itinerary) {
    return (
      <Recovery
        tripId={id}
        boardAvailable={boardAvailable}
        title="No trip built yet"
        body={boardAvailable ? 'You have not built this trip yet. Head back to the board, confirm what you want, and press Build my trip.' : 'Your answers are saved. Retrying starts one fresh draft from them.'}
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
  const fixtureMode = isFixtureComposer();
  const locks = getItineraryLocks(id);
  /* What Regenerate keeps and replaces, read from the rows the rebuild reads — the stored plan, not the booked overlay. */
  const regeneration = regenerationCopy(regenerationPreview({ itinerary, locks, selections: getSelections(id), bookings: listBookedItems(id).length }));

  return (
    <>
      <EnvironmentPill />
      {fixtureMode ? (
        <p className="mx-auto max-w-4xl px-5 pt-4 sm:px-8">
          <span className="inline-flex items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-amber bg-amber-soft px-2.5 py-1 text-xs text-amber" data-testid="fixture-planning-badge">
            Fixture planning data — this plan was composed from a saved fixture, not the live model.
          </span>
        </p>
      ) : null}
    <ItineraryView
      tiles={resolveMapBasemap(process.env)}
      tripId={id}
      {...model}
      itinerary={model.appliedItinerary}
      /* V9 — the band says the trip is kept on an account only when it is; the shared copy never gets this prop. */
      savedToAccount={Boolean(trip.userId)}
      destinationName={trip.basics.destinationInput}
      boardAvailable={boardAvailable}
      lockedPlaceIds={locks.map((lock) => lock.placeId)}
      regeneration={regeneration}
      dateLabel={formatDateRange(trip.basics.startDate, trip.basics.endDate)}
      // Read once, on the server, so every day on the page judges the same
      // forecast against the same instant. See `lib/clock` for why this is a
      // function rather than an inline clock read.
      renderedAt={renderInstant()}
    />
    <p className="mx-auto max-w-4xl px-5 pb-8 sm:px-8">
      {/* V9 §11 — the offline copy keeps the plan, Today and the Pack, and records Preflight's "offline" tick when saved. */}
      <OfflineSnapshot paths={[`/trips/${id}/itinerary`, `/trips/${id}/today`, `/trips/${id}/pack`]} tripId={id} />
    </p>
    {/*
      * PRODUCTION LOCK V5 §43 — Ask Sidequest.
      *
      * Mounted here rather than inside `ItineraryView` because it is a sheet
      * over the whole page, not a section of the trip: it must sit outside the
      * hub's five views so it is reachable from all of them, and outside the
      * print flow entirely.
      */}
    <AskSidequestMount
      tripId={id}
      ready={Boolean(getTripDraft(id))}
      canUndo={undoTarget(id) !== null}
      dayCount={model.appliedItinerary.days.length}
      baseNames={(model.appliedItinerary.package?.bases ?? []).map((base) => base.displayName ?? base.name)}
    />
    </>
  );
}

async function Recovery({ tripId, title, body, boardAvailable }: { tripId: string; title: string; body: string; boardAvailable: boolean }) {
  /*
   * COMPOSITION RELIABILITY — a trip with no board (the normal interview path)
   * recovers through an explicit press, never on load. V1 convergence — and the
   * press does what it says: it starts the build from the saved answers, unless
   * the preflight already knows no build can run, in which case the page says
   * so and offers the review instead of a button that cannot work.
   */
  const preflight = boardAvailable ? null : buildPreflight(tripId, { caller: await callerKey() });
  return (
    <div className="mx-auto max-w-xl px-5 py-20 sm:px-8">
      <Panel className="p-8">
        <h1 className="font-display text-2xl text-ink">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{body}</p>
        {boardAvailable ? (
          <Link href={`/trips/${tripId}/discover`} className={`${buttonClass('primary')} mt-6`} data-testid="recovery-primary">
            Back to the Discovery Board
          </Link>
        ) : preflight && !preflight.ok ? (
          <>
            <p className="mt-4 text-sm leading-relaxed text-ink" data-testid="recovery-unavailable">
              <strong className="font-semibold">{preflight.failure.heading}</strong> {preflight.failure.message}
            </p>
            <Link href={`/trips/${tripId}/questionnaire`} className={`${buttonClass('secondary')} mt-6`} data-testid="recovery-review">
              Return to my answers
            </Link>
          </>
        ) : (
          <RecoveryBuildButton tripId={tripId} />
        )}
      </Panel>
    </div>
  );
}
