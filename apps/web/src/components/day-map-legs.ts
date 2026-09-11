import { decodePolyline, type ItineraryDay, type TransportMode } from '@sidequest/core';
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

function styleFor(mode: TransportMode, provenance: string, episodeMode?: string, hint?: string): MapConnectorStyle {
  /* V7 §14 — an episode leg is drawn by how it moves, whatever a router said about it. */
  const m = mode as string;
  if (episodeMode === 'boat' || m === 'ferry' || hint === 'ferry' || hint === 'boat') return 'boat';
  if (episodeMode === 'rail' || m === 'rail' || hint === 'rail' || hint === 'high_speed_rail') return 'rail';
  if (hint === 'flight') return 'flight';
  if (episodeMode === 'walk' || episodeMode === 'horse') return 'trail';
  if (provenance === 'unmeasured') return 'unmeasured';
  if (provenance === 'estimated') return 'estimated';
  switch (mode) {
    case 'walk':
    case 'bicycle':
      return 'measured_walk';
    case 'rail':
    case 'public_bus':
    case 'ferry':
    case 'shuttle':
      return 'measured_transit';
    case 'drive':
    case 'rideshare':
    case 'private_transfer':
      return 'measured_drive';
    default:
      return 'unmeasured';
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
  let pendingLeg: { mode: TransportMode; provenance: string; id: string; episodeMode?: string; hint?: string; path?: readonly { lat: number; lng: number }[] } | null = null;
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
      pendingLeg = { mode: item.travel.mode, provenance: item.travel.provenance, id: item.id, ...(item.travel.episodeMode ? { episodeMode: item.travel.episodeMode } : {}), ...(item.travel.hint ? { hint: item.travel.hint } : {}), ...(path ? { path } : {}) };
      // A return leg to base closes the loop when the base is placed.
      if (item.travel.role === 'return' && base && cursor && cursor !== base) {
        connectors.push({ id: `${item.id}-return`, from: cursor, to: base, style: styleFor(item.travel.mode, item.travel.provenance, item.travel.episodeMode, item.travel.hint), ...(path ? { path } : {}) });
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
      connectors.push({ id: `${pendingLeg?.id ?? item.id}-leg`, from: cursor, to: point, style: pendingLeg ? styleFor(pendingLeg.mode, pendingLeg.provenance, pendingLeg.episodeMode, pendingLeg.hint) : 'unmeasured', ...(pendingLeg?.path ? { path: pendingLeg.path } : {}) });
    }
    cursor = point;
    pendingLeg = null;
  }
  return { base, markers, connectors, omitted };
}
