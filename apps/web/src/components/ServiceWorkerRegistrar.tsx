'use client';

import { useEffect } from 'react';

export const TRIP_SERVICE_WORKER_URL = '/trip-offline-sw.js';

/**
 * V9 §11 — THE SERVICE WORKER, REGISTERED ONCE FOR THE WHOLE APP.
 *
 * Registered from the root layout so an installed Sidequest has its worker
 * before any trip is opened, with `updateViaCache: 'none'` so a new worker
 * file is fetched on every check rather than served from the HTTP cache —
 * the one thing that makes shipping `v2` actually replace `v1`. Renders
 * nothing; the per-page saving indicator is `OfflineSnapshot`, which posts
 * the pages it wants kept.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(TRIP_SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
  }, []);
  return null;
}
