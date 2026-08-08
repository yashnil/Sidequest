'use client';

import { useState, useTransition } from 'react';
import {
  PROVISIONAL_INTENT_LABELS,
  RECONCILE_OUTCOME_COPY,
  RECONCILE_REASON_COPY,
  boardRef,
  boardRefLabel,
  isLoss,
  isUnaccounted,
  unacknowledged,
  type BoardAcknowledgements,
  type BoardReconciliation,
  type ReconciledSelection,
} from '@sidequest/core';
import { acknowledgeRemovalAction } from '@/app/(product)/trips/[id]/discover/actions';
import { Badge, Panel, buttonClass } from './ui';

/**
 * The product's minimum pointer target, as one value rather than as a guess per
 * control. WCAG 2.5.5 asks for 44 CSS pixels in the smallest dimension, and the
 * shared `sm` button size is about 28 — fine as a dense inline affordance, not
 * fine as something somebody presses on a phone.
 */
const TARGET_SIZE = 'min-h-11 min-w-11';

/**
 * WHAT HAPPENED TO THE THINGS YOU PICKED.
 *
 * A traveller curates a dozen places off the provisional board and gets seven
 * back. That is the research funnel working — its whole purpose is to discover
 * that a museum is shut, a lake has no road to it, and two records were the same
 * place. But it is the moment the product is most likely to feel like it lied,
 * and the difference between "we found these things out" and "half your choices
 * vanished" is entirely whether every removal has a name attached to it.
 *
 * So this renders first, above the board, and the pinned losses render first
 * inside it. Somebody who marked something as a must-do and did not get it is
 * owed the reason before they are shown anything else.
 *
 * Three rules decide everything below.
 *
 * **Nothing is hidden.** The full history is here — every decision the traveller
 * made, including the ones that came through untouched and the ones they said no
 * to. The engine now records all four intents rather than only the surviving
 * ones, and a panel that showed a subset would have put the silence back one
 * layer up. Volume is handled with disclosure, not with omission.
 *
 * **A pinned loss must be acknowledged.** Scrolled past unread is, from the
 * traveller's side, the same event as never mentioned. So those rows sit in
 * their own group at the top, they say plainly that they are waiting, and they
 * stay visible after acknowledgement rather than disappearing — the record is
 * that somebody was told, not that the problem went away.
 *
 * **An alternative is offered, never applied.** Choosing a replacement on
 * somebody's behalf while they are not looking is how a plan comes to hold a
 * place they never agreed to. Every alternative here is a sentence and a name;
 * none of them is a button that changes the plan.
 */
export function ReconciliationPanel({
  tripId,
  reconciliation,
  acknowledgements,
}: {
  tripId: string;
  reconciliation: BoardReconciliation;
  acknowledgements: BoardAcknowledgements | null;
}) {
  /*
   * Optimistic locally, authoritative on the server.
   *
   * The action revalidates the route, but a traveller who clicks and watches
   * nothing change for a beat has been given the same experience as a button
   * that does not work. Local state closes that gap; the server's copy wins on
   * the next render.
   */
  const [seenLocally, setSeenLocally] = useState<readonly string[]>([]);
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  const stillWaiting = unacknowledged(reconciliation, acknowledgements).filter(
    (entry) => !seenLocally.includes(entry.placeId),
  );
  const waitingIds = new Set(stillWaiting.map((entry) => entry.placeId));

  const needsAcknowledgement = reconciliation.entries.filter(
    (entry) => entry.acknowledgementRequired,
  );
  const otherLosses = reconciliation.entries.filter(
    (entry) => !entry.acknowledgementRequired && isLoss(entry.outcome),
  );
  const replaced = reconciliation.entries.filter((entry) => entry.outcome === 'replaced_duplicate');
  const changed = reconciliation.entries.filter(
    (entry) => entry.outcome === 'retained_with_changes',
  );
  const kept = reconciliation.entries.filter((entry) => entry.outcome === 'retained').length;
  const nothingChanged = kept === reconciliation.entries.length;

  function acknowledge(placeId: string) {
    setFailed(null);
    startTransition(async () => {
      const result = await acknowledgeRemovalAction(tripId, placeId);
      if (result.ok) setSeenLocally((current) => [...current, placeId]);
      else setFailed(result.error ?? 'That did not save.');
    });
  }

  return (
    <Panel
      className="mb-8 p-5"
      as="section"
      labelledBy="reconciliation-heading"
      testId="reconciliation-panel"
    >
      <p className="eyebrow">Since you last looked</p>
      <h2 id="reconciliation-heading" className="mt-2 font-display text-xl text-ink">
        {nothingChanged ? 'Everything you marked came through' : 'What changed once we checked'}
      </h2>
      <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
        {nothingChanged
          ? `All ${kept} of what you marked survived verification unchanged. The full record of what you told us is below.`
          : `${kept} of what you marked came through unchanged. Everything else you decided is below, with what became of it — including the things you said no to, so nothing you told us goes missing.`}
      </p>

      {/*
       * The waiting count is announced rather than only drawn.
       *
       * `aria-live="polite"` so that acknowledging the last one is audible as a
       * change of state to somebody who cannot see the group shrink. Polite
       * rather than assertive: this is a confirmation, not an alarm.
       */}
      <p className="sr-only" aria-live="polite">
        {stillWaiting.length === 0
          ? 'Nothing is waiting to be acknowledged.'
          : `${stillWaiting.length} must-do ${stillWaiting.length === 1 ? 'place needs' : 'places need'} acknowledging.`}
      </p>

      {needsAcknowledgement.length > 0 ? (
        <section aria-labelledby="reconciliation-pinned" className="mt-5">
          <h3 id="reconciliation-pinned" className="eyebrow">
            You said these were must-dos
          </h3>
          <ul className="mt-2.5 space-y-3">
            {needsAcknowledgement.map((entry) => (
              <PinnedLoss
                key={entry.placeId}
                entry={entry}
                waiting={waitingIds.has(entry.placeId)}
                busy={pending}
                onAcknowledge={() => acknowledge(entry.placeId)}
              />
            ))}
          </ul>
          {failed ? (
            <p role="alert" className="mt-2 text-sm text-clay">
              {failed}
            </p>
          ) : null}
        </section>
      ) : null}

      {changed.length > 0 ? (
        <section aria-labelledby="reconciliation-changed" className="mt-5">
          <h3 id="reconciliation-changed" className="eyebrow">
            Still on the board, but not quite as it was
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm text-ink-muted">
            {changed.map((entry) => (
              <li key={entry.placeId}>
                <span className="text-ink">{entry.name}</span> — {entry.explanation}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {replaced.length > 0 ? (
        <section aria-labelledby="reconciliation-duplicates" className="mt-5">
          <h3 id="reconciliation-duplicates" className="eyebrow">
            Turned out to be the same place
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm text-ink-muted">
            {replaced.map((entry) => (
              <li key={entry.placeId}>
                <span className="text-ink">{entry.name}</span>
                {entry.replacedByName ? ` — kept as ${entry.replacedByName}.` : '.'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {otherLosses.length > 0 ? (
        <details className="mt-5 border-t border-rule pt-4">
          <summary className={`${TARGET_SIZE} flex cursor-pointer items-center text-sm text-ink-muted`}>
            {otherLosses.length} other {otherLosses.length === 1 ? 'place' : 'places'} you had
            marked did not make it
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {otherLosses.map((entry) => (
              <li key={entry.placeId}>
                <span className="text-ink">{entry.name}</span>{' '}
                <Badge>{PROVISIONAL_INTENT_LABELS[entry.intent]}</Badge>{' '}
                <Badge tone={isUnaccounted(entry.outcome) ? 'clay' : 'neutral'}>
                  {RECONCILE_REASON_COPY[entry.reasonCode]}
                </Badge>
                <span className="mt-0.5 block text-ink-muted">{entry.explanation}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/*
       * The complete account, collapsed.
       *
       * Every decision, in one list, including retentions and the places they
       * said no to. Collapsed because a forty-row table above the board would
       * bury the four rows that matter; present because "show me everything I
       * told you" has to have an answer, and because a category that is only
       * summarised is a category somebody can suspect of hiding something.
       */}
      <details className="mt-4 border-t border-rule pt-4" data-testid="reconciliation-history">
        <summary className={`${TARGET_SIZE} flex cursor-pointer items-center text-sm text-ink-muted`}>
          The full record — all {reconciliation.entries.length} decisions you made
        </summary>

        {/*
         * TWO PRESENTATIONS, ONE AT A TIME.
         *
         * Four columns of full sentences at 390 px is a table nobody reads: the
         * outcome column wraps to five lines and the board column falls off the
         * side. So a narrow viewport gets the same rows stacked, and a wide one
         * gets the table. Both are `display: none` outside their range, so only
         * one is ever in the accessibility tree — a duplicated record read twice
         * would be its own defect.
         */}
        <ul className="mt-3 space-y-3 sm:hidden" data-testid="reconciliation-history-stacked">
          {reconciliation.entries.map((entry) => (
            <li key={entry.placeId} className="border-t border-rule/60 pt-2 text-xs">
              <p className="text-sm text-ink">{entry.name}</p>
              <dl className="mt-1 space-y-0.5">
                <div className="flex gap-2">
                  <dt className="text-ink-faint">You said</dt>
                  <dd className="text-ink-muted">{PROVISIONAL_INTENT_LABELS[entry.intent]}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-faint">Board</dt>
                  <dd className="text-ink-muted">{boardLabel(entry)}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Outcome</dt>
                  <dd className="text-ink-muted">{RECONCILE_OUTCOME_COPY[entry.outcome]}</dd>
                  {entry.detail ? <dd className="text-ink-faint">{entry.detail}</dd> : null}
                </div>
              </dl>
            </li>
          ))}
        </ul>

        <table className="mt-3 hidden w-full text-left text-xs sm:table">
          <caption className="sr-only">
            Every place you marked on the provisional board, what you said about it, and what
            became of it.
          </caption>
          <thead className="text-ink-faint">
            <tr>
              <th scope="col" className="py-1 pr-3 font-normal">
                Place
              </th>
              <th scope="col" className="py-1 pr-3 font-normal">
                You said
              </th>
              <th scope="col" className="py-1 pr-3 font-normal">
                Outcome
              </th>
              <th scope="col" className="py-1 font-normal">
                Board
              </th>
            </tr>
          </thead>
          <tbody>
            {reconciliation.entries.map((entry) => (
              <tr key={entry.placeId} className="border-t border-rule/60 align-top">
                <th scope="row" className="py-1.5 pr-3 font-normal text-ink">
                  {entry.name}
                </th>
                <td className="py-1.5 pr-3 text-ink-muted">
                  {PROVISIONAL_INTENT_LABELS[entry.intent]}
                </td>
                <td className="py-1.5 pr-3 text-ink-muted">
                  {RECONCILE_OUTCOME_COPY[entry.outcome]}
                  {entry.detail ? (
                    <span className="mt-0.5 block text-ink-faint">{entry.detail}</span>
                  ) : null}
                </td>
                <td className="py-1.5 text-ink-faint">{boardLabel(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {reconciliation.addedPlaceIds.length > 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          {reconciliation.addedPlaceIds.length}{' '}
          {reconciliation.addedPlaceIds.length === 1 ? 'place' : 'places'} appeared that were not on
          the board you marked. They are below with everything else.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Which board the choice was made on, or plainly that we do not know.
 *
 * `v{undefined}` and an invented `v1` are both worse than the sentence. A mark
 * recorded before board identity was carried genuinely has no board attached,
 * and the field exists precisely so that "you unpinned it" and "the board you
 * pinned it on no longer exists" stop being the same row.
 */
function boardLabel(entry: ReconciledSelection): string {
  return boardRefLabel(boardRef(entry.provisionalBoardId, entry.provisionalBoardVersion));
}

/**
 * One must-do that did not survive.
 *
 * The row stays after acknowledgement rather than disappearing. What was
 * recorded is that somebody was told — not that the place came back — and a row
 * that vanishes on click reads as the second thing.
 */
function PinnedLoss({
  entry,
  waiting,
  busy,
  onAcknowledge,
}: {
  entry: ReconciledSelection;
  waiting: boolean;
  busy: boolean;
  onAcknowledge: () => void;
}) {
  const headingId = `reconciliation-${entry.placeId}`;
  return (
    <li
      className="rounded-lg bg-clay-soft p-3.5"
      data-testid="pinned-removal"
      data-acknowledged={waiting ? 'false' : 'true'}
      aria-labelledby={headingId}
    >
      <p id={headingId} className="text-sm font-medium text-ink">
        {entry.name}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{entry.explanation}</p>
      {/*
       * The stage's own sentence, *beside* the outcome rather than instead of
       * it. It used to replace it, which is how a removal came to be reported
       * as "we could not establish what it costs" with nothing anywhere saying
       * the place had been dropped.
       */}
      {entry.detail ? (
        <p className="mt-1 text-sm leading-relaxed text-ink-faint" data-testid="removal-detail">
          {entry.detail}
        </p>
      ) : null}

      {entry.alternatives.length > 0 ? (
        <div className="mt-2 text-sm text-ink">
          <p>
            {entry.alternatives.length === 1
              ? 'Closest thing we still have in that area:'
              : 'Closest things we still have in that area:'}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {entry.alternatives.map((alternative) => (
              <li key={alternative.placeId}>
                <span className="font-medium">{alternative.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-muted">
            We have not picked any of them for you — they are on the board below if you want one.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-faint">
          Nothing else in that area does the same job, so we have not suggested a stand-in.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {waiting ? (
          <button
            type="button"
            onClick={onAcknowledge}
            disabled={busy}
            className={`${buttonClass('secondary', 'sm')} ${TARGET_SIZE} motion-reduce:transition-none`}
          >
            {busy ? 'Saving…' : 'I have read this'}
          </button>
        ) : (
          <span className="text-xs text-ink-faint" data-testid="acknowledged-note">
            You have marked this as read. It stays here so the record is complete.
          </span>
        )}
      </div>
    </li>
  );
}
