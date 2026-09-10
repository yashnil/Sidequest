'use client';

import { useTransition } from 'react';
import { signOutAction } from '@/app/(product)/signin/actions';

export function SignOutButton() {
  const [pending, startTransition] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => startTransition(() => signOutAction())} className="block w-full rounded-[var(--radius-control)] px-2 py-1.5 text-left text-sm text-ink hover:bg-paper-sunk" data-testid="nav-signout">
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
