'use client';

import { useState, useTransition } from 'react';
import {
  MUST_DO_OBSTACLE_COPY,
  MUST_DO_STATUS_COPY,
  mustDoIsAccountedFor,
  mustDoOutstanding,
  type MustDoCoverage,
  type MustDoResolution,
} from '@sidequest/core';
import { decideMustDoAction } from '@/app/(product)/trips/[id]/plan/must-do-actions';
import { Panel, buttonClass } from './ui';

/**
 * WHAT BECAME OF THE THINGS YOU SAID YOU COULD NOT MISS.
 *
 * The traveller typed a sentence into "anything you would regret missing" and,
 * until this panel existed, the only acknowledgement they ever got was "noted,
 * and not looked up" on the composer screen. Whether the place was found, shut,
 * ambiguous or nowhere in the data was known internally and said nowhere.
 *
 * Three rules govern the copy, and they are the same three the readiness panel
 * holds to.
 *
 * **No compiler words.** Nothing here says candidate, resolution, containment,
 * scope or packet. Every sentence comes from `MUST_DO_STATUS_COPY`, which is
 * written for a person.
 *
 * **The traveller's own characters are quoted back.** A request is rendered as
 * what they typed, never as what we made of it — so a wrong match is visibly
 * wrong rather than plausibly right.
 *
 * **The smallest decision that would help, and no more.** An ambiguous request
 * gets a short list to pick from. Everything unresolved gets one way out —
 * "leave it out" — because that is the only other thing a person can honestly
 * say. There is no "look again" button: the second look has already happened,
 * and a control that re-runs a search whose answer is known is a control that
 * lies about what it does.
 *
 * Rendered before the itinerary is built, on both screens that come first, so
 * nobody learns their must-do went missing from a finished plan.
 */
export function MustDoPanel({
  tripId,
  coverage,
}: {
  tripId: string;
  coverage: MustDoCoverage;
}) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  const resolutions = coverage.resolutions;
  if (resolutions.length === 0) return null;

  // Worst first, from the shared helper, so the count in the heading and the
  // ordering a future screen might use come from one place rather than two.
  const outstanding = mustDoOutstanding(coverage);

  function decide(requestId: string, kind: 'withdrawn' | 'chose', chosenId?: string) {
    setFailed(null);
    startTransition(async () => {
      const result = await decideMustDoAction(tripId, requestId, kind, chosenId);
      if (!result.ok) setFailed(result.error ?? 'That did not save.');
    });
  }

  return (
    <section
      aria-labelledby="must-do-heading"
      data-testid="must-do-panel"
      data-must-do-outstanding={outstanding.length}
    >
      <Panel className="mt-8 p-5 sm:p-6">
        <p className="eyebrow">What you asked for by name</p>
        <h2 id="must-do-heading" className="mt-2 font-display text-xl text-ink">
          {outstanding.length === 0
            ? 'Everything you named is accounted for'
            : outstanding.length === 1
              ? 'One thing you named is still open'
              : `${outstanding.length} things you named are still open`}
        </h2>

        <ul className="mt-4 space-y-4">
          {resolutions.map((resolution) => (
            <MustDoRow
              key={resolution.request.id}
              resolution={resolution}
              pending={pending}
              onDecide={decide}
            />
          ))}
        </ul>

        {failed ? (
          <p className="mt-3 text-sm text-clay" role="status">
            {failed}
          </p>
        ) : null}
      </Panel>
    </section>
  );
}

function MustDoRow({
  resolution,
  pending,
  onDecide,
}: {
  resolution: MustDoResolution;
  pending: boolean;
  onDecide: (requestId: string, kind: 'withdrawn' | 'chose', chosenId?: string) => void;
}) {
  const copy = MUST_DO_STATUS_COPY[resolution.status];
  const settled = mustDoIsAccountedFor(resolution);

  return (
    <li
      className="rounded-[var(--radius-card)] border border-rule p-3.5"
      data-testid="must-do-row"
      data-must-do-status={resolution.status}
    >
      {/* Their words, sliced from what they typed. Never a paraphrase. */}
      <p className="text-sm italic text-ink">“{resolution.request.quote}”</p>
      <p className="mt-1.5 text-sm font-medium text-ink" data-testid="must-do-status-label">
        {copy.label}
        {resolution.match ? <span className="font-normal text-ink-muted"> — {resolution.match.name}</span> : null}
      </p>
      <p className="measure mt-1 text-sm leading-relaxed text-ink-muted">{copy.blurb}</p>
      {resolution.obstacle ? (
        <p className="measure mt-1 text-sm leading-relaxed text-ink-muted">
          {MUST_DO_OBSTACLE_COPY[resolution.obstacle]}
        </p>
      ) : null}

      {/*
        THE CHOICE, WHEN THERE IS ONE TO MAKE.

        Only for an ambiguity, and only over things we actually found. This is
        the "smallest relevant decision" the product owes somebody instead of a
        generic error: the rest of the trip carries on regardless, and pressing
        one of these settles one line.
      */}
      {resolution.status === 'ambiguous' && resolution.candidates.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-[0.12em] text-ink-faint">Which did you mean?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {resolution.candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                disabled={pending}
                className={buttonClass('secondary', 'sm')}
                data-testid="must-do-choice"
                onClick={() => onDecide(resolution.request.id, 'chose', candidate.id)}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!settled ? (
        <div className="mt-3">
          <button
            type="button"
            disabled={pending}
            className={buttonClass('ghost', 'sm')}
            data-testid="must-do-withdraw"
            onClick={() => onDecide(resolution.request.id, 'withdrawn')}
          >
            Leave it out
          </button>
        </div>
      ) : null}
    </li>
  );
}
