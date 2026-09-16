import { decodePolyline, journeyFromSegment, journeyLineKind, type ItineraryDay, type TravelSegment } from '@sidequest/core';
import type { MapConnector, MapConnectorStyle, MapMarker } from './InteractiveMap';

/**
 * A DAY'S STOPS AND LEGS, AS MAP MARKS — WITH HONEST LINE STYLES.
 *
 * Walks the day's timeline in order. Every activity with a known position
 * becomes a numbered stop; every travel item between two positioned points
 * becomes a connector whose style says what is known about it: a measured
 * drive is solid, measured transit long-dashed, a measured walk dotted, and
 * anything unmeasured short-dashed. LIVE WORLD V1: a measured leg that
 * persisted its shape draws the road itself; one without stays a straight
 * line between two real positions — the caption says so — and the *style*
 * never claims a measurement nobody made.
 */
export interface DayMapModel {
  base: { lat: number; lng: number } | null;
  markers: MapMarker[];
  connectors: MapConnector[];
  omitted: number;
}

/**
 * V12.1 §21 — THE LINE IS DRAWN BY THE JOURNEY, NOT BY A CHAIN OF STRING TESTS.
 *
 * This used to compare the raw `hint` against seven literals before falling
 * through to a `switch` on the persisted mode — one of the three places in the
 * repository re-parsing the same field with its own rules. It now asks the
 * journey what kind of movement it is, so a mode the vocabulary learns is drawn
 * correctly here without this file changing.
 *
 * Two axes, kept apart exactly as V8 had them: *how it moves* decides the shape
 * (an arc for a flight, a wave for water, dots for a trail), and *what is known*
 * decides the colour — and a mode whose shape carries the meaning keeps that
 * shape whether or not anybody timed it. A flight nobody timed is still an arc;
 * drawing it as a faint straight connector would say "we do not know how you get
 * there", which is false.
 */
function styleFor(segment: Pick<TravelSegment, 'mode' | 'provenance' | 'episodeMode' | 'hint'>): MapConnectorStyle {
  const journey = journeyFromSegment(segment as TravelSegment);
  switch (journeyLineKind(journey)) {
    case 'air':
      return 'flight';
    case 'water':
      return 'boat';
    case 'rail':
      return 'rail';
    case 'trail':
      return 'trail';
    case 'operator':
      /* An arranged transfer runs on roads the traveller does not choose; drawn as road when timed, as an untimed connector otherwise. */
      return segment.provenance === 'measured' ? 'measured_drive' : segment.provenance === 'estimated' ? 'estimated' : 'unmeasured';
    case 'pedestrian':
      return segment.provenance === 'measured' ? 'measured_walk' : segment.provenance === 'estimated' ? 'estimated' : 'unmeasured';
    case 'road':
    default:
      if (segment.provenance === 'unmeasured') return 'unmeasured';
      if (segment.provenance === 'estimated') return 'estimated';
      return segment.mode === 'public_bus' || segment.mode === 'shuttle' ? 'measured_transit' : 'measured_drive';
  }
}

export function dayMapModel(input: {
  day: ItineraryDay;
  coordinates: Record<string, { lat: number; lng: number }>;
  nameOf?: (placeId: string, fallback: string) => string;
}): DayMapModel {
  const { day, coordinates } = input;
  const base = coordinates[day.baseId] ?? null;
  const markers: MapMarker[] = [];
  const connectors: MapConnector[] = [];
  let omitted = 0;
  let cursor: { lat: number; lng: number } | null = base;
  let pendingLeg: { segment: TravelSegment; id: string; path?: readonly { lat: number; lng: number }[] } | null = null;
  let order = 0;
  const pathOf = (geometry: string | undefined) => {
    if (!geometry) return undefined;
    try {
      const decoded = decodePolyline(geometry);
      return decoded.length > 1 ? decoded : undefined;
    } catch {
      return undefined;
    }
  };
  for (const item of day.items) {
    if (item.kind === 'travel' && item.travel) {
      const path = item.travel.provenance === 'measured' ? pathOf(item.travel.geometry) : undefined;
      pendingLeg = { segment: item.travel, id: item.id, ...(path ? { path } : {}) };
      // A return leg to base closes the loop when the base is placed.
      if (item.travel.role === 'return' && base && cursor && cursor !== base) {
        connectors.push({ id: `${item.id}-return`, from: cursor, to: base, style: styleFor(item.travel), ...(path ? { path } : {}) });
        cursor = base;
        pendingLeg = null;
      }
      continue;
    }
    if (item.kind !== 'activity' || !item.placeId) continue;
    const point = coordinates[item.placeId];
    if (!point) {
      omitted += 1;
      continue;
    }
    order += 1;
    markers.push({ id: item.placeId, name: input.nameOf ? input.nameOf(item.placeId, item.title) : item.title, coordinates: point, kind: 'stop', order });
    if (cursor) {
      connectors.push({ id: `${pendingLeg?.id ?? item.id}-leg`, from: cursor, to: point, style: pendingLeg ? styleFor(pendingLeg.segment) : 'unmeasured', ...(pendingLeg?.path ? { path: pendingLeg.path } : {}) });
    }
    cursor = point;
    pendingLeg = null;
  }
  return { base, markers, connectors, omitted };
}
