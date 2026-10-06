import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SetupFlow } from '@/components/setup/SetupFlow';
import { ownedTrip } from '@/lib/net/trip-access';
import { getIntent } from '@/lib/db/compiler-repository';
import { buttonClass } from '@/components/ui';
import { hasItinerary } from '@/lib/db/repository';
import { tripHomeHref } from '@/lib/trips/trip-home';

/**
 * CHANGING YOUR MIND, WITHOUT LOSING THE TRIP.
 *
 * The route the product did not have. "Change the trip" appeared on the
 * preflight screen, on a failed build, and on every blocked state — and every
 * one of them linked to `/trips/new`, a blank composer. Correcting a single
 * wrong answer cost the destination, the dates, the party, the must-dos, the
 * questionnaire and any research already paid for, and left an orphan trip
 * beside the one the traveller was trying to fix.
 *
 * This renders the same composer, seeded from what they already said, and saves
 * through `updateTripFromComposer` — which invalidates only the stages the
 * changed answer actually broke. A traveller who moves their dates by a day
 * keeps their questionnaire and their must-do decisions; one who changes the
 * destination outright does not, because those stages were about somewhere
 * else.
 */
export const dynamic = 'force-dynamic';

/** Which trip is being corrected. See the discover route for why. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return {
    title: trip
      ? `${trip.basics.destinationInput} — Change this trip — Sidequest`
      : 'Change this trip — Sidequest',
  };
}

export default async function EditTripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  /*
   * The owner's trip or nothing — a foreign browser sees a missing trip, the
   * same boundary every trip door holds. See `lib/net/trip-access`.
   */
  const trip = await ownedTrip(id);
  if (!trip) notFound();

  const intent = getIntent(id);
  const answers = intent?.composer ?? null;
  /* V1 convergence — the trip's own home, never `/plan`, which bounces a trip that did not take the research path. */
  const back = tripHomeHref(id, hasItinerary(id));

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">Change this trip</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        Correct anything that reads wrong
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">
        Your trip stays where it is. We only redo the parts that depend on what you change — moving
        your dates does not throw away your questionnaire, and changing a preference does not throw
        away the region we already read.
      </p>

      <div className="mt-10">
        {answers ? (
          <SetupFlow
            defaults={{ startDate: trip.basics.startDate, endDate: trip.basics.endDate }}
            editing={{ tripId: id, answers }}
          />
        ) : (
          /*
           * A trip with no stored composer answers.
           *
           * Only reachable for rows created before the composer existed. Editing
           * them through this form would present defaults as though they were
           * the traveller's own answers, which is worse than saying so — the
           * whole point of this screen is that it shows you what you said.
           */
          <div className="max-w-xl">
            <p className="text-ink-muted">
              This trip was created before we started keeping your answers, so there is nothing here
              to show you. You can still change its dates from the plan screen, or start a fresh
              trip — this one stays where it is either way.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={back} className={buttonClass('primary')} data-testid="edit-back-to-trip">
                Back to this trip
              </Link>
              <Link href="/trips/new" className={buttonClass('ghost')}>
                Start a new trip
              </Link>
            </div>
          </div>
        )}
      </div>

      <p className="mt-14 border-t border-rule pt-6 text-sm text-ink-faint">
        <Link href={back} className="underline underline-offset-2" data-testid="edit-leave">
          Leave this without changing anything
        </Link>{' '}
        — nothing here is saved until you press the button above.
      </p>
    </div>
  );
}
