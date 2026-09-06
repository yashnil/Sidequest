'use client';

import { useEffect, useState } from 'react';
import { DestinationMap, type DestinationGeometry } from './DestinationMap';
import type { MapBasemap } from '../map-adapter';

/**
 * PRODUCTION UI V1 — THE ONE-TO-TWO-MINUTE WAIT IS A PRODUCT MOMENT.
 *
 * Four traveller-facing stages, advanced on elapsed time rather than on any
 * internal signal (the build is one server action; nothing here knows the
 * reconciler exists), an animated route sketch, and no percentage — a
 * percentage would be a promise about a model's speed nobody can keep. Words
 * a traveller uses: designing, checking, preparing. Nothing about providers,
 * schemas or verification deadlines.
 */
const STAGES = [
  { at: 0, label: 'Designing your route', detail: 'Choosing where you sleep, what each day is for, and what to leave out.' },
  { at: 45, label: 'Checking the places', detail: 'Matching each stop to a real place on the map.' },
  { at: 75, label: 'Checking travel', detail: 'Timing the legs between stops where a router can, estimating honestly where it cannot.' },
  { at: 100, label: 'Preparing the trip', detail: 'Bookings to arrange, what to pack, and a fallback for each day.' },
];

export function GenerationOverlay({ destination, geometry = null, tiles = null }: { destination: string; geometry?: DestinationGeometry | null; tiles?: MapBasemap | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const stageIndex = STAGES.reduce((index, stage, i) => (elapsed >= stage.at ? i : index), 0);
  const stage = STAGES[stageIndex]!;
  return (
    <div className="atlas fixed inset-0 z-40 overflow-y-auto p-5 sm:p-8" role="status" aria-live="polite" data-testid="generation-overlay">
      {/*
        EXPERIENCE V2 — the wait is a place. The destination's own map on the
        atlas ground, the four stages beside it, a route sketched once across
        the frame. Stages advance on elapsed time only; nothing here pretends
        to know what the model is doing, and nothing shows a percentage.
      */}
      <div className="mx-auto grid min-h-full max-w-6xl items-center gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0">
          <p className="type-small atlas-muted">Building {destination}</p>
          <h2 className="display-xl mt-2 text-[var(--color-atlas-ink)]">{stage.label}</h2>
          <p className="mt-3 max-w-[48ch] type-body atlas-muted">{stage.detail}</p>
          <ol className="mt-8 space-y-3" aria-label="Stages">
            {STAGES.map((s, i) => (
              <li key={s.label} className={`flex items-center gap-3 text-sm ${i <= stageIndex ? 'text-[var(--color-atlas-ink)]' : 'atlas-muted'}`} aria-current={i === stageIndex ? 'step' : undefined}>
                <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${i < stageIndex ? 'bg-[var(--color-route-bright)]' : i === stageIndex ? 'bg-[var(--color-route-bright)] breathing' : 'border border-[var(--color-atlas-muted)]'}`} />
                {s.label}
              </li>
            ))}
          </ol>
          <p className="mt-8 type-small atlas-muted">Usually one to two minutes. Your answers are saved either way.</p>
        </div>
        <div className="relative min-w-0 rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)] p-3">
          {geometry ? (
            <div className="gen-map">
              <DestinationMap geometry={geometry} tiles={tiles} shape="stay_put" />
            </div>
          ) : null}
          <svg viewBox="0 0 480 200" className="pointer-events-none absolute inset-3 h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)]" preserveAspectRatio="none" aria-hidden="true">
            <path d="M40 150 C 110 60, 170 40, 220 90 S 320 170, 440 60" fill="none" stroke="var(--color-route-bright)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="route-reveal" />
            {[
              [40, 150],
              [220, 90],
              [440, 60],
            ].map(([x, y], i) => (
              <g key={i} className="gen-pin" style={{ animationDelay: `${i * 1.1 + 0.2}s` }}>
                <rect x={x! - 6} y={y! - 6} width="12" height="12" rx="2" fill="var(--color-atlas-ink)" stroke="var(--color-atlas)" strokeWidth="2" />
              </g>
            ))}
          </svg>
        </div>
      </div>
      <style>{`
        .gen-pin { opacity: 0; animation: gen-pop var(--motion-figure) var(--ease-out) forwards; transform-box: fill-box; transform-origin: center; }
        .gen-map { opacity: 0.55; filter: saturate(0.6) contrast(1.05); }
        .gen-map :where(figcaption, p, button, .type-meta) { color: var(--color-atlas-muted); }
        @keyframes gen-pop { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) { .gen-pin { opacity: 1; animation: none; } }
      `}</style>
    </div>
  );
}
