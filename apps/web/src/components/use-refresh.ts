'use client';

import { useContext } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';

/**
 * V9 — A REFRESH THAT SURVIVES A RENDER WITHOUT THE APP ROUTER.
 *
 * The hub's client islands re-read the page after a server action so a booking
 * marked or an import confirmed shows at once. `useRouter` throws when no app
 * router is mounted — which is exactly how the acceptance suite renders the
 * hub to a string — so the islands read the same context `useRouter` reads and
 * refresh only when a router is there. Never a hard reload: work in flight
 * elsewhere on the page must not be thrown away (`no-hard-reload.architecture.test.ts`).
 */
export function useRefresh(): () => void {
  const router = useContext(AppRouterContext);
  return () => {
    router?.refresh();
  };
}
