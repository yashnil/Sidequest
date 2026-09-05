'use client';

import { useEffect, useRef } from 'react';
import type { GeoPoint } from './map-projection';
import type { VectorBasemap as VectorBasemapSource } from './map-adapter';

/**
 * THE VECTOR BASEMAP UNDER THE ATLAS FIGURE.
 *
 * MapLibre GL renders OpenFreeMap's style into a canvas that sits beneath the
 * SVG figure; the figure keeps every mark, connector, pin and keyboard
 * control it always had, and stays the only thing the pointer talks to. The
 * two share one projection — Web Mercator, world size 512·2^zoom pixels — so
 * the SVG's view (`centre` in world units, `scale` in pixels per world unit)
 * maps onto a MapLibre camera exactly: zoom = log2(scale / 512).
 *
 * Loaded on the client, lazily, only when a vector basemap is configured, so
 * a build with no map provider ships no map library and reaches no tile host.
 */
export function VectorBasemapLayer({ source, centre, scale, width, height }: { source: VectorBasemapSource; centre: GeoPoint; scale: number; width: number; height: number }) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<{ jumpTo: (camera: { center: [number, number]; zoom: number }) => void; resize: () => void; remove: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const element = container.current;
    if (!element) return;
    (async () => {
      const maplibre = await import('maplibre-gl');
      await import('maplibre-gl/dist/maplibre-gl.css');
      if (cancelled || !container.current) return;
      const instance = new maplibre.Map({
        container: container.current,
        style: source.styleUrl,
        center: [centre.lng, centre.lat],
        zoom: Math.max(0, Math.min(source.maxZoom, Math.log2(scale / 512))),
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        maxZoom: source.maxZoom,
      });
      map.current = instance;
    })().catch(() => {
      /* No basemap is a complete figure; a tile host that does not answer is not an error the traveller needs. */
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
    // The style and container are fixed for the life of the layer; camera moves are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.styleUrl]);

  useEffect(() => {
    map.current?.jumpTo({ center: [centre.lng, centre.lat], zoom: Math.max(0, Math.min(source.maxZoom, Math.log2(scale / 512))) });
  }, [centre.lat, centre.lng, scale, source.maxZoom]);

  useEffect(() => {
    map.current?.resize();
  }, [width, height]);

  return <div ref={container} aria-hidden="true" className="absolute inset-0" data-testid="vector-basemap" style={{ opacity: 0.92 }} />;
}
