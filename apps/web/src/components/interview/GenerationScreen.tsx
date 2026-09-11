'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DestinationMap, type DestinationGeometry } from './DestinationMap';
import type { MapBasemap } from '../map-adapter';
import { buttonClass, cx } from '../ui';
import { callAction, newBuildKey } from '../client-action';
import type { GenerationProgressView } from '@/app/api/trips/[id]/progress/route';
import { retryBuildAction } from '@/app/(product)/trips/[id]/questionnaire/actions';
import { formatElapsed, projectPlaced } from '@/lib/build-progress/placed-projection';

/**
 * THE ONE-TO-TWO-MINUTE WAIT IS A PRODUCT MOMENT — AND IT TELLS THE TRUTH.
 *
 * MVP V3, Stage 24. Every stage is a boundary the server actually crossed
 * (`generation_progress`), polled a couple of times a second; a finished stage
 * locks in with a mark and stays; the current one breathes. Elapsed time is
 * shown because it is a fact. There is no percentage, and there will not be
 * one: a percentage is a claim about how long a model will take.
 *
 * V8 — this screen is rendered from the **run**, not from a page's memory of
 * having pressed a button. It knows four states: running, succeeded (it
 * leaves for the Trip Hub), failed and lost — and the last two are designed as
 * carefully as the first: what happened in the traveller's terms, what is
 * preserved, and what they can do now. "Try build again" uses the profile
 * already saved and never the interview.
 *
 * V8 §14 — THE BUILD AS ONE COMPOSITION. The dark atlas world, alive under a
 * slow grid drift. Left (top on a phone): the stage rail drawn as a vertical
 * route whose stops light as they are reached, the current stage named large,
 * its one-line detail, and the milestone sentences — real counters, in words —
 * rising in as they arrive. Right (below on a phone): the destination's own
 * map, its frame easing in, with every locality the build has actually placed
 * so far marked on it and joined in placement order; with no geometry, the
 * atlas graticule with the destination's name, never an empty dark rectangle.
 * Nothing on this screen is invented: `stage`, `reached`, `milestones`,
 * `placed` and `elapsedSeconds` are the whole vocabulary.
 */

/** Fast enough to feel live, slow enough to be nothing: one small read of one row. */
const POLL_MS = 1_200;

const EASE_OUT = [0.2, 0.7, 0.2, 1] as const;

export function GenerationScreen({
  tripId,
  destination,
  geometry = null,
  tiles = null,
  initial = null,
  variant = 'page',
}: {
  tripId: string;
  destination: string;
  geometry?: DestinationGeometry | null;
  tiles?: MapBasemap | null;
  /** The run as the server saw it when this rendered, so the first paint is never a guess. */
  initial?: GenerationProgressView | null;
  /** `overlay` sits over the review while the route changes; `page` is `/trips/[id]/build`. */
  variant?: 'overlay' | 'page';
}) {
  const router = useRouter();
  const reduceMotion = useReducedMotion() ?? false;
  const [elapsed, setElapsed] = useState(initial?.elapsedSeconds ?? 0);
  const [progress, setProgress] = useState<GenerationProgressView | null>(initial);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, startRetry] = useTransition();
  const retryKey = useRef<string | null>(null);
  const leaving = useRef(false);
  /*
   * V8 — which run this screen is watching. The poll stops on a terminal
   * state; a retry starts a new run, so it bumps this token and the effect
   * below starts polling again. Without it the screen kept showing the run
   * that had just failed while the retry ran to its own end unwatched.
   */
  const [watching, setWatching] = useState(0);

  useEffect(() => {
    const started = Date.now() - (initial?.elapsedSeconds ?? 0) * 1000;
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [initial?.elapsedSeconds]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    /*
     * V7 §16 — a GET route, never a server action: a tab's server actions run
     * one at a time, so a poll made through one waited behind the build itself
     * and the screen never moved. See `api/trips/[id]/progress/route.ts`.
     */
    const poll = async () => {
      const view = await fetch(`/api/trips/${encodeURIComponent(tripId)}/progress`, { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<GenerationProgressView>) : null))
        .catch(() => null);
      if (stopped) return;
      if (view) setProgress(view);
      if (view?.state === 'succeeded') {
        if (!leaving.current) {
          leaving.current = true;
          router.replace(`/trips/${tripId}/itinerary`);
        }
        return;
      }
      if (view?.state === 'failed' || view?.state === 'lost') return;
      timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), 400);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [tripId, router, watching]);

  const state = progress?.state ?? 'running';
  const stages = progress?.all ?? FALLBACK_STAGES;
  const reached = progress?.reached ?? [];
  const currentIndex = progress ? Math.max(0, stages.findIndex((stage) => stage.id === progress.stage)) : 0;
  const label = progress?.label ?? 'Reading your trip';
  const detail = progress?.detail ?? 'Your answers, your dates and anything already booked.';
  const seconds = progress?.elapsedSeconds ?? elapsed;
  const placed = progress?.placed ?? [];

  function retry() {
    setRetryError(null);
    retryKey.current ??= newBuildKey();
    const key = retryKey.current;
    startRetry(async () => {
      const outcome = await callAction(() => retryBuildAction(tripId, key));
      if (!outcome.ok) {
        setRetryError(outcome.message);
        return;
      }
      if (!outcome.value.ok) {
        setRetryError(outcome.value.error);
        return;
      }
      /* A new run: the key is spent, and the poll starts again on the new row. */
      retryKey.current = null;
      setProgress(null);
      setElapsed(0);
      setWatching((n) => n + 1);
    });
  }

  const failed = state === 'failed' || state === 'lost';

  return (
    <div
      /*
       * A flex column so the grid can take the whole plate: `min-h-full` on a
       * child of a `min-h-*` parent resolves to nothing, which is why the first
       * round left the lower half of the ground empty at 1024 and 1440. The grid
       * fills the height and centres its content on `lg+`; on a phone the stack
       * stays at the top, where a scrolling column belongs.
       */
      className={cx('atlas atlas-live flex flex-col overflow-y-auto px-5 py-6 sm:px-8 sm:py-8', variant === 'overlay' ? 'fixed inset-0 z-40' : 'min-h-[calc(100dvh-var(--chrome-height))]')}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      data-testid="generation-overlay"
      data-stage={progress?.stage ?? 'understanding'}
      data-state={state}
    >
      <div className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:content-center lg:items-center lg:gap-12">
        <div className="min-w-0">
          {failed ? (
            <BuildFailure destination={destination} tripId={tripId} view={progress} retrying={retrying} retryError={retryError} onRetry={retry} />
          ) : (
            <>
              <p className="type-small atlas-muted">Building {destination}</p>
              {/* The current stage, named large; a stage change replaces the name with a short rise. */}
              <div className="relative mt-2 min-h-[1.1em]">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.h2
                    key={label}
                    initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
                    transition={{ duration: reduceMotion ? 0 : 0.28, ease: EASE_OUT }}
                    className="display-xl text-[var(--color-atlas-ink)]"
                  >
                    {label}
                  </motion.h2>
                </AnimatePresence>
              </div>
              <p className="mt-3 max-w-[46ch] type-body atlas-muted">{detail}</p>

              {/* THE STAGE RAIL AS A ROUTE: a vertical line with a stop per stage, each lighting as the server reaches it. */}
              <ol className="relative mt-8" aria-label="Stages">
                {stages.map((stage, index) => {
                  const done = reached.includes(stage.id) && index < currentIndex;
                  const now = index === currentIndex;
                  const last = index === stages.length - 1;
                  return (
                    <li key={stage.id} className={cx('relative flex items-start gap-3.5', !last && 'pb-4')} aria-current={now ? 'step' : undefined} data-done={done ? 'true' : 'false'}>
                      {!last ? (
                        <span
                          aria-hidden="true"
                          className="absolute left-[11px] top-6 bottom-0 w-0.5 rounded-full transition-colors duration-[var(--motion-page)]"
                          style={{ background: done ? 'color-mix(in srgb, var(--color-route-bright) 70%, transparent)' : 'rgb(255 255 255 / 0.12)' }}
                        />
                      ) : null}
                      <span
                        aria-hidden="true"
                        className={cx(
                          'relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition-colors duration-[var(--motion-base)]',
                          done ? 'border-[var(--color-route-bright)] bg-[var(--color-route-bright)] text-[var(--color-atlas)]' : now ? 'border-[var(--color-route-bright)] bg-[var(--color-atlas)]' : 'border-white/20 bg-[var(--color-atlas)]',
                        )}
                      >
                        <AnimatePresence initial={false}>
                          {done ? (
                            <motion.svg
                              key="tick"
                              viewBox="0 0 16 16"
                              className="h-3 w-3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              initial={{ scale: reduceMotion ? 1 : 0.4, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              transition={{ duration: reduceMotion ? 0 : 0.32, ease: EASE_OUT }}
                            >
                              <path d="m3.5 8.5 3 3 6-7" />
                            </motion.svg>
                          ) : now ? (
                            <span key="now" className="breathing h-2 w-2 rounded-full bg-[var(--color-route-bright)]" />
                          ) : null}
                        </AnimatePresence>
                      </span>
                      <span className={cx('pt-0.5 text-sm leading-5 transition-colors duration-[var(--motion-base)]', done || now ? 'text-[var(--color-atlas-ink)]' : 'atlas-muted', now && 'font-semibold')}>{stage.label}</span>
                    </li>
                  );
                })}
              </ol>

              {/* V7 §16 — what has actually been counted so far. Sentences from real counters; never a percentage, never a provider name. */}
              {progress && progress.milestones.length > 0 ? (
                <ul className="mt-7 space-y-1.5 text-sm text-[var(--color-atlas-ink)]" aria-label="Progress so far" data-testid="generation-milestones">
                  <AnimatePresence initial={false}>
                    {progress.milestones.map((line) => (
                      <motion.li
                        key={line}
                        initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: reduceMotion ? 0 : 0.26, ease: EASE_OUT }}
                        className="flex gap-2.5"
                      >
                        <span aria-hidden="true" className="text-[var(--color-route-bright)]">—</span>
                        <span>{line}</span>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              ) : null}

              <p className="mt-8 type-small atlas-muted" data-testid="generation-elapsed">
                <span className="type-figure text-base text-[var(--color-atlas-ink)]">{formatElapsed(seconds)}</span> elapsed · usually under two minutes.
              </p>
              <p className="mt-1 type-small atlas-muted">Your answers are saved either way.</p>
            </>
          )}
        </div>

        <BuildMap destination={destination} geometry={geometry} tiles={tiles} placed={placed} reduceMotion={reduceMotion} />
      </div>
      <style>{`
        .gen-map { opacity: 0.72; filter: saturate(0.5) contrast(1.05); transition: opacity var(--motion-page) var(--ease-out); }
        .gen-map figure > div { border-color: rgb(255 255 255 / 0.12); }
        .gen-map :where(p, .type-meta) { color: var(--color-atlas-muted); }
        .gen-placed-label { text-shadow: 0 1px 2px rgb(0 0 0 / 0.85), 0 0 6px rgb(0 0 0 / 0.6); }
      `}</style>
    </div>
  );
}

/**
 * THE MAP HALF OF THE COMPOSITION.
 *
 * With geometry: the destination's own map — the same one the review showed,
 * so the two screens read as one surface — with a sketch over it of every
 * locality the build has placed so far. Without geometry: the atlas graticule
 * carrying the destination's name in the display face. The frame eases in
 * once; nothing on it loops.
 */
function BuildMap({ destination, geometry, tiles, placed, reduceMotion }: { destination: string; geometry: DestinationGeometry | null; tiles: MapBasemap | null; placed: GenerationProgressView['placed']; reduceMotion: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.42, ease: EASE_OUT }}
      className="relative min-w-0 rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)] p-3 shadow-[var(--shadow-float)]"
      data-testid="generation-map"
    >
      {geometry ? (
        <div className="relative">
          {/*
            The destination's own map. Nothing invented is drawn on it: the only
            marks are localities the build has actually placed, and the line
            between them is their placement order — the caption says so.
          */}
          <div className="gen-map">
            <DestinationMap geometry={geometry} tiles={tiles} shape="stay_put" chromeless />
          </div>
          <PlacedSketch geometry={geometry} placed={placed} reduceMotion={reduceMotion} />
        </div>
      ) : (
        <div className="atlas relative flex aspect-[7/5] items-end overflow-hidden rounded-[var(--radius-card)] p-5 sm:p-6" data-testid="generation-map-graticule">
          <span aria-hidden="true" className="absolute left-1/2 top-[42%] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-route-bright)]" />
          <span aria-hidden="true" className="breathing absolute left-1/2 top-[42%] h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--color-route-bright)]/40" />
          <p className="display-lg relative max-w-[14ch] text-[var(--color-atlas-ink)]">{destination}</p>
        </div>
      )}
      {placed.length > 0 ? (
        <p className="mt-2.5 px-1 type-small atlas-muted" data-testid="generation-placed-count">
          <span className="type-figure text-[var(--color-atlas-ink)]">{placed.length}</span> {placed.length === 1 ? 'place' : 'places'} on the map so far. The line is the order they were placed, not a measured route.
        </p>
      ) : null}
    </motion.div>
  );
}

/**
 * V8 §14 — THE ROUTE SKELETON, DRAWN AS THE DRAFT MAKES IT AVAILABLE.
 *
 * Each placed locality is a hollow mark with its name; consecutive marks are
 * joined by a segment that draws itself in (`route-draw`), so the sketch grows
 * segment by segment rather than redrawing from the start on every poll. The
 * overlay sits over the map figure at the figure's own 7:5 ratio; positions
 * come from `projectPlaced`, a plate-carrée fit of the same bounds the map
 * frames, so a mark lands near the town it names — close enough for a sketch,
 * captioned as one. Under reduced motion marks appear without animation.
 */
function PlacedSketch({ geometry, placed, reduceMotion }: { geometry: DestinationGeometry; placed: GenerationProgressView['placed']; reduceMotion: boolean }) {
  const points = useMemo(() => projectPlaced(placed, { center: geometry.center, bounds: geometry.bounds ?? null }), [placed, geometry.center, geometry.bounds]);
  if (points.length === 0) return null;
  const latest = points[points.length - 1]!;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[7/5] overflow-hidden rounded-[var(--radius-card)]" data-testid="generation-placed" aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        {points.slice(1).map((point, index) => {
          const from = points[index]!;
          return (
            <path
              key={`${from.name}→${point.name}`}
              d={`M${from.x} ${from.y} L${point.x} ${point.y}`}
              pathLength={1}
              className="route-draw"
              fill="none"
              stroke="var(--color-route-bright)"
              strokeWidth={2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {points.map((point) => (
        <motion.div
          key={point.name}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.32, ease: EASE_OUT }}
          className="absolute"
          style={{ left: `${point.x}%`, top: `${point.y}%` }}
        >
          <span className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border-2 border-[var(--color-route-bright)] bg-[var(--color-atlas)]" />
          {point.name === latest.name ? <span className="pulse-once absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border border-[var(--color-route-bright)]" /> : null}
          <span className={cx('gen-placed-label absolute top-0 block max-w-[11rem] -translate-y-1/2 truncate whitespace-nowrap text-xs font-semibold text-[var(--color-atlas-ink)]', point.x > 68 ? 'right-3' : 'left-3')}>{point.name}</span>
        </motion.div>
      ))}
    </div>
  );
}

/**
 * V8 §1.5 / §1.8 — THE BUILD FAILURE, AS A DESIGNED STATE.
 *
 * Three questions, in order: what happened in the traveller's terms, what is
 * preserved, what they can do now. The kind decides the second sentence and
 * what "Try build again" will cost; the reference is shown so a support
 * conversation can find the one log line. No provider, no schema, no stack.
 */
function BuildFailure({
  destination,
  tripId,
  view,
  retrying,
  retryError,
  onRetry,
}: {
  destination: string;
  tripId: string;
  view: GenerationProgressView | null;
  retrying: boolean;
  retryError: string | null;
  onRetry: () => void;
}) {
  const failure = view?.failure ?? null;
  const lost = view?.state === 'lost';
  const heading = lost ? 'We lost track of this build.' : 'Sidequest couldn’t finish this build.';
  const preserved = failure?.draftSaved
    ? 'Your trip profile is saved, and so is the draft Sidequest wrote — trying again finishes that draft rather than starting over.'
    : failure?.modelInvoked
      ? 'Your trip profile is saved. The draft could not be used, so trying again writes a fresh one.'
      : 'Your trip profile is saved. Nothing was composed yet, so trying again starts the build from it.';
  return (
    <div className="enter" data-testid="build-failure">
      <p className="type-small atlas-muted">Building {destination}</p>
      <h2 className="display-xl mt-2 text-[var(--color-atlas-ink)]">{heading}</h2>
      <p className="mt-4 max-w-[52ch] type-body text-[var(--color-atlas-ink)]" data-testid="build-failure-reason">
        {preserved}
      </p>
      {view?.hasItinerary ? (
        <p className="mt-2 max-w-[52ch] type-body atlas-muted" data-testid="build-failure-earlier-plan">
          Your earlier plan is still there and unchanged.
        </p>
      ) : null}
      <p className="mt-2 max-w-[52ch] type-small atlas-muted">Nothing in the interview needs answering again.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" onClick={onRetry} disabled={retrying} className={cx(buttonClass('primary', 'lg'), 'bg-[var(--color-atlas-ink)] text-[var(--color-atlas)] hover:bg-white')} data-testid="build-retry">
          {retrying ? 'Starting…' : 'Try build again'}
        </button>
        <Link href={`/trips/${tripId}/questionnaire`} className={cx(ATLAS_SECONDARY, 'min-h-12 px-6 text-base')} data-testid="build-return-review">
          Return to review
        </Link>
        {view?.hasItinerary ? (
          <Link href={`/trips/${tripId}/itinerary`} className={cx(ATLAS_SECONDARY, 'min-h-12 border-transparent px-6 text-base')} data-testid="build-open-earlier">
            Open the earlier plan
          </Link>
        ) : null}
      </div>
      {retryError ? (
        <p className="mt-4 max-w-[52ch] type-small text-[var(--color-atlas-ink)]" role="alert" data-testid="build-retry-error">
          {retryError}
        </p>
      ) : null}
      {failure?.ref ? (
        <p className="mt-8 type-small atlas-muted" data-testid="build-failure-ref">
          If it keeps happening, quote this reference: <span className="font-mono text-[var(--color-atlas-ink)]">{failure.ref}</span>
        </p>
      ) : null}
    </div>
  );
}

/** A quiet outlined control on the atlas ground, where the paper button classes are invisible. */
const ATLAS_SECONDARY = 'pressable inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-white/25 bg-transparent font-semibold text-[var(--color-atlas-ink)] transition-colors hover:border-white/50 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[var(--color-route-bright)] focus-visible:outline-offset-2';

/** Shown for the fraction of a second before the first poll answers. Same words, same order. */
const FALLBACK_STAGES = [
  { id: 'understanding' as const, label: 'Reading your trip' },
  { id: 'composing' as const, label: 'Designing the route' },
  { id: 'route' as const, label: 'Laying out the days' },
  { id: 'places' as const, label: 'Checking the places' },
  { id: 'travel' as const, label: 'Timing the travel' },
  { id: 'preparing' as const, label: 'Preparing the trip' },
];
