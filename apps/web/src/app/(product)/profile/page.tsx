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
 *
 * V8 — sections are cards, and the people you travel with are person cards:
 * a portrait disc in the display face, the name, and what the planner has to
 * account for — never a diagnosis, only its planning consequence.
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
      <p className="measure mt-4 type-body text-ink-muted">Where a new trip starts from. Every trip can still answer differently.</p>

      <ProfileForm initial={{ displayName: user.displayName ?? '', homeAirport: user.homeAirport ?? '', usual }} email={user.email} />

      <section className="card mt-6 rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="profile-people">
        <h2 id="profile-people" className="type-section text-ink">
          People you travel with
        </h2>
        <p className="mt-1 type-small text-ink-muted">Described once, from a trip’s party page, and remembered here for the next one.</p>
        {travelers.length === 0 ? (
          <p className="mt-4 type-body text-ink-muted">Nobody described yet.</p>
        ) : (
          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {travelers.map((traveler) => {
              const needs = traveler.needs.length;
              const detail = [traveler.relationship, needs > 0 ? `${needs} planning need${needs === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'No planning needs noted';
              return (
                <li key={traveler.id} className="card lift flex min-w-0 items-center gap-3.5 rounded-[var(--radius-card)] px-4 py-3.5" data-testid="profile-traveler">
                  <span aria-hidden="true" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-paper-sunk font-display text-xl text-ink shadow-[inset_0_0_0_1px_var(--color-rule)]">
                    {traveler.displayName.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-display text-lg leading-tight text-ink">{traveler.displayName}</span>
                    <span className="mt-0.5 block type-small text-ink-muted">{detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mt-10">
        <Link href="/trips" className={buttonClass('secondary')}>
          ← Back to your trips
        </Link>
      </div>
    </div>
  );
}
