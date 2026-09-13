'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { tilesForViewport, type MapBasemap } from './map-adapter';
import { VectorBasemapLayer, type MapHealth } from './VectorBasemap';
import { MAX_MERCATOR_LATITUDE, fitMercator, geodesicRing, toWorld, type GeoPoint, type MapViewport } from './map-projection';
import { labelBudget, selectLabels } from './map-camera';
import { cx } from './ui';
import { LEG_LINE_STYLE, legPath, legendFor } from './hub/route-styles';

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

export type MapConnectorStyle =
  | 'measured_drive'
  | 'measured_transit'
  | 'measured_walk'
  | 'estimated'
  | 'unmeasured'
  | 'sightline'
  /**
   * MVP V3 — a line that illustrates an idea rather than a journey.
   *
   * The interview's transit spokes used `measured_transit`, so the caption under
   * a map with no plan on it read "Solid lines: measured legs" — a claim about
   * evidence, on a drawing whose whole point is that nothing has been measured
   * yet. A conceptual line has its own style and is captioned as one.
   */
  | 'conceptual'
  /**
   * V7 §14 — A LINE DRAWN BY HOW YOU MOVE, NOT BY WHAT WAS MEASURED.
   *
   * A cruise, a train and a flight are not road legs a router timed; they are
   * journeys with their own operator, and the map says which they are. Each has
   * its own mark so a river passage never reads as a drive.
   */
  | 'boat'
  | 'rail'
  | 'flight'
  | 'trail';

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
  /** PRODUCTION UI V1 — points the initial fit must include without drawing them (a destination's extent, a stated reach). */
  fitPoints?: readonly GeoPoint[];
  /**
   * MVP V3 — draw the map and nothing around it.
   *
   * For the generation screen, where the map is scenery: pan controls a
   * traveller cannot use while they wait, a legend about line styles and a
   * paragraph of caption were three kinds of clutter on a screen with one job.
   * The attribution is NOT optional and is still rendered, because it is a
   * licence obligation rather than chrome.
   */
  chromeless?: boolean;
}

const INSETS = { top: 18, right: 18, bottom: 18, left: 18 };
/**
 * The smallest ground span a frame of SEVERAL points may represent.
 *
 * 1.5 km is right for a cluster of stops in one town and wrong for anything
 * else, which is the whole of the founder's "Banff townsite orientation" frame:
 * that day had one placed point, so the fit collapsed to a degenerate extent and
 * this floor filled the screen with the nearest creek.
 */
const MIN_SPAN_KM = 1.5;
/**
 * V11 §11 — and the smallest span a frame of ONE point may represent.
 *
 * A single pin needs the town it is in and the valley it sits in or it is a pin
 * on nothing. Applied here rather than at each call site so every map — day,
 * overview, generation, share — gets it without being asked, and so a caller
 * that forgets cannot reintroduce the defect. `cameraFrameFor` in
 * `map-camera.ts` decides the same thing at a higher level, for callers that can
 * say which mode they are in; this is the floor under all of them.
 */
const SINGLE_POINT_SPAN_KM = 12;
/** Two points closer than this are one place as far as framing is concerned. */
const DISTINCT_POINT_DEGREES = 0.002;
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
  /*
   * V11 §11 — how much ground the floor should cover depends on how many places
   * are actually in the frame. Counted on distinct positions rather than on the
   * array length, because a day whose base and only stop resolved to the same
   * point is a one-place day however many entries it has.
   */
  const distinct = new Set(points.map((point) => `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`));
  const spread = points.length > 1 && (Math.max(...points.map((p) => p.lat)) - Math.min(...points.map((p) => p.lat)) > DISTINCT_POINT_DEGREES || Math.max(...points.map((p) => p.lng)) - Math.min(...points.map((p) => p.lng)) > DISTINCT_POINT_DEGREES);
  const minSpanKm = distinct.size > 1 && spread ? MIN_SPAN_KM : SINGLE_POINT_SPAN_KM;
  const viewport = fitMercator({ points, width, height, insets: INSETS, minSpanKm });
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

/*
 * PRODUCTION UI V1 — map colour is functional: the measured route in
 * cartographic teal, an estimated leg in umber dashes, an untimed leg as a
 * faint short-dashed connector. V8 — the line styles and the legend sentences
 * live together in `hub/route-styles.ts`, so a line and its key cannot drift.
 */
const EASE_MS = 420;

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
  fitPoints = [],
  chromeless = false,
}: InteractiveMapProps) {
  const rawId = useId();
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const points = useMemo<GeoPoint[]>(() => [...markers.map((m) => m.coordinates), ...(base ? [base.coordinates] : []), ...fitPoints], [markers, base, fitPoints]);
  const fitKey = points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
  const fitted = useMemo(() => fitView(points, width, height), [fitKey, width, height]); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = useState<View>(fitted);
  /*
   * V8 — THE CAMERA EASES; IT DOES NOT CUT.
   *
   * A day filter, "Fit" and the `0` key move the camera through a 420 ms
   * ease-out tween between the current view and the fitted one, so a reader
   * keeps their bearings when the drawing changes scale. Zoom steps stay
   * immediate — they are feedback, not navigation. A reduced-motion machine
   * jumps straight to the target, and nothing waits on the tween finishing.
   */
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const animation = useRef<number | null>(null);
  const animateTo = useCallback((target: View) => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof requestAnimationFrame !== 'function') {
      setView(target);
      return;
    }
    const from = viewRef.current;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / EASE_MS);
      const eased = 1 - (1 - t) ** 3;
      setView({ cx: from.cx + (target.cx - from.cx) * eased, cy: from.cy + (target.cy - from.cy) * eased, scale: from.scale * (target.scale / from.scale) ** eased });
      animation.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    animation.current = requestAnimationFrame(step);
  }, []);
  useEffect(
    () => () => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
    },
    [],
  );
  const fittedFor = useRef(fitKey);
  useEffect(() => {
    if (fittedFor.current === fitKey) return;
    fittedFor.current = fitKey;
    animateTo(fitted);
  }, [fitKey, fitted, animateTo]);
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
  /* Names beside the pins when the drawing is sparse enough to read them; a basemap's own labels take over otherwise. */
  const labelAll = markers.filter((m) => m.name).length <= 14 && width >= 400;
  /*
   * V11 §12 §15 — WHICH LABELS ARE ACTUALLY DRAWN.
   *
   * `labelAll` decided *whether* to label and the flip logic decided whether a
   * label ran off the right edge. Neither asked the question that produced the
   * founder's Kyrgyzstan screenshot: whether two labels land on top of each
   * other. They did — "Osh Bazaar" and "Ala-Too Square" overlapped into one
   * unreadable smear around Bishkek, and the same thing happens on any day whose
   * stops sit close together.
   *
   * `selectLabels` is the shared decision (`map-camera.ts`, unit-tested without
   * a browser): priority by kind — a base outranks a stop — a budget that
   * shrinks on a phone, the focused marker always keeping its label whatever it
   * overlaps, and a colliding lower-priority label dropped rather than drawn
   * over. Recomputed only when the positions or the focus change.
   */
  const labelledIds = useMemo(() => {
    if (!labelAll) return new Set<string>();
    const chosen = selectLabels(
      placed
        .filter((entry) => entry.marker.name)
        .map((entry) => ({
          id: entry.marker.id,
          label: entry.marker.name,
          /* This component's three kinds map onto the shared vocabulary; a "place" is an ordinary stop. */
          kind: entry.marker.kind === 'base' ? ('base' as const) : entry.marker.kind === 'stop' ? ('signature' as const) : ('stop' as const),
          x: entry.x,
          y: entry.y,
        })),
      { max: labelBudget({ mode: 'day', widthPx: width }), ...(focusedId ? { selectedId: focusedId } : {}) },
    );
    return new Set(chosen.map((entry) => entry.id));
  }, [placed, labelAll, width, focusedId]);

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
  /*
   * MVP V3 — the figure never waits on the basemap and never pretends to have
   * one. Until the tiles are actually on screen the graticule stays, so a frame
   * is never empty; a basemap that fails says so in the caption rather than
   * leaving an attribution line crediting a map nobody can see.
   */
  const [basemapHealth, setBasemapHealth] = useState<MapHealth>(vector ? 'loading' : 'failed');
  const basemapDrawn = vector !== null && (basemapHealth === 'ready' || basemapHealth === 'degraded');
  const placedTiles = tiles && tiles.kind !== 'vector' ? tilesForViewport({ viewport, source: tiles, maxTiles: 48 }) : [];
  const centreGeo = viewport.unproject({ x: width / 2, y: height / 2 });
  const hasRouteShape = connectors.some((c) => c.path && c.path.length > 1);
  const hasStraightMeasured = connectors.some((c) => c.style.startsWith('measured') && !(c.path && c.path.length > 1));
  /* The legend lists exactly the styles on the drawing — never a line nobody drew. */
  const legend = legendFor(connectors.map((c) => c.style));

  function onKeyDown(event: React.KeyboardEvent<SVGSVGElement>) {
    const handled: Record<string, () => void> = {
      ArrowLeft: () => panBy(PAN_STEP_PX, 0),
      ArrowRight: () => panBy(-PAN_STEP_PX, 0),
      ArrowUp: () => panBy(0, PAN_STEP_PX),
      ArrowDown: () => panBy(0, -PAN_STEP_PX),
      '+': () => zoomBy(ZOOM_STEP),
      '=': () => zoomBy(ZOOM_STEP),
      '-': () => zoomBy(1 / ZOOM_STEP),
      '0': () => animateTo(fitted),
    };
    const action = handled[event.key];
    if (action && event.target === event.currentTarget) {
      event.preventDefault();
      action();
    }
  }

  return (
    /* `group` so the keyboard hint below can appear exactly when the map region has focus. */
    <div className={cx('group min-w-0', className)}>
      <figure className="m-0" data-testid={testId}>
        <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-rule bg-paper-sunk">
          {vector ? <VectorBasemapLayer source={vector} centre={centreGeo} scale={view.scale} width={width} height={height} onHealth={setBasemapHealth} /> : null}
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

            {!basemapDrawn && placedTiles.length === 0 ? (
              /* PRODUCTION UI V1 — with no basemap, a faint graticule says "this is a map" and gives the eye a scale; nothing here claims a coastline or a road. */
              <g pointerEvents="none" opacity={0.35}>
                {Array.from({ length: Math.ceil(width / 64) + 1 }, (_, i) => (
                  <line key={`v${i}`} x1={i * 64} y1={0} x2={i * 64} y2={height} stroke="var(--color-rule)" strokeWidth={1} />
                ))}
                {Array.from({ length: Math.ceil(height / 64) + 1 }, (_, i) => (
                  <line key={`h${i}`} x1={0} y1={i * 64} x2={width} y2={i * 64} stroke="var(--color-rule)" strokeWidth={1} />
                ))}
              </g>
            ) : null}

            {ring ? (
              <>
                <path d={ring.path} fill="none" stroke="var(--color-ink-faint)" strokeWidth={1} strokeDasharray="3 4" opacity={0.7} />
                <text x={baseAt ? baseAt.x : width / 2} y={baseAt ? baseAt.y - ring.km / viewport.kmPerPixelAt(base!.coordinates.lat) - 4 : 12} textAnchor="middle" fontSize={9} fill="var(--color-ink-faint)" stroke="var(--color-paper-sunk)" strokeWidth={2.5} paintOrder="stroke">
                  {ring.km} km
                </text>
              </>
            ) : null}

            {connectors.map((connector) => {
              const style = LEG_LINE_STYLE[connector.style];
              if (connector.path && connector.path.length > 1) {
                const points = connector.path.map((p) => viewport.project(p)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                return (
                  <polyline key={connector.id} points={points} fill="none" stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={style.opacity} strokeLinecap="round" strokeLinejoin="round" data-connector-style={connector.style} data-connector-shape="route" />
                );
              }
              const from = viewport.project(connector.from);
              const to = viewport.project(connector.to);
              /* A flight arcs, a boat rides a wave, everything else is the straight line it honestly is. */
              return (
                <path key={connector.id} d={legPath(connector.style, from, to)} fill="none" stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={style.opacity} strokeLinecap="round" strokeLinejoin="round" data-connector-style={connector.style} data-connector-shape={style.shape} />
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
                  {isFocused ? <circle key={`pulse-${marker.id}`} cx={x} cy={y} r={stop ? 10 : 6.5} fill="none" stroke="var(--color-route)" strokeWidth={2} className="pulse-once" aria-hidden="true" /> : null}
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
                  {labelAll && labelledIds.has(marker.id) && marker.name && !isFocused
                    ? (() => {
                        /*
                         * MVP V3 — A LABEL THAT RUNS OFF THE MAP IS NOT A LABEL.
                         *
                         * Seen on the live Kyrgyzstan review: a mark near the
                         * right edge read "Second base (to be" and stopped at
                         * the frame. Labels sit to the right of their mark by
                         * default; one that would not fit flips to the left of
                         * it instead. The width is estimated from the character
                         * count at this font size — measuring text in SVG means
                         * a layout read per marker per frame, and a label that
                         * flips a few pixels early is invisible where a clipped
                         * one is not.
                         */
                        const text = marker.name.length > 28 ? `${marker.name.slice(0, 27)}…` : marker.name;
                        const estimated = text.length * 5.4;
                        const offset = stop ? 12 : 8;
                        const flip = x + offset + estimated > width - 4;
                        return (
                          <text
                            x={flip ? x - offset : x + offset}
                            y={y + 3.5}
                            textAnchor={flip ? 'end' : 'start'}
                            fontSize={10}
                            fill="var(--color-ink-muted)"
                            stroke="var(--color-paper-sunk)"
                            strokeWidth={2.5}
                            paintOrder="stroke"
                            pointerEvents="none"
                          >
                            {text}
                          </text>
                        );
                      })()
                    : null}
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
        {/*
          MVP V3, Stage 60 — THE MAP AS A LIST.

          The picture is a picture: `role="img"` with a one-sentence summary is
          the whole of what a screen reader gets from an SVG, and a summary
          cannot say what the fourth stop is. So every marker is also a list
          item, in the order the day runs, hidden from sight and available to
          anybody reading the page any other way. It is generated from the same
          array the map draws, so the two can never disagree.
        */}
        {markers.some((marker) => marker.name) || base ? (
          <ol className="sr-only" data-testid="map-list-equivalent">
            {base ? <li>Base: {base.name}</li> : null}
            {markers.filter((marker) => marker.name).map((marker) => (
              <li key={`list-${marker.id}`}>
                {marker.kind === 'stop' && marker.order !== undefined ? `Stop ${marker.order}: ` : ''}
                {marker.name}
                {marker.category ? `. ${marker.category}` : ''}
                {typeof marker.travelMinutes === 'number' ? `. ${marker.travelMinutes} minutes from the previous stop` : ''}
              </li>
            ))}
          </ol>
        ) : null}
        {/*
          V11 §3 — THE KEY IS ONE LINE ON A PHONE.

          At 360 px every entry took a line of its own, and the key, the
          attribution and the sentence explaining the arrow keys came to roughly
          230 px under a map not much taller than that: the caption was bigger
          than the picture it captioned.

          The key now scrolls sideways in one row below `sm` and wraps as before
          from `sm` up. Nothing is removed and nothing is behind a press — a key
          a traveller cannot read is worse than a tall one. The attribution is
          deliberately *not* in that row: it is a licence obligation, so it sits
          on its own line where it can never be scrolled out of sight.
        */}
        <figcaption className={cx('mt-2 flex items-center gap-x-3 gap-y-1.5 overflow-x-auto text-xs leading-snug text-ink-faint sm:flex-wrap sm:overflow-visible [&>*]:shrink-0 sm:[&>*]:shrink', chromeless && 'sr-only')} data-testid={`${testId}-legend`}>
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
          {/*
            One entry per line style actually on the map, each with a sample of
            the line beside the words. It used to appear for any `place`
            marker, so a screen with one mark and no lines carried a legend for
            lines nobody had drawn — a caption asserting something the picture
            does not show, which is the one thing every other rule in this file
            exists to prevent.
          */}
          {legend.map((entry) => (
            <span key={entry.style} className="inline-flex items-center gap-1.5" data-legend-style={entry.style} data-legend-basis={entry.basis}>
              <LegendSample style={entry.style} />
              <span>
                {entry.legend}
                {entry.style.startsWith('measured') && hasStraightMeasured ? ' (straight where no road shape was recorded)' : ''}
              </span>
            </span>
          ))}
          {hasRouteShape ? <span>Curved lines follow the measured road.</span> : null}
          {caption}
        </figcaption>
        {/* Its own line, never in the scrolling row: attribution is a licence obligation. */}
        <p className={cx('mt-1 text-xs leading-snug text-ink-faint', chromeless && 'sr-only')} data-testid={`${testId}-attribution`}>
          {basemapDrawn || placedTiles.length > 0 ? (
            tiles!.attribution
          ) : vector && basemapHealth === 'loading' ? null : (
            /* Said only once it is true: a basemap still arriving is not an absent one. */
            <>No basemap here — the marks and lines are what is known.</>
          )}
        </p>
      </figure>
      {/* The attribution stays visible even chromeless: it is a licence obligation, not chrome. */}
      {chromeless ? <p className="mt-1.5 text-xs leading-snug text-ink-faint">{basemapDrawn || placedTiles.length > 0 ? tiles!.attribution : null}</p> : null}
      <div className={cx('mt-2 flex-wrap items-center gap-1.5', chromeless ? 'hidden' : 'flex')} aria-label="Map controls">
        <MapButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </MapButton>
        <MapButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </MapButton>
        <MapButton label="Fit the map to every place" onClick={() => animateTo(fitted)}>
          Fit
        </MapButton>
        {/*
          V11 §3 — the hint applies exactly when the map has focus, so that is
          when it is shown. Permanently printing a keyboard instruction under
          every map cost two lines on a phone and told a touch user nothing. It
          stays in the accessibility tree at all times (`sr-only`), so a screen
          reader still hears it, and becomes visible for a sighted keyboard user
          the moment anything in the map region takes focus.
        */}
        <span className="sr-only text-xs text-ink-faint group-focus-within:not-sr-only">Drag to pan · arrow keys pan, + and − zoom when the map has focus</span>
      </div>
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="pressable inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-rule bg-paper-raised px-2 text-sm font-medium text-ink shadow-[var(--shadow-card)] hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2">
      {children}
    </button>
  );
}

/** A sample of one line style, drawn exactly as the map draws it, for the legend. */
function LegendSample({ style }: { style: MapConnectorStyle }) {
  const line = LEG_LINE_STYLE[style];
  return (
    <svg viewBox="0 0 36 10" width={36} height={10} aria-hidden="true" className="shrink-0">
      <path d={legPath(style, { x: 2, y: 5 }, { x: 34, y: 5 })} fill="none" stroke={line.stroke} strokeWidth={Math.min(line.width, 2.5)} strokeDasharray={line.dash} opacity={line.opacity} strokeLinecap="round" />
    </svg>
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
