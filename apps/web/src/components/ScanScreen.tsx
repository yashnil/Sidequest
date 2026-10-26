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
import { ScanMap } from './ScanMap';

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
 *
 * SURVEY ATLAS (2026-10): the night survey grid as the ground; the counts as
 * boxed figures (proposed · placed · bases · timed · elapsed) rather than a
 * sentence, still the scan's own numbers and never a percentage; the stages
 * as a ruled, numbered register; the map as a survey plate with numbered
 * specimens and a live coordinate bar (`ScanMap`). The words arrive with a
 * short staggered rise and the pins rise as the scan places them.
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

  const figures: { key: string; label: string; value: string }[] = [
    { key: 'proposed', label: 'Ideas', value: String(view.counters.proposed) },
    { key: 'placed', label: 'Mapped', value: String(view.counters.placed) },
    { key: 'bases', label: 'Stays', value: String(view.counters.bases) },
    { key: 'timed', label: 'Timed', value: String(view.counters.timed) },
  ];
  const headingClass = 'mt-3 font-display text-[clamp(2.4rem,1.7rem+2.6vw,4rem)] leading-[0.98] font-[340] tracking-[-0.03em] text-[var(--color-atlas-ink)] focus:outline focus:outline-2 focus:outline-[var(--color-glacier)] focus:outline-offset-2';

  return (
    <div className="survey-night min-h-[calc(100svh-var(--chrome-height))] text-[var(--color-atlas-ink)]" data-testid="scan-screen" data-state={view.state}>
    <div className={cx('mx-auto px-5 py-10 sm:px-8 sm:py-14', view.map && !view.failure ? 'grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start' : 'max-w-3xl')}>
    <div className="min-w-0">
      <p className="sheet-label fade-up flex min-w-0 flex-wrap gap-x-2 text-[var(--color-glacier)]">
        <span>Step 2 of 3 · Finding places</span>
        <span className="text-[var(--color-atlas-muted)]">· {destination}</span>
      </p>

      {running || (view.state === 'ready' && !idle) ? (
        <section aria-labelledby="scan-heading" className="mt-3">
          <p className="sr-only">Finding places for {destination}</p>
          {/* One polite live region: the stage name and the newest real count, so a screen reader hears each change once. */}
          <div role="status" aria-live="polite" aria-atomic="true">
            <h1 id="scan-heading" ref={headingRef} tabIndex={-1} className={headingClass} data-testid="scan-stage">
              <span key={view.state === 'ready' ? 'ready' : (view.stage ?? 'start')} className="mask-rise pb-[0.06em]">
                <span>{view.state === 'ready' ? (view.autoBuildPending || view.autoBuildStarted ? 'Your board is ready — building your trip' : 'Your board is ready') : (view.label ?? 'Starting the search')}</span>
              </span>
            </h1>
            {latest && latest !== view.label ? (
              <p className="mt-4 text-base text-[var(--color-atlas-ink)]" data-testid="scan-latest">
                {latest}
              </p>
            ) : null}
          </div>

          {/* The counts as figures: what the scan has actually counted, nothing estimated, never a percentage. */}
          <div className="mt-7 grid min-w-0 grid-cols-5 border-t border-l border-white/20" aria-label="What the scan has counted so far" role="group" data-testid="scan-figures">
            {figures.map((figure, i) => (
              <div key={figure.key} className="fade-up min-w-0 border-r border-b border-white/20 px-2 py-2.5 sm:px-3" style={{ ['--d' as string]: `${120 + i * 60}ms` }}>
                <span className="block truncate font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-atlas-muted)] sm:text-[10px] sm:tracking-[0.12em]">{figure.label}</span>
                <span className="mt-0.5 block font-display text-[1.35rem] leading-none tabular-nums sm:text-[1.6rem] text-[var(--color-atlas-ink)]">{figure.value}</span>
              </div>
            ))}
            <div className="fade-up min-w-0 border-r border-b border-white/20 px-2 py-2.5 sm:px-3" style={{ ['--d' as string]: '360ms' }}>
              <span className="block truncate font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-glacier)] sm:text-[10px] sm:tracking-[0.12em]">Elapsed</span>
              <span className="mt-0.5 block font-mono text-[0.95rem] leading-[1.45] sm:text-[1.15rem] sm:leading-[1.4] tabular-nums text-[var(--color-atlas-ink)]">{formatElapsed(running ? elapsed : view.elapsedSeconds)}</span>
            </div>
          </div>

          <ol className="mt-8 border-t border-white/15" aria-label="Stages">
            {view.stages.map((stage, index) => {
              const done = view.state === 'ready' || (currentIndex >= 0 && index < currentIndex);
              const now = running && index === currentIndex;
              return (
                <li key={stage.id} className="flex min-w-0 items-center gap-3.5 border-b border-white/10 py-2.5" aria-current={now ? 'step' : undefined} data-done={done ? 'true' : 'false'}>
                  <span aria-hidden="true" className={cx('w-6 shrink-0 font-mono text-[0.7rem] tabular-nums', done ? 'text-[var(--color-glacier)]' : now ? 'text-[var(--color-flare)]' : 'text-[var(--color-atlas-muted)]/70')}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className={cx('min-w-0 flex-1 text-sm leading-5', done || now ? 'text-[var(--color-atlas-ink)]' : 'text-[var(--color-atlas-muted)]', now && 'font-semibold')}>{stage.label}</span>
                  <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center">
                    {done ? (
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[var(--color-glacier)]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    ) : now ? (
                      <span className="breathing h-2 w-2 bg-[var(--color-flare)]" />
                    ) : (
                      <span className="h-px w-3 bg-white/25" />
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          {view.lines.length > 1 ? (
            <p className="mt-5 type-small text-[var(--color-atlas-muted)]" data-testid="scan-counts">
              {view.lines.join(' · ')}
            </p>
          ) : null}

          <p className="mt-4 type-small text-[var(--color-atlas-muted)]" data-testid="scan-elapsed">
            <span className="font-mono text-[var(--color-atlas-ink)]">{formatElapsed(running ? elapsed : view.elapsedSeconds)}</span> elapsed · usually a minute or two. The search carries on if you leave this page; your answers are saved either way.
          </p>
          {view.autoBuildPending ? (
            <p className="mt-2 type-small text-[var(--color-atlas-muted)]" data-testid="scan-auto-build-note">
              You asked Sidequest to plan with smart defaults, so it will build your trip from its own picks as soon as the board is ready.
            </p>
          ) : null}
        </section>
      ) : (
        <section aria-labelledby="scan-heading" className="mt-3">
          {failure ? (
            <div role="alert" data-testid="scan-failure" data-kind={failure.kind} data-retryable={failure.retryable ? 'true' : 'false'}>
              <p className="coordbar mt-4 inline-flex items-center gap-2 border border-[var(--color-flare)]/60 px-2 py-1 text-[var(--color-flare)]">
                <span aria-hidden="true" className="h-1.5 w-1.5 bg-[var(--color-flare)]" />
                Search stopped
              </p>
              <h1 id="scan-heading" ref={headingRef} tabIndex={-1} className={headingClass}>
                {failure.heading}
              </h1>
              <p className="mt-4 max-w-[60ch] type-body text-[var(--color-atlas-ink)]" data-testid="scan-failure-message">
                {failure.message}
              </p>
              {failure.ref ? (
                <p className="mt-4 border-t border-white/15 pt-3 type-small text-[var(--color-atlas-muted)]" data-testid="scan-failure-ref">
                  If it keeps happening, quote this reference: <span className="font-mono text-[var(--color-atlas-ink)]">{failure.ref}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <h1 id="scan-heading" ref={headingRef} tabIndex={-1} className={headingClass}>
                <span className="mask-rise pb-[0.06em]">
                  <span>Find places for {destination}</span>
                </span>
              </h1>
              <p className="fade-up mt-4 max-w-[56ch] type-body text-[var(--color-atlas-muted)]" style={{ ['--d' as string]: '160ms' }} data-testid="scan-intro">
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
              <button type="button" onClick={buildWithoutBoard} disabled={pending} className="inline-flex min-h-12 items-center rounded-full border border-white/20 px-6 text-base font-semibold text-[var(--color-atlas-ink)] hover:border-white/50 focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="scan-build-without-board">
                Plan without the board
              </button>
            ) : null}
            <Link href={`/trips/${tripId}/questionnaire`} className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold text-[var(--color-atlas-ink)] underline decoration-white/25 underline-offset-4 hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="scan-back-to-answers">
              Change my answers
            </Link>
          </div>
          {unavailable ? (
            <p id="scan-unavailable-note" className="mt-3 type-small text-[var(--color-atlas-ink)]" role="status" data-testid="scan-unavailable">
              <strong className="font-semibold">{unavailable.heading}</strong> {unavailable.message}
            </p>
          ) : null}
        </section>
      )}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
    {view.map && !view.failure ? (
      <div className="fade-up h-[17rem] min-w-0 max-lg:order-first sm:h-[22rem] lg:sticky lg:top-[calc(var(--chrome-height)+2rem)] lg:h-[min(38rem,calc(100svh-var(--chrome-height)-4rem))]" style={{ ['--d' as string]: '200ms' }}>
        <ScanMap center={view.map.center} scale={view.map.scale} points={view.map.points} />
      </div>
    ) : null}
    </div>
    </div>
  );
}
