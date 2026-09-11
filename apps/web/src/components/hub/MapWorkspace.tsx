'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
import type { GeoPoint } from '../map-projection';
import { cx } from '../ui';
import { usePlaceSheet, type PlaceSheetDetail } from './PlaceSheet';

/**
 * EXPERIENCE V2 — THE MAP VIEW IS A WORKSPACE, NOT A PICTURE.
 *
 * The whole trip on one large map, with the days as a rail over it: "Whole
 * trip" draws the base moves and every day's timed legs; a day draws that
 * day's stops, numbered, and its base. Pressing a stop opens its place sheet
 * (with a way into its day), the legend says what each line is, and the
 * camera eases between a day and the whole trip rather than cutting.
 *
 * V8 — WHAT THE WHOLE-TRIP VIEW DOES NOT DRAW. A day whose legs nobody could
 * time has, per day, a fan of faint straight connectors from the base to each
 * stop and back. Drawn eight days deep on one map they read as a lattice of
 * routes that do not exist. The whole-trip view therefore draws only the base
 * moves and the legs that were timed, estimated or run by an operator; the
 * untimed straight connectors stay on the single-day view, where the legend
 * beside them says what they are.
 */
export interface MapWorkspaceDay {
  dayNumber: number;
  theme: string;
  baseName: string;
  base: GeoPoint | null;
  markers: readonly MapMarker[];
  connectors: readonly MapConnector[];
}

/** What a pressed marker opens: the stop's sheet and the day it belongs to. */
export interface MapWorkspaceSheet {
  detail: PlaceSheetDetail;
  dayNumber: number;
}

export function MapWorkspace({
  markers,
  connectors,
  primaryBase,
  days,
  tiles = null,
  summary,
  sheets = {},
  frames = {},
}: {
  /** Every placed stop on the trip, with the day it belongs to. */
  markers: readonly (MapMarker & { dayNumber: number })[];
  /** The moves between bases. */
  connectors: readonly MapConnector[];
  primaryBase: { name: string; coordinates: GeoPoint } | null;
  days: readonly MapWorkspaceDay[];
  tiles?: MapBasemap | null;
  summary: string;
  /** Sheet details by place id, assembled on the server from the same rows the Days view shows. */
  sheets?: Record<string, MapWorkspaceSheet>;
  /** A picture of a place by id, for the sheet; never rendered on the map itself. */
  frames?: Record<string, ReactNode>;
}) {
  const [day, setDay] = useState<number | 'all'>('all');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const sheet = usePlaceSheet();
  const drawn = useMemo(() => {
    if (day === 'all') {
      return {
        markers,
        connectors: [...connectors, ...days.flatMap((d) => d.connectors.filter((c) => c.style !== 'unmeasured' && c.style !== 'sightline').map((c) => ({ ...c, id: `d${d.dayNumber}-${c.id}` })))],
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
    return (
      /*
       * A DESIGNED EMPTY STATE, NOT A LINE OF PROSE.
       *
       * The sentence is the same one as before — it is true, and the tests
       * read it — but it sits on the atlas ground at a real height, so the Map
       * view is still a place rather than a caption. Nothing here is a fake
       * map: the ground is the brand's grid, not a coastline.
       */
      <div className="atlas relative flex min-h-[18rem] items-center justify-center overflow-hidden rounded-[var(--radius-plate)] px-6 py-10 sm:min-h-[22rem]" data-testid="map-workspace-empty">
        <div className="relative max-w-[40ch] text-center">
          <p className="eyebrow text-[var(--color-atlas-muted)]">Map</p>
          <p className="mt-3 font-display text-2xl leading-snug text-[var(--color-atlas-ink)]">Nothing to draw yet.</p>
          <p className="mt-3 type-body atlas-muted">No stop on this trip has a confirmed position yet, so there is nothing honest to draw. Route timing on the days is estimated.</p>
        </div>
      </div>
    );
  }

  const open = (id: string) => {
    setFocusedId(id);
    const entry = sheets[id];
    const marker = markers.find((m) => m.id === id);
    if (entry && sheet) {
      sheet.open(
        entry.detail,
        frames[id] ?? null,
        <a href={`#day-${entry.dayNumber}`} className="text-accent underline underline-offset-4" data-testid="map-sheet-open-day">
          Open day {entry.dayNumber}
        </a>,
      );
      return;
    }
    if (marker) window.location.hash = `day-${marker.dayNumber}`;
  };

  return (
    <div className="relative" data-testid="map-workspace" data-day={String(day)}>
      <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-3 sm:mx-0 sm:px-0" role="tablist" aria-label="Which day to draw">
        <button type="button" role="tab" aria-selected={day === 'all'} onClick={() => setDay('all')} className={chip(day === 'all')} data-testid="map-day-all">
          Whole trip
        </button>
        {days.map((d) => (
          <button key={d.dayNumber} type="button" role="tab" aria-selected={day === d.dayNumber} onClick={() => setDay(d.dayNumber)} className={chip(day === d.dayNumber)} data-testid={`map-day-${d.dayNumber}`} title={d.theme}>
            <span className="type-figure">{String(d.dayNumber).padStart(2, '0')}</span>
            <span className="hidden sm:inline">{shortTheme(d.theme)}</span>
          </button>
        ))}
      </div>
      <InteractiveMap
        testId="trip-overview-map"
        markers={drawn.markers}
        connectors={drawn.connectors}
        base={drawn.base}
        focusedId={focusedId}
        onFocus={open}
        tiles={tiles}
        width={1120}
        height={640}
        fitPoints={drawn.connectors.flatMap((c) => [c.from, c.to])}
        summary={drawn.summary}
        pinLabel={(marker) => `${marker.name}${'dayNumber' in marker ? `, day ${(marker as MapMarker & { dayNumber?: number }).dayNumber}` : ''}`}
        caption={<span>{day === 'all' ? 'Every base and stop; press a stop for its details.' : `Day ${day}: stops numbered in order; press one for its details.`}</span>}
      />
    </div>
  );
}

function chip(on: boolean): string {
  return cx(
    'pressable inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine',
    on ? 'border-ink bg-ink text-paper shadow-[var(--shadow-card)]' : 'border-rule bg-paper-raised text-ink-muted hover:border-ink-faint hover:text-ink',
  );
}

function shortTheme(theme: string): string {
  const trimmed = theme.replace(/\.$/, '');
  return trimmed.length > 28 ? `${trimmed.slice(0, 26).trimEnd()}…` : trimmed;
}
