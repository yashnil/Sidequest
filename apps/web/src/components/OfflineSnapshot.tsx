'use client';

import { useEffect, useState } from 'react';

/**
 * LIVE WORLD V1 — "SAVED FOR OFFLINE".
 *
 * Registers the trip service worker and asks it to snapshot this page. The
 * indicator says what is true: saved, saving, or not available in this
 * browser. Nothing here alters the plan.
 */
export function OfflineSnapshot({ path }: { path: string }) {
  const [state, setState] = useState<'unsupported' | 'saving' | 'saved' | 'failed'>('saving');
  useEffect(() => {
    let cancelled = false;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      // Deferred so the effect never sets state synchronously during a render pass.
      void Promise.resolve().then(() => {
        if (!cancelled) setState('unsupported');
      });
      return () => {
        cancelled = true;
      };
    }
    navigator.serviceWorker
      .register('/trip-offline-sw.js')
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        const worker = registration.active ?? registration.waiting ?? registration.installing;
        worker?.postMessage({ type: 'snapshot', url: path });
        if (!cancelled) setState('saved');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (state === 'unsupported') return null;
  return (
    <span className="text-xs text-ink-faint print:hidden" data-testid="offline-snapshot" data-state={state}>
      {state === 'saved' ? 'Saved for offline use in this browser.' : state === 'saving' ? 'Saving for offline use…' : 'Could not save for offline use in this browser.'}
    </span>
  );
}
