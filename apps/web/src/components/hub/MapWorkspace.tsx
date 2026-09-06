'use client';

import { useMemo, useState } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
import type { GeoPoint } from '../map-projection';
import { cx } from '../ui';

/**
 * EXPERIENCE V2 — THE MAP VIEW IS A WORKSPACE, NOT A PICTURE.
 *
 * The whole trip on one large map, with the days as a floating rail over it:
 * "All" draws the base moves and every day's legs; a day draws that day's
 * stops, numbered, and its base. Pressing a stop opens its day. No permanent
 * control panel — the rail and the legend are the only chrome, and on a phone
 * the rail scrolls under the thumb.
 */
export interface MapWorkspaceDay {
  dayNumber: number;
  theme: string;
  baseName: string;
  base: GeoPoint | null;
  markers: readonly MapMarker[];
  connectors: readonly MapConnector[];
}

export function MapWorkspace({
  markers,
  connectors,
  primaryBase,
  days,
  tiles = null,
  summary,
}: {
  /** Every placed stop on the trip, with the day it belongs to. */
  markers: readonly (MapMarker & { dayNumber: number })[];
  /** The moves between bases. */
  connectors: readonly MapConnector[];
  primaryBase: { name: string; coordinates: GeoPoint } | null;
  days: readonly MapWorkspaceDay[];
  tiles?: MapBasemap | null;
  summary: string;
}) {
  const [day, setDay] = useState<number | 'all'>('all');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const drawn = useMemo(() => {
    if (day === 'all') {
      return {
        markers,
        connectors: [...connectors, ...days.flatMap((d) => d.connectors.map((c) => ({ ...c, id: `d${d.dayNumber}-${c.id}` })))],
        base: primaryBase,
        summary,
      };
    }
    const model = days.find((d) => d.dayNumber === day);
    if (!model) return { markers, connectors, base: primaryBase, summary };
    return {
      markers: model.markers,
      connectors: model.connectors,
      base: model.base ? { name: model.baseName, coordinates: model.base } : null,
      summary: `${model.markers.length} ${model.markers.length === 1 ? 'stop' : 'stops'} on day ${model.dayNumber}, numbered in order.`,
    };
  }, [day, markers, connectors, primaryBase, days, summary]);

  if (markers.length === 0) {
    return <p className="rule-top pt-4 type-small text-ink-muted">No stop on this trip has a confirmed position yet, so there is nothing honest to draw. Route timing on the days is estimated.</p>;
  }

  return (
    <div className="relative" data-testid="map-workspace" data-day={String(day)}>
      <div className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5 pb-3 sm:mx-0 sm:px-0" role="tablist" aria-label="Which day to draw">
        <button type="button" role="tab" aria-selected={day === 'all'} onClick={() => setDay('all')} className={chip(day === 'all')} data-testid="map-day-all">
          Whole trip
        </button>
        {days.map((d) => (
          <button key={d.dayNumber} type="button" role="tab" aria-selected={day === d.dayNumber} onClick={() => setDay(d.dayNumber)} className={chip(day === d.dayNumber)} data-testid={`map-day-${d.dayNumber}`} title={d.theme}>
            <span className="numeral">{String(d.dayNumber).padStart(2, '0')}</span>
            <span className="hidden sm:inline">{shortTheme(d.theme)}</span>
          </button>
        ))}
      </div>
      <InteractiveMap
        key={String(day)}
        testId="trip-overview-map"
        markers={drawn.markers}
        connectors={drawn.connectors}
        base={drawn.base}
        focusedId={focusedId}
        onFocus={(id) => {
          setFocusedId(id);
          const marker = markers.find((m) => m.id === id);
          if (marker) window.location.hash = `day-${marker.dayNumber}`;
        }}
        tiles={tiles}
        width={1120}
        height={640}
        fitPoints={drawn.connectors.flatMap((c) => [c.from, c.to])}
        summary={drawn.summary}
        pinLabel={(marker) => `${marker.name}${'dayNumber' in marker ? `, day ${(marker as MapMarker & { dayNumber?: number }).dayNumber}` : ''}`}
        caption={<span>{day === 'all' ? 'Every base and stop; press a stop to open its day.' : `Day ${day}: stops numbered in order; press one to open the day.`}</span>}
      />
    </div>
  );
}

function chip(on: boolean): string {
  return cx(
    'pressable inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
    on ? 'border-ink bg-ink text-paper' : 'border-rule bg-paper-raised text-ink-muted hover:border-ink-faint hover:text-ink',
  );
}

function shortTheme(theme: string): string {
  const trimmed = theme.replace(/\.$/, '');
  return trimmed.length > 28 ? `${trimmed.slice(0, 26).trimEnd()}…` : trimmed;
}
