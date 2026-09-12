'use client';

import { useRef, useState, useTransition } from 'react';
import { buttonClass, cx } from '@/components/ui';
import { CopyButton } from '@/components/CopyButton';
import { createCalendarFeedAction, revokeCalendarFeedAction } from '@/lib/execution/calendar-actions';

/**
 * V9 §11 — THE CALENDAR SUBSCRIPTION, ON THE TRIP PACK.
 *
 * The address is shown once, the moment it is made: it is a secret, stored
 * only as a hash, and no later visit can show it again. What a later visit
 * can say is that a subscription exists, when it was made and when a
 * calendar last read it — and offer "Make a new address", which revokes the
 * old one in the same statement, or "Revoke", after which every copy of the
 * old address answers with nothing.
 *
 * Google Calendar needs the `https://` form (it fetches from its own
 * servers); Apple and Outlook take either, and `webcal://` opens Apple's
 * Calendar directly. Refresh is the client's decision: Apple lets you choose
 * hourly, Outlook takes hours, Google most of a day — said plainly, because a
 * traveller who edits a day and checks their phone deserves the truth about
 * when it will show.
 */
interface ActiveFeed {
  createdAt: string;
  lastServedAt: string | null;
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function CalendarSubscription({ tripId, feed }: { tripId: string; feed: ActiveFeed | null }) {
  const [active, setActive] = useState<ActiveFeed | null>(feed);
  const [url, setUrl] = useState<string | null>(null);
  const [webcal, setWebcal] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const create = () => {
    setStatus(null);
    setConfirming(false);
    startTransition(async () => {
      const result = await createCalendarFeedAction(tripId);
      if (!result.ok) {
        setStatus(result.error);
        return;
      }
      const full = result.url ?? `${window.location.origin}${result.path}`;
      setUrl(full);
      setWebcal(result.webcal ?? full.replace(/^https?:\/\//, 'webcal://'));
      setActive({ createdAt: result.createdAt, lastServedAt: null });
    });
  };

  const revoke = () => {
    if (!confirming) {
      setConfirming(true);
      setStatus(null);
      return;
    }
    startTransition(async () => {
      const result = await revokeCalendarFeedAction(tripId);
      setConfirming(false);
      if (!result.ok) {
        setStatus(result.error);
        return;
      }
      setUrl(null);
      setWebcal(null);
      setActive(null);
      setStatus('Subscription revoked. Any calendar still pointing at the old address will show nothing from its next refresh.');
    });
  };

  return (
    <div className="mt-3" data-testid="pack-feed" data-active={active ? 'true' : 'false'}>
      {url ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            readOnly
            aria-label="Calendar subscription address"
            value={url}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
            data-testid="pack-feed-url"
          />
          <CopyButton text={url} label="Copy address" testId="pack-feed-copy" />
          {webcal ? (
            <a href={webcal} className={buttonClass('ghost', 'sm')} data-testid="pack-feed-webcal">
              Open in Apple Calendar
            </a>
          ) : null}
          <p className="w-full type-small text-ink-muted">
            This address is shown once. Paste it into your calendar now; if you lose it, make a new one below and the old one stops working.
          </p>
        </div>
      ) : active ? (
        <p className="type-small text-ink" data-testid="pack-feed-active">
          A subscription exists — made {when(active.createdAt)}, last read by a calendar {when(active.lastServedAt)}. Its address was shown once; make a new one to see an address again.
        </p>
      ) : (
        <p className="type-small text-ink-muted">No subscription yet. One address, pasted into your calendar, keeps every device up to date as the plan changes.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2" data-print="never">
        <button type="button" disabled={pending} onClick={create} className={buttonClass(active ? 'secondary' : 'accent', 'sm')} data-testid="pack-feed-create">
          {pending ? 'Working…' : active ? 'Make a new address' : 'Create subscription'}
        </button>
        {active ? (
          <>
            <button type="button" disabled={pending} onClick={revoke} aria-pressed={confirming} className={buttonClass('ghost', 'sm')} data-testid="pack-feed-revoke" data-confirming={confirming ? 'true' : 'false'}>
              {confirming ? 'Press again to revoke' : 'Revoke subscription'}
            </button>
            {confirming ? (
              <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {status ? (
        <p role="status" className={cx('mt-2 w-full type-small', status.startsWith('Subscription revoked') ? 'text-ink' : 'text-clay')}>
          {status}
        </p>
      ) : null}

      <dl className="mt-4 grid gap-2 type-small sm:grid-cols-3">
        <div data-testid="pack-feed-google">
          <dt className="label">Google Calendar</dt>
          <dd className="mt-1 text-ink-muted">
            Settings → Other calendars → <em>+</em> → <em>From URL</em> → paste the <code>https://</code> address. Google refreshes about once a day.
          </dd>
        </div>
        <div data-testid="pack-feed-apple">
          <dt className="label">Apple Calendar</dt>
          <dd className="mt-1 text-ink-muted">
            File → New Calendar Subscription, paste the address, choose iCloud and an hourly refresh. On iPhone, open the <code>webcal://</code> link.
          </dd>
        </div>
        <div data-testid="pack-feed-outlook">
          <dt className="label">Outlook</dt>
          <dd className="mt-1 text-ink-muted">Calendar → Add calendar → Subscribe from web → paste the address. Outlook refreshes every few hours.</dd>
        </div>
      </dl>
    </div>
  );
}
