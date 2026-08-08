'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  PENDING_FACT_LABELS,
  INTEREST_LABELS,
  PLACE_CATEGORY_LABELS,
  PLANNING_ROLE_LABELS,
  PROVISIONAL_INTENTS,
  PROVISIONAL_INTENT_LABELS,
  SOURCE_PRESENCE_LABELS,
  readProvisionalIntegrity,
  summariseSelections,
  summaryVersion,
  type ProvisionalBoard,
  type ProvisionalCard,
  type ProvisionalIntent,
} from '@sidequest/core';
import { Badge, ErrorNote, EvidenceBadge, Panel, buttonClass, cx } from './ui';
import { BoardIntegrityPanel } from './BoardIntegrityPanel';
import { setProvisionalIntentAction } from '@/app/(product)/trips/[id]/provisional/actions';

/**
 * THE BOARD BEFORE ANYTHING HAS BEEN VERIFIED.
 *
 * A separate component from `DiscoveryBoardView`, and deliberately smaller. The
 * final board renders travel times, opening hours, access badges, weather
 * assessments and a "build my trip" button. Not one of those exists here, and
 * the way to guarantee none of them appears is for this component not to know
 * how to draw them.
 *
 * What it shows instead is what the map data actually said — a name, a kind, an
 * area, how many datasets list it, and a preliminary fit computed from the
 * traveller's own stated interests. Every card carries what is still *pending*,
 * by name, because "unverified" tells somebody nothing they can act on and
 * "we do not know when it opens" tells them exactly what they are deciding
 * without.
 *
 * There is no auto-pick here, and its absence is deliberate. `autoSelect` reads
 * drive minutes and detour classes; at this point both would be zero, so it
 * would cheerfully select a week of driving and the planner would refuse all of
 * it. Auto-pick runs once, on the final board, where the numbers are real.
 */

const INTENT_TONE: Record<ProvisionalIntent, 'pine' | 'blue' | 'neutral' | 'clay'> = {
  pinned: 'pine',
  interested: 'blue',
  not_interested: 'neutral',
  hidden: 'neutral',
};

/**
 * The smallest a control on this board may be.
 *
 * WCAG 2.5.5's 44 px, and the intent buttons were 32. They sit four to a card on
 * a 390 px screen, which is exactly the situation the criterion is about: a
 * dense grid of small toggles under a thumb. `min-h-11` rather than more padding
 * so the label keeps its size and only the target grows.
 */
const MIN_TARGET = 'min-h-11';

/**
 * A stable identity for the board on screen.
 *
 * `id` alone is not enough: `saveProvisionalBoard` mints `${id}-v${version}` and
 * the version is the thing that moves. Both, through one derivation, so the
 * value in `data-board-version` and the value the counts were computed against
 * are the same value rather than two that agree today.
 */
function versionOf(board: ProvisionalBoard): string {
  return summaryVersion([board.id, board.version]);
}

export function ProvisionalBoardView({
  tripId,
  board,
  selections,
  stillRunning,
  tripDays,
}: {
  tripId: string;
  board: ProvisionalBoard;
  selections: Record<string, ProvisionalIntent | undefined>;
  /** Whether verification is still going. Decides what the footer offers. */
  stillRunning: boolean;
  /**
   * Days the trip runs, so "how much is here" can be answered against something.
   *
   * Forty places is generous for a weekend and thin for a fortnight, and a count
   * with nothing to measure it against says neither.
   */
  tripDays: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /*
   * HIDING WAS A ONE-WAY DOOR.
   *
   * `hidden` is one of four buttons on every card, the view filtered hidden
   * cards out, and there was no control anywhere that brought one back. A
   * traveller who worked down the board hiding things they did not fancy could
   * reach an empty page with no cards, no explanation and no way back — the mark
   * was stored, so a refresh did not help either.
   */
  const [showHidden, setShowHidden] = useState(false);
  /** Which card is mid-save, so busy state is reported per card and not per page. */
  const [savingId, setSavingId] = useState<string | null>(null);

  const boardVersion = versionOf(board);

  /*
   * THE MIRROR CANNOT OUTLIVE WHAT IT MIRRORS.
   *
   * `useState(selections)` seeds once and never again, so this component went on
   * rendering the marks it was born with. Two ways that reached a traveller:
   * a rebuild replaced `board` while the pinned count stayed on the previous
   * board's figure, and a second tab moved the marks while this one kept
   * counting its own copy. Neither looks wrong on screen — a number is a number.
   *
   * The mirror is now keyed to the *server state it was derived from*. When
   * either the board version or the stored marks change identity, it is dropped
   * and the props become the answer again. It still exists, because a decision
   * that takes a round trip to appear is one people click twice — it just cannot
   * describe a state the server has moved on from.
   */
  const serverKey = summaryVersion([boardVersion, marksFingerprint(selections)]);
  const [mirror, setMirror] = useState<{ key: string; value: typeof selections }>({
    key: serverKey,
    value: selections,
  });
  if (mirror.key !== serverKey) setMirror({ key: serverKey, value: selections });
  const chosen = mirror.key === serverKey ? mirror.value : selections;

  const hiddenCards = board.cards.filter((card) => chosen[card.placeId] === 'hidden');
  const visible = showHidden
    ? board.cards
    : board.cards.filter((card) => chosen[card.placeId] !== 'hidden');

  /*
   * WHAT THIS BOARD IS, FROM NUMBERS THE BUILD ALREADY WROTE DOWN.
   *
   * `counts.droppedUtilityRole` has been persisted with every board since the
   * role split and read by nothing. It is the honest counterpart to the final
   * board's own refusal count — which is structurally near zero, because the
   * inventory separates support from candidates long before a board sees either
   * — and because it is stored rather than derived it says the same thing after
   * a refresh and with every provider switched off.
   */
  const integrity = readProvisionalIntegrity({
    tripDays,
    cards: board.cards.length,
    categoryDiversity: new Set(board.cards.map((card) => card.category)).size,
    areas: board.clusters.length,
    supportKeptSeparately: board.counts.droppedUtilityRole,
  });

  /*
   * Every count on this screen, derived once, against the board being rendered.
   *
   * `cardIds` is the board's own list rather than the keys of the mark map: a
   * mark about a place a later build dropped is still a real thing somebody
   * said, and it is not a fact about the board in front of them.
   */
  const summary = summariseSelections({
    boardVersion,
    cardIds: board.cards.map((card) => card.placeId),
    statuses: PROVISIONAL_INTENTS,
    selections: chosen,
  });
  const pinnedCount = summary.counts.pinned;

  function choose(placeId: string, intent: ProvisionalIntent) {
    const next = chosen[placeId] === intent ? null : intent;
    setMirror((current) => ({
      key: current.key,
      value: { ...current.value, [placeId]: next ?? undefined },
    }));
    setError(null);
    setSavingId(placeId);
    startTransition(async () => {
      const result = await setProvisionalIntentAction(tripId, placeId, next);
      setSavingId(null);
      if (!result.ok) {
        setMirror((current) => ({ key: current.key, value: selections }));
        setError(result.error ?? 'We could not save that.');
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-8" data-testid="provisional-board" data-board-version={boardVersion}>
      <Panel className="bg-paper-sunk p-5" as="section" labelledBy="provisional-heading">
        <div className="flex flex-wrap items-center gap-3">
          <EvidenceBadge state="provisional">Nothing here is verified</EvidenceBadge>
          {stillRunning ? <Badge tone="blue">Still checking</Badge> : null}
        </div>
        <h2 id="provisional-heading" className="mt-3 font-display text-2xl text-ink">
          What we found, before we checked any of it
        </h2>
        <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
          These come from map data. We have not read an opening time, a price or a
          road for any of them yet — and there are no travel times here, because
          nothing has been routed. Marking things now tells us what to check first.
        </p>
        {/*
          Every figure in this list belongs to the board named in the attribute
          beside it. The stamp is not decoration: it is what makes "the summary
          and the board agree" checkable from outside the component, which is the
          only way a mismatch is ever going to be noticed.
        */}
        <dl
          className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm"
          data-testid="provisional-summary"
          data-board-version={summary.boardVersion}
        >
          <Count label="On this board" value={summary.onBoard} testId="count-on-board" />
          <Count label="You have marked" value={summary.decided} testId="count-marked" />
          {board.byRole.map((entry) => (
            <Count
              key={entry.role}
              label={PLANNING_ROLE_LABELS[entry.role]}
              value={entry.count}
            />
          ))}
        </dl>

        {/*
          A polite status line, and the only thing on this board that speaks.

          Every mark made here changes a count, moves a card and sometimes empties
          a section, and none of that reached a screen reader: the counts are
          plain text and the card simply vanishes from the DOM. One live region,
          reporting the state after the change rather than the change itself, so
          two quick marks announce one settled result instead of two races.
        */}
        <p className="sr-only" role="status" aria-live="polite" data-testid="provisional-status">
          {error
            ? error
            : `${summary.decided} of ${summary.onBoard} marked. ${visible.length} showing${
                hiddenCards.length > 0 ? `, ${hiddenCards.length} hidden` : ''
              }.`}
        </p>

        {/*
          Marks about places this board no longer holds.

          Named as history rather than added to the totals above. They are real
          decisions somebody made and they are not facts about what is on screen,
          and the old count could not tell the difference.
        */}
        {summary.carriedOver > 0 ? (
          <p className="mt-3 text-xs leading-relaxed text-ink-faint" data-testid="carried-over">
            You also marked {summary.carriedOver}{' '}
            {summary.carriedOver === 1 ? 'place' : 'places'} that an earlier version of this
            board had and this one does not. Those marks are kept, and they are not counted
            above.
          </p>
        ) : null}
      </Panel>

      <BoardIntegrityPanel
        tripId={tripId}
        reading={integrity}
        headingId="provisional-integrity-heading"
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {/*
        The way back out of hiding.

        Rendered whenever anything is hidden rather than only when everything is,
        because the state that needs a door is the one before the empty page —
        somebody two marks from a blank board should be able to see that hiding is
        reversible without having to reach the blank board to find out.
      */}
      {hiddenCards.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="hidden-control">
          <p className="text-sm text-ink-muted">
            {hiddenCards.length} {hiddenCards.length === 1 ? 'place is' : 'places are'} hidden.
          </p>
          <button
            type="button"
            onClick={() => setShowHidden((current) => !current)}
            aria-pressed={showHidden}
            className={cx(buttonClass('secondary', 'sm'), MIN_TARGET)}
          >
            {showHidden ? 'Hide them again' : 'Show hidden places'}
          </button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <Panel className="p-8" testId="provisional-empty">
          <h3 className="font-display text-xl text-ink">You have hidden everything on this board</h3>
          <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
            Nothing has been thrown away — every one of these {board.cards.length} places is still
            here, and every mark you made is still recorded. Bring them back whenever you like.
          </p>
          <button
            type="button"
            onClick={() => setShowHidden(true)}
            className={cx(buttonClass('primary', 'sm'), MIN_TARGET, 'mt-5')}
          >
            Show hidden places
          </button>
        </Panel>
      ) : null}

      {board.clusters.map((cluster) => {
        const cards = visible.filter((card) => card.clusterId === cluster.id);
        if (cards.length === 0) return null;
        return (
          <section key={cluster.id} aria-labelledby={`area-${cluster.id}`}>
            <h3 id={`area-${cluster.id}`} className="font-display text-xl text-ink">
              {cluster.name}
            </h3>
            <p className="mt-1 text-sm text-ink-muted">
              {cards.length} {cards.length === 1 ? 'place' : 'places'}, if you based yourself at{' '}
              {cluster.baseName}
            </p>
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((card) => (
                <li key={card.placeId}>
                  <Card
                    card={card}
                    intent={chosen[card.placeId]}
                    saving={pending && savingId === card.placeId}
                    onChoose={choose}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <Panel className="p-5">
        <p className="text-sm leading-relaxed text-ink" data-board-version={summary.boardVersion}>
          {stillRunning
            ? `We are checking the strongest of these now${pinnedCount > 0 ? `, starting with the ${pinnedCount} you marked` : ''}. You can close this page — it carries on without you.`
            : 'Checking has finished. The board below has what survived, and what did not.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href={`/trips/${tripId}/plan`} className={cx(buttonClass('secondary'), MIN_TARGET)}>
            Back to progress
          </Link>
        </div>
      </Panel>
    </div>
  );
}

function Card({
  card,
  intent,
  saving,
  onChoose,
}: {
  card: ProvisionalCard;
  intent: ProvisionalIntent | undefined;
  /**
   * Whether *this* card is mid-save. Reported, never used to disable.
   *
   * What was here was `disabled={pending}` off one shared `useTransition`, which
   * disabled all four buttons on all forty cards the instant any one of them was
   * pressed — including the button that had just been pressed. A disabled
   * element cannot hold focus, so focus fell to `<body>` and a keyboard user lost
   * their place on the board every single time they marked something. It also
   * meant one slow round trip froze the whole page.
   *
   * `DiscoveryBoardView` never does this: its only `disabled` is `unavailable`,
   * a *semantic* refusal — the choice itself is impossible — and pendingness is
   * carried by an optimistic mirror instead. This board has the same mirror, so
   * it needs no disabling at all: the press lands immediately, and a failure
   * rolls it back with a message.
   */
  saving: boolean;
  onChoose: (placeId: string, intent: ProvisionalIntent) => void;
}) {
  return (
    <Panel
      className={cx('flex h-full flex-col p-4', intent === 'pinned' ? 'border-pine' : '')}
      testId="provisional-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-display text-lg leading-tight text-ink">{card.name}</span>
          <span className="mt-0.5 block text-xs text-ink-muted">{card.locality}</span>
        </span>
        <EvidenceBadge state="provisional" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge>{PLACE_CATEGORY_LABELS[card.category]}</Badge>
        <Badge tone="neutral">{PLANNING_ROLE_LABELS[card.role]}</Badge>
        {intent ? <Badge tone={INTENT_TONE[intent]}>{PROVISIONAL_INTENT_LABELS[intent]}</Badge> : null}
      </div>

      {card.matchedInterests.length > 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          {/*
            The shared label map, never the identifier with its underscores out.

            `replace(/_/g, ' ')` is the exact mechanism that put "reusing shared
            claims" in front of a traveller, and `stageLabel` was written to
            refuse it. It was still here, rendering "hot spring, scenic drive" —
            singular, uncapitalised, machine-shaped — inside a sentence claiming
            to quote what somebody said. An unmapped value renders nothing rather
            than rendering an identifier.
          */}
          Matches what you said about{' '}
          {card.matchedInterests
            .map((interest) => (INTEREST_LABELS as Record<string, string | undefined>)[interest])
            .filter((label): label is string => Boolean(label))
            .join(', ')}
          .
        </p>
      ) : null}

      <p className="mt-2 text-xs text-ink-faint">{SOURCE_PRESENCE_LABELS[card.presence]}</p>

      {/*
        What is still missing, by name.

        "Unverified" tells somebody nothing they can act on. "We do not know when
        it opens or what it costs" tells them exactly what they are deciding
        without — which is the difference between a caveat and a disclaimer.
      */}
      {/*
        The shared label map, and an unmapped value renders nothing rather than
        `undefined` — the same rule the interests line above follows, for the
        same reason: a stored board is JSON, and a board written by a build that
        knew a fact this build does not is how a raw value reaches a screen.
      */}
      <p className="mt-3 border-t border-rule pt-3 text-xs leading-relaxed text-ink-faint">
        Still to check:{' '}
        {card.pending
          .map((fact) => (PENDING_FACT_LABELS as Record<string, string | undefined>)[fact])
          .filter((label): label is string => Boolean(label))
          .join(', ')}
        .
      </p>

      <div className="mt-auto flex flex-wrap gap-1.5 pt-4" aria-busy={saving || undefined}>
        {PROVISIONAL_INTENTS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={intent === value}
            onClick={() => onChoose(card.placeId, value)}
            className={cx(
              'inline-flex items-center justify-center rounded-full border px-3.5 text-xs font-medium transition-colors',
              MIN_TARGET,
              intent === value
                ? 'border-transparent bg-ink text-paper'
                : 'border-rule text-ink-muted hover:border-ink-faint',
            )}
          >
            {PROVISIONAL_INTENT_LABELS[value]}
          </button>
        ))}
      </div>
    </Panel>
  );
}

/**
 * The identity of a set of marks, so a change made elsewhere is visible as one.
 *
 * Sorted before hashing, because `Object.entries` order follows insertion and
 * two tabs that recorded the same marks in a different order hold the same
 * state. Cleared marks are omitted for the same reason: `undefined` and absent
 * are one thing here.
 */
function marksFingerprint(selections: Record<string, ProvisionalIntent | undefined>): string {
  return summaryVersion(
    Object.entries(selections)
      .filter((entry): entry is [string, ProvisionalIntent] => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .flat(),
  );
}

function Count({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 tabular-nums text-ink" {...(testId ? { 'data-testid': testId } : {})}>
        {value}
      </dd>
    </div>
  );
}
