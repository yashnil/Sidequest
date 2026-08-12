import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  DATE_MODE_LABELS,
  TRIP_THEME_LABELS,
  nightsFrom,
  shortlistLead,
  shortlistSeparation,
  type DestinationShortlist,
} from '@sidequest/core';
import { ShortlistView } from '@/components/ShortlistView';
import { DecisionRevise } from '@/components/DecisionRevise';
import { buttonClass } from '@/components/ui';
import { ShortlistImagery } from './ShortlistImagery';
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

export const metadata: Metadata = {
  title: 'Where should I go — Sidequest',
};

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

  const images = imagesForShortlist(session.shortlist);
  const picks = session.shortlist?.picks ?? [];

  /**
   * WHEN A RANKING IS NOT A RANKING.
   *
   * A live run produced eight administrative polygons under a numbered list and
   * a "why this one" panel beside the first. A list in an order that means
   * nothing, presented as an order, is worse than no list: somebody acts on the
   * first row.
   *
   * This used to test `band === 'thin_evidence'` on every pick, which was the
   * wrong question twice over. It was too *narrow* — a full set of answers puts
   * the same eight indistinguishable regions in the `worth_a_look` band, and the
   * screen went back to numbering them 1 to 8 — and it was indirect, because the
   * band is a statement about one destination's evidence while the thing at
   * stake is whether the eight can be told apart *from each other*.
   *
   * So the verdict is derived from the scores themselves, in `@sidequest/core`
   * beside the ranker that produced them, and `ShortlistView` reads the same
   * function. Two screens cannot disagree about whether a list is ranked.
   */
  const separation = shortlistSeparation(picks);

  /**
   * WHICH ONE THE PAGE LEADS WITH, AND WHAT IT MAY SAY ABOUT IT.
   *
   * The old headline for a tie was "We could not tell these apart", and below it
   * the page spent two paragraphs elaborating on that, then offered six things
   * the traveller could go and answer. Every word of it was true and the whole
   * screen was about us. Somebody who asked where they should go got a report on
   * our confidence.
   *
   * `shortlistLead` is the same function `ShortlistView` calls, so the name in
   * this heading and the destination in the panel below cannot drift apart.
   */
  const lead = shortlistLead(picks, separation);
  const leadPick = lead ? picks.find((pick) => pick.entryId === lead.entryId) : undefined;

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">Where should I go</p>
      {/*
        An empty result gets its own heading rather than the confident one.

        `shortlistSeparation([])` reports `separates: true` — vacuously, because
        no adjacent pair disagrees — so a run that returned nothing was headed
        "Places that fit this trip" above a panel reading "Nothing came back".
      */}
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {!session.shortlist
          ? 'Working out where you should go'
          : picks.length === 0
            ? 'We could not put a list together'
            : !separation.separates && leadPick
              ? `Start with ${leadPick.displayName}`
              : 'Places that fit this trip'}
      </h1>

      {/*
        THE ONE INPUT THAT WOULD CHANGE THE ANSWER.

        One, not the six this listed before. The dimensions are not equal —
        climate carries 0.24 of the nominal weight and transport 0.04 — so
        `shortlistLead` sorts them and hands back the heaviest question that is
        the traveller's to answer. Six bullet points and a button reading
        "Answer those and re-rank" is a form, and a form is exactly what
        somebody is trying to avoid when they ask a product where to go.

        Absent entirely when nothing would help: every remaining gap is ours or
        nobody's, they are listed once inside the disclosure below the results,
        and offering a form for a problem the traveller cannot solve is worse
        than saying nothing.
      */}
      {session.shortlist && !separation.separates && lead?.nextQuestion ? (
        <div className="mt-6 max-w-2xl rounded-[var(--radius-card)] border border-rule bg-paper-sunk p-5">
          <p className="eyebrow">One answer would change this</p>
          <p className="mt-3 leading-relaxed text-ink">{lead.nextQuestion.action}</p>
          <a href="#revise" className={`${buttonClass('primary')} mt-5`}>
            Answer that and re-rank
          </a>
        </div>
      ) : null}

      <div className="mt-10">
        <ShortlistView
          sessionId={id}
          shortlist={session.shortlist}
          answersSummary={summary}
          images={images}
        />
      </div>

      {/*
        Photographs are resolved after the ranking is on screen, never in front
        of it. See `ShortlistImagery` and the note in `buildShortlistAction`.
      */}
      {picks.length > 0 ? (
        <ShortlistImagery
          sessionId={id}
          missing={picks.filter((pick) => !images[pick.entryId]).length}
        />
      ) : null}

      {/*
        `scroll-mt-8` rather than `scroll-mt-24`.

        The root now carries `scroll-padding-top: var(--chrome-height)` so that
        a focused control never lands behind the header (WCAG 2.2 SC 2.4.11).
        That padding applies to anchor jumps too, and it *adds* to any
        `scroll-margin` here — 96px of margin on top of 73px of padding would
        drop this heading a quarter of the way down a phone screen. What is
        wanted here is only breathing room above the rule.
      */}
      <div id="revise" className="mt-14 scroll-mt-8 border-t border-rule pt-8">
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
