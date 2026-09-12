import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUserId } from '@/lib/auth/session';
import { listPartyMembers, listTravelers, partyFactsFor } from '@/lib/db/party-repository';
import { getItinerary, hasItinerary } from '@/lib/db/repository';
import { sessionToken } from '@/lib/net/caller';
import { ownedTrip } from '@/lib/net/trip-access';
import { buttonClass } from '@/components/ui';
import { PartyEditor } from './PartyEditor';
import { SplitSuggestions, type SplitSuggestionDay } from './SplitSuggestions';

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
  /* V9 §17 — a split needs a difference to split over; without one the section does not exist. */
  const splitDays: SplitSuggestionDay[] = built && partyFactsFor(id)?.differences ? splitSuggestionDays(id) : [];
  const adults = `${trip.basics.adults} adult${trip.basics.adults === 1 ? '' : 's'}`;
  const party = trip.basics.children > 0 ? `${adults}, ${trip.basics.children} child${trip.basics.children === 1 ? '' : 'ren'}` : adults;

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14" data-testid="party-page">
      <p className="eyebrow">{trip.title ?? trip.basics.destinationInput}</p>
      <h1 className="display-xl mt-3 text-ink">Who is going?</h1>
      <p className="measure mt-4 type-body text-ink-muted">
        <span className="type-figure text-ink">{party}.</span> Describe anyone whose needs or tastes should shape the plan — a diet, a knee, an early riser, someone who does not drive. It is planned around, and never
        shared.
      </p>

      <PartyEditor tripId={id} members={members.map((m) => ({ ...m, traveler: m.traveler }))} available={available.map((t) => ({ id: t.id, displayName: t.displayName, relationship: t.relationship ?? null }))} />

      <SplitSuggestions tripId={id} days={splitDays} />

      <div className="sticky bottom-0 z-10 -mx-5 mt-12 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule bg-paper/95 px-5 py-3 backdrop-blur-sm sm:-mx-8 sm:px-8">
        <Link href={built ? `/trips/${id}/itinerary` : `/trips/${id}/questionnaire`} className={buttonClass('primary', 'lg')} data-testid="party-done">
          {built ? 'Back to the trip' : 'Continue to the review'}
        </Link>
        {built ? <span className="type-small text-ink-muted">Applied the next time the trip is built or a day is changed.</span> : <span className="type-small text-ink-muted">Nothing here is required to build.</span>}
      </div>
    </div>
  );
}

/** The built plan's days, for the split links; a plan that will not read is simply no offer. */
function splitSuggestionDays(tripId: string): SplitSuggestionDay[] {
  try {
    const itinerary = getItinerary(tripId);
    return (itinerary?.days ?? []).map((day) => ({ dayNumber: day.dayNumber, theme: day.theme, date: day.date, alreadySplit: Boolean(day.split) }));
  } catch {
    return [];
  }
}
