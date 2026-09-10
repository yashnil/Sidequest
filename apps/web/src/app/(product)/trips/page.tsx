import type { Metadata } from 'next';
import Link from 'next/link';
import { DASHBOARD_SECTIONS } from '@sidequest/core';
import { authProviders } from '@/lib/auth/config';
import { currentUser } from '@/lib/auth/session';
import { countUnclaimedTrips } from '@/lib/db/auth-repository';
import { sessionToken } from '@/lib/net/caller';
import { dashboardRowsFor } from '@/lib/trips/dashboard';
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
 * V6 §25. Signed in: every trip on the account, grouped by where it is in
 * its life — up next, booked, planning, ideas, past, archived — as cards with
 * a picture, the dates or the timing that is still open, who is going, the
 * route, what is booked, what to do next. Signed out: this browser's trips,
 * the same way, with one quiet offer to keep them.
 *
 * ## "Last touched" is computed here, not in the card
 *
 * The card is a client component and is rendered twice: once on the server and
 * once when React hydrates. "3 days ago" computed from `Date.now()` in both
 * places is two different strings whenever a render straddles a boundary, and
 * React reports that as a hydration error rather than a rounding one. Computing
 * it once, on the server, and sending the finished words down means both renders
 * agree by construction.
 */
export default async function TripsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const user = await currentUser();
  const token = await sessionToken({ mint: false });
  const now = new Date();
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
          <Link href="/trips/new" className={buttonClass('primary')} data-testid="dashboard-new-trip">
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

      <TripDashboard rows={rows} sections={DASHBOARD_SECTIONS} query={query} sort={sort} filter={filter} signedIn={Boolean(user)} />
    </div>
  );
}

/**
 * When a trip was last touched, in the words a person would use.
 *
 * Deliberately coarse. A timestamp to the minute is a database field; what a
 * traveller wants to know is whether this is the thing they were working on
 * yesterday or something they started in the spring.
 */
function lastTouched(updatedAt: string, now: Date): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return 'Saved';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 7) return `Updated ${days} days ago`;
  if (days < 14) return 'Updated last week';
  if (days < 60) return `Updated ${Math.round(days / 7)} weeks ago`;
  return `Updated ${Math.round(days / 30)} months ago`;
}
