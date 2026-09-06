'use client';

import { useMemo, useState } from 'react';
import { InteractiveMap, type MapConnector, type MapMarker } from '../InteractiveMap';
import type { MapBasemap } from '../map-adapter';
import { cx } from '../ui';

/**
 * PRODUCTION UI V1 — A REAL MAP UNDER THE QUESTIONS, NOT A 50 KM RING.
 *
 * Once the destination is resolved, the interview's right rail shows where it
 * actually is: the resolved centre, the published bounds where the geocoder
 * gave one (drawn as a thin frame — the honest shape of "Ireland", rather than
 * a circle), and the traveller's stated reach as the ring the map already
 * draws around a base. With a vector basemap configured the roads, coast and
 * water come from OpenFreeMap; without one the drawing is positions and
 * geometry only, and the caption says so. Nothing here draws a route: before
 * a plan exists there is no route to draw.
 */
export interface DestinationGeometry {
  name: string;
  center: { lat: number; lng: number };
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null;
  featureType?: string;
}

export function DestinationMap({ geometry, tiles = null, shape, rangeKm = 30, className }: { geometry: DestinationGeometry; tiles?: MapBasemap | null; shape: 'stay_put' | 'moving'; /** The traveller's stated reach, so a point destination is framed at the scale the trip will actually cover. */ rangeKm?: number; className?: string }) {
  const [focused, setFocused] = useState<string | null>(null);
  const { markers, connectors, fitPoints } = useMemo(() => {
    const markers: MapMarker[] = [{ id: 'centre', name: geometry.name, coordinates: geometry.center, kind: 'base' }];
    const connectors: MapConnector[] = [];
    const fitPoints: { lat: number; lng: number }[] = [];
    const b = geometry.bounds;
    if (b) {
      const sw = b.southWest;
      const ne = b.northEast;
      const corners = [sw, { lat: sw.lat, lng: ne.lng }, ne, { lat: ne.lat, lng: sw.lng }];
      for (let i = 0; i < 4; i += 1) connectors.push({ id: `bounds-${i}`, from: corners[i]!, to: corners[(i + 1) % 4]!, style: 'sightline' });
      fitPoints.push(...corners);
    } else {
      // No published extent: frame the traveller's own reach, so the ring the map draws around the base is what fills it.
      const dLat = rangeKm / 111;
      const dLng = rangeKm / (111 * Math.max(0.2, Math.cos((geometry.center.lat * Math.PI) / 180)));
      fitPoints.push({ lat: geometry.center.lat + dLat, lng: geometry.center.lng + dLng }, { lat: geometry.center.lat - dLat, lng: geometry.center.lng - dLng });
    }
    return { markers, connectors, fitPoints };
  }, [geometry, rangeKm]);
  const extent = geometry.bounds ? `about ${Math.round(kmBetween(geometry.bounds.southWest, geometry.bounds.northEast))} km corner to corner` : null;
  return (
    <div className={cx('min-w-0', className)} data-testid="destination-map">
      <InteractiveMap
        testId="destination-map-canvas"
        markers={markers}
        connectors={connectors}
        fitPoints={fitPoints}
        base={{ name: geometry.name, coordinates: geometry.center }}
        focusedId={focused}
        onFocus={setFocused}
        tiles={tiles}
        width={420}
        height={300}
        summary={`${geometry.name}${extent ? `, ${extent}` : ''}. ${shape === 'stay_put' ? 'One base with days out from it.' : 'A moving route between bases.'}`}
        caption={
          <span>
            {geometry.bounds ? 'The thin frame is the destination’s published extent. ' : ''}
            {shape === 'stay_put' ? 'One base, days out from it.' : 'A moving route: bases to be chosen by the plan.'} No route is drawn before a plan exists.
          </span>
        }
      />
    </div>
  );
}

function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
