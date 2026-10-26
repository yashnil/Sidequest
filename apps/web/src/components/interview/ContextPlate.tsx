'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { InterviewContext, QuestionnaireAnswers } from '@sidequest/core';
import { AtlasMap, type AtlasLine, type AtlasPoint } from '../atlas/AtlasMap';
import type { AtlasLineStyle } from '../atlas/atlas-model';
import type { MapBasemap } from '../map-adapter';
import { cx } from '../ui';
import { PORTRAIT_S, timing } from './choreography';
import { frameKmFor, type DestinationGeometry } from './DestinationMap';
import { mapLayersFor, partyLine, sketchFor, type Sketch } from './TripSketch';
import { TRANSPORT_LINE } from './patterns';

/**
 * THE CONTEXT PLATE — THE MAP THAT ANSWERS.
 *
 * One plate beside every question (a slim band above it on a phone): the
 * destination on Sidequest's own survey cartography, redrawn from the answers
 * as they are given — and, while a question is open, from the answer the
 * traveller is *considering*, so the ring grows as they move along the reach
 * scale and the lines change dash as they move down the transport rows.
 *
 * Nothing here is a route. The ring is a reach (dashed flare: an estimate, not
 * a measurement), the spokes are an idea of how the days move (drawn in the
 * mode's own dash), hollow marks are bases nobody has chosen. The caption says
 * so once. Without a vector basemap, or while it loads, or where WebGL is
 * missing, the same layers are drawn as a schematic figure that says it is one.
 */

export type PlateFocus = 'interests' | 'pace' | 'reach' | 'transport' | 'shape' | 'effort' | 'budget' | 'food' | 'rules' | null;

const FOCUS_OF: Record<string, PlateFocus> = {
  priorities: 'interests',
  priority_roles: 'interests',
  day_shape: 'pace',
  day_start: 'pace',
  free_time: 'pace',
  scenic_reach: 'reach',
  day_trips: 'reach',
  daily_driving: 'reach',
  transport_mode: 'transport',
  transit_comfort: 'transport',
  road_comfort: 'transport',
  boats_ferries: 'transport',
  private_transfers: 'transport',
  base_moves: 'shape',
  coverage_strategy: 'shape',
  effort: 'effort',
  hike_appetite: 'effort',
  walking_tolerance: 'effort',
  stairs_hills: 'effort',
  budget: 'budget',
  convenience_spend: 'budget',
  food_tradeoff: 'food',
  dietary: 'food',
  special_meals: 'food',
  hard_constraints: 'rules',
};

export function plateFocusOf(questionId: string | null): PlateFocus {
  if (!questionId) return null;
  if (questionId.startsWith('priority_role:')) return 'interests';
  return FOCUS_OF[questionId] ?? null;
}

const FOCUS_LABEL: Record<Exclude<PlateFocus, null>, string> = {
  interests: 'Leads with',
  pace: 'A day holds',
  reach: 'Reach from base',
  transport: 'Getting around',
  shape: 'Shape',
  effort: 'Effort',
  budget: 'Spend',
  food: 'Food',
  rules: 'Hard rules',
};

function focusValue(focus: Exclude<PlateFocus, null>, sketch: Sketch, answers: QuestionnaireAnswers): { value: string; open: boolean } {
  switch (focus) {
    case 'interests': {
      const lead = sketch.lines[0];
      return lead && sketch.leadInterest ? { value: lead.text, open: false } : { value: 'Not chosen yet', open: true };
    }
    case 'pace':
      return { value: answers.pace === 'slow' ? 'One big thing' : answers.pace === 'fast' ? 'As much as fits' : 'Two or three things', open: false };
    case 'reach':
      return { value: sketch.rangeLabel, open: sketch.rangeOpen };
    case 'transport':
      return { value: sketch.transport.label, open: sketch.transport.open };
    case 'shape':
      return { value: sketch.shapeLabel, open: sketch.shapeOpen };
    case 'effort':
      return { value: answers.dailyIntensity === 'intense' ? 'Long days, real climbing' : answers.dailyIntensity === 'light' ? 'Easy on the legs' : 'Some miles, some climbing', open: false };
    case 'budget':
      return { value: answers.budgetStyle ? String(answers.budgetStyle).replace(/_/g, ' ') : 'Not decided yet', open: !answers.budgetStyle };
    case 'food':
      return { value: answers.foodStyle === 'destination' ? 'Will cross town for a meal' : answers.foodStyle === 'budget' ? 'Food is fuel' : 'Good food on the way', open: false };
    case 'rules':
      return { value: answers.hardConstraints.length === 0 ? 'None yet' : `${answers.hardConstraints.length} hard ${answers.hardConstraints.length === 1 ? 'rule' : 'rules'}`, open: answers.hardConstraints.length === 0 };
  }
}

/** The atlas line style a way of moving is drawn in. All conceptual; none of them is a measured leg. */
function lineStyleFor(movement: ReturnType<typeof mapLayersFor>['movement']): AtlasLineStyle {
  if (movement === 'transit_walk') return 'rail';
  if (movement === 'boat') return 'boat';
  if (movement === 'guided') return 'trail';
  if (movement === 'car' || movement === 'mixed') return 'estimated';
  return 'unmeasured';
}

/** The transport answer's own key, for the schematic figure's dash. */
function transportKey(sketch: Sketch, movement: ReturnType<typeof mapLayersFor>['movement']): string | null {
  if (sketch.transport.open) return null;
  if (movement === 'transit_walk') return sketch.transport.glyph === 'taxi' ? 'taxis' : 'transit_walk';
  if (movement === 'boat') return 'boats_transfers';
  if (movement === 'guided') return 'guided';
  if (movement === 'mixed') return 'mixed';
  if (movement === 'car') return 'rent_car';
  return null;
}

function destinationPoint(center: { lat: number; lng: number }, km: number, bearingDeg: number) {
  const dLat = (km / 111) * Math.cos((bearingDeg * Math.PI) / 180);
  const dLng = ((km / 111) * Math.sin((bearingDeg * Math.PI) / 180)) / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  return { lat: center.lat + dLat, lng: center.lng + dLng };
}

export function ContextPlate({
  ctx,
  answers,
  geometry = null,
  tiles = null,
  questionId = null,
  className,
  notes = true,
  size = 'band',
  answerText = null,
}: {
  ctx: InterviewContext;
  /** The answers as they stand — or as they would stand with the answer being considered. */
  answers: QuestionnaireAnswers;
  geometry?: DestinationGeometry | null;
  tiles?: MapBasemap | null;
  /** The open question, so the plate can show the fact that question is about. */
  questionId?: string | null;
  className?: string;
  /** The ruled field notes under the map (wide screens). */
  notes?: boolean;
  /** The open question's answer in words (`describeAnswer`), for the facts the sketch does not draw. */
  answerText?: string | null;
  /** How tall the plate stands below the wide layout: a slim band over a question, a short portrait elsewhere. */
  size?: 'band' | 'portrait';
}) {
  const reduced = useReducedMotion();
  /* One element at every width: the coordinate bar only where there is room for it. */
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const apply = () => setWide(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  const band = !wide;
  const sketch = sketchFor(ctx, answers);
  const layers = mapLayersFor(sketch, answers);
  const focus = plateFocusOf(questionId);
  const drawn = focus === 'reach' || focus === 'transport' || focus === 'shape' || focus === 'interests';
  const fact = focus ? { label: FOCUS_LABEL[focus], ...(answerText && !drawn ? { value: answerText, open: false } : focusValue(focus, sketch, answers)) } : null;
  const vector = tiles && tiles.kind === 'vector' ? tiles : null;
  const style = lineStyleFor(layers.movement);
  const key = transportKey(sketch, layers.movement);

  const drawing = useMemo(() => {
    if (!geometry) return null;
    const c = geometry.center;
    const b = geometry.bounds ?? null;
    const urban = geometry.featureType === 'city' || geometry.featureType === 'town' || geometry.featureType === 'district' || geometry.featureType === 'neighbourhood';
    const scaleKm = sketch.rangeKm ?? (b ? Math.max(6, kmBetween(b.southWest, b.northEast) / 3) : frameKmFor(geometry) / 2);
    const clamp = (p: { lat: number; lng: number }) => {
      if (!b) return p;
      const iLat = (b.northEast.lat - b.southWest.lat) * 0.08;
      const iLng = (b.northEast.lng - b.southWest.lng) * 0.08;
      return { lat: Math.min(b.northEast.lat - iLat, Math.max(b.southWest.lat + iLat, p.lat)), lng: Math.min(b.northEast.lng - iLng, Math.max(b.southWest.lng + iLng, p.lng)) };
    };
    const points: AtlasPoint[] = [{ id: 'base', lat: c.lat, lng: c.lng, label: `${geometry.name} — where the trip is centred`, state: 'base' }];
    const lines: AtlasLine[] = [];
    if (sketch.rangeKm !== null) {
      const ring: [number, number][] = [];
      for (let i = 0; i <= 72; i += 1) {
        const p = destinationPoint(c, sketch.rangeKm, (i / 72) * 360);
        ring.push([p.lng, p.lat]);
      }
      lines.push({ id: 'reach', coords: ring, style: 'estimated' });
      /* The ring's four ticks frame the camera on the reach: the map answers the question. */
      [0, 90, 180, 270].forEach((bearing, i) => {
        const p = destinationPoint(c, sketch.rangeKm!, bearing);
        points.push({ id: `reach-${i}`, lat: p.lat, lng: p.lng, label: 'Edge of the reach you chose', state: 'muted' });
      });
    } else if (b) {
      const corners = [b.southWest, { lat: b.southWest.lat, lng: b.northEast.lng }, b.northEast, { lat: b.northEast.lat, lng: b.southWest.lng }];
      lines.push({ id: 'frame', coords: [...corners, corners[0]!].map((p) => [p.lng, p.lat] as [number, number]), style: 'unmeasured' });
      corners.forEach((p, i) => points.push({ id: `frame-${i}`, lat: p.lat, lng: p.lng, label: 'Corner of the destination’s published extent', state: 'muted' }));
    } else {
      const km = frameKmFor(geometry);
      [45, 225].forEach((bearing, i) => {
        const p = destinationPoint(c, km * 1.2, bearing);
        points.push({ id: `frame-${i}`, lat: p.lat, lng: p.lng, label: 'Edge of the frame', state: 'muted' });
      });
    }
    /* A moving route: hollow marks for bases nobody has chosen, joined by a dotted idea of a move. */
    if (layers.bases >= 2) {
      const second = clamp(destinationPoint(c, scaleKm * 0.8, 62));
      points.push({ id: 'base-2', lat: second.lat, lng: second.lng, label: 'A second base, still to be chosen', mark: '02', state: 'idle' });
      lines.push({ id: 'move-1', coords: [[c.lng, c.lat], [second.lng, second.lat]], style: 'unmeasured' });
      if (layers.bases >= 3) {
        const third = clamp(destinationPoint(c, scaleKm * 0.9, 150));
        points.push({ id: 'base-3', lat: third.lat, lng: third.lng, label: 'A third base, still to be chosen', mark: '03', state: 'idle' });
        lines.push({ id: 'move-2', coords: [[second.lng, second.lat], [third.lng, third.lat]], style: 'unmeasured' });
      }
    }
    /* How the days move: short spokes from the base, in the mode's own dash. */
    if (!sketch.transport.open) {
      const reach = scaleKm * (layers.dayTrips === 'several' ? 1.5 : layers.dayTrips === 'one_day_trip' ? 1.2 : urban ? 0.45 : 0.6);
      const count = layers.dayTrips === 'several' ? 3 : layers.dayTrips === 'one_day_trip' ? 1 : 5;
      for (let i = 0; i < count; i += 1) {
        const end = clamp(destinationPoint(c, reach, (count === 1 ? 300 : 20) + i * (360 / Math.max(count, 3))));
        lines.push({ id: `spoke-${i}`, coords: [[c.lng, c.lat], [end.lng, end.lat]], style });
      }
    }
    return { points, lines };
  }, [geometry, sketch.rangeKm, sketch.transport.open, layers.bases, layers.dayTrips, style]);

  const fitKey = `${sketch.rangeKm ?? 'none'}|${layers.bases}|${layers.dayTrips ?? ''}`;
  const summary = geometry
    ? `${geometry.name}. ${sketch.rangeKm !== null ? `A ring shows the reach you chose: ${sketch.rangeLabel.toLowerCase()}.` : 'No reach drawn yet.'} ${sketch.transport.open ? '' : `Lines show getting around: ${sketch.transport.label.toLowerCase()}.`} Nothing drawn here is a route.`
    : `${sketch.destination}, not yet placed on a map.`;

  const figure = <PlateFigure sketch={sketch} bases={layers.bases} transport={key} name={sketch.destination} />;

  return (
    <aside className={cx('min-w-0', className)} aria-label="Your trip so far" data-testid="trip-sketch">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate font-display text-xl leading-none text-ink lg:text-2xl">{sketch.destination}</p>
        <p className="coordbar shrink-0 text-ink-muted">
          {sketch.nights} {sketch.nights === 1 ? 'night' : 'nights'} · {partyLine(ctx.traveller)}
        </p>
      </div>
      <div className={cx('ob-plate', size === 'band' ? 'h-36 sm:h-48' : 'h-56 sm:h-72', 'lg:h-[min(58vh,34rem)] lg:min-h-80')}>
        {geometry && vector && drawing ? (
          <AtlasMap
            className="absolute inset-0"
            testId="context-atlas"
            ground="survey"
            points={drawing.points}
            lines={drawing.lines}
            fitKey={fitKey}
            padding={band ? 18 : 44}
            coordinateBar={!band}
            controls={!band}
            drawRoute={false}
            maxZoom={13}
            ariaLabel={summary}
            fallback={figure}
          />
        ) : (
          <div className="absolute inset-0" role="img" aria-label={summary}>
            {figure}
          </div>
        )}
        {/* Registration corners: a plate, not a widget. */}
        <span aria-hidden="true" className="ob-plate-corner top-2 left-2 border-t-2 border-l-2" />
        <span aria-hidden="true" className="ob-plate-corner right-2 bottom-2 border-r-2 border-b-2" />
        <AnimatePresence initial={false} mode="popLayout">
          {fact ? (
            <motion.div
              key={`${fact.label}:${fact.value}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={timing(PORTRAIT_S, reduced)}
              className={cx('ob-fact pointer-events-none absolute z-10 max-w-[75%]', band ? 'top-2.5 left-2.5 px-2 py-1' : 'bottom-10 left-4')}
              aria-hidden="true"
            >
              <p className="sheet-label text-[9.5px] text-ink-muted">{fact.label}</p>
              <p className={cx('font-display leading-tight', band ? 'text-sm' : 'text-xl', fact.open ? 'text-ink-faint' : 'text-ink')}>{fact.value}</p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {notes ? (
        <div className="hidden lg:block">
          <FieldNotes sketch={sketch} />
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The plate's field notes: the settled facts as ruled rows, each marked as the
 * traveller's own (filled square) or Sidequest's read (hollow). The test ids
 * the browser suite reads (`sketch-shape`, `sketch-transport`, `sketch-range`)
 * stay on the same facts.
 */
function FieldNotes({ sketch }: { sketch: Sketch }) {
  const reduced = useReducedMotion();
  const rows: { key: string; label: string; value: string; assumed: boolean; open: boolean; testId?: string }[] = [];
  const lead = sketch.lines[0];
  if (lead && sketch.leadInterest) rows.push({ key: 'lead', label: 'Leads with', value: lead.text, assumed: lead.assumed, open: false });
  rows.push({ key: 'transport', label: 'Getting around', value: sketch.transport.label, assumed: sketch.transport.assumed, open: sketch.transport.open, testId: 'sketch-transport' });
  rows.push({ key: 'shape', label: 'Shape', value: sketch.shapeLabel, assumed: sketch.shapeAssumed, open: sketch.shapeOpen, testId: 'sketch-shape' });
  rows.push({ key: 'range', label: 'Reach', value: sketch.rangeLabel, assumed: sketch.rangeAssumed, open: sketch.rangeOpen, testId: 'sketch-range' });
  return (
    <div className="mt-4">
      <dl className="ruled border-t-[1.5px] border-ink" data-testid="trip-profile">
        {rows.map((row) => (
          <motion.div key={row.key} layout="position" transition={timing(PORTRAIT_S, reduced)} className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-3 py-2">
            <dt className="sheet-label flex items-center gap-2 text-[10px] text-ink-muted">
              <span aria-hidden="true" className={cx('inline-block h-2 w-2 shrink-0', row.open ? 'border border-dashed border-ink-faint' : row.assumed ? 'border border-ink' : 'bg-flare')} />
              {row.label}
            </dt>
            <dd className={cx('min-w-0 text-sm leading-snug', row.open ? 'text-ink-faint' : 'text-ink')} {...(row.testId ? { 'data-testid': row.testId } : {})}>
              {row.value}
              {row.assumed && !row.open ? <span className="sr-only"> (Sidequest’s read)</span> : null}
            </dd>
          </motion.div>
        ))}
      </dl>
      <p className="coordbar mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ink-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 bg-flare" /> you said
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 border border-ink" /> our read
        </span>
        <span>Lines are ideas, not routes</span>
      </p>
    </div>
  );
}

/**
 * The schematic: the same layers drawn without a basemap. The ring's radius
 * animates (CSS `r`), the spokes take the transport answer's dash, hollow
 * squares are bases to be chosen. Labelled as a schematic, never as a map.
 */
function PlateFigure({ sketch, bases, transport, name }: { sketch: Sketch; bases: 1 | 2 | 3; transport: string | null; name: string }) {
  const W = 400;
  const H = 400;
  const cx0 = 200;
  const cy0 = 214;
  const r = sketch.rangeKm === null ? 0 : 24 + Math.min(150, Math.sqrt(sketch.rangeKm) * 12);
  const line = transport ? TRANSPORT_LINE[transport] : null;
  const spokeLen = r > 0 ? r * 0.8 : 70;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <pattern id="ob-grid" width={40} height={40} patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="#0f1b20" strokeOpacity={0.08} strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="#ece5d6" />
      <rect width={W} height={H} fill="url(#ob-grid)" />
      {[60, 110, 160, 210].map((rr, i) => (
        <circle key={rr} cx={cx0 + 30} cy={cy0 - 20} r={rr} fill="none" stroke="#b7a88d" strokeOpacity={0.35 - i * 0.06} strokeWidth={1} />
      ))}
      <circle className="ob-ring" cx={cx0} cy={cy0} r={r} fill="#ff5a1f" fillOpacity={0.07} stroke="#ff5a1f" strokeWidth={2} strokeDasharray="7 5" opacity={r > 0 ? 1 : 0} />
      {line
        ? [0, 1, 2, 3, 4].map((i) => {
            const a = ((20 + i * 72) * Math.PI) / 180;
            return <line key={i} x1={cx0} y1={cy0} x2={cx0 + Math.sin(a) * spokeLen} y2={cy0 - Math.cos(a) * spokeLen} stroke={line.color} strokeWidth={2} strokeDasharray={line.dash} strokeLinecap="round" />;
          })
        : null}
      {bases >= 2 ? <line x1={cx0} y1={cy0} x2={300} y2={130} stroke="#0f1b20" strokeWidth={1.5} strokeDasharray="1 4" strokeLinecap="round" /> : null}
      {bases >= 3 ? <line x1={300} y1={130} x2={318} y2={300} stroke="#0f1b20" strokeWidth={1.5} strokeDasharray="1 4" strokeLinecap="round" /> : null}
      {bases >= 2 ? <rect x={292} y={122} width={16} height={16} fill="#ece5d6" stroke="#0f1b20" strokeWidth={1.5} /> : null}
      {bases >= 3 ? <rect x={310} y={292} width={16} height={16} fill="#ece5d6" stroke="#0f1b20" strokeWidth={1.5} /> : null}
      <rect x={cx0 - 8} y={cy0 - 8} width={16} height={16} fill="#f1ebdf" stroke="#0f1b20" strokeWidth={2} />
      <text x={cx0} y={cy0 + 30} textAnchor="middle" fontSize={15} fill="#0f1b20" fontFamily="var(--font-display)">
        {name}
      </text>
      <text x={16} y={H - 14} fontSize={9} fill="#4a4f4d" letterSpacing={1.4} fontFamily="var(--font-mono)">
        SCHEMATIC · NOT TO SCALE{sketch.rangeKm === null ? '' : ' · RING = REACH'}
      </text>
    </svg>
  );
}

function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
