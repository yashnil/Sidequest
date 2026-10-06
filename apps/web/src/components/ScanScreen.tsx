'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ErrorNote, buttonClass, cx } from './ui';
import { callAction, newBuildKey } from './client-action';
import type { TravellerScanView } from '@/lib/discovery-scan/view';
import { startDiscoveryScanAction } from '@/app/(product)/trips/[id]/discover/scan-actions';
import { retryBuildAction } from '@/app/(product)/trips/[id]/questionnaire/actions';
import { formatElapsed } from '@/lib/build-progress/placed-projection';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN, AS THE STEP BETWEEN THE INTERVIEW AND THE BOARD.
 *
 * Shown on `/trips/[id]/discover` while the trip has no board yet. Before a
 * scan: one clear primary action, "Find places for my trip". While one runs:
 * the real stage in words, the stages already passed, the latest real count
 * ("Proposed 32 places that fit you · Placed 27 of them on the map"), and the
 * elapsed time — no percentage, because nobody knows how long a search will
 * take. Polls a GET route (`/api/trips/[id]/scan`), never a server action, so
 * the poll never queues behind other work. When the scan is ready the page is
 * refreshed in place and the board renders; when the traveller asked for the
 * build to follow ("Plan with smart defaults"), the screen follows the build
 * instead. A failure says what happened in the traveller's terms, what is
 * kept, and whether trying again can help — with a reference, never a cause.
 */

const POLL_MS = 1_500;
/** How long a ready scan may wait for the build it asked for before the board is shown instead. */
const AUTO_BUILD_GRACE_MS = 20_000;

export function ScanScreen({
  tripId,
  destination,
  initial,
  unavailable = null,
  canBuildWithoutBoard = false,
}: {
  tripId: string;
  destination: string;
  initial: TravellerScanView;
  /** Set when no scan can run on this deployment right now; the button is disabled with this sentence beside it. */
  unavailable?: { heading: string; message: string } | null;
  /** Whether the model-composed fallback can build this trip without a board (a composer is configured). */
  canBuildWithoutBoard?: boolean;
}) {
  const router = useRouter();
  /* The view, and when this client received it, so the elapsed figure can tick between polls from the server's own count. */
  const [received, setReceived] = useState<{ view: TravellerScanView; at: number }>(() => ({ view: initial, at: Date.now() }));
  const view = received.view;
  const setView = (next: TravellerScanView) => setReceived({ view: next, at: Date.now() });
  const [clock, setClock] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /* A new scan bumps this, so the poll restarts on the new row. */
  const [watching, setWatching] = useState(initial.state === 'running' || (initial.state === 'ready' && initial.autoBuildPending) ? 1 : 0);
  const leaving = useRef(false);
  const buildKey = useRef<string | null>(null);
  const readySince = useRef<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const running = view.state === 'running';

  /* The elapsed figure ticks locally between polls, anchored on the server's count. */
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = view.elapsedSeconds + Math.max(0, Math.floor((clock - received.at) / 1000));

  useEffect(() => {
    if (watching === 0) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      const next = await fetch(`/api/trips/${encodeURIComponent(tripId)}/scan`, { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<TravellerScanView>) : null))
        .catch(() => null);
      if (stopped) return;
      if (next) setView(next);
      if (next?.state === 'ready') {
        if (next.autoBuildStarted) {
          if (!leaving.current) {
            leaving.current = true;
            router.push(`/trips/${tripId}/build`);
          }
          return;
        }
        readySince.current ??= Date.now();
        const stillWaiting = next.autoBuildPending && Date.now() - readySince.current < AUTO_BUILD_GRACE_MS;
        if (!stillWaiting) {
          if (!leaving.current) {
            leaving.current = true;
            router.refresh();
          }
          return;
        }
      }
      if (next?.state === 'failed' || next?.state === 'lost') {
        headingRef.current?.focus({ preventScroll: true });
        return;
      }
      timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), 600);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [tripId, router, watching]);

  function startScan() {
    setError(null);
    startTransition(async () => {
      const outcome = await callAction(() => startDiscoveryScanAction(tripId, { autoBuild: false }));
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      const result = outcome.value;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      leaving.current = false;
      readySince.current = null;
      setView(result.view);
      setWatching((n) => n + 1);
    });
  }

  function buildWithoutBoard() {
    setError(null);
    buildKey.current ??= newBuildKey();
    const key = buildKey.current;
    startTransition(async () => {
      const outcome = await callAction(() => retryBuildAction(tripId, key));
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      if (!outcome.value.ok) {
        setError(outcome.value.error);
        return;
      }
      router.push(`/trips/${tripId}/build`);
    });
  }

  const failure = view.failure;
  const latest = view.lines[view.lines.length - 1] ?? null;
  const currentIndex = view.stage ? view.stages.findIndex((stage) => stage.id === view.stage) : -1;
  /* A scan that reads ready on the first paint but has no board behind it is offered again rather than looped on. */
  const idle = !running && (view.state !== 'ready' || watching === 0);

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14" data-testid="scan-screen" data-state={view.state}>
      <p className="label text-accent">Discovery board</p>

      {running || (view.state === 'ready' && !idle) ? (
        <section aria-labelledby="scan-heading" className="mt-3">
          <p className="type-small text-ink-muted">Finding places for {destination}</p>
          {/* One polite live region: the stage name and the newest real count, so a screen reader hears each change once. */}
          <div role="status" aria-live="polite" aria-atomic="true">
            <h1 id="scan-heading" ref={headingRef} tabIndex={-1} className="display-xl mt-2 text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2" data-testid="scan-stage">
              {view.state === 'ready' ? (view.autoBuildPending || view.autoBuildStarted ? 'Your board is ready — building your trip' : 'Your board is ready') : (view.label ?? 'Starting the search')}
            </h1>
            {latest ? (
              <p className="mt-4 text-base text-ink" data-testid="scan-latest">
                {latest}
              </p>
            ) : null}
          </div>

          <ol className="relative mt-8" aria-label="Stages">
            {view.stages.map((stage, index) => {
              const done = view.state === 'ready' || (currentIndex >= 0 && index < currentIndex);
              const now = running && index === currentIndex;
              const last = index === view.stages.length - 1;
              return (
                <li key={stage.id} className={cx('relative flex items-start gap-3.5', !last && 'pb-4')} aria-current={now ? 'step' : undefined} data-done={done ? 'true' : 'false'}>
                  {!last ? <span aria-hidden="true" className={cx('absolute left-[11px] top-6 bottom-0 w-0.5 rounded-full', done ? 'bg-pine' : 'bg-rule')} /> : null}
                  <span aria-hidden="true" className={cx('relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2', done ? 'border-pine bg-pine text-paper' : now ? 'border-pine bg-paper' : 'border-rule bg-paper')}>
                    {done ? (
                      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    ) : now ? (
                      <span className="breathing h-2 w-2 rounded-full bg-pine" />
                    ) : null}
                  </span>
                  <span className={cx('pt-0.5 text-sm leading-5', done || now ? 'text-ink' : 'text-ink-muted', now && 'font-semibold')}>{stage.label}</span>
                </li>
              );
            })}
          </ol>

          {view.lines.length > 1 ? (
            <p className="mt-6 type-small text-ink-muted" data-testid="scan-counts">
              {view.lines.join(' · ')}
            </p>
          ) : null}

          <p className="mt-6 type-small text-ink-muted" data-testid="scan-elapsed">
            <span className="type-figure text-base text-ink">{formatElapsed(running ? elapsed : view.elapsedSeconds)}</span> elapsed · usually a minute or two. The search carries on if you leave this page; your answers are saved either way.
          </p>
          {view.autoBuildPending ? (
            <p className="mt-2 type-small text-ink-muted" data-testid="scan-auto-build-note">
              You asked Sidequest to plan with smart defaults, so it will build your trip from its own picks as soon as the board is ready.
            </p>
          ) : null}
        </section>
      ) : (
        <section aria-labelledby="scan-heading" className="mt-3">
          {failure ? (
            <div role="alert" data-testid="scan-failure" data-kind={failure.kind} data-retryable={failure.retryable ? 'true' : 'false'}>
              <h1 id="scan-heading" ref={headingRef} tabIndex={-1} className="display-xl mt-2 text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2">
                {failure.heading}
              </h1>
              <p className="mt-4 max-w-[60ch] type-body text-ink" data-testid="scan-failure-message">
                {failure.message}
              </p>
              {failure.ref ? (
                <p className="mt-3 type-small text-ink-muted" data-testid="scan-failure-ref">
                  If it keeps happening, quote this reference: <span className="font-mono text-ink">{failure.ref}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <h1 id="scan-heading" ref={headingRef} tabIndex={-1} className="display-xl mt-2 text-ink focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2">
                Find places for {destination}
              </h1>
              <p className="mt-4 max-w-[60ch] type-body text-ink-muted" data-testid="scan-intro">
                Sidequest searches {destination} for places that fit how you travel — the classics and the quieter finds — puts each one on the map and times the distances between them. Your Discovery Board opens with Sidequest’s picks already ticked; keep them, change them, then build your trip from what you chose.
              </p>
            </>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {!failure || failure.retryable ? (
              <button type="button" onClick={startScan} disabled={pending || Boolean(unavailable)} aria-describedby={unavailable ? 'scan-unavailable-note' : undefined} className={buttonClass('accent', 'lg')} data-testid="scan-start">
                {pending ? 'Starting…' : failure ? 'Search again' : 'Find places for my trip'}
              </button>
            ) : null}
            {canBuildWithoutBoard && (failure || unavailable) ? (
              <button type="button" onClick={buildWithoutBoard} disabled={pending} className={buttonClass('secondary', 'lg')} data-testid="scan-build-without-board">
                Plan without the board
              </button>
            ) : null}
            <Link href={`/trips/${tripId}/questionnaire`} className={buttonClass('ghost')} data-testid="scan-back-to-answers">
              Change my answers
            </Link>
          </div>
          {unavailable ? (
            <p id="scan-unavailable-note" className="mt-3 type-small text-ink" role="status" data-testid="scan-unavailable">
              <strong className="font-semibold">{unavailable.heading}</strong> {unavailable.message}
            </p>
          ) : null}
        </section>
      )}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}
