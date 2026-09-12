import type { Metadata } from 'next';
import Link from 'next/link';
import { authProviders } from '@/lib/auth/config';
import { currentUser } from '@/lib/auth/session';
import { countUnclaimedTrips } from '@/lib/db/auth-repository';
import { sessionToken } from '@/lib/net/caller';
import { DASHBOARD_V3_SECTIONS, dashboardRowsFor, lastTouched } from '@/lib/trips/dashboard';
import { renderInstant } from '@/lib/clock';
import { buttonClass } from '@/components/ui';
import { ClaimBanner } from './ClaimBanner';
import { TripDashboard, type DashboardCardRow } from './TripDashboard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your trips — Sidequest',
};

/**
 * THE TRIPS HOME.
 *
 * V6 §25, V9 §21. Signed in: every trip on the account, grouped by where it
 * is in its life — traveling now, booked / getting ready, planning, ideas,
 * past, archived — as cards with
 * a picture, the dates or the timing that is still open, who is going, the
 * route, what is booked, what to do next. Signed out: this browser's trips,
 * the same way, with one quiet offer to keep them.
 *
 * "Last touched" is computed here, not in the card: the card is a client
 * component rendered on the server and again on hydration, and "3 days ago"
 * from `Date.now()` in both places is a hydration error waiting for midnight.
 * See `lastTouched` in `lib/trips/dashboard.ts`.
 */
export default async function TripsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const user = await currentUser();
  const token = await sessionToken({ mint: false });
  /* V9 — the same instant the hub judges itself against (`lib/clock`), so a card and the trip it opens never disagree about today. */
  const now = new Date(renderInstant());
  const rows: DashboardCardRow[] = dashboardRowsFor({ userId: user?.id ?? null, ownerToken: token }, now).map((row) => ({
    ...row,
    updatedLabel: lastTouched(row.updatedAt, now),
  }));
  const unclaimed = user ? countUnclaimedTrips(token) : 0;
  const providers = authProviders();
  const query = typeof params.q === 'string' ? params.q : '';
  const sort = params.sort === 'changed' ? 'changed' : 'date';
  const filter = typeof params.status === 'string' ? params.status : 'all';

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14" data-testid="trips-dashboard">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className="eyebrow">{user ? (user.displayName ? `${user.displayName}’s trips` : 'Your trips') : 'Trips on this browser'}</p>
          <h1 className="display-hero mt-3 text-ink">Where next?</h1>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link href="/decide" className={buttonClass('secondary')}>
            Help me decide
          </Link>
          <Link href="/trips/new" className={buttonClass('accent')} data-testid="dashboard-new-trip">
            New trip
          </Link>
        </div>
      </div>

      {user && unclaimed > 0 ? <ClaimBanner count={unclaimed} /> : null}
      {!user && providers.any && rows.length > 0 ? (
        <p className="mt-6 type-body text-ink-muted" data-testid="dashboard-signin-offer">
          These trips live on this browser.{' '}
          <Link href="/signin?returnTo=%2Ftrips" className="text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2">
            Sign in
          </Link>{' '}
          to keep them on every device.
        </p>
      ) : null}

      <TripDashboard rows={rows} sections={DASHBOARD_V3_SECTIONS} query={query} sort={sort} filter={filter} signedIn={Boolean(user)} />
    </div>
  );
}
