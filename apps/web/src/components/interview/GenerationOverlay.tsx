'use client';

import { useEffect, useState } from 'react';

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

export function GenerationOverlay({ destination }: { destination: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const stageIndex = STAGES.reduce((index, stage, i) => (elapsed >= stage.at ? i : index), 0);
  const stage = STAGES[stageIndex]!;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-paper/92 p-6 backdrop-blur-sm" role="status" aria-live="polite" data-testid="generation-overlay">
      <div className="w-full max-w-lg">
        <svg viewBox="0 0 480 200" className="h-auto w-full" aria-hidden="true">
          <defs>
            <pattern id="gen-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M32 0H0V32" fill="none" stroke="var(--color-rule)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="480" height="200" fill="url(#gen-grid)" opacity="0.5" />
          <path d="M40 150 C 110 60, 170 40, 220 90 S 320 170, 440 60" fill="none" stroke="var(--color-map-route)" strokeWidth="3" strokeLinecap="round" strokeDasharray="620" strokeDashoffset="620" className="gen-route" />
          {[
            [40, 150],
            [220, 90],
            [440, 60],
          ].map(([x, y], i) => (
            <g key={i} className="gen-pin" style={{ animationDelay: `${i * 1.1 + 0.2}s` }}>
              <rect x={x! - 6} y={y! - 6} width="12" height="12" rx="2" fill="var(--color-ink)" stroke="var(--color-paper)" strokeWidth="2" />
            </g>
          ))}
          {[
            [120, 70],
            [300, 140],
            [380, 95],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="4.5" fill="var(--color-accent)" className="gen-pin" style={{ animationDelay: `${i * 0.9 + 1.4}s` }} />
          ))}
        </svg>
        <p className="mt-2 type-meta">Building {destination}</p>
        <h2 className="display-md mt-1 text-ink">{stage.label}</h2>
        <p className="mt-2 type-body text-ink-muted">{stage.detail}</p>
        <ol className="mt-6 flex flex-wrap gap-x-5 gap-y-2 type-small" aria-label="Stages">
          {STAGES.map((s, i) => (
            <li key={s.label} className={i <= stageIndex ? 'text-ink' : 'text-ink-faint'} aria-current={i === stageIndex ? 'step' : undefined}>
              <span aria-hidden="true" className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${i < stageIndex ? 'bg-pine' : i === stageIndex ? 'bg-accent breathing' : 'bg-rule'}`} />
              {s.label}
            </li>
          ))}
        </ol>
        <p className="mt-6 type-meta">Usually one to two minutes. Your answers are saved either way.</p>
      </div>
      <style>{`
        .gen-route { animation: gen-draw 3.2s var(--ease-out) forwards; }
        .gen-pin { opacity: 0; animation: gen-pop var(--motion-figure) var(--ease-out) forwards; transform-box: fill-box; transform-origin: center; }
        @keyframes gen-draw { to { stroke-dashoffset: 0; } }
        @keyframes gen-pop { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) { .gen-route { stroke-dashoffset: 0; animation: none; } .gen-pin { opacity: 1; animation: none; } }
      `}</style>
    </div>
  );
}
