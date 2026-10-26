'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DestinationImage as ImageRecord } from '@sidequest/core';
import { DestinationImage, ImageCredit } from '../DestinationImage';
import { imageryFallbackFor } from '@sidequest/core';
import { cx } from '../ui';
import { JourneyMap, MODE_COLOUR, type JourneyMapHandle, type JourneyPin, type TerrainReport } from './JourneyMap';
import { legLabel, type JourneyDay, type JourneyLeg, type JourneyModel, type JourneyStop } from '@/lib/journey/model';
import { useReplay, type ReplayStep } from './useReplay';

/**
 * THE JOURNEY EXPLORER — the itinerary as a place you can move through.
 *
 * One component, three frames: the sticky map beside the Days timeline
 * (`sticky`, selection shared with the rows through `onSelectStop` /
 * `selectedPlaceId`), the full-width Journey view (`full`, the route ribbon is
 * the navigation), and the phone's full-screen dialog (`sheet`).
 *
 * Scales nest — whole trip → a stay (the days slept in one base) → a day → a
 * stop — and the camera travels between them rather than cutting. The numbers
 * are the timeline's numbers. Nothing here plans: the model is a projection of
 * the stored itinerary, so an edit re-renders a new drawing and a stale route
 * cannot survive it.
 */
export type JourneyScale = 'trip' | 'stay' | 'day';

export interface JourneyPhoto {
  image: ImageRecord;
}

export function JourneyExplorer({
  model,
  photos = {},
  variant,
  styleId,
  dayNumber: controlledDay,
  onDayChange,
  selectedPlaceId,
  onSelectStop,
  className,
  footer,
  testId = 'journey-explorer',
}: {
  model: JourneyModel;
  /** Licensed photographs by place id, already resolved on the server. */
  photos?: Record<string, ImageRecord>;
  variant: 'sticky' | 'full' | 'sheet';
  styleId?: string;
  /** When the Days timeline owns the day, it is passed in and reported back. */
  dayNumber?: number;
  onDayChange?: (dayNumber: number) => void;
  /** The stop the timeline has selected, by place id. */
  selectedPlaceId?: string | null;
  onSelectStop?: (stop: JourneyStop) => void;
  className?: string;
  footer?: ReactNode;
  testId?: string;
}) {
  const handle = useRef<JourneyMapHandle | null>(null);
  const [ownDay, setOwnDay] = useState(model.days[0]?.dayNumber ?? 1);
  const dayNumber = controlledDay ?? ownDay;
  const [scale, setScale] = useState<JourneyScale>(variant === 'full' ? 'trip' : 'day');
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const [selectedLeg, setSelectedLeg] = useState<string | null>(null);
  /* Which of the two was pressed last: a stop and a leg can both be "selected", the card shows the newer. */
  const [detailFocus, setDetailFocus] = useState<'stop' | 'leg'>('stop');
  const [terrain, setTerrain] = useState<{ on: boolean; busy: boolean; report: TerrainReport | null }>({ on: false, busy: false, report: null });
  const [keyOpen, setKeyOpen] = useState(false);
  const [ready, setReady] = useState(false);

  const day = model.days.find((d) => d.dayNumber === dayNumber) ?? model.days[0] ?? null;
  const stay = useMemo(() => model.bases.find((b) => b.dayNumbers.includes(dayNumber)) ?? null, [model.bases, dayNumber]);

  const pinIdOf = (stop: JourneyStop) => (stop.kind === 'base' ? stop.id : (stop.placeId ?? stop.id));
  const selectedId = selectedPlaceId !== undefined && selectedPlaceId !== null ? selectedPlaceId : ownSelected;

  /* What is drawn at each scale: the scope at full strength, the rest of the trip faint behind it. */
  const { pins, legs, focusPoints } = useMemo(() => buildScene(model, scale, day, stay?.dayNumbers ?? []), [model, scale, day, stay]);

  const changeDay = useCallback(
    (next: number) => {
      setOwnDay(next);
      onDayChange?.(next);
      setSelectedLeg(null);
    },
    [onDayChange],
  );

  /* The camera follows the scope. */
  const scopeKey = `${scale}:${scale === 'trip' ? 'all' : scale === 'stay' ? (stay?.id ?? '') : dayNumber}`;
  const lastScope = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !handle.current) return;
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    handle.current.fit(focusPoints, { ...(terrain.on ? { pitch: 55 } : {}) });
  }, [ready, scopeKey, focusPoints, terrain.on]);

  /* A stop selected anywhere (a pin, a row, the ribbon) brings the camera to it. */
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !handle.current || !selectedId || selectedId === lastSelected.current) return;
    lastSelected.current = selectedId;
    const pin = pins.find((p) => p.id === selectedId);
    if (pin) handle.current.flyTo(pin, { zoom: 15, ...(terrain.on ? { pitch: 60 } : {}) });
  }, [ready, selectedId, pins, terrain.on]);

  const selectStop = (id: string) => {
    if (id.startsWith('ctx:')) return;
    const stop = day?.stops.find((s) => pinIdOf(s) === id) ?? null;
    setOwnSelected(id);
    setSelectedLeg(null);
    setDetailFocus('stop');
    if (stop) onSelectStop?.(stop);
    if (stop === null && scale !== 'day') {
      /* A pin of another day, pressed in the trip or stay view: go to that day. */
      const owner = model.days.find((d) => d.stops.some((s) => pinIdOf(s) === id));
      if (owner) {
        changeDay(owner.dayNumber);
        setScale('day');
      }
    }
  };

  const toggleTerrain = async () => {
    if (!handle.current) return;
    setTerrain((t) => ({ ...t, busy: true }));
    const report = await handle.current.setTerrain(!terrain.on);
    setTerrain({ on: report.ok ? !terrain.on : false, busy: false, report: report.ok && terrain.on ? null : report });
  };

  /* Replay My Day. */
  const steps = useMemo<ReplayStep[]>(() => (day ? replaySteps(day) : []), [day]);
  const replay = useReplay({ steps, handle, terrainOn: terrain.on, overview: day ? day.stops.map((s) => s.point) : [] });
  const current = replay.active ? replay.step : null;
  const replayStop = current?.kind === 'stop' ? (day?.stops.find((s) => s.id === current.stopId) ?? null) : null;
  const replayLeg = current?.kind === 'leg' ? (day?.legs.find((l) => l.id === current.legId) ?? null) : null;

  const selectedStop = day?.stops.find((s) => pinIdOf(s) === selectedId) ?? null;
  const pickedLeg = selectedLeg ? (day?.legs.find((l) => l.id === selectedLeg) ?? null) : null;
  const shownStop = replay.active ? replayStop : scale === 'day' && !(pickedLeg && detailFocus === 'leg') ? selectedStop : null;
  /* A leg belongs to its day: at the trip or stay scale its card would describe a day no longer on screen. */
  const shownLeg = replay.active ? replayLeg : scale === 'day' && pickedLeg && (detailFocus === 'leg' || !selectedStop) ? pickedLeg : null;
  const modesHere = [...new Set((day?.legs ?? []).map((l) => l.mode))];

  if (!day) return null;
  const fallback = (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <p className="max-w-[34ch] text-sm text-bone/70">{ready ? '' : 'Drawing the journey…'}</p>
    </div>
  );

  return (
    <div className={cx('relative h-full w-full overflow-hidden bg-night text-bone', className)} data-testid={testId} data-scale={scale} data-day={day.dayNumber} data-terrain={terrain.on ? '3d' : '2d'} data-replay={replay.active ? (replay.playing ? 'playing' : 'paused') : 'off'}>
      <JourneyMap
        ref={handle}
        className="absolute inset-0"
        pins={replay.active ? pins.map((p) => ({ ...p, dim: p.dim || !replay.revealedPins.has(p.id) })) : pins}
        legs={replay.active ? legs.map((l) => ({ ...l, dim: !replay.revealedLegs.has(l.id) })) as JourneyLeg[] : legs}
        selectedId={replayStop ? pinIdOf(replayStop) : selectedId}
        activeLegId={shownLeg?.id ?? null}
        onSelect={selectStop}
        onLegSelect={(id) => {
          setSelectedLeg(id);
          setDetailFocus('leg');
        }}
        {...(styleId ? { styleId } : {})}
        padding={variant === 'full' ? { top: 140, right: 72, bottom: 190, left: 72 } : variant === 'sheet' ? { top: 120, right: 36, bottom: 210, left: 36 } : { top: 150, right: 64, bottom: 160, left: 64 }}
        ariaLabel={scale === 'trip' ? `The whole trip: ${model.days.length} days, ${model.bases.length} ${model.bases.length === 1 ? 'base' : 'bases'}.` : `Day ${day.dayNumber}: ${day.stops.filter((s) => s.kind === 'stop').length} stops, numbered in the order of the day.`}
        fallback={fallback}
        onReady={() => setReady(true)}
        testId={`${testId}-map`}
      />

      {/* THE HEADER: where you are in the journey, and the way back out of it. */}
      <div className={cx('pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-night via-night/75 to-transparent px-5 pt-4 pb-12', variant === 'sheet' && 'pt-[calc(1rem+env(safe-area-inset-top))] pr-16')}>
        <nav aria-label="Map scale" className="pointer-events-auto flex flex-wrap items-center gap-x-1 gap-y-1 coordbar text-bone/70" data-testid="journey-scale">
          <ScaleButton on={scale === 'trip'} onClick={() => setScale('trip')} testId="journey-scale-trip">Whole trip</ScaleButton>
          {model.bases.length > 1 && stay ? (
            <>
              <span aria-hidden="true">›</span>
              <ScaleButton on={scale === 'stay'} onClick={() => setScale('stay')} testId="journey-scale-stay">{stay.name}</ScaleButton>
            </>
          ) : null}
          <span aria-hidden="true">›</span>
          <ScaleButton on={scale === 'day'} onClick={() => setScale('day')} testId="journey-scale-day">Day {String(day.dayNumber).padStart(2, '0')}</ScaleButton>
        </nav>
        <p key={`${scale}-${day.dayNumber}`} className="mt-2 max-w-[30ch] font-display text-[1.55rem] leading-[1.08] font-light tracking-[-0.015em] text-bone fade-up">
          {scale === 'trip' ? `${model.days.length} days · ${model.bases.length === 1 ? 'one base' : `${model.bases.length} bases`}` : scale === 'stay' && stay ? `${stay.name} · ${stay.dayNumbers.length === 1 ? 'one day' : `days ${stay.dayNumbers[0]}–${stay.dayNumbers[stay.dayNumbers.length - 1]}`}` : day.theme}
        </p>
        {scale === 'day' ? <DayFigures day={day} /> : null}
      </div>

      {/* CONTROLS: 2D / 3D, Replay, the key. */}
      <div className={cx('absolute right-3 z-30 flex flex-col items-end gap-2', variant === 'sheet' ? 'top-[calc(4.25rem+env(safe-area-inset-top))]' : 'top-3')}>
        <div className="flex" role="group" aria-label="Map view">
          <button type="button" aria-pressed={!terrain.on} onClick={() => terrain.on && void toggleTerrain()} disabled={terrain.busy} className={cx(segment(!terrain.on))} data-testid="journey-2d">2D</button>
          <button type="button" aria-pressed={terrain.on} onClick={() => !terrain.on && void toggleTerrain()} disabled={terrain.busy || styleId === 'sidequest:fixture'} className={cx(segment(terrain.on), '-ml-px')} data-testid="journey-3d" title={styleId === 'sidequest:fixture' ? 'No elevation data on the test map' : 'Tilt the map over the terrain'}>
            3D
          </button>
        </div>
        {scale === 'day' && steps.length > 1 ? (
          <button type="button" onClick={() => (replay.active ? replay.exit() : replay.start())} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-flare px-4 text-sm font-semibold text-night shadow-float" data-testid="journey-replay">
            <span aria-hidden="true">{replay.active ? '■' : '▶'}</span>
            {replay.active ? 'Exit replay' : 'Replay my day'}
          </button>
        ) : null}
        <button type="button" onClick={() => setKeyOpen((o) => !o)} aria-expanded={keyOpen} className="inline-flex min-h-11 min-w-11 items-center justify-center border border-bone/25 bg-night/80 px-3 text-xs text-bone" data-testid="journey-key-toggle">
          Key
        </button>
        {keyOpen ? <Key modes={modesHere} /> : null}
        {terrain.report ? (
          <p className="max-w-[16rem] border border-bone/20 bg-night/90 px-3 py-2 text-right text-xs text-bone/80" role="status" data-testid="journey-terrain-status">
            {terrain.report.ok ? (terrain.report.minMetres !== null ? `Relief here: ${Math.max(0, terrain.report.minMetres).toLocaleString()}–${Math.max(0, terrain.report.maxMetres!).toLocaleString()} m above sea level.${terrain.report.maxMetres! - terrain.report.minMetres < 80 ? ' Flat ground — 3D adds little.' : ''}` : '') : `3D is unavailable: ${terrain.report.reason}`}
          </p>
        ) : null}
      </div>

      {/* WHAT IS SELECTED: a stop as a print, or a leg in words. */}
      {shownStop || shownLeg ? (
        <div className={cx('absolute z-20 w-[min(21rem,calc(100%-2rem))]', variant === 'full' ? 'bottom-[9.5rem] left-4' : variant === 'sheet' ? 'bottom-[12.5rem] left-4' : 'bottom-24 left-4')} aria-live="polite" data-testid="journey-detail">
          {shownStop ? <StopCard stop={shownStop} image={shownStop.placeId ? photos[shownStop.placeId] ?? null : null} /> : null}
          {!shownStop && shownLeg ? <LegCard leg={shownLeg} day={day} /> : null}
        </div>
      ) : null}

      {/* THE ROUTE RIBBON — the day as a line you can press along. */}
      {/* During a replay its controls take the ribbon's place; the step line says where the day is. */}
      {scale === 'day' && !replay.active ? (
        <Ribbon day={day} selectedId={replayStop ? pinIdOf(replayStop) : selectedId} activeLeg={shownLeg?.id ?? null} onStop={(stop) => selectStop(pinIdOf(stop))} onLeg={(leg) => {
          setSelectedLeg(leg.id);
          setDetailFocus('leg');
        }} compact={variant === 'sticky'} />
      ) : null}
      {scale !== 'day' ? <DayStrip model={model} scale={scale} stayDays={stay?.dayNumbers ?? []} current={day.dayNumber} onDay={(n) => { changeDay(n); setScale('day'); }} /> : null}

      {/* REPLAY CONTROLS. */}
      {replay.active ? (
        <div className="absolute inset-x-3 bottom-3 z-40 flex flex-wrap items-center gap-2 border border-bone/20 bg-night/95 px-3 py-2" role="group" aria-label="Replay controls" data-testid="journey-replay-controls">
          <button type="button" onClick={replay.previous} className={ctl} aria-label="Previous step">‹</button>
          <button type="button" onClick={replay.playing ? replay.pause : replay.resume} className={cx(ctl, 'min-w-20')} data-testid="journey-replay-toggle">{replay.playing ? 'Pause' : 'Play'}</button>
          <button type="button" onClick={replay.next} className={ctl} aria-label="Next step" data-testid="journey-replay-next">›</button>
          <button type="button" onClick={replay.cycleSpeed} className={ctl} data-testid="journey-replay-speed">{replay.speed}×</button>
          <p className="coordbar ml-2 min-w-0 flex-1 truncate text-bone/70" data-testid="journey-replay-step">
            Step {replay.index + 1} of {steps.length}
            {replay.step?.kind === 'stop' && replayStop ? ` · ${replayStop.title}` : replay.step?.kind === 'leg' && replayLeg ? ` · to ${day.stops.find((st) => st.id === replayLeg.to)?.title ?? 'the next stop'}` : ''}
            {replay.step?.kind === 'leg' && replayLeg && replayLeg.shape !== 'routed' ? ' · straight line, not the route' : ''}
            {replay.reducedMotion ? ' · motion reduced: step with ›' : ''}
          </p>
          <button type="button" onClick={replay.exit} className={ctl} data-testid="journey-replay-exit">Exit</button>
        </div>
      ) : null}
      {footer}
    </div>
  );
}

const ctl = 'inline-flex min-h-11 min-w-11 items-center justify-center border border-bone/25 px-3 text-sm text-bone hover:border-bone';

function segment(on: boolean) {
  return cx('inline-flex min-h-11 min-w-12 items-center justify-center border px-3 text-xs font-semibold tracking-[0.12em] disabled:opacity-50', on ? 'border-bone bg-bone text-night' : 'border-bone/30 bg-night/80 text-bone hover:border-bone');
}

function ScaleButton({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: ReactNode; testId: string }) {
  return (
    <button type="button" onClick={onClick} aria-current={on ? 'true' : undefined} className={cx('inline-flex min-h-9 items-center px-1.5 underline-offset-4', on ? 'text-bone' : 'text-bone/60 underline hover:text-bone')} data-testid={testId}>
      {children}
    </button>
  );
}

function DayFigures({ day }: { day: JourneyDay }) {
  const stops = day.stops.filter((s) => s.kind === 'stop').length;
  const routed = day.totals.routedLegs;
  return (
    <p className="coordbar mt-2 flex flex-wrap gap-x-4 gap-y-1 text-bone/65" data-testid="journey-day-figures">
      <span>{stops} {stops === 1 ? 'stop' : 'stops'}</span>
      <span>{day.totals.minutes === null ? 'moving time not all known' : `${formatMinutes(day.totals.minutes)} moving`}</span>
      <span>≈{Math.round(day.totals.km)} km</span>
      <span>{routed === day.totals.legs && routed > 0 ? 'every leg on its route' : routed > 0 ? `${routed} of ${day.totals.legs} legs on their route` : 'no route shapes — straight lines'}</span>
      {day.unplaced > 0 ? <span>{day.unplaced} not on the map</span> : null}
    </p>
  );
}

function StopCard({ stop, image }: { stop: JourneyStop; image: ImageRecord | null }) {
  return (
    <div className="fade-up">
      {image ? (
        <figure className="print-frame m-0" style={{ width: `min(100%, ${Math.round(170 * Math.max(0.62, Math.min(6, image.width / image.height)))}px)` }}>
          <DestinationImage image={image} fallback={imageryFallbackFor({ kind: 'candidate', id: stop.placeId ?? stop.id, name: stop.title })} ratio={image.width / image.height >= 0.62 && image.width / image.height <= 6 ? `${image.width} / ${image.height}` : 'natural'} credit="none" backdrop="paper" />
          <figcaption className="!font-sans !text-[10px] !normal-case !tracking-normal">
            <ImageCredit image={image} as="span" className="mt-0 inline" />
          </figcaption>
        </figure>
      ) : null}
      <div className={cx('bg-night/92 p-4 backdrop-blur-sm', image && 'mt-1.5')}>
        <p className="coordbar text-bone/60">
          {stop.kind === 'base' ? 'Where you sleep' : stop.kind === 'meal' ? 'Meal' : `Stop ${String(stop.number).padStart(2, '0')}`}
          {stop.start !== undefined ? ` · ${clock(stop.start)}${stop.end !== undefined ? `–${clock(stop.end)}` : ''}` : ''}
        </p>
        <p className="mt-1 font-display text-[1.45rem] leading-[1.08] tracking-[-0.015em]">{stop.title}</p>
        {stop.why ? <p className="mt-1.5 text-sm leading-relaxed text-bone/80">{stop.why}</p> : null}
        <p className="coordbar mt-2 text-bone/45">
          {Math.abs(stop.point.lat).toFixed(4)}° {stop.point.lat >= 0 ? 'N' : 'S'} · {Math.abs(stop.point.lng).toFixed(4)}° {stop.point.lng >= 0 ? 'E' : 'W'}
        </p>
      </div>
    </div>
  );
}

function LegCard({ leg, day }: { leg: JourneyLeg; day: JourneyDay }) {
  const from = day.stops.find((s) => s.id === leg.from);
  const to = day.stops.find((s) => s.id === leg.to);
  return (
    <div className="bg-night/94 p-4 fade-up" data-testid="journey-leg">
      <p className="coordbar flex items-center gap-2 text-bone/60">
        <span aria-hidden="true" className="inline-block h-1 w-6" style={{ background: MODE_COLOUR[leg.mode] }} />
        {leg.modeLabel}
      </p>
      <p className="mt-1 font-display text-lg leading-snug">
        {from?.title ?? 'Start'} → {to?.title ?? 'Next'}
      </p>
      <p className="mt-1.5 text-sm text-bone/80">{legLabel(leg, formatMinutes)}</p>
      <p className="mt-2 text-xs leading-relaxed text-bone/55">
        {leg.disconnected
          ? 'A flight or long crossing, drawn as an arc so it is never read as ground.'
          : leg.shape === 'routed'
            ? `The line is the route ${leg.shapeSource ? `${leg.shapeSource} returned` : 'a router returned'}${leg.time === 'measured' ? ', and the time was measured on it' : ''}.`
            : leg.time === 'unknown'
              ? 'Nobody has measured this leg. The dotted line joins the two places; it is not the way between them.'
              : 'The time is known; the way is not. The dashed line joins the two places and is not the road, path or rail.'}
      </p>
    </div>
  );
}

function Key({ modes }: { modes: readonly string[] }) {
  return (
    <div className="w-[15.5rem] border border-bone/20 bg-night/95 p-3 text-xs text-bone/85" data-testid="journey-key">
      <p className="sheet-label text-bone/60">Lines</p>
      <ul className="mt-2 space-y-1.5">
        <li className="flex items-center gap-2"><Swatch dash="solid" />Route as measured</li>
        <li className="flex items-center gap-2"><Swatch dash="dashed" />Straight line — time known or estimated</li>
        <li className="flex items-center gap-2"><Swatch dash="dotted" />Straight line — not measured</li>
        <li className="flex items-center gap-2"><Swatch dash="arc" />Flight or long crossing</li>
      </ul>
      {modes.length > 0 ? (
        <>
          <p className="sheet-label mt-3 text-bone/60">Colour is how you move</p>
          <ul className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
            {modes.map((mode) => (
              <li key={mode} className="flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-1 w-4" style={{ background: MODE_COLOUR[mode as keyof typeof MODE_COLOUR] }} />
                {MODE_WORD[mode] ?? mode}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

const MODE_WORD: Record<string, string> = { drive: 'Drive', walk: 'Walk', transit: 'Bus or shuttle', rail: 'Train', ferry: 'Ferry', flight: 'Flight', cycle: 'Bike', trail: 'Trail', transfer: 'Transfer', unknown: 'Not stated' };

function Swatch({ dash }: { dash: 'solid' | 'dashed' | 'dotted' | 'arc' }) {
  return (
    <svg aria-hidden="true" width="30" height="8" viewBox="0 0 30 8" className="shrink-0">
      {dash === 'arc' ? <path d="M1 7 Q15 -3 29 7" fill="none" stroke="#d7c8ff" strokeWidth="2" strokeDasharray="4 3" /> : <line x1="1" y1="4" x2="29" y2="4" stroke="#ff5a1f" strokeWidth={dash === 'solid' ? 3.5 : 2.4} strokeDasharray={dash === 'dashed' ? '5 3.5' : dash === 'dotted' ? '0.5 4' : undefined} strokeLinecap={dash === 'dotted' ? 'round' : 'butt'} />}
    </svg>
  );
}

/** The day along a line: base, legs and stops in order, every element pressable. */
function Ribbon({ day, selectedId, activeLeg, onStop, onLeg, compact }: { day: JourneyDay; selectedId: string | null; activeLeg: string | null; onStop: (stop: JourneyStop) => void; onLeg: (leg: JourneyLeg) => void; compact: boolean }) {
  const ordered: ({ type: 'stop'; stop: JourneyStop } | { type: 'leg'; leg: JourneyLeg })[] = [];
  for (const stop of day.stops) {
    const leg = stop.kind === 'base' ? undefined : day.legs.find((l) => l.to === stop.id);
    if (leg) ordered.push({ type: 'leg', leg });
    ordered.push({ type: 'stop', stop });
  }
  const back = day.legs.find((l) => l.to.startsWith('base:') && l.from !== l.to);
  if (back) ordered.push({ type: 'leg', leg: back });
  return (
    <nav aria-label={`Day ${day.dayNumber}, along the route`} className={cx('absolute inset-x-0 z-20 bg-gradient-to-t from-night via-night/90 to-transparent px-3 pt-8', compact ? 'bottom-8 pb-2' : 'bottom-8 pb-3')} data-testid="journey-ribbon">
      <ol className="no-scrollbar flex items-center overflow-x-auto pb-1">
        {ordered.map((entry) =>
          entry.type === 'stop' ? (
            <li key={entry.stop.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onStop(entry.stop)}
                aria-pressed={(entry.stop.placeId ?? entry.stop.id) === selectedId}
                className={cx('group flex min-h-11 items-center gap-2 px-1.5 text-left', (entry.stop.placeId ?? entry.stop.id) === selectedId && 'text-flare')}
                data-testid="journey-ribbon-stop"
              >
                <span aria-hidden="true" className={cx('atlas-pin !static shrink-0', entry.stop.kind === 'meal' && '!bg-glacier')} data-state={entry.stop.kind === 'base' ? 'base' : entry.stop.kind === 'meal' ? 'meal' : 'chosen'}>
                  {entry.stop.kind === 'base' ? '⌂' : entry.stop.number ?? ''}
                </span>
                <span className={cx('max-w-[9rem] truncate text-xs text-bone/85 group-hover:text-bone', compact && 'max-sm:hidden')}>{entry.stop.title}</span>
              </button>
            </li>
          ) : (
            <li key={entry.leg.id} className="flex shrink-0 items-center">
              <button type="button" onClick={() => onLeg(entry.leg)} aria-pressed={entry.leg.id === activeLeg} className="flex min-h-11 flex-col items-center justify-center px-1" title={legLabel(entry.leg, formatMinutes)} aria-label={legLabel(entry.leg, formatMinutes)} data-testid="journey-ribbon-leg">
                <svg aria-hidden="true" width="44" height="6" viewBox="0 0 44 6">
                  <line x1="0" y1="3" x2="44" y2="3" stroke={MODE_COLOUR[entry.leg.mode]} strokeWidth={entry.leg.id === activeLeg ? 4 : 2.5} strokeDasharray={entry.leg.shape === 'routed' && !entry.leg.disconnected ? undefined : entry.leg.time === 'unknown' ? '0.5 4' : '5 3.5'} strokeLinecap={entry.leg.time === 'unknown' ? 'round' : 'butt'} />
                </svg>
                <span className="coordbar mt-0.5 text-[9px] text-bone/55">{entry.leg.minutes === null ? '—' : `${entry.leg.time === 'estimated' ? '≈' : ''}${formatMinutes(entry.leg.minutes)}`}</span>
              </button>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

function DayStrip({ model, scale, stayDays, current, onDay }: { model: JourneyModel; scale: JourneyScale; stayDays: readonly number[]; current: number; onDay: (n: number) => void }) {
  const days = scale === 'stay' ? model.days.filter((d) => stayDays.includes(d.dayNumber)) : model.days;
  return (
    <nav aria-label="Days" className="absolute inset-x-0 bottom-8 z-20 bg-gradient-to-t from-night via-night/90 to-transparent px-3 pt-8 pb-2" data-testid="journey-days">
      <ol className="no-scrollbar flex overflow-x-auto">
        {days.map((d) => (
          <li key={d.dayNumber} className="min-w-[8.5rem] shrink-0 border-l border-bone/10 first:border-l-0">
            <button type="button" onClick={() => onDay(d.dayNumber)} className={cx('block min-h-11 w-full px-3 py-1.5 text-left hover:bg-white/5', d.dayNumber === current && 'text-flare')} data-testid="journey-day">
              <span className="block font-display text-xl leading-none font-light">{String(d.dayNumber).padStart(2, '0')}</span>
              <span className="mt-1 block truncate text-[11px] text-bone/70">{d.theme}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function buildScene(model: JourneyModel, scale: JourneyScale, day: JourneyDay | null, stayDays: readonly number[]) {
  const pins: JourneyPin[] = [];
  const legs: (JourneyLeg & { dim?: boolean })[] = [];
  const focusPoints: { lat: number; lng: number }[] = [];
  const inScope = (d: JourneyDay) => scale === 'trip' || (scale === 'stay' ? stayDays.includes(d.dayNumber) : d.dayNumber === day?.dayNumber);
  const seen = new Set<string>();
  for (const base of model.bases) {
    const scoped = scale === 'trip' || base.dayNumbers.some((n) => (scale === 'stay' ? stayDays.includes(n) : n === day?.dayNumber));
    pins.push({ id: scale === 'day' && day && base.dayNumbers.includes(day.dayNumber) ? `base:${day.dayNumber}` : `ctx:base:${base.id}`, lat: base.point.lat, lng: base.point.lng, label: `${base.name}, where you sleep${base.nights ? ` · ${base.nights} ${base.nights === 1 ? 'night' : 'nights'}` : ''}`, mark: '⌂', kind: 'base', dim: !scoped });
    if (scoped) focusPoints.push(base.point);
  }
  for (const d of model.days) {
    const scoped = inScope(d);
    for (const stop of d.stops) {
      if (stop.kind === 'base') continue;
      const id = stop.placeId ?? stop.id;
      if (seen.has(id)) continue;
      seen.add(id);
      if (scale === 'day' && !scoped) {
        pins.push({ id: `ctx:${id}`, lat: stop.point.lat, lng: stop.point.lng, label: `${stop.title}, day ${d.dayNumber}`, mark: '', kind: 'context', dim: true });
        continue;
      }
      pins.push({
        id,
        lat: stop.point.lat,
        lng: stop.point.lng,
        label: scale === 'day' ? (stop.kind === 'meal' ? `Meal: ${stop.title}` : `Stop ${stop.number}: ${stop.title}`) : `Day ${d.dayNumber}: ${stop.title}`,
        mark: scale === 'day' ? (stop.kind === 'meal' ? '' : String(stop.number ?? '')) : String(d.dayNumber),
        kind: stop.kind === 'meal' ? 'meal' : 'stop',
        dim: !scoped,
      });
      if (scoped) focusPoints.push(stop.point);
    }
    if (scale === 'day' && scoped) legs.push(...d.legs);
    if (scale !== 'day' && scoped) legs.push(...d.legs.filter((l) => l.shape === 'routed' || l.disconnected).map((l) => ({ ...l, id: `d${d.dayNumber}:${l.id}` })));
  }
  if (scale !== 'day') legs.push(...model.moves);
  if (focusPoints.length === 0 && day) focusPoints.push(...day.stops.map((s) => s.point));
  return { pins, legs: legs as JourneyLeg[], focusPoints };
}

function replaySteps(day: JourneyDay): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const start = day.stops[0];
  if (start) steps.push({ kind: 'stop', stopId: start.id, point: start.point, pinId: start.kind === 'base' ? start.id : (start.placeId ?? start.id) });
  for (const stop of day.stops.slice(1)) {
    const leg = day.legs.find((l) => l.to === stop.id);
    if (leg) steps.push({ kind: 'leg', legId: leg.id, leg, point: stop.point });
    steps.push({ kind: 'stop', stopId: stop.id, point: stop.point, pinId: stop.placeId ?? stop.id });
  }
  const back = day.legs.find((l) => l.to.startsWith('base:'));
  if (back) steps.push({ kind: 'leg', legId: back.id, leg: back, point: day.stops[0]!.point });
  steps.push({ kind: 'overview' });
  return steps;
}

function clock(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}
