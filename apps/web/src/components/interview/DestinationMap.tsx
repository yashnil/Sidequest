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

/**
 * How far out to sit when nobody published an extent, by what kind of place it is.
 *
 * Not a claim about size: a country is not eight hundred kilometres across, and
 * the caption never says it is. It is the distance at which a single mark reads
 * as "somewhere in this country" instead of as a pinpoint in an empty field.
 */
const FRAME_KM: Record<string, number> = {
  country: 800,
  dependency: 300,
  region: 200,
  county: 90,
  island: 90,
  national_park: 60,
  protected_area: 60,
};

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
  chromeless = false,
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
  /** Draw the map and its attribution, nothing else. For screens where it is scenery. */
  chromeless?: boolean;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  const { markers, connectors, fitPoints } = useMemo(() => {
    /*
     * MVP V3 — THE BASEMAP ALREADY SAYS WHERE THIS IS.
     *
     * Seen on the live Kyrgyzstan generation screen: "Kyrgyzstan" drawn by
     * Sidequest directly over "Kyrgyzstan / Кыргызстан" drawn by the basemap,
     * the two overlapping into one smear. Over a real basemap the centre mark
     * is a position rather than a caption, and the screen's own heading names
     * the place; the name is kept when there is no basemap, where it is the
     * only thing saying what the reader is looking at.
     */
    const markers: MapMarker[] = [{ id: 'centre', name: tiles ? '' : geometry.name, coordinates: geometry.center, kind: 'base' }];
    const connectors: MapConnector[] = [];
    const fitPoints: { lat: number; lng: number }[] = [];
    const b = geometry.bounds;
    const urban = URBAN_FEATURES.has(geometry.featureType ?? '');
    /*
     * A CONCEPTUAL MARK STAYS INSIDE THE DESTINATION.
     *
     * These positions are schematic — nobody has chosen a second base yet — but
     * over a real basemap a position is read as a place. Seen on the live
     * Kyrgyzstan run: "Third base (to be chosen)" drawn beyond the published
     * extent, over China. Clamped to the bounds with a small inset, so a
     * schematic mark is at least somewhere the trip could go. Without bounds
     * there is nothing to clamp to and the offset stands.
     */
    const clamp = (point: { lat: number; lng: number }) => {
      if (!b) return point;
      const insetLat = (b.northEast.lat - b.southWest.lat) * 0.08;
      const insetLng = (b.northEast.lng - b.southWest.lng) * 0.08;
      return {
        lat: Math.min(b.northEast.lat - insetLat, Math.max(b.southWest.lat + insetLat, point.lat)),
        lng: Math.min(b.northEast.lng - insetLng, Math.max(b.southWest.lng + insetLng, point.lng)),
      };
    };
    const offset = (km: number, bearingDeg: number) => {
      const dLat = (km / 111) * Math.cos((bearingDeg * Math.PI) / 180);
      const dLng = ((km / 111) * Math.sin((bearingDeg * Math.PI) / 180)) / Math.max(0.2, Math.cos((geometry.center.lat * Math.PI) / 180));
      return clamp({ lat: geometry.center.lat + dLat, lng: geometry.center.lng + dLng });
    };
    const scaleKm = rangeKm ?? (b ? Math.max(8, kmBetween(b.southWest, b.northEast) / 3) : urban ? 10 : 35);
    // Conceptual bases for a moving route: schematic positions, hollow marks, a dashed line.
    /*
     * NAMELESS ON PURPOSE (V6 §Map).
     *
     * These marks used to carry the strings "Second base (to be chosen)" and
     * "Third base (to be chosen)", which `InteractiveMap` draws on the map and
     * reads out in its marker list — so a traveller looking at their own
     * destination was shown two labelled places whose names were an internal
     * placeholder with an editorial apology inside a bracket. A conceptual mark
     * is a shape, not a place: the *drawing* says a second base is coming, and
     * the caption says it once, in a sentence a person would say out loud.
     *
     * An empty name is what removes the label: markers without one are skipped
     * by the map's label pass and by its screen-reader list, and the caption
     * carries the meaning for both.
     */
    if (bases >= 2) {
      const second = offset(scaleKm * 0.8, 62);
      markers.push({ id: 'concept-base-2', name: '', coordinates: second, kind: 'place' });
      connectors.push({ id: 'concept-move-1', from: geometry.center, to: second, style: 'sightline' });
      fitPoints.push(second);
      if (bases >= 3) {
        const third = offset(scaleKm * 0.9, 150);
        markers.push({ id: 'concept-base-3', name: '', coordinates: third, kind: 'place' });
        connectors.push({ id: 'concept-move-2', from: second, to: third, style: 'sightline' });
        fitPoints.push(third);
      }
    }
    // Day trips out of a city: outer marks at the edge of the reach.
    if (dayTrips === 'one_day_trip' || dayTrips === 'several') {
      const count = dayTrips === 'several' ? 3 : 1;
      for (let i = 0; i < count; i += 1) {
        const point = offset(scaleKm * 1.6, 300 + i * 70);
        // Nameless for the same reason the conceptual bases are; see the note above.
        markers.push({ id: `concept-daytrip-${i}`, name: '', coordinates: point, kind: 'place' });
        connectors.push({ id: `concept-daytrip-${i}`, from: geometry.center, to: point, style: 'sightline' });
        fitPoints.push(point);
      }
    }
    // Transit and walking: short spokes from the centre — the city covered from one base by its network.
    if (movement === 'transit_walk' && bases === 1) {
      // Conceptual, and captioned as such: nothing on this drawing has been measured.
      for (let i = 0; i < 6; i += 1) connectors.push({ id: `concept-spoke-${i}`, from: geometry.center, to: offset(scaleKm * 0.45, i * 60 + 15), style: 'conceptual' });
    }
    if (b) {
      const sw = b.southWest;
      const ne = b.northEast;
      const corners = [sw, { lat: sw.lat, lng: ne.lng }, ne, { lat: ne.lat, lng: sw.lng }];
      for (let i = 0; i < 4; i += 1) connectors.push({ id: `bounds-${i}`, from: corners[i]!, to: corners[(i + 1) % 4]!, style: 'sightline' });
      fitPoints.push(...corners);
    } else {
      /*
       * No published extent: frame the decided reach when there is one, else the
       * place at its own scale. A radius nobody chose is never drawn — this sets
       * how far out the camera sits, not how far the trip goes.
       *
       * The country rung was missing, and it showed: a country placed from the
       * bundled reference has a real coordinate and no bounds, so it was framed at
       * forty kilometres — one dot in an empty box, for a place two thousand
       * kilometres long. Keyed on the published feature type, so it is the same
       * rule for every country and no destination is named.
       */
      const frameKm = rangeKm ?? FRAME_KM[geometry.featureType ?? ''] ?? (URBAN_FEATURES.has(geometry.featureType ?? '') ? 12 : 40);
      const dLat = frameKm / 111;
      const dLng = frameKm / (111 * Math.max(0.2, Math.cos((geometry.center.lat * Math.PI) / 180)));
      fitPoints.push({ lat: geometry.center.lat + dLat, lng: geometry.center.lng + dLng }, { lat: geometry.center.lat - dLat, lng: geometry.center.lng - dLng });
    }
    return { markers, connectors, fitPoints };
  }, [geometry, rangeKm, bases, movement, dayTrips, tiles]);
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
        chromeless={chromeless}
        summary={`${geometry.name}${extent ? `, ${extent}` : ''}. ${shape === 'stay_put' ? (URBAN_FEATURES.has(geometry.featureType ?? '') ? 'One base, the city around it.' : 'One base with days out from it.') : 'A moving route between bases.'}`}
        caption={
          <span>
            {geometry.bounds ? 'The thin frame is the destination’s published extent. ' : ''}
            {shape === 'stay_put' ? (URBAN_FEATURES.has(geometry.featureType ?? '') ? 'One base, the city around it' : 'One base, days out from it') : `A moving route with ${bases} bases`}
            {movementWord ? `, ${movementWord}` : ''}.{' '}
            {/*
              ONE LINE FOR THE MARKS NOBODY HAS CHOSEN YET.

              The conceptual marks lost their labels — see the note in the
              layout above — so this is the only place that says what they are,
              and it says it once. Bases before day trips because a moving trip
              is the bigger claim of the two; never both, because two sentences
              about the same unchosen thing read as two separate facts.
            */}
            {bases >= 2
              ? 'The hollow marks are bases still to be chosen.'
              : dayTrips === 'one_day_trip' || dayTrips === 'several'
                ? 'The outer marks are days out still to be chosen.'
                : conceptual
                  ? ''
                  : rangeKm === null
                    ? 'No range is drawn until you decide how far the trip should reach.'
                    : 'The ring is the reach you chose.'}
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
