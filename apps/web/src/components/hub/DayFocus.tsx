'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
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
}

const Ctx = createContext<DayFocusState | null>(null);

export function DayFocusProvider({ initial, children }: { initial: number; children: ReactNode }) {
  const [active, setActiveRaw] = useState(initial);
  const [focusedStop, setFocusedStop] = useState<string | null>(null);
  const pinned = useRef<number | null>(null);
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
          setActiveRaw(dayNumber);
          return;
        }
        if (pinned.current !== null) return;
        setActiveRaw(dayNumber);
      },
      focusedStop,
      setFocusedStop,
    }),
    [active, focusedStop],
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
      className={cx(focus && focus.active === dayNumber && 'lg:[&>*]:ring-1 lg:[&>*]:ring-accent/40')}
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
      className={cx(className, focus?.active === dayNumber && '!border-ink !bg-ink !text-paper')}
      aria-current={focus?.active === dayNumber ? 'true' : undefined}
      onClick={() => focus?.setActive(dayNumber, 'rail')}
    >
      {children}
    </a>
  );
}

/** The sticky map for the day in focus. Desktop only; nothing renders below `lg`. */
export function DayFocusMap({ days, tiles = null }: { days: readonly DayFocusModel[]; tiles?: MapBasemap | null }) {
  const focus = useDayFocus();
  const active = focus?.active ?? days[0]?.dayNumber ?? 1;
  const day = days.find((d) => d.dayNumber === active) ?? days[0];
  if (!day) return null;
  const placed = day.markers.length > 0 || day.base;
  return (
    <aside className="hidden lg:block" aria-label={`Map of day ${day.dayNumber}`} data-testid="day-focus-map">
      <div className="sticky top-[calc(var(--chrome-height)+3.75rem)]">
        <div className="flex items-baseline justify-between gap-3 pb-2">
          <p className="type-section text-ink">
            Day {day.dayNumber} <span className="font-sans text-sm text-ink-muted">· {day.theme}</span>
          </p>
          <span className="type-meta">{day.baseName}</span>
        </div>
        {placed ? (
          <InteractiveMap
            key={day.dayNumber}
            testId="day-focus-map-canvas"
            markers={day.markers}
            connectors={day.connectors}
            base={day.base ? { name: day.baseName, coordinates: day.base } : null}
            focusedId={focus?.focusedStop ?? null}
            onFocus={(id) => {
              focus?.setFocusedStop(id);
              const row = document.querySelector(`[data-timeline-place="${CSS.escape(id)}"][data-day="${day.dayNumber}"]`) ?? document.querySelector(`[data-timeline-place="${CSS.escape(id)}"]`);
              row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              (row as HTMLElement | null)?.focus?.({ preventScroll: true });
            }}
            tiles={tiles}
            width={560}
            height={520}
            summary={`${day.markers.length} ${day.markers.length === 1 ? 'stop' : 'stops'} on day ${day.dayNumber}, numbered in order${day.base ? ', from where you are staying' : ''}.`}
            caption={day.omitted > 0 ? <span>{day.omitted} {day.omitted === 1 ? 'stop is' : 'stops are'} not drawn: nobody publishes where {day.omitted === 1 ? 'it is' : 'they are'}.</span> : null}
          />
        ) : (
          /*
            A sentence, not an empty frame.
            This used to reserve the map's full 560×520 aspect and centre one
            line in it, so a plan with no resolved coordinates gave up nearly
            half the screen to a box with nothing in it. The reason to keep the
            aspect would be to avoid layout shift, and there is no shift here:
            nothing is loading, and nothing will arrive.
          */
          <p className="rounded-[var(--radius-card)] border border-dashed border-rule bg-paper-sunk px-4 py-3 type-small text-ink-muted">
            Nothing on this day has a confirmed position yet, so there is nothing honest to draw.
          </p>
        )}
      </div>
    </aside>
  );
}

/** Rows call this to light their pin on hover. */
export function StopFocusHandle({ placeId, children }: { placeId: string | undefined; children: ReactNode }) {
  const focus = useDayFocus();
  if (!placeId || !focus) return <>{children}</>;
  return (
    <div onPointerEnter={() => focus.setFocusedStop(placeId)} onPointerLeave={() => focus.setFocusedStop(null)} className={cx(focus.focusedStop === placeId && 'bg-pine-soft/40')}>
      {children}
    </div>
  );
}
