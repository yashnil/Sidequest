'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
import type { GeoPoint } from '../map-projection';
import { cameraFrameFor, type MapMode } from '../map-camera';
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
  /*
   * V11 §F — THREE MODES, NOT ONE MAP WITH A DAY FILTER.
   *
   * "Whole trip" and "a day" were the same drawing with a different subset, at
   * the same density, framed by the same rule. They answer different questions
   * and the brief names all three:
   *
   *   overview  — where you arrive, where you sleep, what the trip is built
   *               around, and the route between them. Ordinary stops are
   *               *suppressed*: eleven days of coffee stops is the cloud that
   *               makes an overview useless.
   *   day       — today's base, today's stops, today's route, with the rest of
   *               the trip drawn faintly behind so today has somewhere to be.
   *   explore   — everything, at full density, with filters. The only mode
   *               where density is what somebody came for.
   */
  const [view, setView] = useState<{ mode: MapMode; day: number | null }>({ mode: 'overview', day: null });
  const day = view.mode === 'day' && view.day !== null ? view.day : 'all';
  const [kindFilter, setKindFilter] = useState<'all' | 'signature' | 'base'>('all');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const sheet = usePlaceSheet();
  const drawn = useMemo(() => {
    const tripConnectors = [
      ...connectors,
      ...days.flatMap((d) => d.connectors.filter((c) => c.style !== 'unmeasured' && c.style !== 'sightline').map((c) => ({ ...c, id: `d${d.dayNumber}-${c.id}` }))),
    ];

    if (view.mode === 'overview') {
      /*
       * The spine only. A marker that is an ordinary stop is dropped here
       * rather than dimmed — an overview crowded with faint dots is still
       * crowded, and the day mode is one press away for anybody who wants them.
       */
      const spine = markers.filter((marker) => marker.kind !== 'place' && marker.kind !== 'stop');
      return {
        markers: spine.length > 0 ? spine : markers,
        connectors: tripConnectors,
        base: primaryBase,
        faded: [] as readonly MapMarker[],
        summary: `${spine.length} of the trip's key places — where you arrive, where you sleep and what it is built around.`,
      };
    }

    if (view.mode === 'explore') {
      const shown =
        kindFilter === 'all'
          ? markers
          : kindFilter === 'base'
            ? markers.filter((marker) => marker.kind === 'base' || marker.kind === 'gateway')
            : markers.filter((marker) => marker.kind === 'signature' || marker.kind === 'overnight_experience');
      return {
        markers: shown,
        connectors: tripConnectors,
        base: primaryBase,
        faded: [] as readonly MapMarker[],
        summary: `${shown.length} ${shown.length === 1 ? 'place' : 'places'} on this trip.`,
      };
    }

    const model = days.find((d) => d.dayNumber === view.day);
    if (!model) return { markers, connectors, base: primaryBase, faded: [] as readonly MapMarker[], summary };
    const todayIds = new Set(model.markers.map((marker) => marker.id));
    return {
      markers: model.markers,
      connectors: model.connectors,
      base: model.base ? { name: model.baseName, coordinates: model.base } : null,
      /* V11 §F2 — the rest of the trip, faded: context that never moves the frame. */
      faded: markers.filter((marker) => !todayIds.has(marker.id)),
      summary: `${model.markers.length} ${model.markers.length === 1 ? 'stop' : 'stops'} on day ${model.dayNumber}, numbered in order.`,
    };
  }, [view, kindFilter, markers, connectors, primaryBase, days, summary]);

  /*
   * V11 §F5 — THE FRAME IS DECIDED IN ONE PLACE, WITH A STATED BASIS.
   *
   * `cameraFrameFor` existed and nothing called it, so each surface still fit
   * whatever points it happened to hold — which is how a day with one placed
   * stop framed a creek. Its answer arrives here as the points to include and
   * the smallest ground the frame may cover, and its `basis` is put on the
   * element so a bad frame can be diagnosed from a screenshot's DOM.
   */
  const frame = useMemo(
    () =>
      cameraFrameFor({
        mode: view.mode,
        markers: markers.map((marker) => ({
          id: marker.id,
          label: marker.name,
          kind: marker.kind === 'place' ? 'stop' : marker.kind,
          point: marker.coordinates,
          dayNumber: marker.dayNumber,
        })),
        ...(view.day === null ? {} : { dayNumber: view.day }),
      }),
    [view, markers],
  );

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
    <div className="relative" data-testid="map-workspace" data-day={String(day)} data-map-mode={view.mode} data-camera-basis={frame.ok ? frame.basis : 'nothing_placed'}>
      <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-3 sm:mx-0 sm:px-0" role="tablist" aria-label="What to draw">
        <button type="button" role="tab" aria-selected={view.mode === 'overview'} onClick={() => setView({ mode: 'overview', day: null })} className={chip(view.mode === 'overview')} data-testid="map-day-all">
          Overview
        </button>
        <button type="button" role="tab" aria-selected={view.mode === 'explore'} onClick={() => setView({ mode: 'explore', day: null })} className={chip(view.mode === 'explore')} data-testid="map-mode-explore">
          Explore
        </button>
        {days.map((d) => (
          <button key={d.dayNumber} type="button" role="tab" aria-selected={view.mode === 'day' && view.day === d.dayNumber} onClick={() => setView({ mode: 'day', day: d.dayNumber })} className={chip(view.mode === 'day' && view.day === d.dayNumber)} data-testid={`map-day-${d.dayNumber}`} title={d.theme}>
            <span className="type-figure">{String(d.dayNumber).padStart(2, '0')}</span>
            <span className="hidden sm:inline">{shortTheme(d.theme)}</span>
          </button>
        ))}
      </div>

      {/*
        V11 §F3 — filters belong to Explore and nowhere else.

        An overview with filters is an overview somebody has to configure before
        it answers anything, and a day has too few marks for a filter to do
        work. Three, because the classification only supports three honest
        questions.
      */}
      {view.mode === 'explore' ? (
        <div className="flex flex-wrap gap-2 pb-3" role="group" aria-label="Filter what is drawn">
          {(
            [
              ['all', 'Everything'],
              ['signature', 'What it is built around'],
              ['base', 'Where you sleep and arrive'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kindFilter === value}
              onClick={() => setKindFilter(value)}
              className={chip(kindFilter === value)}
              data-testid={`map-filter-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <InteractiveMap
        testId="trip-overview-map"
        mode={view.mode}
        markers={drawn.markers}
        faded={drawn.faded}
        connectors={drawn.connectors}
        base={drawn.base}
        focusedId={focusedId}
        onFocus={open}
        tiles={tiles}
        width={1120}
        height={640}
        /*
         * The camera's own answer, not this component's. `fitPoints` are the
         * points the frame has to contain and `minSpanKm` is how much ground it
         * must cover — the two halves of the founder's bad frame.
         */
        fitPoints={frame.ok ? frame.points : []}
        {...(frame.ok ? { minSpanKm: frame.minSpanKm } : {})}
        summary={drawn.summary}
        pinLabel={(marker) => `${marker.name}${'dayNumber' in marker ? `, day ${(marker as MapMarker & { dayNumber?: number }).dayNumber}` : ''}`}
        caption={
          <span>
            {view.mode === 'overview'
              ? 'Where you arrive, where you sleep and what the trip is built around.'
              : view.mode === 'explore'
                ? 'Everything on this trip; press a place for its details.'
                : `Day ${day}: stops numbered in order; press one for its details.`}
          </span>
        }
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
