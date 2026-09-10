'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorNote, FieldLabel, buttonClass, cx } from '@/components/ui';
import { fixtureSignInAction } from './actions';

const INPUT =
  'mt-1.5 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

/**
 * THE FIXTURE DOOR — AND IT SAYS SO.
 *
 * An email, no password, no message sent. Only rendered where the deployment
 * opened it; the server action refuses everywhere else. It used to look exactly
 * like the real door with a grey line under it saying "a development door",
 * which is the version somebody demonstrates to a customer by accident. It is
 * drawn as what it is instead: a dashed outline, a labelled header, and a
 * secondary button — unmistakably not the way a traveller signs in.
 */
export function FixtureSignIn({ returnTo }: { returnTo: string }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <section className="rounded-[var(--radius-card)] border border-dashed border-rule bg-paper-sunk/50 p-5" data-testid="signin-fixture">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="type-section text-ink">Sign in with an email</h2>
        <span className="rounded-full border border-amber/50 bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber">
          Development door
        </span>
      </div>
      <p className="mt-1.5 type-small text-ink-muted">No password, and no email is sent.</p>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await fixtureSignInAction({ email, ...(name ? { name } : {}), returnTo });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(result.href);
            router.refresh();
          });
        }}
      >
        <div>
          <FieldLabel htmlFor="signin-email">Email</FieldLabel>
          <input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'signin-error' : undefined}
            className={INPUT}
            data-testid="signin-email"
          />
        </div>
        <div>
          <FieldLabel htmlFor="signin-name">Name (optional)</FieldLabel>
          <input id="signin-name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} data-testid="signin-name" />
        </div>
        {error ? <ErrorNote id="signin-error">{error}</ErrorNote> : null}
        <button type="submit" disabled={pending || email.length === 0} className={cx(buttonClass('secondary'), 'justify-self-start')} data-testid="signin-submit">
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
