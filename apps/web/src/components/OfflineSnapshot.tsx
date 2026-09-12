'use client';

import { useEffect, useState } from 'react';
import { setCheckAction } from '@/app/(product)/trips/[id]/itinerary/actions';
import { TRIP_SERVICE_WORKER_URL } from './ServiceWorkerRegistrar';

/**
 * "SAVED FOR OFFLINE" — LIVE WORLD V1, EXTENDED FOR V9 §11.
 *
 * Registers the trip service worker and asks it to keep this page (and any
 * others named) so the plan opens on a mountain with no signal. The
 * indicator says what is true: saved and when, saving, or not available in
 * this browser. Nothing here alters the plan; when a trip id is given and the
 * copy is saved, Preflight's "offline copy" tick is recorded through the
 * existing check action so the Prepare view can count it.
 */
type SnapshotState = 'unsupported' | 'saving' | 'saved' | 'failed';

const STORAGE_PREFIX = 'sidequest-offline:';

function relative(savedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function readSavedAt(path: string): number | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${path}`);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSavedAt(path: string, at: number): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${path}`, String(at));
  } catch {
    /* Storage refused: the indicator still says saved for this session. */
  }
}

/**
 * Forget every saved page — the sign-out counterpart of saving. Posts the
 * clear message to the worker and deletes the caches directly too, so a
 * browser whose worker is not yet controlling the page still ends clean.
 */
export async function clearOfflineSnapshots(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(key);
  } catch {
    /* nothing to forget */
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear' });
  } catch {
    /* no worker */
  }
  try {
    if ('caches' in window) {
      const names = await window.caches.keys();
      await Promise.all(names.filter((name) => name.startsWith('sidequest-trip-')).map((name) => window.caches.delete(name)));
    }
  } catch {
    /* no cache access */
  }
}

export function OfflineSnapshot({
  path,
  paths,
  tripId,
  testId = 'offline-snapshot',
  className,
}: {
  /** The page to keep; the first entry of `paths` when both are given. */
  path?: string;
  /** Every page to keep, e.g. the itinerary, Today and the Pack. */
  paths?: readonly string[];
  /** When set, a saved copy records Preflight's offline tick for this trip. */
  tripId?: string;
  testId?: string;
  className?: string;
}) {
  const wanted = paths && paths.length > 0 ? paths : path ? [path] : [];
  const key = wanted.join('|');
  const [state, setState] = useState<SnapshotState>('saving');
  /* The last save this browser recorded for the page, so a reload can still say when. Read once, never during a render pass. */
  const [savedAt, setSavedAt] = useState<number | null>(() => (typeof window === 'undefined' || wanted.length === 0 ? null : readSavedAt(wanted[0]!)));
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const list = key ? key.split('|') : [];
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || list.length === 0) {
      // Deferred so the effect never sets state synchronously during a render pass.
      void Promise.resolve().then(() => {
        if (!cancelled) setState('unsupported');
      });
      return () => {
        cancelled = true;
      };
    }
    navigator.serviceWorker
      .register(TRIP_SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' })
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        const worker = registration.active ?? registration.waiting ?? registration.installing;
        for (const url of list) worker?.postMessage({ type: 'snapshot', url });
        if (cancelled) return;
        const at = Date.now();
        writeSavedAt(list[0]!, at);
        setSavedAt(at);
        setNow(at);
        setState('saved');
        if (tripId) {
          try {
            await setCheckAction(tripId, 'preflight', 'offline', true);
          } catch {
            /* The tick is a convenience; the copy is saved either way. */
          }
        }
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [key, tripId]);

  useEffect(() => {
    if (state !== 'saved') return;
    /* "updated 3 min ago" stays true while the page is open: the clock ticks from outside React. */
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [state]);

  if (state === 'unsupported') return null;
  const label =
    state === 'saved'
      ? `Saved · updated ${relative(savedAt ?? now, now)}`
      : state === 'saving'
        ? 'Saving for offline use…'
        : 'Could not save for offline use in this browser.';
  return (
    <span className={className ?? 'text-xs text-ink-faint print:hidden'} data-testid={testId} data-state={state}>
      {label}
    </span>
  );
}
