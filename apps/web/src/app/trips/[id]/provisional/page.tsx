import { notFound, redirect } from 'next/navigation';
import type { ProvisionalIntent } from '@sidequest/core';
import { ProvisionalBoardView } from '@/components/ProvisionalBoardView';
import { getProvisionalBoard, getProvisionalSelections } from '@/lib/db/provisional-repository';
import { getLatestJob } from '@/lib/db/compiler-repository';
import { getTrip } from '@/lib/db/repository';
import { countTripDays, isTerminal } from '@sidequest/core';

/**
 * THE PROVISIONAL BOARD.
 *
 * Its own route rather than a mode of `/discover`, for one reason that decides
 * everything else: **this page starts no external work.**
 *
 * That began as a difference from `/discover`, which resolved the region during
 * render and fetched a forecast while doing it. It is no longer a difference:
 * the forecast moved behind an explicit control and `resolveTripRegion` reads a
 * stored snapshot, so neither route fetches on a render now. What survives is
 * the stronger property, which this route has and the other still does not — it
 * reads rows and renders, with no resolver and no derivation in the middle.
 * Refreshing it costs nothing, which is what makes "you can close this page"
 * true rather than aspirational.
 */
export const dynamic = 'force-dynamic';

export default async function ProvisionalBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) notFound();

  const board = getProvisionalBoard(id);
  /*
   * No board yet is not an error, and not a 404 either — it is "the cut has not
   * happened". Sending them back to the progress screen is the honest answer,
   * because that screen is where they will be told the moment it has.
   */
  if (!board) redirect(`/trips/${id}/plan`);

  const job = getLatestJob(id);
  const stillRunning = job !== null && !isTerminal(job.state);

  const selections: Record<string, ProvisionalIntent | undefined> = {};
  for (const selection of getProvisionalSelections(id)) {
    selections[selection.placeId] = selection.intent;
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="eyebrow">While we check</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {trip.basics.destinationInput}, as the map data has it
      </h1>

      <div className="mt-10">
        {/*
          Keyed on the trip *and* the board version.

          Without it React reconciles a rebuilt board — or a different trip
          reached by a client-side navigation — into the same component
          instance, and every piece of local state seeded from props survives
          into an artifact it does not describe. The component defends itself
          against that too; this is the cheaper half of the same guarantee, and
          it is the half that also covers state nobody has thought about yet.
        */}
        <ProvisionalBoardView
          key={`${id}:${board.id}:${board.version}`}
          tripId={id}
          board={board}
          selections={selections}
          stillRunning={stillRunning}
          /*
           * What "enough" is measured against. Read off the trip rather than
           * assumed, because the same forty places are generous for a weekend
           * and thin for a fortnight — and a count with nothing to compare it
           * to says neither of those things.
           */
          tripDays={countTripDays(trip.basics.startDate, trip.basics.endDate)}
        />
      </div>
    </div>
  );
}
