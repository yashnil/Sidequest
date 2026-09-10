'use client';

import { useState } from 'react';
import { INTEREST_LABELS, questionById, type Interest, type InterestLevel, type InterviewContext, type QuestionnaireAnswers } from '@sidequest/core';
import { cx, FOCUS_RING } from '../ui';
import { Glyph, INTEREST_HUE, type GlyphId } from './glyphs';
import { DestinationMap, type DestinationGeometry } from './DestinationMap';
import type { MapBasemap } from '../map-adapter';

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
  /** True when nothing — answer, default or a confident destination read — has settled the shape yet. */
  shapeOpen: boolean;
  transport: { glyph: GlyphId; label: string; assumed: boolean; open: boolean };
  /** A range ring is drawn only for a real constraint: an answer, or a decided default. Null draws no ring. */
  rangeKm: number | null;
  rangeLabel: string;
  rangeAssumed: boolean;
  rangeOpen: boolean;
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

/** Answered or decided (smart default, destination prior, carried) — anything with provenance. */
function settled(answers: QuestionnaireAnswers, ...ids: string[]): boolean {
  return ids.some((id) => answers.provenance[id] !== undefined || answers.interview?.decided.includes(id));
}

const OPEN = 'Not decided yet';

const TRANSPORT_BY_VALUE: Record<string, { glyph: GlyphId; label: string }> = {
  rent_car: { glyph: 'car', label: 'A car' },
  self_drive: { glyph: 'car', label: 'Self-drive, transfers where there is no road' },
  mixed: { glyph: 'car', label: 'A car where it helps, local transport in town' },
  guided: { glyph: 'guide', label: 'Guided, with transfers' },
  taxis: { glyph: 'taxi', label: 'Taxis and rideshare' },
  boats_transfers: { glyph: 'boat', label: 'Boats between islands' },
  no_car: { glyph: 'transit', label: 'No car: shuttles, taxis and tours' },
  transit_walk: { glyph: 'transit', label: 'On foot and by transit' },
};

const TRANSPORT_BY_MOVEMENT: Record<string, { glyph: GlyphId; label: string }> = {
  car: TRANSPORT_BY_VALUE.rent_car!,
  transit_walk: TRANSPORT_BY_VALUE.transit_walk!,
  guided: TRANSPORT_BY_VALUE.guided!,
  boat: TRANSPORT_BY_VALUE.boats_transfers!,
  mixed: TRANSPORT_BY_VALUE.mixed!,
};

export function sketchFor(ctx: InterviewContext, answers: QuestionnaireAnswers): Sketch {
  const d = ctx.destination;
  const traits = new Set(d.traits);
  const chosen = (Object.entries(answers.interests) as [Interest, InterestLevel][])
    .filter(([, level]) => LEVEL_RANK[level] >= 2)
    .sort((a, b) => LEVEL_RANK[b[1]] - LEVEL_RANK[a[1]] || a[0].localeCompare(b[0]));
  const leadInterest = chosen[0]?.[0] ?? null;

  // --- shape ---------------------------------------------------------------
  // Three sources, in order of authority: what was answered or decided, a confident
  // destination read, and — for a trip of three days or fewer — the one base any
  // short trip keeps. Anything else is open, and says so.
  const assumption = d.assumption;
  const confident = assumption?.confidence === 'high';
  let bases: Sketch['bases'] = 1;
  let shapeOpen = false;
  const shapeSettled = settled(answers, 'base_moves', 'coverage_strategy');
  if (shapeSettled) {
    bases = traits.has('broad_geography') ? 3 : traits.has('multi_base_likely') ? 2 : 1;
    const tolerance = answers.baseMoveTolerance;
    if (tolerance === 'stay_put') bases = 1;
    else if (tolerance === 'move_once') bases = 2;
    else if (tolerance === 'move_freely') bases = 3;
    if (answers.scopeStrategy === 'depth' && bases > 2) bases = 2;
    if (answers.scopeStrategy === 'breadth') bases = 3;
  } else if (assumption?.basesConfidence === 'high' && assumption.bases !== 'undecided') {
    bases = assumption.bases === 'many' ? 3 : assumption.bases === 'few' ? 2 : 1;
  } else if (ctx.traveller.tripDays <= 3) {
    bases = 1;
  } else {
    shapeOpen = true;
  }
  if (ctx.traveller.tripDays <= 3) bases = 1;
  const shapeLabel = shapeOpen ? OPEN : bases === 1 ? (traits.has('dense_urban') ? 'One base, the city on foot' : 'One base, days out from it') : bases === 2 ? 'Two bases, one move' : 'A moving route';
  const shapeAssumed = !shapeOpen && !explicit(answers, 'base_moves', 'coverage_strategy');

  // --- transport -------------------------------------------------------------
  // The answer when there is one; Sidequest's read when the evidence is strong; otherwise open.
  let transport: Sketch['transport'];
  if (settled(answers, 'transport_mode')) {
    const value = String(questionById(ctx, answers, 'transport_mode')?.read(answers) ?? 'transit_walk');
    const style = TRANSPORT_BY_VALUE[value] ?? TRANSPORT_BY_VALUE.transit_walk!;
    transport = { ...style, assumed: !explicit(answers, 'transport_mode'), open: false };
  } else if (confident && assumption && assumption.movement !== 'undecided') {
    transport = { ...TRANSPORT_BY_MOVEMENT[assumption.movement]!, assumed: true, open: false };
  } else {
    transport = { glyph: 'compass', label: OPEN, assumed: false, open: true };
  }

  // --- range --------------------------------------------------------------------
  // A city's reach is a question about day trips, not a driving radius; a region's is
  // the scenic reach. Neither is drawn until it has been answered or decided.
  let rangeKm: number | null = null;
  let rangeLabel = OPEN;
  let rangeOpen = true;
  if (traits.has('dense_urban')) {
    if (settled(answers, 'day_trips')) {
      const appetite = answers.dayTripAppetite;
      rangeKm = appetite === 'stay_in_city' ? 8 : appetite === 'several' ? 100 : 50;
      rangeLabel = appetite === 'stay_in_city' ? 'Inside the city' : appetite === 'several' ? 'Day trips out of the city' : 'One day out of the city';
      rangeOpen = false;
    }
  } else if (settled(answers, 'scenic_reach', 'day_trips')) {
    rangeKm = RANGE_KM[answers.regionalExpansion];
    rangeLabel = rangeKm <= 8 ? `${d.name} itself` : rangeKm <= 25 ? 'About half an hour out' : rangeKm <= 50 ? 'About an hour out' : rangeKm <= 100 ? 'Up to two hours out' : `The best of ${d.proseName}`;
    rangeOpen = false;
  }
  const rangeAssumed = !rangeOpen && !explicit(answers, 'scenic_reach', 'day_trips');

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
    shapeOpen,
    transport,
    rangeKm,
    rangeLabel,
    rangeAssumed,
    rangeOpen,
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
  const r = sketch.rangeKm === null ? 34 : 12 + Math.min(88, Math.sqrt(sketch.rangeKm) * 6.4);
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
          SKETCH · NOT TO SCALE{sketch.rangeKm === null ? ' · RANGE NOT DECIDED' : ` · ${sketch.rangeKm} KM RING`}
        </text>
      </svg>
      <div className="absolute top-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-rule bg-paper-raised text-ink">
        <Glyph id={sketch.transport.glyph} className="h-5 w-5" />
      </div>
    </div>
  );
}


/**
 * EXPERIENCE V2 — THE LIVE TRIP PROFILE.
 *
 * Not a ledger of every default: the strongest current decisions, each marked
 * as the traveller's own (filled mark) or Sidequest's read (hollow mark), and
 * open questions named as open. Above it, the map that reacts to those
 * decisions. The testids the browser battery reads (`sketch-shape`,
 * `sketch-transport`, `sketch-range`) stay on the same facts.
 */
function profileRows(sketch: Sketch): { key: string; label: string; value: string; assumed: boolean; open: boolean; testId?: string }[] {
  const rows: { key: string; label: string; value: string; assumed: boolean; open: boolean; testId?: string }[] = [];
  const lead = sketch.lines[0];
  if (lead) rows.push({ key: 'lead', label: 'Leads with', value: lead.text, assumed: lead.assumed, open: false });
  rows.push({ key: 'transport', label: 'Getting around', value: sketch.transport.label, assumed: sketch.transport.assumed, open: sketch.transport.open, testId: 'sketch-transport' });
  rows.push({ key: 'shape', label: 'Shape', value: sketch.shapeLabel, assumed: sketch.shapeAssumed, open: sketch.shapeOpen, testId: 'sketch-shape' });
  rows.push({ key: 'range', label: 'Reach', value: sketch.rangeLabel, assumed: sketch.rangeAssumed, open: sketch.rangeOpen, testId: 'sketch-range' });
  /*
   * The loose traits under one label rather than under none.
   *
   * These rows carried `label: ''`, so after four labelled rows the panel
   * ended with an unlabelled line that read as a missing field. Only the first
   * takes the heading; the rest continue under it, which is what a list of
   * further facts about one subject looks like.
   */
  sketch.lines.slice(1, 4).forEach((line, index) => {
    rows.push({ key: line.text, label: index === 0 ? 'Also' : '', value: line.text, assumed: line.assumed, open: false });
  });
  return rows;
}

function ProfileMark({ assumed, open }: { assumed: boolean; open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx('mt-2 inline-block h-2 w-2 shrink-0 rounded-full', open ? 'border border-dashed border-ink-faint' : assumed ? 'border border-ink-faint bg-paper' : 'bg-accent')}
    />
  );
}

export function TripProfileList({ sketch, compact = false }: { sketch: Sketch; compact?: boolean }) {
  const rows = profileRows(sketch);
  return (
    <div>
      <ul className="divide-y divide-rule" data-testid="trip-profile">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-2.5 py-2">
            <ProfileMark assumed={row.assumed} open={row.open} />
            <span className="min-w-0 flex-1">
              {row.label ? <span className="label block text-ink-faint">{row.label}</span> : null}
              <span className={cx('block text-sm leading-snug', row.open ? 'text-ink-faint' : 'text-ink')} {...(row.testId ? { 'data-testid': row.testId } : {})}>
                {row.value}
                {row.assumed && !row.open ? <span className="sr-only"> (Sidequest’s read)</span> : null}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {!compact ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" /> you said
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full border border-ink-faint bg-paper" /> Sidequest’s read
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full border border-dashed border-ink-faint" /> not decided yet
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** The conceptual-layer props the sketch hands the map. */
export function mapLayersFor(sketch: Sketch, answers: QuestionnaireAnswers): { bases: 1 | 2 | 3; movement: 'car' | 'transit_walk' | 'guided' | 'boat' | 'mixed' | null; dayTrips: 'stay_in_city' | 'one_day_trip' | 'several' | null } {
  const glyph = sketch.transport.glyph;
  const movement = sketch.transport.open ? null : glyph === 'car' ? (sketch.transport.label.startsWith('A car where') ? 'mixed' : 'car') : glyph === 'transit' ? 'transit_walk' : glyph === 'guide' ? 'guided' : glyph === 'boat' ? 'boat' : glyph === 'taxi' ? 'transit_walk' : null;
  const dayTrips = !sketch.rangeOpen && answers.dayTripAppetite ? answers.dayTripAppetite : null;
  return { bases: sketch.shapeOpen ? 1 : sketch.bases, movement, dayTrips };
}

export function TripSketchPanel({ ctx, answers, className, compact = false, geometry = null, tiles = null }: { ctx: InterviewContext; answers: QuestionnaireAnswers; className?: string; compact?: boolean; geometry?: DestinationGeometry | null; tiles?: MapBasemap | null }) {
  const sketch = sketchFor(ctx, answers);
  const layers = mapLayersFor(sketch, answers);
  return (
    <aside className={cx('min-w-0', className)} aria-label="Your trip so far" data-testid="trip-sketch">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-display text-xl leading-tight text-ink">{sketch.destination}</p>
        <p className="numeral shrink-0 text-xs text-ink-faint">
          {[sketch.scale, `${sketch.nights} ${sketch.nights === 1 ? 'night' : 'nights'}`].filter(Boolean).join(' · ')}
        </p>
      </div>
      {geometry ? (
        <DestinationMap geometry={geometry} tiles={tiles} shape={layers.bases > 1 ? 'moving' : 'stay_put'} rangeKm={sketch.rangeKm} bases={layers.bases} movement={layers.movement} dayTrips={layers.dayTrips} className="mt-3" />
      ) : (
        <SketchFigure sketch={sketch} className="mt-3" />
      )}
      <div className="mt-3">
        <TripProfileList sketch={sketch} compact={compact} />
      </div>
    </aside>
  );
}

/** On a phone: a sheet that opens from a slim bar. */
export function TripSketchSheet({ ctx, answers, geometry = null, tiles = null }: { ctx: InterviewContext; answers: QuestionnaireAnswers; geometry?: DestinationGeometry | null; tiles?: MapBasemap | null }) {
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
              {[!sketch.shapeOpen ? sketch.shapeLabel : null, !sketch.transport.open ? sketch.transport.label : null, !sketch.rangeOpen ? sketch.rangeLabel : null].filter(Boolean).join(' · ') || 'Nothing decided yet'}
            </span>
          </span>
        </span>
        <span className="text-sm text-accent">{open ? 'Hide' : 'Show'}</span>
      </button>
      <div id="trip-sketch-sheet-body" className={cx('enter mt-3', !open && 'hidden')}>
        <TripSketchPanel ctx={ctx} answers={answers} geometry={geometry} tiles={tiles} />
      </div>
    </div>
  );
}
