'use client';

import { useState, useTransition } from 'react';
import { BOOKED_ITEM_TYPES, BOOKED_ITEM_TYPE_LABELS, type BookedPlanItem, type TravelReadinessProfile } from '@sidequest/core';
import { ErrorNote, FOCUS_RING, buttonClass, cx } from '../ui';
import {
  addBookedItemAction,
  clearReadinessProfileAction,
  removeBookedItemAction,
  saveReadinessProfileAction,
  setCheckAction,
} from '@/app/(product)/trips/[id]/itinerary/actions';
import { BookedStatusControl } from '@/app/(product)/trips/[id]/itinerary/live-controls';
import { AddConfirmationButton } from './BookingActions';
import { PAID_WORD, REFUNDABLE_WORD, SOURCE_WORD, formatMoney } from './booking-copy';

/**
 * THE HUB'S THREE INPUTS: A BOOKING, A READINESS PROFILE, A TICK.
 *
 * All three are plain forms that call a server action and let the page
 * re-render from disk. Nothing here keeps its own copy of the plan.
 */
const inputClass = 'mt-1 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine';

export function BookedItemForm({ tripId, startDate, endDate }: { tripId: string; startDate: string; endDate: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<(typeof BOOKED_ITEM_TYPES)[number]>('lodging');

  function submit(form: FormData) {
    setError(null);
    const get = (key: string) => {
      const value = form.get(key);
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    };
    const payload = {
      type,
      title: get('title') ?? '',
      date: get('date'),
      endDate: get('endDate'),
      startTime: get('startTime'),
      endTime: get('endTime'),
      location: get('location'),
      confirmationRef: get('confirmationRef'),
      url: get('url'),
      notes: get('notes'),
      status: get('status') ?? 'booked',
      locked: true,
      ...(get('costAmount') && Number.isFinite(Number(get('costAmount'))) ? { cost: { amount: Number(get('costAmount')), currency: (get('costCurrency') ?? 'USD').toUpperCase().slice(0, 8) } } : {}),
      ...(get('paid') ? { paid: get('paid') } : {}),
      ...(get('refundable') ? { refundable: get('refundable') } : {}),
    };
    startTransition(async () => {
      const result = await addBookedItemAction(tripId, payload);
      if (!result.ok) {
        setError(result.error ?? 'That did not save.');
        return;
      }
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary', 'sm')} data-testid="booked-add">
        Add something you have booked
      </button>
    );
  }
  return (
    <form action={submit} className="card-raised p-5" data-testid="booked-form">
      <p className="eyebrow">Something you have booked</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink">
          Kind
          <select name="type" value={type} onChange={(e) => setType(e.target.value as (typeof BOOKED_ITEM_TYPES)[number])} className={inputClass} data-testid="booked-type">
            {BOOKED_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {BOOKED_ITEM_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink">
          Name
          <input name="title" required maxLength={160} className={inputClass} placeholder={type === 'lodging' ? 'Hotel or apartment name' : type === 'flight' ? 'Flight number or route' : 'What is booked'} data-testid="booked-title" />
        </label>
        <label className="text-sm text-ink">
          {type === 'lodging' ? 'Check-in' : 'Date'}
          <input name="date" type="date" required min={startDate} max={endDate} defaultValue={startDate} className={inputClass} data-testid="booked-date" />
        </label>
        {type === 'lodging' ? (
          <label className="text-sm text-ink">
            Check-out
            <input name="endDate" type="date" min={startDate} max={endDate} className={inputClass} data-testid="booked-end-date" />
          </label>
        ) : (
          <label className="text-sm text-ink">
            {type === 'flight' || type === 'train' || type === 'ferry' ? 'Departs' : 'Starts'}
            <input name="startTime" type="time" className={inputClass} data-testid="booked-start" />
          </label>
        )}
        {type !== 'lodging' ? (
          <label className="text-sm text-ink">
            {type === 'flight' || type === 'train' || type === 'ferry' ? 'Arrives' : 'Ends'}
            <input name="endTime" type="time" className={inputClass} data-testid="booked-end" />
          </label>
        ) : null}
        <label className="text-sm text-ink">
          {type === 'lodging' ? 'Town or area' : 'Where'}
          <input name="location" maxLength={160} className={inputClass} data-testid="booked-location" />
        </label>
        <label className="text-sm text-ink">
          Status
          <select name="status" defaultValue="booked" className={inputClass}>
            <option value="booked">Booked</option>
            <option value="soft_hold">Held, not paid</option>
            <option value="idea">Just an idea</option>
          </select>
        </label>
        <label className="text-sm text-ink">
          Confirmation reference <span className="text-ink-muted">(optional, stays on this trip only)</span>
          <input name="confirmationRef" maxLength={80} autoComplete="off" className={inputClass} />
        </label>
        <label className="text-sm text-ink">
          Amount <span className="text-ink-faint">(optional)</span>
          <span className="mt-1 flex gap-2">
            <input name="costAmount" type="number" min={0} step={1} className={cx(inputClass, 'mt-0')} aria-label="Amount" />
            <input name="costCurrency" maxLength={8} defaultValue="USD" className={cx(inputClass, 'mt-0 w-24 uppercase')} aria-label="Currency" />
          </span>
        </label>
        <label className="text-sm text-ink">
          Paid
          <select name="paid" defaultValue="" className={inputClass}>
            <option value="">Not recorded</option>
            <option value="paid">{PAID_WORD.paid}</option>
            <option value="deposit">{PAID_WORD.deposit}</option>
            <option value="unpaid">{PAID_WORD.unpaid}</option>
          </select>
        </label>
        <label className="text-sm text-ink">
          Refund terms
          <select name="refundable" defaultValue="" className={inputClass}>
            <option value="">Not recorded</option>
            <option value="refundable">{REFUNDABLE_WORD.refundable}</option>
            <option value="non_refundable">{REFUNDABLE_WORD.non_refundable}</option>
          </select>
        </label>
        <label className="text-sm text-ink sm:col-span-2">
          Notes
          <input name="notes" maxLength={500} className={inputClass} />
        </label>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')} data-testid="booked-save">
          {pending ? 'Saving…' : 'Save booking'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * V9 §5 — A BOOKED FACT, WITH ITS CONFIRMATION BEHIND A DISCLOSURE.
 *
 * The reference, the link, the amount and the terms are the traveller's own
 * and stay on this trip: the disclosure is `print:hidden`, never on paper,
 * and this row is rendered only for the owner (the shared copy lists titles).
 */
export function BookedItemRow({ tripId, item }: { tripId: string; item: BookedPlanItem }) {
  const [pending, startTransition] = useTransition();
  const hasConfirmation = Boolean(item.confirmationRef || item.url || item.cost || item.paid || item.refundable || item.cancellationDeadline || item.provider);
  return (
    <li className="py-3" data-testid="booked-item" data-source={item.source ?? 'typed'}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm text-ink">
            <span className="font-semibold">{item.title}</span>
            <span className="text-ink-muted"> · {BOOKED_ITEM_TYPE_LABELS[item.type]}</span>
            {item.status !== 'booked' ? <span className="text-ink-muted"> · {item.status === 'soft_hold' ? 'held' : 'idea'}</span> : null}
          </p>
          <p className="type-figure text-xs font-medium text-ink-muted">
            {item.date ?? 'No date'}
            {item.endDate ? ` → ${item.endDate}` : ''}
            {item.startTime ? ` · ${item.startTime}` : ''}
            {item.endTime ? `–${item.endTime}` : ''}
            {item.location ? ` · ${item.location}` : ''}
          </p>
          {item.replaces ? <p className="mt-0.5 text-xs text-ink-muted">In place of the plan’s “{item.replaces}”.</p> : null}
        </div>
        <span className="inline-flex flex-wrap items-center gap-3">
          <BookedStatusControl tripId={tripId} id={item.id} status={item.status} {...(item.cost ? { cost: item.cost } : {})} {...(item.paid ? { paid: item.paid } : {})} {...(item.refundable ? { refundable: item.refundable } : {})} />
          <AddConfirmationButton tripId={tripId} item={item} />
          <button type="button" disabled={pending} onClick={() => startTransition(async () => void (await removeBookedItemAction(tripId, item.id)))} className={cx(buttonClass('ghost', 'sm'), 'hover:text-clay')} data-testid="booked-remove">
            Remove
          </button>
        </span>
      </div>
      {hasConfirmation ? (
        <details className="mt-1 print:hidden" data-testid="booked-confirmation">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted">Your confirmation</summary>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {item.confirmationRef ? (
              <div>
                <dt className="type-meta">Reference</dt>
                <dd className="type-figure text-ink" data-testid="booked-reference">{item.confirmationRef}</dd>
              </div>
            ) : null}
            {item.provider ? (
              <div>
                <dt className="type-meta">Booked with</dt>
                <dd className="text-ink">{item.provider}</dd>
              </div>
            ) : null}
            {item.url ? (
              <div>
                <dt className="type-meta">Link</dt>
                <dd>
                  <a href={item.url} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">Open the booking</a>
                </dd>
              </div>
            ) : null}
            {item.cost ? (
              <div>
                <dt className="type-meta">Amount</dt>
                <dd className="type-figure text-ink">
                  {formatMoney(item.cost.amount, item.cost.currency)}
                  {item.paid ? ` · ${PAID_WORD[item.paid]}` : ''}
                </dd>
              </div>
            ) : item.paid ? (
              <div>
                <dt className="type-meta">Paid</dt>
                <dd className="text-ink">{PAID_WORD[item.paid]}</dd>
              </div>
            ) : null}
            {item.refundable && item.refundable !== 'unknown' ? (
              <div>
                <dt className="type-meta">Refund terms</dt>
                <dd className="text-ink">{REFUNDABLE_WORD[item.refundable]}</dd>
              </div>
            ) : null}
            {item.cancellationDeadline ? (
              <div>
                <dt className="type-meta">Free cancellation until</dt>
                <dd className="type-figure text-ink">{item.cancellationDeadline}</dd>
              </div>
            ) : null}
            <div>
              <dt className="type-meta">How it got here</dt>
              <dd className="text-ink-muted">{SOURCE_WORD[item.source ?? 'typed']}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </li>
  );
}

const COUNTRIES = ['US', 'GB', 'CA', 'AU', 'NZ', 'IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI', 'JP', 'KR', 'SG', 'IN', 'BR', 'MX', 'ZA', 'AR', 'CL', 'PT', 'CH', 'AT', 'BE', 'PL', 'CZ', 'IS'];

export function ReadinessProfileForm({ tripId, current, drives }: { tripId: string; current: TravelReadinessProfile | null; drives: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(form: FormData) {
    setError(null);
    const get = (key: string) => {
      const value = form.get(key);
      return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : undefined;
    };
    const payload: Record<string, unknown> = {
      citizenship: get('citizenship'),
      residence: get('residence'),
      passportExpiry: (form.get('passportExpiry') as string | null) || undefined,
      ageCategory: (form.get('ageCategory') as string | null) || undefined,
      drivingLicenceCountry: get('drivingLicenceCountry'),
      transitCountries: [],
    };
    startTransition(async () => {
      const result = await saveReadinessProfileAction(tripId, payload);
      if (!result.ok) {
        setError(result.error ?? 'That did not save.');
        return;
      }
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setOpen(true)} className={buttonClass(current ? 'ghost' : 'secondary', 'sm')} data-testid="readiness-open">
          {current ? 'Change what Sidequest knows' : 'Want Sidequest to check travel-document requirements?'}
        </button>
        {current ? (
          <button type="button" disabled={pending} onClick={() => startTransition(async () => void (await clearReadinessProfileAction(tripId)))} className={buttonClass('ghost', 'sm')}>
            Forget these details
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <form action={submit} className="card-raised p-5" data-testid="readiness-form">
      <p className="eyebrow">Only what changes a requirement</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">No passport number, no scans, nothing inferred. Kept on this trip only; forget it any time.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink">
          Passport issued by
          <input name="citizenship" list="hub-countries" defaultValue={current?.citizenship ?? ''} maxLength={2} placeholder="e.g. US" className={cx(inputClass, 'uppercase')} data-testid="readiness-citizenship" />
        </label>
        <label className="text-sm text-ink">
          Country of residence <span className="text-ink-faint">(if different)</span>
          <input name="residence" list="hub-countries" defaultValue={current?.residence ?? ''} maxLength={2} className={cx(inputClass, 'uppercase')} />
        </label>
        <label className="text-sm text-ink">
          Passport expiry month
          <input name="passportExpiry" type="month" defaultValue={current?.passportExpiry?.slice(0, 7) ?? ''} className={inputClass} data-testid="readiness-passport" />
        </label>
        <label className="text-sm text-ink">
          Who is travelling
          <select name="ageCategory" defaultValue={current?.ageCategory ?? 'adult'} className={inputClass}>
            <option value="adult">Adults</option>
            <option value="senior">Includes seniors</option>
            <option value="mixed_with_minors">Includes children</option>
            <option value="minor_travelling">A minor travelling</option>
          </select>
        </label>
        {drives ? (
          <label className="text-sm text-ink">
            Driving licence issued by
            <input name="drivingLicenceCountry" list="hub-countries" defaultValue={current?.drivingLicenceCountry ?? ''} maxLength={2} className={cx(inputClass, 'uppercase')} />
          </label>
        ) : null}
      </div>
      <datalist id="hub-countries">
        {COUNTRIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')} data-testid="readiness-save">
          {pending ? 'Checking…' : 'Check my requirements'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CheckBox({ tripId, list, itemId, checked, label, hint, testId }: { tripId?: string; list: 'packing' | 'checklist'; itemId: string; checked: boolean; label: string; hint?: string; testId?: string }) {
  const [pending, startTransition] = useTransition();
  const [local, setLocal] = useState(checked);
  return (
    <label className={cx('flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--radius-control)] py-2', FOCUS_RING, local && 'text-ink-faint')}>
      <input
        type="checkbox"
        checked={local}
        disabled={pending || !tripId}
        onChange={(e) => {
          const next = e.target.checked;
          setLocal(next);
          if (tripId) startTransition(async () => void (await setCheckAction(tripId, list, itemId, next)));
        }}
        className="mt-1 h-[18px] w-[18px] shrink-0 accent-[var(--color-accent)]"
        {...(testId ? { 'data-testid': testId } : {})}
      />
      <span className="min-w-0">
        <span className={cx('block text-sm font-medium', local ? 'line-through' : 'text-ink')}>{label}</span>
        {hint ? <span className="check-hint block text-xs leading-snug text-ink-muted">{hint}</span> : null}
      </span>
    </label>
  );
}
