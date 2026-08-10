'use client';

import { useOptimistic, useState, useTransition } from 'react';
import {
  ACCESS_BADGE_LABELS,
  BOARD_GROUP_COPY,
  FACT_PATH_LABELS,
  FACT_VERIFICATION_LABELS,
  FIT_BAND_LABELS,
  FIT_BAND_METER,
  MONEY_UNIT_LABELS,
  OPERATING_BADGE_LABELS,
  PLACE_CATEGORY_LABELS,
  PLACE_WEATHER_BADGE_LABELS,
  SELECTION_STATUSES,
  SELECTION_STATUS_LABELS,
  WORTH_DETOUR_COPY,
  imageryFallbackFor,
  summariseSelections,
  summaryVersion,
  type DestinationImage as ImageRecord,
  type AccessBadge,
  type BoardGroup,
  type BoardWeatherBackups,
  type DiscoveryCandidate,
  type OperatingBadge,
  type PlaceWeatherBadge,
  type SelectionStatus,
  type PlannerReadiness,
  type WeatherSnapshotState,
  type ClosureEvidence,
  type SafetyEvidence,
} from '@sidequest/core';
import {
  Badge,
  ErrorNote,
  FitMeter,
  FitMeterLegend,
  Panel,
  PlacePlate,
  buttonClass,
  cx,
  type BadgeTone,
} from './ui';
import {
  BoardFilterRail,
  NO_FILTERS,
  anyFilterActive,
  facetsFor,
  filterCandidates,
  type BoardFilterState,
} from './BoardFilters';
import { DestinationImage } from './DestinationImage';
import { BuildTripButton, PlannerReadinessPanel } from './BuildTripButton';
import { formatCost, formatDistance, formatIntensity, formatMinutes } from '@/lib/format';
import { autoPickAction, setSelectionAction } from '@/app/(product)/trips/[id]/discover/actions';

export interface SerializedGroup {
  group: BoardGroup;
  candidates: DiscoveryCandidate[];
}

type SelectionMap = Record<string, SelectionStatus | undefined>;

/**
 * The smallest a control on this board may be.
 *
 * WCAG 2.5.5's 44 px. The three decision buttons under every card were 28 —
 * three targets side by side inside a card that is itself half a phone wide,
 * which is the exact situation the criterion exists for. `min-h-11` grows the
 * target without growing the type.
 */
const MIN_TARGET = 'min-h-11';

/**
 * The same floor, for a `<summary>`.
 *
 * Padding rather than a flex box: a summary is a `display: list-item`, and
 * making it flex removes the disclosure triangle in every WebKit-derived
 * browser. A 44 px target that no longer looks like a control is not a fix.
 */
const MIN_TARGET_SUMMARY = 'min-h-11 py-2.5';

export function DiscoveryBoardView({
  tripId,
  storedReadiness,
  groups,
  initialSelections,
  autoPickNotes,
  targetCount,
  hasItinerary,
  weatherBackups,
  boardVersion: declaredVersion,
  weatherFreshness,
  images = {},
}: {
  tripId: string;
  /**
   * How old the weather behind this board is, when the page knows.
   *
   * Four states and they are not degrees of one thing. `not_fetched` and
   * `expired` never reach here with numbers attached — `resolveTripRegion`
   * substitutes an unfetched dataset for both, so every card reads "we have not
   * checked" — but `stale` does: a snapshot past its freshness window is still
   * rendered, badges and all, and without this the board says "the forecast
   * works against X on your dates" about a forecast fetched days ago in exactly
   * the same voice it uses for one fetched a minute ago.
   *
   * Optional, and its absence means the board says nothing about age rather than
   * asserting freshness it was not told about.
   */
  weatherFreshness?: WeatherSnapshotState | 'not_fetched';
  /**
   * The artifact this board was projected from, when the page knows it.
   *
   * Optional, and its absence is not a hole: when nothing is declared the
   * version is derived from the cards actually rendered, which is the same
   * identity by a longer route. Passing the compiled region's id makes the stamp
   * name something an operator can look up, and is the preferred form.
   */
  boardVersion?: string;
  /** The last refusal, from the database, so it survives a refresh. */
  storedReadiness?: PlannerReadiness | null;
  groups: SerializedGroup[];
  /**
   * Derived from this trip's weather, not from what any place fundamentally is.
   * Null when nothing on the board is in trouble, which is most of the time.
   */
  weatherBackups: BoardWeatherBackups | null;
  initialSelections: SelectionMap;
  autoPickNotes: string[];
  targetCount: number;
  hasItinerary: boolean;
  /**
   * Licensed photographs by place id, read from a table by the page.
   *
   * Optional and empty by default, and that default is the honest one: an
   * artifact compiled before imagery existed has no rows, and every card on it
   * renders exactly as it always did. There is no migration, no backfill and no
   * version check — the absence of a photograph was already a supported state.
   */
  images?: Record<string, ImageRecord>;
}) {
  /*
   * THE VERSION EVERY NUMBER ON THIS SCREEN BELONGS TO.
   *
   * Derived from the cards actually rendered when the page does not declare one,
   * so the identity moves exactly when the board does and not when a traveller
   * marks something. That distinction is the whole point: a mark changes the
   * counts, a rebuild changes what the counts are counting, and the second one
   * has to invalidate everything derived from the first.
   */
  const cardIds = groups.flatMap((entry) => entry.candidates.map((c) => c.place.id));
  const boardVersion = summaryVersion([declaredVersion ?? '', ...cardIds]);

  /*
   * THE MIRROR CANNOT OUTLIVE WHAT IT MIRRORS.
   *
   * `useState(initialSelections)` seeded once and never again, so a rebuilt
   * board kept the previous board's marks and the previous board's totals — and
   * a stale "12 in" beside a board of nine cards reads as a fact. The mirror is
   * keyed to the server state it was derived from and dropped the moment either
   * the board version or the stored marks change identity.
   *
   * It exists at all for one reason, which is still true: `autoPickAction`
   * returns what it stored, and adopting that immediately is what makes the
   * board's counts move on the click rather than on the round trip.
   */
  const serverKey = summaryVersion([boardVersion, marksFingerprint(initialSelections)]);
  const [mirror, setMirror] = useState<{ key: string; value: SelectionMap; notes: string[] }>({
    key: serverKey,
    value: initialSelections,
    notes: autoPickNotes,
  });
  if (mirror.key !== serverKey) {
    setMirror({ key: serverKey, value: initialSelections, notes: autoPickNotes });
  }
  const settled = mirror.key === serverKey ? mirror : { value: initialSelections, notes: autoPickNotes };
  const selections = settled.value;
  const notes = settled.notes;

  const [optimistic, applyOptimistic] = useOptimistic(
    selections,
    (current: SelectionMap, patch: SelectionMap) => ({ ...current, ...patch }),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [onlyIncluded, setOnlyIncluded] = useState(false);
  /*
   * Filters are view state and nothing else.
   *
   * Held here, beside the marks rather than inside them, because hiding a card
   * must never look like a decision about it. `filterCandidates` returns a
   * subset; clearing a filter brings every card back marked exactly as it was.
   */
  const [filters, setFilters] = useState<BoardFilterState>(NO_FILTERS);
  /*
   * WHY THE LAST BUILD REFUSED, HELD HERE RATHER THAN INSIDE THE BUTTON.
   *
   * Seeded from the database so a refusal survives a refresh — a finding that
   * does not outlive a reload is not much of one — and held at board level so
   * the panel can render in the flow rather than inside the bar that is pinned
   * to the top of the viewport. A `ready` reading is not a finding and shows
   * nothing.
   */
  const [readiness, setReadiness] = useState<PlannerReadiness | null>(
    storedReadiness && storedReadiness.level !== 'ready' ? storedReadiness : null,
  );

  /*
   * Counted over the cards on screen, not over the keys of the mark map.
   *
   * The map is trip-scoped and outlives every board it was written against, so
   * counting its values reported decisions about places this board does not
   * have — which is how the header claimed more picks than there were cards.
   */
  const summary = summariseSelections({
    boardVersion,
    cardIds,
    statuses: SELECTION_STATUSES,
    selections: optimistic,
  });
  const includedCount = summary.counts.included;
  const maybeCount = summary.counts.maybe;

  function choose(placeId: string, status: SelectionStatus) {
    const next = optimistic[placeId] === status ? undefined : status;
    const previous = selections;
    setError(null);
    startTransition(async () => {
      applyOptimistic({ [placeId]: next });
      const result = await setSelectionAction(tripId, placeId, next ?? null);
      if (result.ok) {
        setMirror((current) => ({ ...current, value: { ...current.value, [placeId]: next } }));
      } else {
        // Roll the card back rather than showing a state the server does not have.
        setMirror((current) => ({ ...current, value: previous }));
        setError(result.error ?? 'That choice did not save.');
      }
    });
  }

  function autoPick() {
    setError(null);
    startTransition(async () => {
      const result = await autoPickAction(tripId);
      if (!result.ok || !result.selections) {
        setError(result.error ?? 'We could not build a selection just then.');
        return;
      }
      // Adopt what the server actually stored, which preserves any card the
      // traveller had already decided on by hand. Keyed to the board it was
      // computed for, so a rebuild discards it rather than carrying it across.
      setMirror((current) => ({
        key: current.key,
        value: result.selections!,
        notes: result.notes ?? [],
      }));
    });
  }

  const allCandidates = groups.flatMap((entry) => entry.candidates);
  const facets = facetsFor(allCandidates);
  const visibleGroups = groups
    .map((entry) => ({
      ...entry,
      candidates: filterCandidates(
        onlyIncluded
          ? entry.candidates.filter((candidate) => optimistic[candidate.place.id] === 'included')
          : entry.candidates,
        filters,
      ),
    }))
    .filter((entry) => entry.candidates.length > 0);
  const visibleCardCount = visibleGroups.reduce((total, entry) => total + entry.candidates.length, 0);
  const filtered = anyFilterActive(filters) || onlyIncluded;

  /*
   * THE WEATHER SENTENCE THAT BELONGS TO THE BOARD, NOT TO A CARD.
   *
   * Seventeen cards carried the identical thirty-word paragraph "We could not
   * reach a weather source for your dates…" — about five hundred words of the
   * same sentence, repeated down a page whose job is to let somebody compare
   * seventeen different places. A fact that is true of the whole board is a
   * property of the board.
   */
  const boardWeather = sharedWeatherNote(allCandidates);

  return (
    <div data-testid="discovery-board" data-board-version={boardVersion}>
      {/*
        THE ACTION BAR: STICKY AT THE TOP ON A DESKTOP, PINNED TO THE BOTTOM ON A PHONE.

        One element, two positions. It was `sm:sticky`, which means *not* sticky
        at the one width where it matters: on a 390px screen the board is some
        twenty-five thousand pixels tall, and the count and the primary action
        scrolled away after the first card and never came back. A traveller
        marking their ninth place had no way of knowing how many they had, and no
        way to build without scrolling to the top of a page thirty screens long.

        Deliberately not a second copy of the toolbar. Two "Build my trip"
        buttons would be two things the traveller has to reconcile — and, more
        practically, an ambiguous target for anything that goes looking for the
        button by name.

        Only the count and the build action live here. Auto-pick and the filters
        sit in the flow below, because they are things you do once while reading
        rather than things you reach for from the bottom of the screen.
      */}
      <Panel
        className={cx(
          // Below the product header (`z-30`), above the cards. Equal z-indexes
          // made the two sticky bars fight over which one painted on top.
          'z-20 flex flex-wrap items-center gap-x-5 gap-y-3 p-4',
          'sm:sticky sm:top-[var(--chrome-height)] sm:mb-6',
          'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[70vh]',
          'max-sm:overflow-y-auto max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0',
          'max-sm:shadow-panel print:hidden',
        )}
        testId="board-action-bar"
      >
        {/*
          The count and the version it describes, from one object.

          They cannot disagree because `summary` produced both. The stamp is what
          makes that checkable from outside — a stale total beside a rebuilt
          board is invisible to review and obvious to an assertion.
        */}
        <p className="text-sm text-ink" data-testid="board-summary" data-board-version={summary.boardVersion}>
          <strong className="font-display text-lg">{includedCount}</strong> in
          {maybeCount > 0 ? <span className="text-ink-muted"> · {maybeCount} maybe</span> : null}
          <span className="text-ink-faint"> · we suggested {targetCount}</span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <BuildTripButton
            tripId={tripId}
            hasItinerary={hasItinerary}
            includedCount={includedCount}
            onReadiness={setReadiness}
          />
        </div>
      </Panel>

      {/* Below the bar, in the flow, where a long explanation may be long. */}
      {readiness ? <PlannerReadinessPanel readiness={readiness} /> : null}

      {/*
        The things you do once, in the flow, where they do not compete with the
        primary action for the bottom of a phone screen.
      */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 print:hidden">
        <label
          className={cx(
            'flex cursor-pointer items-center gap-2 px-1 text-sm text-ink-muted',
            MIN_TARGET,
          )}
        >
          <input
            type="checkbox"
            checked={onlyIncluded}
            onChange={(event) => setOnlyIncluded(event.target.checked)}
            className="h-5 w-5 accent-[var(--color-pine)]"
          />
          Only what I picked
        </label>
        <button
          type="button"
          onClick={autoPick}
          disabled={pending}
          className={cx(buttonClass('secondary', 'sm'), MIN_TARGET)}
        >
          {pending ? 'Working…' : 'Auto-pick the best mix for me'}
        </button>
        <FitMeterLegend className="basis-full" />
      </div>

      <BoardFilterRail
        facets={facets}
        filters={filters}
        onChange={setFilters}
        showing={visibleCardCount}
        total={allCandidates.length}
      />

      {/*
        The board-level weather statement, once.

        The cards it covers say nothing about the weather at all; a card whose
        situation differs from this one still carries its own sentence and its own
        badge, which is the only way the difference is legible.
      */}
      {boardWeather ? (
        <p
          className="mb-8 rounded-md bg-paper-sunk p-3 text-sm leading-relaxed text-ink-muted"
          data-testid="board-weather-note"
        >
          {boardWeather}
        </p>
      ) : null}

      {/*
        A polite status line, and the only thing on this board that speaks.

        Every decision here moves a count, sometimes empties a group and — under
        "Only what I picked" — can empty the whole board. None of that reached a
        screen reader: the totals are plain text and a filtered card simply
        vanishes from the DOM, so a keyboard user pressing Skip got silence and a
        page that had quietly rearranged itself beneath them.

        The state *after* the change rather than the change itself, so three
        quick decisions announce one settled result instead of racing each other.
        An error takes precedence, because a failed save is the one thing here
        somebody has to hear.
      */}
      {/*
        Phrased as a sentence, not as a copy of the counter beside it.
        Two reasons, and both are about the person hearing it. A live region that
        repeats the visible summary verbatim is announced *twice* — once as the
        element, once as the change — and "9 in, 0 maybe" read aloud out of
        context is a sequence of numbers rather than a statement. And a second
        node carrying the same leading text made every `getByText(/^\d+ in/)` in
        the suite ambiguous, which is the sort of collision that is invisible
        until four specs fail at once.
      */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="board-status">
        {error
          ? error
          : `Your board now has ${includedCount} places included and ${maybeCount} marked maybe, out of ${summary.onBoard}. ${visibleCardCount} showing.`}
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {notes.length > 0 ? (
        <ul
          className="mb-8 space-y-1.5 border-l-2 border-pine pl-4 text-sm leading-relaxed text-ink-muted"
          data-board-version={summary.boardVersion}
        >
          {notes.map((note) => (
            <li key={`${summary.boardVersion}:${note}`}>{note}</li>
          ))}
        </ul>
      ) : null}

      {/*
        Decisions about places this board does not hold.

        Named as history rather than folded into "N in". They are real choices
        somebody made — about a card an earlier build had, or about a place this
        trip's answers now rule out — and the count that quietly included them
        was describing a board nobody was looking at.
      */}
      {summary.carriedOver > 0 ? (
        <p
          className="mb-8 text-xs leading-relaxed text-ink-faint"
          data-testid="board-carried-over"
          data-board-version={summary.boardVersion}
        >
          You have also decided on {summary.carriedOver}{' '}
          {summary.carriedOver === 1 ? 'place' : 'places'} that is not on this board. Those
          choices are kept and are not counted above.
        </p>
      ) : null}

      {visibleGroups.length === 0 ? (
        <Panel className="p-8 text-center">
          <p className="font-display text-lg text-ink">
            {filtered ? 'Nothing matches what you asked for' : 'Nothing here fits this trip'}
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            {filtered
              ? 'Every card is still on the board — clear the filters above to see them again, or use auto-pick for a starting set.'
              : 'Try widening how far you will travel, or moving your dates — some of what we found here is only reachable for part of the year.'}
          </p>
        </Panel>
      ) : (
        <div className="space-y-14">
          {visibleGroups.map((entry) => (
            <section key={entry.group} aria-labelledby={`group-${entry.group}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 id={`group-${entry.group}`} className="font-display text-2xl text-ink">
                  {BOARD_GROUP_COPY[entry.group].title}
                </h2>
                <span className="text-sm text-ink-faint">{entry.candidates.length}</span>
              </div>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                {BOARD_GROUP_COPY[entry.group].blurb}
              </p>
              {/*
                THINGS TO SKIP DO NOT GET THE SAME SPACE AS THINGS TO DO.

                Six full cards — image, description, fit panel, evidence — is
                about two thousand pixels arguing for places we have just
                explained are wrong for this trip, laid out identically to the
                places we are recommending. The group is still complete, still
                explained and still re-includable; it is simply a list, because
                the decision it asks for is "no, unless" rather than "yes or no".
              */}
              {entry.group === 'weak_fit' ? (
                <ul className="mt-5 space-y-2" data-testid="skip-list">
                  {entry.candidates.map((candidate) => (
                    <li key={candidate.place.id}>
                      <SkipRow
                        candidate={candidate}
                        status={optimistic[candidate.place.id]}
                        onChoose={choose}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {entry.candidates.map((candidate) => (
                    <PlaceCard
                      key={candidate.place.id}
                      candidate={candidate}
                      image={anchorImage(images, candidate)}
                      status={optimistic[candidate.place.id]}
                      onChoose={choose}
                      {...(boardWeather ? { boardWeatherNote: boardWeather } : {})}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}

          <WeatherBackups
            backups={weatherBackups}
            selections={optimistic}
            onChoose={choose}
            {...(weatherFreshness ? { freshness: weatherFreshness } : {})}
          />

          <WeatherCredit groups={groups} {...(weatherFreshness ? { freshness: weatherFreshness } : {})} />
        </div>
      )}
    </div>
  );
}

/**
 * The identity of a set of decisions, so a change made elsewhere is visible.
 *
 * Sorted before hashing: `Object.entries` follows insertion order, and two
 * sessions that recorded the same choices in a different order hold the same
 * state. Cleared entries are omitted, because `undefined` and absent are one
 * thing here.
 */
function marksFingerprint(selections: SelectionMap): string {
  return summaryVersion(
    Object.entries(selections)
      .filter((entry): entry is [string, SelectionStatus] => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .flat(),
  );
}

/**
 * THE WEATHER SENTENCE EVERY CARD WAS CARRYING A COPY OF.
 *
 * Returns the note that is true of the board as a whole, or null when the cards
 * genuinely differ. The threshold is deliberately high: a note has to be on most
 * of the cards *and* on at least three of them before it is treated as a
 * board-level fact, because hoisting a sentence that applies to two of seventeen
 * places would be the opposite mistake — a claim about the board made from a
 * minority of it.
 *
 * Nothing is dropped. A card whose note differs still prints its own, and the
 * per-card weather badges are untouched.
 */
function sharedWeatherNote(candidates: readonly DiscoveryCandidate[]): string | null {
  const notes = candidates.map((candidate) => candidate.weather.note).filter(Boolean) as string[];
  if (notes.length < 3) return null;
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note, (counts.get(note) ?? 0) + 1);
  let best: { note: string; count: number } | null = null;
  for (const [note, count] of counts) {
    if (!best || count > best.count) best = { note, count };
  }
  if (!best) return null;
  return best.count >= 3 && best.count >= candidates.length * 0.6 ? best.note : null;
}

/**
 * THE PART A PLACE PLAYS IN THE TRIP, ON THE CARD.
 *
 * The board already sorts every candidate into exactly one group, and the group
 * *is* the role — classic, hidden gem, side quest, rainy-day backup. That was
 * legible only from the section heading, which is off-screen the moment you have
 * scrolled two rows, so a card in isolation could not say whether it was a famous
 * stop or a quiet find. This reads `candidate.group` and nothing else: no score
 * is invented and no threshold is applied here.
 */
const ROLE_BADGE: Record<BoardGroup, { label: string; tone: BadgeTone } | null> = {
  must_see_classics: { label: 'Classic', tone: 'neutral' },
  hidden_gems: { label: 'Hidden gem', tone: 'amber' },
  nearby_side_quests: { label: 'Side quest', tone: 'blue' },
  scenic_detours: { label: 'Scenic detour', tone: 'blue' },
  low_effort_backups: { label: 'Rainy-day backup', tone: 'blue' },
  needs_verification: { label: 'Check first', tone: 'amber' },
  // The skip list says what it is in its own heading and needs no chip.
  weak_fit: null,
};

/**
 * Which access facts earn a badge, in the order they matter to a decision.
 *
 * `shuttle_available` and `no_transit` are deliberately absent: "there is also a
 * bus" and "there is no bus" are true of almost every card here, and a badge
 * that is always on is a badge nobody reads. They appear in the card's cautions
 * instead, where they belong.
 */
const ACCESS_BADGE_ORDER: readonly AccessBadge[] = [
  'shuttle_required',
  'car_required',
  'seasonal_service',
  'permit_required',
  'verify_conditions',
];

const ACCESS_BADGE_TONE: Record<AccessBadge, BadgeTone> = {
  car_required: 'neutral',
  shuttle_required: 'blue',
  shuttle_available: 'blue',
  seasonal_service: 'amber',
  no_transit: 'neutral',
  permit_required: 'amber',
  verify_conditions: 'amber',
};

/**
 * Which opening-hours facts earn a badge.
 *
 * `always_open` earns nothing at all, which is the point. Nineteen of the
 * twenty-two places in this region have no closing time, and stamping "Open 24
 * hours" across the board would drown the three cards where the hours genuinely
 * decide whether the day works.
 */
/**
 * Weather badge tones, in the same vocabulary as everything else on a card:
 * pine confirms, blue offers an alternative, amber cautions, neutral states a
 * fact. Capped at three per card upstream, and `workable` weather earns nothing
 * — the board already carries access and hours badges, and a card wearing eight
 * of them communicates less than one wearing two.
 */
const WEATHER_BADGE_TONE: Record<PlaceWeatherBadge, BadgeTone> = {
  best_on_a_day: 'pine',
  good_in_the_forecast: 'pine',
  poor_in_the_forecast: 'amber',
  visibility_dependent: 'neutral',
  poor_weather_friendly: 'blue',
  daylight_only: 'neutral',
  seasonal_pattern: 'neutral',
  weather_unknown: 'neutral',
};

/**
 * What to have in reserve, if the weather takes something.
 *
 * A cross-cut rather than a group: every place here already has a primary
 * section above, and the point is precisely that the good bad-weather options
 * are scattered across "hidden gems", "must-see classics" and "scenic detours"
 * where nobody would think to look for them on a wet morning. So this is a list
 * of names rather than a second set of cards — duplicating twenty-three cards to
 * surface four of them would make the board longer and less useful.
 *
 * It appears only when something is actually at risk, and the two registers are
 * kept apart because they are different claims: a forecast is about *your dates*,
 * a seasonal pattern is about *this time of year* and is preparation rather than
 * prediction.
 *
 * Nothing here is scheduled, and saying so is not pedantry — a traveller who
 * reads this as "we have handled it" would arrive expecting a plan that does not
 * exist.
 */
function WeatherBackups({
  backups,
  selections,
  onChoose,
  freshness,
}: {
  backups: BoardWeatherBackups | null;
  selections: SelectionMap;
  onChoose: (placeId: string, status: SelectionStatus) => void;
  freshness?: WeatherSnapshotState | 'not_fetched';
}) {
  if (!backups) return null;

  // Filtered against live state rather than the server's snapshot, so a place
  // the traveller has just ruled out disappears from here immediately. Offering
  // somebody a fallback they have already said no to teaches them their answers
  // are decorative.
  const usable = backups.suggestions.filter(
    (backup) => selections[backup.placeId] !== 'excluded',
  );
  const atRisk = backups.atRisk.filter((entry) => selections[entry.placeId] !== 'excluded');
  if (atRisk.length === 0) return null;

  const forecast = backups.evidence === 'forecast';

  return (
    <section aria-labelledby="weather-backups" className="border-t border-rule pt-8">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="weather-backups" className="font-display text-2xl text-ink">
          If the weather turns
        </h2>
        <Badge tone={forecast ? 'blue' : 'neutral'}>
          {forecast ? 'Forecast' : 'Seasonal pattern'}
        </Badge>
        {/*
          The age of the evidence, beside the kind of it.

          A stale snapshot renders — that is deliberate, an old forecast is worth
          more than none — and it must not render in the same voice as a fresh
          one. Without this the badge said "Forecast" whether it was fetched a
          minute ago or last week.
        */}
        {forecast && freshness === 'stale' ? (
          <Badge tone="amber">Fetched a while ago</Badge>
        ) : null}
      </div>

      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        {forecast
          ? `The forecast works against ${listNames(atRisk.map((entry) => entry.name))} on your dates.`
          : `${listNames(atRisk.map((entry) => entry.name))} can be a washout at this time of year — this is preparation, not a forecast for your dates.`}{' '}
        {usable.length > 0
          ? 'These hold up better, and are near enough to swap in on the morning. Nothing here is scheduled.'
          : ''}
      </p>

      {usable.length === 0 ? (
        <p className="mt-4 max-w-2xl rounded-md bg-amber-soft p-3 text-sm leading-relaxed text-ink-muted">
          {/*
            No landform, in a sentence whose whole point is not inventing one.

            This used to end "would open up the sheltered stops down the valley"
            — a claim about one mountain region, rendered on a board that now
            compiles anywhere. An island, a delta, a steppe or a city centre was
            being told to widen its radius to reach a valley that does not exist
            there, inside the paragraph that says we will not invent a fallback.
          */}
          <span className="font-medium text-ink">Nothing on your board fits.</span> Everything
          else here is either too far, shut on your dates, or exposed to the same weather — so
          we are not going to invent a fallback. Widening how far you will go is the change most
          likely to open something up.
        </p>
      ) : (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {usable.map((backup) => (
            <li
              key={backup.placeId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border border-rule p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{backup.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{backup.why}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-ink-faint">
                  {backup.driveMinutes === 0 ? 'in town' : `${backup.driveMinutes} min`}
                </span>
                <button
                  type="button"
                  className={cx(buttonClass('ghost', 'sm'), MIN_TARGET)}
                  onClick={() => onChoose(backup.placeId, 'maybe')}
                  aria-pressed={selections[backup.placeId] === 'maybe'}
                >
                  Keep in mind
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "A and B", "A, B and 2 more" — a list a person would actually say out loud. */
function listNames(names: readonly string[]): string {
  if (names.length === 0) return 'some of your choices';
  if (names.length === 1) return names[0]!;
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  // "A, B and C" or "A, B, C and 4 more" — never the "and … and" the first
  // version produced by gluing a tail onto an already-conjoined list.
  const tail = rest > 0 ? `${rest} more` : shown.pop()!;
  return `${shown.join(', ')} and ${tail}`;
}

/**
 * The licence line, once, at the foot of the board.
 *
 * The cards quote provider numbers — "a 76% chance of rain" — and Open-Meteo's
 * data is CC BY 4.0, so the notice has to appear wherever the data does. Once
 * per page rather than once per card: twenty-three copies of the same sentence
 * is not attribution, it is noise, and the itinerary does the same thing in the
 * same quiet type.
 */
function WeatherCredit({
  groups,
  freshness,
}: {
  groups: readonly SerializedGroup[];
  freshness?: WeatherSnapshotState | 'not_fetched';
}) {
  const candidates = groups.flatMap((group) => group.candidates);
  const notice = candidates.find((candidate) => candidate.weather.attribution)?.weather
    .attribution;
  const label = candidates.find((candidate) => candidate.weather.evidenceLabel)?.weather
    .evidenceLabel;
  if (!notice) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint" data-testid="board-weather-credit">
      {label ? `${label} for your dates. ` : ''}
      {notice}{' '}
      {/*
        What is actually known about when this was read.

        "Conditions change; we have not checked today" was said whatever the
        snapshot's age, which is true of a fresh fetch and an understatement of
        a stale one. Where the page tells us the state, the sentence says it.
      */}
      {freshness === 'stale'
        ? 'This is the last weather we fetched and it is old enough to be worth fetching again.'
        : freshness === 'expired' || freshness === 'not_fetched'
          ? 'Nothing here is a claim about the weather on your dates.'
          : 'Conditions change; we have not checked today.'}
    </p>
  );
}

/** "Thu 13 Aug" — enough to point at a day without spelling out a date. */
function shortDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const OPERATING_BADGE_ORDER: readonly OperatingBadge[] = [
  'closed_on_your_dates',
  'closed_some_days',
  'limited_hours',
  'last_admission',
  'timed_entry',
  'reservation_required',
  'admission_permit',
  'hours_unknown',
  'verify_hours',
  'daylight_only',
];

const OPERATING_BADGE_TONE: Record<OperatingBadge, BadgeTone> = {
  limited_hours: 'neutral',
  closed_some_days: 'amber',
  closed_on_your_dates: 'clay',
  last_admission: 'amber',
  reservation_required: 'amber',
  timed_entry: 'amber',
  admission_permit: 'amber',
  hours_unknown: 'amber',
  verify_hours: 'amber',
  daylight_only: 'neutral',
};

/**
 * Whether stating the hours would tell the traveller anything. A day-use site
 * posted 06:00 to 22:00 cannot constrain a trip day, and printing its hours on
 * the card is a line of text that only competes with the ones that matter.
 */
function bindsTheDay(operating: DiscoveryCandidate['operating']): boolean {
  return (
    operating.badges.includes('limited_hours') ||
    operating.badges.includes('last_admission') ||
    operating.badges.includes('closed_some_days')
  );
}

const STATUS_STYLE: Record<SelectionStatus, string> = {
  included: 'border-pine bg-pine-soft text-pine',
  maybe: 'border-slate-blue bg-slate-blue-soft text-slate-blue',
  excluded: 'border-clay bg-clay-soft text-clay',
};

/**
 * WHICH CARDS GET A PHOTOGRAPH, AND WHY IT IS NOT ALL OF THEM.
 *
 * Two filters, and they are filters on *meaning* rather than on availability.
 *
 * **Only strong subject confidence.** A file matched through a stated media
 * category is a picture of something in the same category as this place, which
 * is a fine reason to show it beside a destination's name and a bad reason to
 * illustrate one specific stop. A card that says "this is the waterfall" with a
 * picture of a different waterfall in the same valley is worse than a card with
 * no picture at all — it is a claim, and it is wrong.
 *
 * **Only cards where a picture is the argument.** A board carries forty
 * candidates including car parks, bus stations and supermarkets, and a
 * photograph on every one of them turns a decision tool into a gallery: the
 * scanning cost goes up, the information density goes down, and the traveller
 * stops being able to see which four things matter. So imagery is reserved for
 * the places whose appeal *is* what they look like — the anchors and the
 * viewpoints — and support stops keep the category plate they already had.
 */
function anchorImage(
  images: Record<string, ImageRecord>,
  candidate: DiscoveryCandidate,
): ImageRecord | null {
  const image = images[candidate.place.id];
  if (!image || image.subjectConfidence !== 'strong') return null;
  return candidate.place.relationship === 'base' || candidate.fit.band === 'top_pick' ? image : null;
}

/**
 * WHAT A CARD SHOWS BEFORE YOU ASK IT ANYTHING.
 *
 * The board was 13,930px tall at 1440 and 25,270px at 390 — about thirty phone
 * screens for seventeen decisions, because every card printed everything it knew
 * at once: a five-line description, a four-line weather caveat, an eight-line
 * "why this fits you" panel, two disclosures and a source line. A comparison
 * tool that cannot be compared is not doing its job.
 *
 * So the card now leads with the eight things a decision is actually made on —
 * what it looks like, what it is called, where it is, how well it fits, how far,
 * how long, how hard, what it costs — plus the badges that change what the
 * traveller has to *do*, and the three buttons. The argument, the description and
 * the cautions are one disclosure away, and the disclosure is labelled with the
 * question it answers rather than with a chevron.
 *
 * Nothing is deleted. Every sentence that used to be on the card is still on the
 * card; the difference is whether you have to read it to see the next place.
 */
function PlaceCard({
  candidate,
  image,
  status,
  onChoose,
  boardWeatherNote,
}: {
  candidate: DiscoveryCandidate;
  /** Null on most cards, by design. See `anchorImage`. */
  image: ImageRecord | null;
  status: SelectionStatus | undefined;
  onChoose: (placeId: string, status: SelectionStatus) => void;
  /**
   * The sentence the board has already said for every card. Where this card's
   * own note is the same sentence, the card says nothing and the board's notice
   * stands for it; where it differs, the card's own note is what renders.
   */
  boardWeatherNote?: string;
}) {
  const { place, fit, season, access, operating, weather } = candidate;
  const blocked = fit.band === 'not_workable';
  const role = ROLE_BADGE[candidate.group];
  const ownWeatherNote = weather.note && weather.note !== boardWeatherNote ? weather.note : null;
  /*
   * The disclosure is named for what is inside it.
   *
   * "Why this fits you" is the product's whole argument, so it stays a phrase a
   * traveller recognises rather than becoming a chevron. Where there is no
   * argument to make — a card with no reasons — it does not pretend to have one.
   */
  const detailLabel =
    fit.blockers.length > 0
      ? 'Why this will not work'
      : fit.reasons.length > 0
        ? 'Why this fits you'
        : 'More about this place';

  return (
    <Panel
      as="article"
      className={cx(
        // `h-full` so every card in a row is the same height, which is what makes
        // `mt-auto` on the action block put every row of buttons on one line.
        // Without it a short card ended ninety pixels above its neighbours and
        // the eye had to hunt for each set of controls.
        //
        // `scroll-mt` is the other half of a sticky toolbar. Two bars are pinned
        // to the top of this page — the product header and the board's own
        // action bar — so anything the browser scrolls to the top edge (a
        // keyboard focus, an anchor, `scrollIntoView`) lands *underneath* about
        // 133px of chrome. Stating the margin here means a card scrolled to is a
        // card you can see and press.
        'flex h-full scroll-mt-[calc(var(--chrome-height)+5.5rem)] flex-col overflow-hidden transition-colors',
        status === 'included' && 'border-pine',
        status === 'excluded' && 'opacity-60',
      )}
    >
      <div className="relative">
        {/*
          A photograph when one was licensed *and* credibly of this exact place;
          the generated category plate otherwise. Never cropped: the frame is
          only a little wider than a photograph, and a crop here would buy a few
          pixels of composition at the cost of a share-alike question.
        */}
        {image ? (
          <DestinationImage
            image={image}
            fallback={imageryFallbackFor({
              kind: 'candidate',
              id: place.id,
              name: place.name,
              coordinates: place.coordinates,
            })}
            ratio="16 / 7"
            category={place.category}
          />
        ) : (
          <PlacePlate category={place.category} className="h-24" />
        )}
        <span className="absolute top-2 left-2 rounded-full bg-paper-raised/90 px-2 py-0.5 text-[11px] font-medium text-ink">
          {PLACE_CATEGORY_LABELS[place.category]}
        </span>
        {/*
          The role, opposite the category. Two different questions — "what kind of
          thing is it" and "what part does it play in this trip" — and the second
          one used to be readable only from a section heading three rows up.
        */}
        {role ? (
          <span
            className="absolute top-2 right-2 rounded-full bg-paper-raised/90 px-2 py-0.5 text-[11px] font-medium text-ink"
            data-testid="card-role"
          >
            {role.label}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-display text-lg leading-snug text-ink">{place.name}</h3>
        <p className="mt-0.5 text-xs text-ink-faint">
          {place.locality}
          {/*
            Two records that share one car park would otherwise read as two
            unrelated stops that happen to have similar names. Saying which site
            they belong to is what makes "the grounds" and "the visitor centre"
            legible as halves of one visit rather than a duplicate.
          */}
          {place.accessGroup ? (
            <>
              {' · '}
              <span title={place.accessGroup.note}>Part of {place.accessGroup.label}</span>
            </>
          ) : null}
        </p>

        <div className="mt-3">
          <FitMeter band={fit.band} label={FIT_BAND_LABELS[fit.band]} meter={FIT_BAND_METER[fit.band]} />
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Stat label="From base">
            {candidate.detourClass === 'base'
              ? 'At your base'
              : `${formatMinutes(candidate.driveMinutes)} · ${formatDistance(candidate.distanceKm)}`}
          </Stat>
          <Stat label="Time there">{formatMinutes(place.typicalDurationMinutes)}</Stat>
          <Stat label="Cost">{formatCost(place.costLevel)}</Stat>
          <Stat label="Effort">{formatIntensity(place.physicalIntensity)}</Stat>
        </dl>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone={blocked ? 'clay' : 'neutral'}>{WORTH_DETOUR_COPY[candidate.worthDetour]}</Badge>
          {/*
            The role chip already says "Hidden gem" on the plate above, so the
            score-derived badge would be the same word twice on one card.
          */}
          {place.hiddenGemScore >= 0.6 && role?.label !== 'Hidden gem' ? (
            <Badge tone="amber">Hidden gem</Badge>
          ) : null}
          {season.status === 'partially_open' ? <Badge tone="amber">Part of your dates</Badge> : null}
          {season.status === 'closed' ? <Badge tone="clay">Closed on your dates</Badge> : null}
          {/*
            Only the badges that change what the traveller has to do. A card that
            wears every flag it qualifies for teaches people to stop reading them.
          */}
          {ACCESS_BADGE_ORDER.filter((badge) => access.badges.includes(badge)).map((badge) => (
            <Badge key={badge} tone={ACCESS_BADGE_TONE[badge]}>
              {ACCESS_BADGE_LABELS[badge]}
            </Badge>
          ))}
          {/*
            "Recheck hours" is dropped where the card already carries the
            paragraph that says the same thing at length and names the source.
            One card was wearing "Hours unconfirmed", "Recheck hours" and a
            three-line "Check its hours" note — one fact, told three times,
            which is how a reader learns that none of the three is worth reading.
          */}
          {OPERATING_BADGE_ORDER.filter(
            (badge) =>
              operating.badges.includes(badge) &&
              !(badge === 'verify_hours' && operating.requiresVerification && operating.verifyNote),
          ).map((badge) => (
            <Badge key={badge} tone={OPERATING_BADGE_TONE[badge]}>
              {OPERATING_BADGE_LABELS[badge]}
            </Badge>
          ))}
          {/*
            The two weather badges that state the *board's* situation rather
            than this place's are dropped where the board has already said it,
            once, in a sentence: "No weather data" and "Seasonal pattern" were
            true of every card, so they distinguished nothing and cost a line
            each. The badges that discriminate — needs a clear day, holds up in
            bad weather, best on a particular day — are untouched, which is the
            whole point of clearing the others out of their way.
          */}
          {candidate.weather.badges
            .filter(
              (badge) =>
                !(boardWeatherNote && (badge === 'weather_unknown' || badge === 'seasonal_pattern')),
            )
            .map((badge) => (
              <Badge key={badge} tone={WEATHER_BADGE_TONE[badge]}>
                {badge === 'best_on_a_day' && candidate.weather.bestDate
                  ? `Best on ${shortDay(candidate.weather.bestDate)}`
                  : PLACE_WEATHER_BADGE_LABELS[badge]}
              </Badge>
            ))}
        </div>

        {access.status === 'partial' ? (
          <p className="mt-3 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Reachable on {access.usableDates.length} of your{' '}
            {access.byDate.length} days — we will only put it on one of those.
          </p>
        ) : null}

        {/*
          Reaching it and being let in are separate questions, so they get
          separate lines. Only the hours that bear on these dates appear; the
          rest of the annual timetable is not the traveller's problem.
        */}
        {operating.status === 'closed_throughout' ? (
          <p className="mt-3 rounded-md bg-clay-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Shut on every day of your trip.
          </p>
        ) : operating.status === 'open_some_days' ? (
          <p className="mt-3 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Open on {operating.openDates.length} of your {operating.byDate.length} days
            {operating.hoursSummary ? `, ${operating.hoursSummary}` : ''} — we will only put it on
            one of those.
          </p>
        ) : operating.hoursSummary && bindsTheDay(operating) ? (
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Open {operating.hoursSummary}
            {operating.lastAdmissionSummary ? ` · ${operating.lastAdmissionSummary.toLowerCase()}` : ''}
          </p>
        ) : null}

        {operating.requiresVerification && operating.verifyNote ? (
          <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            {/*
              Deliberately not "check before you go" — that is the access
              badge's phrase, and a card wearing both said the same four words
              twice about two different things.
            */}
            <span className="font-medium text-ink">Check its hours.</span>{' '}
            {operating.verifyNote}
          </p>
        ) : null}

        {/*
          THE ARGUMENT, ONE CLICK AWAY.

          Everything that used to run down the card unprompted — the description,
          the weather sentence, the reasons or the blockers, and the cautions —
          in one disclosure named for the question it answers. `open` when the
          place will not work, because a card that has just been marked
          impossible owes its reason immediately rather than on request.

          Independent per card rather than an accordion: comparing two places
          means having both open, and a control that closes the card you were
          reading in order to open the next one is a comparison tool that
          forbids comparison.
        */}
        <details className="mt-3" open={blocked}>
          <summary
            className={cx(
              MIN_TARGET_SUMMARY,
              'cursor-pointer text-xs font-medium',
              blocked ? 'text-clay' : 'text-ink hover:text-pine',
            )}
          >
            {detailLabel}
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-sm leading-relaxed text-ink-muted">{place.shortDescription}</p>

            {/*
              One sentence, and only when the weather over these dates would
              change the decision, and only when it is not the sentence the board
              has already made for every card. The verb has to match the
              evidence: "looks like the day for this one" is sayable about a
              forecast and not about ten past Augusts, so the sentence is built
              where the evidence is known rather than assembled here from parts.
            */}
            {ownWeatherNote ? (
              <p className="text-xs leading-relaxed text-ink-faint">{ownWeatherNote}</p>
            ) : null}

            {fit.blockers.length > 0 ? (
              <ul className="rounded-lg bg-clay-soft p-3 text-xs leading-relaxed text-ink-muted">
                {fit.blockers.map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            ) : fit.reasons.length > 0 ? (
              <ul className="space-y-1 rounded-lg bg-paper-sunk p-3 text-xs leading-relaxed text-ink-muted">
                {fit.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}

            {fit.cautions.length > 0 ? (
              <div className="text-xs">
                <p className="font-medium text-ink">Worth knowing ({fit.cautions.length})</p>
                <ul className="mt-1 space-y-1 leading-relaxed text-ink-muted">
                  {fit.cautions.map((caution) => (
                    <li key={caution}>{caution}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>

        <EvidencePanel candidate={candidate} />

        <div className="mt-auto pt-4">
          {/*
            A choice that has become impossible stays visible as a conflict.
            Silently flipping it to "Skip" would rewrite what someone asked for
            and hide the one fact they need in order to change their mind.
          */}
          {blocked && status === 'included' ? (
            <p className="mb-2 rounded-md bg-clay-soft p-2.5 text-xs leading-relaxed text-clay">
              You picked this, and it no longer works on these dates. We have kept
              your choice — change your dates, your transport answers, or skip it.
            </p>
          ) : null}
          <div
            className="flex gap-1.5"
            role="group"
            aria-label={`Your decision on ${place.name}`}
          >
            {(['included', 'maybe', 'excluded'] as const).map((option) => {
              // Offering "Include" on a stop we just explained is impossible would
              // let the traveller build a plan that cannot run.
              const unavailable = blocked && option === 'included' && status !== 'included';
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChoose(place.id, option)}
                  disabled={unavailable}
                  aria-pressed={status === option}
                  // The reason names the actual constraint. "Low logistics fit"
                  // tells nobody which of their answers to change.
                  title={unavailable ? (fit.blockers[0]?.message ?? undefined) : undefined}
                  className={cx(
                    'flex flex-1 items-center justify-center rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors',
                    MIN_TARGET,
                    unavailable && 'cursor-not-allowed border-rule text-ink-faint opacity-50',
                    !unavailable && status === option
                      ? STATUS_STYLE[option]
                      : !unavailable && 'border-rule text-ink-muted hover:border-ink-faint hover:text-ink',
                  )}
                >
                  {SELECTION_STATUS_LABELS[option]}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">
            Source: {place.source.name}
            {place.source.url ? (
              <>
                {' · '}
                <SourceLink url={place.source.url} />
              </>
            ) : null}
          </p>
        </div>
      </div>
    </Panel>
  );
}

/**
 * THE ONE LINK ON EVERY CARD, AT A SIZE A THUMB CAN HIT.
 *
 * Measured at 130x13 px, roughly twenty times per board — under a third of
 * WCAG 2.5.5's 44 px in the axis that matters, and it is the link that takes
 * somebody to the official page to check a closure. `inline-flex` with a minimum
 * height grows the target without moving the text or breaking the sentence it
 * sits in; the floor is lifted on touch widths only, because on a desktop the
 * pointer is precise and a 44px tall line inside 11px type would look broken.
 *
 * The colour moves from `ink-faint` to `ink-muted` for the same reason: a link
 * set in the product's faintest ink is legible by the letter of the contrast
 * rule and unfindable in practice.
 */
function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-ink sm:min-h-0"
    >
      check current conditions
    </a>
  );
}

/**
 * A PLACE WE ARE RECOMMENDING AGAINST, AT THE SIZE OF THAT RECOMMENDATION.
 *
 * One row rather than a card: name, how badly it fits, the badges that say what
 * is wrong with it, the reason in a sentence, and the same three buttons every
 * other card has — because "probably skip" is our opinion and the traveller is
 * allowed to disagree with it. Include stays disabled only where the place is
 * genuinely impossible, and the button then carries the constraint as its title,
 * exactly as on a full card.
 *
 * The detail that a full card would show is behind the row's own disclosure, so
 * nothing is lost: somebody who wants to argue with the verdict can read
 * everything it was made from.
 */
function SkipRow({
  candidate,
  status,
  onChoose,
}: {
  candidate: DiscoveryCandidate;
  status: SelectionStatus | undefined;
  onChoose: (placeId: string, status: SelectionStatus) => void;
}) {
  const { place, fit, season, access, operating } = candidate;
  const blocked = fit.band === 'not_workable';
  // The blocker where there is one — it is the specific, actionable answer — and
  // the quality layer's own sentence otherwise, which is always present.
  const headline = fit.blockers[0]?.message ?? candidate.quality.reason;

  return (
    <Panel
      as="article"
      className={cx(
        'flex scroll-mt-[calc(var(--chrome-height)+5.5rem)] flex-wrap items-start gap-x-4 gap-y-3 p-3 transition-colors',
        status === 'included' && 'border-pine',
        status === 'excluded' && 'opacity-60',
      )}
    >
      {/*
        One line on a desktop, two on a phone.

        `flex-1` alone left the text a hundred and thirty pixels wide beside
        three buttons that will not shrink, so every badge wrapped onto its own
        line and the "row" became taller than the card it replaced. Below `sm`
        the text takes the full width and the controls sit under it.
      */}
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-display text-base leading-snug text-ink">{place.name}</h3>
          <span className="text-xs text-ink-faint">{place.locality}</span>
          {/*
            WHICH SITE THIS BELONGS TO, KEPT ON THE COMPACT ROW.

            Dropped when the skip group collapsed to one line per place, and it
            is exactly the line that stops two halves of one site — a visitor
            centre and the grounds around it — reading as a duplicate record we
            failed to merge. The full card has always carried it; a shorter row
            is not a reason to make the board look wrong.
          */}
          {place.accessGroup ? (
            <span className="text-xs text-ink-faint" title={place.accessGroup.note}>
              Part of {place.accessGroup.label}
            </span>
          ) : null}
          <Badge tone={blocked ? 'clay' : 'neutral'}>{FIT_BAND_LABELS[fit.band]}</Badge>
          {season.status === 'closed' ? <Badge tone="clay">Closed on your dates</Badge> : null}
          {season.status === 'partially_open' ? (
            <Badge tone="amber">Part of your dates</Badge>
          ) : null}
          {ACCESS_BADGE_ORDER.filter((badge) => access.badges.includes(badge)).map((badge) => (
            <Badge key={badge} tone={ACCESS_BADGE_TONE[badge]}>
              {ACCESS_BADGE_LABELS[badge]}
            </Badge>
          ))}
          {OPERATING_BADGE_ORDER.filter((badge) => operating.badges.includes(badge)).map((badge) => (
            <Badge key={badge} tone={OPERATING_BADGE_TONE[badge]}>
              {OPERATING_BADGE_LABELS[badge]}
            </Badge>
          ))}
        </div>

        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          <span className={cx('font-medium', blocked ? 'text-clay' : 'text-ink')}>
            {blocked ? 'Why this will not work' : 'Why we would skip it'}
          </span>{' '}
          — {headline}
        </p>

        {/*
          THE DATE FACT SURVIVES THE COMPACT ROW.

          Collapsing the skip group to one line per place dropped this sentence,
          and it is the one sentence on the row a traveller most needs: "shut on
          every day of your trip" is not a nuance, it is the whole answer. A
          browser suite caught it — four specifications that had asserted this
          text for phases went red — but the defect is a product one, and it is
          the same shape as a reviewer's separate finding that a disabled
          Include button explained itself only through a `title` attribute
          nobody on a phone can read.

          Rendered as text rather than as a badge because a badge saying
          "Closed" and a sentence saying which days are shut are different
          claims, and the row already carries the badge.
        */}
        {operating.status === 'closed_throughout' ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Shut on every day of your trip.
          </p>
        ) : operating.status === 'open_some_days' ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Open on {operating.openDates.length} of your {operating.byDate.length} days
            {operating.hoursSummary ? `, ${operating.hoursSummary}` : ''}.
          </p>
        ) : null}

        {/*
          The choice stays visible as a conflict rather than being flipped for
          them. Same rule as the full card, and for the same reason.
        */}
        {blocked && status === 'included' ? (
          <p className="mt-2 rounded-md bg-clay-soft p-2.5 text-xs leading-relaxed text-clay">
            You picked this, and it no longer works on these dates. We have kept your choice —
            change your dates, your transport answers, or skip it.
          </p>
        ) : null}

        <details className="mt-1">
          <summary
            className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-xs text-ink-muted hover:text-ink')}
          >
            What it is, and everything we checked
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs leading-relaxed text-ink-muted">{place.shortDescription}</p>
            {fit.blockers.length > 1 ? (
              <ul className="space-y-1 text-xs leading-relaxed text-ink-muted">
                {fit.blockers.slice(1).map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            ) : null}
            {fit.cautions.length > 0 ? (
              <ul className="space-y-1 text-xs leading-relaxed text-ink-muted">
                {fit.cautions.map((caution) => (
                  <li key={caution}>{caution}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-ink-muted">
              Source: {place.source.name}
              {place.source.url ? (
                <>
                  {' · '}
                  <SourceLink url={place.source.url} />
                </>
              ) : null}
            </p>
          </div>
        </details>
      </div>

      <div
        className="flex shrink-0 gap-1.5 max-sm:w-full"
        role="group"
        aria-label={`Your decision on ${place.name}`}
      >
        {(['included', 'maybe', 'excluded'] as const).map((option) => {
          const unavailable = blocked && option === 'included' && status !== 'included';
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChoose(place.id, option)}
              disabled={unavailable}
              aria-pressed={status === option}
              title={unavailable ? (fit.blockers[0]?.message ?? undefined) : undefined}
              className={cx(
                'flex items-center justify-center rounded-md border px-3 text-xs font-medium whitespace-nowrap transition-colors max-sm:flex-1',
                MIN_TARGET,
                unavailable && 'cursor-not-allowed border-rule text-ink-faint opacity-50',
                !unavailable && status === option
                  ? STATUS_STYLE[option]
                  : !unavailable && 'border-rule text-ink-muted hover:border-ink-faint hover:text-ink',
              )}
            >
              {SELECTION_STATUS_LABELS[option]}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/**
 * WHY WE TRUST THIS — and, more often, why we do not.
 *
 * Two registers, kept apart on purpose. The chips above the fold are the facts
 * that change what a traveller *does*: a booking they have to make, a price they
 * have to budget for, a closure that removes the stop. The panel below the fold
 * is the audit trail: which page said it, when we read it, and what nobody
 * answered.
 *
 * It is collapsed by default and absent entirely where nothing was established,
 * because an evidence panel that opens onto "unknown, unknown, unknown" teaches
 * people to stop opening evidence panels. The unknowns are still listed *inside*
 * it, where somebody who has decided to care can read them.
 */
function EvidencePanel({ candidate }: { candidate: DiscoveryCandidate }) {
  const evidence = candidate.evidence;
  if (!evidence) return null;

  const booking = evidence.booking;
  const mustBook =
    booking?.reservationRequired === 'yes' ||
    booking?.timedEntry === 'yes' ||
    booking?.permitRequired === 'yes';
  const blocking = evidence.closures.filter((closure) => closure.severity === 'blocks');
  const cautions = [
    ...evidence.closures.filter((closure) => closure.severity !== 'blocks'),
    ...evidence.safety.filter((entry) => entry.severity !== 'informs'),
  ];
  const admission = evidence.costs.find((cost) => cost.kind === 'admission');
  const answered = evidence.resolved.filter(
    (fact) => fact.state !== 'unknown' && fact.state !== 'unavailable',
  );
  const unanswered = evidence.resolved.filter((fact) => fact.state === 'unknown');
  const conflicted = evidence.resolved.filter((fact) => fact.state === 'conflicted');

  if (answered.length === 0 && !evidence.officialUrl && unanswered.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {/*
        Only the facts that change a decision get a chip. A card that wears one
        for every field it happens to have communicates less than one wearing two.
      */}
      {(mustBook || admission || blocking.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {blocking.length > 0 ? <Badge tone="clay">Closed — official notice</Badge> : null}
          {mustBook ? (
            <Badge tone="amber">
              {booking?.permitRequired === 'yes'
                ? 'Permit needed'
                : booking?.timedEntry === 'yes'
                  ? 'Timed entry'
                  : 'Book ahead'}
            </Badge>
          ) : null}
          {admission ? (
            <Badge tone="neutral">{describeCost(admission)}</Badge>
          ) : null}
        </div>
      )}

      {cautions.length > 0 ? (
        <p className="rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">Worth knowing.</span> {cautions[0]!.statement}
          {/*
            Why it is being shown rather than acted on, where it is not acted on.
            A closure that ended before the traveller arrives, begins after they
            leave, or is old enough to have been lifted is still worth reading
            and must not remove a place — and a warning with no explanation of
            why nothing changed reads as an inconsistency rather than as care.
          */}
          {noteOf(cautions[0]!) ? (
            <span className="text-ink-faint"> {noteOf(cautions[0]!)}</span>
          ) : null}
        </p>
      ) : null}

      <details className="text-xs">
        <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-ink-faint hover:text-ink')}>
          Why we trust this ({answered.length} of {evidence.resolved.length} checked
          {conflicted.length > 0 ? `, ${conflicted.length} disputed` : ''})
        </summary>
        <div className="mt-2 space-y-2">
          {evidence.officialUrl ? (
            <p className="leading-relaxed text-ink-muted">
              Official page:{' '}
              <a
                href={evidence.officialUrl}
                target="_blank"
                rel="noreferrer nofollow"
                className="underline underline-offset-2 hover:text-ink"
              >
                {hostOf(evidence.officialUrl)}
              </a>
            </p>
          ) : null}

          <ul className="space-y-1.5">
            {answered.map((fact) => (
              <li key={fact.factPath} className="leading-relaxed">
                <span className="text-ink">{FACT_PATH_LABELS[fact.factPath]}</span>
                {': '}
                <span className="text-ink-muted">{fact.rationale}</span>{' '}
                <span className="text-ink-faint">({FACT_VERIFICATION_LABELS[fact.state]})</span>
              </li>
            ))}
          </ul>

          {/*
            The unknowns are the honest half. A traveller deciding whether to
            drive an hour needs to know that nobody published the hours far more
            than they need to know the two facts we did establish.
          */}
          {unanswered.length > 0 ? (
            <p className="leading-relaxed text-ink-faint">
              Nobody we could read publishes{' '}
              {unanswered
                .slice(0, 4)
                .map((fact) => FACT_PATH_LABELS[fact.factPath].toLowerCase())
                .join(', ')}
              {unanswered.length > 4 ? ` and ${unanswered.length - 4} more` : ''}.
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

/** A closure carries a note when it is shown but not enforced. Safety does not. */
function noteOf(entry: ClosureEvidence | SafetyEvidence): string | undefined {
  return 'note' in entry ? entry.note : undefined;
}

function describeCost(cost: NonNullable<DiscoveryCandidate['evidence']>['costs'][number]): string {
  if (cost.free) return 'Free entry';
  if (!cost.money) return 'There is a charge';
  const { currency, amount, maxAmount, unit } = cost.money;
  const range = maxAmount !== undefined ? `${amount}–${maxAmount}` : `${amount}`;
  return `${range} ${currency} ${MONEY_UNIT_LABELS[unit]}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the official page';
  }
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
