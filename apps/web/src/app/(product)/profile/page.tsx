import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';
import { listTravelers } from '@/lib/db/party-repository';
import { sessionToken } from '@/lib/net/caller';
import { buttonClass } from '@/components/ui';
import { ProfileForm } from './ProfileForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Travel profile — Sidequest',
};

/**
 * V6 §45 — THE PERSONAL TRAVEL PROFILE.
 *
 * What an account remembers between trips: a name, a home airport, the
 * people you usually travel with, and the usual preferences a new trip may
 * start from. Trip-specific answers always override these; nothing here is
 * applied to a trip without "Use my usual preferences" being pressed — which is
 * one sentence under the heading rather than a caveat repeated per field.
 */
export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect('/signin?returnTo=%2Fprofile');
  const travelers = listTravelers({ userId: user.id, ownerToken: await sessionToken({ mint: false }) });
  const usual = (user.profile.usual ?? {}) as { budgetStyle?: string; pace?: string; drives?: boolean; foodNotes?: string; lodgingNotes?: string };

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14" data-testid="profile-page">
      <p className="eyebrow">Your account</p>
      <h1 className="display-xl mt-3 text-ink">Travel profile</h1>
      <p className="measure mt-4 type-body text-ink-muted">
        Where a new trip starts from. Every trip can still answer differently.
      </p>

      <ProfileForm initial={{ displayName: user.displayName ?? '', homeAirport: user.homeAirport ?? '', usual }} email={user.email} />

      <section className="mt-12" aria-labelledby="profile-people">
        <h2 id="profile-people" className="type-section rule-top pt-4 text-ink">
          People you travel with
        </h2>
        {travelers.length === 0 ? (
          <p className="mt-3 type-body text-ink-muted">
            Nobody described yet. You add people from a trip’s party page, and they are remembered
            here for the next one.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {travelers.map((traveler) => (
              <li
                key={traveler.id}
                className="flex min-w-0 items-center gap-3 rounded-[var(--radius-card)] border border-rule bg-paper-raised px-4 py-3"
                data-testid="profile-traveler"
              >
                <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper-sunk font-display text-base text-ink">
                  {traveler.displayName.trim().charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{traveler.displayName}</span>
                  <span className="block type-small text-ink-muted">
                    {[traveler.relationship, traveler.needs.length > 0 ? `${traveler.needs.length} planning need${traveler.needs.length === 1 ? '' : 's'}` : null]
                      .filter(Boolean)
                      .join(' · ') || 'No planning needs noted'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-12">
        <Link href="/trips" className={buttonClass('secondary')}>
          ← Back to your trips
        </Link>
      </div>
    </div>
  );
}
