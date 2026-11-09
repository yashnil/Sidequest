'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { callAction } from '../client-action';
import { undoTripEditAction } from '@/app/(product)/trips/[id]/itinerary/actions';

/**
 * WHAT YOU JUST CHANGED, AND THE WAY BACK.
 *
 * An edit used to answer in the control that made it — and most controls close
 * or leave with the change. Move a stop to another day and its row, menu and
 * confirmation sentence all went to that day together; remove one and nothing
 * said anything at all. So the page changed under the traveller with no
 * statement of what happened and no way to take it back.
 *
 * Every edit now raises one event, and this one toast answers it wherever the
 * traveller is on the page: the sentence the server wrote about the change,
 * and Undo, which restores the plan exactly as it stood before it (a stored
 * state, never a re-plan). It stays long enough to read and act on, waits
 * while it is hovered or focused, and is a polite live region, so the same
 * sentence reaches a screen reader without taking focus.
 */
export const TRIP_EDITED_EVENT = 'sidequest:trip-edited';

export interface TripEditDetail {
  message: string;
  undoable?: boolean;
  restoresPlaceId?: string;
}

/** Called by an edit control when its change was saved. Safe on the server (no-op) and with no toast mounted. */
export function announceTripEdit(result: { changed?: string; undoable?: boolean; restoresPlaceId?: string }, fallback = 'Saved.'): void {
  if (typeof window === 'undefined') return;
  const detail: TripEditDetail = { message: result.changed ?? fallback, ...(result.undoable ? { undoable: true } : {}), ...(result.restoresPlaceId ? { restoresPlaceId: result.restoresPlaceId } : {}) };
  window.dispatchEvent(new CustomEvent<TripEditDetail>(TRIP_EDITED_EVENT, { detail }));
}

const READ_MS = 12_000;
const DONE_MS = 5_000;

export function EditToast({ tripId }: { tripId: string }) {
  const [toast, setToast] = useState<(TripEditDetail & { key: number; error?: boolean }) | null>(null);
  const [pending, startTransition] = useTransition();
  const [held, setHeld] = useState(false);
  const counter = useRef(0);

  useEffect(() => {
    const onEdit = (event: Event) => {
      const detail = (event as CustomEvent<TripEditDetail>).detail;
      if (!detail?.message) return;
      counter.current += 1;
      setToast({ ...detail, key: counter.current });
    };
    window.addEventListener(TRIP_EDITED_EVENT, onEdit);
    return () => window.removeEventListener(TRIP_EDITED_EVENT, onEdit);
  }, []);

  /* It leaves on its own — but never while it is being read, pointed at, or mid-undo. */
  useEffect(() => {
    if (!toast || held || pending) return;
    const handle = window.setTimeout(() => setToast((current) => (current?.key === toast.key ? null : current)), toast.undoable ? READ_MS : DONE_MS);
    return () => window.clearTimeout(handle);
  }, [toast, held, pending]);

  const undo = () => {
    if (!toast?.undoable) return;
    const restores = toast.restoresPlaceId;
    startTransition(async () => {
      const outcome = await callAction(() => undoTripEditAction(tripId, restores));
      counter.current += 1;
      if (!outcome.ok) return setToast({ message: outcome.message, key: counter.current, error: true });
      if (!outcome.value.ok) return setToast({ message: outcome.value.error ?? 'That could not be undone.', key: counter.current, error: true });
      setToast({ message: outcome.value.changed ?? 'Undone.', key: counter.current });
    });
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 print:hidden sm:bottom-6">
      {/* The live region is always in the document; only its content comes and goes, so the first edit is announced too. */}
      <div
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocusCapture={() => setHeld(true)}
        onBlurCapture={() => setHeld(false)}
        role="status"
        aria-live="polite"
        className={toast ? 'pointer-events-auto flex max-w-[34rem] items-center gap-2 rounded-[var(--radius-panel)] bg-night py-2 pr-2 pl-4 text-sm text-bone shadow-float fade-up' : 'sr-only'} 
        data-testid="edit-toast"
        data-state={toast ? (toast.error ? 'error' : 'shown') : 'idle'}
      >
        {toast ? (
          <>
            <p key={toast.key} className="min-w-0 flex-1 leading-snug" data-testid="edit-toast-message">
              {toast.message}
            </p>
            {toast.undoable ? (
              <button type="button" onClick={undo} disabled={pending} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-flare px-4 text-sm font-semibold text-night disabled:opacity-60" data-testid="edit-toast-undo">
                {pending ? 'Undoing…' : 'Undo'}
              </button>
            ) : null}
            <button type="button" onClick={() => setToast(null)} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-lg text-bone/80 hover:text-bone" aria-label="Dismiss">
              <span aria-hidden="true">×</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
