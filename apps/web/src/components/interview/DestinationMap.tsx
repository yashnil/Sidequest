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

const URBAN_FEATURES = new Set(['city', 'town', 'district', 'neighbourhood', 'metro_area']);

export type ConceptualMovement = 'car' | 'transit_walk' | 'guided' | 'boat' | 'mixed' | null;

/**
 * EXPERIENCE V2 — THE MAP REACTS TO THE ANSWERS, HONESTLY.
 *
 * Nothing here is a route: before a plan exists there is none to draw. What
 * the answers change are *conceptual layers*, each labelled as such in the
 * caption: a decided reach as a ring; a moving route as two or three hollow
 * base marks joined by a dashed line, positioned schematically inside the
 * frame; day trips as outer marks; transit as short spokes from the centre.
 * The traveller sees the trip take shape without a single invented place.
 */
export function DestinationMap({
  geometry,
  tiles = null,
  shape,
  rangeKm = null,
  bases = 1,
  movement = null,
  dayTrips = null,
  className,
}: {
  geometry: DestinationGeometry;
  tiles?: MapBasemap | null;
  shape: 'stay_put' | 'moving';
  /** A decided reach, drawn as a ring. Null — nothing decided yet — draws no ring and frames the place at its own scale. */
  rangeKm?: number | null;
  /** How many bases the trip is shaping up to have; two or more draw conceptual base marks. */
  bases?: 1 | 2 | 3;
  movement?: ConceptualMovement;
  dayTrips?: 'stay_in_city' | 'one_day_trip' | 'several' | null;
  className?: string;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  const { markers, connectors, fitPoints } = useMemo(() => {
    const markers: MapMarker[] = [{ id: 'centre', name: geometry.name, coordinates: geometry.center, kind: 'base' }];
    const connectors: MapConnector[] = [];
    const fitPoints: { lat: number; lng: number }[] = [];
    const b = geometry.bounds;
    const urban = URBAN_FEATURES.has(geometry.featureType ?? '');
    const offset = (km: number, bearingDeg: number) => {
      const dLat = (km / 111) * Math.cos((bearingDeg * Math.PI) / 180);
      const dLng = ((km / 111) * Math.sin((bearingDeg * Math.PI) / 180)) / Math.max(0.2, Math.cos((geometry.center.lat * Math.PI) / 180));
      return { lat: geometry.center.lat + dLat, lng: geometry.center.lng + dLng };
    };
    const scaleKm = rangeKm ?? (b ? Math.max(8, kmBetween(b.southWest, b.northEast) / 3) : urban ? 10 : 35);
    // Conceptual bases for a moving route: schematic positions, hollow marks, a dashed line.
    if (bases >= 2) {
      const second = offset(scaleKm * 0.8, 62);
      markers.push({ id: 'concept-base-2', name: 'Second base (to be chosen)', coordinates: second, kind: 'place' });
      connectors.push({ id: 'concept-move-1', from: geometry.center, to: second, style: 'sightline' });
      fitPoints.push(second);
      if (bases >= 3) {
        const third = offset(scaleKm * 0.9, 150);
        markers.push({ id: 'concept-base-3', name: 'Third base (to be chosen)', coordinates: third, kind: 'place' });
        connectors.push({ id: 'concept-move-2', from: second, to: third, style: 'sightline' });
        fitPoints.push(third);
      }
    }
    // Day trips out of a city: outer marks at the edge of the reach.
    if (dayTrips === 'one_day_trip' || dayTrips === 'several') {
      const count = dayTrips === 'several' ? 3 : 1;
      for (let i = 0; i < count; i += 1) {
        const point = offset(scaleKm * 1.6, 300 + i * 70);
        markers.push({ id: `concept-daytrip-${i}`, name: 'A day out (to be chosen)', coordinates: point, kind: 'place' });
        connectors.push({ id: `concept-daytrip-${i}`, from: geometry.center, to: point, style: 'sightline' });
        fitPoints.push(point);
      }
    }
    // Transit and walking: short spokes from the centre — the city covered from one base by its network.
    if (movement === 'transit_walk' && bases === 1) {
      for (let i = 0; i < 6; i += 1) connectors.push({ id: `concept-spoke-${i}`, from: geometry.center, to: offset(scaleKm * 0.45, i * 60 + 15), style: 'measured_transit' });
    }
    if (b) {
      const sw = b.southWest;
      const ne = b.northEast;
      const corners = [sw, { lat: sw.lat, lng: ne.lng }, ne, { lat: ne.lat, lng: sw.lng }];
      for (let i = 0; i < 4; i += 1) connectors.push({ id: `bounds-${i}`, from: corners[i]!, to: corners[(i + 1) % 4]!, style: 'sightline' });
      fitPoints.push(...corners);
    } else {
      // No published extent: frame the decided reach when there is one, else the place at its own scale — a
      // city at a dozen kilometres, a region at forty. A radius nobody chose is never drawn.
      const frameKm = rangeKm ?? (URBAN_FEATURES.has(geometry.featureType ?? '') ? 12 : 40);
      const dLat = frameKm / 111;
      const dLng = frameKm / (111 * Math.max(0.2, Math.cos((geometry.center.lat * Math.PI) / 180)));
      fitPoints.push({ lat: geometry.center.lat + dLat, lng: geometry.center.lng + dLng }, { lat: geometry.center.lat - dLat, lng: geometry.center.lng - dLng });
    }
    return { markers, connectors, fitPoints };
  }, [geometry, rangeKm, bases, movement, dayTrips]);
  const extent = geometry.bounds ? `about ${Math.round(kmBetween(geometry.bounds.southWest, geometry.bounds.northEast))} km corner to corner` : null;
  const conceptual = bases >= 2 || dayTrips === 'one_day_trip' || dayTrips === 'several' || movement === 'transit_walk';
  const movementWord = movement === 'car' ? 'by car' : movement === 'transit_walk' ? 'on foot and by transit' : movement === 'guided' ? 'with guides and transfers' : movement === 'boat' ? 'by boat' : movement === 'mixed' ? 'by car where it helps' : null;
  return (
    <div className={cx('min-w-0', className)} data-testid="destination-map">
      <InteractiveMap
        testId="destination-map-canvas"
        markers={markers}
        connectors={connectors}
        fitPoints={fitPoints}
        base={rangeKm !== null ? { name: geometry.name, coordinates: geometry.center } : null}
        focusedId={focused}
        onFocus={setFocused}
        tiles={tiles}
        width={420}
        height={300}
        summary={`${geometry.name}${extent ? `, ${extent}` : ''}. ${shape === 'stay_put' ? (URBAN_FEATURES.has(geometry.featureType ?? '') ? 'One base, the city around it.' : 'One base with days out from it.') : 'A moving route between bases.'}`}
        caption={
          <span>
            {geometry.bounds ? 'The thin frame is the destination’s published extent. ' : ''}
            {shape === 'stay_put' ? (URBAN_FEATURES.has(geometry.featureType ?? '') ? 'One base, the city around it' : 'One base, days out from it') : `A moving route with ${bases} bases`}
            {movementWord ? `, ${movementWord}` : ''}. {conceptual ? 'Hollow marks and dashed lines are conceptual: nothing is placed until the plan is built.' : rangeKm === null ? 'No range is drawn until you decide how far the trip should reach.' : 'The ring is the reach you chose.'}
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
