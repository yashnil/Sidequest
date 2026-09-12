'use client';

import { ALTERNATIVE_REQUESTS, type TripDecision } from '@sidequest/core';
import { Badge, cx } from '../ui';
import { ASK_OPEN_EVENT } from './HubShell';

/**
 * V9 §3 — A DECISION IS A RECORD, AND "WHY THIS?" IS ANSWERABLE FROM IT.
 *
 * The route, how the trip moves and when it happens, each as a card: what
 * was chosen, and behind one disclosure — why, the traveller facts that
 * drove it, the tradeoffs as figures, the alternatives that were on the
 * table. The chips beneath are the controlled alternatives: each is a
 * refinement request in plain words that opens Ask Sidequest pre-filled, so a
 * "less driving" costs one bounded call, a proposal and a deterministic delta,
 * and never a regeneration.
 *
 * Client only for the chips (they raise a DOM event). Nothing here writes.
 */
const LOCK_WORD: Record<TripDecision['lock'], string | null> = {
  booked_lock: 'Held by a booking',
  hard_lock: 'Locked',
  user_explicit: 'You decided',
  user_soft: 'Your leaning',
  sidequest_inferred: 'Sidequest chose',
  model_proposed: null,
};

const CHIPS_FOR: Record<string, readonly string[]> = {
  route: ['less_driving', 'fewer_hotel_changes', 'slower'],
  transport: ['less_driving', 'cheaper'],
  timing: [],
};

export function DecisionCard({ decision, askable = true, className }: { decision: TripDecision; askable?: boolean; className?: string }) {
  const lock = LOCK_WORD[decision.lock];
  const chipIds = CHIPS_FOR[decision.key] ?? (decision.key.startsWith('episode:') ? [] : ['more_adventurous', 'more_iconic']);
  const chips = ALTERNATIVE_REQUESTS.filter((entry) => chipIds.includes(entry.id));
  return (
    <section className={cx('card p-5', className)} data-testid="decision-card" data-key={decision.key} data-lock={decision.lock}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="eyebrow">{decision.title}</p>
        {lock ? <Badge tone={decision.decidedBy === 'traveller' ? 'pine' : 'neutral'}>{lock}</Badge> : null}
      </div>
      <p className="mt-1.5 type-body text-ink" data-testid="decision-chosen">
        {decision.chosen}
      </p>
      <details className="mt-3" data-testid="decision-why">
        <summary className="min-h-11 cursor-pointer list-none type-small font-semibold text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">Why this?</summary>
        <p className="mt-2 type-small text-ink">{decision.why}</p>
        {decision.travellerFacts.length > 0 ? (
          <div className="mt-3">
            <p className="type-meta">What you told Sidequest</p>
            <ul className="mt-1 space-y-1 type-small text-ink-muted">
              {decision.travellerFacts.slice(0, 4).map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {decision.tradeoffs.length > 0 ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5" data-testid="decision-tradeoffs">
            {decision.tradeoffs.map((tradeoff) => (
              <div key={`${tradeoff.label}:${tradeoff.value}`} className="flex items-baseline justify-between gap-3 text-sm">
                <dt className="text-ink-muted">{tradeoff.label}</dt>
                <dd className="type-figure text-ink">{tradeoff.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {decision.alternatives.length > 0 ? (
          <div className="mt-3" data-testid="decision-alternatives">
            <p className="type-meta">Also considered</p>
            <ul className="mt-1 space-y-1 type-small text-ink-muted">
              {decision.alternatives.map((alternative) => (
                <li key={alternative.label}>
                  <span className="text-ink">{alternative.label}</span>
                  {alternative.why ? <span> — {alternative.why}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {decision.decidedAt ? <p className="mt-3 type-meta">Recorded {decision.decidedAt.slice(0, 10)}.</p> : null}
      </details>
      {askable && chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Try an alternative">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              data-testid="alternative-chip"
              data-alternative={chip.id}
              onClick={() => window.dispatchEvent(new CustomEvent(ASK_OPEN_EVENT, { detail: { request: chip.request, send: true, structural: chip.touches === 'route' } }))}
              className="pressable inline-flex min-h-11 items-center rounded-full border border-rule bg-paper-raised px-3.5 text-sm font-medium text-ink shadow-[var(--shadow-card)] hover:border-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
