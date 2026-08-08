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
import { Badge, ErrorNote, FitMeter, Panel, PlacePlate, buttonClass, cx, type BadgeTone } from './ui';
import { DestinationImage } from './DestinationImage';
import { BuildTripButton } from './BuildTripButton';
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

  const visibleGroups = groups
    .map((entry) => ({
      ...entry,
      candidates: onlyIncluded
        ? entry.candidates.filter((candidate) => optimistic[candidate.place.id] === 'included')
        : entry.candidates,
    }))
    .filter((entry) => entry.candidates.length > 0);
  const visibleCardCount = visibleGroups.reduce((total, entry) => total + entry.candidates.length, 0);

  return (
    <div data-testid="discovery-board" data-board-version={boardVersion}>
      <Panel className="sticky top-0 z-10 mb-8 flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
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
          <BuildTripButton
            tripId={tripId}
            hasItinerary={hasItinerary}
            includedCount={includedCount}
            storedReadiness={storedReadiness ?? null}
          />
        </div>
      </Panel>

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
            {onlyIncluded ? 'Nothing picked yet' : 'Nothing here fits this trip'}
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            {onlyIncluded
              ? 'Untick the filter to see everything we found, or use auto-pick for a starting set.'
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
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {entry.candidates.map((candidate) => (
                  <PlaceCard
                    key={candidate.place.id}
                    candidate={candidate}
                    image={anchorImage(images, candidate)}
                    status={optimistic[candidate.place.id]}
                    onChoose={choose}
                  />
                ))}
              </div>
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

function PlaceCard({
  candidate,
  image,
  status,
  onChoose,
}: {
  candidate: DiscoveryCandidate;
  /** Null on most cards, by design. See `anchorImage`. */
  image: ImageRecord | null;
  status: SelectionStatus | undefined;
  onChoose: (placeId: string, status: SelectionStatus) => void;
}) {
  const { place, fit, season, access, operating, weather } = candidate;
  const blocked = fit.band === 'not_workable';

  return (
    <Panel
      as="article"
      className={cx(
        'flex flex-col overflow-hidden transition-colors',
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
          />
        ) : (
          <PlacePlate placeId={place.id} category={place.category} className="h-24" />
        )}
        <span className="absolute top-2 left-2 rounded-full bg-paper-raised/90 px-2 py-0.5 text-[11px] font-medium text-ink">
          {PLACE_CATEGORY_LABELS[place.category]}
        </span>
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

        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{place.shortDescription}</p>

        {/*
          One sentence, and only when the weather over these dates would change
          the decision. The verb has to match the evidence: "looks like the day
          for this one" is sayable about a forecast and not about ten past
          Augusts, so the sentence is built where the evidence is known rather
          than assembled here from parts.
        */}
        {weather.note ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">{weather.note}</p>
        ) : null}

        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
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
          {place.hiddenGemScore >= 0.6 ? <Badge tone="amber">Hidden gem</Badge> : null}
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
          {OPERATING_BADGE_ORDER.filter((badge) => operating.badges.includes(badge)).map((badge) => (
            <Badge key={badge} tone={OPERATING_BADGE_TONE[badge]}>
              {OPERATING_BADGE_LABELS[badge]}
            </Badge>
          ))}
          {candidate.weather.badges.map((badge) => (
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

        {fit.blockers.length > 0 ? (
          <div className="mt-4 rounded-lg bg-clay-soft p-3">
            <p className="text-xs font-medium text-clay">Why this will not work</p>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
              {fit.blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          </div>
        ) : fit.reasons.length > 0 ? (
          <div className="mt-4 rounded-lg bg-paper-sunk p-3">
            <p className="text-xs font-medium text-ink">Why this fits you</p>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
              {fit.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {fit.cautions.length > 0 ? (
          <details className="mt-3 text-xs">
            <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-ink-faint hover:text-ink')}>
              Worth knowing ({fit.cautions.length})
            </summary>
            <ul className="mt-2 space-y-1 leading-relaxed text-ink-muted">
              {fit.cautions.map((caution) => (
                <li key={caution}>{caution}</li>
              ))}
            </ul>
          </details>
        ) : null}

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
          <p className="mt-2 text-[11px] text-ink-faint">
            Source: {place.source.name}
            {place.source.url ? (
              <>
                {' · '}
                <a
                  href={place.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-ink"
                >
                  check current conditions
                </a>
              </>
            ) : null}
          </p>
        </div>
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
