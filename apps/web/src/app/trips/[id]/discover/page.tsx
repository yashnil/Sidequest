import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  autoSelect,
  buildDiscoveryBoard,
  countTripDays,
  EASTERN_SIERRA_PLACES,
  REGIONS,
  tripMonths,
  tripPersonality,
  type SelectionStatus,
} from '@sidequest/core';
import { DiscoveryBoardView } from '@/components/DiscoveryBoardView';
import { TripPersonalityCard } from '@/components/QuestionnaireWizard';
import { Panel, buttonClass } from '@/components/ui';
import { formatDateRange, formatMinutes } from '@/lib/format';
import { getProfile, getSelections, getTrip, hasItinerary } from '@/lib/db/repository';

export const dynamic = 'force-dynamic';

export default async function DiscoverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) notFound();

  const profile = getProfile(id);
  if (!profile) redirect(`/trips/${id}/questionnaire`);

  const region = REGIONS.find((item) => item.id === trip.basics.regionId);
  if (!region) notFound();

  const days = countTripDays(trip.basics.startDate, trip.basics.endDate);
  const months = tripMonths(trip.basics.startDate, trip.basics.endDate);

  const board = buildDiscoveryBoard({
    region,
    places: EASTERN_SIERRA_PLACES,
    profile,
    months,
    travelerNeeds: trip.basics.travelerNeeds,
  });
  const suggestion = autoSelect({ candidates: board.candidates, profile, tripDays: days });
  const personality = tripPersonality(profile, days);

  const planned = hasItinerary(id);
  const stored = getSelections(id);
  const selections: Record<string, SelectionStatus | undefined> = {};
  for (const selection of stored) selections[selection.placeId] = selection.status;

  const closed = board.candidates.filter((candidate) => candidate.season.status === 'closed');
  const workable = board.candidates.filter((candidate) => candidate.fit.band !== 'not_workable');

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="border-b border-rule pb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Discovery board</p>
        <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-5xl">
          {region.name}
        </h1>
        <p className="mt-3 max-w-2xl text-ink-muted">{region.summary}</p>

        <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3 text-sm">
          <Fact label="Dates">
            {formatDateRange(trip.basics.startDate, trip.basics.endDate)} · {days} days
          </Fact>
          <Fact label="Base">{region.baseName}</Fact>
          <Fact label="Travellers">
            {trip.basics.adults} adult{trip.basics.adults === 1 ? '' : 's'}
            {trip.basics.children > 0 ? `, ${trip.basics.children} children` : ''}
          </Fact>
          <Fact label="Region searched">
            {formatMinutes(board.expansion.radiusMinutes)} from base
          </Fact>
          <Fact label="Found">
            {board.expansion.base.length} at base · {board.expansion.satellites.length} satellites
          </Fact>
        </dl>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={`/trips/${id}/questionnaire`} className={buttonClass('secondary', 'sm')}>
            Change my answers
          </Link>
          {planned ? (
            <Link href={`/trips/${id}/itinerary`} className={buttonClass('secondary', 'sm')}>
              View the trip you built
            </Link>
          ) : null}
        </div>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="order-2 lg:order-1">
          {workable.length === 0 ? (
            <Panel className="p-8">
              <h2 className="font-display text-xl text-ink">Nothing in this region works on these dates</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                Every candidate we found is either closed for the season, past how far you will
                travel, or beyond the effort level you set. That is a real answer rather than a
                padded list — but changing your dates, your radius or your driving comfort will
                open it up.
              </p>
              <Link
                href={`/trips/${id}/questionnaire`}
                className={`${buttonClass('primary', 'sm')} mt-5`}
              >
                Revisit my answers
              </Link>
            </Panel>
          ) : (
            <DiscoveryBoardView
              tripId={id}
              groups={board.groups}
              initialSelections={selections}
              autoPickNotes={suggestion.notes}
              targetCount={suggestion.targetCount}
              hasItinerary={planned}
            />
          )}
        </div>

        <aside className="order-1 space-y-6 lg:order-2 lg:sticky lg:top-6">
          <div>
            <h2 className="font-display text-lg text-ink">Your trip personality</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Everything on the board is ranked against this.
            </p>
            <div className="mt-3">
              <TripPersonalityCard personality={personality} />
            </div>
          </div>

          {closed.length > 0 ? (
            <Panel className="p-4">
              <h3 className="text-sm font-medium text-ink">
                {closed.length} {closed.length === 1 ? 'place is' : 'places are'} shut on your dates
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                Snow closes most of this region for months at a time. These are listed under
                “Probably skip” with the reason, rather than hidden.
              </p>
              <ul className="mt-3 space-y-1 text-xs text-ink-faint">
                {closed.slice(0, 5).map((candidate) => (
                  <li key={candidate.place.id}>{candidate.place.name}</li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}
