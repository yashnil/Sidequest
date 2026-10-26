'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type * as MapLibre from 'maplibre-gl';
import { MAPLIBRE_MODULE_URL, ensureMaplibreStylesheet } from '../map-vendor';
import { ATLAS_TOURS, arcThrough, stopProgress, type AtlasTour } from './atlas-tours';
import { scaleBar } from '../atlas/atlas-model';
import { ExampleStill } from './ExampleStill';
import { NIGHT_ATTRIBUTION, nightAtlasStyle } from './night-style';

/**
 * THE LANDING GLOBE.
 *
 * Real geography on the first screen: a night globe with shaded relief that
 * flies down into a region, draws an example trip's shape as a flare line
 * through real towns, and lights each waypoint as the line arrives. Then the
 * next region. It is the product's argument in one motion — a route emerges
 * from the land — and it is honest about being an example: the caption says so
 * and the line is a great-circle sketch, never a road.
 *
 * ## Loading, and every way it can decline
 *
 * The server renders a poster (night ground and contours) that is the whole
 * hero on its own. The globe is an enhancement, started only when all of
 * these hold: the deployment has a basemap provider (`enabled`); the hero is on
 * screen; the browser is idle; WebGL2 exists; and the visitor has not asked to
 * save data. MapLibre comes from `public/vendor` (never the bundle — see
 * `map-vendor.ts`). It cross-fades in on its first rendered frame; any error
 * before that leaves the poster, silently.
 *
 * ## Motion
 *
 * Auto-advancing content longer than five seconds must be pausable (WCAG
 * 2.2.2), so there is a pause control, and hovering or focusing the hero
 * holds the current region. Under `prefers-reduced-motion` the camera jumps
 * instead of flying, the line is drawn whole, and nothing advances on its own:
 * the region buttons still work.
 *
 * ## Survey Atlas (2026-10)
 *
 * The chrome is an instrument now, not a row of pills: a mono coordinate bar
 * along the foot that reads the live camera (centre, zoom, bearing, tilt and a
 * scale bar), and the example journeys as a numbered vertical index on the
 * right edge — each still labelled "Example shape". Before WebGL answers, and
 * on a machine that never will, the hero shows a designed still
 * (`ExampleStill`): the same example's real towns plotted on the night grid,
 * not an empty box. Fewer map labels: country names fade out before the
 * camera reaches a region (`night-style.ts`).
 */

type Phase = 'poster' | 'loading' | 'live';

interface MapHandle {
  flyTo: (o: Record<string, unknown>) => void;
  jumpTo: (o: Record<string, unknown>) => void;
  setPaintProperty: (layer: string, prop: string, value: unknown) => void;
  getSource: (id: string) => { setData: (d: unknown) => void } | undefined;
  addSource: (id: string, s: unknown) => void;
  addLayer: (l: unknown) => void;
  on: (e: string, h: (p?: unknown) => void) => void;
  once: (e: string, h: (p?: unknown) => void) => void;
  off: (e: string, h: (p?: unknown) => void) => void;
  remove: () => void;
  resize: () => void;
  isStyleLoaded: () => boolean;
  triggerRepaint?: () => void;
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
}

interface Camera {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

const FLARE = '#ff5a1f';
const FLY_MS = 3600;
const DRAW_MS = 2600;
const HOLD_MS = 4200;
/** The longest a drawing waits for a region's tiles after the flight lands. */
const ARRIVAL_CAP_MS = 2500;

/**
 * Can this browser draw the globe? The probe's context is released straight
 * away: browsers cap live WebGL contexts per page (Chrome ~16), and a probe
 * that kept its context — next to the board's and the day maps' — was how a
 * later visit to the front page found no context left and stayed on the
 * still until a reload.
 */
function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/* How long the map may take to say it is ready before it is set up anyway (its style loaded) or tried again. */
const READY_GRACE_MS = 4500;
const RETRY_DELAYS_MS = [700, 1800] as const;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function routeGradient(progress: number): unknown {
  const p = Math.min(0.9999, Math.max(0.0001, progress));
  return ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(255,90,31,0.25)', p * 0.6, 'rgba(255,90,31,0.75)', p, FLARE, Math.min(1, p + 0.0001), 'rgba(255,90,31,0)'];
}

function tourData(tour: AtlasTour, progress: number) {
  const marks = stopProgress(tour.stops);
  return {
    line: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: arcThrough(tour.stops) } },
    stops: {
      type: 'FeatureCollection',
      features: tour.stops.map((stop, i) => ({
        type: 'Feature',
        properties: { name: stop.name, reached: progress + 1e-6 >= marks[i]! ? 1 : 0, first: i === 0 ? 1 : 0 },
        geometry: { type: 'Point', coordinates: [stop.lng, stop.lat] },
      })),
    },
  };
}

export function AtlasGlobe({ enabled }: { enabled: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapHandle | null>(null);
  const [phase, setPhase] = useState<Phase>('poster');
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const [still, setStill] = useState(false);
  /** The index whose route has finished drawing; the tour advances only from there. */
  const [drawn, setDrawn] = useState(-1);
  const animation = useRef(0);
  const [camera, setCamera] = useState<Camera | null>(null);
  const tour = ATLAS_TOURS[index]!;

  /* Start the globe only when every condition above holds. */
  useEffect(() => {
    if (!enabled) return;
    const element = host.current;
    if (!element) return;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (saveData || !supportsWebGL2()) return;
    let cancelled = false;
    let started = false;
    let retryTimer = 0;
    let graceTimer = 0;
    /* One attempt at the live globe; a failure (module, context, a style that never settles) tries again, then keeps the designed still. */
    const boot = (attempt: number) => {
      if (cancelled || !container.current) return;
      const retry = () => {
        window.clearTimeout(graceTimer);
        map.current?.remove();
        map.current = null;
        if (cancelled) return;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          setPhase('poster');
          return;
        }
        retryTimer = window.setTimeout(() => boot(attempt + 1), delay);
      };
      (async () => {
        const maplibre = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ MAPLIBRE_MODULE_URL)) as typeof MapLibre;
        ensureMaplibreStylesheet(document);
        if (cancelled || !container.current) return;
        const first = ATLAS_TOURS[0]!;
        const instance = new maplibre.Map({
          container: container.current,
          style: nightAtlasStyle({ terrain: true }) as unknown as MapLibre.StyleSpecification,
          center: [first.camera.lng - 40, first.camera.lat * 0.4],
          zoom: 1.35,
          pitch: 0,
          interactive: false,
          attributionControl: false,
          fadeDuration: 200,
          maxPitch: 60,
        }) as unknown as MapHandle;
        map.current = instance;
        instance.on('error', () => {
          /* A tile that does not answer is a quieter map, not a broken hero. */
        });
        /* A context the browser takes back (memory pressure, a sleeping laptop, too many maps) is rebuilt, not left blank. */
        instance.on('webglcontextlost', () => {
          if (cancelled) return;
          setPhase('loading');
          retry();
        });
        /* The scale bar reads the camera, at most once a frame. */
        let frame = 0;
        const report = () => {
          const c = instance.getCenter();
          setCamera({ lat: c.lat, lng: c.lng, zoom: instance.getZoom(), bearing: instance.getBearing(), pitch: instance.getPitch() });
        };
        instance.on('move', () => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            report();
          });
        });
        let ready = false;
        const setup = () => {
          if (ready || cancelled) return;
          ready = true;
          window.clearTimeout(graceTimer);
          const data = tourData(first, 0);
          instance.addSource('route', { type: 'geojson', data: data.line, lineMetrics: true });
          instance.addSource('stops', { type: 'geojson', data: data.stops });
          instance.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 9, 'line-blur': 6, 'line-gradient': routeGradient(0), 'line-opacity': 0.45 } });
          instance.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 3, 'line-gradient': routeGradient(0) } });
          instance.addLayer({ id: 'stop-halo', type: 'circle', source: 'stops', paint: { 'circle-radius': ['case', ['==', ['get', 'reached'], 1], 11, 0], 'circle-color': FLARE, 'circle-opacity': 0.18, 'circle-radius-transition': { duration: 400 } } });
          instance.addLayer({ id: 'stop', type: 'circle', source: 'stops', paint: { 'circle-radius': ['case', ['==', ['get', 'reached'], 1], 4.5, 2], 'circle-color': ['case', ['==', ['get', 'reached'], 1], FLARE, '#5e7479'], 'circle-stroke-color': '#0a161b', 'circle-stroke-width': 1.5 } });
          instance.addLayer({
            id: 'stop-label',
            type: 'symbol',
            source: 'stops',
            filter: ['==', ['get', 'reached'], 1],
            layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.14, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': false },
            paint: { 'text-color': '#f1ebdf', 'text-halo-color': '#0a161b', 'text-halo-width': 1.5 },
          });
          report();
          setPhase('live');
        };
        instance.once('load', setup);
        /*
         * 'load' waits for the first tiles, and one slow terrain tile could hold
         * the hero on its still indefinitely. The globe starts as soon as the
         * style itself has loaded and the tiles stream in; if even the style has
         * not arrived within the grace period, try again.
         */
        /* The style is enough to start: the route draws while the first tiles fade in under it. */
        const styleReady = () => {
          if (instance.isStyleLoaded()) setup();
        };
        instance.on('styledata', styleReady);
        graceTimer = window.setTimeout(() => {
          if (ready || cancelled) return;
          if (instance.isStyleLoaded()) setup();
          else retry();
        }, READY_GRACE_MS);
      })().catch(() => {
        if (!cancelled) retry();
      });
    };
    const start = () => {
      if (started || cancelled) return;
      started = true;
      setStill(reducedMotion());
      setPhase('loading');
      boot(0);
    };
    const idle = (fn: () => void) => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
      if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 700 });
      else window.setTimeout(fn, 300);
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        idle(start);
      }
    });
    observer.observe(element);
    const onResize = () => map.current?.resize();
    window.addEventListener('resize', onResize);
    /* Back to the page from the browser's back-forward cache: wake the map and redraw it. */
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      map.current?.resize();
      map.current?.triggerRepaint?.();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(graceTimer);
      window.removeEventListener('pageshow', onPageShow);
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(animation.current);
      map.current?.remove();
      map.current = null;
    };
  }, [enabled]);

  /* Fly to the current region and draw its route. */
  useEffect(() => {
    const instance = map.current;
    if (phase !== 'live' || !instance) return;
    const data = tourData(tour, still ? 1 : 0);
    instance.getSource('route')?.setData(data.line);
    instance.getSource('stops')?.setData(data.stops);
    /*
     * The words own the left of the hero on a wide screen and the top on a
     * phone; the camera centres the route in what is left, so the line is
     * never drawn under the headline.
     */
    const box = host.current?.getBoundingClientRect();
    const wide = (box?.width ?? 0) >= 1024;
    const padding = wide
      ? { left: Math.round((box?.width ?? 0) * 0.4), right: 360, top: 70, bottom: 90 }
      : { left: 24, right: 24, top: 48, bottom: 190 };
    const zoom = tour.camera.zoom - (wide ? 0.35 : (box?.width ?? 0) < 640 ? 1.15 : 0.6);
    const camera = { center: [tour.camera.lng, tour.camera.lat], zoom, padding, pitch: still ? 0 : tour.camera.pitch, bearing: still ? 0 : tour.camera.bearing };
    cancelAnimationFrame(animation.current);
    if (still) {
      instance.jumpTo(camera);
      instance.setPaintProperty('route', 'line-gradient', routeGradient(1));
      instance.setPaintProperty('route-glow', 'line-gradient', routeGradient(1));
      return;
    }
    instance.setPaintProperty('route', 'line-gradient', routeGradient(0));
    instance.setPaintProperty('route-glow', 'line-gradient', routeGradient(0));
    instance.flyTo({ ...camera, duration: FLY_MS, curve: 1.6, essential: false });
    /*
     * The line is drawn once the region has arrived: after the flight, when
     * the map reports its tiles loaded (or after a short cap on a slow
     * connection), so a route is never sketched over land that is not there
     * yet. The next region is scheduled from the end of the drawing.
     */
    let cancelled = false;
    let begin = Number.POSITIVE_INFINITY;
    let lastReached = -1;
    const marks = stopProgress(tour.stops);
    const frame = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - begin) / DRAW_MS));
      const eased = 1 - (1 - t) ** 3;
      instance.setPaintProperty('route', 'line-gradient', routeGradient(eased));
      instance.setPaintProperty('route-glow', 'line-gradient', routeGradient(eased));
      const reached = marks.filter((m) => eased + 1e-6 >= m).length;
      if (reached !== lastReached) {
        lastReached = reached;
        instance.getSource('stops')?.setData(tourData(tour, eased).stops);
      }
      if (t < 1) animation.current = requestAnimationFrame(frame);
      else setDrawn(index);
    };
    let capTimer = 0;
    const draw = () => {
      if (cancelled || begin !== Number.POSITIVE_INFINITY) return;
      window.clearTimeout(capTimer);
      begin = performance.now();
      animation.current = requestAnimationFrame(frame);
    };
    const arrived = window.setTimeout(() => {
      if (cancelled) return;
      instance.once('idle', draw);
      capTimer = window.setTimeout(draw, ARRIVAL_CAP_MS);
    }, FLY_MS);
    return () => {
      cancelled = true;
      instance.off('idle', draw);
      window.clearTimeout(arrived);
      window.clearTimeout(capTimer);
      cancelAnimationFrame(animation.current);
    };
  }, [phase, tour, still, index]);

  /* Advance a hold after the route is drawn, unless paused, held by hover/focus, or still. */
  useEffect(() => {
    if (phase !== 'live' || paused || held || still || drawn !== index) return;
    const timer = window.setTimeout(() => setIndex((i) => (i + 1) % ATLAS_TOURS.length), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [phase, paused, held, still, index, drawn]);

  const scale = camera ? scaleBar(camera.lat, camera.zoom, 72) : null;
  const iconButton = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-white/20 text-xs text-[var(--color-atlas-ink)] hover:border-white/50 focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2';

  return (
    <div
      ref={host}
      className="absolute inset-0"
      data-testid="atlas-globe"
      data-phase={phase}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {/* The designed still: the example's real towns on the night grid, until (or unless) the globe draws. */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 bottom-44 transition-opacity duration-[1200ms] ease-out lg:right-[22rem] lg:bottom-10 lg:left-[40%]" style={{ opacity: phase === 'live' ? 0 : 1 }}>
        <ExampleStill tour={tour} />
      </div>
      <div
        aria-hidden="true"
        className="absolute inset-0 transition-opacity duration-[1200ms] ease-out"
        style={{ opacity: phase === 'live' ? 1 : 0 }}
      >
        <div ref={container} style={{ width: '100%', height: '100%' }} />
      </div>
      {/* Cinema: the edges of the world fall away into the night ground. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(120%_90%_at_70%_45%,transparent_55%,rgb(8_20_26/0.75)_100%)]" />

      {/* THE INDEX — the example journeys, numbered, on the right edge. Real buttons, keyboard reachable. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[4.75rem] z-[3] px-5 sm:px-8 lg:inset-x-auto lg:top-1/2 lg:right-8 lg:bottom-auto lg:w-[19rem] lg:-translate-y-1/2 lg:px-0">
        <div className="pointer-events-auto">
          <p className="sheet-label text-[var(--color-atlas-muted)] max-lg:sr-only">Try an example trip</p>
          <ol className="mt-3 -mx-5 flex gap-1 overflow-x-auto px-5 [scrollbar-width:none] lg:mx-0 lg:block lg:overflow-visible lg:border-t lg:border-white/15 lg:px-0" aria-label="Example regions">
            {ATLAS_TOURS.map((t, i) => {
              const active = i === index;
              return (
                <li key={t.id} className="shrink-0 lg:border-b lg:border-white/15">
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-pressed={active}
                    className={`group flex min-h-11 w-full items-baseline gap-3 rounded-full border px-3.5 py-2 text-left transition-colors duration-[var(--motion-fast)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2 lg:rounded-none lg:border-0 lg:px-0 lg:py-2.5 ${active ? 'border-[var(--color-flare)] text-[var(--color-atlas-ink)]' : 'border-white/15 text-[var(--color-atlas-muted)] hover:text-[var(--color-atlas-ink)]'}`}
                  >
                    <span className={`font-mono text-[0.72rem] tabular-nums ${active ? 'text-[var(--color-flare)]' : ''}`}>{String(i + 1).padStart(2, '0')}</span>
                    <span className={`whitespace-nowrap font-display text-base lg:text-[1.15rem] ${active ? '' : 'lg:font-[340]'}`}>{t.prompt}</span>
                    <span className="ml-auto hidden font-mono text-[0.68rem] tabular-nums lg:inline">{t.days} days</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-sm leading-snug text-[var(--color-atlas-muted)] lg:basis-full" aria-live="polite">
              <span className="coordbar mr-2 text-[var(--color-glacier)]">Example</span>
              <span className="sr-only">{tour.prompt}. </span>
              {tour.note}
            </p>
            <Link
              href={`/trips/new?destination=${encodeURIComponent(tour.prompt)}`}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-semibold text-[var(--color-atlas-ink)] underline decoration-[var(--color-flare)] decoration-2 underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2"
              data-testid="home-prompt"
            >
              Plan a trip like this <span aria-hidden="true">→</span>
            </Link>
            {phase === 'live' && !still ? (
              <button type="button" onClick={() => setPaused((p) => !p)} className={iconButton} aria-label={paused ? 'Resume the tour' : 'Pause the tour'}>
                {paused ? '▶' : '❚❚'}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* THE FOOT STRIP — which example is showing, its scale and the map credits. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] border-t border-white/10 bg-[rgb(8_20_26/0.55)] backdrop-blur-[2px]">
        <div className="mx-auto flex min-h-10 max-w-[1600px] min-w-0 items-center gap-x-5 overflow-hidden px-5 text-[var(--color-atlas-muted)] sm:px-8" data-testid="home-coordbar">
          {/* What the globe is showing, in words — not the camera's numbers. */}
          <span className="coordbar text-[var(--color-glacier)]">Example trip</span>
          <span className="coordbar truncate text-[var(--color-atlas-ink)]">
            {tour.prompt} · {tour.stops.length} stops · {tour.days} days
          </span>
          {camera && phase === 'live' && scale ? (
            <span className="coordbar inline-flex items-center gap-2 max-lg:hidden">
              <span aria-hidden="true" className="inline-block h-1.5 border-x border-b border-current" style={{ width: scale.px }} />
              {scale.label}
            </span>
          ) : null}
          {phase === 'live' ? <span className="ml-auto truncate text-[0.62rem] leading-snug max-lg:hidden">{NIGHT_ATTRIBUTION}</span> : null}
        </div>
        {phase === 'live' ? <p className="truncate px-5 pb-1.5 text-[0.6rem] text-[var(--color-atlas-muted)] lg:hidden">{NIGHT_ATTRIBUTION}</p> : null}
      </div>
    </div>
  );
}
