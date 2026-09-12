'use client';

import type { SplitPlan } from '@sidequest/core';
import { buttonClass } from '@/components/ui';
import { splitRequestFor } from './split-request';

/**
 * V9 §17 — A SPLIT DAY AS A STRUCTURE.
 *
 * Who does what, where everyone meets again, what it means for transport and
 * for anything booked that day. Rendered inside a day card only when the day
 * carries a split. "Suggest a split" appears only when the page says it may
 * (`canSuggest`: the party has a recorded difference to split over); it
 * opens Ask Sidequest with a request the traveller can edit before sending,
 * and nothing is changed until they do.
 */
const ASK_OPEN = 'sidequest:ask-open';

export function SplitPlanCard({ plan, tripId, canSuggest = false }: { plan: SplitPlan; tripId?: string; canSuggest?: boolean }) {
  void tripId;
  return (
    <div className="card mt-3 p-4" data-testid={`split-plan-${plan.dayNumber}`}>
      <p className="eyebrow">A split day</p>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {plan.groups.map((group) => (
          <li key={group.who} className="rounded-[var(--radius-card)] bg-paper-sunk/60 p-3" data-testid="split-group">
            <p className="type-small font-semibold text-ink">{group.who}</p>
            <p className="type-small text-ink-muted">{group.does}</p>
          </li>
        ))}
      </ul>
      <dl className="mt-3 grid gap-1.5">
        <div className="flex min-w-0 flex-wrap gap-x-2">
          <dt className="type-small font-medium text-ink">Back together</dt>
          <dd className="type-small text-ink-muted" data-testid="split-rejoin">
            {plan.rejoin ?? 'Not said yet — ask Sidequest to name a meeting point and time.'}
          </dd>
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-2">
          <dt className="type-small font-medium text-ink">Getting around</dt>
          <dd className="type-small text-ink-muted" data-testid="split-transport">
            {plan.transportNote}
          </dd>
        </div>
        {plan.bookingsNote ? (
          <div className="flex min-w-0 flex-wrap gap-x-2">
            <dt className="type-small font-medium text-ink">Booked today</dt>
            <dd className="type-small text-ink-muted" data-testid="split-bookings">
              {plan.bookingsNote}
            </dd>
          </div>
        ) : null}
      </dl>
      {canSuggest ? (
        <button
          type="button"
          className={`${buttonClass('secondary', 'sm')} mt-3`}
          data-testid={`split-suggest-${plan.dayNumber}`}
          onClick={() => {
            window.dispatchEvent(new CustomEvent(ASK_OPEN, { detail: { request: splitRequestFor(plan.dayNumber, plan), dayNumber: plan.dayNumber } }));
          }}
        >
          Suggest a different split
        </button>
      ) : null}
    </div>
  );
}
