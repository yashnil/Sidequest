import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  autoSelect,
  countTripDays,
  detourToleranceMinutesFor,
  mayShowDiscoveryBoard,
  readBoardIntegrity,
  settleMustDoCoverage,
  type SelectionStatus,
} from '@sidequest/core';
import { DiscoveryBoardView } from '@/components/DiscoveryBoardView';
import { resolveMapTileSource } from '@/components/map-adapter';
import { BoardIntegrityPanel } from '@/components/BoardIntegrityPanel';
import { BoardBackstage } from '@/components/BoardBackstage';
import { acceptedImagesFor, unresolvedImagerySubjects } from '@/lib/db/imagery-repository';

import { FoodStopsBoard, type FoodChoiceMap } from '@/components/FoodStopsBoard';
import { TripPersonalityCard } from '@/components/TripPersonalityCard';
import { Panel, buttonClass } from '@/components/ui';
import { MustDoPanel } from '@/components/MustDoPanel';
import { ResearchReadinessPanel, coverageStoppedEarly } from '@/components/ResearchReadinessPanel';
import { getIntent, getLatestJob } from '@/lib/db/compiler-repository';
import { formatDateRange, formatMinutes } from '@/lib/format';
import {
  getFoodSelections,
  getProfile,
  getSelections,
  hasItinerary,
  getReadiness,
} from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';
import {
  getAcknowledgements,
  getReconciliationFor,
  pendingActionCount,
} from '@/lib/db/provisional-repository';
import { BusyFormSubmit } from '@/components/BusyFormSubmit';
import { ReconciliationPanel } from '@/components/ReconciliationPanel';
import {
  boardWeatherBackups,
  foodBoardFor,
  weatherPanelCopy,
  type CompiledRegion,
  type WeatherAvailability,
} from '@sidequest/core';
import { boardFor, compiledRegionFor, resolveTripRegion } from '@/lib/region';
import { refreshWeatherFormAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The tab says which trip and which step, not what the product is.
 *
 * Every trip route inherited the root layout's one marketing title, so a
 * traveller with a plan, a board and a questionnaire open had three identical
 * tabs, back-history entries that could not be told apart, and — the failure
 * that makes this WCAG 2.4.2 rather than a nicety — a screen reader announcing
 * the same sentence on arrival at every screen.
 *
 * Read from the stored trip, the same row this page renders, so the tab cannot
 * claim a destination the page does not show. Where the row is missing the page
 * itself 404s, and the step name alone is the honest title.
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
      ? `${trip.basics.destinationInput} — Discovery board — Sidequest`
      : 'Discovery board — Sidequest',
  };
}

export default async function DiscoverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  /*
   * The owner's trip or nothing — a foreign browser sees a missing trip, the
   * same boundary every trip door holds. See `lib/net/trip-access`.
   */
  const trip = await ownedTrip(id);
  if (!trip) notFound();

  const profile = getProfile(id);
  if (!profile) redirect(`/trips/${id}/questionnaire`);

  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) notFound();
  const { region } = resolved.context;

  const days = countTripDays(trip.basics.startDate, trip.basics.endDate);
  const board = boardFor(trip, profile, resolved.context);
  const compiled = compiledRegionFor(id);
  const attributions = compiled?.sourceManifest.attributions ?? [];
  const suggestion = autoSelect({
    candidates: board.candidates,
    profile,
    tripDays: days,
    transitUnmeasured: board.transitUnmeasured,
  });

  const planned = hasItinerary(id);

  /**
   * Derived rather than stored, and short by construction. A region with no food
   * data simply has no section, which is the honest outcome and not an error.
   */
  const foodStops = resolved.context.food
    ? foodBoardFor({
        dataset: resolved.context.food,
        profile,
        dates: resolved.context.dates,
      })
    : [];
  const foodChoices: FoodChoiceMap = {};
  for (const entry of getFoodSelections(id)) foodChoices[entry.venueId] = entry.status;
  /*
   * What changed between the board they marked and the board they got — **for
   * the artifact on this screen**.
   *
   * Read, never recomputed: the account was written when the artifact was
   * committed, and re-deriving it here would give a different answer whenever
   * anything downstream moved.
   *
   * The identity comparison is the whole of a fix worth restating. An account is
   * only ever written on a *successful* build, and this page used to read the
   * stored one unconditionally — so a rebuild that failed left the previous
   * build's removals sitting above the new board, every sentence in the present
   * tense, describing places that had never been checked against this artifact.
   * A mismatch renders nothing, because nothing is much better than a confident
   * and detailed wrong answer.
   */
  const reconciliation = compiled ? getReconciliationFor(id, compiled.id) : null;
  /*
   * Which of those the traveller has already said they read. Stored apart from
   * the account itself, because it is a fact about the person rather than about
   * what the compiler found.
   */
  const acknowledgements = getAcknowledgements(id);
  /*
   * Marks nothing has accounted for yet.
   *
   * The honest counterpart to the gate above: when there is no account for the
   * artifact on screen — no build has finished, or the last one failed — the
   * traveller's own choices are still recorded and still outstanding, and
   * saying so is the difference between a state and a silence.
   */
  const awaitingReconciliation = reconciliation ? 0 : pendingActionCount(id);
  const stored = getSelections(id);
  const selections: Record<string, SelectionStatus | undefined> = {};
  for (const selection of stored) selections[selection.placeId] = selection.status;

  const closed = board.candidates.filter((candidate) => candidate.season.status === 'closed');
  const workable = board.candidates.filter((candidate) => candidate.fit.band !== 'not_workable');

  /*
   * The imagery subjects for this board, built once and used twice: to read what
   * has already been resolved, and to count what nobody has looked for yet.
   *
   * The Wikidata id is what turns the lookup into an identifier relationship
   * rather than a name search, and it is the difference between a card that gets
   * a photograph and a card that never can — a bounded name search resolves at
   * `weak` confidence, which no surface is allowed to display. An artifact
   * compiled before the backbone carried the id has none, and gets the designed
   * graphic instead.
   */
  const imagerySubjects = board.candidates.map((candidate) => ({
    kind: 'candidate' as const,
    id: candidate.place.id,
    ...(candidate.place.wikidataId ? { wikidataId: candidate.place.wikidataId } : {}),
  }));
  /*
   * The pending count is over the subjects the *action* will actually ask
   * about, which is not every card.
   *
   * Two filters, and they have to be the same two the action applies or the
   * loop never closes: the skip list is not illustrated, and a record with no
   * open identifier cannot resolve above the confidence this board displays.
   * Count a subject the action will never ask about and the board fires one
   * futile round trip on every visit, for ever.
   */
  const imageryPending = unresolvedImagerySubjects(
    board.candidates
      .filter(
        (candidate) =>
          candidate.fit.band !== 'weak' &&
          candidate.fit.band !== 'not_workable' &&
          candidate.place.wikidataId !== undefined,
      )
      .map((candidate) => ({
        kind: 'candidate' as const,
        id: candidate.place.id,
        ...(candidate.place.wikidataId ? { wikidataId: candidate.place.wikidataId } : {}),
      })),
  ).length;

  /*
   * WHAT THIS BOARD IS, AS SOMETHING THE TRAVELLER CAN READ.
   *
   * `board.integrity` has been computed on every build since the role gate
   * landed and rendered nowhere, so a board that quietly set records aside was
   * indistinguishable from a destination with little in it.
   *
   * Derived here rather than stored, which is the same rule the rest of this
   * page follows: it is a projection of the artifact named in `compiled.id`, so
   * it is identical after a refresh, identical with every provider switched off,
   * and it moves exactly when the artifact does.
   *
   * The named areas come off the artifact and are frequently absent — the
   * authored fixture divides itself into nothing — and the panel then says
   * nothing about areas rather than claiming one. Containment's own counts come
   * from `compiled.boardSupply`, frozen with the artifact so they survive a
   * refresh and a provider being switched off; an artifact compiled before that
   * field existed simply omits those facts rather than inventing zeros for them.
   */
  /**
   * The compiled reading, if this artifact carries one.
   *
   * Read off the artifact rather than recomputed, so the verdict a traveller
   * sees is the verdict the build reached — including whatever recovery it ran.
   */
  /**
   * The reading and the named requests, with the traveller's own decisions
   * applied. Two persisted values in, one pair out; see `settleMustDoCoverage`.
   */
  const settled = settleMustDoCoverage({
    ...(compiled?.researchReadiness ? { readiness: compiled.researchReadiness } : {}),
    ...(compiled?.mustDoCoverage ? { coverage: compiled.mustDoCoverage } : {}),
    decisions: getIntent(id)?.composer?.mustDoDecisions ?? [],
  });
  const readiness = settled.readiness;
  /*
   * Whether the build behind this artifact stopped on its own budget, so a
   * `thin` reading can be attributed honestly — "we stopped before reading
   * everything" rather than "the world publishes little". Read from the
   * artifact's own coverage report first; the job row is consulted only when
   * it is the job that produced *this* artifact, so a later failed rebuild
   * cannot recolour the board on screen.
   */
  const latestJob = getLatestJob(id);
  const buildStoppedEarly =
    coverageStoppedEarly(compiled?.coverage ?? null) ||
    (latestJob?.state === 'partial' && latestJob.compiledRegionId === compiled?.id);

  const integrity = readBoardIntegrity({
    board,
    profile,
    tripDays: days,
    ...(compiled?.boardSupply ? { recorded: compiled.boardSupply } : {}),
    ...(compiled && compiled.subregions.length > 0
      ? {
          areas: compiled.subregions.map((subregion) => ({
            name: subregion.name,
            placeIds: subregion.placeIds,
          })),
        }
      : {}),
  });

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
      {/*
        THE HEADER IS ONE LINE, BECAUSE THE PAGE IS ABOUT PLACES.

        It was a five-item definition list plus a summary paragraph plus two
        buttons — about two hundred and eighty pixels of trip metadata a
        traveller had already typed, in front of the thing they came for. §10.1
        is explicit that the primary experience is exciting places, not the
        research engine's account of itself.

        What is left is what somebody genuinely re-reads while choosing: when
        they are going, where they are sleeping, and how far the board reaches.
        Everything else — how much was found, how the region was searched, what
        public transport could and could not be measured — is one press away at
        the foot of the page.
      */}
      <header className="border-b border-rule pb-6">
        <p className="label text-accent">Discovery board</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <h1 className="display-xl text-ink">{region.name}</h1>
          <div className="flex flex-wrap gap-2 print:hidden">
            <Link href={`/trips/${id}/questionnaire`} className={buttonClass('secondary', 'sm')}>
              Change my answers
            </Link>
            {planned ? (
              <Link href={`/trips/${id}/itinerary`} className={buttonClass('secondary', 'sm')}>
                View the trip you built
              </Link>
            ) : null}
          </div>
        </div>
        <p className="mt-3 text-sm text-ink-muted" data-testid="trip-line">
          {formatDateRange(trip.basics.startDate, trip.basics.endDate)} · {days} days ·{' '}
          {trip.basics.adults} adult{trip.basics.adults === 1 ? '' : 's'}
          {trip.basics.children > 0 ? `, ${trip.basics.children} children` : ''} · staying in{' '}
          {region.baseName} ·{' '}
          {/*
            The radius in the mode this traveller actually moves in. The raw
            `radiusMinutes` is a driving figure — for a car-free traveller it is
            a constant twenty, and this header once said "20 min from base" over
            cards legitimately reached by a 45-minute train two rows below.
          */}
          {profile.transport.willDrive
            ? `up to ${formatMinutes(board.expansion.radiusMinutes)} out`
            : `up to ${formatMinutes(detourToleranceMinutesFor(profile, 'rail'))} out by public transport`}
        </p>
      </header>

      {/*
        BELOW THE HEADING, NOT ABOVE IT.

        `ReconciliationPanel` opens with an `h2` and carries three `h3`s, and it
        rendered before the page's own `h1` — so after any rebuild, which is
        exactly when a traveller most needs to orient themselves, the document
        began at level two. Nothing about the panel changed; it is simply after
        the thing it is a note about.
      */}
      {reconciliation && reconciliation.entries.length > 0 ? (
        <ReconciliationPanel
          tripId={id}
          reconciliation={reconciliation}
          acknowledgements={acknowledgements}
        />
      ) : awaitingReconciliation > 0 ? (
        <Panel className="mb-8 p-5" as="section" testId="reconciliation-pending">
          <p className="eyebrow">Since you last looked</p>
          <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
            {awaitingReconciliation}{' '}
            {awaitingReconciliation === 1 ? 'choice you made is' : 'choices you made are'} still
            waiting to be checked against a finished build. Nothing has been lost — we simply have
            not been able to tell you what became of{' '}
            {awaitingReconciliation === 1 ? 'it' : 'them'} yet.
          </p>
        </Panel>
      ) : null}

      {/*
        The named requests, above the board rather than inside it.

        A card that is not on the board cannot explain its own absence, which is
        exactly the failure this panel exists to close: somebody who typed one
        place name and got forty other places is owed a sentence about theirs
        before they are shown anything else.
      */}
      {settled.coverage ? <MustDoPanel tripId={id} coverage={settled.coverage} /> : null}

      {readiness && !mayShowDiscoveryBoard(readiness) ? null : (
        <div className="mt-6">
          {workable.length === 0 ? (
            /*
             * THE EMPTY BOARD, EXPLAINED BY THE THING THAT IS ACTUALLY BINDING.
             *
             * The panel names the constraint that is stopping the most places,
             * counted off the board's own blockers, and offers only remedies
             * that could move that constraint. Where nothing on this screen would
             * help — a price, a closure, an intensity — it says so by offering
             * nothing but a way back, which is a better answer than a plausible
             * one.
             */
            <BoardIntegrityPanel tripId={id} reading={integrity} standalone />
          ) : (
            <DiscoveryBoardView
              tripId={id}
              tiles={resolveMapTileSource(process.env)}
              /*
               * The artifact these counts are counts *of*.
               *
               * Every number the board shows — included, maybe, per-group totals —
               * is derived from the cards below, and without the version stamped
               * beside them a count from the previous build renders happily next to
               * this build's cards. The board treats a change in this value as a
               * reason to drop its own client-side mirror rather than reconcile it.
               */
              boardVersion={compiled?.id ?? ''}
              /*
               * So a stale forecast is described in a stale voice.
               *
               * `not_fetched` and `expired` already arrive with no numbers at all —
               * `resolveTripRegion` substitutes an unfetched dataset — but `stale`
               * arrives with real numbers and used to be narrated as though it had
               * just been fetched.
               */
              weatherFreshness={
                resolved.context.weatherAvailability.kind === 'absent'
                  ? 'not_fetched'
                  : resolved.context.weatherAvailability.state
              }
              /*
               * Photographs, read out of a local table.
               *
               * A row lookup, never a resolution: a render that could resolve one
               * would do it per card, per refresh, per visitor. The identity is
               * established by `fillBoardImageryAction`, which the board asks for
               * once while `imageryPending` is non-zero.
               */
              images={acceptedImagesFor(imagerySubjects)}
              imageryPending={imageryPending}
              /*
               * The thing every travel time on this board is measured from, so
               * the map can draw it. Straight off the region rather than
               * recomputed — a map whose base disagrees with the durations beside
               * it would be worse than no map.
               */
              base={{ name: region.baseName, coordinates: region.baseCoordinates }}
              groups={board.groups}
              initialSelections={selections}
              autoPickNotes={suggestion.notes}
              hasItinerary={planned}
              weatherBackups={boardWeatherBackups(board.candidates)}
              storedReadiness={getReadiness(id)}
            />
          )}

          {foodStops.length > 0 ? (
            <FoodStopsBoard tripId={id} entries={foodStops} initialChoices={foodChoices} />
          ) : null}

          {/*
            HOW MUCH IS HERE — the one quality framework that stays in the open.

            Below the board rather than in front of it. §33 asks for one
            customer-facing quality framework on this screen and this is the one
            that survives, because it is the only one of the four that answers a
            question a traveller asked: is there enough here to plan a trip from?
            Three lines and a remedy. Everything else it used to print — the
            support-stop count, the expansion count, the withheld count — is
            operational bookkeeping and no longer renders anywhere a traveller
            reads. See `TRAVELLER_BOARD_FACTS`.
          */}
          {workable.length > 0 ? (
            <div className="mt-10">
              <BoardIntegrityPanel tripId={id} reading={integrity} />
            </div>
          ) : null}

          {/*
            EVERYTHING ELSE, BEHIND ONE DOOR.

            The research reading, the trip's own shape, what public transport
            could be measured, the weather snapshot and the places that are shut.
            All of it is true and useful; none of it is what somebody came to
            this page to do, and stacked in front of the cards it pushed the
            first place nine hundred pixels down a desktop screen.
          */}
          <BoardBackstage className="mt-4">
            {readiness ? (
              <ResearchReadinessPanel
                tripId={id}
                readiness={readiness}
                buildStoppedEarly={buildStoppedEarly}
              />
            ) : null}

            <div>
              <h2 className="font-display text-lg text-ink">What we searched</h2>
              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3 text-sm">
                <Fact label="Found">
                  {/*
                    The two numbers must sum to the board the traveller is about
                    to scroll. The old line counted only `satellites`, so a card
                    in the beyond-radius or unmeasured buckets was on the board
                    and missing from its own headline.
                  */}
                  {board.expansion.base.length} at your base ·{' '}
                  {board.expansion.satellites.length +
                    board.expansion.beyondRadius.length +
                    board.expansion.unmeasured.length}{' '}
                  further out
                </Fact>
                {/*
                  PUBLIC TRANSPORT, SAID PLAINLY OR NOT CLAIMED.

                  Four different silences read identically on a screen — nothing
                  can measure it, nothing needed to, we hold no timetables here,
                  we ran out of budget — and each one leads somewhere different.
                */}
                {compiled?.transitEvidence ? (
                  <Fact label="Public transport">
                    {transitSummaryFor(compiled.transitEvidence)}
                  </Fact>
                ) : null}
              </dl>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">
                {region.summary}
              </p>
            </div>

            {/*
              THE PUBLIC-TRANSPORT JOURNEYS, WHERE ANY WERE MEASURED.

              Every number here comes from a journey the provider returned;
              nothing is derived, nothing is averaged, and a journey the provider
              could not answer for is not in this list at all.
            */}
            {compiled?.transitEvidence && compiled.transitEvidence.measured > 0 ? (
              <TransitPanel
                evidence={compiled.transitEvidence}
                places={compiled.places}
                bases={compiled.bases}
              />
            ) : null}

            <div>
              <h2 className="font-display text-lg text-ink">Your trip personality</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Everything on the board is ranked against this.
              </p>
              <div className="mt-3">
                <TripPersonalityCard profile={profile} tripDays={days} />
              </div>
            </div>

            <WeatherPanel tripId={id} availability={resolved.context.weatherAvailability} />

            {closed.length > 0 ? (
              <Panel className="p-4">
                <h3 className="text-sm font-medium text-ink">
                  {closed.length} {closed.length === 1 ? 'place is' : 'places are'} shut on your
                  dates
                </h3>
                {/*
                 * The sentence here used to be "Snow closes most of this region
                 * for months at a time" — a claim about one mountain range,
                 * rendered on a page that now compiles anywhere on earth.
                 */}
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  Each of these is closed on your dates for a reason we can point at. They are
                  listed under “Probably skip” with that reason, rather than hidden.
                </p>
                <ul className="mt-3 space-y-1 text-xs text-ink-faint">
                  {closed.slice(0, 5).map((candidate) => (
                    <li key={candidate.place.id}>{candidate.place.name}</li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </BoardBackstage>
        </div>
      )}

      {attributions.length > 0 ? (
        /**
         * ODbL attribution, rendered from the artifact's own licence records.
         *
         * The string comes from `DataLicence.attribution` rather than being
         * written here, because the obligation is to show *that* text — a
         * component that paraphrases it has quietly stopped complying.
         */
        <p
          data-testid="board-attribution"
          className="mt-10 border-t border-rule pt-6 text-[11px] leading-relaxed text-ink-faint"
        >
          {attributions.join(' · ')}. Place data is normalised from these sources; descriptions and
          scoring are ours.
        </p>
      ) : null}

      {/*
        THE ROOM THE PINNED BAR NEEDS IS NOT THIS PAGE'S TO GIVE.

        A spacer here was the second wrong answer. The first put the clearance on
        the board column, so on a phone it landed *between* the board and the
        rail and everything after it — including the ODbL attribution — scrolled
        under an opaque bar. Moving it to the end of the page fixed the
        attribution and not the footer, because the footer is rendered by the
        chrome, **after** `</main>`, and a spacer inside `<main>` structurally
        cannot clear something outside it. The site-wide "check anything you are
        booking against the official source" disclaimer stayed uncoverable.

        The clearance now lives on the footer itself, which is genuinely the last
        element in the document. It costs a little dead space at the bottom of
        pages that pin nothing, which is invisible because it is below the last
        line of content — and is a great deal better than a licence notice and a
        staleness warning nobody can read.
      */}
    </div>
  );
}

/**
 * The measured journeys, listed rather than summarised.
 *
 * Bounded to a handful because the rail is a summary column and a long list
 * belongs in the board — and because transit evidence is sparse by design, so a
 * handful is usually all there is.
 */
function TransitPanel({
  evidence,
  places,
  bases,
}: {
  evidence: NonNullable<CompiledRegion['transitEvidence']>;
  places: CompiledRegion['places'];
  bases: CompiledRegion['bases'];
}) {
  /*
   * Both id spaces, because journeys are measured in both directions: the way
   * home has `toId` = the base's routing id, which is not a place id — so half
   * this panel used to read "Somewhere on the board", which is a placeholder
   * wearing a fact's clothing on the exact panel meant to prove the transit
   * claim. Outbound journeys only (a destination is what a traveller scans
   * for), and a journey nothing can name is dropped rather than shrugged at.
   */
  const nameOf = new Map([
    ...places.map((place) => [place.id, place.name] as const),
    ...bases.map((base) => [base.routingId, base.name] as const),
  ]);
  const baseIds = new Set(bases.map((base) => base.routingId));
  const measured = evidence.journeys
    .filter(
      (journey) =>
        journey.status === 'measured' &&
        !baseIds.has(journey.toId) &&
        nameOf.has(journey.toId),
    )
    .slice(0, 6);
  return (
    <Panel className="p-5" data-testid="transit-panel">
      <p className="eyebrow">Getting around by public transport</p>
      <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
        Journeys from where you are staying, checked against published timetables for a weekday
        morning. A different time of day is a different journey.
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {measured.map((journey) => (
          <li key={`${journey.fromId}-${journey.toId}`} className="text-ink">
            <span className="text-ink-muted">{nameOf.get(journey.toId)}</span>
            {' — '}
            {formatMinutes(journey.minutes ?? 0)}
            {typeof journey.transfers === 'number' ? (
              <span className="text-ink-faint">
                {journey.transfers === 0
                  ? ', no changes'
                  : `, ${journey.transfers} change${journey.transfers === 1 ? '' : 's'}`}
              </span>
            ) : null}
            {typeof journey.walkingMinutes === 'number' && journey.walkingMinutes > 0 ? (
              <span className="text-ink-faint">
                {' '}
                including {formatMinutes(journey.walkingMinutes)} on foot
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {evidence.measured > measured.length ? (
        <p className="mt-3 text-xs text-ink-faint">
          {evidence.measured - measured.length} more were checked.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * What the board says about getting around by public transport.
 *
 * One sentence, and it never implies more than was measured. A measured count is
 * the only case that states a number; every other case names the reason and
 * stops, because "we could not check" and "there is nothing to catch" are
 * different facts and a traveller plans differently around each.
 */
function transitSummaryFor(evidence: NonNullable<CompiledRegion['transitEvidence']>): string {
  if (evidence.measured > 0) {
    const total = evidence.requested;
    return `${evidence.measured} of ${total} journeys checked against timetables`;
  }
  /**
   * THE ONE CASE WHERE THE PRODUCT LEARNED SOMETHING AND USED TO DISCARD IT.
   *
   * A run where every journey came back `no_route` is a run where a provider
   * answered, in coverage, and the answer was "there is no way to do this by
   * public transport". For a car-free traveller that is the single most
   * trip-defining thing the compiler found — and it fell into the vague default
   * below, which says nothing came back. Something came back; it was bad news.
   */
  const asked = evidence.journeys.length;
  const noService = evidence.journeys.filter((journey) => journey.status === 'no_route').length;
  if (asked > 0 && noService === asked) {
    return `We checked ${asked} ${asked === 1 ? 'journey' : 'journeys'} and found no public-transport service for any of them`;
  }

  switch (evidence.absence) {
    case 'unsupported':
      /*
       * Scoped to journeys, not to the trip.
       *
       * This used to end "so treat any journey time as a guess", which is a
       * claim about *every* number on the board — including the road or walking
       * times that were genuinely measured. A caveat about a capability this
       * build lacks must not cast doubt on the evidence it has.
       */
      return 'Not verified — we cannot check timetables here, so any public-transport journey is unmeasured';
    case 'out_of_coverage':
      return 'Not verified — we hold no timetables for this area';
    case 'budget_exhausted':
      return 'Not verified — we stopped before checking any journeys';
    case 'not_needed':
      return 'Not checked — this trip is planned around a car';
    default:
      return 'Not verified — nothing came back for the journeys we asked about';
  }
}

/**
 * THE WEATHER, AS A STORED RESULT WITH A BUTTON BESIDE IT.
 *
 * This panel is the visible half of the render-purity fix. Rendering this page
 * used to fetch a forecast, because resolving the region did — so a reload was
 * an outbound request, a slow provider was a slow page, and the numbers moved
 * underneath a plan that had been built against different ones. None of that was
 * ever offered to the traveller as a choice, because it did not look like one.
 *
 * Now it is one. Four states, and each says exactly what it knows:
 *
 *   - **not fetched** — no claim about the weather at all, and a button.
 *   - **fresh** — when it was fetched, from whom, with the licence notice.
 *   - **stale** — the same, labelled old, with the button still there. Nothing
 *     refreshes on its own: a render that repaired its own staleness would be
 *     the original defect wearing a different name.
 *   - **expired** — past the window it was good for, so the numbers are gone
 *     rather than caveated.
 *
 * A refresh replaces this snapshot and touches nothing else. It does not
 * re-plan, does not rewrite the compiled region, and does not change a single
 * item on a stored itinerary — a newer forecast is a reason to look again, not a
 * licence to edit somebody's trip while they are reading it.
 */
function WeatherPanel({
  tripId,
  availability,
}: {
  tripId: string;
  availability: WeatherAvailability;
}) {
  /*
   * The sentence is decided in core, from all three inputs.
   *
   * This used to be built here from `kind` and `state` alone — two of the three
   * things that decide it. The third is whether the stored dataset holds
   * anything, and reading only two produced "Weather: fetched · Fetched recently
   * enough to rely on" above a dataset in which every day was `unavailable`,
   * which is what a switched-off provider returns. `weatherPanelCopy` reads the
   * coverage and the refresh status as well, so the heading cannot contradict the
   * rows beneath it.
   */
  const { heading, body, showNumbers } = weatherPanelCopy(availability);

  /*
   * `showNumbers` rather than "is there a snapshot". An expired snapshot, and one
   * that came back empty, both still have a row — and the fetched-at, provider and
   * points-sampled list beneath is a claim that we hold numbers for these dates.
   */
  const snapshot = availability.kind === 'present' && showNumbers ? availability.snapshot : null;

  /*
   * The attempt is worth reporting even when the numbers are not.
   *
   * A failed refresh on a trip that had never fetched now writes a row whose every
   * day states its own absence — so this is the one thing that must render from a
   * snapshot `showNumbers` has excluded, or the failure would be invisible again.
   */
  const attempt = availability.kind === 'present' ? availability.snapshot.refresh : null;

  return (
    <Panel className="p-4" testId="weather-snapshot">
      <h3 className="text-sm font-medium text-ink">{heading}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>

      {snapshot ? (
        <dl className="mt-3 space-y-1 text-xs text-ink-faint">
          <div>
            <dt className="inline">Fetched </dt>
            <dd className="inline">
              <time dateTime={snapshot.fetchedAt}>{utcStamp(snapshot.fetchedAt)}</time>
            </dd>
          </div>
          <div>
            <dt className="inline">Source </dt>
            <dd className="inline">
              {snapshot.provider}
              {snapshot.model ? ` · ${snapshot.model}` : ''}
            </dd>
          </div>
          <div>
            <dt className="inline">Points sampled </dt>
            <dd className="inline">{snapshot.locations.length}</dd>
          </div>
        </dl>
      ) : null}

      {attempt && attempt.status !== 'succeeded' && attempt.message ? (
        <p className="mt-3 text-xs leading-relaxed text-clay" data-testid="weather-attempt">
          {attempt.message}
        </p>
      ) : null}

      {/*
       * A form rather than an anchor, because this is not navigation: it spends
       * a request and writes a row, and the affordance has to say so.
       *
       * The button is a client component for one reason: it has to be able to
       * say it is working. A control that reaches a provider and then repaints
       * the page some seconds later, with nothing in between, is
       * indistinguishable from one that does nothing — so people press it again,
       * which is a second request they did not intend to spend.
       */}
      <form action={refreshWeatherFormAction.bind(null, tripId)} className="mt-3">
        <BusyFormSubmit
          testId="weather-refresh"
          idleLabel={availability.kind === 'absent' ? 'Fetch the weather' : 'Fetch it again'}
          busyLabel="Fetching the weather…"
        />
      </form>

      {snapshot && snapshot.attribution.length > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          {snapshot.attribution.map((entry) => entry.notice).join(' · ')}
        </p>
      ) : null}
    </Panel>
  );
}

/** An absolute instant, in UTC, with no "2 hours ago" anywhere near it. */
function utcStamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}
