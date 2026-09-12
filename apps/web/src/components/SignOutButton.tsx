'use client';

import { useTransition } from 'react';
import { signOutAction } from '@/app/(product)/signin/actions';
import { clearOfflineSnapshots } from './OfflineSnapshot';

/**
 * V9 §14/§24 — signing out forgets the offline copies first. The service
 * worker caches whole trip pages for the browser that saved them; a shared
 * device must not keep somebody's itinerary readable after they leave.
 */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await clearOfflineSnapshots();
          await signOutAction();
        })
      }
      className="block w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left text-sm text-ink hover:bg-paper-sunk"
      data-testid="nav-signout"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
