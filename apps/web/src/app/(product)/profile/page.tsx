import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DIETARY_NEED_LABELS, FUNCTIONAL_NEED_LABELS, dietaryRulesOf, learnedHints } from '@sidequest/core';
import { currentUser } from '@/lib/auth/session';
import { listTravelers } from '@/lib/db/party-repository';
import { learnedWithDismissals } from '@/lib/db/preference-evidence-repository';
import { sessionToken } from '@/lib/net/caller';
import { buttonClass } from '@/components/ui';
import { LearnedPreferences, type LearnedRow } from './LearnedPreferences';
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
 *
 * V9 §18 — two more cards. "You told Sidequest" is the hard facts: the usual
 * preferences above and every travelling companion's rules (a diet, a need),
 * shown as what they are — the traveller's own words, binding. "Sidequest
 * noticed" is the other kind of knowledge: leanings learned from what the
 * account did on earlier trips, medium confidence or better, each with the
 * sentence the next brief would read and a Dismiss that keeps it out of every
 * brief from then on.
 */
const USUAL_LABELS: Record<string, string> = { budgetStyle: 'Usual budget', pace: 'Usual pace', foodNotes: 'Food, in your words', lodgingNotes: 'Where you like to stay' };

function toldRows(usual: Record<string, unknown>, travelers: ReturnType<typeof listTravelers>): { label: string; value: string; kind: 'usual' | 'rule' }[] {
  const rows: { label: string; value: string; kind: 'usual' | 'rule' }[] = [];
  for (const [key, label] of Object.entries(USUAL_LABELS)) {
    const value = usual[key];
    if (typeof value === 'string' && value.trim()) rows.push({ label, value: value.trim().replace(/_/g, ' '), kind: 'usual' });
  }
  if (typeof usual.drives === 'boolean') rows.push({ label: 'Driving', value: usual.drives ? 'Happy to drive' : 'Prefers not to drive', kind: 'usual' });
  for (const traveler of travelers) {
    const rules = dietaryRulesOf(traveler.diet, DIETARY_NEED_LABELS);
    for (const rule of rules) rows.push({ label: traveler.displayName, value: `${rule.label}${rule.strict ? ' — a cannot, not a would-rather-not' : ''}`, kind: 'rule' });
    for (const need of traveler.needs) rows.push({ label: traveler.displayName, value: FUNCTIONAL_NEED_LABELS[need], kind: 'rule' });
  }
  return rows;
}

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect('/signin?returnTo=%2Fprofile');
  const travelers = listTravelers({ userId: user.id, ownerToken: await sessionToken({ mint: false }) });
  const usual = (user.profile.usual ?? {}) as { budgetStyle?: string; pace?: string; drives?: boolean; foodNotes?: string; lodgingNotes?: string };
  const told = toldRows(usual as Record<string, unknown>, travelers);
  const noticed = learnedWithDismissals({ userId: user.id, ownerToken: null });
  const dismissed = new Set(noticed.dismissed);
  const learnedRows: LearnedRow[] = noticed.learned
    .filter((p): p is typeof p & { band: 'medium' | 'high' } => p.band !== 'low')
    .map((p) => ({ feature: p.feature, sentence: learnedHints([p], 1)[0] ?? p.feature, band: p.band, weight: p.weight, dismissed: dismissed.has(p.feature) }));

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

      <section className="card mt-6 rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="profile-told-heading" data-testid="profile-told">
        <h2 id="profile-told-heading" className="type-section text-ink">
          You told Sidequest
        </h2>
        <p className="mt-1 type-small text-ink-muted">Your own words. A companion’s rule is the group’s rule, and nothing here is ever guessed.</p>
        {told.length === 0 ? (
          <p className="mt-4 type-body text-ink-muted">Nothing on record yet. The usual preferences above and each person’s needs appear here once they are saved.</p>
        ) : (
          <dl className="mt-4 grid gap-2 sm:grid-cols-2">
            {told.map((row, index) => (
              <div key={`${row.label}-${index}`} className="flex min-w-0 flex-wrap gap-x-2 rounded-[var(--radius-card)] bg-paper-sunk/60 px-3 py-2" data-testid="profile-told-row" data-kind={row.kind}>
                <dt className="type-small font-medium text-ink">{row.label}</dt>
                <dd className="type-small text-ink-muted">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="card mt-6 rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="profile-noticed-heading" data-testid="profile-noticed">
        <h2 id="profile-noticed-heading" className="type-section text-ink">
          Sidequest noticed
        </h2>
        <p className="mt-1 type-small text-ink-muted">Leanings from what you chose and changed on earlier trips. Each one nudges the next plan and can be traded away; dismiss it and it is never read again.</p>
        <LearnedPreferences rows={learnedRows} />
      </section>

      <div className="mt-10">
        <Link href="/trips" className={buttonClass('secondary')}>
          ← Back to your trips
        </Link>
      </div>
    </div>
  );
}
