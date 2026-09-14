'use client';

import { useEffect, useRef, useState } from 'react';
import type * as MapLibre from 'maplibre-gl';
import type { GeoPoint } from './map-projection';
import type { VectorBasemap as VectorBasemapSource } from './map-adapter';
import { MAPLIBRE_MODULE_URL, ensureMaplibreStylesheet } from './map-vendor';

/**
 * THE VECTOR BASEMAP UNDER THE ATLAS FIGURE.
 *
 * MapLibre GL renders OpenFreeMap's style into a canvas that sits beneath the
 * SVG figure; the figure keeps every mark, connector, pin and keyboard control
 * it always had, and stays the only thing the pointer talks to. The two share
 * one projection — Web Mercator, world size 512·2^zoom pixels — so the SVG's
 * view (`centre` in world units, `scale` in pixels per world unit) maps onto a
 * MapLibre camera exactly: zoom = log2(scale / 512).
 *
 * ---
 *
 * ## Why the map is a wrapper around a container, and not one div (MVP V3, P0-2)
 *
 * The founder's screenshots showed MapLibre's controls, its label typography and
 * the OpenStreetMap attribution line — and no map. The tiles were never the
 * problem: OpenFreeMap answered 200 for the style, the sprite sheet and the
 * vector planet source, and MapLibre created its canvas at the right pixel size.
 *
 * `Map` writes its own `maplibregl-map` class onto whatever element it is given,
 * and `maplibre-gl.css` — dynamically imported, so it lands *after* the Tailwind
 * layer, at equal specificity — declares `.maplibregl-map { position: relative }`.
 * That beat the `absolute` this component had put on the same element. With
 * `position: relative`, `inset-0` no longer stretches anything, the div collapsed
 * to **472 × 0** because the canvas inside it is itself absolutely positioned,
 * and the whole basemap painted into a clipped nothing.
 *
 * The lesson generalises past this one class name: a third-party library that
 * styles the element you hand it will always be able to overrule the classes you
 * put on that same element. So the element MapLibre owns is now an inner div it
 * may style however it likes, and the positioning lives on a wrapper it never
 * sees. `map-health.test.ts` asserts the two are not the same element.
 *
 * ---
 *
 * ## One health state, said out loud
 *
 * A map that fails silently is a map nobody notices is broken — which is exactly
 * how this shipped. `MapHealth` is reported to the caller so the figure can keep
 * drawing its own graticule until real tiles are on screen, and so a browser test
 * can assert that a basemap actually became `ready`. In development the precise
 * reason for a failure is logged; a traveller only ever sees the quiet fallback.
 */

export type MapHealth = 'loading' | 'ready' | 'degraded' | 'failed';

interface MapLibreLike {
  jumpTo: (camera: { center: [number, number]; zoom: number }) => void;
  resize: () => void;
  remove: () => void;
  on: (event: string, handler: (payload?: unknown) => void) => void;
  loaded: () => boolean;
  /** Used only to find the style's own label layers. See `SUPPRESSED_LABEL_LAYERS`. */
  getStyle: () => { layers?: { id: string; type: string }[] } | undefined;
  setLayoutProperty: (layer: string, property: string, value: unknown) => void;
}

/**
 * V11 §F6 — WHICH OF THE BASEMAP'S OWN LABELS STEP ASIDE.
 *
 * The overlay draws its own names for the places the *trip* is about, with
 * collision handling (`selectLabels`). The basemap underneath draws names for
 * everything else, in its own typography, with no knowledge of what is above it
 * — so a stop's label and a point-of-interest label land on each other and both
 * become unreadable. Measuring that collision from outside the canvas is not
 * possible; the honest fix is to decide which layer owns which kind of name.
 *
 * Point-of-interest and transit-stop labels are ours to draw where they matter
 * and noise where they do not, so they are hidden while the overlay is
 * labelling. **Settlement, country, water and road-shield labels stay**: they are
 * the context a traveller reads the frame with, the overlay never draws them,
 * and hiding them would leave a map of anonymous coastline.
 *
 * Matched on the layer id prefix, which is the convention every OpenMapTiles
 * -derived style follows. A style that names its layers differently keeps all
 * its labels — degraded, never broken.
 */
const SUPPRESSED_LABEL_LAYERS = /^(poi|place_label_other|transit|aerodrome[-_]label|mountain_peak)/i;

/** How long a basemap may take to draw before the figure stops waiting on it. */
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 200;

function zoomFor(scale: number, maxZoom: number): number {
  return Math.max(0, Math.min(maxZoom, Math.log2(scale / 512)));
}

/**
 * Hide the basemap's own point-of-interest labels.
 *
 * Wrapped whole in a `try` because this reaches into a third-party style: a
 * style without the layers, or a library version that renames the method, must
 * leave a working map with a slightly busier caption — never a blank frame.
 */
function hideConflictingLabels(instance: MapLibreLike): void {
  try {
    for (const layer of instance.getStyle()?.layers ?? []) {
      if (layer.type !== 'symbol' || !SUPPRESSED_LABEL_LAYERS.test(layer.id)) continue;
      instance.setLayoutProperty(layer.id, 'visibility', 'none');
    }
  } catch {
    /* A busier map is not a broken one. */
  }
}

export function VectorBasemapLayer({
  source,
  centre,
  scale,
  width,
  height,
  onHealth,
  quietLabels = false,
}: {
  source: VectorBasemapSource;
  centre: GeoPoint;
  scale: number;
  width: number;
  height: number;
  /** Called as the basemap moves through its states, so the figure can decide what to draw. */
  onHealth?: (health: MapHealth) => void;
  /**
   * V11 §F6 — true while the overlay is drawing its own place names.
   *
   * Hides the basemap's point-of-interest labels so two layers do not write over
   * each other. Settlement and geography labels are never touched.
   */
  quietLabels?: boolean;
}) {
  /** The element MapLibre owns. It writes its own class and position onto this one. */
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreLike | null>(null);
  const [health, setHealth] = useState<MapHealth>('loading');
  /**
   * The wrapper's real width divided by the figure's coordinate width.
   *
   * The SVG above is responsive (`width: 100%`, `height: auto` over a fixed
   * viewBox), so on most screens it is drawn at some multiple of the
   * coordinates it was laid out in. The basemap has to be drawn at the *same*
   * multiple or the two layers disagree about where a place is — a map that is
   * wrong in a way nobody can see. Measured rather than assumed.
   */
  const [displayScale, setDisplayScale] = useState(1);
  const report = useRef(onHealth);
  /* The wrapper's own box, watched, so the camera tracks a responsive figure. */
  const wrapper = useRef<HTMLDivElement | null>(null);
  const displayScaleRef = useRef(1);
  const quietLabelsRef = useRef(quietLabels);
  /* Latest values for the long-lived map effect, written after commit rather than during render. */
  useEffect(() => {
    report.current = onHealth;
    displayScaleRef.current = displayScale;
    quietLabelsRef.current = quietLabels;
  }, [onHealth, displayScale, quietLabels]);

  useEffect(() => {
    let cancelled = false;
    const element = container.current;
    if (!element) return;
    const settle = (next: MapHealth, reason?: string) => {
      if (cancelled) return;
      setHealth(next);
      report.current?.(next);
      if (next !== 'ready' && process.env.NODE_ENV !== 'production') {
        console.warn(`[basemap] ${next}${reason ? `: ${reason}` : ''} (style ${source.styleUrl})`);
      }
    };
    let readyTimer = 0;
    (async () => {
      /*
       * Loaded from `public/`, unbundled, and the ignore comments are the whole
       * point: a bundler that rewrites this import also rewrites the
       * `import.meta.url` MapLibre uses to find its own worker, and a MapLibre
       * that cannot find its worker draws nothing and says nothing. See
       * `scripts/vendor-maplibre.mjs`.
       */
      const maplibre = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ MAPLIBRE_MODULE_URL)) as typeof MapLibre;
      ensureMaplibreStylesheet(document);
      if (cancelled || !container.current) return;
      const instance = new maplibre.Map({
        container: container.current,
        style: source.styleUrl,
        center: [centre.lng, centre.lat],
        zoom: zoomFor(scale * displayScaleRef.current, source.maxZoom),
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        maxZoom: source.maxZoom,
      }) as unknown as MapLibreLike;
      map.current = instance;
      /*
       * Readiness is *polled*, not taken on trust from one event.
       *
       * `load` is the documented signal and it is listened for — but a handler
       * attached after construction can miss it, and a library upgrade can
       * rename or re-order it. The map's own `loaded()` is the fact; the event
       * is an optimisation. This is exactly the class of silent failure that let
       * a collapsed basemap ship, so the state is derived from the map itself.
       */
      let settled = false;
      const become = (next: MapHealth, reason?: string) => {
        if (settled && next !== 'degraded') return;
        settled = true;
        settle(next, reason);
      };
      instance.on('load', () => {
        become('ready');
        /*
         * Once, on load, and never in the camera effect: a style's layer list is
         * fixed for the life of the style, and setting a layout property on
         * every pan is a repaint the frame does not need.
         */
        if (quietLabelsRef.current) hideConflictingLabels(instance);
      });
      const startedAt = Date.now();
      const poll = () => {
        if (cancelled || settled) return;
        if (instance.loaded()) {
          become('ready');
          return;
        }
        if (Date.now() - startedAt > READY_TIMEOUT_MS) {
          become('degraded', 'the style did not finish drawing in time');
          return;
        }
        readyTimer = window.setTimeout(poll, READY_POLL_MS);
      };
      readyTimer = window.setTimeout(poll, READY_POLL_MS);
      /*
       * A tile, sprite or glyph that does not answer is a *degraded* map, not a
       * failed one: MapLibre keeps drawing everything it did get. Only a failure
       * before the style loads leaves nothing on screen.
       */
      instance.on('error', (payload) => {
        const detail = (payload as { error?: { message?: string } } | undefined)?.error?.message;
        become(instance.loaded() ? 'degraded' : 'failed', detail);
      });
    })().catch((error: unknown) => {
      settle('failed', error instanceof Error ? error.message : 'the map library could not be loaded');
    });
    return () => {
      cancelled = true;
      window.clearTimeout(readyTimer);
      map.current?.remove();
      map.current = null;
    };
    // The style and container are fixed for the life of the layer; camera moves are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.styleUrl]);

  useEffect(() => {
    const element = wrapper.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || width <= 0) return;
      const next = box.width / width;
      if (Number.isFinite(next) && next > 0) setDisplayScale(next);
      map.current?.resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);

  useEffect(() => {
    map.current?.jumpTo({ center: [centre.lng, centre.lat], zoom: zoomFor(scale * displayScale, source.maxZoom) });
  }, [centre.lat, centre.lng, scale, displayScale, source.maxZoom]);

  useEffect(() => {
    map.current?.resize();
  }, [width, height]);

  return (
    <div
      ref={wrapper}
      aria-hidden="true"
      data-testid="vector-basemap"
      data-map-health={health}
      /*
       * The wrapper carries the geometry, and it is an element MapLibre never
       * touches — which is the whole point (see the note above). It stretches to
       * the frame so the basemap is drawn at the same size as the responsive SVG
       * over it, and `displayScale` keeps the two cameras in register.
       */
      className="pointer-events-none absolute inset-0"
    >
      <div ref={container} data-testid="vector-basemap-canvas" style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
