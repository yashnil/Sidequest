'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass, cx } from '@/components/ui';
import { addCustomStopAction, fixDayAction, moveStopAction, setStopDurationAction, setStopKeepAction, shiftStopAction, updateBookedItemAction, discoverStaysAction, discoverFoodAction, type DiscoveryActionResult } from './actions';

/**
 * LIVE WORLD V1 — THE CONTROLS THAT CHANGE A DAY WITHOUT A MODEL CALL.
 *
 * Every control here hands a structured intent to a deterministic server
 * edit and refreshes the page; every failure comes back as a sentence.
 * Nothing spends: no rebuild, no provider call, except the two discovery
 * buttons, each of which is one bounded lookup the traveller pressed for.
 */
/*
 * V8 — REAL CONTROLS, NOT UNDERLINED TEXT.
 *
 * Every edit affordance on a day was a 12-pixel underlined link, which is the
 * same object as a citation. They are ghost buttons now: 44 px tall, plainly
 * pressable, quiet because they have no ground rather than because they are
 * faded. The text of each is unchanged — the browser suite reads it.
 */
const GHOST = buttonClass('ghost', 'sm');
const FIELD = 'min-h-11 rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine';

export function StopDayControls({ tripId, dayNumber, stopId, title, dayCount, role }: { tripId: string; dayNumber: number; stopId: string; title: string; dayCount: number; role?: 'core' | 'secondary' | 'optional' | 'flex' }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const run = (work: () => Promise<{ ok: boolean; error?: string; changed?: string }>) => {
    setStatus(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setStatus(result.error ?? 'That change could not be made.');
        return;
      }
      setStatus(result.changed ?? null);
      router.refresh();
    });
  };
  return (
    <div className="print:hidden" data-testid="stop-day-controls">
      <button type="button" className={GHOST} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Close day controls' : 'Move, re-time or keep…'}
      </button>
      {open ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-[var(--radius-card)] border border-rule bg-paper-sunk/60 p-2 text-sm">
          <button type="button" disabled={pending} className={GHOST} onClick={() => run(() => shiftStopAction(tripId, dayNumber, stopId, 'earlier'))} data-testid="stop-earlier">
            Earlier
          </button>
          <button type="button" disabled={pending} className={GHOST} onClick={() => run(() => shiftStopAction(tripId, dayNumber, stopId, 'later'))} data-testid="stop-later">
            Later
          </button>
          <label className="inline-flex items-center gap-2 text-sm text-ink-muted">
            Move to
            <select
              disabled={pending || dayCount < 2}
              className={cx(FIELD, 'py-1')}
              defaultValue=""
              data-testid="stop-move-day"
              onChange={(event) => {
                const target = Number(event.target.value);
                if (Number.isFinite(target) && target > 0) run(() => moveStopAction(tripId, dayNumber, stopId, target));
              }}
            >
              <option value="">day…</option>
              {Array.from({ length: dayCount }, (_, i) => i + 1)
                .filter((d) => d !== dayNumber)
                .map((d) => (
                  <option key={d} value={d}>
                    Day {d}
                  </option>
                ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-ink-muted">
            Minutes
            <input
              type="number"
              min={15}
              max={600}
              step={15}
              disabled={pending}
              className={cx(FIELD, 'w-24 py-1')}
              data-testid="stop-minutes"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const minutes = Number((event.target as HTMLInputElement).value);
                  if (Number.isFinite(minutes)) run(() => setStopDurationAction(tripId, dayNumber, stopId, minutes));
                }
              }}
              placeholder="60 ⏎"
            />
          </label>
          {role === 'core' ? (
            <button type="button" disabled={pending} className={GHOST} onClick={() => run(() => setStopKeepAction(tripId, dayNumber, stopId, 'optional'))} data-testid="stop-optional">
              Mark optional
            </button>
          ) : (
            <button type="button" disabled={pending} className={GHOST} onClick={() => run(() => setStopKeepAction(tripId, dayNumber, stopId, 'must_keep'))} data-testid="stop-must-keep">
              Must keep
            </button>
          )}
          {status ? (
            <span role="status" className="basis-full text-ink-muted">
              {status}
            </span>
          ) : null}
          {pending ? <span className="text-ink-faint">Working…</span> : null}
        </div>
      ) : null}
      <span className="sr-only">{title}</span>
    </div>
  );
}

export function FixDayButton({ tripId, dayNumber }: { tripId: string; dayNumber: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  return (
    <span className="print:hidden">
      <button
        type="button"
        disabled={pending}
        className={GHOST}
        data-testid="fix-day"
        onClick={() => {
          setStatus(null);
          setSteps([]);
          startTransition(async () => {
            const result = await fixDayAction(tripId, dayNumber);
            if (!result.ok) {
              setStatus(result.error ?? 'This day could not be repaired.');
              return;
            }
            setStatus(result.changed ?? 'Fixed.');
            setSteps(result.steps ?? []);
            router.refresh();
          });
        }}
      >
        {pending ? 'Fixing…' : 'Fix this day'}
      </button>
      {status ? (
        <span role="status" className="ml-2 text-sm text-ink-muted" data-testid="fix-day-status">
          {status}
        </span>
      ) : null}
      {steps.length > 0 ? <span className="sr-only">{steps.join(' ')}</span> : null}
    </span>
  );
}

export function AddStopForm({ tripId, dayNumber }: { tripId: string; dayNumber: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="border-t border-rule px-4 py-3 print:hidden sm:px-5" data-testid="add-stop">
      {open ? (
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const title = String(form.get('title') ?? '');
            const minutes = Number(form.get('minutes') ?? 60);
            setStatus(null);
            startTransition(async () => {
              const result = await addCustomStopAction(tripId, dayNumber, { title, minutes });
              if (!result.ok) {
                setStatus(result.error ?? 'That stop could not be added.');
                return;
              }
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <label className="flex flex-col gap-1 text-ink-muted">
            A stop of your own
            <input name="title" required minLength={2} maxLength={80} className={cx(FIELD, 'w-64 max-w-full')} placeholder="e.g. Harbour swim" data-testid="add-stop-title" />
          </label>
          <label className="flex flex-col gap-1 text-ink-muted">
            Minutes
            <input name="minutes" type="number" min={15} max={600} step={15} defaultValue={60} className={cx(FIELD, 'w-24')} />
          </label>
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')} data-testid="add-stop-submit">
            {pending ? 'Adding…' : 'Add to this day'}
          </button>
          <button type="button" className={GHOST} onClick={() => setOpen(false)}>
            Cancel
          </button>
          {status ? (
            <span role="alert" className="basis-full text-clay">
              {status}
            </span>
          ) : null}
        </form>
      ) : (
        <button type="button" className={GHOST} onClick={() => setOpen(true)} data-testid="add-stop-open">
          Add a stop of your own
        </button>
      )}
    </div>
  );
}

const BOOKED_STATUS_LABELS: Record<string, string> = { booked: 'Booked', soft_hold: 'Held', idea: 'Idea' };

const PAID_LABELS: Record<string, string> = { paid: 'Paid', deposit: 'Deposit', unpaid: 'Unpaid' };
const REFUND_LABELS: Record<string, string> = { refundable: 'Refundable', non_refundable: 'Non-refundable' };

/** V9 §5 — status, cost, and now paid / refund terms, each one press that patches the fact. */
export function BookedStatusControl({ tripId, id, status, cost, paid, refundable }: { tripId: string; id: string; status: string; cost?: { amount: number; currency: string }; paid?: string; refundable?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const apply = (patch: Record<string, unknown>) => {
    setError(null);
    startTransition(async () => {
      const result = await updateBookedItemAction(tripId, id, patch);
      if (!result.ok) {
        setError(result.error ?? 'That could not be saved.');
        return;
      }
      router.refresh();
    });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm print:hidden" data-testid="booked-status-control">
      <select value={status} disabled={pending} className={cx(FIELD, 'py-1')} aria-label="Booking status" data-testid="booked-status" onChange={(event) => apply({ status: event.target.value })}>
        {Object.entries(BOOKED_STATUS_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={0}
        step={1}
        defaultValue={cost?.amount ?? ''}
        placeholder="cost"
        aria-label="Cost paid"
        className={cx(FIELD, 'w-24 py-1')}
        data-testid="booked-cost"
        disabled={pending}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const amount = Number((event.target as HTMLInputElement).value);
            if (Number.isFinite(amount) && amount >= 0) apply({ cost: { amount, currency: cost?.currency ?? 'USD' } });
          }
        }}
      />
      {cost?.currency ? <span className="text-ink-faint">{cost.currency}</span> : null}
      <select value={paid ?? ''} disabled={pending} className={cx(FIELD, 'py-1')} aria-label="Paid" data-testid="booked-paid" onChange={(event) => apply(event.target.value ? { paid: event.target.value } : {})}>
        <option value="">Paid?</option>
        {Object.entries(PAID_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select value={refundable ?? ''} disabled={pending} className={cx(FIELD, 'py-1')} aria-label="Refund terms" data-testid="booked-refundable" onChange={(event) => apply(event.target.value ? { refundable: event.target.value } : {})}>
        <option value="">Refundable?</option>
        {Object.entries(REFUND_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-clay">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function DiscoverButton({ tripId, near, kind, label, query }: { tripId: string; near: { lat: number; lng: number } | null; kind: 'stays' | 'food'; label: string; query?: string }) {
  const [result, setResult] = useState<DiscoveryActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  if (!near) return null;
  return (
    <div className="mt-2 print:hidden" data-testid={`discover-${kind}`}>
      <button
        type="button"
        disabled={pending}
        className={GHOST}
        data-testid={`discover-${kind}-button`}
        onClick={() =>
          startTransition(async () => {
            setResult(kind === 'stays' ? await discoverStaysAction(tripId, near, query) : await discoverFoodAction(tripId, near, query));
          })
        }
      >
        {pending ? 'Looking…' : label}
      </button>
      {result ? (
        !result.ok ? (
          <p role="alert" className="mt-1 text-sm text-clay">
            {result.error}
          </p>
        ) : !result.available ? (
          <p className="mt-1 text-sm text-ink-muted" data-testid={`discover-${kind}-unavailable`}>
            {result.reason}
          </p>
        ) : (
          <div className="card mt-2 p-3 text-sm" data-testid={`discover-${kind}-results`}>
            {/*
              MVP V3, Stages 34 and 35 — ordered by fit, and each row says why it
              is where it is. The rating is shown because it is real information
              and withheld where there is none; it is never the thing that
              decides the order.
            */}
            <ul className="space-y-2">
              {(result.items ?? []).map((p) => (
                <li key={p.name}>
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-ink">
                      {p.website || p.mapsUri ? (
                        <a href={p.website ?? p.mapsUri} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
                          {p.name}
                        </a>
                      ) : (
                        p.name
                      )}
                      {p.priceLevel ? <span className="text-ink-faint"> · {p.priceLevel.replace(/_/g, ' ')}</span> : null}
                    </span>
                    <span className="numeral text-ink-faint">
                      {p.distanceKm} km
                      {p.rating !== undefined ? ` · ${p.rating.toFixed(1)}${p.reviewCountLabel ? ` · ${p.reviewCountLabel} reviews` : ''}` : ''}
                    </span>
                  </span>
                  {p.why ? <span className="mt-0.5 block text-ink-faint">Chosen for you: {p.why}.</span> : null}
                  {p.caution ? <span className="mt-0.5 block text-clay">{p.caution}</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-ink-faint">
              {result.attribution}. Ordered by how well each one fits your trip, not by rating. Found, not quoted: Sidequest has no live room prices or availability, and shows none.
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}
