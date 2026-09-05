'use client';

import { useState } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from './InteractiveMap';
import type { MapTileSource } from './map-adapter';

/**
 * THE WHOLE TRIP ON ONE MAP — every placed stop, every base, the moves
 * between bases as honest straight connectors. Pressing a stop jumps to the
 * day it belongs to.
 */
export function TripOverviewMap({
  markers,
  connectors,
  base,
  tiles = null,
  summary,
}: {
  markers: readonly (MapMarker & { dayNumber: number })[];
  connectors: readonly MapConnector[];
  base: { name: string; coordinates: { lat: number; lng: number } } | null;
  tiles?: MapTileSource | null;
  summary: string;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  if (markers.length === 0) return null;
  return (
    <InteractiveMap
      testId="trip-overview-map"
      markers={markers}
      connectors={connectors}
      base={base}
      focusedId={focusedId}
      onFocus={(id) => {
        setFocusedId(id);
        const marker = markers.find((m) => m.id === id);
        if (!marker) return;
        document.getElementById(`day-${marker.dayNumber}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
      tiles={tiles}
      width={640}
      height={340}
      summary={summary}
      pinLabel={(marker) => `${marker.name}, day ${(marker as MapMarker & { dayNumber?: number }).dayNumber ?? ''}`.trim()}
      caption={<span>Press a stop to jump to its day.</span>}
    />
  );
}
