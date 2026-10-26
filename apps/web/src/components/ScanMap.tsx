'use client';

import { useEffect, useRef, useState } from 'react';
import type * as MapLibre from 'maplibre-gl';
import { MAPLIBRE_MODULE_URL, ensureMaplibreStylesheet } from './map-vendor';
import { NIGHT_ATTRIBUTION, nightAtlasStyle } from './landing/night-style';
import { formatCoordinate, scaleBar } from './atlas/atlas-model';

/**
 * THE SCAN, ON THE MAP, AS IT HAPPENS.
 *
 * While the discovery scan runs, this shows the destination on the night
 * sheet the moment its centre is known, and every place and base the moment
 * placement has put it on the map — real coordinates from the scan row, never
 * an estimate and never a decorative pin. The camera settles on what has been
 * found.
 *
 * SURVEY ATLAS (2026-10): the points are numbered specimens (`.atlas-pin`) in
 * the order the scan placed them — the same numbers the counters count — and
 * a base is the square specimen. Each new pin rises into place as it arrives,
 * so the sheet fills in calmly rather than all at once. A mono coordinate bar
 * reads the live camera with a scale bar. The pins are pictures (the board is
 * where places are pressed), so they are hidden from assistive technology; the
 * figure's caption carries the counts in words.
 *
 * Without WebGL (or before MapLibre arrives) the same numbered points are
 * drawn as an SVG plot over their own extent, so the screen still shows what
 * was found and where. Reduced motion: no camera flights, pins simply appear.
 */
export interface ScanMapPoint {
  name: string;
  lat: number;
  lng: number;
  kind: 'place' | 'base';
}

interface MapHandle {
  addSource: (id: string, s: unknown) => void;
  addLayer: (l: unknown) => void;
  getSource: (id: string) => { setData: (d: unknown) => void } | undefined;
  flyTo: (o: Record<string, unknown>) => void;
  jumpTo: (o: Record<string, unknown>) => void;
  fitBounds: (b: [[number, number], [number, number]], o: Record<string, unknown>) => void;
  once: (e: string, h: () => void) => void;
  on: (e: string, h: () => void) => void;
  remove: () => void;
  resize: () => void;
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
}

const ZOOM_BY_SCALE: Record<string, number> = { local: 12, city: 10.5, settlement: 10.5, district: 11, subregion: 8, region: 6.5, country: 5, multi_country: 4, continental: 3 };

/** Places are numbered in the order the scan placed them; bases carry their own count. */
export function specimenMarks(points: readonly ScanMapPoint[]): string[] {
  let place = 0;
  let base = 0;
  return points.map((p) => (p.kind === 'base' ? `B${++base}` : String(++place).padStart(2, '0')));
}

function keyOf(p: ScanMapPoint): string {
  return `${p.kind}|${p.name}|${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function featureCollection(points: readonly ScanMapPoint[]) {
  return {
    type: 'FeatureCollection',
    features: points.filter((p) => p.kind === 'base').map((p) => ({ type: 'Feature', properties: { name: p.name }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
  };
}

export function ScanMap({ center, scale, points }: { center: { lat: number; lng: number }; scale: string | null; points: readonly ScanMapPoint[] }) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapHandle | null>(null);
  const lib = useRef<typeof MapLibre | null>(null);
  const markers = useRef(new Map<string, { marker: MapLibre.Marker; el: HTMLSpanElement }>());
  /* MapLibre positions a marker by its element's transform, so the arrival animation runs on an inner pin, never on the element it moves. */
  const [live, setLive] = useState(false);
  const [camera, setCamera] = useState<{ lat: number; lng: number; zoom: number } | null>(null);
  const reduce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const placed = markers.current;
    try {
      if (!document.createElement('canvas').getContext('webgl2')) return;
    } catch {
      return;
    }
    reduce.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    (async () => {
      const maplibre = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ MAPLIBRE_MODULE_URL)) as typeof MapLibre;
      ensureMaplibreStylesheet(document);
      if (cancelled || !container.current) return;
      lib.current = maplibre;
      const instance = new maplibre.Map({
        container: container.current,
        style: nightAtlasStyle() as unknown as MapLibre.StyleSpecification,
        center: [center.lng, center.lat],
        zoom: Math.max(2, (ZOOM_BY_SCALE[scale ?? 'city'] ?? 9) - 3),
        interactive: false,
        attributionControl: false,
        fadeDuration: 150,
      }) as unknown as MapHandle;
      map.current = instance;
      instance.on('error', () => undefined);
      let frame = 0;
      const report = () => {
        const c = instance.getCenter();
        setCamera({ lat: c.lat, lng: c.lng, zoom: instance.getZoom() });
      };
      instance.on('move', () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          report();
        });
      });
      instance.once('load', () => {
        if (cancelled) return;
        instance.addSource('found', { type: 'geojson', data: featureCollection([]) });
        instance.addLayer({
          id: 'found-label',
          type: 'symbol',
          source: 'found',
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.14, 'text-offset': [0, 1.5], 'text-anchor': 'top' },
          paint: { 'text-color': '#f1ebdf', 'text-halo-color': '#0a161b', 'text-halo-width': 1.5 },
        });
        report();
        setLive(true);
      });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      for (const { marker } of placed.values()) marker.remove();
      placed.clear();
      map.current?.remove();
      map.current = null;
    };
    // The map is created once per screen; the camera and points are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Place each new specimen as it arrives, then settle on what has been found. */
  useEffect(() => {
    const instance = map.current;
    const maplibre = lib.current;
    if (!live || !instance || !maplibre) return;
    instance.getSource('found')?.setData(featureCollection(points));
    const marks = specimenMarks(points);
    const seen = new Set<string>();
    let fresh = 0;
    points.forEach((p, i) => {
      const key = keyOf(p);
      seen.add(key);
      const existing = markers.current.get(key);
      if (existing) {
        existing.el.textContent = marks[i]!;
        return;
      }
      const holder = document.createElement('span');
      holder.setAttribute('aria-hidden', 'true');
      holder.className = 'pointer-events-none';
      /* A base sits above the places measured from it. */
      holder.style.zIndex = p.kind === 'base' ? '2' : '1';
      const el = document.createElement('span');
      el.className = 'atlas-pin pointer-events-none';
      el.dataset.state = p.kind === 'base' ? 'base' : 'chosen';
      el.textContent = marks[i]!;
      if (!reduce.current) {
        /* A calm arrival: each new pin rises a beat after the one before it. */
        el.style.animation = `sq-fade-up 520ms var(--ease-out) ${Math.min(fresh, 24) * 70}ms both`;
        fresh += 1;
      }
      holder.appendChild(el);
      const marker = new maplibre.Marker({ element: holder, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(instance as unknown as MapLibre.Map);
      markers.current.set(key, { marker, el });
    });
    for (const [key, { marker }] of markers.current) {
      if (!seen.has(key)) {
        marker.remove();
        markers.current.delete(key);
      }
    }
    const duration = reduce.current ? 0 : 2200;
    if (points.length >= 2) {
      const lngs = points.map((p) => p.lng);
      const lats = points.map((p) => p.lat);
      instance.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: { top: 64, right: 56, bottom: 84, left: 56 }, maxZoom: 12.5, duration });
    } else {
      instance.flyTo({ center: [center.lng, center.lat], zoom: ZOOM_BY_SCALE[scale ?? 'city'] ?? 9, duration, essential: false });
    }
  }, [live, points, center.lat, center.lng, scale]);

  const places = points.filter((p) => p.kind === 'place').length;
  const bases = points.length - places;
  const bar = camera ? scaleBar(camera.lat, camera.zoom, 64) : null;

  return (
    <figure className="survey-night relative m-0 h-full min-h-[16rem] overflow-hidden border border-white/15 lg:min-h-[24rem]" data-testid="scan-map" data-live={live ? 'true' : 'false'} data-points={points.length}>
      <div aria-hidden="true" className="absolute inset-0 transition-opacity duration-700" style={{ opacity: live ? 1 : 0 }}>
        <div ref={container} style={{ width: '100%', height: '100%' }} />
      </div>
      {!live ? <PlotFallback center={center} points={points} /> : null}
      <CornerTicks />
      <div aria-hidden="true" className="coordbar pointer-events-none absolute inset-x-0 top-0 flex min-w-0 items-center gap-x-4 overflow-hidden border-b border-white/10 bg-[rgb(8_20_26/0.6)] px-3.5 py-2 text-[var(--color-atlas-muted)]">
        <span className="text-[var(--color-glacier)]">{live ? 'Camera' : 'Plot'}</span>
        <span className="text-[var(--color-atlas-ink)]">{formatCoordinate(camera?.lat ?? center.lat, 'lat')}</span>
        <span className="text-[var(--color-atlas-ink)]">{formatCoordinate(camera?.lng ?? center.lng, 'lng')}</span>
        {camera ? <span className="max-sm:hidden">Z {camera.zoom.toFixed(1)}</span> : null}
        {bar ? (
          <span className="ml-auto inline-flex items-center gap-2 max-sm:hidden">
            <span className="inline-block h-1.5 border-x border-b border-current" style={{ width: bar.px }} />
            {bar.label}
          </span>
        ) : null}
      </div>
      <figcaption className="absolute inset-x-0 bottom-0 flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-1 bg-gradient-to-t from-[rgb(8_20_26/0.92)] to-transparent px-3.5 pt-10 pb-2.5 text-xs text-[var(--color-atlas-muted)]">
        <span className="coordbar">
          <span className="text-[var(--color-atlas-ink)]">{String(places).padStart(2, '0')}</span> places on the map
          {bases > 0 ? (
            <>
              {' · '}
              <span className="text-[var(--color-atlas-ink)]">{String(bases).padStart(2, '0')}</span> {bases === 1 ? 'base' : 'bases'}
            </>
          ) : null}
        </span>
        {live ? <span className="min-w-0 max-w-full text-right text-[0.58rem] leading-snug opacity-80 sm:max-w-[60%] sm:text-[0.62rem]">{NIGHT_ATTRIBUTION}</span> : null}
      </figcaption>
    </figure>
  );
}

/** The sheet's register marks: four hairline corners, so the frame reads as a survey plate. */
function CornerTicks() {
  const tick = 'pointer-events-none absolute h-3 w-3 border-[var(--color-glacier)]/70';
  return (
    <span aria-hidden="true">
      <span className={`${tick} top-10 left-2 border-t border-l`} />
      <span className={`${tick} top-10 right-2 border-t border-r`} />
      <span className={`${tick} bottom-2 left-2 border-b border-l`} />
      <span className={`${tick} right-2 bottom-2 border-r border-b`} />
    </span>
  );
}

/** The no-WebGL drawing: the same real points, numbered, plotted over their own extent. */
function PlotFallback({ center, points }: { center: { lat: number; lng: number }; points: readonly ScanMapPoint[] }) {
  const all = points.length > 0 ? points : [{ name: '', lat: center.lat, lng: center.lng, kind: 'base' as const }];
  const marks = specimenMarks(points);
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const k = Math.max(0.05, Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
  const spanLat = Math.max(maxLat - minLat, 0.02);
  const spanLng = Math.max((maxLng - minLng) * k, 0.02);
  const s = Math.min(480 / spanLng, 240 / spanLat);
  const x = (lng: number) => 300 + ((lng - (minLng + maxLng) / 2) * k) * s;
  const y = (lat: number) => 200 - (lat - (minLat + maxLat) / 2) * s;
  return (
    <svg viewBox="0 0 600 400" className="absolute inset-0 h-full w-full" role="img" aria-label={`${points.length} places found so far`}>
      {points.length === 0 ? (
        <g stroke="var(--color-glacier)" strokeOpacity={0.6}>
          <line x1={286} y1={200} x2={314} y2={200} />
          <line x1={300} y1={186} x2={300} y2={214} />
        </g>
      ) : null}
      {/* Places first, bases on top: a base is the square every place is measured from. */}
      {points.map((p, i) => ({ p, i })).sort((a, b) => (a.p.kind === b.p.kind ? a.i - b.i : a.p.kind === 'base' ? 1 : -1)).map(({ p, i }) => (
        <g key={i} className="fade-up" style={{ ['--d' as string]: `${Math.min(i, 24) * 60}ms` }}>
          {p.kind === 'base' ? (
            <rect x={x(p.lng) - 11} y={y(p.lat) - 11} width={22} height={22} rx={2} fill="var(--color-bone)" stroke="var(--color-night)" strokeWidth={1.5} />
          ) : (
            <circle cx={x(p.lng)} cy={y(p.lat)} r={12} fill="var(--color-flare)" stroke="var(--color-night)" strokeWidth={1.5} />
          )}
          <text x={x(p.lng)} y={y(p.lat) + 3.6} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={10} fill="var(--color-night)">
            {marks[i]}
          </text>
        </g>
      ))}
    </svg>
  );
}
