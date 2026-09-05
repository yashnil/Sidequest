'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
        className="rounded-md px-2 py-1 text-ink-faint transition-colors hover:bg-paper-sunk hover:text-ink"
      >
        {locked ? '🔒' : '⋯'}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-rule bg-paper p-1 shadow-lg"
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
            <p className="px-3 py-2 text-xs leading-relaxed text-ink-muted">
              Nothing else on your board fits this slot — same day, similar effort, reachable and
              open. Removing it is still an option.
            </p>
          ) : (
            <>
              <p className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-faint">
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
      className={`block w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-paper-sunk disabled:opacity-50 ${
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
        className="text-xs text-ink-faint underline underline-offset-4 transition-colors hover:text-ink disabled:opacity-50"
      >
        {pending ? 'Rearranging…' : 'Make this day easier'}
      </button>
      {status ? (
        <span role="alert" className="ml-2 text-xs text-clay">
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
 * REGENERATE — THE SAME CANONICAL GENERATION AS "BUILD MY TRIP", FROM THE PLAN.
 *
 * One model call, a fresh draft, verified and reconciled the same way, and
 * the page refreshes onto the replacement. Disabled while pending so a second
 * press cannot overlap a write.
 */
export function RegenerateButton({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        data-testid="regenerate-trip"
        onClick={() => {
          setStatus(null);
          startTransition(async () => {
            const result = await regenerateItineraryAction(tripId);
            if (!result.ok) {
              setStatus(result.error ?? 'We could not regenerate your trip just now.');
              return;
            }
            router.refresh();
          });
        }}
        className="rounded-md border border-rule bg-paper px-3 py-1.5 text-sm text-ink transition-colors hover:border-ink disabled:opacity-50"
      >
        {pending ? 'Regenerating…' : 'Regenerate'}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? 'Regenerating your trip. This can take a minute or two.' : ''}
      </span>
      {status ? (
        <span role="alert" className="text-xs text-clay">
          {status}
        </span>
      ) : null}
    </span>
  );
}
