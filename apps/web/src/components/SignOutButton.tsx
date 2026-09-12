'use client';

import { useTransition } from 'react';
import { signOutAction } from '@/app/(product)/signin/actions';
import { clearOfflineSnapshots } from './OfflineSnapshot';

/**
 * V9 §14/§24 — signing out forgets the offline copies first. The service
 * worker caches whole trip pages for the browser that saved them; a shared
 * device must not keep somebody's itinerary readable after they leave.
 *
 * V9.1 §8 — the order is a function of its own so a test can prove it: the
 * caches and the "saved" markers go first, and a failure there never keeps
 * the traveller signed in — leaving is the one thing that must always work.
 */
export interface SignOutSequence {
  clear: () => Promise<void>;
  signOut: () => Promise<void>;
}

/** Forget the offline copies, then sign out. A clearing failure is swallowed; the sign-out is not. */
export async function signOutAfterClearing(deps: SignOutSequence = { clear: clearOfflineSnapshots, signOut: signOutAction }): Promise<void> {
  try {
    await deps.clear();
  } catch {
    /* Nothing to forget, or no cache access: leaving still happens. */
  }
  await deps.signOut();
}

export function SignOutButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending}
      onClick={() => startTransition(() => signOutAfterClearing())}
      className="block w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left text-sm text-ink hover:bg-paper-sunk"
      data-testid="nav-signout"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
