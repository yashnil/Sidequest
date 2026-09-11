import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authProviders } from '@/lib/auth/config';
import { safeReturnTo } from '@/lib/auth/google';
import { currentUser } from '@/lib/auth/session';
import { countUnclaimedTrips } from '@/lib/db/auth-repository';
import { sessionToken } from '@/lib/net/caller';
import { buttonClass } from '@/components/ui';
import { FixtureSignIn } from './FixtureSignIn';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in — Sidequest',
};

/**
 * THE SIGN-IN PAGE — ONE DOOR PER PROVIDER THE DEPLOYMENT HAS, AND AN HONEST
 * SENTENCE WHEN IT HAS NONE.
 *
 * V6 §21/§22. Nothing here is required to plan a trip: the anonymous flow
 * stands. Signing in is what makes trips durable across browsers and devices,
 * and what lets a party's travellers be described once and reused.
 *
 * Short on purpose. A sign-in screen is a door, not an argument — three lines
 * saying what an account is for, the doors themselves as one card with depth,
 * and one sentence for the browser that already has trips waiting.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(typeof params.returnTo === 'string' ? params.returnTo : null);
  const user = await currentUser();
  if (user) redirect(returnTo === '/signin' ? '/trips' : returnTo);
  const providers = authProviders();
  const unclaimed = countUnclaimedTrips(await sessionToken({ mint: false }));
  const failure = typeof params.error === 'string' ? params.error : null;

  return (
    <div className="mx-auto max-w-lg px-5 py-14 sm:px-8 sm:py-20" data-testid="signin-page">
      <p className="eyebrow">Your account</p>
      <h1 className="display-xl mt-3 text-ink">Keep your trips.</h1>
      <p className="mt-4 type-body text-lg text-ink-muted">
        You never need an account to plan. One keeps every trip on every device, remembers who you
        travel with, and carries what you told us into the next trip.
      </p>

      {unclaimed > 0 ? (
        <p className="card mt-6 px-4 py-3 text-sm text-ink" data-testid="signin-unclaimed">
          {unclaimed === 1 ? 'One trip on this browser' : `${unclaimed} trips on this browser`} can be
          saved to your account once you are in.
        </p>
      ) : null}

      {failure ? (
        <p className="card mt-6 border-clay/40 bg-clay-soft px-4 py-3 text-sm text-ink" role="alert">
          {FAILURE_COPY[failure] ?? 'Sign-in did not complete. Nothing was changed; try again.'}
        </p>
      ) : null}

      <div className="card-raised enter mt-8 rounded-[var(--radius-panel)] p-5 sm:p-6">
        <div className="grid gap-5">
          {providers.google ? (
            <div>
              <a
                href={`/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`}
                className={`${buttonClass('accent', 'lg')} w-full`}
                data-testid="signin-google"
              >
                Continue with Google
              </a>
              <p className="mt-2 type-small text-ink-muted">We ask Google for your name and email, and store nothing else from it.</p>
            </div>
          ) : null}

          {providers.google && providers.fixture ? (
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-rule" />
              <span className="type-meta">or</span>
              <span className="h-px flex-1 bg-rule" />
            </div>
          ) : null}

          {providers.fixture ? <FixtureSignIn returnTo={returnTo} /> : null}

          {!providers.any ? (
            <div>
              <h2 className="type-section text-ink">No sign-in here yet</h2>
              <p className="mt-2 type-body text-ink-muted">
                Trips on this deployment belong to the browser that made them. Everything works; they
                just stay on this device.
              </p>
              <Link href="/trips" className={`${buttonClass('secondary')} mt-4`}>
                Back to your trips
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const FAILURE_COPY: Record<string, string> = {
  state: 'That sign-in link had expired. Start again from this page.',
  denied: 'Google did not sign you in. Nothing was changed.',
  exchange: 'We could not confirm your identity with Google just now. Try again in a moment.',
  unavailable: 'Sign-in is not available on this deployment.',
};
