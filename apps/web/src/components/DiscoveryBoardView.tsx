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
  FOCUS_RING,
  FitMeter,
  OVERLAY_INPUT,
  PlaceName,
  PlacePlate,
  buttonClass,
  cx,
} from './ui';
import { CheckIcon, ChevronIcon, InfoIcon, RouteIcon, SparkIcon } from './board/icons';
import '@/styles/board.css';
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
import { BoardStage, type StageFeature } from './board/BoardStage';
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
  initialAutoPicks = [],
  autoPickNotes,
  hasItinerary,
  weatherBackups,
  boardVersion: declaredVersion,
  weatherFreshness,
  images = {},
  base = null,
  imageryPending = 0,
  tiles = null,
  lead = null,
}: {
  /** The sheet header and the notes about the trip, set at the top of the register. */
  lead?: React.ReactNode;
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
  /** Included cards Sidequest picked (source `auto`), so a card can say whose pick it is. */
  initialAutoPicks?: readonly string[];
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
  const serverKey = summaryVersion([
    boardVersion,
    marksFingerprint(initialSelections),
    [...initialAutoPicks].sort().join(','),
  ]);
  const [mirror, setMirror] = useState<{ key: string; value: SelectionMap; notes: string[]; autoPicks: readonly string[] }>({
    key: serverKey,
    value: initialSelections,
    notes: autoPickNotes,
    autoPicks: initialAutoPicks,
  });
  if (mirror.key !== serverKey) {
    setMirror({ key: serverKey, value: initialSelections, notes: autoPickNotes, autoPicks: initialAutoPicks });
  }
  const settled =
    mirror.key === serverKey ? mirror : { value: initialSelections, notes: autoPickNotes, autoPicks: initialAutoPicks };
  const selections = settled.value;
  const notes = settled.notes;
  const autoPickSet = new Set(settled.autoPicks);

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

  function choose(placeId: string, status: SelectionStatus, reason?: PassReason) {
    const next = optimistic[placeId] === status ? undefined : status;
    const previous = selections;
    setError(null);
    startTransition(async () => {
      applyOptimistic({ [placeId]: next });
      // Un-ticking an include (ours or theirs) is stored as a decision — see `withdrawSelection`.
      const result = await setSelectionAction(tripId, placeId, next ?? null, next === 'excluded' ? (reason ?? null) : null);
      if (result.ok) {
        // Any hand-made answer makes the card the traveller's, never Sidequest's pick.
        setMirror((current) => ({
          ...current,
          value: { ...current.value, [placeId]: next },
          autoPicks: current.autoPicks.filter((id) => id !== placeId),
        }));
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
    choose(candidate.place.id, 'excluded', reason);
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
        target.ids.map((id) => setSelectionAction(tripId, id, 'excluded', target.reason)),
      );
      if (results.every((result) => result.ok)) {
        setMirror((current) => ({
          ...current,
          autoPicks: current.autoPicks.filter((id) => !target.ids.includes(id)),
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

  /**
   * One decision applied to several cards — a group's "Include all" or "Clear".
   *
   * The same path a single press takes, once per card, so nothing reaches the
   * store that a traveller could not have done by hand; the group button only
   * saves them the presses. `null` withdraws a mark, exactly as un-ticking does.
   */
  function chooseMany(ids: readonly string[], status: SelectionStatus | null) {
    if (ids.length === 0) return;
    const previous = selections;
    setError(null);
    setFollowUp(null);
    startTransition(async () => {
      applyOptimistic(Object.fromEntries(ids.map((id) => [id, status ?? undefined])));
      const results = await Promise.all(ids.map((id) => setSelectionAction(tripId, id, status, null)));
      if (results.every((result) => result.ok)) {
        setMirror((current) => ({
          ...current,
          autoPicks: current.autoPicks.filter((id) => !ids.includes(id)),
          value: { ...current.value, ...Object.fromEntries(ids.map((id) => [id, status ?? undefined])) },
        }));
      } else {
        setMirror((current) => ({ ...current, value: previous }));
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
        // What changed comes first, and is said even when the answer is "nothing".
        notes: [...(result.change ? [result.change] : []), ...(result.notes ?? [])],
        autoPicks: result.autoPicks ?? [],
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

  /*
   * THE NUMBER EVERY PLACE WEARS — on its row and on its pin.
   *
   * Assigned once, in board order, over the places the map draws (a "probably
   * skip" row is listed but not mapped, so it carries no number). The same
   * integer on both sides is what makes the stage and the register one surface.
   */
  const numbers = new Map<string, number>();
  for (const candidate of allCandidates) {
    if (candidate.group === 'weak_fit') continue;
    numbers.set(candidate.place.id, numbers.size + 1);
  }

  const focusedCandidate = focusedId ? allCandidates.find((candidate) => candidate.place.id === focusedId) ?? null : null;
  const feature: StageFeature | null =
    focusedCandidate && numbers.has(focusedCandidate.place.id)
      ? {
          id: focusedCandidate.place.id,
          number: numbers.get(focusedCandidate.place.id)!,
          name: displayNameOf(focusedCandidate.place),
          kind: focusedCandidate.place.displayKind ?? focusedCandidate.place.category.replace(/_/g, ' '),
          meta: [focusedCandidate.place.locality, formatMinutes(focusedCandidate.place.typicalDurationMinutes) + ' there'].filter(Boolean).join(' · '),
          why: whys[focusedCandidate.place.id] ?? null,
          chosen: optimistic[focusedCandidate.place.id] === 'included',
          image: cardImage(images, focusedCandidate),
          fallback: imageryFallbackFor({ kind: 'candidate', id: focusedCandidate.place.id, name: focusedCandidate.place.name, coordinates: focusedCandidate.place.coordinates }),
          category: focusedCandidate.place.category,
        }
      : null;

  const fallbackMap = (
    <BoardMap base={base} places={mapPlaces} focusedId={focusedId} onFocus={focusFromMap} tiles={tiles} />
  );
  const stageAvailable = tiles?.kind === 'vector';

  return (
    <div
      data-testid="discovery-board"
      data-board-version={boardVersion}
      className={cx('flex flex-col lg:grid lg:items-start lg:gap-10', stageAvailable ? 'lg:grid-cols-[minmax(0,35rem)_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,1fr)_22rem]')}
    >
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        {lead}
        {/*
          THE ACTION BAR: STICKY AT THE TOP OF THE REGISTER, PINNED TO THE BOTTOM ON A PHONE.

          One element, two positions. On a 390px screen the register is
          thousands of pixels tall, so the count and the primary action live at
          the thumb; on a desktop they ride the top of the column they count.
          Auto-pick lives here: it answers "there are twenty-four of these and I
          do not want to read them all", so it has to be reachable from wherever
          somebody gives up.
        */}
        <div
          className={cx(
            'board-action-bar z-20 flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden',
            'sm:sticky sm:top-[calc(var(--chrome-height)+0.5rem)] sm:mb-6 sm:flex-nowrap sm:rounded-[20px] sm:border sm:border-ink/10 sm:px-4 sm:py-3',
            'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[70vh] max-sm:rounded-t-[22px] max-sm:border-t max-sm:border-ink/10 max-sm:px-4 max-sm:pt-3',
            'max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-sm:overflow-y-auto',
          )}
          data-testid="board-action-bar"
        >
          {followUp ? (
            <div
              className="board-followup max-sm:order-first max-sm:basis-full max-sm:border-b max-sm:border-ink/10 max-sm:pb-3 sm:fixed sm:right-6 sm:bottom-6 sm:z-50 sm:max-w-sm sm:rounded-[18px] sm:border sm:border-ink/10 sm:bg-paper-raised sm:p-4 sm:shadow-float print:hidden"
              role="status"
              data-testid="board-pass-followup"
            >
              <p className="text-sm leading-relaxed text-ink">{alsoLikeThisPrompt(followUp.reason, followUp.ids.length)}</p>
              <p className="mt-1 text-xs text-ink-faint">Because you passed on {followUp.from}.</p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={applyFollowUp} className={cx(buttonClass('primary', 'sm'), MIN_TARGET)} data-testid="board-pass-followup-apply">
                  Skip {followUp.ids.length === 1 ? 'it' : 'them'} too
                </button>
                <button type="button" onClick={() => setFollowUp(null)} className={cx(buttonClass('ghost', 'sm'), MIN_TARGET)}>
                  Leave them
                </button>
              </div>
            </div>
          ) : null}
          <div className="min-w-0 shrink-0">
            <p className="flex items-baseline gap-1.5 text-sm whitespace-nowrap text-ink" data-testid="board-summary" data-board-version={summary.boardVersion}>
              <strong key={includedCount} className="numeral board-count font-display text-[1.9rem] leading-none font-light text-ink">{includedCount}</strong> chosen
              <span className="text-ink-faint"> of {summary.onBoard}</span>
              {maybeCount > 0 ? <span className="text-ink-muted"> · {maybeCount} maybe</span> : null}
            </p>
            {/* How much of the board is in, at a glance. Decorative: the sentence above says it. */}
            <span aria-hidden="true" className="mt-1.5 block h-[3px] w-28 overflow-hidden rounded-full bg-ink/10">
              <span
                className="block h-full rounded-full bg-flare transition-[width] duration-[var(--motion-base)]"
                style={{ width: `${summary.onBoard > 0 ? Math.round((includedCount / summary.onBoard) * 100) : 0}%` }}
              />
            </span>
          </div>
          <button
            type="button"
            onClick={autoPick}
            disabled={pending}
            className={cx(buttonClass('secondary', 'sm'), MIN_TARGET, 'ml-auto shrink-0 gap-1.5 whitespace-nowrap')}
            data-testid="board-auto-pick"
          >
            <SparkIcon className={cx('h-3.5 w-3.5', pending && 'animate-spin')} />
            {pending ? 'Choosing…' : 'Choose for me'}
          </button>
          <div className="shrink-0 max-sm:basis-full">
            <BuildTripButton tripId={tripId} hasItinerary={hasItinerary} includedCount={includedCount} onReadiness={setReadiness} className="max-sm:w-full max-sm:min-h-12" />
          </div>
        </div>

        {readiness ? <PlannerReadinessPanel readiness={readiness} /> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {autoPicked && notes.length > 0 ? (
          <div className="mb-6 rounded-[16px] border border-flare/30 bg-paper-raised px-4 py-3 fade-up" data-testid="board-auto-pick-notes" data-board-version={summary.boardVersion}>
            <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink">
              <SparkIcon className="h-3.5 w-3.5 text-flare" />
              What Sidequest chose
            </p>
            <ul className="space-y-1.5 text-sm leading-relaxed text-ink">
              {notes.map((note) => (
                <li key={`${summary.boardVersion}:${note}`}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {shared.notes.length > 0 ? (
          <details className="group mb-5 rounded-[14px] bg-paper-sunk/50 px-3.5" data-testid="board-weather-note">
            <summary className={cx(MIN_TARGET_SUMMARY, 'flex cursor-pointer list-none items-center gap-2 text-[13px] leading-snug text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden')}>
              <InfoIcon className="h-3.5 w-3.5 shrink-0" />
              <span>
                {shared.notes.length === 1 ? 'One thing we could not check across this board' : `${shared.notes.length} things we could not check across this board`}
                <span className="ml-1 text-ink-faint">— see what they are</span>
              </span>
              <ChevronIcon className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <ul className="list-disc space-y-1 pb-3 pl-5 text-[13px] leading-snug text-ink-muted">
              {shared.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite" data-testid="board-status">
          {error ? error : `Your board now has ${includedCount} places included and ${maybeCount} marked maybe, out of ${summary.onBoard}. ${visibleCardCount} showing.`}
        </p>

        {summary.carriedOver > 0 ? (
          <p className="mb-6 text-xs leading-relaxed text-ink-faint" data-testid="board-carried-over" data-board-version={summary.boardVersion}>
            You have also decided on {summary.carriedOver} {summary.carriedOver === 1 ? 'place' : 'places'} that is not on this board. Those choices are kept and are not counted above.
          </p>
        ) : null}

        {/*
          THE BOARD AT A GLANCE: jump to a group, or look at only what is in.

          Each group is a pill with its count, so "how much is here, of what
          kind" is answered before scrolling, and a press takes you there.
        */}
        <div className="board-jump -mx-1 mb-4 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 print:hidden">
          <label
            className={cx(
              'relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors',
              MIN_TARGET,
              FOCUS_RING,
              onlyIncluded ? 'border-ink bg-ink text-paper' : 'border-ink/15 text-ink hover:border-ink/40',
            )}
          >
            <input type="checkbox" checked={onlyIncluded} onChange={(event) => setOnlyIncluded(event.target.checked)} className={OVERLAY_INPUT} />
            <CheckIcon className="h-3.5 w-3.5" />
            Only what I chose
          </label>
          <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-ink/15" />
          <nav aria-label="Jump to a group" className="flex shrink-0 items-center gap-1.5">
            {visibleGroups.map((entry) => (
              <a
                key={entry.group}
                href={`#group-${entry.group}`}
                className={cx('inline-flex shrink-0 items-center gap-2 rounded-full px-3 text-[13px] whitespace-nowrap text-ink-muted transition-colors hover:bg-paper-sunk hover:text-ink', MIN_TARGET)}
              >
                {BOARD_GROUP_HEADINGS[entry.group].title}
                <span className="rounded-full bg-ink/8 px-1.5 py-px font-mono text-[11px] text-ink">{entry.candidates.length}</span>
              </a>
            ))}
          </nav>
        </div>
        <BoardFilterRail facets={facets} filters={filters} onChange={setFilters} showing={visibleCardCount} total={allCandidates.length} />

        {visibleGroups.length === 0 ? (
          <div className="ruled-strong py-10">
            <p className="font-display text-2xl text-ink">{filtered ? 'Nothing matches what you asked for' : 'Nothing here fits this trip'}</p>
            <p className="mt-2 max-w-md text-sm text-ink-muted">
              {filtered
                ? 'Every place is still on the board — clear the filters to see them again, or let us choose a starting set.'
                : 'Try widening how far you will travel, or moving your dates — some of what we found here is only reachable for part of the year.'}
            </p>
          </div>
        ) : (
          <div className="space-y-14">
            <BoardSections
              groups={visibleGroups.map((entry) => ({ ...entry, continued: false }))}
              images={images}
              selections={optimistic}
              autoPicks={autoPickSet}
              focusedId={focusedId}
              shared={shared}
              whys={whys}
              numbers={numbers}
              onChoose={choose}
              onChooseMany={chooseMany}
              onFocus={setFocusedId}
              passing={passing}
              onStartPass={setPassing}
              onCancelPass={() => setPassing(null)}
              onPass={passWithReason}
            />
            <WeatherBackups backups={weatherBackups} selections={optimistic} onChoose={choose} {...(weatherFreshness ? { freshness: weatherFreshness } : {})} />
            <WeatherCredit groups={groups} {...(weatherFreshness ? { freshness: weatherFreshness } : {})} />
          </div>
        )}
      </div>
      {/*
        THE STAGE — on a phone it is the first thing on the page, a window onto
        the place; on a wide screen it is the right two-thirds, pinned, and the
        register scrolls past it. Without a vector basemap (tests, a build with
        no map provider) the honest SVG figure takes the same column, after the
        places in the document so a phone meets places first.
      */}
      {stageAvailable ? (
        <div className="relative -mx-5 mb-6 h-[52vh] min-h-[320px] overflow-hidden max-lg:order-first sm:-mx-8 lg:sticky lg:top-[var(--chrome-height)] lg:col-start-2 lg:row-start-1 lg:mx-0 lg:mb-0 lg:h-[calc(100dvh_-_var(--chrome-height)_-_2rem)] lg:min-h-[560px] print:hidden">
          <BoardStage
            base={base}
            places={mapPlaces.map((place) => ({
              id: place.id,
              number: numbers.get(place.id) ?? 0,
              name: place.name,
              coordinates: place.coordinates,
              chosen: place.chosen,
              excluded: optimistic[place.id] === 'excluded',
            }))}
            focusedId={focusedId}
            feature={feature}
            onFocus={focusFromMap}
            fallback={fallbackMap}
          />
        </div>
      ) : (
        <div className="mt-10 lg:sticky lg:top-[calc(var(--chrome-height)+1rem)] lg:col-start-2 lg:row-start-1 lg:mt-0 print:hidden">
          <p className="sheet-label mb-2 text-ink-muted">The board, on the map</p>
          {fallbackMap}
        </div>
      )}
    </div>
  );
}

/**
 * THE GROUPS, AS A REGISTER.
 *
 * Each group opens on a ruled heading with its sheet number and count. The
 * strongest place in a group of three or more leads it as a print — the whole
 * photograph, larger type — and the rest follow as ruled specimen rows: a
 * number, a small print, the argument and the three decisions. No card
 * borders anywhere: the rules and the survey grid are the structure.
 */
function BoardSections({
  groups,
  images,
  selections,
  autoPicks,
  focusedId,
  shared,
  whys,
  numbers,
  onChoose,
  onChooseMany,
  onFocus,
  passing,
  onStartPass,
  onCancelPass,
  onPass,
}: {
  onChooseMany: (placeIds: readonly string[], status: SelectionStatus | null) => void;
  groups: readonly RenderedGroup[];
  images: Record<string, ImageRecord>;
  selections: SelectionMap;
  autoPicks: ReadonlySet<string>;
  focusedId: string | null;
  shared: SharedBoardFacts;
  whys: Record<string, string | null>;
  numbers: ReadonlyMap<string, number>;
  onChoose: (placeId: string, status: SelectionStatus) => void;
  onFocus: (placeId: string) => void;
  passing: string | null;
  onStartPass: (placeId: string) => void;
  onCancelPass: () => void;
  onPass: (candidate: DiscoveryCandidate, reason: PassReason) => void;
}) {
  return (
    <div className="space-y-14">
      {groups.map((entry) => {
        /* What "Include all" would add: every card that can be included and is not in yet — never one the traveller skipped. */
        const addable = entry.candidates
          .filter((candidate) => candidate.fit.band !== 'not_workable')
          .filter((candidate) => selections[candidate.place.id] !== 'included' && selections[candidate.place.id] !== 'excluded')
          .map((candidate) => candidate.place.id);
        const inGroup = entry.candidates.filter((candidate) => selections[candidate.place.id] === 'included').map((candidate) => candidate.place.id);
        const title = BOARD_GROUP_HEADINGS[entry.group].title;
        return (
        <section key={entry.group} aria-labelledby={`group-${entry.group}`} className="scroll-mt-[calc(var(--chrome-height)+6.5rem)]" id={`section-${entry.group}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink/12 pb-3">
            <h2 id={`group-${entry.group}`} className="scroll-mt-[calc(var(--chrome-height)+6.5rem)] font-display text-[1.6rem] leading-tight max-sm:basis-full max-sm:text-[1.45rem] font-light tracking-[-0.02em] text-ink">
              {title}
            </h2>
            <span className="rounded-full bg-ink/8 px-2 py-0.5 font-mono text-[11px] text-ink" aria-label={`${entry.candidates.length} places, ${inGroup.length} chosen`}>
              {inGroup.length > 0 ? `${inGroup.length}/${entry.candidates.length}` : entry.candidates.length}
            </span>
            {entry.group !== 'weak_fit' ? (
              <div className="ml-auto flex items-center gap-1 print:hidden">
                {addable.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => onChooseMany(addable, 'included')}
                    className={cx('inline-flex items-center gap-1 rounded-full px-3 text-[12px] font-medium text-ink transition-colors hover:bg-paper-sunk', MIN_TARGET)}
                    aria-label={`Include all ${addable.length} in ${title}`}
                    data-testid="board-group-include-all"
                  >
                    <CheckIcon className="h-3.5 w-3.5" />
                    Include all
                  </button>
                ) : null}
                {inGroup.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => onChooseMany(inGroup, null)}
                    className={cx('rounded-full px-3 text-[12px] text-ink-muted transition-colors hover:bg-paper-sunk hover:text-ink', MIN_TARGET)}
                    aria-label={`Clear the ${inGroup.length} chosen in ${title}`}
                    data-testid="board-group-clear"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="mt-2 max-w-xl text-sm text-ink-muted">{BOARD_GROUP_HEADINGS[entry.group].blurb}</p>

          {entry.group === 'weak_fit' ? (
            <ul className="mt-4 divide-y divide-ink/10 overflow-hidden rounded-[18px] border border-ink/10 bg-paper-raised/50" data-testid="skip-list">
              {entry.candidates.map((candidate) => (
                <li key={candidate.place.id}>
                  <SkipRow candidate={candidate} status={selections[candidate.place.id]} onChoose={onChoose} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 space-y-3">
              {entry.candidates.map((candidate, index) => (
                <PlaceCard
                  key={candidate.place.id}
                  candidate={candidate}
                  number={numbers.get(candidate.place.id) ?? null}
                  image={cardImage(images, candidate)}
                  status={selections[candidate.place.id]}
                  pickedBy={autoPicks.has(candidate.place.id) ? 'sidequest' : 'traveller'}
                  focused={focusedId === candidate.place.id}
                  featured={index === 0 && entry.candidates.length >= 3}
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
        );
      })}
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
/**
 * A print takes the photograph's own shape — a panorama is a long strip, a
 * portrait a tall card — so the whole file shows with no letterbox and no crop.
 * Only an extreme portrait is held to the frame (it would push the register a
 * screen down), and then the file is shown whole inside it.
 */
function printRatio(image: ImageRecord): string {
  if (image.width <= 0 || image.height <= 0) return 'natural';
  const ratio = image.width / image.height;
  return ratio >= 0.62 && ratio <= 6 ? `${image.width} / ${image.height}` : 'natural';
}

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
 * A PLACE, AS A SPECIMEN ROW.
 *
 * The order is the order a decision is made in: the number that finds it on
 * the map, what it looks like, its name in a script the reader can read, where
 * it is and what getting there costs, how strongly we recommend it, the one
 * sentence of *why* — then the three decisions. Everything else (description,
 * caveats, provenance) is one disclosure away.
 *
 * The lead row of a group is a print: the photograph whole at its own shape,
 * larger type. Every other row keeps a small print at the side. A photograph
 * is never cropped — share-alike files may not be — so the prints have mixed
 * shapes, which is the rhythm of the register rather than a defect of it.
 */
function PlaceCard({
  candidate,
  number,
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
  pickedBy,
}: {
  candidate: DiscoveryCandidate;
  /** The number this place wears on the map; null for a place the map does not draw. */
  number: number | null;
  image: ImageRecord | null;
  status: SelectionStatus | undefined;
  pickedBy?: 'sidequest' | 'traveller';
  focused: boolean;
  featured: boolean;
  shared: SharedBoardFacts;
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
  const fallback = imageryFallbackFor({ kind: 'candidate', id: place.id, name: place.name, coordinates: place.coordinates });
  const label = recommendationLabel(candidate);

  const badge = number !== null ? String(number).padStart(2, '0') : null;
  const kind = place.displayKind ?? null;

  const picture = image ? (
    <DestinationImage image={image} fallback={fallback} ratio={featured ? printRatio(image) : 'natural'} credit="none" category={place.category} backdrop="paper" />
  ) : (
    <PlacePlate
      category={place.category}
      className={cx('rounded-[12px]', featured ? 'h-44 sm:h-56' : 'h-[5.5rem] max-sm:h-[4.75rem]')}
      signature={{ intensity: place.physicalIntensity, minutes: place.typicalDurationMinutes, hiddenGemScore: place.hiddenGemScore }}
    />
  );

  return (
    <article
      data-place-card={place.id}
      data-status={status ?? 'undecided'}
      data-featured={featured || undefined}
      data-focused={focused || undefined}
      className={cx(
        'board-card relative scroll-mt-[calc(var(--chrome-height)+7rem)] rounded-[18px] border border-ink/10 bg-paper-raised/70 p-3 sm:p-4',
        featured ? 'block' : 'grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 max-sm:grid-cols-[5rem_minmax(0,1fr)] max-sm:gap-x-3',
        status === 'excluded' && 'opacity-55',
      )}
      onMouseEnter={() => onFocus(place.id)}
      onFocusCapture={() => onFocus(place.id)}
    >
      {/* The picture, with the number it wears on the map in its corner. */}
      <div className={cx('relative min-w-0 self-start overflow-hidden rounded-[12px]', featured && 'mb-4')}>
        {picture}
        {badge ? (
          <span aria-hidden="true" className="board-pin-badge absolute top-2 left-2">
            {badge}
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        {kind || featured ? (
          <p className="mb-0.5 text-[11.5px] font-medium tracking-[0.02em] text-ink-muted">
            {kind}
            {featured ? `${kind ? ' · ' : ''}${formatMinutes(place.typicalDurationMinutes)} there` : null}
          </p>
        ) : null}
        <h3 className={cx('font-display leading-[1.08] tracking-[-0.015em] text-ink', featured ? 'text-[1.9rem] font-light sm:text-[2.2rem]' : 'text-[1.25rem]')}>
          <PlaceName entity={place} />
        </h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-muted">
          <RouteIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <span>
            {place.locality ? `${place.locality} · ` : ''}
            <TravelPhrase candidate={candidate} suppressed={suppressed} />
          </span>
          {label !== null && !featured ? (
            <span
              className={cx(
                'ml-0.5 rounded-full px-2 py-px text-[11.5px] font-medium',
                blocked ? 'bg-clay-soft text-clay' : 'bg-ink/6 text-ink',
              )}
            >
              {label}
            </span>
          ) : null}
        </p>

        {featured && label !== null ? (
          <div className="mt-3 max-w-xs">
            <FitMeter band={fit.band} label={label} meter={FIT_BAND_METER[fit.band]} />
          </div>
        ) : null}
      </div>

      {/* The argument and its facts: beside the picture on a wide screen, under it on a phone where the column is too narrow to read. */}
      <div className={cx('min-w-0', !featured && 'max-sm:col-span-2 max-sm:mt-1 sm:col-start-2')}>

        {why ? (
          <p className={cx('mt-2 leading-relaxed', featured ? 'text-[15px]' : 'text-sm', blocked ? 'text-clay' : 'text-ink-muted')} data-testid="card-why">
            {why}
          </p>
        ) : null}

        {stats.length > 0 || chips.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {stats.length > 0 ? (
              <dl className="flex flex-wrap gap-1.5 text-xs" data-testid="card-stats">
                {stats.map((stat) => (
                  <Stat key={stat.key} label={stat.label}>
                    {stat.value}
                  </Stat>
                ))}
              </dl>
            ) : null}
            {chips.length > 0 ? (
              <div className="flex flex-wrap gap-1.5" data-testid="card-chips">
                {chips.map((chip: BoardChip) => (
                  <Badge key={chip.key} tone={chip.tone}>
                    {chip.label}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {operating.status === 'closed_throughout' ? (
          <p className="mt-2.5 border-l-2 border-clay pl-2.5 text-xs leading-relaxed text-ink-muted">Shut on every day of your trip.</p>
        ) : operating.status === 'open_some_days' ? (
          <p className="mt-2.5 border-l-2 border-amber pl-2.5 text-xs leading-relaxed text-ink-muted">
            Open on {operating.openDates.length} of your {operating.byDate.length} days
            {operating.hoursSummary ? `, ${operating.hoursSummary}` : ''} — we will only put it on one of those.
          </p>
        ) : access.status === 'partial' ? (
          <p className="mt-2.5 border-l-2 border-amber pl-2.5 text-xs leading-relaxed text-ink-muted">
            Reachable on {access.usableDates.length} of your {access.byDate.length} days — we will only put it on one of those.
          </p>
        ) : null}

        {blocked && status === 'included' ? (
          <p className="mt-2.5 border-l-2 border-clay pl-2.5 text-xs leading-relaxed text-clay">
            {pickedBy === 'sidequest' ? 'We picked this' : 'You picked this'}, and it no longer works on these dates. We have kept {pickedBy === 'sidequest' ? 'it' : 'your choice'} — change your dates, your transport answers, or skip it.
          </p>
        ) : null}
      </div>

      {/* The decision, and everything one press deeper — the full width of the card, so a phone gets room for its thumb. */}
      <div className={cx('min-w-0', featured ? 'mt-1' : 'max-sm:col-span-2 sm:col-start-2')}>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          {passing ? (
            <div data-testid="card-pass-reasons" className="basis-full">
              <p className="text-xs text-ink-muted">Why not this one?</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PASS_REASONS.map((reason) => (
                  <button
                    key={reason.id}
                    type="button"
                    onClick={() => onPass(reason.id)}
                    className={cx('rounded-full border border-ink/20 px-3 text-xs text-ink-muted transition-colors hover:border-clay hover:text-clay', MIN_TARGET)}
                  >
                    {reason.label}
                  </button>
                ))}
                <button type="button" onClick={onCancelPass} className={cx('px-2 text-xs text-ink-faint underline', MIN_TARGET)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="board-decision" role="group" aria-label={`Your decision on ${displayNameOf(place)}`}>
              {(['included', 'maybe', 'excluded'] as const).map((option) => {
                const unavailable = blocked && option === 'included' && status !== 'included';
                const on = status === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => (option === 'excluded' && status !== 'excluded' ? onStartPass() : onChoose(place.id, option))}
                    disabled={unavailable}
                    aria-pressed={on}
                    title={unavailable ? (fit.blockers[0]?.message ?? undefined) : undefined}
                    className={cx(
                      'flex items-center justify-center gap-1.5 px-4 text-xs font-medium whitespace-nowrap transition-[background-color,color,border-color] duration-[var(--motion-fast)]',
                      'min-h-10 max-sm:min-h-11',
                      unavailable && 'cursor-not-allowed text-ink-faint opacity-50',
                      !unavailable && on && SEGMENT_STYLE[option],
                      !unavailable && !on && 'text-ink-muted',
                    )}
                  >
                    {option === 'included' && on ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                    {SELECTION_STATUS_LABELS[option]}
                  </button>
                );
              })}
            </div>
          )}
          {status === 'included' && pickedBy && !passing ? (
            <p className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-muted" data-testid="card-picked-by" data-picked-by={pickedBy}>
              {pickedBy === 'sidequest' ? <SparkIcon className="h-3 w-3 text-flare" /> : null}
              {pickedBy === 'sidequest' ? "Sidequest's pick" : 'Your pick'}
            </p>
          ) : null}
        </div>

        <details className="group/more mt-1">
          <summary className={cx(MIN_TARGET_SUMMARY, 'flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden')}>
            More about this place
            <ChevronIcon className="h-3.5 w-3.5 transition-transform group-open/more:rotate-180" />
          </summary>
          <div className="mt-2 space-y-2 border-l border-ink/15 pl-3">
            {description ? <p className="text-sm leading-relaxed text-ink-muted">{description}</p> : null}
            {candidate.weather.note && !suppressed.has('weather') ? <p className="text-xs leading-relaxed text-ink-faint">{candidate.weather.note}</p> : null}
            {fit.blockers.length > 1 ? (
              <ul className="space-y-1 text-xs leading-relaxed text-clay">
                {fit.blockers.slice(1).map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            ) : null}
            {fit.reasons.length > 1 ? (
              <ul className="space-y-1 text-xs leading-relaxed text-ink-muted">
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
            {operating.requiresVerification && operating.verifyNote && !suppressed.has('hours') ? <p className="text-xs leading-relaxed text-ink-muted">{operating.verifyNote}</p> : null}
            {place.accessGroup ? (
              <p className="text-xs leading-relaxed text-ink-faint">
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

        {image ? <ImageCredit image={image} className="mt-0.5 text-[10.5px] leading-snug text-ink-faint" /> : null}
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
    <section aria-labelledby="weather-backups" className="rounded-[20px] border border-ink/10 bg-paper-sunk/40 p-4 sm:p-5">
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
        <p className="mt-4 max-w-2xl rounded-[14px] bg-amber-soft p-3 text-sm leading-relaxed text-ink-muted">
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
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[14px] border border-ink/10 bg-paper-raised/60 p-3"
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

/** The three answers inside a card's pill control: a filled segment, no outline of its own. Ink, not flare — flare is the build. */
const SEGMENT_STYLE: Record<SelectionStatus, string> = {
  included: 'bg-ink text-paper shadow-[0_1px_2px_rgb(13_26_31/0.2)]',
  maybe: 'bg-slate-blue-soft text-slate-blue',
  excluded: 'bg-clay-soft text-clay',
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
        'flex scroll-mt-[calc(var(--chrome-height)+7rem)] flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 transition-colors',
        status === 'included' && 'bg-paper-raised',
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
          {place.locality && place.locality !== displayNameOf(place) ? <span className="text-xs text-ink-faint">{place.locality}</span> : null}
          {recommendationLabel(candidate) !== null ? (
            <span className={cx('rounded-full px-2 py-px text-[11.5px] font-medium', blocked ? 'bg-clay-soft text-clay' : 'bg-ink/6 text-ink-muted')}>{FIT_BAND_LABELS[fit.band]}</span>
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

        <details className="group/more mt-0.5">
          <summary
            className={cx(MIN_TARGET_SUMMARY, 'flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden')}
          >
            What it is, and everything we checked
            <ChevronIcon className="h-3.5 w-3.5 transition-transform group-open/more:rotate-180" />
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
        className="board-decision shrink-0 max-sm:w-full"
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
                'flex min-h-10 items-center justify-center px-3.5 text-xs font-medium whitespace-nowrap transition-colors max-sm:min-h-11 max-sm:flex-1',
                unavailable && 'cursor-not-allowed text-ink-faint opacity-50',
                !unavailable && status === option ? SEGMENT_STYLE[option] : !unavailable && 'text-ink-muted',
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
    <div className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ink/5 px-2 py-0.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-medium text-ink">{children}</dd>
    </div>
  );
}
