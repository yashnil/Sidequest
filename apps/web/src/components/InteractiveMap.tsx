'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { tilesForViewport, type MapBasemap } from './map-adapter';
import { VectorBasemapLayer } from './VectorBasemap';
import { MAX_MERCATOR_LATITUDE, fitMercator, geodesicRing, toWorld, type GeoPoint, type MapViewport } from './map-projection';
import { cx } from './ui';

/**
 * ONE INTERACTIVE MAP FOR THE BOARD AND THE ITINERARY.
 *
 * Pan (drag, arrow keys), zoom (buttons, wheel, +/−), fit-to-places, a real
 * basemap when a tile source is configured (`SIDEQUEST_MAP_TILES`, with its
 * attribution printed), pins that are real buttons in the tab order, and the
 * two-way selection the board depends on: pressing a pin focuses its card,
 * focusing a card lights its pin.
 *
 * WHAT IT NEVER DOES. It never draws a line and calls it a route. Connectors
 * carry a style: a measured leg is solid (drive), long-dashed (transit) or
 * dotted (walk); an unmeasured leg and a sightline are short-dashed and the
 * caption says so. Without a tile source there is no coastline, road or
 * border, because none has been read — what is drawn is exactly what is
 * known: positions, one ring of true ground radius, and the legs.
 */

export type MapMarkerKind = 'base' | 'stop' | 'place';

export interface MapMarker {
  id: string;
  name: string;
  coordinates: GeoPoint;
  kind: MapMarkerKind;
  chosen?: boolean;
  /** The number drawn on a stop, in day order. */
  order?: number;
  category?: string;
  travelMinutes?: number | null;
}

export type MapConnectorStyle = 'measured_drive' | 'measured_transit' | 'measured_walk' | 'unmeasured' | 'sightline';

export interface MapConnector {
  id: string;
  from: GeoPoint;
  to: GeoPoint;
  style: MapConnectorStyle;
  /** LIVE WORLD V1 — the measured route's own shape, when the provider returned one; a straight line otherwise. */
  path?: readonly GeoPoint[];
}

export interface InteractiveMapProps {
  markers: readonly MapMarker[];
  connectors?: readonly MapConnector[];
  base?: { name: string; coordinates: GeoPoint } | null;
  focusedId: string | null;
  onFocus: (id: string) => void;
  tiles?: MapBasemap | null;
  width?: number;
  height?: number;
  /** One sentence for assistive technology: what this drawing shows. */
  summary: string;
  testId: string;
  /** Rendered under the map; the legend is appended. */
  caption?: ReactNode;
  className?: string;
  /** "<name>, 20 min from base" for a board pin; "Stop 3: <name>" for a day stop. */
  pinLabel?: (marker: MapMarker) => string;
}

const INSETS = { top: 18, right: 18, bottom: 18, left: 18 };
const MIN_SPAN_KM = 1.5;
const ZOOM_STEP = 1.6;
const PAN_STEP_PX = 48;
const NUDGE_STEP_PX = 7;

interface View {
  /** World-coordinate centre (0..1 Mercator). */
  cx: number;
  cy: number;
  /** Pixels per world unit. */
  scale: number;
}

function fitView(points: readonly GeoPoint[], width: number, height: number): View {
  const viewport = fitMercator({ points, width, height, insets: INSETS, minSpanKm: MIN_SPAN_KM });
  return { cx: viewport.centre.x, cy: viewport.centre.y, scale: viewport.scale };
}

function viewportFor(view: View, width: number, height: number): MapViewport {
  const project = (point: GeoPoint) => {
    const world = toWorld(point);
    return { x: width / 2 + (world.x - view.cx) * view.scale, y: height / 2 + (world.y - view.cy) * view.scale };
  };
  const centreLatitude = (2 * Math.atan(Math.exp((0.5 - view.cy) * 2 * Math.PI)) - Math.PI / 2) / (Math.PI / 180);
  return {
    width,
    height,
    scale: view.scale,
    centre: { x: view.cx, y: view.cy },
    centreLatitude,
    project,
    unproject(pixel) {
      const wx = view.cx + (pixel.x - width / 2) / view.scale;
      const wy = view.cy + (pixel.y - height / 2) / view.scale;
      return { lat: (2 * Math.atan(Math.exp((0.5 - wy) * 2 * Math.PI)) - Math.PI / 2) / (Math.PI / 180), lng: wx * 360 - 180 };
    },
    kmPerPixelAt(lat) {
      return (40075.0167 * Math.cos((lat * Math.PI) / 180)) / view.scale;
    },
  };
}

const CONNECTOR_STYLE: Record<MapConnectorStyle, { stroke: string; dash?: string; width: number; opacity: number }> = {
  measured_drive: { stroke: 'var(--color-slate-blue)', width: 2.5, opacity: 0.9 },
  measured_transit: { stroke: 'var(--color-slate-blue)', dash: '8 4', width: 2.5, opacity: 0.9 },
  measured_walk: { stroke: 'var(--color-pine)', dash: '2 4', width: 2.5, opacity: 0.9 },
  unmeasured: { stroke: 'var(--color-ink-faint)', dash: '3 4', width: 1.5, opacity: 0.7 },
  sightline: { stroke: 'var(--color-pine)', dash: '3 4', width: 1.5, opacity: 0.55 },
};

export function InteractiveMap({
  markers,
  connectors = [],
  base = null,
  focusedId,
  onFocus,
  tiles = null,
  width = 360,
  height = 300,
  summary,
  testId,
  caption,
  className,
  pinLabel,
}: InteractiveMapProps) {
  const rawId = useId();
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const points = useMemo<GeoPoint[]>(() => [...markers.map((m) => m.coordinates), ...(base ? [base.coordinates] : [])], [markers, base]);
  const fitKey = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
  const fitted = useMemo(() => fitView(points, width, height), [fitKey, width, height]); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState<View>(fitted);
  const [fittedFor, setFittedFor] = useState(fitKey);
  if (fittedFor !== fitKey) {
    setFittedFor(fitKey);
    setView(fitted);
  }
  const viewport = viewportFor(view, width, height);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastDragMoved = useRef(false);

  const zoomBy = useCallback((factor: number, at?: { x: number; y: number }) => {
    setView((current) => {
      const next = Math.max(fitted.scale / 4, Math.min(fitted.scale * 64, 256 * 2 ** (tiles?.maxZoom ?? 19), current.scale * factor));
      if (!at) return { ...current, scale: next };
      // Zoom about the cursor: the world point under it stays under it.
      const wx = current.cx + (at.x - width / 2) / current.scale;
      const wy = current.cy + (at.y - height / 2) / current.scale;
      return { cx: wx - (at.x - width / 2) / next, cy: wy - (at.y - height / 2) / next, scale: next };
    });
  }, [fitted.scale, height, tiles?.maxZoom, width]);

  const panBy = useCallback((dx: number, dy: number) => {
    setView((current) => ({ ...current, cx: current.cx - dx / current.scale, cy: current.cy - dy / current.scale }));
  }, []);

  // Wheel zoom needs a non-passive listener to stop the page scrolling under the map.
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * width;
      const y = ((event.clientY - rect.top) / rect.height) * height;
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x, y });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [height, width, zoomBy]);

  function pixelOf(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return { x: ((event.clientX - rect.left) / rect.width) * width, y: ((event.clientY - rect.top) / rect.height) * height };
  }

  // --- placed marks ------------------------------------------------------------------
  const placed = useMemo(() => {
    const ordered = [...markers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const taken: { x: number; y: number }[] = [];
    return ordered.map((marker) => {
      const at = viewport.project(marker.coordinates);
      let { x, y } = at;
      let overlapping = 0;
      if (marker.kind === 'place') {
        while (taken.some((other) => Math.hypot(other.x - x, other.y - y) < NUDGE_STEP_PX)) {
          overlapping += 1;
          const step = Math.ceil(overlapping / 4) * NUDGE_STEP_PX;
          const quarter = overlapping % 4;
          x = at.x + (quarter === 0 ? step : quarter === 2 ? -step : 0);
          y = at.y + (quarter === 1 ? -step : quarter === 3 ? step : 0);
          if (overlapping > 16) break;
        }
      }
      taken.push({ x, y });
      return { marker, x, y };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, view.cx, view.cy, view.scale, width, height]);

  const baseAt = base ? viewport.project(base.coordinates) : null;
  const focused = placed.find((entry) => entry.marker.id === focusedId) ?? null;

  const ring = useMemo(() => {
    if (!base) return null;
    const kmPerPixel = viewport.kmPerPixelAt(base.coordinates.lat);
    const halfFrame = Math.min(width, height) / 2 - INSETS.left;
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].filter((km) => km / kmPerPixel < halfFrame && km / kmPerPixel > 24);
    const km = candidates[candidates.length - 1];
    if (!km) return null;
    const path = `${geodesicRing(base.coordinates, km, 48)
      .map((point, index) => {
        const at = viewport.project(point);
        return `${index === 0 ? 'M' : 'L'}${at.x.toFixed(1)} ${at.y.toFixed(1)}`;
      })
      .join(' ')} Z`;
    return { path, km };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, view.cx, view.cy, view.scale, width, height]);

  const vector = tiles && tiles.kind === 'vector' ? tiles : null;
  const placedTiles = tiles && tiles.kind !== 'vector' ? tilesForViewport({ viewport, source: tiles, maxTiles: 48 }) : [];
  const centreGeo = viewport.unproject({ x: width / 2, y: height / 2 });
  const hasMeasured = connectors.some((c) => c.style.startsWith('measured'));
  const hasRouteShape = connectors.some((c) => c.path && c.path.length > 1);
  const hasStraightMeasured = connectors.some((c) => c.style.startsWith('measured') && !(c.path && c.path.length > 1));
  const hasUnmeasured = connectors.some((c) => c.style === 'unmeasured' || c.style === 'sightline');

  function onKeyDown(event: React.KeyboardEvent<SVGSVGElement>) {
    const handled: Record<string, () => void> = {
      ArrowLeft: () => panBy(PAN_STEP_PX, 0),
      ArrowRight: () => panBy(-PAN_STEP_PX, 0),
      ArrowUp: () => panBy(0, PAN_STEP_PX),
      ArrowDown: () => panBy(0, -PAN_STEP_PX),
      '+': () => zoomBy(ZOOM_STEP),
      '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP),
      '0': () => setView(fitted),
    };
    const action = handled[event.key];
    if (action && event.target === event.currentTarget) {
      event.preventDefault();
      action();
    }
  }

  return (
    <div className={cx('min-w-0', className)}>
      <figure className="m-0" data-testid={testId}>
        <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-rule bg-paper-sunk">
          {vector ? <VectorBasemapLayer source={vector} centre={centreGeo} scale={view.scale} width={width} height={height} /> : null}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            className={cx('relative h-auto w-full touch-none select-none', dragging ? 'cursor-grabbing' : 'cursor-grab')}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const at = pixelOf(event);
              drag.current = { x: at.x, y: at.y, cx: view.cx, cy: view.cy, moved: false };
              lastDragMoved.current = false;
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              const at = pixelOf(event);
              const dx = at.x - drag.current.x;
              const dy = at.y - drag.current.y;
              if (!drag.current.moved && Math.hypot(dx, dy) > 3) {
                // Only a real drag takes the pointer; a plain press still reaches the pin underneath.
                drag.current.moved = true;
                lastDragMoved.current = true;
                setDragging(true);
                (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
              }
              if (!drag.current.moved) return;
              setView((current) => ({ ...current, cx: drag.current!.cx - dx / current.scale, cy: drag.current!.cy - dy / current.scale }));
            }}
            onPointerUp={(event) => {
              const moved = drag.current?.moved ?? false;
              drag.current = null;
              setDragging(false);
              if (moved && (event.currentTarget as SVGSVGElement).hasPointerCapture(event.pointerId)) {
                (event.currentTarget as SVGSVGElement).releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
          >
            {placedTiles.length > 0 ? (
              <>
                <clipPath id={`${id}-frame`}>
                  <rect x={0} y={0} width={width} height={height} />
                </clipPath>
                <g clipPath={`url(#${id}-frame)`} opacity={0.9}>
                  {placedTiles.map((tile) => (
                    <image key={`${tile.z}/${tile.x}/${tile.y}`} href={tile.href} x={tile.left} y={tile.top} width={tile.size} height={tile.size} />
                  ))}
                </g>
              </>
            ) : null}

            {ring ? (
              <>
                <path d={ring.path} fill="none" stroke="var(--color-ink-faint)" strokeWidth={1} strokeDasharray="3 4" opacity={0.7} />
                <text x={baseAt ? baseAt.x : width / 2} y={baseAt ? baseAt.y - 8 : 12} textAnchor="middle" fontSize={9} fill="var(--color-ink-faint)" stroke="var(--color-paper-sunk)" strokeWidth={2.5} paintOrder="stroke">
                  {ring.km} km
                </text>
              </>
            ) : null}

            {connectors.map((connector) => {
              const style = CONNECTOR_STYLE[connector.style];
              if (connector.path && connector.path.length > 1) {
                const points = connector.path.map((p) => viewport.project(p)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                return (
                  <polyline key={connector.id} points={points} fill="none" stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={style.opacity} strokeLinecap="round" strokeLinejoin="round" data-connector-style={connector.style} data-connector-shape="route" />
                );
              }
              const from = viewport.project(connector.from);
              const to = viewport.project(connector.to);
              return (
                <line key={connector.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={style.opacity} strokeLinecap="round" data-connector-style={connector.style} data-connector-shape="straight" />
              );
            })}

            {baseAt && focused && focused.marker.kind === 'place' ? (
              <line x1={baseAt.x} y1={baseAt.y} x2={focused.x} y2={focused.y} stroke="var(--color-pine)" strokeWidth={1.5} strokeDasharray="3 4" opacity={0.55} data-connector-style="sightline" />
            ) : null}

            {placed.map(({ marker, x, y }) => {
              const isFocused = marker.id === focusedId;
              const label = pinLabel ? pinLabel(marker) : defaultPinLabel(marker);
              const stop = marker.kind === 'stop';
              return (
                <g key={marker.id} data-marker={marker.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r={14}
                    fill="transparent"
                    className="cursor-pointer"
                    onClick={() => {
                      if (lastDragMoved.current) {
                        lastDragMoved.current = false;
                        return;
                      }
                      onFocus(marker.id);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    aria-pressed={isFocused}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        onFocus(marker.id);
                      }
                    }}
                  />
                  <circle
                    cx={x}
                    cy={y}
                    r={stop ? (isFocused ? 10 : 8.5) : isFocused ? 6.5 : marker.chosen ? 5 : 3.5}
                    fill={stop ? 'var(--color-ink)' : marker.chosen ? 'var(--color-accent)' : 'var(--color-ink-faint)'}
                    stroke={isFocused ? 'var(--color-ink)' : 'var(--color-paper-raised)'}
                    strokeWidth={isFocused ? 2.5 : 1}
                    pointerEvents="none"
                  />
                  {stop && marker.order !== undefined ? (
                    <text x={x} y={y + 3.2} textAnchor="middle" fontSize={9} fontWeight={600} fill="var(--color-paper-raised)" pointerEvents="none">
                      {marker.order}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {baseAt ? (
              <g pointerEvents="none">
                <rect x={baseAt.x - 5.5} y={baseAt.y - 5.5} width={11} height={11} rx={2} fill="var(--color-ink)" stroke="var(--color-paper-raised)" strokeWidth={1.5} />
              </g>
            ) : null}

            {focused ? (
              <text
                x={Math.min(Math.max(focused.x, 44), width - 44)}
                y={focused.y > 26 ? focused.y - 13 : focused.y + 22}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill="var(--color-ink)"
                stroke="var(--color-paper-sunk)"
                strokeWidth={3}
                paintOrder="stroke"
                id={`${id}-focused`}
              >
                {focused.marker.name}
              </text>
            ) : null}
          </svg>
        </div>
        <figcaption className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-snug text-ink-faint">
          {base ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-[2px] bg-ink" />
              {base.name}
            </span>
          ) : null}
          {markers.some((m) => m.kind === 'place' && m.chosen) ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-accent" />
              chosen
            </span>
          ) : null}
          {markers.some((m) => m.kind === 'stop') ? <span>Numbered in the order of the day.</span> : null}
          {hasMeasured ? <span>Solid and long-dashed lines are measured legs (drive, transit); dotted is on foot.</span> : null}
          {hasRouteShape ? <span>Curved lines follow the measured road.</span> : null}
          {hasStraightMeasured ? <span>A straight measured line has a real duration but no recorded shape.</span> : null}
          {hasUnmeasured || markers.some((m) => m.kind === 'place') ? <span>Short-dashed lines are straight connectors, not routes.</span> : null}
          {caption}
          {tiles ? <span>Basemap: {tiles.attribution}.</span> : <span>Positions come from the source records; no basemap is configured.</span>}
        </figcaption>
      </figure>
      <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Map controls">
        <MapButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </MapButton>
        <MapButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </MapButton>
        <MapButton label="Fit the map to every place" onClick={() => setView(fitted)}>
          Fit
        </MapButton>
        <span className="text-[11px] text-ink-faint">Drag to pan · arrow keys pan, + and − zoom when the map has focus</span>
      </div>
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-rule bg-paper-raised px-2 text-sm text-ink hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2">
      {children}
    </button>
  );
}

export function defaultPinLabel(marker: MapMarker): string {
  if (marker.kind === 'stop') return `Stop ${marker.order ?? ''}: ${marker.name}`.replace(/\s+/g, ' ');
  if (marker.kind === 'base') return `${marker.name}, your base`;
  const distance =
    marker.travelMinutes === null || marker.travelMinutes === undefined
      ? 'journey not verified'
      : marker.travelMinutes === 0
        ? 'at your base'
        : `${marker.travelMinutes} min from base`;
  return `${marker.name}, ${distance}${marker.chosen ? ', chosen' : ''}`;
}

export { MAX_MERCATOR_LATITUDE };
