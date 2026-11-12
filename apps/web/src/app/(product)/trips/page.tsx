import type { Metadata } from 'next';
import Link from 'next/link';
import { authProviders } from '@/lib/auth/config';
import { currentUser } from '@/lib/auth/session';
import { countUnclaimedTrips } from '@/lib/db/auth-repository';
import { sessionToken } from '@/lib/net/caller';
import { DASHBOARD_V3_SECTIONS, dashboardRowsFor, lastTouched } from '@/lib/trips/dashboard';
import { renderInstant } from '@/lib/clock';
import { ClaimBanner } from './ClaimBanner';
import { CollectionDashboard } from '@/components/collection/CollectionDashboard';
import { catalogueNumbers, countdown, coverTrip } from '@/components/collection/stamp-geometry';
import { DashboardStage } from '@/components/dashboard/DashboardStage';
import { ExampleShapes } from '@/components/dashboard/ExampleShapes';
import type { AtlasTrip } from '@/components/dashboard/YourAtlas';
import { greetingName } from '@/components/dashboard/stage-model';
import { resolveVectorBasemap } from '@/components/map-adapter';
import type { DashboardCardRow } from './TripCard';

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
 *
 * SURVEY ATLAS (2026-10) — the page is a collection now (`CollectionDashboard`):
 * the next trip as a cover, every trip as a numbered, stamped entry. The
 * behaviour, the sections and every test id are `TripDashboard`'s.
 *
 * VISUAL CONTINUITY (2026-11) — the page opens on the front page's night
 * (`DashboardStage`): a greeting, the globe or your atlas, and the cover; the
 * collection follows on paper. With nothing yet, example shapes follow instead.
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

  const today = now.toISOString().slice(0, 10);
  const numbers = catalogueNumbers(rows);
  const cover = rows.length >= 2 ? coverTrip(rows, today) : null;
  const next = rows.map((row) => countdown(row, today)).filter((c): c is { kind: 'until'; days: number } => c.kind === 'until').sort((a, b) => a.days - b.days)[0];
  const atlas: AtlasTrip[] = rows
    .filter((row) => row.lifecycle !== 'archived')
    .map((row) => {
      const at = row.shape?.center ?? row.shape?.bases[0] ?? null;
      return at ? { id: row.id, title: row.title, href: row.href, lat: at.lat, lng: at.lng, catalogue: numbers.get(row.id) ?? 0, upNext: row.id === cover?.id, past: row.lifecycle === 'past' } : null;
    })
    .filter((trip): trip is AtlasTrip => trip !== null);

  return (
    <div data-testid="trips-dashboard">
      <DashboardStage
        name={greetingName(user?.displayName)}
        rows={rows}
        atlas={atlas}
        cover={cover}
        coverCatalogue={cover ? (numbers.get(cover.id) ?? 1) : 1}
        nextInDays={next ? next.days : null}
        today={today}
        globe={resolveVectorBasemap(process.env) !== null}
        signedIn={Boolean(user)}
      />
      {rows.length === 0 ? (
        <>
          {user && unclaimed > 0 ? (
            <div className="mx-auto max-w-7xl px-5 sm:px-8">
              <ClaimBanner count={unclaimed} />
            </div>
          ) : null}
          <ExampleShapes />
        </>
      ) : (
        <div className="mx-auto max-w-7xl px-5 pb-14 sm:px-8">
          {user && unclaimed > 0 ? <ClaimBanner count={unclaimed} /> : null}
          {!user && providers.any ? (
            <p className="mt-6 type-body text-ink-muted" data-testid="dashboard-signin-offer">
              These trips live on this browser.{' '}
              <Link href="/signin?returnTo=%2Ftrips" className="text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2">
                Sign in
              </Link>{' '}
              to keep them on every device.
            </p>
          ) : null}
          <CollectionDashboard rows={rows} sections={DASHBOARD_V3_SECTIONS} query={query} sort={sort} filter={filter} coverId={cover?.id ?? null} today={today} />
        </div>
      )}
    </div>
  );
}
