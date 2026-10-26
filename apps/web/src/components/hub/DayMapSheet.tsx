'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AtlasMap, type AtlasLine, type AtlasPoint } from '../atlas/AtlasMap';
import { JourneyExplorer } from '../journey/JourneyExplorer';
import type { JourneyModel, JourneyStop } from '@/lib/journey/model';
import type { DestinationImage as ImageRecord } from '@sidequest/core';

/**
 * THE DAY'S MAP ON A PHONE — one press away, the whole screen when open.
 *
 * Below `lg` there is no room for a sticky map beside the timeline, and a map
 * squeezed above it would leave a phone with three sticky bands and a strip of
 * day. So the day you are reading keeps a button at the thumb, and the map
 * opens as a native modal dialog: focus moves into it, Escape and the close
 * button return it, and the page behind does not scroll. The map itself is not
 * created until the dialog opens, so a phone pays for no WebGL it never asks
 * for. Pressing a numbered pin closes the sheet and brings that stop's row into
 * view.
 */
const subscribeNothing = () => () => {};

type SheetProps =
  | { dayNumber: number; theme: string; points: readonly AtlasPoint[]; lines: readonly AtlasLine[]; onSelect: (id: string) => void; journey?: undefined }
  | { dayNumber: number; theme: string; journey: JourneyModel; photos?: Record<string, ImageRecord>; styleId?: string; onSelect: (stop: JourneyStop) => void };

export function DayMapSheet(props: SheetProps) {
  const { dayNumber, theme } = props;
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [open, setOpen] = useState(false);
  /*
   * Portalled to the body: the hub's views animate in with a transform, and a
   * transformed ancestor turns `position: fixed` into "fixed to that ancestor",
   * which parked the button at the foot of the timeline under the last day.
   */
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const host = mounted ? document.body : null;
  const show = () => {
    setOpen(true);
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
  };
  if (!host) return null;
  return createPortal(
    <div className="day-map-sheet print:hidden" data-hub-day-map={dayNumber}>
      <button
        type="button"
        onClick={show}
        className="fixed right-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 inline-flex min-h-12 items-center gap-2 rounded-full bg-night px-4 text-sm font-semibold text-bone shadow-float"
        data-testid="day-map-sheet-open"
      >
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-flare" />
        Map · day {dayNumber}
      </button>
      <dialog
        ref={dialog}
        onClose={() => setOpen(false)}
        aria-label={`Map of day ${dayNumber}`}
        className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-night p-0 text-bone backdrop:bg-night/70"
        data-testid="day-map-sheet"
      >
        <div className="relative h-full w-full">
          {open && props.journey ? (
            <JourneyExplorer
              model={props.journey}
              photos={props.photos ?? {}}
              variant="sheet"
              {...(props.styleId ? { styleId: props.styleId } : {})}
              dayNumber={dayNumber}
              onSelectStop={(stop) => {
                close();
                props.onSelect(stop);
              }}
              testId="day-map-sheet-journey"
            />
          ) : open && !props.journey ? (
            <AtlasMap
              className="absolute inset-0"
              testId="day-map-sheet-atlas"
              ground="night"
              points={props.points}
              lines={props.lines}
              onSelect={(id) => {
                close();
                props.onSelect(id);
              }}
              fitKey={`sheet-${dayNumber}`}
              padding={{ top: 96, right: 40, bottom: 72, left: 40 }}
              ariaLabel={`Day ${dayNumber}: stops numbered in the order of the day.`}
              fallback={<p className="p-6 text-sm text-bone/70">Drawing the day…</p>}
            />
          ) : null}
          <div className={props.journey ? 'pointer-events-none absolute top-0 right-0 z-50 px-4 pt-[calc(1rem+env(safe-area-inset-top))]' : 'pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 bg-gradient-to-b from-night via-night/80 to-transparent px-5 pt-[calc(1rem+env(safe-area-inset-top))] pb-8'}>
            <div className={props.journey ? 'sr-only' : 'min-w-0'}>
              <p className="sheet-label text-bone/60">Day {String(dayNumber).padStart(2, '0')}</p>
              <p className="mt-1 font-display text-xl leading-tight font-light">{theme}</p>
            </div>
            <button type="button" onClick={close} className="pointer-events-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-bone/30 text-lg" aria-label="Close the map">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>
      </dialog>
    </div>,
    host,
  );
}
