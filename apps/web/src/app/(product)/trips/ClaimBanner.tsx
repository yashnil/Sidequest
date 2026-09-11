'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass } from '@/components/ui';
import { claimBrowserTripsAction } from '../signin/actions';

/**
 * "Save your trips to your account" — one press, this browser's unclaimed trips
 * only.
 *
 * A warm offer, not an alert. It sat in the accent band with a filled button,
 * which is the shape this product uses for *problems* — and nothing here is a
 * problem: the trips are safe, they are simply on one device. So it is a quiet
 * card with a single sentence and one press, and it disappears for good the
 * moment there is nothing left to offer.
 */
export function ClaimBanner({ count }: { count: number }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (done !== null) {
    return (
      <p className="card mt-6 flex items-center gap-2.5 border-pine/40 bg-pine-soft px-4 py-3 text-sm text-pine-strong" data-testid="claim-done">
        <span aria-hidden="true">✓</span>
        {done === 1 ? 'One trip is' : `${done} trips are`} now saved to your account.
      </p>
    );
  }
  return (
    <div className="card mt-6 flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-3 px-4 py-3.5 sm:px-5" data-testid="claim-banner">
      <p className="min-w-0 text-sm leading-relaxed text-ink">
        {/* The e2e proof matches on this sentence; keep the words if you move them. */}
        This browser made {count === 1 ? 'a trip' : `${count} trips`} before you signed in. Keep{' '}
        {count === 1 ? 'it' : 'them'} on your account and {count === 1 ? 'it' : 'they'} will follow
        you to every device.
      </p>
      <button
        type="button"
        className={buttonClass('primary', 'sm')}
        disabled={pending}
        data-testid="claim-trips"
        onClick={() =>
          startTransition(async () => {
            const result = await claimBrowserTripsAction();
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setDone(result.trips);
            router.refresh();
          })
        }
      >
        {pending ? 'Saving…' : 'Save to my account'}
      </button>
      {error ? (
        <div className="w-full">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
    </div>
  );
}
