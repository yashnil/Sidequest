'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass } from '@/components/ui';
import { DELETE_ALL_CONFIRMATION } from '@/lib/data-rights/confirmation';
import { deleteTripAction } from '../actions';
import { deleteAllMyDataAction } from './actions';

/**
 * PRODUCTION PASS — "YOUR DATA": DOWNLOAD IT, DELETE A TRIP, DELETE ALL OF IT.
 *
 * Every destructive control is two steps in the flow of the page (the same
 * pattern as `TripList`): the first press turns the row into its own question
 * with real buttons, and "Delete all my data" additionally needs the phrase
 * typed, which the server checks again. After a full deletion the offline trip
 * copies this browser kept (`OfflineSnapshot`, caches named `sidequest-trip-*`)
 * are removed too, so a shared device keeps nothing.
 */
export interface DataControlTrip {
  id: string;
  title: string;
}

async function clearOfflineCopies(): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('caches' in window)) return;
    const names = await window.caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('sidequest-trip-')).map((name) => window.caches.delete(name)));
  } catch {
    /* No cache API (a private window, an old browser): nothing was stored, nothing to remove. */
  }
}

export function DataControls({ trips, signedIn }: { trips: DataControlTrip[]; signedIn: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmingTrip, setConfirmingTrip] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [phrase, setPhrase] = useState('');

  const removeTrip = (id: string) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteTripAction(id);
      if (!result.ok) {
        setError(result.error ?? 'That trip could not be deleted. Nothing was lost.');
        return;
      }
      setConfirmingTrip(null);
      setDone('Trip deleted.');
      router.refresh();
    });
  };

  const removeEverything = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteAllMyDataAction(phrase);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await clearOfflineCopies();
      setConfirmingAll(false);
      setPhrase('');
      setDone(result.account ? 'Your account and all of its data were deleted.' : `Deleted ${result.trips} trip${result.trips === 1 ? '' : 's'} and everything this browser saved.`);
      if (result.account) router.push('/');
      else router.refresh();
    });
  };

  return (
    <section id="your-data" className="card mt-6 rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="profile-data-heading" data-testid="profile-data">
      <h2 id="profile-data-heading" className="type-section text-ink">
        Your data
      </h2>
      <p className="mt-1 type-small text-ink-muted">
        {signedIn
          ? 'Everything on this account, plus any trips this browser made before you signed in.'
          : 'Everything this browser made. Without an account, your trips belong to this browser’s cookie.'}{' '}
        See the <a className="underline" href="/privacy">privacy notice</a> for what is stored and why.
      </p>

      {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
      {done ? (
        <p role="status" className="mt-3 type-small text-ink">
          {done}
        </p>
      ) : null}

      <div className="mt-4">
        <a href="/api/me/export" className={buttonClass('secondary', 'sm')} data-testid="download-my-data" download>
          Download my data (JSON)
        </a>
      </div>

      {trips.length > 0 ? (
        <ul className="mt-5 grid gap-2" aria-label="Your trips">
          {trips.map((trip) => (
            <li key={trip.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] bg-paper-sunk/60 px-3 py-2" data-testid="data-trip">
              {confirmingTrip === trip.id ? (
                <>
                  <span className="type-small text-ink">Delete <span className="font-semibold">{trip.title}</span> and everything in it? This cannot be undone.</span>
                  <span className="flex gap-2">
                    <button type="button" className={buttonClass('primary', 'sm')} disabled={pending} onClick={() => removeTrip(trip.id)}>
                      Delete this trip
                    </button>
                    <button type="button" className={buttonClass('ghost', 'sm')} disabled={pending} onClick={() => setConfirmingTrip(null)}>
                      Keep it
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate type-small text-ink">{trip.title}</span>
                  <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => { setDone(null); setConfirmingTrip(trip.id); }}>
                    Delete this trip
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 type-small text-ink-muted">No trips stored.</p>
      )}

      <div className="mt-6 border-t border-rule pt-4">
        {confirmingAll ? (
          <div className="grid gap-3" data-testid="delete-all-confirm">
            <p className="type-small text-ink">
              {signedIn
                ? 'This deletes your account, every trip on it, the people you travel with, what Sidequest learned, your share links and calendar feeds, and signs you out everywhere.'
                : 'This deletes every trip this browser made, with its share links and calendar feeds, and the people and preferences saved with them.'}{' '}
              It cannot be undone. Type <span className="font-semibold">{DELETE_ALL_CONFIRMATION}</span> to confirm.
            </p>
            <label className="grid gap-1 type-small text-ink">
              <span className="label">Confirmation</span>
              <input
                className="min-h-11 rounded-[var(--radius-card)] border border-rule bg-paper px-3"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                autoComplete="off"
                data-testid="delete-all-phrase"
              />
            </label>
            <span className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass('primary', 'sm')}
                disabled={pending || phrase.trim().toLowerCase() !== DELETE_ALL_CONFIRMATION}
                onClick={removeEverything}
                data-testid="delete-all-submit"
              >
                Delete all my data
              </button>
              <button type="button" className={buttonClass('ghost', 'sm')} disabled={pending} onClick={() => { setConfirmingAll(false); setPhrase(''); }}>
                Cancel
              </button>
            </span>
          </div>
        ) : (
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => { setDone(null); setConfirmingAll(true); }} data-testid="delete-all-start">
            {signedIn ? 'Delete my account and all my data' : 'Delete all my data'}
          </button>
        )}
      </div>
    </section>
  );
}
