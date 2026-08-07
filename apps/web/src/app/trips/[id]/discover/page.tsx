import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  autoSelect,
  countTripDays,
  readBoardIntegrity,
  tripPersonality,
  type SelectionStatus,
} from '@sidequest/core';
import { DiscoveryBoardView } from '@/components/DiscoveryBoardView';
import { BoardIntegrityPanel } from '@/components/BoardIntegrityPanel';
import { acceptedImagesFor } from '@/lib/db/imagery-repository';

import { FoodStopsBoard, type FoodChoiceMap } from '@/components/FoodStopsBoard';
import { TripPersonalityCard } from '@/components/QuestionnaireWizard';
import { Panel, buttonClass } from '@/components/ui';
import { formatDateRange, formatMinutes } from '@/lib/format';
import {
  getFoodSelections,
  getProfile,
  getSelections,
  getTrip,
  hasItinerary,
  getReadiness,
} from '@/lib/db/repository';
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
  type WeatherAvailability,
} from '@sidequest/core';
import { boardFor, compiledRegionFor, resolveTripRegion } from '@/lib/region';
import { refreshWeatherFormAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function DiscoverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = getTrip(id);
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
  const suggestion = autoSelect({ candidates: board.candidates, profile, tripDays: days });
  const personality = tripPersonality(profile, days);

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
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      {/*
       * Rendered whenever there is an account with anything in it, not only
       * when something changed.
       *
       * `hasChanges` used to gate this, which meant a traveller who marked
       * twelve places and got all twelve back saw nothing at all — and, more to
       * the point, could not reach "the full record of what I told you", which
       * is the one thing this panel promises unconditionally. A build where
       * nothing was lost is a result worth stating rather than a reason to say
       * nothing; the panel's own copy already adapts to it.
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
            /*
             * THE EMPTY BOARD, EXPLAINED BY THE THING THAT IS ACTUALLY BINDING.
             *
             * What was here named three causes at once — "closed for the season,
             * past how far you will travel, or beyond the effort level you set"
             * — and offered one link that could change two of them. On the one
             * synthetic world that reaches this state every place is *inside* the
             * radius and simply too far to get to and back from, so two of the
             * three named causes were false and the remedy for the true one was
             * not among the ones offered.
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
               * A row lookup, never a resolution: identity was established when
               * the region was compiled, and a page that could resolve one would
               * do it per card, per refresh, per visitor. The board falls back to
               * a coordinate-derived graphic for anything with no accepted row,
               * so an empty table costs nothing.
               */
              images={acceptedImagesFor(
                board.candidates.map((candidate) => ({
                  kind: 'candidate' as const,
                  id: candidate.place.id,
                })),
              )}
              groups={board.groups}
              initialSelections={selections}
              autoPickNotes={suggestion.notes}
              targetCount={suggestion.targetCount}
              hasItinerary={planned}
              weatherBackups={boardWeatherBackups(board.candidates)}
              storedReadiness={getReadiness(id)}
            />
          )}

          {foodStops.length > 0 ? (
            <FoodStopsBoard tripId={id} entries={foodStops} initialChoices={foodChoices} />
          ) : null}
        </div>

        <aside className="order-1 space-y-6 lg:order-2 lg:sticky lg:top-6">
          {/*
            Beside the board rather than above it when there *is* a board: the
            question "how much is here" is context for the cards, not a warning
            in front of them. When there is no board it takes the board's place
            instead, which is the only time it is the whole answer.
          */}
          {workable.length > 0 ? (
            <BoardIntegrityPanel tripId={id} reading={integrity} />
          ) : null}

          <div>
            <h2 className="font-display text-lg text-ink">Your trip personality</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Everything on the board is ranked against this.
            </p>
            <div className="mt-3">
              <TripPersonalityCard personality={personality} />
            </div>
          </div>

          <WeatherPanel tripId={id} availability={resolved.context.weatherAvailability} />

          {closed.length > 0 ? (
            <Panel className="p-4">
              <h3 className="text-sm font-medium text-ink">
                {closed.length} {closed.length === 1 ? 'place is' : 'places are'} shut on your dates
              </h3>
              {/*
               * The sentence here used to be "Snow closes most of this region
               * for months at a time" — a claim about one mountain range,
               * rendered on a page that now compiles anywhere on earth. It read
               * as a fact and was a leftover from the days when the product knew
               * one destination. The generic form says the same useful thing:
               * these are shut, we are telling you rather than hiding them, and
               * the per-place reason is on the card where it belongs.
               */}
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                Each of these is closed on your dates for a reason we can point at. They are listed
                under “Probably skip” with that reason, rather than hidden.
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
    </div>
  );
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
