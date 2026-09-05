'use client';

import { useState } from 'react';
import { INTEREST_LABELS, type Interest, type InterestLevel, type InterviewContext, type QuestionnaireAnswers } from '@sidequest/core';
import { cx, FOCUS_RING } from '../ui';
import { Glyph, INTEREST_HUE, type GlyphId } from './glyphs';

/**
 * THE LIVING TRIP SKETCH.
 *
 * Sidequest drawing the trip while the traveller talks: a range ring that
 * grows when they say they would drive further, a second base that appears
 * when they would move hotels, a transport glyph that changes with the
 * answer, and a few lines of personality that rewrite themselves. Every
 * value comes from the answers as they stand (and is marked assumed when it
 * is only a default), so the sketch is honest about what it knows.
 */

export interface Sketch {
  destination: string;
  scale: string | undefined;
  nights: number;
  bases: 1 | 2 | 3;
  shapeLabel: string;
  shapeAssumed: boolean;
  transport: { glyph: GlyphId; label: string; assumed: boolean };
  rangeKm: number;
  rangeLabel: string;
  rangeAssumed: boolean;
  lines: { text: string; assumed: boolean }[];
  hue: number;
  leadInterest: Interest | null;
}

const LEVEL_RANK: Record<InterestLevel, number> = { avoid: 0, low: 1, occasional: 2, frequent: 3, core: 4 };

const RANGE_KM: Record<QuestionnaireAnswers['regionalExpansion'], number> = {
  destination_only: 8,
  nearby_30: 25,
  nearby_60: 50,
  nearby_120: 100,
  best_regional: 160,
};

function explicit(answers: QuestionnaireAnswers, ...ids: string[]): boolean {
  return ids.some((id) => answers.provenance[id]?.source === 'explicit');
}

export function sketchFor(ctx: InterviewContext, answers: QuestionnaireAnswers): Sketch {
  const d = ctx.destination;
  const traits = new Set(d.traits);
  const chosen = (Object.entries(answers.interests) as [Interest, InterestLevel][])
    .filter(([, level]) => LEVEL_RANK[level] >= 2)
    .sort((a, b) => LEVEL_RANK[b[1]] - LEVEL_RANK[a[1]] || a[0].localeCompare(b[0]));
  const leadInterest = chosen[0]?.[0] ?? null;

  // --- shape ---------------------------------------------------------------
  let bases: Sketch['bases'] = traits.has('broad_geography') ? 3 : traits.has('multi_base_likely') ? 2 : 1;
  const tolerance = answers.baseMoveTolerance;
  if (tolerance === 'stay_put') bases = 1;
  else if (tolerance === 'move_once') bases = 2;
  else if (tolerance === 'move_freely') bases = 3;
  if (answers.scopeStrategy === 'depth' && bases > 2) bases = 2;
  if (answers.scopeStrategy === 'breadth') bases = 3;
  if (ctx.traveller.tripDays <= 3) bases = 1;
  const shapeLabel = bases === 1 ? (traits.has('dense_urban') ? 'One base, the city on foot' : 'One base, days out from it') : bases === 2 ? 'Two bases, one move' : 'A moving route';
  const shapeAssumed = !explicit(answers, 'base_moves', 'coverage_strategy');

  // --- transport -------------------------------------------------------------
  let transport: Sketch['transport'];
  if (answers.willDrive) transport = { glyph: 'car', label: 'A car', assumed: !explicit(answers, 'transport_mode') };
  else if (answers.guideWillingness === 'prefer') transport = { glyph: 'guide', label: 'Guided, with transfers', assumed: !explicit(answers, 'transport_mode') };
  else if (traits.has('archipelago') && answers.boatsAndFerries === 'fine') transport = { glyph: 'boat', label: 'Boats between islands', assumed: !explicit(answers, 'transport_mode') };
  else if (answers.transportPriority === 'least_stressful' && answers.privateTransfers === 'fine') transport = { glyph: 'taxi', label: 'Taxis and rideshare', assumed: !explicit(answers, 'transport_mode') };
  else transport = { glyph: 'transit', label: 'On foot and by transit', assumed: !explicit(answers, 'transport_mode') };

  // --- range --------------------------------------------------------------------
  const rangeKm = traits.has('dense_urban') && answers.dayTripAppetite === 'stay_in_city' ? 8 : RANGE_KM[answers.regionalExpansion];
  const rangeLabel = rangeKm <= 8 ? `${d.name} itself` : rangeKm <= 25 ? 'About half an hour out' : rangeKm <= 50 ? 'About an hour out' : rangeKm <= 100 ? 'Up to two hours out' : `The best of ${d.proseName}`;
  const rangeAssumed = !explicit(answers, 'scenic_reach', 'day_trips');

  // --- personality lines ----------------------------------------------------------
  const lines: Sketch['lines'] = [];
  if (chosen.length > 0) {
    const top = chosen.slice(0, 2).map(([interest]) => INTEREST_LABELS[interest].toLowerCase());
    lines.push({ text: `${capitalize(top[0]!)} first${top[1] ? `, then ${top[1]}` : ''}`, assumed: !explicit(answers, 'priorities') });
  }
  lines.push({ text: answers.pace === 'slow' ? 'One big thing a day' : answers.pace === 'fast' ? 'Full, fast days' : 'Two or three stops a day', assumed: !explicit(answers, 'day_shape') });
  if (explicit(answers, 'iconic_crowds') || answers.crowdTolerance !== 'mild') {
    lines.push({ text: answers.iconicCrowdStrategy === 'see_it_anyway' ? 'Crowds are fine' : answers.iconicCrowdStrategy === 'quieter_alternative' ? 'Quiet over famous' : 'Famous places at quiet hours', assumed: !explicit(answers, 'iconic_crowds') });
  }
  if (explicit(answers, 'food_tradeoff')) {
    lines.push({ text: answers.foodStyle === 'destination' ? 'Will cross town for a meal' : answers.foodStyle === 'budget' ? 'Food is fuel' : 'Good food on the way', assumed: false });
  }
  if (explicit(answers, 'effort')) {
    lines.push({ text: answers.dailyIntensity === 'intense' ? 'Long days, real climbing' : answers.dailyIntensity === 'light' ? 'Easy on the legs' : 'Some miles, some climbing', assumed: false });
  }
  if (answers.hardConstraints.length > 0) lines.push({ text: `${answers.hardConstraints.length} hard ${answers.hardConstraints.length === 1 ? 'rule' : 'rules'}`, assumed: false });

  return {
    destination: d.name,
    scale: d.scaleLabel,
    nights: d.nights,
    bases,
    shapeLabel,
    shapeAssumed,
    transport,
    rangeKm,
    rangeLabel,
    rangeAssumed,
    lines: lines.slice(0, 5),
    hue: leadInterest ? INTEREST_HUE[leadInterest] : traits.has('dense_urban') ? 228 : traits.has('beach') || traits.has('archipelago') ? 199 : 150,
    leadInterest,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The figure: base, range ring, extra bases and their moves. Rings animate on change. */
export function SketchFigure({ sketch, className }: { sketch: Sketch; className?: string }) {
  const r = 12 + Math.min(88, Math.sqrt(sketch.rangeKm) * 6.4);
  const second = sketch.bases >= 2;
  const third = sketch.bases >= 3;
  return (
    <div className={cx('plate relative overflow-hidden rounded-[var(--radius-plate)] border border-rule', className)} style={{ '--plate-hue': sketch.hue, '--plate-x': '42%', '--plate-y': '55%' } as React.CSSProperties} aria-hidden="true">
      <svg viewBox="0 0 320 220" className="h-auto w-full">
        <circle className="ring-live" cx={128} cy={118} r={r} fill="var(--color-accent)" opacity={0.1} />
        <circle className="ring-live" cx={128} cy={118} r={r} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} strokeDasharray="4 5" opacity={0.85} />
        {second ? <line className="ring-live" x1={128} y1={118} x2={226} y2={82} stroke="var(--color-ink)" strokeWidth={1.5} strokeDasharray="2 4" opacity={0.6} /> : null}
        {third ? <line className="ring-live" x1={226} y1={82} x2={262} y2={162} stroke="var(--color-ink)" strokeWidth={1.5} strokeDasharray="2 4" opacity={0.6} /> : null}
        <rect x={122} y={112} width={12} height={12} rx={2} fill="var(--color-ink)" />
        {second ? <rect className="pop" x={220} y={76} width={12} height={12} rx={2} fill="var(--color-ink)" /> : null}
        {third ? <rect className="pop" x={256} y={156} width={12} height={12} rx={2} fill="var(--color-ink)" /> : null}
        {[[176, 96], [98, 150], [150, 172], [70, 84], [214, 146]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={3.5} fill={Math.hypot(x! - 128, y! - 118) <= r ? 'var(--color-accent)' : 'var(--color-ink-faint)'} className="transition-[fill] duration-[var(--motion-figure)]" />
        ))}
        <text x={128} y={144} textAnchor="middle" fontSize={11} fill="var(--color-ink)" fontFamily="var(--font-display)">
          {sketch.destination}
        </text>
        <g transform="translate(286 22)" opacity={0.7}>
          <line x1={0} y1={12} x2={0} y2={-8} stroke="var(--color-ink)" strokeWidth={1.2} />
          <path d="M-4 -2 L0 -10 L4 -2" fill="none" stroke="var(--color-ink)" strokeWidth={1.2} />
          <text x={0} y={24} textAnchor="middle" fontSize={8} fill="var(--color-ink)" letterSpacing={1}>
            N
          </text>
        </g>
        <text x={12} y={208} fontSize={7.5} fill="var(--color-ink-muted)" letterSpacing={1.2}>
          SKETCH · NOT TO SCALE · {sketch.rangeKm} KM RING
        </text>
      </svg>
      <div className="absolute top-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-rule bg-paper-raised text-ink">
        <Glyph id={sketch.transport.glyph} className="h-5 w-5" />
      </div>
    </div>
  );
}

function Assumed({ on }: { on: boolean }) {
  return on ? <span className="ml-1.5 align-middle text-[10px] uppercase tracking-[0.14em] text-ink-faint">assumed</span> : null;
}

export function TripSketchPanel({ ctx, answers, className, compact = false }: { ctx: InterviewContext; answers: QuestionnaireAnswers; className?: string; compact?: boolean }) {
  const sketch = sketchFor(ctx, answers);
  return (
    <aside className={cx('min-w-0', className)} aria-label="Your trip so far" data-testid="trip-sketch">
      <p className="label text-ink-faint">Your trip, so far</p>
      <p className="mt-1.5 font-display text-2xl leading-tight text-ink">{sketch.destination}</p>
      <p className="text-sm text-ink-muted">
        {[sketch.scale, `${sketch.nights} ${sketch.nights === 1 ? 'night' : 'nights'}`].filter(Boolean).join(' · ')}
      </p>
      <SketchFigure sketch={sketch} className="mt-4" />
      <dl className="mt-4 space-y-2.5 text-sm">
        <div>
          <dt className="label text-ink-faint">Shape</dt>
          <dd className="text-ink" data-testid="sketch-shape">
            {sketch.shapeLabel}
            <Assumed on={sketch.shapeAssumed} />
          </dd>
        </div>
        <div>
          <dt className="label text-ink-faint">Getting around</dt>
          <dd className="text-ink" data-testid="sketch-transport">
            {sketch.transport.label}
            <Assumed on={sketch.transport.assumed} />
          </dd>
        </div>
        <div>
          <dt className="label text-ink-faint">Range</dt>
          <dd className="text-ink" data-testid="sketch-range">
            {sketch.rangeLabel}
            <Assumed on={sketch.rangeAssumed} />
          </dd>
        </div>
        {!compact && sketch.lines.length > 0 ? (
          <div>
            <dt className="label text-ink-faint">Personality</dt>
            <dd>
              <ul className="mt-1 space-y-1" data-testid="sketch-lines">
                {sketch.lines.map((line) => (
                  <li key={line.text} className="enter flex items-baseline gap-2 text-ink">
                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      {line.text}
                      <Assumed on={line.assumed} />
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
    </aside>
  );
}

/** On a phone: a sheet that opens from a slim bar. */
export function TripSketchSheet({ ctx, answers }: { ctx: InterviewContext; answers: QuestionnaireAnswers }) {
  const [open, setOpen] = useState(false);
  const sketch = sketchFor(ctx, answers);
  return (
    <div className="lg:hidden" data-testid="trip-sketch-sheet">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="trip-sketch-sheet-body"
        className={cx('flex w-full items-center justify-between gap-3 rounded-[var(--radius-card)] border border-rule bg-paper-raised px-4 py-3 text-left', FOCUS_RING)}
      >
        <span className="flex items-center gap-3">
          <span className="plate inline-flex h-9 w-9 items-center justify-center rounded-full" style={{ '--plate-hue': sketch.hue } as React.CSSProperties} aria-hidden="true">
            <Glyph id={sketch.transport.glyph} className="h-4 w-4 text-ink" />
          </span>
          <span>
            <span className="label block text-ink-faint">Your trip so far</span>
            <span className="block text-sm text-ink">
              {sketch.shapeLabel} · {sketch.rangeLabel}
            </span>
          </span>
        </span>
        <span className="text-sm text-accent">{open ? 'Hide' : 'Show'}</span>
      </button>
      <div id="trip-sketch-sheet-body" className={cx('enter mt-3', !open && 'hidden')}>
        <TripSketchPanel ctx={ctx} answers={answers} />
      </div>
    </div>
  );
}
