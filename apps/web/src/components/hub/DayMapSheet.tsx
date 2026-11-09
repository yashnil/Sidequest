'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AtlasMap } from '../atlas/AtlasMap';
import { planToAtlas } from '../atlas/atlas-model';
import { InteractiveMap } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
import { JourneyExplorer } from '../journey/JourneyExplorer';
import type { JourneyModel } from '@/lib/journey/model';
import type { DestinationImage as ImageRecord } from '@sidequest/core';
import type { DayFocusModel } from './DayFocus';

/**
 * THE DAY'S MAP BELOW `lg` — DOCKED BESIDE THE LIST, NOT INSTEAD OF IT.
 *
 * There is no room for a sticky column on a phone, and the first answer was a
 * full-screen dialog: the map *or* the list, never both, so "where is this
 * stop" cost a round trip and forgot the row you were reading. The three
 * options were weighed:
 *
 *   - a toggle between map and list — the same either/or with a nicer switch;
 *   - a mini-map pinned under the top chrome — a phone already has a sticky
 *     header, and a second band there leaves a strip of day (and sits exactly
 *     where the "day being read" is measured);
 *   - a dock at the thumb, above the tab bar — the list keeps the top of the
 *     screen and its scroll, the map keeps the bottom two-fifths, and each
 *     answers the other. Chosen.
 *
 * So: a button at the thumb opens the dock; the dock shows the day in focus
 * and follows it as you scroll; pressing a stop's number in the list marks its
 * pin (and opens the dock if it was folded); pressing a pin brings its row to
 * the top of the list and marks it, without closing anything. It is a region,
 * not a dialog — focus is never trapped and the page behind still scrolls —
 * with Escape and a close button to fold it. No map is created until it is
 * first opened, so a phone pays for no WebGL it never asked for. From `sm` up
 * the same dock floats bottom-right as a card.
 *
 * With a real basemap the dock offers "Full screen": the Journey Explorer as a
 * modal dialog, with the ribbon, 3D and Replay. A stop chosen there closes it
 * and lands on that stop's row.
 */
const subscribeNothing = () => () => {};

export function DayMapDock({
  day,
  dayNumbers,
  onDay,
  markedId,
  selectedId,
  onSelect,
  tiles,
  journey,
  photos = {},
  notDrawn,
  open,
  onOpenChange,
}: {
  day: DayFocusModel;
  dayNumbers: readonly number[];
  onDay: (dayNumber: number) => void;
  /** The pin to mark: the hovered row's, or the selected stop's. */
  markedId: string | null;
  /** The selected stop when it is on this day (the dock names it). */
  selectedId: string | null;
  onSelect: (placeId: string) => void;
  tiles: MapBasemap | null;
  journey: JourneyModel | null;
  photos?: Record<string, ImageRecord>;
  /** "Not on the map: …" for this day, or null. */
  notDrawn: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const region = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [full, setFull] = useState(false);
  /* The map is built the first time the dock opens and kept after, so folding and unfolding is instant. */
  const [everOpen, setEverOpen] = useState(open);
  if (open && !everOpen) setEverOpen(true);
  /* Shown only while the days themselves are on screen: over the trip's cover it would be a button about nothing. */
  const [daysOnScreen, setDaysOnScreen] = useState(false);
  /*
   * Portalled to the body: the hub's views animate in with a transform, and a
   * transformed ancestor turns `position: fixed` into "fixed to that ancestor",
   * which parked the button at the foot of the timeline under the last day.
   */
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);

  useEffect(() => {
    const list = document.querySelector('[data-day-focus]')?.closest('ol');
    if (!list || typeof IntersectionObserver === 'undefined') {
      const show = () => setDaysOnScreen(true);
      show();
      return;
    }
    const observer = new IntersectionObserver((entries) => setDaysOnScreen(entries.some((entry) => entry.isIntersecting)), { rootMargin: '-25% 0px -25% 0px' });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  /* The list makes room for the dock, so its last rows can still be scrolled clear of it. */
  useEffect(() => {
    if (!open) return;
    document.documentElement.dataset.mapDock = 'open';
    return () => {
      delete document.documentElement.dataset.mapDock;
    };
  }, [open]);

  if (!mounted) return null;

  const placed = day.markers.length > 0 || day.base !== null;
  const vector = tiles?.kind === 'vector' ? tiles : null;
  const index = dayNumbers.indexOf(day.dayNumber);
  const previous = index > 0 ? dayNumbers[index - 1]! : null;
  const next = index >= 0 && index < dayNumbers.length - 1 ? dayNumbers[index + 1]! : null;
  const selected = selectedId ? day.markers.find((marker) => marker.id === selectedId) ?? null : null;
  const fullScreen = vector && journey && journey.days.some((d) => d.stops.length > 0) ? { journey, styleId: vector.styleUrl } : null;

  const show = () => {
    onOpenChange(true);
    /* Opened from its own button: focus goes to the dock, so a keyboard or a screen reader is where the map is. */
    requestAnimationFrame(() => region.current?.focus({ preventScroll: true }));
  };
  const fold = () => {
    onOpenChange(false);
    requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  };
  const openFull = () => {
    setFull(true);
    dialog.current?.showModal();
  };
  const closeFull = () => dialog.current?.close();

  const atlas = vector && placed ? planToAtlas({ marks: day.markers, connectors: day.connectors, base: day.base ? { name: day.baseName, coordinates: day.base } : null }) : null;
  const summary = `Day ${day.dayNumber}: ${day.markers.length} ${day.markers.length === 1 ? 'stop' : 'stops'}, numbered in the order of the day${day.base ? ', from where you are staying' : ''}.`;

  return createPortal(
    <div className="day-map-sheet print:hidden" data-hub-day-map={day.dayNumber} data-dock={open ? 'open' : 'folded'}>
      {!open && daysOnScreen ? (
        <button
          ref={opener}
          type="button"
          onClick={show}
          aria-expanded={false}
          aria-controls="day-map-dock"
          className="fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 inline-flex min-h-12 items-center gap-2 rounded-full bg-night px-4 text-sm font-semibold text-bone shadow-float sm:bottom-6"
          data-testid="day-map-sheet-open"
        >
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-flare" />
          Map · day {day.dayNumber}
        </button>
      ) : null}

      <section
        ref={region}
        id="day-map-dock"
        tabIndex={-1}
        hidden={!open}
        aria-label={`Map of day ${day.dayNumber}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !full) {
            event.stopPropagation();
            fold();
          }
        }}
        className="day-map-dock fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 flex h-[min(44dvh,21rem)] flex-col overflow-hidden border-t border-bone/15 bg-night text-bone shadow-[0_-12px_32px_-18px_rgb(13_26_31/0.6)] outline-none sm:inset-x-auto sm:right-4 sm:bottom-4 sm:h-[22rem] sm:w-[26rem] sm:rounded-[var(--radius-plate)] sm:border"
        data-testid="day-map-dock"
        data-day={day.dayNumber}
      >
        <header className="flex shrink-0 items-center gap-1 border-b border-bone/10 pr-1 pl-2">
          <button type="button" onClick={() => previous !== null && onDay(previous)} disabled={previous === null} className={dockButton} aria-label={previous === null ? 'No earlier day' : `Day ${previous}`} data-testid="day-map-dock-prev">
            <span aria-hidden="true">‹</span>
          </button>
          <p className="min-w-0 flex-1 truncate text-sm" data-testid="day-map-dock-title">
            <span className="coordbar text-bone/65">Day {String(day.dayNumber).padStart(2, '0')}</span>
            <span className="ml-2 text-bone/90">{day.theme}</span>
          </p>
          <button type="button" onClick={() => next !== null && onDay(next)} disabled={next === null} className={dockButton} aria-label={next === null ? 'No later day' : `Day ${next}`} data-testid="day-map-dock-next">
            <span aria-hidden="true">›</span>
          </button>
          {fullScreen ? (
            <button type="button" onClick={openFull} className={dockButton} aria-label="Open the map full screen" data-testid="day-map-dock-expand">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
              </svg>
            </button>
          ) : null}
          <button type="button" onClick={fold} className={dockButton} aria-label="Hide the map" data-testid="day-map-dock-close">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          {!everOpen ? null : !placed ? (
            <p className="flex h-full items-center justify-center px-6 text-center text-sm text-bone/70" data-testid="day-map-dock-empty">
              Nothing on this day has a confirmed position yet, so there is nothing honest to draw.
            </p>
          ) : atlas ? (
            <AtlasMap
              className="absolute inset-0"
              testId="day-map-dock-atlas"
              ground="night"
              points={atlas.points}
              lines={atlas.lines}
              focusId={markedId}
              onSelect={(id) => (id === 'base' ? undefined : onSelect(id))}
              fitKey={`dock-${day.dayNumber}`}
              padding={{ top: 28, right: 32, bottom: 36, left: 32 }}
              ariaLabel={summary}
              fallback={<p className="p-6 text-sm text-bone/70">Drawing the day…</p>}
            />
          ) : (
            /* No basemap (or no WebGL): the same day as the honest figure, on paper, cut to the dock. */
            <div className="day-map-dock-figure absolute inset-0 overflow-hidden bg-paper-sunk">
              <InteractiveMap
                key={day.dayNumber}
                testId="day-map-dock-figure"
                chromeless
                markers={day.markers}
                connectors={day.connectors}
                base={day.base ? { name: day.baseName, coordinates: day.base } : null}
                focusedId={markedId}
                onFocus={onSelect}
                tiles={tiles}
                width={420}
                height={236}
                summary={summary}
              />
            </div>
          )}
        </div>

        <p className="shrink-0 truncate border-t border-bone/10 px-3 py-1.5 text-xs text-bone/75" data-testid="day-map-dock-status">
          {selected ? (
            <>
              <span className="coordbar text-flare">{selected.order === undefined ? 'Selected' : String(selected.order).padStart(2, '0')}</span>
              <span className="ml-2 text-bone">{selected.name}</span>
            </>
          ) : (
            (notDrawn ?? 'Press a number in the list, or a pin, to match them up.')
          )}
        </p>
      </section>

      {fullScreen ? (
        <dialog
          ref={dialog}
          onClose={() => setFull(false)}
          aria-label={`Map of day ${day.dayNumber}, full screen`}
          className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-night p-0 text-bone backdrop:bg-night/70"
          data-testid="day-map-sheet"
        >
          <div className="relative h-full w-full">
            {full ? (
              <JourneyExplorer
                model={fullScreen.journey}
                photos={photos}
                variant="sheet"
                styleId={fullScreen.styleId}
                dayNumber={day.dayNumber}
                onDayChange={onDay}
                selectedPlaceId={selectedId}
                onSelectStop={(stop) => {
                  if (!stop.placeId) return;
                  closeFull();
                  onSelect(stop.placeId);
                }}
                testId="day-map-sheet-journey"
              />
            ) : null}
            <div className="pointer-events-none absolute top-0 right-0 z-50 px-4 pt-[calc(1rem+env(safe-area-inset-top))]">
              <button type="button" onClick={closeFull} className="pointer-events-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-bone/30 bg-night/80 text-lg" aria-label="Close the full-screen map">
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </div>,
    document.body,
  );
}

const dockButton = 'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-lg text-bone/85 hover:text-bone disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-glacier';
