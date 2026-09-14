'use client';

import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  FACT_PATH_LABELS,
  FACT_VERIFICATION_LABELS,
  FIT_BAND_LABELS,
  FIT_BAND_METER,
  MONEY_UNIT_LABELS,
  SELECTION_STATUSES,
  SELECTION_STATUS_LABELS,
  REACH_MODE_PHRASE,
  describeReachFromBase,
  describeTransitBlindWalk,
  displayNameOf,
  imageryFallbackFor,
  summariseSelections,
  summaryVersion,
  type DestinationImage as ImageRecord,
  type BoardGroup,
  type BoardWeatherBackups,
  type DiscoveryCandidate,
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
  Panel,
  PlaceName,
  PlacePlate,
  buttonClass,
  cx,
} from './ui';
import {
  BoardFilterRail,
  NO_FILTERS,
  anyFilterActive,
  facetsFor,
  filterCandidates,
  type BoardFilterState,
} from './BoardFilters';
import {
  BOARD_GROUP_HEADINGS,
  PASS_REASONS,
  alsoLikeThis,
  alsoLikeThisPrompt,
  cardStats,
  chipsFor,
  descriptionOf,
  evidenceDisclosureLabel,
  honestWeatherNote,
  whysForBoard,
  recommendationLabel,
  sharedBoardFacts,
  type BoardChip,
  type PassReason,
  type SharedBoardFacts,
  type SharedFactKind,
} from './BoardCopy';
import { BoardMap } from './BoardMap';
import type { MapBasemap } from './map-adapter';
import { DestinationImage, ImageCredit } from './DestinationImage';
import { BuildTripButton, PlannerReadinessPanel } from './BuildTripButton';
import { formatMinutes } from '@/lib/format';
import {
  autoPickAction,
  fillBoardImageryAction,
  setSelectionAction,
} from '@/app/(product)/trips/[id]/discover/actions';

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

/**
 * The card surface, spelled out rather than taken from `Panel`.
 *
 * `Panel` deliberately refuses arbitrary props — a component that silently drops
 * a `data-testid` cost this project two green-looking tests — and a card needs
 * `data-place-card` and pointer handlers so the map can find it and it can tell
 * the map what is being read. Borrowing the classes keeps the two surfaces
 * identical without loosening the component that is strict on purpose.
 */
const CARD_SURFACE = 'rounded-[var(--radius-card)] border border-rule bg-paper-raised';

/**
 * How many places come before the map on a phone. See the layout comment in the
 * board's own body.
 */
const LEAD_CARDS = 3;

/** A group as it is rendered: the compiler's group, plus where the cut fell. */
interface RenderedGroup extends SerializedGroup {
  /** True for the tail of a group whose head was rendered above the map. */
  continued: boolean;
}

/**
 * THE DISCOVERY BOARD, LEADING WITH PLACES.
 *
 * What this replaces, measured on a real compiled Tokyo board: the first place
 * card sat nine hundred pixels down a desktop screen and fourteen hundred down a
 * phone, behind a readiness panel, an integrity panel and a column of counts
 * headed "Practical stops kept aside 94" and "Added on purpose from further out
 * 3033". Below that were twenty-four visually identical bordered cards, each
 * wearing the same six chips and the same three warnings, each labelled "Strong
 * fit", each titled in a script the reader could not read, none with a picture,
 * and the whole thing with no map anywhere.
 *
 * The rebuild is four decisions:
 *
 * 1. **Places first.** Everything about how the board was made is at the foot of
 *    the page behind one disclosure. What is above the fold is the count, the
 *    two actions, the map and the cards.
 * 2. **The card argues, once.** An image or an intentional graphic, the name in
 *    a script the reader can read, where it is and what getting there costs, one
 *    calibrated label, one sentence of *why*, and at most two chips. The
 *    provenance and the caveats are one press away.
 * 3. **A fact true of the board is stated by the board.** See `sharedBoardFacts`.
 * 4. **The map and the list are one surface.** Pressing a pin focuses a card and
 *    the reverse, so "where is this" is answerable without leaving the screen.
 */
export function DiscoveryBoardView({
  tripId,
  storedReadiness,
  groups: incomingGroups,
  initialSelections,
  autoPickNotes,
  hasItinerary,
  weatherBackups,
  boardVersion: declaredVersion,
  weatherFreshness,
  images = {},
  base = null,
  imageryPending = 0,
  tiles = null,
}: {
  tripId: string;
  /** How old the weather behind this board is, when the page knows. */
  weatherFreshness?: WeatherSnapshotState | 'not_fetched';
  /** The artifact this board was projected from, when the page knows it. */
  boardVersion?: string;
  /** The last refusal, from the database, so it survives a refresh. */
  storedReadiness?: PlannerReadiness | null;
  groups: SerializedGroup[];
  weatherBackups: BoardWeatherBackups | null;
  initialSelections: SelectionMap;
  autoPickNotes: string[];
  hasItinerary: boolean;
  /** A basemap tile source, resolved on the server from `SIDEQUEST_MAP_TILES`; null draws positions only. */
  tiles?: MapBasemap | null;
  /** Licensed photographs by place id, read from a table by the page. */
  images?: Record<string, ImageRecord>;
  /** Where they are sleeping, so the map can draw the thing everything is measured from. */
  base?: { name: string; coordinates: { lat: number; lng: number } } | null;
  /**
   * How many cards nobody has ever looked for a photograph for.
   *
   * The board runs one bounded resolution pass while this is non-zero and then
   * stops, because a refusal is stored just as an acceptance is. Zero on a board
   * whose subjects have all been answered, which is the steady state and costs
   * nothing.
   */
  imageryPending?: number;
}) {
  /*
   * ONE WEATHER STORY PER PAGE.
   *
   * The cards arrive carrying the sentence core composed for their per-day
   * evidence, and for an *absent* dataset that sentence claims an outage — "we
   * could not reach a weather source" — on the same page whose weather panel
   * says "not fetched" with a fetch button. Only this page knows which absence
   * it is (`weatherFreshness === 'not_fetched'` means no snapshot row exists),
   * so the notes are reconciled here, once, before anything reads them: the
   * hoisted banner, the per-card fallbacks and `sharedBoardFacts` all see the
   * same words. A board whose fetch genuinely failed keeps the outage story.
   */
  const groups = useMemo<SerializedGroup[]>(
    () =>
      weatherFreshness === 'not_fetched'
        ? incomingGroups.map((entry) => ({
            ...entry,
            candidates: entry.candidates.map((candidate) =>
              candidate.weather.note
                ? {
                    ...candidate,
                    weather: {
                      ...candidate.weather,
                      note: honestWeatherNote(candidate.weather.note, weatherFreshness),
                    },
                  }
                : candidate,
            ),
          }))
        : incomingGroups,
    [incomingGroups, weatherFreshness],
  );

  /*
   * THE VERSION EVERY NUMBER ON THIS SCREEN BELONGS TO.
   *
   * Derived from the cards actually rendered when the page does not declare one,
   * so the identity moves exactly when the board does and not when a traveller
   * marks something.
   */
  const cardIds = groups.flatMap((entry) => entry.candidates.map((c) => c.place.id));
  const boardVersion = summaryVersion([declaredVersion ?? '', ...cardIds]);

  /*
   * THE MIRROR CANNOT OUTLIVE WHAT IT MIRRORS.
   *
   * Keyed to the server state it was derived from and dropped the moment either
   * the board version or the stored marks change identity — a stale "12 in"
   * beside a board of nine cards reads as a fact.
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
  const [filters, setFilters] = useState<BoardFilterState>(NO_FILTERS);
  /*
   * Whether auto-pick has just run. The observed failure was that pressing it
   * changed some borders far down a very long page and said nothing at all, so
   * it read as a button that did nothing. The account it returns is now rendered
   * where the press happened, and announced.
   */
  const [autoPicked, setAutoPicked] = useState(false);
  /** The card whose pin is lit, and vice versa. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** A pass in progress: which card, and the follow-up its reason earned. */
  const [passing, setPassing] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<{
    reason: PassReason;
    from: string;
    ids: string[];
  } | null>(null);
  const [readiness, setReadiness] = useState<PlannerReadiness | null>(
    storedReadiness && storedReadiness.level !== 'ready' ? storedReadiness : null,
  );

  const allCandidates = groups.flatMap((entry) => entry.candidates);

  /*
   * ONE BOUNDED IMAGERY PASS, THEN NEVER AGAIN FOR THIS BOARD.
   *
   * The ref, not the state, is what makes that true: an effect keyed only on the
   * board version would run again after the refresh it itself triggers. The
   * server action is the terminating half — it resolves only subjects nothing
   * has ever looked for, and it writes down refusals as well as acceptances, so
   * `imageryPending` falls to zero and stays there.
   *
   * The refresh is conditional on something actually being found. A round trip
   * that changes no pixel is a page that flickers for no reason.
   */
  const imageryAsked = useRef<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (imageryPending <= 0) return;
    if (imageryAsked.current === boardVersion) return;
    imageryAsked.current = boardVersion;
    let cancelled = false;
    void fillBoardImageryAction(tripId).then((result) => {
      if (cancelled || !result.ok || !result.accepted) return;
      /**
       * `router.refresh()`, NEVER `window.location.reload()`.
       *
       * This used to be a plain reload, on the reasoning that the page is
       * `force-dynamic` so letting the server re-render it is the simplest
       * correct thing. The re-render was correct; the *navigation* was not. A
       * hard reload tears down every request the page has in flight, and the
       * one this page exists to start takes several seconds.
       *
       * Measured: pressing "Build my trip" inside the imagery window aborts
       * `buildItineraryAction` mid-flight, so the browser never follows its
       * redirect to the itinerary. The plan is built and saved — the server
       * finished — and the traveller is left on a board that has just flashed,
       * with the button relabelled "Rebuild my trip" and a panel saying their
       * plan is thin. A success rendered as a refusal, with no way forward
       * offered.
       *
       * The e2e suite hid it because imagery resolution needs a `wikidataId`
       * and the authored demo region has none, so `imageryPending` is zero
       * there — while every compiled region carries them. It missed the demo
       * destination and hit every real one.
       *
       * `router.refresh()` re-fetches this route's payload on the server
       * without unloading the document, so anything in flight survives it.
       */
      router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [tripId, boardVersion, imageryPending, router]);

  /*
   * Counted over the cards on screen, not over the keys of the mark map. The map
   * is trip-scoped and outlives every board it was written against.
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

  /**
   * A pass, with the reason applied to this trip immediately.
   *
   * §10.6 is explicit that a rejection reason must act on the current trip and
   * must not require a new questionnaire. So the reason is not filed away: it is
   * turned straight into a question about the board in front of them — "four
   * more are at least as far out; skip those too?" — which they answer with one
   * press or ignore. Nothing is applied silently, because a single "no" is not a
   * mandate to remove five things somebody has not looked at yet.
   */
  function passWithReason(candidate: DiscoveryCandidate, reason: PassReason) {
    setPassing(null);
    choose(candidate.place.id, 'excluded');
    const decided = new Set(
      Object.entries(optimistic)
        .filter(([, status]) => status !== undefined)
        .map(([placeId]) => placeId),
    );
    decided.add(candidate.place.id);
    const similar = alsoLikeThis({ candidates: allCandidates, passed: candidate, reason, decided });
    setFollowUp(
      similar.length > 0
        ? {
            reason,
            from: displayNameOf(candidate.place),
            ids: similar.map((entry) => entry.place.id),
          }
        : null,
    );
  }

  function applyFollowUp() {
    const target = followUp;
    setFollowUp(null);
    if (!target) return;
    setError(null);
    startTransition(async () => {
      applyOptimistic(Object.fromEntries(target.ids.map((id) => [id, 'excluded' as const])));
      const results = await Promise.all(
        target.ids.map((id) => setSelectionAction(tripId, id, 'excluded')),
      );
      if (results.every((result) => result.ok)) {
        setMirror((current) => ({
          ...current,
          value: {
            ...current.value,
            ...Object.fromEntries(target.ids.map((id) => [id, 'excluded' as const])),
          },
        }));
      } else {
        setError('Some of those did not save. Reload to see what stuck.');
      }
    });
  }

  function autoPick() {
    setError(null);
    setFollowUp(null);
    startTransition(async () => {
      const result = await autoPickAction(tripId);
      if (!result.ok || !result.selections) {
        setError(result.error ?? 'We could not build a selection just then.');
        return;
      }
      // Adopt what the server actually stored, which preserves any card the
      // traveller had already decided on by hand.
      setMirror((current) => ({
        key: current.key,
        value: result.selections!,
        notes: result.notes ?? [],
      }));
      setAutoPicked(true);
    });
  }

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
    // §10.2: an empty group never renders.
    .filter((entry) => entry.candidates.length > 0);
  const visibleCardCount = visibleGroups.reduce((total, entry) => total + entry.candidates.length, 0);
  const filtered = anyFilterActive(filters) || onlyIncluded;

  /*
   * The board, cut once so the map can sit between the first few places and the
   * rest. See the layout comment below for why the cut exists at all; the split
   * itself is deliberately shallow — a heading and a handful of cards — because
   * anything longer defeats the point on the screen it was made for.
   */
  const lead = visibleGroups[0];
  const leadGroups: RenderedGroup[] = lead
    ? [{ ...lead, candidates: lead.candidates.slice(0, LEAD_CARDS), continued: false }]
    : [];
  const restGroups: RenderedGroup[] = [
    ...(lead && lead.candidates.length > LEAD_CARDS
      ? [{ ...lead, candidates: lead.candidates.slice(LEAD_CARDS), continued: true }]
      : []),
    ...visibleGroups.slice(1).map((entry) => ({ ...entry, continued: false })),
  ];

  /*
   * The sentences that belong to the board rather than to twenty-four copies of
   * one card. See `sharedBoardFacts` for why the threshold is what it is.
   */
  const shared = sharedBoardFacts(allCandidates);
  /*
   * The argument each card leads with, chosen across the board rather than per
   * card. See `whysForBoard`: the scorer's reasons are ranked, so a per-card
   * read of the top one prints the same sentence on every card that fits for the
   * same leading reason.
   */
  const whys = whysForBoard(allCandidates, shared);

  const mapPlaces = allCandidates
    .filter((candidate) => candidate.group !== 'weak_fit')
    .map((candidate) => ({
      id: candidate.place.id,
      /*
       * The name a reader of this interface can read. A pin's accessible label
       * is the *only* thing a screen-reader user gets from the drawing, and a
       * board of Tokyo pins labelled in kanji on a document declaring lang="en"
       * is a drawing they cannot use. `displayNameOf` chooses between names a
       * source actually published; nothing here translates.
       */
      name: displayNameOf(candidate.place),
      coordinates: candidate.place.coordinates,
      category: candidate.place.category,
      chosen: optimistic[candidate.place.id] === 'included',
      travelMinutes: candidate.travelMinutesFromBase,
    }));

  /** Bring a card into view when its pin is pressed. The other half of §10.5. */
  function focusFromMap(placeId: string) {
    setFocusedId(placeId);
    document
      .querySelector(`[data-place-card="${CSS.escape(placeId)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <div data-testid="discovery-board" data-board-version={boardVersion}>
      {/*
        THE ACTION BAR: STICKY AT THE TOP ON A DESKTOP, PINNED TO THE BOTTOM ON A PHONE.

        One element, two positions. It was `sm:sticky`, which means *not* sticky
        at the one width where it matters: on a 390px screen the board is many
        thousands of pixels tall and the count and the primary action scrolled
        away after the first card.

        Auto-pick now lives here rather than in the flow. It is the product's
        answer to "there are twenty-four of these and I do not want to read them
        all", and a control that answers that question has to be reachable from
        the point in the page where somebody gives up.
      */}
      <Panel
        className={cx(
          // Below the product header (`z-30`), above the cards.
          'z-20 flex flex-wrap items-center gap-x-4 gap-y-2 p-3 sm:p-4',
          'sm:sticky sm:top-[var(--chrome-height)] sm:mb-6',
          /*
           * The safe area, paid for by the bar rather than assumed away.
           * `bottom-0` on an iPhone is behind the home indicator, so the last
           * thirty-four pixels — where the primary action sits — were not
           * tappable.
           */
          'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[70vh]',
          'max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
          'max-sm:overflow-y-auto max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0',
          'max-sm:shadow-panel print:hidden',
        )}
        testId="board-action-bar"
      >
        {/*
          The count and the version it describes, from one object. They cannot
          disagree because `summary` produced both.

          "we suggested 18" is gone. It sat beside a header reading "We
          pre-selected 0" — two numbers from the same computation contradicting
          each other in one glance — and a raw target is not a thing a traveller
          asked for anyway. What auto-pick did is now said in words, once, where
          it was pressed.
        */}
        {/*
          THE FOLLOW-UP A REJECTION REASON EARNED.

          On a phone it is the first row *of this bar* rather than a second
          fixed panel stacked above it: the bar's height depends on how its
          rows wrap, and a panel pinned at a guessed offset landed on top of
          "Choose for me". On a wider screen it floats at the corner as before,
          because by the time somebody has chosen a reason the card they
          pressed may well have scrolled away — and an offer nobody sees is a
          reason nobody used.
        */}
        {followUp ? (
          <div
            className="max-sm:order-first max-sm:basis-full max-sm:border-b max-sm:border-rule max-sm:pb-3 sm:fixed sm:right-6 sm:bottom-6 sm:z-50 sm:max-w-sm sm:rounded-[var(--radius-card)] sm:border sm:border-rule sm:bg-paper-raised sm:p-4 sm:shadow-panel print:hidden"
            role="status"
            data-testid="board-pass-followup"
          >
            <p className="text-sm leading-relaxed text-ink">
              {alsoLikeThisPrompt(followUp.reason, followUp.ids.length)}
            </p>
            <p className="mt-1 text-xs text-ink-faint">Because you passed on {followUp.from}.</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={applyFollowUp}
                className={cx(buttonClass('primary', 'sm'), MIN_TARGET)}
                data-testid="board-pass-followup-apply"
              >
                Skip {followUp.ids.length === 1 ? 'it' : 'them'} too
              </button>
              <button
                type="button"
                onClick={() => setFollowUp(null)}
                className={cx(buttonClass('ghost', 'sm'), MIN_TARGET)}
              >
                Leave them
              </button>
            </div>
          </div>
        ) : null}
        <p className="text-sm text-ink" data-testid="board-summary" data-board-version={summary.boardVersion}>
          <strong className="numeral font-display text-2xl text-accent-strong">{includedCount}</strong> chosen
          {maybeCount > 0 ? <span className="text-ink-muted"> · {maybeCount} maybe</span> : null}
          {/*
            The denominator is dropped on a phone. Three facts and two buttons do
            not fit across 390 pixels, and the wrap cost the bar a third of the
            viewport — on the one screen where the bar is pinned over the content.
          */}
          <span className="text-ink-faint max-sm:hidden"> · {summary.onBoard} on the board</span>
        </p>
        {/*
          Two controls, two rows on a phone and one on a desktop.

          `BuildTripButton` is a block that carries its own hint paragraph
          underneath ("include at least one place first"), so at 390px it cannot
          share a row with anything: the hint sets the block's width and pushes
          the count onto a line of its own. Giving it the full row below is the
          layout that respects that rather than fighting it, and it puts the
          primary action across the whole width of the thumb's reach.
        */}
        <button
          type="button"
          onClick={autoPick}
          disabled={pending}
          className={cx(buttonClass('secondary', 'sm'), MIN_TARGET, 'ml-auto whitespace-nowrap')}
          data-testid="board-auto-pick"
        >
          {pending ? 'Choosing…' : 'Choose for me'}
        </button>
        <div className="max-sm:basis-full">
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

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {/*
        WHAT AUTO-PICK DID, WHERE IT WAS PRESSED — and only once it has been.

        Two halves of one defect. Pressing "choose for me" used to change some
        borders far down a very long page and say nothing, so it read as a button
        that did nothing; meanwhile the *server's* preview of what auto-pick
        would do was rendered on first load, in the past tense, so a traveller
        who had pressed nothing was told "we pre-selected 0". The account is now
        rendered exactly when it is true: after the action returns, describing
        what it stored.
      */}
      {autoPicked && notes.length > 0 ? (
        <div
          className={cx(
            'mb-6 rounded-[var(--radius-card)] border-l-4 border-accent bg-accent-soft px-4 py-3',
          )}
          data-testid="board-auto-pick-notes"
          data-board-version={summary.boardVersion}
        >
          <ul className="space-y-1.5 text-sm leading-relaxed text-ink">
            {notes.map((note) => (
              <li key={`${summary.boardVersion}:${note}`}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        THE SENTENCES THAT ARE TRUE OF THE WHOLE BOARD — BEHIND ONE LINE.

        Said once, and *folded*. Hoisting them off the cards was right and did
        not go far enough: a fresh reviewer opened a live board and found six
        consecutive negative sentences between the trip header and the first
        place, which on a phone put the first thing to do about two viewports
        down. Honest abstention that nobody scrolls past is not honesty, it is a
        wall.

        So the summary line counts them and the sentences themselves are one
        press away. Nothing is hidden — the count is on screen, the disclosure is
        a real control, and print opens every one of these — and the cards they
        cover still say nothing, so the difference a card *does* carry is still
        the only thing shouting.
      */}
      {shared.notes.length > 0 ? (
        <details className="mb-6 rounded-[var(--radius-control)] bg-paper-sunk px-3" data-testid="board-weather-note">
          <summary
            className={cx(
              MIN_TARGET_SUMMARY,
              'flex cursor-pointer items-center text-[13px] leading-snug text-ink-muted hover:text-ink',
            )}
          >
            {shared.notes.length === 1
              ? 'One thing we could not check across this board'
              : `${shared.notes.length} things we could not check across this board`}
            <span className="ml-1 text-ink-faint">— see what they are</span>
          </summary>
          <ul className="space-y-1 pb-3 text-[13px] leading-snug text-ink-muted">
            {shared.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {/*
        A polite status line, and the only thing on this board that speaks.

        Phrased as a sentence rather than as a copy of the counter beside it: a
        live region that repeats the visible summary verbatim is announced twice,
        and "9 in, 0 maybe" read aloud out of context is a sequence of numbers.
      */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="board-status">
        {error
          ? error
          : `Your board now has ${includedCount} places included and ${maybeCount} marked maybe, out of ${summary.onBoard}. ${visibleCardCount} showing.`}
      </p>

      {/*
        Decisions about places this board does not hold — named as history rather
        than folded into the count.
      */}
      {summary.carriedOver > 0 ? (
        <p
          className="mb-6 text-xs leading-relaxed text-ink-faint"
          data-testid="board-carried-over"
          data-board-version={summary.boardVersion}
        >
          You have also decided on {summary.carriedOver}{' '}
          {summary.carriedOver === 1 ? 'place' : 'places'} that is not on this board. Those choices
          are kept and are not counted above.
        </p>
      ) : null}

      {visibleGroups.length === 0 ? (
        <Panel className="p-8 text-center">
          <p className="font-display text-lg text-ink">
            {filtered ? 'Nothing matches what you asked for' : 'Nothing here fits this trip'}
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            {filtered
              ? 'Every card is still on the board — clear the filters to see them again, or let us choose a starting set.'
              : 'Try widening how far you will travel, or moving your dates — some of what we found here is only reachable for part of the year.'}
          </p>
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start xl:grid-cols-[minmax(0,1fr)_23rem]">
          {/*
            THE FIRST FEW PLACES, ABOVE EVERYTHING ELSE ON A PHONE.

            Three grid items rather than two, and the reason is the phone. The
            map used to be the first thing in the document, so on a 390px screen
            the traveller met a caveat panel, a three-hundred-pixel drawing, a
            filter rail and only then a place — about two viewports of apparatus
            before the first thing they could actually decide on.

            On a wide screen nothing moves: blocks one and three both sit in
            column one, rows one and two, and the map takes column one's whole
            height beside them. On a narrow one the document order does the work
            — a few places, then the map, then the rest.
          */}
          <div className="lg:col-start-1 lg:row-start-1">
            <BoardSections
              groups={leadGroups}
              images={images}
              selections={optimistic}
              focusedId={focusedId}
              shared={shared}
              whys={whys}
              onChoose={choose}
              onFocus={setFocusedId}
              passing={passing}
              onStartPass={setPassing}
              onCancelPass={() => setPassing(null)}
              onPass={passWithReason}
            />
          </div>

          <div className="lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-[calc(var(--chrome-height)+5.5rem)] print:hidden">
            <p className="label mb-2 text-ink-faint">The board, on the map</p>
            <BoardMap
              base={base}
              places={mapPlaces}
              focusedId={focusedId}
              onFocus={focusFromMap}
              tiles={tiles}
            />

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
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
                  className="h-5 w-5 accent-[var(--color-accent)]"
                />
                Only what I chose
              </label>
            </div>

            <BoardFilterRail
              facets={facets}
              filters={filters}
              onChange={setFilters}
              showing={visibleCardCount}
              total={allCandidates.length}
            />
          </div>

          <div className="lg:col-start-1 lg:row-start-2 space-y-12 lg:mt-12">
            <BoardSections
              groups={restGroups}
              images={images}
              selections={optimistic}
              focusedId={focusedId}
              shared={shared}
              whys={whys}
              onChoose={choose}
              onFocus={setFocusedId}
              passing={passing}
              onStartPass={setPassing}
              onCancelPass={() => setPassing(null)}
              onPass={passWithReason}
            />

            <WeatherBackups
              backups={weatherBackups}
              selections={optimistic}
              onChoose={choose}
              {...(weatherFreshness ? { freshness: weatherFreshness } : {})}
            />

            <WeatherCredit groups={groups} {...(weatherFreshness ? { freshness: weatherFreshness } : {})} />
          </div>
        </div>
      )}

    </div>
  );
}

/**
 * THE GROUPS, AND THE ONE PIECE OF HIERARCHY ON THE BOARD.
 *
 * §18 bans the endless identical card, and a uniform two-column grid is that
 * pattern's structural half: with every cell the same size the eye has no entry
 * point, so twenty-four places read as one long undifferentiated wall whatever
 * is printed inside them.
 *
 * So the strongest card in each group leads it, across the full width, with room
 * for a larger picture and larger type — and the rest follow two-up beneath it.
 * The rank is the board's own: the groups arrive sorted by fit, so the lead is
 * the card the fit model already put first. Nothing is invented to make it look
 * important, and a group too short to have a "first among several" (fewer than
 * three) gets no lead, because promoting one of two cards says nothing.
 */
function BoardSections({
  groups,
  images,
  selections,
  focusedId,
  shared,
  whys,
  onChoose,
  onFocus,
  passing,
  onStartPass,
  onCancelPass,
  onPass,
}: {
  groups: readonly RenderedGroup[];
  images: Record<string, ImageRecord>;
  selections: SelectionMap;
  focusedId: string | null;
  shared: SharedBoardFacts;
  /** The sentence each card leads with, chosen across the board. */
  whys: Record<string, string | null>;
  onChoose: (placeId: string, status: SelectionStatus) => void;
  onFocus: (placeId: string) => void;
  passing: string | null;
  onStartPass: (placeId: string) => void;
  onCancelPass: () => void;
  onPass: (candidate: DiscoveryCandidate, reason: PassReason) => void;
}) {
  return (
    <div className="space-y-12">
      {groups.map((entry) => (
        <section
          key={`${entry.group}${entry.continued ? ':more' : ''}`}
          {...(entry.continued ? {} : { 'aria-labelledby': `group-${entry.group}` })}
          {...(entry.continued ? { 'aria-label': `${BOARD_GROUP_HEADINGS[entry.group].title}, continued` } : {})}
        >
          {entry.continued ? null : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-2 border-ink pt-4">
                <h2 id={`group-${entry.group}`} className="display-md text-ink">
                  {BOARD_GROUP_HEADINGS[entry.group].title}
                </h2>
                <span className="numeral text-sm text-accent">{entry.candidates.length}</span>
              </div>
              <p className="mt-1.5 max-w-2xl text-sm text-ink-muted">
                {BOARD_GROUP_HEADINGS[entry.group].blurb}
              </p>
            </>
          )}

          {/*
            THINGS TO SKIP DO NOT GET THE SAME SPACE AS THINGS TO DO.

            Six full cards is about two thousand pixels arguing for places we
            have just explained are wrong for this trip. The group is still
            complete, still explained and still re-includable; it is simply a
            list, because the decision it asks for is "no, unless" rather than
            "yes or no".
          */}
          {entry.group === 'weak_fit' ? (
            <ul className="mt-4 space-y-2" data-testid="skip-list">
              {entry.candidates.map((candidate) => (
                <li key={candidate.place.id}>
                  <SkipRow
                    candidate={candidate}
                    status={selections[candidate.place.id]}
                    onChoose={onChoose}
                  />
                </li>
              ))}
            </ul>
          ) : (
            /*
              Two columns from the first width that can hold them, and never
              more. Three-up made every card a column of stacked fragments;
              one-up at 1024 made each card six hundred pixels wide, which is a
              paragraph pretending to be a card. The lead spans both.
            */
            <div className={cx('grid gap-4 sm:grid-cols-2', entry.continued ? '' : 'mt-4')}>
              {entry.candidates.map((candidate, index) => (
                <PlaceCard
                  key={candidate.place.id}
                  candidate={candidate}
                  image={cardImage(images, candidate)}
                  status={selections[candidate.place.id]}
                  focused={focusedId === candidate.place.id}
                  featured={!entry.continued && index === 0 && entry.candidates.length >= 3}
                  shared={shared}
                  why={whys[candidate.place.id] ?? null}
                  onChoose={onChoose}
                  onFocus={onFocus}
                  passing={passing === candidate.place.id}
                  onStartPass={() => onStartPass(candidate.place.id)}
                  onCancelPass={onCancelPass}
                  onPass={(reason) => onPass(candidate, reason)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
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
 * WHICH CARDS GET A PHOTOGRAPH.
 *
 * One filter, on meaning rather than on availability: a `weak` subject match is
 * a file found by searching a name, and a card that says "this is the waterfall"
 * beside a picture of a different waterfall in the same valley is worse than a
 * card with no picture — it is a claim, and it is wrong.
 *
 * `moderate` is admitted, and that is a deliberate loosening. It means the
 * entity's *own* stated media category contained the file, which the schema
 * itself describes as "good enough to sit beside a name, not good enough to
 * headline a page" — and a board card is precisely the first of those. The
 * previous rule took `strong` only *and* only for base places and top picks,
 * which on a real board meant no photograph ever appeared on any card.
 */
function cardImage(
  images: Record<string, ImageRecord>,
  candidate: DiscoveryCandidate,
): ImageRecord | null {
  const image = images[candidate.place.id];
  if (!image) return null;
  return image.subjectConfidence === 'weak' ? null : image;
}

/**
 * WHAT A CARD SHOWS BEFORE YOU ASK IT ANYTHING.
 *
 * The order is the order a decision is made in: what it looks like, what it is
 * called in a script the reader can read, where it is and what getting there
 * costs, how strongly we recommend it, *why*, then the three practical numbers.
 * At most two chips, and only for facts that change what the traveller has to
 * do. Everything else — the description, the caveats, the provenance — is behind
 * one disclosure named for what is inside it.
 *
 * "Why this fits" is expanded and the negatives are collapsed. It was the other
 * way round, which on a product whose entire differentiation is personal fit
 * meant the argument was hidden and the disclaimers led.
 */
function PlaceCard({
  candidate,
  image,
  status,
  focused,
  featured,
  shared,
  why,
  onChoose,
  onFocus,
  passing,
  onStartPass,
  onCancelPass,
  onPass,
}: {
  candidate: DiscoveryCandidate;
  /** Null where nothing licensable was found, which is most of the world. */
  image: ImageRecord | null;
  status: SelectionStatus | undefined;
  focused: boolean;
  /** The strongest card in its group. See `BoardSections`. */
  featured: boolean;
  /** Everything the board has already said, so this card does not repeat it. */
  shared: SharedBoardFacts;
  /** The sentence this card leads with, chosen across the board. */
  why: string | null;
  onChoose: (placeId: string, status: SelectionStatus) => void;
  onFocus: (placeId: string) => void;
  passing: boolean;
  onStartPass: () => void;
  onCancelPass: () => void;
  onPass: (reason: PassReason) => void;
}) {
  const { place, fit, access, operating } = candidate;
  const suppressed = shared.suppressed;
  const blocked = fit.band === 'not_workable';
  const chips = chipsFor(candidate, suppressed, shared.verificationMarker);
  const stats = cardStats(candidate, shared);
  const description = descriptionOf(place);

  return (
    <article
      data-place-card={place.id}
      className={cx(
        CARD_SURFACE,
        // `h-full` so every card in a row is the same height, which is what puts
        // every row of buttons on one line.
        //
        // `scroll-mt` is the other half of a sticky toolbar: two bars are pinned
        // to the top of this page, so anything the browser scrolls to the top
        // edge lands underneath about 133px of chrome.
        'flex h-full scroll-mt-[calc(var(--chrome-height)+5.5rem)] flex-col overflow-hidden transition-colors',
        // The lead card takes the row. Not a decoration: it is the only thing
        // giving a wall of equal cells somewhere for the eye to start.
        featured && 'sm:col-span-2',
        status === 'included' && 'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]',
        status === 'excluded' && 'opacity-60',
        focused && 'ring-2 ring-ink/40 ring-offset-2 ring-offset-[var(--color-paper)]',
      )}
      onMouseEnter={() => onFocus(place.id)}
      onFocusCapture={() => onFocus(place.id)}
    >
      <div className="relative">
        {/*
          A photograph when one was licensed *and* credibly of this place; the
          generated plate otherwise.

          Never cropped — a crop of a share-alike file is an adaptation, and the
          prop type refuses one here. What changed is the *frame*: it takes the
          file's own shape (`ratio="natural"`), so an unmodified photograph fills
          it instead of floating as a letterboxed sliver between two coloured
          bands. The credit moves to the foot of the card for the same reason:
          rendered verbatim and reachable, but no longer the loudest text above
          the name of the place.
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
            ratio="natural"
            credit="none"
            category={place.category}
          />
        ) : (
          <PlacePlate
            category={place.category}
            className={featured ? 'h-56' : 'h-32'}
            /*
              The three facts that make one plate differ from the next. Without
              them eleven easy walks in one city are eleven identical rectangles
              — which is exactly what a fresh reviewer found.
            */
            signature={{
              intensity: place.physicalIntensity,
              minutes: place.typicalDurationMinutes,
              hiddenGemScore: place.hiddenGemScore,
            }}
          />
        )}
      </div>

      <div className={cx('flex flex-1 flex-col p-4', featured && 'sm:p-5')}>
        <h3
          className={cx(
            'font-display leading-snug text-ink',
            featured ? 'text-2xl sm:text-3xl' : 'text-xl',
          )}
        >
          {/*
            English or romanised first, the native name beside it. The board
            rendered raw local script for every card in Tokyo, on an
            English-language interface, while the source records held romanised
            alternates that nothing read. Nothing here translates: `PlaceName`
            chooses between names a source actually published.
          */}
          <PlaceName entity={place} />
        </h3>

        {/*
          Where it is and what getting there costs, on one line. Two facts a
          traveller uses together and which used to sit four rows apart.
        */}
        <p className="mt-0.5 text-xs text-ink-faint">
          {place.locality}
          {' · '}
          <TravelPhrase candidate={candidate} suppressed={suppressed} />
        </p>

        {/*
          The meter answers "how well does this suit you", which is a question
          the trip has already closed for a place it cannot reach — see
          `recommendationLabel`. Null there rather than a second verdict beside
          the heading's.
        */}
        {recommendationLabel(candidate) !== null ? (
          <div className="mt-3">
            <FitMeter
              band={fit.band}
              label={recommendationLabel(candidate)!}
              meter={FIT_BAND_METER[fit.band]}
            />
          </div>
        ) : null}

        {/*
          THE ARGUMENT, OPEN. One sentence, never a panel of them: a card that
          lists eight reasons has not made a case, it has made a list.

          Absent where there is nothing left to say that the board has not
          already said. A card with no reason line is a card that is honest
          about having no argument; a card padded with "A viewpoint." has
          stopped being worth reading.
        */}
        {why ? (
          <p
            className={cx('mt-2 text-sm leading-relaxed', blocked ? 'text-clay' : 'text-ink-muted')}
            data-testid="card-why"
          >
            {why}
          </p>
        ) : null}

        {/*
          ONLY THE NUMBERS THIS CARD DOES NOT SHARE WITH THE BOARD.

          "Time there 1 hr 30 min · Cost Free · Effort Easy", identical down
          twenty-four cards, was named verbatim by a fresh designer as the §18
          banned pattern. The board now states its norm once, above; what is left
          here is the figure on which this place actually differs — which is the
          figure somebody comparing places is looking for. A card that matches
          the norm on all three shows none, and is no poorer for it.
        */}
        {stats.length > 0 ? (
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs" data-testid="card-stats">
            {stats.map((stat) => (
              <Stat key={stat.key} label={stat.label}>
                {stat.value}
              </Stat>
            ))}
          </dl>
        ) : null}

        {chips.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5" data-testid="card-chips">
            {chips.map((chip: BoardChip) => (
              <Badge key={chip.key} tone={chip.tone}>
                {chip.label}
              </Badge>
            ))}
          </div>
        ) : null}

        {/*
          The one practical statement that changes a decision, where there is
          one. Access and hours are separate questions and a card that has a
          problem with both says so once each; a card that shares its problem
          with the whole board says nothing, because the board has said it.
        */}
        {operating.status === 'closed_throughout' ? (
          <p className="mt-3 rounded-[var(--radius-control)] bg-clay-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Shut on every day of your trip.
          </p>
        ) : operating.status === 'open_some_days' ? (
          <p className="mt-3 rounded-[var(--radius-control)] bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Open on {operating.openDates.length} of your {operating.byDate.length} days
            {operating.hoursSummary ? `, ${operating.hoursSummary}` : ''} — we will only put it on
            one of those.
          </p>
        ) : access.status === 'partial' ? (
          <p className="mt-3 rounded-[var(--radius-control)] bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Reachable on {access.usableDates.length} of your {access.byDate.length} days — we will
            only put it on one of those.
          </p>
        ) : null}

        <details className="mt-3">
          <summary
            className={cx(
              MIN_TARGET_SUMMARY,
              'cursor-pointer text-xs font-medium text-ink-muted hover:text-ink',
            )}
          >
            More about this place
          </summary>
          <div className="mt-2 space-y-2">
            {/*
              What it is, where that is worth a sentence. §8.7 bans "A lake." and
              "A viewpoint." as copy, and a live board carried "A easy walk."
              eleven times — the classifier's honest minimal sentence for a
              record nothing is published about, and a line that costs the reader
              a fixation and returns nothing. `descriptionOf` returns null there.
            */}
            {description ? (
              <p className="text-sm leading-relaxed text-ink-muted">{description}</p>
            ) : null}

            {/*
              The weather sentence, only where it is this card's own and not the
              board's. The verb has to match the evidence, so the sentence is
              built where the evidence is known rather than assembled here.
            */}
            {candidate.weather.note && !suppressed.has('weather') ? (
              <p className="text-xs leading-relaxed text-ink-faint">{candidate.weather.note}</p>
            ) : null}

            {fit.blockers.length > 1 ? (
              <ul className="rounded-[var(--radius-card)] bg-clay-soft p-3 text-xs leading-relaxed text-ink-muted">
                {fit.blockers.slice(1).map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            ) : null}

            {fit.reasons.length > 1 ? (
              <ul className="space-y-1 rounded-[var(--radius-card)] bg-paper-sunk p-3 text-xs leading-relaxed text-ink-muted">
                {fit.reasons.slice(1).map((reason) => (
                  <li key={reason}>{reason}</li>
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

            {operating.requiresVerification && operating.verifyNote && !suppressed.has('hours') ? (
              <p className="text-xs leading-relaxed text-ink-muted">{operating.verifyNote}</p>
            ) : null}

            {place.accessGroup ? (
              <p className="text-xs leading-relaxed text-ink-faint">
                {/*
                  Two records that share one car park would otherwise read as two
                  unrelated stops with similar names.
                */}
                Part of {place.accessGroup.label}. {place.accessGroup.note}
              </p>
            ) : null}

            <EvidencePanel candidate={candidate} />

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

        {/*
          The credit, at the foot of the card rather than over the name.

          Rendered verbatim, in the tab order, with the file page and the licence
          as real links — the obligation is unchanged. What changed is where it
          sits: two to four lines of dotted-underlined attribution directly above
          the place's name made the photographer the loudest text on a card about
          a river.
        */}
        {image ? <ImageCredit image={image} className="mt-3" /> : null}

        <div className="mt-auto pt-4">
          {/*
            A choice that has become impossible stays visible as a conflict.
            Silently flipping it to "Skip" would rewrite what someone asked for
            and hide the one fact they need in order to change their mind.
          */}
          {blocked && status === 'included' ? (
            <p className="mb-2 rounded-[var(--radius-control)] bg-clay-soft p-2.5 text-xs leading-relaxed text-clay">
              You picked this, and it no longer works on these dates. We have kept your choice —
              change your dates, your transport answers, or skip it.
            </p>
          ) : null}

          {passing ? (
            /*
              THE REASON, ASKED FOR ONCE AND USED IMMEDIATELY.

              In place of the buttons rather than under them: a five-way choice
              added below a three-way one is a card that grows by sixty pixels
              every time somebody's finger lands near "Skip".
            */
            <div data-testid="card-pass-reasons">
              <p className="text-xs text-ink-muted">Why not this one?</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PASS_REASONS.map((reason) => (
                  <button
                    key={reason.id}
                    type="button"
                    onClick={() => onPass(reason.id)}
                    className={cx(
                      'rounded-[var(--radius-control)] border border-rule px-2.5 text-xs text-ink-muted transition-colors hover:border-clay hover:text-clay',
                      MIN_TARGET,
                    )}
                  >
                    {reason.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={onCancelPass}
                  className={cx('px-2 text-xs text-ink-faint underline', MIN_TARGET)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              className="flex gap-1.5"
              role="group"
              aria-label={`Your decision on ${displayNameOf(place)}`}
            >
              {(['included', 'maybe', 'excluded'] as const).map((option) => {
                // Offering "Include" on a stop we just explained is impossible
                // would let the traveller build a plan that cannot run.
                const unavailable = blocked && option === 'included' && status !== 'included';
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() =>
                      option === 'excluded' && status !== 'excluded'
                        ? onStartPass()
                        : onChoose(place.id, option)
                    }
                    disabled={unavailable}
                    aria-pressed={status === option}
                    // The reason names the actual constraint. "Low logistics
                    // fit" tells nobody which of their answers to change.
                    title={unavailable ? (fit.blockers[0]?.message ?? undefined) : undefined}
                    className={cx(
                      'flex flex-1 items-center justify-center rounded-[var(--radius-control)] border px-2 text-xs font-medium whitespace-nowrap transition-colors duration-[var(--motion-fast)]',
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
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * HOW LONG IT TAKES TO GET THERE, AND BY WHAT, IN A CLAUSE.
 *
 * Both facts come off this card's own `reach`, which is the object the scorer,
 * the detour classifier, the auto-selector and the planner all read — so the
 * number, the mode and the journey the itinerary will schedule cannot disagree
 * without one of them being changed on purpose.
 *
 * The board took its mode from the matrix, which has *one* mode for the whole
 * board, so on a car-free trip every card read "Walk from base": a true
 * statement about the matrix and a false one about the journey.
 *
 * Where the whole board is unrouted the clause says nothing at all, because the
 * board has already said it once at the top. Twenty-four copies of "we could not
 * check the journey" is not honesty, it is noise wearing honesty's clothes.
 */
function TravelPhrase({
  candidate,
  suppressed,
}: {
  candidate: DiscoveryCandidate;
  suppressed: ReadonlySet<SharedFactKind>;
}) {
  if (candidate.detourClass === 'base') return <>at your base</>;
  if (candidate.reach.status !== 'measured') {
    if (suppressed.has('journey')) return <>journey not timed</>;
    return (
      <>
        {candidate.detourClass === 'unknown'
          ? 'journey not verified'
          : describeReachFromBase(candidate.reach, formatMinutes)}
      </>
    );
  }
  const { mode, travelMinutes, provenance } = candidate.reach;
  /*
   * A measured walk that is only *pricing* a journey nobody could time: the
   * traveller's scheduled modes were never measured, the destination's own
   * evidence observes a network, and the walking figure is the fallback
   * network's answer rather than this traveller's journey. The sentence is
   * minted in the reach module beside the rule that produces the state — the
   * walk stays a walk, and no transit time is invented for it.
   *
   * Read off `journeyProxy` rather than off `detourClass === 'unknown'`, which
   * is what it used to test. That was the same fact asked of the wrong witness:
   * the class is a statement about the traveller's budgets, so a proxy walk
   * long enough to bust the day's travel allowance is filed `too_far` before
   * the proxy rule is ever reached — and the card then went back to reading out
   * a walking clock as this traveller's distance. On a delivered metropolitan
   * board that produced "2 hr 17 min on foot from base" over the destination's
   * best-known tower, immediately above the same card's own admission that no
   * route here could be confirmed.
   */
  if (candidate.journeyProxy) {
    return (
      <>
        {describeTransitBlindWalk(travelMinutes, formatMinutes, {
          pastDayBudget: candidate.detourClass === 'too_far',
        })}
      </>
    );
  }
  /*
   * A modelled journey says so, in one word.
   *
   * `modelled` here means the road matrix held a distance for the pair and
   * nothing measured could carry it in a mode this traveller has — so the number
   * is that distance walked at a conservative pace, not a measurement. The
   * planner has walked these since the multimodal pass; the board refused them
   * outright until the derivation moved into the shared resolver. "About" is
   * what a person says about a figure they worked out rather than read.
   */
  return (
    <>
      {provenance === 'modelled' ? 'about ' : ''}
      {formatMinutes(travelMinutes)} {REACH_MODE_PHRASE[mode]} from base
    </>
  );
}

/**
 * What to have in reserve, if the weather takes something.
 *
 * A cross-cut rather than a group: every place here already has a primary
 * section above, and the point is precisely that the good bad-weather options
 * are scattered across the other groups where nobody would think to look for
 * them on a wet morning. So this is a list of names rather than a second set of
 * cards.
 *
 * It appears only when something is actually at risk, and the two registers are
 * kept apart because they are different claims: a forecast is about *your dates*,
 * a seasonal pattern is about *this time of year*.
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
  const usable = backups.suggestions.filter((backup) => selections[backup.placeId] !== 'excluded');
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
          The age of the evidence, beside the kind of it. A stale snapshot
          renders — an old forecast is worth more than none — and it must not
          render in the same voice as a fresh one.
        */}
        {forecast && freshness === 'stale' ? <Badge tone="amber">Fetched a while ago</Badge> : null}
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
        <p className="mt-4 max-w-2xl rounded-[var(--radius-control)] bg-amber-soft p-3 text-sm leading-relaxed text-ink-muted">
          {/*
            No landform, in a sentence whose whole point is not inventing one.
            This used to end "would open up the sheltered stops down the valley"
            — a claim about one mountain region, rendered on a board that now
            compiles anywhere.
          */}
          <span className="font-medium text-ink">Nothing on your board fits.</span> Everything else
          here is either too far, shut on your dates, or exposed to the same weather — so we are not
          going to invent a fallback. Widening how far you will go is the change most likely to open
          something up.
        </p>
      ) : (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {usable.map((backup) => (
            <li
              key={backup.placeId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[var(--radius-control)] border border-rule p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{backup.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{backup.why}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-ink-faint">
                  {/*
                    The mode, not just the number. A backup is taken on a morning
                    somebody has already lost their plan — "40 min on foot" and
                    "40 min by train" are not the same rescue.
                  */}
                  {backup.travelMinutesFromBase === 0
                    ? 'in town'
                    : `${backup.travelMinutesFromBase} min ${REACH_MODE_PHRASE[backup.travelModeFromBase]}`}
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
 * The cards quote provider numbers and Open-Meteo's data is CC BY 4.0, so the
 * notice has to appear wherever the data does. Once per page rather than once
 * per card: twenty-three copies of the same sentence is not attribution.
 */
function WeatherCredit({
  groups,
  freshness,
}: {
  groups: readonly SerializedGroup[];
  freshness?: WeatherSnapshotState | 'not_fetched';
}) {
  const candidates = groups.flatMap((group) => group.candidates);
  const notice = candidates.find((candidate) => candidate.weather.attribution)?.weather.attribution;
  const label = candidates.find((candidate) => candidate.weather.evidenceLabel)?.weather
    .evidenceLabel;
  if (!notice) return null;

  return (
    <p className="text-[11px] leading-relaxed text-ink-faint" data-testid="board-weather-credit">
      {label ? `${label} for your dates. ` : ''}
      {notice}{' '}
      {/*
        What is actually known about when this was read. "Conditions change; we
        have not checked today" was said whatever the snapshot's age.
      */}
      {freshness === 'stale'
        ? 'This is the last weather we fetched and it is old enough to be worth fetching again.'
        : freshness === 'expired' || freshness === 'not_fetched'
          ? 'Nothing here is a claim about the weather on your dates.'
          : 'Conditions change; we have not checked today.'}
    </p>
  );
}

const STATUS_STYLE: Record<SelectionStatus, string> = {
  included: 'border-accent bg-accent-soft text-accent-strong',
  maybe: 'border-slate-blue bg-slate-blue-soft text-slate-blue',
  excluded: 'border-clay bg-clay-soft text-clay',
};

/**
 * THE ONE LINK ON EVERY CARD, AT A SIZE A THUMB CAN HIT.
 *
 * Measured at 130x13 px — under a third of WCAG 2.5.5's 44 px in the axis that
 * matters, and it is the link that takes somebody to the official page to check
 * a closure. The floor is lifted on touch widths only, because on a desktop a
 * 44px tall line inside 11px type would look broken.
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
 * One row rather than a card: name, the reason in a sentence, and the same three
 * buttons every other card has — because "probably skip" is our opinion and the
 * traveller is allowed to disagree with it. Include stays disabled only where
 * the place is genuinely impossible.
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
  const { place, fit, operating } = candidate;
  const blocked = fit.band === 'not_workable';
  // The blocker where there is one — it is the specific, actionable answer — and
  // the quality layer's own sentence otherwise, which is always present.
  const headline = fit.blockers[0]?.message ?? candidate.quality.reason;

  return (
    <article
      data-place-card={place.id}
      className={cx(
        CARD_SURFACE,
        'flex scroll-mt-[calc(var(--chrome-height)+5.5rem)] flex-wrap items-start gap-x-4 gap-y-3 p-3 transition-colors',
        status === 'included' && 'border-pine',
        status === 'excluded' && 'opacity-60',
      )}
    >
      {/*
        One line on a desktop, two on a phone. `flex-1` alone left the text a
        hundred and thirty pixels wide beside three buttons that will not shrink.
      */}
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-display text-base leading-snug text-ink">
            <PlaceName entity={place} />
          </h3>
          <span className="text-xs text-ink-faint">{place.locality}</span>
          {recommendationLabel(candidate) !== null ? (
            <Badge tone={blocked ? 'clay' : 'neutral'}>{FIT_BAND_LABELS[fit.band]}</Badge>
          ) : null}
        </div>

        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          <span className={cx('font-medium', blocked ? 'text-clay' : 'text-ink')}>
            {blocked ? 'Why this will not work' : 'Why we would skip it'}
          </span>{' '}
          — {headline}
        </p>

        {/*
          THE DATE FACT SURVIVES THE COMPACT ROW. "Shut on every day of your
          trip" is not a nuance, it is the whole answer.
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

        {blocked && status === 'included' ? (
          <p className="mt-2 rounded-[var(--radius-control)] bg-clay-soft p-2.5 text-xs leading-relaxed text-clay">
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
            {/* The same stub gate the full card uses. See `descriptionOf`. */}
            {descriptionOf(place) ? (
              <p className="text-xs leading-relaxed text-ink-muted">{descriptionOf(place)}</p>
            ) : null}
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
        aria-label={`Your decision on ${displayNameOf(place)}`}
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
                'flex items-center justify-center rounded-[var(--radius-control)] border px-3 text-xs font-medium whitespace-nowrap transition-colors max-sm:flex-1',
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
    </article>
  );
}

/**
 * WHERE THIS CAME FROM — the audit trail, inside the card's own disclosure.
 *
 * It used to be a second disclosure on the outside of every card, headed "Why we
 * trust this (0 of 6 checked)": a fraction nobody outside the team can act on,
 * attached to a promise of trust it withdraws in the same breath, on all
 * twenty-four cards of a live board. §26 names that string.
 *
 * What survives is the part somebody who has opened a card genuinely wants: the
 * official page, what was established, and — the honest half — what nobody
 * publishes. A traveller deciding whether to travel an hour needs to know that
 * nobody published the hours far more than they need the two facts we did
 * establish.
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

  if (answered.length === 0 && !evidence.officialUrl && unanswered.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-rule pt-2 text-xs">
      <p className="font-medium text-ink">{evidenceDisclosureLabel(answered.length)}</p>

      {blocking.length > 0 || mustBook || admission ? (
        <p className="leading-relaxed text-ink-muted">
          {blocking.length > 0 ? 'An official notice says it is closed. ' : ''}
          {mustBook
            ? booking?.permitRequired === 'yes'
              ? 'A permit is needed. '
              : booking?.timedEntry === 'yes'
                ? 'Entry is by timed slot. '
                : 'You have to book ahead. '
            : ''}
          {admission ? describeCost(admission) : ''}
        </p>
      ) : null}

      {cautions.length > 0 ? (
        <p className="rounded-[var(--radius-control)] bg-amber-soft p-2.5 leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">Worth knowing.</span> {cautions[0]!.statement}
          {/*
            Why it is being shown rather than acted on, where it is not acted on.
            A closure that ended before the traveller arrives is still worth
            reading and must not remove a place — and a warning with no
            explanation of why nothing changed reads as an inconsistency.
          */}
          {noteOf(cautions[0]!) ? <span className="text-ink-faint"> {noteOf(cautions[0]!)}</span> : null}
        </p>
      ) : null}

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

      {answered.length > 0 ? (
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
      ) : null}

      {unanswered.length > 0 ? (
        <p className="leading-relaxed text-ink-faint">
          {/*
            De-duplicated before counting: several fact paths carry labels a
            reader cannot tell apart once lowercased in a running sentence,
            and a list that says the same thing twice reads as a defect
            rather than as thoroughness. The remainder is counted over the
            distinct labels so the arithmetic matches what is printed.
          */}
          {(() => {
            const labels = [
              ...new Set(unanswered.map((fact) => FACT_PATH_LABELS[fact.factPath].toLowerCase())),
            ];
            const shown = labels.slice(0, 4);
            const rest = labels.length - shown.length;
            return `Nobody we could read publishes ${shown.join(', ')}${
              rest > 0 ? ` and ${rest} more` : ''
            }.`;
          })()}
        </p>
      ) : null}
    </div>
  );
}

/** A closure carries a note when it is shown but not enforced. Safety does not. */
function noteOf(entry: ClosureEvidence | SafetyEvidence): string | undefined {
  return 'note' in entry ? entry.note : undefined;
}

function describeCost(cost: NonNullable<DiscoveryCandidate['evidence']>['costs'][number]): string {
  if (cost.free) return 'Free to enter.';
  if (!cost.money) return 'There is a charge.';
  const { currency, amount, maxAmount, unit } = cost.money;
  const range = maxAmount !== undefined ? `${amount}–${maxAmount}` : `${amount}`;
  return `${range} ${currency} ${MONEY_UNIT_LABELS[unit]}.`;
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
