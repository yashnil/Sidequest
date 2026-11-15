'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { announceTripEdit } from '@/components/hub/EditToast';
import { buttonClass } from '@/components/ui';
import { callAction } from '@/components/client-action';
import type { TravelLimitDayView } from '@/lib/planning/travel-limit-choices';
import { applyTravelLimitChoiceAction } from './actions';

/**
 * 2026-11 — A DAY OVER THE TRAVELLER'S OWN DAILY LIMIT, AND WHAT THEY CAN DO.
 *
 * Only the choices Sidequest can execute in place are controls (keep the long
 * day; drop the pick that takes it over), each showing what it changes in
 * numbers before Apply. Choices that would change where the traveller sleeps
 * are written underneath as information — never as something to press — and
 * a day already decided says what was chosen. Apply goes through one server
 * action with no model and no provider; the toast offers Undo.
 */
export function TravelLimitChoices({ tripId, view }: { tripId: string; view: TravelLimitDayView }) {
  const router = useRouter();
  const name = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const n = view.dayNumber;

  if (view.decided) {
    return (
      <div className="mt-3 border-l-2 border-l-pine py-1 pl-3 text-sm leading-relaxed text-ink-muted print:hidden" data-testid={`travel-limit-day-${n}`} data-state="decided">
        <p data-testid="travel-limit-decided">{view.decided}</p>
      </div>
    );
  }

  const apply = () => {
    if (!selected) return;
    setStatus(null);
    startTransition(async () => {
      const outcome = await callAction(() => applyTravelLimitChoiceAction(tripId, selected));
      if (!outcome.ok) {
        setStatus(outcome.message);
        return;
      }
      const result = outcome.value;
      if (!result.ok) {
        setStatus(result.error ?? 'That choice could not be applied.');
        return;
      }
      announceTripEdit(result, `Day ${n} was changed.`);
      setSelected(null);
      router.refresh();
    });
  };

  return (
    <section className="mt-3 rounded-[var(--radius-card)] border border-rule bg-paper-sunk p-4 print:hidden" aria-labelledby={`${name}-heading`} data-testid={`travel-limit-day-${n}`} data-state="open">
      <p className="eyebrow text-clay">Over your daily travel limit</p>
      <h3 id={`${name}-heading`} className="mt-1 text-base font-medium text-ink" data-testid="travel-limit-headline">
        {view.headline}
      </h3>
      {view.history ? (
        <p className="mt-1 type-small text-ink-muted" data-testid="travel-limit-history">
          {view.history}
        </p>
      ) : null}
      <fieldset className="mt-3" disabled={pending}>
        <legend className="type-small text-ink-muted">Choose what happens to day {n}:</legend>
        <ul className="mt-2 space-y-2">
          {view.options.map((option) => (
            <li key={option.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-rule bg-paper-raised p-3 has-[:checked]:border-pine" data-testid="travel-limit-option" data-kind={option.kind}>
                <input type="radio" name={name} value={option.id} checked={selected === option.id} onChange={() => setSelected(option.id)} className="mt-1" />
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{option.label}</span>
                  <span className="mt-0.5 block text-sm text-ink-muted" data-testid="travel-limit-effect">
                    {option.effect}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass('primary', 'sm')} disabled={!selected || pending} onClick={apply} data-testid="travel-limit-apply">
            {pending ? 'Applying…' : 'Apply this choice'}
          </button>
          {status ? (
            <span role="alert" className="text-sm text-clay">
              {status}
            </span>
          ) : null}
        </div>
      </fieldset>
      {view.information.length > 0 ? (
        <div className="mt-4 border-t border-rule pt-3" data-testid="travel-limit-information">
          <p className="type-small text-ink-muted">Other ways round it, for weighing — these change your stays, so they are not applied from here:</p>
          <ul className="mt-1.5 space-y-1.5 text-sm">
            {view.information.map((info) => (
              <li key={`${info.kind}:${info.label}`} data-testid="travel-limit-info" data-kind={info.kind}>
                <span className="font-medium text-ink">{info.label}.</span> <span className="text-ink-muted">{info.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
