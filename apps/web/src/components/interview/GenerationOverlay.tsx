'use client';

import { useEffect, useState } from 'react';
import { DestinationMap, type DestinationGeometry } from './DestinationMap';
import type { MapBasemap } from '../map-adapter';
import { generationProgressAction, type GenerationProgressView } from '@/app/(product)/trips/[id]/questionnaire/progress-actions';

/**
 * THE ONE-TO-TWO-MINUTE WAIT IS A PRODUCT MOMENT — AND IT TELLS THE TRUTH.
 *
 * MVP V3, Stage 24. What this replaces: four stages advanced by a `setInterval`,
 * so at 45 seconds the screen said "Checking the places" whether or not a place
 * had been checked, and at 100 seconds it said "Preparing the trip" whether or
 * not the model had answered. A progress display that cannot be wrong because it
 * is not about anything.
 *
 * Now every stage is a boundary the server actually crossed
 * (`generation_progress`), polled a couple of times a second; a finished stage
 * locks in with a mark and stays; the current one breathes. Elapsed time is
 * shown because it is a fact. There is no percentage, and there will not be one:
 * a percentage is a claim about how long a model will take.
 *
 * The dark cartographic ground stays — the destination's own map behind the
 * stages, a route sketched once across the frame.
 */

/** Fast enough to feel live, slow enough to be nothing: one small read of one row. */
const POLL_MS = 1_200;

export function GenerationOverlay({ tripId, destination, geometry = null, tiles = null }: { tripId?: string; destination: string; geometry?: DestinationGeometry | null; tiles?: MapBasemap | null }) {
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<GenerationProgressView | null>(null);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!tripId) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      const view = await generationProgressAction(tripId).catch(() => null);
      if (stopped) return;
      if (view) setProgress(view);
      if (!view?.finished) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), 400);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [tripId]);

  const stages = progress?.all ?? FALLBACK_STAGES;
  const reached = progress?.reached ?? [];
  const currentIndex = progress ? Math.max(0, stages.findIndex((stage) => stage.id === progress.stage)) : 0;
  const label = progress?.label ?? 'Reading your trip';
  const detail = progress?.detail ?? 'Your answers, your dates and anything already booked.';
  const seconds = progress?.elapsedSeconds ?? elapsed;

  return (
    <div className="atlas fixed inset-0 z-40 overflow-y-auto p-5 sm:p-8" role="status" aria-live="polite" data-testid="generation-overlay" data-stage={progress?.stage ?? 'understanding'}>
      <div className="mx-auto grid min-h-full max-w-6xl items-center gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0">
          <p className="type-small atlas-muted">Building {destination}</p>
          <h2 className="display-xl mt-2 text-[var(--color-atlas-ink)]">{label}</h2>
          <p className="mt-3 max-w-[48ch] type-body atlas-muted">{detail}</p>
          <ol className="mt-8 space-y-3" aria-label="Stages">
            {stages.map((stage, index) => {
              const done = reached.includes(stage.id) && index < currentIndex;
              const now = index === currentIndex;
              return (
                <li key={stage.id} className={`flex items-center gap-3 text-sm ${done || now ? 'text-[var(--color-atlas-ink)]' : 'atlas-muted'}`} aria-current={now ? 'step' : undefined} data-done={done ? 'true' : 'false'}>
                  <span aria-hidden="true" className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? 'bg-[var(--color-route-bright)] text-[var(--color-atlas)]' : now ? 'border border-[var(--color-route-bright)]' : 'border border-[var(--color-atlas-muted)]'}`}>
                    {done ? '\u2713' : null}
                  </span>
                  <span className={now ? 'font-medium' : undefined}>{stage.label}</span>
                  {now ? <span aria-hidden="true" className="breathing inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-route-bright)]" /> : null}
                </li>
              );
            })}
          </ol>
          <p className="numeral mt-8 type-small atlas-muted">
            {seconds}s elapsed · usually under two minutes. Your answers are saved either way.
          </p>
        </div>
        <div className="relative min-w-0 rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)] p-3">
          {/*
            The destination's own map, and nothing drawn on top of it.
            An invented route with invented pins used to sweep across this frame.
            Over a graticule that was decoration; over a real basemap it is a
            claim — three marks on actual Hong Kong at places nobody chose —
            which is precisely what the rest of this product refuses to do.
          */}
          {geometry ? (
            <div className="gen-map">
              <DestinationMap geometry={geometry} tiles={tiles} shape="stay_put" chromeless />
            </div>
          ) : null}
        </div>
      </div>
      <style>{`
        .gen-map { opacity: 0.6; filter: saturate(0.55) contrast(1.05); }
        .gen-map :where(p, .type-meta) { color: var(--color-atlas-muted); }
      `}</style>
    </div>
  );
}

/** Shown for the fraction of a second before the first poll answers. Same words, same order. */
const FALLBACK_STAGES = [
  { id: 'understanding' as const, label: 'Reading your trip' },
  { id: 'composing' as const, label: 'Designing the route' },
  { id: 'route' as const, label: 'Laying out the days' },
  { id: 'places' as const, label: 'Checking the places' },
  { id: 'travel' as const, label: 'Timing the travel' },
  { id: 'preparing' as const, label: 'Preparing the trip' },
];
