import Link from 'next/link';
import {
  BOARD_INTEGRITY_FACT_BLURBS,
  BOARD_INTEGRITY_FACT_LABELS,
  BOARD_INTEGRITY_STATE_BLURBS,
  BOARD_INTEGRITY_STATE_LABELS,
  BOARD_RECOVERY_ACTION_BLURBS,
  BOARD_RECOVERY_ACTION_LABELS,
  BOARD_RECOVERY_ACTION_TARGETS,
  INTEREST_LABELS,
  type BoardIntegrityReading,
  type BoardIntegrityState,
  type BoardRecoveryAction,
  type BoardRecoveryTarget,
} from '@sidequest/core';
import { Badge, Panel, buttonClass, cx, type BadgeTone } from './ui';

/**
 * WHAT THE BOARD IS, SAID OUT LOUD.
 *
 * `BoardIntegrity` has been computed on every build since the role gate landed
 * and rendered on precisely no screen; so has `ProvisionalBoard.counts`. The
 * cost of that silence is not a missing feature, it is a wrong impression: a
 * board that set eleven records aside as transport, withheld four nobody could
 * place and dropped six for being somewhere else is indistinguishable, to the
 * person reading it, from a destination with nine things in it.
 *
 * The panel answers three questions in that order — *how much is here*, *what
 * happened to the rest*, and *what could you do about it* — and it refuses to
 * answer any of them by guessing. Every count it draws is one the artifact
 * genuinely records; the reading omits the rest rather than rendering a zero,
 * because a permanent nought beside a label is a broken panel wearing a fact's
 * clothing.
 *
 * Nothing here is a raw identifier. Every word comes off a label map, and an
 * unmapped value renders nothing — the rule `stageLabel` was written to hold,
 * after `replace(/_/g, ' ')` put "hot spring, scenic drive" in front of a
 * traveller inside a sentence claiming to quote what they had said.
 */

const STATE_TONE: Record<BoardIntegrityState, BadgeTone> = {
  strong: 'pine',
  usable: 'pine',
  partial: 'blue',
  thin: 'amber',
  blocked: 'clay',
};

export function BoardIntegrityPanel({
  tripId,
  reading,
  /**
   * Whether this is the whole answer on screen or a note beside a board.
   *
   * `standalone` is what renders where a board would have been. It is not a
   * different component because it is not a different claim — the same reading,
   * given the room its severity deserves.
   */
  standalone = false,
  headingId = 'board-integrity-heading',
}: {
  tripId: string;
  reading: BoardIntegrityReading;
  standalone?: boolean;
  headingId?: string;
}) {
  const missingInterests = reading.missingInterests
    // The shared label map, never the identifier with its underscores out.
    .map((interest) => (INTEREST_LABELS as Record<string, string | undefined>)[interest])
    .filter((label): label is string => Boolean(label));

  return (
    <Panel
      as="section"
      testId="board-integrity"
      labelledBy={headingId}
      className={standalone ? 'p-8' : 'p-4'}
    >
      {/*
        The state, as an attribute as well as a badge.

        A test that reads the badge text is asserting on copy; a test that reads
        this is asserting on the verdict. Both matter, and only one of them
        should have to change when a phrase is reworded.
      */}
      <div className="flex flex-wrap items-center gap-2" data-board-state={reading.state}>
        <Badge tone={STATE_TONE[reading.state]}>{BOARD_INTEGRITY_STATE_LABELS[reading.state]}</Badge>
      </div>

      <h2
        id={headingId}
        className={cx('mt-3 font-display text-ink', standalone ? 'text-xl' : 'text-lg')}
      >
        {BOARD_INTEGRITY_STATE_BLURBS[reading.state]}
      </h2>

      <p
        className="measure mt-2 text-sm leading-relaxed text-ink-muted"
        data-testid="board-integrity-summary"
      >
        {reading.summary}
      </p>

      {reading.facts.length > 0 ? (
        <dl className="mt-4 space-y-2.5">
          {reading.facts.map((fact) => (
            <div key={fact.id}>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-ink-muted">{BOARD_INTEGRITY_FACT_LABELS[fact.id]}</dt>
                <dd
                  className="tabular-nums text-ink"
                  data-testid={`board-integrity-fact-${fact.id}`}
                >
                  {fact.value}
                </dd>
              </div>
              {BOARD_INTEGRITY_FACT_BLURBS[fact.id] ? (
                <p className="measure mt-0.5 text-xs leading-relaxed text-ink-faint">
                  {BOARD_INTEGRITY_FACT_BLURBS[fact.id]}
                </p>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}

      {missingInterests.length > 0 ? (
        <p
          className="measure mt-4 text-sm leading-relaxed text-ink-muted"
          data-testid="board-integrity-missing-interests"
        >
          We found nothing here for {listOf(missingInterests)}, and you asked us to build the trip
          around {missingInterests.length === 1 ? 'it' : 'them'}.
        </p>
      ) : null}

      {reading.missingAreas.length > 0 ? (
        <p
          className="measure mt-2 text-sm leading-relaxed text-ink-muted"
          data-testid="board-integrity-missing-areas"
        >
          Nothing on this board sits in {listOf(reading.missingAreas)}.
        </p>
      ) : null}

      {reading.actions.length > 0 ? (
        <div className="mt-5 border-t border-rule pt-4">
          <p className="eyebrow">What would change this</p>
          <ul className="mt-3 space-y-3">
            {reading.actions.map((action) => (
              <li key={action}>
                <RecoveryAction tripId={tripId} action={action} prominent={standalone} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * One remedy, and where it is taken.
 *
 * The route is decided here rather than in core, because a route is the web
 * app's business and a shared module that knew one would be wrong the first time
 * a screen moved. `this_board` deliberately renders no link at all: "carry on
 * with what is here" is done by carrying on, and a button that navigates
 * somewhere in order to do nothing is worse than a sentence.
 */
function RecoveryAction({
  tripId,
  action,
  prominent,
}: {
  tripId: string;
  action: BoardRecoveryAction;
  prominent: boolean;
}) {
  const target = BOARD_RECOVERY_ACTION_TARGETS[action];
  const label = BOARD_RECOVERY_ACTION_LABELS[action];
  const blurb = BOARD_RECOVERY_ACTION_BLURBS[action];
  const href = hrefFor(target, tripId);

  return (
    <div data-testid={`board-recovery-${action}`}>
      {href ? (
        <Link href={href} className={buttonClass(prominent ? 'primary' : 'secondary', 'sm')}>
          {label}
        </Link>
      ) : (
        <p className="text-sm font-medium text-ink">{label}</p>
      )}
      <p className="measure mt-1.5 text-xs leading-relaxed text-ink-faint">{blurb}</p>
    </div>
  );
}

function hrefFor(target: BoardRecoveryTarget, tripId: string): string | null {
  switch (target) {
    case 'trip_answers':
      return `/trips/${tripId}/questionnaire`;
    case 'trip_shape':
      return `/trips/${tripId}/plan`;
    case 'this_board':
      return null;
  }
}

/** "a, b and c" — an Oxford-free list, because these are read aloud. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
