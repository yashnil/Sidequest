import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  DATE_MODE_LABELS,
  TRIP_THEME_LABELS,
  nightsFrom,
  type DestinationShortlist,
} from '@sidequest/core';
import { ShortlistView } from '@/components/ShortlistView';
import { DecisionRevise } from '@/components/DecisionRevise';
import { getDecisionSession } from '@/lib/db/decision-repository';
import { destinationEntryById } from '@/lib/db/destination-index-repository';
import { acceptedImagesFor } from '@/lib/db/imagery-repository';
import { isClimateEnabled } from '@/lib/providers/switches';

/**
 * Dynamic, and reads rows only.
 *
 * Nothing here starts external work: the shortlist is built by an explicit
 * action and stored, so a refresh re-renders what is on disk rather than paying
 * for it again. That is the same rule the plan page follows and the same reason —
 * a page that ranked on every render would rank on every back button.
 *
 * Imagery follows the identical rule and is the reason it is worth restating.
 * The photographs on this screen were resolved by `buildShortlistAction`, gated,
 * credited and written to `destination_images`; this reads that table. A render
 * that could ask a wiki for a picture would ask once per card, on every refresh,
 * from every visitor — which is the "hot spider" pattern Wikimedia's own
 * guidance names and asks clients not to build.
 */
export const dynamic = 'force-dynamic';

export default async function DecideSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = getDecisionSession(id);
  if (!session) notFound();

  /*
   * Already chosen. The decision is a record of how they got there, and the trip
   * is where the work now lives — so this is a redirect rather than a read-only
   * copy of a screen they have finished with.
   */
  if (session.resolvedTripId) redirect(`/trips/${session.resolvedTripId}/plan`);

  const nights = nightsFrom(session.answers);
  const summary = [
    session.answers.dates.mode === 'month' && session.answers.dates.month
      ? MONTHS[session.answers.dates.month - 1]
      : session.answers.dates.mode === 'season' && session.answers.dates.season
        ? `${session.answers.dates.season[0]!.toUpperCase()}${session.answers.dates.season.slice(1)}`
        : DATE_MODE_LABELS[session.answers.dates.mode],
    nights === null ? 'length open' : `${nights} nights`,
    session.answers.themes.map((theme) => TRIP_THEME_LABELS[theme].toLowerCase()).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">Where should I go</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {session.shortlist ? 'Places that fit this trip' : 'Working out where you should go'}
      </h1>

      <div className="mt-10">
        <ShortlistView
          sessionId={id}
          shortlist={session.shortlist}
          answersSummary={summary}
          images={imagesForShortlist(session.shortlist)}
        />
      </div>

      <div className="mt-14 border-t border-rule pt-8">
        <DecisionRevise
          sessionId={id}
          climateEnabled={isClimateEnabled()}
          initial={{
            dateMode: session.answers.dates.mode,
            ...(session.answers.dates.startDate ? { startDate: session.answers.dates.startDate } : {}),
            ...(session.answers.dates.endDate ? { endDate: session.answers.dates.endDate } : {}),
            ...(session.answers.dates.month ? { month: session.answers.dates.month } : {}),
            ...(session.answers.dates.season ? { season: session.answers.dates.season } : {}),
            nights: session.answers.duration.nights ?? null,
            shape: session.answers.shape ?? null,
            transport: session.answers.transport ?? null,
            pace: session.answers.pace ?? null,
            themes: [...session.answers.themes],
            outdoorIntensity: session.answers.outdoorIntensity ?? null,
            budget: session.answers.budget ?? null,
            adults: session.answers.adults,
            children: session.answers.children,
            avoid: session.answers.avoid ?? '',
          }}
        />
      </div>

      <p className="mt-10 text-sm text-ink-faint">
        <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
          Or start from a destination you already have in mind.
        </Link>
      </p>
    </div>
  );
}

/**
 * Stored photographs for the destinations on screen, keyed by index entry id.
 *
 * The Wikidata id comes back out of the index rather than out of the shortlist,
 * because that is what an imagery record is keyed on — a photograph survives the
 * index being rebuilt and every entry renumbered, and looking it up by our own
 * id would lose it at exactly the moment the catalogue is refreshed.
 *
 * Two local table reads and no network. A shortlist with nothing stored yields
 * an empty object and every card draws its coordinate-derived graphic, which is
 * a designed outcome rather than a degraded one.
 */
function imagesForShortlist(shortlist: DestinationShortlist | null) {
  if (!shortlist || shortlist.picks.length === 0) return {};
  const subjects = shortlist.picks.flatMap((pick) => {
    const entry = destinationEntryById(pick.entryId);
    if (!entry) return [];
    return [
      {
        kind: 'destination' as const,
        id: entry.id,
        ...(entry.wikidataId ? { wikidataId: entry.wikidataId } : {}),
      },
    ];
  });
  return acceptedImagesFor(subjects);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
