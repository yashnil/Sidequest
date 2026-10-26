'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type * as MapLibre from 'maplibre-gl';
import { MAPLIBRE_MODULE_URL, ensureMaplibreStylesheet } from '../map-vendor';
import { ATLAS_ATTRIBUTION, atlasStyle, type AtlasGround } from '../atlas/atlas-style';
import { boundsOf, formatCoordinate, scaleBar } from '../atlas/atlas-model';
import { arcCoords, type JourneyLeg, type JourneyModeKind } from '@/lib/journey/model';
import { cx } from '../ui';

/**
 * THE JOURNEY MAP — the renderer under the Journey Explorer.
 *
 * Deliberately dumb about trips: it draws the pins and legs it is handed, in
 * the evidence each carries, and exposes the camera to its owner (the explorer
 * and Replay My Day) through a small imperative handle. Planning lives in the
 * planner, the projection in `lib/journey/model.ts`, interaction state in the
 * explorer; this file only renders and moves the camera.
 *
 * Line language — shape first, then mode, then what is known:
 * - a routed leg (the provider's own polyline) is a solid line along the road;
 * - a straight chord is never solid: dashed when its time was measured or
 *   estimated, dotted when nobody knows it — it joins two real positions and
 *   claims nothing about the ground between them;
 * - a flight or long ferry is an arc, the one shape that cannot read as ground;
 * - the colour is the mode (flare drive, bone walk, glacier transit, lilac
 *   rail, blue ferry, amber trail…), repeated in words in every label.
 */

export interface JourneyPin {
  id: string;
  lat: number;
  lng: number;
  label: string;
  mark: string;
  kind: 'base' | 'stop' | 'meal' | 'gateway' | 'context';
  dim?: boolean;
}

export interface JourneyMapHandle {
  fit: (points: readonly { lat: number; lng: number }[], options?: { duration?: number; padding?: Padding; pitch?: number; bearing?: number }) => void;
  flyTo: (point: { lat: number; lng: number }, options?: { zoom?: number; duration?: number; pitch?: number; bearing?: number }) => void;
  follow: (point: { lat: number; lng: number }) => void;
  /** Replay: show the first `fraction` of one leg as the drawing head. Null clears it. */
  drawLeg: (leg: JourneyLeg | null, fraction: number) => void;
  setTerrain: (on: boolean) => Promise<TerrainReport>;
  isReady: () => boolean;
}

export type TerrainReport = { ok: true; minMetres: number | null; maxMetres: number | null } | { ok: false; reason: string };
type Padding = number | { top: number; right: number; bottom: number; left: number };

export const MODE_COLOUR: Record<JourneyModeKind, string> = {
  drive: '#ff5a1f',
  walk: '#f1ebdf',
  transit: '#7fd1e0',
  rail: '#b9a7ff',
  ferry: '#5fb3ff',
  flight: '#d7c8ff',
  cycle: '#9bd18b',
  trail: '#e6a568',
  transfer: '#ffb38a',
  unknown: '#a3b1b1',
};

export const JourneyMap = forwardRef<JourneyMapHandle, {
  pins: readonly JourneyPin[];
  legs: readonly JourneyLeg[];
  selectedId?: string | null;
  activeLegId?: string | null;
  onSelect?: (id: string) => void;
  onLegSelect?: (id: string) => void;
  ground?: AtlasGround;
  styleId?: string;
  terrainAvailable?: boolean;
  padding?: Padding;
  ariaLabel: string;
  fallback: ReactNode;
  className?: string;
  testId?: string;
  coordinateBar?: boolean;
  onReady?: () => void;
}>(function JourneyMap(
  { pins, legs, selectedId = null, activeLegId = null, onSelect, onLegSelect, ground = 'night', styleId, padding = 64, ariaLabel, fallback, className, testId = 'journey-map', coordinateBar = true, onReady },
  ref,
) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibre.Map | null>(null);
  const lib = useRef<typeof MapLibre | null>(null);
  const markers = useRef(new Map<string, { marker: MapLibre.Marker; el: HTMLButtonElement }>());
  const [health, setHealth] = useState<'loading' | 'ready' | 'failed'>('loading');
  /* The ground under the marks: a tile service that refuses leaves a map with no geography, and the map says so. */
  const [tilesFailed, setTilesFailed] = useState(false);
  const [camera, setCamera] = useState<{ lat: number; lng: number; zoom: number; pitch: number; bearing: number } | null>(null);
  const reduced = useRef(false);
  /* The last framing asked for, re-applied when the frame changes size, so a fit computed against an unsized canvas never sticks. */
  const lastFit = useRef<{ points: readonly { lat: number; lng: number }[]; padding?: Padding; pitch?: number; bearing?: number } | null>(null);
  const latest = useRef({ pins, legs, onSelect, onLegSelect, selectedId, activeLegId, padding });
  useEffect(() => {
    latest.current = { pins, legs, onSelect, onLegSelect, selectedId, activeLegId, padding };
  });

  useEffect(() => {
    let cancelled = false;
    reduced.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const element = container.current;
    if (!element) return;
    if (!webglAvailable()) {
      const frame = requestAnimationFrame(() => setHealth('failed'));
      return () => cancelAnimationFrame(frame);
    }
    (async () => {
      const maplibre = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ MAPLIBRE_MODULE_URL)) as typeof MapLibre;
      ensureMaplibreStylesheet(document);
      if (cancelled || !container.current) return;
      lib.current = maplibre;
      const bounds = boundsOf(latest.current.pins);
      const instance = new maplibre.Map({
        container: container.current,
        style: (styleId === 'sidequest:fixture' ? fixtureStyle() : atlasStyle(ground)) as unknown as MapLibre.StyleSpecification,
        ...(bounds ? { bounds: [[bounds.west, bounds.south], [bounds.east, bounds.north]] as [[number, number], [number, number]], fitBoundsOptions: { padding: latest.current.padding, maxZoom: 14 } } : { center: [0, 20] as [number, number], zoom: 1.5 }),
        attributionControl: false,
        fadeDuration: 0,
        maxZoom: 17,
        maxPitch: 75,
        cooperativeGestures: true,
      });
      instance.keyboard.disable();
      map.current = instance;
      requestAnimationFrame(() => {
        instance.resize();
        requestAnimationFrame(() => instance.resize());
      });
      let frame = 0;
      const report = () => {
        const c = instance.getCenter();
        setCamera({ lat: c.lat, lng: c.lng, zoom: instance.getZoom(), pitch: instance.getPitch(), bearing: instance.getBearing() });
      };
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
        instance.addSource('journey-legs', { type: 'geojson', data: legsGeoJson(latest.current.legs, latest.current.activeLegId) });
        instance.addSource('journey-replay', { type: 'geojson', lineMetrics: true, data: emptyLine() });
        const colour = ['match', ['get', 'mode'], ...Object.entries(MODE_COLOUR).flat(), MODE_COLOUR.unknown] as unknown as MapLibre.ExpressionSpecification;
        const opacity = ['case', ['==', ['get', 'dim'], true], 0.28, 1] as unknown as MapLibre.ExpressionSpecification;
        const width = (base: number) => ['case', ['==', ['get', 'active'], true], base + 2, base] as unknown as MapLibre.ExpressionSpecification;
        instance.addLayer({ id: 'journey-halo', type: 'line', source: 'journey-legs', filter: ['==', ['get', 'shape'], 'routed'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ground === 'night' ? '#0d1a1f' : '#ffffff', 'line-width': width(8), 'line-opacity': ['case', ['==', ['get', 'dim'], true], 0.15, 0.6] as unknown as MapLibre.ExpressionSpecification } });
        instance.addLayer({ id: 'journey-routed', type: 'line', source: 'journey-legs', filter: ['all', ['==', ['get', 'shape'], 'routed'], ['!=', ['get', 'disconnected'], true]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colour, 'line-width': width(4), 'line-opacity': opacity } });
        instance.addLayer({ id: 'journey-chord', type: 'line', source: 'journey-legs', filter: ['all', ['==', ['get', 'shape'], 'straight'], ['!=', ['get', 'time'], 'unknown'], ['!=', ['get', 'disconnected'], true]], layout: { 'line-cap': 'butt' }, paint: { 'line-color': colour, 'line-width': width(2.4), 'line-opacity': opacity, 'line-dasharray': [2.2, 1.6] } });
        instance.addLayer({ id: 'journey-unknown', type: 'line', source: 'journey-legs', filter: ['all', ['==', ['get', 'time'], 'unknown'], ['!=', ['get', 'disconnected'], true]], layout: { 'line-cap': 'round' }, paint: { 'line-color': colour, 'line-width': width(2.2), 'line-opacity': opacity, 'line-dasharray': [0.2, 2.2] } });
        instance.addLayer({ id: 'journey-arc', type: 'line', source: 'journey-legs', filter: ['==', ['get', 'disconnected'], true], layout: { 'line-cap': 'round' }, paint: { 'line-color': colour, 'line-width': width(2), 'line-opacity': opacity, 'line-dasharray': [4, 3] } });
        instance.addLayer({ id: 'journey-replay', type: 'line', source: 'journey-replay', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9, 'line-blur': 0.5 } });
        for (const layer of ['journey-routed', 'journey-chord', 'journey-unknown', 'journey-arc']) {
          instance.on('click', layer, (event) => {
            const id = event.features?.[0]?.properties?.id;
            if (typeof id === 'string') latest.current.onLegSelect?.(id);
          });
          instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
          instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
        }
        setHealth('ready');
        report();
        syncMarkers();
        onReady?.();
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
  }, [ground, styleId]);

  function syncMarkers() {
    const instance = map.current;
    const maplibre = lib.current;
    if (!instance || !maplibre) return;
    const seen = new Set<string>();
    latest.current.pins.forEach((pin, index) => {
      seen.add(pin.id);
      let entry = markers.current.get(pin.id);
      if (!entry) {
        const el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          latest.current.onSelect?.(pin.id);
        });
        const marker = new maplibre.Marker({ element: el, anchor: 'center' }).setLngLat([pin.lng, pin.lat]).addTo(instance);
        entry = { marker, el };
        markers.current.set(pin.id, entry);
      }
      entry.marker.setLngLat([pin.lng, pin.lat]);
      const { el } = entry;
      const selected = pin.id === latest.current.selectedId;
      el.classList.add('atlas-pin');
      el.dataset.state = pin.kind === 'base' || pin.kind === 'gateway' ? 'base' : pin.kind === 'meal' ? 'meal' : pin.kind === 'context' ? 'muted' : 'chosen';
      el.dataset.focused = String(selected);
      el.dataset.dim = String(Boolean(pin.dim));
      el.dataset.pointId = pin.id;
      el.textContent = pin.mark;
      el.setAttribute('aria-label', pin.label);
      el.setAttribute('aria-pressed', String(selected));
      /* Stops above the bed: a stop at the base must still be pressable. */
      el.style.zIndex = String(selected ? 1000 : pin.kind === 'base' ? 50 : pin.kind === 'context' ? 10 : 100 + index);
      el.style.opacity = pin.dim ? '0.4' : '';
      if (!latest.current.onSelect || pin.kind === 'context') el.tabIndex = -1;
    });
    for (const [id, entry] of markers.current) {
      if (seen.has(id)) continue;
      entry.marker.remove();
      markers.current.delete(id);
    }
  }

  useEffect(() => {
    if (health !== 'ready') return;
    syncMarkers();
    (map.current?.getSource('journey-legs') as MapLibre.GeoJSONSource | undefined)?.setData(legsGeoJson(legs, activeLegId));
  }, [health, pins, legs, selectedId, activeLegId]);

  /* The frame resizes (a sticky column settling, a phone rotating, a dialog opening). */
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let last = '';
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      const size = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '';
      if (size === last) return;
      last = size;
      const instance = map.current;
      if (!instance) return;
      instance.resize();
      const fit = lastFit.current;
      const bounds = fit ? boundsOf(fit.points) : null;
      if (fit && bounds) instance.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: fit.padding ?? latest.current.padding, maxZoom: 14.5, duration: 0, ...(fit.pitch !== undefined ? { pitch: fit.pitch } : {}) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    isReady: () => health === 'ready',
    fit(points, options = {}) {
      const instance = map.current;
      const bounds = boundsOf(points);
      if (!instance || !bounds) return;
      lastFit.current = { points, ...(options.padding !== undefined ? { padding: options.padding } : {}), ...(options.pitch !== undefined ? { pitch: options.pitch } : {}) };
      instance.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], {
        padding: options.padding ?? latest.current.padding,
        maxZoom: 14.5,
        duration: reduced.current ? 0 : (options.duration ?? 1100),
        ...(options.pitch !== undefined ? { pitch: options.pitch } : {}),
        ...(options.bearing !== undefined ? { bearing: options.bearing } : {}),
      });
    },
    flyTo(point, options = {}) {
      const instance = map.current;
      if (!instance) return;
      const camera = { center: [point.lng, point.lat] as [number, number], zoom: options.zoom ?? Math.max(instance.getZoom(), 14), ...(options.pitch !== undefined ? { pitch: options.pitch } : {}), ...(options.bearing !== undefined ? { bearing: options.bearing } : {}) };
      lastFit.current = null;
      if (reduced.current || options.duration === 0) instance.jumpTo(camera);
      else instance.flyTo({ ...camera, duration: options.duration ?? 1400, curve: 1.3, essential: true, padding: latest.current.padding });
    },
    follow(point) {
      map.current?.jumpTo({ center: [point.lng, point.lat] });
    },
    drawLeg(leg, fraction) {
      const source = map.current?.getSource('journey-replay') as MapLibre.GeoJSONSource | undefined;
      if (!source) return;
      if (!leg || leg.shape !== 'routed') {
        source.setData(emptyLine());
        return;
      }
      source.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: partialPath(leg.coords, fraction) } });
    },
    async setTerrain(on) {
      const instance = map.current;
      if (!instance) return { ok: false, reason: 'The map has not loaded.' };
      if (!on) {
        instance.setTerrain(null);
        instance.easeTo({ pitch: 0, bearing: 0, duration: reduced.current ? 0 : 900 });
        return { ok: true, minMetres: null, maxMetres: null };
      }
      if (!instance.getSource('dem')) return { ok: false, reason: 'No elevation data is configured for this map.' };
      try {
        instance.setTerrain({ source: 'dem', exaggeration: 1.35 });
        instance.easeTo({ pitch: 62, bearing: instance.getBearing() || -18, duration: reduced.current ? 0 : 1400 });
        await waitForIdle(instance, 8000);
        const heights = latest.current.pins
          .map((pin) => instance.queryTerrainElevation([pin.lng, pin.lat]))
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        if (heights.length === 0) return { ok: false, reason: 'Elevation tiles did not answer for these places.' };
        /* queryTerrainElevation is exaggerated; report real metres. */
        const real = heights.map((h) => h / 1.35);
        return { ok: true, minMetres: Math.round(Math.min(...real)), maxMetres: Math.round(Math.max(...real)) };
      } catch {
        instance.setTerrain(null);
        return { ok: false, reason: 'Elevation tiles could not be loaded.' };
      }
    },
  }));

  const scale = camera ? scaleBar(camera.lat, camera.zoom) : null;

  return (
    <div className={cx('isolate overflow-hidden', className?.includes('absolute') ? '' : 'relative', ground === 'night' ? 'bg-night' : 'bg-[#ece5d6]', className)} data-testid={testId} data-map-health={health} data-tiles={tilesFailed ? 'failed' : 'ok'} data-ground={ground}>
      <div className={cx('absolute inset-0 transition-opacity duration-500', health === 'ready' ? 'pointer-events-none opacity-0' : 'opacity-100')} aria-hidden={health === 'ready'}>
        {health === 'ready' ? null : fallback}
      </div>
      <div ref={container} className={cx('absolute inset-0 transition-opacity duration-700', health === 'ready' ? 'opacity-100' : 'opacity-0')} role="region" aria-label={ariaLabel} />
      {/*
        The foot of the map: its scale, and whether it is tilted — in words.
        The camera's numbers (centre, zoom, tilt) ride on `data-camera` for
        tests and tools; a traveller never needed to read "Z 10.3".
      */}
      {coordinateBar && camera && health === 'ready' ? (
        <div
          className={cx('coordbar pointer-events-none absolute right-16 bottom-3 left-3 z-10 flex items-center gap-x-4 max-sm:gap-x-2.5 max-sm:text-[9px]', ground === 'night' ? 'text-bone/75' : 'text-ink/70')}
          aria-hidden="true"
          data-testid="journey-coordbar"
          data-camera={`${formatCoordinate(camera.lat, 'lat')} ${formatCoordinate(camera.lng, 'lng')} z=${camera.zoom.toFixed(2)} bearing=${Math.round(camera.bearing)} tilt=${Math.round(camera.pitch)}`}
        >
          {camera.pitch > 1 ? <span className="rounded-full border border-current/40 px-2 py-0.5">3D view</span> : null}
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
      {health === 'ready' ? (
        <p className={cx('pointer-events-none absolute right-3 bottom-[-1px] z-10 max-w-[70%] translate-y-[-1.6rem] text-right text-[9.5px] leading-tight max-sm:hidden', ground === 'night' ? 'text-bone/45' : 'text-ink/55')}>
          {styleId === 'sidequest:fixture' ? 'Test map (no tiles)' : ATLAS_ATTRIBUTION}
        </p>
      ) : null}
    </div>
  );
});

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

function emptyLine() {
  return { type: 'FeatureCollection' as const, features: [] };
}

function legsGeoJson(legs: readonly JourneyLeg[], activeLegId: string | null) {
  return {
    type: 'FeatureCollection' as const,
    features: legs
      .filter((leg) => leg.coords.length >= 2)
      .map((leg) => ({
        type: 'Feature' as const,
        properties: { id: leg.id, mode: leg.mode, time: leg.time, shape: leg.shape, disconnected: leg.disconnected, active: leg.id === activeLegId, dim: (leg as JourneyLeg & { dim?: boolean }).dim === true },
        geometry: { type: 'LineString' as const, coordinates: leg.disconnected ? arcCoords(leg.coords[0]!, leg.coords[leg.coords.length - 1]!) : leg.coords },
      })),
  };
}

/** The first `fraction` of a path, by length, with the interpolated head as its last point. */
export function partialPath(coords: readonly [number, number][], fraction: number): [number, number][] {
  if (coords.length < 2 || fraction <= 0) return coords.slice(0, 1) as [number, number][];
  if (fraction >= 1) return [...coords];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const [x1, y1] = coords[i - 1]!;
    const [x2, y2] = coords[i]!;
    const d = Math.hypot(x2 - x1, (y2 - y1) * 1.2);
    lengths.push(d);
    total += d;
  }
  let remaining = total * fraction;
  const out: [number, number][] = [coords[0]!];
  for (let i = 1; i < coords.length; i += 1) {
    const d = lengths[i - 1]!;
    if (remaining >= d) {
      out.push(coords[i]!);
      remaining -= d;
      continue;
    }
    const t = d === 0 ? 0 : remaining / d;
    const [x1, y1] = coords[i - 1]!;
    const [x2, y2] = coords[i]!;
    out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    break;
  }
  return out;
}

function waitForIdle(instance: MapLibre.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs);
    instance.once('idle', () => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The test map: no remote sources at all, so a browser test of the interactive
 * map is reproducible offline. Plain ground and a graticule so the camera has
 * something to move over; no elevation, so 3D reports itself unavailable.
 */
function fixtureStyle(): Record<string, unknown> {
  const lines: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'LineString'; coordinates: [number, number][] } }[] = [];
  for (let lng = -180; lng <= 180; lng += 1) lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[lng, -85], [lng, 85]] } });
  for (let lat = -80; lat <= 80; lat += 1) lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-180, lat], [180, lat]] } });
  return {
    version: 8,
    sources: { graticule: { type: 'geojson', data: { type: 'FeatureCollection', features: lines } } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#16303a' } },
      { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': '#24414b', 'line-width': 1 } },
    ],
  };
}
