import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUserId } from '@/lib/auth/session';
import { listPartyMembers, listTravelers } from '@/lib/db/party-repository';
import { hasItinerary } from '@/lib/db/repository';
import { sessionToken } from '@/lib/net/caller';
import { ownedTrip } from '@/lib/net/trip-access';
import { buttonClass } from '@/components/ui';
import { PartyEditor } from './PartyEditor';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Who is going — Sidequest',
};

/**
 * V6 §3/§4 — THE PARTY PAGE: PEOPLE, NOT "3 ADULTS".
 *
 * Optional. A trip plans fine on counts; describing each person is what lets
 * the plan honour a diet, a knee, a child's day, a friend who does not drive.
 * Every field maps to a planning consequence (`NEED_CONSEQUENCES`); nothing
 * here asks for a diagnosis, and the notes are private to the planning.
 */
export default async function PartyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();
  const members = listPartyMembers(id);
  const available = listTravelers({ userId: await currentUserId(), ownerToken: await sessionToken({ mint: false }) }).filter((t) => !members.some((m) => m.travelerId === t.id));
  const built = hasItinerary(id);

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14" data-testid="party-page">
      <p className="eyebrow">{trip.title ?? trip.basics.destinationInput}</p>
      <h1 className="display-xl mt-3 text-ink">Who is going?</h1>
      <p className="measure mt-4 type-body text-ink-muted">
        <span className="text-ink">
          {trip.basics.adults} adult{trip.basics.adults === 1 ? '' : 's'}
          {trip.basics.children > 0 ? `, ${trip.basics.children} child${trip.basics.children === 1 ? '' : 'ren'}` : ''}.
        </span>{' '}
        Describe anyone whose needs or tastes should shape the plan — a diet, a knee, an early
        riser, someone who does not drive. It is planned around, and never shared.
      </p>

      <PartyEditor tripId={id} members={members.map((m) => ({ ...m, traveler: m.traveler }))} available={available.map((t) => ({ id: t.id, displayName: t.displayName, relationship: t.relationship ?? null }))} />

      <div className="mt-12 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rule-top pt-5">
        <Link href={built ? `/trips/${id}/itinerary` : `/trips/${id}/questionnaire`} className={buttonClass('primary', 'lg')} data-testid="party-done">
          {built ? 'Back to the trip' : 'Continue'}
        </Link>
        {built ? <span className="type-small text-ink-muted">Applied the next time the trip is built or a day is changed.</span> : null}
      </div>
    </div>
  );
}
