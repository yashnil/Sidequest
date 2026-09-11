'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { startTransition, useEffect, useMemo, useRef } from 'react';
import { buttonClass } from './ui';

/**
 * V8 §1.1 / §1.8 / §1.9 — WHAT A TRAVELLER SEES WHEN A PAGE BREAKS.
 *
 * One component behind every route boundary, so the promises are the same
 * everywhere and each is behaviourally true:
 *
 * - **"Retry this page" re-fetches the same logical state.** Next 16's
 *   `retry()` re-fetches and re-renders the boundary's children; the older
 *   `reset()` re-rendered them *from the props the page first loaded with*,
 *   which is how "Try again" on the questionnaire showed a traveller an
 *   unanswered interview over fourteen saved answers
 *   (`.claude-private/V8-BUILD-FAILURE.md`). Where `retry` is not provided the
 *   refresh is made explicit before the reset. Nothing here creates a trip,
 *   resets an interview, clears a timing or calls a model.
 * - **"Return to …" goes to the point in the journey this screen belongs to**,
 *   never a generic "Try again" with different meanings on different screens.
 * - **Every failure has a short opaque reference tied to a structured server
 *   log line.** A server-rendered fault carries Next's digest; a browser fault
 *   gets a reference minted here and reported by beacon, best-effort, so the
 *   reference on screen always points at something.
 *
 * Named fields only in the console: the error object carries whatever threw
 * it, which for a provider failure includes the outbound request.
 */
export function RouteFailure({
  error,
  reset,
  retry,
  eyebrow,
  heading,
  preserved,
  detail,
  secondary,
  route,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
  eyebrow: string;
  heading: string;
  /** What is safe, first: the sentence a traveller needs before they read anything else. */
  preserved: string;
  /** Optional second sentence about what this page does and does not do. */
  detail?: string;
  /** Where the journey continues from here. */
  secondary: { href: string; label: string };
  /** A short name for the log line. */
  route: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reference = useMemo(() => error.digest ?? mintReference(), [error]);

  /*
   * Focus follows the content. A boundary swaps the page without changing the
   * URL, so a keyboard user is otherwise left on a control that no longer
   * exists and a screen-reader user is told nothing happened. `focus:` rather
   * than `focus-visible:` on the heading because this focus arrives from
   * script, which the browser's heuristic declines to ring.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    console.error(`${route} route failed`, { ref: reference, name: error.name, message: error.message.slice(0, 200), ...(error.digest ? { digest: error.digest } : {}) });
    if (error.digest) return; /* the server already has this one under its digest */
    try {
      const body = JSON.stringify({ ref: reference, route: pathname ?? route, name: error.name, message: error.message.slice(0, 200) });
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') navigator.sendBeacon('/api/client-failure', new Blob([body], { type: 'application/json' }));
      else void fetch('/api/client-failure', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined);
    } catch {
      /* reporting is best-effort */
    }
  }, [error, reference, route, pathname]);

  function retryThisPage() {
    if (retry) {
      retry();
      return;
    }
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-16 sm:px-8" data-testid="route-failure" data-route={route}>
      <p className="eyebrow">{eyebrow}</p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-3 rounded-sm font-display text-3xl leading-tight text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2 sm:text-4xl"
      >
        {heading}
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-ink" data-testid="route-failure-preserved">
        {preserved}
      </p>
      {detail ? <p className="mt-3 leading-relaxed text-ink-muted">{detail}</p> : null}
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" onClick={retryThisPage} className={buttonClass('primary', 'lg')} data-testid="route-failure-retry">
          Retry this page
        </button>
        <Link href={secondary.href} className={buttonClass('secondary', 'lg')} data-testid="route-failure-return">
          {secondary.label}
        </Link>
      </div>
      <p className="mt-10 type-small text-ink-faint" data-testid="route-failure-ref">
        If it keeps happening, quote this reference: <span className="font-mono text-ink-muted">{reference}</span>
      </p>
    </div>
  );
}

function mintReference(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

/** The trip a pathname is inside, when it is: the boundary's way back to the review. */
export function tripIdFromPath(pathname: string | null): string | null {
  const match = /^\/trips\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(pathname ?? '');
  return match && match[1] !== 'new' ? match[1]! : null;
}
