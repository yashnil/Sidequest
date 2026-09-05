'use client';

import { useState } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from './InteractiveMap';
import type { MapTileSource } from './map-adapter';

/**
 * ONE DAY, ON THE GROUND.
 *
 * Numbered stops in the order of the day, the bed, and the legs between them
 * drawn in the style that says what is known about each (see
 * `day-map-legs.ts`). Pressing a stop scrolls the timeline row it belongs to
 * into view and lights it, so the drawing is tied to the plan rather than
 * decorating it.
 */
export function DayMap({
  base,
  markers,
  connectors,
  omitted,
  dayNumber,
  tiles = null,
  className,
}: {
  base: { lat: number; lng: number } | null;
  markers: readonly MapMarker[];
  connectors: readonly MapConnector[];
  omitted: number;
  dayNumber: number;
  tiles?: MapTileSource | null;
  className?: string;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  if (markers.length === 0) return null;
  const summary = `${markers.length} ${markers.length === 1 ? 'stop' : 'stops'} on day ${dayNumber}, numbered in order${base ? ', from where you are staying' : ''}${omitted > 0 ? `; ${omitted} more with no published position` : ''}.`;
  return (
    <InteractiveMap
      testId="day-map"
      className={className}
      markers={markers}
      connectors={connectors}
      base={base ? { name: 'Your base', coordinates: base } : null}
      focusedId={focusedId}
      onFocus={(id) => {
        setFocusedId(id);
        const row = document.querySelector(`[data-timeline-place="${CSS.escape(id)}"][data-day="${dayNumber}"]`) ?? document.querySelector(`[data-timeline-place="${CSS.escape(id)}"]`);
        row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (row as HTMLElement | null)?.focus?.({ preventScroll: true });
      }}
      tiles={tiles}
      width={320}
      height={220}
      summary={summary}
      caption={omitted > 0 ? <span>{omitted} {omitted === 1 ? 'stop is' : 'stops are'} not drawn, because nobody publishes where {omitted === 1 ? 'it is' : 'they are'}.</span> : null}
    />
  );
}
