'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DayMapDock } from './DayMapSheet';
import { revealTimelineRow, useTripSelection } from './TripSelection';
import { unplacedSentence } from './trip-selection-model';
import { InteractiveMap, type MapConnector, type MapMarker } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
import { AtlasMap } from '../atlas/AtlasMap';
import { planToAtlas } from '../atlas/atlas-model';
import { JourneyExplorer } from '../journey/JourneyExplorer';
import type { JourneyModel, JourneyStop } from '@/lib/journey/model';
import type { DestinationImage as ImageRecord } from '@sidequest/core';
import { cx } from '../ui';

/**
 * PRODUCTION UI V1 — THE MAP FOLLOWS THE DAY YOU ARE READING.
 *
 * On a desktop the itinerary takes the left three-fifths and one sticky map
 * the right two-fifths. Scroll a day into view, hover it or press its heading
 * and the map redraws for that day; hover a stop's row and its pin lights;
 * press a pin and the row scrolls into view. Below `lg` the sticky map is not
 * rendered and each day keeps its own small map, as before.
 *
 * Everything drawn is computed on the server (`dayMapModel`) and passed in;
 * this component only decides which day's drawing is showing.
 */
export interface DayFocusModel {
  dayNumber: number;
  date: string;
  theme: string;
  baseName: string;
  base: { lat: number; lng: number } | null;
  markers: MapMarker[];
  connectors: MapConnector[];
  omitted: number;
}

interface DayFocusState {
  active: number;
  setActive: (dayNumber: number, source: 'scroll' | 'pointer' | 'rail') => void;
  focusedStop: string | null;
  setFocusedStop: (id: string | null) => void;
  /** The stop chosen — by a row, a pin or the ribbon — which every map marks. Hover never sets it. */
  selectedStop: string | null;
  /** `list`: a row or its number was pressed. `map`: a pin or a ribbon stop was. */
  selectStop: (id: string, source: 'list' | 'map', dayNumber?: number) => void;
}

const Ctx = createContext<DayFocusState | null>(null);

export function DayFocusProvider({ initial, children }: { initial: number; children: ReactNode }) {
  /*
   * RELEASE PASS — the day and the stop are the trip page's, not this view's.
   *
   * With a `TripSelectionProvider` above (the hub), both are read from it, so
   * the Map tab and the phone's dock see the same selection and an edit or a
   * tab change cannot lose it. Without one (a document test, a surface that
   * renders the days alone) this provider keeps them itself, exactly as before.
   */
  const shared = useTripSelection();
  const [localActive, setLocalActive] = useState(initial);
  const [focusedStop, setFocusedStop] = useState<string | null>(null);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const pinned = useRef<number | null>(null);
  const active = shared ? shared.day : localActive;
  const selectedStop = shared ? shared.stop : localSelected;
  const value = useMemo<DayFocusState>(
    () => ({
      active,
      setActive: (dayNumber, source) => {
        // A deliberate press wins over the scroll observer for a moment, so the map does not snap back mid-jump.
        if (source === 'rail' || source === 'pointer') {
          pinned.current = dayNumber;
          window.setTimeout(() => {
            if (pinned.current === dayNumber) pinned.current = null;
          }, 900);
          /* The rail is a choice; a pointer passing over a day is only reading it. */
          if (!shared) setLocalActive(dayNumber);
          else if (source === 'rail') shared.chooseDay(dayNumber, 'list');
          else shared.readDay(dayNumber);
          return;
        }
        if (pinned.current !== null) return;
        if (shared) shared.readDay(dayNumber);
        else setLocalActive(dayNumber);
      },
      focusedStop,
      setFocusedStop,
      selectedStop,
      selectStop: (id, source, dayNumber) => {
        if (shared) shared.chooseStop(id, { source, ...(dayNumber === undefined ? {} : { day: dayNumber }) });
        else setLocalSelected(id);
      },
    }),
    [active, focusedStop, selectedStop, shared],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDayFocus(): DayFocusState | null {
  return useContext(Ctx);
}

/** Wraps a day card: reports when it is the day most in view, or hovered. */
export function DayFocusTarget({ dayNumber, children }: { dayNumber: number; children: ReactNode }) {
  const focus = useDayFocus();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !focus || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio > 0) focus.setActive(dayNumber, 'scroll');
      },
      // The band a third of the way down the viewport: the day whose header passes it is the day being read.
      { rootMargin: '-30% 0px -55% 0px', threshold: [0, 0.01] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [dayNumber, focus]);
  return (
    <div
      ref={ref}
      data-day-focus={dayNumber}
      onPointerEnter={() => focus?.setActive(dayNumber, 'pointer')}
      onFocusCapture={() => focus?.setActive(dayNumber, 'pointer')}
      data-active={focus?.active === dayNumber || undefined}
    >
      {children}
    </div>
  );
}

/** A day-rail link that also drives the map. */
export function DayFocusLink({ dayNumber, className, children }: { dayNumber: number; className?: string; children: ReactNode }) {
  const focus = useDayFocus();
  return (
    <a
      href={`#day-${dayNumber}`}
      className={cx(className, focus?.active === dayNumber && '!border-flare !text-ink')}
      aria-current={focus?.active === dayNumber ? 'true' : undefined}
      onClick={() => focus?.setActive(dayNumber, 'rail')}
    >
      {children}
    </a>
  );
}

/** The sticky map for the day in focus. Desktop only; nothing renders below `lg`. */
export function DayFocusMap({ days, tiles = null, journey = null, photos = {} }: { days: readonly DayFocusModel[]; tiles?: MapBasemap | null; journey?: JourneyModel | null; photos?: Record<string, ImageRecord> }) {
  const focus = useDayFocus();
  const shared = useTripSelection();
  const active = focus?.active ?? days[0]?.dayNumber ?? 1;
  const day = days.find((d) => d.dayNumber === active) ?? days[0];
  if (!day) return null;
  const placed = day.markers.length > 0 || day.base;
  /* A pin (or a ribbon stop) pressed: the stop is selected for every view, and its row comes to you. */
  const openRow = (id: string) => {
    focus?.selectStop(id, 'map', day.dayNumber);
    revealTimelineRow(id, day.dayNumber);
  };
  /* The mark on the map: the row under the pointer while there is one, the chosen stop otherwise. */
  const selectedHere = focus?.selectedStop && day.markers.some((marker) => marker.id === focus.selectedStop) ? focus.selectedStop : null;
  const markedId = focus?.focusedStop ?? selectedHere ?? null;
  /* Stops with no position are named, not silently left off: absence is said, never drawn. */
  const notDrawn = unplacedSentence(shared?.days.find((entry) => entry.dayNumber === day.dayNumber)) ?? (day.omitted > 0 ? `${day.omitted} ${day.omitted === 1 ? 'stop is' : 'stops are'} not on the map — no confirmed position yet.` : null);
  const figure = placed ? (
    <InteractiveMap
      key={day.dayNumber}
      testId="day-focus-map-canvas"
      markers={day.markers}
      connectors={day.connectors}
      base={day.base ? { name: day.baseName, coordinates: day.base } : null}
      focusedId={markedId}
      onFocus={openRow}
      tiles={tiles}
      width={560}
      height={520}
      summary={`${day.markers.length} ${day.markers.length === 1 ? 'stop' : 'stops'} on day ${day.dayNumber}, numbered in order${day.base ? ', from where you are staying' : ''}.`}
      caption={notDrawn ? <span data-testid="day-map-unplaced">{notDrawn}</span> : null}
    />
  ) : null;
  const dayNumbers = days.map((d) => d.dayNumber);
  const goToDay = (n: number) => {
    focus?.setActive(n, 'rail');
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`day-${n}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  /* The phone's and the tablet's map: docked beside the list, the same day, the same selection. */
  const dock = (
    <DayMapDock
      day={day}
      dayNumbers={dayNumbers}
      onDay={goToDay}
      markedId={markedId}
      selectedId={selectedHere}
      onSelect={openRow}
      tiles={tiles}
      journey={journey}
      photos={photos}
      notDrawn={notDrawn}
      open={shared?.dockOpen ?? false}
      onOpenChange={(next) => shared?.setDockOpen(next)}
    />
  );

  /*
   * THE JOURNEY STAGE — when a vector basemap is configured.
   *
   * One night atlas for the whole trip, the height of the screen, that
   * travels: reading another day flies the camera to that day's ground and
   * draws its route again, leg by leg, in the evidence each leg has. The pins
   * carry the same numbers as the rows; pressing one brings its row into view.
   * Every day is drawn from the same server model the SVG figure uses, so the
   * two can never disagree about where anything is.
   */
  /*
   * THE JOURNEY EXPLORER — the sticky map beside the timeline, sharing its state.
   *
   * The day in view is the timeline's day; a row pressed is the stop the camera
   * flies to; a pin or a ribbon stop pressed brings its row into view and marks
   * it selected. Other days, the whole trip and Replay My Day are one press away,
   * and the explorer only ever draws the planner's own records.
   */
  if (tiles?.kind === 'vector' && journey && journey.days.some((d) => d.stops.length > 0)) {
    const select = (stop: JourneyStop) => {
      if (!stop.placeId) return;
      openRow(stop.placeId);
    };
    return (
      <>
        {dock}
        <aside className="hidden lg:block" aria-label={`Journey map, day ${day.dayNumber}`} data-testid="day-focus-map">
          {/* The frame ends above the floating "Ask Sidequest" button (fixed, bottom-right), which otherwise sat over the replay controls. */}
          <div className="sticky top-[calc(var(--chrome-height)+3.75rem)] h-[calc(100dvh_-_var(--chrome-height)_-_8.5rem)] min-h-[560px]">
            <JourneyExplorer
              model={journey}
              photos={photos}
              variant="sticky"
              styleId={tiles.styleUrl}
              dayNumber={day.dayNumber}
              onDayChange={goToDay}
              selectedPlaceId={focus?.selectedStop ?? null}
              onSelectStop={select}
              testId="day-journey"
            />
          </div>
        </aside>
      </>
    );
  }

  if (tiles?.kind === 'vector' && placed) {
    const { points, lines } = planToAtlas({
      marks: day.markers,
      connectors: day.connectors,
      base: day.base ? { name: day.baseName, coordinates: day.base } : null,
    });
    return (
      <>
      {dock}
      <aside className="hidden lg:block" aria-label={`Map of day ${day.dayNumber}`} data-testid="day-focus-map">
        <div className="sticky top-[calc(var(--chrome-height)+3.75rem)] h-[calc(100dvh_-_var(--chrome-height)_-_4.75rem)] min-h-[520px]">
          <AtlasMap
            className="absolute inset-0"
            testId="day-focus-atlas"
            ground="night"
            points={points}
            lines={lines}
            focusId={markedId}
            onSelect={(id) => (id === 'base' ? undefined : openRow(id))}
            fitKey={`day-${day.dayNumber}`}
            padding={{ top: 120, right: 72, bottom: 84, left: 72 }}
            ariaLabel={`Day ${day.dayNumber}: ${day.markers.length} ${day.markers.length === 1 ? 'stop' : 'stops'}, numbered in the order of the day${day.base ? ', from where you are staying' : ''}.`}
            fallback={figure}
          />
          <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 bg-gradient-to-b from-night/95 via-night/70 to-transparent px-6 pt-5 pb-10 text-bone">
            <p className="sheet-label text-bone/60">Day {String(day.dayNumber).padStart(2, '0')} · {day.baseName}</p>
            <p key={day.dayNumber} className="mt-1 max-w-[36ch] font-display text-[1.6rem] leading-tight font-light tracking-[-0.015em] fade-up">{day.theme}</p>
          </div>
          {notDrawn ? (
            <p className="absolute right-4 bottom-10 left-4 z-10 text-xs text-bone/70" data-testid="day-map-unplaced">
              {notDrawn}
            </p>
          ) : null}
        </div>
      </aside>
      </>
    );
  }

  return (
    <>
    {dock}
    <aside className="hidden lg:block" aria-label={`Map of day ${day.dayNumber}`} data-testid="day-focus-map">
      <div className="sticky top-[calc(var(--chrome-height)+3.75rem)]">
        <div className="flex items-baseline justify-between gap-3 pb-2">
          <p className="type-section text-ink">
            Day {day.dayNumber} <span className="font-sans text-sm text-ink-muted">· {day.theme}</span>
          </p>
          <span className="type-small text-ink-muted">{day.baseName}</span>
        </div>
        {figure ?? (
          /*
            A sentence, not an empty frame: a plan with no resolved coordinates
            must not give half the screen to a box with nothing in it.
          */
          <div className="atlas flex min-h-[12rem] items-center justify-center rounded-[var(--radius-plate)] px-6 py-8 text-center" data-testid="day-focus-map-empty">
            <p className="max-w-[32ch] type-small atlas-muted">Nothing on this day has a confirmed position yet, so there is nothing honest to draw.</p>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}

/** Rows call this to light their pin on hover, and to select the stop when the row is pressed. */
export function StopFocusHandle({ placeId, dayNumber, children }: { placeId: string | undefined; dayNumber?: number; children: ReactNode }) {
  const focus = useDayFocus();
  if (!placeId || !focus) return <>{children}</>;
  const selected = focus.selectedStop === placeId;
  return (
    <div
      onPointerEnter={(event) => {
        /* A finger is not a hover: on touch the row would stay "under the pointer" after the tap. */
        if (event.pointerType === 'mouse') focus.setFocusedStop(placeId);
      }}
      onPointerLeave={() => focus.setFocusedStop(null)}
      /*
       * Pressing a row (anywhere but its own controls) selects the stop, and every
       * map marks it. Its buttons and links keep their own meaning; the numbered
       * pin is the same act as a real button, for a keyboard and a screen reader.
       */
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a, button, input, select, textarea, summary, label, [role="dialog"]')) return;
        focus.selectStop(placeId, 'list', dayNumber);
      }}
      data-selected={selected || undefined}
      className={cx('transition-colors', focus.focusedStop === placeId && 'bg-[color-mix(in_srgb,var(--color-flare)_6%,transparent)]', selected && 'bg-[color-mix(in_srgb,var(--color-flare)_10%,transparent)] shadow-[inset_3px_0_0_var(--color-flare)]')}
    >
      {children}
    </div>
  );
}

/**
 * THE NUMBER IS THE BRIDGE — AND NOW IT IS A BUTTON.
 *
 * The same two digits sit on the row and on its pin. Pressing the row's number
 * selects the stop: the map beside the list (or the dock, on a phone) marks its
 * pin and brings it into frame. It is a real button — in the tab order, named
 * for what it does, `aria-pressed` while it is the selected stop — because a
 * row that only answers a mouse click is a feature a keyboard cannot reach.
 * Without a provider (a printed or shared document) it is the plain number.
 */
export function StopPinButton({ placeId, dayNumber, number, name, optional = false }: { placeId: string; dayNumber?: number; number: number; name: string; optional?: boolean }) {
  const focus = useDayFocus();
  const pin = cx('stop-pin mt-0.5 shrink-0', optional && 'stop-pin-optional');
  if (!focus) {
    return (
      <span aria-hidden="true" data-testid="stop-number" className={pin}>
        {number}
      </span>
    );
  }
  const selected = focus.selectedStop === placeId;
  return (
    <button
      type="button"
      data-testid="stop-number"
      data-stop-pin={placeId}
      aria-pressed={selected}
      aria-label={`Show ${name} on the map (stop ${number})`}
      title="Show on the map"
      onClick={() => focus.selectStop(placeId, 'list', dayNumber)}
      className={cx(pin, 'stop-pin-button print:pointer-events-none')}
    >
      {number}
    </button>
  );
}
