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
import { ATLAS_TOURS } from '@/components/landing/atlas-tours';
import { plateRoute, smoothPath } from '@/components/dashboard/stage-model';

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

  const benefits = (
    <ol className="ruled-night m-0 list-none p-0" aria-label="What an account adds">
      {SIGNIN_BENEFITS.map((benefit, index) => (
        <li key={benefit.text} className="fade-up flex items-baseline gap-4 py-3.5" style={{ ['--d' as string]: `${260 + index * 90}ms` }}>
          <span aria-hidden="true" className="font-mono text-xs text-[var(--color-flare)]">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="font-display text-lg leading-snug text-[var(--color-atlas-ink)]">{benefit.text}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="grid min-h-[calc(100svh-var(--chrome-height))] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]" data-testid="signin-page">
      {/*
        2026-11 — the account door on the front page's night. It was a centred
        card with icon tiles on a pale page: the one screen between the landing
        hero and the trips home, and the one that looked like somebody else's
        product. The night side carries the brand (an example shape drawing
        itself, the three reasons as a ruled list); the door stays plain.
      */}
      <section className="night-stage flex flex-col justify-between px-5 pt-10 pb-8 sm:px-10 sm:pt-14 lg:px-14 lg:pt-20 lg:pb-12" data-chrome-tone="night" aria-labelledby="signin-heading">
        <div className="max-w-xl">
          <p className="sheet-label rise-in text-[var(--color-glacier)]">Your account</p>
          <h1 id="signin-heading" className="mt-4 font-display text-[clamp(2.9rem,1.9rem+4.4vw,6rem)] leading-[0.9] font-[360] tracking-[-0.045em] text-[var(--color-atlas-ink)]">
            <span className="mask-rise">
              <span style={{ ['--d' as string]: '60ms' }}>Keep every</span>
            </span>{' '}
            <span className="mask-rise pr-[0.12em] pb-[0.1em]">
              <span style={{ ['--d' as string]: '200ms' }}>
                <em className="font-[300] text-[var(--color-flare)]">detour.</em>
              </span>
            </span>
          </h1>
          <p className="rise-in mt-5 max-w-md text-base leading-relaxed text-[var(--color-atlas-muted)] sm:text-lg" style={{ ['--d' as string]: '80ms' }}>
            You never need an account to plan. One keeps what you plan.
          </p>
          <div className="mt-8 hidden max-w-md lg:block">{benefits}</div>
        </div>
        <SignInShape />
      </section>

      <section className="flex flex-col justify-center px-5 py-10 sm:px-10 lg:px-14" aria-label="Sign in">
        <div className="mx-auto w-full max-w-md">
          {unclaimed > 0 ? (
            <p className="mb-6 border-l-2 border-[var(--color-flare)] pl-4 text-sm text-ink" data-testid="signin-unclaimed">
              {unclaimed === 1 ? 'One trip on this browser' : `${unclaimed} trips on this browser`} can be
              saved to your account once you are in.
            </p>
          ) : null}

          {failure ? (
            <p className="card mb-6 border-clay/40 bg-clay-soft px-4 py-3 text-sm text-ink" role="alert">
              {FAILURE_COPY[failure] ?? 'Sign-in did not complete. Nothing was changed; try again.'}
            </p>
          ) : null}

          <p className="sheet-label text-ink-muted">Sign in</p>
          <div className="enter mt-4 grid gap-6">
            {providers.google ? (
              <div>
                <a
                  href={`/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`}
                  className={`${buttonClass('accent', 'lg')} w-full gap-3`}
                  data-testid="signin-google"
                >
                  <GoogleG />
                  Continue with Google
                </a>
                <p className="mt-2.5 type-small text-ink-muted">We ask Google for your name and email, and store nothing else from it.</p>
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
          <div className="mt-10 rounded-[var(--radius-panel)] bg-[var(--color-night)] px-5 py-1 lg:hidden">{benefits}</div>
        </div>
      </section>
    </div>
  );
}

/** The front page's first example, drawing itself along the foot of the night side. Labelled an example; the line is an order, not a road. */
function SignInShape() {
  const tour = ATLAS_TOURS[0]!;
  const points = plateRoute(tour.stops, { width: 520, height: 220, pad: 28 });
  const d = smoothPath([...points, points[0]!]);
  return (
    <figure className="m-0 mt-10 hidden max-w-xl sm:block" aria-label={`Example shape: ${tour.prompt}`}>
      <svg viewBox="0 0 520 220" className="block h-auto w-full" aria-hidden="true">
        <path d={d} pathLength={1} fill="none" stroke="var(--color-flare)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="route-draw" />
        {points.map((p, i) => (
          <g key={tour.stops[i]!.name} className="fade-up" style={{ ['--d' as string]: `${600 + i * 180}ms` }}>
            <circle cx={p.x} cy={p.y} r={4} fill="var(--color-flare)" stroke="var(--color-night)" strokeWidth={1.5} />
            <text x={p.x > 360 ? p.x - 10 : p.x + 10} y={p.y + 3.5} textAnchor={p.x > 360 ? 'end' : 'start'} fontFamily="var(--font-mono)" fontSize={9.5} letterSpacing={1.2} fill="rgb(241 235 223 / 0.7)">
              {tour.stops[i]!.name.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="coordbar mt-2 text-[var(--color-atlas-muted)]">
        Example shape · {tour.prompt} · {tour.days} days
      </figcaption>
    </figure>
  );
}

/** Google's mark, as its brand guidelines draw it, on a white disc so it reads on the flare button. */
function GoogleG() {
  return (
    <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white">
      <svg viewBox="0 0 48 48" className="h-4 w-4">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    </span>
  );
}

const SIGNIN_BENEFITS = [
  { text: 'Every trip, on every device' },
  { text: 'The people you travel with, remembered' },
  { text: 'Your usual preferences, ready for the next trip' },
] as const;

const FAILURE_COPY: Record<string, string> = {
  state: 'That sign-in link had expired or was started in another browser. Start again from this page.',
  busy: 'Too many sign-in attempts from here just now. Wait a minute and start again.',
  denied: 'Google did not sign you in. Nothing was changed.',
  exchange: 'We could not confirm your identity with Google just now. Try again in a moment.',
  unavailable: 'Sign-in is not available on this deployment.',
};
