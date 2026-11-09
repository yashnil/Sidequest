'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dayOfStop, initialSelection, parseStoredSelection, reconcileSelection, selectionAnnouncement, type SelectionDay, type TripSelection } from './trip-selection-model';

/**
 * THE MAP AND THE ITINERARY ARE ONE THING, SELECTED ONCE.
 *
 * One provider above every hub view holds the day in focus and the stop that
 * was pressed (`trip-selection-model.ts` has the rules). The Days timeline, its
 * sticky map, the phone's map dock and the Map tab all read it, so:
 *
 *   - choosing a day anywhere draws and frames that day's route everywhere;
 *   - choosing a stop in the list marks its pin; choosing a pin marks its row;
 *   - switching tabs keeps both, because no tab owns them;
 *   - an edit re-renders the plan underneath and the selection is reconciled
 *     against it rather than reset (a moved stop keeps its selection, a removed
 *     one lets go of it);
 *   - a reload restores it (session storage, per trip, best effort — a private
 *     window or blocked storage simply starts fresh).
 *
 * Every deliberate change is also said aloud once, politely, because the map
 * is a picture and the answer to "what did that press do" must not be.
 */
export interface TripSelectionApi extends TripSelection {
  days: readonly SelectionDay[];
  /** Bumps on every deliberate choice, so a view that was elsewhere knows to follow. */
  revision: number;
  /** The day scrolled into view. Never deliberate, never announced, never moves another tab. */
  readDay: (day: number) => void;
  chooseDay: (day: number, source: 'list' | 'map') => void;
  chooseStop: (stopId: string, options: { source: 'list' | 'map'; day?: number }) => void;
  clearStop: () => void;
  /** The phone's map dock: open beside the list, or folded to its button. */
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
}

const Ctx = createContext<TripSelectionApi | null>(null);

export function useTripSelection(): TripSelectionApi | null {
  return useContext(Ctx);
}

function storageKeyFor(scope: string): string {
  return `sidequest:trip-selection:${scope}`;
}

function readStored(scope: string | null, days: readonly SelectionDay[]): TripSelection | null {
  if (!scope) return null;
  try {
    return parseStoredSelection(window.sessionStorage.getItem(storageKeyFor(scope)), days);
  } catch {
    return null;
  }
}

export function TripSelectionProvider({ days, storageScope = null, children }: { days: readonly SelectionDay[]; /** The trip id; absent on a shared copy, which remembers nothing. */ storageScope?: string | null; children: ReactNode }) {
  const [raw, setRaw] = useState<TripSelection>(() => initialSelection(days));
  const [revision, setRevision] = useState(0);
  const [dockOpen, setDockOpen] = useState(false);
  const [said, setSaid] = useState('');
  /* Reconciled on every render against the plan as it now is: an edit can never leave a dangling selection. */
  const selection = useMemo(() => reconcileSelection(raw, days), [raw, days]);
  const latest = useRef({ days, selection });
  useEffect(() => {
    latest.current = { days, selection };
  }, [days, selection]);

  /* Read back what this trip had selected, once, after hydration (the server cannot know). */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const stored = readStored(storageScope, latest.current.days);
    if (!stored) return;
    const apply = () => {
      setRaw(stored);
      setRevision((n) => n + 1);
    };
    apply();
  }, [storageScope]);

  useEffect(() => {
    if (!storageScope || !selection.chosen) return;
    try {
      window.sessionStorage.setItem(storageKeyFor(storageScope), JSON.stringify({ day: selection.day, stop: selection.stop }));
    } catch {
      /* Storage is a convenience; the page works without it. */
    }
  }, [storageScope, selection]);

  const commit = useCallback((next: TripSelection, source: 'list' | 'map') => {
    setRaw(next);
    setRevision((n) => n + 1);
    setSaid(selectionAnnouncement({ days: latest.current.days, selection: reconcileSelection(next, latest.current.days), source }));
  }, []);

  const api = useMemo<TripSelectionApi>(
    () => ({
      ...selection,
      days,
      revision,
      readDay: (day) => setRaw((current) => (current.day === day ? current : { ...current, day })),
      chooseDay: (day, source) => {
        const current = latest.current.selection;
        /* A stop on another day stops being the subject once a different day is chosen. */
        const keepsStop = current.stop !== null && dayOfStop(latest.current.days, current.stop, day) === day;
        commit({ day, stop: keepsStop ? current.stop : null, stopDay: keepsStop ? day : null, chosen: true }, source);
      },
      chooseStop: (stopId, options) => {
        const owner = dayOfStop(latest.current.days, stopId, options.day ?? latest.current.selection.day);
        commit({ day: owner ?? options.day ?? latest.current.selection.day, stop: stopId, stopDay: owner, chosen: true }, options.source);
        /*
         * Below `lg` a stop pressed in the list opens the map beside it and keeps
         * its row clear of the dock. On a wide screen the sticky map is already
         * there, and the dock must never be opened: it would build a second map
         * inside a hidden element.
         */
        if (options.source === 'list' && isNarrow()) {
          setDockOpen(true);
          keepRowClearOfDock(stopId, owner ?? undefined);
        }
      },
      clearStop: () => setRaw((current) => (current.stop === null ? current : { ...current, stop: null, stopDay: null })),
      dockOpen,
      setDockOpen,
    }),
    [selection, days, revision, dockOpen, commit],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <p role="status" aria-live="polite" className="sr-only" data-testid="trip-selection-status">
        {said}
      </p>
    </Ctx.Provider>
  );
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches;
}

function rowFor(stopId: string, dayNumber?: number): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(stopId) : stopId.replace(/"/g, '\\"');
  const scoped = dayNumber === undefined ? null : document.querySelector<HTMLElement>(`#hub-view-days [data-timeline-place="${escaped}"][data-day="${dayNumber}"]`);
  return scoped ?? document.querySelector<HTMLElement>(`#hub-view-days [data-timeline-place="${escaped}"]`) ?? document.querySelector<HTMLElement>(`[data-timeline-place="${escaped}"]`);
}

/**
 * The dock rises over the lower part of the list, which may be exactly where
 * the row just pressed is. Two frames, so the dock is laid out and the list has
 * made room for it; a row already clear of it is left where it is, and focus is
 * never moved.
 */
function keepRowClearOfDock(stopId: string, dayNumber?: number): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const row = rowFor(stopId, dayNumber);
      const dock = document.getElementById('day-map-dock');
      if (!row || !dock) return;
      if (row.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top - 8) return;
      const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }),
  );
}

/**
 * Bring a stop's row into view and mark the arrival.
 *
 * Shared by every map surface so they agree on where a row lands: below the
 * sticky chrome, above the phone's dock. Reduced motion jumps instead of
 * gliding and skips the flash. Focus follows, without a second scroll, so a
 * keyboard or screen-reader user is on the row they asked for.
 */
export function revealTimelineRow(stopId: string, dayNumber?: number): boolean {
  if (typeof document === 'undefined') return false;
  const row = rowFor(stopId, dayNumber);
  if (!row) return false;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wide = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
  /* Wide: the middle of the screen, beside the map. Narrow: just under the chrome, clear of the dock at the foot. */
  row.scrollIntoView({ block: wide ? 'center' : 'start', behavior: reduce ? 'auto' : 'smooth' });
  row.focus({ preventScroll: true });
  if (!reduce) {
    row.classList.remove('row-flash');
    /* Restart the animation when the same row is revealed twice in a row. */
    void row.offsetWidth;
    row.classList.add('row-flash');
    window.setTimeout(() => row.classList.remove('row-flash'), 1800);
  }
  return true;
}
