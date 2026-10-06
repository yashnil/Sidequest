'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { callAction, newBuildKey } from '@/components/client-action';
import {
  easeDayAction,
  regenerateItineraryAction,
  removeStopAction,
  swapAlternativesAction,
  swapStopAction,
  toggleLockAction,
  type SwapOffer,
} from './actions';

/**
 * THE EDITING SURFACE: ONE QUIET CONTROL PER STOP, NOT A TOOLBAR.
 *
 * Each activity row carries a single overflow button; everything behind it is
 * a structured intent handed to a deterministic server-side replan (§11.1).
 * The menu deliberately offers only what the planner can actually honour —
 * remove, swap against this trip's own unused supply, lock — and every failure
 * comes back as a sentence, because "the button did nothing" is the worst
 * outcome an edit can have.
 */
export function StopEditMenu({
  tripId,
  dayNumber,
  placeId,
  title,
  locked,
}: {
  tripId: string;
  dayNumber: number;
  placeId: string;
  title: string;
  locked: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [offers, setOffers] = useState<SwapOffer[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  /* Click-away closes the menu; the page is long and modals are heavier than
     this deserves. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setOffers(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const run = (work: () => Promise<{ ok: boolean; error?: string; changed?: string }>) => {
    setStatus(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setStatus(result.error ?? 'That change could not be made.');
        return;
      }
      setOpen(false);
      setOffers(null);
      router.refresh();
    });
  };

  const loadOffers = () => {
    setStatus(null);
    startTransition(async () => {
      const result = await swapAlternativesAction(tripId, dayNumber, placeId);
      if (!result.ok) {
        setStatus(result.error ?? 'We could not look for alternatives just then.');
        return;
      }
      setOffers(result.offers ?? []);
    });
  };

  return (
    <div ref={rootRef} className="relative print:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change ${title}`}
        onClick={() => {
          setOpen((value) => !value);
          setOffers(null);
          setStatus(null);
        }}
        className="pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-transparent px-2 text-lg text-ink-muted transition-colors hover:border-rule hover:bg-paper-sunk hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
      >
        {locked ? '🔒' : '⋯'}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-64 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-1 shadow-[var(--shadow-float)]"
        >
          {offers === null ? (
            <>
              <MenuButton
                disabled={pending}
                onClick={() => run(() => toggleLockAction(tripId, dayNumber, placeId, !locked))}
              >
                {locked ? 'Unlock — a rebuild may move it' : 'Lock to this day'}
              </MenuButton>
              <MenuButton disabled={pending} onClick={loadOffers}>
                Swap for something similar…
              </MenuButton>
              <MenuButton
                disabled={pending}
                tone="danger"
                onClick={() => run(() => removeStopAction(tripId, dayNumber, placeId))}
              >
                Remove from this day
              </MenuButton>
            </>
          ) : offers.length === 0 ? (
            <p className="px-3 py-2 text-sm leading-relaxed text-ink-muted">
              Nothing else on your board fits this slot — same day, similar effort, reachable and
              open. Removing it is still an option.
            </p>
          ) : (
            <>
              <p className="eyebrow px-3 pt-2 pb-1">
                Swap {title} for
              </p>
              {offers.map((offer) => (
                <MenuButton
                  key={offer.placeId}
                  disabled={pending}
                  onClick={() =>
                    run(() => swapStopAction(tripId, dayNumber, placeId, offer.placeId))
                  }
                >
                  <span className="block text-ink">{offer.name}</span>
                  <span className="block text-xs text-ink-muted">{offer.reason}</span>
                </MenuButton>
              ))}
            </>
          )}
          {status ? (
            <p role="alert" className="px-3 py-2 text-xs leading-relaxed text-clay">
              {status}
            </p>
          ) : null}
          {pending ? (
            <p role="status" className="px-3 py-2 text-xs text-ink-faint">
              Working…
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`block min-h-11 w-full rounded-[var(--radius-control)] px-3 py-2 text-left text-sm transition-colors hover:bg-paper-sunk disabled:opacity-50 ${
        tone === 'danger' ? 'text-clay' : 'text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/** Day-level tuning: one honest verb, not a settings panel. */
export function EaseDayButton({ tripId, dayNumber }: { tripId: string; dayNumber: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <span className="print:hidden">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setStatus(null);
          startTransition(async () => {
            const result = await easeDayAction(tripId, dayNumber);
            if (!result.ok) {
              setStatus(result.error ?? 'This day could not be made easier.');
              return;
            }
            router.refresh();
          });
        }}
        className={buttonClass('ghost', 'sm')}
      >
        {pending ? 'Rearranging…' : 'Make this day easier'}
      </button>
      {status ? (
        <span role="alert" className="ml-2 text-sm text-clay">
          {status}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Print completeness (§17): the page's collapsed disclosures open before the
 * print dialog renders, whichever way it was invoked, and close again after.
 * CSS cannot do this — children of a closed `<details>` are unrendered, not
 * merely hidden, so a print stylesheet has nothing to reveal.
 */
export function PrintExpand() {
  useEffect(() => {
    const opened = new Set<HTMLDetailsElement>();
    const before = () => {
      for (const details of document.querySelectorAll<HTMLDetailsElement>('details:not([open])')) {
        details.open = true;
        opened.add(details);
      }
    };
    const after = () => {
      for (const details of opened) details.open = false;
      opened.clear();
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  return null;
}

/**
 * REGENERATE — A DURABLE REBUILD, AFTER SAYING WHAT IT KEEPS.
 *
 * The press opens a confirmation first: what survives a rebuild (board
 * decisions, must-keeps and locks, bookings, the party) and — only when there
 * are some — the edits made on this itinerary that it replaces. Confirming
 * records a durable build run and goes to the build screen, which shows
 * progress and returns here when the new plan is saved. The copy comes from the
 * server (`regenerate-summary.ts`) so it says only what the build will do.
 */
export function RegenerateButton({ tripId, copy }: { tripId: string; copy?: { kept: string; replaced: readonly string[] } }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef<string | null>(null);

  const start = () => {
    setStatus(null);
    key.current ??= newBuildKey();
    const buildKey = key.current;
    startTransition(async () => {
      const outcome = await callAction(() => regenerateItineraryAction(tripId, buildKey));
      if (!outcome.ok) {
        setStatus(outcome.message);
        return;
      }
      if (!outcome.value.ok) {
        key.current = null;
        setStatus(outcome.value.error);
        return;
      }
      router.push(`/trips/${tripId}/build`);
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        aria-expanded={confirming}
        data-testid="regenerate-trip"
        onClick={() => {
          setStatus(null);
          setConfirming((open) => !open);
        }}
        className={buttonClass('ghost', 'sm')}
      >
        Regenerate
      </button>
      {confirming ? (
        <div role="group" aria-labelledby="regenerate-heading" className="max-w-[22rem] rounded-[var(--radius-control)] border border-rule bg-paper p-3 text-sm" data-testid="regenerate-confirm">
          <p id="regenerate-heading" className="font-medium text-ink">
            Plan this trip again from scratch?
          </p>
          {copy ? (
            <>
              <p className="mt-1.5 leading-relaxed text-ink-muted" data-testid="regenerate-kept">
                {copy.kept}
              </p>
              {copy.replaced.map((line) => (
                <p key={line} className="mt-1.5 leading-relaxed text-ink" data-testid="regenerate-replaced">
                  {line}
                </p>
              ))}
            </>
          ) : null}
          <p className="mt-1.5 leading-relaxed text-ink-muted">It takes a minute or two. You will watch it build, then come back to the new plan.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={start} className={buttonClass('primary', 'sm')} data-testid="regenerate-confirm-start">
              {pending ? 'Starting…' : 'Rebuild the trip'}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={buttonClass('ghost', 'sm')}>
              Keep this plan
            </button>
          </div>
          {status ? (
            <p role="alert" className="mt-2 text-sm text-clay" data-testid="regenerate-error">
              {status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
