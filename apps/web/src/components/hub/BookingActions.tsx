'use client';

import { useState, useTransition } from 'react';
import { useRefresh } from '../use-refresh';
import { BOOKED_ITEM_TYPES, BOOKED_ITEM_TYPE_LABELS, type BookedItemType, type BookingItem } from '@sidequest/core';
import { ErrorNote, buttonClass, cx } from '../ui';
import { addConfirmationAction, markBookedAction, replaceBookingAction, skipBookingAction, unskipBookingAction, type ConfirmationInput, type MarkBookedInput } from '@/app/(product)/trips/[id]/itinerary/actions';
import { BOOKED_TYPE_FOR_KIND, PAID_WORD, REFUNDABLE_WORD } from './booking-copy';

/**
 * V9 §5 — THE ACTIONS ON A BOOKING NEED.
 *
 * Open official source · Mark booked · Add confirmation · Replace · Skip.
 * Each is one press that calls one server action and lets the page re-render
 * from disk; the compact forms are pre-filled from the need so marking a
 * hotel booked is four fields, not fourteen. Nothing here keeps its own copy
 * of the plan, and nothing here spends.
 */
const FIELD = 'mt-1 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine';
const GHOST = buttonClass('ghost', 'sm');

type Mode = 'idle' | 'mark' | 'replace' | 'confirm';
/** V9.1 §10 — which press is in flight, so that button alone says "Saving…". */
type Press = 'skip' | 'unskip' | 'form' | null;

export interface BookingActionsProps {
  tripId: string;
  need: BookingItem;
  skipped: boolean;
  tripStart: string;
  tripEnd: string;
}

function readForm(form: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of form.entries()) out[key] = typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  return out;
}

function costOf(values: Record<string, string | undefined>): { amount: number; currency: string } | undefined {
  const amount = values.costAmount ? Number(values.costAmount) : NaN;
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  return { amount, currency: (values.costCurrency ?? 'USD').toUpperCase().slice(0, 8) };
}

export function BookingActions({ tripId, need, skipped, tripStart, tripEnd }: BookingActionsProps) {
  const refresh = useRefresh();
  const [mode, setMode] = useState<Mode>('idle');
  const [pending, startTransition] = useTransition();
  const [press, setPress] = useState<Press>(null);
  const [error, setError] = useState<string | null>(null);
  const isGroup = Boolean(need.memberIds && need.memberIds.length > 0);
  const open = need.status === 'open' || need.status === 'not_needed';
  const booked = (need.status === 'booked' || need.status === 'soft_hold') && need.bookedItemId;
  const busy = (which: Press) => pending && press === which;

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, which: Press = 'form') => {
    setError(null);
    setPress(which);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? 'That did not save.');
        return;
      }
      setMode('idle');
      refresh();
    });
  };

  return (
    <div className="mt-2 print:hidden" data-testid="booking-actions" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {need.officialSourceUrl ? (
          <a href={need.officialSourceUrl} target="_blank" rel="noreferrer noopener" className={GHOST} data-testid="booking-open-source">
            {need.officialSourceName ? `Open ${need.officialSourceName}` : 'Open official source'}
          </a>
        ) : null}
        {!isGroup && open ? (
          <>
            <button type="button" disabled={pending} className={GHOST} aria-expanded={mode === 'mark'} onClick={() => setMode(mode === 'mark' ? 'idle' : 'mark')} data-testid="booking-mark-booked">
              Mark booked
            </button>
            <button type="button" disabled={pending} className={GHOST} aria-expanded={mode === 'replace'} onClick={() => setMode(mode === 'replace' ? 'idle' : 'replace')} data-testid="booking-replace">
              Booked something else
            </button>
            {skipped ? (
              <button type="button" disabled={pending} aria-busy={busy('unskip')} className={GHOST} onClick={() => run(() => unskipBookingAction(tripId, need.id), 'unskip')} data-testid="booking-unskip">
                {busy('unskip') ? 'Saving…' : 'Put it back'}
              </button>
            ) : (
              <button type="button" disabled={pending} aria-busy={busy('skip')} className={GHOST} onClick={() => run(() => skipBookingAction(tripId, need.id), 'skip')} data-testid="booking-skip">
                {busy('skip') ? 'Saving…' : 'Skip'}
              </button>
            )}
          </>
        ) : null}
        {booked ? (
          <button type="button" disabled={pending} className={GHOST} aria-expanded={mode === 'confirm'} onClick={() => setMode(mode === 'confirm' ? 'idle' : 'confirm')} data-testid="booking-add-confirmation">
            Add confirmation
          </button>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {pending ? 'Saving…' : ''}
        </span>
      </div>
      {error && mode === 'idle' ? <ErrorNote>{error}</ErrorNote> : null}
      {mode === 'mark' || mode === 'replace' ? (
        <MarkBookedForm
          need={need}
          replace={mode === 'replace'}
          tripStart={tripStart}
          tripEnd={tripEnd}
          pending={pending}
          error={error}
          onCancel={() => setMode('idle')}
          onSubmit={(payload) => run(() => (mode === 'replace' ? replaceBookingAction(tripId, payload) : markBookedAction(tripId, payload)))}
        />
      ) : null}
      {mode === 'confirm' && need.bookedItemId ? (
        <ConfirmationForm pending={pending} error={error} onCancel={() => setMode('idle')} onSubmit={(payload) => run(() => addConfirmationAction(tripId, need.bookedItemId!, payload))} />
      ) : null}
    </div>
  );
}

/** The compact "Mark booked" / "Booked something else" form, pre-filled from the need. */
export function MarkBookedForm({ need, replace, tripStart, tripEnd, pending, error, onCancel, onSubmit }: { need: BookingItem; replace: boolean; tripStart: string; tripEnd: string; pending: boolean; error: string | null; onCancel: () => void; onSubmit: (payload: MarkBookedInput) => void }) {
  const [type, setType] = useState<BookedItemType>(BOOKED_TYPE_FOR_KIND[need.kind]);
  const lodging = type === 'lodging';
  const timed = type === 'flight' || type === 'train' || type === 'ferry';
  const defaultDate = need.date && need.date >= tripStart && need.date <= tripEnd ? need.date : tripStart;

  function submit(form: FormData) {
    const values = readForm(form);
    const cost = costOf(values);
    const payload: MarkBookedInput = {
      bookingItemId: need.id,
      type,
      title: values.title ?? '',
      date: values.date,
      endDate: lodging ? values.endDate : undefined,
      startTime: !lodging ? values.startTime : undefined,
      endTime: !lodging ? values.endTime : undefined,
      location: values.location,
      provider: values.provider,
      confirmationRef: values.confirmationRef,
      cancellationDeadline: values.cancellationDeadline,
      ...(cost ? { cost } : {}),
      ...(values.paid ? { paid: values.paid as 'paid' | 'deposit' | 'unpaid' } : {}),
      ...(values.refundable ? { refundable: values.refundable as 'refundable' | 'non_refundable' | 'unknown' } : {}),
      ...(need.baseId ? { baseId: need.baseId } : {}),
      ...(need.placeId ? { placeId: need.placeId } : {}),
      status: 'booked',
    };
    onSubmit(payload);
  }

  return (
    <form action={submit} className="card-raised mt-2 p-4" data-testid="mark-booked-form" aria-busy={pending}>
      <p className="eyebrow">{replace ? 'What you booked instead' : 'Mark booked'}</p>
      <p className="mt-1 text-sm text-ink-muted">{replace ? `This replaces "${need.title}" on the plan; Sidequest schedules around what you booked.` : 'Only what you know. The plan reshapes around it at the next look.'}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink">
          Kind
          <select name="type" value={type} onChange={(e) => setType(e.target.value as BookedItemType)} className={FIELD} data-testid="mark-booked-type">
            {BOOKED_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {BOOKED_ITEM_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink">
          Name
          <input name="title" required maxLength={160} defaultValue={replace ? '' : need.title} placeholder={replace ? 'What you booked' : undefined} className={FIELD} data-testid="mark-booked-title" />
        </label>
        <label className="text-sm text-ink">
          {lodging ? 'Check-in' : 'Date'}
          <input name="date" type="date" required min={tripStart} max={tripEnd} defaultValue={defaultDate} className={FIELD} data-testid="mark-booked-date" />
        </label>
        {lodging ? (
          <label className="text-sm text-ink">
            Check-out
            <input name="endDate" type="date" min={tripStart} max={tripEnd} className={FIELD} data-testid="mark-booked-end-date" />
          </label>
        ) : (
          <label className="text-sm text-ink">
            {timed ? 'Departs' : 'Starts'}
            <input name="startTime" type="time" defaultValue={need.timeLabel && /^\d{2}:\d{2}$/.test(need.timeLabel) ? need.timeLabel : ''} className={FIELD} data-testid="mark-booked-start" />
          </label>
        )}
        {!lodging ? (
          <label className="text-sm text-ink">
            {timed ? 'Arrives' : 'Ends'}
            <input name="endTime" type="time" className={FIELD} />
          </label>
        ) : null}
        <label className="text-sm text-ink">
          {lodging ? 'Town or area' : 'Where'}
          <input name="location" maxLength={160} className={FIELD} />
        </label>
        <label className="text-sm text-ink">
          Booked with <span className="text-ink-faint">(optional)</span>
          <input name="provider" maxLength={80} className={FIELD} />
        </label>
        <label className="text-sm text-ink">
          Confirmation reference <span className="text-ink-faint">(stays on this trip only)</span>
          <input name="confirmationRef" maxLength={80} autoComplete="off" className={FIELD} data-testid="mark-booked-ref" />
        </label>
        <CostAndTerms />
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('primary', 'sm')} data-testid="mark-booked-save">
          {pending ? 'Saving…' : replace ? 'Save what you booked' : 'Save as booked'}
        </button>
        <button type="button" onClick={onCancel} className={GHOST}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Cost, paid state and refund terms — shared by the mark form and the confirmation form. */
function CostAndTerms({ cost, paid, refundable, cancellationDeadline }: { cost?: { amount: number; currency: string }; paid?: string; refundable?: string; cancellationDeadline?: string } = {}) {
  return (
    <>
      <label className="text-sm text-ink">
        Amount <span className="text-ink-faint">(optional)</span>
        <span className="mt-1 flex gap-2">
          <input name="costAmount" type="number" min={0} step={1} defaultValue={cost?.amount ?? ''} className={cx(FIELD, 'mt-0')} aria-label="Amount" data-testid="booking-cost-amount" />
          <input name="costCurrency" maxLength={8} defaultValue={cost?.currency ?? 'USD'} className={cx(FIELD, 'mt-0 w-24 uppercase')} aria-label="Currency" />
        </span>
      </label>
      <label className="text-sm text-ink">
        Paid
        <select name="paid" defaultValue={paid ?? ''} className={FIELD} data-testid="booking-paid">
          <option value="">Not recorded</option>
          <option value="paid">{PAID_WORD.paid}</option>
          <option value="deposit">{PAID_WORD.deposit}</option>
          <option value="unpaid">{PAID_WORD.unpaid}</option>
        </select>
      </label>
      <label className="text-sm text-ink">
        Refund terms
        <select name="refundable" defaultValue={refundable ?? ''} className={FIELD} data-testid="booking-refundable">
          <option value="">Not recorded</option>
          <option value="refundable">{REFUNDABLE_WORD.refundable}</option>
          <option value="non_refundable">{REFUNDABLE_WORD.non_refundable}</option>
        </select>
      </label>
      <label className="text-sm text-ink">
        Free cancellation until <span className="text-ink-faint">(optional)</span>
        <input name="cancellationDeadline" type="date" defaultValue={cancellationDeadline ?? ''} className={FIELD} />
      </label>
    </>
  );
}

/** "Add confirmation" on a booked fact: reference, link, amount, paid, refund terms, deadline. */
export function ConfirmationForm({ current, pending, error, onCancel, onSubmit }: { current?: { confirmationRef?: string; url?: string; cost?: { amount: number; currency: string }; paid?: string; refundable?: string; cancellationDeadline?: string; provider?: string }; pending: boolean; error: string | null; onCancel: () => void; onSubmit: (payload: ConfirmationInput) => void }) {
  function submit(form: FormData) {
    const values = readForm(form);
    const cost = costOf(values);
    onSubmit({
      confirmationRef: values.confirmationRef,
      url: values.url,
      provider: values.provider,
      cancellationDeadline: values.cancellationDeadline,
      ...(cost ? { cost } : {}),
      ...(values.paid ? { paid: values.paid as 'paid' | 'deposit' | 'unpaid' } : {}),
      ...(values.refundable ? { refundable: values.refundable as 'refundable' | 'non_refundable' | 'unknown' } : {}),
    });
  }
  return (
    <form action={submit} className="card-raised mt-2 p-4" data-testid="confirmation-form" aria-busy={pending}>
      <p className="eyebrow">Your confirmation</p>
      <p className="mt-1 text-sm text-ink-muted">Kept on this trip only; never printed, never on a shared copy.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink">
          Confirmation reference
          <input name="confirmationRef" maxLength={80} autoComplete="off" defaultValue={current?.confirmationRef ?? ''} className={FIELD} data-testid="confirmation-ref" />
        </label>
        <label className="text-sm text-ink">
          Link to the booking <span className="text-ink-faint">(optional)</span>
          <input name="url" type="url" maxLength={500} defaultValue={current?.url ?? ''} placeholder="https://" className={FIELD} />
        </label>
        <label className="text-sm text-ink">
          Booked with <span className="text-ink-faint">(optional)</span>
          <input name="provider" maxLength={80} defaultValue={current?.provider ?? ''} className={FIELD} />
        </label>
        <CostAndTerms {...(current?.cost ? { cost: current.cost } : {})} {...(current?.paid ? { paid: current.paid } : {})} {...(current?.refundable ? { refundable: current.refundable } : {})} {...(current?.cancellationDeadline ? { cancellationDeadline: current.cancellationDeadline } : {})} />
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('primary', 'sm')} data-testid="confirmation-save">
          {pending ? 'Saving…' : 'Save confirmation'}
        </button>
        <button type="button" onClick={onCancel} className={GHOST}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The same confirmation form, on a booked fact's own row. */
export function AddConfirmationButton({ tripId, item }: { tripId: string; item: { id: string; confirmationRef?: string; url?: string; cost?: { amount: number; currency: string }; paid?: string; refundable?: string; cancellationDeadline?: string; provider?: string } }) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="print:hidden">
      <button type="button" className={GHOST} aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="booking-add-confirmation">
        {item.confirmationRef ? 'Edit confirmation' : 'Add confirmation'}
      </button>
      {open ? (
        <ConfirmationForm
          current={item}
          pending={pending}
          error={error}
          onCancel={() => setOpen(false)}
          onSubmit={(payload) => {
            setError(null);
            startTransition(async () => {
              const result = await addConfirmationAction(tripId, item.id, payload);
              if (!result.ok) {
                setError(result.error ?? 'That did not save.');
                return;
              }
              setOpen(false);
              refresh();
            });
          }}
        />
      ) : null}
    </span>
  );
}
