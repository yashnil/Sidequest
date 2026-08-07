'use client';

import { useFormStatus } from 'react-dom';
import { buttonClass } from './ui';

/**
 * A SUBMIT CONTROL THAT SAYS IT IS WORKING.
 *
 * `useFormStatus` can only be read from inside the form it describes, which means
 * a component, which means this one. Its own file rather than `ui.tsx` because
 * this is a client component and `ui.tsx` is not: a `'use client'` directive at
 * the top of that module would drag `Panel`, `Badge` and every layout primitive
 * in the product across the boundary with it.
 *
 * It exists because a control that reaches a provider and repaints the page some
 * seconds later, with nothing in between, is indistinguishable from a control
 * that does nothing — so people press it again, and spend a second request they
 * never intended to. The weather refresh is the sharpest case: it buys data.
 *
 * The state is **announced** as well as drawn. "The label changed" is not an
 * event anybody using a screen reader hears, so the busy label is also published
 * through a live region. `motion-reduce:transition-none` because the only motion
 * here is a colour transition and somebody who asked for less of it meant this
 * too.
 */
export function BusyFormSubmit({
  idleLabel,
  busyLabel,
  testId,
  variant = 'secondary',
}: {
  idleLabel: string;
  busyLabel: string;
  testId?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const { pending } = useFormStatus();
  return (
    <>
      <button
        type="submit"
        disabled={pending}
        aria-disabled={pending}
        className={`${buttonClass(variant, 'sm')} min-w-11 motion-reduce:transition-none`}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {pending ? busyLabel : idleLabel}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? busyLabel : ''}
      </span>
    </>
  );
}
