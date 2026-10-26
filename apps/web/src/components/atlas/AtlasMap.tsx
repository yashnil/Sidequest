'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type * as MapLibre from 'maplibre-gl';
import { MAPLIBRE_MODULE_URL, ensureMaplibreStylesheet } from '../map-vendor';
import { ATLAS_ATTRIBUTION, atlasStyle, type AtlasGround } from './atlas-style';
import { boundsOf, formatCoordinate, groupClose, scaleBar, type AtlasLine, type AtlasPoint } from './atlas-model';
import { cx } from '../ui';

export type { AtlasLine, AtlasPoint } from './atlas-model';

/**
 * THE ATLAS MAP — one interactive map for the stage screens.
 *
 * The trip's other maps are an SVG figure over a still basemap: honest, and
 * printable, but a picture. The board and the journey need a *place*: pins you
 * can press, a camera that travels to what you are reading, a route that draws
 * itself between the day's stops. This is that, and nothing in it is decorative:
 *
 * - **Every pin is a real coordinate and a real `<button>`**, in the tab order,
 *   named for the place, pressed state announced. A map nobody can operate by
 *   keyboard is a picture with a click handler.
 * - **Lines carry their evidence.** A measured leg is solid flare, an estimate
 *   is dashed, an unmeasured connector is a faint dotted line that says what it
 *   is not (see `day-map-legs`). The camera never animates a road that was not
 *   routed: the draw-on is a reveal of the same line, not a fake path.
 * - **The coordinate bar reads the camera**, not a constant: centre, zoom and a
 *   scale bar computed from the latitude.
 * - **Reduced motion** jumps instead of flying and draws lines whole.
 * - **It degrades to `fallback`** — the existing SVG figure — while it loads,
 *   when WebGL is missing and when the style fails, so a frame is never blank.
 */
/* Pins nearer than this on screen are fanned out. */
const SPREAD_PX = 22;

function ringOffset(k: number, n: number): [number, number] {
  const angle = -Math.PI / 2 + (2 * Math.PI * k) / n;
  const radius = n <= 2 ? 18 : n <= 4 ? 24 : 30;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

/** The k-th seat of a sunflower (golden-angle) packing: even spacing, tight around the centre. */
function sunflowerOffset(k: number): [number, number] {
  const radius = 16 * Math.sqrt(k + 1);
  const angle = k * 2.39996;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function footprints(points: readonly AtlasPoint[]) {
  return { type: 'FeatureCollection', features: points.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })) };
}

export function AtlasMap({
  points,
  lines = [],
  focusId = null,
  onSelect,
  ground = 'night',
  fitKey,
  padding = 64,
  coordinateBar = true,
  drawRoute = true,
  ariaLabel,
  fallback,
  className,
  maxZoom = 15.5,
  testId = 'atlas-map',
  controls = true,
  fitPoints,
  minSpanKm,
}: {
  points: readonly AtlasPoint[];
  lines?: readonly AtlasLine[];
  focusId?: string | null;
  onSelect?: (id: string) => void;
  ground?: AtlasGround;
  /** The camera refits whenever this changes (a new day, a new filter). Defaults to the point ids. */
  fitKey?: string;
  padding?: number | { top: number; right: number; bottom: number; left: number };
  coordinateBar?: boolean;
  drawRoute?: boolean;
  ariaLabel: string;
  /** What draws while the map loads and if it cannot: the SVG figure. */
  fallback: ReactNode;
  className?: string;
  maxZoom?: number;
  testId?: string;
  /** Zoom in, zoom out and fit — on by default. */
  controls?: boolean;
  /** The points the camera must frame, when that is not all of them (faded context never moves the frame). */
  fitPoints?: readonly { lat: number; lng: number }[];
  /** The least ground the frame may cover — the camera model's guard against framing a creek. */
  minSpanKm?: number;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibre.Map | null>(null);
  const lib = useRef<typeof MapLibre | null>(null);
  const markers = useRef(new Map<string, { marker: MapLibre.Marker; el: HTMLButtonElement }>());
  const [health, setHealth] = useState<'loading' | 'ready' | 'failed'>('loading');
  /* The ground under the marks: a tile service that refuses leaves a map with no geography, and the map says so. */
  const [tilesFailed, setTilesFailed] = useState(false);
  const [camera, setCamera] = useState<{ lat: number; lng: number; zoom: number } | null>(null);
  const latest = useRef({ points, lines, onSelect, padding, maxZoom, drawRoute, fit: fitPoints && fitPoints.length > 0 ? fitPoints : points });
  useEffect(() => {
    latest.current = { points, lines, onSelect, padding, maxZoom, drawRoute, fit: fitPoints && fitPoints.length > 0 ? fitPoints : points };
  });
  const reduced = useRef(false);
  const minSpanDeg = minSpanKm && minSpanKm > 0 ? minSpanKm / 111 : 0.012;
  const key = fitKey ?? points.map((p) => p.id).join('|');

  /* The map itself: created once per ground. */
  useEffect(() => {
    let cancelled = false;
    reduced.current = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const element = container.current;
    if (!element) return;
    if (!webglAvailable()) {
      /* Reported from a frame callback, not synchronously inside the effect. */
      const frame = requestAnimationFrame(() => setHealth('failed'));
      return () => cancelAnimationFrame(frame);
    }
    (async () => {
      const maplibre = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ MAPLIBRE_MODULE_URL)) as typeof MapLibre;
      ensureMaplibreStylesheet(document);
      if (cancelled || !container.current) return;
      lib.current = maplibre;
      const { fit: pts, padding: pad, maxZoom: mz } = latest.current;
      const bounds = boundsOf(pts, minSpanDeg);
      const instance = new maplibre.Map({
        container: container.current,
        style: atlasStyle(ground) as unknown as MapLibre.StyleSpecification,
        ...(bounds ? { bounds: [[bounds.west, bounds.south], [bounds.east, bounds.north]] as [[number, number], [number, number]], fitBoundsOptions: { padding: pad, maxZoom: Math.min(mz, 14) } } : { center: [0, 20] as [number, number], zoom: 1.5 }),
        attributionControl: false,
        fadeDuration: 0,
        maxZoom: mz,
        dragRotate: false,
        pitchWithRotate: false,
        /*
         * The map lives inside a page that scrolls. Wheel and one-finger drags
         * belong to the page; Ctrl/⌘-scroll or two fingers move the map, and
         * the zoom buttons below do it for anyone who would rather press.
         */
        cooperativeGestures: true,
      });
      instance.touchZoomRotate.disableRotation();
      /*
       * A frame laid out after the renderer started (a cover whose height comes
       * from the type over it, a sticky column settling) is measured again on
       * the next two frames, so the canvas never keeps the 300 × 150 default it
       * was born with — at which size MapLibre never finishes its first draw.
       */
      requestAnimationFrame(() => {
        instance.resize();
        requestAnimationFrame(() => instance.resize());
      });
      instance.keyboard.disable();
      map.current = instance;
      const report = () => {
        const c = instance.getCenter();
        setCamera({ lat: c.lat, lng: c.lng, zoom: instance.getZoom() });
      };
      let frame = 0;
      instance.on('move', () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          report();
        });
      });
      let started = false;
      const begin = () => {
        if (started || cancelled) return;
        started = true;
        instance.addSource('atlas-lines', { type: 'geojson', lineMetrics: true, data: linesGeoJson(latest.current.lines) });
        instance.addLayer({ id: 'atlas-line-halo', type: 'line', source: 'atlas-lines', filter: ['in', ['get', 'style'], ['literal', ['measured', 'estimated', 'boat', 'rail', 'trail']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ground === 'night' ? '#0d1a1f' : '#ffffff', 'line-width': 7, 'line-opacity': 0.55 } });
        instance.addLayer({ id: 'atlas-line-measured', type: 'line', source: 'atlas-lines', filter: ['==', ['get', 'style'], 'measured'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 3.5, 'line-gradient': gradient(1) } });
        instance.addLayer({ id: 'atlas-line-estimated', type: 'line', source: 'atlas-lines', filter: ['in', ['get', 'style'], ['literal', ['estimated', 'trail']]], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#ff5a1f', 'line-width': 3, 'line-dasharray': [1.6, 1.2] } });
        instance.addLayer({ id: 'atlas-line-transit', type: 'line', source: 'atlas-lines', filter: ['in', ['get', 'style'], ['literal', ['boat', 'rail', 'flight']]], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#7fd1e0', 'line-width': 2.5, 'line-dasharray': [3, 1.5] } });
        /*
         * The pins' footprints, invisible, on top of the basemap's symbols: a
         * symbol that is always placed and still enters the collision index, so
         * a town name moves aside (or to another anchor) rather than printing
         * under a pin. The pins themselves stay DOM buttons.
         */
        instance.addSource('atlas-pin-footprints', { type: 'geojson', data: footprints(latest.current.points) });
        instance.addLayer({ id: 'atlas-pin-footprints', type: 'symbol', source: 'atlas-pin-footprints', layout: { 'text-field': 'MM', 'text-font': ['Noto Sans Regular'], 'text-size': 19, 'text-allow-overlap': true, 'text-ignore-placement': false, 'text-padding': 2 }, paint: { 'text-opacity': 0 } });
        instance.on('moveend', () => spread());
        instance.addLayer({ id: 'atlas-line-unmeasured', type: 'line', source: 'atlas-lines', filter: ['==', ['get', 'style'], 'unmeasured'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ground === 'night' ? '#a3b1b1' : '#5f625c', 'line-width': 1.5, 'line-dasharray': [0.5, 2.5], 'line-opacity': 0.8 } });
        refit(0);
        setHealth('ready');
        report();
        syncMarkers();
        animateDraw();
      };
      /*
       * Ready when the style is, not when every first tile has arrived:
       * 'load' waits for the tiles (terrain included), which on a cold visit
       * held the trip cover on a black ground for 11–15 s and could cross the
       * 15 s failure line below. The lines and pins draw now; tiles fade in.
       */
      instance.on('load', begin);
      instance.on('styledata', () => {
        if (instance.isStyleLoaded()) begin();
      });
      instance.on('error', (event) => {
        /* The source itself refused (its TileJSON), not one tile: a single missing tile is ordinary. */
        const detail = event as { sourceId?: string; tile?: unknown };
        if (detail.sourceId === 'openmaptiles' && !detail.tile) setTilesFailed(true);
        else if (!started) setHealth((h) => (h === 'ready' ? h : 'failed'));
      });
      /* A style that never finishes is a failed map, not an empty one. */
      window.setTimeout(() => {
        if (!cancelled && !started) setHealth((h) => (h === 'ready' ? h : 'failed'));
      }, 15_000);
    })().catch(() => setHealth('failed'));
    const markerMap = markers.current;
    return () => {
      cancelled = true;
      markerMap.forEach(({ marker }) => marker.remove());
      markerMap.clear();
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ground]);

  function syncMarkers() {
    const instance = map.current;
    const maplibre = lib.current;
    if (!instance || !maplibre) return;
    const seen = new Set<string>();
    latest.current.points.forEach((point, index) => {
      seen.add(point.id);
      let entry = markers.current.get(point.id);
      if (!entry) {
        const el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          latest.current.onSelect?.(point.id);
        });
        const marker = new maplibre.Marker({ element: el, anchor: 'center' }).setLngLat([point.lng, point.lat]).addTo(instance);
        entry = { marker, el };
        markers.current.set(point.id, entry);
      }
      entry.marker.setLngLat([point.lng, point.lat]);
      const { el } = entry;
      el.classList.add('atlas-pin');
      el.dataset.state = point.state ?? 'idle';
      el.dataset.focused = String(point.id === focusRef.current);
      el.dataset.pointId = point.id;
      el.textContent = point.mark ?? '';
      el.setAttribute('aria-label', point.label);
      el.setAttribute('aria-pressed', String(point.id === focusRef.current));
      el.style.zIndex = String(point.id === focusRef.current ? 1000 : point.state === 'base' ? 900 : 100 + index);
      if (!latest.current.onSelect) el.tabIndex = -1;
    });
    for (const [id, entry] of markers.current) {
      if (seen.has(id)) continue;
      entry.marker.remove();
      markers.current.delete(id);
    }
    (instance.getSource('atlas-pin-footprints') as MapLibre.GeoJSONSource | undefined)?.setData(footprints(latest.current.points) as never);
    spread();
  }

  /**
   * Pins that land on one another at this zoom fan out in a small ring around
   * where they are, so every number can be read and pressed; a base stays
   * where it is and the others ring it. Recomputed when the camera settles.
   * The coordinates are untouched — only the screen offset moves.
   */
  function spread() {
    const instance = map.current;
    if (!instance) return;
    const points = latest.current.points;
    const screen = points.map((point) => ({ point, at: instance.project([point.lng, point.lat]) }));
    const groups = groupClose(screen.map(({ at }) => ({ x: at.x, y: at.y })), SPREAD_PX);
    for (const group of groups) {
      const anchor = group.find((i) => points[i]!.state === 'base');
      const ring = group.filter((i) => i !== anchor);
      const cx = group.reduce((sum, i) => sum + screen[i]!.at.x, 0) / group.length;
      const cy = group.reduce((sum, i) => sum + screen[i]!.at.y, 0) / group.length;
      const ox = anchor !== undefined ? screen[anchor]!.at.x : cx;
      const oy = anchor !== undefined ? screen[anchor]!.at.y : cy;
      if (anchor !== undefined) markers.current.get(points[anchor]!.id)?.marker.setOffset([0, 0]);
      ring.forEach((i, k) => {
        const { at, point } = screen[i]!;
        if (group.length < 2) {
          markers.current.get(point.id)?.marker.setOffset([0, 0]);
          return;
        }
        /* A few pins sit on one small ring; many fill a tight sunflower, so a crowded centre never sprawls across the map. */
        const [dx, dy] = ring.length <= 6 ? ringOffset(k, ring.length) : sunflowerOffset(k);
        markers.current.get(point.id)?.marker.setOffset([ox + dx - at.x, oy + dy - at.y]);
      });
    }
  }

  /** Fit the camera to the current points. Called on load and on resize, because a fit computed against an unsized canvas is a fit to nothing. */
  function refit(duration: number) {
    const instance = map.current;
    const bounds = boundsOf(latest.current.fit, minSpanDeg);
    if (!instance || !bounds) return;
    instance.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: latest.current.padding, maxZoom: Math.min(latest.current.maxZoom, 14), duration });
  }

  function animateDraw() {
    const instance = map.current;
    if (!instance || !instance.getLayer('atlas-line-measured')) return;
    if (reduced.current || !latest.current.drawRoute) {
      instance.setPaintProperty('atlas-line-measured', 'line-gradient', gradient(1));
      return;
    }
    const started = performance.now();
    const duration = 1100;
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      if (!map.current?.getLayer('atlas-line-measured')) return;
      map.current.setPaintProperty('atlas-line-measured', 'line-gradient', gradient(eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const focusRef = useRef<string | null>(focusId);
  useEffect(() => {
    focusRef.current = focusId;
  });

  /* Points and lines change → markers and the line source follow. */
  useEffect(() => {
    if (health !== 'ready') return;
    syncMarkers();
    const source = map.current?.getSource('atlas-lines') as MapLibre.GeoJSONSource | undefined;
    source?.setData(linesGeoJson(lines));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, points, lines, focusId]);

  /* A new set of places (another day, a filter) → the camera travels to it and the route draws again. */
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (health !== 'ready' || !map.current) return;
    if (lastKey.current === null) {
      lastKey.current = key;
      return;
    }
    if (lastKey.current === key) return;
    lastKey.current = key;
    const bounds = boundsOf(fitPoints && fitPoints.length > 0 ? fitPoints : points, minSpanDeg);
    if (!bounds) return;
    map.current.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding, maxZoom: Math.min(maxZoom, 14), duration: reduced.current ? 0 : 1200, essential: false });
    animateDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, key]);

  /* A focused place → the camera goes to it, if it is not comfortably in view already. */
  useEffect(() => {
    const instance = map.current;
    if (health !== 'ready' || !instance || !focusId) return;
    const point = points.find((p) => p.id === focusId);
    if (!point) return;
    const projected = instance.project([point.lng, point.lat]);
    const canvas = instance.getCanvas();
    const margin = 0.18;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const inView = projected.x > w * margin && projected.x < w * (1 - margin) && projected.y > h * margin && projected.y < h * (1 - margin);
    if (inView) return;
    instance.easeTo({ center: [point.lng, point.lat], zoom: Math.max(instance.getZoom(), 13), duration: reduced.current ? 0 : 900, padding });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, focusId]);

  /* The frame changes size (a sticky column settling, a phone rotating) → the map resizes and refits. */
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let last = '';
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
      if (size === last) return;
      last = size;
      map.current?.resize();
      if (health === 'ready') refit(0);
    });
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health]);

  const scale = camera ? scaleBar(camera.lat, camera.zoom) : null;

  return (
    <div className={cx('isolate overflow-hidden', className?.includes('absolute') ? '' : 'relative', ground === 'night' ? 'bg-night' : 'bg-[#ece5d6]', className)} data-testid={testId} data-map-health={health} data-tiles={tilesFailed ? 'failed' : 'ok'} data-ground={ground}>
      {/* The figure while the map loads, and instead of it if it cannot draw. */}
      <div className={cx('absolute inset-0 transition-opacity duration-500', health === 'ready' ? 'pointer-events-none opacity-0' : 'opacity-100')} aria-hidden={health === 'ready'}>
        {health === 'ready' ? null : fallback}
      </div>
      <div ref={container} className={cx('absolute inset-0 transition-opacity duration-700', health === 'ready' ? 'opacity-100' : 'opacity-0')} role="region" aria-label={ariaLabel} />
      {/*
        The foot of the map: its scale, and whether it is tilted — in words.
        The camera's numbers (centre, zoom) ride on `data-camera` for
        tests and tools; a traveller never needed to read "Z 10.3".
      */}
      {coordinateBar && camera && health === 'ready' ? (
        <div
          className={cx('coordbar pointer-events-none absolute right-16 bottom-3 left-3 z-10 flex items-center gap-x-4 max-sm:gap-x-2.5 max-sm:text-[9px]', ground === 'night' ? 'text-bone/75' : 'text-ink/70')}
          aria-hidden="true"
          data-testid="atlas-coordbar"
          data-camera={`${formatCoordinate(camera.lat, 'lat')} ${formatCoordinate(camera.lng, 'lng')} z=${camera.zoom.toFixed(2)}`}
        >
          {scale ? (
            <span className="flex items-center gap-2">
              <span className="inline-block h-1.5 border-x border-b border-current" style={{ width: scale.px }} />
              {scale.label}
            </span>
          ) : null}
        </div>
      ) : null}
      {health === 'ready' && tilesFailed ? (
        <p role="status" className="absolute inset-x-3 top-1/2 z-10 mx-auto max-w-[30ch] -translate-y-1/2 border border-bone/20 bg-night/90 px-3 py-2 text-center text-xs text-bone/80" data-testid="map-tiles-failed">
          The map tiles did not load. The places are drawn at their real positions with no map beneath them.
        </p>
      ) : null}
      {health === 'ready' && controls ? (
        <div className="absolute right-3 bottom-9 z-10 flex flex-col print:hidden" data-testid="atlas-controls">
          {([
            ['+', 'Zoom in', () => map.current?.zoomIn({ duration: reduced.current ? 0 : 300 })],
            ['−', 'Zoom out', () => map.current?.zoomOut({ duration: reduced.current ? 0 : 300 })],
            ['⤢', 'Show everything', () => refit(reduced.current ? 0 : 700)],
          ] as const).map(([glyph, label, act], index) => (
            <button
              key={label}
              type="button"
              onClick={act}
              aria-label={label}
              title={label}
              className={cx('flex h-11 w-11 items-center justify-center border text-lg leading-none transition-colors', index > 0 && '-mt-px', ground === 'night' ? 'border-bone/25 bg-night/80 text-bone hover:bg-night' : 'border-ink/25 bg-bone/90 text-ink hover:bg-bone')}
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          ))}
        </div>
      ) : null}
      {health === 'ready' ? (
        <p className={cx('pointer-events-none absolute top-2 right-3 z-10 max-w-[78%] text-right text-[10px] leading-tight max-sm:max-w-[92%] max-sm:text-[8.5px]', ground === 'night' ? 'text-bone/50' : 'text-ink/55')}>{ATLAS_ATTRIBUTION}</p>
      ) : null}
    </div>
  );
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    /* Release the probe at once: a page holds only so many live WebGL contexts, and every map here probes. */
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function linesGeoJson(lines: readonly AtlasLine[]) {
  return {
    type: 'FeatureCollection' as const,
    features: lines
      .filter((line) => line.coords.length >= 2)
      .map((line) => ({ type: 'Feature' as const, properties: { id: line.id, style: line.style }, geometry: { type: 'LineString' as const, coordinates: line.coords.map(([lng, lat]) => [lng, lat]) } })),
  };
}

/** The measured route as a gradient that is flare up to `progress` and clear after it: the draw-on. */
function gradient(progress: number): MapLibre.ExpressionSpecification {
  const p = Math.max(0.0001, Math.min(0.9999, progress));
  return ['step', ['line-progress'], '#ff5a1f', p, 'rgba(255,90,31,0)'] as unknown as MapLibre.ExpressionSpecification;
}
